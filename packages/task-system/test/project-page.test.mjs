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
 assert.match(p.content(),/临时任务规划/);assert.match(p.content(),/返回任务中心/);assert.doesNotMatch(p.content(),/整理并继续/);
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
 await p.action('project','p');assert.match(p.content(),/data-action="projects" aria-label="返回项目中心"/);
 await p.action('projects');await p.action('temporary-tasks');assert.match(p.content(),/data-action="projects" aria-label="返回项目中心"/);assert.match(p.content(),/新建临时任务/);
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
 await p.action('task',task.id);assert.match(p.overlay(),/请求运行状态/);
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
