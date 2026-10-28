import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskLedger} from '../dist/ledger.js';
import {TaskPlanner,taskDecisionCatalog} from '../dist/planning.js';

const fallback={provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'};
const preferred={provider:'workload-provider',model:'preferred',reasoningEffort:'high'};
const explicit={provider:'workload-provider',model:'explicit',reasoningEffort:'low'};
const code=value=>error=>error.code===value;
function fixture(){
  let now=Date.parse('2026-10-19T00:00:00Z'),sequence=0;
  const l=TaskLedger.open(':memory:',{nodeId:'scheduler',now:()=>now});
  l.registerNode('worker',{nodeId:'worker',enabled:true,roles:['executor'],models:[],capabilities:[],workspaceIds:[],maxConcurrent:1,lastSeenAt:new Date(now).toISOString()});
  const publish=(models,result={})=>{
    const request=l.executionModels.request(`catalog-${++sequence}`,{nodeId:'worker'}).catalog.request;
    return l.completeExecutionModels(`publish-${sequence}`,{nodeId:'worker',requestId:request.requestId,generation:request.generation,result:{state:'success',observedAt:now,complete:true,models,...result}}).value;
  };
  const setDefault=choice=>{const view=l.executionModels.view('worker');return l.executionModels.setDefault(`default-${++sequence}`,{nodeId:'worker',expectedRevision:view.policy.revision,expectedCatalogRevision:view.catalog.snapshot.revision,choice});};
  const run=(choice,taskInput={})=>{const task=l.createTask(`task-${++sequence}`,{title:'Verify dispatch admission',...taskInput}).value;const selected=l.selectExecutionModel('worker',choice);return l.createRun(`run-${sequence}`,{taskId:task.taskId,route:{nodeId:'worker',...selected.choice,requiredCapabilities:[]},executionModel:selected.executionModel}).value;};
  return {l,publish,setDefault,run,now:()=>now,advance:milliseconds=>{now+=milliseconds;},close:()=>l.close()};
}
function planner(f,calls){
  const decisions={ask:async input=>{calls.push(input);throw Error('Formal dispatch must not ask a model');}};
  return new TaskPlanner(f.l,decisions,()=>taskDecisionCatalog(f.l,{nodeId:'scheduler'},30000,f.now()),()=>{},f.now);
}
function legacyWithoutContext(l,run){
  const raw={...l.getRun(run.runId)};delete raw.projectContext;
  l.managementDatabase().prepare("UPDATE entities SET data=? WHERE kind='run' AND id=?").run(JSON.stringify(raw),run.runId);
}

test('formal dispatch ignores decision-call overrides and uses the node default or explicit workload tuple',async()=>{
  for(const choice of [undefined,explicit]){
    const f=fixture();try{
      f.publish([preferred,explicit,fallback]);f.setDefault(preferred);
      const calls=[],p=planner(f,calls),input={requestId:'source-request',title:'Execute authorized work',description:'The user requested work.',provider:'decision-provider',model:'decision-model',reasoningEffort:'ultra',...(choice?{executionModel:choice}:{})};
      await p.plan(input);const applied=p.apply(input.requestId);const run=f.l.getRun(applied.value.runId);
      assert.equal(calls.length,0);
      assert.equal(run.route.provider,(choice ?? preferred).provider);assert.equal(run.route.model,(choice ?? preferred).model);assert.equal(run.route.reasoningEffort,(choice ?? preferred).reasoningEffort);
      assert.equal(run.executionModel.origin,choice?'explicit':'node_default');
      assert.deepEqual(run.projectContext,{version:1,schedulerId:f.l.schedulerIdentity(),project:null});
      assert.deepEqual(p.apply(input.requestId),applied);assert.equal(f.l.snapshot().runs.length,1);assert.equal(f.l.snapshot().attempts.length,0);
    }finally{f.close();}
  }
});

test('default fallback requires a fresh complete successful catalog and never changes explicit selection',()=>{
  const f=fixture();try{
    f.publish([preferred,explicit,fallback]);f.setDefault(preferred);
    const normal=f.run(),fixed=f.run(explicit);
    f.advance(60001);f.l.refreshDispatchEligibility(normal.runId);
    assert.equal(f.l.getRun(normal.runId).route.model,'preferred');assert.equal(f.l.getRun(normal.runId).dispatchIssue.kind,'waiting');
    f.publish([fallback]);
    const ready=f.l.refreshDispatchEligibility(normal.runId),unavailable=f.l.refreshDispatchEligibility(fixed.runId);
    assert.equal(ready.route.model,'deepseek-flash');assert.equal(ready.executionModel.origin,'fallback');assert.equal(ready.dispatchIssue,undefined);
    assert.equal(unavailable.route.model,'explicit');assert.equal(unavailable.executionModel.origin,'explicit');assert.equal(unavailable.dispatchIssue.kind,'needs_action');assert.equal(unavailable.dispatchIssue.code,'EXPLICIT_EXECUTION_MODEL_UNAVAILABLE');
    assert.equal(f.l.snapshot().attempts.length,0);
  }finally{f.close();}
});

test('partial or failed catalog does not erase saved node default or retarget its queued Run',()=>{
  const f=fixture();try{
    f.publish([preferred,fallback]);f.setDefault(preferred);const run=f.run();
    f.publish([fallback],{complete:false});
    let view=f.l.executionModels.view('worker');assert.equal(view.policy.choice.model,'preferred');assert.notEqual(view.catalog.state,'fresh');
    let queued=f.l.refreshDispatchEligibility(run.runId);assert.equal(queued.route.model,'preferred');assert.equal(queued.dispatchIssue.kind,'waiting');
    const request=f.l.executionModels.pending('worker')[0];
    f.l.completeExecutionModels('failed-probe',{nodeId:'worker',requestId:request.requestId,generation:request.generation,result:{state:'failure',code:'TIMEOUT'}});
    view=f.l.executionModels.view('worker');assert.equal(view.policy.choice.model,'preferred');
    queued=f.l.getRun(run.runId);assert.equal(queued.route.model,'preferred');assert.equal(f.l.snapshot().attempts.length,0);
  }finally{f.close();}
});

test('direct claim uses the fresh fallback route rather than its pre-refresh Run copy',()=>{
  const f=fixture();try{
    f.publish([preferred,fallback]);f.setDefault(preferred);const run=f.run();
    f.advance(60001);f.publish([fallback]);
    const claim=f.l.claim('direct-claim',{runId:run.runId,nodeId:'worker',ttlMs:30000}).value;
    assert.equal(claim.run.runId,run.runId);assert.equal(claim.run.route.model,'deepseek-flash');assert.equal(claim.run.executionModel.origin,'fallback');
    assert.equal(f.l.snapshot().attempts.length,1);
  }finally{f.close();}
});

test('legacy context repair is visible in query/history/wait and preserves the Run and zero attempts',()=>{
  const f=fixture();try{
    f.publish([preferred]);const parent=f.l.createTask('waiting-parent',{title:'Parent waiting for child'}).value;
    const run=f.run(preferred,{parentTaskId:parent.taskId});legacyWithoutContext(f.l,run);
    const before=f.l.taskActionState(run.taskId);assert.equal(before.active,true);assert.equal(before.canRepair,true);assert.equal(before.canRetry,false);
    const waiting=f.l.allSettled(parent.taskId,0);assert.equal(waiting.settled,false);assert.deepEqual(waiting.pendingRunIds,[run.runId]);assert.equal(waiting.needsAction[0].issue.code,'TEMPORARY_CONTEXT_REQUIRED');
    const own=f.l.allSettled(run.taskId,0,undefined,true);assert.equal(own.settled,false);assert.deepEqual(own.pendingRunIds,[run.runId]);assert.equal(own.needsAction[0].runId,run.runId);
    assert.equal(f.l.querySnapshot().runs.find(row=>row.runId===run.runId).dispatchIssue.code,'TEMPORARY_CONTEXT_REQUIRED');
    const input={taskId:run.taskId,runId:run.runId,expectedActionVersion:before.version};
    const repaired=f.l.repairDispatch('repair-context',input).value;
    assert.equal(repaired.runId,run.runId);assert.equal(repaired.projectContext.project,null);assert.equal(repaired.projectContext.schedulerId,f.l.schedulerIdentity());assert.equal(repaired.dispatchIssue,undefined);
    assert.deepEqual(f.l.repairDispatch('repair-context',input).value,repaired);
    assert.throws(()=>f.l.repairDispatch('stale-repair',input),code('CONFLICT'));
    const history=f.l.history(run.taskId);assert.equal(history.runs.length,1);assert.equal(history.reports.length,0);assert.equal(f.l.snapshot().attempts.length,0);
    assert.equal(f.l.taskActionState(run.taskId).canRepair,false);assert.equal(f.l.allSettled(parent.taskId,0).settled,false);
  }finally{f.close();}
});

test('explicit model repair reuses the same Run and node with a version fence before its first Attempt',()=>{
  const f=fixture();try{
    f.publish([preferred,fallback]);const run=f.run(explicit);
    const input={taskId:run.taskId,runId:run.runId,expectedActionVersion:f.l.taskActionState(run.taskId).version,executionModel:preferred};
    const repaired=f.l.repairDispatch('repair-explicit-model',input).value;
    assert.equal(repaired.runId,run.runId);assert.equal(repaired.route.nodeId,'worker');assert.equal(repaired.route.model,'preferred');assert.equal(repaired.executionModel.origin,'explicit');assert.equal(repaired.dispatchIssue,undefined);
    assert.deepEqual(f.l.repairDispatch('repair-explicit-model',input).value,repaired);assert.equal(f.l.snapshot().runs.length,1);assert.equal(f.l.snapshot().attempts.length,0);
    f.l.claim('claim-repaired-model',{runId:run.runId,nodeId:'worker',ttlMs:30000});
    assert.equal(f.l.snapshot().attempts.length,1);
    assert.throws(()=>f.l.repairDispatch('repair-after-claim',{...input,expectedActionVersion:f.l.taskActionState(run.taskId).version}),code('CONFLICT'));
  }finally{f.close();}
});

test('a ready-to-ready model repair invalidates the previous action version',()=>{
  const f=fixture();try{
    f.publish([preferred,explicit]);const run=f.run(preferred);
    assert.equal(f.l.getRun(run.runId).dispatchIssue,undefined);
    const before=f.l.taskActionState(run.taskId).version;
    const input={taskId:run.taskId,runId:run.runId,expectedActionVersion:before,executionModel:explicit};
    f.l.repairDispatch('ready-to-ready',input);
    assert.equal(f.l.getRun(run.runId).dispatchIssue,undefined);
    assert.notEqual(f.l.taskActionState(run.taskId).version,before);
    assert.throws(()=>f.l.repairDispatch('stale-ready-overwrite',{...input,executionModel:preferred}),code('CONFLICT'));
    assert.equal(f.l.getRun(run.runId).route.model,'explicit');assert.equal(f.l.snapshot().runs.length,1);assert.equal(f.l.snapshot().attempts.length,0);
  }finally{f.close();}
});

test('cancel or an accepted claim wins over stale same-Run repair without duplicate attempts',()=>{
  for(const winner of ['cancel','claim']){
    const f=fixture();try{
      f.publish([preferred]);const run=f.run(preferred);const expectedActionVersion=f.l.taskActionState(run.taskId).version;
      if(winner==='cancel')f.l.cancel('cancel-first',{taskId:run.taskId,runId:run.runId,reason:'User cancelled'});
      else f.l.claim('claim-first',{runId:run.runId,nodeId:'worker',ttlMs:30000});
      assert.throws(()=>f.l.repairDispatch('late-repair',{taskId:run.taskId,runId:run.runId,expectedActionVersion}),code('CONFLICT'));
      assert.equal(f.l.snapshot().runs.length,1);assert.equal(f.l.snapshot().attempts.length,winner==='claim'?1:0);
    }finally{f.close();}
  }
});

test('capacity remains waiting execution with no fictional blocked outcome or repair action',()=>{
  const f=fixture();try{
    f.publish([preferred]);const first=f.run(preferred),second=f.run(preferred);
    f.l.claim('capacity-holder',{runId:first.runId,nodeId:'worker',ttlMs:30000});
    assert.throws(()=>f.l.claim('capacity-waiter',{runId:second.runId,nodeId:'worker',ttlMs:30000}),code('BUSY'));
    assert.equal(f.l.getRun(second.runId).state,'queued');assert.equal(f.l.taskActionState(second.taskId).canRepair,false);assert.equal(f.l.taskActionState(second.taskId).canRetry,false);
    assert.equal(f.l.allSettled(second.taskId,0).needsAction.length,0);assert.equal(f.l.snapshot().attempts.length,1);
  }finally{f.close();}
});

test('final paginated catalog preserves every page in claim validation',()=>{
  const f=fixture();try{
    const request=f.l.executionModels.request('paged',{nodeId:'worker'}).catalog.request;
    for(const [index,choice] of [preferred,fallback].entries())f.l.completeExecutionModels(`page-${index}`,{nodeId:'worker',requestId:request.requestId,generation:request.generation,page:{index,total:2},result:{state:'success',complete:true,observedAt:f.now(),models:[choice]}});
    assert.equal(f.l.executionModels.view('worker').catalog.snapshot.models.length,2);
    for(const [index,choice] of [preferred,fallback].entries()){
      const run=f.run(choice);if(index===0)f.l.registerNode('more-capacity',{...f.l.getNode('worker'),maxConcurrent:2});
      assert.equal(f.l.claim(`claim-page-${index}`,{runId:run.runId,nodeId:'worker',ttlMs:30000}).value.run.route.model,choice.model);
    }
  }finally{f.close();}
});
