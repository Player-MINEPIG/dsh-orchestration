import { Workbench } from "../../packages/task-system/dist/workbench.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createNativeHarness} from './native-harness.mjs';
let serial=0;
function call(h,name,args,agent){return h.ctx.tools.execute({callId:ToolCallId(`public-admission-${serial++}`),name,arguments:args,signal:new AbortController().signal,...(agent?{agent}:{})});}
function body(result){assert.equal(result.isError,false,JSON.stringify(result.error));return JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));}
function catalog(l,nodeId,models){const pending=l.executionModels.request('request-'+serial++,{nodeId}).catalog.request;l.completeExecutionModels('complete-'+serial++,{nodeId,requestId:pending.requestId,generation:pending.generation,result:{state:'success',observedAt:Date.now(),complete:true,models}});return l.executionModels.view(nodeId);}
test('external public task_dispatch applies a reviewed proposal and creates claimable temporary context without planner conversation metadata and real native session uses temporary-tasks',async()=>{
 const h=await createNativeHarness({script:[{name:'task_submit_result',args:{outcome:'success',summary:'external tool task complete'}}]});
 try{
  h.ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
  const l=h.ledger;l.registerNode('register',{nodeId:'local',roles:['both'],capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:[],enabled:true});
  catalog(l,'local',[{provider:'test-offline',model:'script'}]);
  // Mimic the external console's authorized session: no ProjectRuntime task/project relation.
  const parent=await h.ctx.agents.create({sessionId:SessionId('dmc-external-tool-session'),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  const agent=parent.agent;
  assert.equal(h.ctx.taskSystem.projects.taskForSession(agent.id),undefined);
  const proposed=body(await call(h,'task_plan',{requestId:'external-task',title:'Inspect issue',description:'Perform the approved isolated issue analysis.',route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}},agent));
  assert.equal(proposed.routingStatus,'ready');
  const applied=body(await call(h,'task_dispatch',{commandId:'external-task'},agent));
  const snapshot=body(await call(h,"task_query",{},agent));
  const run=snapshot.runs.find(run=>run.runId===applied.value.runId);
  assert.ok(run?.runId);assert.equal(run.projectContext.schedulerId,l.schedulerIdentity());assert.equal(run.projectContext.project,null);assert.equal(run.route.workspaceId,undefined);
  assert.equal(l.pendingRuns('local').some(r=>r.runId===run.runId),true);
  const replay=body(await call(h,'task_dispatch',{commandId:'external-task'},agent));assert.equal(replay.value.runId,run.runId);assert.equal(l.snapshot().runs.length,1);assert.equal(l.snapshot().attempts.length,0);
  const claim=l.claim('fixture-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
  const executed=await h.ctx.taskSystem.native.execute(claim);assert.equal(executed.run.state,'succeeded');
  const stored=await h.ctx.sessionPersistence.open(executed.sessionId,'read');assert.equal(stored.header.cwd,join(h.dir,'temporary-tasks'));await stored.close();
 }finally{await h.dispose();}
});

test('public task_dispatch uses node policy rather than global model and scheduling rejects an unbound temporary task',async()=>{
 const h=await createNativeHarness();
 try{
  h.ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
  const l=h.ledger;l.registerNode('node',{nodeId:'local',roles:['both'],capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:[],enabled:true});
  const view=catalog(l,'local',[{provider:'test-offline',model:'script'}]);
  l.executionModels.setDefault('default',{nodeId:'local',expectedRevision:0,expectedCatalogRevision:view.catalog.snapshot.revision,choice:{provider:'test-offline',model:'script'}});
  const task=body(await call(h,'task_create',{commandId:'public-create',title:'Default task'})).value;
  const created=body(await call(h,'task_dispatch',{commandId:'public-run',taskId:task.taskId,nodeId:'local'})).value;
  assert.equal(created.executionModel.origin,'node_default');assert.equal(created.route.provider,'test-offline');assert.equal(created.route.model,'script');assert.equal(created.dispatchIssue,undefined);
  const denied=await call(h,'task_schedule',{commandId:'unbound-schedule',action:'create',value:{scheduleId:'schedule',taskId:task.taskId}});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/PROJECT_REQUIRED|Bind this task to a project/);
 }finally{await h.dispose();}
});

test('public task tool contract has one formal dispatch entry and proposal calls never dispatch',async()=>{
 const h=await createNativeHarness();
 try{
  for(const name of ['task_dispatch','task_plan','task_create','task_repair_dispatch','codex_delegate','task_wait'])assert.ok(h.ctx.tools.get(name),name);
  for(const name of ['task_run','task_delegate','task_children','project_dispatch','task_claim','task_execute','task_settle','project_nodes'])assert.equal(h.ctx.tools.get(name),undefined,name);
  const schema=h.ctx.tools.schemas().find(tool=>tool.name==='task_plan');assert.equal(schema.parameters.properties.action,undefined);
  const proposed=body(await call(h,'task_plan',{requestId:'review-only',title:'Review this work'}));
  assert.equal(proposed.routingStatus,'pending-route');assert.equal(h.ledger.snapshot().tasks.length,0);assert.equal(h.ledger.snapshot().runs.length,0);
  await call(h,'task_plan',{action:'apply',requestId:'review-only',title:'Review this work'});
  assert.equal(h.ledger.snapshot().tasks.length,0);assert.equal(h.ledger.snapshot().runs.length,0);
 }finally{await h.dispose();}
});

test('task_dispatch plans and dispatches once with a node default and rejects changed replay intent',async()=>{
 const h=await createNativeHarness();
 try{
  h.ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
  const l=h.ledger;l.registerNode('dispatch-node',{nodeId:'local',roles:['both'],capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:[],enabled:true});
  const view=catalog(l,'local',[{provider:'test-offline',model:'script'}]);
  l.executionModels.setDefault('dispatch-default',{nodeId:'local',expectedRevision:0,expectedCatalogRevision:view.catalog.snapshot.revision,choice:{provider:'test-offline',model:'script'}});
  const args={commandId:'one-formal-dispatch',title:'Execute the approved request',description:'Use the node default.',nodeId:'local'};
  const first=body(await call(h,'task_dispatch',args)).value;
  assert.equal(l.getRun(first.runId).executionModel.origin,'node_default');
  assert.equal(l.getDecision(args.commandId).input.nodeId,'local');assert.equal(l.getDecision(args.commandId).input.route,undefined);
  const replay=body(await call(h,'task_dispatch',args)).value;assert.equal(replay.runId,first.runId);
  const changed=await call(h,'task_dispatch',{...args,title:'Different work'});assert.equal(changed.isError,true);assert.match(JSON.stringify(changed),/CONFLICT|Decision request ID reused/);
  assert.equal(l.snapshot().tasks.length,1);assert.equal(l.snapshot().runs.length,1);assert.equal(l.snapshot().attempts.length,0);
 }finally{await h.dispose();}
});

test('real Loader project tools recover original Task, keep reads compact, and gate finish on confirmed cancellation',async()=>{
 const h=await createNativeHarness();
 try {
  const registration=await import('../../packages/task-system/dist/project-registration/plugin.js');
  await h.ctx.plugin(registration,{namespaces:['fixture/local']});
  const l=h.ledger;
  l.registerNode('lifecycle-node',{nodeId:'local',roles:['both'],enabled:true,capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:[],maxConcurrent:3});
  catalog(l,'local',[{provider:'test-offline',model:'script'}]);
  h.ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
  const parent=await h.ctx.agents.create({sessionId:SessionId('lifecycle-project'),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}}),agent=parent.agent;
  const activation=body(await call(h,'project_start',{title:'Lifecycle project'},agent));
  const projectId=activation.binding.projectId;
  const wb=new Workbench(l),project=wb.snapshot().projects.find(project=>project.projectId===projectId);
  wb.manage('large-project-description','update_project',{projectId,expectedRevision:project.revision,description:'PROJECT_BODY_SENTINEL_'+('p'.repeat(10000))});
  const task=body(await call(h,'task_create',{commandId:'lifecycle-draft',title:'Original task',description:'INTENT_SENTINEL_'+('x'.repeat(10000))},agent)).value;
  l.projectExecutionSettings.save({projectId,expectedRevision:0,allowedNodeIds:[],executionBindings:{}});
  const args={commandId:'lifecycle-rejected',taskId:task.taskId,nodeId:'local',executionModel:{provider:'test-offline',model:'script'},configuration:{input:{secret:'CONFIG_SENSITIVE_SENTINEL'}}};
  const rejected=await call(h,'task_dispatch',args,agent);assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected),/Project settings no longer allow/);
  assert.equal(l.snapshot().tasks.length,1);assert.equal(l.snapshot().runs.length,0);
  l.projectExecutionSettings.save({projectId,expectedRevision:1,allowedNodeIds:['local'],executionBindings:{}});
  const dispatched=body(await call(h,'task_dispatch',{...args,commandId:'lifecycle-recovered'},agent));
  const run=dispatched.dispatch;assert.equal(run.taskId,task.taskId);assert.doesNotMatch(JSON.stringify(dispatched),/INTENT_SENTINEL|PROJECT_BODY_SENTINEL|CONFIG_SENSITIVE_SENTINEL/);
  assert.equal((await call(h,'task_dispatch',args,agent)).isError,true,'old command replays rejection');
  assert.equal(l.snapshot().runs.length,1);
  for(let i=0;i<6;i++)l.appendReport('loader-report-'+i,{taskId:task.taskId,title:'Report '+i,body:'BODY_SENTINEL_'+i,kind:'progress'});
  const query=body(await call(h,'task_query',{},agent));assert.equal(query.reports[0].title,'Report 5');assert.doesNotMatch(JSON.stringify(query),/INTENT_SENTINEL|BODY_SENTINEL|PROJECT_BODY_SENTINEL|CONFIG_SENSITIVE_SENTINEL/);
  const ids=[];let cursor;
  do {
   const page=body(await call(h,'task_history',{taskId:task.taskId,details:true,section:'reports',limit:2,...(cursor?{cursor}:{})},agent));
   assert.ok(page.reports.every(report=>report.body.startsWith('BODY_SENTINEL')));ids.push(...page.reports.map(report=>report.reportId));cursor=page.page.nextCursor;
  }while(cursor);
  assert.equal(new Set(ids).size,6);
  const compact=body(await call(h,'project_progress',{commandId:'lifecycle-progress',summary:'Progress recorded'},agent));assert.equal(compact.tasks,undefined);assert.equal(compact.reports,undefined);
  assert.equal((await call(h,'project_progress',{commandId:'both-identities',requestId:'old-alias',summary:'Invalid IDs'},agent)).isError,true);
  const repair=body(await call(h,'task_repair_dispatch',{commandId:'lifecycle-repair',taskId:task.taskId,runId:run.runId,expectedActionVersion:l.taskActionState(task.taskId).version},agent));assert.equal(repair.value.runId,run.runId);assert.doesNotMatch(JSON.stringify(repair),/INTENT_SENTINEL|PROJECT_BODY_SENTINEL|CONFIG_SENSITIVE_SENTINEL/);
  const pending=body(await call(h,'task_wait',{taskId:task.taskId,timeoutMs:0},agent));assert.equal(pending.pending[0].runId,run.runId);
  const claim=l.claim('lifecycle-claim',{runId:run.runId,nodeId:'local',ttlMs:60000}).value;
  const ref={runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'local',fence:claim.attempt.fence,executionId:'lifecycle-owner'};l.markRunning('lifecycle-running',ref);
  body(await call(h,'task_cancel',{commandId:'lifecycle-cancel',taskId:task.taskId,reason:'User deferred optional task'},agent));
  const blocked=await call(h,'project_finish',{commandId:'lifecycle-blocked',summary:'Stage ready'},agent);assert.equal(blocked.isError,true);assert.match(JSON.stringify(blocked),new RegExp(run.runId));assert.equal(l.getRun(run.runId).state,'running');
  l.acknowledgeCancellation('lifecycle-confirm-stop',ref);
  const finished=body(await call(h,'project_finish',{commandId:'lifecycle-finish',summary:'Stage ready; optional task deferred'},agent));assert.equal(finished.binding.state,'pending_review');assert.equal(finished.tasks,undefined);
  const retry=body(await call(h,'task_dispatch',{...args,commandId:'lifecycle-retry',retry:true,expectedActionVersion:l.taskActionState(task.taskId).version},agent));assert.notEqual(retry.dispatch.runId,run.runId);assert.equal(l.snapshot().tasks.length,1);
  const nodes=body(await call(h,'task_nodes',{},agent));assert.ok(nodes.nodes.length);assert.equal(nodes.routes,undefined);assert.equal(nodes.nodes[0].catalog.snapshot,undefined);
  const detail=body(await call(h,'task_nodes',{details:true,nodeId:'local',limit:1},agent));assert.equal(detail.routes.length,1);
 }finally{await h.dispose();}
});

test('ordinary host dispatch replays raw request receipts before changed defaults or repaired admission',async()=>{
 const h=await createNativeHarness();
 try {
  const l=h.ledger;l.registerNode('host-replay-node',{nodeId:'local',roles:['both'],enabled:true,capabilities:[],workspaceIds:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]},{provider:'test-offline',model:'alternate',reasoningEfforts:[]}]});
  const view=catalog(l,'local',[{provider:'test-offline',model:'script'},{provider:'test-offline',model:'alternate'}]);
  l.executionModels.setDefault('host-first-default',{nodeId:'local',expectedRevision:0,expectedCatalogRevision:view.catalog.snapshot.revision,choice:{provider:'test-offline',model:'script'}});
  const task=body(await call(h,'task_create',{commandId:'host-replay-draft',title:'Replay draft'})).value;
  const args={commandId:'host-replay-dispatch',taskId:task.taskId,nodeId:'local'};
  const first=body(await call(h,'task_dispatch',args));assert.equal(first.value.route.model,'script');
  l.executionModels.setDefault('host-changed-default',{nodeId:'local',expectedRevision:1,expectedCatalogRevision:view.catalog.snapshot.revision,choice:{provider:'test-offline',model:'alternate'}});
  assert.deepEqual(body(await call(h,'task_dispatch',args)),first);
  assert.equal((await call(h,'task_dispatch',{...args,executionModel:{provider:'test-offline',model:'alternate'}})).isError,true);
  const rejectedTask=body(await call(h,'task_create',{commandId:'host-rejected-draft',title:'Rejected draft'})).value;
  l.registerNode('disable-host',{...l.getNode('local'),enabled:false});
  const rejectedArgs={commandId:'host-rejected-dispatch',taskId:rejectedTask.taskId,nodeId:'local',executionModel:{provider:'test-offline',model:'script'}};
  const rejected=await call(h,'task_dispatch',rejectedArgs);assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected),/Node disabled/);
  l.registerNode('enable-host',{...l.getNode('local'),enabled:true});
  assert.deepEqual(await call(h,'task_dispatch',rejectedArgs),rejected);
  const repaired=body(await call(h,'task_dispatch',{...rejectedArgs,commandId:'host-repaired-dispatch'}));assert.equal(repaired.value.taskId,rejectedTask.taskId);
  assert.equal(l.snapshot().tasks.length,2);assert.equal(l.snapshot().runs.length,2);
 }finally{await h.dispose();}
});
