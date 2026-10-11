import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const runtime=process.env.DSH_OFFICIAL_ROOT
assert.ok(runtime,'DSH_OFFICIAL_ROOT must name an existing official rc.2 install')
const require=createRequire(join(runtime,'package.json'))
const url=name=>pathToFileURL(require.resolve(name)).href
const {boot,initProfile,readProfilePatches}=await import(url('@deepseek-ai/dsh-app-boot'))
const tmp=mkdtempSync(join(tmpdir(),'dsh-disabled-remote-')),home=join(tmp,'home'),dir=join(home,'profiles','disabled-remote-fixture')
mkdirSync(home,{recursive:true});initProfile(dir,[])
symlinkSync(resolve('node_modules'),join(dir,'node_modules'),'dir')
const profile={name:'disabled-remote-fixture',dir,patchPath:join(dir,'cordis.patch.yml'),installAnchor:join(runtime,'package.json'),cwd:tmp,home,startedBundles:[],overlays:[],telemetryDisabledEnv:'1'}
const remoteState=join(tmp,'remote.sqlite')
const rows=[
  {id:'config-editor',name:url('@deepseek-ai/dsh-config-editor')},
  {id:'settings',name:url('@deepseek-ai/dsh-settings')},
  {id:'systemPrompt',name:url('@deepseek-ai/dsh-system-prompt')},
  {id:'tools',name:url('@deepseek-ai/dsh-tools')},
  {id:'typert',name:url('@deepseek-ai/dsh-typert-registry')},
  {id:'task-system',name:'@dsh-task/task-system/plugin',config:{databasePath:join(tmp,'task.sqlite'),nodeId:'fixture',role:'both',keepAlive:false,schedulerEnabled:false,autoExecute:false}},
  {id:'task-system-settings',name:'@dsh-task/task-system'},
  {id:'task-remote-execution',name:'@dsh-task/task-system/remote',disabled:true,config:{role:'executor',nodeId:'fixture',authMode:'trusted-network',statePath:remoteState,exposeHttp:false,pollIntervalMs:0,concurrency:1,coordinator:null}},
]
writeFileSync(profile.patchPath,JSON.stringify([{insert:rows}],null,2))
const root=join(dir,'cordis.yml');writeFileSync(root,'[]\n')
const start=()=>boot('disabled-remote-fixture',root,readProfilePatches('disabled-remote-fixture',profile),ctx=>ctx.provide('profileContext',profile))
let ctx
try {
  ctx=await start()
  const editor=ctx.get('configEditor'),settings=ctx.get('taskPluginSettings')
  assert.ok(editor&&settings)
  const remote=editor.entries().find(entry=>entry.options.id==='task-remote-execution')
  assert.ok(remote);assert.equal(remote.disabled,true);assert.equal(remote.fiber,undefined)
  const before=readFileSync(profile.patchPath,'utf8'),rootBefore=readFileSync(root,'utf8')
  let callbackCalled=false,rawError
  try {await editor.edit(remote,current=>{callbackCalled=true;return {...current,concurrency:2}})} catch(error){rawError=error.message}
  assert.match(rawError,/Configuration entry is no longer available/);assert.equal(callbackCalled,false)
  const startup=await settings.startup();assert.ok(startup.remote)
  let rpcError
  try {await settings.saveStartup({target:'remote',expected:startup.remote.values,changes:{concurrency:2}})} catch(error){rpcError={code:error.code,reason:error.details?.reason,message:error.message}}
  assert.equal(rpcError.code,'task/startup');assert.equal(rpcError.reason,'STARTUP_REMOTE_DISABLED')
  assert.equal(readFileSync(profile.patchPath,'utf8'),before);assert.equal(readFileSync(root,'utf8'),rootBefore)
  assert.equal(ctx.get('remoteExecution'),undefined);assert.equal(existsSync(remoteState),false)
  // Public Entry.update does not persist the profile-owned patch. Verify it is
  // not a replacement for ConfigEditor rather than silently adopting this route.
  await remote.update({config:{...remote.options.config,concurrency:2}})
  assert.equal(remote.options.config.concurrency,2);assert.equal(remote.disabled,true);assert.equal(remote.fiber,undefined)
  assert.equal(readFileSync(profile.patchPath,'utf8'),before)
  await ctx.fiber.dispose();ctx=await start()
  const reloaded=ctx.get('configEditor').entries().find(entry=>entry.options.id==='task-remote-execution')
  assert.equal(reloaded.options.config.concurrency,1);assert.equal(reloaded.disabled,true)
  assert.equal(ctx.get('remoteExecution'),undefined);assert.equal(existsSync(remoteState),false)
  const evidence={officialRuntime:'0.2.0-rc.2',disabledEntryVisible:true,disabledEntryHasFiber:false,configEditorCallbackCalled:callbackCalled,rawConfigEditorError:rawError,startupRpcError:rpcError,profilePatchUnchanged:true,loaderRootUnchanged:true,publicEntryUpdatePersists:false,reopenedConcurrency:reloaded.options.config.concurrency,disabledRemoteServiceStarted:false,remoteStateCreated:false}
  // Isolated fixture setup models the approved operator migration. Product code
  // never writes a disabled entry or enables one as an editing workaround.
  await ctx.fiber.dispose();ctx=undefined
  const migrated=structuredClone(rows),remoteRow=migrated.find(row=>row.id==='task-remote-execution')
  remoteRow.disabled=false;remoteRow.config.paused=true
  writeFileSync(profile.patchPath,JSON.stringify([{insert:migrated}],null,2))
  ctx=await start()
  let service=ctx.get('remoteExecution'),controller=ctx.get('taskPluginSettings'),view=await controller.startup()
  assert.ok(service);assert.equal(view.remote.loaded,true);assert.equal(view.remote.loaderDisabled,false);assert.equal(view.remote.values.paused,true)
  assert.equal(service.gateway,undefined);assert.equal(service.nativeWorker,undefined);assert.equal(service.coordinatorLedger,undefined);assert.equal(existsSync(remoteState),false)
  const pausedBefore=readFileSync(profile.patchPath,'utf8')
  await assert.rejects(controller.saveStartup({target:'remote',expected:view.remote.values,changes:{paused:false}}),error=>error.code==='task/startup'&&error.details?.reason==='STARTUP_CONNECTION_REQUIRED')
  assert.equal(readFileSync(profile.patchPath,'utf8'),pausedBefore)
  const saved=await controller.saveStartup({target:'remote',expected:view.remote.values,changes:{concurrency:2,endpoint:'http://127.0.0.3:45679/commands',audience:'fixture-planner',trustedNetworkTarget:{address:'127.0.0.3',port:45679,localAddress:'127.0.0.2',allowHttp:true}}})
  assert.equal(saved.saved,true)
  service=ctx.get('remoteExecution');controller=ctx.get('taskPluginSettings');view=await controller.startup()
  assert.equal(view.remote.values.paused,true);assert.equal(view.remote.values.concurrency,2);assert.equal(view.remote.values.endpoint,'http://127.0.0.3:45679/commands')
  assert.equal(service.settingsSnapshot().paused,true);assert.equal(service.settingsSnapshot().polling,false);assert.equal(existsSync(remoteState),false)
  await assert.rejects(service.executorIdentity(),{code:'REMOTE_PAUSED'});await assert.rejects(service.heartbeatNow(),{code:'REMOTE_PAUSED'})
  assert.throws(()=>service.createWorker({id:'unused',capabilities:[],supports:()=>true,execute:async()=>{throw Error('must not execute')}}),{code:'REMOTE_PAUSED'})
  assert.equal(service.queueSnapshot().items.length,0)
  await ctx.fiber.dispose();ctx=await start()
  service=ctx.get('remoteExecution');view=await ctx.get('taskPluginSettings').startup()
  assert.equal(view.remote.loaded,true);assert.equal(view.remote.values.paused,true);assert.equal(view.remote.values.concurrency,2);assert.equal(view.remote.values.endpoint,'http://127.0.0.3:45679/commands')
  assert.equal(service.gateway,undefined);assert.equal(service.nativeWorker,undefined);assert.equal(service.coordinatorLedger,undefined);assert.equal(existsSync(remoteState),false)
  const planningBefore=view.task.values
  assert.equal(planningBefore.planningDecisionEnabled,true)
  await ctx.get('taskPluginSettings').saveStartup({target:'task',expected:planningBefore,changes:{planningDecisionEnabled:false}})
  view=await ctx.get('taskPluginSettings').startup()
  assert.equal(view.task.values.planningDecisionEnabled,false);assert.equal(view.task.values.sessionDecisionEnabled,planningBefore.sessionDecisionEnabled)
  await ctx.fiber.dispose();ctx=await start()
  view=await ctx.get('taskPluginSettings').startup()
  assert.equal(view.task.values.planningDecisionEnabled,false);assert.equal(view.remote.values.paused,true);assert.equal(existsSync(remoteState),false)
  console.log(JSON.stringify({...evidence,pausedConfigurationFiberLoaded:true,officialPausedSaveSucceeded:true,pausedSaveSurvivedRestart:true,pausedAfterSave:true,invalidResumePreservedPaused:true,noRemoteJournal:true,noCoordinatorClient:true,noWorker:true,noListener:true,noHeartbeat:true,pausedExecutionEntrypointsRejected:true,planningSwitchOfficialSaveAndRestart:true},null,2))
} finally {if(ctx) await ctx.fiber.dispose();rmSync(tmp,{recursive:true,force:true})}
