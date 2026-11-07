import test from 'node:test';
import {demandProductFixture} from './fixtures/demand-products.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../dist/ledger.js';
import {ProjectRuntime} from '../dist/project-runtime.js';

const fixture=demandProductFixture;

test('SQL task pages have global facets, stable pages, clamping and selected details only',t=>{
 const f=fixture(t),rows=[];
 for(let i=0;i<13;i++){const task=f.task('task-'+i),run=f.run(task,'run-'+i,i%2?'failed':'succeeded');f.report(task,run,'report-'+i);rows.push({task,run});}
 const first=f.read('taskPage',{presentation:'all',pageSize:5});assert.equal(first.total,13);assert.equal(first.items.length,5);assert.equal(first.counts.byStatus.done,7);assert.equal(first.counts.byStatus.error,6);
 const all=[0,1,2].flatMap(page=>f.read('taskPage',{presentation:'all',pageSize:5,page}).items.map(row=>row.id));assert.equal(new Set(all).size,13);
 assert.equal(f.read('taskPage',{presentation:'all',pageSize:5,page:99}).page,2);
 const filtered=f.read('taskPage',{presentation:'all',status:'error',pageSize:5});assert.equal(filtered.total,6);assert.equal(filtered.counts.baseTotal,13);
 const card=first.items[0];for(const field of ['description','report','reportHistory','supplementaryReports','configuration','projectContext'])assert.equal(field in card,false,field);
 const detail=f.read('taskDetail',{taskId:card.id});assert.match(detail.task.description,/selected description/);assert.equal(detail.runs.pageSize,5);
 const report=f.read('taskReportDetail',{taskId:card.id,reportId:card.reportId});assert.match(report.body,/selected body/);
});

test('latest supplementary report remains preferred when newer result history grows',t=>{
 const f=fixture(t),task=f.task('supplements'),run=f.run(task,'run');f.report(task,run,'supplement','note',{data:{supplemental:true}});f.report(task,run,'result-1');f.report(task,run,'result-2');f.report(task,run,'result-3');
 const page=f.read('taskPage',{presentation:'all'});assert.equal(page.items[0].reportId,'supplement');assert.equal(page.items[0].reportSource,'supplement');assert.equal(page.items[0].unreadResultCount,3);
});

test('node scope descends seeds then adds context ancestors without granting sibling branches',t=>{
 const f=fixture(t),root=f.task('root'),owned=f.task('owned',{parentTaskId:root.taskId}),child=f.task('descendant',{parentTaskId:owned.taskId}),sibling=f.task('secret sibling',{parentTaskId:root.taskId});
 f.run(owned,'owned-run','succeeded',{route:{nodeId:'worker',provider:'offline',model:'script',requiredCapabilities:[]}});f.run(sibling,'secret-run','failed',{route:{nodeId:'other',provider:'offline',model:'script',requiredCapabilities:[]}});
 const page=f.read('taskPage',{presentation:'all'},{kind:'node',nodeId:'worker'});assert.deepEqual(new Set(page.items.map(row=>row.id)),new Set([root.taskId,owned.taskId,child.taskId]));assert.equal(page.items.find(row=>row.id===root.taskId).childAttentionCount,0);
 assert.throws(()=>f.read('taskDetail',{taskId:sibling.taskId},{kind:'node',nodeId:'worker'}),error=>error.code==='NOT_FOUND');
});

test('warm page and idle maintenance do not decode added same-task cold Run/Report/Event payloads',t=>{
 const f=fixture(t),task=f.task('cold-history');
 for(let i=0;i<48;i++){const run=f.run(task,'cold-'+i,'succeeded',{configuration:{payload:'x'.repeat(64*1024)}});f.report(task,run,'cold-report-'+i,'result',{body:'r'.repeat(64*1024)});}
 f.read('taskPage',{presentation:'all'});
 const prepare=f.db.prepare.bind(f.db);let sourceBytes=0;f.db.prepare=sql=>{const statement=prepare(sql);for(const method of ['get','all']){const original=statement[method].bind(statement);statement[method]=(...args)=>{const result=original(...args);if(/\bFROM\s+(entities|events)\b/i.test(sql)&&/\bdata\b/i.test(sql)){const rows=method==='all'?result:[result];for(const row of rows)if(row?.data)sourceBytes+=Buffer.byteLength(String(row.data));}return result;};}return statement;};
 for(let i=0;i<3;i++){const page=f.read('taskPage',{presentation:'all',pageSize:5});assert.equal(page.total,1);f.ledger.checkins.tick();f.runtime.tick();}
 assert.equal(sourceBytes,0,'warm reads and idle ticks must not touch cold source payloads');
 const plan=prepare('EXPLAIN QUERY PLAN SELECT data FROM demand_task_display ORDER BY updated_at DESC,seq DESC,id LIMIT 5').all().map(row=>row.detail).join('\n');assert.match(plan,/demand_display_order/);
});

test('attention preserves historical reviews, current failure, group order and scoped child pages',t=>{
 const f=fixture(t),root=f.task('attention-root'),old=f.run(root,'parent-old','running',{createdAt:'2026-01-01T00:00:00Z'}),recent=f.run(root,'parent-recent','running',{createdAt:'2026-02-01T00:00:00Z'});
 const first=f.task('child-first',{parentTaskId:root.taskId,parentRunId:old.runId}),second=f.task('child-second',{parentTaskId:root.taskId,parentRunId:recent.runId});
 f.run(first,'child-old-review','failed',{parentRunId:old.runId,reviewStatus:'rejected'});f.run(first,'child-current-success','succeeded',{parentRunId:recent.runId});f.run(second,'child-current-failure','failed',{parentRunId:recent.runId});
 const group=f.read('taskAttentionGroupPage',{taskId:root.taskId,pageSize:1});assert.equal(group.total,2);assert.equal(group.totalAttention,2);assert.equal(group.items[0].parentRunId,recent.runId);assert.equal(group.items[0].taskId,root.taskId);
 const detail=f.read('taskDetail',{taskId:root.taskId});assert.equal(detail.task.childAttentionCount,2);
 const page=f.read('taskAttentionPage',{taskId:root.taskId,parentRunId:old.runId});assert.deepEqual(page.items.map(row=>row.runId),['child-old-review']);
 const exported=f.runtime.snapshot().tasks.find(task=>task.id===root.taskId).childAttention;
 assert.deepEqual(detail.childAttention.items,exported);
});

test('manual completion cards read only compact material receipts with cold message history',t=>{
 const f=fixture(t),task=f.task('manual-materials'),run=f.run(task,'manual-run');
 const manual={decisionId:'manual-decision',actor:'operator',decidedAt:'2026-01-02T00:00:00Z',runId:run.runId,materials:'pending',requestMessageId:'manual-request'};
 f.db.prepare("UPDATE entities SET state='completed',data=json_set(data,'$.state','completed','$.manualCompletion',json(?)) WHERE kind='task' AND id=?").run(JSON.stringify(manual),task.taskId);
 for(let i=0;i<60;i++){const message={messageId:'message-'+i,taskId:task.taskId,nodeId:'worker',sessionId:'session',state:'completed',text:'m'.repeat(64*1024),createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-02T00:00:00Z'};f.db.prepare("INSERT INTO entities(kind,id,parent,state,data) VALUES('sessionMessage',?,?,?,?)").run(message.messageId,task.taskId,message.state,JSON.stringify(message));}
 const request={messageId:'manual-request',taskId:task.taskId,nodeId:'worker',sessionId:'session',state:'failed',text:'bounded request',supplementFor:'manual-decision',createdAt:'2026-01-02T00:00:00Z',updatedAt:'2026-01-02T00:00:00Z'};f.db.prepare("INSERT INTO entities(kind,id,parent,state,data) VALUES('sessionMessage',?,?,?,?)").run(request.messageId,task.taskId,request.state,JSON.stringify(request));
 assert.equal(f.read('taskPage',{presentation:'all'}).items[0].materialsStatus,'failed');
 const prepare=f.db.prepare.bind(f.db);let messageBytes=0;f.db.prepare=sql=>{const statement=prepare(sql);for(const method of ['get','all']){const original=statement[method].bind(statement);statement[method]=(...args)=>{const result=original(...args);if(/FROM entities/.test(sql)&&/data/.test(sql)){for(const row of method==='all'?result:[result])if(row?.data&&String(row.data).includes('messageId'))messageBytes+=Buffer.byteLength(String(row.data));}return result;};}return statement;};
 assert.equal(f.read('taskPage',{presentation:'all'}).items[0].materialsStatus,'failed');assert.equal(messageBytes,0);
});

test('workflow history pages read persisted headers, never historical step output JSON',async t=>{
 const {prepareWorkflowReadIndex}=await import('../dist/workflow-read-index.js');
 const f=fixture(t),task=f.task('workflow-task');f.run(task,'workflow-task-run');
 f.db.exec('CREATE TABLE workflow_definitions(id TEXT PRIMARY KEY,data TEXT NOT NULL,next_due TEXT);CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE workflow_task_bindings(task_id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE workflow_adoptions(workflow_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
 prepareWorkflowReadIndex(f.db);
 const definition={workflowId:'flow',title:'flow',description:'description',revision:1,steps:[{stepId:'step',nodeId:'worker',title:'step',dependsOn:[],execution:{kind:'agent',instructions:'private instructions'}}]};f.db.prepare('INSERT INTO workflow_definitions(id,data) VALUES(?,?)').run('flow',JSON.stringify(definition));
 for(let i=0;i<40;i++)f.db.prepare('INSERT INTO workflow_runs VALUES(?,?)').run('flow-'+i,JSON.stringify({workflowRunId:'flow-'+i,workflowId:'flow',taskId:task.taskId,runId:'workflow-task-run',title:'flow',definitionRevision:1,definition,createdAt:'2026-01-02T00:00:00Z',state:'succeeded',steps:[{output:{body:'o'.repeat(64*1024)}}]}));
 f.read('taskPage',{presentation:'all'});
 const prepare=f.db.prepare.bind(f.db);let rawWorkflowReads=0;f.db.prepare=sql=>{if(/\bFROM workflow_runs\b/i.test(sql))rawWorkflowReads++;return prepare(sql);};
 const first=f.read('workflowRunPage',{workflowId:'flow',pageSize:5}),second=f.read('workflowRunPage',{workflowId:'flow',pageSize:5,page:1});assert.equal(first.total,40);assert.equal(first.items.length,5);assert.equal(new Set([...first.items,...second.items].map(row=>row.workflowRunId)).size,10);assert.ok(first.items.every(row=>!('steps' in row)&&!('definition' in row)));assert.equal(rawWorkflowReads,0);
 const plan=prepare('EXPLAIN QUERY PLAN SELECT data FROM workflow_run_headers WHERE workflow_id=? ORDER BY seq DESC LIMIT 5').all('flow').map(row=>row.detail).join('\n');assert.match(plan,/workflow_header_history/);
});

test('imported project resources page public registration headers without packet payloads',async t=>{
 const {fixture:packet}=await import('./fixtures/registration.mjs');
 const f=fixture(t);f.ledger.registerProject('source-registration',packet());
 const projects=f.read('projectListPage',{});assert.equal(projects.total,1);assert.equal(projects.items[0].title,'Local project');assert.ok(!('goal' in projects.items[0]));
 const page=f.read('projectResourcesPage',{projectId:projects.items[0].id,kind:'registrations'});assert.equal(page.total,1);assert.equal(page.items[0].unknownOriginalTimes,true);assert.equal(page.items[0].origin.harness,'fixture (no real model)');assert.deepEqual(page.items[0].sourceAcceptance,[{title:'Draft delivery',acceptance:'pending_user'}]);assert.equal('packet' in page.items[0],false);
});

test('node workflow details retain the public step whitelist and hide private execution/output',t=>{
 const f=fixture(t),task=f.task('workflow-visible'),run=f.run(task,'workflow-visible-run');
 const definition={workflowId:'visible-flow',title:'visible flow',description:'public topology',revision:1,steps:[{stepId:'step',nodeId:'worker',title:'step',dependsOn:[],execution:{kind:'agent',instructions:'PRIVATE_DEFINITION_EXECUTION'}}]};
 const step={stepId:'step',nodeId:'worker',title:'step',kind:'agent',state:'succeeded',taskId:task.taskId,runId:run.runId,attemptCount:1,summary:'public summary',output:{body:'PRIVATE_STEP_OUTPUT'},sessionId:'PRIVATE_STEP_SESSION',retryFromRunId:'PRIVATE_RETRY_RUN'};
 const flow={workflowRunId:'visible-flow-run',workflowId:'visible-flow',taskId:task.taskId,runId:run.runId,title:'visible flow',definitionRevision:1,definition,input:{secret:'PRIVATE_FLOW_INPUT'},createdAt:'2026-01-01T00:00:00Z',state:'succeeded',steps:[step],dispatches:[]};
 f.runtime.ctx={get:key=>key==='taskSystem'?{config:{},workflows:{getRunView:()=>flow}}:undefined};
 f.read('taskPage',{presentation:'all'});
 for(const method of ['workflowRunDetail','workflowStepDetail']){
  const value=f.read(method,{workflowRunId:flow.workflowRunId,...(method==='workflowStepDetail'?{stepId:'step'}:{})},{kind:'node',nodeId:'worker'});
  assert.ok(!JSON.stringify(value).includes('PRIVATE_'));assert.match(JSON.stringify(value),/public summary/);
 }
 assert.equal(f.read('workflowStepDetail',{workflowRunId:flow.workflowRunId,stepId:'step'}).output.body,'PRIVATE_STEP_OUTPUT');
});

test('artifact pages preserve planner orphans and scope node artifacts by task before project filtering',async t=>{
 const {Workbench}=await import('../dist/workbench.js');
 const f=fixture(t),root=f.task('artifact-root'),own=f.task('artifact-owned',{parentTaskId:root.taskId}),other=f.task('artifact-sibling',{parentTaskId:root.taskId});
 f.run(own,'artifact-owned-run');f.run(other,'artifact-sibling-run','succeeded',{route:{nodeId:'other',provider:'offline',model:'script',requiredCapabilities:[]}});
 const wb=new Workbench(f.ledger);wb.manage('artifact-project','create_project',{projectId:'artifact-project',title:'Shared project',goal:'Shared project',state:'active'});wb.manage('artifact-backlog','create_backlog',{backlogId:'artifact-backlog',projectId:'artifact-project',title:'Shared'});
 for(const task of [own,other])wb.manage('artifact-link-'+task.taskId,'link_backlog_task',{backlogId:'artifact-backlog',taskId:task.taskId});
 const insert=f.db.prepare("INSERT INTO wb_artifacts(artifact_id,name,task_id,ref_kind,ref_id,ref_version,ref_path,created_at) VALUES(?,?,?,'git','fixture-repo','revision','artifact.txt','2026-01-01T00:00:00Z')");insert.run('owned-artifact','Owned artifact',own.taskId);insert.run('sibling-artifact','PRIVATE_SIBLING_ARTIFACT',other.taskId);insert.run('orphan-artifact','Planner unlinked artifact',null);
 assert.equal(f.read('projectResourcesPage',{kind:'artifacts'}).total,3);
 const scoped=f.read('projectResourcesPage',{kind:'artifacts',projectId:'artifact-project'},{kind:'node',nodeId:'worker'});assert.equal(scoped.total,1);assert.equal(scoped.items[0].id,'owned-artifact');assert.ok(!JSON.stringify(scoped).includes('PRIVATE_'));
 const legacy=f.runtime.snapshotForNode('worker').artifacts;assert.deepEqual(scoped.items,legacy);
});

test('workflow maintenance picks runnable headers before reading any historical output payload',async t=>{
 const {WorkflowRuntime}=await import('../dist/workflows.js'),{ProgramRegistry}=await import('../dist/workflow-programs.js');
 const f=fixture(t),workflows=new WorkflowRuntime(f.ledger,new ProgramRegistry('central'));
 for(let i=0;i<40;i++)f.db.prepare('INSERT INTO workflow_runs(id,data) VALUES(?,?)').run('cold-workflow-'+i,JSON.stringify({workflowRunId:'cold-workflow-'+i,workflowId:'cold-flow',title:'Cold workflow',createdAt:'2026-01-01T00:00:00Z',state:'succeeded',steps:[{state:'succeeded',output:{body:'o'.repeat(64*1024)}}]}));
 const prepare=f.db.prepare.bind(f.db);let sourceQueries=0;f.db.prepare=sql=>{if(/\bFROM workflow_runs\b/i.test(sql))sourceQueries++;return prepare(sql);};
 for(let i=0;i<3;i++)workflows.tick({scheduleEnabled:false});assert.equal(sourceQueries,0);
 const plan=prepare('EXPLAIN QUERY PLAN SELECT id FROM workflow_run_headers WHERE runnable=1 ORDER BY seq DESC').all().map(row=>row.detail).join('\n');assert.match(plan,/workflow_header_runnable/);
});


test('ordinary and unbound tasks cannot disappear into execution details and v1 persisted cards recover on upgrade',t=>{
 const f=fixture(t),root=f.task('root-delivery'),parent=f.run(root,'parent-execution','running'),child=f.task('bound-child',{parentTaskId:root.taskId,parentRunId:parent.runId}),unbound=f.task('unbound-child'),noRun=f.task('not-yet-run-child',{parentTaskId:root.taskId,parentRunId:parent.runId}),step=f.task('workflow-internal');
 f.db.prepare("UPDATE entities SET parent=?,data=json_set(data,'$.parentTaskId',?) WHERE kind='task' AND id=?").run(root.taskId,root.taskId,unbound.taskId);
 f.run(child,'child-execution','succeeded',{parentRunId:parent.runId});f.run(unbound,'unbound-execution');f.run(step,'step-execution','succeeded',{configuration:{workflow:{workflowRunId:'legacy-flow',stepId:'step'}}});
 for(const task of [root,child,unbound,noRun,step])f.db.prepare('INSERT INTO pr_task_presentation(task,visibility) VALUES(?,?)').run(task.taskId,'execution');
 let page=f.read('taskPage');assert.deepEqual(new Set(page.items.map(row=>row.id)),new Set([root.taskId,unbound.taskId,noRun.taskId]));
 assert.throws(()=>f.runtime.setTaskPresentation({commandId:'hide-root',taskId:root.taskId,visibility:'execution'}),error=>error.code==='INVALID');
 assert.throws(()=>f.runtime.setTaskPresentation({commandId:'hide-unbound',taskId:unbound.taskId,visibility:'execution'}),error=>error.code==='INVALID');
 f.runtime.setTaskPresentation({commandId:'promote-child',taskId:child.taskId,visibility:'primary'});assert.ok(f.read('taskPage').items.some(row=>row.id===child.taskId));
 f.runtime.setTaskPresentation({commandId:'fold-child',taskId:child.taskId,visibility:'execution'});
 const before=f.ledger.getTask(root.taskId),runBefore=f.ledger.getRun(parent.runId);
 f.db.prepare("UPDATE demand_task_display SET coordinator=0,data=json_set(data,'$.showInCoordinator',json('false')) WHERE id IN (?,?)").run(root.taskId,unbound.taskId);
 f.db.exec('UPDATE demand_display_meta SET version=1;DELETE FROM demand_task_dirty');
 const reopened=new ProjectRuntime({get:()=>undefined},f.ledger,'central','both');
 for(let i=0;i<10;i++){try{page=reopened.demandRead('taskPage',{});break;}catch(error){if(error.code!=='READ_MODEL_UPDATING')throw error;}}
 assert.deepEqual(new Set(page.items.map(row=>row.id)),new Set([root.taskId,unbound.taskId,noRun.taskId]));
 assert.deepEqual(f.ledger.getTask(root.taskId),before);assert.deepEqual(f.ledger.getRun(parent.runId),runBefore);
 assert.equal(reopened.demandRead('taskPage',{presentation:'all'}).total,5);
});
