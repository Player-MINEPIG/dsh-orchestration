import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
let serial=0;
function call(h,name,args,agent){return h.ctx.tools.execute({callId:ToolCallId(`public-admission-${serial++}`),name,arguments:args,signal:new AbortController().signal,...(agent?{agent}:{})});}
function body(result){assert.equal(result.isError,false,JSON.stringify(result.error));return JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));}
function catalog(l,nodeId,models){const pending=l.executionModels.request('request-'+serial++,{nodeId}).catalog.request;l.completeExecutionModels('complete-'+serial++,{nodeId,requestId:pending.requestId,generation:pending.generation,result:{state:'success',observedAt:Date.now(),complete:true,models}});return l.executionModels.view(nodeId);}
test('external public task_dispatch applies a reviewed proposal and creates claimable temporary context without planner conversation metadata and real native session uses temporary-tasks',async()=>{
 const h=await createNativeHarness({script:[{name:'task_settle',args:{outcome:'success',summary:'external tool task complete'}}]});
 try{
  h.ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
  const l=h.ledger;l.registerNode('register',{nodeId:'local',roles:['both'],capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:[],enabled:true});
  catalog(l,'local',[{provider:'test-offline',model:'script'}]);
  // Mimic the external console's authorized session: no ProjectRuntime task/project relation.
  const agent={id:'dmc-external-tool-session'};
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
  for(const name of ['task_run','task_delegate','task_children','project_dispatch'])assert.equal(h.ctx.tools.get(name),undefined,name);
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
