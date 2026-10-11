/** Real official human-command lifecycle against the isolated VPS over Tailscale. No model requests. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import http from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { SessionId } from '@deepseek-ai/dsh-session';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { validateRegistration, mappedId } from '../../../packages/task-system/dist/project-registration/protocol.js';
import { registrationOutboxStatus } from '../../../packages/task-system/dist/project-registration/client.js';
import { fixture } from '../../../packages/task-system/test/fixtures/registration.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const root=resolve(process.env.DSH_RECURSIVE_RUNTIME || join(repo,'.runtime/project-runtime-final'));
const testParent=join(repo,'.runtime');
const rootRelative=relative(testParent,root);
assert(rootRelative && !rootRelative.startsWith('..') && !isAbsolute(rootRelative),'Require isolated checkout .runtime directory');
const source='100.111.163.32', address='100.123.230.75', port=43872;
const endpoint=`http://${address}:${port}/v1/registrations`;
const prepared=join(root,'registration-workspace');
const packetPath=join(prepared,'.dsh/project-registration.json');
const outbox=join(root,'registration-outbox'),evidenceDir=join(root,'evidence');
mkdirSync(join(prepared,'.dsh'),{recursive:true});mkdirSync(evidenceDir,{recursive:true});
const now=()=>new Date().toISOString();
function packet(externalId,title,namespace='mbp-local-live',mode='live'){
 const p=fixture();Object.assign(p,{namespace,projectExternalId:externalId,mode,observedAt:now()});
 p.origin={nodeId:'mbp',harness:'DSH official human commands; deterministic evidence fixture, zero model calls',workspaceUri:pathToFileURL(prepared).href};
 p.project.title=title;p.project.goal='验证本地准备的规范项目通过官方 /project 指令进入原中央面板';
 p.project.nextStep='通过中央任务面板核对来源完成与中央复核';
 p.tasks[0].description='确定性登记验收数据，不声称由模型生成';
 p.reports[0].body='登记验收：项目证据由脚本准备，/project 指令直接发送，模型调用次数为零。';
 p.runs[0].sessionIds=[];p.runs[0].provider='deterministic-fixture';p.runs[0].evidenceUri=pathToFileURL(join(prepared,externalId+'-evidence.json')).href;
 p.reports[0].evidenceUri=p.runs[0].evidenceUri;
 p.artifacts=[];p.reports[0].artifactIds=[];
 if(mode!=='live'){p.project.state='completed';p.tasks[0].state='completed';p.runs[0].state='succeeded';p.runs[0].outcome='success';}
 validateRegistration(p);writeFileSync(join(prepared,externalId+'-evidence.json'),JSON.stringify({kind:'deterministic-registration-acceptance',modelCalls:0}),{mode:0o600});return p;
}
const live=packet('runtime-native-live','本地项目 · 早登记与持续同步');
const p2=structuredClone(live);Object.assign(p2,{revision:2,previousRevision:1,idempotencyKey:'live-r2'});p2.tasks[0].state='completed';p2.runs[0].state='succeeded';p2.runs[0].outcome='success';
const final=structuredClone(p2);Object.assign(final,{revision:3,previousRevision:2,idempotencyKey:'live-r3',mode:'final'});final.project.state='completed';
const finished=packet('runtime-finished-only','本地项目 · 完成后一次性提交','mbp-local-live','final');
const generic=packet('runtime-generic-history','通用协议 · 其他 Harness 历史补录','generic-history','history');generic.origin.harness='Generic harness protocol fixture; zero model calls';
const pvSource=process.env.DSH_PV_PACKET || '/Users/pmp/.codex/worktrees/20e9/dsh-orchestration/.runtime/registration/pv/pv-registration.json';
const pv=validateRegistration(JSON.parse(readFileSync(pvSource,'utf8')));
Object.assign(pv,{namespace:'mbp-pv-history',projectExternalId:'runtime-real-pv-finite-history',idempotencyKey:'pv-finite-r1',mode:'history',revision:1,previousRevision:0,observedAt:now()});
pv.project.title='PV 本地真实项目 · 有限历史补录';
validateRegistration(pv);
for(const [name,p] of Object.entries({live,p2,final,finished,generic,pv})){const file=join(prepared,name+'.json');if(existsSync(file)){const stored=validateRegistration(JSON.parse(readFileSync(file,'utf8')));for(const key of Object.keys(p))delete p[key];Object.assign(p,stored);}else writeFileSync(file,JSON.stringify(p,null,2),{mode:0o600});}
writeFileSync(packetPath,JSON.stringify(live,null,2),{mode:0o600});
const registrationConfig={namespaces:['mbp-local-live','mbp-pv-history','generic-history'],endpoint,outboxPath:outbox,tokenEnv:'DSH_RUNTIME_REGISTRATION_TOKEN',trustedNetwork:{address,port,localAddress:source,allowHttp:true}};
writeFileSync(join(root,'registration-extra-patch.json'),JSON.stringify({insert:[{id:'project-registration',name:'@dsh-task/task-system/project-registration/plugin',config:registrationConfig}]},null,2),{mode:0o600});
if(process.argv.includes('--prepare-only')){console.log(JSON.stringify({prepared,packetPath,extraPatch:join(root,'registration-extra-patch.json'),modelCalls:0}));process.exit(0);}
assert(existsSync(join(root,'registration-token')),'Wait for coordinator test registration token before live execution');
process.env.DSH_RUNTIME_REGISTRATION_TOKEN=readFileSync(join(root,'registration-token'),'utf8').trim();
assert(process.env.DSH_RUNTIME_REGISTRATION_TOKEN.length>=24);
async function getSnapshot(){
 const url=new URL(`http://${address}:43871/snapshot`);
 return await new Promise((resolve,reject)=>{
  const req=http.request(url,{method:'GET',agent:false,localAddress:source,headers:{host:`${address}:43871`}},res=>{
   if(res.statusCode!==200){res.resume();reject(Error('Snapshot HTTP '+res.statusCode));return;}
   const chunks=[];let bytes=0;res.on('data',c=>{bytes+=c.length;if(bytes>8_000_000){res.destroy(Error('Snapshot too large'));return;}chunks.push(c);});
   res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch(e){reject(e)}});res.on('error',reject);
  });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(Error('Snapshot timeout')));
  req.once('socket',socket=>socket.once('connect',()=>{
   if(socket.remoteAddress!==address || socket.remotePort!==43871 || socket.localAddress!==source){req.destroy(Error('Socket endpoint mismatch'));return;}req.end();
  }));
 });
}
const before=await getSnapshot();
const ctx=new Context();let modelRequests=0;
class RejectModel extends LlmAdapter { async *stream(){modelRequests++;throw Error('Human command must never invoke model');} }
const steps=[];
try{
 await ctx.plugin(Loader,{baseUrl:pathToFileURL(join(repo,'package.json')).href});
 await ctx.loader.root.update([
  {id:'llm',name:'@deepseek-ai/dsh-llm'},{id:'sessions',name:'@deepseek-ai/dsh-session'},
  {id:'projection',name:'@deepseek-ai/dsh-session-projection'}, {id:'prompt',name:'@deepseek-ai/dsh-system-prompt'},
  {id:'tools',name:'@deepseek-ai/dsh-tools'},{id:'agents',name:'@deepseek-ai/dsh-agent'},
  {id:'loop',name:'@deepseek-ai/dsh-agent-loop',config:{agents:[]}},{id:'commands',name:'@deepseek-ai/dsh-commands'},
  {id:'task',name:pathToFileURL(join(repo,'packages/task-system/dist/dsh-plugin.js')).href,config:{databasePath:join(root,'registration-local.sqlite'),nodeId:'mbp-command-client',role:'executor',keepAlive:false,schedulerEnabled:false,autoExecute:false}},
  {id:'registration',name:pathToFileURL(join(repo,'packages/task-system/dist/project-registration/plugin.js')).href,config:registrationConfig},
 ]);await ctx.loader.await();
 ctx.llm.registerAdapter(['never-invoked'],new RejectModel());
 const handle=await ctx.agents.create({sessionId:SessionId('runtime-project-native-commands'),meta:{cwd:prepared},agentOptions:{provider:'never-invoked',model:'none'}});
 async function invoke(command,label){
  const execution=await ctx.commands.execute(handle.agent,command,[],new AbortController().signal);
  assert(execution,'Official registry resolves /project');assert.equal(execution.result.kind,'success',execution.result.text);
  if(!['preview','status'].includes(label))assert(!execution.result.text.includes('中央尚未确认'),execution.result.text);
  steps.push({label,command,commandId:execution.commandId,kind:execution.result.kind,text:execution.result.text});return execution.result;
 }
 await invoke('/project preview','preview');
 await invoke('/project register','register');
 writeFileSync(packetPath,JSON.stringify(p2),{mode:0o600});await invoke('/project sync','sync');
 writeFileSync(packetPath,JSON.stringify(final),{mode:0o600});await invoke('/project submit','submit');
 await invoke('/project register '+JSON.stringify(join(prepared,'live.json')),'old-replay');
 await invoke('/project submit '+JSON.stringify(join(prepared,'finished.json')),'finished-only-submit');
 await invoke('/project history '+JSON.stringify(join(prepared,'generic.json')),'generic-history');
 await invoke('/project history '+JSON.stringify(join(prepared,'pv.json')),'pv-real-history');
 const status=JSON.parse((await invoke('/project status','status')).text);
 assert.equal(status.pending.length,0);
 const after=await getSnapshot();const ownIds=[live.projectExternalId,finished.projectExternalId,generic.projectExternalId,pv.projectExternalId];
 const registrations=after.projectRegistrations.filter(r=>ownIds.includes(r.projectExternalId));assert.equal(registrations.length,4);
 assert.equal(registrations.find(r=>r.projectExternalId===live.projectExternalId).sourceRevision,3);
 const importedTasks=new Set(registrations.flatMap(r=>r.packet.tasks.map(t=>mappedId(r.namespace,r.projectExternalId,'task',t.externalId))));
 assert.equal(after.attempts.filter(a=>importedTasks.has(a.taskId)).length,0,'Registration creates no execution attempts');
 assert.equal(after.runs.filter(r=>importedTasks.has(r.taskId)&&!r.observationOnly).length,0,'Registration creates no executable runs');
 assert.equal(ctx.taskSystem.ledger.snapshot().projectRegistrations.length,0,'Execution endpoint is a client, no local scheduler copy');
 const events=handle.agent.session.snapshotEvents();assert.equal(modelRequests,0);
 assert.equal(events.filter(e=>e.type==='turn/start'||e.type==='user/message').length,0);
 assert.equal(events.filter(e=>e.type==='command/run').length,steps.length);assert.equal(events.filter(e=>e.type==='command/done').length,steps.length);
 const evidence={at:now(),transport:'Tailscale direct bound socket; no SSH forwarding',source,address,endpoint,authority:'same coordinator.sqlite as recursive execution',officialCommands:true,modelCalls:modelRequests,
  commandCount:steps.length,commandEvents:events.filter(e=>e.type==='command/run'||e.type==='command/done').length,sourceDefaultProfileChanged:false,registrationExecutionAttempts:0,registrationExecutableRuns:0,allAttemptsUnchanged:after.attempts.length===before.attempts.length,
  counts:{beforeAttempts:before.attempts.length,afterAttempts:after.attempts.length,registrations:registrations.length,observedRuns:after.runs.filter(r=>r.observationOnly).length},
  pv:{scope:'finite real historical text/report packet; no media bytes uploaded; not whole-project final approval',tasks:pv.tasks.length,runs:pv.runs.length,reports:pv.reports.length,artifactReferences:pv.artifacts.length},
  registrations:registrations.map(({packet,...rest})=>rest),status,steps};
 writeFileSync(join(evidenceDir,'registration-native.json'),JSON.stringify(evidence,null,2),{mode:0o600});
 writeFileSync(join(evidenceDir,'unified-snapshot.json'),JSON.stringify(after,null,2),{mode:0o600});
 console.log(JSON.stringify({ok:true,commands:steps.length,registrations:registrations.length,modelCalls:0,registrationExecutionAttempts:0,allAttemptsUnchanged:after.attempts.length===before.attempts.length,evidence:join(evidenceDir,'registration-native.json')}));
}catch(error){writeFileSync(join(evidenceDir,'registration-failure.json'),JSON.stringify({at:now(),transport:'Tailscale direct',completedSteps:steps,modelRequests,status:registrationOutboxStatus(outbox),error:{code:error.code??'ERROR',message:error.message}},null,2),{mode:0o600});throw error;}finally{delete process.env.DSH_RUNTIME_REGISTRATION_TOKEN;await ctx.fiber.dispose();}
