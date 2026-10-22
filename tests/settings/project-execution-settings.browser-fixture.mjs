// Isolated real-runtime RPC fixture; drive it through the browser and stop with SIGINT.
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createNativeHarness} from '../dsh/native-harness.mjs';
import {attachWorkspaceRegistry} from './local-workspace-harness.mjs';
import {TaskPluginSettings} from '../../packages/task-system/dist/settings.js';
const h=await createNativeHarness({config:{role:'planner',nodeId:'scheduler',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}}),runtime=h.ctx.taskSystem.projects;
const registry=await attachWorkspaceRegistry(h),dirs=['coordinator-current','coordinator-next','remote-owned-repository'].map(n=>join(h.dir,n));dirs.forEach(d=>mkdirSync(d));
const official=await Promise.all(dirs.slice(0,2).map((d,i)=>registry.create(d,'统筹工作区 '+(i+1))));
const {projectId}=await runtime.create({commandId:'browser-project',title:'项目设置 · 本地验收',goal:'验证统筹会话和执行端授权目录分别保存，保留历史。',workspace:{kind:'registered',nodeId:'scheduler',workspaceId:'registry:'+official[0].id}});
for(const nodeId of ['mbp','not-yet-authorized'])h.ledger.registerNode('node-'+nodeId,{nodeId,roles:['executor'],models:[],capabilities:[],workspaceIds:[],enabled:true,maxConcurrent:1});
h.ledger.recordExecutorWorkspaces('fixture-announcement',{nodeId:'mbp',sampledAt:Date.now(),workspaces:[{workspaceId:'mbp-repo',nodeId:'mbp',path:dirs[2],label:'MBP 已授权仓库',state:'ready'}]});
const settings=Object.assign(Object.create(TaskPluginSettings.prototype),{ctx:h.ctx}),methods=['projectSnapshot','projectExecutionSettings','saveProjectExecutionSettings','projectConversation','conversationModels'];
const html=readFileSync(new URL('../../packages/task-system/dist/project-page.html',import.meta.url),'utf8'),calls=[];
const host=`<!doctype html><html><body style="margin:0"><iframe id="app" src="/page" style="width:100%;height:100dvh;border:0"></iframe><script>const frame=document.getElementById('app');window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.data?.channel!=='dsh-project-runtime')return;const {id,method,input}=event.data;if(method==='detailFullscreen')return;const result=await(await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,input})})).json();event.source.postMessage({channel:'dsh-project-runtime',id,...result},'*');});</script></body></html>`;
const server=createServer(async(req,res)=>{try{if(req.url==='/rpc'){let body='';for await(const part of req)body+=part;const {method,input}=JSON.parse(body);if(!methods.includes(method))throw Error('Unexpected fixture RPC '+method);calls.push({method,input});res.setHeader('content-type','application/json');res.end(JSON.stringify({value:await settings[method](input)}));}else{res.setHeader('content-type','text/html;charset=utf-8');res.end(req.url==='/page'?html:host);}}catch(error){res.end(JSON.stringify({error:error.message,errorCode:error.details?.reason||error.code}));}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port,projectId,fixtureDirectory:h.dir}));
process.on('SIGINT',async()=>{const evidence=process.env.EVIDENCE_DIR||'/private/tmp/dsh-project-execution-settings';mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'browser-runtime-receipt.json'),JSON.stringify({projectId,settings:runtime.executionSettings(projectId),calls,tasks:h.ledger.snapshot().tasks.length},null,2));await new Promise(done=>server.close(done));await h.dispose();process.exit(0);});
