import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import TitleService,{foldSessionTitle} from '@deepseek-ai/dsh-session-title';
import ProjectionCache from '@deepseek-ai/dsh-session-projection-cache';
import {createNativeHarness} from './native-harness.mjs';
import {attachProjectSessionHost} from '../../packages/task-system/test/fixtures/project-session-host.mjs';
import {authorizedProjectInput,requestsNewProject} from '../../packages/task-system/dist/steward-project-creation.js';
import {resolveStewardRoute} from '../../packages/task-system/dist/steward-routing.js';
const config={role:'both',schedulerEnabled:false,autoExecute:false,projectAgentOptions:{provider:'test-offline',model:'script'}};
const args={title:'天气助手',goal:'整理每天的天气'};
const text=`帮我新建一个项目，名称：${args.title}，目标：${args.goal}`;
async function setup(dir,{root=true,mode='workspace-write'}={}){
 const h=await createNativeHarness({dir,config});
 await h.ctx.loader.create({id:'creation-sandbox',name:'@deepseek-ai/dsh-sandbox-policy',config:{mode}});
 await attachProjectSessionHost(h);await h.ctx.loader.await();
 await h.ctx.plugin(TitleService,{fallbackMaxWords:10,fallbackMaxBytes:100,maxTitleBytes:512});
 await h.ctx.plugin(ProjectionCache,{writeEveryEvents:100,writeIntervalMs:10000});await h.ctx.fiber.ready;
 if(root&&!h.ctx.taskSystem.projects.settings().root)h.ctx.taskSystem.projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
 return h;
}
async function done(h,commandId){
 for(let n=0;n<400;n++){
  const snapshot=await h.ctx.taskSystem.steward.reconcile({conversationId:'main',commandId});
  if(snapshot.commandMessage?.state.kind==='completed')return snapshot;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw Error('Project creation native turn did not finish: '+JSON.stringify(h.ctx.taskSystem.steward.snapshot({conversationId:'main',commandId}).commandMessage?.state));
}
function toolResult(request){return JSON.stringify(request.messages);}

test('imperative new-project routing is side effect free and quoted, casual, question, and missing metadata are not authority',async()=>{
 const route=await resolveStewardRoute({text,projects:[],previousScope:{kind:'project',projectId:'old'},classify:()=>{throw Error('No classifier needed');}});
 for(const value of ["我想新建一个叫天气助手的项目，目标整理每天的天气", "能帮我创建项目天气助手，目标整理每天的天气吗？", "请帮我创建项目天气助手，目标整理每天的天气"])assert.equal(requestsNewProject(value),true,value);
 assert.equal(requestsNewProject("管家是否能创建项目？"),false);
 assert.deepEqual(route,{kind:'route',target:{kind:'personal'},provenance:'explicit'});
 for(const value of ['如何新建项目？','他说“帮我新建一个项目，名称：天气助手，目标：整理每天的天气”','我想了解新建项目','新建项目怎么操作','> 新建项目：天气助手','Create a new project?']){
  assert.equal(requestsNewProject(value),false,value);
  assert.throws(()=>authorizedProjectInput(value,args),{code:'FORBIDDEN'});
 }
 assert.throws(()=>authorizedProjectInput(text,{title:args.title}),{code:'CLARIFICATION'});
 assert.throws(()=>authorizedProjectInput(text,{...args,goal:'Model invented goal'}),{code:'CLARIFICATION'});
 assert.throws(()=>authorizedProjectInput(text,{...args,root:'/tmp/arbitrary'}),{code:'CLARIFICATION'});
 assert.throws(()=>authorizedProjectInput('帮我新建一个项目',{title:'项目',goal:'项目'}),{code:'CLARIFICATION'});
 assert.throws(()=>authorizedProjectInput(text,{title:'天气',goal:'整理'}),{code:'CLARIFICATION'});
 assert.throws(()=>authorizedProjectInput('帮我新建一个项目，但先不要创建；名称：天气助手，目标：整理每天的天气',args),{code:'FORBIDDEN'});
 assert.deepEqual(authorizedProjectInput(text,args),args);
});

test('actual personal tool creates one durable project, native sidebar title and workspace, immediate topic and follow-up scope; duplicate result and restart replay converge',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-create-native-'));let h=await setup(dir);
 try{
  const s=h.ctx.taskSystem.steward,request={conversationId:'main',commandId:'create-weather',text,routingMode:'auto'};
  h.adapter.script.push({name:'steward_create_project',args},options=>{
   assert.match(toolResult(options),/projectId/);assert.match(toolResult(options),/sessionId/);
   return {name:'steward_create_project',args};
  },'项目已创建');
  await s.send(request);const snapshot=await done(h,request.commandId);
  const projects=h.ctx.taskSystem.projects.snapshot().projects;assert.equal(projects.length,1);
  const project=projects[0],scope={kind:'project',projectId:project.id};
  assert.equal(snapshot.commandMessage.scope.kind,'personal','Creation never rewrites the source scope');
  assert.deepEqual(snapshot.currentScope,scope);assert.ok(snapshot.topicActivity.items.some(item=>item.scope.projectId===project.id));
  assert.ok(existsSync(join(project.workspace,'PROJECT.md')));
  assert.ok(h.ctx.workspaceRegistry.list().some(workspace=>workspace.sessionIds.includes(project.sessionId)));
  const reader=await h.ctx.sessionPersistence.open(project.sessionId,'read');
  try{assert.equal(foldSessionTitle((await reader.read()).events).title,'管家 · 天气助手');}finally{await reader.close();}
  const sidebar=(await h.ctx.sessionController.list({},AbortSignal.timeout(5000))).items;
  assert.equal(sidebar.find(item=>item.sessionId===project.sessionId)?.projections.values.title,'管家 · 天气助手');
  assert.ok(h.adapter.requests[0].tools.some(tool=>tool.name==='steward_create_project'));
  const calls=h.adapter.requests.length;await s.send(request);assert.equal(h.adapter.requests.length,calls);
  assert.equal(h.ctx.taskSystem.projects.snapshot().projects.length,1);
  await h.dispose();h=await setup(dir);
  const replay=await h.ctx.taskSystem.steward.send(request);assert.equal(replay.commandMessage.id,snapshot.commandMessage.id);
  assert.equal(h.adapter.requests.length,0);assert.equal(h.ctx.taskSystem.projects.snapshot().projects.length,1);
  assert.deepEqual(replay.currentScope,scope);
  h.adapter.script.push('项目后续已收到');
  await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'follow-created',text:'请继续整理'});
  const follow=await done(h,'follow-created');assert.deepEqual(follow.commandMessage.scope,scope);
  assert.equal(follow.commandMessage.source.sessionId,project.sessionId);
  assert.ok(!h.adapter.requests[0].tools.some(tool=>tool.name==='steward_create_project'),'Project PM cannot create additional projects');
 }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('read-only native policy denies before project rows and files; untrusted text cannot grant creation even under writable policy',{timeout:30000},async()=>{
 for(const [index,body,mode] of [[0,text,'read-only'],[1,'我只是提到创建项目，不要新建天气助手；整理每天的天气','workspace-write']]){
  const h=await setup(undefined,{mode});try{
   h.adapter.script.push({name:'steward_create_project',args},options=>{assert.match(toolResult(options),index===0?/read-only|permission preset does not allow/:/explicit current user instruction/);return '未创建项目';});
   await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'denied-'+index,text:body,target:{kind:'personal'}});await done(h,'denied-'+index);
   assert.equal(h.ctx.taskSystem.projects.snapshot().projects.length,0);
   assert.equal(h.ledger.managementDatabase().prepare('SELECT COUNT(*) AS n FROM pr_projects').get().n,0);
  }finally{await h.dispose();}
 }
});

test('missing configured root surfaces the actual error without creating a row or inventing a root',{timeout:20000},async()=>{
 const h=await setup(undefined,{root:false});try{
  h.adapter.script.push({name:'steward_create_project',args},options=>{assert.match(toolResult(options),/Set the project root first/);return '请先配置项目根目录';});
  await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'missing-root',text,target:{kind:'personal'}});await done(h,'missing-root');
  assert.equal(h.ctx.taskSystem.projects.settings().root,null);assert.equal(h.ctx.taskSystem.projects.snapshot().projects.length,0);
 }finally{await h.dispose();}
});

test('missing title and goal clarify without effects; bounded metadata replies complete the original instruction across restart and cancellation ends it',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'steward-create-details-'));let h=await setup(dir);
 try{
  h.adapter.script.push('新项目叫什么，目标是什么？');
  await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'draft-intent',text:'帮我建个项目',routingMode:'auto'});await done(h,'draft-intent');
  assert.equal(h.ctx.taskSystem.projects.snapshot().projects.length,0);
  h.adapter.script.push('这个项目的目标是什么？');
  await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'draft-title',text:'叫天气助手',routingMode:'auto'});await done(h,'draft-title');
  assert.equal(h.ctx.taskSystem.projects.snapshot().projects.length,0);
  const origin=h.ctx.taskSystem.steward.store.commandMessage('main','draft-intent');
  await h.dispose();h=await setup(dir);
  h.adapter.script.push({name:'steward_create_project',args},'项目已经建立');
  await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'draft-goal',text:'目标是整理每天的天气',routingMode:'auto'});await done(h,'draft-goal');
  assert.equal(h.ctx.taskSystem.projects.snapshot().projects.length,1);
  assert.equal(h.ledger.managementDatabase().prepare('SELECT command FROM pr_projects').get().command,'steward-create:'+origin.id);
  for(const [commandId,body] of [['cancel-intent','帮我新建一个项目'],['cancel-draft','取消刚才的创建，先聊别的']]){
   h.adapter.script.push('收到');await h.ctx.taskSystem.steward.send({conversationId:'main',commandId,text:body,target:{kind:'personal'}});await done(h,commandId);
  }
  h.adapter.script.push({name:'steward_create_project',args},options=>{assert.match(toolResult(options),/explicit current user instruction/);return '请重新明确创建要求';});
  await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'after-cancel',text:'叫天气助手，目标整理每天的天气',target:{kind:'personal'}});await done(h,'after-cancel');
  assert.equal(h.ctx.taskSystem.projects.snapshot().projects.length,1);
 }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});
