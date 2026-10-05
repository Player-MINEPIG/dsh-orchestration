import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { TaskLedger } from '../dist/ledger.js'
import { TaskSystemService } from '../dist/dsh-plugin.js'
import { RemoteExecutionService, Config as RemoteConfig } from '../dist/remote/index.js'
import { RecoveryStore, ExecutorWorker, RemoteGateway, IdentityVerifier } from '../dist/remote/api.js'
import { readStartupSettings, saveStartupSettings, SaveStartupInput } from '../dist/startup-settings.js'
import { startupDescriptor, saveStartupDescriptor } from '../dist/settings.js'

function fixture(t) {
  const ledger=TaskLedger.open(':memory:');t.after(()=>ledger.close())
  for(const workspaceId of ['default','other']) ledger.registerWorkspace(`w-${workspaceId}`,{workspaceId,nodeId:'worker',path:`/tmp/${workspaceId}`,label:workspaceId,state:'ready',createdAt:new Date().toISOString()})
  ledger.registerNode('node',{nodeId:'worker',roles:['both'],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default','other'],enabled:true,lastSeenAt:new Date().toISOString()})
  const raw={role:'both',defaultWorkspaceId:'default',sessionDecisionEnabled:false,databasePath:'/tmp/private.sqlite',nodeId:'worker',executionTools:[],privateMarker:'NOT_A_REAL_SECRET',unknownExtension:{keep:true}}
  const remoteRaw=RemoteConfig({role:'executor',nodeId:'worker',authMode:'trusted-network',taskSessionsEnabled:true,coordinator:{endpoint:'http://127.0.0.1:45678/commands',audience:'planner',authMode:'trusted-network',trustedNetwork:{address:'127.0.0.1',port:45678,localAddress:'127.0.0.2',allowHttp:true},nativeRoutes:[]}})
  remoteRaw.unknownExtension={keep:true}
  const taskRow={options:{id:'task-system',name:'@dsh-task/task-system/plugin',config:raw}},remoteRow={options:{id:'task-remote-execution',name:'@dsh-task/task-system/remote',config:remoteRaw}}
  const rows=[taskRow,remoteRow],writes=[]
  const host={entries:()=>rows,edit:async(entry,change)=>{await host.before?.();const next=change(structuredClone(entry.options.config),{});if(host.fail) throw Error('Configuration for task-system is overridden by a home patch or command-line overlay');entry.options.config=next;writes.push(next)}}
  const task={ledger,config:{...raw},providers:new Set(),configurationPaused:false,beginConfigurationEdit(){return TaskSystemService.prototype.beginConfigurationEdit.call(this)}}
  const store=new RecoveryStore(':memory:');t.after(()=>store.close())
  const remote=new RemoteExecutionService(new Context(),remoteRaw,ledger,store)
  const profile={overlays:[]}
  const ctx={get:key=>({configEditor:host,taskSystem:task,remoteExecution:remote,profileContext:profile})[key]}
  return {ctx,host,task,remote,store,ledger,taskRow,remoteRow,writes,profile}
}
const input=(f,target,changes)=>({target,expected:readStartupSettings(f.ctx)[target].values,changes})
test('startup read/save descriptors use exact public service methods and a single typed JSON input',()=>{
  assert.equal(startupDescriptor.method,'startup');assert.deepEqual(startupDescriptor.parameters,[])
  assert.equal(saveStartupDescriptor.parameters[0].wire,'input');assert.equal(saveStartupDescriptor.parameters[0].source,'json')
})
test('startup read excludes credentials, node grants and full raw config',t=>{
  const f=fixture(t),view=readStartupSettings(f.ctx)
  assert.equal(view.task.values.role,'both');assert.equal(view.applies,'plugin-restart')
  assert.ok(!JSON.stringify(view).includes('NOT_A_REAL_SECRET'));assert.ok(!JSON.stringify(view).includes('private.sqlite'));assert.ok(!JSON.stringify(view).includes('executionTools'))
})
test('public ConfigEditor merge persists only selected startup fields and preserves unknown data',async t=>{
  const f=fixture(t),result=await saveStartupSettings(f.ctx,input(f,'task',{defaultWorkspaceId:'other',sessionDecisionEnabled:true}))
  assert.deepEqual(result,{saved:true,applies:'plugin-restart'});assert.equal(f.writes.length,1)
  assert.equal(f.taskRow.options.config.privateMarker,'NOT_A_REAL_SECRET');assert.deepEqual(f.taskRow.options.config.unknownExtension,{keep:true});assert.equal(f.taskRow.options.config.defaultWorkspaceId,'other')
  assert.equal(f.task.configurationPaused,false)
})
test('role selection is saved but cannot silently remove incompatible node bootstrap',async t=>{
  const f=fixture(t);await saveStartupSettings(f.ctx,input(f,'task',{role:'planner'}));assert.equal(f.taskRow.options.config.role,'planner')
  f.taskRow.options.config.localNode={models:[]};await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{role:'planner'})),{code:'STARTUP_ROLE_CONFLICT'})
  assert.deepEqual(f.taskRow.options.config.localNode,{models:[]})
})
test('CAS rejects a stale startup snapshot without overwriting a newer field',async t=>{
  const f=fixture(t),request=input(f,'task',{role:'executor'});f.taskRow.options.config.defaultWorkspaceId='other'
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
  const f=fixture(t);await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{defaultWorkspaceId:'not-registered'})),{code:'STARTUP_SAVE_FAILED'});assert.equal(f.writes.length,0);assert.deepEqual(f.ledger.getNode('worker').workspaceIds,['default','other'])
})
test('active claimed work blocks connection changes before ConfigEditor is called',async t=>{
  const f=fixture(t),task=f.ledger.createTask('task',{title:'active'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',provider:'fixture',model:'fixture',workspaceId:'default',requiredCapabilities:[]}}).value
  f.ledger.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:60000})
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',{audience:'another'})),{code:'STARTUP_BUSY'});assert.equal(f.writes.length,0)
})
test('native external work and unresolved remote recovery block startup edits',async t=>{
  const f=fixture(t);f.task.providers.add({activeCount:1})
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'task',{role:'executor'})),{code:'STARTUP_BUSY'})
  f.task.providers.clear();f.store.createDispatch({attemptId:'attempt',state:'uncertain',claim:{},lease:{},sessionId:'session'})
  await assert.rejects(saveStartupSettings(f.ctx,input(f,'remote',{audience:'another'})),{code:'STARTUP_BUSY'});assert.equal(f.writes.length,0);assert.equal(f.task.configurationPaused,false)
})
test('admissions are held throughout asynchronous persistence and released after failure',async t=>{
  const f=fixture(t),task=f.ledger.createTask('task',{title:'queued'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',provider:'fixture',model:'fixture',workspaceId:'default',requiredCapabilities:[]}}).value
  let continueEdit;f.host.before=()=>new Promise(resolve=>{continueEdit=resolve})
  const saving=saveStartupSettings(f.ctx,input(f,'task',{role:'executor'}));await Promise.resolve()
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

test('clearing a default workspace is reflected as null rather than the older runtime value',async t=>{
  const f=fixture(t)
  await saveStartupSettings(f.ctx,input(f,'task',{defaultWorkspaceId:null}))
  assert.equal(readStartupSettings(f.ctx).task.values.defaultWorkspaceId,null)
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
