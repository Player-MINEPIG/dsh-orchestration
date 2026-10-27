import test from 'node:test';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../../dist/ledger.js';
import {SessionMessages} from '../../dist/remote/session-messages.js';
import {RemoteClient,RemoteLedgerClient,RemoteGateway,RecoveryStore,IdentityVerifier,TrustedNetworkVerifier,ExecutorWorker,httpHandler} from '../../dist/remote/api.js';

for(const mode of ['ed25519','trusted-network'])test(`${mode} fenced workload start, delegation, admission refresh and withdrawal preserve exact event semantics`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'execution-protocol-'));let clock=Date.now();const l=TaskLedger.open(join(dir,'tasks.sqlite'),{role:'both',nodeId:'central',now:()=>clock}),server=new RecoveryStore(':memory:'),outbox=new RecoveryStore(':memory:');
 const operations=['claim','markRunning','bindSession','delegate','sessionMessages','sessionMessageReply'];
 l.registerNode('node',{nodeId:'worker',roles:['executor'],enabled:true,models:[{provider:'offline',model:'script'}],workspaceIds:['ws'],capabilities:[],maxConcurrent:4});l.registerWorkspace('ws',{workspaceId:'ws',nodeId:'worker',path:dir,state:'ready'});
 const request=l.executionModels.request('catalog',{nodeId:'worker'}).catalog.request;l.completeExecutionModels('catalog-result',{nodeId:'worker',requestId:request.requestId,generation:request.generation,result:{state:'success',complete:true,observedAt:clock,models:[{provider:'offline',model:'script'}]}});
 const keys=generateKeyPairSync('ed25519'),peer={nodeId:'worker',audience:'central',operations,workspaces:['ws'],capabilities:[]};
 let gateway;const httpServer=mode==='trusted-network'?createServer((req,res)=>httpHandler(gateway,{trustedNetwork:network})(req,res)):undefined;if(httpServer)await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));const port=httpServer?.address().port??49152;
 const network={listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1'],peers:[{...peer,address:'127.0.0.1',role:'executor'}]};
 const verifier=mode==='ed25519'?new IdentityVerifier({audience:'central',peers:[{...peer,keyId:'key',publicKey:keys.publicKey}]}):new TrustedNetworkVerifier({audience:'central',...network});
 gateway=new RemoteGateway({role:'planner',nodeId:'central',ledger:l,store:server,verifier});
 const client=new RemoteClient({authMode:mode,endpoint:mode==='ed25519'?'https://fixture.invalid/commands':`http://127.0.0.1:${port}/commands`,nodeId:'worker',audience:'central',store:outbox,...(mode==='trusted-network'?{trustedNetwork:{address:'127.0.0.1',port,localAddress:'127.0.0.1',allowHttp:true}}:{keyId:'key',privateKey:keys.privateKey,fetch:async(_url,options)=>new Response(JSON.stringify(await gateway.handle(options.body)))})}),remote=new RemoteLedgerClient(client,'worker');
 t.after(async()=>{await client.dispose();await gateway.dispose();if(httpServer)await new Promise(resolve=>httpServer.close(resolve));outbox.close();server.close();l.close();rmSync(dir,{recursive:true,force:true});});
 const origin={kind:'session',nodeId:'worker',sessionId:'dispatcher',cwd:dir,composition:{provider:'offline',model:'script',tools:[]}},task=l.withDispatchOrigin(origin,()=>l.createTask('task',{title:'Bounded root',policy:{settlementQuietMs:0}}).value),run=l.withDispatchOrigin(origin,()=>l.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',workspaceId:'ws',provider:'offline',model:'script',requiredCapabilities:[]},expectedExecutionMs:1000}).value);
 const claim=(await remote.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:60000})).value,ref={runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:'owned-execution'};
 await remote.markRunning('running',ref);clock+=10000;l.checkins.tick();assert.equal(l.sessionMessages(task.taskId).length,0);
 await assert.rejects(remote.markExecutionStarted('forged-start',{...ref,executionId:'other'}));await remote.markExecutionStarted('actual-start',ref);const started=l.getRun(run.runId).executionExpectation.startedAt;clock+=1000;await remote.markExecutionStarted('duplicate-start',ref);assert.equal(l.getRun(run.runId).executionExpectation.startedAt,started);
 await remote.bindSession('bind',{...ref,sessionId:'executor-session'});const child=(await remote.delegateTask('delegate',{...ref,title:'Protected child',expectedExecutionMs:2000})).value;assert.equal(child.run.executionExpectation.expectedExecutionMs,2000);assert.equal(child.run.dispatchOrigin.sessionId,'executor-session');
 l.checkins.tick();const message=(await remote.pendingSessionMessages('worker',{kind:'continuation'})).find(m=>m.checkIn?.kind==='execution-deadline');assert.equal(message.sessionId,'dispatcher');
 const resetAt=new Date(clock+3600000).toISOString();await remote.completeSessionMessage('limited',{messageId:message.messageId,nodeId:'worker',state:'failed',reply:'RATE_LIMIT',failure:{code:'RATE_LIMIT',resetAt}});assert.equal(l.getSessionMessage(message.messageId).deliveryFailure.resetAt,resetAt);assert.equal((await remote.pendingSessionMessages('worker',{messageId:message.messageId,forAdmission:true}))[0].admission,'defer');
 const childClaim=l.claim('child-claim',{runId:child.run.runId,nodeId:'worker',ttlMs:60000}).value;l.submit('child-done',{runId:child.run.runId,attemptId:childClaim.attempt.attemptId,nodeId:'worker',fence:childClaim.attempt.fence,outcome:'success',summary:'Child result'});clock+=1000;
 l.submit('done',{...ref,outcome:'success',summary:'Actual result'});l.checkins.tick();assert.equal((await remote.pendingSessionMessages('worker',{messageId:message.messageId,forAdmission:true}))[0].admission,'obsolete');
 await remote.completeSessionMessage('withdrawn-ack',{messageId:message.messageId,nodeId:'worker',state:'completed',reply:'Check-in no longer relevant',checkInTasks:[],withdrawn:true});assert.equal(l.getSessionMessage(message.messageId).withdrawn,true);assert.equal(l.getRun(run.runId).state,'succeeded');
});

function fixture(t,count=6) {
 const dir=mkdtempSync(join(tmpdir(),'message-query-')),file=join(dir,'ledger.sqlite');
 let ledger=TaskLedger.open(file,{role:'both',nodeId:'central'});
 ledger.registerWorkspace('workspace',{workspaceId:'ws',nodeId:'worker',path:dir,state:'ready'});
 ledger.registerNode('node',{nodeId:'worker',roles:['executor'],enabled:true,capabilities:[],models:[{provider:'offline',model:'script'}],workspaceIds:['ws'],maxConcurrent:4});
 const request=ledger.executionModels.request('catalog',{nodeId:'worker'}).catalog.request;
 ledger.completeExecutionModels('catalog-result',{nodeId:'worker',requestId:request.requestId,generation:request.generation,result:{state:'success',complete:true,observedAt:Date.now(),models:[{provider:'offline',model:'script'}]}});
 const messages=[],sessions=[];
 for(let i=0;i<count;i++) {
  const task=ledger.createTask('task-'+i,{title:'Result '+i,policy:{settlementQuietMs:0}}).value;
  const run=ledger.withDispatchOrigin({kind:'session',nodeId:'worker',sessionId:'parent',composition:{provider:'offline',model:'script',tools:[]}},()=>ledger.createRun('run-'+i,{taskId:task.taskId,route:{nodeId:'worker',workspaceId:'ws',provider:'offline',model:'script',requiredCapabilities:[]}}).value);
  const claim=ledger.claim('claim-'+i,{runId:run.runId,nodeId:'worker',ttlMs:10000}).value;
  const ref={runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:'execution-'+i};
  ledger.markRunning('started-'+i,ref);
  sessions.push(ledger.selectTaskSession('session-'+i,{...ref,workspaceId:'ws',session:{mode:'new'}}).value.sessionId);
  ledger.submit('finish-'+i,{...ref,outcome:'success',summary:'Result '+i});
  messages.push(ledger.history(task.taskId).resultReturns[0]);
 }
 const resources=[];
 t.after(async()=>{for(const r of resources.reverse())await(r.dispose?.()??r.close?.());ledger.close();rmSync(dir,{recursive:true,force:true});});
 return {dir,get ledger(){return ledger;},messages,sessions,resources,reopen(){ledger.close();ledger=TaskLedger.open(file,{role:'both',nodeId:'central'});}};
}
function remote(t,f) {
 const keys=generateKeyPairSync('ed25519'),server=new RecoveryStore(':memory:'),outbox=new RecoveryStore(':memory:');
 const peer={keyId:'key',nodeId:'worker',publicKey:keys.publicKey,audience:'central',operations:['sessionMessages','sessionMessageReply'],workspaces:[],capabilities:[]};
 const gateway=new RemoteGateway({role:'planner',nodeId:'central',ledger:f.ledger,store:server,verifier:new IdentityVerifier({audience:'central',peers:[peer]})});
 const payloads=[];
 const client=new RemoteClient({endpoint:'https://fixture.invalid/commands',nodeId:'worker',audience:'central',keyId:'key',privateKey:keys.privateKey,store:outbox,fetch:async(_url,options)=>{payloads.push(JSON.parse(options.body).payload);return new Response(JSON.stringify(await gateway.handle(options.body)));}});
 f.resources.push(server,outbox,gateway,client);
 return {client,remote:new RemoteLedgerClient(client,'worker'),payloads};
}

test('pending completion query excludes active IDs before the four-message limit without acknowledging them',t=>{
 const f=fixture(t),first=f.ledger.pendingSessionMessages('worker',{kind:'completion'}),active=first.map(m=>m.messageId);
 assert.equal(first.length,4);
 const later=f.ledger.pendingSessionMessages('worker',{kind:'completion',excludeMessageIds:active});
 assert.deepEqual(later.map(m=>m.messageId),f.messages.slice(4).map(m=>m.messageId));
 assert.ok(f.messages.every(m=>f.ledger.getSessionMessage(m.messageId).state==='queued'));
 assert.deepEqual(f.ledger.pendingSessionMessages('other',{kind:'completion',excludeMessageIds:active}),[]);
 f.reopen();
 assert.deepEqual(f.ledger.pendingSessionMessages('worker',{kind:'completion'}).map(m=>m.messageId),active,'process-local exclusions do not remove crash recovery');
});

test('message exclusions preserve authenticated signed remote delivery',async t=>{
 const f=fixture(t),r=remote(t,f),active=f.messages.slice(0,4).map(m=>m.messageId);
 const plain=f.ledger.queueSessionMessage('plain',{taskId:f.messages[0].taskId,nodeId:'worker',sessionId:f.sessions[0],text:'A direct message'}).value;
 assert.deepEqual(f.ledger.pendingSessionMessages('worker',{kind:'message',excludeMessageIds:[plain.messageId]}),[]);
 assert.deepEqual(f.ledger.pendingSessionMessages('worker',{kind:'message'}).map(m=>m.messageId),[plain.messageId],'an omission query never changes stored state');
 assert.equal((await r.remote.pendingSessionMessages('worker',{kind:'completion'})).length,4);
 const later=await r.remote.pendingSessionMessages('worker',{kind:'completion',excludeMessageIds:active});
 assert.deepEqual(later.map(m=>m.messageId),f.messages.slice(4).map(m=>m.messageId));
 assert.equal(r.payloads.at(-1).excludeMessageIds.length,4);
 assert.ok(f.messages.every(m=>f.ledger.getSessionMessage(m.messageId).state==='queued'));
 const done=await r.remote.completeSessionMessage('processed',{messageId:later[0].messageId,nodeId:'worker',state:'completed',reply:'Consumed result'});
 assert.equal(done.value.state,'completed');
 assert.equal(f.ledger.getSessionMessage(f.messages[0].messageId).state,'queued');
});

test('remote pending query scans past more active completions than the wire array limit',async t=>{
 const f=fixture(t,264),r=remote(t,f),active=f.messages.slice(0,260).map(m=>m.messageId);
 const later=await r.remote.pendingSessionMessages('worker',{kind:'completion',excludeMessageIds:active});
 assert.deepEqual(later.map(m=>m.messageId),f.messages.slice(260).map(m=>m.messageId));
 assert.ok(r.payloads.every(p=>!p.excludeMessageIds||p.excludeMessageIds.length<=256));
 assert.ok(r.payloads.some(p=>p.afterMessageId),'bounded cursor advances past in-flight messages beyond the exclusion window');
 assert.equal(f.ledger.getSessionMessage(active[259]).state,'queued');
});

test('session message query rejects invalid exclusions and foreign cursors at the authenticated boundary',async t=>{
 const f=fixture(t),r=remote(t,f);
 for(const [key,payload] of [
  ['not-array',{excludeMessageIds:'message'}],
  ['invalid-id',{excludeMessageIds:['x'.repeat(129)]}],
  ['invalid-type',{excludeMessageIds:[4]}],
  ['invalid-cursor',{afterMessageId:'x'.repeat(129)}],
 ]) {
  const result=await r.client.send('sessionMessages',key,payload);
  assert.notEqual(result.state,'done');
 }
 const result=await r.client.send('sessionMessages','foreign-cursor',{afterMessageId:'not-my-message'});
 assert.notEqual(result.state,'done');
 assert.equal(f.ledger.pendingSessionMessages('worker').length,4);
});


test('waiting completions leave ordinary message capacity available and preserve ordinary session serialization',async t=>{
 const f=fixture(t,2),store=new RecoveryStore(':memory:');f.resources.push(store);
 const first=f.messages[0],run=f.ledger.getRun(first.completion.runId),attempt=f.ledger.getAttempt(run.currentAttemptId);
 store.createDispatch({attemptId:attempt.attemptId,state:'acknowledged',claim:{task:f.ledger.getTask(first.taskId),run,attempt},lease:{runId:run.runId,attemptId:attempt.attemptId,nodeId:'worker',fence:attempt.fence},sessionId:f.sessions[0],workspacePath:f.dir});
 const seen=[],waits=[];let releasePlain;
 const plainGate=new Promise(resolve=>releasePlain=resolve);
 const pump=new SessionMessages({ledger:f.ledger,store,policy:{role:'executor',nodeId:'worker',capabilities:[],workspaces:[{workspaceId:'ws',nodeId:'worker',path:f.dir,allowedRoot:f.dir}]},provider:{id:'offline',capabilities:[],supports:()=>true,
  sendTaskReturn:async m=>{seen.push(m.messageId);await new Promise(resolve=>waits.push(resolve));return 'Processed';},
  sendSessionMessage:async(m,_record,started)=>{started();seen.push(m.messageId);if(m.messageId==='plain-first')await plainGate;return 'Ordinary reply';},
 }});
 const until=async(check,label)=>{const deadline=Date.now()+1500;while(!check()){assert.ok(Date.now()<deadline,label);await new Promise(resolve=>setTimeout(resolve,5));}};
 try{
  await pump.poll(1);await pump.poll(1);
  assert.equal(seen.length,2);assert.ok(f.messages.every(m=>f.ledger.getSessionMessage(m.messageId).state==='queued'));
  for(const id of ['plain-first','plain-second'])f.ledger.queueSessionMessage(id,{taskId:first.taskId,nodeId:'worker',sessionId:f.sessions[0],text:id});
  await pump.poll(1);await until(()=>seen.includes('plain-first'),'ordinary message should enter another session while completion waits fill the old capacity');
  await pump.poll(1);assert.ok(!seen.includes('plain-second'),'ordinary messages keep their own session owner and capacity');
  assert.equal(f.ledger.getSessionMessage('plain-first').state,'queued');
  assert.equal(f.ledger.getSessionMessage('plain-second').state,'queued');
  releasePlain();await until(()=>f.ledger.getSessionMessage('plain-first').state==='completed','first ordinary reply ACK');
  await pump.poll(1);await until(()=>f.ledger.getSessionMessage('plain-second').state==='completed','next ordinary message follows its predecessor');
  assert.ok(f.messages.every(m=>f.ledger.getSessionMessage(m.messageId).state==='queued'),'ordinary replies do not falsely acknowledge result processing');
 }finally{releasePlain();for(const release of waits)release();await pump.dispose();}
});


test('completion waits preserve worker configuration ownership without consuming execution slots or heartbeat counts',async t=>{
 const f=fixture(t),store=new RecoveryStore(':memory:');f.resources.push(store);
 const waits=[],seen=[];let executions=0;
 const worker=new ExecutorWorker({ledger:f.ledger,store,policy:{role:'executor',nodeId:'worker',capabilities:[],workspaces:[{workspaceId:'ws',nodeId:'worker',path:f.dir,allowedRoot:f.dir}]},provider:{id:'offline',capabilities:[],supports:()=>true,
  sendTaskReturn:async m=>{seen.push(m.messageId);await new Promise(resolve=>waits.push(resolve));return 'Processed';},sendSessionMessage:async()=>{},
  execute:async()=>{executions++;return{outcome:'success',summary:'Independent work completed'};},
 }});
 try{
  await worker.pollOnce(1);await worker.pollOnce(1);
  assert.equal(seen.length,6);
  assert.equal(worker.activeExecutions,0,'pending result-consumption ACKs are not executing workloads');
  await assert.rejects(worker.beginConfigurationEdit(),{code:'CONFIGURATION_BUSY'});
  const task=f.ledger.createTask('independent-task',{title:'Independent work',policy:{settlementQuietMs:0}}).value;
  const run=f.ledger.createRun('independent-run',{taskId:task.taskId,route:{nodeId:'worker',workspaceId:'ws',provider:'offline',model:'script',requiredCapabilities:[]}}).value;
  await worker.pollOnce(1);
  assert.equal(executions,1,'notification waits do not occupy the node execution slot');
  assert.equal(f.ledger.getRun(run.runId).state,'succeeded');
 }finally{for(const release of waits)release();await worker.dispose();}
});
