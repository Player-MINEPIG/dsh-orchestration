import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {createNativeHarness} from '../dsh/native-harness.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const evidence=process.env.DSH_UI_EVIDENCE;assert.ok(evidence);mkdirSync(evidence,{recursive:true});
const h=await createNativeHarness({config:{role:'planner',nodeId:'authority'}}),l=h.ledger,p=h.ctx.taskSystem.projects;let browser,server;
try{
 l.registerNode('node',{nodeId:'executor',roles:['executor'],models:[{provider:'provider',model:'model',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
 const task=l.createTask('task',{title:'外部插件提交的临时任务',description:'保留原执行请求，修复缺失的临时目录上下文。'}).value;
 const run=l.createRun('run',{taskId:task.taskId,route:{nodeId:'executor',provider:'provider',model:'model',requiredCapabilities:[]}}).value;
 const old={...run};delete old.projectContext;l.managementDatabase().prepare("UPDATE entities SET data=? WHERE kind='run' AND id=?").run(JSON.stringify(old),run.runId);
 const pageSource=readFileSync(resolve('packages/task-system/dist/project-page.html'),'utf8');
 const operations={projectSnapshot:()=>p.snapshot(),actOnProjectTask:input=>p.actOnTask(input)};
 const host=`<!doctype html><html><body style="margin:0"><iframe id="app" style="width:100%;height:100dvh;border:0"></iframe><script>const f=document.getElementById('app');window.addEventListener('message',async e=>{if(e.source!==f.contentWindow||e.data?.channel!=='dsh-project-runtime')return;const {id,method,input}=e.data;if(method==='detailFullscreen')return;const result=await(await fetch('/rpc',{method:'POST',body:JSON.stringify({method,input})})).json();e.source.postMessage({channel:'dsh-project-runtime',id,...result},'*');});fetch('/page').then(r=>r.text()).then(html=>f.srcdoc=html);</script></body></html>`;
 server=createServer(async(req,res)=>{try{if(req.url==='/rpc'){let body='';for await(const part of req)body+=part;const {method,input}=JSON.parse(body);if(!operations[method])throw Error('Unexpected '+method);res.setHeader('content-type','application/json');res.end(JSON.stringify({value:await operations[method](input)}));}else{res.setHeader('content-type','text/html;charset=utf-8');res.end(req.url==='/page'?pageSource:host);}}catch(error){res.end(JSON.stringify({error:error.message,errorCode:error.code}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});await page.goto(`http://127.0.0.1:${server.address().port}`);const app=page.frameLocator('#app');
 await app.getByText(task.title,{exact:true}).first().click();await app.getByRole('button',{name:'重新检查并修复',exact:true}).waitFor();
 for(const width of [1440,390]){await page.setViewportSize({width,height:1100});await app.getByRole('button',{name:'重新检查并修复',exact:true}).scrollIntoViewIfNeeded();assert.equal(await app.locator('body').evaluate(el=>el.scrollWidth<=el.clientWidth),true);await page.screenshot({path:join(evidence,`dispatch-issue-${width}.png`)});}
 await app.getByRole('button',{name:'重新检查并修复',exact:true}).click();await page.waitForTimeout(200);
 const repaired=l.getRun(run.runId);assert.equal(repaired.projectContext.project,null);assert.equal(repaired.runId,run.runId);assert.equal(l.snapshot().attempts.length,0);assert.equal(l.snapshot().runs.length,1);
 assert.equal(repaired.dispatchIssue?.code,'EXECUTION_CATALOG_PENDING','old pinned route requests fresh directory without changing the assignment');
 writeFileSync(join(evidence,'dispatch-issue.json'),JSON.stringify({realSqlite:true,productionWrites:0,sameRunId:true,attempts:0,remainingIssue:repaired.dispatchIssue.code},null,2));console.log(JSON.stringify({passed:true,sameRunId:true,attempts:0,remainingIssue:repaired.dispatchIssue.code}));
}finally{await browser?.close();await new Promise(r=>server?server.close(r):r());await h.dispose();}
