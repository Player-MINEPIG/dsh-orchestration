// Isolated real DSH/Typert host for the executor alert page. No external model calls.
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createNativeHarness} from '../dsh/native-harness.mjs';
import {RecoveryStore} from '../../packages/task-system/dist/remote/store.js';
import {RemoteExecutionService,Config} from '../../packages/task-system/dist/remote/index.js';
import * as settings from '../../packages/task-system/dist/settings.js';
const dir=process.env.ALERT_FIXTURE_DIR??'/private/tmp/dsh-executor-alerts/browser-data';mkdirSync(dir,{recursive:true});
const h=await createNativeHarness({dir,config:{role:'both',nodeId:'MBP',schedulerEnabled:false,autoExecute:false}}),store=new RecoveryStore(join(dir,'recovery.sqlite'));
const remote=new RemoteExecutionService(h.ctx,Config({role:'executor',nodeId:'MBP',paused:false,pollIntervalMs:0,workspaces:[]}),h.ledger,store);
const req=createRequire(realpathSync(process.env.DSH_CLI??'/Users/pmp/.local/bin/dsh'));
for(const name of ['@deepseek-ai/dsh-typert-registry','@deepseek-ai/dsh-api-remote-access','@deepseek-ai/dsh-api-gateway'])await(await h.ctx.plugin(req(name).default)).await();
await(await h.ctx.plugin(settings)).await();const {Peer}=req('@deepseek-ai/dsh-client-connection'),peer=new Peer(h.ctx,{principal:{kind:'owner'}});
const row=(id,state,outcome)=>({attemptId:id,state,claim:{task:{taskId:id,title:({blocked:'历史受阻分析',active:'正在执行的本机任务',pending:'结果等待回传'})[id],description:'隔离测试任务，不操作生产。'},run:{runId:'run-'+id,taskId:id,state:'blocked',updatedAt:'2026-10-23T00:00:00Z',route:{nodeId:'MBP'}},attempt:{attemptId:id}},lease:{runId:'run-'+id,attemptId:id,nodeId:'MBP',fence:1},sessionId:'session-'+id,result:{outcome,summary:'保留的原始结果'},receipt:{commandId:'result-'+id,acceptedAt:'2026-10-23T00:00:00Z',value:{}}});
for(const x of [row('blocked','acknowledged','blocked'),row('active','dispatching','unknown'),row('pending','result','blocked')])store.createDispatch(x);
if(!store.outbound('old-claim'))store.saveOutbound('old-claim',{operation:'claim',payload:{runId:'legacy-run'},state:'uncertain',endpoint:'https://old-scheduler.invalid/',audience:'old',receipt:{state:'uncertain'}});
const calls=[],page=readFileSync(new URL('../../packages/task-system/dist/project-page.html',import.meta.url),'utf8');
const server=createServer(async(request,response)=>{
 try{
  if(request.url==='/page'){response.setHeader('content-type','text/html; charset=utf-8');response.end(page);return;}
  if(request.url==='/rpc'&&request.method==='POST'){
   let body='';for await(const chunk of request){body+=chunk;if(body.length>10000)throw Error('Fixture body too large');}
   const {method,input}=JSON.parse(body);if(!['projectSnapshot','setExecutorAlertDisposition'].includes(method))throw Error('Fixture read/mutation denied');
   const value=await h.ctx.typertGateway.invoke({peer,namespace:'taskPluginSettings',method,args:input===undefined?{}:{input}});
   calls.push({method,...(method==='setExecutorAlertDisposition'?{input}:{}),at:new Date().toISOString()});writeFileSync(join(dir,'rpc-calls.json'),JSON.stringify(calls,null,2));
   response.setHeader('content-type','application/json');response.end(JSON.stringify({value}));return;
  }
  response.setHeader('content-type','text/html; charset=utf-8');response.end(`<!doctype html><html><head><title>执行端本机提醒 · 隔离真实 DSH</title><style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style></head><body><iframe src="/page"></iframe><script>addEventListener('message',async event=>{const x=event.data;if(x?.channel!=='dsh-project-runtime'||!x.id)return;try{const result=await(await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:x.method,input:x.method==='projectSnapshot'?{view:'executor'}:x.input})})).json();event.source.postMessage({channel:x.channel,id:x.id,...result},'*');}catch(error){event.source.postMessage({channel:x.channel,id:x.id,error:{message:error.message}},'*');}});</script></body></html>`);
 }catch(error){response.statusCode=400;response.setHeader('content-type','application/json');response.end(JSON.stringify({error:{message:error.message,details:error.details}}));}
});
server.listen(64419,'127.0.0.1',()=>console.log('Real isolated alert page: http://127.0.0.1:64419/'));
let closing=false;for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{if(closing)return;closing=true;server.close();await remote.dispose();await h.dispose();store.close();process.exit(0);});
