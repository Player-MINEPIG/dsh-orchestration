/** Deterministic generic-history fixture through real official slash commands; no model or PV evidence. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import http from 'node:http';
import {Context} from '@deepseek-ai/cordis';
import {Loader} from '@deepseek-ai/cordis-plugin-loader';
import {SessionId} from '@deepseek-ai/dsh-session';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {fixture} from '../../../packages/task-system/test/fixtures/registration.mjs';
import {validateRegistration,mappedId} from '../../../packages/task-system/dist/project-registration/protocol.js';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const root=resolve(process.env.DSH_RECURSIVE_RUNTIME || join(repo,'.runtime/session-collaboration'));
const rel=relative(join(repo,'.runtime'),root);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Isolated worktree runtime required');
const workspace=join(root,'history-fixture-workspace'),evidence=join(root,'evidence','history-native.json');
mkdirSync(join(workspace,'.dsh'),{recursive:true});mkdirSync(join(root,'evidence'),{recursive:true});
const file=join(workspace,'.dsh','project-registration.json');
const source='100.111.163.32',address='100.123.230.75',port=43972;
const endpoint=`http://${address}:${port}/v1/registrations`;
const snapshotPort=43971;
async function snapshot(){return new Promise((done,fail)=>{
 const req=http.request(`http://${address}:${snapshotPort}/snapshot`,{agent:false,localAddress:source},res=>{
  if(res.statusCode!==200){res.resume();fail(Error(`Snapshot HTTP ${res.statusCode}`));return;}
  const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>8_000_000)res.destroy(Error('Oversized snapshot'));else chunks.push(chunk);});res.on('error',fail);res.on('end',()=>{try{done(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){fail(e);}});
 });req.on('error',fail);req.setTimeout(15000,()=>req.destroy(Error('Snapshot timeout')));
 req.once('socket',socket=>socket.once('connect',()=>{if(socket.remoteAddress!==address||socket.remotePort!==snapshotPort||socket.localAddress!==source){req.destroy(Error('Socket endpoint mismatch'));return;}req.end();}));
});}
let packet;
if(existsSync(file)) packet=validateRegistration(JSON.parse(readFileSync(file,'utf8')));
else{
 packet=fixture();Object.assign(packet,{namespace:'generic-history',projectExternalId:'session-collaboration-generic-history-fixture',mode:'history',observedAt:new Date().toISOString()});
 packet.origin={nodeId:'mbp',harness:'Generic harness deterministic fixture; no real model or PV evidence',workspaceUri:pathToFileURL(workspace).href};
 packet.project={...packet.project,title:'历史协议回归 · 明确标注的测试数据',goal:'通过官方 /project 补录确定性历史fixture，验证统一观察且不执行',state:'completed',nextStep:'中央核对协议回执，不代表真实项目验收'};
 packet.tasks[0]={...packet.tasks[0],title:'历史fixture工作项（未调用模型）',description:'This is generated test evidence, not a real task execution.',state:'completed'};
 packet.runs[0]={...packet.runs[0],state:'succeeded',outcome:'success',sessionIds:[],provider:'deterministic-fixture',evidenceUri:pathToFileURL(file).href};
 packet.reports[0]={...packet.reports[0],title:'确定性历史fixture证据',body:'Fixture only. No model calls, no real PV data, no actual workload execution.',artifactIds:[],evidenceUri:pathToFileURL(file).href};
 packet.artifacts=[];packet.outcomes[0].title='Fixture delivery, awaiting review';
 validateRegistration(packet);writeFileSync(file,JSON.stringify(packet,null,2),{mode:0o600});
}
assert.equal(packet.namespace,'generic-history');assert.equal(packet.mode,'history');
const tokenEnv='DSH_SESSION_HISTORY_TOKEN';process.env[tokenEnv]=readFileSync(join(root,'registration-token'),'utf8').trim();assert(process.env[tokenEnv].length>=24);
const ctx=new Context(),steps=[];let modelCalls=0,handle;
class RejectModel extends LlmAdapter{async *stream(){modelCalls++;throw Error('History commands must not invoke a model');}}
try{
 const before=await snapshot();
 await ctx.plugin(Loader,{baseUrl:pathToFileURL(join(repo,'package.json')).href});
 await ctx.loader.root.update([
  ['llm','@deepseek-ai/dsh-llm'],['sessions','@deepseek-ai/dsh-session'],['projection','@deepseek-ai/dsh-session-projection'],['prompt','@deepseek-ai/dsh-system-prompt'],['tools','@deepseek-ai/dsh-tools'],['agents','@deepseek-ai/dsh-agent'],['loop','@deepseek-ai/dsh-agent-loop',{agents:[]}],['commands','@deepseek-ai/dsh-commands'],
  ['task',pathToFileURL(join(repo,'packages/task-system/dist/dsh-plugin.js')).href,{databasePath:join(root,'history-client.sqlite'),nodeId:'mbp-history-client',role:'executor',keepAlive:false,schedulerEnabled:false,autoExecute:false}],
  ['registration',pathToFileURL(join(repo,'packages/task-system/dist/project-registration/plugin.js')).href,{namespaces:['generic-history'],endpoint,outboxPath:join(root,'history-outbox'),tokenEnv,trustedNetwork:{address,port,localAddress:source,allowHttp:true}}],
 ].map(([id,name,config])=>({id,name,config})));await ctx.loader.await();
 ctx.llm.registerAdapter(['never-invoked'],new RejectModel());
 handle=await ctx.agents.create({sessionId:SessionId('session-generic-history-fixture'),meta:{cwd:workspace},agentOptions:{provider:'never-invoked',model:'none'}});
 for(const command of ['/project preview','/project history']){
  const result=await ctx.commands.execute(handle.agent,command,[],new AbortController().signal);
  assert(result,'Official registry resolves command');steps.push({command,commandId:result.commandId,...result.result});
  assert.equal(result.result.kind,'success',result.result.text);assert(!result.result.text.includes('中央尚未确认'),result.result.text);
 }
 const after=await snapshot();
 const records=after.projectRegistrations.filter(r=>r.namespace===packet.namespace&&r.projectExternalId===packet.projectExternalId);assert.equal(records.length,1);
 const tasks=new Set(packet.tasks.map(t=>mappedId(packet.namespace,packet.projectExternalId,'task',t.externalId)));
 const importedRuns=after.runs.filter(r=>tasks.has(r.taskId));assert.equal(importedRuns.length,packet.runs.length);assert(importedRuns.every(r=>r.observationOnly===true));
 const importedAttempts=after.attempts.filter(a=>tasks.has(a.taskId));assert.equal(importedAttempts.length,0);
 assert.equal(after.attempts.length,before.attempts.length,'No execution attempt added during history commands');
 assert.equal(ctx.taskSystem.ledger.snapshot().projectRegistrations.length,0,'Local client is not another central authority');
 const events=handle.agent.session.snapshotEvents();assert.equal(modelCalls,0);assert.equal(events.filter(e=>e.type==='turn/start'||e.type==='user/message').length,0);
 assert.equal(events.filter(e=>e.type==='command/run').length,2);assert.equal(events.filter(e=>e.type==='command/done').length,2);
 writeFileSync(evidence,JSON.stringify({at:new Date().toISOString(),ok:true,evidenceKind:'deterministic generic-history fixture; NOT real model or PV evidence',officialCommands:true,modelCalls,source,address,endpoint,transport:'Tailscale direct bound socket; no forwarding',centralDatabase:'same coordinator.sqlite as session collaboration',commands:steps,registration:{namespace:records[0].namespace,projectExternalId:records[0].projectExternalId,sourceRevision:records[0].sourceRevision},observedRuns:importedRuns.map(r=>({runId:r.runId,taskId:r.taskId,observationOnly:r.observationOnly})),executionAttempts:0,beforeTotalAttempts:before.attempts.length,afterTotalAttempts:after.attempts.length,commandEvents:4},null,2),{mode:0o600});
 console.log(JSON.stringify({ok:true,commands:2,modelCalls:0,observationOnly:true,newExecutionAttempts:0,evidence}));
}catch(error){writeFileSync(join(root,'evidence','history-native-failure.json'),JSON.stringify({at:new Date().toISOString(),steps,modelCalls,error:{code:error.code??'ERROR',message:error.message}},null,2),{mode:0o600});throw error;}
finally{delete process.env[tokenEnv];if(handle)await handle.dispose();await ctx.fiber.dispose();}
