import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { TaskPluginSettings } from '../dist/settings.js';
import { TaskError } from '../dist/ledger.js';

const service = task => Object.assign(Object.create(TaskPluginSettings.prototype), {ctx: {get: key => key === 'taskSystem' ? task : undefined}});
test('project RPC distinguishes executor role, unavailable planner service and business failures', async () => {
  const executor = service({config: {role: 'executor'}});
  const roleError = error => error.isDSHRemoteError === true && error.code === 'task/project' && error.details.reason === 'PLANNER_REQUIRED';
  await assert.rejects(executor.projectSnapshot(), error => error.code === 'task/project' && error.details.reason === 'COORDINATOR_UNAVAILABLE');
  await assert.rejects(executor.createProject({commandId: 'no-grant', title: 'test', goal: 'test'}), roleError);
  await assert.rejects(service({config:{role:'planner'}}).projectSnapshot(), error => error.details.reason === 'PROJECT_UNAVAILABLE');
  const snapshot = {projects:[],tasks:[]};
  assert.equal(await service({config:{role:'planner'},projects:{snapshot:()=>snapshot}}).projectSnapshot(), snapshot);
  await assert.rejects(service({config:{role:'both'},projects:{create:async()=>{throw new TaskError('CONFLICT','PRIVATE PATH MUST NOT LEAK');}}}).createProject({commandId:'conflict',title:'test',goal:'test'}),error=>error.code==='task/project'&&error.details.reason==='CONFLICT'&&!error.message.includes('PRIVATE PATH'));
});

function page() {
  const html=readFileSync(new URL('../dist/project-page.html',import.meta.url),'utf8');
  const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements=new Map(),requests=[],events={},documentEvents={},root={dataset:{}}; let sequence=0;
  const parent={postMessage:request=>{if(request.method!=="detailFullscreen")requests.push(request);}};
  const context=vm.createContext({atob,structuredClone,console,Date,Map,Set,URL,innerWidth:1200,crypto:{randomUUID:()=>String(++sequence)},parent,window:{addEventListener:(name,listener)=>events[name]=listener},document:{documentElement:root,title:'',activeElement:{tagName:'BODY'},querySelector:()=>null,addEventListener:(name,listener)=>documentEvents[name]=listener,getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',hidden:true,dataset:{}});return elements.get(id);}},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1});
  vm.runInContext(source,context);
  return {requests,context,elements,documentEvents,action:(a,id)=>vm.runInContext('actions('+JSON.stringify(a)+','+JSON.stringify(id)+')',context),overlay:()=>elements.get('overlays').innerHTML,theme:(source,input)=>events.message({source:source==='parent'?parent:{},data:{channel:'dsh-project-runtime',method:'theme',input}}),root,content:()=>elements.get('app').innerHTML,async answer(response){const request=requests.shift();assert.ok(request);events.message({source:parent,data:{channel:'dsh-project-runtime',id:request.id,...response}});await new Promise(resolve=>setImmediate(resolve));},async retry(){await vm.runInContext("actions('reload')",context);},startRetry(){return vm.runInContext("actions('reload')",context);},startPoll(){return vm.runInContext('poll()',context);}};
}
const snapshot={projects:[],tasks:[],settings:{root:null,revision:0},nodes:[]};
test('executor page shows a persistent role explanation without false zero task counts or repeated role requests', async () => {
  const p=page();assert.match(p.content(),/正在读取/);assert.doesNotMatch(p.content(),/暂无任务|hub-stats|kanban-col/);
  await p.answer({error:'当前节点为执行端，项目任务中心需要调度端身份。',errorCode:'PLANNER_REQUIRED'});
  assert.match(p.content(),/当前节点是执行端/);assert.match(p.content(),/设置 → 任务系统/);assert.doesNotMatch(p.content(),/暂无任务|hub-stats|kanban-col/);
  await p.startPoll();assert.equal(p.requests.length,0);
  const retry=p.startRetry();assert.equal(p.requests.length,1);await p.answer({value:snapshot});await retry;
  assert.match(p.content(),/hub-stats/);assert.doesNotMatch(p.content(),/当前节点是执行端/);
});
test('initial read failure and stale real data stay distinct and clear after recovery', async () => {
  const p=page();await p.answer({error:'服务内部错误',errorCode:'gateway/internal'});
  assert.match(p.content(),/数据尚未读取成功/);assert.doesNotMatch(p.content(),/hub-stats/);
  let pending=p.startRetry();await p.answer({value:snapshot});await pending;
  pending=p.startPoll();await p.answer({error:'连接中断',errorCode:'gateway/disconnected'});await pending;
  assert.match(p.content(),/保留上次/);assert.match(p.content(),/hub-stats/);
  pending=p.startPoll();await p.answer({value:snapshot});await pending;
  assert.doesNotMatch(p.content(),/保留上次|连接中断/);
});

test('project theme changes keep task data and pending requests, and ignore messages from other sources', async () => {
  const p=page();
  p.theme('other','dark'); assert.equal(p.root.dataset.theme,undefined);
  p.theme('parent','light'); assert.equal(p.root.dataset.theme,'light');
  assert.equal(p.requests.length,1);
  await p.answer({value:snapshot}); const content=p.content();
  p.theme('parent','dark'); assert.equal(p.root.dataset.theme,'dark');
  p.theme('parent','invalid'); assert.equal(p.root.dataset.theme,'dark');
  assert.equal(p.content(),content); assert.equal(p.requests.length,0);
});


test('legacy task detail exposes temporary conversation and visible disabled retry reasons, returning to the original task filter',async()=>{
 const p=page(),task={id:'legacy-task',project:'unassigned',title:'Legacy task',description:'Existing task',status:'error',nativeState:'waiting',canRetry:true,run:'old-run',runState:'failed',recommendation:[],candidateChecks:[]};
 await p.answer({value:{...snapshot,tasks:[task]}});await p.action('filter','error');await p.action('task',task.id);
 assert.match(p.overlay(),/临时任务对话/);assert.match(p.overlay(),/重新尝试派发/);
 const open=p.action('task-chat',task.id);assert.equal(p.requests[0].method,'taskConversation');assert.equal(p.requests[0].input.taskId,task.id);
 await p.answer({value:{taskId:task.id,projectId:null,workspace:'/planner/temporary-tasks/task-1',generation:1,messages:[],turns:[],sessions:[]}});await open;
 assert.match(p.content(),/临时任务规划/);assert.match(p.content(),/返回上一位置/);assert.doesNotMatch(p.content(),/整理并继续/);
 await p.action('home');assert.equal(vm.runInContext('state.filter',p.context),'error');assert.equal(vm.runInContext('state.view',p.context),'hub');
 vm.runInContext("state.tasks[0].canRetry=false;state.tasks[0].retryDisabledReason='执行结果不确定，请先核实执行端'",p.context);await p.action('task',task.id);
 assert.match(p.overlay(),/重新尝试派发/);assert.match(p.overlay(),/disabled aria-disabled="true"/);assert.match(p.overlay(),/执行结果不确定/);
});


test('retry confirmation cannot submit twice while candidate evaluation is pending and retains a recoverable error',async()=>{
 const p=page(),task={id:'legacy-task',project:'unassigned',title:'Legacy',status:'error',canRetry:true,actionVersion:'version',runId:'old-run',confirmationRevision:1};
 await p.answer({value:{...snapshot,tasks:[task]}});await p.action('task-retry',task.id);
 const pending=p.action('task-action-confirm');assert.equal(p.requests.length,1);assert.equal(p.requests[0].method,'actOnProjectTask');assert.match(p.overlay(),/正在检查派发条件/);
 await p.action('task-action-confirm');assert.equal(p.requests.length,1);
 await p.answer({error:'候选配置已变化',errorCode:'STALE_DECISION'});await pending;assert.match(p.overlay(),/>确认<\/button>/);assert.doesNotMatch(p.overlay(),/正在检查派发条件/);
});


test('project center provides task return and temporary area; project details return to project center',async()=>{
 const p=page(),project={id:'p',title:'Project',description:'Goal',goal:'Goal',stage:'Active',workspace:'/projects/p',session:1,canChat:true,messages:[]};
 await p.answer({value:{...snapshot,settings:{root:'/projects',revision:1},projects:[project]}});
 assert.doesNotMatch(p.content(),/data-action="temporary-tasks"|data-action="settings"/);
 await p.action('projects');assert.match(p.content(),/data-action="home"/);assert.match(p.content(),/data-action="temporary-tasks"/);assert.doesNotMatch(p.content(),/data-action="settings"/);
 await p.action('project','p');assert.match(p.content(),/data-action="nav-back" data-id="projects" aria-label="返回上一位置"/);
 await p.action('projects');await p.action('temporary-tasks');assert.match(p.content(),/data-action="nav-back" data-id="projects" aria-label="返回上一位置"/);assert.match(p.content(),/新建临时任务/);
 await p.action('home');assert.equal(vm.runInContext('state.view',p.context),'hub');
});

test('temporary creation form submits once and opens the created task; failure retains input and command ID',async()=>{
 const p=page(),task={id:'new-temp',project:'unassigned',title:'New task',description:'Full instruction',status:'queued',recommendation:[],candidateChecks:[]};
 await p.answer({value:{...snapshot,settings:{root:'/projects',revision:1}}});await p.action('projects');await p.action('temporary-tasks');await p.action('create-temporary');
 vm.runInContext("document.getElementById('temporary-title');document.getElementById('temporary-description');",p.context);p.elements.get('temporary-title').value=task.title;p.elements.get('temporary-description').value=task.description;
 let pending=p.action('create-temporary-confirm');const input={...p.requests[0].input};assert.equal(p.requests[0].method,'createTemporaryTask');assert.equal(input.description,task.description);assert.match(p.overlay(),/正在创建并规划/);
 await p.action('create-temporary-confirm');assert.equal(p.requests.length,1);
 await p.answer({error:'Connection failed'});await pending;assert.equal(p.elements.get('temporary-title').value,task.title);assert.equal(p.elements.get('temporary-description').value,task.description);
 pending=p.action('create-temporary-confirm');assert.equal(p.requests[0].input.commandId,input.commandId);await p.answer({value:{taskId:task.id,dispatchState:'queued'}});assert.equal(p.requests[0].method,'projectSnapshot');await p.answer({value:{...snapshot,settings:{root:'/projects',revision:1},tasks:[task]}});await pending;
 assert.match(p.overlay(),/New task/);assert.equal(vm.runInContext('state.overlay.id',p.context),task.id);
});


test('project root settings are available to planners and hidden from executor settings',async()=>{
 assert.deepEqual(await service({config:{role:'executor'}}).projectSettings(),{enabled:false});
 assert.deepEqual(await service({config:{role:'planner'},projects:{settings:()=>({root:'/projects',revision:3})}}).projectSettings(),{enabled:true,root:'/projects',revision:3});
});


test('task panel shows multi-hour elapsed time and refreshes an explicitly requested progress response without redispatch',async()=>{
 const p=page(),task={id:'long-task',project:'unassigned',title:'Long task',status:'running',canRequestStatus:true,canCancel:true,actionVersion:'v1',runId:'run1',executionStartedAt:new Date(Date.now()-9000000).toISOString(),executionEndedAt:null};
 await p.answer({value:{...snapshot,tasks:[task]}});assert.match(p.content(),/已运行 2小时 30分/);
 await p.action('task',task.id);assert.match(p.overlay(),/刷新执行状态/);
 const pending=p.action('task-status',task.id);assert.equal(p.requests[0].method,'actOnProjectTask');assert.equal(p.requests[0].input.action,'status');
 await p.action('task-status',task.id);assert.equal(p.requests.length,1);
 await p.answer({value:{}});
 const requested={...task,progressRequest:{requestId:'req',requestedAt:new Date().toISOString()}};
 await p.answer({value:{...snapshot,tasks:[requested]}});await pending;assert.match(p.overlay(),/等待执行端回报/);
 const refresh=p.startPoll();await p.answer({value:{...snapshot,tasks:[{...requested,progressRequest:{...requested.progressRequest,summary:'正在整理结果，已完成 3 步',reportedAt:new Date().toISOString()}}]}});await refresh;
 assert.match(p.overlay(),/正在整理结果，已完成 3 步/);assert.match(p.overlay(),/回报时间/);assert.equal(p.requests.length,0);
 assert.equal(vm.runInContext("elapsedText('2026-10-01T00:00:00Z','2026-10-03T01:02:03Z')",p.context),'49小时 2分 3秒');
});

test('conversation polling preserves the reading position and composer, follows the bottom only when already there, and dismisses compact retry reminders',async()=>{
 const p=page(),task={id:'mobile-task',project:'unassigned',title:'测试任务2',status:'error',canRetry:true,canReconcile:false,runId:'run-old',actionVersion:'v1'};
 await p.answer({value:{...snapshot,tasks:[task]}});
 const conversation={taskId:task.id,workspace:'/temporary',generation:1,messages:[{id:'m1',role:'assistant',text:'Existing response'}],turns:[],sessions:[]};
 const open=p.action('task-chat',task.id);await p.answer({value:conversation});await open;
 assert.match(p.content(),/recovery-card/);assert.match(p.content(),/btn recovery-action/);assert.match(p.content(),/关闭测试任务2提醒/);
 const messages={dataset:{conversation:'temporary:mobile-task:1'},scrollTop:200,scrollHeight:1200,clientHeight:400},reminder={innerHTML:''},composer={value:'unfinished draft',selectionStart:5};let html='',writes=0;
 Object.defineProperty(messages,'innerHTML',{get:()=>html,set:value=>{html=value;writes++;messages.scrollTop=0;}});
 p.context.nodes={'#messages':messages,'#conversation-recovery':reminder,'#message-input':composer};
 vm.runInContext('document.querySelector=selector=>nodes[selector]||null;updateConversation()',p.context);
 messages.scrollTop=300;const initialWrites=writes,app=p.content();
 let pending=p.startPoll();await p.answer({value:{...snapshot,tasks:[task],nodes:[{sampledAt:1}]}});await p.answer({value:conversation});await pending;
 assert.equal(messages.scrollTop,300);assert.equal(writes,initialWrites,'unchanged messages must not be replaced for heartbeat-only changes');assert.equal(p.content(),app);assert.equal(composer.value,'unfinished draft');assert.equal(composer.selectionStart,5);
 const next={...conversation,messages:[...conversation.messages,{id:'m2',role:'assistant',text:'New response'}]};
 pending=p.startPoll();await p.answer({value:{...snapshot,tasks:[task]}});await p.answer({value:next});await pending;
 assert.equal(messages.scrollTop,300,'new output does not take the user away from older messages');assert.equal(writes,initialWrites+1);
 messages.scrollTop=800;
 pending=p.startPoll();await p.answer({value:{...snapshot,tasks:[task]}});await p.answer({value:{...next,messages:[...next.messages,{id:'m3',role:'assistant',text:'Newest response'}]}});await pending;
 assert.equal(messages.scrollTop,messages.scrollHeight,'readers at the bottom follow new output');
 messages.scrollTop=250;await p.action('dismiss-recovery',task.id);assert.equal(reminder.innerHTML,'');assert.equal(messages.scrollTop,250);assert.equal(p.requests.length,0,'closing a reminder does not perform a task action');
 pending=p.startPoll();await p.answer({value:{...snapshot,tasks:[{...task,actionVersion:'new-heartbeat-version'}]}});await p.answer({value:next});await pending;
 assert.equal(reminder.innerHTML,'','routine refresh does not reopen a dismissed reminder');
 vm.runInContext("state.tasks[0].runId='new-run';updateConversation()",p.context);assert.match(reminder.innerHTML,/recovery-card/,'a new execution can present a new reminder');
});

test('conversation scroll restores the visible message anchor when preceding content changes height',()=>{
 const p=page();let top=300;
 const anchor={dataset:{messageId:'middle'},getBoundingClientRect:()=>({top:120,bottom:180})};
 const element={dataset:{conversation:'p:1'},scrollTop:top,scrollHeight:1400,clientHeight:500,getBoundingClientRect:()=>({top:100}),querySelectorAll:()=>[anchor]};
 p.context.scrollFixture=element;const saved=vm.runInContext('chatPosition(scrollFixture)',p.context);assert.equal(saved.anchor.id,'middle');assert.equal(saved.anchor.offset,20);
 anchor.getBoundingClientRect=()=>({top:170,bottom:230});p.context.savedPosition=saved;
 vm.runInContext('restoreChatPosition(scrollFixture,savedPosition)',p.context);assert.equal(element.scrollTop,350);
});


test('conversation recipient distinguishes executor messages with reply icons and keeps scheduler selection',async()=>{
 const p=page(),task={id:'direct-task',project:'unassigned',title:'Original task',status:'done'};
 await p.answer({value:{...snapshot,tasks:[task]}});
 const data={taskId:task.id,workspace:'/temporary',generation:1,messages:[{id:'direct1',role:'user',text:'只问现状',executor:'mbp-executor',sessionId:'session1',state:'completed'},{id:'direct2',role:'assistant',text:'已经完成',executor:'mbp-executor',sessionId:'session1'}],turns:[],sessions:[],executorTargets:[{taskId:task.id,nodeId:'mbp-executor',sessionId:'session1',title:task.title}]};
 const open=p.action('task-chat',task.id);await p.answer({value:data});await open;
 assert.match(p.content(),/发给执行端 · mbp-executor/);assert.match(p.content(),/回复来自执行端 · mbp-executor/);assert.match(p.content(),/message-destination/);
 await p.action('recipient');assert.match(p.overlay(),/调度者/);assert.match(p.overlay(),/session1/);
 await p.action('recipient-select','session1');assert.match(p.content(),/向执行端原会话发消息/);
 assert.equal(vm.runInContext('recipient().sessionId',p.context),'session1');
 p.elements.set('message-input',{value:'只给执行端的消息'});
 let send=p.documentEvents.submit({preventDefault(){},target:{id:'chat-form'}});
 assert.equal(p.requests[0].method,'sendExecutorMessage');assert.equal(p.requests[0].input.sessionId,'session1');assert.equal(p.requests[0].input.taskId,task.id);
 const messageId=p.requests[0].input.commandId;
 await p.answer({error:'连接超时'});await send;
 p.elements.get('message-input').value='另一条消息';await p.documentEvents.submit({preventDefault(){},target:{id:'chat-form'}});assert.equal(p.requests.length,0,'unknown prior delivery must not send different text under the old ID');
 p.elements.get('message-input').value='只给执行端的消息';send=p.documentEvents.submit({preventDefault(){},target:{id:'chat-form'}});
 assert.equal(p.requests[0].input.commandId,messageId);await p.answer({value:{}});await p.answer({value:data});await send;

 await p.action('recipient-select','');assert.equal(vm.runInContext('recipient()',p.context),undefined);
 assert.match(p.content(),/对话对象：调度者/);
});


test('task details retain scroll through changed data and offer fullscreen plus one manual decision entry',async()=>{
 const p=page(),task={id:'manual',project:'unassigned',title:'Manual',description:'Goal',status:'error',canConfirm:true,canComplete:true,canRequestMaterials:true,canCancel:true,canRetry:true,run:'old',runState:'failed',recommendation:[],candidateChecks:[]};
 await p.answer({value:{...snapshot,tasks:[task]}});await p.action('task',task.id);
 assert.match(p.overlay(),/data-action="detail-fullscreen"/);assert.match(p.overlay(),/人工确认/);
 assert.doesNotMatch(p.overlay(),/data-action="task-cancel"|标记已处理/);
 const body={scrollTop:385};p.context.document.querySelector=selector=>selector==='#overlays .modal-body'?body:null;
 const overlay=p.elements.get('overlays');let currentHtml=overlay.innerHTML;
 Object.defineProperty(overlay,'innerHTML',{get:()=>currentHtml,set:value=>{currentHtml=value;body.scrollTop=0;}});
 vm.runInContext("state.tasks[0].report='fresh report';renderOverlay()",p.context);assert.equal(body.scrollTop,385);
 await p.action('detail-fullscreen');assert.match(p.overlay(),/task-detail expanded/);assert.equal(body.scrollTop,385);
 await p.action('task-manual',task.id);assert.match(p.overlay(),/已完成，要求补齐材料/);assert.match(p.overlay(),/已完成，不要求补齐材料/);assert.match(p.overlay(),/取消任务/);
 p.documentEvents.change({target:{name:'manual-choice',value:'complete'}});
 const pending=p.action('manual-confirm-submit');assert.equal(p.requests[0].input.action,'complete');
 await p.action('manual-confirm-submit');assert.equal(p.requests.length,1);
 await p.answer({value:{}});await p.answer({value:{...snapshot,tasks:[{...task,status:'done'}]}});await pending;
 assert.match(p.overlay(),/Manual/);
});


test('automatic fullscreen stays stable when expanding the host changes iframe width across the breakpoint',async()=>{
 const p=page(),task={id:'small',project:'unassigned',title:'Small',status:'error',run:'r',recommendation:[],candidateChecks:[]};
 await p.answer({value:{...snapshot,tasks:[task]}});p.context.innerWidth=700;await p.action('task',task.id);
 assert.match(p.overlay(),/task-detail expanded/);
 p.context.innerWidth=850;vm.runInContext('renderOverlay()',p.context);assert.match(p.overlay(),/task-detail expanded/);
 await p.action('detail-fullscreen');assert.doesNotMatch(p.overlay(),/task-detail expanded/);
 await p.action('close');await p.action('task',task.id);assert.match(p.overlay(),/Small/);
});


test('closing task submenus returns to the same detail and reading position without submitting',async()=>{
 const p=page(),task={id:'nested',project:'unassigned',title:'Nested task',status:'error',canConfirm:true,canComplete:true,canRequestMaterials:true,canCancel:true,canRetry:true,run:'r',recommendation:[],candidateChecks:[]};
 await p.answer({value:{...snapshot,tasks:[task]}});await p.action('task',task.id);
 const body={scrollTop:250};p.context.document.querySelector=selector=>selector==='#overlays .modal-body'?body:null;
 const overlay=p.elements.get('overlays');let html=overlay.innerHTML;
 Object.defineProperty(overlay,'innerHTML',{get:()=>html,set:value=>{html=value;body.scrollTop=0;}});
 await p.action('task-manual',task.id);await p.action('close');assert.match(p.overlay(),/aria-label="Nested task"/);assert.equal(body.scrollTop,250);
 await p.action('task-retry',task.id);p.documentEvents.keydown({key:'Escape'});assert.match(p.overlay(),/aria-label="Nested task"/);assert.equal(body.scrollTop,250);
 await p.action('task-manual',task.id);const backdrop={dataset:{action:'backdrop'},closest(){return this}};p.documentEvents.click({target:backdrop});assert.match(p.overlay(),/aria-label="Nested task"/);assert.equal(body.scrollTop,250);
 assert.equal(p.requests.length,0);await p.action('close');assert.equal(p.overlay(),'');
});


test('execution report renders Markdown safely and updates in place when supplemental material arrives',async()=>{
 const p=page(),task={id:'report',project:'unassigned',title:'Report task',status:'done',run:'r',recommendation:[],candidateChecks:[],report:'尚未收到执行报告',materialsStatus:'requested',manualCompletion:{materials:'pending'}};
 await p.answer({value:{...snapshot,tasks:[task]}});await p.action('task',task.id);assert.match(p.overlay(),/等待执行端回复/);
 const markdown='# Result\n\n**完成** 与 `file.md`\n\n| 文件 | 状态 |\n| --- | --- |\n| test.md | ready |\n\n- item\n  - nested\n\n> quote\n\n```sh\nprintf "<hello>"\n```\n\n[docs](https://example.com)\n\n<script>alert(1)</script>\n[bad](javascript:alert(1))\n![external](https://example.com/pixel.png)';
 const next={...task,report:markdown,reportId:'supplement',reportSource:'supplement',materialsStatus:'received',reportHistory:[{reportId:'old',title:'Original',body:'Old **report**',recordedAt:'earlier'}]};
 const pending=p.startPoll();await p.answer({value:{...snapshot,tasks:[next]}});await pending;
 const html=p.overlay();assert.doesNotMatch(html,/<\/section>}<\/div>/,'no template delimiter leaks after the report');assert.equal((html.match(/<h3>执行报告<\/h3>/g)||[]).length,1);assert.doesNotMatch(html,/<h3>补交材料/);assert.doesNotMatch(html,/尚未收到执行报告/);
 for(const tag of ['<h1>Result</h1>','<strong>完成</strong>','<table>','<blockquote>','<ul>','<pre><code class="language-sh"','<details class="report-history">'])assert.ok(html.includes(tag),tag);
 assert.match(html,/已收到执行端补交/);assert.match(html,/target="_blank" rel="noopener noreferrer"/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img|href="javascript:/);
});

test('snapshot refresh preserves main scroll through DOM replacement, read errors and recovery',async()=>{
 for(const view of ['hub','projects']){
  const p=page();await p.answer({value:snapshot});if(view==='projects')await p.action('projects');
  let scroll={scrollTop:420,scrollLeft:75},html=p.content();
  p.context.document.querySelector=selector=>selector==='#app .page, #app .hub-main'?scroll:null;
  Object.defineProperty(p.elements.get('app'),'innerHTML',{get:()=>html,set:value=>{html=value;scroll={scrollTop:0,scrollLeft:0};}});
  let pending=p.startPoll();await p.answer({value:{...snapshot,nodes:[{sampledAt:1}]}});await pending;
  assert.equal(scroll.scrollTop,420,view+' retains vertical position after polling');assert.equal(scroll.scrollLeft,75);
  pending=p.startPoll();await p.answer({error:'temporary read failure',errorCode:'gateway/disconnected'});await pending;
  assert.equal(scroll.scrollTop,420,view+' retains position while showing a read error');
  pending=p.startRetry();await p.answer({value:{...snapshot,nodes:[{sampledAt:2}]}});await pending;
  assert.equal(scroll.scrollTop,420,view+' retains position after recovery');
  await p.action(view==='hub'?'projects':'home');assert.equal(scroll.scrollTop,0,'navigation starts at the destination top');
 }
});

test('main scroll is not carried across filters or project identities',async()=>{
 const p=page();await p.answer({value:snapshot});let scroll={scrollTop:320,scrollLeft:30},html=p.content();
 p.context.document.querySelector=selector=>selector==='#app .page, #app .hub-main'?scroll:null;
 Object.defineProperty(p.elements.get('app'),'innerHTML',{get:()=>html,set:value=>{html=value;scroll={scrollTop:0,scrollLeft:0};}});
 await p.action('filter','review');assert.equal(scroll.scrollTop,0);assert.equal(scroll.scrollLeft,0);
 scroll.scrollTop=190;vm.runInContext('render()',p.context);assert.equal(scroll.scrollTop,190,'same-view redraw retains reading position');
 vm.runInContext("state.project='different-project';render()",p.context);assert.equal(scroll.scrollTop,0);
});

test('review, approval and running tasks expose cancellation without a misleading manual completion menu',async()=>{
 for(const props of [
  {status:'review',reviewStatus:'pending_user'},
  {status:'review',confirmationPending:true},
  {status:'running'},
 ]){
  const p=page(),task={id:'decision',project:'unassigned',title:'Decision',canConfirm:true,canComplete:false,canRequestMaterials:false,canCancel:true,...props};
  await p.answer({value:{...snapshot,tasks:[task]}});await p.action('task',task.id);
  assert.doesNotMatch(p.overlay(),/data-action="task-manual"/);
  assert.match(p.overlay(),/data-action="task-cancel"/);
  if(props.reviewStatus)assert.match(p.overlay(),/审核通过[\s\S]*审核不通过/);
  if(props.confirmationPending)assert.match(p.overlay(),/批准执行/);
  await p.action('task-cancel',task.id);
  assert.match(p.overlay(),/取消此任务并停止后续派发/);
  assert.doesNotMatch(p.overlay(),/已完成，/);
  await p.action('close');assert.match(p.overlay(),/aria-label="Decision"/);
  assert.equal(p.requests.length,0,'opening and closing confirmation must not submit a decision');
 }
});

test('review decisions preserve their distinct accept and reject commands',async()=>{
 for(const action of ['accept','reject']){
  const p=page(),task={id:'review',project:'unassigned',title:'Review',status:'review',reviewStatus:'pending_user',canCancel:true,actionVersion:'v1',runId:'r1',confirmationRevision:1};
  await p.answer({value:{...snapshot,tasks:[task]}});await p.action('task',task.id);await p.action('task-'+action,task.id);
  const pending=p.action('task-action-confirm');assert.equal(p.requests[0].input.action,action);assert.equal(p.requests[0].input.runId,'r1');
  await p.answer({value:{}});await p.answer({value:{...snapshot,tasks:[{...task,status:action==='accept'?'done':'error'}]}});await pending;
 }
});

test('cancelled task explains why redispatch is disabled and executor cannot cancel',async()=>{
 const p=page(),task={id:'cancelled',project:'unassigned',title:'Cancelled',status:'cancelled',nativeState:'cancelled',canRetry:false};
 await p.answer({value:{...snapshot,tasks:[task]}});await p.action('task',task.id);
 assert.match(p.overlay(),/已取消的任务不支持直接重新派发/);
 assert.match(p.overlay(),/data-action="task-retry"[^>]*disabled/);
 const readonly=page();await readonly.answer({value:{...snapshot,tasks:[{...task,status:'review',canCancel:true}],viewContext:{role:'executor',scope:'node',nodeId:'mbp'}}});
 await readonly.action('task',task.id);assert.doesNotMatch(readonly.overlay(),/data-action="task-cancel"/);
 await readonly.action('task-cancel',task.id);assert.equal(readonly.requests.length,0);assert.equal(readonly.elements.get('toast').dataset.status,'error');
});

test('retry feedback survives polling and failed submission, then reaches the action RPC',async()=>{
 const p=page(),task={id:'feedback',project:'unassigned',title:'Feedback',status:'error',reviewStatus:'rejected',canRetry:true,actionVersion:'v',runId:'r',confirmationRevision:1};
 const data={...snapshot,tasks:[task]};await p.answer({value:data});await p.action('task',task.id);await p.action('task-retry',task.id);
 assert.match(p.overlay(),/补充提示词（可选）/);
 const field={id:'retry-prompt',dataset:{},value:'补上边界测试 <example>'};p.elements.set('retry-prompt',field);p.documentEvents.input({target:field});
 const poll=p.startPoll();await p.answer({value:{...data,tasks:[{...task,report:'Updated while typing'}]}});await poll;assert.equal(vm.runInContext('state.overlay.retryPrompt',p.context),field.value);assert.equal(p.elements.get('retry-prompt').value,field.value);
 let submit=p.action('task-action-confirm');const command=p.requests[0].input.commandId;
 assert.equal(p.requests[0].input.retryPrompt,field.value);await p.answer({error:'暂时离线'});await submit;
 assert.match(p.overlay(),/补上边界测试 &lt;example&gt;/);
 submit=p.action('task-action-confirm');assert.equal(p.requests[0].input.commandId,command);await p.answer({value:{}});await p.answer({value:data});await submit;
});

test('schedule entry is separate from temporary tasks; history opens the selected Run result',async()=>{
 const p=page(),s={scheduleId:'s',taskId:'scheduled',title:'Recurring',project:'unassigned',enabled:true,revision:2,intervalMs:60000,nextDueAt:'2026-10-01T13:00:00Z',overlap:'skip',node:'mbp',model:'small',occurrences:[{runId:'one',scheduledFor:'2026-10-01T12:00:00Z',status:'admitted'},{runId:'two',scheduledFor:'2026-10-01T12:01:00Z',status:'admitted'}]};
 await p.answer({value:{...snapshot,scheduleRuntime:{enabled:true,ticking:true},tasks:[{id:'scheduled',kind:'scheduled',title:'Recurring',project:'unassigned',status:'pending_user'},{id:'temp',kind:'adhoc',title:'One off',project:'unassigned',status:'queued'}],schedules:[s],runs:[{id:'one',taskId:'scheduled',state:'succeeded',model:'small',node:'mbp'},{id:'two',taskId:'scheduled',state:'succeeded',model:'small',node:'mbp'}],reports:[{id:'r1',taskId:'scheduled',runId:'one',kind:'result',body:'First result'},{id:'r2',taskId:'scheduled',runId:'two',kind:'result',body:'Second result'}]}});
 await p.action('projects');assert.match(p.content(),/定时计划/);await p.action('temporary-tasks');assert.match(p.content(),/One off/);assert.doesNotMatch(p.content(),/Recurring/);await p.action('schedules');assert.match(p.content(),/Recurring/);await p.action('schedule-detail','s');assert.match(p.content(),/触发历史/);await p.action('schedule-run','one');assert.match(p.overlay(),/First result/);assert.doesNotMatch(p.overlay(),/Second result/);
});
test('schedule create preserves draft and command on failure; pause submits expected revision',async()=>{
 const p=page();await p.answer({value:snapshot});let pending=p.action('create-schedule');assert.equal(p.requests[0].method,'scheduleOptions');await p.answer({value:{projects:[],routes:[{id:'route',label:'MBP Luna'}]}});await pending;
 vm.runInContext("Object.assign(state.overlay.draft,{title:'Check',description:'Report',routeId:'route',minutes:'1'})",p.context);
 pending=p.action('create-schedule-confirm');const request=p.requests[0].input;assert.equal(p.requests[0].method,'createScheduledPlan');assert.equal(request.cadence.minutes,1);await p.answer({error:'Connection failed'});await pending;assert.match(p.overlay(),/Check/);assert.equal(vm.runInContext('state.overlay.commandId',p.context),request.commandId);
 vm.runInContext("state.records.schedules=[{scheduleId:'s',enabled:true,revision:7,title:'Check'}]",p.context);await p.action('schedule-control','s');pending=p.action('schedule-control-confirm');assert.equal(p.requests[0].input.expectedRevision,7);assert.equal(p.requests[0].input.enabled,false);await p.answer({error:'Changed'});await pending;
});
test('executor cannot create or control scheduled plans through project RPC',async()=>{
 const executor=service({config:{role:'executor'}}),denied=e=>e.details?.reason==='PLANNER_REQUIRED';await assert.rejects(executor.scheduleOptions(),denied);await assert.rejects(executor.createScheduledPlan({}),denied);await assert.rejects(executor.controlScheduledPlan({}),denied);
});

function expandedContentOnly(html){let depth=0;return html.split(/(<\/?details\b[^>]*>)/).filter(part=>{if(/^<details\b/.test(part)){depth++;return false}if(/^<\/details/.test(part)){depth--;return false}return depth===0}).join('');}
test('plain task details separate requirements, saved context and history; machine IDs stay collapsed and linked executions use arrow cards',async()=>{
 const p=page(),uuid='e4408886-5cf1-4b57-a5b5-7cfb15184507',t={id:'scheduled-task-long-id',title:'Check',project:'p',description:'Current task requirements',status:'review',nativeState:'ready',runId:uuid,run:uuid,runState:'succeeded',executionStartedAt:'2026-10-11T13:00:00Z',executionEndedAt:'2026-10-11T13:01:00Z',report:'Finished\n'+uuid,reportId:'report-secret-long-id',canRequestStatus:false};
 const r={id:uuid,taskId:t.id,state:'succeeded',createdAt:t.executionStartedAt,inputSnapshot:{description:'Saved execution requirements',project:{title:'Project',goal:'Deliver a useful result'},notes:[{id:'note-id',title:'User reference',body:'Useful supplied context'}]}};
 await p.answer({value:{...snapshot,projects:[{id:'p',title:'Project',goal:'Deliver',messages:[]}],tasks:[t],runs:[r],reports:[{id:t.reportId,runId:uuid,taskId:t.id,kind:'result',body:t.report}]}});await p.action('task',t.id);const html=p.overlay(),visible=expandedContentOnly(html);
 for(const title of ['执行进度','执行报告','执行历史','关联内容'])assert.ok(visible.includes(title),title);
 for(const title of ['任务要求','本次执行输入','项目上下文'])assert.ok(html.includes(title),title);
 assert.doesNotMatch(visible,/Current task requirements|Saved execution requirements|Useful supplied context/);assert.match(html,/Current task requirements/);assert.match(html,/Saved execution requirements/);assert.match(html,/Useful supplied context/);assert.doesNotMatch(visible,/子任务协作|点击“请求运行状态”|data-action="task-status"/);
 // Check rendered text, excluding identifier-bearing navigation attributes.
 const text=visible.replace(/<[^>]+>/g,'');assert.doesNotMatch(text,/e4408886|scheduled-task-long-id|report-secret-long-id/);assert.match(html,/e4408886/);assert.match(visible,/class="link-card activity-card" data-action="schedule-run"/);assert.match(visible,/class="link-arrow" aria-hidden="true"/);
 await p.action('schedule-run',uuid);assert.match(p.overlay(),/本次执行结果/);assert.match(p.overlay(),/Saved execution requirements/);assert.doesNotMatch(expandedContentOnly(p.overlay()).replace(/<[^>]+>/g,''),/e4408886/);
});
test('progress query is adjacent to current progress and disappears after completion',async()=>{
 const p=page(),t={id:'running',title:'Working',project:'unassigned',status:'running',runState:'running',canRequestStatus:true,executionStartedAt:'2026-10-11T13:00:00Z'};await p.answer({value:{...snapshot,tasks:[t]}});await p.action('task',t.id);assert.match(p.overlay(),/<h3>执行进度<\/h3>[\s\S]*?data-action="task-status"[\s\S]*?<\/section>/);assert.equal((p.overlay().match(/data-action="task-status"/g)||[]).length,1);
 const poll=p.startPoll();await p.answer({value:{...snapshot,tasks:[{...t,runState:'succeeded',status:'review',canRequestStatus:false,executionEndedAt:'2026-10-11T13:01:00Z'}]}});await poll;assert.doesNotMatch(p.overlay(),/data-action="task-status"|尚无步骤回报|点击“请求运行状态”/);
});


test('cross-page return restores task detail, filter and scroll without rolling back fresh records',async()=>{
 const p=page(),t={id:'t',project:'p',title:'Task',description:'Goal',status:'review',runId:'r',runState:'succeeded',recommendation:[],candidateChecks:[]};
 const pr={id:'p',title:'Project',goal:'Goal',workspace:'/p',session:0,messages:[]};
 await p.answer({value:{...snapshot,projects:[pr],tasks:[t],runs:[{id:'r',taskId:'t',state:'succeeded'}],schedules:[{scheduleId:'s',taskId:'t',title:'Plan',project:'p',intervalMs:60000,occurrences:[]}]}});
 let main={scrollTop:240,scrollLeft:12},body={scrollTop:0,scrollLeft:0},html=p.content(),overlay=p.overlay();
 p.context.document.querySelector=selector=>selector==='#app .page, #app .hub-main'?main:selector==='#overlays .modal-body'?body:null;
 Object.defineProperty(p.elements.get('app'),'innerHTML',{get:()=>html,set:value=>{html=value;main={scrollTop:0,scrollLeft:0};}});
 Object.defineProperty(p.elements.get('overlays'),'innerHTML',{get:()=>overlay,set:value=>{overlay=value;body={scrollTop:0,scrollLeft:0};}});
 await p.action('filter','review');main.scrollTop=240;await p.action('task','t');body.scrollTop=320;
 await p.action('schedule-detail','s');assert.equal(vm.runInContext('state.view',p.context),'schedule-detail');
 main.scrollTop=125;await p.action('schedule-run','r');assert.match(p.overlay(),/本次执行结果/);
 await p.action('nav-back');assert.equal(vm.runInContext('state.view',p.context),'schedule-detail');assert.equal(vm.runInContext('state.overlay',p.context),null);assert.equal(main.scrollTop,125);
 vm.runInContext("state.tasks[0].description='Fresh requirement'",p.context);
 await p.action('nav-back');assert.equal(vm.runInContext('state.view',p.context),'hub');assert.equal(vm.runInContext('state.filter',p.context),'review');assert.match(p.overlay(),/Fresh requirement/);assert.equal(body.scrollTop,320);assert.equal(main.scrollTop,240);
 await p.action('close');assert.equal(p.overlay(),'');assert.equal(main.scrollTop,240);assert.equal(vm.runInContext('navigationHistory.length',p.context),0);
});

test('project navigation returns to full panel with its exact tab, scope and search',async()=>{
 const p=page();await p.answer({value:{...snapshot,projects:[{id:'p',title:'Project',goal:'Goal',session:0,messages:[]}]}});
 await p.action('fullpanel');await p.action('panel-tab','tasks');vm.runInContext("state.scope='p';state.search='needle'",p.context);
 await p.action('project','p');await p.action('nav-back');
 assert.equal(vm.runInContext('state.view',p.context),'fullpanel');assert.equal(vm.runInContext('state.panelTab',p.context),'tasks');assert.equal(vm.runInContext('state.scope',p.context),'p');assert.equal(vm.runInContext('state.search',p.context),'needle');
 await p.action('nav-back');assert.equal(vm.runInContext('state.view',p.context),'hub');
});

test('back without an origin uses its declared fallback and does not replay commands',async()=>{
 const p=page();await p.answer({value:snapshot});vm.runInContext("state.view='schedules'",p.context);
 await p.action('nav-back','projects');assert.equal(vm.runInContext('state.view',p.context),'projects');assert.equal(p.requests.length,0);
});


test('project picker cancellation returns to its source without leaving a stale navigation entry',async()=>{
 const p=page();await p.answer({value:snapshot});await p.action('fullpanel');await p.action('panel-tab','reports');
 await p.action('pick-project');await p.action('scope-cancel');assert.equal(vm.runInContext('state.view',p.context),'fullpanel');assert.equal(vm.runInContext('state.panelTab',p.context),'reports');
 await p.action('pick-project');await p.action('scope-select','all');assert.equal(vm.runInContext('state.view',p.context),'fullpanel');
 await p.action('nav-back');assert.equal(vm.runInContext('state.view',p.context),'hub');
});


test('a completed review action keeps the task return route without replaying the mutation',async()=>{
 const p=page(),t={id:'t',project:'unassigned',title:'Task',status:'review',canAccept:true,runId:'r',actionVersion:'v',confirmationRevision:0};
 const data={...snapshot,tasks:[t]};await p.answer({value:data});await p.action('task','t');await p.action('task-accept','t');
 const pending=p.action('task-action-confirm');await p.answer({value:{}});await p.answer({value:data});await pending;
 assert.match(p.overlay(),/返回上一位置/);await p.action('close');assert.equal(p.overlay(),'');assert.equal(p.requests.length,0);assert.equal(vm.runInContext('navigationHistory.length',p.context),0);
});


test('requirements are collapsed and identical execution snapshots are not duplicated; results come first',async()=>{
 const p=page(),t={id:'same',project:'unassigned',title:'Daily',description:'A very long instruction',status:'error',runId:'r',runState:'uncertain',report:'执行回执：Native result rejected: SCHEMA_VALIDATION'};
 await p.answer({value:{...snapshot,tasks:[t],runs:[{id:'r',taskId:'same',state:'uncertain',settlementSummary:'Native result rejected: SCHEMA_VALIDATION',inputSnapshot:{description:t.description}}]}});await p.action('task','same');const html=p.overlay();
 assert.equal((html.match(/A very long instruction/g)||[]).length,1);assert.match(html,/与当前任务要求一致，不重复展示/);assert.ok(html.indexOf('执行报告')<html.indexOf('任务要求'));assert.doesNotMatch(expandedContentOnly(html),/A very long instruction|SCHEMA_VALIDATION/);assert.match(expandedContentOnly(html),/结果提交未通过校验/);
});
test('related execution cards combine task and run with consistent project, status, node and parent linkage',async()=>{
 const p=page(),root={id:'root',title:'Daily',project:'p',status:'error',runId:'r',runState:'uncertain'},child={id:'child',title:'PC collector',description:'Long child instructions',project:'unassigned',parentTaskId:'root',parentRunId:'r',status:'error',runId:'cr',node:'PC_AU'};
 await p.answer({value:{...snapshot,projects:[{id:'p',title:'Reports',goal:'Daily'}],tasks:[root,child],runs:[{id:'r',taskId:'root',state:'uncertain',node:'MBP'},{id:'cr',taskId:'child',parentRunId:'r',state:'uncertain',node:'PC_AU'}]}});await p.action('task','root');const html=p.overlay(),tree=html.slice(html.indexOf('<section class="panel recursive-tree">'));
 assert.equal((tree.match(/<strong>PC collector<\/strong>/g)||[]).length,1);assert.match(tree,/本次执行派发的子任务/);assert.match(tree,/Reports/);assert.match(tree,/独立任务/);assert.match(tree,/结果待核实/);assert.match(tree,/执行端：PC_AU/);assert.doesNotMatch(tree,/Long child instructions/);
});
test('diagnostic materials remain visibly unaccepted and never replace a validated run report',async()=>{
 const p=page(),t={id:'d',title:'Daily',project:'unassigned',status:'error',runId:'r',runState:'uncertain'};
 await p.answer({value:{...snapshot,tasks:[t],runs:[{id:'r',taskId:'d',state:'uncertain',diagnosticReport:{id:'diag',body:'Saved 24 summaries; child rejected'},settlementSummary:'Native result rejected: SCHEMA_VALIDATION'}]}});await p.action('task','d');assert.match(p.overlay(),/尚未作为正式结果通过校验/);assert.match(p.overlay(),/Saved 24 summaries/);await p.action('schedule-run','r');assert.match(p.overlay(),/Saved 24 summaries/);
 vm.runInContext("state.records.reports=[{id:'good',kind:'result',runId:'r',body:'Accepted report'}]",p.context);await p.action('schedule-run','r');assert.match(p.overlay(),/Accepted report/);assert.doesNotMatch(p.overlay(),/Saved 24 summaries/);
});

test('report retry settings save once with task revision and remain read-only on executors',async()=>{
 const p=page(),t={id:'retry-task',title:'Daily',project:'unassigned',description:'Instructions',status:'error',revision:7,maxResultRetries:2};
 await p.answer({value:{...snapshot,tasks:[t]}});await p.action('task',t.id);await p.action('report-retry-settings',t.id);
 assert.match(p.overlay(),/报告校验重试/);
 const get=p.context.document.querySelector;p.context.document.querySelector=s=>s==='#report-retry-count'?{value:'0'}:get(s);
 const pending=p.action('report-retry-save');assert.equal(p.requests[0].method,'setReportRetryLimit');assert.equal(p.requests[0].input.expectedRevision,7);assert.equal(p.requests[0].input.maxRetries,0);
 await p.action('report-retry-save');assert.equal(p.requests.length,1);
 await p.answer({value:{}});await p.answer({value:{...snapshot,tasks:[{...t,maxResultRetries:0,revision:8}]}});await pending;
 assert.match(p.overlay(),/自动重新派发最多 0 次/);
 const executor=service({config:{role:'executor'}});await assert.rejects(executor.setReportRetryLimit({commandId:'x',taskId:t.id,expectedRevision:7,maxRetries:2}),error=>error.details.reason==='PLANNER_REQUIRED');
});

test('needs-attention filter is visible and distinct from review',async()=>{
 const p=page();await p.answer({value:{...snapshot,tasks:[{id:'error',title:'Broken daily',project:'unassigned',status:'error'},{id:'review',title:'Review daily',project:'unassigned',status:'review'}]}});
 assert.match(p.content(),/data-id="error" data-status="error"[^>]*><span>需处理<\/span><b>1<\/b>/);
 await p.action('filter','error');assert.match(p.content(),/Broken daily/);assert.doesNotMatch(p.content(),/Review daily/);
});
test('mobile hub retains the actual outer scroll container across heartbeat, errors and back navigation',async()=>{
 const p=page();p.context.innerWidth=393;await p.answer({value:snapshot});let hub={scrollTop:430,scrollLeft:0},inner={scrollTop:0,scrollLeft:0},html=p.content();
 p.context.document.querySelector=selector=>selector==='#app .hub-layout'?hub:selector==='#app .page, #app .hub-main'?inner:null;
 Object.defineProperty(p.elements.get('app'),'innerHTML',{get:()=>html,set:value=>{html=value;hub={scrollTop:0,scrollLeft:0};inner={scrollTop:0,scrollLeft:0};}});
 let pending=p.startPoll();await p.answer({value:{...snapshot,nodes:[{observedAt:1}]}});await pending;assert.equal(hub.scrollTop,430);assert.equal(inner.scrollTop,0);
 pending=p.startPoll();await p.answer({error:'temporary failure'});await pending;assert.equal(hub.scrollTop,430);
 pending=p.startRetry();await p.answer({value:{...snapshot,nodes:[{observedAt:2}]}});await pending;assert.equal(hub.scrollTop,430);
 await p.action('projects');assert.equal(hub.scrollTop,0);await p.action('nav-back');assert.equal(hub.scrollTop,430);
});
test('history is bounded, keeps selected page through polling, and never renders array indexes as relations',async()=>{
 const p=page(),t={id:'daily',title:'Daily',project:'unassigned',status:'review',runId:'r12'},runs=Array.from({length:12},(_,i)=>({id:'r'+(i+1),taskId:t.id,state:'succeeded',node:'PC_AU',createdAt:new Date(2026,9,i+1).toISOString()}));
 const data={...snapshot,tasks:[t],runs};await p.answer({value:data});await p.action('task',t.id);
 const history=()=>p.overlay().split('<h3>执行历史</h3>')[1].split('<h3>关联内容</h3>')[0];
 assert.equal((history().match(/data-action="schedule-run"/g)||[]).length,5);assert.match(history(),/第 12 次执行/);assert.doesNotMatch(history(),/第 7 次执行|activity-relation/);
 await p.action('history-older',t.id);assert.match(history(),/第 7 次执行/);assert.doesNotMatch(history(),/第 12 次执行/);
 const pending=p.startPoll();await p.answer({value:{...data,nodes:[{observedAt:2}]}});await pending;assert.match(history(),/第 7 次执行/);
 await p.action('history-older',t.id);assert.equal((history().match(/data-action="schedule-run"/g)||[]).length,2);assert.match(history(),/data-action="history-older"[^>]*disabled/);
 await p.action('history-newer',t.id);assert.match(history(),/第 7 次执行/);
});

test('accepted partial results have their own section and filter while retaining delivery gaps',async()=>{
 const p=page(),task={id:'accepted-daily',project:'unassigned',title:'Accepted daily',status:'accepted',stateLabel:'已验收',reviewStatus:'accepted',runState:'partial',runId:'accepted-run',report:'Partial delivery; PC_AU source unavailable'};
 await p.answer({value:{...snapshot,tasks:[task],runs:[{id:'accepted-run',taskId:task.id,state:'partial',reviewStatus:'accepted'}],reports:[{id:'accepted-report',taskId:task.id,runId:'accepted-run',kind:'result',body:task.report}]}});
 assert.match(p.content(),/data-status="accepted"><span>已验收<\/span><span>1<\/span>/);
 assert.match(p.content(),/data-status="error"><span>需处理<\/span><span>0<\/span>/);
 await p.action('filter','accepted');assert.match(p.content(),/Accepted daily/);assert.doesNotMatch(p.content(),/data-status="error"><span>需处理/);
 await p.action('task',task.id);assert.match(p.overlay(),/部分交付 · 已验收/);assert.match(p.overlay(),/PC_AU source unavailable/);
 assert.doesNotMatch(p.overlay(),/>审核通过<|>审核不通过<|>标记已处理</);
 assert.equal(vm.runInContext("runResultLabel({state:'partial',reviewStatus:'rejected'})",p.context),'部分交付 · 审核未通过');
});
