import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {TaskLedger} from '../dist/ledger.js';
import {RecoveryStore,RemoteGateway,RemoteClient,RemoteLedgerClient,IdentityVerifier} from '../dist/remote/api.js';
import {RemoteExecutionService} from '../dist/remote/index.js';
import {TaskPluginSettings} from '../dist/settings.js';
import {executorPanelSnapshot} from '../dist/executor-panel.js';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';

function panel(t) {
 const dir=mkdtempSync(join(tmpdir(),'executor-alert-'));let store=new RecoveryStore(join(dir,'recovery.sqlite'));
 const ledger=TaskLedger.open(':memory:'),workers=new Set();
 const remote=Object.assign(Object.create(RemoteExecutionService.prototype),{store,workers,config:{role:'executor',nodeId:'MBP',coordinator:{endpoint:'https://current.invalid/',audience:'current'},paused:false},dispositionProbes:new Map()});
 const ctx={get:k=>({taskSystem:{config:{role:'executor',nodeId:'MBP'},ledger,results:{pending:()=>[]}},remoteExecution:remote})[k]};
 const settings=Object.assign(Object.create(TaskPluginSettings.prototype),{ctx});
 t.after(()=>{store.close();ledger.close();rmSync(dir,{recursive:true,force:true});});
 const record=(state='acknowledged',outcome='blocked',attemptId='attempt')=>({attemptId,state,claim:{task:{taskId:'task',title:'Historical blocked workload',description:'Read-only task'},run:{runId:'run',taskId:'task',state:'blocked',updatedAt:'2026-10-22T00:00:00Z',route:{nodeId:'MBP'}},attempt:{attemptId}},lease:{runId:'run',attemptId,nodeId:'MBP',fence:1},sessionId:'execution-session',result:{outcome,summary:'Original result'},receipt:{commandId:'result-'+attemptId,acceptedAt:'2026-10-22T00:00:00Z',value:{}}});
 const disposition={schedulerId:'scheduler-fixture',taskId:'task',runId:'run',taskState:'cancelled',runState:'blocked',attemptId:'attempt',attemptState:'settled',currentAttemptId:'attempt',cancellationRequested:false};
 return {dir,remote,settings,ledger,workers,record,disposition,get store(){return store},restart(){store.close();store=new RecoveryStore(join(dir,'recovery.sqlite'));remote.store=store;}};
}
test('acknowledgement is durable local-only, reversible, CAS-bound and does not hide a later attempt',async t=>{
 const f=panel(t),original=f.record();f.store.createDispatch(original);
 let view=await f.settings.projectSnapshot();const alert=view.tasks[0].alert;assert.equal(view.tasks[0].status,'error');assert.equal(alert.canAcknowledge,true);
 await f.settings.setExecutorAlertDisposition({recordId:alert.recordId,fingerprint:alert.fingerprint,acknowledged:true});
 f.restart();view=await f.settings.projectSnapshot();assert.equal(view.tasks[0].status,'handled');assert.equal(view.tasks[0].alert.acknowledged,true);assert.deepEqual(f.store.dispatch('attempt'),original);
 await f.settings.setExecutorAlertDisposition({recordId:alert.recordId,fingerprint:alert.fingerprint,acknowledged:false});assert.equal((await f.settings.projectSnapshot()).tasks[0].status,'error');
 await f.settings.setExecutorAlertDisposition({recordId:alert.recordId,fingerprint:alert.fingerprint,acknowledged:true});
 f.store.createDispatch({...f.record('acknowledged','failure','attempt-2'),claim:{...original.claim,run:{...original.claim.run,updatedAt:'2026-10-23T00:00:00Z'}},receipt:{commandId:'result-2',acceptedAt:'2026-10-23T00:00:00Z',value:{}}});
 view=await f.settings.projectSnapshot();assert.equal(view.tasks[0].status,'error');assert.equal(view.tasks[0].alert.acknowledged,false);
 const changed=f.store.dispatch('attempt');f.store.saveDispatch({...changed,result:{outcome:'partial',summary:'New partial result'}});
 await assert.rejects(f.settings.setExecutorAlertDisposition({recordId:alert.recordId,fingerprint:alert.fingerprint,acknowledged:true}),e=>e.details.reason==='ALERT_CHANGED');
});
for(const state of ['dispatching','uncertain','result','cancellation','retry_pending'])test(`cannot acknowledge ${state} execution or undelivered responsibility`,async t=>{
 const f=panel(t);f.store.createDispatch(f.record(state));const alert=(await f.settings.projectSnapshot()).runs[0].alert;assert.equal(alert.canAcknowledge,false);
 await assert.rejects(f.settings.setExecutorAlertDisposition({recordId:alert.recordId,fingerprint:alert.fingerprint,acknowledged:true}),e=>e.details.reason==='ALERT_STILL_ACTIVE');
});
test('Task cancellation changes local presentation without rewriting the historical blocked Run or raw claim receipt',async t=>{
 const f=panel(t);f.store.createDispatch(f.record());f.store.saveOutbound('claim-record',{operation:'claim',payload:{runId:'run'},state:'done',receipt:{result:{value:{attempt:{attemptId:'attempt'},run:{runId:'run'}}}},endpoint:'https://current.invalid/',audience:'current'});
 const authority={endpoint:'https://current.invalid/',audience:'current'};
 const {executorAlertFingerprint}=await import('../dist/executor-alerts.js');f.store.saveExecutionObservation('dispatch:attempt',executorAlertFingerprint(authority),f.disposition,Date.now());
 let view=await f.settings.projectSnapshot();assert.equal(view.tasks[0].status,'cancelled');assert.equal(view.runs[0].state,'acknowledged');assert.equal(view.tasks[0].authorityDisposition.runState,'blocked');assert.equal(f.store.dispatch('attempt').claim.run.state,'blocked');
 f.store.saveDispatch({...f.record(),state:'result'});view=await f.settings.projectSnapshot();assert.equal(view.tasks[0].status,'review');assert.equal(view.tasks[0].alert.canAcknowledge,false);
 f.store.saveOutbound('old-claim',{operation:'claim',payload:{runId:'old-run'},state:'uncertain',endpoint:'https://old.invalid/',audience:'old',receipt:{state:'uncertain'}});
 const claim=(await f.settings.projectSnapshot()).viewContext.unresolvedClaims[0];assert.equal(claim.alert.canAcknowledge,true);
 await f.settings.setExecutorAlertDisposition({recordId:claim.alert.recordId,fingerprint:claim.alert.fingerprint,acknowledged:true});assert.equal(f.store.outbound('old-claim').state,'uncertain');assert.equal(f.store.outbound('old-claim').receipt.state,'uncertain');
});
test('current authority claim cancellation is observed; old authority and failed observations do not clear warnings',async t=>{
 const f=panel(t);for(const [key,endpoint]of [['current','https://current.invalid/'],['old','https://old.invalid/']])f.store.saveOutbound(key,{operation:'claim',payload:{runId:key},state:'uncertain',endpoint,audience:key});
 const calls=[];f.remote.client={cachedExecutorIdentity:()=>({schedulerId:'scheduler-fixture'})};f.remote.coordinatorLedger={executionDisposition:async input=>{calls.push(input);return {...f.disposition,runId:input.runId,attemptId:null,currentAttemptId:null,attemptState:null};}};
 await f.remote.observeExecutorDispositions();let claims=(await f.settings.projectSnapshot()).viewContext.unresolvedClaims;
 assert.equal(calls.length,1);assert.equal(calls[0].runId,'current');assert.equal(claims.find(c=>c.runId==='current').resolved,true);assert.equal(claims.find(c=>c.runId==='old').resolved,false);assert.equal(f.store.outbound('current').state,'uncertain');
 const current=claims.find(c=>c.runId==='current');await f.settings.setExecutorAlertDisposition({recordId:current.alert.recordId,fingerprint:current.alert.fingerprint,acknowledged:true});
 f.remote.dispositionProbes.clear();await f.remote.observeExecutorDispositions();claims=(await f.settings.projectSnapshot()).viewContext.unresolvedClaims;assert.equal(claims.find(c=>c.runId==='current').alert.acknowledged,true,'observedAt does not change the acknowledgement fingerprint');
 f.store.saveOutbound('unreadable',{operation:'claim',payload:{runId:'unreadable'},state:'uncertain',endpoint:'https://current.invalid/',audience:'current'});
 f.remote.coordinatorLedger.executionDisposition=async()=>{throw Error('unsupported or disconnected authority');};f.remote.dispositionProbes.clear();await f.remote.observeExecutorDispositions();
 const unknown=(await f.settings.projectSnapshot()).viewContext.unresolvedClaims.find(c=>c.runId==='unreadable');assert.equal(unknown.resolved,false);assert.equal(unknown.alert.canAcknowledge,false);assert.equal(f.store.executionObservation('claim:unreadable'),undefined);

});
test('local ledger terminal exceptions share the same acknowledgement while pending result journal remains visible',async t=>{
 const f=panel(t);f.ledger.registerNode('node',{nodeId:'MBP',roles:['executor'],enabled:true,workspaceIds:[],capabilities:[],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}]});
 const task=f.ledger.createTask('task',{title:'Local terminal task'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'MBP',provider:'fixture',model:'fixture',requiredCapabilities:[]}}).value;
 const claim=f.ledger.claim('claim',{nodeId:'MBP',runId:run.runId,ttlMs:10000}).value;f.ledger.submit('blocked',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'MBP',fence:claim.attempt.fence,outcome:'blocked',summary:'Actual local blocked result'});
 const taskSystem=f.settings.ctx.get('taskSystem');f.settings.ctx={get:key=>key==='taskSystem'?taskSystem:undefined};
 const alert=(await f.settings.projectSnapshot()).runs[0].alert;assert.equal(alert.canAcknowledge,true);await f.settings.setExecutorAlertDisposition({recordId:alert.recordId,fingerprint:alert.fingerprint,acknowledged:true});assert.equal((await f.settings.projectSnapshot()).runs[0].status,'handled');
 taskSystem.results.pending=()=>[{ref:{runId:run.runId},sessionId:'local-session',settlement:{summary:'Pending local result'}}];
 const pending=(await f.settings.projectSnapshot()).runs[0];assert.equal(pending.status,'review');assert.equal(pending.alert.canAcknowledge,false);assert.equal(pending.alert.acknowledged,false);
});

test('authenticated disposition reads only the assigned execution and exposes cancelled Task with original blocked Run',async t=>{
 const ledger=TaskLedger.open(':memory:',{role:'planner',nodeId:'scheduler'}),store=new RecoveryStore(':memory:'),outbound=new RecoveryStore(':memory:');
 const keys=generateKeyPairSync('ed25519');
 t.after(()=>{ledger.close();store.close();outbound.close();});
 for(const nodeId of ['MBP','other']){
  ledger.registerWorkspace('workspace-'+nodeId,{workspaceId:'ws-'+nodeId,nodeId,path:'/tmp/'+nodeId,label:nodeId,state:'ready',createdAt:new Date().toISOString()});
  ledger.registerNode('node-'+nodeId,{nodeId,roles:['executor'],enabled:true,workspaceIds:['ws-'+nodeId],capabilities:[],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}]});
 }
 const task=ledger.createTask('task',{title:'Final blocked evidence',description:'Must not be included in disposition'}).value,route={nodeId:'MBP',workspaceId:'ws-MBP',provider:'fixture',model:'fixture',requiredCapabilities:[]};
 const run=ledger.createRun('run',{taskId:task.taskId,route}).value,claim=ledger.claim('claim',{runId:run.runId,nodeId:'MBP',ttlMs:10000}).value;
 ledger.submit('blocked',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'MBP',fence:claim.attempt.fence,outcome:'blocked',summary:'Result already returned'});ledger.cancel('cancel',{taskId:task.taskId,reason:'User cancelled'});
 const peer={nodeId:'MBP',keyId:'key',audience:'scheduler',publicKey:keys.publicKey,operations:['executorIdentity','executionDisposition'],workspaces:['ws-MBP'],capabilities:[]};
 const gateway=new RemoteGateway({role:'planner',nodeId:'scheduler',ledger,store,verifier:new IdentityVerifier({audience:'scheduler',peers:[peer]})});t.after(()=>gateway.dispose());
 let denial;const client=new RemoteClient({endpoint:'https://scheduler.invalid/',nodeId:'MBP',keyId:'key',audience:'scheduler',privateKey:keys.privateKey,store:outbound,fetch:async(_url,options)=>{try{return new Response(JSON.stringify(await gateway.handle(options.body)));}catch(error){denial=error;throw error;}}});t.after(()=>client.dispose());
 await client.executorIdentity();const remote=new RemoteLedgerClient(client,'MBP');
 const value=await remote.executionDisposition({runId:run.runId,attemptId:claim.attempt.attemptId});assert.equal(value.taskState,'cancelled');assert.equal(value.runState,'blocked');assert.equal(value.attemptState,'settled');assert.equal(value.schedulerId,ledger.schedulerIdentity());assert.equal((await remote.executionDisposition({runId:run.runId})).taskState,'cancelled');assert.doesNotMatch(JSON.stringify(value),/Must not|description|report|route/);
 const currentIdentity=client.cachedExecutorIdentity.bind(client);client.cachedExecutorIdentity=()=>({...currentIdentity(),schedulerId:'scheduler-rebuilt'});
 await assert.rejects(remote.executionDisposition({runId:run.runId,attemptId:claim.attempt.attemptId}),error=>error.code==='SCHEDULER_IDENTITY_CHANGED');client.cachedExecutorIdentity=currentIdentity;

 const foreignTask=ledger.createTask('other',{title:'Private other node'}).value,foreign=ledger.createRun('other-run',{taskId:foreignTask.taskId,route:{...route,nodeId:'other',workspaceId:'ws-other'}}).value;
 await assert.rejects(remote.executionDisposition({runId:foreign.runId}),/REMOTE_OUTCOME_UNCERTAIN/);assert.equal(denial.code,'NODE_ROUTE_DENIED');
 assert.equal(ledger.getRun(run.runId).state,'blocked');assert.equal(ledger.snapshot().attempts.length,1);
});

test('new same-Run claim remains visible beside a previously confirmed attempt, and authority is exact to that attempt',async t=>{
 const f=panel(t);f.store.createDispatch(f.record());const original=(await f.settings.projectSnapshot()).tasks[0].alert;
 await f.settings.setExecutorAlertDisposition({recordId:original.recordId,fingerprint:original.fingerprint,acknowledged:true});
 f.store.saveOutbound('old-claim',{operation:'claim',payload:{runId:'run'},state:'done',endpoint:'https://old.invalid/',audience:'old',receipt:{state:'done',result:{value:{attempt:{attemptId:'attempt'},run:{runId:'run'}}}}});
 f.store.saveOutbound('new-retry-claim',{operation:'claim',payload:{runId:'run'},state:'uncertain',endpoint:'https://current.invalid/',audience:'current'});
 assert.deepEqual(f.store.dispatchAuthority('run','attempt'),{endpoint:'https://old.invalid/',audience:'old'});
 assert.equal(f.store.dispatchAuthority('run','different-attempt'),undefined);
 const view=await f.settings.projectSnapshot();assert.equal(view.viewContext.unresolvedClaims.length,1);assert.equal(view.viewContext.unresolvedClaims[0].commandId,'new-retry-claim');assert.equal(view.viewContext.unresolvedClaims[0].alert.acknowledged,false);assert.equal(view.viewContext.unresolvedClaims[0].alert.canAcknowledge,false);
});
