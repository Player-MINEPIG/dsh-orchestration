import {registerExecutor,respondToCatalogRequests} from '../../../tests/dsh/executor-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
import {DecisionEngine,StructuredModelProvider} from './legacy-model-fixture.mjs';

function assertPlannerTools(tools){const names=tools.map(tool=>tool.name);for(const name of ['task_wait','task_history','task_nodes','task_plan','task_dispatch','task_query'])assert.ok(names.includes(name),name);for(const name of ['codex_delegate','task_run','task_delegate','bash','write'])assert.ok(!names.includes(name),name);}
const worker={nodeId:'worker',roles:['executor'],models:[{provider:'worker-model',model:'small',reasoningEfforts:['off']}],capabilities:[],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()};
async function settle(h,command){const deadline=Date.now()+5000;while(Date.now()<deadline){const turn=h.ledger.managementDatabase().prepare('SELECT state FROM pr_turns WHERE command=?').get(command);if(['completed','failed'].includes(turn.state))return turn;await new Promise(r=>setTimeout(r,20));}throw Error('Turn timeout');}
function decisions(){return new DecisionEngine([new StructuredModelProvider('judge',[{model:'router',version:'fixture',reasoningEfforts:[]}],{complete:async({input})=>{
  assert.ok(input.context.catalog.modelRoutes.some(r=>r.reasoningEffort==='off'),'fixture publishes the advertised workload effort');
  const route=input.context.catalog.modelRoutes.find(r=>r.executorId==='worker'&&r.reasoningEffort==='off');
  const replan=input.context.state.request.title==='Replan';
  const choices={persist:replan?'attach':'create',attach:replan?input.context.catalog.tasks[0].id:'none',executor:'worker',modelEffort:route.id,reporting:'summary'};
  return {output:{answers:Object.fromEntries(input.questions.map(q=>[q.questionId,{type:'choice',choice:choices[q.questionId]??'none'}]))},modelVersion:'fixture'};
}})],{defaultProvider:'judge',maxAttempts:1});}

test('project creation provisions a durable native session, rejects root conflicts and reconciles duplicate commands',async()=>{
  const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try{const runtime=h.ctx.taskSystem.projects,root=join(h.dir,'projects');
    assert.throws(()=>runtime.saveSettings({root:'../relative',expectedRevision:0}),/absolute/);
    runtime.saveSettings({root,expectedRevision:0});
    assert.throws(()=>runtime.saveSettings({root,expectedRevision:0}),/changed/);
    const input={commandId:'create-one',title:'../../Project',goal:'Compute externally'};
    const p=await runtime.create(input),again=await runtime.create(input);
    assert.deepEqual(p,again);assert.equal(runtime.snapshot().projects.length,1);
    const row=runtime.snapshot().projects[0];assert.ok(row.workspace.startsWith(root+'/project-'));
    assert.ok(existsSync(join(row.workspace,'PROJECT.md')));assert.match(readFileSync(join(row.workspace,'TOOLS.md'),'utf8'),/task_plan/);
    assert.ok(await h.ctx.sessionPersistence.stat(row.sessionId));
    assert.equal(h.adapter.requests.length,0,'new project must not invoke a model');
    await assert.rejects(runtime.create({...input,title:'other'}),/reused/);
    assert.deepEqual((await runtime.conversation(p.projectId)).messages,[]);
  }finally{await h.dispose();}
});

test('a project message uses real native dispatch tools and persists offline queued work once, with project association and handoff',async()=>{
  const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
  const engine=decisions();h.ctx.provide('decisionModels',engine);let stopCatalogs=()=>{};
  try{const runtime=h.ctx.taskSystem.projects;registerExecutor(h.ledger, 'worker',worker);stopCatalogs=respondToCatalogRequests(h.ledger,['worker']);runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const {projectId}=await runtime.create({commandId:'new',title:'Phone task',goal:'Small real dispatch'});
    const command='message1',requestId='project-message:'+command;
    h.adapter.script.push({name:'task_nodes',args:{}},{name:'task_plan',args:{requestId,title:'Calculate',description:'Compute 1+1 and report'}},{name:'task_dispatch',args:{commandId:requestId}},'任务已经排队，等待执行端上线');
    const input={projectId,commandId:command,text:'请计算 1+1，交给执行端'};
    runtime.send(input);assert.equal((await settle(h,command)).state,'completed');
    const snapshot=runtime.snapshot();assert.equal(snapshot.tasks.length,1,JSON.stringify(h.adapter.requests.at(-1)));assert.equal(snapshot.tasks[0].project,projectId);assert.equal(snapshot.tasks[0].status,'queued');
    assert.equal(h.ledger.snapshot().attempts.length,0);assert.equal(snapshot.runs.length,0);assert.equal(snapshot.tasks[0].nativeState,'inbox');assert.equal(snapshot.tasks[0].report,'尚未收到执行报告');assert.equal(snapshot.tasks[0].recommendation[0].nodeId,'worker');
    runtime.send(input);assert.equal(h.ledger.snapshot().runs.length,0);assert.equal(h.adapter.requests.length,4);
    assert.throws(()=>runtime.send({...input,text:'different'}),/reused/);
    const request=h.adapter.requests[0];assertPlannerTools(request.tools);
    assert.match(JSON.stringify(request.messages),/project-message:message1/);
    const conversation=await runtime.conversation(projectId);assert.equal(conversation.messages[0].role,'user');assert.equal(conversation.messages.filter(m=>m.role==='user').length,1);assert.match(conversation.messages.at(-1).text,/排队/);
    const second=await runtime.create({commandId:'new2',title:'Other',goal:'Isolated'}),other=runtime.snapshot().projects.find(p=>p.id===second.projectId);
    assert.throws(()=>runtime.assertDecisionScope(other.sessionId,requestId),/another project/);
    h.ledger.recordNodeHeartbeat('online-worker',{nodeId:'worker',runtimeReady:true,activeExecutions:0,observedAt:new Date().toISOString()});runtime.tick();runtime.tick();assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(runtime.snapshot().runs[0].node,'worker');
    assert.equal(h.ledger.managementDatabase().prepare('SELECT generation FROM pr_dispatch').get().generation,1);
    h.ledger.recordNodeHeartbeat('worker-paused',{nodeId:'worker',runtimeReady:false,activeExecutions:0});
    h.ledger.managementDatabase().prepare("UPDATE pr_dispatch SET updated='2000-01-01T00:00:00Z'").run();
    runtime.tick();assert.equal(h.ledger.getRun(runtime.snapshot().runs[0].id).state,'cancelled');assert.equal(runtime.snapshot().tasks[0].nativeState,'inbox');assert.equal(runtime.snapshot().tasks[0].stateLabel,'等待执行端接收');
    const replanId='project-message:replan-message';
    h.adapter.script.push({name:'task_plan',args:{requestId:replanId,title:'Replan',description:'Replan the same pending task'}},{name:'task_dispatch',args:{commandId:replanId}},'已更新候选');
    runtime.send({projectId,commandId:'replan-message',text:'重新规划尚未领取的同一任务'});assert.equal((await settle(h,'replan-message')).state,'completed');
    assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(h.ledger.managementDatabase().prepare('SELECT decision FROM pr_dispatch').get().decision,replanId);
    runtime.enqueueDecision(requestId,snapshot.tasks[0].id);assert.equal(h.ledger.managementDatabase().prepare('SELECT decision FROM pr_dispatch').get().decision,replanId,'older recovery receipts must not overwrite a replan');
    h.ledger.recordNodeHeartbeat('worker-returned',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();runtime.tick();
    assert.equal(h.ledger.snapshot().runs.length,2);assert.equal(h.ledger.managementDatabase().prepare('SELECT generation FROM pr_dispatch').get().generation,2);assert.equal(h.ledger.snapshot().attempts.length,0);
    const old=conversation.sessionId;await runtime.handoff(projectId);const next=await runtime.conversation(projectId);assert.equal(next.generation,2);assert.notEqual(next.sessionId,old);assert.match(next.sessions[0].summary,/Calculate/);assert.equal(h.ledger.snapshot().runs.length,2);
  }finally{stopCatalogs();await h.dispose();await engine.close();}
});

test('planner-only ledger rejects a stale self-node executor role and excludes it from the planning catalog',async()=>{
 const h=await createNativeHarness({config:{role:'planner',nodeId:'vps'}});
 try{registerExecutor(h.ledger, 'stale-self',{...worker,nodeId:'vps',roles:['both']});
  assert.throws(()=>h.ledger.validateRoute({nodeId:'vps',provider:'worker-model',model:'small',requiredCapabilities:[]}),/Planner-only/);
  const {taskDecisionCatalog}=await import('../dist/planning.js');assert.equal(taskDecisionCatalog(h.ledger,{role:'planner',nodeId:'vps'}).executors.length,0);
 }finally{await h.dispose();}
});

test('ordered candidate admission skips offline primary, persists fallback order and never moves a claimed Run',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
 const engine=new DecisionEngine([new StructuredModelProvider('judge',[{model:'router',version:'fixture',reasoningEfforts:[]}],{complete:async({input})=>{
  const primary=input.context.catalog.modelRoutes.find(r=>r.executorId==='worker'&&r.reasoningEffort==='off');
  const backup=input.context.catalog.modelRoutes.find(r=>r.executorId==='backup'&&r.reasoningEffort==='off');
  const choices={persist:'create',attach:'none',executor:'worker',modelEffort:primary.id,reporting:'summary',fallbackRoute1:backup.id};
  return {output:{answers:Object.fromEntries(input.questions.map(q=>[q.questionId,{type:'choice',choice:choices[q.questionId]??'none'}]))},modelVersion:'fixture'};
 }} )],{defaultProvider:'judge',maxAttempts:1});h.ctx.provide('decisionModels',engine);
 try {
  registerExecutor(h.ledger, 'one',worker);registerExecutor(h.ledger, 'two',{...worker,nodeId:'backup'});
  h.ledger.recordNodeHeartbeat('backup-online',{nodeId:'backup',runtimeReady:true,activeExecutions:0});
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const {projectId}=await runtime.create({commandId:'new-fallback',title:'Fallback',goal:'Use alternate executor'});
  const command='fallback-message',requestId='project-message:'+command;
  h.adapter.script.push({name:'task_plan',args:{requestId,title:'Small task',description:'Report two'}},{name:'task_dispatch',args:{commandId:requestId}},'已提交');
  runtime.send({projectId,commandId:command,text:'派发小任务'});assert.equal((await settle(h,command)).state,'completed');
  let task=runtime.snapshot().tasks[0];assert.deepEqual(task.recommendation.map(r=>r.nodeId),['worker','backup']);
  assert.deepEqual(task.candidateChecks,[{nodeId:'worker',reason:'offline'},{nodeId:'backup',reason:'assigned'}]);
  const run=h.ledger.snapshot().runs[0];assert.equal(run.route.nodeId,'backup');
  h.ledger.claim('claimed',{runId:run.runId,nodeId:'backup',ttlMs:10000});
  h.ledger.recordNodeHeartbeat('backup-pause',{nodeId:'backup',runtimeReady:false,activeExecutions:1});
  runtime.tick();assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(h.ledger.getRun(run.runId).state,'running');
  assert.throws(()=>h.ledger.returnUnclaimedToInbox('illegal-return',{taskId:run.taskId,runId:run.runId}),/already been claimed/);
 }finally{await h.dispose();await engine.close();}
});

function operator(runtime,taskId,action,commandId=action+'-'+taskId) {
 const t=runtime.snapshot().tasks.find(t=>t.id===taskId);
 return {commandId,taskId,action,expectedVersion:t.actionVersion,runId:t.runId,confirmationRevision:t.confirmationRevision};
}
function fixtureRun(h,key,policy) {
 const task=h.ledger.createTask('task-'+key,{title:key,...(policy?{policy}:{})}).value;
 const run=h.ledger.createRun('run-'+key,{taskId:task.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:[]}}).value;
 const a=h.ledger.claim('claim-'+key,{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;const lease={runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence};
 return {task,run,lease};
}

test('operator attention preserves failed outcome, survives restart, restores and invalidates on a new execution',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try {
  registerExecutor(h.ledger, 'node',worker);const runtime=h.ctx.taskSystem.projects;
  const {task,run,lease}=fixtureRun(h,'failed-work');
  h.ledger.submit('failure',{...lease,outcome:'failure',summary:'Real failure',report:{title:'Failure',body:'Original error'}});
  const before=operator(runtime,task.taskId,'handle');assert.equal(runtime.snapshot().tasks[0].status,'error');
  runtime.actOnTask(before);runtime.actOnTask(before);assert.equal(runtime.snapshot().tasks[0].status,'handled');
  assert.equal(h.ledger.getRun(run.runId).state,'failed');assert.equal(h.ledger.getTask(task.taskId).state,'failed');
  assert.match(runtime.snapshot().tasks[0].report,/Original error/);
  const {TaskLedger}=await import('../dist/ledger.js');const read=TaskLedger.open(join(h.dir,'tasks.sqlite'),{readOnly:true});
  try{assert.equal(read.taskActionState(task.taskId).handled,true);}finally{read.close();}
  runtime.actOnTask(operator(runtime,task.taskId,'restore'));assert.equal(runtime.snapshot().tasks[0].status,'error');
  runtime.actOnTask(operator(runtime,task.taskId,'handle','handle-again'));
  h.ledger.createRun('retry',{taskId:task.taskId,route:run.route});assert.equal(runtime.snapshot().tasks[0].status,'queued');
  assert.throws(()=>runtime.actOnTask({...before,commandId:'stale-handle'}),/changed/);
  assert.equal(h.ledger.snapshot().runs.length,2);
 }finally{await h.dispose();}
});

test('execution approval and result review are distinct; rejected result becomes actionable without automatic replay',async()=>{
 const h=await createNativeHarness({config:{role:'planner',requireConfirmation:true}});
 try {
  registerExecutor(h.ledger, 'node',worker);const runtime=h.ctx.taskSystem.projects;
  const task=h.ledger.createTask('approval-task',{title:'Needs permission'}).value;
  let t=runtime.snapshot().tasks[0];assert.equal(t.status,'review');assert.equal(t.stateLabel,'待批准执行');
  const approve=operator(runtime,task.taskId,'approve');runtime.actOnTask(approve);runtime.actOnTask(approve);
  assert.equal(runtime.snapshot().tasks[0].confirmationPending,false);
  const run=h.ledger.createRun('approved-run',{taskId:task.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:[]}}).value;
  assert.equal(runtime.snapshot().tasks[0].confirmationPending,true,'new execution invalidates an earlier task approval');
  runtime.actOnTask(operator(runtime,task.taskId,'approve','approve-run'));
  const a=h.ledger.claim('approved-claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;const lease={runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence};
  h.ledger.submit('partial',{...lease,outcome:'partial',summary:'Partial result',report:{title:'Partial',body:'Partly done'}});
  t=runtime.snapshot().tasks[0];assert.equal(t.status,'review');assert.equal(t.stateLabel,'待审核结果');
  assert.throws(()=>runtime.actOnTask(operator(runtime,task.taskId,'handle')),/cannot change/);
  const reject=operator(runtime,task.taskId,'reject');runtime.actOnTask(reject);runtime.actOnTask(reject);
  assert.equal(runtime.snapshot().tasks[0].status,'error');assert.equal(h.ledger.snapshot().runs.length,1);
  runtime.actOnTask(operator(runtime,task.taskId,'handle'));assert.equal(runtime.snapshot().tasks[0].status,'handled');
  assert.equal(h.ledger.getRun(run.runId).state,'partial');
 }finally{await h.dispose();}
});

test('cancellation respects executor stop acknowledgement, queued tasks and unknown effects',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try {
  registerExecutor(h.ledger, 'node',worker);const runtime=h.ctx.taskSystem.projects;
  const {task,run,lease}=fixtureRun(h,'running-work');
  const cancel=operator(runtime,task.taskId,'cancel');runtime.actOnTask(cancel);runtime.actOnTask(cancel);
  assert.equal(runtime.snapshot().tasks.find(t=>t.id===task.taskId).status,'cancelling');assert.equal(h.ledger.getRun(run.runId).state,'running');
  h.ledger.acknowledgeCancellation('stopped',lease);assert.equal(runtime.snapshot().tasks.find(t=>t.id===task.taskId).status,'cancelled');
  const queued=h.ledger.createTask('queued-task',{title:'Queued'}).value;
  const q=h.ledger.createRun('queued-run',{taskId:queued.taskId,route:run.route}).value;
  runtime.actOnTask(operator(runtime,queued.taskId,'cancel'));assert.equal(h.ledger.getRun(q.runId).state,'cancelled');
  assert.equal(runtime.snapshot().tasks.find(t=>t.id===queued.taskId).status,'cancelled');
  const unknown=fixtureRun(h,'unknown-work');
  h.ledger.submit('unknown',{...unknown.lease,outcome:'unknown',summary:'No certainty'});
  assert.throws(()=>runtime.actOnTask(operator(runtime,unknown.task.taskId,'handle')),/cannot change/);
  runtime.actOnTask(operator(runtime,unknown.task.taskId,'cancel'));
  let row=runtime.snapshot().tasks.find(t=>t.id===unknown.task.taskId);assert.equal(row.status,'error');assert.equal(row.stateLabel,'取消待核实');assert.equal(row.canReconcile,true);
  const verified=operator(runtime,unknown.task.taskId,'confirm-stopped');runtime.actOnTask(verified);runtime.actOnTask(verified);
  assert.equal(runtime.snapshot().tasks.find(t=>t.id===unknown.task.taskId).status,'cancelled');
  const late=fixtureRun(h,'late-work');runtime.actOnTask(operator(runtime,late.task.taskId,'cancel'));
  assert.throws(()=>h.ledger.submit('late-result',{...late.lease,outcome:'success',summary:'Late result'}),/Cancellation requested/);
  h.ledger.acknowledgeCancellation('late-stop',late.lease);row=runtime.snapshot().tasks.find(t=>t.id===late.task.taskId);assert.equal(row.status,'cancelled');assert.equal(h.ledger.getRun(late.run.runId).state,'cancelled');
 }finally{await h.dispose();}
});

test('continue dispatch reuses a safe project recommendation, queues offline and creates one new Run without replaying old effects',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});const engine=decisions();h.ctx.provide('decisionModels',engine);
 try {
  registerExecutor(h.ledger, 'node',worker);const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const {projectId}=await runtime.create({commandId:'retry-project',title:'Retry project',goal:'Compute externally'}),requestId='project-message:retry-message';
  h.adapter.script.push({name:'task_plan',args:{requestId,title:'Retry work',description:'Compute once'}},{name:'task_dispatch',args:{commandId:requestId}},'排队');
  runtime.send({projectId,commandId:'retry-message',text:'派发'});await settle(h,'retry-message');
  h.ledger.recordNodeHeartbeat('online',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();
  const run=h.ledger.snapshot().runs[0],a=h.ledger.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  h.ledger.submit('failed',{runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,outcome:'failure',summary:'Stopped failure'});runtime.tick();
  assert.equal(runtime.snapshot().tasks[0].canRetry,true);
  h.ledger.recordNodeHeartbeat('pause',{nodeId:'worker',runtimeReady:false,activeExecutions:0});
  const input=operator(runtime,run.taskId,'retry');await runtime.actOnTask(input);await runtime.actOnTask(input);
  assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(runtime.snapshot().tasks[0].stateLabel,'等待执行端接收');
  h.ledger.recordNodeHeartbeat('back',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();runtime.tick();
  const rows=h.ledger.snapshot().runs;assert.equal(rows.length,2);assert.equal(rows[0].state,'failed');assert.notEqual(rows[0].runId,rows[1].runId);assert.equal(rows[1].taskId,rows[0].taskId);
  assert.equal(runtime.snapshot().tasks[0].canRetry,false);await assert.rejects(runtime.actOnTask({...input,commandId:'unsafe-retry'}),/changed/);
  runtime.actOnTask(operator(runtime,run.taskId,'cancel'));runtime.tick();assert.equal(runtime.snapshot().tasks[0].status,'cancelled');assert.equal(h.ledger.snapshot().runs.length,2);
 }finally{await h.dispose();await engine.close();}
});


test('legacy unassigned tasks have isolated durable planning sessions and safe retry preserves task/run/report/attention history',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});const engine=decisions();h.ctx.provide('decisionModels',engine);
 try{
  const runtime=h.ctx.taskSystem.projects;registerExecutor(h.ledger, 'node',worker);runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const one=fixtureRun(h,'legacy-one'),two=fixtureRun(h,'legacy-two');
  for(const f of [one,two]) h.ledger.submit('failure-'+f.task.taskId,{...f.lease,outcome:'failure',summary:'Original failure',report:{title:'Failure report',body:'Keep the original report'}});
  runtime.actOnTask(operator(runtime,one.task.taskId,'handle'));
  const before=h.ledger.snapshot(),[a,b]=await Promise.all([runtime.taskConversation(one.task.taskId),runtime.taskConversation(two.task.taskId)]);
  assert.notEqual(a.sessionId,b.sessionId);assert.equal(a.projectId,null);assert.equal(a.taskId,one.task.taskId);assert.equal(runtime.projectForSession(a.sessionId),undefined);assert.equal(runtime.taskForSession(a.sessionId),one.task.taskId);
  assert.equal(runtime.snapshot().projects.length,0);assert.equal(h.ledger.snapshot().runs.length,before.runs.length);assert.equal(h.adapter.requests.length,0);assert.equal(a.workspace,b.workspace,'temporary planning sessions share their configured context directory');assert.ok(await h.ctx.sessionPersistence.stat(a.sessionId));assert.ok(await h.ctx.sessionPersistence.stat(b.sessionId));
  assert.equal((await runtime.taskConversation(one.task.taskId)).sessionId,a.sessionId);
  const command='legacy-clarify';h.adapter.script.push('可以在任务详情点击重新尝试派发');runtime.sendTask({taskId:one.task.taskId,commandId:command,text:'说明这个任务失败后如何恢复'});await settle(h,command);
  assert.match((await runtime.taskConversation(one.task.taskId)).messages.at(-1).text,/重新尝试/);assert.equal((await runtime.taskConversation(two.task.taskId)).messages.length,0);assert.equal(h.ledger.snapshot().tasks.length,2);
  assertPlannerTools(h.adapter.requests[0].tools);
  const input=operator(runtime,one.task.taskId,'retry','legacy-retry');await runtime.actOnTask(input);await runtime.actOnTask(input);
  let row=runtime.snapshot().tasks.find(t=>t.id===one.task.taskId);assert.equal(row.stateLabel,'等待执行端接收');assert.equal(row.status,'queued');assert.equal(row.project,'unassigned');assert.equal(row.recommendation[0].reasoningEffort,'off');assert.equal(h.ledger.snapshot().runs.length,2);assert.equal(h.ledger.getRun(one.run.runId).state,'failed');assert.equal(h.ledger.snapshot().reports.filter(r=>r.kind==='result').length,2);
  assert.throws(()=>runtime.assertDecisionScope(b.sessionId,'task-retry:legacy-retry'),/another temporary task/);
  h.ledger.recordNodeHeartbeat('online',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();runtime.tick();assert.equal(h.ledger.snapshot().runs.length,3);assert.equal(h.ledger.snapshot().tasks.length,2);
  assert.equal(h.ledger.getRun(one.run.runId).state,'failed');assert.equal(runtime.snapshot().tasks.find(t=>t.id===one.task.taskId).canRetry,false);
 }finally{await h.dispose();await engine.close();}
});

test('temporary conversation applies to the host-owned inbox task and cannot bypass operator retry or attach another task',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});const engine=decisions();h.ctx.provide('decisionModels',engine);
 try{
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});registerExecutor(h.ledger, 'node',worker);
  const task=h.ledger.createTask('inbox-temporary',{title:'Temporary',description:'Compute externally'}).value;
  const conversation=await runtime.taskConversation(task.taskId),command='temporary-plan',requestId='project-message:'+command;
  h.adapter.script.push({name:'task_plan',args:{requestId,title:'Calculate',description:'Compute externally'}},{name:'task_dispatch',args:{commandId:requestId}},'已排队');
  runtime.sendTask({taskId:task.taskId,commandId:command,text:'安排这个任务'});assert.equal((await settle(h,command)).state,'completed');assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(runtime.snapshot().tasks[0].stateLabel,'等待执行端接收');assert.equal(runtime.snapshot().tasks[0].recommendation[0].nodeId,'worker');
  assert.equal(h.ledger.getDecision(requestId).proposal.attachTaskId,task.taskId);
  h.ledger.recordNodeHeartbeat('up',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();const run=h.ledger.snapshot().runs[0],a=h.ledger.claim('claim-temp',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  h.ledger.submit('temp-failed',{runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,outcome:'failure',summary:'Failed'});
  const request2='project-message:unsafe-model-retry';h.adapter.script.push({name:'task_plan',args:{requestId:request2,title:'Calculate',description:'Try again'}},{name:'task_dispatch',args:{commandId:request2}},'需要点击重试');runtime.sendTask({taskId:task.taskId,commandId:'unsafe-model-retry',text:'重做'});await settle(h,'unsafe-model-retry');
  assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(h.ledger.getTask(task.taskId).state,'failed');assert.equal(h.ledger.commandReceipt('apply-decision:'+request2),undefined);
  assert.throws(()=>runtime.assertProposalScope(conversation.sessionId,{requestId,route:{nodeId:'local'}}),/current message/);
 }finally{await h.dispose();await engine.close();}
});

test('retry rechecks action CAS after asynchronous planning and does not reopen a cancelled task',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  const runtime=h.ctx.taskSystem.projects;registerExecutor(h.ledger, 'node',worker);const f=fixtureRun(h,'race');h.ledger.submit('fail-race',{...f.lease,outcome:'failure',summary:'Failed'});
  const real=runtime.planner;let release,started;const began=new Promise(r=>started=r),wait=new Promise(r=>release=r);
  runtime.planner={plan:async(...args)=>{started();await wait;return real.plan(...args)},apply:(...args)=>real.apply(...args)};
  const retry=runtime.actOnTask(operator(runtime,f.task.taskId,'retry','race-retry'));await began;runtime.actOnTask(operator(runtime,f.task.taskId,'cancel','race-cancel'));release();await assert.rejects(retry,/changed/);
  assert.equal(h.ledger.getTask(f.task.taskId).state,'cancelled');assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(h.ledger.managementDatabase().prepare('SELECT count(*) AS n FROM pr_dispatch').get().n,0);
 }finally{await h.dispose();}
});

test('retry without a decision dependency preserves the original route and queues without executing on the planner',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  const runtime=h.ctx.taskSystem.projects;registerExecutor(h.ledger, 'node',worker);const f=fixtureRun(h,'no-catalog-choice');h.ledger.submit('failed-default',{...f.lease,outcome:'failure',summary:'Failed'});
  await runtime.actOnTask(operator(runtime,f.task.taskId,'retry'));
  assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(runtime.snapshot().tasks[0].stateLabel,'等待执行端接收');assert.deepEqual(runtime.snapshot().tasks[0].recommendation,[f.run.route]);assert.equal(h.ledger.getDecision('task-retry:retry-'+f.task.taskId).receipt.kind,'deterministic-planning-v1');assert.equal(h.ctx.taskSystem.native,undefined);
 }finally{await h.dispose();}
});


test('existing project session schema migrates to explicit conversation ownership without losing sessions or dispatch',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
 try{
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});const project=await runtime.create({commandId:'migration-project',title:'Keep project',goal:'Keep session'});
  const before=await runtime.conversation(project.projectId),db=h.ledger.managementDatabase();db.exec('ALTER TABLE pr_sessions RENAME COLUMN owner TO project; ALTER TABLE pr_turns RENAME COLUMN owner TO project');
  const {ProjectRuntime}=await import('../dist/project-runtime.js'),restored=new ProjectRuntime(h.ctx,h.ledger,'local','planner',{provider:'test-offline',model:'script'});
  assert.equal((await restored.conversation(project.projectId)).sessionId,before.sessionId);assert.equal(restored.projectForSession(before.sessionId),project.projectId);assert.equal(restored.snapshot().projects.length,1);
  const t=h.ledger.createTask('temp-migration',{title:'Temporary'}).value,a=await restored.taskConversation(t.taskId);const again=new ProjectRuntime(h.ctx,h.ledger,'local','planner',{provider:'test-offline',model:'script'});
  assert.equal((await again.taskConversation(t.taskId)).sessionId,a.sessionId);assert.equal(again.projectForSession(a.sessionId),undefined);assert.equal(again.taskForSession(a.sessionId),t.taskId);
 }finally{await h.dispose();}
});


test('new temporary task plans and dispatches the same Task once, with independent context and no project',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}}),engine=decisions();h.ctx.provide('decisionModels',engine);
 try {
  const runtime=h.ctx.taskSystem.projects;registerExecutor(h.ledger, 'worker',worker);runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const input={commandId:'temporary-new',title:'Calculate',description:'Compute 1+1 and report'};
  const [first,second]=await Promise.all([runtime.createTemporary(input),runtime.createTemporary(input)]);
  assert.deepEqual(first,second);assert.equal(first.dispatchState,'queued');assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(h.ledger.snapshot().runs.length,0);
  assert.equal(runtime.snapshot().projects.length,0);assert.equal(runtime.snapshot().tasks[0].project,'unassigned');assert.equal(runtime.snapshot().tasks[0].nativeState,'inbox');
  assert.equal((await runtime.taskConversation(first.taskId)).taskId,first.taskId);assert.equal(h.adapter.requests.length,0,'structured task creation only needs the routing decision');
  const originalSession=(await runtime.taskConversation(first.taskId)).sessionId;
  assert.deepEqual(await runtime.createTemporary(input),first);await assert.rejects(runtime.createTemporary({...input,description:'changed'}),/reused/);
  h.ledger.recordNodeHeartbeat('online',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();runtime.tick();
  assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(h.ledger.snapshot().runs[0].taskId,first.taskId);
  assert.deepEqual(await runtime.createTemporary(input),first);assert.equal(h.ledger.snapshot().runs.length,1);assert.equal((await runtime.taskConversation(first.taskId)).sessionId,originalSession);
 } finally {await h.dispose();await engine.close();}
});

test('temporary creation rejects missing configuration before creating and preserves a task when planning fails',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
 try {
  const runtime=h.ctx.taskSystem.projects,input={commandId:'temporary-failure',title:'Work',description:'Full instructions'};
  await assert.rejects(runtime.createTemporary(input),/Configure/);assert.equal(h.ledger.snapshot().tasks.length,0);
  runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});runtime.planner={plan:async()=>{throw Error('Provider failed');}};
  const result=await runtime.createTemporary(input);assert.equal(result.dispatchState,'needs-planning');assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(h.ledger.snapshot().runs.length,0);
  assert.equal((await runtime.taskConversation(result.taskId)).taskId,result.taskId);assert.deepEqual(await runtime.createTemporary(input),result);assert.equal(h.ledger.snapshot().tasks.length,1);
 }finally{await h.dispose();}
});

test('DSH registration attaches project session generations and reconciles pre-existing projects without recreating IDs',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
 try {
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const input={commandId:'native-workspace',title:'Native workspace',goal:'Keep sessions together'},created=await runtime.create(input),before=runtime.snapshot().projects[0];
  const registered=new Map();h.ctx.provide('workspaceRegistry',{async create(path,title){if(!registered.has(path))registered.set(path,{title,sessions:new Set(),async attachSession(id){assert.ok(await h.ctx.sessionPersistence.stat(id));this.sessions.add(id);}});return registered.get(path);}});
  await runtime.syncWorkspaces();await runtime.syncWorkspaces();assert.equal(registered.size,1);assert.equal(registered.get(before.workspace).title,input.title);assert.deepEqual([...registered.get(before.workspace).sessions],[before.sessionId]);
  await runtime.handoff(created.projectId);assert.equal(registered.get(before.workspace).sessions.size,2);assert.deepEqual(await runtime.create(input),created);assert.equal(runtime.snapshot().projects[0].workspace,before.workspace);
  assert.equal(h.ledger.snapshot().workspaces.length,1);assert.equal(h.adapter.requests.length,0);
 }finally{await h.dispose();}
});

test('conversation model selection uses the host catalog, persists per owner, retains sessions and rejects busy/stale changes',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
 try {
  h.adapter.listModels=async()=>[{provider:'test-offline',id:'script',name:'Script'},{provider:'test-offline',id:'other',name:'Other'}];
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'models'),expectedRevision:0});
  const {projectId}=await runtime.create({commandId:'model-project',title:'Models',goal:'Talk'});
  const {projectId:other}=await runtime.create({commandId:'model-other',title:'Other',goal:'Isolate'});
  const before=await runtime.conversation(projectId),catalog=await runtime.modelCatalog();assert.equal(catalog.providers[0].models.length,2);
  await runtime.selectModel({projectId,expectedRevision:0,selection:{provider:'test-offline',model:'other'}});
  assert.equal((await runtime.conversation(projectId)).sessionId,before.sessionId);assert.equal((await runtime.conversation(other)).conversationModel.selection,null);
  await assert.rejects(runtime.selectModel({projectId,expectedRevision:0,selection:null}),/changed/);
  await assert.rejects(runtime.selectModel({projectId,expectedRevision:1,selection:{provider:'test-offline',model:'missing'}}),/unavailable/);
  h.adapter.script.push('Conversation only');runtime.send({projectId,commandId:'selected-model',text:'Hello'});assert.equal((await settle(h,'selected-model')).state,'completed');assert.equal(h.adapter.requests[0].model,'other');
  h.adapter.script.push('hang');runtime.send({projectId,commandId:'busy-model',text:'Wait'});await assert.rejects(runtime.selectModel({projectId,expectedRevision:1,selection:null}),/responding/);
  assert.equal(JSON.parse(h.ledger.managementDatabase().prepare('SELECT selection FROM pr_models WHERE owner=?').get(projectId).selection).model,'other');
 }finally{await h.dispose();}
});
test('interrupted task can be confirmed stopped without cancelling its Task, then becomes retryable with a terminal attempt',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try {
  registerExecutor(h.ledger, 'node',worker);const runtime=h.ctx.taskSystem.projects,unknown=fixtureRun(h,'interrupted-work');h.ledger.submit('uncertain-result',{...unknown.lease,outcome:'unknown',summary:'Service stopped'});
  const row=runtime.snapshot().tasks.find(t=>t.id===unknown.task.taskId);assert.equal(row.canReconcile,true);assert.equal(row.canRetry,false);assert.match(row.report,/执行回执：/);
  runtime.actOnTask(operator(runtime,unknown.task.taskId,'confirm-stopped'));
  assert.equal(h.ledger.getTask(unknown.task.taskId).state,'waiting');assert.equal(h.ledger.getRun(unknown.run.runId).state,'failed');assert.equal(h.ledger.getAttempt(unknown.lease.attemptId).state,'expired');assert.equal(runtime.snapshot().tasks.find(t=>t.id===unknown.task.taskId).canRetry,true);
 }finally{await h.dispose();}
});


test('retry skips model decisions for a valid route and keeps capabilities and workspace until admission',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try {
  registerExecutor(h.ledger, 'node',{...worker,capabilities:['filesystem'],workspaceIds:['original']});
  h.ledger.registerWorkspace('workspace',{workspaceId:'original',nodeId:'worker',path:h.dir,label:'Original',state:'ready',createdAt:new Date().toISOString()});
  const task=h.ledger.createTask('task',{title:'Keep choices',workspaceId:'original'}).value;
  const route={nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:['filesystem'],workspaceId:'original'};
  const run=h.ledger.createRun('run',{taskId:task.taskId,route}).value,a=h.ledger.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  h.ledger.submit('fail',{runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,outcome:'failure',summary:'Stopped'});
  let calls=0;h.ctx.provide('decisionModels',{ask:async()=>{calls++;throw Error('Retry must not ask a model');}});
  const runtime=h.ctx.taskSystem.projects;await runtime.actOnTask(operator(runtime,task.taskId,'retry','cached'));
  assert.equal(calls,0);assert.deepEqual(runtime.snapshot().tasks[0].recommendation,[route]);assert.equal(h.ledger.snapshot().runs.length,1);
  h.ledger.recordNodeHeartbeat('online',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();runtime.tick();
  assert.equal(h.ledger.snapshot().runs.length,2);assert.deepEqual(h.ledger.snapshot().runs.at(-1).route,route);
 }finally{await h.dispose();}
});


test('task status requests and elapsed timestamps survive snapshot refresh and use the exact current attempt',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try {
  registerExecutor(h.ledger, 'node',worker);const runtime=h.ctx.taskSystem.projects;
  const {task,run,lease}=fixtureRun(h,'long-work');
  const before=runtime.snapshot().tasks.find(t=>t.id===task.taskId);
  assert.ok(before.executionStartedAt);assert.equal(before.executionEndedAt,null);assert.equal(before.canRequestStatus,true);
  runtime.actOnTask(operator(runtime,task.taskId,'status'));
  let t=runtime.snapshot().tasks.find(t=>t.id===task.taskId);
  assert.equal(t.progressRequest.requestId,'status-'+task.taskId);assert.equal(t.progressRequest.summary,undefined);
  h.ledger.renew('progress-reply',{...lease,ttlMs:10000,progress:{requestId:t.progressRequest.requestId,summary:'正在检查文件，已完成 3 步'}});
  t=runtime.snapshot().tasks.find(t=>t.id===task.taskId);assert.match(t.progressRequest.summary,/已完成 3 步/);assert.ok(t.progressRequest.reportedAt);
  h.ledger.submit('long-done',{...lease,outcome:'success',summary:'Finished'});
  t=runtime.snapshot().tasks.find(t=>t.id===task.taskId);assert.equal(t.canRequestStatus,false);assert.ok(t.executionEndedAt);
  assert.throws(()=>runtime.actOnTask(operator(runtime,task.taskId,'status','late-progress')),/not running/);
 }finally{await h.dispose();}
});


test('a read-only follow-up keeps existing run identities and exposes honest report and messaging limitations in the planner prompt',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
 try {
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});registerExecutor(h.ledger, 'node',worker);
  const {task,run,lease}=fixtureRun(h,'receipt-question');h.ledger.submit('old-unknown',{...lease,outcome:'unknown',summary:'No canonical receipt'});
  h.ledger.resolveUncertain('verified-stopped',{runId:run.runId,outcome:'failed',reason:'Verified stopped'});
  const before=h.ledger.snapshot();await runtime.taskConversation(task.taskId);
  h.adapter.script.push({name:'task_history',args:{taskId:task.taskId}},'账本没有完成证据；当前统筹工具不能向原执行端会话发送普通消息，不重新派发。');
  runtime.sendTask({taskId:task.taskId,commandId:'receipt-question-message',text:'不重新运行，只询问执行端已有结果'});assert.equal((await settle(h,'receipt-question-message')).state,'completed');
  const prompt=JSON.stringify(h.adapter.requests[0].messages);assert.match(prompt,/不得断言执行端没有完成/);assert.match(prompt,/没有向执行端会话发送普通消息/);assert.match(prompt,/不得 task_plan\/task_dispatch/);
  const after=h.ledger.snapshot();assert.deepEqual(after.runs,before.runs);assert.deepEqual(after.attempts,before.attempts);assert.deepEqual(after.reports,before.reports);
 }finally{await h.dispose();}
});


test('manual completion and original-session supplements never create an execution or rewrite its outcome',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  registerExecutor(h.ledger, 'node',{...worker,workspaceIds:['original']});
  h.ledger.registerWorkspace('workspace',{workspaceId:'original',nodeId:'worker',path:h.dir,label:'Original',state:'ready',createdAt:new Date().toISOString()});
  const runtime=h.ctx.taskSystem.projects,{task,run,lease}=fixtureRun(h,'supplement');
  assert.throws(()=>runtime.actOnTask(operator(runtime,task.taskId,'complete','active')),/not ready/);
  const ref={...lease,executionId:'original-execution'};
  h.ledger.markRunning('start',ref);
  const session=h.ledger.selectTaskSession('select',{...ref,workspaceId:'original',session:{mode:'new'}}).value;
  h.ledger.queueSessionMessage('old-chat',{taskId:task.taskId,nodeId:'worker',sessionId:session.sessionId,text:'Before gate'});
  h.ledger.submit('failed',{...ref,outcome:'failure',summary:'Timeout'});
  const original=JSON.stringify(h.ledger.getRun(run.runId));
  const confirm=operator(runtime,task.taskId,'complete-materials','manual');runtime.actOnTask(confirm);runtime.actOnTask(confirm);
  let view=runtime.snapshot().tasks[0];assert.equal(view.status,'done');assert.equal(view.stateLabel,'已完成 · 已请求补交，等待回复');assert.equal(view.materialsStatus,'requested');
  assert.equal(h.ledger.sessionMessages(task.taskId).length,2);assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(h.ledger.snapshot().attempts.length,1);
  const messageId=h.ledger.getTask(task.taskId).manualCompletion.requestMessageId;
  assert.throws(()=>h.ledger.completeSessionMessage('foreign',{messageId,nodeId:'other',state:'completed',reply:'Spoofed'}),/mismatch/);
  h.ledger.completeSessionMessage('old-response',{messageId:'old-chat',nodeId:'worker',state:'completed',reply:'Old reply'});
  assert.equal(runtime.snapshot().tasks[0].supplementaryReports.length,0);
  h.ledger.completeSessionMessage('delivery-failed',{messageId,nodeId:'worker',state:'failed',reply:'No admission'});
  assert.equal(runtime.snapshot().tasks[0].materialsStatus,'failed');
  const retryMessage=h.ledger.queueSessionMessage('material-followup',{taskId:task.taskId,nodeId:'worker',sessionId:session.sessionId,text:'Please return the existing material'}).value;
  assert.equal(runtime.snapshot().tasks[0].materialsStatus,'requested');
  const response={messageId:retryMessage.messageId,nodeId:'worker',state:'completed',reply:'Existing file: workspace-structure.md'};
  h.ledger.completeSessionMessage('receipt',response);h.ledger.completeSessionMessage('receipt',response);h.ledger.completeSessionMessage('receipt-again',response);
  assert.equal(runtime.snapshot().tasks[0].supplementaryReports.length,1);
  const received=runtime.snapshot().tasks[0];assert.equal(received.materialsStatus,'received');assert.equal(received.stateLabel,'已完成 · 已收到材料，待核对');assert.equal(received.report,'Existing file: workspace-structure.md');assert.equal(received.reportSource,'supplement');assert.equal(received.resultStatus,'review');
  assert.equal(JSON.stringify(h.ledger.getRun(run.runId)),original);
  assert.throws(()=>runtime.actOnTask({...confirm,commandId:'stale'}),/changed/);
  h.ledger.queueSessionMessage('follow-up',{taskId:task.taskId,nodeId:'worker',sessionId:session.sessionId,text:'More material'});
  runtime.actOnTask(operator(runtime,task.taskId,'complete','finish-materials'));
  h.ledger.completeSessionMessage('late-reply',{messageId:'follow-up',nodeId:'worker',state:'completed',reply:'Late reply retained only in chat'});
  view=runtime.snapshot().tasks[0];assert.equal(view.supplementaryReports.length,1);assert.equal(view.stateLabel,'已完成 · 人工确认');assert.equal(view.canRetry,false);
  const {TaskLedger}=await import('../dist/ledger.js');const read=TaskLedger.open(join(h.dir,'tasks.sqlite'),{readOnly:true});
  try{assert.equal(read.getTask(task.taskId).state,'completed');assert.equal(read.getTask(task.taskId).manualCompletion.materials,'not_required');}finally{read.close();}
  const second=fixtureRun(h,'no-session');h.ledger.submit('fail-second',{...second.lease,outcome:'failure',summary:'Stopped'});
  assert.throws(()=>runtime.actOnTask(operator(runtime,second.task.taskId,'complete-materials','no-target')),/unavailable/);
  assert.equal(h.ledger.getTask(second.task.taskId).state,'failed');
  runtime.actOnTask(operator(runtime,second.task.taskId,'complete','no-materials'));assert.equal(h.ledger.getTask(second.task.taskId).state,'completed');
  const third=fixtureRun(h,'cancel-pending');h.ledger.submit('fail-third',{...third.lease,outcome:'failure',summary:'Stopped'});
  runtime.actOnTask(operator(runtime,third.task.taskId,'cancel','cancel-manual'));assert.equal(h.ledger.getTask(third.task.taskId).state,'cancelled');
 }finally{await h.dispose();}
});

test('rejected result can be dispatched with immutable operator feedback in the next claim and original evidence preserved',async()=>{
 for(const outcome of ['partial','success']){
  const h=await createNativeHarness({config:{role:'planner'}});
  try{
   const runtime=h.ctx.taskSystem.projects;h.ledger.registerWorkspace('rework-workspace',{workspaceId:'review-ws',nodeId:'worker',path:join(h.dir,'review-workspace'),label:'Review workspace',state:'ready',createdAt:new Date().toISOString()});registerExecutor(h.ledger, 'node',{...worker,workspaceIds:['review-ws']});
   const task=h.ledger.createTask('rework-task',{title:'Rework fixture',description:'Original instructions',policy:{allowedBackends:['fixture-backend']}}).value;
   const run=h.ledger.createRun('rework-run',{taskId:task.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:[],...(outcome==='success'?{backend:'fixture-backend',workspaceId:'review-ws'}:{})}}).value;
   const a=h.ledger.claim('rework-claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
   h.ledger.submit('rework-result',{runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,outcome,summary:'Original result',report:{title:'Original report',body:'Keep original evidence'}});
   assert.equal(runtime.snapshot().tasks[0].canRetry,false);
   runtime.actOnTask(operator(runtime,task.taskId,'reject'));
   assert.equal(runtime.snapshot().tasks[0].canRetry,true);
   assert.equal(h.ledger.snapshot().runs.length,1,'rejection alone does not start work');
   const input={...operator(runtime,task.taskId,'retry'),retryPrompt:'请补充失败用例，并解释修正依据。'};
   await runtime.actOnTask(input);await runtime.actOnTask(input);
   await assert.rejects(runtime.actOnTask({...input,retryPrompt:'Different feedback'}),/reused/);
   const {ProjectRuntime}=await import('../dist/project-runtime.js');
   const recovered=new ProjectRuntime(h.ctx,h.ledger,'local','planner');
   h.ledger.recordNodeHeartbeat('available',{nodeId:'worker',runtimeReady:true,activeExecutions:0});recovered.tick();recovered.tick();
   const runs=h.ledger.snapshot().runs;assert.equal(runs.length,2);
   const second=runs[1];if(outcome==='success')assert.equal(second.route.workspaceId,'review-ws','official backend retry keeps its explicit workspace grant');
   const claim=h.ledger.claim('rework-second-claim',{runId:second.runId,nodeId:'worker',ttlMs:10000}).value;
   assert.equal(claim.executionContext.reports.length,1);assert.match(claim.executionContext.reports[0].body,/Original instructions[\s\S]*请补充失败用例/);
   assert.equal(recovered.snapshot().runs.find(r=>r.id===second.runId).retryPrompt,input.retryPrompt);
   assert.equal(h.ledger.getTask(task.taskId).description,'Original instructions');assert.equal(h.ledger.getTask(task.taskId).workspaceId,undefined);
   assert.equal(h.ledger.getRun(run.runId).reviewStatus,'rejected');assert.equal(h.ledger.getRun(run.runId).state,outcome==='success'?'succeeded':'partial');
   assert.equal(h.ledger.snapshot().reports.filter(r=>r.kind==='result').length,1);
   assert.equal(recovered.snapshot().tasks[0].canRetry,false);
  }finally{await h.dispose();}
 }
});

test('scheduled plans expose assigned ownership before first Run and restrict the executor projection',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
 try{h.ledger.registerWorkspace('scheduled-ws',{workspaceId:'ws',nodeId:'worker',path:h.dir,label:'Scheduled workspace',state:'ready',createdAt:new Date().toISOString()});registerExecutor(h.ledger, 'scheduled-node',{...worker,workspaceIds:['ws']});h.ledger.recordNodeHeartbeat('scheduled-hb',{nodeId:'worker',runtimeReady:true,activeExecutions:0,sampledAt:Date.now(),source:'host-local',providerStatus:{executionRoutes:[{nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:[]}]}});const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});const {projectId}=await runtime.create({commandId:'plan-project',title:'Plans',goal:'Recurring work'});const options=runtime.scheduleOptions();const created=runtime.createScheduledPlan({commandId:'scheduled-new',title:'Regular check',description:'Return a report',projectId,routeId:options.routes[0].id,cadence:{mode:'interval',minutes:1}});const own=runtime.snapshotForNode('worker');assert.equal(own.schedules.length,1);assert.equal(own.schedules[0].scheduleId,created.scheduleId);assert.equal(own.tasks.find(t=>t.id===created.taskId).kind,'scheduled');assert.equal(own.tasks[0].canCancel,false);assert.equal(runtime.snapshotForNode('unrelated').schedules.length,0);assert.equal(own.runs.length,0);}finally{await h.dispose();}
});

test('execution detail exposes the immutable intent and only referenced context notes',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});try{const l=h.ledger;registerExecutor(l, 'input-node',worker);const t=l.createTask('input-task',{title:'Inspect input',description:'Original instructions'}).value;const note=l.appendReport('input-note',{taskId:t.taskId,title:'Provided reference',body:'Relevant context'}).value;l.appendReport('unreferenced',{taskId:t.taskId,title:'Later material',body:'Do not pretend this was sent'});const r=l.createRun('input-run',{taskId:t.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:[]},contextNotes:[note.reportId]}).value;l.updateTask('edit-current',{taskId:t.taskId,expectedRevision:l.getTask(t.taskId).revision??1,description:'Changed for future work'});const snapshot=h.ctx.taskSystem.projects.snapshot();assert.equal(snapshot.tasks.find(x=>x.id===t.taskId).description,'Changed for future work');const input=snapshot.runs.find(x=>x.id===r.runId).inputSnapshot;assert.equal(input.description,'Original instructions');assert.deepEqual(input.notes,[{id:note.reportId,title:'Provided reference',body:'Relevant context'}]);}finally{await h.dispose();}
});


test('same-run diagnostic notes expose evidence without accepting or changing the execution result',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});try{const l=h.ledger;registerExecutor(l, 'diagnostic-node',worker);const t=l.createTask('diag-task',{title:'Daily',description:'Report'}).value;const r=l.createRun('diag-run',{taskId:t.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:[]}}).value;const a=l.claim('diag-claim',{runId:r.runId,nodeId:'worker',ttlMs:10000}).value.attempt;l.submit('diag-unknown',{runId:r.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,outcome:'unknown',summary:'Native result rejected: SCHEMA_VALIDATION'});l.appendReport('diag-note',{taskId:t.taskId,runId:r.runId,kind:'note',title:'Saved evidence',body:'24 summaries; not accepted',schemaId:'execution-diagnostic.v1'});l.appendReport('unrelated-note',{taskId:t.taskId,kind:'note',title:'Other note',body:'Not this execution',schemaId:'execution-diagnostic.v1'});const v=h.ctx.taskSystem.projects.snapshot(),run=v.runs.find(x=>x.id===r.runId);assert.equal(run.diagnosticReport.body,'24 summaries; not accepted');assert.equal(run.settlementSummary,'Native result rejected: SCHEMA_VALIDATION');assert.equal(run.state,'uncertain');assert.equal(v.tasks.find(x=>x.id===t.taskId).reportId,null);assert.equal(l.snapshot().reports.filter(x=>x.kind==='result').length,0);}finally{await h.dispose();}
});

test('per-task report retry limit is revision checked and bounded',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{const l=h.ledger,r=h.ctx.taskSystem.projects,t=l.createTask('retry-policy',{title:'Configurable retries'}).value;
 assert.equal(r.snapshot().tasks.find(x=>x.id===t.taskId).maxResultRetries,2);
 r.setReportRetryLimit({commandId:'disable-retries',taskId:t.taskId,expectedRevision:t.revision,maxRetries:0});
 assert.equal(l.getTask(t.taskId).policy.maxResultRetries,0);
 assert.throws(()=>r.setReportRetryLimit({commandId:'stale-limit',taskId:t.taskId,expectedRevision:t.revision,maxRetries:1}),/revision|changed/i);
 assert.throws(()=>r.setReportRetryLimit({commandId:'bad-limit',taskId:t.taskId,expectedRevision:l.getTask(t.taskId).revision,maxRetries:6}));
 }finally{await h.dispose();}
});

test('child report rejection keeps parent waiting while its bounded retry is pending',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});try{
  const l=h.ledger,runtime=h.ctx.taskSystem.projects;registerExecutor(l, 'n',{...worker,maxConcurrent:2});
  const parent=l.createTask('parent',{title:'Parent',policy:{settlementQuietMs:0}}).value;
  const root=l.createRun('root',{taskId:parent.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:[]}}).value;
  l.claim('parent-claim',{runId:root.runId,nodeId:'worker',ttlMs:10000});
  const child=l.createTask('child',{title:'Child',parentTaskId:parent.taskId,parentRunId:root.runId}).value;
  const run=l.createRun('child-run',{taskId:child.taskId,parentRunId:root.runId,route:root.route}).value;
  const a=l.claim('child-claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt,ref={runId:run.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,executionId:'child-execution'};
  l.markRunning('start',ref);l.bindSession('session',{...ref,sessionId:'child-session'});
  l.submit('rejected',{...ref,outcome:'failure',summary:'Rejected',resultValidationFailure:{kind:'native-result-validation-failure-v1',code:'SCHEMA_VALIDATION',issues:['Missing required result'],sessionId:'child-session',quiescent:true,sessionPersisted:true}});
  assert.equal(l.allSettled(parent.taskId,0,root.runId).settled,false);
  l.recordNodeHeartbeat('online',{nodeId:'worker',runtimeReady:true,activeExecutions:0});
  for(let i=0;i<30&&l.snapshot().runs.length<3;i++){runtime.tick();await new Promise(r=>setTimeout(r,5));}
  assert.equal(l.snapshot().runs.length,3);assert.equal(l.snapshot().runs.at(-1).parentRunId,root.runId);assert.equal(l.allSettled(parent.taskId,0,root.runId).settled,false);
 }finally{await h.dispose();}
});

test('accepted partial results project as accepted without rewriting delivery facts; a later run has its own review',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  registerExecutor(h.ledger, 'node',worker);const runtime=h.ctx.taskSystem.projects;
  const {task,run,lease}=fixtureRun(h,'accepted-partial');
  h.ledger.submit('partial-result',{...lease,outcome:'partial',summary:'Missing PC_AU source',report:{title:'Daily',body:'Partial delivery; PC_AU source unavailable'}});
  const reportBefore=JSON.stringify(h.ledger.snapshot().reports);
  // An existing persisted acceptance is enough; no migration or synthetic success.
  h.ledger.reviewRun('existing-acceptance',{runId:run.runId,decision:'accepted',reason:'User accepts known coverage gap'});
  let row=runtime.snapshot().tasks.find(t=>t.id===task.taskId);
  assert.equal(row.status,'accepted');assert.equal(row.stateLabel,'已验收');assert.equal(row.resultStatus,'accepted');
  assert.equal(row.runState,'partial');assert.match(row.report,/PC_AU source unavailable/);
  assert.equal(row.canHandle,false);assert.equal(row.canRetry,false);assert.equal(row.canComplete,false);
  assert.equal(JSON.stringify(h.ledger.snapshot().reports),reportBefore);
  const {TaskLedger}=await import('../dist/ledger.js');const read=TaskLedger.open(join(h.dir,'tasks.sqlite'),{readOnly:true});
  try{assert.equal(read.getRun(run.runId).reviewStatus,'accepted');assert.equal(read.getRun(run.runId).state,'partial');assert.equal(read.taskActionState(task.taskId).canHandle,false);}finally{read.close();}
  const next=h.ledger.createRun('next-occurrence',{taskId:task.taskId,route:run.route}).value;
  assert.equal(runtime.snapshot().tasks.find(t=>t.id===task.taskId).status,'queued');
  const a=h.ledger.claim('next-claim',{runId:next.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  h.ledger.submit('next-result',{runId:next.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,outcome:'partial',summary:'New gap',report:{title:'Next daily',body:'New gap'}});
  assert.equal(runtime.snapshot().tasks.find(t=>t.id===task.taskId).status,'review');
  runtime.actOnTask(operator(runtime,task.taskId,'reject','reject-next'));
  row=runtime.snapshot().tasks.find(t=>t.id===task.taskId);assert.equal(row.status,'error');assert.equal(row.canRetry,true);
  assert.equal(h.ledger.getRun(run.runId).reviewStatus,'accepted');
 }finally{await h.dispose();}
});

test('project creation accepts an available per-project model with no global default and rejects missing or stale choices before creating records',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try {
  h.adapter.listModels=async()=>[{provider:'test-offline',id:'script',name:'Script'}];
  const runtime=h.ctx.taskSystem.projects;
  runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const input={commandId:'model-project',title:'Model project',goal:'Use a selected model'};
  assert.equal((await runtime.modelCatalog()).defaultSelection,null);
  await assert.rejects(runtime.create(input),error=>error.code==='PROJECT_MODEL_REQUIRED');
  await assert.rejects(runtime.create({...input,selection:{provider:'test-offline',model:'missing'}}),error=>error.code==='PROJECT_MODEL_UNAVAILABLE');
  await assert.rejects(runtime.create({...input,selection:{provider:'test-offline',model:'script',reasoningEffort:'not-an-effort'}}),error=>error.code==='PROJECT_MODEL_UNAVAILABLE');
  assert.equal(runtime.snapshot().projects.length,0);
  const selected={...input,selection:{provider:'test-offline',model:'script'}};
  const created=await runtime.create(selected);
  assert.deepEqual(await runtime.create(selected),created);
  const conversation=await runtime.conversation(created.projectId);
  assert.equal(conversation.conversationModel.effective.model,'script');
  assert.equal((await runtime.modelCatalog()).defaultSelection,null);
  assert.equal(h.adapter.requests.length,0);
  await assert.rejects(runtime.create({...selected,selection:{provider:'test-offline',model:'other'}}),error=>error.code==='CONFLICT');
 }finally{await h.dispose();}
});


test('report reading persists by report content version independently of generation and acceptance',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  registerExecutor(h.ledger, 'reading-worker',worker);const {task,lease}=fixtureRun(h,'reading');h.ledger.submit('reading-result',{...lease,outcome:'success',summary:'Report generated',report:{title:'Daily report',body:'First visible body'}});
  const runtime=h.ctx.taskSystem.projects,first=runtime.snapshot().reports.find(r=>r.taskId===task.taskId&&r.kind==='result');
  assert.equal(first.unread,true);assert.equal(runtime.snapshot().tasks.find(t=>t.id===task.taskId).status,'done');
  const input={commandId:'read-exact',reportId:first.id,contentVersion:first.contentVersion};runtime.readReport(input);runtime.readReport(input);
  assert.equal(runtime.snapshot().reports.find(r=>r.id===first.id).unread,false);assert.equal(h.ledger.getRun(lease.runId).reviewStatus,undefined);assert.equal(h.ledger.getTask(task.taskId).confirmation?.approved,undefined);
  const other=h.ledger.appendReport('later-result',{taskId:task.taskId,runId:lease.runId,kind:'result',title:'Supplement',body:'Additional source'}).value;
  assert.equal(runtime.snapshot().reports.find(r=>r.id===other.reportId).unread,true);
  const extra=runtime.snapshot().reports.find(r=>r.id===other.reportId);runtime.readReport({commandId:'read-extra',reportId:extra.id,contentVersion:extra.contentVersion});
  const db=h.ledger.managementDatabase(),row=db.prepare("SELECT data FROM entities WHERE kind='report' AND id=?").get(first.id),changed=JSON.parse(row.data);changed.body='Revised visible body';db.prepare("UPDATE entities SET data=? WHERE kind='report' AND id=?").run(JSON.stringify(changed),first.id);
  assert.equal(runtime.snapshot().reports.find(r=>r.id===first.id).unread,true);
  assert.throws(()=>runtime.readReport({...input,commandId:'read-stale'}),/Report changed/);
  const {ProjectRuntime}=await import('../dist/project-runtime.js'),reopened=new ProjectRuntime(h.ctx,h.ledger,'local','planner');assert.equal(reopened.snapshot().reports.find(r=>r.id===other.reportId).unread,false);assert.equal(reopened.snapshot().reports.find(r=>r.id===first.id).unread,true);
 }finally{await h.dispose();}
});


test('task center presentation is reversible metadata and never erases a historical child issue or executor tree',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  registerExecutor(h.ledger, 'presentation-worker',{...worker,maxConcurrent:3});const f=fixtureRun(h,'parent-presentation',{settlementQuietMs:0}),l=h.ledger;
  const child=l.createTask('child-presentation',{title:'Local source',parentTaskId:f.task.taskId,parentRunId:f.run.runId}).value;
  const r=l.createRun('child-presentation-run',{taskId:child.taskId,parentRunId:f.run.runId,route:{nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:[]}}).value;
  const claim=l.claim('child-presentation-claim',{runId:r.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  l.submit('child-presentation-result',{runId:r.runId,attemptId:claim.attemptId,nodeId:'worker',fence:claim.fence,outcome:'partial',summary:'Source gap',report:{title:'Partial source',body:'Some data missing'}});
  const failed=l.createRun('child-presentation-failed',{taskId:child.taskId,parentRunId:f.run.runId,route:r.route}).value;
  const failedClaim=l.claim('child-presentation-failed-claim',{runId:failed.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  l.submit('child-presentation-failed-result',{runId:failed.runId,attemptId:failedClaim.attemptId,nodeId:'worker',fence:failedClaim.fence,outcome:'failure',summary:'Temporary failure'});
  const later=l.createRun('child-presentation-later',{taskId:child.taskId,parentRunId:f.run.runId,route:r.route}).value;
  const laterClaim=l.claim('child-presentation-later-claim',{runId:later.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  l.submit('child-presentation-later-result',{runId:later.runId,attemptId:laterClaim.attemptId,nodeId:'worker',fence:laterClaim.fence,outcome:'success',summary:'A newer result',report:{title:'New result',body:'Different execution succeeded'}});
  l.submit('parent-presentation-result',{...f.lease,outcome:'success',summary:'Later overall delivery',report:{title:'Parent report',body:'Delivered with stated source gap'}});
  const runtime=h.ctx.taskSystem.projects;let v=runtime.snapshot(),parent=v.tasks.find(t=>t.id===f.task.taskId),c=v.tasks.find(t=>t.id===child.taskId);
  assert.equal(parent.status,'done');assert.equal(parent.showInCoordinator,true);assert.equal(c.showInCoordinator,false);assert.equal(parent.childAttention[0].parentRunId,f.run.runId);assert.equal(parent.childAttention[0].runId,r.runId);
  v=runtime.snapshot();assert.equal(v.tasks.find(t=>t.id===child.taskId).status,'done');assert.deepEqual(v.tasks.find(t=>t.id===f.task.taskId).childAttention.map(row=>row.runId),[r.runId]);
  const before=l.getRun(r.runId);runtime.setTaskPresentation({commandId:'promote-delivery',taskId:child.taskId,visibility:'primary'});assert.equal(runtime.snapshot().tasks.find(t=>t.id===child.taskId).showInCoordinator,true);assert.deepEqual(l.getRun(r.runId),before);
  runtime.setTaskPresentation({commandId:'fold-delivery',taskId:child.taskId,visibility:'execution'});assert.equal(runtime.snapshotForNode('worker').tasks.some(t=>t.id===child.taskId),true);
  const {ProjectRuntime}=await import('../dist/project-runtime.js'),reopened=new ProjectRuntime(h.ctx,l,'local','planner');assert.equal(reopened.snapshot().tasks.find(t=>t.id===child.taskId).showInCoordinator,false);assert.equal(reopened.snapshot().tasks.find(t=>t.id===f.task.taskId).childAttention.length,1);assert.equal(l.getRun(r.runId).reviewStatus,'pending_user');
 }finally{await h.dispose();}
});

test('HTML report presentation loads by exact version without growing snapshots or changing read facts',async(t)=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  registerExecutor(h.ledger, 'html-worker',worker);const {task,lease}=fixtureRun(h,'html-report');const html='<h1>Exact HTML</h1><p>'+'x'.repeat(300000)+'</p>';
  h.ledger.submit('html-result',{...lease,outcome:'success',summary:'Rendered report',report:{title:'HTML',body:'Text alternative',data:{presentation:{mediaType:'text/html',body:html},privateField:'not projected'}}});
  const runtime=h.ctx.taskSystem.projects,view=runtime.snapshot(),report=view.reports.find(r=>r.taskId===task.taskId&&r.kind==='result');assert.equal(report.hasHtmlPresentation,true);assert.equal('presentation' in report,false);assert.equal(JSON.stringify(view).includes(html),false);assert.equal(JSON.stringify(view).includes('not projected'),false);
  const bytes=Buffer.byteLength(JSON.stringify(view)),full=runtime.reportPresentation({reportId:report.id,contentVersion:report.contentVersion});assert.equal(full.presentation.body,html);assert.equal(full.runId,lease.runId);assert.equal(full.taskId,task.taskId);assert.deepEqual(Object.keys(full.presentation).sort(),['body','mediaType']);assert.equal(runtime.snapshot().reports.find(r=>r.id===report.id).unread,true);
  const other=h.ledger.appendReport('html-other',{taskId:task.taskId,runId:lease.runId,kind:'result',title:'Other',body:'Other body',data:{presentation:{mediaType:'text/html',body:'<h1>Another report</h1>'}}}).value;
  assert.throws(()=>runtime.reportPresentation({reportId:other.reportId,contentVersion:report.contentVersion}),/Report changed/);assert.throws(()=>runtime.reportPresentation({reportId:'missing',contentVersion:report.contentVersion}),error=>error.code==='NOT_FOUND');
  runtime.readReport({commandId:'read-html-v1',reportId:report.id,contentVersion:report.contentVersion});const db=h.ledger.managementDatabase(),row=db.prepare("select data from entities where kind='report' and id=?").get(report.id),changed=JSON.parse(row.data);changed.data.presentation.body='<h1>Changed HTML, same text</h1>';db.prepare("update entities set data=? where kind='report' and id=?").run(JSON.stringify(changed),report.id);
  const next=runtime.snapshot().reports.find(r=>r.id===report.id);assert.notEqual(next.contentVersion,report.contentVersion);assert.equal(next.unread,true);assert.throws(()=>runtime.reportPresentation({reportId:report.id,contentVersion:report.contentVersion}),/Report changed/);
  assert.ok(bytes<50000,'300KB HTML does not enter the default snapshot');
  const previousShape={...view,reports:view.reports.map(({hasHtmlPresentation,...report})=>report)};
  t.diagnostic(JSON.stringify({sample:'one 300KB HTML report, same UTF8 uncompressed JSON',previousSnapshotBytes:Buffer.byteLength(JSON.stringify(previousShape)),currentSnapshotBytes:bytes,onDemandBytes:Buffer.byteLength(JSON.stringify(full)),defaultContainsHtml:false}));
 }finally{await h.dispose();}
});


test('unanswered completion is visible as needs action even after task success, and operator retry preserves its execution',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  registerExecutor(h.ledger,'node',worker);const runtime=h.ctx.taskSystem.projects;
  const {task,run,lease}=h.ledger.withDispatchOrigin({kind:'session',nodeId:'local',sessionId:'return-owner',composition:{provider:'test-offline',model:'script',tools:[]}},()=>fixtureRun(h,'unanswered-result'));
  h.ledger.submit('return-success',{...lease,outcome:'success',summary:'Execution finished'});
  const message=h.ledger.history(task.taskId).resultReturns[0];
  for(let n=0;n<3;n++)h.ledger.recordTaskReturnFailure(message.messageId,'RETURN_UNAVAILABLE');
  const row=runtime.snapshot().tasks.find(t=>t.id===task.taskId);
  assert.equal(row.status,'error');assert.match(row.stateLabel,/需处理/);assert.equal(row.checkin.returnDelivery.messageId,message.messageId);
  const retry={...operator(runtime,task.taskId,'retry-return'),returnMessageId:message.messageId};
  runtime.actOnTask(retry);runtime.actOnTask(retry);
  assert.equal(h.ledger.getSessionMessage(message.messageId).state,'queued');assert.equal(h.ledger.getRun(run.runId).state,'succeeded');assert.equal(h.ledger.history(task.taskId).runs.length,1);
 }finally{await h.dispose();}
});

test('overview separates execution facts from explicit responsibility and proven user blockers',async()=>{
 const h=await createNativeHarness({config:{role:'planner',nodeId:'central'}});
 try{
  registerExecutor(h.ledger,'worker',{...worker,nodeId:'worker'});
  const origin={kind:'session',nodeId:'central',sessionId:'owner',cwd:h.dir};
  const protectedTask=h.ledger.withDispatchOrigin({...origin,parentLease:{runId:'parent',attemptId:'parent-a',nodeId:'central',fence:1}},()=>h.ledger.createTask('protected-task',{title:'Protected active task'}).value);
  const run=h.ledger.createRun('protected-run',{taskId:protectedTask.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',requiredCapabilities:[]}}).value;
  h.ledger.claim('protected-claim',{runId:run.runId,nodeId:'worker',ttlMs:10000});
  const unowned=h.ledger.createTask('unowned-queue',{title:'Unowned queued task'}).value;
  h.ledger.createRun('unowned-run',{taskId:unowned.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',requiredCapabilities:[]}});
  const failed=fixtureRun(h,'unowned-failure');h.ledger.submit('fail-unowned',{...failed.lease,outcome:'failure',summary:'No responsible session can repair this failure'});
  const source=h.ledger.withDispatchOrigin(origin,()=>h.ledger.createTask('owned-return',{title:'Failed result return'}).value);
  const returned=h.ledger.withDispatchOrigin(origin,()=>h.ledger.createRun('return-run',{taskId:source.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',requiredCapabilities:[]}}).value);
  const claim=h.ledger.claim('return-claim',{runId:returned.runId,nodeId:'worker',ttlMs:10000}).value;
  h.ledger.submit('return-failure',{runId:returned.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,outcome:'failure',summary:'Coordinator can assess the execution failure'});
  let rows=h.ctx.taskSystem.projects.snapshot().tasks;
  assert.notEqual(rows.find(t=>t.id===protectedTask.taskId).checkin.responsibility.state,'needs_user');
  assert.notEqual(rows.find(t=>t.id===unowned.taskId).checkin.responsibility.state,'needs_user');
  assert.equal(rows.find(t=>t.id===failed.task.taskId).checkin.responsibility.state,'needs_user');
  assert.equal(rows.find(t=>t.id===source.taskId).checkin.responsibility.state,'unreviewed');
  const message=h.ledger.sessionMessages(source.taskId).find(m=>m.completion);
  for(let i=0;i<3;i++)h.ledger.recordTaskReturnFailure(message.messageId,'RETURN_UNAVAILABLE');
  rows=h.ctx.taskSystem.projects.snapshot().tasks;
  assert.equal(rows.find(t=>t.id===source.taskId).checkin.responsibility.state,'needs_user');
  assert.match(rows.find(t=>t.id===source.taskId).checkin.responsibility.summary,/原会话/);
 }finally{await h.dispose();}
});
