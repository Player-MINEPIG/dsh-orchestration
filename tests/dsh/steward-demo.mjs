import {createServer} from 'node:http';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createNativeHarness} from './native-harness.mjs';
import {ScriptedModel} from './scripted-model.mjs';
import {attachLiveProvider,readLiveProviderRoute,attachOfficialCompaction} from './steward-live-provider.mjs';
import {mountStewardMemory,stewardMemoryAvailable} from './fixtures/steward-memory-host.mjs';

const liveMode=process.env.DSH_STEWARD_DEMO_MODE==='live';
const withMemory=process.env.DSH_STEWARD_DEMO_MEMORY==='1'||liveMode;
const route=liveMode?await readLiveProviderRoute():{provider:'test-offline',model:'script'};
const root=resolve(process.env.DSH_STEWARD_DEMO_ROOT ?? (liveMode?'.runtime/steward-demo-live':withMemory?'.runtime/steward-demo-memory':'.runtime/steward-demo'));
mkdirSync(root,{recursive:true});
const h=await createNativeHarness({dir:root,executionRoot:true,config:{role:'both',schedulerEnabled:false,autoExecute:false,projectAgentOptions:route,localNode:{models:route?[{provider:route.provider,model:route.model,reasoningEfforts:[]}]:[],capabilities:[],workspaceIds:[],enabled:true}}});
const task=h.ctx.taskSystem, projects=task.projects, service=task.steward;
const live=liveMode?await attachLiveProvider(h.ctx,{isolatedRoot:root,maxOutputTokens:512,maxRequests:120}):null;
let memoryStatus=withMemory?'pinned-sources-unavailable':'not-mounted',compactionStatus='not-mounted';
if(withMemory&&stewardMemoryAvailable){await mountStewardMemory(h);memoryStatus='mounted-not-delegated';}
if(live?.configured){await attachOfficialCompaction(h.ctx,{config:{auto:true,headroomTokens:1024,retainTokens:4096,maxTokens:512}});compactionStatus='official-auto';}
if(!projects.settings().root) projects.saveSettings({root:join(root,'projects'),expectedRevision:projects.settings().revision});
if(!liveMode||live?.configured)for(const [id,title,goal] of [['demo-a','A 项目','A_ONLY_GOAL'],['demo-b','B 项目','B_ONLY_GOAL']]) await projects.create({commandId:id,title,goal});
const token=randomUUID(),states={mode:liveMode?'live-provider':'scripted-offline',runtime:'actual DSH Loader / AgentLoop / SessionPersistence',root,memory:memoryStatus,compaction:compactionStatus,provider:live?.metadata??null,diagnostic:liveMode&&!live?.configured?live?.reason:null};
const demoLabel=liveMode?`隔离本机演示 · ${live?.configured?`真实模型 ${live.metadata.providerId} / ${live.metadata.model} · 每次最多512输出token，最多120次模型请求`:`真实模型未配置：${live?.reason}`} · 仅内存复用既有配置，不修改生产档案`:'隔离本机演示 · 离线脚本模型 · 真实 DSH 会话与 SQLite 路由 · 未接入生产凭据';
const echo=options=>{
  const latest=[...options.messages].reverse().find(message=>message.role==='user'&&message.source?.kind!=='runtime-context');
  const text=(latest?.content.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'').split('\n[用户明确分享的一段历史原文')[0].trim();
  return `离线脚本回复：${text}\n\n此回复由测试模型产生；原生会话、路由与任务记录由真实 DSH 处理。`;
};
// Resolve each fixture response from its actual request, never from an enqueue on HTTP retry.
let localJob=null, recallJob=null, mutation=false, sends=0, dropNextSend=process.env.DSH_STEWARD_DEMO_DROP_FIRST_SEND==='1';
h.ctx.on('tools/result',(exec,result)=>{
  if(recallJob&&exec.name==='steward_recall'&&exec.agent?.id===recallJob.sessionId){
    if(result.isError)recallJob.error=JSON.stringify(result.content);
    else {
      recallJob.last=JSON.parse(result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'));
      if(recallJob.last.kind==='steward-scoped-message')recallJob.pages.push(recallJob.last);
    }
  }
});
h.adapter.stream=async function* (options) {
  this.requests.push(options);
  const text=JSON.stringify(options.messages);
  let response=echo(options);
  if(options.messages[0]?.source?.kind==='dsh-steward-route-classifier') {
    const route=JSON.parse(options.messages[0].content.find(part=>part.type==='text').text);
    const matches=route.projects.filter(project=>route.text.includes(project.title));
    response=JSON.stringify(/闲聊|散心|聊点别的/.test(route.text)?{kind:'route',target:{kind:'personal'}}:matches.length===1?{kind:'route',target:{kind:'project',projectId:matches[0].projectId}}:{kind:'clarification',question:'离线分流脚本未识别明确对象，请选择闲聊或项目。'});
  }
  else if(recallJob&&options.sessionId===recallJob.sessionId&&text.includes(recallJob.marker)){
    if(recallJob.error)throw Error(recallJob.error);
    const result=recallJob.last;
    const pointer=!result?null:result.kind==='steward-scoped-history'?result.items.find(item=>item.messageId===recallJob.messageId)?.lookup:result.next;
    if(!result)response={name:'steward_recall',args:{query:recallJob.marker,limit:3}};
    else if(pointer){const {tool:_tool,...args}=pointer;response={name:'steward_recall',args};}
    else if(result.kind==='steward-scoped-message')response=`离线续读验证：已沿真实工具指针读取 ${recallJob.pages.length} 页，尾部为 ${recallJob.pages.at(-1).content.slice(-60)}。此结果验证接口，不证明真实模型记忆能力。`;
    else throw Error('Scoped history did not return the seeded message');
  }
  else if(options.tools?.some(tool=>tool.name==='task_submit_result')) response={name:'task_submit_result',args:{outcome:'success',summary:'离线模型完成本机原生执行链',reportTitle:'本机原生执行证据',reportBody:'真实 TaskLedger claim → native AgentLoop → task_submit_result；业务内容为离线脚本，不证明真实模型质量。'}};
  else if(localJob&&text.includes(localJob.marker)) {
    if(localJob.dispatched)response='本机验证任务已登记，等待本机执行器。';
    else {
      const match=text.match(/commandId=\\"(project-message:[^\\"]+)\\"/);
      if(!match)throw Error('Managed PM command identity was not present');
      localJob.dispatched=true;
      response={name:'task_dispatch',args:{commandId:match[1],title:localJob.title,description:'Return the explicit offline native fixture report',nodeId:'local'}};
    }
  }
  yield* new ScriptedModel([response]).stream(options);
};
async function waitCommand(commandId) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {
    const snapshot=await service.reconcile({conversationId:'main'});
    const user=snapshot.messages.find(message=>message.commandId===commandId);
    if(user&&['completed','rejected','needs-reconciliation'].includes(user.state.kind))return snapshot;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('Demo native turn remains unconfirmed; reconcile before another mutation');
}
const assets={
  '/react.js':readFileSync(new URL('../../node_modules/react/umd/react.development.js',import.meta.url)),
  '/react-dom.js':readFileSync(new URL('../../node_modules/react-dom/umd/react-dom.development.js',import.meta.url)),
  '/steward-client.js':readFileSync(new URL('../../packages/task-system/src/steward-client.js',import.meta.url)),
};
const page=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>管家 · 隔离本机演示</title><style>html,body,#root{height:100%;margin:0}body{background:#181b20;color:#ddd}button,select,textarea{color-scheme:dark}</style><div style="position:fixed;right:16px;top:10px;z-index:5;font:12px system-ui"><button id="local-task" ${liveMode?'disabled title="此按钮仅验证离线任务夹具；真实模型通过聊天使用实际工具"':''}>本机任务链验证</button> <button id="recall-proof" ${liveMode?'disabled':''}>长消息续读验证</button> <a style="color:#9fd7ca" href="/evidence?token=${token}" target="_blank">查看隔离证据</a><span id="local-task-status"></span></div><div id="root"></div><script src="/react.js?token=${token}"></script><script src="/react-dom.js?token=${token}"></script><script src="/steward-client.js?token=${token}"></script><script>const invoke=async(method,input)=>{const response=await fetch('/api/'+method+'?token=${token}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{code:value.code,details:value.details});return value;};document.getElementById('local-task').onclick=async()=>{const button=document.getElementById('local-task');button.disabled=true;try{const result=await invoke('demoLocalTask',{});document.getElementById('local-task-status').textContent=' '+result.state+' · '+result.taskId;}catch(error){document.getElementById('local-task-status').textContent=error.message;}finally{button.disabled=false;}};document.getElementById('recall-proof').onclick=async()=>{const button=document.getElementById('recall-proof');button.disabled=true;try{const result=await invoke('demoRecall',{});document.getElementById('local-task-status').textContent=' 全文一致 · '+result.pages.length+' 页 · '+result.totalBytes+' UTF-8字节';}catch(error){document.getElementById('local-task-status').textContent=error.message;}finally{button.disabled=false;}};const {StewardPanel}=createStewardClient(React);ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(StewardPanel,{invoke,demoLabel:${JSON.stringify(demoLabel).replace(/</g,'\\u003c')},openSession:id=>alert('真实原生会话 ID：'+id)}));</script></html>`;
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  let rpcPath='',rpcInput;
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    const supplied=Buffer.from(url.searchParams.get('token')??''),expected=Buffer.from(token);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)) {res.writeHead(403);res.end('Demo token required');return;}
    if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw Error('Cross-origin request refused');
    if(req.method==='GET'&&url.pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(page);return;}
    if(req.method==='GET'&&assets[url.pathname]){res.setHeader('content-type','text/javascript; charset=utf-8');res.end(assets[url.pathname]);return;}
    if(req.method==='GET'&&url.pathname==='/evidence'){res.setHeader('content-type','application/json');res.end(JSON.stringify({...states,liveStats:live?.stats??null,requestObservations:service.snapshot({conversationId:'main'}).requests,requests:liveMode?undefined:h.adapter.requests.map(request=>({sessionId:request.sessionId,messages:request.messages})),tasks:h.ledger.snapshot().tasks},null,2));return;}
    if(req.method!=='POST')throw Error('Unknown demo route');
    let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw Error('Request too large');}
    const input=JSON.parse(body||'{}');rpcPath=url.pathname;rpcInput=input;let value;
    if(url.pathname==='/api/stewardSnapshot')value=await service.snapshot(input);
    else if(url.pathname==='/api/stewardReconcile')value=await service.reconcile(input);
    else if(url.pathname==='/api/stewardResolve')value=await service.resolve(input);
    else if(url.pathname==='/api/stewardMemoryRead')value=await service.memoryConfiguration(input);
    else if(url.pathname==='/api/stewardMemoryConfigure')value=await service.configureMemory(input);
    else if(url.pathname==='/api/stewardGateRead')value=service.gateRead(input);
    else if(url.pathname==='/api/stewardGateArm')value=service.gateArm(input);
    else if(url.pathname==='/api/stewardGateDecide')value=service.gateDecide(input);
    else if(url.pathname==='/api/stewardGateAmend')value=service.gateAmend(input);
    else if(url.pathname==='/api/stewardGateContinue')value=await service.gateContinue(input);
    else if(url.pathname==='/api/stewardGateAcceptContinue')value=await service.gateAcceptContinue(input);
    else if(url.pathname==='/api/stewardGateIndependent')value=await service.gateIndependent(input);
    else if(url.pathname==='/api/stewardSend'){
      if(mutation)throw Error('Demo mutation is busy; this request was not admitted');
      sends++;try{value=await service.send(input);if(dropNextSend){dropNextSend=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Synthetic gateway lost the original application acknowledgement'}));return;}}finally{sends--;}
    }
    else if(url.pathname==='/api/demoRecall'){
      if(liveMode)throw Object.assign(Error('Recall proof uses the explicitly offline fixture'),{code:'DEMO_OFFLINE_ONLY'});
      if(mutation||sends||service.active)throw Error('Demo mutation is busy; this request was not admitted');
      mutation=true;try{
        const command=randomUUID(),marker=`DEMO_SPILL_${command}`,tail=`EXACT_TAIL_${command}`;
        const original=`${marker}\n${'中文😀'.repeat(1800)}\0${tail}`;
        await service.send({conversationId:'main',commandId:`recall-seed-${command}`,text:original,target:{kind:'personal'}});
        const seeded=await waitCommand(`recall-seed-${command}`),user=seeded.messages.find(message=>message.commandId===`recall-seed-${command}`);
        recallJob={marker,sessionId:user.source.sessionId,messageId:user.id,pages:[],last:null};
        await service.send({conversationId:'main',commandId:`recall-proof-${command}`,text:`验证此前长消息的完整尾部。 ${marker}`,target:{kind:'personal'}});
        await waitCommand(`recall-proof-${command}`);
        const recovered=recallJob.pages.map(page=>page.content).join('');
        value={mode:'scripted-offline',runtime:states.runtime,messageId:user.id,sessionId:user.source.sessionId,
          exactMatch:recovered===original,tailPresent:recovered.endsWith(tail),tail,totalBytes:Buffer.byteLength(original),
          coordinate:'utf-8-bytes',pages:recallJob.pages.map(page=>({offset:page.offset,nextOffset:page.nextOffset,bytes:Buffer.byteLength(page.content),revision:page.source.revision})),
          modelQualityVerified:false};
        if(!value.exactMatch||!value.tailPresent)throw Error('Native recall pages did not reconstruct the exact seeded text');
        states.recall=value;writeFileSync(join(root,'recall-evidence.json'),JSON.stringify(value,null,2));
      }finally{recallJob=null;mutation=false;}
    }
    else if(url.pathname==='/api/demoLocalTask'){
      if(liveMode)throw Object.assign(Error('This deterministic task-chain button is available only in the explicitly offline fixture'),{code:'DEMO_OFFLINE_ONLY'});
      if(mutation||sends||service.active)throw Error('Demo mutation is busy; this request was not admitted');
      mutation=true;try{
      const command=randomUUID(),title=`本机原生执行验证 ${command.slice(0,8)}`;
      h.ledger.registerNode(`demo-node-${command}`,{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
      const catalogRequest=h.ledger.executionModels.request(`demo-catalog-${command}`,{nodeId:'local'}).catalog.request;
      const catalog=h.ledger.completeExecutionModels(`demo-catalog-result-${command}`,{nodeId:'local',requestId:catalogRequest.requestId,generation:catalogRequest.generation,result:{state:'success',complete:true,observedAt:Date.now(),temporaryWorkspaceReady:true,models:[{provider:'test-offline',model:'script'}]}}).value;
      h.ledger.executionModels.setDefault(`demo-default-${command}`,{nodeId:'local',expectedRevision:catalog.policy.revision,expectedCatalogRevision:catalog.catalog.positiveSnapshot.revision,choice:{provider:'test-offline',model:'script'}});
      h.ledger.recordNodeHeartbeat(`demo-ready-${command}`,{nodeId:'local',runtimeReady:true,activeExecutions:0});
      const project=projects.snapshot().projects.find(project=>project.title==='A 项目');
      if(!project)throw Error('Demo project A is unavailable');
      localJob={marker:`DEMO_LOCAL_TASK_${command}`,title,dispatched:false};
      await service.send({conversationId:'main',commandId:`demo-dispatch-${command}`,text:`执行一次本机离线原生任务链验证。 ${localJob.marker}`,target:{kind:'project',projectId:project.id}});
      const deadline=Date.now()+10000;
      let taskRecord,run;
      while(Date.now()<deadline){
        projects.tick();await service.reconcile({conversationId:'main'});
        taskRecord=h.ledger.snapshot().tasks.find(task=>task.title===title);
        run=taskRecord&&h.ledger.history(taskRecord.taskId).runs.at(-1);
        const user=service.snapshot({conversationId:'main'}).messages.find(message=>message.commandId===`demo-dispatch-${command}`);
        if(run&&user?.state.kind==='completed')break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      if(!taskRecord||!run)throw Error('PM did not admit a local Run');
      const claim=h.ledger.claim(`demo-claim-${command}`,{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
      const result=await task.native.execute(claim);value={taskId:taskRecord.taskId,runId:run.runId,state:result.run.state,sessionId:result.sessionId,reports:h.ledger.history(taskRecord.taskId).reports};states.localExecution=value;
      writeFileSync(join(root,'local-execution.json'),JSON.stringify(value,null,2));
      }finally{localJob=null;mutation=false;}
    } else throw Error('Unknown demo RPC');
    res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
  }catch(error){
    const details={reason:error.code,detail:error.message};
    if(rpcPath==='/api/stewardSend'&&rpcInput?.conversationId&&rpcInput?.commandId)details.admission=service.commandStatus(rpcInput.conversationId,rpcInput.commandId);
    const kinds={stewardGateArm:'simple',stewardGateDecide:'simple',stewardGateAmend:'simple',stewardGateContinue:'continue',stewardGateAcceptContinue:'accept-continue',stewardGateIndependent:'independent'};
    const kind=kinds[rpcPath.slice(5)];if(kind&&rpcInput?.commandId)details.actionOutcome=service.humanActionApplied(rpcInput.commandId,kind)?'may-have-applied':'not-applied';
    res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message,code:error.code,details}));
  }
});
await new Promise(done=>server.listen(Number(process.env.DSH_STEWARD_DEMO_PORT??0),'127.0.0.1',done));
const url=`http://127.0.0.1:${server.address().port}/?token=${token}`;
writeFileSync(join(root,'demo.json'),JSON.stringify({...states,url,evidenceUrl:url.replace('/?','/evidence?')},null,2));
process.stdout.write(JSON.stringify({...states,url,evidenceUrl:url.replace('/?','/evidence?')})+'\n');
async function stop(){await live?.dispose();server.closeAllConnections();await new Promise(done=>server.close(done));await h.dispose();}
process.once('SIGINT',()=>void stop().then(()=>process.exit()));process.once('SIGTERM',()=>void stop().then(()=>process.exit()));
