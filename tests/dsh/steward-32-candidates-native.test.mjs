import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startHost} from '../ci/browser-native-project.mjs';

const conversationId='main';
const request=(commandId,text,extra={})=>({conversationId,commandId,text,...extra});
const scope=project=>({kind:'project',projectId:project.projectId});
const json=value=>JSON.stringify(value);
const modelInput=options=>JSON.parse(options.messages[0].content[0].text);
async function completed(service,commandId){
  for(let n=0;n<600;n++){
    const value=await service.reconcile({conversationId,commandId});
    if(value.commandMessage?.state.kind==='completed')return value.commandMessage;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error(`Native command did not complete: ${commandId}`);
}
const canonical=service=>service.store.messages(conversationId).map(message=>({id:message.id,scope:message.scope,text:message.text,source:message.source}));
async function seed(host,project,id,text){
  host.model.script.push(`${id} reply`);
  await host.ctx.taskSystem.steward.send(request(id,text,{target:scope(project)}));
  return completed(host.ctx.taskSystem.steward,id);
}

test('32 authorized candidates reach the last real native recipient; a 33rd equal-score topic retains the original without dispatch',{timeout:120000},async()=>{
  const host=await startHost();
  try{
    const service=host.ctx.taskSystem.steward,projects=[];
    const shared='scopeboundedsharedneedle';
    for(let n=0;n<32;n++){
      const title=`Authorized candidate ${n.toString().padStart(2,'0')}`;
      const project={...await host.runtime.create({commandId:`candidate-create-${n}`,title,goal:shared}),title};
      projects.push(project);
      project.seed=await seed(host,project,`candidate-seed-${n}`,`PRIVATE_CANDIDATE_HISTORY_${n.toString().padStart(2,'0')}`);
    }
    const source=await seed(host,host.created,'private-original-seed','PRIVATE_ORIGINAL_PROJECT_HISTORY');
    await service.configureRouting({commandId:'candidate-native-routing-model',expectedRevision:0,fallback:{provider:'test-offline',model:'script'}});
    const before=canonical(service),calls=host.model.requests.length;
    let target;
    host.model.script.push(options=>{
      assert.equal(modelInput(options).stage,'latest');
      return json({kind:'search',queries:[shared]});
    },options=>{
      const input=modelInput(options);
      assert.equal(input.stage,'candidates');assert.equal(input.candidates.length,32);
      assert.deepEqual(input.candidates.map(item=>item.id),Array.from({length:32},(_,n)=>`topic_${n}`));
      for(const item of input.candidates){
        assert.equal('scope' in item,false);assert.equal('binding' in item,false);
        assert.equal('projectId' in item,false);assert.equal('sessionId' in item,false);
        assert.ok(Array.from(item.summary).length<=100);
      }
      const wire=json(input.candidates);
      for(const project of projects){assert.equal(wire.includes(project.projectId),false);assert.equal(wire.includes(project.seed.source.sessionId),false);}
      const candidate=input.candidates[31];target=projects.find(project=>project.title===candidate.title);
      assert.ok(target,'The final opaque candidate maps to one real authorized project');
      assert.doesNotMatch(json(input),/PRIVATE_ORIGINAL_PROJECT_HISTORY/);
      return json({kind:'candidate',id:candidate.id});
    },options=>{
      const text=json(options.messages);
      assert.match(text,/ORIGINAL_32_CANDIDATE_REQUEST/);
      assert.match(text,new RegExp(`PRIVATE_CANDIDATE_HISTORY_${projects.indexOf(target).toString().padStart(2,'0')}`));
      assert.doesNotMatch(text,/PRIVATE_ORIGINAL_PROJECT_HISTORY/);
      for(let n=0;n<projects.length;n++)if(projects[n].projectId!==target.projectId)assert.doesNotMatch(text,new RegExp(`PRIVATE_CANDIDATE_HISTORY_${n.toString().padStart(2,'0')}`));
      return 'LAST_AUTHORIZED_RECIPIENT_COMPLETED';
    });
    const original=request('candidate-last-original','ORIGINAL_32_CANDIDATE_REQUEST',{routingMode:'auto'});
    await service.send(original);const delivered=await completed(service,original.commandId);
    assert.deepEqual(delivered.scope,scope(target));assert.equal(delivered.text,original.text);
    assert.equal(delivered.source.sessionId,target.seed.source.sessionId);
    assert.notEqual(delivered.source.sessionId,source.source.sessionId);
    assert.equal(host.model.requests.length,calls+3,'Latest semantic search, all-candidate choice and one real recipient turn');
    const after=canonical(service);
    for(const project of [host.created,...projects]){
      const prior=before.filter(message=>message.scope.projectId===project.projectId);
      const now=after.filter(message=>message.scope.projectId===project.projectId);
      if(project.projectId===target.projectId){assert.equal(now.length,prior.length+2);assert.deepEqual(now.slice(0,prior.length),prior);}
      else assert.deepEqual(now,prior,'Every other canonical source stays unchanged');
    }
    await seed(host,host.created,'private-original-before-jev','PRIVATE_ORIGINAL_PROJECT_JEV_CONTEXT');
    await host.ctx.loader.create({id:'candidate-native-jev',name:pathToFileURL(resolve('packages/jev/lib/index.js')).href,config:{provider:'native',nativeProvider:'test-offline',model:'script'}});
    await host.ctx.loader.await();assert.ok(host.ctx.get('decisionModels'));
    const jevBefore=canonical(service),jevCalls=host.model.requests.length;
    let jevTarget;
    const abstain=options=>{
      assert.match(options.system,/supplied typed questions/);
      const data=modelInput(options);assert.equal(JSON.parse(data.state).stage,'latest');
      return json({answers:{recipient:{type:'choice',choice:'uncertain'}}});
    };
    const search=options=>{assert.equal(modelInput(options).stage,'latest');return json({kind:'search',queries:[shared]});};
    host.model.script.push(abstain,search,options=>{
      assert.match(options.system,/supplied typed questions/);
      const data=modelInput(options),input=JSON.parse(data.state);
      assert.equal(input.stage,'candidates');assert.equal(input.candidates.length,32);
      assert.equal(Object.keys(data.questions.recipient.criteria).length,33,'All 32 choices plus abstention reach the production Jev service');
      assert.ok(data.questions.recipient.criteria.topic_31);
      jevTarget=projects.find(project=>project.title===input.candidates[31].title);assert.ok(jevTarget);
      return json({answers:{recipient:{type:'choice',choice:'topic_31'}}});
    },options=>{
      const text=json(options.messages);assert.match(text,/ORIGINAL_32_JEV_REQUEST/);
      assert.match(text,new RegExp(`PRIVATE_CANDIDATE_HISTORY_${projects.indexOf(jevTarget).toString().padStart(2,'0')}`));
      assert.doesNotMatch(text,/PRIVATE_ORIGINAL_PROJECT_/);
      for(let n=0;n<projects.length;n++)if(projects[n].projectId!==jevTarget.projectId)assert.doesNotMatch(text,new RegExp(`PRIVATE_CANDIDATE_HISTORY_${n.toString().padStart(2,'0')}`));
      return 'REAL_JEV_LAST_RECIPIENT_COMPLETED';
    });
    const jevOriginal=request('candidate-last-real-jev','ORIGINAL_32_JEV_REQUEST',{routingMode:'auto'});
    const jevSent=await service.send(jevOriginal);
    assert.equal(jevSent.router.find(item=>item.commandId===jevOriginal.commandId)?.executorAdmitted,true,json({router:jevSent.router.find(item=>item.commandId===jevOriginal.commandId),remaining:host.model.script.length,requests:host.model.requests.slice(jevCalls).map(item=>({system:String(item.system??'').slice(0,90),source:item.messages[0]?.source?.kind}))}));
    const jevDelivered=await completed(service,jevOriginal.commandId);
    assert.deepEqual(jevDelivered.scope,scope(jevTarget));assert.equal(jevDelivered.text,jevOriginal.text);
    assert.equal(jevDelivered.source.sessionId,jevTarget.seed.source.sessionId);
    assert.equal(host.model.requests.length,jevCalls+4,'Real Jev abstention, independent fallback search, real Jev choice and one recipient turn');
    const jevAfter=canonical(service);
    for(const project of [host.created,...projects]){
      const prior=jevBefore.filter(message=>message.scope.projectId===project.projectId);
      const now=jevAfter.filter(message=>message.scope.projectId===project.projectId);
      if(project.projectId===jevTarget.projectId){assert.equal(now.length,prior.length+2);assert.deepEqual(now.slice(0,prior.length),prior);}
      else assert.deepEqual(now,prior,'Jev selection leaves all other native canonical sources unchanged');
    }
    const overflow=await host.runtime.create({commandId:'candidate-create-33',title:'Authorized candidate 32',goal:shared});
    await seed(host,overflow,'candidate-seed-33','PRIVATE_CANDIDATE_HISTORY_32');
    await seed(host,host.created,'private-original-return','PRIVATE_ORIGINAL_PROJECT_CONTINUATION');
    const frozen=canonical(service),overflowCalls=host.model.requests.length;
    host.model.script.push(abstain,search);
    const heldInput=request('candidate-overflow-original','ORIGINAL_33_CANDIDATE_REQUEST',{routingMode:'auto'});
    const held=await service.send(heldInput),pending=held.router.find(item=>item.commandId===heldInput.commandId);
    assert.equal(pending.phase,'clarifying');assert.equal(pending.executorAdmitted,false);
    assert.equal(pending.text,heldInput.text);assert.ok(pending.options.length<=4);
    assert.equal(service.store.commandMessage(conversationId,heldInput.commandId),null);
    assert.equal(host.model.requests.length,overflowCalls+2,'Incomplete retrieval never invokes candidate selection or an executor');
    assert.deepEqual(canonical(service),frozen,'The held original changes no canonical project source');
    await service.send(heldInput);assert.equal(host.model.requests.length,overflowCalls+2,'Lost-ack retry does not repeat routing');
    await assert.rejects(service.send({...heldInput,text:'Changed original',target:scope(target)}),{code:'CONFLICT'});
    assert.deepEqual(canonical(service),frozen);
    assert.equal(host.model.script.length,0);
  }finally{await host.close();}
});
