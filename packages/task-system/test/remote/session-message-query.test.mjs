import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../../dist/ledger.js';
import {SessionMessages} from '../../dist/remote/session-messages.js';
import {RemoteClient,RemoteLedgerClient,RemoteGateway,RecoveryStore,IdentityVerifier,ExecutorWorker} from '../../dist/remote/api.js';

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
