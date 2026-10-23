import test from 'node:test';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createNativeHarness} from './native-harness.mjs';
import {attachWorkspaceRegistry} from '../settings/local-workspace-harness.mjs';
import {RecoveryStore,RemoteGateway,RemoteClient,RemoteLedgerClient,TrustedNetworkVerifier,httpHandler,ExecutorWorker,nativeExecutionAdapter} from '../../packages/task-system/dist/remote/api.js';
import {executionWorkspace} from '../../packages/task-system/dist/remote/project-workspace.js';

test('trusted managed workspace announcement → project settings → coordinator child claim creates native session in the selected executor repository', {timeout:20000},async()=>{
 const planner=await createNativeHarness({config:{role:'planner',nodeId:'planner',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
 const worker=await createNativeHarness({executionRoot:true,config:{role:'executor',nodeId:'worker',schedulerEnabled:false},script:[{name:'task_submit_result',args:{outcome:'success',summary:'Verified selected repository cwd',reportTitle:'Workspace evidence',reportBody:'The native session uses the owner-authorized original repository.'}}]});
 const stores=['server','client','worker'].map(n=>new RecoveryStore(join(worker.dir,n+'.sqlite')));let gateway,client,executor,server;
 try {
  const registry=await attachWorkspaceRegistry(planner),coordinator=join(planner.dir,'scheduler-local'),repository=join(worker.dir,'existing-repository');mkdirSync(coordinator);mkdirSync(repository);const official=await registry.create(coordinator,'Scheduler-only directory');
  const runtime=planner.ctx.taskSystem.projects,{projectId}=await runtime.create({commandId:'project',title:'Workspace routing fixture',goal:'Use executor selected repository without confusing scheduler cwd',workspace:{kind:'registered',nodeId:'planner',workspaceId:'registry:'+official.id}});
  assert.throws(()=>planner.ledger.getNode('planner'),{code:'NOT_FOUND'});
  let handler;server=createServer((req,res)=>handler(req,res));await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;
  const network={listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1'],peers:[{address:'127.0.0.1',nodeId:'',role:'executor',audience:'planner',operations:[],workspaces:[],capabilities:[]}]};
  gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger:planner.ledger,store:stores[0],verifier:new TrustedNetworkVerifier({audience:'planner',...network,pairings:stores[0]})});handler=httpHandler(gateway,{trustedNetwork:network});
  client=new RemoteClient({authMode:'trusted-network',endpoint:`http://127.0.0.1:${port}/commands`,nodeId:'worker',audience:'planner',trustedNetwork:{address:'127.0.0.1',port,localAddress:'127.0.0.1',allowHttp:true},store:stores[1]});
  const remote=new RemoteLedgerClient(client,'worker');
  await remote.recordNodeHeartbeat('workspace-announcement',{nodeId:'worker',sampledAt:Date.now(),runtimeReady:true,activeExecutions:0,workspaces:[{workspaceId:'owner-grant',nodeId:'worker',path:repository,label:'Existing executor repository',state:'ready'}]});
  const l=planner.ledger;l.registerNode('runtime-models',{...l.getNode('worker'),models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],maxConcurrent:2});
  const req=l.executionModels.request('models',{nodeId:'worker'}).catalog.request;l.completeExecutionModels('model-result',{nodeId:'worker',requestId:req.requestId,generation:req.generation,result:{state:'success',complete:true,observedAt:Date.now(),models:[{provider:'test-offline',model:'script'}]}});
  await runtime.saveExecutionSettings({projectId,expectedRevision:0,allowedNodeIds:['worker'],executionBindings:{worker:'owner-grant'}});
  const sessionId=runtime.executionSettings(projectId).coordinatorSession.sessionId,origin={kind:'session',nodeId:'planner',sessionId,cwd:coordinator,composition:{provider:'test-offline',model:'script',tools:[]}};
  const parent=l.withDispatchOrigin(origin,()=>l.createTask('parent',{title:'Parent coordinator',policy:{settlementQuietMs:0}}).value),bound=l.bindDispatcher('bind',{nodeId:'planner',sessionId,taskId:parent.taskId,projectId}).value;
  const child=l.createTask('child',{title:'Read-only child',parentTaskId:parent.taskId}).value;
  const run=l.createRun('run',{taskId:child.taskId,parentRunId:bound.runId,route:{nodeId:'worker',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
  assert.equal(run.executionParentKind,'coordinator');assert.equal(run.route.workspaceId,'owner-grant');assert.doesNotMatch(JSON.stringify(run),/scheduler-local/);
  const provider=nativeExecutionAdapter(worker.ctx.taskSystem.native,{provider:'test-offline',models:[{model:'script',reasoningEfforts:[]}],capabilities:[]});
  executor=new ExecutorWorker({ledger:remote,provider,store:stores[2],policy:{role:'executor',nodeId:'worker',capabilities:[],workspaces:[{workspaceId:'owner-grant',nodeId:'worker',path:repository,allowedRoot:repository}]}});
  const result=await executor.pollOnce(1);assert.equal(result[0].value.state,'acknowledged',JSON.stringify(result));assert.equal(l.getRun(run.runId).state,'succeeded');
  const record=stores[2].dispatches().find(r=>r.claim.run.runId===run.runId);assert.ok(record?.sessionId);assert.equal((await worker.ctx.sessionPersistence.stat(SessionId(record.sessionId))).header.cwd,repository);
  assert.equal(await executionWorkspace({parent:repository,claim:record.claim,store:stores[2],sessionId:record.sessionId,resume:true}),repository);
  // The same selected repository still isolates a true recursive executor child.
  const recursive={...record.claim,task:{...record.claim.task,taskId:'recursive-child'},run:{...record.claim.run,parentRunId:run.runId,executionParentKind:'executor',executionParentRunId:run.runId}};
  const recursiveCwd=await executionWorkspace({parent:repository,claim:recursive,store:stores[2],sessionId:'recursive-session',resume:false});assert.notEqual(recursiveCwd,repository);assert.ok(recursiveCwd.startsWith(join(repository,'.dsh','delegated')));
  assert.equal(l.snapshot().attempts.length,1);assert.equal(worker.adapter.requests.length,1);
 } finally {await executor?.dispose();await client?.dispose();await gateway?.dispose();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}stores.forEach(s=>s.close());await worker.dispose();await planner.dispose();}
});
