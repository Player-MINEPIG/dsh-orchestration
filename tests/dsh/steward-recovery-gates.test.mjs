import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createNativeHarness} from './native-harness.mjs';
import {registerExecutor} from './executor-fixture.mjs';

async function settled(service,commandId){
  const until=Date.now()+10000;
  while(Date.now()<until){const snapshot=await service.reconcile({conversationId:'main',commandId});if(snapshot.commandMessage?.state.kind==='completed')return snapshot;await new Promise(done=>setTimeout(done,20));}
  throw Error('Expected native command did not settle');
}
async function fixture(){
  const h=await createNativeHarness({executionRoot:true,config:{role:'both',schedulerEnabled:false,autoExecute:false,projectAgentOptions:{provider:'test-offline',model:'script'},localNode:{models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true}}});
  h.projects=h.ctx.taskSystem.projects;h.service=h.ctx.taskSystem.steward;
  h.projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  h.a=await h.projects.create({commandId:'recover-a',title:'Recovery A',goal:'A authority'});h.b=await h.projects.create({commandId:'recover-b',title:'Recovery B',goal:'B authority'});
  h.adapter.script.push('A subscribed');await h.service.send({conversationId:'main',commandId:'subscribe-a',text:'Subscribe A',target:{kind:'project',projectId:h.a.projectId}});await settled(h.service,'subscribe-a');
  h.adapter.script.push('B foreground');await h.service.send({conversationId:'main',commandId:'subscribe-b',text:'Subscribe B',target:{kind:'project',projectId:h.b.projectId}});await settled(h.service,'subscribe-b');
  return h;
}

test('old unfinished A remains directly actionable after 350 B notices, without full canonical scans or duplicate native admission',{timeout:20000},async()=>{
  const h=await fixture();try{
    const a=h.service.store.commandMessage('main','subscribe-a'),b=h.service.store.commandMessage('main','subscribe-b');
    const old=h.service.store.accept({conversationId:'main',commandId:'old-unconfirmed-a',text:'OLD_A_UNKNOWN',target:a.scope},a.scope,a.source,-1);
    h.service.store.setState(old.id,{kind:'needs-reconciliation',reason:'Injected stop before native admission'});
    for(let i=0;i<350;i++)h.service.store.project({...b,role:'notification',commandId:null,text:`B notice ${i}`,replyTo:null,state:{kind:'completed'}},`bulk-b:${i}`);
    h.service.store.messages=()=>{throw Error('Hot paths must not materialize the whole canonical log');};
    const snapshot=h.service.snapshot({conversationId:'main'});
    assert.equal(snapshot.messages.length,50);assert.ok(!snapshot.messages.some(message=>message.id===old.id));
    const attention=snapshot.attention.items.find(message=>message.id===old.id);assert.ok(attention);assert.equal(attention.preview,'OLD_A_UNKNOWN');
    const requests=h.adapter.requests.length;
    await assert.rejects(h.service.send({conversationId:'main',commandId:'blocked-new-a',text:'New A message',target:a.scope}),{code:'BUSY'});
    assert.equal(h.service.commandStatus('main','blocked-new-a'),'not-admitted');assert.equal(h.adapter.requests.length,requests);
    const resolve={conversationId:'main',commandId:'close-old-a',messageId:attention.id,expectedRevision:attention.revision,expectedState:attention.state.kind,confirm:true};
    const until=Date.now()+3000;while(true){try{await h.service.resolve(resolve);break;}catch(error){if(error.code!=='BUSY'||Date.now()>until)throw error;await new Promise(done=>setTimeout(done,20));}}
    h.adapter.script.push('A can continue');await h.service.send({conversationId:'main',commandId:'new-a-after-closure',text:'NEW_A_AFTER_CLOSURE',target:a.scope});await settled(h.service,'new-a-after-closure');
    assert.equal(h.adapter.requests.length,requests+1);assert.doesNotMatch(JSON.stringify(h.adapter.requests.at(-1).messages),/OLD_A_UNKNOWN/);
  }finally{await h.dispose();}
});

test('eleven gates keep the oldest pending candidate reachable and independent work uses the complete revision snapshot',{timeout:20000},async()=>{
  const h=await fixture();try{
    const session=h.projects.placementProject(h.a.projectId).session;
    for(let i=0;i<11;i++){h.ledger.createTask(`gate-root-${i}`,{taskId:`gate-root-${i}`,title:`Workstream ${i}`});h.ledger.createTask(`gate-repair-${i}`,{taskId:`gate-repair-${i}`,title:`Repair ${i}`,parentTaskId:`gate-root-${i}`});h.projects.linkTask(session,`gate-root-${i}`);}
    for(let i=0;i<11;i++)h.service.gateArm({conversationId:'main',commandId:`arm-ui-${i}`,instruction:'Wait for my acceptance before downstream work',gate:{gateId:`many-gate-${i}`,projectId:h.a.projectId,workstreamTaskId:`gate-root-${i}`,upstreamTaskIds:[`gate-repair-${i}`]}});
    registerExecutor(h.ledger,'many-gate-node',{nodeId:'local',roles:['both'],capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:[],enabled:true});h.ledger.recordNodeHeartbeat('many-gate-ready',{nodeId:'local',runtimeReady:true,activeExecutions:0});
    const run=h.ledger.createRun('old-gate-repair-run',{taskId:'gate-repair-0',route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
    const lease=h.ledger.claim('old-gate-repair-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
    h.ledger.submit('old-gate-repair-result',{runId:run.runId,attemptId:lease.attempt.attemptId,nodeId:'local',fence:lease.attempt.fence,outcome:'success',summary:'Ready for human acceptance',report:{title:'Old gate result',body:'Bound exact candidate'}});
    let snapshot;const until=Date.now()+10000;
    do{snapshot=await h.service.reconcile({conversationId:'main'});if(snapshot.messages.some(message=>message.gate?.gateId==='many-gate-0'&&message.gate.state==='awaiting-acceptance'))break;await new Promise(done=>setTimeout(done,20));}while(Date.now()<until);
    const notice=snapshot.messages.find(message=>message.gate?.gateId==='many-gate-0'&&message.gate.state==='awaiting-acceptance');assert.ok(notice);
    assert.deepEqual(snapshot.currentScope,{kind:'project',projectId:h.b.projectId},'A acceptance notice does not switch the foreground B scope');
    const recent=h.service.gateRead({conversationId:'main',projectId:h.a.projectId});assert.equal(recent.gates.length,10);assert.equal(recent.page.total,11);assert.ok(!recent.gates.some(gate=>gate.gateId==='many-gate-0'));
    const exact=h.service.gateRead({conversationId:'main',projectId:h.a.projectId,gateId:notice.gate.gateId});assert.equal(exact.gates[0].candidate.digest,notice.gate.candidateDigest);
    const accepted=h.service.gateDecide({conversationId:'main',commandId:'accept-old-gate',gateId:'many-gate-0',expectedRevision:exact.gates[0].revision,candidateDigest:exact.gates[0].candidate.digest,decision:'accept',comment:'Reviewed the old exact candidate'});assert.equal(accepted.state,'released');
    const fresh=h.service.gateRead({conversationId:'main',projectId:h.a.projectId});h.adapter.script.push('Explicit independent work acknowledged');
    const input={conversationId:'main',commandId:'new-human-independent',projectId:h.a.projectId,backlogId:fresh.backlogs[0].id,title:'Separate independent request',description:'Do not change repair workstreams',gateSnapshotDigest:fresh.revisionSnapshot.digest};
    const independent=await h.service.gateIndependent(input);await settled(h.service,'new-human-independent:invoke');
    assert.ok(h.ledger.acceptanceIndependentReference(independent.task.taskId));assert.equal(h.ledger.acceptanceGateView('many-gate-1').state,'repairing');
    const requests=h.adapter.requests.length;await h.service.gateIndependent(input);assert.equal(h.adapter.requests.length,requests);
    await assert.rejects(h.service.gateIndependent({...input,title:'Changed reused request'}),{code:'CONFLICT'});
  }finally{await h.dispose();}
});
