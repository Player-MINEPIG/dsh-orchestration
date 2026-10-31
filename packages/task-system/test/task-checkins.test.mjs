import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../dist/ledger.js';
import {ProjectRuntime} from '../dist/project-runtime.js';

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

function expectedRun(f,key='bounded',expectedExecutionMs=2000){
 const r=route(f),task=f.task(key),run=f.l.withDispatchOrigin(owner(),()=>f.l.createRun(key+'-run',{taskId:task.taskId,route:r,expectedExecutionMs}).value);
 return {task,run,start(){const claim=f.l.claim(key+'-claim',{runId:run.runId,nodeId:'worker',ttlMs:60000}).value;const ref={runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:key+'-execution'};f.l.markRunning(key+'-running',ref);return ref;}};
}

test('check-in maintenance and status read Runs once per operation and observe the next operation changes',t=>{
 const f=fixture(t),r=route(f),tasks=[];
 for(let i=0;i<20;i++){
  const task=f.task('history-'+i),run=f.l.createRun('run-'+i,{taskId:task.taskId,route:r}).value;
  tasks.push({task,run});
 }
 const db=f.l.managementDatabase();
 db.prepare("UPDATE entities SET state='completed',data=json_set(data,'$.state','completed') WHERE kind='task'").run();
 db.prepare("UPDATE entities SET state='succeeded',data=json_set(data,'$.state','succeeded') WHERE kind='run'").run();
 let runReads=0;const prepare=db.prepare.bind(db);
 db.prepare=sql=>{const statement=prepare(sql),all=statement.all.bind(statement);statement.all=(...args)=>{if(sql==='SELECT data FROM entities WHERE kind=? ORDER BY rowid'&&args[0]==='run')runReads++;return all(...args);};return statement;};
 f.l.checkins.tick();assert.equal(runReads,1,'one maintenance operation must not re-read all Run payloads for every historical task');
 runReads=0;assert.equal(f.l.checkins.view(tasks[0].task.taskId).category,'closed');assert.equal(runReads,1);
 const latest={...tasks[0].run,runId:'legacy-unindexed-latest',state:'queued'};
 db.prepare("UPDATE entities SET state='ready',data=json_set(data,'$.state','ready') WHERE kind='task' AND id=?").run(tasks[0].task.taskId);
 db.prepare("INSERT INTO entities(kind,id,data) VALUES('run',?,?)").run(latest.runId,JSON.stringify(latest));
 runReads=0;assert.equal(f.l.checkins.view(tasks[0].task.taskId).category,'waiting_execution','a later read must see the latest Run even if legacy parent/state columns are null');assert.equal(runReads,1);
 f.l.checkins.tick();assert.equal(f.l.checkins.view(tasks[0].task.taskId).category,'waiting_execution');
});

test('the complete project snapshot shares Task, Run and action reads across its historical task list',t=>{
 const f=fixture(t),r=route(f),runtime=new ProjectRuntime({get:()=>undefined},f.l,'central','both');
 for(let i=0;i<20;i++){const task=f.task('snapshot-history-'+i);f.l.createRun('snapshot-run-'+i,{taskId:task.taskId,route:r});}
 const db=f.l.managementDatabase();
 db.prepare("UPDATE entities SET state='completed',data=json_set(data,'$.state','completed') WHERE kind='task'").run();
 db.prepare("UPDATE entities SET state='succeeded',data=json_set(data,'$.state','succeeded') WHERE kind='run'").run();
 let runReads=0,taskReads=0,actionReads=0;const prepare=db.prepare.bind(db);
 db.prepare=sql=>{const statement=prepare(sql),all=statement.all.bind(statement);statement.all=(...args)=>{if(sql==='SELECT data FROM entities WHERE kind=? ORDER BY rowid'){if(args[0]==='run')runReads++;if(args[0]==='task')taskReads++;}if(sql==='SELECT data FROM entities WHERE kind=? AND parent=? ORDER BY rowid'&&args[0]==='report')actionReads++;return all(...args);};return statement;};
 const snapshot=runtime.snapshot();assert.equal(snapshot.tasks.length,20);assert.equal(snapshot.runs.length,20);assert.ok(snapshot.tasks.every(task=>task.status==='done'));
 assert.equal(runReads,2,'one ledger snapshot read plus one shared check-in read for the entire task list');
 assert.equal(taskReads,3,'ledger, decision catalog and check-in scope each read Task facts once');assert.equal(actionReads,20,'each task action is evaluated once');
 runReads=0;taskReads=0;actionReads=0;
 const first=snapshot.tasks[0],before=first.actionVersion;
 db.prepare("UPDATE entities SET state='cancelled',data=json_set(data,'$.state','cancelled') WHERE kind='task' AND id=?").run(first.id);
 const next=runtime.snapshot();assert.equal(next.tasks.length,20);assert.equal(next.tasks.find(task=>task.id===first.id).status,'cancelled');assert.notEqual(next.tasks.find(task=>task.id===first.id).actionVersion,before);
 assert.equal(runReads,2,'the next request must use a fresh read scope');assert.equal(taskReads,3);assert.equal(actionReads,20);
});

test('execution bound starts only on the fenced actual start, survives renew and restart, and fires once under a valid lease',t=>{
 const f=fixture(t),{task,run,start}=expectedRun(f);f.advance(10000);f.l.checkins.tick();assert.equal(f.messages().length,0);assert.equal(f.l.checkins.executionView(task.taskId).phase,'pending_start');
 const ref=start();f.advance(10000);f.l.checkins.tick();assert.equal(f.messages().length,0,'markRunning is preparation, not actual execution');
 assert.throws(()=>f.l.markExecutionStarted('foreign',{...ref,executionId:'foreign'}));
 f.l.markExecutionStarted('actual',ref);const started=f.l.getRun(run.runId).executionExpectation.startedAt;
 f.advance(1000);f.l.markExecutionStarted('actual-again',ref);f.l.renew('renew',{...ref,ttlMs:60000});assert.equal(f.l.getRun(run.runId).executionExpectation.startedAt,started);
 f.advance(1000);f.l.checkins.tick();const message=f.messages()[0];assert.equal(message.checkIn.kind,'execution-deadline');assert.equal(message.checkIn.runId,run.runId);assert.deepEqual(message.checkIn.tasks,[]);assert.equal(f.l.getRun(run.runId).state,'running');
 f.reopen();f.l.checkins.tick();assert.equal(f.messages()[0].messageId,message.messageId);f.ack(message);f.advance(100000);f.l.checkins.tick();assert.equal(f.l.sessionMessages(task.taskId).filter(m=>m.checkIn?.kind==='execution-deadline').length,1);assert.equal(f.l.checkins.view(task.taskId).checksWithoutUpdate,0);assert.equal(f.l.getRun(run.runId).state,'running');
});

test('completion while waiting withdraws the exact deadline and a genuinely late ACK remains idempotent',t=>{
 const f=fixture(t),{task,run,start}=expectedRun(f),ref=start();f.l.markExecutionStarted('actual',ref);f.advance(2000);f.l.checkins.tick();const message=f.messages()[0];
 f.l.recordTaskReturnFailure(message.messageId,'CHECKIN_BUSY');assert.equal(f.l.getSessionMessage(message.messageId).consecutiveDeliveryFailures??0,0);
 f.l.submit('done',{...ref,outcome:'success',summary:'Actual finished result'});f.l.checkins.tick();assert.equal(f.l.getSessionMessage(message.messageId).withdrawn,true);assert.equal(f.l.pendingSessionMessages('central',{messageId:message.messageId,forAdmission:true})[0].admission,'obsolete');
 f.ack(message,'late-real-ack');assert.equal(f.l.getSessionMessage(message.messageId).withdrawn,undefined);assert.equal(f.l.checkins.executionView(task.taskId).phase,'processed');f.ack(message,'late-real-ack');assert.equal(f.l.getRun(run.runId).state,'succeeded');
});

test('deadline delivery failures share quota cooldown, stop after three real no replies and retry the same event',t=>{
 const f=fixture(t),{task,run,start}=expectedRun(f),ref=start();f.l.markExecutionStarted('actual',ref);f.advance(2000);f.l.checkins.tick();const message=f.messages()[0],resetAt=new Date(f.now+60000).toISOString();
 f.l.recordTaskReturnFailure(message.messageId,'RATE_LIMIT',{code:'RATE_LIMIT',resetAt});assert.equal(f.l.getSessionMessage(message.messageId).consecutiveDeliveryFailures,0);f.reopen();assert.equal(f.l.pendingSessionMessages('central',{messageId:message.messageId,forAdmission:true})[0].admission,'defer');
 f.advance(60000);for(let n=0;n<3;n++)f.l.recordTaskReturnFailure(message.messageId,'RETURN_UNAVAILABLE');assert.equal(f.l.getSessionMessage(message.messageId).state,'failed');assert.equal(f.l.checkins.view(task.taskId).phase,'needs_action');f.l.checkins.tick();assert.equal(f.messages().length,0);
 f.l.retryTaskReturn('manual-recover',message.messageId);f.advance(30*60000);assert.equal(f.messages()[0].messageId,message.messageId);assert.equal(f.l.snapshot().runs.length,1);assert.equal(f.l.getRun(run.runId).state,'running');
});

test('factual queued or running children suppress ordinary periodic checks but not the parents explicit upper bound',t=>{
 const f=fixture(t),{task,run,start}=expectedRun(f),ref=start();f.l.markExecutionStarted('actual',ref);f.l.bindSession('binding',{...ref,sessionId:'worker-parent'});
 const child=f.l.delegateTask('child',{...ref,title:'Child',expectedExecutionMs:3000}).value;assert.equal(child.run.executionExpectation.phase,'pending_start');
 f.advance(1000);f.l.checkins.tick();assert.equal(f.l.checkins.view(task.taskId).category,'waiting_children');assert.equal(f.messages().length,0);
 f.advance(1000);f.l.checkins.tick();assert.equal(f.messages()[0].checkIn.runId,run.runId);f.ack(f.messages()[0]);f.advance(10000);f.l.checkins.tick();assert.equal(f.messages().length,0,'a check reply does not rearm a deadline or the normal child wait');
});

test('invalid explicit bounds reject before a Run and legacy records have no invented execution start',t=>{
 const f=fixture(t),r=route(f),task=f.task();for(const value of [0,-1,1.5,Infinity,31*86400000])assert.throws(()=>f.l.createRun('invalid-'+value,{taskId:task.taskId,route:r,expectedExecutionMs:value}));
 assert.equal(f.l.snapshot().runs.length,0);assert.equal(f.l.checkins.executionView(task.taskId).phase,'not_set');
});

test('deadline stays in outbox during an explicit pause or user decision and resumes without replacing its event',t=>{
 const f=fixture(t),{task,run,start}=expectedRun(f),ref=start();f.l.markExecutionStarted('actual',ref);
 const responsibility=(state,key)=>f.l.withDispatchOrigin(owner(),()=>f.l.taskCheckin({action:'responsibility',taskId:task.taskId,commandId:key,expectedVersion:f.l.checkins.view(task.taskId).responsibilityVersion,state,summary:'Recorded by the responsible coordinator'}));
 responsibility('needs_user','needs-user');f.advance(2000);f.l.checkins.tick();const message=f.l.sessionMessages(task.taskId).find(m=>m.checkIn?.kind==='execution-deadline');assert.ok(message);assert.equal(f.l.checkins.disposition(message),'defer');assert.equal(f.messages().length,0);assert.equal(f.l.checkins.view(task.taskId).responsibility.state,'needs_user','enqueuing a reminder is not new business evidence');
 responsibility('coordinator','resume-owner');assert.equal(f.messages()[0].messageId,message.messageId);
 f.update(task,{kind:'paused',reason:'Explicitly paused pending external approval'},'pause-deadline');assert.equal(f.messages().length,0);f.reopen();assert.equal(f.l.checkins.disposition(message),'defer');
 f.update(task,{kind:'scheduled'},'unpause-deadline');assert.equal(f.messages()[0].messageId,message.messageId);assert.equal(f.l.getRun(run.runId).state,'running');
});

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

test('a processed current result supersedes old check delivery failure and actually resumes one due check',t=>{
 const f=fixture(t),task=f.task('recovered-check');f.l.checkins.request('first-check',task.taskId);const check=f.messages()[0];
 for(let n=0;n<3;n++)f.l.recordTaskReturnFailure(check.messageId,'RETURN_UNAVAILABLE');
 const run=f.l.withDispatchOrigin(owner(),()=>f.l.createRun('run',{taskId:task.taskId,route:route(f)}).value),a=f.l.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
 f.advance();f.l.submit('failure',{runId:run.runId,attemptId:a.attemptId,nodeId:'worker',fence:a.fence,outcome:'failure',summary:'Coordinator assessed the actual outcome'});
 const returned=f.l.sessionMessages(task.taskId).find(m=>m.completion);f.l.completeSessionMessage('return-processed',{messageId:returned.messageId,nodeId:'central',state:'completed',reply:'Current result handled'});
 assert.equal(f.l.checkins.view(task.taskId).phase,'scheduled');assert.doesNotMatch(f.l.checkins.view(task.taskId).reason,/请修复/);
 f.advance(60000);f.l.checkins.tick();const due=f.messages().filter(m=>m.checkIn);assert.equal(due.length,1);assert.notEqual(due[0].messageId,check.messageId);f.l.checkins.tick();assert.equal(f.messages().filter(m=>m.checkIn).length,1);
 assert.equal(f.l.getSessionMessage(check.messageId).state,'failed','old delivery record remains history');
});

test('queued work waits without periodic questions; explicit checks and real failure recovery remain available',t=>{
 const f=fixture(t),r=route(f),task=f.task(),run=f.l.createRun('run',{taskId:task.taskId,route:r}).value;
 f.advance();f.l.checkins.tick();assert.equal(f.messages().length,0);assert.equal(f.l.checkins.view(task.taskId).category,'waiting_execution');
 f.l.checkins.request('explicit-queue-check',task.taskId);const message=f.messages()[0];assert.ok(message);
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
 f.advance(20000);f.l.checkins.tick();assert.equal(f.messages().length,0,'session recovery interval applies to another task');f.advance(40000);assert.equal(f.messages().length,1);assert.equal(f.messages()[0].checkIn.tasks[0].taskId,a.taskId);
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


test('exhausted uncertain result return stops task check-ins until that original event is manually retried',t=>{
 const f=fixture(t),task=f.task('unanswered'),run=f.l.withDispatchOrigin(owner(),()=>f.l.createRun('run',{taskId:task.taskId,route:route(f)}).value);
 const claim=f.l.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value;
 f.l.submit('unknown',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,outcome:'unknown',summary:'Execution ended without task_submit_result'});
 const message=f.messages().find(m=>m.completion);
 for(let n=0;n<3;n++)f.l.recordTaskReturnFailure(message.messageId,'RETURN_UNAVAILABLE');
 assert.equal(f.l.getRun(run.runId).state,'uncertain');assert.equal(f.l.getTask(task.taskId).state,'waiting');
 f.advance(600000);f.l.checkins.tick();
 assert.equal(f.l.checkins.view(task.taskId).phase,'needs_action');assert.equal(f.l.checkins.view(task.taskId).canRequest,false);
 assert.equal(f.messages().length,0,'a check-in must not restart the exhausted conversation');
 f.l.retryTaskReturn('manual-return',message.messageId);assert.equal(f.messages()[0].messageId,message.messageId);
 f.l.completeSessionMessage('return-processed',{messageId:message.messageId,nodeId:'central',state:'completed',reply:'Verified current uncertain execution'});
 f.l.checkins.tick();assert.ok(f.messages().some(m=>m.checkIn),'manual recovery restores follow-up without rerunning uncertain effects');
 assert.equal(f.l.history(task.taskId).runs.length,1);
});

test('responsibility is owner-only, versioned and separate from execution and user acceptance',t=>{
 const f=fixture(t),task=f.task(),r=route(f),run=f.l.createRun('run',{taskId:task.taskId,route:r}).value;
 const claim=f.l.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value;
 f.l.submit('failure',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,outcome:'failure',summary:'Actual execution failed'});
 const before=JSON.stringify({run:f.l.getRun(run.runId),reports:f.l.history(task.taskId).reports});
 const status=()=>f.l.checkins.view(task.taskId);
 const write=(state,commandId,version=status().responsibilityVersion,actor=owner())=>f.l.withDispatchOrigin(actor,()=>f.l.taskCheckin({action:'responsibility',taskId:task.taskId,commandId,expectedVersion:version,state,summary:state==='needs_user'?'Please restore the missing workspace grant':'Checked the original evidence and arranged follow-up'}));
 const first=status().responsibilityVersion;
 assert.throws(()=>write('resolved','forged',first,owner('other')),e=>e.code==='FORBIDDEN');
 write('coordinator','take');assert.equal(status().responsibility.state,'coordinator');
 assert.throws(()=>write('resolved','stale',first),e=>e.code==='CONFLICT');
 write('needs_user','escalate');assert.match(status().responsibility.summary,/workspace grant/);
 write('resolved','resolve');assert.equal(status().phase,'closed');assert.equal(status().responsibility.state,'resolved');
 assert.equal(JSON.stringify({run:f.l.getRun(run.runId),reports:f.l.history(task.taskId).reports}),before);
 f.advance(10000);f.l.checkins.tick();assert.equal(f.messages().filter(m=>m.checkIn).length,0);
 f.reopen();assert.equal(status().responsibility.state,'resolved');
 f.l.createRun('next-run',{taskId:task.taskId,route:r});assert.equal(status().responsibility,null);assert.notEqual(status().phase,'closed');
});

test('responsible session cannot close pending user review or approval and evidence invalidates declarations',t=>{
 const f=fixture(t),task=f.task(),r=route(f),run=f.l.createRun('run',{taskId:task.taskId,route:r}).value;
 const claim=f.l.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value;
 const write=(state,key)=>f.l.withDispatchOrigin(owner(),()=>f.l.taskCheckin({action:'responsibility',taskId:task.taskId,commandId:key,expectedVersion:f.l.checkins.view(task.taskId).responsibilityVersion,state,summary:'Explicit responsible session declaration'}));
 write('coordinator','working');
 f.l.submit('partial',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,outcome:'partial',summary:'Only part delivered'});
 assert.equal(f.l.checkins.view(task.taskId).responsibility,null);
 assert.equal(f.l.getRun(run.runId).reviewStatus,'pending_user');
 assert.throws(()=>write('resolved','bypass-review'),e=>e.code==='FORBIDDEN');
 write('coordinator','coordinate-review');f.l.reviewRun('rejected',{runId:run.runId,decision:'rejected',reason:'User requests revision'});
 assert.equal(f.l.checkins.view(task.taskId).responsibility,null);
 const gated=f.l.withDispatchOrigin(owner(),()=>f.l.createTask('gated',{title:'Requires approval',requiresConfirmation:true}).value);
 assert.throws(()=>f.l.withDispatchOrigin(owner(),()=>f.l.taskCheckin({action:'responsibility',commandId:'bypass-approval',taskId:gated.taskId,expectedVersion:f.l.checkins.view(gated.taskId).responsibilityVersion,state:'resolved',summary:'Cannot grant myself approval'})),e=>e.code==='FORBIDDEN');
});

test('responsibility written while processing a result survives its ACK but a new delivery failure invalidates it',t=>{
 const f=fixture(t),task=f.task(),run=f.l.withDispatchOrigin(owner(),()=>f.l.createRun('run',{taskId:task.taskId,route:route(f)}).value);
 const claim=f.l.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value;
 f.l.submit('failure',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,outcome:'failure',summary:'Failed, coordinator can handle'});
 const message=f.messages().find(m=>m.completion);
 assert.ok(message);
 const write=(state,key)=>f.l.withDispatchOrigin(owner(),()=>f.l.taskCheckin({action:'responsibility',taskId:task.taskId,commandId:key,expectedVersion:f.l.checkins.view(task.taskId).responsibilityVersion,state,summary:'Inspected failure and ended this follow-up'}));
 write('coordinator','coordinating-return');
 f.l.recordTaskReturnFailure(message.messageId,'RETURN_UNAVAILABLE');assert.equal(f.l.checkins.view(task.taskId).responsibility,null);
 write('resolved','resolved-during-return');
 f.l.completeSessionMessage('return-ack',{messageId:message.messageId,nodeId:'central',state:'completed',reply:'Handled in the original session'});
 assert.equal(f.l.checkins.view(task.taskId).responsibility.state,'resolved');
 assert.equal(f.l.checkins.view(task.taskId).phase,'closed');
 f.l.queueTaskNote('new-evidence',{taskId:task.taskId,body:'A newly discovered issue',actor:'fixture'});
 assert.equal(f.l.checkins.view(task.taskId).responsibility,null);
});

test('active, queued and uncertain effects including child execution cannot be hidden as resolved',t=>{
 const f=fixture(t),r=route(f),parent=f.task(),child=f.l.withDispatchOrigin(owner(),()=>f.l.createTask('child',{title:'Child',parentTaskId:parent.taskId}).value);
 const run=f.l.createRun('child-run',{taskId:child.taskId,route:r}).value;
 const resolve=key=>f.l.withDispatchOrigin(owner(),()=>f.l.taskCheckin({action:'responsibility',taskId:parent.taskId,commandId:key,expectedVersion:f.l.checkins.view(parent.taskId).responsibilityVersion,state:'resolved',summary:'Must not hide active work'}));
 assert.throws(()=>resolve('queued'),e=>e.code==='CONFLICT');
 f.l.claim('claim-child',{runId:run.runId,nodeId:'worker',ttlMs:10000});assert.throws(()=>resolve('running'),e=>e.code==='CONFLICT');
 f.advance(11000);f.l.recoverExpired('expired');assert.equal(f.l.getRun(run.runId).state,'uncertain');assert.throws(()=>resolve('uncertain'),e=>e.code==='CONFLICT');
 assert.equal(f.l.checkins.view(parent.taskId).responsibility,null);
});

test('needs_user suppresses automatic wakeups but allows a one-shot check and coordinator resumption',t=>{
 const f=fixture(t),task=f.task();
 const write=(state,key)=>f.l.withDispatchOrigin(owner(),()=>f.l.taskCheckin({action:'responsibility',taskId:task.taskId,commandId:key,expectedVersion:f.l.checkins.view(task.taskId).responsibilityVersion,state,summary:'Explicitly recorded handling responsibility'}));
 write('needs_user','needs-user');f.advance(5000);f.l.checkins.tick();assert.equal(f.messages().length,0);
 assert.equal(f.l.checkins.view(task.taskId).category,'waiting_user');
 f.l.checkins.request('one-shot',task.taskId);const message=f.messages()[0];assert.ok(message);assert.equal(message.checkIn.automatic,false);
 f.ack(message);assert.equal(f.l.checkins.view(task.taskId).responsibility.state,'needs_user');
 f.advance(5000);f.l.checkins.tick();assert.equal(f.messages().length,0);
 write('coordinator','resume');f.l.checkins.tick();assert.equal(f.messages().length,1);
});

test('a child result awaiting user review blocks parent resolution and remains a user-facing gate',t=>{
 const f=fixture(t),r=route(f),parent=f.task(),child=f.l.withDispatchOrigin(owner(),()=>f.l.createTask('review-child',{title:'Child candidate',parentTaskId:parent.taskId}).value);
 const run=f.l.createRun('child-run',{taskId:child.taskId,route:r}).value,claim=f.l.claim('child-claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value;
 f.l.submit('child-partial',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,outcome:'partial',summary:'User must review this delivery'});
 assert.equal(f.l.checkins.view(parent.taskId).approvalRequired,true);
 assert.throws(()=>f.l.withDispatchOrigin(owner(),()=>f.l.taskCheckin({action:'responsibility',commandId:'close-parent',taskId:parent.taskId,expectedVersion:f.l.checkins.view(parent.taskId).responsibilityVersion,state:'resolved',summary:'Cannot close a child review'})),e=>e.code==='FORBIDDEN');
});
