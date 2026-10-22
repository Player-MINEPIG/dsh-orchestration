import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../dist/ledger.js';
import {Workbench} from '../dist/workbench.js';
import {TaskPlanner,taskDecisionCatalog} from '../dist/planning.js';
import {ProjectExecutionSettings} from '../dist/project-execution-settings.js';
const route=nodeId=>({nodeId,provider:'fixture',model:'small',requiredCapabilities:[]});
let serial=0;
const command=()=>`policy-${++serial}`;
function fixture(t,path=':memory:') {
 const ledger=TaskLedger.open(path,{role:'planner',nodeId:'scheduler'});t.after(()=>ledger.close());
 const wb=new Workbench(ledger),db=ledger.managementDatabase();
 const manage=(op,data)=>wb.manage(command(),op,data).value;
 for(const projectId of ['p','q']) {manage('create_project',{projectId,title:projectId,goal:'Isolated policy test',state:'active'});manage('create_backlog',{backlogId:projectId,projectId,title:'Tasks'});}
 for(const nodeId of ['a','b']) {
  ledger.registerNode(command(),{nodeId,roles:['executor'],models:[{provider:'fixture',model:'small',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true,maxConcurrent:8,lastSeenAt:new Date().toISOString()});
  for(const suffix of ['1','2']) {const workspaceId=nodeId+suffix;ledger.registerWorkspace(command(),{workspaceId,nodeId,label:workspaceId,path:`/executor-${nodeId}/existing-${suffix}`,state:'ready',createdAt:new Date().toISOString()});}
  ledger.registerNode(command(),{...ledger.getNode(nodeId),workspaceIds:[nodeId+'1',nodeId+'2']});
  const request=ledger.executionModels.request(command(),{nodeId}).catalog.request;
  const models=ledger.completeExecutionModels(command(),{nodeId,requestId:request.requestId,generation:request.generation,result:{state:'success',complete:true,observedAt:Date.now(),temporaryWorkspaceReady:true,models:[{provider:'fixture',model:'small'}]}}).value;
  ledger.executionModels.setDefault(command(),{nodeId,expectedRevision:0,expectedCatalogRevision:models.catalog.snapshot.revision,choice:{provider:'fixture',model:'small'}});
 }
 const task=(project='p',extra={})=>{const task=ledger.createTask(command(),{title:'Fixture Task',...extra}).value;if(project)manage('link_backlog_task',{backlogId:project,taskId:task.taskId});return task;};
 // Only the public CAS input fields are accepted.
 const settings=(projectId,data={})=>{const old=ledger.projectExecutionSettings.read(projectId);return ledger.projectExecutionSettings.save({projectId,expectedRevision:old.revision,allowedNodeIds:old.allowedNodeIds,executionBindings:old.executionBindings,...data});};
 const run=(task,node='a',extra={})=>ledger.createRun(command(),{taskId:task.taskId,route:route(node),...extra}).value;
 return {ledger,db,manage,task,settings,run};
}

test('settings default, strict boundary, CAS, transaction rollback and durable reopen',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dsh-project-policy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'tasks.sqlite'),f=fixture(t,file),store=f.ledger.projectExecutionSettings;
 assert.deepEqual(store.read('p'),{projectId:'p',revision:0,allowedNodeIds:null,executionBindings:{}});
 assert.equal(ProjectExecutionSettings.safeParse({...store.read('p'),coordinatorWorkspace:{path:'/scheduler'}}).success,false);
 const first=f.settings('p',{allowedNodeIds:[],executionBindings:{a:'a1'}});assert.equal(first.revision,1);
 assert.throws(()=>store.save({projectId:'p',expectedRevision:0,allowedNodeIds:null,executionBindings:{}}),{code:'CONFLICT'});
 f.db.exec('BEGIN IMMEDIATE');f.settings('p',{allowedNodeIds:['a']});f.db.exec('ROLLBACK');assert.deepEqual(store.read('p'),first);
 const other=TaskLedger.open(file,{readOnly:true});try{assert.deepEqual(other.projectExecutionSettings.read('p'),first);assert.throws(()=>other.projectExecutionSettings.save({projectId:'p',expectedRevision:1,allowedNodeIds:null,executionBindings:{}}),{code:'READ_ONLY'});}finally{other.close();}
});

test('direct routes honor allowed nodes and per-node execution directories without copying coordinator paths',t=>{
 const f=fixture(t),task=f.task();
 f.db.exec('CREATE TABLE pr_project_workspaces(project TEXT PRIMARY KEY,workspace TEXT NOT NULL)');
 f.db.prepare('INSERT INTO pr_project_workspaces VALUES(?,?)').run('p',JSON.stringify({workspaceId:'scheduler-only',nodeId:'scheduler',path:'/scheduler/private',scope:'coordinator'}));
 f.settings('p',{allowedNodeIds:['a','b'],executionBindings:{a:'a1',b:'b2'}});
 const a=f.run(task,'a'),b=f.run(f.task(),'b');
 assert.equal(a.route.workspaceId,'a1');assert.equal(a.workspaceConstraint,'a1');assert.equal(a.projectExecutionBinding,'a1');assert.equal(a.projectSettingsRevision,1);
 assert.equal(b.route.workspaceId,'b2');assert.equal(b.workspaceConstraint,'b2');assert.doesNotMatch(JSON.stringify(a),/scheduler\/private/);
 assert.throws(()=>f.run(f.task(),'a',{route:{...route('a'),workspaceId:'a2'}}),{code:'FORBIDDEN'});
 f.settings('p',{allowedNodeIds:[]});assert.throws(()=>f.run(f.task()),{code:'PROJECT_NODE_NOT_ALLOWED'});
 assert.throws(()=>f.ledger.createRun(command(),{taskId:f.task().taskId}),{code:'PROJECT_NODE_NOT_ALLOWED'});
 f.settings('p',{allowedNodeIds:null});assert.equal(f.run(f.task(),'b').route.workspaceId,'b2');
});

test('queued policies invalidate without route mutation or extra execution; admitted old lease can still report',t=>{
 const f=fixture(t);f.settings('p',{executionBindings:{a:'a1'}});
 const task=f.task(),run=f.run(task),active=f.run(f.task());
 const claim=f.ledger.claim(command(),{runId:active.runId,nodeId:'a',ttlMs:60000}).value;
 f.settings('p',{allowedNodeIds:['b'],executionBindings:{a:'a2'}});
 const blocked=f.ledger.refreshDispatchEligibility(run.runId);
 assert.equal(blocked.dispatchIssue.kind,'needs_action');assert.equal(blocked.dispatchIssue.code,'PROJECT_NODE_NOT_ALLOWED');
 assert.deepEqual(blocked.route,run.route);assert.equal(blocked.workspaceConstraint,'a1');assert.equal(blocked.projectSettingsRevision,1);
 assert.throws(()=>f.ledger.claim(command(),{runId:run.runId,nodeId:'a',ttlMs:60000}),{code:'PROJECT_NODE_NOT_ALLOWED'});
 f.ledger.submit(command(),{runId:active.runId,attemptId:claim.attempt.attemptId,nodeId:'a',fence:claim.attempt.fence,outcome:'success',summary:'Old admitted lease reported',report:{title:'Result',body:'Physical execution was already admitted'}});
 assert.equal(f.ledger.getRun(active.runId).state,'succeeded');
 f.settings('p',{allowedNodeIds:null});assert.equal(f.ledger.refreshDispatchEligibility(run.runId).dispatchIssue.code,'PROJECT_WORKSPACE_CHANGED');
 assert.deepEqual(f.ledger.getRun(run.runId).route,run.route);
 f.ledger.returnUnclaimedToInbox(command(),{taskId:task.taskId,runId:run.runId});
 const replacement=f.run(task);assert.equal(replacement.workspaceConstraint,'a2');assert.equal(replacement.projectSettingsRevision,3);
 assert.equal(f.ledger.snapshot().attempts.length,1);assert.equal(f.ledger.snapshot().runs.length,3);
 f.settings('p',{executionBindings:{}});assert.equal(f.ledger.refreshDispatchEligibility(replacement.runId).dispatchIssue.code,'PROJECT_WORKSPACE_CHANGED');
});

test('coordinator-only revision changes do not invalidate matching queued policy',t=>{
 const f=fixture(t);f.settings('p',{executionBindings:{a:'a1'}});const run=f.run(f.task());
 f.settings('p');const current=f.ledger.refreshDispatchEligibility(run.runId);
 assert.equal(current.dispatchIssue,undefined);assert.equal(current.projectSettingsRevision,1);assert.equal(current.workspaceConstraint,'a1');
});

test('project ancestry and trusted dispatcher session are enforced, with system caller isolation',t=>{
 const f=fixture(t),parent=f.task(),parentRun=f.run(parent),child=f.task(null,{parentTaskId:parent.taskId,parentRunId:parentRun.runId});
 f.settings('p',{allowedNodeIds:['b']});assert.equal(f.ledger.projectForTask(child.taskId),'p');assert.throws(()=>f.run(child),{code:'PROJECT_NODE_NOT_ALLOWED'});
 f.db.exec('CREATE TABLE dispatcher_projects(node TEXT,session TEXT,project TEXT,cwd TEXT,PRIMARY KEY(node,session))');
 f.db.prepare('INSERT INTO dispatcher_projects VALUES(?,?,?,?)').run('scheduler','ordinary','p','/scheduler/current');
 const origin={kind:'session',nodeId:'scheduler',sessionId:'ordinary'},draft=f.ledger.withDispatchOrigin(origin,()=>f.task(null));
 assert.throws(()=>f.ledger.withDispatchOrigin(origin,()=>f.run(draft)),{code:'PROJECT_NODE_NOT_ALLOWED'});
 const system=f.run(draft);assert.equal(system.projectContext.project,null);assert.equal(system.projectSettingsRevision,undefined);
 assert.throws(()=>f.ledger.withDispatchOrigin(origin,()=>f.run(f.task('q'))),{code:'AMBIGUOUS_PROJECT'});
});

test('new coordination child Run distinguishes coordination ancestry from real executor recursion',t=>{
 const f=fixture(t);f.db.exec('CREATE TABLE pr_projects(id TEXT PRIMARY KEY)');f.db.prepare('INSERT INTO pr_projects VALUES(?)').run('managed');
 f.manage('create_project',{projectId:'pr:managed',title:'Managed',goal:'Coordinator fixture',state:'active'});f.manage('create_backlog',{backlogId:'pr:managed',projectId:'pr:managed',title:'Managed tasks'});
 const origin={kind:'session',nodeId:'scheduler',sessionId:'coordinator'};
 const draft=f.ledger.withDispatchOrigin(origin,()=>f.task(null));
 f.settings('managed',{allowedNodeIds:[]});
 const binding=f.ledger.withDispatchOrigin(origin,()=>f.ledger.bindDispatcher(command(),{taskId:draft.taskId,nodeId:'scheduler',sessionId:'coordinator',projectId:'managed',cwd:'/scheduler/project'}).value);
 assert.equal(f.ledger.projectForTask(draft.taskId),'managed');assert.equal(f.ledger.getRun(binding.runId).state,'running');
 f.settings('managed',{allowedNodeIds:['a'],executionBindings:{a:'a1'}});
 const child=f.ledger.withDispatchOrigin(origin,()=>f.task(null)),run=f.ledger.withDispatchOrigin(origin,()=>f.run(child));
 assert.equal(run.parentRunId,binding.runId);assert.equal(run.executionParentKind,'coordinator');assert.equal(run.executionParentRunId,undefined);
 const lease=f.ledger.claim(command(),{runId:run.runId,nodeId:'a',ttlMs:60000}).value;
 const grandchild=f.ledger.delegateTask(command(),{runId:run.runId,attemptId:lease.attempt.attemptId,nodeId:'a',fence:lease.attempt.fence,title:'Recursive child',route:route('a')}).value;
 assert.equal(grandchild.run.executionParentKind,'executor');assert.equal(grandchild.run.executionParentRunId,run.runId);assert.equal(grandchild.run.projectSettingsRevision,2);
});

test('planner only offers allowed executors; project CAS changes make an unapplied decision stale',async t=>{
 const f=fixture(t);f.settings('p',{allowedNodeIds:['b'],executionBindings:{b:'b1'}});let offered;
 const decisions={async ask(input){const state=JSON.parse(input.state);offered=state.catalog.executors.map(row=>row.id);const model=state.catalog.modelRoutes.find(row=>row.executorId==='b');return{provider:'fixture',model:'decider',answers:Object.fromEntries(Object.entries(input.questions).map(([id])=>[id,{type:'choice',choice:({persist:'create',attach:'none',executor:'b',modelEffort:model.id,reporting:'none'})[id]??'none'}]))};}};
 const planner=new TaskPlanner(f.ledger,decisions,()=>taskDecisionCatalog(f.ledger,{}),()=>{});
 const plan=await planner.plan({requestId:'project-plan',projectId:'p',title:'Scoped work',description:'Plan only'});
 assert.deepEqual(offered,['b']);assert.equal(plan.proposal.kind,'proposal');
 await assert.rejects(planner.plan({requestId:'wrong-node',projectId:'p',title:'Wrong',description:'',nodeId:'a'}),{code:'PROJECT_NODE_NOT_ALLOWED'});
 f.settings('p',{allowedNodeIds:['a']});assert.throws(()=>planner.apply('project-plan'),{code:'STALE_DECISION'});
 f.settings('p',{allowedNodeIds:['b']});
 const fixed=await planner.plan({requestId:'fixed-project',projectId:'p',title:'Fixed',description:'',route:route('b')});
 const applied=planner.apply(fixed.decisionId).value,run=f.ledger.getRun(applied.runId);
 assert.equal(run.workspaceConstraint,'b1');assert.equal(run.projectSettingsRevision,3);assert.equal(f.ledger.getTask(applied.taskId).workspaceId,undefined);
});

test('legacy execution workspace constrains revision zero only; saved policy becomes authoritative without repinning an old Run',t=>{
 const f=fixture(t);f.db.exec('CREATE TABLE pr_project_workspaces(project TEXT PRIMARY KEY,workspace TEXT NOT NULL)');
 f.db.prepare('INSERT INTO pr_project_workspaces VALUES(?,?)').run('p',JSON.stringify({workspaceId:'a1',nodeId:'a',path:'/executor-a/existing-1'}));
 const old=f.run(f.task());assert.equal(old.workspaceConstraint,'a1');assert.equal(old.projectExecutionBinding,'a1');
 assert.throws(()=>f.run(f.task(),'b'),{code:'WORKSPACE_POLICY'});
 f.settings('p',{allowedNodeIds:['a','b'],executionBindings:{b:'b2'}});
 assert.equal(f.ledger.projectWorkspaceConstraint('p'),undefined);assert.equal(f.run(f.task(),'b').workspaceConstraint,'b2');
 assert.equal(f.ledger.refreshDispatchEligibility(old.runId).dispatchIssue.code,'PROJECT_WORKSPACE_CHANGED');
 assert.equal(f.ledger.getRun(old.runId).workspaceConstraint,'a1');
});

test('real executor A can delegate to project-bound B without inheriting A project directory',t=>{
 const f=fixture(t);f.settings('p',{allowedNodeIds:['a','b'],executionBindings:{a:'a1',b:'b2'}});
 const parent=f.run(f.task()),lease=f.ledger.claim(command(),{runId:parent.runId,nodeId:'a',ttlMs:60000}).value;
 const child=f.ledger.delegateTask(command(),{runId:parent.runId,attemptId:lease.attempt.attemptId,nodeId:'a',fence:lease.attempt.fence,title:'Remote child',route:route('b')}).value;
 assert.equal(child.run.route.nodeId,'b');assert.equal(child.run.route.workspaceId,'b2');assert.equal(child.run.workspaceConstraint,'b2');assert.equal(child.task.workspaceId,undefined);
 assert.equal(child.run.projectExecutionBinding,'b2');assert.equal(child.run.executionParentRunId,parent.runId);
 const same=f.ledger.delegateTask(command(),{runId:parent.runId,attemptId:lease.attempt.attemptId,nodeId:'a',fence:lease.attempt.fence,title:'Same executor child'}).value;
 assert.equal(same.task.workspaceId,undefined);assert.equal(same.run.workspaceConstraint,'a1');
});

const workspace=(workspaceId,nodeId='a',state='ready',path=`/executor-${nodeId}/declared-${workspaceId}`)=>({workspaceId,nodeId,state,path,label:workspaceId});
const announce=(f,sampledAt,workspaces,nodeId='a')=>f.ledger.recordExecutorWorkspaces(command(),{nodeId,sampledAt,workspaces}).value;

test('authenticated workspace snapshots preserve independent manual grants and withdraw runtime grants on missing/unavailable/revoked entries',t=>{
 const f=fixture(t);assert.deepEqual(f.ledger.executorWorkspaceCatalog('a'),{nodeId:'a',sampledAt:null,workspaces:[]});
 const initial=announce(f,1000,[workspace('a1','a','ready','/executor-a/existing-1'),workspace('new')]);
 assert.equal(initial.sampledAt,1000);assert.ok(f.ledger.getNode('a').workspaceIds.includes('new'));
 assert.equal(f.ledger.getWorkspace('new').path,'/executor-a/declared-new');
 announce(f,2000,[workspace('new','a','unavailable')]);
 assert.ok(f.ledger.getNode('a').workspaceIds.includes('a1'));assert.equal(f.ledger.getWorkspace('a1').state,'ready');
 assert.ok(!f.ledger.getNode('a').workspaceIds.includes('new'));assert.equal(f.ledger.getWorkspace('new').state,'failed');
 assert.deepEqual(f.ledger.executorWorkspaceCatalog('a').workspaces.map(row=>row.workspaceId),['new']);
 announce(f,3000,[workspace('new')]);assert.ok(f.ledger.getNode('a').workspaceIds.includes('new'));
 announce(f,4000,[workspace('new','a','revoked')]);assert.ok(!f.ledger.getNode('a').workspaceIds.includes('new'));
 announce(f,5000,[workspace('new')]);announce(f,6000,[]);assert.ok(!f.ledger.getNode('a').workspaceIds.includes('new'));
});

test('workspace snapshots reject stale data, foreign ownership, identity rebinding and active directory overlap atomically',t=>{
 const f=fixture(t);announce(f,1000,[workspace('stable')]);
 assert.throws(()=>announce(f,900,[]),{code:'STALE_WORKSPACE_CATALOG'});
 assert.deepEqual(announce(f,1000,[workspace('stable')]),f.ledger.executorWorkspaceCatalog('a'));
 assert.throws(()=>announce(f,1000,[]),{code:'CONFLICT'});
 assert.throws(()=>announce(f,2000,[workspace('foreign','b')]),{code:'INVALID'});
 assert.throws(()=>announce(f,2000,[workspace('stable','a','ready','/new-directory')]),{code:'CONFLICT'});
 assert.throws(()=>announce(f,2000,[workspace('overlap','a','ready','/executor-a/existing-1')]),{code:'CONFLICT'});
 assert.throws(()=>announce(f,2000,[workspace('created-before-collision'),workspace('wrong-node','a','ready','/executor-a/existing-1')]),{code:'CONFLICT'});
 assert.throws(()=>f.ledger.getWorkspace('created-before-collision'),{code:'NOT_FOUND'});
 assert.equal(f.ledger.executorWorkspaceCatalog('a').sampledAt,1000);
 assert.throws(()=>announce(f,2000,Array.from({length:65},(_,i)=>workspace('excess-'+i))),{code:'INVALID'});
 announce(f,2000,[]);const next=workspace('replacement','a','ready','/executor-a/declared-stable');
 announce(f,3000,[next]);assert.ok(f.ledger.getNode('a').workspaceIds.includes('replacement'));
 assert.equal(f.ledger.getWorkspace('stable').state,'failed');
 assert.throws(()=>announce(f,4000,[workspace('stable','a','ready','/other')]),{code:'CONFLICT'});
});

test('later explicit management adoption has its own grant source and survives announcement withdrawal',t=>{
 const f=fixture(t);announce(f,1000,[workspace('adopted')]);
 f.ledger.registerNode(command(),f.ledger.getNode('a'));
 f.ledger.registerWorkspace(command(),f.ledger.getWorkspace('adopted'));
 announce(f,2000,[]);
 assert.ok(f.ledger.getNode('a').workspaceIds.includes('adopted'));assert.equal(f.ledger.getWorkspace('adopted').state,'ready');
 assert.deepEqual(f.ledger.executorWorkspaceCatalog('a').workspaces,[]);
});
