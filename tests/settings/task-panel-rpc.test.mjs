import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,realpathSync} from 'node:fs';
import vm from 'node:vm';
import {createNativeHarness} from '../dsh/native-harness.mjs';
import * as settings from '../../packages/task-system/dist/settings.js';
const req=createRequire(realpathSync(process.env.DSH_CLI ?? '/Users/pmp/.local/bin/dsh'));
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
 } finally {await h.dispose();}
});
