import {demandReadMethods} from "../../packages/task-system/dist/demand-reads.js";
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from '../dsh/native-harness.mjs';
import {TaskPluginSettings} from '../../packages/task-system/dist/settings.js';

export async function testTaskCheckins(browser,{output}={}){
 const h=await createNativeHarness({config:{role:'planner',centralMode:'host',executionEnabled:false},script:['Verified the task still waits for a human decision']});
 const settings=Object.assign(Object.create(TaskPluginSettings.prototype),{ctx:h.ctx}),calls=[];
 const handle=await h.ctx.agents.create({sessionId:SessionId('browser-checkin-owner'),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
 const result=await h.ctx.tools.execute({name:'task_create',arguments:{commandId:'browser-draft',title:'检查未派发任务'},callId:ToolCallId('browser-create'),agent:handle.agent,signal:new AbortController().signal});assert.equal(result.isError,false);
 const task=h.ledger.snapshot().tasks.find(task=>task.title==='检查未派发任务');
 h.ledger.managementDatabase().prepare("DELETE FROM entities WHERE kind='taskCheckin' AND id=?").run(task.taskId);
 const html=readFileSync(new URL('../../packages/task-system/dist/project-page.html',import.meta.url),'utf8');
 const server=createServer(async(request,response)=>{
  try{
   if(request.url==='/page'){response.setHeader('content-type','text/html; charset=utf-8');response.end(html);return;}
   if(request.url==='/rpc'&&request.method==='POST'){
    let body='';for await(const chunk of request){body+=chunk;assert.ok(body.length<10000);}
    const {method,input}=JSON.parse(body);assert.ok([...demandReadMethods,'actOnProjectTask'].includes(method));calls.push({method,input});
    const value=await settings[method](input);response.setHeader('content-type','application/json');response.end(JSON.stringify({value}));return;
   }
   response.setHeader('content-type','text/html; charset=utf-8');response.end(`<!doctype html><html><body style="margin:0"><iframe title="Task center" src="/page" style="width:100vw;height:100vh;border:0"></iframe><script>addEventListener('message',async event=>{const x=event.data;if(x?.channel!=='dsh-project-runtime')return;if(x.method==='ready'){event.source.postMessage({channel:x.channel,method:'active',input:{active:true,generation:1}},'*');return;}if(!x.id)return;const result=await(await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:x.method,input:x.input})})).json();event.source.postMessage({channel:x.channel,id:x.id,...result},location.origin);});</script></body></html>`);
  }catch(error){response.statusCode=400;response.setHeader('content-type','application/json');response.end(JSON.stringify({error:error.message,errorCode:error.details?.reason??error.code}));}
 });
 const context=await browser.newContext({viewport:{width:1280,height:1000}}),page=await context.newPage(),errors=[];
 page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await page.goto(`http://127.0.0.1:${server.address().port}/`);const frame=page.frameLocator('iframe');
  await frame.locator(`[data-action="task"][data-id="${task.taskId}"]`).first().click();const dialog=frame.getByRole('dialog');
  await dialog.getByRole('heading',{name:'负责会话进度',exact:true}).waitFor();await dialog.getByRole('button',{name:'检查进度',exact:true}).click();
  await dialog.getByText('已排队，等待会话处理',{exact:true}).waitFor();assert.equal(await dialog.locator('[data-action="task-check"]').isDisabled(),true);assert.equal(calls.filter(call=>call.method==='actOnProjectTask').length,1);
  assert.equal(h.ledger.getTask(task.taskId).state,'ready');assert.equal(h.ledger.snapshot().runs.length,0);assert.ok(h.ledger.checkins.view(task.taskId).nextCheckAt);
  if(output)await page.screenshot({path:join(output,'task-checkin-queued.png'),fullPage:true});
  const updated=await h.ctx.tools.execute({name:'task_checkin',arguments:{action:'update',commandId:'pause-for-human',taskId:task.taskId,observation:'blocked',summary:'Waiting for a human decision',plan:{kind:'paused',reason:'需要用户决定'}},callId:ToolCallId('browser-pause'),agent:handle.agent,signal:new AbortController().signal});assert.equal(updated.isError,false);h.ledger.checkins.tick();
  await dialog.getByText('自动检查已暂停',{exact:true}).waitFor();await dialog.getByText(/本次为单次检查，自动检查继续暂停/).waitFor();await dialog.getByRole('button',{name:'检查进度',exact:true}).click();await dialog.getByText('已排队，等待会话处理',{exact:true}).waitFor();
  const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];assert.equal(message.checkIn.automatic,false);const receipt=await h.ctx.taskSystem.taskReturns.deliver(message);h.ledger.completeSessionMessage('browser-ack',{nodeId:'local',messageId:message.messageId,state:'completed',...receipt});
  await dialog.getByText('自动检查已暂停',{exact:true}).waitFor();assert.equal(h.ledger.checkins.view(task.taskId).phase,'paused');assert.equal(h.ledger.snapshot().runs.length,0);assert.deepEqual(errors,[]);
  if(output)await page.screenshot({path:join(output,'task-checkin-paused-after-manual.png'),fullPage:true});
  await dialog.locator('[data-action="close"]').click();
  const second=await h.ctx.tools.execute({name:'task_create',arguments:{commandId:'browser-auto-pending',title:'自动检查等待时请求手动核实'},callId:ToolCallId('browser-create-auto-pending'),agent:handle.agent,signal:new AbortController().signal});assert.equal(second.isError,false);
  const later=h.ledger.snapshot().tasks.find(task=>task.title==='自动检查等待时请求手动核实');h.ledger.clock=()=>Date.now()+31*60000;h.ledger.checkins.tick();
  const old=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];assert.equal(old.checkIn.automatic,true);assert.equal(old.checkIn.manualChecks,undefined);
  await frame.locator(`[data-action="task"][data-id="${later.taskId}"]`).first().click();
  await dialog.getByRole('button',{name:'请求手动核实',exact:true}).click();
  await dialog.getByText('已排队，等待会话处理',{exact:true}).waitFor();assert.equal(await dialog.locator('[data-action="task-check"]').isDisabled(),true);
  assert.equal(h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0].messageId,old.messageId);
  h.adapter.script.push('Existing automatic check finished');const oldReceipt=await h.ctx.taskSystem.taskReturns.deliver(old);h.ledger.completeSessionMessage('browser-old-auto-ack',{nodeId:'local',messageId:old.messageId,state:'completed',...oldReceipt});h.ledger.checkins.tick();
  const manual=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];assert.notEqual(manual.messageId,old.messageId);assert.equal(manual.checkIn.manualChecks[0].taskId,later.taskId);
  h.adapter.script.push({name:'task_checkin',args:{action:'status',taskId:later.taskId}},'Explicit manual verification finished');const manualReceipt=await h.ctx.taskSystem.taskReturns.deliver(manual);h.ledger.completeSessionMessage('browser-after-auto-manual-ack',{nodeId:'local',messageId:manual.messageId,state:'completed',...manualReceipt});
  await dialog.getByRole('button',{name:'检查进度',exact:true}).waitFor();assert.equal(calls.filter(call=>call.method==='actOnProjectTask').length,3);assert.equal(h.ledger.snapshot().runs.length,0);
  if(output)await page.screenshot({path:join(output,'task-checkin-auto-then-manual.png'),fullPage:true});
  return{realAuthority:true,draftNeverDispatched:true,manualRequestCount:3,pausedCheckOneShot:true,journalReceipt:true,automaticPendingDoesNotBlockManual:true};
 }catch(error){if(output)await page.screenshot({path:join(output,'task-checkin-failure.png'),fullPage:true}).catch(()=>{});throw error;}
 finally{await context.close();await new Promise(resolve=>server.close(resolve));await h.dispose();}
}
