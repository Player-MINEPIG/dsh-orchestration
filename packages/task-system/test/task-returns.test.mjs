import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../dist/ledger.js';
import {containsTaskReturn} from '../dist/task-returns.js';
import {TaskReturnError,providerReturnFailure,returnRetryAt} from '../dist/task-return-failure.js';
import {SessionMessages} from '../dist/remote/session-messages.js';

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'task-returns-')), file=join(dir,'ledger.sqlite');
 let now=Date.now();const open=()=>TaskLedger.open(file,{role:'both',nodeId:'central',now:()=>now});let l=open();
 l.registerNode('node',{nodeId:'worker',roles:['executor'],enabled:true,capabilities:[],models:[{provider:'offline',model:'script'}],workspaceIds:['ws'],maxConcurrent:4});
 const request=l.executionModels.request('catalog',{nodeId:'worker'}).catalog.request;
 l.completeExecutionModels('catalog-result',{nodeId:'worker',requestId:request.requestId,generation:request.generation,result:{state:'success',complete:true,observedAt:Date.now(),models:[{provider:'offline',model:'script'}]}});
 l.registerWorkspace('workspace',{workspaceId:'ws',nodeId:'worker',path:dir,state:'ready'});
 t.after(()=>{l.close();rmSync(dir,{recursive:true,force:true});});
 return {get l(){return l;},get now(){return now;},advance(ms=60000){now+=ms;},reopen(){l.close();l=open();}};
}
const route={nodeId:'worker',provider:'offline',model:'script',workspaceId:'ws',requiredCapabilities:[]};
const origin=sessionId=>({kind:'session',nodeId:'central',sessionId,composition:{provider:'offline',model:'script',tools:[]}});
function dispatch(l,key){const task=l.createTask(key+'-task',{title:key,policy:{settlementQuietMs:0}}).value;return l.createRun(key+'-run',{taskId:task.taskId,route:{...route}}).value;}
function finish(l,run,key='finish'){const claim=l.claim(key+'-claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value;return l.submit(key,{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,outcome:'success',summary:'verified exact result'}).value;}

test('dispatch origin is async-isolated; terminal outbox and exact replay survive restart',async t=>{
 const f=fixture(t);
 const [a,b]=await Promise.all(['a','b'].map(name=>f.l.withDispatchOrigin(origin(name),async()=>{await new Promise(resolve=>setTimeout(resolve,name==='a'?10:1));return dispatch(f.l,name);}))); 
 assert.equal(a.dispatchOrigin.sessionId,'a');assert.equal(b.dispatchOrigin.sessionId,'b');
 finish(f.l,a);const out=f.l.pendingSessionMessages('central');assert.equal(out.length,1);assert.equal(out[0].sessionId,'a');assert.match(out[0].text,/verified exact result/);
 f.reopen();assert.equal(f.l.pendingSessionMessages('central')[0].messageId,out[0].messageId);
 assert.equal(f.l.history(a.taskId).resultReturns.length,1);
 f.l.completeSessionMessage('ack',{nodeId:'central',messageId:out[0].messageId,state:'completed',reply:'queued'});
 assert.equal(f.l.pendingSessionMessages('central').length,0);
 const later=f.l.createRun('system-next',{taskId:a.taskId,route:{...route}}).value;
 assert.equal(later.dispatchOrigin.kind,'system','a later system run must not inherit the old conversation');
 finish(f.l,later,'system-finish');assert.equal(f.l.pendingSessionMessages('central').length,0);
});

test('failed return is visible, retry only requeues the event and never creates another run',t=>{
 const f=fixture(t),run=f.l.withDispatchOrigin(origin('origin'),()=>dispatch(f.l,'retry'));
 finish(f.l,run);const message=f.l.pendingSessionMessages('central')[0];
 f.l.completeSessionMessage('delivery-failed',{nodeId:'central',messageId:message.messageId,state:'failed',reply:'Original preset unavailable'});
 const failed=f.l.history(run.taskId).resultReturns[0];assert.equal(failed.deliveryAttempts,1);assert.equal(failed.lastDeliveryError,'Original preset unavailable');
 f.reopen();f.advance();f.l.retryTaskReturn('requeue',message.messageId);assert.equal(f.l.pendingSessionMessages('central')[0].messageId,message.messageId);assert.equal(f.l.history(run.taskId).runs.length,1);assert.equal(f.l.getRun(run.runId).state,'succeeded');
});

test('owned child origin is derived from the exact lease and targets parent node/session',t=>{
 const f=fixture(t),parent=dispatch(f.l,'parent'),claim=f.l.claim('parent-claim',{runId:parent.runId,nodeId:'worker',ttlMs:10000}).value;
 const ref={runId:parent.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence};
 f.l.bindSession('parent-session',{...ref,sessionId:'parent-origin'});
 const child=f.l.delegateTask('child',{...ref,title:'child'}).value;
 assert.equal(child.run.dispatchOrigin.sessionId,'parent-origin');assert.equal(child.run.dispatchOrigin.parentLease.fence,ref.fence);
 finish(f.l,child.run);assert.equal(f.l.pendingSessionMessages('worker')[0].sessionId,'parent-origin');
 assert.throws(()=>f.l.delegateTask('bad-child',{...ref,fence:ref.fence-1,title:'forged'}));
});

test('persisted admission is found in consumed messages or pending next-turn inbox',()=>{
 const source={kind:'dsh-task-result',eventId:'event-1',taskId:'task'};
 assert.equal(containsTaskReturn([{type:'user/message',data:{source}}],'event-1'),true);
 assert.equal(containsTaskReturn([{type:'agent/inbox/spliced',data:{inserted:[{source}]}}],'event-1'),true);
 assert.equal(containsTaskReturn([{type:'agent/inbox/spliced',data:{inserted:[{source}]}}],'different'),false);
});

test('remote result return retries the same event after an interrupted acknowledgement',async()=>{
 let deliveries=0,acks=0;const message={messageId:'event',sessionId:'parent',nodeId:'worker',completion:{eventId:'event'},state:'queued'};
 const pump=new SessionMessages({ledger:{pendingSessionMessages:async()=>[message],completeSessionMessage:async(_id,input)=>{acks++;if(acks===1)throw Error('ack interrupted');assert.equal(input.messageId,'event');}},store:{},policy:{nodeId:'worker'},provider:{sendSessionMessage(){},sendTaskReturn:async()=>{deliveries++;return 'persisted';}}});
 await pump.poll(1);await new Promise(resolve=>setImmediate(resolve));await pump.poll(1);await new Promise(resolve=>setImmediate(resolve));await pump.dispose();assert.ok(deliveries>=1);assert.ok(acks>=2);
});


test('remote completion admission bypasses same-session and workload capacity gates',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),seen=[],acks=[];
 const messages=[1,2].map(n=>({messageId:'parallel-'+n,sessionId:'parent',nodeId:'worker',completion:{eventId:'parallel-'+n},state:'queued'}));
 const pump=new SessionMessages({ledger:{pendingSessionMessages:async()=>messages,completeSessionMessage:async(_id,input)=>acks.push(input)},store:{sessionMessageState:()=>undefined},policy:{nodeId:'worker'},provider:{sendSessionMessage(){},sendTaskReturn:async message=>{seen.push(message.messageId);await gate;return 'processed';}}});
 try{await pump.poll(1);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(seen,['parallel-1','parallel-2']);assert.equal(acks.length,0);}finally{release();await pump.dispose();}
 assert.equal(acks.length,2);
});


test('three consecutive unavailable returns stop automatically, survive restart and retry only the original event',t=>{
 const f=fixture(t),run=f.l.withDispatchOrigin(origin('no-reply'),()=>dispatch(f.l,'no-reply'));
 finish(f.l,run);const message=f.l.pendingSessionMessages('central')[0];
 for(let n=1;n<=3;n++){
  f.l.completeSessionMessage('failure-'+n,{nodeId:'central',messageId:message.messageId,state:'failed',reply:'No reply'});
  assert.equal(f.l.getSessionMessage(message.messageId).consecutiveDeliveryFailures,n);
  assert.equal(f.l.pendingSessionMessages('central').length,0);
  f.advance();
  assert.equal(f.l.pendingSessionMessages('central').length,n<3?1:0);
 }
 f.reopen();assert.equal(f.l.history(run.taskId).resultReturns[0].state,'failed');
 assert.match(f.l.getSessionMessage(message.messageId).reply,/连续三次/);
 f.l.retryTaskReturn('manual-return',message.messageId);
 assert.equal(f.l.pendingSessionMessages('central')[0].messageId,message.messageId);
 assert.equal(f.l.getSessionMessage(message.messageId).consecutiveDeliveryFailures,0);
 assert.equal(f.l.getSessionMessage(message.messageId).deliveryAttempts,3);
 assert.equal(f.l.history(run.taskId).runs.length,1);
 f.l.completeSessionMessage('success',{nodeId:'central',messageId:message.messageId,state:'completed',reply:'Processed original result'});
 assert.equal(f.l.getSessionMessage(message.messageId).consecutiveDeliveryFailures,0);
});

test('quota cooling blocks sibling returns and check-ins across restart without consuming the no-reply budget',t=>{
 const f=fixture(t),run=f.l.withDispatchOrigin(origin('limited'),()=>dispatch(f.l,'limited'));
 const draft=f.l.withDispatchOrigin(origin('limited'),()=>f.l.createTask('draft',{title:'Continue later'}).value);
 f.l.checkins.request('request-check',draft.taskId);
 const check=f.l.pendingSessionMessages('central').find(m=>m.checkIn);
 finish(f.l,run);const message=f.l.pendingSessionMessages('central').find(m=>m.completion);
 const resetAt=new Date(f.now+3*3600000).toISOString();
 for(let n=1;n<=4;n++)f.l.recordTaskReturnFailure(message.messageId,'RATE_LIMIT',{code:'RATE_LIMIT',resetAt});
 assert.equal(f.l.getSessionMessage(message.messageId).deliveryAttempts,4);
 assert.equal(f.l.getSessionMessage(message.messageId).consecutiveDeliveryFailures,0);
 assert.equal(f.l.checkins.view(draft.taskId).deliveryFailures,0);
 assert.equal(f.l.pendingSessionMessages('central').length,0);
 f.reopen();f.advance(2*3600000);assert.equal(f.l.pendingSessionMessages('central').length,0);
 f.l.retryTaskReturn('manual-cannot-bypass',message.messageId);assert.equal(f.l.pendingSessionMessages('central').length,0);
 f.advance(3600000);assert.ok(f.l.pendingSessionMessages('central').some(m=>m.messageId===message.messageId));
 f.l.completeSessionMessage('limited-ack',{nodeId:'central',messageId:message.messageId,state:'completed',reply:'Processed'});
 assert.ok(f.l.pendingSessionMessages('central').some(m=>m.messageId===check.messageId));
 f.l.recordTaskReturnFailure(check.messageId,'RATE_LIMIT',{code:'RATE_LIMIT',retryAfterMs:3600000});
 assert.equal(f.l.checkins.view(draft.taskId).deliveryFailures,0);
 assert.equal(f.l.pendingSessionMessages('central').length,0);
 f.advance(3600000);assert.equal(f.l.pendingSessionMessages('central').length,1);
});

test('legacy queued returns exhaust their previous unavailable attempts without waking a model',t=>{
 const f=fixture(t),run=f.l.withDispatchOrigin(origin('legacy'),()=>dispatch(f.l,'legacy'));finish(f.l,run);
 const message=f.l.pendingSessionMessages('central')[0];message.deliveryAttempts=6;
 f.l.managementDatabase().prepare("UPDATE entities SET data=? WHERE kind='sessionMessage' AND id=?").run(JSON.stringify(message),message.messageId);
 f.reopen();assert.equal(f.l.pendingSessionMessages('central').length,0);assert.equal(f.l.getSessionMessage(message.messageId).state,'failed');
});

test('known reset and Retry-After facts delay retries; missing reset uses thirty minutes',()=>{
 const now=Date.parse('2026-10-27T10:00:00Z');
 assert.equal(providerReturnFailure({code:'SERVER',message:'quota speculation'},now),undefined);
 const failure=providerReturnFailure({code:'RATE_LIMIT',message:"Claude Code: You've hit your session limit · resets 1:10pm (UTC)"},now);
 assert.equal(failure.resetAt,'2026-10-27T13:10:00.000Z');assert.equal(returnRetryAt(failure,now),failure.resetAt);
 assert.doesNotThrow(()=>providerReturnFailure({code:'RATE_LIMIT',providerRetryAfterMs:Number.MAX_VALUE},now));
 assert.equal(returnRetryAt({code:'RATE_LIMIT'},now),'2026-10-27T10:30:00.000Z');
 assert.equal(returnRetryAt({code:'RATE_LIMIT',retryAfterMs:7200000},now),'2026-10-27T12:00:00.000Z');
});

test('remote return failure retains structured quota timing instead of flattening it into unavailable',async()=>{
 const failure={code:'RATE_LIMIT',resetAt:'2026-10-28T13:10:00.000Z'},acks=[];
 const message={messageId:'quota-event',sessionId:'parent',nodeId:'worker',completion:{eventId:'quota-event'},state:'queued'};
 const pump=new SessionMessages({ledger:{pendingSessionMessages:async()=>[message],completeSessionMessage:async(_id,input)=>acks.push(input)},store:{},policy:{nodeId:'worker'},provider:{sendSessionMessage(){},sendTaskReturn:async()=>{throw new TaskReturnError(failure);}}});
 await pump.poll(1);await new Promise(resolve=>setImmediate(resolve));await pump.dispose();
 assert.deepEqual(acks[0].failure,failure);assert.equal(acks[0].state,'failed');
});


test('account balance exhaustion without a recovery time is bounded and retains its cause',t=>{
 const f=fixture(t),run=f.l.withDispatchOrigin(origin('balance'),()=>dispatch(f.l,'balance'));finish(f.l,run);
 const message=f.l.pendingSessionMessages('central')[0];
 for(let n=0;n<3;n++){f.l.recordTaskReturnFailure(message.messageId,'ACCOUNT_QUOTA',{code:'ACCOUNT_QUOTA'});f.advance();}
 assert.equal(f.l.getSessionMessage(message.messageId).state,'failed');
 assert.equal(f.l.getSessionMessage(message.messageId).deliveryFailure.code,'ACCOUNT_QUOTA');
 assert.match(f.l.getSessionMessage(message.messageId).reply,/额度不足.*ACCOUNT_QUOTA/);
 f.advance(86400000);assert.equal(f.l.pendingSessionMessages('central').length,0);
});
