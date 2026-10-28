import {registerExecutor} from '../../../tests/dsh/executor-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';

for(const planningDecisionEnabled of [false,true])for(const sessionDecisionEnabled of [false,true])test(`dispatch and execution ignore legacy decision switches ${planningDecisionEnabled}/${sessionDecisionEnabled}`,async()=>{
 const h=await createNativeHarness({executionRoot:true,config:{planningDecisionEnabled,sessionDecisionEnabled},script:[{name:'task_submit_result',args:{outcome:'success',summary:'Done'}}]});
 let calls=0;h.ctx.provide('decisionModels',{ask:async()=>{calls++;throw Error('Dispatch must not call JEV');}});
 try{
  registerExecutor(h.ledger,'node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
  const invoke=args=>h.ctx.tools.execute({name:'task_dispatch',callId:'direct-dispatch',arguments:args,signal:new AbortController().signal});
  assert.equal(h.ctx.tools.get('task_plan'),undefined);
  const args={commandId:'direct',title:'Execute directly',description:'Use the authorized pool.'};
  const first=await invoke(args);assert.equal(first.isError,false,JSON.stringify(first));
  const replay=await invoke(args);assert.equal(replay.isError,false);assert.equal(replay.value.value.runId,first.value.value.runId);
  assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(h.ledger.snapshot().runs.length,1);
  const run=h.ledger.getRun(first.value.value.runId),claim=h.ledger.claim('claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
  const result=await h.ctx.taskSystem.native.execute(claim);assert.equal(result.run.state,'succeeded');
  const next=h.ledger.createRun('again',{taskId:run.taskId,route:run.route}).value;
  h.adapter.script.push({name:'task_submit_result',args:{outcome:'success',summary:'Continued'}});
  const again=await h.ctx.taskSystem.native.execute(h.ledger.claim('claim-again',{runId:next.runId,nodeId:'local',ttlMs:10000}).value);
  assert.equal(again.run.state,'succeeded');assert.equal(again.sessionId,result.sessionId);assert.equal(calls,0);
 }finally{await h.dispose();}
});

test('authorized pool uses readiness then slots, stable ties, explicit node and explicit model without JEV',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});let calls=0;
 h.ctx.provide('decisionModels',{ask:async()=>{calls++;throw Error('Unexpected JEV call');}});
 try{
  for(const [nodeId,maxConcurrent,model]of [['a',1,'basic'],['b',3,'premium'],['c',3,'premium']]){
   registerExecutor(h.ledger,'node-'+nodeId,{nodeId,roles:['executor'],maxConcurrent,models:[{provider:'fixture',model,reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
   h.ledger.recordNodeHeartbeat('heartbeat-'+nodeId,{nodeId,observedAt:new Date().toISOString(),runtimeReady:nodeId!=='a',activeExecutions:0});
  }
  const planner=h.ctx.taskSystem.projects.planner;
  const first=await planner.plan({requestId:'pool',title:'Generic pool work',description:''});assert.equal(first.proposal.executor.id,'b');
  assert.deepEqual(await planner.plan({requestId:'pool',title:'Generic pool work',description:''}),first);
  const explicit=await planner.plan({requestId:'explicit',title:'Specific device',description:'',nodeId:'c'});assert.equal(explicit.proposal.executor.id,'c');
  const model=await planner.plan({requestId:'model',title:'Requested model',description:'',executionModel:{provider:'fixture',model:'premium'}});assert.equal(model.proposal.executor.id,'b');assert.equal(model.proposal.modelRoute.model,'premium');
  await assert.rejects(planner.plan({requestId:'bad-model',title:'Unsupported choice',description:'',nodeId:'a',executionModel:{provider:'fixture',model:'premium'}}),/not advertised|not available/);
  assert.equal(calls,0);
 }finally{await h.dispose();}
});

test('draft and project binding dispatch share the authorized pool without promoting policy workspace to Task constraint',async()=>{
 const h=await createNativeHarness({config:{role:'planner'}});let calls=0;
 h.ctx.provide('decisionModels',{ask:async()=>{calls++;throw Error('Unexpected JEV call');}});
 let handle;
 try{
  for(const nodeId of ['a','b']){
   h.ledger.registerWorkspace('workspace-'+nodeId,{workspaceId:'workspace-'+nodeId,nodeId,path:h.dir,label:nodeId,state:'ready',createdAt:new Date().toISOString()});
   registerExecutor(h.ledger,'node-'+nodeId,{nodeId,roles:['executor'],maxConcurrent:nodeId==='b'?3:1,models:[{provider:'fixture',model:'work',reasoningEfforts:[]}],capabilities:[],workspaceIds:['workspace-'+nodeId],enabled:true});
   h.ledger.recordNodeHeartbeat('online-'+nodeId,{nodeId,runtimeReady:true,activeExecutions:0});
  }
  const draft=h.ledger.createTask('draft',{title:'Generic draft'}).value;
  const chosen=h.ledger.dispatchExistingTask('draft-dispatch',{taskId:draft.taskId}).value;
  assert.equal(chosen.route.nodeId,'b');
  assert.equal(h.ledger.dispatchExistingTask('draft-dispatch',{taskId:draft.taskId}).value.runId,chosen.runId);
  handle=await h.ctx.agents.create({sessionId:'binding-pm',meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  const activated=await h.ctx.taskSystem.sessionCollaboration.activate(handle.agent,'Bound project');
  const projectId=activated.binding.projectId;
  h.ledger.projectExecutionSettings.save({projectId,expectedRevision:0,allowedNodeIds:['a','b'],executionBindings:{a:'workspace-a',b:'workspace-b'}});
  const result=await h.ctx.tools.execute({name:'task_dispatch',callId:'bound-dispatch',arguments:{commandId:'bound',title:'Project allocation',description:'Use the configured project workspace'},agent:handle.agent,signal:new AbortController().signal});
  assert.equal(result.isError,false,JSON.stringify(result));
  const task=h.ledger.snapshot().tasks.find(task=>task.title==='Project allocation');
  const run=h.ledger.history(task.taskId).runs[0];
  assert.equal(task.workspaceId,undefined,'project policy is not an explicit Task workspace');
  assert.equal(run.route.nodeId,'b');assert.equal(run.route.workspaceId,'workspace-b');assert.equal(calls,0);
 }finally{await handle?.dispose();await h.dispose();}
});
