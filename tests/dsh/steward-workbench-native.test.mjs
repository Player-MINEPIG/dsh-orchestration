import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startHost } from '../ci/browser-native-project.mjs';
import { workbenchFileAllowed } from '../../packages/task-system/dist/steward-workbench.js';
import { delegatesProjectDetails, authorizedProjectInput } from '../../packages/task-system/dist/steward-project-creation.js';
const presets={'read-only':{sandbox:'read-only',approval:'never'},'workspace-write':{sandbox:'workspace-write',approval:'ask'},'danger-full-access':{sandbox:'danger-full-access',approval:'never'}};
async function fixture(){const h=await startHost({permissionPresets:presets});try{const req=createRequire(join(process.env.DSH_OFFICIAL_ROOT,'package.json'));await h.ctx.loader.create({id:'workbench-native-files',name:pathToFileURL(req.resolve('@deepseek-ai/dsh-tool-fs')).href,config:{read:true,write:true,edit:true,readImage:true}});await h.ctx.loader.await();return h;}catch(error){await h.close();throw error;}}
async function done(h,id){for(let n=0;n<400;n++){const value=await h.ctx.taskSystem.steward.reconcile({conversationId:'main',commandId:id});if(value.commandMessage?.state.kind==='completed')return value;await new Promise(r=>setTimeout(r,10));}throw Error('workbench turn did not complete');}

test('bounded project-detail delegation preserves explicit requirements',()=>{
 assert.deepEqual(authorizedProjectInput('创建一个项目，目标：检查天气，名称：天气助手',{title:'天气助手',goal:'检查天气'}),{title:'天气助手',goal:'检查天气'});
 assert.equal(delegatesProjectDetails('你自己写即可'),true);assert.equal(delegatesProjectDetails('他说“你自己写即可”'),false);
 assert.throws(()=>authorizedProjectInput('创建一个新项目，'+ '原'.repeat(7900),{title:'拟定',goal:'目'.repeat(1000)},true),{code:'CLARIFICATION'});
});

test('real workbench tools write/read own persistent cwd while other-project, traversal, symlink and personal isolation hold',{timeout:30000},async()=>{
 const h=await fixture();try{
  const s=h.ctx.taskSystem.steward,source=await s.sourceSession({conversationId:'main',scope:{kind:'workbench'}}),cwd=source.binding.cwd;
  const outside=join(h.directory,'foreign-secret.txt');writeFileSync(outside,'FOREIGN_SECRET');
  symlinkSync(outside,join(cwd,'outside-link'));symlinkSync(join(h.directory,'never-created.txt'),join(cwd,'dangling-link'));symlinkSync(h.directory,join(cwd,'outside-dir'));
  for(const path of [outside,'../foreign-secret.txt','outside-link','dangling-link','outside-dir/new.txt'])assert.equal(workbenchFileAllowed(cwd,{file_path:path}),false,path);
  assert.equal(workbenchFileAllowed(cwd,{file_path:'notes/new.txt'}),true);
  h.model.script.push({name:'write',args:{file_path:'notes.txt',content:'WORKBENCH_ARTIFACT'}},{name:'read',args:{file_path:'notes.txt'}},{name:'read',args:{file_path:outside}},options=>{const text=JSON.stringify(options.messages);assert.match(text,/WORKBENCH_ARTIFACT/);assert.ok(!text.includes('FOREIGN_SECRET'));assert.match(text,/only access their own workspace/);return 'WORKSPACE_READY';});
  await s.send({conversationId:'main',commandId:'workbench-files',text:'在工作台整理研究草案',target:{kind:'workbench'}});const state=await done(h,'workbench-files');
  assert.equal(state.commandMessage.source.sessionId,source.binding.sessionId);assert.equal(readFileSync(join(cwd,'notes.txt'),'utf8'),'WORKBENCH_ARTIFACT');
  assert.ok(!h.model.requests[0].tools.some(tool=>tool.name==='bash'));assert.ok(h.model.requests[0].tools.some(tool=>tool.name==='steward_create_project'));
  const recall=s.recall.read(source.binding.sessionId,{});assert.equal(recall.scope.kind,'workbench');
  assert.throws(()=>s.recall.read(source.binding.sessionId,{recordKind:'project'}),{code:'FORBIDDEN'});
  h.model.script.push('PERSONAL_ONLY');await s.send({conversationId:'main',commandId:'personal-after',text:'随便聊聊',target:{kind:'personal'}});const personal=await done(h,'personal-after');
  assert.notEqual(personal.commandMessage.source.sessionId,source.binding.sessionId);assert.notEqual(personal.commandMessage.source.cwd,cwd);assert.ok(!h.model.requests.at(-1).tools.some(tool=>['write','steward_create_project'].includes(tool.name)));assert.ok(!JSON.stringify(h.model.requests.at(-1).messages).includes('WORKBENCH_ARTIFACT'));
  h.model.script.push({name:'write',args:{file_path:'denied.txt',content:'NO'}},'READONLY_DONE');await s.send({conversationId:'main',commandId:'readonly-workbench',text:'写入测试',target:{kind:'workbench'},permissionPreset:'read-only'});await done(h,'readonly-workbench');assert.equal(existsSync(join(cwd,'denied.txt')),false);
 }finally{await h.close();}
});

test('legacy personal creation clarification bridges only that explicit intent on an active same-command retry; delegated goal preserves original requirement',{timeout:30000},async()=>{
 const h=await fixture();try{
  const s=h.ctx.taskSystem.steward,original='创建一个新项目，去搜索并推测gpt6.2的发布时间';await s.configureRouting({commandId:'legacy-creation-router',expectedRevision:0,fallback:{provider:'test-offline',model:'script'}});
  h.model.script.push('PERSONAL_SECRET');await s.send({conversationId:'main',commandId:'unrelated-casual',text:'我的无关闲聊秘密',target:{kind:'personal'}});await done(h,'unrelated-casual');
  h.model.script.push('请提供新项目的标题和目标原文。');await s.send({conversationId:'main',commandId:'legacy-create',text:original,target:{kind:'personal'}});const old=await done(h,'legacy-create');
  const before=h.model.requests.length,request={conversationId:'main',commandId:'same-local-not-admitted-id',text:'你自己写即可',routingMode:'auto'};
  h.model.script.push(JSON.stringify({kind:'new-work',question:'要将这项待创建项目需求交给管家工作区吗？'}),options=>{const data=JSON.stringify(options.messages);assert.match(data,/去搜索并推测gpt6.2/);assert.ok(!data.includes('PERSONAL_SECRET'));assert.ok(!data.includes('无关闲聊秘密'));return {name:'steward_create_project',args:{title:'GPT6.2发布时间研究',goal:'搜索可信信息并形成有依据的发布时间推测'}};},'已创建研究项目');
  const routing=await s.send(request),question=routing.router.find(item=>item.commandId===request.commandId);assert.equal(question.executorAdmitted,false);await s.send({conversationId:'main',commandId:'legacy-confirm-workbench',text:'确认',routeQuestionId:question.questionId,routeCreateTopic:true,target:{kind:'workbench'}});const next=await done(h,request.commandId);assert.equal(h.model.requests.length,before+3,'Independent routing confirmation precedes the real bounded creation tool turn');
  assert.equal(next.commandMessage.scope.kind,'workbench');assert.ok(next.commandMessage.scope.topicId);assert.equal(s.store.message(old.commandMessage.id).scope.kind,'personal');assert.equal(next.commandMessage.creationContext.instructionId,old.commandMessage.id);
  const project=h.runtime.snapshot().projects.find(p=>p.title==='GPT6.2发布时间研究');assert.ok(project);assert.ok(project.goal.includes(original));
  const count=h.model.requests.length;await s.send(request);assert.equal(h.model.requests.length,count);assert.equal(h.runtime.snapshot().projects.filter(p=>p.title==='GPT6.2发布时间研究').length,1);
  const source=await s.sourceSession({conversationId:'main',scope:next.commandMessage.scope});assert.ok(existsSync(source.binding.cwd));
  h.model.script.push({name:'steward_create_project',args:{title:'不允许',goal:'无授权'}},'未创建');await s.send({conversationId:'main',commandId:'isolated-delegation',text:'你自己写即可',target:{kind:'workbench'}});await done(h,'isolated-delegation');assert.equal(h.runtime.snapshot().projects.filter(p=>p.title==='不允许').length,0);
 }finally{await h.close();}
});

test('creation authority freezes exact reply anchor, rejects quote bridging and narrows delegation under later explicit constraints',{timeout:30000},async()=>{
 const h=await fixture();try{
  const s=h.ctx.taskSystem.steward;
  h.model.script.push('A项目请确认标题和目标');await s.send({conversationId:'main',commandId:'intent-A',text:'创建一个新项目，研究A主题',target:{kind:'workbench'}});await done(h,'intent-A');
  const questionA=s.store.messages('main').find(item=>item.text==='A项目请确认标题和目标');
  h.model.script.push('B项目请确认标题和目标');await s.send({conversationId:'main',commandId:'intent-B',text:'创建一个新项目，研究B主题',target:{kind:'workbench'}});await done(h,'intent-B');
  h.model.script.push({name:'steward_create_project',args:{title:'不应创建',goal:'引用不是授权'}},'引用未创建');await s.send({conversationId:'main',commandId:'quote-not-authority',text:'你自己写即可',target:{kind:'workbench'},quote:{messageId:questionA.id,expectedRevision:questionA.revision,excerpt:questionA.text}});await done(h,'quote-not-authority');assert.ok(!h.runtime.snapshot().projects.some(p=>p.title==='不应创建'));
  h.model.script.push({name:'steward_create_project',args:{title:'A研究',goal:'整理A主题资料'}},'A已创建');await s.send({conversationId:'main',commandId:'reply-A',text:'你自己写即可',replyTo:questionA.id});const reply=await done(h,'reply-A');
  const a=h.runtime.snapshot().projects.find(p=>p.title==='A研究');assert.ok(a.goal.includes('研究A主题'));assert.ok(!a.goal.includes('研究B主题'));assert.equal(reply.commandMessage.creationContext.instructionId,s.store.commandMessage('main','intent-A').id);
  for(const [id,text,response] of [['narrow-root','创建一个新项目，整理天气资料','请确认名称目标'],['narrow-delegate','你自己写即可','我先整理方案']]){h.model.script.push(response);await s.send({conversationId:'main',commandId:id,text,target:{kind:'workbench'}});await done(h,id);}
  const latest={title:'天气助手',goal:'只记录上海天气，不要创建定时任务'};
  h.model.script.push({name:'steward_create_project',args:{title:'别的名字',goal:'创建定时任务'}},options=>{assert.match(JSON.stringify(options.messages),/最新明确提供/);return {name:'steward_create_project',args:latest};},'已按最新限制创建');
  await s.send({conversationId:'main',commandId:'narrow-fields',text:`名称：${latest.title}，目标：${latest.goal}`,target:{kind:'workbench'}});await done(h,'narrow-fields');
  const narrowed=h.runtime.snapshot().projects.find(p=>p.title===latest.title);assert.ok(narrowed);assert.ok(narrowed.goal.includes(latest.goal));assert.ok(narrowed.goal.includes('整理天气资料'));
  h.model.script.push('请确认这个待创建项目的名称');await s.send({conversationId:'main',commandId:'cancelled-reply-root',text:'创建一个新项目，整理取消测试',target:{kind:'workbench'}});await done(h,'cancelled-reply-root');
  const cancelledQuestion=s.store.messages('main').find(item=>item.text==='请确认这个待创建项目的名称');h.model.script.push('已取消创建');await s.send({conversationId:'main',commandId:'cancelled-reply-stop',text:'取消刚才的创建',target:{kind:'workbench'}});await done(h,'cancelled-reply-stop');
  const beforeReply=h.model.requests.length;await assert.rejects(s.send({conversationId:'main',commandId:'reply-after-cancel',text:'你自己写即可',replyTo:cancelledQuestion.id}),{code:'CLARIFICATION'});assert.equal(h.model.requests.length,beforeReply);
  h.model.script.push('澄清'.repeat(6500));await s.send({conversationId:'main',commandId:'bounded-intent',text:'创建一个新项目，研究上下文边界',target:{kind:'workbench'}});await done(h,'bounded-intent');
  const count=h.model.requests.length;await assert.rejects(s.send({conversationId:'main',commandId:'bounded-answer',text:'你自己写即可',target:{kind:'workbench'}}),{code:'CLARIFICATION'});assert.equal(h.model.requests.length,count);assert.equal(s.store.commandMessage('main','bounded-answer'),null);
 }finally{await h.close();}
});

test('workbench native source, files and admitted command recover across a real full profile restart without inference replay',{timeout:30000},async()=>{
 const h=await fixture();let restarted;try{
  const s=h.ctx.taskSystem.steward,request={conversationId:'main',commandId:'durable-workbench',text:'保留这份草案',target:{kind:'workbench'}};
  const source=await s.sourceSession({conversationId:'main',scope:{kind:'workbench'}});h.model.script.push({name:'write',args:{file_path:'draft.txt',content:'PERSISTENT_WORKBENCH'}},'已保留');await s.send(request);const first=await done(h,request.commandId),count=h.model.requests.length;
  await h.ctx.fiber.dispose();
  const req=createRequire(join(process.env.DSH_OFFICIAL_ROOT,'package.json')),{runProfile}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh/profile-boot'))),{createLaunchEnvironmentSnapshot}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-launch-environment')));
  ({ctx:restarted}=await runProfile({profile:'project-native-browser',patchFiles:[],args:['--no-open'],environment:createLaunchEnvironmentSnapshot([{source:'process',values:{...process.env}}])}));restarted.llm.registerAdapter(['test-offline'],h.model);
  const recovered=await restarted.taskSystem.steward.sourceSession({conversationId:'main',scope:{kind:'workbench'}});assert.deepEqual(recovered.binding,source.binding);assert.equal(readFileSync(join(recovered.binding.cwd,'draft.txt'),'utf8'),'PERSISTENT_WORKBENCH');
  const replay=await restarted.taskSystem.steward.send(request);assert.equal(replay.commandMessage.id,first.commandMessage.id);assert.equal(h.model.requests.length,count);assert.equal(restarted.taskSystem.steward.recall.read(source.binding.sessionId,{}).scope.kind,'workbench');
 }finally{await restarted?.fiber.dispose();await h.close();}
});
