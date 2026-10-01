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
