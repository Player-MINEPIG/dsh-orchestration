import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {attachWorkspaceRegistry} from './local-workspace-harness.mjs';
import {Config,RemoteExecutionService} from '../../packages/task-system/dist/remote/index.js';
import vm from 'node:vm';
import {createNativeHarness} from '../dsh/native-harness.mjs';
import * as settings from '../../packages/task-system/dist/settings.js';
const runtimeRoot=process.env.DSH_OFFICIAL_ROOT;
assert.ok(runtimeRoot,'Set DSH_OFFICIAL_ROOT to the isolated pinned runtime directory containing package.json and node_modules');
const req=createRequire(join(runtimeRoot,'package.json'));
function load(file,require){let value;vm.runInNewContext(readFileSync(file,'utf8'),{window:{__ModuleLoader__:{load:row=>{value=row.factory(require);}}},AbortController,AbortSignal,TextEncoder,TextDecoder,crypto:globalThis.crypto,setTimeout,clearTimeout,console});return value;}
test('actual browser Remote descriptors and host Typert Gateway agree for initial and selected task views and session tasks',async()=>{
 const h=await createNativeHarness({config:{role:'both',nodeId:'local',schedulerEnabled:false,autoExecute:false}}),ctx=h.ctx;
 try {
  for(const name of ['@deepseek-ai/dsh-typert-registry','@deepseek-ai/dsh-api-remote-access','@deepseek-ai/dsh-api-gateway'])await (await ctx.plugin(req(name).default)).await();
  await (await ctx.plugin(settings)).await();
  const {Peer}=req('@deepseek-ai/dsh-client-connection'),peer=new Peer(ctx,{principal:{kind:'owner'}});
  const calls=[];
  ctx.provide('connection',{rpc:{async call(path,method,payload){calls.push({method,args:payload.args});try{return {ok:true,value:await ctx.typertGateway.invoke({peer,namespace:'taskPluginSettings',method:method.split('/')[1],args:payload.args})};}catch(error){return {ok:false,error};}},open(){}},registerGenerationSource:()=>()=>{},start:()=>()=>{},generation:{getSnapshot:()=>undefined},isLoopback:true});
  const browser=load(req.resolve('@deepseek-ai/dsh-api-gateway/client').replace('client.node.js','client.browser.js'),name=>req(name));
  await (await ctx.plugin(browser)).await();
  const ui=load(new URL('../../packages/task-system/dist/settings-client.js',import.meta.url),()=>({}));
  await ctx.remote.$mount({package:'@dsh-task/task-system',descriptors:ui.projectDescriptors});
  const descriptor=ui.projectDescriptors.find(d=>d.method==='projectSnapshot');assert.equal(descriptor.parameters.length,1);assert.equal(settings.projectDescriptors.find(d=>d.method==='projectSnapshot').parameters.length,1);
  const read=(method,input)=>ui.readRemote(ctx,method,ui.projectDescriptors.find(d=>d.method===method).result.create(),input);
  assert.equal((await read('projectSnapshot',{})).viewContext.role,'planner');
  assert.equal((await read('projectSnapshot',{view:'executor'})).viewContext.scope,'local');
  assert.equal((await read('projectSnapshot',{view:'planner'})).viewContext.role,'planner');
  assert.equal((await read('sessionTasks',{sessionId:'nonexistent-isolated-session'})).tasks.length,0);
  assert.equal(calls.length,4);console.log('actual Remote→Gateway calls passed:',calls.map(x=>x.method).join(','));
  ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
  h.ledger.registerNode('local-executor',{nodeId:'local',roles:['executor'],enabled:true,workspaceIds:[],capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}]});
  const task=h.ledger.createTask('alert-task',{title:'Native-only terminal exception'}).value,run=h.ledger.createRun('alert-run',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
  const claim=h.ledger.claim('alert-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
  h.ledger.submit('alert-result',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'local',fence:claim.attempt.fence,outcome:'blocked',summary:'Actual isolated result'});
  const alert=(await read('projectSnapshot',{view:'executor'})).tasks[0].alert;
  assert.equal(ui.projectDescriptors.find(d=>d.method==='setExecutorAlertDisposition').parameters.length,1);
  await read('setExecutorAlertDisposition',{recordId:alert.recordId,fingerprint:alert.fingerprint,acknowledged:true});
  assert.equal((await read('projectSnapshot',{view:'executor'})).tasks[0].status,'handled');
  await read('setExecutorAlertDisposition',{recordId:alert.recordId,fingerprint:alert.fingerprint,acknowledged:false});
  assert.equal((await read('projectSnapshot',{view:'executor'})).tasks[0].status,'error');
  await assert.rejects(read('setExecutorAlertDisposition',{recordId:alert.recordId,fingerprint:'stale-fingerprint',acknowledged:true}),error=>error.details?.reason==='ALERT_CHANGED');


 } finally {await h.dispose();}
});

test('actual Typert contracts read/save project settings and owner local grants, including zero-argument catalogue',async()=>{
 const h=await createNativeHarness({config:{role:'both',nodeId:'local',schedulerEnabled:false,autoExecute:false,projectAgentOptions:{provider:'test-offline',model:'script'}}}),ctx=h.ctx;
 let remote;
 try {
  const registry=await attachWorkspaceRegistry(h),cwd=join(h.dir,'coordinator');mkdirSync(cwd);const workspace=await registry.create(cwd,'Official registry workspace');
  const project=await ctx.taskSystem.projects.create({commandId:'rpc-project',title:'RPC fixture',goal:'Only isolated configuration',workspace:{kind:'registered',nodeId:'local',workspaceId:'registry:'+workspace.id}});
  remote=new RemoteExecutionService(ctx,Config({role:'executor',nodeId:'local',statePath:join(h.dir,'rpc-remote.sqlite'),paused:true,pollIntervalMs:0,workspaces:[]}),h.ledger);
  for(const name of ['@deepseek-ai/dsh-typert-registry','@deepseek-ai/dsh-api-remote-access','@deepseek-ai/dsh-api-gateway'])await (await ctx.plugin(req(name).default)).await();
  await (await ctx.plugin(settings)).await();
  const {Peer}=req('@deepseek-ai/dsh-client-connection'),peer=new Peer(ctx,{principal:{kind:'owner'}}),calls=[];
  ctx.provide('connection',{rpc:{async call(path,method,payload){calls.push({method,args:payload.args});try{return {ok:true,value:await ctx.typertGateway.invoke({peer,namespace:'taskPluginSettings',method:method.split('/')[1],args:payload.args})};}catch(error){return {ok:false,error};}},open(){}},registerGenerationSource:()=>()=>{},start:()=>()=>{},generation:{getSnapshot:()=>undefined},isLoopback:true});
  const browser=load(req.resolve('@deepseek-ai/dsh-api-gateway/client').replace('client.node.js','client.browser.js'),name=>req(name));await (await ctx.plugin(browser)).await();
  const ui=load(new URL('../../packages/task-system/dist/settings-client.js',import.meta.url),()=>({}));await ctx.remote.$mount({package:'@dsh-task/task-system',descriptors:ui.projectDescriptors});
  const invoke=(method,...args)=>ui.readRemote(ctx,method,ui.projectDescriptors.find(d=>d.method===method).result.create(),...args);
  for(const name of ['projectExecutionSettings','saveProjectExecutionSettings','executorWorkspaceGrants','setExecutorWorkspaceGrant'])assert.equal(ui.projectDescriptors.find(d=>d.method===name).parameters.length,settings.projectDescriptors.find(d=>d.method===name).parameters.length,name);
  const original=await invoke('projectExecutionSettings',{projectId:project.projectId});assert.equal(original.revision,0);assert.equal(original.coordinatorWorkspace.path,cwd);
  const saved=await invoke('saveProjectExecutionSettings',{projectId:project.projectId,expectedRevision:0,allowedNodeIds:[],executionBindings:{}});assert.equal(saved.revision,1);assert.deepEqual(saved.allowedNodeIds,[]);
  const grants=await invoke('executorWorkspaceGrants');assert.equal(grants.enabled,true);const item=grants.items.find(i=>i.registryId===workspace.id);assert.equal(item.enabled,false);
  const authorized=await invoke('setExecutorWorkspaceGrant',{registryId:workspace.id,enabled:true,expectedRevision:grants.revision});assert.equal(authorized.items.find(i=>i.registryId===workspace.id).enabled,true);
  assert.equal(Object.keys(calls.find(c=>c.method.endsWith('/executorWorkspaceGrants')).args).length,0);assert.equal(h.ledger.snapshot().tasks.length,0);
  console.log('actual Remote→Gateway project settings/grant contracts passed:',calls.map(c=>c.method).join(','));
 } finally {await remote?.dispose();await h.dispose();}
});
