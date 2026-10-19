import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
import {installModelSelection} from '@deepseek-ai/dsh-agent';
import {ScriptedModel} from '../../../tests/dsh/scripted-model.mjs';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {randomUUID} from 'node:crypto';
import * as presetRegistry from '@deepseek-ai/dsh-agent-preset-registry';
import * as preset from '@deepseek-ai/dsh-agent-preset';

for(const external of [false,true]) for(const variant of ['preset','allowlist','child']) {const explicit=variant==='allowlist',child=variant==='child';test(`${external?'remote':'local'} native task uses the actual preset tools and respects ${child?'preset child tool execution':explicit?'explicit task tool limits':'preset guards'}`,async()=>{
 const h=await createNativeHarness({script:[...(child?[{name:'fixture_child',args:{}},{name:'task_submit_result',args:{outcome:'blocked',summary:'A child cannot settle its parent'}},{name:'fixture_list',args:{}},'Child completed']:[]),{name:'fixture_blocked',args:{}},{name:'fixture_list',args:{}},{name:'task_submit_result',args:{outcome:'success',summary:'Verified preset directory list'}}]});
 try {
  const file=join(h.dir,'preset-tools.mjs'),marker=join(h.dir,'must-not-run');
  writeFileSync(file,`import {defineTool} from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-tools'))};import {writeFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {createUserMessage} from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-llm'))};export const inject=['tools'];export function apply(ctx){ctx.tools.register(defineTool({name:'fixture_child',description:'Test a preset-owned child',parameters:{},output:{schema:{type:'string'},render:(_a,r)=>[{type:'text',text:r}]},async execute(_args,exec){const handle=await ctx.get('agents').create({sessionId:randomUUID(),parentAgent:exec.agent,setup:async(c)=>{await c.get('agentPresets').mount(c,'standard');},agentOptions:{provider:'test-offline',model:'script'}});try{handle.agent.followup(createUserMessage({source:{kind:'test'},content:[{type:'text',text:'List the files'}]}));await handle.agent.whenIdle();return 'Child completed';}finally{await handle.dispose();}}}));ctx.tools.register(defineTool({name:'fixture_list',description:'List this preset workspace',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,r)=>[{type:'text',text:JSON.stringify(r)}]},execute:()=>({files:['test.md']})}));ctx.tools.guard(exec=>exec.name==='fixture_blocked'?'Denied by preset':undefined);ctx.tools.register(defineTool({name:'fixture_blocked',description:'Guarded preset operation',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_args,r)=>[{type:'text',text:JSON.stringify(r)}]},execute:()=>{writeFileSync(${JSON.stringify(marker)},'ran');return {mustNotRun:true}}}));}`);
  await h.ctx.plugin(presetRegistry.default,{default:'standard'});
  const fiber=await h.ctx.plugin(preset.default,{id:'standard',name:'Standard fixture',plugins:[{name:pathToFileURL(file).href}]});await fiber.await();
  const task=h.ledger.createTask('task',{title:'List workspace',...(explicit?{policy:{allowedTools:[]}}:{})}).value;
  h.ledger.registerNode('node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()});
  const run=h.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
  const claim=h.ledger.claim('claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
  let sid;
  if(external){sid=randomUUID();claim.attempt.executionId=randomUUID();claim.attempt.sessionId=sid;const result=await h.ctx.taskSystem.native.executeExternal({claim,sessionId:sid,workspacePath:h.dir,signal:new AbortController().signal});assert.equal(result.outcome,'success'); }
  else{const result=await h.ctx.taskSystem.native.execute(claim);assert.equal(result.run.state,'succeeded'); sid=h.ledger.getAttempt(claim.attempt.attemptId).sessionId;}
  assert.equal(existsSync(marker),false);if(!explicit){const offset=child?4:0;assert.match(JSON.stringify(h.adapter.requests[1+offset].messages),/Denied by preset/);assert.match(JSON.stringify(h.adapter.requests[2+offset].messages),/test.md/);}if(child){assert.match(JSON.stringify(h.adapter.requests[2].messages),/task_submit_result requires the exact owned native agent/);assert.match(JSON.stringify(h.adapter.requests[3].messages),/test.md/);}const names=h.adapter.requests[0].tools.map(t=>t.name);
  assert.equal(names.includes('fixture_list'),!explicit);
  assert.equal(names.includes('fixture_blocked'),!explicit);
  const handle=await h.ctx.sessionPersistence.open(sid,'read');try{assert.equal(handle.header.agentPreset,'standard');}finally{await handle.close();}
 } finally {await h.dispose();}
});}


for (const variant of ['idle','running','maintenance']) {const busy=variant!=='idle';test(`remote retry ${busy?'blocks '+variant:'borrows a WebUI-opened idle'} session without a second writer`,async()=>{
 const h=await createNativeHarness({script:[{name:'fixture_list',args:{}},{name:'task_submit_result',args:{outcome:'success',summary:'Same session completed'}}]});
 try {
  const file=join(h.dir,'live-tools.mjs');writeFileSync(file,`import {defineTool} from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-tools'))};export const inject=['tools'];export function apply(ctx){ctx.tools.register(defineTool({name:'fixture_list',description:'List fixture files',parameters:{},output:{schema:{type:'string'},render:(_a,r)=>[{type:'text',text:r}]},execute:()=> 'test.md'}));}`);
  await h.ctx.plugin(presetRegistry.default,{default:'standard'});await (await h.ctx.plugin(preset.default,{id:'standard',name:'Standard',plugins:[{name:pathToFileURL(file).href}]})).await();
  const web=new ScriptedModel(variant==='running'?['hang']:[{name:'fixture_list',args:{}},'Web conversation continues']);h.ctx.llm.registerAdapter(['test-web'],web);
  const sid=randomUUID(),handle=await h.ctx.agents.create({sessionId:sid,meta:{cwd:h.dir,agentPreset:'standard'},agentOptions:{provider:'test-web',model:'script'},setup:async(c)=>{await c.get('agentPresets').mount(c,'standard');installModelSelection(c,{current:{provider:'test-web',model:'script'},assembled:undefined});}}),agent=handle.agent;
  // WebUI installs tools on the Agent itself, which restrict() cannot name.
  agent.ctx.get('tools').register((await import('@deepseek-ai/dsh-tools')).defineTool({name:'fixture_local',description:'Per-agent fixture',parameters:{},output:{schema:{type:'string'},render:(_a,r)=>[{type:'text',text:r}]},execute:()=> 'local'}));
  const task=h.ledger.createTask('task',{title:'Retry'}).value;h.ledger.registerNode('node',{nodeId:'local',roles:['executor'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()});
  const run=h.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value,claim=h.ledger.claim('claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;claim.attempt.executionId=randomUUID();claim.attempt.sessionId=sid;
  let maintenance,releaseMaintenance;
  if(variant==='maintenance'){maintenance=agent.runMaintenance(()=>new Promise(resolve=>releaseMaintenance=resolve));assert.equal(agent.status,'idle');}
  if(variant==='running'){agent.followup(createUserMessage({source:{kind:'test'},content:[{type:'text',text:'Existing WebUI work'}]}));for(let i=0;i<100&&!web.requests.length;i++)await new Promise(r=>setTimeout(r,5));assert.equal(agent.status,'running');}
  const result=await h.ctx.taskSystem.native.executeExternal({claim,sessionId:sid,resumeSession:true,workspacePath:h.dir,signal:new AbortController().signal});
  assert.equal(h.ctx.agents.get(sid),agent,'WebUI Agent remains owned by its original lifecycle');
  if(busy){assert.equal(result.outcome,'blocked');assert.match(result.summary,/SESSION_BUSY/);assert.equal(h.adapter.requests.length,0);if(maintenance){releaseMaintenance();await maintenance;}else{assert.equal(agent.status,'running');agent.cancel({kind:'hook',reason:'fixture finished'});}await agent.whenIdle();}
  else{assert.equal(result.outcome,'success');assert.deepEqual(h.adapter.requests[0].tools.map(t=>t.name).sort(),['fixture_list','fixture_local','task_submit_result']);assert.equal(web.requests.length,0,'leased route wins over the WebUI selection');agent.followup(createUserMessage({source:{kind:'test'},content:[{type:'text',text:'Resume ordinary WebUI chat'}]}));await agent.whenIdle();assert.equal(web.requests.length,2,'ordinary input and original model resume after task guard cleanup');assert.match(JSON.stringify(web.requests[1].messages),/test.md/);}
  await handle.dispose();
 }finally{await h.dispose();}
});}
