import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
import {TaskPluginSettings,executionPresetsDescriptor} from '../dist/settings.js';
import {SessionId} from '@deepseek-ai/dsh-session';

async function fixture() {
 const h=await createNativeHarness({presets:false,config:{executionAgentPreset:'files'},script:[{name:'read',args:{file_path:'evidence.txt'}},{name:'task_submit_result',args:{outcome:'success',summary:'Read the actual preset file'}}]});
 writeFileSync(join(h.dir,'evidence.txt'),'PRESET_READ_PROOF');h.ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
 const wrong=join(h.dir,'wrong-route.mjs');writeFileSync(wrong,`import {installModelSelection} from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-agent'))};export function apply(ctx){installModelSelection(ctx,{current:{provider:'wrong-provider',model:'wrong-model'},assembled:undefined})}`);
 for(const row of [
  {id:'fs',name:'@deepseek-ai/dsh-fs-local',config:{cwd:h.dir}},
  {id:'directory',name:'@deepseek-ai/dsh-working-directory',config:{defaultDirectory:h.dir}},
  {id:'registry',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'empty'}},
  {id:'files',name:'@deepseek-ai/dsh-agent-preset',config:{id:'files',name:'Read files',plugins:[{name:'@deepseek-ai/dsh-tool-fs',config:{read:true,readImage:false,write:false,edit:false}},{name:pathToFileURL(wrong).href}]}},
  {id:'empty',name:'@deepseek-ai/dsh-agent-preset',config:{id:'empty',name:'No filesystem',plugins:[]}},
 ])await h.ctx.loader.create(row);
 await h.ctx.loader.await();
 h.ledger.registerNode('node',{nodeId:'local',enabled:true,roles:['both'],workspaceIds:[],capabilities:[],maxConcurrent:8,models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],lastSeenAt:new Date().toISOString()});
 let n=0;h.claim=()=>{const key=String(++n),task=h.ledger.createTask('task'+key,{title:'Preset fixture'}).value,run=h.ledger.createRun('run'+key,{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;const claim=h.ledger.claim('claim'+key,{runId:run.runId,nodeId:'local',ttlMs:30000}).value;claim.attempt.executionId=randomUUID();return claim};
 h.execute=(claim,sid=randomUUID(),resumeSession=false)=>h.ctx.taskSystem.native.executeExternal({claim,sessionId:sid,resumeSession,workspacePath:h.dir,signal:new AbortController().signal});
 return h;
}

test('official preset catalog is bounded public metadata, and its Typert descriptor has a strict result',async()=>{
 const h=await fixture();try{
  const catalog=await TaskPluginSettings.prototype.executionPresets.call({ctx:h.ctx});assert.deepEqual(catalog.items.map(x=>x.id).sort(),['empty','files']);assert.equal(catalog.items.every(x=>x.available),true);assert.doesNotMatch(JSON.stringify(catalog),/plugins|wrong-provider/);assert.deepEqual(executionPresetsDescriptor.result.create().parse(catalog),catalog);
 }finally{await h.dispose()}
});

test('selected official preset supplies a real read tool and cannot change the task model route',async()=>{
 const h=await fixture();try{
  const sid=randomUUID(),result=await h.execute(h.claim(),sid);assert.equal(result.outcome,'success',JSON.stringify({result,requests:h.adapter.requests,log:h.ctx.logger.buffer.map(x=>x.args.map(a=>a instanceof Error ? a.message : String(a)))}));assert.match(JSON.stringify(h.adapter.requests[1].messages),/PRESET_READ_PROOF/);assert.ok(h.adapter.requests[0].tools.some(t=>t.name==='read'));assert.ok(!h.adapter.requests[0].tools.some(t=>t.name==='write'));assert.equal(h.adapter.requests[0].model,'script');
  const stored=await h.ctx.sessionPersistence.open(SessionId(sid),'read');try{assert.equal(stored.header.agentPreset,'files')}finally{await stored.close()}
  h.ctx.taskSystem.config.executionAgentPreset='empty';h.adapter.script.push({name:'task_submit_result',args:{outcome:'success',summary:'No filesystem tools'}});
  const next=randomUUID();assert.equal((await h.execute(h.claim(),next)).outcome,'success');assert.ok(!h.adapter.requests.at(-1).tools.some(t=>t.name==='read'));
  const newStored=await h.ctx.sessionPersistence.open(SessionId(next),'read');try{assert.equal(newStored.header.agentPreset,'empty')}finally{await newStored.close()}
 }finally{await h.dispose()}
});

test('resume retains the session recorded preset after the executor selection changes',async()=>{
 const h=await fixture();try{
  const sid=SessionId(randomUUID()),handle=await h.ctx.get('sessionPersistence').create({version:4,id:sid,createdAt:Date.now(),cwd:h.dir,isSeeded:false,delegationDepth:0,agentPreset:'files'});await handle.append([{type:'permission/preset',seq:0,time:Date.now(),data:{preset:'workspace-write'}}]);await handle.flush();await handle.close();
  h.ctx.taskSystem.config.executionAgentPreset='empty';const claim=h.claim();claim.attempt.sessionId=sid;
  assert.equal((await h.execute(claim,sid,true)).outcome,'success');assert.ok(h.adapter.requests[0].tools.some(t=>t.name==='read'));assert.match(JSON.stringify(h.adapter.requests[1].messages),/PRESET_READ_PROOF/);
 }finally{await h.dispose()}
});

test('a deleted selected preset blocks clearly rather than falling back or creating an empty session',async()=>{
 const h=await fixture();try{
  h.ctx.taskSystem.config.executionAgentPreset='deleted';await assert.rejects(h.execute(h.claim()),error=>error.code==='EXECUTION_PRESET_UNAVAILABLE');assert.equal(h.adapter.requests.length,0);
 }finally{await h.dispose()}
});
