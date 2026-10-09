import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskLedger } from "../dist/index.js";
import { TaskPlanner, taskDecisionCatalog } from "../dist/planning.js";
import {
  DecisionEngine,
  RulesProvider,
} from "../../typed-decisions/dist/core.js";
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
test("decisions persist before atomic task application and replay does not call backend or create twice", async () => {
  const ledger = TaskLedger.open(":memory:");
  let calls = 0;
  const p = provider();
  const original = p.evaluate;
  p.evaluate = async (r) => {
    calls++;
    return original(r);
  };
  const engine = new DecisionEngine([p], { defaultProvider: "fixture" });
  try {
    const planner = new TaskPlanner(
      ledger,
      engine,
      () => taskDecisionCatalog(ledger, { channel: "fixture" }),
      () => {},
    );
    const input = {
      requestId: "intent-1",
      title: "Persist this project",
      description: "A long task",
    };
    const record = await planner.plan(input);
    assert.equal(record.proposal.kind, "proposal");
    const applied = planner.apply("intent-1");
    assert.ok(applied.value.taskId);
    assert.equal(ledger.snapshot().tasks.length, 1);
    assert.deepEqual(planner.apply("intent-1"), applied);
    await planner.plan(input);
    assert.equal(calls, 1);
    assert.equal(ledger.snapshot().reports.length, 1);
    assert.equal(ledger.getDecision("intent-1").receipt.status, "answered");
  } finally {
    engine.close();
    ledger.close();
  }
});
test("changed catalog or denied authorization cannot silently apply a model proposal", async () => {
  const ledger = TaskLedger.open(":memory:");
  const engine = new DecisionEngine([provider()], {
    defaultProvider: "fixture",
  });
  try {
    const planner = new TaskPlanner(
      ledger,
      engine,
      () => taskDecisionCatalog(ledger, {}),
      () => {
        throw new Error("Operator policy denies");
      },
    );
    await planner.plan({
      requestId: "intent",
      title: "Task",
      description: "Do work",
    });
    assert.throws(() => planner.apply("intent"), /policy denies/);
    ledger.createTask("other", { title: "Catalog changed" });
    assert.throws(
      () => planner.apply("intent"),
      (e) => e.code === "STALE_DECISION",
    );
    assert.equal(ledger.snapshot().tasks.length, 1);
  } finally {
    engine.close();
    ledger.close();
  }
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

test('planner consumes its configured preset without changing explicit decision routing', async () => {
  const ledger=TaskLedger.open(':memory:');
  const engine=new DecisionEngine([provider()],{defaultProvider:'fixture',presets:[{id:'planner-work',name:'Planner work',provider:'fixture',model:'test'}]});
  const requests=[];
  const service={presetFor:consumer=>{assert.equal(consumer,'task-planning');return 'planner-work';},evaluate:async(request,options)=>{requests.push(request);return engine.evaluate(request,options);}};
  try {
    const planner=new TaskPlanner(ledger,service,()=>taskDecisionCatalog(ledger,{channel:'fixture'}),()=>{});
    assert.equal((await planner.plan({requestId:'preset-plan',title:'Plan',description:'Use saved preset'})).proposal.kind,'proposal');
    assert.equal(requests[0].preset,'planner-work');assert.equal(requests[0].provider,undefined);
    assert.equal((await planner.plan({requestId:'explicit-plan',title:'Explicit',description:'Pinned route',provider:'fixture'})).proposal.kind,'proposal');
    assert.equal(requests[1].preset,undefined);assert.equal(requests[1].provider,'fixture');
  } finally {await engine.close();ledger.close();}
});


test('heartbeat health changes during a decision preserve route evidence, while authority changes still reject it',async()=>{
 for(const mutateAuthority of [false,true]) {
  const ledger=TaskLedger.open(':memory:');const worker={nodeId:'worker',roles:['executor'],models:[{provider:'worker-model',model:'small',reasoningEfforts:['off']}],capabilities:[],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()};ledger.registerNode('worker',worker);
  const task=ledger.createTask('task',{title:'Calculate'}).value;
  const p=provider();p.evaluate=async({request})=>{
   assert.notEqual(ledger.nodeStatuses()[0].state,"online");
   ledger.recordNodeHeartbeat('heartbeat',{nodeId:'worker',runtimeReady:true,activeExecutions:0});
   if(mutateAuthority)ledger.registerNode('disable',{...worker,enabled:false});
   const route=request.context.catalog.modelRoutes[0];
   return {modelVersion:'1',answers:Object.fromEntries(request.questions.map(q=>[q.questionId,{type:'choice',choice:{persist:'attach',attach:task.taskId,executor:'worker',modelEffort:route.id,reporting:'summary'}[q.questionId]}]))};
  };
  const engine=new DecisionEngine([p],{defaultProvider:'fixture'});
  try {
   const planner=new TaskPlanner(ledger,engine,()=>taskDecisionCatalog(ledger,{role:'planner',nodeId:'planner'}),()=>{});
   const result=await planner.plan({requestId:'intent',taskId:task.taskId,title:'Calculate',description:'Compute 1+1'});
   if(mutateAuthority){assert.equal(result.proposal.kind,'abstain');assert.equal(result.proposal.reason,'stale-snapshot');assert.equal(ledger.snapshot().runs.length,0);}
   else {assert.equal(result.routingStatus,'ready',JSON.stringify(result.proposal));const applied=planner.apply('intent',{deferExecution:true});assert.equal(applied.value.taskId,task.taskId);assert.equal(ledger.getTask(task.taskId).state,'inbox');assert.equal(ledger.snapshot().tasks.length,1);}
  }finally{await engine.close();ledger.close();}
 }
});
