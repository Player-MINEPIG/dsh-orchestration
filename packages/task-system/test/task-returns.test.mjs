import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../dist/ledger.js';
import {containsTaskReturn} from '../dist/task-returns.js';
import {SessionMessages} from '../dist/remote/session-messages.js';

function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'task-returns-')), file=join(dir,'ledger.sqlite');
 let l=TaskLedger.open(file,{role:'both',nodeId:'central'});
 l.registerNode('node',{nodeId:'worker',roles:['executor'],enabled:true,capabilities:[],models:[{provider:'offline',model:'script'}],workspaceIds:['ws'],maxConcurrent:4});
 l.registerWorkspace('workspace',{workspaceId:'ws',nodeId:'worker',path:dir,state:'ready'});
 t.after(()=>{l.close();rmSync(dir,{recursive:true,force:true});});
 return {get l(){return l;},reopen(){l.close();l=TaskLedger.open(file,{role:'both',nodeId:'central'});}};
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
 f.reopen();f.l.retryTaskReturn('requeue',message.messageId);assert.equal(f.l.pendingSessionMessages('central')[0].messageId,message.messageId);assert.equal(f.l.history(run.taskId).runs.length,1);assert.equal(f.l.getRun(run.runId).state,'succeeded');
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
