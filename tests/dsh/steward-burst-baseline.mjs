import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {cpus,loadavg} from 'node:os';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {createNativeHarness} from './native-harness.mjs';
import {ScriptedModel} from './scripted-model.mjs';
import {registerExecutor} from './executor-fixture.mjs';
import {TaskPluginSettings} from '../../packages/task-system/dist/settings.js';
import {RecoveryStore} from '../../packages/task-system/dist/remote/store.js';
import {SessionMessages} from '../../packages/task-system/dist/remote/session-messages.js';

// Claim: deterministic overlap/admission/ordering evidence on one isolated native host.
// This is not a throughput, model quality, paid-provider latency, or speedup benchmark.
// Model barriers prove a request arrived and hold completion independent of admission.
const baselineRoot=resolve(process.env.DSH_BURST_BASELINE_ROOT??'/private/tmp/dsh-steward-official-iteration');
const runId=`${Date.now()}-${process.pid}`;
const output=resolve(process.env.DSH_BURST_OUTPUT??'.runtime/steward-burst-baseline');mkdirSync(output,{recursive:true});
const receipt={claim:'Deterministic product-path concurrency and delivery evidence; no actual provider throughput or quality claim',node:process.version,cores:cpus().length,loadBefore:loadavg(),source:'Baseline Host/UI/demo from preserved candidate; after Host/UI/demo from current built worktree. Independent authority/demo-guard modes use the current worktree.',rounds:[],errors:[]};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const barrier=()=>{let release;const promise=new Promise(done=>release=done);return {promise,release};};
async function until(check,label){const deadline=Date.now()+10000;while(!await check()){if(Date.now()>deadline)throw Error('Timed out: '+label);await delay(10);}}
const latest=options=>[...options.messages].reverse().find(message=>message.role==='user'&&message.source?.kind!=='runtime-context');
const body=message=>message?.content.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';
async function waitCommand(service,commandId){let result;await until(async()=>{result=await service.reconcile({conversationId:'main',commandId});return result.commandMessage?.state.kind==='completed';},commandId+' completion');return result;}
async function post(url,method,input){const response=await fetch(new URL('/rpc',url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,input})});return {ok:response.ok,status:response.status,...await response.json()};}

async function settingsAndUi(browser,index,phase="baseline"){
 const after=phase==="after",uiRoot=after?process.cwd():baselineRoot;
 const createHarness=after?createNativeHarness:(await import(pathToFileURL(join(baselineRoot,'tests/dsh/native-harness.mjs')).href)).createNativeHarness;
 const h=await createHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
 const gates=new Map(),events=[],dropAcks=new Set(),server=createServer();let context,page;
 const stamp=(kind,commandId,extra={})=>events.push({kind,commandId,ms:performance.now(),...extra});
 try{
  const service=h.ctx.taskSystem.steward,projects=h.ctx.taskSystem.projects;
  projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const a=await projects.create({commandId:'create-a',title:'Alpha',goal:'A_GOAL'}),b=await projects.create({commandId:'create-b',title:'Beta',goal:'B_GOAL'});
  h.adapter.stream=async function*(options){
   this.requests.push(options);const user=latest(options),text=body(user),classifier=user?.source?.kind==='dsh-steward-route-classifier';
   const marker=classifier?JSON.parse(text).text:text;stamp(classifier?'classifier-arrived':'model-arrived',marker,{sessionId:options.sessionId});
   if(gates.has(marker))await gates.get(marker).promise;
   yield*new ScriptedModel([classifier?JSON.stringify({kind:'route',target:{kind:'project',projectId:a.projectId}}):'reply:'+marker]).stream(options);
  };
  const settings=Object.assign(Object.create(TaskPluginSettings.prototype),{ctx:h.ctx});
  const assets=new Map([['/react.js',readFileSync(new URL('../../node_modules/react/umd/react.production.min.js',import.meta.url))],['/react-dom.js',readFileSync(new URL('../../node_modules/react-dom/umd/react-dom.production.min.js',import.meta.url))],['/steward.js',readFileSync(join(uiRoot,'packages/task-system/src/steward-client.js'))]]);
  server.on('request',async(req,res)=>{try{
   if(assets.has(req.url)){res.setHeader('content-type','text/javascript; charset=utf-8');res.end(assets.get(req.url));return;}
   if(req.url==='/rpc'){let text='';for await(const part of req)text+=part;const {method,input}=JSON.parse(text);assert.ok(['stewardSnapshot','stewardReconcile','stewardSend'].includes(method));stamp('http-received',input.commandId,{method});const value=await settings[method](input);if(method==='stewardSend'&&dropAcks.has(input.text)){stamp('http-ack-dropped',input.commandId);res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Synthetic lost acknowledgement'}));return;}stamp('http-returned',input.commandId,{method,state:value.commandMessage?.state.kind});res.setHeader('content-type','application/json');res.end(JSON.stringify({value}));return;}
   res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/steward.js"></script><script>const invoke=async(method,input)=>{const r=await fetch("/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method,input})});const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error),{details:v.details});return v.value;};ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(createStewardClient(React).StewardPanel,{invoke}));</script>');
  }catch(error){stamp('http-error',undefined,{code:error.details?.reason??error.code,message:error.message});res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message,details:error.details}));}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}`;
  context=await browser.newContext();page=await context.newPage();page.on('pageerror',error=>{stamp('browser-error',null,{error:error.message});process.stderr.write(error.stack+'\n');});page.setDefaultTimeout(10000);await page.goto(url);
  const select=page.getByRole('combobox',{name:'本条对话对象',exact:true}),input=page.getByRole('textbox',{name:'消息',exact:true});
  const slow=`slow-a-${index}`,gate=barrier();gates.set(slow,gate);
  await select.selectOption(`project:${a.projectId}`);await input.fill(slow);await page.getByRole('button',{name:'发送',exact:true}).click();
  await until(()=>events.some(event=>event.kind==='model-arrived'&&event.commandId===slow),'slow A model reached');
  await until(()=>input.isEnabled(),'settings API returns admission before model completion');
  const aUser=service.snapshot({conversationId:'main'}).messages.find(message=>message.text===slow);assert.ok(aUser);assert.notEqual(aUser.state.kind,'completed');
  await select.selectOption(`project:${b.projectId}`);await input.fill(`fast-b-${index}`);await page.getByRole('button',{name:'发送',exact:true}).click();
  await until(()=>service.snapshot({conversationId:'main'}).messages.some(message=>message.text===`reply:fast-b-${index}`),'UI B completes while A held');
  assert.equal(await select.inputValue(),`project:${b.projectId}`);
  const second=await post(url,'stewardSend',{conversationId:'main',commandId:`a-second-${index}`,text:`a-second-${index}`,target:{kind:'project',projectId:a.projectId}});
  if(after){assert.equal(second.ok,true);assert.equal(second.value.commandMessage.state.kind,'queued');}else{assert.equal(second.ok,false);assert.equal(second.details.reason,'BUSY');assert.equal(second.details.admission,'not-admitted');assert.equal(service.commandStatus('main',`a-second-${index}`),'not-admitted');}
  gate.release();await waitCommand(service,aUser.commandId);if(after)await waitCommand(service,`a-second-${index}`);await until(()=>input.isEnabled(),'B admission returned');
  assert.equal(await select.inputValue(),`project:${b.projectId}`,'A completion does not steal B input target');
  const ambiguous=`ambiguous-${index}`,classification=barrier();gates.set(ambiguous,classification);
  await select.selectOption('auto');await input.fill(ambiguous);await page.getByRole('button',{name:'发送',exact:true}).click();
  await until(()=>events.some(event=>event.kind==='classifier-arrived'&&event.commandId===ambiguous),'classifier reached');
  assert.equal(await input.isDisabled(),!after);assert.equal(await select.isDisabled(),!after);
  assert.equal(service.snapshot({conversationId:'main'}).messages.some(message=>message.text===ambiguous),false,'Pending classifier has no durable canonical message yet');
  let directId=`direct-during-classifier-${index}`;
  if(after){
   await select.selectOption(`project:${b.projectId}`);await input.fill(`direct-during-classifier-${index}`);await page.getByRole('button',{name:'发送',exact:true}).click();
   await until(()=>service.snapshot({conversationId:'main'}).messages.some(message=>message.text===`direct-during-classifier-${index}`),'independent UI message admitted');
   directId=service.snapshot({conversationId:'main'}).messages.find(message=>message.text===`direct-during-classifier-${index}`).commandId;
   await input.fill(`NEW_DRAFT_${index}`);
  }else{const direct=await post(url,'stewardSend',{conversationId:'main',commandId:directId,text:`direct-during-classifier-${index}`,target:{kind:'project',projectId:b.projectId}});assert.equal(direct.ok,true);}
  await waitCommand(service,directId);stamp('observed-completed',directId);
  classification.release();await until(()=>!after?input.isEnabled():page.locator('[data-pending-command]').count().then(count=>count===0),'classifier released UI');
  const classified=service.snapshot({conversationId:'main'}).messages.find(message=>message.text===ambiguous);await waitCommand(service,classified.commandId);stamp('observed-completed',classified.commandId);
  if(after){assert.equal(await input.inputValue(),`NEW_DRAFT_${index}`);assert.equal(await select.inputValue(),`project:${b.projectId}`);await input.fill('');}
  const ids=service.snapshot({conversationId:'main'}).messages.filter(message=>message.role==='user').map(message=>message.commandId);assert.equal(ids.length,after?5:4);assert.equal(new Set(ids).size,after?5:4);
  assert.equal(events.filter(event=>event.kind==='model-arrived'&&event.commandId===`a-second-${index}`).length,after?1:0,'Accepted queued second reaches the model exactly once; legacy rejected second never does');
  const count=h.adapter.requests.length;const retry=await post(url,'stewardSend',{conversationId:'main',commandId:directId,text:`direct-during-classifier-${index}`,target:{kind:'project',projectId:b.projectId}});assert.equal(retry.ok,true);assert.equal(h.adapter.requests.length,count);
  let recoveryEvidence=null;
  if(after){
   const pending=[];
   for(const [project,letter]of [[a,'a'],[b,'b']]){
    const text=`drop-ack-${letter}-${index}`;dropAcks.add(text);await select.selectOption(`project:${project.projectId}`);await input.fill(text);await page.getByRole('button',{name:'发送',exact:true}).click();
    await until(()=>service.snapshot({conversationId:'main'}).messages.some(message=>message.text===text),'dropped ACK server accepted');const user=service.snapshot({conversationId:'main'}).messages.find(message=>message.text===text);pending.push(user);await waitCommand(service,user.commandId);
   }
   await until(()=>page.locator('[data-pending-command]').count().then(count=>count===2),'two unknown requests retained');await page.reload();await until(()=>page.locator('[data-pending-command]').count().then(count=>count===2),'two pending requests survive reload');
   await input.fill(`RECOVERY_DRAFT_${index}`);await select.selectOption(`project:${b.projectId}`);
   await page.locator(`[data-pending-command="${pending[0].commandId}"]`).getByRole('button',{name:'核实原请求',exact:true}).click();await until(()=>page.locator('[data-pending-command]').count().then(count=>count===1),'one reconciliation preserves other pending');
   const before=h.adapter.requests.length;dropAcks.delete(pending[1].text);await page.locator(`[data-pending-command="${pending[1].commandId}"]`).getByRole('button',{name:'重试原请求',exact:true}).click();await until(()=>page.locator('[data-pending-command]').count().then(count=>count===0),'same-command retry confirmed');assert.equal(h.adapter.requests.length,before);
   assert.equal(await input.inputValue(),`RECOVERY_DRAFT_${index}`);assert.equal(await select.inputValue(),`project:${b.projectId}`);
   await input.fill('');
   const held=`busy-ui-first-${index}`,heldGate=barrier();gates.set(held,heldGate);await select.selectOption('personal');await input.fill(held);await page.getByRole('button',{name:'发送',exact:true}).click();await until(()=>events.some(event=>event.kind==='model-arrived'&&event.commandId===held),'held UI request reaches model');
   const rejectedText=`busy-ui-second-${index}`;await input.fill(rejectedText);await page.getByRole('button',{name:'发送',exact:true}).click();const restore=page.getByRole('button',{name:'恢复原文到输入框',exact:true});await restore.waitFor();assert.equal(await input.isEnabled(),true);await restore.click();assert.equal(await input.inputValue(),rejectedText);await select.selectOption(`project:${b.projectId}`);await page.getByRole('button',{name:'发送',exact:true}).click();await until(()=>service.snapshot({conversationId:'main'}).messages.some(message=>message.text===`reply:${rejectedText}`),'restored not-admitted message can reach independent target');heldGate.release();const heldUser=service.snapshot({conversationId:'main'}).messages.find(message=>message.text===held);await waitCommand(service,heldUser.commandId);
   const legacy={conversationId:'main',commandId:aUser.commandId,text:slow,target:{kind:'project',projectId:a.projectId}},storageKey=`dsh-steward-pending:${encodeURIComponent(service.snapshot({conversationId:'main'}).authorityId)}:main`;
   await page.evaluate(({storageKey,legacy})=>localStorage.setItem(storageKey,JSON.stringify(legacy)),{storageKey,legacy});await page.reload();await until(()=>page.locator('[data-pending-command]').count().then(count=>count===1),'legacy single pending restored');assert.equal(await input.isEnabled(),true);const beforeLegacy=h.adapter.requests.length;await page.getByRole('button',{name:'核实原请求',exact:true}).click();await until(()=>page.locator('[data-pending-command]').count().then(count=>count===0),'legacy pending verified individually');assert.equal(h.adapter.requests.length,beforeLegacy);
   const missing={request:{conversationId:'main',commandId:`missing-source-${index}`,text:'Original reply must keep its target',replyTo:'not-on-this-page',quote:{messageId:'also-not-on-this-page',expectedRevision:0,excerpt:'Original quote'}},status:'not-admitted',reason:'Synthetic not-admitted original'};
   await page.evaluate(({storageKey,missing})=>localStorage.setItem(storageKey,JSON.stringify([missing])),{storageKey,missing});await page.reload();await page.getByRole('button',{name:'恢复原文到输入框',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'恢复原文到输入框',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'重试原请求',exact:true}).isEnabled(),true);assert.equal(await input.isEnabled(),true);
   recoveryEvidence={missingReplyQuoteRestoreBlocked:true,unknownBeforeReload:2,unknownAfterReload:2,reconcilePreservesOther:true,sameCommandRetryExtraModelRequests:0,newDraftPreserved:true,busyOriginalRestored:true,legacySinglePendingMigrated:true};
  }
  const canonical=service.snapshot({conversationId:'main'}).messages.filter(message=>message.role==='user');
  for(const user of canonical){const model=events.filter(event=>event.kind==='model-arrived'&&event.commandId===user.text);assert.equal(model.length,1);assert.equal(model[0].sessionId,user.source.sessionId);stamp('canonical-completed',user.commandId,{sessionId:user.source.sessionId,text:user.text,state:user.state.kind});}
  return {kind:'settings-http-production-ui',index,phase,recoveryEvidence,verdict:{crossProject:true,admissionBeforeCompletion:true,managedSameProject:after?'durable queued FIFO':'BUSY before canonical acceptance',classifierDurableBeforeRouting:false,classifierBlocksSingleComposer:!after,directApiIndependentOfClassifier:true,completionKeepsInputTarget:true,canonicalUserCount:canonical.length,duplicateUserCount:canonical.length-new Set(canonical.map(message=>message.commandId)).size},events};
 }catch(error){if(page)writeFileSync(join(output,'failed-page.html'),await page.content());writeFileSync(join(output,'failed-events.json'),JSON.stringify(events,null,2));throw error;}finally{for(const gate of gates.values())gate.release();await context?.close();server.closeAllConnections();await new Promise(done=>server.close(done));await h.dispose();}
}

async function originalDemo(index,phase="baseline"){
 const after=phase==="after";
 const root=join(output,`demo-${phase}-${index}-${runId}`),child=spawn(process.execPath,['tests/dsh/steward-demo.mjs'],{cwd:after?process.cwd():baselineRoot,env:{...process.env,DSH_STEWARD_DEMO_MODE:'offline',DSH_STEWARD_DEMO_MEMORY:'0',DSH_STEWARD_DEMO_ROOT:root,DSH_STEWARD_DEMO_PORT:'0'},stdio:['ignore','pipe','pipe']});let logs='',errors='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
 try{
  await until(()=>logs.includes('"url":'),'original demo boot');const info=JSON.parse(logs.trim().split('\n').find(line=>line.startsWith('{'))),url=new URL(info.url);
  const response=await fetch(new URL(`/api/stewardSnapshot${url.search}`,url),{method:'POST',body:JSON.stringify({conversationId:'main'})});const snapshot=await response.json();const targets=snapshot.projects;
  const send=(project,letter)=>fetch(new URL(`/api/stewardSend${url.search}`,url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversationId:'main',commandId:`demo-${letter}-${index}`,text:`demo-${letter}-${index}`,target:{kind:'project',projectId:project.projectId}})}).then(async response=>({status:response.status,...await response.json()}));
  const values=await Promise.all([send(targets[index%2], 'first'),send(targets[1-index%2],'second')]);assert.equal(values.filter(value=>value.status===200).length,after?2:1);if(!after){const failed=values.find(value=>value.status!==200);assert.match(failed.error,/mutation is busy/);assert.equal(failed.details.admission,'not-admitted');}
  const mutationExclusion=null;
  return {kind:'demo-http',index,phase,mutationExclusion,verdict:after?'both concurrent other-project requests admitted independently':'one accepted, concurrent other-project request not admitted by global demo mutation guard',responses:values.map(value=>({status:value.status,error:value.error,admission:value.details?.admission}))};
 }finally{child.kill('SIGTERM');await Promise.race([new Promise(done=>child.once('exit',done)),delay(10000)]);writeFileSync(join(output,`demo-${phase}-${index}-stderr.log`),errors);}
}

async function workerMessages(index){
 const h=await createNativeHarness({executionRoot:true,config:{role:'both',schedulerEnabled:false,autoExecute:false,localNode:{models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:['ws'],capabilities:[],enabled:true}}}),store=new RecoveryStore(':memory:'),gates=new Map(),events=[];let pump;
 try{
  const ledger=h.ledger,native=h.ctx.taskSystem.native;
  ledger.registerWorkspace('ws',{workspaceId:'ws',nodeId:'local',path:h.dir,state:'ready'});registerExecutor(ledger,'node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['ws'],enabled:true,maxConcurrent:4});ledger.recordNodeHeartbeat('ready',{nodeId:'local',runtimeReady:true,activeExecutions:0});
  h.adapter.stream=async function*(options){this.requests.push(options);const user=latest(options),text=body(user);const direct=user?.source?.kind==='dsh-direct-message';events.push({kind:direct?'direct-model-arrived':'work-model-arrived',text,sessionId:options.sessionId,ms:performance.now()});if(gates.has(text))await gates.get(text).promise;yield*new ScriptedModel([direct?'DIRECT_REPLY:'+text:{name:'task_submit_result',args:{outcome:'success',summary:'Scripted native result'}}]).stream(options);};
  const create=(label)=>{const task=ledger.createTask(label,{title:label,description:label}).value,run=ledger.createRun(label+'-run',{taskId:task.taskId,route:{nodeId:'local',workspaceId:'ws',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value,claim=ledger.claim(label+'-claim',{runId:run.runId,nodeId:'local',ttlMs:60000}).value;return {task,run,claim};};
  const a=create('worker-a'),b=create('worker-b');await native.execute(b.claim);
  // Hold A's actual task provider request, leaving its ordinary-message queue busy.
  let releaseWork;const blockWork=barrier();gates.set('__work',blockWork);h.adapter.stream=async function*(options){this.requests.push(options);const user=latest(options),text=body(user),direct=user?.source?.kind==='dsh-direct-message';events.push({kind:direct?'direct-model-arrived':'work-model-arrived',text,sessionId:options.sessionId,ms:performance.now()});if(!direct){releaseWork=true;await blockWork.promise;}if(gates.has(text))await gates.get(text).promise;yield*new ScriptedModel([direct?'DIRECT_REPLY:'+text:{name:'task_submit_result',args:{outcome:'success',summary:'Scripted native result'}}]).stream(options);};
  const executing=native.execute(a.claim);await until(()=>releaseWork,'A real native execution reached model');
  for(const item of [a,b]){const attempt=ledger.getAttempt(item.claim.attempt.attemptId),target=ledger.sessionMessageTargets(item.task.taskId)[0];assert.ok(target);item.target=target;store.createDispatch({attemptId:attempt.attemptId,state:'acknowledged',claim:{task:item.task,run:ledger.getRun(item.run.runId),attempt},lease:{runId:item.run.runId,attemptId:attempt.attemptId,nodeId:'local',fence:attempt.fence},sessionId:target.sessionId,workspacePath:h.dir});}
  pump=new SessionMessages({ledger,store,policy:{nodeId:'local',role:'executor',capabilities:[],workspaces:[{workspaceId:'ws',nodeId:'local',path:h.dir,allowedRoot:h.dir}]},provider:{id:'native-baseline',capabilities:[],supports:()=>true,sendSessionMessage:native.sendSessionMessage.bind(native)}});
  for(const [item,label]of [[a,'a1'],[a,'a2'],[b,'b1'],[b,'b2']]){const input={taskId:item.task.taskId,nodeId:'local',sessionId:item.target.sessionId,commandId:`${label}-${index}`,text:`${label}-${index}`};await h.ctx.taskSystem.sessionPortal.sendExecutorMessage(input);events.push({kind:"queue-accepted",commandId:input.commandId,sessionId:input.sessionId,ms:performance.now()});await h.ctx.taskSystem.sessionPortal.sendExecutorMessage(input);}
  await assert.rejects(h.ctx.taskSystem.sessionPortal.sendExecutorMessage({taskId:a.task.taskId,nodeId:'local',sessionId:b.target.sessionId,commandId:`foreign-${index}`,text:'cross task/session spoof'}),/bound/);
  const aFirst=barrier();gates.set(`a1-${index}`,aFirst);
  await until(async()=>{await pump.poll(4);return ledger.getSessionMessage(`b2-${index}`).state==='completed';},'B messages completed while A busy');
  assert.equal(ledger.getSessionMessage(`a1-${index}`).state,'queued');assert.equal(ledger.getSessionMessage(`a2-${index}`).state,'queued');assert.equal(events.filter(event=>event.kind==='direct-model-arrived'&&event.text.startsWith('a')).length,0);
  blockWork.release();await executing;
  await until(async()=>{await pump.poll(4);return events.some(event=>event.kind==='direct-model-arrived'&&event.text===`a1-${index}`);},'A first direct message reached model');
  await pump.poll(4);assert.equal(events.some(event=>event.kind==='direct-model-arrived'&&event.text===`a2-${index}`),false);
  aFirst.release();await until(async()=>{await pump.poll(4);return ledger.getSessionMessage(`a2-${index}`).state==='completed';},'A ordered queue completed');
  for(const label of ['a1','a2','b1','b2'])events.push({kind:'observed-completed',commandId:`${label}-${index}`,ms:performance.now(),state:ledger.getSessionMessage(`${label}-${index}`).state});
  const delivered=events.filter(event=>event.kind==='direct-model-arrived').map(event=>event.text);assert.deepEqual(delivered,[`b1-${index}`,`b2-${index}`,`a1-${index}`,`a2-${index}`]);
  return {kind:'authority-worker-queue-native',index,verdict:{busyRetainsQueued:true,otherSessionIndependent:true,sameSessionOrdered:true,accepted:4,delivered:4,duplicates:0,wrongTargetRejected:true},events};
 }finally{for(const gate of gates.values())gate.release();await pump?.dispose();store.close();await h.dispose();}
}

async function authoritySwitch(browser){
 const hosts=await Promise.all([0,1].map(()=>createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}}))),gate=barrier(),calls=[];let context,server,active=0;
 try{
  for(const [index,h]of hosts.entries()){h.adapter.script.push(`SEED_REPLY_${index}`);await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:`seed-${index}`,text:`AUTHORITY_${index}_SEED`,target:{kind:'personal'}});await waitCommand(h.ctx.taskSystem.steward,`seed-${index}`);}
  const a=hosts[0].ctx.taskSystem.steward,b=hosts[1].ctx.taskSystem.steward,template=a.snapshot({conversationId:'main'}).messages[0];
  for(let index=2;index<100;index++)a.store.project({...template,role:'notification',commandId:null,text:`A_NOTICE_${index}`,state:{kind:'completed'}},`authority-seed-${index}`);
  const ids=hosts.map(h=>h.ctx.taskSystem.steward.snapshot({conversationId:'main'}).authorityId),keys=ids.map(id=>`dsh-steward-pending:${encodeURIComponent(id)}:main`);
  hosts[0].adapter.stream=async function*(options){this.requests.push(options);if(latest(options)?.source?.kind==='dsh-steward-route-classifier'){await gate.promise;yield*new ScriptedModel([JSON.stringify({kind:'route',target:{kind:'personal'}})]).stream(options);}else yield*new ScriptedModel(['A_LATE_REPLY']).stream(options);};
  const settings=hosts.map(h=>Object.assign(Object.create(TaskPluginSettings.prototype),{ctx:h.ctx}));
  const assets=new Map([['/react.js',readFileSync(new URL('../../node_modules/react/umd/react.production.min.js',import.meta.url))],['/react-dom.js',readFileSync(new URL('../../node_modules/react-dom/umd/react-dom.production.min.js',import.meta.url))],['/steward.js',readFileSync(new URL('../../packages/task-system/src/steward-client.js',import.meta.url))]]);
  server=createServer(async(req,res)=>{try{if(assets.has(req.url)){res.setHeader('content-type','text/javascript; charset=utf-8');res.end(assets.get(req.url));return;}if(req.url==='/rpc'){let text='';for await(const chunk of req)text+=chunk;const {method,input}=JSON.parse(text),owner=active;calls.push({owner,method,input,ms:performance.now()});const value=await settings[owner][method](input);res.setHeader('content-type','application/json');res.end(JSON.stringify({value}));return;}res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><div id="root"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/steward.js"></script><script>const invoke=async(method,input)=>{const r=await fetch("/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({method,input})});const v=await r.json();if(!r.ok)throw Error(v.error);return v.value;};ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(createStewardClient(React).StewardPanel,{invoke}));</script>');}catch(error){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));context=await browser.newContext();await context.addInitScript(({keys})=>keys.forEach((key,index)=>localStorage.setItem(key,JSON.stringify([{request:{conversationId:'main',commandId:`pending-${index}`,text:`LOCAL_PENDING_${index}`,target:{kind:'personal'}},status:'unknown'}]))),{keys});
  const page=await context.newPage();page.setDefaultTimeout(10000);await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByText('A_NOTICE_99',{exact:true}).waitFor();await page.locator('[data-pending-command="pending-0"]').waitFor();
  await page.getByRole('combobox',{name:'本条对话对象',exact:true}).selectOption('auto');await page.getByRole('textbox',{name:'消息',exact:true}).fill('A_LATE_CLASSIFIER');await page.getByRole('button',{name:'发送',exact:true}).click();await until(()=>hosts[0].adapter.requests.some(request=>latest(request)?.source?.kind==='dsh-steward-route-classifier'),'A late classifier reached model');
  active=1;await page.getByText('AUTHORITY_1_SEED',{exact:true}).waitFor();await page.locator('[data-pending-command="pending-1"]').waitFor();assert.equal(await page.locator('[data-pending-command="pending-0"]').count(),0);
  await until(()=>calls.some(call=>call.owner===1&&call.method==='stewardReconcile'&&call.input.afterSeq===2),'B cursor follows its own two rows');
  const resetRead=calls.findIndex(call=>call.owner===1&&call.method==='stewardReconcile'&&call.input.afterSeq===undefined);assert.ok(resetRead>=0,'Changed authority must be fetched without old cursor or known IDs');assert.equal(calls[resetRead].input.knownIds,undefined);
  assert.ok(calls.slice(resetRead+1).filter(call=>call.owner===1&&call.method==='stewardReconcile').every(call=>call.input.afterSeq<=2));
  gate.release();await until(()=>a.snapshot({conversationId:'main'}).messages.some(message=>message.text==='A_LATE_REPLY'),'late original A response completed');assert.equal(await page.getByText('A_LATE_REPLY',{exact:true}).count(),0);assert.equal(await page.locator('[data-pending-command="pending-1"]').count(),1);
  const saved=await page.evaluate(keys=>keys.map(key=>JSON.parse(localStorage.getItem(key))),keys);assert.ok(saved[0].some(item=>item.request.commandId==='pending-0'));assert.ok(saved[0].some(item=>item.request.text==='A_LATE_CLASSIFIER'));assert.equal(saved[1][0].request.commandId,'pending-1');
  return {kind:'authority-namespace-real-pagination',verdict:{aStoredRowsBeforeSwitch:100,bStoredRows:2,newAuthorityFullRead:true,oldCursorReset:true,oldKnownIdsCleared:true,bothPendingNamespacesPreserved:true,lateAResponseIgnoredOnB:true},calls};
 }finally{gate.release();await context?.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}for(const h of hosts)await h.dispose();}
}

async function demoFixtureDuringPm(){
 const root=join(output,`demo-pm-guard-${runId}`),preload=join(output,'demo-hold-preload.mjs');
 writeFileSync(preload,`import {ScriptedModel} from ${JSON.stringify(new URL('./scripted-model.mjs',import.meta.url).href)};const original=ScriptedModel.prototype.stream;let release;const gate=new Promise(done=>release=done);process.on('message',message=>{if(message?.kind==='release')release();});ScriptedModel.prototype.stream=async function*(options){if(options.sessionId&&JSON.stringify(options.messages).includes('DEMO_PROJECT_HOLD')){process.send?.({kind:'model-held'});await gate;}yield*original.call(this,options);};`);
 const child=spawn(process.execPath,['--import',preload,'tests/dsh/steward-demo.mjs'],{cwd:process.cwd(),env:{...process.env,DSH_STEWARD_DEMO_MODE:'offline',DSH_STEWARD_DEMO_MEMORY:'0',DSH_STEWARD_DEMO_ROOT:root,DSH_STEWARD_DEMO_PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});let logs='',held=false;child.stdout.on('data',chunk=>logs+=chunk);child.on('message',message=>{if(message.kind==='model-held')held=true;});
 try{
  await until(()=>logs.includes('"url":'),'guard demo boot');const info=JSON.parse(logs.trim().split('\n').find(line=>line.startsWith('{'))),url=new URL(info.url);
  const invoke=async(method,input={})=>{const response=await fetch(new URL(`/api/${method}${url.search}`,url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return {status:response.status,...await response.json()};};
  const snapshot=await invoke('stewardSnapshot',{conversationId:'main'}),[a,b]=snapshot.projects;
  const sentA=await invoke('stewardSend',{conversationId:'main',commandId:'guard-a',text:'DEMO_PROJECT_HOLD',target:{kind:'project',projectId:a.projectId}});assert.equal(sentA.status,200);await until(()=>held,'actual native A model held after admission');
  const rejected=[];for(const method of ['demoRecall','demoLocalTask']){const response=await invoke(method);assert.equal(response.status,400);assert.match(response.error,/mutation is busy/);rejected.push({method,status:response.status,error:response.error});}
  const sentB=await invoke('stewardSend',{conversationId:'main',commandId:'guard-b',text:'B independent while A model held',target:{kind:'project',projectId:b.projectId}});assert.equal(sentB.status,200);
  await until(async()=>{const value=await invoke('stewardReconcile',{conversationId:'main',commandId:'guard-b'});return value.commandMessage?.state.kind==='completed';},'ordinary B completed while fixture guard rejects only fixture actions');
  child.send({kind:'release'});await until(async()=>{const value=await invoke('stewardReconcile',{conversationId:'main',commandId:'guard-a'});return value.commandMessage?.state.kind==='completed';},'A completed after release');
  let recall;await until(async()=>{recall=await invoke('demoRecall');return recall.status===200;},'fixture available after actual PM idle');assert.equal(recall.exactMatch,true);
  return {kind:'demo-fixture-pm-exclusion',verdict:{aAdmittedBeforeNativeCompletion:true,actualNativeModelHeld:true,fixturesRejectedWhilePmRuns:rejected.length,ordinaryBCompletesWhileAHeld:true,fixtureAvailableAfterPmIdle:true},rejected};
 }finally{if(child.connected)child.send({kind:'release'});child.kill('SIGTERM');await Promise.race([new Promise(done=>child.once('exit',done)),delay(10000)]);}
}

let browser;
try{browser=await chromium.launch({headless:true,...(process.env.DSH_BROWSER_CHANNEL?{channel:process.env.DSH_BROWSER_CHANNEL}:{})});if(process.env.DSH_BURST_ONLY_DEMO_GUARD==='1'){const result=await demoFixtureDuringPm();receipt.rounds.push(result);process.stdout.write(JSON.stringify(result.verdict)+'\n');}else if(process.env.DSH_BURST_ONLY_AUTHORITY==='1'){const result=await authoritySwitch(browser);receipt.rounds.push(result);process.stdout.write(JSON.stringify(result.verdict)+'\n');}else for(let index=0;index<5;index++){for(const phase of index%2?['after','baseline']:['baseline','after']){for(const run of [settingsAndUi,originalDemo]){const result=run===settingsAndUi?await run(browser,index,phase):await run(index,phase);receipt.rounds.push(result);process.stdout.write(JSON.stringify({kind:result.kind,index,phase,verdict:result.verdict})+'\n');}}const result=await workerMessages(index);receipt.rounds.push(result);process.stdout.write(JSON.stringify({kind:result.kind,index,verdict:result.verdict})+'\n');}}
catch(error){receipt.errors.push({message:error.message,stack:error.stack});process.exitCode=1;throw error;}
finally{await browser?.close();receipt.loadAfter=loadavg();writeFileSync(join(output,'receipt.json'),JSON.stringify(receipt,null,2));}
