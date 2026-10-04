import test from "node:test";
import assert from "node:assert/strict";
import { TaskLedger } from "../dist/index.js";
const code = (value) => (error) => error.code === value;
function fixture(options = {}) {
  let time = Date.parse("2026-10-01T00:00:00Z");
  const ledger = TaskLedger.open(":memory:", {
    nodeId: "planner",
    now: () => time,
    ...options,
  });
  ledger.registerNode("node", {
    nodeId: "worker",
    roles: ["executor"],
    capabilities: [],
    models: [{ provider: "fixture", model: "fixture", reasoningEfforts: [] }],
    workspaceIds: [],
    enabled: true,
    maxConcurrent: 1,
    lastSeenAt: new Date(time).toISOString(),
  });
  return {
    ledger,
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
    close: () => ledger.close(),
  };
}
const route = {
  nodeId: "worker",
  provider: "fixture",
  model: "fixture",
  requiredCapabilities: [],
};
function active(f, policy = {}) {
  const task = f.ledger.createTask("task", {
    title: "Retry fixture",
    policy,
  }).value;
  const run = f.ledger.createRun("run", { taskId: task.taskId, route }).value;
  const claim = f.ledger.claim("claim", {
    runId: run.runId,
    nodeId: "worker",
    ttlMs: 60000,
  }).value;
  const ref = {
    runId: run.runId,
    attemptId: claim.attempt.attemptId,
    nodeId: "worker",
    fence: claim.attempt.fence,
    executionId: "first-instance",
  };
  f.ledger.markRunning("running", ref);
  f.ledger.bindSession("bind", { ...ref, sessionId: "session-one" });
  return { task, run, ref };
}
const witness = {
  kind: "dsh-owned-zero-tools-v1",
  sessionId: "session-one",
  fromSeq: 1,
  toSeq: 8,
  terminalSeq: 7,
  turn: 1,
  code: "TRANSPORT",
  toolCallCount: 0,
  toolDispatchCount: 0,
  complete: true,
  quiescent: true,
  persisted: true,
  disposed: true,
};

test("alert dedupe, acknowledgment, recovery and reopen are durable distinct cycles", () => {
  const f = fixture({ alertDestinations: ["feishu:chat:fixture"] });
  try {
    const input = {
      dedupeKey: "health-worker",
      nodeId: "worker",
      severity: "warning",
      title: "Worker unavailable",
      body: "No fresh ready observation",
    };
    const first = f.ledger.raiseAlert("raise", input).value;
    assert.equal(f.ledger.snapshot().tasks.length, 0);
    f.ledger.raiseAlert("raise-again", input);
    assert.equal(f.ledger.getAlert(first.alertId).occurrences, 2);
    assert.equal(f.ledger.getAlert(first.alertId).revision, 1);
    assert.equal(f.ledger.deliveries().length, 1);
    f.ledger.setAlertState("ack", {
      alertId: first.alertId,
      expectedRevision: 1,
      state: "acknowledged",
      actor: "operator",
      reason: "Investigating",
    });
    assert.throws(
      () =>
        f.ledger.setAlertState("stale", {
          alertId: first.alertId,
          expectedRevision: 1,
          state: "resolved",
          actor: "operator",
          reason: "Old card",
        }),
      code("CONFLICT"),
    );
    f.ledger.setAlertState("recover", {
      alertId: first.alertId,
      expectedRevision: 2,
      state: "resolved",
      actor: "host-monitor",
      reason: "Fresh healthy evidence",
    });
    assert.equal(f.ledger.alerts().length, 0);
    assert.equal(f.ledger.alerts({ includeResolved: true }).length, 1);
    const reopened = f.ledger.raiseAlert("new-outage", input).value;
    assert.equal(reopened.alertId, first.alertId);
    assert.equal(reopened.cycle, 2);
    assert.equal(reopened.status, "open");
    assert.equal(reopened.acknowledgedAt, undefined);
    assert.equal(
      f.ledger.deliveries().filter((d) => d.state === "pending").length,
      1,
    );
  } finally {
    f.close();
  }
});

test("bulk alert controls roll back entirely on stale revisions and never rewrite unknown delivery", () => {
  const f = fixture({ alertDestinations: ["feishu:chat:fixture"] });
  try {
    const a = f.ledger.raiseAlert("a", {
      dedupeKey: "a",
      severity: "warning",
      title: "A",
      body: "A issue",
    }).value;
    const b = f.ledger.raiseAlert("b", {
      dedupeKey: "b",
      severity: "critical",
      title: "B",
      body: "B issue",
    }).value;
    const delivery = f.ledger.deliveries().find((d) => d.alertId === a.alertId);
    const sending = f.ledger.claimDelivery("send", {
      deliveryId: delivery.deliveryId,
      ttlMs: 1000,
    }).value;
    f.ledger.finishDelivery("unknown", {
      deliveryId: delivery.deliveryId,
      claimToken: sending.claimToken,
      status: "uncertain",
    });
    assert.throws(
      () =>
        f.ledger.setAlertsState("bulk", {
          changes: [
            { alertId: a.alertId, state: "resolved", expectedRevision: 1 },
            { alertId: b.alertId, state: "resolved", expectedRevision: 9 },
          ],
          actor: "operator",
          reason: "Batch",
        }),
      code("CONFLICT"),
    );
    assert.equal(f.ledger.getAlert(a.alertId).status, "open");
    f.ledger.setAlertsState("valid-bulk", {
      changes: [
        { alertId: a.alertId, state: "resolved", expectedRevision: 1 },
        { alertId: b.alertId, state: "resolved", expectedRevision: 1 },
      ],
      actor: "operator",
      reason: "Batch reviewed",
    });
    assert.equal(f.ledger.getAlert(a.alertId).status, "resolved");
    assert.equal(
      f.ledger.deliveries().find((d) => d.deliveryId === delivery.deliveryId)
        .state,
      "uncertain",
    );
  } finally {
    f.close();
  }
});

test("heartbeats are observations, never grants; stale and recovery have alert evidence", () => {
  const f = fixture({ heartbeatTtlMs: 5000, requireFreshHeartbeat: true });
  try {
    const registered = f.ledger.getNode("worker");
    assert.equal(f.ledger.nodeStatuses()[0].state, "unknown");
    assert.throws(
      () => f.ledger.validateRoute(route),
      code("NODE_UNAVAILABLE"),
    );
    f.ledger.recordNodeHeartbeat("online", {
      nodeId: "worker",
      runtimeReady: true,
      activeExecutions: 0,
      sampledAt: f.now(),
      providerStatus: { state: "not-probed" },
    });
    assert.equal(f.ledger.nodeStatuses()[0].state, "online");
    f.ledger.validateRoute(route);
    assert.deepEqual(f.ledger.getNode("worker"), registered);
    f.advance(5001);
    assert.equal(f.ledger.nodeStatuses()[0].state, "stale");
    const [alert] = f.ledger.reconcileNodeHealth("health-outage");
    assert.equal(alert.status, "open");
    assert.throws(
      () => f.ledger.validateRoute(route),
      code("NODE_UNAVAILABLE"),
    );
    f.ledger.recordNodeHeartbeat("recovered", {
      nodeId: "worker",
      runtimeReady: true,
      activeExecutions: 0,
      sampledAt: f.now(),
    });
    f.ledger.reconcileNodeHealth("health-recovery");
    assert.equal(f.ledger.getAlert(alert.alertId).status, "resolved");
    const latest = f.ledger.nodeStatuses()[0].observedAt;
    f.ledger.recordNodeHeartbeat("old-observation", {
      nodeId: "worker",
      runtimeReady: false,
      activeExecutions: 1,
      sampledAt: f.now() - 1,
    });
    assert.equal(f.ledger.nodeStatuses()[0].state, "online");
    assert.equal(f.ledger.nodeStatuses()[0].observedAt, latest);
  } finally {
    f.close();
  }
});

test("same-session safe retry uses a new fenced attempt and preserves runtime origin", () => {
  const f = fixture({
    safeRetry: { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 200 },
    reportDestinations: ["feishu:chat:fixture"],
  });
  try {
    const { run, ref } = active(f, {
      maxRuntimeMs: 1000,
      requiredResources: ["exclusive"],
    });
    const origin = f.ledger.getRun(run.runId).executionStartedAt;
    const retried = f.ledger.retryBeforeEffects("retry", {
      ...ref,
      witness,
    }).value;
    assert.equal(retried.state, "queued");
    assert.equal(retried.retry.count, 1);
    assert.equal(retried.currentAttemptId, undefined);
    assert.equal(f.ledger.pendingRuns("worker").length, 0);
    assert.throws(
      () =>
        f.ledger.claim("early", {
          runId: run.runId,
          nodeId: "worker",
          ttlMs: 60000,
        }),
      code("NOT_DUE"),
    );
    f.advance(100);
    const next = f.ledger.claim("claim-retry", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    assert.equal(next.attempt.fence, 2);
    assert.equal(next.attempt.sessionId, "session-one");
    assert.equal(next.run.executionStartedAt, origin);
    const nextRef = {
      runId: run.runId,
      attemptId: next.attempt.attemptId,
      nodeId: "worker",
      fence: 2,
      executionId: "second-instance",
    };
    f.ledger.markRunning("next-start", nextRef);
    const terminal = f.ledger.retryBeforeEffects("retry-exhausted", {
      ...nextRef,
      witness: { ...witness, fromSeq: 8, toSeq: 15, terminalSeq: 14, turn: 2 },
    }).value;
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.validation, undefined);
    assert.equal(
      f.ledger.deliveries()[0].runId,
      run.runId,
      "late retry-exhaustion delivery stays bound to the original run",
    );
    assert.equal(f.ledger.pendingRuns("worker").length, 0);
  } finally {
    f.close();
  }
});

test("invalid/gapped/effectful retry proof cannot release ownership or schedule work", () => {
  const f = fixture({
    safeRetry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 200 },
  });
  try {
    const { ref, run } = active(f);
    for (const patch of [
      { toolCallCount: 1 },
      { complete: false },
      { quiescent: false },
      { sessionId: "other" },
      { terminalSeq: 8 },
      { fromSeq: 9 },
      { code: "SCHEMA" },
      { disposed: false },
    ])
      assert.throws(
        () =>
          f.ledger.retryBeforeEffects(
            "bad-" + JSON.stringify(patch).replace(/\W/g, ""),
            { ...ref, witness: { ...witness, ...patch } },
          ),
        code("RETRY_WITNESS"),
      );
    assert.equal(f.ledger.getRun(run.runId).state, "running");
    assert.equal(f.ledger.getAttempt(ref.attemptId).state, "running");
    const stopped = f.ledger.retryBeforeEffects("host-budget-stop", {
      ...ref,
      witness,
      allowRetry: false,
    }).value;
    assert.equal(stopped.state, "failed");
    assert.equal(stopped.validation, undefined);
  } finally {
    f.close();
  }
});

test("safe retry cannot knowingly queue a delay beyond the original execution budget", () => {
  const f = fixture({
    safeRetry: { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 400 },
  });
  try {
    const { ref } = active(f, { maxRuntimeMs: 200 });
    const stopped = f.ledger.retryBeforeEffects("deadline", {
      ...ref,
      witness,
    }).value;
    assert.equal(stopped.state, "failed");
    assert.equal(stopped.retry, undefined);
  } finally {
    f.close();
  }
});

test("safe retry and exhaustion preserve another live run's task projection", () => {
  const f = fixture({
    safeRetry: { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 200 },
  });
  try {
    const { task, run, ref } = active(f);
    f.ledger.registerNode("parallel-node", {
      nodeId: "other",
      roles: ["executor"],
      capabilities: [],
      models: [{ provider: "fixture", model: "fixture", reasoningEfforts: [] }],
      workspaceIds: [],
      enabled: true,
      lastSeenAt: new Date(f.now()).toISOString(),
    });
    const parallel = f.ledger.createRun("parallel-run", {
      taskId: task.taskId,
      route: { ...route, nodeId: "other" },
    }).value;
    const claim = f.ledger.claim("parallel-claim", {
      runId: parallel.runId,
      nodeId: "other",
      ttlMs: 60000,
    }).value;
    f.ledger.markRunning("parallel-start", {
      runId: parallel.runId,
      attemptId: claim.attempt.attemptId,
      nodeId: "other",
      fence: claim.attempt.fence,
      executionId: "parallel-owner",
    });
    f.ledger.retryBeforeEffects("retry-parallel", { ...ref, witness });
    assert.equal(f.ledger.getTask(task.taskId).state, "running");
    f.advance(100);
    const next = f.ledger.claim("retry-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    const nextRef = {
      ...ref,
      attemptId: next.attempt.attemptId,
      fence: next.attempt.fence,
      executionId: "next-owner",
    };
    f.ledger.markRunning("retry-start", nextRef);
    f.ledger.retryBeforeEffects("retry-exhaust", { ...nextRef, witness });
    assert.equal(f.ledger.getRun(run.runId).state, "failed");
    assert.equal(f.ledger.getTask(task.taskId).state, "running");
  } finally {
    f.close();
  }
});

test("observed admission has a lifecycle anchor while explicit historical imports stay silent", () => {
  const f = fixture({ lifecycleDestinations: ["feishu:chat:fixture"] });
  try {
    const task = f.ledger.createTask("observed-admission", {
      title: "Observed task",
      kind: "observed",
    }).value;
    assert.equal(f.ledger.deliveries().length, 1);
    assert.equal(f.ledger.deliveries()[0].taskId, task.taskId);
    assert.equal(f.ledger.deliveries()[0].kind, "lifecycle.created");
    const imported = structuredClone(f.ledger.snapshot());
    imported.source = {
      kind: "explicit-import",
      name: "history",
      observedAt: new Date(f.now()).toISOString(),
      staleAfterMs: 60000,
    };
    imported.tasks = [{ ...task, taskId: "historical-import" }];
    imported.events = [];
    f.ledger.importSnapshot("historical-import", imported);
    assert.equal(f.ledger.deliveries().length, 1);
  } finally {
    f.close();
  }
});

test("completed-tool resume needs operator opt-in, closed evidence and retains replay fingerprints", () => {
  const f = fixture({
    safeRetry: {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 200,
      resumableTools: ["reviewed_write"],
    },
  });
  try {
    const { run, ref } = active(f, { allowedTools: ["reviewed_write"] });
    const closed = {
      ...witness,
      kind: "dsh-owned-completed-tools-v1",
      toolCallCount: 1,
      toolDispatchCount: 1,
      toolResultCount: 1,
      completedTools: [
        { name: "reviewed_write", argumentsDigest: "a".repeat(64) },
      ],
    };
    let badIndex = 0;
    for (const bad of [
      { ...closed, toolResultCount: 0 },
      {
        ...closed,
        completedTools: [
          { name: "unreviewed_shell", argumentsDigest: "a".repeat(64) },
        ],
      },
      {
        ...closed,
        completedTools: [
          { name: "reviewed_write", argumentsDigest: "raw-arguments" },
        ],
      },
    ])
      assert.throws(
        () =>
          f.ledger.retryBeforeEffects("bad-completed-" + badIndex++, {
            ...ref,
            witness: bad,
          }),
        code("RETRY_WITNESS"),
      );
    const retried = f.ledger.retryBeforeEffects("closed-resume", {
      ...ref,
      witness: closed,
    }).value;
    assert.deepEqual(retried.retry.completedTools, closed.completedTools);
    f.advance(100);
    const next = f.ledger.claim("closed-next", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    const nextRef = {
      ...ref,
      attemptId: next.attempt.attemptId,
      fence: next.attempt.fence,
      executionId: "next-resume-owner",
    };
    f.ledger.markRunning("closed-next-start", nextRef);
    const zero = f.ledger.retryBeforeEffects("later-zero", {
      ...nextRef,
      witness,
    }).value;
    assert.deepEqual(
      zero.retry.completedTools,
      closed.completedTools,
      "a later zero-tool retry cannot erase previous effect replay guards",
    );
  } finally {
    f.close();
  }
  const disabled = fixture({
    safeRetry: { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 100 },
  });
  try {
    const { ref } = active(disabled);
    assert.throws(
      () =>
        disabled.ledger.retryBeforeEffects("not-opted", {
          ...ref,
          witness: {
            ...witness,
            kind: "dsh-owned-completed-tools-v1",
            toolCallCount: 1,
            toolDispatchCount: 1,
            toolResultCount: 1,
            completedTools: [
              { name: "reviewed_write", argumentsDigest: "a".repeat(64) },
            ],
          },
        }),
      code("RETRY_WITNESS"),
    );
  } finally {
    disabled.close();
  }
});
