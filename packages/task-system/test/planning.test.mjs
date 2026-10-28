import { test } from "node:test";
import assert from "node:assert/strict";
import { registerExecutor } from "../../../tests/dsh/executor-fixture.mjs";
import { TaskLedger } from "../dist/index.js";
import { TaskPlanner, taskDecisionCatalog } from "../dist/planning.js";
import {
  DecisionEngine,
} from "./legacy-model-fixture.mjs";
function provider() {
  return {
    id: "fixture",
    version: "1",
    capabilities: {
      questionTypes: ["choice"],
      maxChoices: 255,
      maxScoreLevels: 10,
      distributions: false,
      abstention: "native",
      models: [{ model: "test", version: "1", reasoningEfforts: [] }],
      evidence: { kind: "deterministic", calibration: "none" },
    },
    async evaluate({ request }) {
      return {
        modelVersion: "1",
        answers: Object.fromEntries(
          request.questions.map((q) => [
            q.questionId,
            {
              type: "choice",
              choice: {
                persist: "create",
                attach: "none",
                executor: "none",
                modelEffort: "none",
                workspace: "none",
                reporting: "summary",
              }[q.questionId],
            },
          ]),
        ),
      };
    },
  };
}
function workload(ledger) {
  registerExecutor(ledger, 'workload', {nodeId: 'worker', roles: ['executor'], enabled: true, models: [{provider: 'worker-model', model: 'small', reasoningEfforts: []}], capabilities: [], workspaceIds: [], maxConcurrent: 2});
}

test("formal planning persists before application and replay neither calls a decision backend nor creates twice", async () => {
  const ledger = TaskLedger.open(":memory:");
  try {
    workload(ledger);
    let calls = 0;
    const planner = new TaskPlanner(ledger, {ask: async () => {calls++; throw Error('Formal planning must not ask a model');}}, () => taskDecisionCatalog(ledger, {channel: 'fixture'}), () => {});
    const input = {requestId: 'intent-1', title: 'Persist this project', description: 'A long task'};
    const record = await planner.plan(input);
    assert.equal(record.proposal.kind, 'proposal');
    assert.equal(record.source, 'default');
    assert.equal(record.proposal.executor.id, 'worker');
    assert.equal(ledger.snapshot().tasks.length, 0);
    assert.equal(ledger.snapshot().runs.length, 0);
    assert.deepEqual(ledger.getDecision(input.requestId).receipt, {kind: 'deterministic-planning-v1', source: 'default', reason: 'authorized-executor-pool'});
    assert.deepEqual(await planner.plan(input), record);
    const applied = planner.apply(input.requestId);
    assert.ok(applied.value.taskId);
    assert.equal(ledger.getRun(applied.value.runId).route.nodeId, 'worker');
    assert.equal(ledger.snapshot().tasks.length, 1);
    assert.equal(ledger.snapshot().runs.length, 1);
    assert.deepEqual(planner.apply(input.requestId), applied);
    assert.deepEqual(await planner.plan(input), record);
    await assert.rejects(planner.plan({...input, description: 'Changed intent'}), {code: 'CONFLICT'});
    assert.equal(calls, 0);
  } finally {ledger.close();}
});

test("changed catalog, expiry, or denied authorization cannot silently apply a deterministic proposal", async () => {
  let now = Date.now();
  const ledger = TaskLedger.open(":memory:", {now: () => now});
  try {
    workload(ledger);
    const planner = new TaskPlanner(ledger, undefined, () => taskDecisionCatalog(ledger, {}, 30000, now), () => {throw Error('Operator policy denies');}, () => now);
    await planner.plan({requestId: 'intent', title: 'Task', description: 'Do work'});
    assert.throws(() => planner.apply('intent'), /policy denies/);
    assert.equal(ledger.snapshot().tasks.length, 0);
    ledger.createTask('other', {title: 'Catalog changed'});
    assert.throws(() => planner.apply('intent'), {code: 'STALE_DECISION'});
    const expiry = new TaskPlanner(ledger, undefined, () => taskDecisionCatalog(ledger, {}, 30000, now), () => {}, () => now);
    await expiry.plan({requestId: 'expires', title: 'Expires', description: ''});
    now += 30001;
    assert.throws(() => expiry.apply('expires'), {code: 'STALE_DECISION'});
    assert.equal(ledger.snapshot().tasks.length, 1);
    assert.equal(ledger.snapshot().runs.length, 0);
  } finally {ledger.close();}
});
test("typed admission of observed work offers no executor candidates and never dispatches", async () => {
  const ledger = TaskLedger.open(":memory:");
  const engine = new DecisionEngine([provider()], {
    defaultProvider: "fixture",
  });
  try {
    const candidate = ledger.captureObservation("capture", {
      seq: 1,
      sessionId: "old-session",
      sourceId: "dsh-session:old-session",
      sourceRevision: "1",
      title: "Already done",
      body: "Existing evidence",
      observedAt: new Date().toISOString(),
      truncated: false,
    }).value;
    const planner = new TaskPlanner(
      ledger,
      engine,
      () => taskDecisionCatalog(ledger, {}),
      () => {},
    );
    const result = await planner.planObservation(candidate.candidateId);
    assert.equal(result.proposal.kind, "proposal");
    const admitted = planner.apply(result.decisionId);
    assert.equal(ledger.getTask(admitted.value.taskId).kind, "observed");
    assert.equal(ledger.snapshot().runs.length, 0);
    assert.equal(ledger.observationCandidates("pending").length, 0);
    assert.deepEqual(planner.apply(result.decisionId), admitted);
  } finally {
    await engine.close();
    ledger.close();
  }
});

test('observation filtering consumes its configured preset and preserves explicit decision routing', async () => {
  const ledger=TaskLedger.open(':memory:');
  const engine=new DecisionEngine([provider()],{defaultProvider:'fixture',presets:[{id:'planner-work',name:'Planner work',provider:'fixture',model:'test'}]});
  const requests=[];
  const service={ask:async(request,options)=>{requests.push(request);return engine.ask(request,options);}};
  try {
    const planner=new TaskPlanner(ledger,service,()=>taskDecisionCatalog(ledger,{channel:'fixture'}),()=>{},Date.now,()=>true,()=> 'planner-work');
    const capture=id=>ledger.captureObservation(id,{seq:id==='preset-plan'?1:2,sessionId:id,sourceId:'dsh-session:'+id,sourceRevision:'1',title:'Observed work',body:'Existing evidence',observedAt:new Date().toISOString(),truncated:false}).value;
    assert.equal((await planner.planObservation(capture('preset-plan').candidateId)).proposal.kind,'proposal');
    assert.equal(requests[0].provider,'planner-work');assert.equal(requests[0].model,undefined);
    assert.equal((await planner.planObservation(capture('explicit-plan').candidateId,{provider:'fixture'})).proposal.kind,'proposal');
    assert.equal(requests[1].preset,undefined);assert.equal(requests[1].provider,'fixture');
  } finally {await engine.close();ledger.close();}
});


test('heartbeat and slot changes preserve a planned route while authority changes invalidate its application',async()=>{
 for(const mutateAuthority of [false,true]) for(const deferExecution of [false,true]) {
  const ledger=TaskLedger.open(':memory:');
  try {
   workload(ledger);
   registerExecutor(ledger,'alternate',{nodeId:'alternate',roles:['executor'],enabled:true,models:[{provider:'worker-model',model:'small',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],maxConcurrent:2});
   ledger.recordNodeHeartbeat('worker-online',{nodeId:'worker',runtimeReady:true,activeExecutions:0});
   ledger.recordNodeHeartbeat('alternate-busy',{nodeId:'alternate',runtimeReady:true,activeExecutions:2});
   const task=ledger.createTask('task',{title:'Calculate'}).value;
   const planner=new TaskPlanner(ledger,{ask:async()=>{throw Error('Authorized work must not ask a model');}},()=>taskDecisionCatalog(ledger,{role:'planner',nodeId:'planner'}),()=>{});
   const result=await planner.plan({requestId:'intent',taskId:task.taskId,title:'Calculate',description:'Compute 1+1'});
   assert.equal(result.proposal.executor.id,'worker');
   ledger.recordNodeHeartbeat('worker-busy',{nodeId:'worker',runtimeReady:true,activeExecutions:2});
   ledger.recordNodeHeartbeat('alternate-free',{nodeId:'alternate',runtimeReady:true,activeExecutions:0});
   assert.equal(ledger.dispatchRoutes({taskId:task.taskId})[0].nodeId,'alternate');
   if(mutateAuthority) {
    ledger.registerNode('disable',{...ledger.getNode('worker'),enabled:false});
    assert.throws(()=>planner.apply('intent',{deferExecution}),{code:'STALE_DECISION'});
    assert.equal(ledger.snapshot().runs.length,0);
   } else {
    const applied=planner.apply('intent',{deferExecution});
    assert.equal(applied.value.taskId,task.taskId);
    assert.equal(ledger.snapshot().tasks.length,1);
    if(deferExecution){assert.equal(ledger.getTask(task.taskId).state,'inbox');assert.equal(ledger.snapshot().runs.length,0);}
    else {assert.equal(ledger.snapshot().runs.length,1);assert.equal(ledger.getRun(applied.value.runId).route.nodeId,'worker');}
   }
  }finally{ledger.close();}
 }
});

test('expected execution estimate is immutable proposal intent and reaches exactly one applied Run', async () => {
  const ledger = TaskLedger.open(':memory:');
  try {
    registerExecutor(ledger, 'expected-worker', {
      nodeId: 'worker', roles: ['executor'], enabled: true,
      models: [{ provider: 'fixture', model: 'fixture', reasoningEfforts: [] }],
      capabilities: [], workspaceIds: [],
    });
    const route = { nodeId: 'worker', provider: 'fixture', model: 'fixture', requiredCapabilities: [] };
    const planner = new TaskPlanner(ledger, undefined, () => taskDecisionCatalog(ledger, {}), () => {});
    const input = { requestId: 'expected-plan', title: 'Bounded work', description: 'Keep the caller estimate', route, expectedExecutionMs: 45000 };
    const proposal = await planner.plan(input);
    assert.equal(proposal.input.expectedExecutionMs, 45000);
    assert.equal(ledger.getDecision(input.requestId).input.expectedExecutionMs, 45000);
    assert.deepEqual(await planner.plan(input), proposal);
    for (const expectedExecutionMs of [undefined, 46000]) {
      await assert.rejects(planner.plan({ ...input, expectedExecutionMs }), { code: 'CONFLICT' });
      assert.throws(() => ledger.applyDecision(`override-${expectedExecutionMs}`, {
        decisionId: input.requestId, currentStateHash: proposal.stateHash,
        title: input.title, description: input.description, persistence: 'create',
        route, reporting: 'none', ...(expectedExecutionMs !== undefined ? { expectedExecutionMs } : {}),
      }), { code: 'CONFLICT' });
    }
    assert.equal(ledger.snapshot().tasks.length, 0);
    assert.equal(ledger.snapshot().runs.length, 0);
    const applied = planner.apply(input.requestId);
    assert.deepEqual(ledger.getRun(applied.value.runId).executionExpectation, { phase: 'pending_start', expectedExecutionMs: 45000 });
    assert.deepEqual(planner.apply(input.requestId), applied);
    assert.equal(ledger.snapshot().runs.length, 1);

    const withoutEstimate = await planner.plan({ requestId: 'legacy-plan', title: 'Unbounded work', description: 'No caller estimate', route });
    assert.equal(withoutEstimate.input.expectedExecutionMs, undefined);
    const legacy = planner.apply('legacy-plan');
    assert.equal(ledger.getRun(legacy.value.runId).executionExpectation, undefined);
  } finally {
    ledger.close();
  }
});

test('planning rejects invalid expected execution estimates before persisting a proposal', async () => {
  const ledger = TaskLedger.open(':memory:');
  try {
    const planner = new TaskPlanner(ledger, undefined, () => taskDecisionCatalog(ledger, {}), () => {});
    for (const [index, expectedExecutionMs] of [0, -1, 1.5, '1000', null, 30 * 86400000 + 1].entries()) {
      const requestId = `invalid-estimate-${index}`;
      await assert.rejects(planner.plan({ requestId, title: 'Invalid estimate', description: '', expectedExecutionMs }));
      assert.equal(ledger.getDecision(requestId), undefined);
    }
    assert.equal(ledger.snapshot().tasks.length, 0);
    assert.equal(ledger.snapshot().runs.length, 0);
  } finally {
    ledger.close();
  }
});
