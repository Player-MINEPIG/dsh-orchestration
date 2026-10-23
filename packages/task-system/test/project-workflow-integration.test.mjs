import {registerExecutor} from '../../../tests/dsh/executor-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
import {Workbench} from '../dist/workbench.js';

function page(){
 const script=readFileSync(new URL('../dist/project-page.html',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 const elements=new Map(),requests=[],events={},documentEvents={};let seq=0;
 const parent={postMessage:r=>{if(r.method!=='detailFullscreen')requests.push(r);}};
 const context=vm.createContext({atob,structuredClone,console,Date,Map,Set,URL,innerWidth:1200,crypto:{randomUUID:()=>String(++seq)},parent,window:{addEventListener:(name,fn)=>events[name]=fn},document:{documentElement:{dataset:{}},activeElement:{tagName:'BODY'},querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(name,fn)=>documentEvents[name]=fn,getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',dataset:{}});return elements.get(id);}},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1});
 vm.runInContext(script,context);
 return {context,requests,html:()=>elements.get('app').innerHTML,overlay:()=>elements.get('overlays').innerHTML,action:(name,id)=>vm.runInContext(`actions(${JSON.stringify(name)},${JSON.stringify(id)})`,context),async answer(value){const req=requests.shift();assert.ok(req);events.message({source:parent,data:{channel:'dsh-project-runtime',id:req.id,value}});await new Promise(resolve=>setImmediate(resolve));},set(code){return vm.runInContext(code,context);}};
}
const flow={workflowId:'report',projectId:'p',revision:2,title:'日报流程',description:'Test',stages:[{stageId:'first',title:'准备',nodeId:'VPS',position:{x:0,y:0}},{stageId:'collect',title:'采集',nodeId:'MBP',position:{x:300,y:0}},{stageId:'last',title:'汇总',nodeId:'VPS',position:{x:600,y:0}}],steps:[{stepId:'a',stageId:'first',title:'开始',nodeId:'VPS',dependsOn:[]},{stepId:'b',stageId:'collect',title:'读取',nodeId:'MBP',dependsOn:['a']},{stepId:'c',stageId:'last',title:'汇总',nodeId:'VPS',dependsOn:['b']}],calls:[{fromStepId:'a',toStepId:'b'},{fromStepId:'b',toStepId:'c'}]};
const project={id:'p',title:'日报项目',goal:'Daily report',description:'Daily report',stage:'Active',workspace:'/p',session:1,canChat:true,messages:[]};
const base={projects:[project],tasks:[],runs:[],reports:[],nodes:[{nodeId:'VPS',state:'stale'},{nodeId:'MBP',state:'online'}],settings:{root:'/projects',revision:1},workflowDefinitions:[flow],workflowRuns:[]};

test('project primary graph uses distinct execution stages and explicitly separates old relationship semantics',async()=>{
 const p=page();await p.answer(base);await p.action('project','p');
 assert.match(p.html(),/执行调用图/);assert.match(p.html(),/任务与产物关系（非执行顺序）/);assert.match(p.html(),/不表示调用顺序/);
 assert.equal((p.html().match(/执行设备：VPS/g)||[]).length,2);
 assert.match(p.html(),/适应窗口/);assert.match(p.html(),/全屏/);assert.match(p.html(),/project-flow-viewport/);
 await p.action('flow-fullscreen');assert.match(p.html(),/project-execution is-fullscreen/);await p.action('flow-fullscreen');assert.doesNotMatch(p.html(),/project-execution is-fullscreen/);
 const opening=p.action('workflow-stage',JSON.stringify({workflowId:'report',stageId:'last'}));assert.equal(p.requests[0].method,'openWorkflow');assert.equal(p.requests[0].input.stageId,'last');assert.equal(p.requests[0].input.projectId,'p');await p.answer({});await opening;
});

test('selected historical workflow Run stays successful while current executor is offline and reports come from that Run',async()=>{
 const p=page(),task={id:'task',project:'p',title:'日报任务',description:'Daily',status:'done',runId:'root',runState:'succeeded',workflowBinding:{workflowId:'report'},recommendation:[]};
 const run={id:'root',taskId:'task',state:'succeeded',createdAt:'2026-10-17T00:00:00Z'};
 const execution={workflowRunId:'invocation',runId:'root',taskId:'task',projectId:'p',workflowId:'report',state:'succeeded',definitionRevision:1,definition:{...flow,revision:1,title:'历史流程版本'},steps:flow.steps.map(step=>({stepId:step.stepId,title:step.title,nodeId:step.nodeId,state:'succeeded',reportId:step.stepId+'-report',runId:step.stepId+'-run'}))};
 await p.answer({...base,tasks:[task],runs:[run],workflowRuns:[execution],reports:[{id:'a-report',runId:'a-run',taskId:'a-task',kind:'result',body:'原步骤报告'}]});await p.action('schedule-run','root');
 assert.match(p.overlay(),/历史流程版本/);assert.match(p.overlay(),/已完成/);assert.match(p.overlay(),/离线或未知/);assert.match(p.overlay(),/原步骤报告/);assert.doesNotMatch(p.overlay(),/阶段需处理|阶段执行中/);
});

test('workflow task creation does not require an Agent route and manual trigger never starts execution',async()=>{
 const p=page();await p.answer(base);await p.action('project','p');let pending=p.action('project-create-task','p');await p.answer({projects:[{id:'p',title:'日报项目'}],routes:[],workflows:[{id:'report',projectId:'p',title:'日报流程'}]});await pending;
 p.set("Object.assign(state.overlay.draft,{title:'Run report',description:'Produce report',executionKind:'workflow',workflowId:'report',workflowInput:'{\\\"day\\\":1}',mode:'manual'});renderOverlay();");
 assert.match(p.overlay(),/固定工作流/);assert.match(p.overlay(),/手动运行/);assert.doesNotMatch(p.overlay(),/data-plan="nodeId"/);
 pending=p.action('create-schedule-confirm');assert.equal(p.requests[0].method,'configureWorkflowTask');assert.equal(p.requests[0].input.workflowId,'report');assert.equal(p.requests[0].input.input.day,1);await p.answer({taskId:'new'});await p.answer({...base,tasks:[{id:'new',project:'p',title:'Run report',description:'Produce report',status:'queued',workflowBinding:{workflowId:'report'},recommendation:[]}]});await pending;
 assert.equal(p.requests.length,0);assert.match(p.overlay(),/运行任务/);
});

test('ordinary project Task creation links project before creating a queued execution and retries do not duplicate Tasks',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  const wb=new Workbench(h.ledger),runtime=h.ctx.taskSystem.projects;
  wb.manage('p','create_project',{projectId:'p',title:'Direct tasks',goal:'Test'});
  h.ledger.registerWorkspace('ws',{workspaceId:'ws',nodeId:'worker',path:h.dir,label:'Worker',state:'ready',createdAt:new Date().toISOString()});
  registerExecutor(h.ledger, 'node',{nodeId:'worker',enabled:true,roles:['executor'],models:[{provider:'test',model:'small',reasoningEfforts:['low']}],capabilities:[],workspaceIds:['ws'],lastSeenAt:new Date().toISOString()});
  h.ledger.recordNodeHeartbeat('heartbeat',{nodeId:'worker',runtimeReady:true,activeExecutions:0,source:'host-local',sampledAt:Date.now(),providerStatus:{executionRoutes:[{nodeId:'worker',provider:'test',model:'small',reasoningEffort:'low',requiredCapabilities:[]}]}});
  const routeId=runtime.scheduleOptions().routes[0].id,input={commandId:'new-task',projectId:'p',title:'Simple task',description:'Return result',routeId,start:false};
  const created=runtime.createDirectTask(input);assert.deepEqual(runtime.createDirectTask(input),created);assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(h.ledger.snapshot().runs.length,0);
  assert.throws(()=>runtime.createDirectTask({...input,start:true}),/Idempotency key reused/);assert.equal(h.ledger.snapshot().tasks.length,1);
  const run=runtime.runDirectTask({commandId:'start-one',taskId:created.taskId});assert.equal(run.projectContext.project.projectId,'p');assert.equal(run.route.nodeId,'worker');assert.deepEqual(runtime.runDirectTask({commandId:'start-one',taskId:created.taskId}),run);assert.equal(h.adapter.requests.length,0);
 }finally{await h.dispose();}
});

test('adopted legacy workflow evidence is reachable from its continuing Task without fabricating a root Run',async()=>{
 const p=page(),task={id:'continuing',project:'p',title:'日报任务',description:'Daily',status:'queued',runId:null,workflowBinding:{workflowId:'report'},recommendation:[]};
 const legacy={workflowRunId:'legacy',workflowId:'report',taskId:'continuing',projectId:'p',createdAt:'2026-10-16T00:00:00Z',state:'succeeded',definition:flow,definitionRevision:1,steps:[]};
 await p.answer({...base,tasks:[task],workflowRuns:[legacy]});await p.action('task','continuing');assert.match(p.overlay(),/迁移前流程记录/);assert.match(p.overlay(),/尚未创建流程根 Run/);assert.match(p.overlay(),/legacy/);
});

test('workflow admission attention is visible on the Task while its root remains active for schedule overlap',async()=>{
 const h=await createNativeHarness({config:{role:'both',nodeId:'local'}});
 try{
  new Workbench(h.ledger).manage('attention-project','create_project',{projectId:'p',title:'Flow',goal:'Test'});
  h.ledger.registerWorkspace('attention-ws',{workspaceId:'ws',nodeId:'local',path:h.dir,label:'Local',state:'ready',createdAt:new Date().toISOString()});
  registerExecutor(h.ledger, 'attention-node',{nodeId:'local',roles:['both'],enabled:true,capabilities:[],models:[],workspaceIds:['ws'],lastSeenAt:new Date().toISOString()});
  h.ctx.taskSystem.programs.register({programId:'work',version:'1',title:'Work',execute:()=>({data:{},summary:'Done'})});
  h.ledger.recordNodeHeartbeat('attention-heartbeat',{nodeId:'local',runtimeReady:true,activeExecutions:0,providerStatus:{programs:h.ctx.taskSystem.programs.catalog()}});
  const runtime=h.ctx.taskSystem.workflows;
  runtime.save({commandId:'attention-flow',expectedRevision:0,definition:{workflowId:'flow',projectId:'p',revision:0,title:'Flow',description:'Test',steps:[{stepId:'a',title:'Step',nodeId:'local',workspaceId:'ws',dependsOn:[],inputs:{},execution:{kind:'program',programId:'work',version:'1'},maxRetries:0}]}});
  const binding=runtime.configureTask({commandId:'attention-task',projectId:'p',workflowId:'flow',input:{}}),run=runtime.start({commandId:'attention-run',taskId:binding.taskId});
  const persisted={...run,state:'needs_attention',steps:run.steps.map(s=>({...s,state:'blocked',reason:'Source needs attention'}))};h.ledger.managementDatabase().prepare('UPDATE workflow_runs SET data=? WHERE id=?').run(JSON.stringify(persisted),run.workflowRunId);
  assert.equal(h.ledger.getRun(run.runId).state,'running');assert.equal(h.ctx.taskSystem.projects.snapshot().tasks.find(t=>t.id===binding.taskId).status,'error');
 }finally{await h.dispose();}
});
