import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
import {DecisionEngine,StructuredModelProvider} from '@dsh-task/typed-decisions/core';

const worker={nodeId:'worker',roles:['executor'],models:[{provider:'worker-model',model:'small',reasoningEfforts:['off']}],capabilities:[],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()};
async function settle(h,command){for(let i=0;i<100;i++){const turn=h.ledger.managementDatabase().prepare('SELECT state FROM pr_turns WHERE command=?').get(command);if(['completed','failed'].includes(turn.state))return turn;await new Promise(r=>setTimeout(r,20));}throw Error('Turn timeout');}
function decisions(){return new DecisionEngine([new StructuredModelProvider('judge',[{model:'router',version:'fixture',reasoningEfforts:[]}],{complete:async({input})=>{
  assert.ok(input.context.catalog.modelRoutes.every(r=>r.reasoningEffort==='off'),'project routes must pin the advertised effort, not a provider default');
  const route=input.context.catalog.modelRoutes.find(r=>r.executorId==='worker'&&r.reasoningEffort==='off');
  const replan=input.context.state.request.title==='Replan';
  const choices={persist:replan?'attach':'create',attach:replan?input.context.catalog.tasks[0].id:'none',executor:'worker',modelEffort:route.id,reporting:'summary'};
  return {output:{answers:Object.fromEntries(input.questions.map(q=>[q.questionId,{type:'choice',choice:choices[q.questionId]}]))},modelVersion:'fixture'};
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
  const engine=decisions();h.ctx.provide('typedDecisions',engine);
  try{const runtime=h.ctx.taskSystem.projects;h.ledger.registerNode('worker',worker);runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const {projectId}=await runtime.create({commandId:'new',title:'Phone task',goal:'Small real dispatch'});
    const command='message1',requestId='project-message:'+command;
    h.adapter.script.push({name:'task_nodes',args:{}},{name:'task_plan',args:{action:'propose',requestId,title:'Calculate',description:'Compute 1+1 and report'}},{name:'task_plan',args:{action:'apply',requestId}},'任务已经排队，等待执行端上线');
    const input={projectId,commandId:command,text:'请计算 1+1，交给执行端'};
    runtime.send(input);assert.equal((await settle(h,command)).state,'completed');
    const snapshot=runtime.snapshot();assert.equal(snapshot.tasks.length,1,JSON.stringify(h.adapter.requests.at(-1)));assert.equal(snapshot.tasks[0].project,projectId);assert.equal(snapshot.tasks[0].status,'queued');
    assert.equal(h.ledger.snapshot().attempts.length,0);assert.equal(snapshot.runs.length,0);assert.equal(snapshot.tasks[0].nativeState,'inbox');assert.equal(snapshot.tasks[0].report,'尚未收到执行报告');assert.equal(snapshot.tasks[0].recommendation[0].nodeId,'worker');
    runtime.send(input);assert.equal(h.ledger.snapshot().runs.length,0);assert.equal(h.adapter.requests.length,4);
    assert.throws(()=>runtime.send({...input,text:'different'}),/reused/);
    const request=h.adapter.requests[0];assert.deepEqual(request.tools.map(t=>t.name).sort(),['task_children','task_history','task_nodes','task_plan','task_query'].sort());
    assert.match(JSON.stringify(request.messages),/project-message:message1/);
    const conversation=await runtime.conversation(projectId);assert.equal(conversation.messages[0].role,'user');assert.equal(conversation.messages.filter(m=>m.role==='user').length,1);assert.match(conversation.messages.at(-1).text,/排队/);
    const second=await runtime.create({commandId:'new2',title:'Other',goal:'Isolated'}),other=runtime.snapshot().projects.find(p=>p.id===second.projectId);
    assert.throws(()=>runtime.assertDecisionScope(other.sessionId,requestId),/another project/);
    h.ledger.recordNodeHeartbeat('online-worker',{nodeId:'worker',runtimeReady:true,activeExecutions:0,observedAt:new Date().toISOString()});runtime.tick();runtime.tick();assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(runtime.snapshot().runs[0].node,'worker');
    assert.equal(h.ledger.managementDatabase().prepare('SELECT generation FROM pr_dispatch').get().generation,1);
    h.ledger.recordNodeHeartbeat('worker-paused',{nodeId:'worker',runtimeReady:false,activeExecutions:0});
    h.ledger.managementDatabase().prepare("UPDATE pr_dispatch SET updated='2000-01-01T00:00:00Z'").run();
    runtime.tick();assert.equal(h.ledger.getRun(runtime.snapshot().runs[0].id).state,'cancelled');assert.equal(runtime.snapshot().tasks[0].nativeState,'inbox');assert.equal(runtime.snapshot().tasks[0].stateLabel,'待派发');
    const replanId='project-message:replan-message';
    h.adapter.script.push({name:'task_plan',args:{action:'propose',requestId:replanId,title:'Replan',description:'Replan the same pending task'}},{name:'task_plan',args:{action:'apply',requestId:replanId}},'已更新候选');
    runtime.send({projectId,commandId:'replan-message',text:'重新规划尚未领取的同一任务'});assert.equal((await settle(h,'replan-message')).state,'completed');
    assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(h.ledger.managementDatabase().prepare('SELECT decision FROM pr_dispatch').get().decision,replanId);
    runtime.enqueueDecision(requestId,snapshot.tasks[0].id);assert.equal(h.ledger.managementDatabase().prepare('SELECT decision FROM pr_dispatch').get().decision,replanId,'older recovery receipts must not overwrite a replan');
    h.ledger.recordNodeHeartbeat('worker-returned',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();runtime.tick();
    assert.equal(h.ledger.snapshot().runs.length,2);assert.equal(h.ledger.managementDatabase().prepare('SELECT generation FROM pr_dispatch').get().generation,2);assert.equal(h.ledger.snapshot().attempts.length,0);
    const old=conversation.sessionId;await runtime.handoff(projectId);const next=await runtime.conversation(projectId);assert.equal(next.generation,2);assert.notEqual(next.sessionId,old);assert.match(next.sessions[0].summary,/Calculate/);assert.equal(h.ledger.snapshot().runs.length,2);
  }finally{await h.dispose();await engine.close();}
});

test('planner-only ledger rejects a stale self-node executor role and excludes it from the planning catalog',async()=>{
 const h=await createNativeHarness({config:{role:'planner',nodeId:'vps'}});
 try{h.ledger.registerNode('stale-self',{...worker,nodeId:'vps',roles:['both']});
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
  return {output:{answers:Object.fromEntries(input.questions.map(q=>[q.questionId,{type:'choice',choice:choices[q.questionId]}]))},modelVersion:'fixture'};
 }} )],{defaultProvider:'judge',maxAttempts:1});h.ctx.provide('typedDecisions',engine);
 try {
  h.ledger.registerNode('one',worker);h.ledger.registerNode('two',{...worker,nodeId:'backup'});
  h.ledger.recordNodeHeartbeat('backup-online',{nodeId:'backup',runtimeReady:true,activeExecutions:0});
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const {projectId}=await runtime.create({commandId:'new-fallback',title:'Fallback',goal:'Use alternate executor'});
  const command='fallback-message',requestId='project-message:'+command;
  h.adapter.script.push({name:'task_plan',args:{action:'propose',requestId,title:'Small task',description:'Report two'}},{name:'task_plan',args:{action:'apply',requestId}},'已提交');
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
function fixtureRun(h,key) {
 const task=h.ledger.createTask('task-'+key,{title:key}).value;
 const run=h.ledger.createRun('run-'+key,{taskId:task.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:[]}}).value;
 const a=h.ledger.claim('claim-'+key,{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;const lease={runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence};
 return {task,run,lease};
}

test('operator attention preserves failed outcome, survives restart, restores and invalidates on a new execution',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try {
  h.ledger.registerNode('node',worker);const runtime=h.ctx.taskSystem.projects;
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
  h.ledger.registerNode('node',worker);const runtime=h.ctx.taskSystem.projects;
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
  h.ledger.registerNode('node',worker);const runtime=h.ctx.taskSystem.projects;
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
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});const engine=decisions();h.ctx.provide('typedDecisions',engine);
 try {
  h.ledger.registerNode('node',worker);const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const {projectId}=await runtime.create({commandId:'retry-project',title:'Retry project',goal:'Compute externally'}),requestId='project-message:retry-message';
  h.adapter.script.push({name:'task_plan',args:{action:'propose',requestId,title:'Retry work',description:'Compute once'}},{name:'task_plan',args:{action:'apply',requestId}},'排队');
  runtime.send({projectId,commandId:'retry-message',text:'派发'});await settle(h,'retry-message');
  h.ledger.recordNodeHeartbeat('online',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();
  const run=h.ledger.snapshot().runs[0],a=h.ledger.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  h.ledger.submit('failed',{runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,outcome:'failure',summary:'Stopped failure'});runtime.tick();
  assert.equal(runtime.snapshot().tasks[0].canRetry,true);
  h.ledger.recordNodeHeartbeat('pause',{nodeId:'worker',runtimeReady:false,activeExecutions:0});
  const input=operator(runtime,run.taskId,'retry');await runtime.actOnTask(input);await runtime.actOnTask(input);
  assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(runtime.snapshot().tasks[0].stateLabel,'待派发');
  h.ledger.recordNodeHeartbeat('back',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();runtime.tick();
  const rows=h.ledger.snapshot().runs;assert.equal(rows.length,2);assert.equal(rows[0].state,'failed');assert.notEqual(rows[0].runId,rows[1].runId);assert.equal(rows[1].taskId,rows[0].taskId);
  assert.equal(runtime.snapshot().tasks[0].canRetry,false);await assert.rejects(runtime.actOnTask({...input,commandId:'unsafe-retry'}),/changed/);
  runtime.actOnTask(operator(runtime,run.taskId,'cancel'));runtime.tick();assert.equal(runtime.snapshot().tasks[0].status,'cancelled');assert.equal(h.ledger.snapshot().runs.length,2);
 }finally{await h.dispose();await engine.close();}
});


test('legacy unassigned tasks have isolated durable planning sessions and safe retry preserves task/run/report/attention history',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});const engine=decisions();h.ctx.provide('typedDecisions',engine);
 try{
  const runtime=h.ctx.taskSystem.projects;h.ledger.registerNode('node',worker);runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const one=fixtureRun(h,'legacy-one'),two=fixtureRun(h,'legacy-two');
  for(const f of [one,two]) h.ledger.submit('failure-'+f.task.taskId,{...f.lease,outcome:'failure',summary:'Original failure',report:{title:'Failure report',body:'Keep the original report'}});
  runtime.actOnTask(operator(runtime,one.task.taskId,'handle'));
  const before=h.ledger.snapshot(),[a,b]=await Promise.all([runtime.taskConversation(one.task.taskId),runtime.taskConversation(two.task.taskId)]);
  assert.notEqual(a.sessionId,b.sessionId);assert.equal(a.projectId,null);assert.equal(a.taskId,one.task.taskId);assert.equal(runtime.projectForSession(a.sessionId),undefined);assert.equal(runtime.taskForSession(a.sessionId),one.task.taskId);
  assert.equal(runtime.snapshot().projects.length,0);assert.equal(h.ledger.snapshot().runs.length,before.runs.length);assert.equal(h.adapter.requests.length,0);assert.ok(existsSync(join(a.workspace,'TOOLS.md')));
  assert.equal((await runtime.taskConversation(one.task.taskId)).sessionId,a.sessionId);
  const command='legacy-clarify';h.adapter.script.push('可以在任务详情点击重新尝试派发');runtime.sendTask({taskId:one.task.taskId,commandId:command,text:'说明这个任务失败后如何恢复'});await settle(h,command);
  assert.match((await runtime.taskConversation(one.task.taskId)).messages.at(-1).text,/重新尝试/);assert.equal((await runtime.taskConversation(two.task.taskId)).messages.length,0);assert.equal(h.ledger.snapshot().tasks.length,2);
  assert.deepEqual(h.adapter.requests[0].tools.map(t=>t.name).sort(),['task_children','task_history','task_nodes','task_plan','task_query'].sort());
  const input=operator(runtime,one.task.taskId,'retry','legacy-retry');await runtime.actOnTask(input);await runtime.actOnTask(input);
  let row=runtime.snapshot().tasks.find(t=>t.id===one.task.taskId);assert.equal(row.stateLabel,'待派发');assert.equal(row.status,'queued');assert.equal(row.project,'unassigned');assert.equal(row.recommendation[0].reasoningEffort,'off');assert.equal(h.ledger.snapshot().runs.length,2);assert.equal(h.ledger.getRun(one.run.runId).state,'failed');assert.equal(h.ledger.snapshot().reports.filter(r=>r.kind==='result').length,2);
  assert.throws(()=>runtime.assertDecisionScope(b.sessionId,'task-retry:legacy-retry'),/another temporary task/);
  h.ledger.recordNodeHeartbeat('online',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();runtime.tick();assert.equal(h.ledger.snapshot().runs.length,3);assert.equal(h.ledger.snapshot().tasks.length,2);
  assert.equal(h.ledger.getRun(one.run.runId).state,'failed');assert.equal(runtime.snapshot().tasks.find(t=>t.id===one.task.taskId).canRetry,false);
 }finally{await h.dispose();await engine.close();}
});

test('temporary conversation applies to the host-owned inbox task and cannot bypass operator retry or attach another task',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});const engine=decisions();h.ctx.provide('typedDecisions',engine);
 try{
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});h.ledger.registerNode('node',worker);
  const task=h.ledger.createTask('inbox-temporary',{title:'Temporary',description:'Compute externally'}).value;
  const conversation=await runtime.taskConversation(task.taskId),command='temporary-plan',requestId='project-message:'+command;
  h.adapter.script.push({name:'task_plan',args:{action:'propose',requestId,title:'Calculate',description:'Compute externally'}},{name:'task_plan',args:{action:'apply',requestId}},'已排队');
  runtime.sendTask({taskId:task.taskId,commandId:command,text:'安排这个任务'});assert.equal((await settle(h,command)).state,'completed');assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(runtime.snapshot().tasks[0].stateLabel,'待派发');assert.equal(runtime.snapshot().tasks[0].recommendation[0].nodeId,'worker');
  assert.equal(h.ledger.getDecision(requestId).proposal.attachTaskId,task.taskId);
  h.ledger.recordNodeHeartbeat('up',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();const run=h.ledger.snapshot().runs[0],a=h.ledger.claim('claim-temp',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  h.ledger.submit('temp-failed',{runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,outcome:'failure',summary:'Failed'});
  const request2='project-message:unsafe-model-retry';h.adapter.script.push({name:'task_plan',args:{action:'propose',requestId:request2,title:'Calculate',description:'Try again'}},{name:'task_plan',args:{action:'apply',requestId:request2}},'需要点击重试');runtime.sendTask({taskId:task.taskId,commandId:'unsafe-model-retry',text:'重做'});await settle(h,'unsafe-model-retry');
  assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(h.ledger.getTask(task.taskId).state,'failed');assert.equal(h.ledger.commandReceipt('apply-decision:'+request2),undefined);
  assert.throws(()=>runtime.assertProposalScope(conversation.sessionId,{requestId,route:{nodeId:'local'}}),/current message/);
 }finally{await h.dispose();await engine.close();}
});

test('retry rechecks action CAS after asynchronous planning and does not reopen a cancelled task',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  const runtime=h.ctx.taskSystem.projects;h.ledger.registerNode('node',worker);const f=fixtureRun(h,'race');h.ledger.submit('fail-race',{...f.lease,outcome:'failure',summary:'Failed'});
  const real=runtime.planner;let release,started;const began=new Promise(r=>started=r),wait=new Promise(r=>release=r);
  runtime.planner={plan:async(...args)=>{started();await wait;return real.plan(...args)},apply:(...args)=>real.apply(...args)};
  const retry=runtime.actOnTask(operator(runtime,f.task.taskId,'retry','race-retry'));await began;runtime.actOnTask(operator(runtime,f.task.taskId,'cancel','race-cancel'));release();await assert.rejects(retry,/changed/);
  assert.equal(h.ledger.getTask(f.task.taskId).state,'cancelled');assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(h.ledger.managementDatabase().prepare('SELECT count(*) AS n FROM pr_dispatch').get().n,0);
 }finally{await h.dispose();}
});

test('retry without a decision dependency preserves the original route and queues without executing on the planner',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  const runtime=h.ctx.taskSystem.projects;h.ledger.registerNode('node',worker);const f=fixtureRun(h,'no-catalog-choice');h.ledger.submit('failed-default',{...f.lease,outcome:'failure',summary:'Failed'});
  await runtime.actOnTask(operator(runtime,f.task.taskId,'retry'));
  assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(runtime.snapshot().tasks[0].stateLabel,'待派发');assert.deepEqual(runtime.snapshot().tasks[0].recommendation,[f.run.route]);assert.equal(h.ledger.getDecision('task-retry:retry-'+f.task.taskId).receipt.kind,'deterministic-planning-v1');assert.equal(h.ctx.taskSystem.native,undefined);
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
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}}),engine=decisions();h.ctx.provide('typedDecisions',engine);
 try {
  const runtime=h.ctx.taskSystem.projects;h.ledger.registerNode('worker',worker);runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
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
  h.ledger.registerNode('node',worker);const runtime=h.ctx.taskSystem.projects,unknown=fixtureRun(h,'interrupted-work');h.ledger.submit('uncertain-result',{...unknown.lease,outcome:'unknown',summary:'Service stopped'});
  const row=runtime.snapshot().tasks.find(t=>t.id===unknown.task.taskId);assert.equal(row.canReconcile,true);assert.equal(row.canRetry,false);assert.match(row.report,/执行回执：/);
  runtime.actOnTask(operator(runtime,unknown.task.taskId,'confirm-stopped'));
  assert.equal(h.ledger.getTask(unknown.task.taskId).state,'waiting');assert.equal(h.ledger.getRun(unknown.run.runId).state,'failed');assert.equal(h.ledger.getAttempt(unknown.lease.attemptId).state,'expired');assert.equal(runtime.snapshot().tasks.find(t=>t.id===unknown.task.taskId).canRetry,true);
 }finally{await h.dispose();}
});


test('retry skips model decisions for a valid route and keeps capabilities and workspace until admission',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try {
  h.ledger.registerNode('node',{...worker,capabilities:['filesystem'],workspaceIds:['original']});
  h.ledger.registerWorkspace('workspace',{workspaceId:'original',nodeId:'worker',path:h.dir,label:'Original',state:'ready',createdAt:new Date().toISOString()});
  const task=h.ledger.createTask('task',{title:'Keep choices',workspaceId:'original'}).value;
  const route={nodeId:'worker',provider:'worker-model',model:'small',reasoningEffort:'off',requiredCapabilities:['filesystem'],workspaceId:'original'};
  const run=h.ledger.createRun('run',{taskId:task.taskId,route}).value,a=h.ledger.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  h.ledger.submit('fail',{runId:a.runId,attemptId:a.attemptId,nodeId:a.nodeId,fence:a.fence,outcome:'failure',summary:'Stopped'});
  let calls=0;h.ctx.provide('typedDecisions',{presetFor:()=>undefined,decide:async()=>{calls++;throw Error('Retry must not ask a model');}});
  const runtime=h.ctx.taskSystem.projects;await runtime.actOnTask(operator(runtime,task.taskId,'retry','cached'));
  assert.equal(calls,0);assert.deepEqual(runtime.snapshot().tasks[0].recommendation,[route]);assert.equal(h.ledger.snapshot().runs.length,1);
  h.ledger.recordNodeHeartbeat('online',{nodeId:'worker',runtimeReady:true,activeExecutions:0});runtime.tick();runtime.tick();
  assert.equal(h.ledger.snapshot().runs.length,2);assert.deepEqual(h.ledger.snapshot().runs.at(-1).route,route);
 }finally{await h.dispose();}
});


test('task status requests and elapsed timestamps survive snapshot refresh and use the exact current attempt',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try {
  h.ledger.registerNode('node',worker);const runtime=h.ctx.taskSystem.projects;
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
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});h.ledger.registerNode('node',worker);
  const {task,run,lease}=fixtureRun(h,'receipt-question');h.ledger.submit('old-unknown',{...lease,outcome:'unknown',summary:'No canonical receipt'});
  h.ledger.resolveUncertain('verified-stopped',{runId:run.runId,outcome:'failed',reason:'Verified stopped'});
  const before=h.ledger.snapshot();await runtime.taskConversation(task.taskId);
  h.adapter.script.push({name:'task_history',args:{taskId:task.taskId}},'账本没有完成证据；当前统筹工具不能向原执行端会话发送普通消息，不重新派发。');
  runtime.sendTask({taskId:task.taskId,commandId:'receipt-question-message',text:'不重新运行，只询问执行端已有结果'});assert.equal((await settle(h,'receipt-question-message')).state,'completed');
  const prompt=JSON.stringify(h.adapter.requests[0].messages);assert.match(prompt,/不得断言执行端没有完成/);assert.match(prompt,/没有向执行端会话发送普通消息/);assert.match(prompt,/不得 propose\/apply/);
  const after=h.ledger.snapshot();assert.deepEqual(after.runs,before.runs);assert.deepEqual(after.attempts,before.attempts);assert.deepEqual(after.reports,before.reports);
 }finally{await h.dispose();}
});


test('manual completion and original-session supplements never create an execution or rewrite its outcome',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});
 try{
  h.ledger.registerNode('node',{...worker,workspaceIds:['original']});
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
