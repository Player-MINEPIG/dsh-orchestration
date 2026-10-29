import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createNativeHarness} from './native-harness.mjs';

async function waitFor(service, predicate) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {
    const snapshot=await service.reconcile({conversationId:'main'});
    if(predicate(snapshot))return snapshot;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Steward native turn did not reach its expected durable projection');
}
function requestText(request) {return JSON.stringify(request.messages);}

test('one canonical steward conversation routes personal/A/B/personal and an old reply to independent real native histories', {timeout:30000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try {
    const task=h.ctx.taskSystem,projects=task.projects;
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const a=await projects.create({commandId:'steward-create-a',title:'Project A',goal:'A_ONLY_GOAL'});
    const b=await projects.create({commandId:'steward-create-b',title:'Project B',goal:'B_ONLY_GOAL'});
    const service=task.steward;
    assert.ok(service,'Actual task service must mount steward');
    const send=async(commandId,text,target,expected,replyTo)=>{
      h.adapter.script.push(expected);
      await service.send({conversationId:'main',commandId,text,...(target?{target}:{}),...(replyTo?{replyTo}:{})});
      return waitFor(service,s=>s.messages.some(message=>message.role==='assistant'&&message.text===expected));
    };
    await send('personal-1','PERSONAL_ONLY_ONE',{kind:'personal'},'Personal response one');
    let snapshot=await send('project-a-1','A_ONLY_REQUEST',{kind:'project',projectId:a.projectId},'A response one');
    const aReply=snapshot.messages.find(message=>message.role==='assistant'&&message.text==='A response one');
    await send('project-b-1','B_ONLY_REQUEST',{kind:'project',projectId:b.projectId},'B response one');
    await send('personal-2','PERSONAL_ONLY_TWO',{kind:'personal'},'Personal response two');
    snapshot=await send('reply-a','A_REPLY_REQUEST',undefined,'A response two',aReply.id);
    assert.equal(snapshot.conversationId,'main');
    assert.equal(snapshot.messages.filter(message=>message.role==='user').length,5);
    const reply=snapshot.messages.find(message=>message.role==='user'&&message.text==='A_REPLY_REQUEST');
    assert.equal(reply.replyTo,aReply.id);assert.deepEqual(reply.scope,{kind:'project',projectId:a.projectId});
    const requests=h.adapter.requests;
    assert.equal(requests.length,5,'There is no mandatory extra steward LLM hop');
    assert.match(requestText(requests[0]),/PERSONAL_ONLY_ONE/);assert.doesNotMatch(requestText(requests[0]),/A_ONLY|B_ONLY/);
    assert.match(requestText(requests[1]),/A_ONLY_REQUEST/);assert.doesNotMatch(requestText(requests[1]),/PERSONAL_ONLY|B_ONLY/);
    assert.match(requestText(requests[2]),/B_ONLY_REQUEST/);assert.doesNotMatch(requestText(requests[2]),/PERSONAL_ONLY|A_ONLY/);
    assert.match(requestText(requests[3]),/PERSONAL_ONLY_ONE.*PERSONAL_ONLY_TWO/);assert.doesNotMatch(requestText(requests[3]),/A_ONLY|B_ONLY/);
    assert.match(requestText(requests[4]),/A_ONLY_REQUEST.*A_REPLY_REQUEST/);assert.doesNotMatch(requestText(requests[4]),/PERSONAL_ONLY|B_ONLY/);
    const userMessages=snapshot.messages.filter(message=>message.role==='user');
    assert.equal(new Set(userMessages.map(message=>message.source.sessionId)).size,3);
    assert.equal(userMessages[0].source.sessionId,userMessages[3].source.sessionId);
    assert.equal(userMessages[1].source.sessionId,userMessages[4].source.sessionId);
    const before=requests.length;
    await service.send({conversationId:'main',commandId:'reply-a',text:'A_REPLY_REQUEST',replyTo:aReply.id});
    assert.equal(h.adapter.requests.length,before,'Exact accepted retry must not create another model request');
    await assert.rejects(async()=>service.send({conversationId:'main',commandId:'reply-a',text:'changed',replyTo:aReply.id}),/changed|reused|conflict/i);
    const restored=await service.snapshot({conversationId:'main'});
    assert.deepEqual(restored.messages.map(message=>message.id),snapshot.messages.map(message=>message.id));
  } finally {await h.dispose();}
});

test('project PM dispatches to the same machine native executor; late task notifications keep their project and do not switch the visible scope', {timeout:30000}, async()=>{
  const {registerExecutor}=await import('./executor-fixture.mjs');
  const h=await createNativeHarness({executionRoot:true,config:{role:'both',schedulerEnabled:false,autoExecute:false,projectAgentOptions:{provider:'test-offline',model:'script'},localNode:{models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true}}});
  try {
    registerExecutor(h.ledger,'steward-local-node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
    h.ledger.recordNodeHeartbeat('steward-local-ready',{nodeId:'local',runtimeReady:true,activeExecutions:0});
    const projects=h.ctx.taskSystem.projects,service=h.ctx.taskSystem.steward;
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const {projectId}=await projects.create({commandId:'local-project',title:'Local project',goal:'One local coordinator and executor'});
    h.adapter.script.push(options=>{
      const match=requestText(options).match(/commandId=\\"(project-message:[^\\"]+)\\"/);
      assert.ok(match,'Managed PM prompt supplies its authoritative stable dispatch command');
      return {name:'task_dispatch',args:{commandId:match[1],title:'Steward same-machine task',description:'Produce the explicit offline native fixture report',nodeId:'local'}};
    },'Local task registered');
    await service.send({conversationId:'main',commandId:'local-dispatch',text:'LOCAL_DISPATCH_MARKER',target:{kind:'project',projectId}});
    await waitFor(service,s=>s.messages.some(message=>message.text==='Local task registered'));
    projects.tick();
    const task=h.ledger.snapshot().tasks.find(task=>task.title==='Steward same-machine task');
    assert.ok(task,'PM used the real task_dispatch tool');
    const run=h.ledger.history(task.taskId).runs.at(-1);assert.ok(run,'Host admitted an actual Run');
    assert.equal(run.route.nodeId,'local');
    h.adapter.script.push('Personal while worker pending');
    await service.send({conversationId:'main',commandId:'personal-while-task',text:'PERSONAL_PENDING_TASK_MARKER',target:{kind:'personal'}});
    await waitFor(service,s=>s.messages.some(message=>message.text==='Personal while worker pending'));
    const claim=h.ledger.claim('steward-native-local-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
    h.adapter.script.push({name:'task_submit_result',args:{outcome:'success',summary:'Actual local native fixture chain completed',reportTitle:'Local execution evidence',reportBody:'Task dispatch, claim, native AgentLoop and scoped result tool executed on the same isolated host.'}});
    const result=await h.ctx.taskSystem.native.execute(claim);
    assert.equal(result.run.state,'succeeded');assert.ok(result.sessionId);
    assert.equal(h.ledger.history(task.taskId).reports.filter(report=>report.kind==='result').length,1);
    const snapshot=await waitFor(service,s=>s.messages.some(message=>message.role==='notification'&&message.provenance?.eventType==='run.settled'));
    assert.deepEqual(snapshot.currentScope,{kind:'personal'});
    const notifications=snapshot.messages.filter(message=>message.role==='notification');
    assert.ok(notifications.length);assert.ok(notifications.every(message=>message.scope.kind==='project'&&message.scope.projectId===projectId));
    assert.equal(notifications.filter(message=>message.provenance?.eventType==='report.appended').length,0,'Initial task request and terminal result report do not duplicate the settled notification');
    const again=await service.reconcile({conversationId:'main'});
    assert.deepEqual(again.messages.filter(message=>message.role==='notification').map(message=>message.id),notifications.map(message=>message.id));
  }finally{await h.dispose();}
});


test('a recreated host restores the canonical log without replay and old project replies follow the authority current generation', {timeout:30000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-restart-'));
  const config={role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}};
  let h=await createNativeHarness({dir,config});
  try {
    h.ctx.taskSystem.projects.saveSettings({root:join(dir,'projects'),expectedRevision:0});
    const {projectId}=await h.ctx.taskSystem.projects.create({commandId:'restart-project',title:'Persistent project',goal:'PERSISTENT_PROJECT_GOAL'});
    const input={conversationId:'main',commandId:'before-restart',text:'BEFORE_RESTART_MARKER',target:{kind:'project',projectId}};
    h.adapter.script.push('Before restart response');
    await h.ctx.taskSystem.steward.send(input);
    const original=await waitFor(h.ctx.taskSystem.steward,s=>s.messages.some(message=>message.text==='Before restart response'));
    const reply=original.messages.find(message=>message.text==='Before restart response');
    await h.dispose();h=await createNativeHarness({dir,config});
    const restored=await h.ctx.taskSystem.steward.reconcile({conversationId:'main'});
    assert.deepEqual(restored.messages.map(message=>message.id),original.messages.map(message=>message.id));
    await h.ctx.taskSystem.steward.send(input);assert.equal(h.adapter.requests.length,0,'Restart does not replay an admitted message');
    await h.ctx.taskSystem.projects.handoff(projectId);
    h.adapter.script.push('After rotation response');
    await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'after-rotation',text:'AFTER_ROTATION_MARKER',replyTo:reply.id});
    const rotated=await waitFor(h.ctx.taskSystem.steward,s=>s.messages.some(message=>message.text==='After rotation response'));
    const user=rotated.messages.find(message=>message.text==='AFTER_ROTATION_MARKER');
    assert.equal(user.source.generation,2);assert.notEqual(user.source.sessionId,reply.source.sessionId);
    assert.deepEqual(user.scope,{kind:'project',projectId});assert.equal(rotated.persona.id,original.persona.id);
    assert.equal(h.adapter.requests.length,1);assert.match(requestText(h.adapter.requests[0]),/BEFORE_RESTART_MARKER/);
    assert.match(requestText(h.adapter.requests[0]),/AFTER_ROTATION_MARKER/);
  }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('ordinary host runtime-context snapshots do not detach an accepted user message from its assistant reply', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}},script:['Reply after runtime context']});
  const stop=h.ctx.systemPrompt.context({name:'steward-native-context-regression',order:110,interpolate:false,text:'RUNTIME_CONTEXT_REGRESSION_MARKER'});
  try {
    const service=h.ctx.taskSystem.steward;
    await service.send({conversationId:'main',commandId:'context-order',text:'USER_BEFORE_RUNTIME_CONTEXT',target:{kind:'personal'}});
    const snapshot=await waitFor(service,s=>s.messages.some(message=>message.role==='assistant'&&message.text==='Reply after runtime context'));
    const user=snapshot.messages.find(message=>message.role==='user');
    assert.equal(snapshot.messages.find(message=>message.role==='assistant').replyTo,user.id);
    assert.equal(user.state.kind,'completed');
    assert.match(requestText(h.adapter.requests[0]),/RUNTIME_CONTEXT_REGRESSION_MARKER/);
  }finally{stop();await h.dispose();}
});

test('auto routing uses bounded classifier requests for casual turns, direct addresses for A/B and old replies before text intent', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try {
    const service=h.ctx.taskSystem.steward,projects=h.ctx.taskSystem.projects;
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const a=await projects.create({commandId:'auto-a',title:'Alpha 项目',goal:'SECRET_A_GOAL'});
    await projects.create({commandId:'auto-b',title:'Beta 项目',goal:'SECRET_B_GOAL'});
    async function send(commandId,text,response,classify,replyTo) {
      if(classify)h.adapter.script.push(JSON.stringify(classify));h.adapter.script.push(response);
      await service.send({conversationId:'main',commandId,text,routingMode:'auto',...(replyTo?{replyTo}:{})});
      return waitFor(service,s=>s.messages.some(message=>message.text===response));
    }
    await send('auto-personal','先闲聊 PERSONAL_AUTO_MARKER','personal one',{kind:'route',target:{kind:'personal'}});
    let snapshot=await send('auto-project-a','Alpha 项目：A_AUTO_MARKER','alpha one');
    const oldA=snapshot.messages.find(message=>message.text==='alpha one');
    await send('auto-project-b','@Beta 项目 B_AUTO_MARKER','beta one');
    await send('auto-personal-back','不要交给 Alpha 项目，聊点别的 PERSONAL_BACK_AUTO','personal back',{kind:'route',target:{kind:'personal'}});
    snapshot=await send('auto-old-reply','Beta 项目只是引用，继续旧问题','alpha reply',null,oldA.id);
    assert.deepEqual(snapshot.messages.find(message=>message.commandId==='auto-old-reply').scope,{kind:'project',projectId:a.projectId});
    const classifiers=h.adapter.requests.filter(request=>request.messages[0]?.source?.kind==='dsh-steward-route-classifier');
    assert.equal(classifiers.length,2);assert.ok(classifiers.every(request=>request.messages.length===1));
    for(const request of classifiers)assert.doesNotMatch(requestText(request),/SECRET_A_GOAL|SECRET_B_GOAL|A_AUTO_MARKER|B_AUTO_MARKER/);
    const before=snapshot.messages.length,requestsBefore=h.adapter.requests.length;
    h.adapter.script.push(JSON.stringify({kind:'route',target:{kind:'project',projectId:'UNKNOWN_PROJECT'}}));
    await assert.rejects(service.send({conversationId:'main',commandId:'auto-unknown',text:'不明确的话题',routingMode:'auto'}),{code:'CLARIFICATION'});
    assert.equal(service.snapshot({conversationId:'main'}).messages.length,before,'Unknown target has no canonical admission or PM dispatch');
    assert.equal(h.adapter.requests.length,requestsBefore+1,'Only classification ran, no destination model');
  }finally{await h.dispose();}
});

test('human recovery closes only an uncertain wait after restart, without replaying its original effect', {timeout:15000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-uncertain-'));
  const config={role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}};
  let h=await createNativeHarness({dir,config,script:['Initial personal response']});
  try {
    let service=h.ctx.taskSystem.steward;
    await service.send({conversationId:'main',commandId:'before-fault',text:'INITIAL_NATIVE_MARKER',target:{kind:'personal'}});
    const initial=await waitFor(service,s=>s.messages.some(message=>message.text==='Initial personal response'));
    const binding=initial.messages.find(message=>message.role==='user').source;
    // Deliberately stop at the durable acceptance boundary, before any native admission.
    const original={conversationId:'main',commandId:'fault-before-native',text:'NEVER_ADMITTED_MARKER',target:{kind:'personal'}};
    const accepted=service.store.accept(original,{kind:'personal'},binding,service.store.cursors('main')[0].afterSeq);
    service.store.setState(accepted.id,{kind:'needs-reconciliation',reason:'Injected interruption after attempt marker, before native admission'});
    await h.dispose();h=await createNativeHarness({dir,config});service=h.ctx.taskSystem.steward;
    const restored=await service.reconcile({conversationId:'main'}),message=restored.messages.find(row=>row.id===accepted.id);
    assert.equal(message.state.kind,'needs-reconciliation');assert.equal(h.adapter.requests.length,0);
    const resolution={conversationId:'main',messageId:message.id,commandId:'resolve-fault',expectedRevision:message.revision,expectedState:message.state.kind,confirm:true};
    await assert.rejects(service.resolve({...resolution,commandId:'stale-resolve',expectedRevision:message.revision+1}),{code:'CONFLICT'});
    const released=await service.resolve(resolution),row=released.messages.find(row=>row.id===message.id);
    assert.equal(row.state.kind,'released');assert.equal(row.resolution.priorState,'needs-reconciliation');
    await service.resolve(resolution);assert.equal(h.adapter.requests.length,0,'Recovery never resends or wakes the original native owner');
    h.adapter.script.push('New independent response');
    await service.send({conversationId:'main',commandId:'after-release',text:'AFTER_RELEASE_MARKER',target:{kind:'personal'}});
    await waitFor(service,s=>s.messages.some(message=>message.text==='New independent response'));
    assert.equal(h.adapter.requests.length,1);assert.doesNotMatch(requestText(h.adapter.requests[0]),/NEVER_ADMITTED_MARKER/);
  }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});
