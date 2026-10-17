import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {createNativeHarness} from '../dsh/native-harness.mjs';
import {Workbench} from '../../packages/task-system/dist/workbench.js';
import {ProgramRegistry} from '../../packages/task-system/dist/workflow-programs.js';
import {ExecutorWorker} from '../../packages/task-system/dist/remote/worker.js';
import {RecoveryStore} from '../../packages/task-system/dist/remote/store.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const root=resolve(new URL('../..',import.meta.url).pathname),evidence=process.env.DSH_UI_EVIDENCE||'/tmp/dsh-followup-ui-evidence';mkdirSync(evidence,{recursive:true});
const h=await createNativeHarness({config:{role:'planner',nodeId:'authority'}}),ledger=h.ledger,workflows=h.ctx.taskSystem.workflows,projects=h.ctx.taskSystem.projects;
const stores=[],workers=[],trace=[];let browser,server,sequence=0,activeResult='';
const next=()=>`ui-${++sequence}`;
try{
 new Workbench(ledger).manage(next(),'create_project',{projectId:'p',title:'真实流程编辑验收',goal:'Persist graph edits and read exact Run reports'});
 const registries=new Map();
 for(const nodeId of ['VPS','MBP']){
  const registry=new ProgramRegistry(nodeId);registries.set(nodeId,registry);
  registry.register({programId:'work',version:'1',title:'Work',inputSchema:{type:'object'},outputSchema:{type:'object'},execute:({input})=>{trace.push(input.name);return {summary:input.name==='c'?activeResult:`STEP_${input.name}_RESULT`,data:{name:input.name}}}});
  ledger.registerNode(next(),{nodeId,enabled:true,roles:['executor'],capabilities:[],workspaceIds:[nodeId+'-ws'],models:[],lastSeenAt:new Date().toISOString(),maxConcurrent:4});
  ledger.registerWorkspace(next(),{workspaceId:nodeId+'-ws',nodeId,path:h.dir,label:nodeId,state:'ready',createdAt:new Date().toISOString()});
  ledger.recordNodeHeartbeat(next(),{nodeId,runtimeReady:true,activeExecutions:0,source:'host-local',sampledAt:Date.now(),providerStatus:{programs:registry.catalog()}});
  const store=new RecoveryStore(join(h.dir,nodeId+'-executions.sqlite'));stores.push(store);const worker=new ExecutorWorker({ledger,store,provider:registry.provider(),policy:{role:'both',nodeId,capabilities:[],workspaces:[{nodeId,workspaceId:nodeId+'-ws',path:h.dir,allowedRoot:h.dir}]}});workers.push(worker);
 }
 const stages=[['a','VPS','MBP 来源采集与当前工作会话完整历史核对阶段'],['b','MBP','PC_AU 官方来源采集与日志完整性检查阶段'],['c','VPS','合并、归纳与完整最终报告渲染阶段']].map(([stageId,nodeId,title],i)=>({stageId,nodeId,title,position:{x:i*400,y:40}}));
 const initial=workflows.save({commandId:next(),expectedRevision:0,definition:{workflowId:'flow',projectId:'p',revision:0,title:'项目图真实交互验收',description:'Test',stages,calls:[{fromStepId:'a',toStepId:'c'}],resultStepIds:['c'],steps:stages.map(stage=>({stepId:stage.stageId,stageId:stage.stageId,nodeId:stage.nodeId,title:'具体步骤 '+stage.stageId,position:{x:0,y:0},workspaceId:stage.nodeId+'-ws',dependsOn:[],inputs:{name:{kind:'literal',value:stage.stageId},...(stage.stageId==='c'?{source:{kind:'step-output',stepId:'a',path:[]}}:{})},execution:{kind:'program',programId:'work',version:'1'},maxRetries:0}))}});
 const binding=workflows.configureTask({commandId:next(),projectId:'p',workflowId:'flow',title:'日报任务',input:{}});
 async function complete(run,body){activeResult=body;for(let i=0;i<10;i++){workflows.tick();for(const worker of workers)await worker.pollOnce();workflows.tick();if(ledger.getRun(run.runId).state==='succeeded')break;}assert.equal(ledger.getRun(run.runId).state,'succeeded');const flow=workflows.snapshot().runs.find(flow=>flow.runId===run.runId),report=projects.snapshot().reports.find(report=>report.runId===run.runId&&report.kind==='result');assert.equal(report.body,body,'runtime publishes exact selected output as root result');assert.equal(report.workflowOutputs[0].stepId,'c');return flow;}
 const old=workflows.start({commandId:next(),taskId:binding.taskId});await complete(old,'OLD_ROOT_REPORT_MARKER');
 const latest=workflows.start({commandId:next(),taskId:binding.taskId});await complete(latest,'LATEST_ROOT_REPORT_MARKER');
 const operations={projectSnapshot:()=>projects.snapshot(),workflowSnapshot:()=>workflows.snapshot(),saveWorkflow:input=>workflows.save(input),startWorkflow:input=>workflows.start(input),scheduleOptions:()=>projects.scheduleOptions()};
 const calls=[];
 const baseline=process.env.DSH_UI_BASELINE==='1';
 const pageSource=baseline?execFileSync('git',['show','9832080a2bc62fa67eb8219691d18fa0029dc3b2:packages/task-system/src/project-page.html'],{cwd:root,encoding:'utf8'}).replace('/*__TASK_MARKDOWN__*/',()=>readFileSync(require.resolve('markdown-it/browser'),'utf8').replace(/<\/script/gi,'<\\/script')):readFileSync(join(root,'packages/task-system/dist/project-page.html'),'utf8');
 const host=`<!doctype html><html><body style="margin:0"><iframe id="app" style="width:100%;height:100dvh;border:0"></iframe><script>const frame=document.getElementById('app');window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.data?.channel!=='dsh-project-runtime')return;const {id,method,input}=event.data;if(method==='detailFullscreen')return;try{const result=await(await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,input})})).json();event.source.postMessage({channel:'dsh-project-runtime',id,...result},'*');}catch(error){event.source.postMessage({channel:'dsh-project-runtime',id,error:error.message},'*');}});fetch('/page').then(r=>r.text()).then(html=>frame.srcdoc=html.replace('<head>','<head><script>window.__DSH_PROJECT_CONTEXT__={projectId:"p"};<'+ '/script>'));</script></body></html>`;
 server=createServer(async(req,res)=>{try{if(req.url==='/rpc'){let body='';for await(const chunk of req)body+=chunk;const {method,input}=JSON.parse(body);calls.push({method,input});if(!operations[method])throw Error('Unexpected RPC '+method);res.setHeader('content-type','application/json');res.end(JSON.stringify({value:await operations[method](input)}));}else{res.setHeader('content-type','text/html; charset=utf-8');res.end(req.url==='/page'?pageSource:host);}}catch(error){res.setHeader('content-type','application/json');res.end(JSON.stringify({error:error.message,errorCode:error.code}));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);await page.goto(`http://127.0.0.1:${server.address().port}`);const app=page.frameLocator('#app');
 await app.locator('.project-flow-stage').first().waitFor();
 const title=await app.locator('.project-flow-stage strong').first().evaluate(node=>({height:node.clientHeight,scroll:node.scrollHeight,width:node.clientWidth,scrollWidth:node.scrollWidth,text:node.textContent}));
 await page.screenshot({path:join(evidence,baseline?'baseline-project.png':'project-before-edit.png'),fullPage:true});
 if(baseline){assert.ok(title.height>=title.scroll&&title.width>=title.scrollWidth,'stage title must be fully visible without clipping');assert.equal(await app.locator('[data-action="flow-edit"]').count(),1,'project diagram must have an actual inline editor');}
 assert.ok(title.height>=title.scroll&&title.width>=title.scrollWidth,'full stage title remains visible');
 await app.locator('[data-action="flow-edit"]').click();await app.locator('.project-flow-viewport.editing').waitFor();
 const height=await app.locator('.project-flow-viewport').first().evaluate(node=>node.getBoundingClientRect().height);
 const heading=app.locator('[data-project-drag="a"]');const box=await heading.boundingBox();await page.mouse.move(box.x+60,box.y+12);await page.mouse.down();await page.mouse.move(box.x+130,box.y+60,{steps:8});await page.mouse.up();
 const moved=await app.locator('[data-project-stage="a"]').evaluate(node=>({x:Number(node.getAttribute('x')),y:Number(node.getAttribute('y'))}));assert.notEqual(moved.x,initial.stages[0].position.x);
 async function connect(from,to,drag=false){const out=app.locator(`[data-project-port="out"][data-project-step="${from}"]`),input=app.locator(`[data-project-port="in"][data-project-step="${to}"]`);if(drag){const a=await out.boundingBox(),b=await input.boundingBox();await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:10});await page.mouse.up();}else{await out.click();await input.click();}}
 await connect('a','b',true);await app.locator('.project-call-list').getByText('具体步骤 a → 具体步骤 b',{exact:true}).waitFor();
 await connect('b','c');await app.locator('.project-call-list').getByText('具体步骤 b → 具体步骤 c',{exact:true}).waitFor();
 await connect('a','a');await app.getByRole('alert').getByText(/不能将步骤连接到自身/).waitFor();
 await connect('c','a');await app.getByRole('alert').getByText(/调用顺序存在循环/).waitFor();
 await app.locator('.project-call-list .spread').filter({hasText:'具体步骤 a → 具体步骤 c'}).getByRole('button',{name:'删除连线'}).click();await app.getByRole('alert').getByText(/仍使用上游输出/).waitFor();
 await app.locator('[data-action="flow-save"]').click();await app.locator('[data-action="flow-save"]').getByText('已保存',{exact:true}).waitFor();
 const saved=workflows.snapshot().definitions.find(flow=>flow.workflowId==='flow');assert.deepEqual(saved.stages[0].position,moved);assert.deepEqual(saved.calls,[{fromStepId:'a',toStepId:'c'},{fromStepId:'a',toStepId:'b'},{fromStepId:'b',toStepId:'c'}]);
 await app.locator('[data-action="flow-fullscreen"]').click();assert.ok(await app.locator('.project-execution.is-fullscreen').count());await app.locator('[data-action="flow-fit"]').click();await app.locator('[data-action="flow-fullscreen"]').click();assert.equal(await app.locator('.project-flow-viewport').first().evaluate(node=>node.getBoundingClientRect().height),height);
 await page.screenshot({path:join(evidence,'project-edited-ports.png'),fullPage:true});
 await page.reload();await app.locator('[data-action="flow-edit"]').click();await app.locator('.project-flow-viewport.editing').waitFor();assert.deepEqual(await app.locator('[data-project-stage="a"]').evaluate(node=>({x:Number(node.getAttribute('x')),y:Number(node.getAttribute('y'))})),moved);
 await app.locator('[data-action="project-tasks"]').click();await app.locator('[data-action="task"][data-id="'+binding.taskId+'"]:visible').first().click();
 assert.match(await app.locator('.workflow-final-report>p.hint').innerText(),/^第 2 次执行 · \d{4}\//);assert.ok(await app.locator('.workflow-final-report').getByText('LATEST_ROOT_REPORT_MARKER',{exact:true}).count());assert.equal(await app.locator('.workflow-final-report').getByText('OLD_ROOT_REPORT_MARKER',{exact:true}).count(),0);assert.equal(await app.locator('#overlays .flow-step-evidence').count(),0);await app.locator('.workflow-report-sources').getByText('来源步骤',{exact:true}).waitFor();
 await app.locator('#overlays [data-action="schedule-run"][data-id="'+old.runId+'"]').first().click();
 await app.locator('#overlays').getByText('OLD_ROOT_REPORT_MARKER',{exact:true}).first().waitFor();assert.equal(await app.locator('#overlays').getByText('LATEST_ROOT_REPORT_MARKER',{exact:true}).count(),0);assert.equal(await app.locator('#overlays [data-project-port]').count(),0);assert.ok(await app.locator('#overlays').getByText(/历史快照只读/).count());
 for(const name of ['a','b'])assert.equal(await app.locator('#overlays .flow-step-evidence').getByText('STEP_'+name+'_RESULT',{exact:true}).count(),1,'step summary and report body are not duplicated');
 assert.equal(await app.locator('#overlays .flow-step-evidence').getByText('OLD_ROOT_REPORT_MARKER',{exact:true}).count(),1);
 await page.screenshot({path:join(evidence,'historical-run-report.png'),fullPage:true});
 await app.locator('#overlays [data-action="close"]').first().click();await app.locator('#overlays [data-action="workflow-task-run"]').waitFor();trace.length=0;await app.locator('#overlays [data-action="workflow-task-run"]').click();
 await app.locator('.workflow-final-report').getByText(/尚未提交正式报告/).waitFor();assert.equal(await app.locator('.workflow-final-report').getByText('LATEST_ROOT_REPORT_MARKER',{exact:true}).count(),0);
 const admitted=workflows.snapshot().runs.find(flow=>flow.runId!==old.runId&&flow.runId!==latest.runId);await complete(admitted,'NEW_EDITED_ROOT_REPORT');assert.deepEqual(trace,['a','b','c'],'saved ports compile into actual real-worker invocation order');
 assert.deepEqual(workflows.snapshot().runs.find(flow=>flow.runId===old.runId).definition,initial,'historical graph is frozen after editing');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,backend:'real SQLite and program workers',savedPosition:moved,realInvocationOrder:trace,rootReportIsolation:true,stepBodyDeduplicated:true,evidence}));
}finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());await Promise.all(workers.map(worker=>worker.dispose()));stores.forEach(store=>store.close());await h.dispose();}
