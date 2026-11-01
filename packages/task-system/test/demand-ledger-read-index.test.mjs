import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TaskLedger,canonical} from '../dist/ledger.js';

const at='2026-10-26T01:00:00.000Z';
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const owner={kind:'session',nodeId:'central',sessionId:'owner'};
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'demand-index-')),file=join(dir,'ledger.sqlite');let now=Date.parse(at),ledger;
 const open=()=>ledger=TaskLedger.open(file,{nodeId:'central',now:()=>now,checkinIntervalMs:1000});open();
 t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
 return {get l(){return ledger;},file,advance(ms=1000){now+=ms;},reopen(){ledger.close();open();},drain(){for(let n=0;n<20;n++)if(ledger.demandReads.reconcileFacts())return;assert.fail('facts did not converge');}};
}
function put(f,kind,value){const id=value.taskId && kind==='task'?value.taskId:value.runId && kind==='run'?value.runId:value.reportId && kind==='report'?value.reportId:value.attemptId && kind==='attempt'?value.attemptId:value.messageId;f.l.managementDatabase().prepare('INSERT INTO entities(kind,id,data) VALUES(?,?,?)').run(kind,id,JSON.stringify(value));}
const task=(id,extra={})=>({taskId:id,title:id,description:'requirements',kind:'ad_hoc',state:'failed',tags:[],createdAt:at,updatedAt:at,...extra});
const run=(id,taskId,extra={})=>({runId:id,taskId,state:'failed',createdAt:at,updatedAt:at,sessionIds:[],configuration:{},route:{nodeId:'worker',workspaceId:'ws',provider:'fixture',model:'small',requiredCapabilities:[]},...extra});
const report=(id,taskId,runId,extra={})=>({reportId:id,taskId,runId,revision:1,title:id,body:'result',artifactIds:[],kind:'result',createdAt:at,recordedAt:at,...extra});
function sourceReads(db){
 const original=db.prepare.bind(db),reads=[];
 db.prepare=sql=>{
  const stmt=original(sql),authority=/(?:FROM|JOIN) (entities|events)\b/.test(sql);
  const observe=(row,args)=>{
   if(!authority||!row||typeof row.data!=='string')return;
   const value=JSON.parse(row.data),literal=sql.match(/kind='([^']+)'/),kind=/FROM events\b/.test(sql)?'event':literal?.[1]??(/kind=\?/.test(sql)&&typeof args[0]==='string'?args[0]:value.eventId?'event':value.reportId?'report':value.attemptId?'attempt':value.messageId?'sessionMessage':value.runId?'run':value.taskId?'task':'entity');
   const id=value.eventId??value.reportId??value.attemptId??value.messageId??value.runId??value.taskId??args[1]??'unknown';
   reads.push([kind,id,Buffer.byteLength(row.data)]);
  };
  for(const method of ['get','all']){const invoke=stmt[method].bind(stmt);stmt[method]=(...args)=>{const result=invoke(...args);for(const row of Array.isArray(result)?result:result?[result]:[])observe(row,args);return result;};}
  if(stmt.iterate){const iterate=stmt.iterate.bind(stmt);stmt.iterate=function*(...args){for(const row of iterate(...args)){observe(row,args);yield row;}};}
  return stmt;
 };
 return {reads,reset(){reads.length=0;},dispose(){db.prepare=original;}};
}

test('unclaimed return and versioned backfill preserve canonical Run and Attempt indexes',t=>{
 const f=fixture(t),parent=task('parent',{state:'ready'}),execution=run('queued','parent',{state:'queued'});
 put(f,'task',parent);put(f,'run',execution);
 f.l.returnUnclaimedToInbox('return',{taskId:parent.taskId,runId:execution.runId});
 let db=f.l.managementDatabase();
 assert.deepEqual({...db.prepare("SELECT parent,state FROM entities WHERE kind='run' AND id=?").get(execution.runId)},{parent:'parent',state:'cancelled'});
 const a={attemptId:'legacy-attempt',taskId:'parent',runId:'queued',nodeId:'worker',fence:1,state:'settled',leaseExpiresAt:at,createdAt:at,updatedAt:at};put(f,'attempt',a);
 db.exec('DROP TRIGGER canonical_entity_update');
 db.prepare("UPDATE entities SET parent='wrong',state=NULL WHERE kind IN ('run','attempt')").run();
 db.prepare("DELETE FROM ledger_index_migrations WHERE name='canonical-parent-state-v1'").run();
 f.reopen();db=f.l.managementDatabase();
 assert.deepEqual({...db.prepare("SELECT parent,state FROM entities WHERE kind='run' AND id='queued'").get()},{parent:'parent',state:'cancelled'});
 assert.deepEqual({...db.prepare("SELECT parent,state FROM entities WHERE kind='attempt' AND id='legacy-attempt'").get()},{parent:'queued',state:'settled'});
 assert.equal(f.l.demandReads.fact('run','queued').state,'cancelled');
});

test('growing cold history on one task does not decode payload on action/checkin/idle maintenance reads',t=>{
 const f=fixture(t);put(f,'task',task('fixed',{unknownPayload:'x'.repeat(32768)}));
 const db=f.l.managementDatabase(),observed=sourceReads(db);t.after(()=>observed.dispose());
 let seeded=0;
 for(const total of [0,24,80]){
  for(;seeded<total;seeded++){
   const id='cold-'+seeded,large='x'.repeat(16384);
   put(f,'run',run(id,'fixed',{configuration:{large},contextNotes:[large],projectContext:{version:1,schedulerId:'s',project:{projectId:'p',revision:1,title:'P',goal:large,description:large,acceptanceCriteria:[]}},unknownPayload:large}));
   put(f,'report',report('report-'+id,'fixed',id,{body:large,data:{large}}));
   put(f,'sessionMessage',{messageId:'message-'+id,taskId:'fixed',nodeId:'central',sessionId:'owner',workspaceId:'ws',state:'completed',text:'t'.repeat(8000),reply:'r'.repeat(12000),createdAt:at,updatedAt:at,
    completion:{eventId:'completion-'+id,runId:id,origin:{...owner,continuation:{id:'continuation',data:large}}},unknownPayload:large});
   db.prepare('INSERT INTO events(id,task_id,run_id,data) VALUES(?,?,?,?)').run('event-'+id,'fixed',id,JSON.stringify({eventId:'event-'+id,taskId:'fixed',runId:id,type:'run.settled',at,detail:{summary:large,payload:large}}));
  }
  f.drain();f.l.checkins.tick();f.drain();observed.reset();
  f.l.taskActionState('fixed');f.l.checkins.view('fixed');f.l.checkins.tick();f.l.allSettled('fixed',0,undefined,true);
  if(total)assert.equal(f.l.resultRetryInfo('cold-'+(total-1)).eligible,false);
  assert.deepEqual(f.l.pendingRuns('worker'),[]);assert.deepEqual(f.l.scheduleDue(),[]);assert.equal(f.l.recoveryNeeded(),false);assert.deepEqual(f.l.pendingSessionMessages('central'),[]);
  assert.deepEqual(observed.reads,[],`cold payload reads at ${total} historical Runs`);
  const rows=db.prepare("SELECT kind,length(data) AS bytes FROM demand_entity_facts WHERE kind IN ('task','run','report','sessionMessage','event')").all();
  assert.ok(rows.every(row=>Number(row.bytes)<6000),'compact facts must not hide copies of large history');
 }
 assert.equal(f.l.snapshot().reports.length,80,'explicit snapshot remains complete');
 assert.equal(f.l.snapshot().reports[0].body.length,16384);assert.equal(f.l.snapshot().events.length,80);assert.equal(f.l.sessionMessages('fixed').length,80);
});

test('v2 migration retains current valid handled and responsibility receipts and leaves stale receipts invalid',t=>{
 const f=fixture(t),db=f.l.managementDatabase();
 for(const id of ['valid','stale']){
  const a=task(id,{dispatchOrigin:owner}),r=run(id+'-run',id,{projectContext:{version:1,schedulerId:'s',project:{projectId:'p',revision:1,title:'P',goal:'large'.repeat(4000),description:'evidence',acceptanceCriteria:[]}}});
  put(f,'task',a);put(f,'run',r);
  const action=hash({task:[id,a.state,a.updatedAt,null],runs:[[r.runId,r.state,null,false,null,null,r.route,null,r.projectContext]],reports:[]});
  const responsibility=createHash('sha256').update(JSON.stringify({tasks:[[id,action]],scope:[[r.runId,action]],returns:[],attention:null})).digest('hex');
  db.prepare("INSERT INTO entities(kind,id,data) VALUES('task-attention',?,?)").run(id,JSON.stringify({fingerprint:id==='valid'?action:'stale',handled:true}));
  db.prepare("INSERT INTO entities(kind,id,parent,data) VALUES('taskResponsibility',?,?,?)").run(id,id,JSON.stringify({state:'coordinator',summary:'I own this evidence',at,nodeId:'central',sessionId:'owner',fingerprint:id==='valid'?responsibility:'stale',revision:1}));
 }
 db.prepare("DELETE FROM ledger_index_migrations WHERE name='demand-fingerprints-v2'").run();
 f.reopen();
 assert.equal(f.l.taskActionState('valid').handled,true);assert.equal(f.l.taskActionState('stale').handled,false);
 assert.equal(f.l.checkins.view('valid').responsibility?.state,'coordinator');assert.equal(f.l.checkins.view('stale').responsibility,null);
 const after=f.l.managementDatabase();
 after.prepare("UPDATE entities SET data=json_set(data,'$.projectContext.project.goal','changed') WHERE kind='run' AND id='valid-run'").run();
 assert.equal(f.l.taskActionState('valid').handled,false);assert.equal(f.l.checkins.view('valid').responsibility,null);
});

test('read-model budgets retain progress, refuse partial reads, and survive reopening',t=>{
 const f=fixture(t);
 for(let i=0;i<300;i++)put(f,'task',task('bulk-'+i));
 let reads=0,projects=0;
 f.l.demandReads.bindProjector(()=>{projects++;});
 assert.throws(()=>f.l.demandReads.withCurrent(()=>{reads++;}),error=>error.code==='READ_MODEL_UPDATING');
 assert.equal(reads,0);assert.equal(f.l.managementDatabase().prepare('SELECT count(*) AS n FROM demand_source_dirty').get().n,44);
 f.reopen();f.l.demandReads.bindProjector(()=>{projects++;});
 for(let i=0;i<4;i++){try{f.l.demandReads.withCurrent(()=>{reads++;});break;}catch(error){assert.equal(error.code,'READ_MODEL_UPDATING');}}
 assert.equal(reads,1);assert.equal(projects,300);
});

test('migration rollback does not commit a partially rebound receipt or readiness marker',t=>{
 const f=fixture(t);put(f,'task',task('rollback'));
 const db=f.l.managementDatabase();
 db.prepare("DELETE FROM ledger_index_migrations WHERE name='demand-fingerprints-v2'").run();
 db.exec("CREATE TRIGGER reject_read_migration BEFORE INSERT ON ledger_index_migrations WHEN NEW.name='demand-fingerprints-v2' BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END");
 assert.throws(()=>f.reopen(),/fixture migration failure/);
 // The failed constructor releases its transaction; a separate writer can repair and retry.
 const repair=new DatabaseSync(f.file);repair.exec('DROP TRIGGER reject_read_migration');
 assert.equal(repair.prepare("SELECT count(*) AS n FROM ledger_index_migrations WHERE name='demand-fingerprints-v2'").get().n,0);repair.close();
 f.reopen();assert.equal(f.l.demandReads.fact('task','rollback').taskId,'rollback');
});

test('candidate deadlines compare instants and preserve legal timezone offsets',t=>{
 const f=fixture(t),db=f.l.managementDatabase();
 for(const [id,deadline] of [['due','2026-10-26T11:00:00+10:00'],['future','2026-10-25T20:00:01-05:00']]){
  put(f,'task',task(id,{state:'running'}));
  put(f,'run',run(id+'-run',id,{state:'running',currentAttemptId:id+'-attempt'}));
  put(f,'attempt',{attemptId:id+'-attempt',taskId:id,runId:id+'-run',nodeId:'worker',fence:1,state:'running',leaseExpiresAt:deadline,createdAt:at,updatedAt:at});
  db.prepare("INSERT INTO entities(kind,id,data) VALUES('schedule',?,?)").run(id+'-schedule',JSON.stringify({scheduleId:id+'-schedule',taskId:id,enabled:true,nextDueAt:deadline,templateId:'t',templateVersion:1,input:{},overlap:'skip'}));
 }
 assert.equal(f.l.recoveryNeeded(),true);
 assert.deepEqual(f.l.scheduleDue().map(s=>s.scheduleId),['due-schedule']);
 assert.deepEqual(f.l.recoverExpired('expire').value.expired.map(a=>a.attemptId),['due-attempt']);
 assert.equal(f.l.getAttempt('future-attempt').state,'running');assert.equal(f.l.recoveryNeeded(),false);
 f.advance(1000);assert.equal(f.l.recoveryNeeded(),true);
});

test('workflow invocation and step markers remain distinct and origin alone is no node assignment',t=>{
 const f=fixture(t);
 put(f,'task',task('root'));put(f,'task',task('step'));
 put(f,'run',run('root-run','root',{state:'uncertain',route:undefined,dispatchOrigin:owner,configuration:{workflowInvocation:{workflowId:'flow'}}}));
 put(f,'run',run('step-run','step',{state:'uncertain',configuration:{workflow:{workflowId:'flow',stepId:'step'}}}));
 const root=f.l.demandReads.fact('run','root-run'),step=f.l.demandReads.fact('run','step-run');
 assert.equal(root.workflowInvocation,true);assert.equal(root.workflow,false);assert.equal(step.workflowInvocation,false);assert.equal(step.workflow,true);
 assert.equal(f.l.managementDatabase().prepare("SELECT node_id FROM demand_entity_facts WHERE kind='run' AND id='root-run'").get().node_id,null);
 assert.equal(f.l.taskActionState('root').canReconcile,false);assert.equal(f.l.taskActionState('step').canReconcile,true);
});

test('unchanged paused deadline maintenance never rereads queued message or active Run payload',t=>{
 const f=fixture(t),db=f.l.managementDatabase();
 put(f,'task',task('live',{state:'running',dispatchOrigin:owner}));
 put(f,'run',run('live-run','live',{state:'running',dispatchOrigin:owner,currentAttemptId:'live-attempt',configuration:{large:'x'.repeat(32768)},executionExpectation:{phase:'started',startedAt:'2026-10-26T00:59:00.000Z',expectedExecutionMs:1000}}));
 put(f,'attempt',{attemptId:'live-attempt',taskId:'live',runId:'live-run',nodeId:'worker',fence:1,state:'running',leaseExpiresAt:'2026-10-26T01:01:00.000Z',createdAt:at,updatedAt:at});
 db.prepare("INSERT INTO entities(kind,id,parent,data) VALUES('taskCheckin','live','live',?)").run(JSON.stringify({taskId:'live',revision:1,plan:{kind:'paused',reason:'waiting'},checksWithoutUpdate:0,deliveryFailures:0}));
 const messageId='task-execution-check:live-run';
 put(f,'sessionMessage',{messageId,taskId:'live',nodeId:'central',sessionId:'owner',workspaceId:'ws',state:'queued',text:'large prompt'.repeat(3000),createdAt:at,updatedAt:at,
   checkIn:{kind:'execution-deadline',eventId:messageId,runId:'live-run',origin:{...owner,continuation:{id:'large-origin',data:'x'.repeat(32768)}},tasks:[],automatic:true}});
 f.drain();f.l.checkins.tick();f.drain();
 const observed=sourceReads(db);t.after(()=>observed.dispose());
 for(let n=0;n<3;n++){f.l.checkins.tick();f.l.checkins.view('live');assert.deepEqual(f.l.pendingSessionMessages('central'),[]);}
 assert.ok(observed.reads.every(([kind,,bytes])=>['taskCheckin','taskResponsibility','task-attention'].includes(kind)&&bytes<4000),JSON.stringify(observed.reads));
 observed.dispose();assert.equal(f.l.getSessionMessage(messageId).state,'queued');
});


test('clean facts remain readable under an independent authority lock and dirty lock failures retry safely',t=>{
 const f=fixture(t),db=f.l.managementDatabase();put(f,'task',task('locked'));f.drain();
 db.exec('PRAGMA busy_timeout=0');const lock=new DatabaseSync(f.file);
 try {
  lock.exec('BEGIN IMMEDIATE');
  assert.equal(f.l.demandReads.fact('task','locked').title,'locked');
  assert.equal(f.l.checkins.view('locked').category,'needs_owner');
  lock.exec('ROLLBACK');
  db.prepare("UPDATE entities SET data=json_set(data,'$.title','changed') WHERE kind='task' AND id='locked'").run();
  lock.exec('BEGIN IMMEDIATE');
  assert.throws(()=>f.l.demandReads.fact('task','locked'),/locked/);
  assert.equal(db.prepare("SELECT json_extract(data,'$.title') title FROM demand_entity_facts WHERE kind='task' AND id='locked'").get().title,'locked');
  assert.ok(db.prepare('SELECT 1 FROM demand_source_dirty LIMIT 1').get(),'failed reconciliation retains dirty work');
  lock.exec('ROLLBACK');
  assert.equal(f.l.demandReads.fact('task','locked').title,'changed','a failed BEGIN cannot leave reconciling stuck');
 } finally {if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}
});
