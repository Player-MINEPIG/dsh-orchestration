import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {Loader} from '@deepseek-ai/cordis-plugin-loader';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {pathToFileURL,fileURLToPath} from 'node:url';
const repoRoot=fileURLToPath(new URL('../../../',import.meta.url));
import {resolve,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fixture} from './fixtures/registration.mjs';
test('official DSH Loader registers and executes registration/update/final/history native tools in isolated planner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'registration-dsh-')),ctx=new Context();
 try{
 await ctx.plugin(Loader,{baseUrl:pathToFileURL(resolve(repoRoot,'package.json')).href});
 await ctx.loader.root.update([
 {id:'llm',name:'@deepseek-ai/dsh-llm'},
 {id:'sessions',name:'@deepseek-ai/dsh-session'},
 {id:'projection',name:'@deepseek-ai/dsh-session-projection'},
 {id:'prompt',name:'@deepseek-ai/dsh-system-prompt'},
 {id:'tools',name:'@deepseek-ai/dsh-tools'},
 {id:'task',name:pathToFileURL(resolve(repoRoot,'packages/task-system/dist/dsh-plugin.js')).href,config:{databasePath:join(dir,'central.sqlite'),role:'planner',keepAlive:false,schedulerEnabled:false,autoExecute:false}},
 {id:'registration',name:pathToFileURL(resolve(repoRoot,'packages/task-system/dist/project-registration/plugin.js')).href,config:{namespaces:['fixture/local']}},
 ]);await ctx.loader.await();assert.ok(ctx.taskSystem);
 const invoke=async(name,p)=>{const r=await ctx.tools.execute({callId:ToolCallId('registration-'+name),name,arguments:{packetJson:JSON.stringify(p)},signal:new AbortController().signal});assert.equal(r.isError,false,JSON.stringify(r.content));return JSON.parse(r.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));};
 const p=fixture();const a=await invoke('project_register',p);assert.equal(a.value.sourceRevision,1);
 const p2={...p,revision:2,previousRevision:1,idempotencyKey:'r2'};await invoke('project_update',p2);
 const p3={...p2,revision:3,previousRevision:2,idempotencyKey:'r3',mode:'final',project:{...p2.project,state:'completed'}};await invoke('project_submit',p3);
 const historical={...p,projectExternalId:'historical',mode:'history',project:{...p.project,state:'completed'}};await invoke('project_history_intake',historical);
 assert.equal(ctx.taskSystem.ledger.snapshot().projects.length,2);assert.ok(ctx.taskSystem.ledger.snapshot().runs.every(r=>r.observationOnly));
 }finally{await ctx.fiber.dispose();rmSync(dir,{recursive:true,force:true});}
});
