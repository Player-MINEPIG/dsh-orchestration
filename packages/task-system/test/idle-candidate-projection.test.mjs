import test from "node:test";
import assert from "node:assert/strict";
import { createNativeHarness } from "../../../tests/dsh/native-harness.mjs";

const node = {
  nodeId: "worker",
  roles: ["executor"],
  models: [{ provider: "fixture", model: "small", reasoningEfforts: [] }],
  workspaceIds: [],
  enabled: true,
  capabilities: [],
};
const route = {
  nodeId: "worker",
  provider: "fixture",
  model: "small",
  requiredCapabilities: [],
};
function rejected(ledger, id, { maxRetries = 2 } = {}) {
  const task = ledger.createTask("task-" + id, {
    title: id,
    policy: { maxResultRetries: maxRetries, settlementQuietMs: 0 },
  }).value;
  const run = ledger.createRun("run-" + id, {
    taskId: task.taskId,
    route,
  }).value;
  const attempt = ledger.claim("claim-" + id, {
    runId: run.runId,
    nodeId: "worker",
    ttlMs: 60000,
  }).value.attempt;
  const lease = {
    runId: run.runId,
    attemptId: attempt.attemptId,
    nodeId: "worker",
    fence: attempt.fence,
    executionId: "execution-" + id,
  };
  ledger.markRunning("running-" + id, lease);
  ledger.bindSession("bind-" + id, { ...lease, sessionId: "session-" + id });
  ledger.submit("reject-" + id, {
    ...lease,
    outcome: "failure",
    summary: "Rejected fixture",
    resultValidationFailure: {
      kind: "native-result-validation-failure-v1",
      code: "SCHEMA_VALIDATION",
      issues: ["Required structured field absent"],
      sessionId: "session-" + id,
      quiescent: true,
      sessionPersisted: true,
    },
  });
  return { task, run };
}

test("retry scan selects only the latest failed validation Run and leaves large completed reports unread", async () => {
  const h = await createNativeHarness({ config: { role: "planner" } });
  try {
    const l = h.ledger;
    l.registerNode("worker", node);
    const old = rejected(l, "old");
    l.createRun("newer-run", { taskId: old.task.taskId, route });
    const current = rejected(l, "current");
    const ordinary = l.createTask("ordinary", {
      title: "Ordinary failure",
    }).value;
    const run = l.createRun("ordinary-run", {
      taskId: ordinary.taskId,
      route,
    }).value;
    const attempt = l.claim("ordinary-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value.attempt;
    l.submit("ordinary-failure", {
      runId: run.runId,
      attemptId: attempt.attemptId,
      nodeId: "worker",
      fence: attempt.fence,
      outcome: "failure",
      summary: "No validation attestation",
    });
    l.appendReport("large-note", {
      taskId: old.task.taskId,
      runId: old.run.runId,
      title: "Historical evidence",
      body: "x".repeat(128000),
    });
    const project = l.projectEntity.bind(l),
      seen = [];
    l.projectEntity = (kind, value) => {
      if (kind === "run") seen.push(value.runId);
      assert.notEqual(
        kind,
        "report",
        "retry candidates must not load historical report bodies",
      );
      return project(kind, value);
    };
    const candidates = l.resultRetryCandidates();
    assert.deepEqual(
      candidates.map((row) => row.runId),
      [current.run.runId],
    );
    assert.deepEqual(seen, [current.run.runId]);
  } finally {
    await h.dispose();
  }
});

test("idle project maintenance skips action fingerprints for exhausted retries and never reads a full snapshot", async () => {
  const h = await createNativeHarness({ config: { role: "planner" } });
  try {
    const l = h.ledger,
      runtime = h.ctx.taskSystem.projects;
    l.registerNode("worker", node);
    const failed = rejected(l, "exhausted", { maxRetries: 0 });
    l.appendReport("large-history", {
      taskId: failed.task.taskId,
      runId: failed.run.runId,
      title: "Completed evidence",
      body: "x".repeat(128000),
    });
    runtime.planner = {};
    l.snapshot = () => {
      throw Error("idle maintenance read full history snapshot");
    };
    l.taskActionState = () => {
      throw Error("ineligible retry computed a report fingerprint");
    };
    const retry = runtime.retryTask;
    let retries = 0;
    runtime.retryTask = async () => {
      retries++;
    };
    runtime.tick();
    runtime.tick();
    assert.equal(retries, 0);
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(l.getRun(failed.run.runId).state, "failed");
    runtime.retryTask = retry;
  } finally {
    await h.dispose();
  }
});

test("pending discovery hydrates only this executor queued Runs and preserves cancellation and confirmation filters", async () => {
  const h = await createNativeHarness({ config: { role: "planner" } });
  try {
    const l = h.ledger;
    l.registerNode("worker", node);
    l.registerNode("other", { ...node, nodeId: "other" });
    const old = rejected(l, "completed-history");
    l.appendReport("large-completed", {
      taskId: old.task.taskId,
      runId: old.run.runId,
      title: "Large history",
      body: "x".repeat(128000),
    });
    const ready = l.createTask("ready", { title: "Ready" }).value,
      queued = l.createRun("queued", { taskId: ready.taskId, route }).value;
    const foreign = l.createTask("foreign", { title: "Other node" }).value;
    l.createRun("foreign-run", {
      taskId: foreign.taskId,
      route: { ...route, nodeId: "other" },
    });
    const confirm = l.createTask("confirm", {
      title: "Needs confirmation",
      requiresConfirmation: true,
    }).value;
    const waiting = l.createRun("confirm-run", {
      taskId: confirm.taskId,
      route,
    }).value;
    const project = l.projectEntity.bind(l),
      seen = [];
    l.projectEntity = (kind, value) => {
      if (kind === "run") seen.push(value.runId);
      assert.notEqual(kind, "report");
      return project(kind, value);
    };
    assert.deepEqual(
      l.pendingRuns("worker").map((run) => run.runId),
      [queued.runId],
    );
    assert.deepEqual(seen, [queued.runId, waiting.runId]);
    l.projectEntity = project;
    l.cancel("cancel-ready", {
      taskId: ready.taskId,
      runId: queued.runId,
      reason: "User cancellation",
    });
    assert.equal(l.pendingRuns("worker").length, 0);
  } finally {
    await h.dispose();
  }
});
