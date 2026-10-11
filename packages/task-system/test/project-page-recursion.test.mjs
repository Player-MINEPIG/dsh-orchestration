import {webcrypto} from 'node:crypto';
import markdownit from 'markdown-it';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function page({insecureContext=false}={}) {
  const html=readFileSync(new URL('../src/project-page.html',import.meta.url),'utf8');
  const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements=new Map(),requests=[],events={},documentEvents={},root={dataset:{}}; let sequence=0;
  const parent={postMessage:request=>{if(request.method!=="detailFullscreen")requests.push(request);}};
  const context=vm.createContext({markdownit,atob,structuredClone,console,Date,Map,Set,URL,innerWidth:1200,crypto:insecureContext?{getRandomValues:value=>webcrypto.getRandomValues(value)}:{randomUUID:()=>String(++sequence)},parent,window:{addEventListener:(name,listener)=>events[name]=listener},document:{documentElement:root,title:'',activeElement:{tagName:'BODY'},querySelector:()=>null,addEventListener:(name,listener)=>documentEvents[name]=listener,getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',hidden:true,dataset:{}});return elements.get(id);}},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1});
  vm.runInContext(source,context);
  return {requests,context,elements,documentEvents,action:(a,id)=>vm.runInContext('actions('+JSON.stringify(a)+','+JSON.stringify(id)+')',context),overlay:()=>elements.get('overlays').innerHTML,theme:(source,input)=>events.message({source:source==='parent'?parent:{},data:{channel:'dsh-project-runtime',method:'theme',input}}),root,content:()=>elements.get('app').innerHTML,async answer(response){const request=requests.shift();assert.ok(request);events.message({source:parent,data:{channel:'dsh-project-runtime',id:request.id,...response}});await new Promise(resolve=>setImmediate(resolve));},async retry(){await vm.runInContext("actions('reload')",context);},startRetry(){return vm.runInContext("actions('reload')",context);},startPoll(){return vm.runInContext('poll()',context);}};
}

const project={id:'p',title:'Source project',description:'Project scope',goal:'Deliver',session:0,messages:[],canChat:false};
const row=(id,extra={})=>({id,project:'p',title:id,description:'Task',status:'review',run:'r-'+id,runId:'r-'+id,runState:'succeeded',nativeState:'waiting',report:'Result',recommendation:[],candidateChecks:[],...extra});
const snapshot={projects:[project],tasks:[row('parent'),row('child',{parentTaskId:'parent',parentRunId:'r-parent',delegationDisplay:'task'}),row('tiny',{parentTaskId:'parent',parentRunId:'r-parent',delegationDisplay:{mode:'step',reason:'small-execution'}}),row('old',{parentTaskId:'parent'})],settings:{root:null,revision:0},runs:[{id:'r-parent',taskId:'parent',state:'succeeded',outcome:'partial'},{id:'r-child',taskId:'child',parentRunId:'r-parent',state:'succeeded',model:'gpt-6-luna',reasoningEffort:'low',executionDriver:'codex',actualModel:'gpt-6-luna',actualReasoningEffort:'low',productThreadId:'verified-product-thread',sessionIds:['official-thread']},{id:'r-tiny',taskId:'tiny',parentRunId:'r-parent',state:'succeeded'},{id:'r-old',taskId:'old',state:'succeeded'}],attempts:[{attemptId:'attempt-child',runId:'r-child',nodeId:'mbp',fence:3,state:'settled',sessionId:'official-thread',executionId:'execution-child'}],nodes:[],projectRegistrations:[]};
test('existing plugin panel folds internal steps and preserves exact parent Run, Attempt and official session evidence',async()=>{
 const p=page();await p.answer({value:structuredClone(snapshot)});
 assert.doesNotMatch(p.content(),/data-id="tiny"/);assert.match(p.content(),/data-id="child"/);
 await p.action('task','parent');const html=p.overlay();
 assert.match(html,/内部小步骤（1）/);assert.match(html,/data-recursive-task="tiny"/);assert.match(html,/父 Run r-parent/);assert.match(html,/Attempt attempt-child/);assert.match(html,/official-thread/);assert.match(html,/计划模型 gpt-6-luna low/);assert.match(html,/运行时已确认：gpt-6-luna · low/);assert.match(html,/产品线程：verified-product-thread/);assert.match(html,/部分交付 · 待验收/);assert.match(html,/组织关联 · 未记录父 Run（1）/);
 assert.doesNotMatch(html,/<details class="recursive-steps" open/);
});
test('retried child runs appear only under their exact parent run and cycles terminate',async()=>{
 const p=page(),data=structuredClone(snapshot);data.runs.push({id:'r-parent-two',taskId:'parent',state:'running'},{id:'r-child-two',taskId:'child',parentRunId:'r-parent-two',state:'running'});
 await p.answer({value:data});await p.action('task','parent');const html=p.overlay();
 assert.equal(html.split('data-run-id="r-child"').length,2);assert.equal(html.split('data-run-id="r-child-two"').length,2);
 assert.ok(html.indexOf('data-run-id="r-child"')<html.indexOf('data-run-id="r-parent-two"'));
 vm.runInContext("state.records.runs.push({id:'cycle',taskId:'parent',parentRunId:'r-child',state:'running'})",p.context);await p.action('task','parent');assert.match(p.overlay(),/循环引用/);
});
test('executor sees central scoped progress in original panel and never offers local management actions',async()=>{
 const p=page();await p.answer({value:{...structuredClone(snapshot),viewContext:{role:'executor',scope:'node',nodeId:'mbp',observedAt:'2026-10-12T00:00:00Z',coordinatorUrl:'http://100.123.230.75:4000/#tasks'}}});
 assert.match(p.content(),/本机协作进度/);assert.match(p.content(),/mbp 相关任务与递归派发 · 只读/);assert.match(p.content(),/http:\/\/100.123.230.75:4000\/#tasks/);
 await p.action('task','parent');assert.doesNotMatch(p.overlay(),/data-action="task-(retry|chat|accept|manual)"/);
 await p.action('task-retry','parent');assert.equal(p.requests.length,0);
 const pending=p.startPoll();await p.answer({error:'中央连接中断',errorCode:'gateway/disconnected'});await pending;assert.match(p.content(),/保留上次/);assert.match(p.content(),/中央连接中断/);
});
test('source task observations do not become execution claims or central acceptance',async()=>{
 const p=page(),data=structuredClone(snapshot);data.tasks[0].observationOnly=true;data.runs[0].observationOnly=true;data.projectRegistrations=[{projectId:'p',namespace:'import',mode:'history',sourceRevision:2,origin:{harness:'DSH'},unknownOriginalTimes:true,central:{review:'unreviewed',note:'Review outstanding'},sourceAcceptance:[{title:'PV',acceptance:'accepted'}],artifactAvailability:[{uri:'file:///media.mp4',availability:'reference-only'}]}];
 await p.answer({value:data});await p.action('task','parent');assert.match(p.overlay(),/来源声明：已验收/);assert.match(p.overlay(),/中央复核：尚未复核/);assert.match(p.overlay(),/来源执行（仅观察）/);assert.match(p.overlay(),/来源声明：执行成功/);assert.match(p.overlay(),/原始项目时间 未知/);assert.doesNotMatch(p.overlay(),/data-action="task-retry"/);
 await p.action('project','p');assert.doesNotMatch(p.content(),/data-action="chat"/);assert.match(p.content(),/来源与中央复核/);
});
test('runtime references and peer URLs cannot inject markup or credentials into a panel link',async()=>{
 const p=page(),data=structuredClone(snapshot);data.runs[1].runtimeVersion='<img src=x>';data.viewContext={role:'executor',nodeId:'<node>',coordinatorUrl:'http://user:secret@100.123.230.75:4000'};
 await p.answer({value:data});assert.doesNotMatch(p.content(),/href="http/);assert.match(p.content(),/&lt;node&gt;/);await p.action('task','parent');assert.match(p.overlay(),/&lt;img src=x&gt;/);assert.doesNotMatch(p.overlay(),/<img src=x>/);
});

test('Tailscale HTTP without randomUUID loads and preserves cryptographic command IDs on uncertain retry',async()=>{
 const p=page({insecureContext:true}),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
 assert.match(p.requests[0].id,uuid);await p.answer({value:structuredClone(snapshot)});assert.match(p.content(),/掌握正在推进的工作/);
 await p.action('task-retry','parent');let pending=p.action('task-action-confirm');const commandId=p.requests[0].input.commandId,requestId=p.requests[0].id;
 assert.match(commandId,uuid);assert.match(requestId,uuid);assert.notEqual(commandId,requestId);
 await p.answer({error:'连接中断',errorCode:'gateway/disconnected'});await pending;
 pending=p.action('task-action-confirm');assert.equal(p.requests[0].input.commandId,commandId);assert.match(p.requests[0].id,uuid);assert.notEqual(p.requests[0].id,requestId);
 await p.answer({error:'仍未连通',errorCode:'gateway/disconnected'});await pending;
});

test('source aggregation task without a run never presents a pending executor selection',async()=>{
 const p=page(),data=structuredClone(snapshot);data.tasks=[row('source-stage',{observationOnly:true,node:'待选择执行端',run:'待创建',runId:null})];data.runs=[];data.attempts=[];
 await p.answer({value:data});assert.match(p.content(),/来源执行（仅观察） · 来源未记录执行端/);assert.doesNotMatch(p.content(),/待选择执行端/);
 await p.action('project','p');assert.doesNotMatch(p.content(),/待选择执行端|执行记录待创建|等待执行结果|结果返回后关联到任务/);assert.match(p.content(),/来源未记录执行/);assert.match(p.content(),/来源未记录产物/);assert.doesNotMatch(p.content(),/graph-state">等待开始/);assert.match(p.content(),/data-kind="执行" data-status="observed"/);assert.match(p.content(),/data-kind="产物" data-status="observed"/);
});

test('executor progress help points to central refresh instead of a missing write action',async()=>{
 const p=page(),data=structuredClone(snapshot);data.viewContext={role:'executor',nodeId:'mbp'};data.tasks[0].executionStartedAt='2026-10-11T00:00:00Z';
 await p.answer({value:data});await p.action('task','parent');assert.match(p.overlay(),/使用“刷新进度”读取最新记录/);assert.doesNotMatch(p.overlay(),/点击“请求运行状态”/);
});
test('disclosures preserve exact run/type and viewed task across refresh and fullscreen, including explicit close',async()=>{
 const p=page();await p.answer({value:structuredClone(snapshot)});await p.action('task','parent');
 const toggle=(kind,id,open)=>{const key=vm.runInContext(`disclosureKey(${JSON.stringify(kind)},${JSON.stringify(id)})`,p.context);p.documentEvents.toggle({target:{matches:()=>true,dataset:{detailState:key},open}});};
 toggle('proof','r-parent',true);toggle('proof','r-child',true);toggle('steps','r-parent',true);
 await p.action('detail-fullscreen');let html=p.overlay();assert.equal((html.match(/class="execution-proof"[^>]* open>/g)||[]).length,2);assert.match(html,/class="recursive-steps"[^>]* open>/);
 const pending=p.startPoll();await p.answer({value:structuredClone(snapshot)});await pending;html=p.overlay();assert.equal((html.match(/class="execution-proof"[^>]* open>/g)||[]).length,2);assert.match(html,/class="recursive-steps"[^>]* open>/);
 await p.action('task','child');assert.doesNotMatch(p.overlay(),/class="execution-proof"[^>]* open>/);
 await p.action('task','parent');assert.equal((p.overlay().match(/class="execution-proof"[^>]* open>/g)||[]).length,2);
 toggle('proof','r-child',false);await p.action('detail-fullscreen');assert.equal((p.overlay().match(/class="execution-proof"[^>]* open>/g)||[]).length,1);assert.match(p.overlay(),/class="recursive-steps"[^>]* open>/);
 // Capture protects a user toggle even if its asynchronous toggle event has not fired yet.
 const key=vm.runInContext("disclosureKey('steps','r-parent')",p.context);vm.runInContext('rememberDisclosures',p.context)({querySelectorAll:()=>[{dataset:{detailState:key},open:false}]});await p.action('detail-fullscreen');assert.doesNotMatch(p.overlay(),/class="recursive-steps"[^>]* open>/);
});
