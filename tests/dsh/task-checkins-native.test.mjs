import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage,ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
import {TaskReturnDelivery} from '../../packages/task-system/dist/task-returns.js';
import {TaskReturnInbox} from '../../packages/task-system/dist/remote/task-return-inbox.js';
import {RemoteClient,RemoteLedgerClient,RemoteGateway,RecoveryStore,IdentityVerifier} from '../../packages/task-system/dist/remote/api.js';
let seq=0;
async function call(h,agent,name,args){const result=await h.ctx.tools.execute({name,arguments:args,callId:ToolCallId('checkin-'+ ++seq),agent,signal:new AbortController().signal});assert.equal(result.isError,false,JSON.stringify(result.error));return result.value;}
async function events(h,id){const handle=await h.ctx.sessionPersistence.open(SessionId(id),'read');try{return(await handle.read()).events;}finally{await handle.close();}}
async function draft(h,id){const handle=await h.ctx.agents.create({sessionId:SessionId(id),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});await call(h,handle.agent,'task_create',{commandId:'draft-'+id,title:'Task '+id});return{handle,task:h.ledger.snapshot().tasks.find(task=>task.title==='Task '+id)};}

test('a Run completing during the final deadline refresh withdraws without steering or a false failed ACK',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});let delivery;
 try{
  const {handle,task}=await draft(h,'completed-at-admission');let clock=Date.now();h.ledger.clock=()=>clock;
  h.ledger.registerNode('worker',{nodeId:'worker',roles:['executor'],enabled:true,models:[{provider:'test-offline',model:'script'}],workspaceIds:[],capabilities:[],maxConcurrent:1});
  const catalog=h.ledger.executionModels.request('catalog',{nodeId:'worker'}).catalog.request;h.ledger.completeExecutionModels('catalog-result',{nodeId:'worker',requestId:catalog.requestId,generation:catalog.generation,result:{state:'success',complete:true,observedAt:clock,models:[{provider:'test-offline',model:'script'}]}});
  const run=h.ledger.withDispatchOrigin(task.dispatchOrigin,()=>h.ledger.createRun('bounded',{taskId:task.taskId,expectedExecutionMs:1000,route:{nodeId:'worker',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value),claim=h.ledger.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:60000}).value,ref={runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:'work'};
  h.ledger.markRunning('prepare',ref);h.ledger.markExecutionStarted('actual',ref);clock+=1000;h.ledger.checkins.tick();const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];let refreshes=0;
  delivery=new TaskReturnDelivery(h.ctx,async current=>{if(++refreshes===2){h.ledger.submit('done',{...ref,outcome:'success',summary:'Finished before admission'});h.ledger.checkins.tick();}const refreshed=h.ledger.pendingSessionMessages('local',{messageId:current.messageId,forAdmission:true})[0];return refreshed?.admission==='obsolete'?'obsolete':refreshed?.admission==='defer'?undefined:refreshed;});
  const receipt=await delivery.deliver(message);assert.equal(receipt.withdrawn,true);h.ledger.completeSessionMessage('withdrawn-ack',{nodeId:'local',messageId:message.messageId,state:'completed',...receipt});assert.equal(h.ledger.getSessionMessage(message.messageId).withdrawn,true);assert.equal(h.adapter.requests.length,0);assert.equal((await events(h,String(handle.agent.id))).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,0);assert.equal(h.ledger.getRun(run.runId).state,'succeeded');
 }finally{await delivery?.dispose();await h.dispose();}
});
function remote(h){
 h.ledger.registerNode("remote-local",{nodeId:"local",roles:["planner"],enabled:true,models:[],capabilities:[],workspaceIds:[],maxConcurrent:1});
 const keys=generateKeyPairSync('ed25519'),server=new RecoveryStore(':memory:'),outbox=new RecoveryStore(':memory:');
 const gateway=new RemoteGateway({role:'planner',nodeId:'central',ledger:h.ledger,store:server,verifier:new IdentityVerifier({audience:'central',peers:[{keyId:'key',nodeId:'local',publicKey:keys.publicKey,audience:'central',operations:['sessionMessages','sessionMessageReply','projectCollaborate'],workspaces:[],capabilities:[]}]})});
 const client=new RemoteClient({endpoint:'https://fixture.invalid/commands',nodeId:'local',audience:'central',keyId:'key',privateKey:keys.privateKey,store:outbox,fetch:async(_url,options)=>new Response(JSON.stringify(await gateway.handle(options.body)))});
 return{ledger:new RemoteLedgerClient(client,'local'),async dispose(){await client.dispose();await gateway.dispose();outbox.close();server.close();}};
}

test('a real cold original session processes a distinct draft check-in, records progress and replays without another turn',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});
 try{
  const {handle,task}=await draft(h,'cold-checkin');assert.ok(task.dispatchOrigin.composition.tools.includes("task_checkin"));h.ledger.checkins.request('manual',task.taskId);const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];await h.ctx.sessions.flush(handle.agent.session);await handle.dispose();
  const nextCheckAt=new Date(Date.now()+60000).toISOString();h.adapter.script.push({name:'task_checkin',args:{action:'update',commandId:'progress',taskId:task.taskId,observation:'waiting_external',summary:'Verified external condition; check later',plan:{kind:'scheduled',nextCheckAt}}},'Progress recorded');
  const receipt=await h.ctx.taskSystem.taskReturns.deliver(message);h.ledger.completeSessionMessage('ack',{nodeId:'local',messageId:message.messageId,state:'completed',...receipt});
  assert.equal(h.ledger.checkins.view(task.taskId).nextCheckAt,nextCheckAt);assert.equal(h.ledger.getTask(task.taskId).state,'ready');assert.equal(h.ledger.snapshot().runs.length,0);
  const before=h.adapter.requests.length;await h.ctx.taskSystem.taskReturns.deliver(message);assert.equal(h.adapter.requests.length,before);assert.equal((await events(h,'cold-checkin')).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,1);
 }finally{await h.dispose();}
});

test('busy responsible turn defers a check without steering, model calls or delivery budget consumption',async()=>{
 let started,release;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false},script:[async()=>{started();await gate;return'Current work done';},'Progress reviewed']});
 try{
  const {handle,task}=await draft(h,'busy-checkin');handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Actual current work'}]}));await ready;
  h.ledger.checkins.request('manual',task.taskId);const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];h.ctx.taskSystem.tick();await h.ctx.taskSystem.returnJob;
  assert.equal(h.adapter.requests.length,1);assert.equal(handle.agent.inbox.nextTurn.length+handle.agent.inbox.nextStep.length,0);assert.equal(h.ledger.checkins.view(task.taskId).deliveryFailures,0);assert.equal(h.ledger.getSessionMessage(message.messageId).deliveryAttempts,undefined);
  release();await handle.agent.whenIdle();h.ledger.clock=()=>Date.now()+60001;await h.ctx.taskSystem.taskReturns.deliver(message);assert.equal((await events(h,'busy-checkin')).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,1);
 }finally{release?.();await h.dispose();}
});

test('remote continuation envelope and exact owner update work without a project binding or execution workspace grant',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});let transport,pump,delivery;
 try{
  const {handle,task}=await draft(h,'remote-checkin');h.ledger.checkins.request('manual',task.taskId);await h.ctx.sessions.flush(handle.agent.session);await handle.dispose();transport=remote(h);
  const nextCheckAt=new Date(Date.now()+60000).toISOString();h.adapter.script.push('Checked remote request');
  delivery=new TaskReturnDelivery(h.ctx,async message=>(await transport.ledger.pendingSessionMessages('local',{kind:'continuation',messageId:message.messageId}))[0]);
  pump=new TaskReturnInbox(transport.ledger,'local',(message,signal)=>delivery.deliver(message,signal));await pump.poll();
  assert.equal(h.ledger.checkins.view(task.taskId).pendingMessageId,null);assert.equal((await events(h,'remote-checkin')).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,1);
  const response=await transport.ledger.projectCollaborate('local','update-remote',{action:'session',sessionId:'remote-checkin',cwd:h.dir,command:{kind:'checkin',input:{action:'update',commandId:'progress',taskId:task.taskId,observation:'waiting_external',summary:'Verified through authenticated remote authority',plan:{kind:'scheduled',nextCheckAt}}}});
  assert.equal(response.confirmed,true);assert.equal(h.ledger.checkins.view(task.taskId).nextCheckAt,nextCheckAt);
  await assert.rejects(transport.ledger.projectCollaborate('local','forged-owner',{action:'session',sessionId:'other-session',cwd:h.dir,command:{kind:'checkin',input:{action:'request',commandId:'forged',taskId:task.taskId}}}));
 }finally{await pump?.dispose();await delivery?.dispose();await transport?.dispose();await h.dispose();}
});

test('existing-agent model mismatch is visible and never overwrites its selected provider',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});
 try{
  const {handle,task}=await draft(h,'model-checkin');const stored=h.ledger.getTask(task.taskId);stored.dispatchOrigin.composition.model='different-model';h.ledger.managementDatabase().prepare("UPDATE entities SET data=? WHERE kind='task' AND id=?").run(JSON.stringify(stored),task.taskId);h.ledger.checkins.request('manual',task.taskId);const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];
  await assert.rejects(h.ctx.taskSystem.taskReturns.deliver(message),e=>e.code==='CHECKIN_COMPOSITION_UNAVAILABLE');assert.equal(handle.agent.options.model,'script');assert.equal(h.adapter.requests.length,0);
 }finally{await h.dispose();}
});


test('a user turn starting during final authority refresh cannot receive an injected check-in',async()=>{
 let started,release;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false},script:[async()=>{started();await gate;return'User work';}]});let delivery;
 try{
  const {handle,task}=await draft(h,'admission-race');h.ledger.checkins.request('manual',task.taskId);const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];let refreshes=0;
  delivery=new TaskReturnDelivery(h.ctx,async current=>{if(++refreshes===2){handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'New actual user turn'}]}));await ready;}return current;});
  await assert.rejects(delivery.deliver(message),e=>e.code==='CHECKIN_BUSY');assert.equal(h.adapter.requests.length,1);assert.equal(handle.agent.inbox.nextTurn.length+handle.agent.inbox.nextStep.length,0);assert.equal((await events(h,'admission-race')).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,0);release();await handle.agent.whenIdle();
 }finally{release?.();await delivery?.dispose();await h.dispose();}
});
