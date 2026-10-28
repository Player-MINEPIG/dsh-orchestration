import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateKeyPairSync} from 'node:crypto';
import {join} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
import * as remotePlugin from '../../packages/task-system/dist/remote/index.js';
import {RemoteGateway,RecoveryStore,IdentityVerifier,TrustedNetworkVerifier,httpHandler} from '../../packages/task-system/dist/remote/api.js';
import {TaskPluginSettings} from '../../packages/task-system/dist/settings.js';
import {deploymentPolicy,ledgerRole} from '../../packages/task-system/dist/deployment.js';
import {Workbench} from '../../packages/task-system/dist/workbench.js';

let sequence = 0;
async function call(h, agent, name, args) {
  const result = await h.ctx.tools.execute({name,arguments:args,callId:ToolCallId(`session-duty-${++sequence}`),agent,signal:new AbortController().signal});
  assert.equal(result.isError,false,JSON.stringify(result.error));
  return result.value;
}
function models(ledger,nodeId) {
  const request=ledger.executionModels.request(`catalog-${++sequence}`,{nodeId}).catalog.request;
  ledger.completeExecutionModels(`catalog-result-${++sequence}`,{nodeId,requestId:request.requestId,generation:request.generation,result:{state:'success',complete:true,observedAt:Date.now(),models:[{provider:'test-offline',model:'script'}]}});
}

test('deployment separates central hosting and execution, preserves explicit legacy grants and never defaults to both',()=>{
  assert.deepEqual(deploymentPolicy({centralMode:'host'}),{centralMode:'host',executionEnabled:false});
  assert.deepEqual(deploymentPolicy({}),{centralMode:'host',executionEnabled:true});
  for(const role of ['planner','executor','both']) {
    assert.equal(deploymentPolicy({role}).executionEnabled,role!=='planner');
    assert.equal(deploymentPolicy({role}).centralMode,role==='executor'?'remote':'host');
  }
  assert.equal(ledgerRole(deploymentPolicy({centralMode:'remote',executionEnabled:false,role:'both'})),'executor');
  assert.equal(deploymentPolicy({role:'both',executionEnabled:false}).executionEnabled,false);
  assert.deepEqual(deploymentPolicy({role:'executor',executionEnabled:false}),{centralMode:'remote',executionEnabled:false});
  assert.equal(deploymentPolicy({role:'both',centralMode:'remote'}).executionEnabled,false);
  assert.equal(deploymentPolicy({role:'executor',centralMode:'host'}).executionEnabled,false);
});

for (const authMode of ['ed25519','trusted-network']) test(`remote central with execution disabled coordinates, cold-returns over ${authMode} HTTP and never claims or creates local authority`,async t=>{
  const workloadReady=Promise.withResolvers(),workloadGate=Promise.withResolvers();
  const central=await createNativeHarness({executionRoot:true,config:{nodeId:'central',centralMode:'host',executionEnabled:true,planningDecisionEnabled:false},script:[async()=>{workloadReady.resolve();await workloadGate.promise;return {name:'task_submit_result',args:{outcome:'success',summary:'Child verified',reportBody:'Native child evidence'}};}]});
  const local=await createNativeHarness({config:{nodeId:'dispatcher',centralMode:'remote',executionEnabled:false,planningDecisionEnabled:false}});
  let origin;
  const stores=[], servers=[];
  t.after(async()=>{await origin?.dispose();await local.dispose();await central.dispose();for(const server of servers)await new Promise(resolve=>server.close(resolve));for(const store of stores)store.close();delete process.env.DSH_SESSION_DUTY_TEST_KEY;});
  const ledger=central.ledger;let clock=Date.now();ledger.clock=()=>clock;
  t.after(()=>workloadGate.resolve());
  ledger.registerNode('central-node',{nodeId:'central',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true,maxConcurrent:2});models(ledger,'central');
  if (authMode === 'ed25519') ledger.registerNode('dispatcher-node',{nodeId:'dispatcher',roles:['planner'],models:[],capabilities:[],workspaceIds:[],enabled:true});
  const keys=generateKeyPairSync('ed25519');process.env.DSH_SESSION_DUTY_TEST_KEY=keys.privateKey.export({type:'pkcs8',format:'pem'});
  const store=new RecoveryStore(join(central.dir,'signed-server.sqlite'));stores.push(store);
  const operations=['projectCollaborate','projectSnapshot','sessionMessages','sessionMessageReply','receipt'];
  let gateway,network,offline=false;
  const server=createServer((req,res)=>offline?(res.writeHead(503),res.end('{}')):httpHandler(gateway,{allowLoopbackHttp:true,...(network?{trustedNetwork:network}:{})})(req,res));servers.push(server);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  network=authMode==='trusted-network'?{listen:{address:'127.0.0.1',port:server.address().port},allowHttp:true,allowedAddresses:['127.0.0.1'],peers:[{address:'127.0.0.1',nodeId:'',executionEnabled:false,audience:'central',operations:[],workspaces:[],capabilities:[]}]}:undefined;
  const verifier=network?new TrustedNetworkVerifier({...network,audience:'central',pairings:store}):new IdentityVerifier({audience:'central',peers:[{keyId:'dispatcher-key',nodeId:'dispatcher',publicKey:keys.publicKey,audience:'central',operations,workspaces:[],capabilities:[]}]});
  gateway=new RemoteGateway({role:'both',nodeId:'central',ledger,store,verifier});
  await local.ctx.plugin(remotePlugin,{authMode,role:'executor',nodeId:'dispatcher',statePath:join(local.dir,'transport.sqlite'),exposeHttp:false,routePath:'/commands',audience:'dispatcher',peers:[],capabilities:[],workspaces:[],allowLoopbackHttp:authMode==='ed25519',pollIntervalMs:100,concurrency:1,coordinator:{endpoint:`http://127.0.0.1:${server.address().port}/commands`,audience:'central',authMode,...(network?{trustedNetwork:{address:'127.0.0.1',port:server.address().port,localAddress:'127.0.0.1',allowHttp:true}}:{keyId:'dispatcher-key',privateKeyEnv:'DSH_SESSION_DUTY_TEST_KEY'}),nativeRoutes:[],heartbeatIntervalMs:1000}});
  assert.deepEqual(ledger.getNode('dispatcher').roles,['planner']);
  assert.equal(local.ctx.taskSystem.native,undefined);
  assert.equal(local.ctx.taskSystem.projects,undefined);
  assert.equal(local.ctx.remoteExecution.nativeWorker,undefined);
  assert.throws(()=>local.ctx.remoteExecution.createWorker({}),/EXECUTION_DISABLED/);
  assert.throws(()=>local.ledger.createTask('forbidden-local',{title:'Second authority'}),/Executor/);
  origin=await local.ctx.agents.create({sessionId:SessionId('local-original'),meta:{cwd:local.dir},agentOptions:{provider:'test-offline',model:'script'}});
  const project=await call(local,origin.agent,'project_start',{title:'Device-local materials',goal:'Coordinate without central cwd'});
  assert.equal(ledger.snapshot().tasks.length,0);
  assert.equal(central.ctx.taskSystem.projects.snapshot().projects[0].title,'Device-local materials');
  const draft=(await call(local,origin.agent,'task_create',{commandId:'parent',title:'Parent',policy:{settlementQuietMs:0}})).value;
  const binding=(await call(local,origin.agent,'task_bind_dispatcher',{commandId:'bind',taskId:draft.taskId})).value;
  const request={commandId:'child',title:'Child',description:'Execute on the enabled central device',nodeId:'central',expectedExecutionMs:1000,executionModel:{provider:'test-offline',model:'script'}};
  const dispatched=await call(local,origin.agent,'task_dispatch',request);
  assert.deepEqual(await call(local,origin.agent,'task_dispatch',request),dispatched);
  const child=ledger.snapshot().tasks.find(task=>task.parentTaskId===draft.taskId),run=ledger.history(child.taskId).runs[0];
  assert.equal(run.dispatchOrigin.nodeId,'dispatcher');assert.equal(run.dispatchOrigin.cwd,local.dir);assert.equal(run.parentRunId,binding.runId);assert.equal(run.workspaceConstraint,undefined);
  assert.equal(run.executionParentKind,'coordinator');assert.equal(run.executionExpectation.phase,'pending_start');assert.equal(run.dispatchOrigin.parentLease,undefined);
  ledger.checkins.tick();assert.equal(ledger.checkins.view(draft.taskId).category,'waiting_children');
  assert.equal((await call(local,origin.agent,'task_query',{})).tasks.length,2);
  const outsider=ledger.createTask('outside',{title:'Unrelated private task'}).value;
  const rejected=await local.ctx.tools.execute({name:'task_history',arguments:{taskId:outsider.taskId},callId:ToolCallId('outside'),agent:origin.agent,signal:new AbortController().signal});assert.equal(rejected.isError,true);
  assert.equal(local.ledger.snapshot().tasks.length,0);
  await local.ctx.sessions.flush(origin.agent.session);await origin.dispose();origin=undefined;
  local.adapter.script.push('Verified child still running; wait for its formal result.',{name:'task_history',args:{taskId:child.taskId}},{name:'task_submit_result',args:{outcome:'success',summary:'Reviewed child',reportBody:'Original local session reviewed native result'}});
  const claim=ledger.claim('enabled-claim',{runId:run.runId,nodeId:'central',ttlMs:10000}).value;
  const execution=central.ctx.taskSystem.native.execute(claim);await workloadReady.promise;
  assert.equal(ledger.getRun(run.runId).executionExpectation.phase,'started');clock+=1000;ledger.checkins.tick();
  const progress=ledger.sessionMessages(child.taskId).find(message=>message.checkIn?.kind==='execution-deadline');assert.ok(progress);assert.equal(progress.sessionId,'local-original');
  for(let i=0;i<100&&ledger.getSessionMessage(progress.messageId).state!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(ledger.getSessionMessage(progress.messageId).state,'completed');assert.equal(ledger.getRun(run.runId).state,'running');assert.equal(ledger.getRun(binding.runId).state,'running');
  ledger.checkins.tick();assert.equal(ledger.sessionMessages(child.taskId).filter(message=>message.checkIn?.kind==='execution-deadline').length,1);
  workloadGate.resolve();await execution;
  for(let i=0;i<100&&ledger.getRun(binding.runId).state==='running';i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(ledger.getRun(binding.runId).state,'succeeded');
  assert.equal(ledger.snapshot().attempts.length,1);assert.equal(ledger.snapshot().attempts[0].nodeId,'central');
  assert.equal(local.ledger.snapshot().tasks.length,0);
  const controls=Object.assign(Object.create(TaskPluginSettings.prototype),{ctx:local.ctx});
  const controller=await local.ctx.agents.create({sessionId:SessionId('control-origin'),meta:{cwd:local.dir},agentOptions:{provider:'test-offline',model:'script'}});
  try {
    await call(local,controller.agent,'project_bind_session',{projectId:project.binding.projectId});
    const extra=await call(local,controller.agent,'task_dispatch',{...request,commandId:'cancel-child',title:'Cancel this child'});
    const projected=await controls.projectSnapshot({view:'planner'}),row=projected.tasks.find(task=>task.id===extra.taskId);
    assert.equal(row.canCancel,true);
    await controls.actOnProjectTask({commandId:'cancel-through-ui',taskId:row.id,runId:row.runId,expectedVersion:row.actionVersion,action:'cancel'});
    assert.equal(ledger.getTask(row.id).state,'cancelled');
    const cancelledReturn=ledger.history(row.id).resultReturns.at(-1);
    for(let n=0;n<3;n++)ledger.recordTaskReturnFailure(cancelledReturn.messageId,'RETURN_UNAVAILABLE');
    const cancelledRow=(await controls.projectSnapshot({view:'planner'})).tasks.find(task=>task.id===row.id);
    assert.equal(cancelledRow.status,'cancelled');assert.equal(cancelledRow.checkin.returnDelivery,null);assert.notEqual(cancelledRow.checkin.responsibility.state,'needs_user');
    assert.equal(ledger.getSessionMessage(cancelledReturn.messageId).state,'failed','cancelled return remains historical evidence');
    const owned=ledger.withDispatchOrigin(ledger.getRun(extra.dispatch.runId).dispatchOrigin,()=>{
      const task=ledger.createTask('return-control-task',{title:'Unanswered return control'}).value;
      const wb=new Workbench(ledger),backlog=wb.snapshot().backlogs.find(backlog=>backlog.projectId===project.binding.projectId);
      wb.manage('link-return-control','link_backlog_task',{taskId:task.taskId,backlogId:backlog.backlogId});
      const run=ledger.createRun('return-control-run',{taskId:task.taskId,route:{nodeId:'central',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
      const claim=ledger.claim('return-control-claim',{runId:run.runId,nodeId:'central',ttlMs:10000}).value.attempt;
      ledger.submit('return-control-failed',{runId:run.runId,attemptId:claim.attemptId,nodeId:'central',fence:claim.fence,outcome:'failure',summary:'Active task failed and still needs coordinator follow-up'});
      const message=ledger.history(task.taskId).resultReturns[0];
      for(let n=0;n<3;n++)ledger.recordTaskReturnFailure(message.messageId,'RETURN_UNAVAILABLE');
      return {task,run,message};
    });
    const returnRow=(await controls.projectSnapshot({view:'planner'})).tasks.find(task=>task.id===owned.task.taskId);
    assert.equal(returnRow.status,'error');assert.equal(returnRow.checkin.returnDelivery.messageId,owned.message.messageId);
    const retry={commandId:'return-through-ui',taskId:owned.task.taskId,runId:owned.run.runId,expectedVersion:returnRow.actionVersion,action:'retry-return',returnMessageId:owned.message.messageId};
    const receipt=await controls.actOnProjectTask(retry);
    assert.deepEqual(await controls.actOnProjectTask(retry),receipt,'signed control replay retains the original event');
    assert.equal(ledger.getSessionMessage(owned.message.messageId).state,'queued');
    assert.equal(ledger.history(owned.task.taskId).runs.length,1);
    await assert.rejects(controls.actOnProjectTask({...retry,commandId:'wrong-return-owner',taskId:row.id,expectedVersion:ledger.taskActionState(row.id).version}));
    await assert.rejects(controls.actOnProjectTask({commandId:'cross-device-ui',taskId:outsider.taskId,runId:null,expectedVersion:ledger.taskActionState(outsider.taskId).version,action:'cancel'}));
  } finally {await controller.dispose();}
  offline=true;
  const offlineAgent=await local.ctx.agents.create({sessionId:SessionId('offline-start'),meta:{cwd:local.dir},agentOptions:{provider:'test-offline',model:'script'}});
  try {
    const result=await local.ctx.tools.execute({name:'project_start',arguments:{title:'Pending project'},callId:ToolCallId('offline'),agent:offlineAgent.agent,signal:new AbortController().signal});assert.equal(result.isError,true);
    assert.equal(local.ctx.taskSystem.sessionCollaboration.binding(offlineAgent.agent).state,'pending');assert.equal(local.ledger.snapshot().tasks.length,0);
    offline=false;await call(local,offlineAgent.agent,'project_start',{title:'Pending project'});
    assert.equal(local.ctx.taskSystem.sessionCollaboration.binding(offlineAgent.agent).state,'active');
  } finally {await offlineAgent.dispose();}
  await gateway.dispose();
});

test('nonexecuting central host consumes returns ahead of old messages and excludes them from configuration edits',async t=>{
  const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});t.after(()=>h.dispose());
  const service=h.ctx.taskSystem,db=h.ledger.managementDatabase();
  const save=message=>db.prepare("INSERT INTO entities(kind,id,parent,state,data) VALUES('sessionMessage',?,?,?,?)").run(message.messageId,message.taskId,'queued',JSON.stringify(message));
  for(let i=0;i<4;i++)save({messageId:`old-${i}`,taskId:'old',nodeId:'local',sessionId:'old',state:'queued'});
  const returned=h.ledger.createTask('return-fixture',{title:'Return fixture'}).value;
  const completion=id=>({messageId:id,taskId:returned.taskId,nodeId:'local',sessionId:'origin',workspaceId:'origin-session',state:'queued',completion:{eventId:id,runId:'child-run',origin:{kind:'session',nodeId:'local',sessionId:'origin',cwd:h.dir}}});
  let deliveries=0,started,finish;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>finish=resolve);
  service.taskReturns.deliver=async()=>{deliveries++;started();await gate;return 'Verified'};
  save(completion('first'));service.tick();await ready;
  assert.equal(deliveries,1);assert.throws(()=>service.beginConfigurationEdit(),/CONFIGURATION_BUSY|active/);
  finish();await service.returnJob;
  const release=service.beginConfigurationEdit();save(completion('second'));service.tick();assert.equal(deliveries,1);release();
  service.tick();await service.returnJob;assert.equal(deliveries,2);assert.equal(h.ledger.pendingSessionMessages('local',{kind:'message'}).length,4);
});


test('native host admits another session return while the first session is still processing', {timeout:10000}, async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});
 let release;const gate=new Promise(resolve=>release=resolve),seen=[];
 try{
  const service=h.ctx.taskSystem,db=h.ledger.managementDatabase(),task=h.ledger.createTask('return-task',{title:'Completed child'}).value;
  const save=id=>{const message={messageId:id,taskId:task.taskId,nodeId:'local',sessionId:id,workspaceId:'origin-session',state:'queued',completion:{eventId:id,origin:{kind:'session',nodeId:'local',sessionId:id}},text:'Result'};db.prepare("INSERT INTO entities(kind,id,parent,state,data) VALUES('sessionMessage',?,?,?,?)").run(id,task.taskId,'queued',JSON.stringify(message));};
  service.taskReturns.deliver=async message=>{seen.push(message.messageId);if(message.messageId==='first')await gate;return 'Processed';};
  save('first');service.tick();
  for(let i=0;i<100&&!seen.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  save('second');service.tick();
  for(let i=0;i<100&&h.ledger.getSessionMessage('second').state!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(seen,['first','second']);assert.equal(h.ledger.getSessionMessage('first').state,'queued');assert.equal(h.ledger.getSessionMessage('second').state,'completed');
  assert.throws(()=>service.beginConfigurationEdit(),{code:'CONFIGURATION_BUSY'});
 }finally{release();await h.dispose();}
});
