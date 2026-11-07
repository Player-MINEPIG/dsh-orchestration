import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createNativeHarness} from './native-harness.mjs';
import {registerExecutor} from './executor-fixture.mjs';

async function until(read) {
  const end=Date.now()+15000;
  while(!read()){assert.ok(Date.now()<end,'managed turn settled');await new Promise(resolve=>setTimeout(resolve,10));}
}
async function fixture({local=false,strict=false}={}) {
  const h=await createNativeHarness({executionRoot:local,config:{role:local?'both':'planner',autoExecute:false,schedulerEnabled:false,requireFreshHeartbeat:strict,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  const runtime=h.ctx.taskSystem.projects,ledger=h.ledger,workerId=local?'local':'worker';
  runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const project=await runtime.create({commandId:'project',title:'Retry proof',goal:'Scripted execution only'});
  registerExecutor(ledger,'worker',{nodeId:workerId,roles:['executor'],enabled:true,models:[{provider:'old',model:'expired',reasoningEfforts:['medium']},{provider:'new',model:'usable',reasoningEfforts:['high']}],workspaceIds:[],capabilities:['safe'],maxConcurrent:1});
  if(strict)ledger.recordNodeHeartbeat('initial-up',{nodeId:workerId,runtimeReady:true,activeExecutions:0});
  const catalog=ledger.executionModels.view(workerId);
  ledger.executionModels.setDefault('usable-default',{nodeId:workerId,expectedRevision:catalog.policy.revision,expectedCatalogRevision:catalog.catalog.positiveSnapshot.revision,choice:{kind:'native-dsh',provider:'new',model:'usable',reasoningEffort:'high',resume:true}});
  const task=ledger.createTask('task',{title:'Original intent',description:'Do not duplicate this Task'}).value;
  runtime.linkTask(runtime.placementProject(project.projectId).session,task.taskId);
  const run=ledger.createRun('run',{taskId:task.taskId,route:{nodeId:workerId,provider:'old',model:'expired',reasoningEffort:'medium',requiredCapabilities:['safe']}}).value;
  const claimed=ledger.claim('claim',{runId:run.runId,nodeId:workerId,ttlMs:10000}).value;
  ledger.submit('failed',{runId:run.runId,attemptId:claimed.attempt.attemptId,nodeId:workerId,fence:claimed.attempt.fence,outcome:'failure',summary:'Original AUTH failure'});
  return {...h,runtime,project,task,run};
}
async function send(h,command,args,text='Retry this task using its current node default') {
  h.adapter.script.push({name:'task_dispatch',args},'Retry recorded');
  h.runtime.send({projectId:h.project.projectId,commandId:command,text});
  await until(()=>['completed','failed'].includes(h.ledger.managementDatabase().prepare('SELECT state FROM pr_turns WHERE command=?').get(command)?.state));
}

test('real managed PM task_dispatch retries the existing Task via formal planning, snapshots current node default and deduplicates its tool call',async()=>{
  const h=await fixture();try{
    const results=[];h.ctx.on('tools/result',(exec,result)=>{if(exec.name==='task_dispatch')results.push(result);});
    const version=h.ledger.taskActionState(h.task.taskId).version;
    const args={commandId:'pm-retry',taskId:h.task.taskId,retry:true,expectedActionVersion:version,nodeId:'worker',expectedExecutionMs:1200000};
    h.adapter.script.push({name:'task_dispatch',args},{name:'task_dispatch',args},'Recorded exactly once');
    h.runtime.send({projectId:h.project.projectId,commandId:'user-retry',text:'Retry; use the current node default'});
    await until(()=>['completed','failed'].includes(h.ledger.managementDatabase().prepare('SELECT state FROM pr_turns WHERE command=?').get('user-retry')?.state));
    assert.equal(results.length,2);assert.equal(results[0].isError,false);assert.equal(results[1].isError,false);assert.deepEqual(results[1].value,results[0].value);
    const decisions=h.ledger.managementDatabase().prepare("SELECT json_extract(data,'$.input') input FROM entities WHERE kind='decision'").all();
    assert.equal(decisions.length,1);
    const input=JSON.parse(decisions[0].input);assert.equal(input.retrySourceRunId,h.run.runId);assert.deepEqual(input.retryRouting,{nodeId:'worker'});
    assert.deepEqual(input.route,{nodeId:'worker',provider:'new',model:'usable',reasoningEffort:'high',requiredCapabilities:['safe']});
    assert.match(input.retryActor,/^agent:project-/);
    assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(h.ledger.getRun(h.run.runId).state,'failed');
    h.ledger.recordNodeHeartbeat('up',{nodeId:'worker',runtimeReady:true,activeExecutions:0});h.runtime.tick();h.runtime.tick();
    const runs=h.ledger.snapshot().runs;assert.equal(runs.length,2);assert.equal(runs[1].taskId,h.task.taskId);assert.equal(runs[1].route.model,'usable');
  }finally{await h.dispose();}
});

test('managed retry explicit model is frozen, immutable command conflicts and unrelated tasks stay forbidden',async()=>{
  const h=await fixture();try{
    const args={commandId:'selected',taskId:h.task.taskId,retry:true,expectedActionVersion:h.ledger.taskActionState(h.task.taskId).version,nodeId:'worker',executionModel:{provider:'new',model:'usable'}};
    await send(h,'selected-request',args);
    const input=JSON.parse(h.ledger.managementDatabase().prepare("SELECT json_extract(data,'$.input') input FROM entities WHERE kind='decision'").get().input);assert.equal(input.route.model,'usable');assert.deepEqual(input.retryRouting.executionModel,args.executionModel);assert.equal(input.route.reasoningEffort,undefined);
    await send(h,'changed-command',{...args,executionModel:{provider:'old',model:'expired'}});
    assert.equal(h.ledger.managementDatabase().prepare("SELECT COUNT(*) n FROM entities WHERE kind='decision'").get().n,1);
    const other=h.ledger.createTask('foreign',{title:'Foreign'}).value;
    await send(h,'foreign-request',{...args,commandId:'foreign-retry',taskId:other.taskId});
    assert.equal(h.ledger.managementDatabase().prepare("SELECT COUNT(*) n FROM entities WHERE kind='decision'").get().n,1);
  }finally{await h.dispose();}
});

test('task-center routing override uses the same retry operation without changing existing caller defaults',async()=>{
  const h=await fixture();try{
    const args={commandId:'operator-routed',taskId:h.task.taskId,action:'retry',expectedVersion:h.ledger.taskActionState(h.task.taskId).version,runId:h.run.runId,confirmationRevision:1,retryRouting:{nodeId:'worker'},expectedExecutionMs:90000};
    const first=await h.runtime.actOnTask(args);assert.deepEqual(await h.runtime.actOnTask(args),first);
    await assert.rejects(h.runtime.actOnTask({...args,retryRouting:{nodeId:'worker',executionModel:{provider:'old',model:'expired'}}}),/reused/);
    const input=h.ledger.getDecision('task-retry:operator-routed').input;
    assert.equal(input.route.model,'usable');assert.equal(input.retryActor,undefined);assert.equal(input.expectedExecutionMs,90000);
    assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(h.ledger.getRun(h.run.runId).state,'failed');
  }finally{await h.dispose();}
});

test('readonly managed PM cannot retry',async()=>{
  const h=await fixture();try{
    const {default:policy}=await import('@deepseek-ai/dsh-sandbox-policy');
    await h.ctx.plugin(policy,{mode:'read-only'});
    await send(h,'readonly',{commandId:'readonly-retry',taskId:h.task.taskId,retry:true,expectedActionVersion:h.ledger.taskActionState(h.task.taskId).version});
    assert.equal(h.ledger.managementDatabase().prepare("SELECT COUNT(*) n FROM entities WHERE kind='decision'").get().n,0);
    assert.equal(h.ledger.snapshot().runs.length,1);
  }finally{await h.dispose();}
});

test('scheduled native PM check-in cannot authorize a managed task rerun',async()=>{
  const h=await fixture();try{
    const {attachProjectSessionHost}=await import('../../packages/task-system/test/fixtures/project-session-host.mjs');
    const {createUserMessage}=await import('@deepseek-ai/dsh-llm');
    const {SessionId}=await import('@deepseek-ai/dsh-session');
    await attachProjectSessionHost(h);
    const id=h.runtime.placementProject(h.project.projectId).session;
    const {agent,error}=await h.ctx.sessionController.resolveAgent(SessionId(id));assert.equal(error,undefined);
    let outcome;h.ctx.on('tools/result',(exec,result)=>{if(exec.name==='task_dispatch')outcome=result;});
    h.adapter.script.push({name:'task_dispatch',args:{commandId:'scheduled-retry',taskId:h.task.taskId,retry:true,expectedActionVersion:h.ledger.taskActionState(h.task.taskId).version}},'No retry');
    agent.followup(createUserMessage({source:{kind:'dsh-task-checkin',taskId:h.task.taskId,eventId:'check'},content:[{type:'text',text:'Check progress; never rerun'}]}));
    await agent.whenIdle();assert.equal(outcome.isError,true);assert.match(JSON.stringify(outcome),/current user-requested/);
    assert.equal(h.ledger.managementDatabase().prepare("SELECT COUNT(*) n FROM entities WHERE kind='decision'").get().n,0);
  }finally{await h.dispose();}
});

test('same-machine formal PM retry is claimed and submitted by actual native executor using the selected model',async()=>{
  const h=await fixture({local:true});try{
    const results=[];h.ctx.on('tools/result',(exec,result)=>{if(exec.name==='task_dispatch')results.push(result);});
    await send(h,'local-user-retry',{commandId:'local-retry',taskId:h.task.taskId,retry:true,expectedActionVersion:h.ledger.taskActionState(h.task.taskId).version,nodeId:'local'});
    assert.equal(results.length,1);assert.equal(results[0].isError,false,JSON.stringify(results));
    h.ledger.recordNodeHeartbeat('local-up',{nodeId:'local',runtimeReady:true,activeExecutions:0});h.runtime.tick();h.runtime.tick();
    const next=h.ledger.snapshot().runs.find(run=>run.runId!==h.run.runId);assert.ok(next);assert.equal(next.route.model,'usable');
    h.adapter.resolveModel=async (provider,id)=>({provider,id,name:id,reasoning:{efforts:[{id:'high',name:'High'}]}});
    h.ctx.llm.registerAdapter(['new'],h.adapter);
    h.adapter.script.push(options=>{assert.equal(options.provider,'new');assert.equal(options.model,'usable');assert.equal(options.reasoningEffort,'high');return {name:'task_submit_result',args:{outcome:'success',summary:'FIXED_NATIVE_RETRY_RESULT',reportTitle:'Retry evidence',reportBody:'Actual scoped task_submit_result, no business side effects'}};});
    const claim=h.ledger.claim('new-claim',{runId:next.runId,nodeId:'local',ttlMs:10000}).value;
    const result=await h.ctx.taskSystem.native.execute(claim);
    assert.equal(result.run.state,'succeeded',result.run.resultSummary);assert.equal(h.ledger.getRun(h.run.runId).state,'failed');assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(h.ledger.snapshot().runs.length,2);
    assert.ok(h.ledger.history(h.task.taskId).reports.some(report=>report.kind==='result'&&report.body.includes('Actual scoped')));
  }finally{await h.dispose();}
});

test('managed PM retry rechecks task CAS after awaited planning and does not reopen cancelled work',async()=>{
  const h=await fixture();try{
    const began=Promise.withResolvers(),release=Promise.withResolvers(),planner=h.runtime.planner;
    h.runtime.planner={plan:async(...args)=>{began.resolve();await release.promise;return planner.plan(...args);},apply:(...args)=>planner.apply(...args)};
    const sending=send(h,'race',{commandId:'race-retry',taskId:h.task.taskId,retry:true,expectedActionVersion:h.ledger.taskActionState(h.task.taskId).version});
    await began.promise;
    h.runtime.actOnTask({commandId:'cancel-during-plan',action:'cancel',taskId:h.task.taskId,expectedVersion:h.ledger.taskActionState(h.task.taskId).version,runId:h.run.runId,confirmationRevision:1});
    release.resolve();await sending;assert.equal(h.ledger.getTask(h.task.taskId).state,'cancelled');assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(h.ledger.managementDatabase().prepare('SELECT COUNT(*) n FROM pr_dispatch').get().n,0);
  }finally{await h.dispose();}
});

test('fresh-heartbeat hosts queue managed retry for an offline chosen executor without losing its capability constraint',async()=>{
  const h=await fixture({strict:true});try{
    h.ledger.recordNodeHeartbeat('offline',{nodeId:'worker',runtimeReady:false,activeExecutions:0});
    await send(h,'offline-user',{commandId:'offline-retry',taskId:h.task.taskId,retry:true,expectedActionVersion:h.ledger.taskActionState(h.task.taskId).version});
    assert.equal(h.ledger.snapshot().runs.length,1);
    const decision=JSON.parse(h.ledger.managementDatabase().prepare("SELECT data FROM entities WHERE kind='decision'").get().data);
    assert.equal(decision.input.route.nodeId,'worker');assert.equal(decision.input.route.model,'usable');assert.deepEqual(decision.input.route.requiredCapabilities,['safe']);
    h.ledger.recordNodeHeartbeat('now-up',{nodeId:'worker',runtimeReady:true,activeExecutions:0});h.runtime.tick();h.runtime.tick();
    assert.equal(h.ledger.snapshot().runs.length,2);
  }finally{await h.dispose();}
});
