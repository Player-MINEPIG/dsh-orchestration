import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {join} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
import {SessionMessages} from '../../packages/task-system/dist/remote/session-messages.js';
import {TaskReturnInbox} from '../../packages/task-system/dist/remote/task-return-inbox.js';
import {RemoteClient,RemoteLedgerClient,RemoteGateway,RecoveryStore,IdentityVerifier} from '../../packages/task-system/dist/remote/api.js';

async function until(check,label){
 const end=Date.now()+3000;
 while(!await check()){
  assert.ok(Date.now()<end,label);
  await new Promise(resolve=>setTimeout(resolve,5));
 }
}
async function events(h,id){const reader=await h.ctx.sessionPersistence.open(SessionId(id),'read');try{return(await reader.read()).events;}finally{await reader.close();}}
function completions(h,sessionId){
 const ledger=h.ledger;
 ledger.registerWorkspace('queue-workspace',{workspaceId:'ws',nodeId:'worker',path:h.dir,state:'ready'});
 ledger.registerNode('queue-worker',{nodeId:'worker',roles:['executor'],enabled:true,capabilities:[],models:[{provider:'test-offline',model:'script'}],workspaceIds:['ws'],maxConcurrent:2});
 const req=ledger.executionModels.request('queue-catalog',{nodeId:'worker'}).catalog.request;
 ledger.completeExecutionModels('queue-catalog-result',{nodeId:'worker',requestId:req.requestId,generation:req.generation,result:{state:'success',complete:true,observedAt:Date.now(),models:[{provider:'test-offline',model:'script'}]}});
 const result=[];
 for(let i=0;i<6;i++){
  const task=ledger.createTask('queue-task-'+i,{title:'Completed child '+i,policy:{settlementQuietMs:0}}).value;
  const run=ledger.withDispatchOrigin({kind:'session',nodeId:'local',sessionId,cwd:h.dir,composition:{provider:'test-offline',model:'script',tools:[]}},()=>ledger.createRun('queue-run-'+i,{taskId:task.taskId,route:{nodeId:'worker',workspaceId:'ws',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value);
  const claim=ledger.claim('queue-claim-'+i,{runId:run.runId,nodeId:'worker',ttlMs:10000}).value;
  ledger.submit('queue-finish-'+i,{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,outcome:'success',summary:'Verified result '+i});
  result.push(ledger.history(task.taskId).resultReturns[0]);
 }
 return result;
}

for(const mode of ['host','remote inbox','remote session pump'])test(`six real results enter a busy native session through ${mode} before any completed ACK`,{timeout:15000},async()=>{
 let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false},script:[async()=>{started();await gate;return{name:'task_query',args:{}};},'All six results processed']});
 const resources=[];let pump;const pending=[];
 try{
  const id='six-results-'+mode.replaceAll(' ','-'),parent=await h.ctx.agents.create({sessionId:SessionId(id),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  parent.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Continue working until the next safe step'}]}));await ready;
  const messages=completions(h,id),ledger=h.ledger;
  const counts=()=>parent.agent.inbox.nextStep.filter(input=>input.source.kind==='dsh-task-result').length;
  let poll;
  if(mode==='host')poll=async()=>{h.ctx.taskSystem.tick();};
  else{
   const keys=generateKeyPairSync('ed25519'),server=new RecoveryStore(':memory:'),outbox=new RecoveryStore(':memory:');resources.push(server,outbox);
   const gateway=new RemoteGateway({role:'planner',nodeId:'central',ledger,store:server,verifier:new IdentityVerifier({audience:'central',peers:[{keyId:'key',nodeId:'local',publicKey:keys.publicKey,audience:'central',operations:['sessionMessages','sessionMessageReply'],workspaces:[],capabilities:[]}]})});resources.push(gateway);
   const client=new RemoteClient({endpoint:'https://fixture.invalid/commands',nodeId:'local',audience:'central',keyId:'key',privateKey:keys.privateKey,store:outbox,fetch:async(_url,options)=>new Response(JSON.stringify(await gateway.handle(options.body)))});resources.push(client);
   const remote=new RemoteLedgerClient(client,'local');
   if(mode==='remote inbox'){
    pump=new TaskReturnInbox(remote,'local',(m,signal)=>h.ctx.taskSystem.taskReturns.deliver(m,signal));
    poll=async()=>{pending.push(pump.poll());await new Promise(resolve=>setImmediate(resolve));};
   }else{
    pump=new SessionMessages({ledger:remote,store:{},policy:{nodeId:'local'},provider:{sendSessionMessage(){},sendTaskReturn:(m,signal)=>h.ctx.taskSystem.taskReturns.deliver(m,signal)}});
    poll=()=>pump.poll(1);
   }
  }
  await poll();await until(()=>counts()===4,'first four reports must enter next-step inbox');
  await poll();await until(()=>counts()===6,'later reports must pass the four still-unconsumed reports');
  await poll();await h.ctx.sessions.flush(parent.agent.session);
  assert.equal(counts(),6,'repeat polling does not inject duplicates');
  assert.ok(messages.every(m=>ledger.getSessionMessage(m.messageId).state==='queued'),'durable intake is not a processing-complete ACK');
  assert.equal(ledger.snapshot().runs.length,6,'notification polling never reruns the tasks');
  const durable=await events(h,id);
  for(const message of messages)assert.ok(durable.some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted.some(input=>input.source.kind==='dsh-task-result'&&input.source.eventId===message.messageId)));
  release();await parent.agent.whenIdle();
  if(mode==='host')await h.ctx.taskSystem.returnJob;
  else if(mode==='remote inbox')await Promise.all(pending);
  else await until(()=>messages.every(m=>ledger.getSessionMessage(m.messageId).state==='completed'),'remote processing ACKs');
  assert.ok(messages.every(m=>ledger.getSessionMessage(m.messageId).state==='completed'));
  const completed=await events(h,id);assert.equal(completed.filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-result').length,6);
  const before=h.adapter.requests.length;await poll();assert.equal(h.adapter.requests.length,before,'completed events do not schedule another model turn');
 }finally{
  release?.();await pump?.dispose();await Promise.allSettled(pending);
  for(const r of resources.reverse())await(r.dispose?.()??r.close?.());
  await h.dispose();
 }
});
