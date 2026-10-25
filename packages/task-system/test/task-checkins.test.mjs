import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../dist/ledger.js';

const owner=(sessionId='owner')=>({kind:'session',nodeId:'central',sessionId,cwd:'/fixture',composition:{provider:'offline',model:'script',tools:['task_checkin','task_submit_result']}});
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'checkins-')),file=join(dir,'tasks.sqlite');let now=Date.parse('2026-10-26T01:00:00Z'),ledger;
 const open=()=>ledger=TaskLedger.open(file,{nodeId:'central',checkinIntervalMs:1000,now:()=>now});open();
 t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
 return {get l(){return ledger;},get now(){return now;},advance(ms=1000){now+=ms;},reopen(){ledger.close();open();},task(name='work',origin=owner()){return ledger.withDispatchOrigin(origin,()=>ledger.createTask(name,{title:name}).value);},update(task,plan={kind:'scheduled'},commandId='update'){return ledger.withDispatchOrigin(owner(),()=>ledger.taskCheckin({action:'update',commandId,taskId:task.taskId,observation:plan.kind==='paused'?'blocked':'waiting_external',summary:'Checked the actual evidence',plan}));},ack(message,key='ack'){return ledger.completeSessionMessage(key,{messageId:message.messageId,nodeId:'central',state:'completed',reply:'Checked in original session',checkInTasks:message.checkIn.tasks});},messages(){return ledger.pendingSessionMessages('central',{kind:'continuation'});}};
}
function route(f){
 f.l.registerNode('node',{nodeId:'worker',roles:['executor'],enabled:true,models:[{provider:'offline',model:'script'}],workspaceIds:['ws'],capabilities:[],maxConcurrent:2});
 f.l.registerWorkspace('workspace',{workspaceId:'ws',nodeId:'worker',path:'/fixture',state:'ready'});
 const request=f.l.executionModels.request('catalog',{nodeId:'worker'}).catalog.request;
 f.l.completeExecutionModels('models',{nodeId:'worker',requestId:request.requestId,generation:request.generation,result:{state:'success',complete:true,observedAt:f.now,models:[{provider:'offline',model:'script'}]}});
 return {nodeId:'worker',workspaceId:'ws',provider:'offline',model:'script',requiredCapabilities:[]};
}

test('new draft checks are atomic, batched, persistent and never create execution Runs',t=>{
 const f=fixture(t),a=f.task('a'),b=f.task('b');assert.equal(f.l.checkins.view(a.taskId).phase,'scheduled');
 f.l.checkins.tick();assert.equal(f.messages().length,0);f.advance();f.l.checkins.tick();
 const [message]=f.messages();assert.equal(message.completion,undefined);assert.deepEqual(message.checkIn.tasks.map(r=>r.taskId),[a.taskId,b.taskId]);
 assert.equal(f.l.snapshot().runs.length,0);assert.equal(f.l.getTask(a.taskId).state,'ready');
 f.reopen();f.l.checkins.tick();assert.equal(f.messages()[0].messageId,message.messageId);
 f.ack(message);assert.equal(f.l.checkins.view(a.taskId).checksWithoutUpdate,1);assert.equal(f.messages().length,0);
});

test('only recorded responsible node/session/cwd can update; legacy enrollment is manual',t=>{
 const f=fixture(t),task=f.task();
 for(const actor of [owner('other'),{...owner(),nodeId:'other'},{...owner(),cwd:'/other'},{kind:'system',nodeId:'central'}])assert.throws(()=>f.l.withDispatchOrigin(actor,()=>f.l.taskCheckin({action:'update',commandId:'forged',taskId:task.taskId,observation:'working',summary:'forged',plan:{kind:'scheduled'}})),e=>e.code==='FORBIDDEN');
 f.l.managementDatabase().prepare("DELETE FROM entities WHERE kind='taskCheckin'").run();f.advance(100000);f.l.checkins.tick();assert.equal(f.messages().length,0);assert.equal(f.l.checkins.view(task.taskId).phase,'untracked');
 f.l.checkins.request('manual-legacy',task.taskId);assert.equal(f.messages().length,1);
 const orphan=f.task('orphan',{kind:'system',nodeId:'central'});assert.equal(f.l.checkins.request('manual-orphan',orphan.taskId).phase,'needs_owner');
});

test('late ACK cannot overwrite an agent deadline or pause; paused manual checks remain one-shot',t=>{
 const f=fixture(t),task=f.task();f.advance();f.l.checkins.tick();const first=f.messages()[0];
 const nextCheckAt=new Date(f.now+20000).toISOString();f.update(task,{kind:'scheduled',nextCheckAt});f.ack(first);assert.equal(f.l.checkins.view(task.taskId).nextCheckAt,nextCheckAt);assert.equal(f.l.checkins.view(task.taskId).checksWithoutUpdate,0);
 f.update(task,{kind:'paused',reason:'Waiting for an explicit human decision'},'pause');f.advance(50000);f.l.checkins.tick();assert.equal(f.messages().length,0);
 f.l.checkins.request('manual-paused',task.taskId);const manual=f.messages()[0];assert.equal(manual.checkIn.automatic,false);f.ack(manual,'ack-manual');assert.equal(f.l.checkins.view(task.taskId).phase,'paused');f.advance(50000);f.l.checkins.tick();assert.equal(f.messages().length,0);
});

test('manual request for another task behind an owner batch is retained until that batch finishes',t=>{
 const f=fixture(t),a=f.task('a'),b=f.task('b');f.l.checkins.request('check-a',a.taskId);const first=f.messages()[0];
 f.l.checkins.request('check-b',b.taskId);f.l.checkins.tick();assert.equal(f.messages().length,1);assert.equal(f.l.checkins.view(b.taskId).phase,'queued');
 f.ack(first);f.l.checkins.tick();const second=f.messages()[0];assert.ok(second.checkIn.tasks.some(ref=>ref.taskId===b.taskId));assert.notEqual(second.messageId,first.messageId);
});

test('three no-update rounds or delivery failures need action; busy does not consume either budget',t=>{
 const f=fixture(t),task=f.task();
 for(let n=1;n<=3;n++){f.advance();f.l.checkins.tick();f.ack(f.messages()[0],'ack-'+n);}
 assert.equal(f.l.checkins.view(task.taskId).phase,'needs_action');f.advance(100000);f.l.checkins.tick();assert.equal(f.messages().length,0);
 f.l.checkins.request('retry',task.taskId);let message=f.messages()[0];f.l.recordTaskReturnFailure(message.messageId,'CHECKIN_BUSY');assert.equal(f.l.checkins.view(task.taskId).deliveryFailures,0);assert.equal(f.l.checkins.view(task.taskId).checksWithoutUpdate,0);
 for(let n=0;n<3;n++){f.l.recordTaskReturnFailure(message.messageId,'RETURN_UNAVAILABLE');}
 assert.equal(f.l.checkins.view(task.taskId).phase,'needs_action');assert.equal(f.l.getSessionMessage(message.messageId).state,'failed');
});

test('queued work is checked, valid execution defers; changing eligibility is checked again before delivery',t=>{
 const f=fixture(t),r=route(f),task=f.task(),run=f.l.createRun('run',{taskId:task.taskId,route:r}).value;
 f.advance();f.l.checkins.tick();const message=f.messages()[0];assert.ok(message,'unclaimed queue does not defer forever');
 f.l.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000});assert.equal(f.l.checkins.disposition(message),'defer');assert.equal(f.messages().length,0);
 f.advance(11000);f.l.recoverExpired('recover');assert.equal(f.l.getRun(run.runId).state,'uncertain');assert.equal(f.l.checkins.disposition(message),'ready');assert.equal(f.l.snapshot().runs.length,1,'checking never retries uncertain effects');
});

test('closed tasks withdraw unsent checks; user approval and protected or child scopes do not grant authority',t=>{
 const f=fixture(t),task=f.task();f.l.checkins.request('manual',task.taskId);const message=f.messages()[0];f.l.cancel('cancel',{taskId:task.taskId,reason:'Operator cancelled'});f.l.checkins.tick();assert.equal(f.messages().length,0);assert.equal(f.l.getSessionMessage(message.messageId).state,'completed');assert.equal(f.l.checkins.view(task.taskId).phase,'closed');
 const protectedTask=f.task('protected',{...owner(),parentLease:{runId:'old',attemptId:'old-a',nodeId:'central',fence:1}});assert.equal(f.l.checkins.request('manual-protected',protectedTask.taskId).category,'protected_execution');
 const confirmed=f.l.withDispatchOrigin(owner(),()=>f.l.createTask('permission',{title:'Needs permission',requiresConfirmation:true}).value);f.advance(5000);f.l.checkins.tick();assert.equal(f.l.checkins.view(confirmed.taskId).category,'approval');assert.equal(f.messages().length,0);f.l.checkins.request('manual-permission',confirmed.taskId);assert.equal(f.messages().length,1);assert.equal(f.l.getTask(confirmed.taskId).confirmation.state,'pending');
});

test('deadlines reject past/oversized values without recording progress',t=>{
 const f=fixture(t),task=f.task();for(const ms of [-1,31*86400000])assert.throws(()=>f.update(task,{kind:'scheduled',nextCheckAt:new Date(f.now+ms).toISOString()},'time-'+ms),e=>e.code==='INVALID');assert.equal(f.l.checkins.view(task.taskId).revision,0);
});


test('mixed batch omits tasks whose plan changed before delivery and accounts automatic rounds separately',t=>{
 const f=fixture(t),a=f.task('a'),b=f.task('b');f.advance();f.l.checkins.tick();const original=f.messages()[0];
 f.update(a,{kind:'paused',reason:'Need a human'});const projected=f.messages()[0];assert.deepEqual(projected.checkIn.tasks.map(ref=>ref.taskId),[b.taskId]);assert.doesNotMatch(projected.text,new RegExp(a.taskId));assert.match(projected.text,/task_checkin/);
 f.ack(original);assert.equal(f.l.checkins.view(a.taskId).phase,'paused');assert.equal(f.l.checkins.view(a.taskId).checksWithoutUpdate,0);assert.equal(f.l.checkins.view(b.taskId).checksWithoutUpdate,1);
});


test('terminal batch failure releases stale revision membership without overwriting its newer schedule',t=>{
 const f=fixture(t),a=f.task('a'),b=f.task('b');f.advance();f.l.checkins.tick();const message=f.messages()[0];
 const nextCheckAt=new Date(f.now+20000).toISOString();f.update(a,{kind:'scheduled',nextCheckAt});
 for(let n=0;n<3;n++)f.l.recordTaskReturnFailure(message.messageId,'RETURN_UNAVAILABLE');
 assert.equal(f.l.getSessionMessage(message.messageId).state,'failed');assert.equal(f.l.checkins.view(a.taskId).pendingMessageId,null);assert.equal(f.l.checkins.view(a.taskId).nextCheckAt,nextCheckAt);assert.equal(f.l.checkins.view(a.taskId).deliveryFailures,0);assert.equal(f.l.checkins.view(b.taskId).phase,'needs_action');
 f.advance(20000);f.l.checkins.tick();assert.equal(f.messages().length,1);assert.equal(f.messages()[0].checkIn.tasks[0].taskId,a.taskId);
});


test('a rejected latest result remains checkable despite the retained completed Task projection',t=>{
 const f=fixture(t),r=route(f),task=f.task(),run=f.l.createRun('run',{taskId:task.taskId,route:r}).value;
 const claim=f.l.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value;
 f.l.submit('finish',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,outcome:'success',summary:'Submitted evidence'});
 f.l.reviewRun('reject',{runId:run.runId,decision:'rejected',reason:'Evidence needs revision'});
 assert.equal(f.l.getTask(task.taskId).state,'completed');assert.notEqual(f.l.checkins.view(task.taskId).phase,'closed');assert.equal(f.l.checkins.view(task.taskId).canRequest,true);
});


test('ACK counts only the actual admitted members, even when omitted work becomes ready before the ACK',t=>{
 const f=fixture(t),r=route(f),a=f.task('a'),b=f.task('b'),run=f.l.createRun('a-run',{taskId:a.taskId,route:r}).value;
 f.advance();f.l.checkins.tick();const original=f.messages()[0];f.l.claim('a-claim',{runId:run.runId,nodeId:'worker',ttlMs:10000});const projected=f.messages()[0];assert.deepEqual(projected.checkIn.tasks.map(ref=>ref.taskId),[b.taskId]);
 f.advance(11000);f.l.recoverExpired('recover');f.ack(projected);assert.equal(f.l.checkins.view(a.taskId).checksWithoutUpdate,0);assert.equal(f.l.checkins.view(b.taskId).checksWithoutUpdate,1);assert.equal(f.l.checkins.view(a.taskId).pendingMessageId,null);
 const fresh=f.l.checkins.request('fresh',a.taskId),message=f.messages()[0];assert.throws(()=>f.l.completeSessionMessage('forged',{messageId:message.messageId,nodeId:'central',state:'completed',reply:'bad',checkInTasks:[{taskId:'other',revision:0}]}),e=>e.code==='FORBIDDEN');assert.throws(()=>f.l.completeSessionMessage('duplicate',{messageId:message.messageId,nodeId:'central',state:'completed',reply:'bad',checkInTasks:[message.checkIn.tasks[0],message.checkIn.tasks[0]]}),e=>e.code==='FORBIDDEN');
});
