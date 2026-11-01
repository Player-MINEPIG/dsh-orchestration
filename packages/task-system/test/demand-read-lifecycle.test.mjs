import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(kind='project') {
  const listeners = new Map(), documentListeners = new Map(), timers = new Map(), elements = new Map(), requests=[],answered=new Set();
  let serial=0;
  const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:true,dataset:{},style:{},classList:{add(){},remove(){},toggle(){},contains(){return false;}},setAttribute(){},removeAttribute(){},handlers:new Map(),addEventListener(name,listener){this.handlers.set(name,listener);},setPointerCapture(){},releasePointerCapture(){},querySelector(){return null;},querySelectorAll(){return [];},getBoundingClientRect(){return {width:100,height:100,left:0,top:0};},focus(){}});return elements.get(id);};
  const parent={postMessage:message=>requests.push(message)};
  const add=(map,name,listener)=>map.set(name,[...(map.get(name)||[]),listener]);
  const document={documentElement:element('root'),body:element('body'),visibilityState:'visible',activeElement:{tagName:'BODY'},querySelector:()=>null,querySelectorAll:()=>[],getElementById:element,addEventListener:(n,f)=>add(documentListeners,n,f)};
  const window={parent,addEventListener:(n,f)=>add(listeners,n,f),scrollTo(){},scrollY:0};
  const context=vm.createContext({atob,markdownit:()=>({renderer:{rules:{}},render:()=>''}),structuredClone,console,Date,Map,Set,URL,parent,window,document,innerWidth:1200,crypto:{randomUUID:()=>String(++serial)},MutationObserver:class{observe(){}disconnect(){}},ResizeObserver:class{observe(){}disconnect(){}},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms,interval:true});return id;},clearInterval:id=>timers.delete(id)});
  let source=readFileSync(new URL(kind==='project'?'../src/project-page.html':'../src/workflow-ui.js',import.meta.url),'utf8');
  if(kind==='project')source=source.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source,context);
  if(kind==='project')vm.runInContext('patchHtml = (root, html) => { root.innerHTML = html; };',context);
  const emit=(name,event)=>{for(const fn of listeners.get(name)||[])fn(event);};
  return {requests,timers,context,document,elements,
    active(active,generation=1,source=parent){emit('message',{source,data:{channel:'dsh-project-runtime',method:'active',input:{active,generation}}});},
    graphToggle(){for(const fn of documentListeners.get('toggle')||[])fn({target:{open:true,matches:()=>true,dataset:{detailState:'["project-graph"]'}}});},
    visibility(state){document.visibilityState=state;for(const fn of documentListeners.get('visibilitychange')||[])fn();},
    dispose(){emit('pagehide',{});},resume(){emit('pageshow',{persisted:true});},
    poll:()=>vm.runInContext('poll()',context),
    action:(action,id)=>vm.runInContext(`actions(${JSON.stringify(action)},${JSON.stringify(id)})`,context),
    async answer(request,value){answered.add(request.id);emit('message',{source:parent,data:{channel:'dsh-project-runtime',id:request.id,value}});await new Promise(resolve=>setImmediate(resolve));},
    reads(){return requests.filter(row=>row.id);},
    async drain(handler){for(let i=0;i<50;i++){const pending=requests.filter(row=>row.id&&!answered.has(row.id));if(!pending.length)return;for(const request of pending)await this.answer(request,await handler(request));}throw Error('UI read did not settle');},
    async tick(ms){const rows=[...timers].filter(([,timer])=>timer.ms===ms);for(const [id,timer] of rows){if(!timer.interval)timers.delete(id);await timer.fn();}},
  };
}
const snapshot={settings:{root:null,revision:0},nodes:[],viewContext:{role:'planner',scope:'all',nodeId:'local'},viewCapabilities:{planner:true,executor:true}};
function board(request,items=[],total=items.length){return {columns:Object.fromEntries(request.input.columns.map(({status,page})=>[status,{items:items.filter(task=>task.status===status),page,pageSize:5,total:status==='error'?total:0,pages:status==='error'?Math.ceil(total/5):0}])),counts:{baseTotal:total,byStatus:{error:total},byResponsibility:{none:total},unreadCompleted:0,matchedTotal:total,matchedByStatus:{error:total}},revision:'r1',sampledAt:'2026-11-01T00:00:00Z',viewContext:snapshot.viewContext,nodes:[]};}
async function complete(p,rows=p.reads().slice(-2),items=[],total=items.length){for(const request of rows)await p.answer(request,request.method==='readBootstrap'?snapshot:board(request,items,total));}

test('task iframe is inactive until a source-validated handshake, and CSS-hidden host stops reads',async()=>{
  const p=fixture();assert.equal(p.reads().length,0);
  assert.ok(p.requests.some(row=>row.method==='ready'));
  p.active(true,1,{});assert.equal(p.reads().length,0);
  p.active(true,1);assert.equal(p.reads().length,2);
  await complete(p);
  assert.ok([...p.timers.values()].some(row=>row.ms===3000));
  p.active(false,2);assert.equal([...p.timers.values()].filter(row=>row.ms===3000||row.ms===1000).length,0);
  await p.tick(3000);assert.equal(p.reads().length,2);
  p.active(true,1);assert.equal(p.reads().length,2);
  p.active(true,3);assert.equal(p.reads().length,4);
  p.dispose();assert.equal([...p.timers.values()].filter(row=>row.ms===3000||row.ms===1000).length,0);
});
test('task tab hide discards in-flight data and resumes immediately without an overlapping timer',async()=>{
  const p=fixture();p.active(true,1);const stale=p.reads();
  p.visibility('hidden');
  await complete(p,stale,[{id:'stale',title:'stale',status:'error'}]);
  assert.equal(vm.runInContext('state.tasks.length',p.context),0);
  p.visibility('visible');assert.equal(p.reads().length,4);
  await complete(p);
  assert.equal([...p.timers.values()].filter(row=>row.ms===3000).length,1);
  p.dispose();
});
test('workflow injected client waits for activation and ignores a response delivered after hiding',async()=>{
  const p=fixture('workflow');assert.equal(p.reads().length,0);
  p.active(true,1);const request=p.reads()[0];assert.equal(request.method,'workflowListPage');
  p.active(false,2);await p.answer(request,{items:[],page:0,pageSize:20,total:0,pages:0});
  assert.equal(p.elements.get('connection')?.textContent || '','');
  assert.equal([...p.timers.values()].filter(row=>row.ms===10000).length,0);
  p.active(true,3);assert.equal(p.reads().length,2);p.dispose();
});
test('host visibility follows CSS visibility and unmount even while the browser tab is visible',()=>{
  let ui,mutation,intersection,resize;
  const events=new Map(),element={isConnected:true,getClientRects:()=>[{}]};
  let rects=[{}],visibility='visible';element.getClientRects=()=>rects;
  vm.runInNewContext(readFileSync(new URL('../src/settings-client.js',import.meta.url),'utf8'),{
    structuredClone,document:{visibilityState:'visible',documentElement:{},addEventListener:(n,f)=>events.set(n,f),removeEventListener:n=>events.delete(n)},
    getComputedStyle:()=>({visibility}),MutationObserver:class{constructor(fn){mutation=fn;}observe(){}disconnect(){}},IntersectionObserver:class{constructor(fn){intersection=fn;}observe(){}disconnect(){}},ResizeObserver:class{constructor(fn){resize=fn;}observe(){}disconnect(){}},
    window:{__ModuleLoader__:{load(row){ui=row.factory(()=>({}));}}},
  });
  const values=[],stop=ui.watchTaskPanelVisibility(element,value=>values.push(value));
  assert.deepEqual(values,[true]);rects=[];mutation();assert.deepEqual(values,[true,false]);
  rects=[{}];intersection();assert.deepEqual(values,[true,false,true]);
  visibility='hidden';resize();assert.equal(values.at(-1),false);
  visibility='visible';mutation();element.isConnected=false;mutation();assert.equal(values.at(-1),false);
  stop();assert.equal(events.has('visibilitychange'),false);
});

test('board page is requested on the backend and global counts do not shrink to five cards',async()=>{
  const p=fixture();p.active(true,1);
  const items=Array.from({length:5},(_,i)=>({id:'first-'+i,title:'First '+i,status:'error',project:'unassigned',checkin:{responsibility:{state:'none'}}}));
  await complete(p,undefined,items,50);
  assert.match(p.elements.get('app').innerHTML,/当前组合 50 项/);
  const next=p.action('board-page',JSON.stringify({status:'error',delta:1}));
  const calls=p.reads().slice(-2),query=calls.find(row=>row.method==='taskBoard');
  assert.equal(query.input.columns.find(row=>row.status==='error').page,1);
  const second=items.map((row,i)=>({...row,id:'second-'+i,title:'Second '+i}));await complete(p,calls,second,50);await next;
  assert.match(p.elements.get('app').innerHTML,/Second 0/);assert.doesNotMatch(p.elements.get('app').innerHTML,/First 0/);
  assert.equal(p.reads().some(row=>row.method==='projectSnapshot'),false);p.dispose();
});
test('task detail outside the page and report body are read only after opening that identity',async()=>{
  const p=fixture();p.active(true,1);await complete(p);
  assert.equal(p.reads().some(row=>row.method==='taskDetail'),false);
  const opened=p.action('task','outside');const request=p.reads().at(-1);assert.equal(request.method,'taskDetail');assert.equal(request.input.taskId,'outside');
  const empty={items:[],page:0,pageSize:5,total:0,pages:0};
  await p.answer(request,{task:{id:'outside',title:'Outside page',project:'unassigned',status:'done',reportId:'report',runId:'run'},runs:empty,reports:empty,childAttention:empty});
  const run=p.reads().at(-1);assert.equal(run.method,'taskRunDetail');await p.answer(run,{run:{id:'run',taskId:'outside',state:'succeeded'},attempts:[],reports:empty,children:empty});
  const report=p.reads().at(-1);assert.equal(report.method,'taskReportDetail');assert.equal(report.input.reportId,'report');
  await p.answer(report,{id:'report',taskId:'outside',runId:'run',body:'Exact requested body',contentVersion:'content',kind:'result'});await opened;
  assert.match(p.elements.get('overlays').innerHTML,/Outside page/);p.dispose();
});

test('unchanged visible polls reuse selected report bodies and run inputs, while content-version changes fetch anew',async()=>{
  const p=fixture(),empty={items:[],total:0,pages:0,page:0,pageSize:5};let version='one';
  const task={id:'selected',title:'Selected',project:'unassigned',status:'error',runId:'run',reportId:'report',actionVersion:'action-one'};
  const serve=request=>{const report={id:'report',taskId:task.id,runId:'run',kind:'result',title:'Result',contentVersion:version};switch(request.method){
    case 'readBootstrap':return snapshot;
    case 'taskBoard':return board(request,[task],1);
    case 'taskDetail':return {task,runs:{...empty,items:[{id:'run',taskId:task.id,state:'succeeded'}],total:1,pages:1},reports:{...empty,items:[report],total:1,pages:1},childAttention:empty};
    case 'taskRunDetail':return {run:{id:'run',taskId:task.id,state:'succeeded',inputSnapshot:{description:'large immutable input'}},attempts:[],reports:{...empty,items:[report],total:1,pages:1},children:empty};
    case 'taskReportDetail':return {...report,body:'Body '+version};
    default:throw Error('Unexpected read '+request.method);
  }};
  p.active(true,1);await p.drain(serve);let pending=p.action('task',task.id);await p.drain(serve);await pending;
  assert.equal(p.reads().filter(row=>row.method==='taskReportDetail').length,1);assert.equal(p.reads().filter(row=>row.method==='taskRunDetail').length,1);
  pending=p.poll();await p.drain(serve);await pending;
  assert.equal(p.reads().filter(row=>row.method==='taskReportDetail').length,1);assert.equal(p.reads().filter(row=>row.method==='taskRunDetail').length,1);
  version='two';pending=p.poll();await p.drain(serve);await pending;
  assert.equal(p.reads().filter(row=>row.method==='taskReportDetail').length,2);assert.equal(vm.runInContext('reportBodies.size',p.context),1);
  assert.equal(vm.runInContext("state.records.reports.find(report=>report.id==='report').body",p.context),'Body two');p.dispose();
});
test('a cached browser page resumes through a fresh host handshake',async()=>{
  for(const kind of ['project','workflow']){
    const p=fixture(kind);p.active(true,1);p.dispose();const before=p.reads().length;
    p.resume();assert.equal(p.reads().length,before);assert.equal(p.requests.at(-1).method,'ready');
    p.active(true,2);assert.ok(p.reads().length>before);p.dispose();
  }
});
test('workflow drag defers a tick without permanently stopping the next refresh',async()=>{
  const p=fixture('workflow');p.active(true,1);await p.answer(p.reads()[0],{items:[],page:0,pageSize:20,total:0,pages:0});
  const graph=p.elements.get('graph-container');graph.handlers.get('pointerdown')({button:0,pointerId:1,clientX:0,clientY:0,target:{closest:()=>null},preventDefault(){}});
  await p.tick(10000);assert.equal(p.reads().length,1);assert.equal([...p.timers.values()].filter(row=>row.ms===10000).length,1);
  graph.handlers.get('pointercancel')();const tick=p.tick(10000);assert.equal(p.reads().length,2);await p.answer(p.reads()[1],{items:[],page:0,pageSize:20,total:0,pages:0});await tick;p.dispose();
});

test('real authority products drive all project graph pages and preserve the selected report version',async t=>{
  const {demandProductFixture}=await import('./fixtures/demand-products.mjs');
  const {Workbench}=await import('../dist/workbench.js');
  const f=demandProductFixture(t),workbench=new Workbench(f.ledger);
  const {WorkflowRuntime}=await import('../dist/workflows.js'),{ProgramRegistry}=await import('../dist/workflow-programs.js');new WorkflowRuntime(f.ledger,new ProgramRegistry('central'));
  workbench.manage('make-project','create_project',{projectId:'ui-project',title:'UI project',goal:'Keep every branch reachable',state:'active'});
  workbench.manage('make-backlog','create_backlog',{backlogId:'ui-backlog',projectId:'ui-project',title:'Tasks',goal:'Keep every branch reachable',state:'open',priority:'normal'});
  const root=f.task('ui-root',{policy:{maxChildren:100,maxDescendants:100}});workbench.manage('link-root','link_backlog_task',{backlogId:'ui-backlog',taskId:root.taskId});
  const children=Array.from({length:60},(_,i)=>f.task('ui-child-'+i,{parentTaskId:root.taskId}));
  const selected=children.at(-1),run=f.run(selected,'ui-run'),report=f.report(selected,run,'ui-report','result',{body:'Initial body '+'.'.repeat(256*1024)});
  const p=fixture(),serve=request=>f.read(request.method,request.input);
  p.active(true,1);await p.drain(serve);
  let pending=p.action('project','ui-project');await p.drain(serve);await pending;
  assert.equal(p.reads().some(row=>row.method==='taskGraphPage'),false,'the closed relationship disclosure does not read the graph');
  pending=p.action('graph-more','ui-project');await p.drain(serve);await pending;
  assert.equal(vm.runInContext("graphResults.get('ui-project').items.length",p.context),50);
  assert.equal(vm.runInContext("graphResults.get('ui-project').total",p.context),61);
  assert.ok(vm.runInContext("graphResults.get('ui-project').items.some(task=>task.parentTaskId)",p.context),'the authority returns child topology, not root-only pages');
  pending=p.action('graph-more','ui-project');await p.drain(serve);await pending;
  assert.equal(vm.runInContext("graphResults.get('ui-project').items.length",p.context),61);
  assert.ok(vm.runInContext("graphResults.get('ui-project').items.map(task=>task.id)",p.context).includes(selected.taskId)); 
  const graphReads=p.reads().filter(row=>row.method==='taskGraphPage').length;
  for(let i=0;i<5;i++)p.graphToggle();
  assert.equal(p.reads().filter(row=>row.method==='taskGraphPage').length,graphReads,'render-generated disclosure events do not read the cached graph again');
  vm.runInContext("disclosureStates.set(disclosureKey('project-graph','ui-project'),true)",p.context);
  pending=p.poll();await p.drain(serve);await pending;
  assert.equal(vm.runInContext("graphResults.get('ui-project').items.length",p.context),61,'visible polling preserves the loaded second topology page');

  pending=p.action('task',selected.taskId);await p.drain(serve);await pending;
  const before=p.reads().filter(row=>row.method==='taskReportDetail').length;
  pending=p.poll();await p.drain(serve);await pending;
  assert.equal(p.reads().filter(row=>row.method==='taskReportDetail').length,before,'unchanged visible polling does not redownload a 256 KiB report');
  f.db.prepare("UPDATE entities SET data=json_set(data,'$.body',?) WHERE kind='report' AND id=?").run('Revised exact body',report.reportId);
  pending=p.poll();await p.drain(serve);await pending;
  assert.equal(p.reads().filter(row=>row.method==='taskReportDetail').length,before+1);
  assert.equal(vm.runInContext("state.records.reports.find(report=>report.id==='ui-report').body",p.context),'Revised exact body');
  assert.equal(p.reads().some(row=>row.method==='projectSnapshot'||row.method==='workflowView'),false);p.dispose();
});

test('hiding an in-flight HTML preview releases loading so the restored panel can retry the same version',async()=>{
 const p=fixture(),empty={items:[],total:0,pages:0,page:0,pageSize:5},task={id:'html-task',title:'HTML',project:'unassigned',status:'error',runId:'html-run',reportId:'html-report',actionVersion:'v1'},report={id:'html-report',taskId:'html-task',runId:'html-run',title:'HTML',kind:'result',contentVersion:'same-version',hasHtmlPresentation:true};
 const serve=request=>{switch(request.method){case 'readBootstrap':return snapshot;case 'taskBoard':return board(request,[task],1);case 'taskDetail':return {task,runs:{...empty,items:[{id:'html-run',taskId:task.id}],total:1,pages:1},reports:{...empty,items:[report],total:1,pages:1},childAttention:empty};case 'taskRunDetail':return {run:{id:'html-run',taskId:task.id,state:'succeeded'},attempts:[],reports:{...empty,items:[report],total:1,pages:1},children:empty};case 'taskReportDetail':return {...report,body:'Alternative text'};default:throw Error('Unexpected read '+request.method);}};
 p.active(true,1);await p.drain(serve);let pending=p.action('task',task.id);await p.drain(serve);await pending;
 pending=p.action('report-preview',report.id);const old=p.reads().at(-1);assert.equal(old.method,'getProjectReportPresentation');p.active(false,2);
 const value={reportId:report.id,taskId:task.id,runId:'html-run',contentVersion:report.contentVersion,presentation:{mediaType:'text/html',body:'<p>Exact HTML</p>'}};
 await p.answer(old,value);await pending;p.active(true,3);await p.drain(serve);
 assert.doesNotMatch(p.elements.get('overlays').innerHTML,/正在加载报告…/);
 pending=p.action('report-preview',report.id);const retry=p.reads().at(-1);assert.equal(retry.method,'getProjectReportPresentation');assert.notEqual(retry.id,old.id);await p.answer(retry,value);await pending;
 assert.match(p.elements.get('overlays').innerHTML,/Exact HTML/);p.dispose();
});

test('a session query changed during a poll schedules the new query and ignores stale completion',async()=>{
 let ui;vm.runInNewContext(readFileSync(new URL('../src/settings-client.js',import.meta.url),'utf8'),{structuredClone,window:{__ModuleLoader__:{load(row){ui=row.factory(()=>({}));}}}});
 const requests=[],scheduled=[],monitor=new ui.SessionTaskMonitor((method,input)=>new Promise(resolve=>requests.push({method,input,resolve})),'s');monitor.active=true;monitor.onSettled=delay=>scheduled.push(delay);
 const first=monitor.load();monitor.setQuery({status:'error'});assert.equal(requests.length,2);assert.equal(requests[1].input.status,'error');
 requests[1].resolve({sessionId:'s',items:[],counts:{all:9,error:2},page:0,pages:0,total:0});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(scheduled,[5000]);
 requests[0].resolve({sessionId:'s',items:[{id:'stale'}],counts:{all:1}});await first;
 assert.equal(monitor.state.value.counts.all,9);assert.equal(monitor.state.value.tasks.length,0);assert.deepEqual(scheduled,[5000]);monitor.dispose();
});

test('session details stop follow-up reads when hidden between owner detail and run metadata',async()=>{
 let ui;vm.runInNewContext(readFileSync(new URL('../src/settings-client.js',import.meta.url),'utf8'),{structuredClone,window:{__ModuleLoader__:{load(row){ui=row.factory(()=>({}));}}}});
 const requests=[],monitor=new ui.SessionTaskMonitor((method,input)=>new Promise(resolve=>requests.push({method,input,resolve})),'s');monitor.active=true;monitor.state.value={tasks:[{id:'task',owner:'task',direct:true,detailVersion:'one'}]};
 monitor.toggleTask('task',true);assert.equal(requests[0].method,'sessionTaskDetail');monitor.active=false;monitor.suspend();requests[0].resolve({task:{id:'task'},runs:{items:[]}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.length,1,'hidden panels must not start the follow-up executionPage read');monitor.dispose();
});

test('executor claims use the bounded product envelope and later pages remain reachable',async()=>{
 const p=fixture();vm.runInContext("state.taskView='executor'",p.context);
 const context={...snapshot.viewContext,role:'executor',scope:'local'};
 const claims=page=>({items:[{runId:'claim-'+page,state:'pending'}],page,pageSize:20,total:21,pages:2,revision:'claims',sampledAt:'2026-11-01T00:00:00Z'});
 const respond=request=>request.method==='readBootstrap'?{...snapshot,viewContext:context,executorClaims:claims(0)}:request.method==='executorClaimsPage'?claims(request.input.page):{...board(request),viewContext:context};
 p.active(true);await p.drain(respond);
 assert.match(p.elements.get('app').innerHTML,/claim-0/);assert.match(p.elements.get('app').innerHTML,/executor-claims-page/);
 const next=p.action('executor-claims-page',JSON.stringify({delta:1}));await p.drain(respond);await next;
 assert.match(p.elements.get('app').innerHTML,/claim-1/);assert.doesNotMatch(p.elements.get('app').innerHTML,/claim-0/);
 assert.equal(p.reads().find(request=>request.method==='executorClaimsPage').input.page,1);p.dispose();
});
