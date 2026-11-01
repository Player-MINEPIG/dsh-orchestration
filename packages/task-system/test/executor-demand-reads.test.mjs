import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../dist/ledger.js';
import {RecoveryStore} from '../dist/remote/store.js';
import {ExecutorDemandReads} from '../dist/remote/executor-reads.js';
import {executorAlertFingerprint} from '../dist/executor-alerts.js';
const at='2026-10-26T01:00:00.000Z',old='2026-10-01T01:00:00.000Z';
const task=(id,extra={})=>({taskId:id,title:id,description:'requirements-'+id,kind:'ad_hoc',state:'completed',tags:[],createdAt:at,updatedAt:at,...extra});
const run=(id,taskId,extra={})=>({runId:id,taskId,state:'succeeded',createdAt:at,updatedAt:at,sessionIds:[],configuration:{},route:{nodeId:'worker',workspaceId:'ws',provider:'fixture',model:'small',requiredCapabilities:[]},...extra});
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'executor-demand-')),ledger=TaskLedger.open(join(dir,'ledger.sqlite'),{nodeId:'worker'}),store=new RecoveryStore(join(dir,'recovery.sqlite'));
 let queueRevision='q0',queue=[],pending=[],pendingReads=0;
 const sources={ledger,store,nodeId:'worker',queue:()=>({revision:queueRevision,records:queue}),pending:()=>pending,
  pendingDetail:id=>{pendingReads++;return {settlement:{summary:'ready',report:{body:'pending body '+id}}};},
  decorate:row=>row.source==='local-recovery'?{...row,alert:store.executorAlert('dispatch:'+row.attemptId,executorAlertFingerprint({state:row.state,outcome:row.outcome??null}),!['dispatching','uncertain'].includes(row.state))}:row,
  decorateClaim:row=>({commandId:row.commandId,runId:row.runId,state:row.state,endpoint:row.endpoint,audience:row.audience,...(row.code?{code:row.code,message:row.message}:{}),resolved:false,authorityDisposition:null,dispositionObservedAt:null,alert:store.executorAlert('claim:'+row.commandId,executorAlertFingerprint(row),true)}),
  context:()=>({queueObservedAt:at,pollState:'ready',connection:null,heartbeat:null})};
 const readers=[];let reader;
 const openReader=()=>{const next=new ExecutorDemandReads(sources);readers.push(next);return next;};reader=openReader();
 t.after(()=>{for(const r of readers)r.close();ledger.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const put=(kind,id,value)=>ledger.managementDatabase().prepare('INSERT INTO entities(kind,id,data) VALUES(?,?,?)').run(kind,id,JSON.stringify(value));
 return {ledger,store,sources,get reader(){return reader;},openReader,read(method,input={}){return ledger.demandReads.withFacts(()=>reader.read(method,input));},rebuild(){reader=openReader();},
  task(value){put('task',value.taskId,value);},run(value){put('run',value.runId,value);},attempt(value){put('attempt',value.attemptId,value);},
  dispatch(id,taskId=id,extra={}){const a=task(taskId),r=run(id,taskId),attempt={attemptId:'attempt-'+id,taskId,runId:id,nodeId:'worker',fence:1,state:'settled',leaseExpiresAt:at,createdAt:at,updatedAt:at};const value={attemptId:attempt.attemptId,state:'acknowledged',claim:{task:a,run:r,attempt},lease:{runId:id,attemptId:attempt.attemptId,nodeId:'worker',fence:1},sessionId:'session-'+id,result:{outcome:'success',summary:'done '+id,report:{title:'report',body:'body '+id}},...extra};store.createDispatch(value);return value;},
  queue(rows){queue=rows;queueRevision+='x';},pending(rows){pending=rows;},get pendingReads(){return pendingReads;}};
}
function rawReads(db,t){const original=db.prepare.bind(db),seen=[];db.prepare=sql=>{const stmt=original(sql);for(const method of ['get','all']){const invoke=stmt[method].bind(stmt);stmt[method]=(...args)=>{const rows=invoke(...args);if(/(?:FROM|JOIN) (entities|events|dispatches|outbound)\b/.test(sql))for(const row of Array.isArray(rows)?rows:rows?[rows]:[])if(typeof row.data==='string'){const v=JSON.parse(row.data);seen.push({id:v.attemptId??v.runId??v.taskId??v.reportId,bytes:Buffer.byteLength(row.data)});}return rows;};}return stmt;};t.after(()=>{db.prepare=original;});return seen;}

test('local executor pages merge sources before counts/limit and preserve durable ownership and session access',t=>{
 const f=fixture(t);f.task(task('shared'));f.run(run('shared','shared'));f.dispatch('shared','shared',{claim:{task:task('shared',{title:'Durable title'}),run:run('shared','shared'),attempt:{nodeId:'worker'}}});
 f.task(task('local'));f.run(run('local-run','local'));f.dispatch('recovery','recovery');
 f.queue([{taskId:'shared',runId:'shared',title:'Queue title',description:'queue',state:'queued',source:'local-queue',nodeId:'worker',time:at,sessionIds:[]},{taskId:'queue',runId:'queue-run',title:'Queue only',description:'q',state:'queued',source:'local-queue',nodeId:'worker',time:at,sessionIds:[]}]);
 const p1=f.read('taskPage',{pageSize:2}),p2=f.read('taskPage',{pageSize:2,page:1});
 assert.equal(p1.total,4);assert.equal(p2.total,4);assert.equal(new Set([...p1.items,...p2.items].map(row=>row.id)).size,4);
 const shared=[...p1.items,...p2.items].find(row=>row.id==='shared');assert.equal(shared.title,'Durable title');assert.equal(shared.source,'local-recovery');
 assert.equal(f.read('taskBoard',{columns:[{status:'done',page:0},{status:'queued',page:0}],pageSize:2}).counts.baseTotal,4);
 assert.equal(f.read('executionPage',{pageSize:50}).total,4);
 assert.equal(f.read('sessionTaskPage',{sessionId:'session-shared',pageSize:1}).total,1);
 assert.deepEqual(f.read('taskSessionAccess',{taskId:'shared',nodeId:'worker',sessionId:'session-shared'}),{allowed:true});
 assert.throws(()=>f.read('taskSessionAccess',{taskId:'shared',nodeId:'other',sessionId:'session-shared'}),error=>error.code==='FORBIDDEN');
 const detail=f.read('taskDetail',{taskId:'shared'});assert.equal(detail.task.description,'requirements-shared');assert.equal(detail.reports.total,1);
 assert.equal(f.read('taskReportDetail',{taskId:'shared',runId:'shared',reportId:detail.task.reportId}).body,'body shared');
 assert.deepEqual(f.read('taskAttentionGroupPage',{taskId:'shared'}).items,[]);
});

test('warm executor page/history/claim reads never load growing cold dispatch or ledger payloads',t=>{
 const f=fixture(t);f.task(task('hot'));f.run(run('hot-run','hot'));f.dispatch('hot-recovery');
 const local=rawReads(f.ledger.managementDatabase(),t),remote=rawReads(f.store.db,t);
 let seeded=0;
 for(const total of [0,20,60]){
  for(;seeded<total;seeded++){const id='cold-'+seeded,large='x'.repeat(16384);f.task(task(id,{description:large,createdAt:old,updatedAt:old}));f.run(run(id,id,{createdAt:old,updatedAt:old,configuration:{large},projectContext:{version:1,schedulerId:'s',project:{projectId:'p',title:'P',description:large,goal:large,revision:1,acceptanceCriteria:[]}}}));
   f.dispatch('remote-'+id,'remote-'+id,{claim:{task:task('remote-'+id,{description:large}),run:run('remote-'+id,'remote-'+id,{updatedAt:old,configuration:{large}}),attempt:{nodeId:'worker'}},result:{outcome:'success',summary:'done',report:{title:'cold',body:large}}});}
  f.read('taskPage',{pageSize:1});local.length=0;remote.length=0;
  const page=f.read('taskPage',{pageSize:1});f.read('taskBoard',{columns:[{status:'done',page:1}],pageSize:5});f.read('taskHistoryPage',{taskId:'hot',pageSize:5});f.read('executorClaimsPage',{pageSize:5});f.read('executionPage',{pageSize:5});
  assert.equal(page.total,2+2*total);assert.deepEqual(local,[]);assert.deepEqual(remote,[]);
  assert.ok(f.store.db.prepare('SELECT length(data) n FROM recovery_dispatch_headers').all().every(row=>row.n<6000));
 }
});

test('delta deletion, lagging readers after retention cleanup and reconstruction converge without payload mirroring',t=>{
 const f=fixture(t);f.task(task('local'));f.run(run('local-run','local'));const saved=f.dispatch('recovery');
 assert.equal(f.read('taskPage',{}).total,2);const lag=f.openReader();f.ledger.demandReads.withFacts(()=>lag.read('taskPage',{}));
 saved.claim.task.title='Changed durable';f.store.saveDispatch(saved);assert.ok(f.read('taskPage',{}).items.some(row=>row.title==='Changed durable'));
 const lagged=f.ledger.demandReads.withFacts(()=>lag.read('taskPage',{}));assert.ok(lagged.items.some(row=>row.title==='Changed durable'),'a trimmed cursor rebuilds compact headers instead of missing a change');
 f.store.db.prepare('DELETE FROM dispatches WHERE id=?').run(saved.attemptId);f.ledger.managementDatabase().prepare("DELETE FROM entities WHERE kind='run' AND id='local-run'").run();
 assert.equal(f.read('taskPage',{}).total,0);f.rebuild();assert.equal(f.read('taskPage',{}).total,0);
});

test('all unresolved claims have bounded pages and pending local results load body only when opened',t=>{
 const f=fixture(t);for(let i=0;i<225;i++)f.store.saveOutbound('claim-'+i,{operation:'claim',payload:{runId:'run-'+i},state:'uncertain',endpoint:'https://old.invalid',audience:'old'});
 const bootstrap=f.read('readBootstrap',{});assert.equal(bootstrap.executorClaims.total,225);assert.equal(bootstrap.executorClaims.items.length,20);
 const last=f.read('executorClaimsPage',{page:11,pageSize:20});assert.equal(last.items.length,5);assert.equal(last.total,225);
 f.task(task('local'));f.run(run('local-run','local'));f.pending([{commandId:'ready',runId:'local-run',attemptId:'attempt',sessionId:'native-session',state:'held',readyAt:Date.parse(at),reasonCode:'offline',summary:'ready summary'}]);
 const page=f.read('taskPage',{});assert.equal(page.items[0].status,'review');assert.equal(f.pendingReads,0);
 const detail=f.read('taskDetail',{taskId:'local'});assert.equal(detail.task.reportId,'native:ready');
 const before=f.pendingReads;assert.equal(f.read('taskReportDetail',{taskId:'local',runId:'local-run',reportId:'native:ready'}).body,'pending body ready');assert.equal(f.pendingReads,before+1);
});

test('session source scopes roots and descendants before rank/filter and uses parsed timestamp ordering',t=>{
 const f=fixture(t);f.task(task('root'));f.run(run('root-run','root',{updatedAt:'2026-10-26T00:00:00.000Z'}));
 f.task(task('child',{parentTaskId:'root'}));f.run(run('child-run','child',{state:'failed',updatedAt:'2026-10-25T20:00:00-05:00'}));
 f.task(task('unrelated'));f.run(run('unrelated-run','unrelated'));
 f.task(task('foreign',{parentTaskId:'root'}));f.run(run('foreign-run','foreign',{route:{nodeId:'other',provider:'fixture',model:'small',requiredCapabilities:[]}}));
 const q={sessionId:'owner-session',rootTaskIds:['root','foreign'],offset:0,limit:1};
 const first=f.read('sessionTaskPage',q);assert.equal(first.total,2);assert.equal(first.counts.all,2);assert.equal(first.directCount,1);assert.equal(first.unavailableTasks,1);assert.equal(first.items[0].id,'child');
 const filtered=f.read('sessionTaskPage',{...q,status:'done'});assert.equal(filtered.total,1);assert.equal(filtered.counts.error,1);assert.equal(filtered.items[0].id,'root');
 assert.equal(f.read('sessionTaskPage',{...q,offset:1}).items[0].id,'root');
});

test('execution ordinals and detail session aggregation use complete metadata across history pages',t=>{
 const f=fixture(t);f.task(task('multi'));
 for(let i=1;i<=3;i++){f.run(run('run-'+i,'multi',{updatedAt:`2026-10-26T01:00:0${i}.000Z`}));f.attempt({attemptId:'a-'+i,taskId:'multi',runId:'run-'+i,nodeId:'worker',fence:1,state:'settled',sessionId:'session-'+i,leaseExpiresAt:at,createdAt:at,updatedAt:at});}
 assert.equal(f.read('taskHistoryPage',{taskId:'multi',pageSize:1}).items[0].insertionOrdinal,3);
 assert.equal(f.read('taskHistoryPage',{taskId:'multi',pageSize:1,page:2}).items[0].insertionOrdinal,1);
 assert.deepEqual(f.read('taskDetail',{taskId:'multi'}).task.sessionIds,['session-1','session-2','session-3']);
 assert.equal(f.read('taskRunDetail',{taskId:'multi',runId:'run-1'}).attempts[0].attemptId,'a-1');
});

test('failed delta reconciliation restores relation maps and a retry removes deleted session membership',t=>{
 const f=fixture(t);f.task(task('owned'));f.run(run('owned-run','owned',{currentAttemptId:'owned-attempt'}));f.attempt({attemptId:'owned-attempt',taskId:'owned',runId:'owned-run',nodeId:'worker',fence:1,state:'settled',sessionId:'old-session',leaseExpiresAt:at,createdAt:at,updatedAt:at});
 assert.equal(f.read('sessionTaskPage',{sessionId:'old-session'}).total,1);
 f.ledger.managementDatabase().prepare("DELETE FROM entities WHERE kind='attempt' AND id='owned-attempt'").run();
 const decorate=f.sources.decorate;let fail=true;f.sources.decorate=row=>{if(fail){fail=false;throw Error('fixture projection failure');}return decorate(row);};
 assert.throws(()=>f.read('taskPage',{}),/fixture projection failure/);
 assert.equal(f.read('sessionTaskPage',{sessionId:'old-session'}).total,0);
});

test('board facets are shared across columns and large queue descriptions do not enter SQL headers',t=>{
 const f=fixture(t);f.queue([{taskId:'queued',runId:'queue-run',title:'Queue',description:'x'.repeat(32768),state:'queued',source:'local-queue',nodeId:'worker',time:at,sessionIds:[]}]);f.read('taskPage',{});
 const db=f.reader.db,prepare=db.prepare.bind(db);let groups=0;db.prepare=sql=>{if(sql.startsWith('SELECT status,count(*)'))groups++;return prepare(sql);};
 const board=f.read('taskBoard',{columns:['error','review','running','draft','queued','cancelling','done','handled','cancelled','archived'].map(status=>({status,page:0})),pageSize:5});
 assert.equal(board.counts.baseTotal,1);assert.equal(board.columns.queued.total,1);assert.equal(groups,2);
 assert.ok(db.prepare('SELECT length(data) n FROM records').all().every(row=>row.n<6000));
});

test('native session access rejects external execution identifiers even on the same local task',t=>{
 const f=fixture(t);f.task(task('external'));f.run(run('external-run','external',{route:{nodeId:'worker',provider:'fixture',model:'small',requiredCapabilities:[],backend:'official-codex'}}));
 f.attempt({attemptId:'external-attempt',taskId:'external',runId:'external-run',nodeId:'worker',fence:1,state:'settled',sessionId:'same-name',leaseExpiresAt:at,createdAt:at,updatedAt:at});
 assert.throws(()=>f.read('taskSessionAccess',{taskId:'external',nodeId:'worker',sessionId:'same-name'}),error=>error.code==='FORBIDDEN');
 f.task(task('native'));f.run(run('native-run','native'));f.attempt({attemptId:'native-attempt',taskId:'native',runId:'native-run',nodeId:'worker',fence:1,state:'settled',sessionId:'same-name',leaseExpiresAt:at,createdAt:at,updatedAt:at});
 assert.deepEqual(f.read('taskSessionAccess',{taskId:'native',nodeId:'worker',sessionId:'same-name'}),{allowed:true});
 assert.throws(()=>f.read('taskSessionAccess',{taskId:'native',nodeId:'foreign',sessionId:'same-name'}),error=>error.code==='FORBIDDEN');
});

test('session revisions ignore unrelated work and selected detail versions change on full body or requirement edits',t=>{
 const f=fixture(t);f.task(task('owned'));f.run(run('owned-run','owned'));
 const db=f.ledger.managementDatabase();db.prepare("INSERT INTO entities(kind,id,data) VALUES('report','owned-report',?)").run(JSON.stringify({reportId:'owned-report',taskId:'owned',runId:'owned-run',revision:1,title:'Report',body:'x'.repeat(2000),artifactIds:[],kind:'result',createdAt:at,recordedAt:at}));
 const q={sessionId:'session',rootTaskIds:['owned'],offset:0,limit:1};
 const first=f.read('sessionTaskPage',q);assert.equal(typeof first.items[0].detailVersion,'string');
 f.task(task('unrelated'));f.run(run('unrelated-run','unrelated'));
 const stable=f.read('sessionTaskPage',q);assert.equal(stable.revision,first.revision);assert.equal(stable.items[0].detailVersion,first.items[0].detailVersion);
 db.prepare("UPDATE entities SET data=json_set(data,'$.body',?) WHERE kind='report' AND id='owned-report'").run('x'.repeat(1999)+'y');
 const changed=f.read('sessionTaskPage',q);assert.notEqual(changed.items[0].detailVersion,first.items[0].detailVersion);
 db.prepare("UPDATE entities SET data=json_set(data,'$.description','changed requirements') WHERE kind='task' AND id='owned'").run();
 assert.notEqual(f.read('sessionTaskPage',q).items[0].detailVersion,changed.items[0].detailVersion);
});

test('session delivery and legacy workspace matching select exact headers before dispatch payload',t=>{
 const f=fixture(t);f.dispatch('z','target',{sessionId:'shared'});f.dispatch('a','target',{sessionId:'shared'});
 f.store.dispatches=()=>{throw Error('full dispatch history is forbidden');};
 assert.equal(f.store.sessionDispatch('shared','target','ws').attemptId,'attempt-a','retain the old id-ordered first matching dispatch');
 assert.equal(f.store.sessionDispatch('shared','target','other-workspace'),undefined);
 assert.equal(f.store.hasLegacySessionMapping('shared','target','worker'),true);assert.equal(f.store.hasLegacySessionMapping('shared','other-task','worker'),false);
 const contextual=f.dispatch('context','context',{sessionId:'context-session'});contextual.claim.run.projectContext={version:1,schedulerId:'s',project:null};f.store.saveDispatch(contextual);
 assert.equal(f.store.hasLegacySessionMapping('context-session','context','worker'),false);
});


test('excluding handled executor reminders applies before page totals and board facets',t=>{
 const f=fixture(t);f.queue([
  {taskId:'handled',runId:'handled-run',title:'Handled',description:'',state:'failed',source:'local-queue',nodeId:'worker',time:at,sessionIds:[],alert:{acknowledged:true,canAcknowledge:true,fingerprint:'handled'}},
  {taskId:'queued',runId:'queued-run',title:'Queued',description:'',state:'queued',source:'local-queue',nodeId:'worker',time:at,sessionIds:[]}
 ]);
 assert.equal(f.read('taskPage',{}).total,2);
 const page=f.read('taskPage',{excludeHandled:true,pageSize:1});
 assert.equal(page.total,1);assert.equal(page.items[0].id,'queued');assert.equal(page.counts.byStatus.handled,0);
 const board=f.read('taskBoard',{excludeHandled:true,columns:[{status:'queued',page:0},{status:'handled',page:0}],pageSize:1});
 assert.equal(board.counts.baseTotal,1);assert.equal(board.columns.queued.total,1);assert.equal(board.columns.handled.total,0);
});
