import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
let serial=0;
function call(h,name,args,agent){return h.ctx.tools.execute({callId:ToolCallId(`public-admission-${serial++}`),name,arguments:args,signal:new AbortController().signal,...(agent?{agent}:{})});}
function body(result){assert.equal(result.isError,false,JSON.stringify(result.error));return JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));}
function catalog(l,nodeId,models){const pending=l.executionModels.request('request-'+serial++,{nodeId}).catalog.request;l.completeExecutionModels('complete-'+serial++,{nodeId,requestId:pending.requestId,generation:pending.generation,result:{state:'success',observedAt:Date.now(),complete:true,models}});return l.executionModels.view(nodeId);}
test('external public task_plan apply creates claimable temporary context without planner conversation metadata and real native session uses temporary-tasks',async()=>{
 const h=await createNativeHarness({script:[{name:'task_settle',args:{outcome:'success',summary:'external tool task complete'}}]});
 try{
  h.ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
  const l=h.ledger;l.registerNode('register',{nodeId:'local',roles:['both'],capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:[],enabled:true});
  catalog(l,'local',[{provider:'test-offline',model:'script'}]);
  // Mimic the external console's authorized session: no ProjectRuntime task/project relation.
  const agent={id:'dmc-external-tool-session'};
  assert.equal(h.ctx.taskSystem.projects.taskForSession(agent.id),undefined);
  const proposed=body(await call(h,'task_plan',{action:'propose',requestId:'external-task',title:'Inspect issue',description:'Perform the approved isolated issue analysis.',route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}},agent));
  assert.equal(proposed.routingStatus,'ready');
  const applied=body(await call(h,'task_plan',{action:'apply',requestId:'external-task'},agent));
  const snapshot=body(await call(h,"task_query",{},agent));
  const run=snapshot.runs.find(run=>run.runId===applied.value.runId);
  assert.ok(run?.runId);assert.equal(run.projectContext.schedulerId,l.schedulerIdentity());assert.equal(run.projectContext.project,null);assert.equal(run.route.workspaceId,undefined);
  assert.equal(l.pendingRuns('local').some(r=>r.runId===run.runId),true);
  const replay=body(await call(h,'task_plan',{action:'apply',requestId:'external-task'},agent));assert.equal(replay.value.runId,run.runId);assert.equal(l.snapshot().runs.length,1);assert.equal(l.snapshot().attempts.length,0);
  const claim=l.claim('fixture-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
  const executed=await h.ctx.taskSystem.native.execute(claim);assert.equal(executed.run.state,'succeeded');
  const stored=await h.ctx.sessionPersistence.open(executed.sessionId,'read');assert.equal(stored.header.cwd,join(h.dir,'temporary-tasks'));await stored.close();
 }finally{await h.dispose();}
});

test('public task_run uses node policy rather than global model and scheduling rejects an unbound temporary task',async()=>{
 const h=await createNativeHarness();
 try{
  h.ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
  const l=h.ledger;l.registerNode('node',{nodeId:'local',roles:['both'],capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:[],enabled:true});
  const view=catalog(l,'local',[{provider:'test-offline',model:'script'}]);
  l.executionModels.setDefault('default',{nodeId:'local',expectedRevision:0,expectedCatalogRevision:view.catalog.snapshot.revision,choice:{provider:'test-offline',model:'script'}});
  const task=body(await call(h,'task_create',{commandId:'public-create',title:'Default task'})).value;
  const created=body(await call(h,'task_run',{commandId:'public-run',taskId:task.taskId,nodeId:'local'})).value;
  assert.equal(created.executionModel.origin,'node_default');assert.equal(created.route.provider,'test-offline');assert.equal(created.route.model,'script');assert.equal(created.dispatchIssue,undefined);
  const denied=await call(h,'task_schedule',{commandId:'unbound-schedule',action:'create',value:{scheduleId:'schedule',taskId:task.taskId}});assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/PROJECT_REQUIRED|Bind this task to a project/);
 }finally{await h.dispose();}
});
