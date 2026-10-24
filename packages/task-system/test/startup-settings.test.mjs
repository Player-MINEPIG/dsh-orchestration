import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { ProjectSessionService } from '../dist/project-session-service.js'
import { RemoteClient, RemoteLedgerClient } from '../dist/remote/api.js'
import { parseCommandEnvelope } from '../dist/remote/protocol.js'
import { Context } from '@deepseek-ai/cordis'
import { TaskLedger } from '../dist/ledger.js'
import { TaskSystemService } from '../dist/dsh-plugin.js'
import { RemoteExecutionService, Config as RemoteConfig } from '../dist/remote/index.js'
import { RecoveryStore, ExecutorWorker, RemoteGateway, IdentityVerifier } from '../dist/remote/api.js'
import { readConnectionSettings, saveConnectionSettings } from '../dist/connection-settings.js'
import { readStartupSettings, saveStartupSettings, SaveStartupInput } from '../dist/startup-settings.js'
import { startupDescriptor, saveStartupDescriptor } from '../dist/settings.js'

function fixture(t) {
  const ledger=TaskLedger.open(':memory:');t.after(async()=>{await task.sessionPortal?.close();ledger.close()})
  for(const workspaceId of ['default','other']) ledger.registerWorkspace(`w-${workspaceId}`,{workspaceId,nodeId:'worker',path:`/tmp/${workspaceId}`,label:workspaceId,state:'ready',createdAt:new Date().toISOString()})
  ledger.registerNode('node',{nodeId:'worker',roles:['both'],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default','other'],enabled:true,lastSeenAt:new Date().toISOString()})
  const raw={role:'both',defaultWorkspaceId:'default',sessionDecisionEnabled:false,databasePath:'/tmp/private.sqlite',nodeId:'worker',executionTools:[],privateMarker:'NOT_A_REAL_SECRET',unknownExtension:{keep:true}}
  const remoteRaw=RemoteConfig({role:'executor',nodeId:'worker',authMode:'trusted-network',taskSessionsEnabled:true,coordinator:{endpoint:'http://127.0.0.1:45678/commands',audience:'planner',authMode:'trusted-network',trustedNetwork:{address:'127.0.0.1',port:45678,localAddress:'127.0.0.2',allowHttp:true},nativeRoutes:[]}})
  remoteRaw.executionLimits=remoteRaw.executionLimits.get();
  remoteRaw.unknownExtension={keep:true}
  const taskRow={options:{id:'task-system',name:'@dsh-task/task-system/plugin',config:raw}},remoteRow={options:{id:'task-remote-execution',name:'@dsh-task/task-system/remote',config:remoteRaw}}
  const rows=[taskRow,remoteRow],writes=[]
  const host={entries:()=>rows,edit:async(entry,change)=>{await host.before?.();const next=change(structuredClone(entry.options.config),{});if(host.fail) throw Error('Configuration for task-system is overridden by a home patch or command-line overlay');entry.options.config=next;if(entry===taskRow) Object.assign(task.config,next);writes.push(next)}}
  const task={ledger,config:{...raw},applyLiveNodeCapacities(){return TaskSystemService.prototype.applyLiveNodeCapacities.call(this)},providers:new Set(),configurationPaused:false,beginConfigurationEdit(){return TaskSystemService.prototype.beginConfigurationEdit.call(this)}}
  const store=new RecoveryStore(':memory:');t.after(()=>store.close())
  const remoteCtx=new Context();remoteCtx.provide('taskSystem',task)
  const remote=new RemoteExecutionService(remoteCtx,remoteRaw,ledger,store)
  const profile={overlays:[]}
  const decisions={};
  const ctx={get:key=>({configEditor:host,taskSystem:task,remoteExecution:remote,profileContext:profile,decisionModels:decisions.enabled===false?undefined:decisions})[key]}
  return {ctx,host,task,remote,store,ledger,taskRow,remoteRow,writes,profile,decisions}
}
const input=(f,target,changes)=>({target,expected:readStartupSettings(f.ctx)[target].values,changes})
test('startup read/save descriptors use exact public service methods and a single typed JSON input',()=>{
  assert.equal(startupDescriptor.method,'startup');assert.deepEqual(startupDescriptor.parameters,[])
  assert.equal(saveStartupDescriptor.parameters[0].wire,'input');assert.equal(saveStartupDescriptor.parameters[0].source,'json')
})
test('startup read excludes credentials, node grants and full raw config',t=>{
  const f=fixture(t),view=readStartupSettings(f.ctx)
  assert.equal(view.task.values.role,'both');assert.equal(view.applies,'plugin-restart')
  assert.ok(!JSON.stringify(view).includes('NOT_A_REAL_SECRET'));assert.equal(view.task.values.databasePath,'/tmp/private.sqlite');assert.equal(view.task.values.nodeId,'worker');assert.deepEqual(view.task.values.executionTools,[]);assert.equal(view.task.values.executionAgentPreset,'ptc')
})
test('public ConfigEditor merge persists only selected startup fields and preserves unknown data',async t=>{
  const f=fixture(t),result=await saveStartupSettings(f.ctx,input(f,'task',{sessionDecisionEnabled:true}))
  assert.deepEqual(result,{saved:true,applies:'live'});assert.equal(f.writes.length,1)
  assert.equal(f.taskRow.options.config.privateMarker,'NOT_A_REAL_SECRET');assert.deepEqual(f.taskRow.options.config.unknownExtension,{keep:true});assert.equal(f.taskRow.options.config.defaultWorkspaceId,'default')
  assert.equal(f.task.configurationPaused,false)
})
test('role selection is saved but cannot silently remove incompatible node bootstrap',async t=>{
  const f=fixture(t);f.remoteRow.options.config.paused=true;await saveStartupSettings(f.ctx,input(f,'task',{role:'planner'}));assert.equal(f.taskRow.options.config.role,'planner')
  f.taskRow.options.config.localNode={models:[]};await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{role:'planner'})),{code:'STARTUP_ROLE_CONFLICT'})
  assert.deepEqual(f.taskRow.options.config.localNode,{models:[]})
})
test('CAS rejects a stale startup snapshot without overwriting a newer field',async t=>{
  const f=fixture(t),request=input(f,'task',{role:'executor'});f.taskRow.options.config.sessionDecisionEnabled=true
  await assert.rejects(saveStartupSettings(f.ctx,request),{code:'STARTUP_CONFLICT'});assert.equal(f.writes.length,0);assert.equal(f.taskRow.options.config.role,'both')
})
test('credentials, key identities, grants and arbitrary namespaces cannot enter the edit payload',async t=>{
  const f=fixture(t)
  for(const changes of [{nodeId:'other'},{peers:[]},{privateKeyEnv:'NEW_KEY'},{executionTools:['shell']},{coordinator:{keyId:'replacement'}}]) await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',changes)))
  assert.throws(()=>SaveStartupInput.parse({...input(f,'remote',{endpoint:'https://fixture.invalid/commands'}),namespace:'unrelated-plugin'}))
  assert.equal(f.writes.length,0)
})
test('command-line and Home overrides refuse saves and leave the source intact',async t=>{
  const f=fixture(t);f.profile.overlays=[{id:'task-system',config:{role:'planner'}}]
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{role:'executor'})),{code:'STARTUP_OVERRIDE'});assert.equal(f.writes.length,0)
  f.profile.overlays=[];f.host.fail=true
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{role:'executor'})),{code:'STARTUP_OVERRIDE'});assert.equal(f.writes.length,0);assert.equal(f.task.configurationPaused,false)
})
test('invalid default workspace is never provisioned or granted by the startup RPC',async t=>{
  const f=fixture(t);await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{defaultWorkspaceId:'not-registered'})),);assert.equal(f.writes.length,0);assert.deepEqual(f.ledger.getNode('worker').workspaceIds,['default','other'])
})
test('active claimed work blocks connection changes before ConfigEditor is called',async t=>{
  const f=fixture(t),task=f.ledger.createTask('task',{title:'active'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',provider:'fixture',model:'fixture',workspaceId:'default',requiredCapabilities:[]}}).value
  f.ledger.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:60000})
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',{audience:'another'})),{code:'STARTUP_BUSY'});assert.equal(f.writes.length,0)
})
test('native external work and unresolved remote recovery block startup edits',async t=>{
  const f=fixture(t);f.task.providers.add({activeCount:1})
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{role:'executor'})),{code:'STARTUP_BUSY'})
  f.task.providers.clear();f.store.createDispatch({attemptId:'attempt',state:'uncertain',claim:{task:{taskId:'recovery',title:'Recovery'},run:{runId:'recovery'}},lease:{},sessionId:'session'})
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',{audience:'another'})),{code:'STARTUP_BUSY'});assert.equal(f.writes.length,0);assert.equal(f.task.configurationPaused,false)
})
test('admissions are held throughout asynchronous persistence and released after failure',async t=>{
  const f=fixture(t),task=f.ledger.createTask('task',{title:'queued'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',provider:'fixture',model:'fixture',workspaceId:'default',requiredCapabilities:[]}}).value
  let continueEdit,entered;const editing=new Promise(resolve=>entered=resolve);f.host.before=()=>new Promise(resolve=>{continueEdit=resolve;entered()})
  const saving=saveStartupSettings(f.ctx,input(f,'task',{role:'executor'}));await editing
  assert.throws(()=>f.ledger.claim('claim-during-save',{runId:run.runId,nodeId:'worker',ttlMs:60000}),{code:'CONFIGURATION_BUSY'})
  f.host.fail=true;continueEdit();await assert.rejects(saving,{code:'STARTUP_OVERRIDE'})
  assert.ok(f.ledger.claim('claim-after-save',{runId:run.runId,nodeId:'worker',ttlMs:60000}).value)
})
test('explicit trusted-network target change is validated and preserves all existing auth/grant fields',async t=>{
  const f=fixture(t);const old=structuredClone(f.remoteRow.options.config)
  await saveStartupSettings(f.ctx,input(f,'remote',{endpoint:'http://127.0.0.3:45679/commands',audience:'new-planner',trustedNetworkTarget:{address:'127.0.0.3',port:45679,localAddress:'127.0.0.2',allowHttp:true}}))
  const saved=f.remoteRow.options.config
  assert.equal(saved.coordinator.endpoint,'http://127.0.0.3:45679/commands');assert.equal(saved.coordinator.authMode,old.coordinator.authMode);assert.deepEqual(saved.peers,old.peers);assert.equal(saved.nodeId,old.nodeId);assert.deepEqual(saved.unknownExtension,{keep:true})
})
test('wrong exact address or credential-bearing endpoint never persists',async t=>{
  const f=fixture(t)
  for(const endpoint of ['http://127.0.0.3:45678/commands','https://u:secret@fixture.invalid/commands','http://127.0.0.1:45678/commands?token=secret']) await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',{endpoint})))
  assert.equal(f.writes.length,0)
})
test('an unconfigured connection cannot be enrolled or granted permissions through startup editing',async t=>{
  const f=fixture(t);f.remoteRow.options.config.coordinator=null
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',{endpoint:'https://new.invalid/commands'})),{code:'STARTUP_CONNECTION_REQUIRED'});assert.equal(f.writes.length,0)
})

test('JEV can be enabled with no legacy default workspace and does not invent one',async t=>{
 const f=fixture(t);delete f.taskRow.options.config.defaultWorkspaceId;
 await saveStartupSettings(f.ctx,input(f,'task',{sessionDecisionEnabled:true}));
 assert.equal(f.taskRow.options.config.sessionDecisionEnabled,true);
 assert.equal('defaultWorkspaceId' in f.taskRow.options.config,false);
 assert.equal('defaultWorkspaceId' in readStartupSettings(f.ctx).task.values,false);
})

test('a new explicitly selected trusted-network connection preserves identity and creates no peer grants',async t=>{
  const f=fixture(t);f.remoteRow.options.config.coordinator=null
  const beforePeers=structuredClone(f.remoteRow.options.config.peers),beforeNode=f.remoteRow.options.config.nodeId
  await saveStartupSettings(f.ctx,input(f,'remote',{endpoint:'http://127.0.0.3:45679/commands',audience:'new-planner',trustedNetworkTarget:{address:'127.0.0.3',port:45679,localAddress:'127.0.0.2',allowHttp:true}}))
  const saved=f.remoteRow.options.config
  assert.equal(saved.coordinator.endpoint,'http://127.0.0.3:45679/commands');assert.deepEqual(saved.coordinator.nativeRoutes,[]);assert.equal(saved.pollIntervalMs,0);assert.equal(saved.taskSessionsEnabled,true);assert.deepEqual(saved.peers,beforePeers);assert.equal(saved.nodeId,beforeNode)
})
test('new connections cannot switch authentication mode or invent a configured node identity',async t=>{
  const f=fixture(t),changes={endpoint:'http://127.0.0.3:45679/commands',audience:'new-planner',trustedNetworkTarget:{address:'127.0.0.3',port:45679,localAddress:'127.0.0.2',allowHttp:true}}
  f.remoteRow.options.config.coordinator=null;f.remoteRow.options.config.authMode='ed25519'
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',changes)),{code:'STARTUP_CONNECTION_REQUIRED'})
  f.remoteRow.options.config.authMode='trusted-network';f.remoteRow.options.config.nodeId='unconfigured'
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',changes)),{code:'STARTUP_CONNECTION_REQUIRED'});assert.equal(f.writes.length,0);assert.equal(f.remoteRow.options.config.coordinator,null)
})

test('planning decision switch persists independently without changing executor session settings',async t=>{
  const f=fixture(t)
  f.taskRow.options.config.sessionDecisionEnabled=true;f.taskRow.options.config.defaultWorkspaceId=null
  const result=await saveStartupSettings(f.ctx,input(f,'task',{planningDecisionEnabled:false}))
  assert.equal(result.saved,true);assert.equal(f.taskRow.options.config.planningDecisionEnabled,false);assert.equal(f.taskRow.options.config.sessionDecisionEnabled,true);assert.equal(f.taskRow.options.config.defaultWorkspaceId,null)
})

test('connection check verifies paused peer identity using durable sequences without polling, saving or claiming work', async t => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { httpHandler, TrustedNetworkVerifier } = await import('../dist/remote/api.js');
  const { checkStartupConnection } = await import('../dist/startup-settings.js');
  const f=fixture(t),dir=mkdtempSync(join(tmpdir(),'task-connection-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let handler;const server=createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const port=server.address().port,policy={listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1'],peers:[{address:'127.0.0.1',nodeId:'worker',role:'executor',audience:'planner',operations:['executorIdentity'],workspaces:['default'],capabilities:[]}]};
  const inbound=new RecoveryStore(':memory:');t.after(()=>inbound.close());
  const gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger:f.ledger,store:inbound,verifier:new TrustedNetworkVerifier({...policy,audience:'planner'})});t.after(()=>gateway.dispose());
  const protocolHandler=httpHandler(gateway,{trustedNetwork:policy});
  handler=(req,res)=>{if(req.url!=='/commands'){res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"NOT_FOUND"}');return;}return protocolHandler(req,res);};
  f.remoteRow.options.config.paused=true;Object.assign(f.remote.config,{paused:true,statePath:join(dir,'remote.sqlite')});
  Object.assign(f.remote.config.coordinator,{endpoint:`http://127.0.0.1:${port}/commands`,trustedNetwork:{address:'127.0.0.1',port,localAddress:'127.0.0.1',allowHttp:true}});
  const expected=readStartupSettings(f.ctx).remote.values,input={expected,endpoint:expected.endpoint,trustedNetworkTarget:expected.trustedNetworkTarget};
  const first=await checkStartupConnection(f.ctx,input),second=await checkStartupConnection(f.ctx,input);
  assert.equal(first.connected,true);assert.equal(second.connected,true);assert.equal(first.paused,true);assert.deepEqual(first.identity,second.identity);assert.equal(f.writes.length,0);assert.equal(f.remote.config.paused,true);assert.equal(f.ledger.snapshot().attempts.length,0);
  const wrongBinding=await checkStartupConnection(f.ctx,{...input,trustedNetworkTarget:{...input.trustedNetworkTarget,port:port+1}});
  assert.equal(wrongBinding.connected,false);assert.equal(wrongBinding.code,'NETWORK_TARGET_DENIED');
  const wrongProtocol=await checkStartupConnection(f.ctx,{...input,endpoint:`http://127.0.0.1:${port}/webui`});
  assert.equal(wrongProtocol.connected,false);assert.equal(wrongProtocol.code,'NOT_FOUND');
  handler=(_req,res)=>{res.writeHead(403,{'content-type':'application/json'});res.end('{"error":"OPERATION_DENIED"}');};
  const denied=await checkStartupConnection(f.ctx,input);assert.equal(denied.connected,false);assert.equal(denied.code,'OPERATION_DENIED');
  handler=(_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<html>WebUI</html>');};
  const html=await checkStartupConnection(f.ctx,input);assert.equal(html.connected,false);assert.equal(html.identity,null);
  const stale=await checkStartupConnection(f.ctx,{...input,expected:{...expected,audience:'changed'}});assert.equal(stale.code,'STARTUP_CONFLICT');
});

test('startup RPC preserves a specific business failure through the official Remote error envelope', async t => {
  const {TaskPluginSettings}=await import('../dist/settings.js');
  const f=fixture(t);f.taskRow.options.config.localNode={models:[]};
  await assert.rejects(TaskPluginSettings.prototype.saveStartup.call({ctx:f.ctx},input(f,'task',{role:'planner'})),error=>error.code==='task/startup'&&error.details.reason==='STARTUP_ROLE_CONFLICT'&&error.isDSHRemoteError===true);
  assert.equal(f.writes.length,0);
});

test('missing decision service locks availability and rejects enabling either switch, while allowing other edits',async t=>{
 const f=fixture(t); f.decisions.enabled=false;
 assert.equal(readStartupSettings(f.ctx).task.decisionAvailable,false);
 for(const key of ['planningDecisionEnabled','sessionDecisionEnabled']) await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{[key]:true})),{code:'STARTUP_DECISION_REQUIRED'});
 assert.equal(f.writes.length,0);
 await saveStartupSettings(f.ctx,input(f,'task',{planningDecisionEnabled:false}));
 f.decisions.enabled=true;assert.equal(readStartupSettings(f.ctx).task.decisionAvailable,true);
 await saveStartupSettings(f.ctx,input(f,'task',{planningDecisionEnabled:true}));
});


test('enabling an executor restores automatic heartbeat and polling from legacy zero intervals without widening grants',async t=>{
  const f=fixture(t);
  f.remoteRow.options.config.paused=true;
  f.remoteRow.options.config.coordinator.nativeRoutes=[{provider:'fixture',models:[{model:'fixture',reasoningEfforts:[]}]}];
  const before=structuredClone(f.remoteRow.options.config);
  await saveStartupSettings(f.ctx,input(f,'remote',{paused:false}));
  const saved=f.remoteRow.options.config;
  assert.equal(saved.paused,false);assert.equal(saved.executionLimits.pollIntervalMs,1000);assert.equal(saved.coordinator.heartbeatIntervalMs,5000);
  assert.deepEqual(saved.workspaces,before.workspaces);assert.deepEqual(saved.capabilities,before.capabilities);
  assert.deepEqual(saved.coordinator.nativeRoutes,before.coordinator.nativeRoutes);
  await saveStartupSettings(f.ctx,input(f,'remote',{paused:true}));
  assert.equal(f.remoteRow.options.config.paused,true);
  assert.equal(f.remoteRow.options.config.coordinator.heartbeatIntervalMs,5000);
});
test('executor can connect before model discovery, and planner remains unable to execute',async t=>{
  const f=fixture(t);f.remoteRow.options.config.paused=true;
  await saveStartupSettings(f.ctx,input(f,'remote',{paused:false}));
  assert.equal(f.writes.length,1);assert.deepEqual(f.remoteRow.options.config.coordinator.nativeRoutes,[]);f.remoteRow.options.config.paused=true;f.remoteRow.options.config.coordinator.heartbeatIntervalMs=0;f.remoteRow.options.config.pollIntervalMs=0;f.remoteRow.options.config.executionLimits.pollIntervalMs=0;
  f.remoteRow.options.config.role='executor';f.task.config.role='planner';f.taskRow.options.config.role='planner';
  await saveStartupSettings(f.ctx,input(f,'remote',{paused:false}));
  assert.equal(f.remoteRow.options.config.pollIntervalMs,0);
  assert.equal(f.remoteRow.options.config.coordinator.heartbeatIntervalMs,0);
});

test('scheduler capacity edit persists only concurrency of existing nodes and survives reading a restarted service',async t=>{
  const f=fixture(t),node={nodeId:'remote-worker',maxConcurrent:1,models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],capabilities:['files'],workspaceIds:['default'],enabled:true,unknown:{keep:true}};
  f.taskRow.options.config.role='planner';f.taskRow.options.config.remoteNodes=[node];f.ledger.registerNode('remote-node',{...node,roles:['executor']});
  const request=input(f,'task',{nodeCapacities:[{nodeId:'remote-worker',maxConcurrent:2}]});
  await saveStartupSettings(f.ctx,request);
  assert.deepEqual(f.taskRow.options.config.remoteNodes,[node]);
  assert.deepEqual(f.taskRow.options.config.nodeCapacityOverrides,{"remote-worker":2});
  assert.equal(f.ledger.getNode("remote-worker").maxConcurrent,2);
  assert.equal(f.taskRow.options.config.nodeCapacities,undefined);
  f.task.config={...f.taskRow.options.config};
  assert.deepEqual(readStartupSettings(f.ctx).task.values.nodeCapacities,[{nodeId:'remote-worker',maxConcurrent:2}]);
  assert.equal(f.remoteRow.options.config.concurrency,1);
});
test('capacity edits reject new identities, grants, omissions, duplicates, invalid limits and stale catalogs',async t=>{
  const f=fixture(t);f.taskRow.options.config.role='planner';f.taskRow.options.config.remoteNodes=[{nodeId:'a',maxConcurrent:1},{nodeId:'b',maxConcurrent:1}];
  for(const nodes of [[],[{nodeId:'a',maxConcurrent:2},{nodeId:'a',maxConcurrent:2}],[{nodeId:'a',maxConcurrent:2},{nodeId:'new',maxConcurrent:2}],[{nodeId:'a',maxConcurrent:2,workspaceIds:['any']},{nodeId:'b',maxConcurrent:2}],[{nodeId:'a',maxConcurrent:33},{nodeId:'b',maxConcurrent:2}]])
    await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{nodeCapacities:nodes})));
  const stale=input(f,'task',{nodeCapacities:[{nodeId:'a',maxConcurrent:2},{nodeId:'b',maxConcurrent:2}]});
  f.taskRow.options.config.remoteNodes[0].maxConcurrent=3;
  await assert.rejects(saveStartupSettings(f.ctx,stale),{code:'STARTUP_CONFLICT'});
  assert.equal(f.writes.length,0);
});
test('capacity edits leave active work intact and apply without the restart gate',async t=>{
  const f=fixture(t);f.task.config.nodeId='planner';f.taskRow.options.config.nodeId='planner';f.taskRow.options.config.remoteNodes=[{nodeId:'worker',maxConcurrent:2}];f.task.providers.add({activeCount:1});
  const task=f.ledger.createTask('task',{title:'active'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',provider:'fixture',model:'fixture',workspaceId:'default',requiredCapabilities:[]}}).value;
  const claim=f.ledger.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:60000}).value;
  const result=await saveStartupSettings(f.ctx,input(f,'task',{nodeCapacities:[{nodeId:'worker',maxConcurrent:1}]}));
  assert.equal(result.applies,'live');assert.equal(f.ledger.getNode('worker').maxConcurrent,1);
  assert.equal(f.ledger.getRun(run.runId).state,'running');assert.equal(f.ledger.snapshot().attempts[0].attemptId,claim.attempt.attemptId);
  assert.equal(f.task.configurationPaused,false);assert.equal(f.writes.length,1);
});
test('executor limits persist during unresolved recovery without rebuilding services',async t=>{
 const f=fixture(t);f.store.createDispatch({attemptId:'attempt',state:'uncertain',claim:{task:{taskId:'recovery',title:'Recovery'},run:{runId:'recovery'}},lease:{},sessionId:'session'});
 const result=await saveStartupSettings(f.ctx,input(f,'remote',{concurrency:2,pollIntervalMs:1100}));
 assert.equal(result.applies,'live');assert.deepEqual(f.remoteRow.options.config.executionLimits,{concurrency:2,pollIntervalMs:1100});assert.equal(f.store.dispatches()[0].state,'uncertain');assert.equal(f.remote.configurationPaused,false);
 assert.equal(readStartupSettings(f.ctx).restartBlockers[0].title,'Recovery');
});

test('connection role is read-only and top-level transitions reject incompatible polling/listening before writes',async t=>{
 const f=fixture(t);await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',{role:'planner'})));assert.equal(f.writes.length,0);
 f.remoteRow.options.config.exposeHttp=true;await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{role:'executor'})),{code:'STARTUP_ROLE_CONFLICT'});assert.equal(f.writes.length,0);assert.equal(f.task.configurationPaused,false);
 f.remoteRow.options.config.exposeHttp=false;f.remoteRow.options.config.pollIntervalMs=1000;await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{role:'planner'})),{code:'STARTUP_ROLE_CONFLICT'});assert.equal(f.writes.length,0);
});

test('executor toggle migrates legacy pause without activating its formerly suppressed listener',async t=>{
 const f=fixture(t);Object.assign(f.remoteRow.options.config,{paused:true,exposeHttp:true});
 await saveStartupSettings(f.ctx,input(f,'remote',{paused:false}));
 assert.equal(f.remoteRow.options.config.pauseScope,'executor');assert.equal(f.remoteRow.options.config.exposeHttp,false);assert.equal(f.remoteRow.options.config.paused,false);
});
test('role preflight protects an independent active listener even when executor is paused',async t=>{
 const f=fixture(t);Object.assign(f.remoteRow.options.config,{paused:true,pauseScope:'executor',exposeHttp:true});
 await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{role:'executor'})),{code:'STARTUP_ROLE_CONFLICT'});assert.equal(f.writes.length,0);
});
test('a legacy both listener without an upstream projects executor as disabled',t=>{
 const f=fixture(t);Object.assign(f.remoteRow.options.config,{paused:false,exposeHttp:true,coordinator:null});assert.equal(readStartupSettings(f.ctx).remote.values.paused,true);
});

function withPresetRegistry(f,registry){const get=f.ctx.get;f.ctx.get=key=>key==='agentPresets'?registry:get(key);}
test('execution preset selection clears the old tool mask in the same profile transaction',async t=>{
 const f=fixture(t);f.taskRow.options.config.executionTools=['activity_sources_read'];f.task.config.executionTools=['activity_sources_read'];
 withPresetRegistry(f,{resolve:async id=>({id,name:'Official preset'})});
 const before=structuredClone(f.taskRow.options.config);
 await saveStartupSettings(f.ctx,input(f,'task',{executionAgentPreset:'standard'}));
 assert.equal(f.writes.length,1);assert.equal(f.taskRow.options.config.executionAgentPreset,'standard');assert.equal(f.taskRow.options.config.executionTools,null);
 const {executionTools,executionAgentPreset,...rest}=f.taskRow.options.config;const {executionTools:oldTools,...oldRest}=before;assert.deepEqual(rest,oldRest);
});
test('missing or broken execution presets reject without a profile write',async t=>{
 for(const registry of [undefined,{resolve:async()=>{throw Error('not found')}},{resolve:async()=>({id:'broken',broken:'failed plugin'})}]){
  const f=fixture(t);withPresetRegistry(f,registry);await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{executionAgentPreset:'broken'})),error=>error.code==='STARTUP_PRESET_UNAVAILABLE');assert.equal(f.writes.length,0);
 }
});
test('execution preset CAS protects a concurrently changed old tool mask',async t=>{
 const f=fixture(t);withPresetRegistry(f,{resolve:async id=>({id})});const request=input(f,'task',{executionAgentPreset:'ptc',executionTools:null});
 f.host.before=()=>{f.taskRow.options.config.executionTools=['read']};
 await assert.rejects(saveStartupSettings(f.ctx,request),error=>error.code==='STARTUP_CONFLICT');assert.equal(f.writes.length,0);assert.deepEqual(f.taskRow.options.config.executionTools,['read']);
});


function projectPolling(t, f, response = {}) {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const packets = [];
  const client = new RemoteClient({
    endpoint: 'https://fixture.invalid/commands', nodeId: 'worker', audience: 'planner',
    keyId: 'fixture', privateKey: generateKeyPairSync('ed25519').privateKey, store: f.store,
    fetch: async (_url, options) => {
      const envelope = parseCommandEnvelope(options.body, 'ed25519');
      packets.push(envelope.payload.input.request.input);
      if (packets.length === 1) { entered.resolve(); await finish.promise; }
      return new Response(JSON.stringify({commandId:envelope.commandId,state:'done',result:{value:response}}));
    },
  });
  f.remote.client = client;
  f.remote.coordinatorLedger = new RemoteLedgerClient(client, 'worker');
  f.task.sessionPortal = new ProjectSessionService(f.task, f.remote.ctx);
  const owner = f.task.sessionPortal.ownerCarrier;
  t.after(async () => { finish.resolve(); await f.task.sessionPortal.close(); await client.dispose(); });
  return {owner, packets, entered:entered.promise, finish:() => finish.resolve()};
}

for (const [name, changes] of [['pause', {paused:true}], ['central address', {endpoint:'http://127.0.0.1:45678/new-commands'}], ['connection form', null]]) {
  test(`catalog polling drains before saving ${name}, and stays paused through persistence`, async t => {
    t.mock.timers.enable({apis:['setInterval']});
    const f=fixture(t), p=projectPolling(t,f);
    const editing=Promise.withResolvers(), persist=Promise.withResolvers();
    f.host.before=async()=>{editing.resolve();await persist.promise;};
    p.owner.start();await p.entered;
    assert.throws(()=>f.remote.client.beginConfigurationEdit(),{code:'CONFIGURATION_BUSY'});
    const connection=changes === null ? await readConnectionSettings(f.ctx) : null;
    const saving=connection
      ? saveConnectionSettings(f.ctx,{expected:connection.revision,value:{...connection.values,outbound:{...connection.values.outbound,endpoint:'http://127.0.0.1:45678/new-commands'}}})
      : saveStartupSettings(f.ctx,input(f,'remote',changes));
    p.finish();await editing.promise;
    t.mock.timers.tick(2000);await p.owner.poll();
    assert.equal(p.packets.length,1);
    await assert.rejects(f.task.sessionPortal.conversation('new-call'),{code:'CONFIGURATION_BUSY'});
    persist.resolve();await saving;
    await p.owner.poll();assert.equal(p.packets.length,2);
    assert.deepEqual(Object.keys(p.packets[0]),['catalog']);
    assert.equal(f.task.configurationPaused,false);
  });
}

test('a catalog response cannot admit a new owner write during configuration drain; persistence failure resumes polling',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const f=fixture(t), binding={kind:'native',projectId:'p',generation:0,nodeId:'worker',sessionId:'s',workspaceId:'w',workspaceRevision:'r',cwd:'/tmp'};
  const p=projectPolling(t,f,{call:{callId:'old-central-write',request:{kind:'native',binding,operation:{kind:'session-cancel'}}}});
  let executions=0;f.task.sessionPortal.ownerExecute=async()=>{executions++;return {cancelled:true};};
  p.owner.start();await p.entered;f.host.fail=true;
  const saving=saveStartupSettings(f.ctx,input(f,'remote',{paused:true}));p.finish();
  await assert.rejects(saving,{code:'STARTUP_OVERRIDE'});
  assert.equal(executions,0);
  assert.equal(f.ledger.managementDatabase().prepare('SELECT count(*) AS count FROM project_session_owner_calls').get().count,0);
  assert.equal(f.task.configurationPaused,false);
  await p.owner.poll();assert.equal(executions,1);
});

test('remote disposal keeps project polling paused until the settings owner releases its guard',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const f=fixture(t), p=projectPolling(t,f);
  p.owner.start();await p.entered;p.finish();await p.owner.poll();
  const release=await f.remote.beginConfigurationEdit();
  await f.remote.dispose();
  t.mock.timers.tick(2000);await p.owner.poll();assert.equal(p.packets.length,1);
  await f.task.sessionPortal.close();release();release();
  t.mock.timers.tick(2000);await p.owner.poll();assert.equal(p.packets.length,1);
});


test('a genuinely busy shared transport still blocks saves and restores project polling after rejection',async t=>{
  const f=fixture(t), p=projectPolling(t,f);
  const busy=f.remote.coordinatorLedger.projectCollaborate('worker','business-inflight',{action:'project-session',request:{kind:'decision',operationId:'move'}});
  await p.entered;
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',{paused:true})),{code:'STARTUP_BUSY'});
  p.finish();await busy;
  await p.owner.poll();assert.equal(p.packets.length,2);
  assert.equal(f.task.configurationPaused,false);
});

test('local owner delivery permits later configuration saves without exporting local results as remote outcomes',async t=>{
  const f=fixture(t), p=projectPolling(t,f);
  f.task.config.centralMode='host';
  f.task.sessionPortal.ownerExecute=async()=>({cancelled:true});
  const binding={kind:'native',projectId:'p',generation:0,nodeId:'worker',sessionId:'s',workspaceId:'w',workspaceRevision:'r',cwd:'/tmp'};
  assert.deepEqual(await f.task.sessionPortal.carrier.request('worker','local-write',{kind:'native',binding,operation:{kind:'session-cancel'}}),{cancelled:true});
  await saveStartupSettings(f.ctx,input(f,'remote',{paused:true}));
  f.ledger.managementDatabase().prepare('UPDATE project_session_owner_calls SET part=0 WHERE id=?').run('local-write');
  await f.task.sessionPortal.close();
  f.task.sessionPortal=new ProjectSessionService(f.task,f.remote.ctx);
  await saveStartupSettings(f.ctx,input(f,'remote',{paused:true}));
  f.task.config.centralMode='remote';
  const polling=f.task.sessionPortal.ownerCarrier.poll();await p.entered;p.finish();await polling;
  assert.deepEqual(Object.keys(p.packets[0]),['catalog']);
});

test('failed peer capability save cannot change the bound scheduler node',async t=>{
  const f=fixture(t);
  f.ledger.registerPairedExecutor('peer-registration','peer');
  f.remoteRow.options.config.trustedNetwork={listen:{address:'127.0.0.1',port:8443},allowHttp:true,allowedAddresses:['127.0.0.2'],peers:[{address:'127.0.0.2',nodeId:'peer',nickname:'Peer',executionEnabled:true,audience:'planner',operations:[],workspaces:[],capabilities:[]}]};
  const before=await readConnectionSettings(f.ctx),node=f.ledger.getNode('peer'),config=structuredClone(f.remoteRow.options.config);
  f.host.fail=true;
  await assert.rejects(saveConnectionSettings(f.ctx,{expected:before.revision,value:{...before.values,peers:before.values.peers.map(peer=>({...peer,capabilities:['activity.reports.v1']}))}}));
  assert.deepEqual(f.ledger.getNode('peer'),node);
  assert.deepEqual(f.remoteRow.options.config,config);
  assert.equal(f.writes.length,0);
});
