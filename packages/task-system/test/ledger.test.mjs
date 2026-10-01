import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../dist/index.js";
const E = (code) => (e) => e.code === code;
function fixture(options = {}) {
  let now = Date.parse("2026-10-01T12:00:00Z");
  const dir = mkdtempSync(join(tmpdir(), "dsh-ledger-"));
  const file = join(dir, "ledger.sqlite");
  let ledger = TaskLedger.open(file, { ...options, now: () => now });
  return {
    get l() {
      return ledger;
    },
    advance: (n) => (now += n),
    now: () => new Date(now).toISOString(),
    reopen() {
      ledger.close();
      ledger = TaskLedger.open(file, { ...options, now: () => now });
    },
    close() {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function prepare(l, nodeId = "worker") {
  l.registerNode("node-" + nodeId, {
    nodeId,
    roles: ["executor"],
    capabilities: ["text"],
    models: [{ provider: "test", model: "model", reasoningEfforts: ["low"] }],
    workspaceIds: [],
    enabled: true,
    lastSeenAt: new Date().toISOString(),
  });
  const task = l.createTask("create", {
    taskId: "task-1",
    title: "Review a project",
  }).value;
  const run = l.createRun("run", {
    taskId: task.taskId,
    route: {
      nodeId,
      provider: "test",
      model: "model",
      reasoningEffort: "low",
      requiredCapabilities: ["text"],
    },
  }).value;
  return { task, run };
}
const lease = (a) => ({
  runId: a.runId,
  attemptId: a.attemptId,
  nodeId: a.nodeId,
  fence: a.fence,
});
test("durable acceptance and exact replay survive restart; key conflicts are rejected", () => {
  const f = fixture();
  try {
    const first = f.l.createTask("same", { title: "Long task" });
    f.reopen();
    assert.deepEqual(f.l.createTask("same", { title: "Long task" }), first);
    assert.throws(
      () => f.l.createTask("same", { title: "Changed" }),
      E("CONFLICT"),
    );
    assert.equal(f.l.snapshot().tasks.length, 1);
  } finally {
    f.close();
  }
});
test("same task retains equal-content reports across sessions and explicit revisions", () => {
  const f = fixture();
  try {
    const { task } = prepare(f.l);
    const a = f.l.appendReport("report-a", {
      taskId: task.taskId,
      title: "Report",
      body: "Same text",
      sessionId: "session-a",
    }).value;
    const b = f.l.appendReport("report-b", {
      taskId: task.taskId,
      title: "Report",
      body: "Same text",
      sessionId: "session-b",
    }).value;
    f.l.appendReport("revision", {
      taskId: task.taskId,
      title: "Correction",
      body: "Corrected",
      previousReportId: a.reportId,
    });
    f.reopen();
    const history = f.l.history(task.taskId);
    assert.equal(history.reports.length, 3);
    assert.equal(history.reports[0].body, "Same text");
    assert.equal(history.reports[2].revision, 2);
    assert.notEqual(a.reportId, b.reportId);
  } finally {
    f.close();
  }
});
test("observed activity is admitted once and cannot be redispatched", () => {
  const f = fixture();
  try {
    const input = {
      sourceId: "local/session",
      sourceRevision: "1",
      title: "Already completed",
      body: "Evidence",
    };
    const first = f.l.observe("observation-a", input).value;
    assert.deepEqual(f.l.observe("observation-b", input).value, first);
    assert.throws(
      () => f.l.createRun("dispatch-observed", { taskId: first.taskId }),
      E("OBSERVE_ONLY"),
    );
    assert.equal(f.l.snapshot().reports.length, 1);
  } finally {
    f.close();
  }
});
test("explicit targets cannot bypass capability/model/effort; wrong node cannot claim or settle", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    assert.throws(
      () =>
        f.l.createRun("bad-effort", {
          taskId: task.taskId,
          route: { ...run.route, reasoningEffort: "ultra" },
        }),
      E("UNSUPPORTED"),
    );
    assert.throws(
      () =>
        f.l.claim("wrong", { runId: run.runId, nodeId: "other", ttlMs: 1000 }),
      E("FORBIDDEN"),
    );
    const a = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    assert.throws(
      () =>
        f.l.submit("wrong-submit", {
          ...lease(a),
          nodeId: "other",
          outcome: "success",
          summary: "done",
        }),
      E("STALE_ASSIGNMENT"),
    );
    assert.equal(f.l.getRun(run.runId).state, "running");
  } finally {
    f.close();
  }
});
test("expired execution retains resource until explicit reconciliation and never automatically retries", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    const a = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
      resources: ["workspace-exclusive"],
    }).value.attempt;
    f.advance(1001);
    f.reopen();
    assert.throws(
      () => f.l.renew("late", { ...lease(a), ttlMs: 1000 }),
      E("LEASE_EXPIRED"),
    );
    f.l.recoverExpired("recover");
    assert.equal(f.l.getRun(run.runId).state, "uncertain");
    assert.throws(
      () =>
        f.l.createRun("unsafe-repeat", {
          taskId: task.taskId,
          route: run.route,
        }),
      E("UNRESOLVED_EFFECTS"),
    );
    const different = f.l.createTask("different-goal", {
      title: "Other work",
    }).value;
    const next = f.l.createRun("next", {
      taskId: different.taskId,
      route: run.route,
    }).value;
    assert.throws(
      () =>
        f.l.claim("blocked", {
          runId: next.runId,
          nodeId: "worker",
          ttlMs: 1000,
          resources: ["workspace-exclusive"],
        }),
      E("BUSY"),
    );
    f.l.resolveUncertain("review", {
      runId: run.runId,
      outcome: "failed",
      reason: "Operator confirmed worker stopped",
    });
    assert.equal(
      f.l.claim("retry", {
        runId: next.runId,
        nodeId: "worker",
        ttlMs: 1000,
        resources: ["workspace-exclusive"],
      }).value.attempt.fence,
      1,
    );
  } finally {
    f.close();
  }
});
test("cancel is a request until correlated acknowledgment; reports can still append without reversing it", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    const a = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    f.l.cancel("cancel", { taskId: task.taskId, reason: "User stopped" });
    assert.equal(f.l.getRun(run.runId).cancellationRequested, true);
    assert.throws(
      () =>
        f.l.submit("late-success", {
          ...lease(a),
          outcome: "success",
          summary: "done",
        }),
      E("CANCELLED"),
    );
    f.l.appendReport("late-evidence", {
      taskId: task.taskId,
      runId: run.runId,
      title: "Partial evidence",
      body: "Useful work before stop",
    });
    f.l.acknowledgeCancellation("ack", lease(a));
    assert.equal(f.l.getRun(run.runId).state, "cancelled");
    assert.equal(f.l.history(task.taskId).reports.length, 1);
  } finally {
    f.close();
  }
});
test("result validation rollback preserves attempt; valid result plus notification intent is atomic", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    const a = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    const settlement = {
      ...lease(a),
      outcome: "partial",
      summary: "Some checks missing",
      report: { title: "Result", body: "Partial" },
      notifications: [
        {
          destination: "allowed-chat",
          kind: "feishu.text",
          payload: { text: "Ready" },
        },
      ],
    };
    assert.throws(
      () =>
        f.l.submit("bad", {
          ...settlement,
          report: { ...settlement.report, artifactIds: ["missing"] },
        }),
      E("NOT_FOUND"),
    );
    assert.equal(f.l.getRun(run.runId).state, "running");
    assert.equal(f.l.deliveries().length, 0);
    const final = f.l.submit("final", settlement);
    f.reopen();
    assert.deepEqual(f.l.submit("final", settlement), final);
    assert.equal(f.l.getRun(run.runId).state, "succeeded");
    assert.equal(f.l.getRun(run.runId).outcome, "partial");
    assert.equal(f.l.deliveries().length, 1);
    assert.equal(f.l.history(task.taskId).reports.length, 1);
  } finally {
    f.close();
  }
});
test("delivery crash becomes uncertain without changing task result; exact claim completion separated", () => {
  const f = fixture();
  try {
    const { run } = prepare(f.l);
    const a = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    f.l.submit("final", {
      ...lease(a),
      outcome: "failure",
      summary: "Service failed",
      notifications: [
        {
          destination: "chat",
          kind: "feishu.text",
          payload: { text: "Failure" },
        },
      ],
    });
    const d = f.l.deliveries()[0];
    f.l.claimDelivery("send", { deliveryId: d.deliveryId, ttlMs: 100 });
    f.advance(101);
    f.reopen();
    f.l.recoverExpired("recover");
    assert.equal(f.l.deliveries()[0].state, "uncertain");
    assert.throws(
      () =>
        f.l.claimDelivery("resend", { deliveryId: d.deliveryId, ttlMs: 100 }),
      E("UNCERTAIN"),
    );
    assert.equal(f.l.getRun(run.runId).state, "failed");
  } finally {
    f.close();
  }
});
test("custom scheduled templates share one stable task and admit each slot once across restart", () => {
  const f = fixture();
  try {
    const task = f.l.createTask("t", {
      title: "Custom scheduled workflow",
    }).value;
    f.l.updateTemplate("tpl", {
      templateId: "custom-type",
      version: 1,
      name: "My custom type",
      description: "Configurable example",
      inputSchema: { type: "object" },
      defaults: {},
      resultContract: { type: "object" },
    });
    const schedule = {
      scheduleId: "schedule",
      taskId: task.taskId,
      templateId: "custom-type",
      templateVersion: 1,
      enabled: true,
      intervalMs: 1000,
      nextDueAt: f.now(),
      overlap: "queue",
      input: { topic: "Anything" },
    };
    f.l.createSchedule("s", schedule);
    const first = f.l.fireSchedule("fire1", {
      scheduleId: "schedule",
      occurrenceAt: f.now(),
    }).value;
    f.reopen();
    assert.deepEqual(
      f.l.fireSchedule("fire-again", {
        scheduleId: "schedule",
        occurrenceAt: f.now(),
      }).value,
      first,
    );
    f.advance(1000);
    const second = f.l.fireSchedule("fire2", {
      scheduleId: "schedule",
      occurrenceAt: f.now(),
    }).value;
    assert.notEqual(first.runId, second.runId);
    assert.equal(f.l.snapshot().tasks.length, 1);
    assert.equal(f.l.snapshot().runs.length, 2);
    assert.equal(f.l.snapshot().runs[0].configuration.template.version, 1);
  } finally {
    f.close();
  }
});
test("source freshness is explicit imported evidence time, not repeated UI polling time", () => {
  const f = fixture();
  try {
    const at = f.now();
    const snap = {
      schemaVersion: "1",
      generatedAt: at,
      source: {
        kind: "explicit-import",
        label: "Authorized update",
        observedAt: at,
        staleAfterMs: 1000,
      },
      tasks: [
        {
          taskId: "dot-task",
          title: "Active work",
          description: "",
          state: "running",
          kind: "observed",
          createdAt: at,
          updatedAt: at,
          tags: [],
        },
      ],
      runs: [],
      reports: [],
      artifacts: [],
      templates: [],
      events: [],
    };
    f.l.importSnapshot("import", snap);
    f.advance(5000);
    assert.equal(f.l.snapshot().source.observedAt, at);
    assert.notEqual(f.l.snapshot().generatedAt, at);
    assert.throws(
      () => f.l.createRun("redispatch", { taskId: "dot-task" }),
      E("OBSERVE_ONLY"),
    );
  } finally {
    f.close();
  }
});
test("cron uses configured time zone and custom schemas reject bad task input", () => {
  const f = fixture();
  try {
    const task = f.l.createTask("t", { title: "Cron task" }).value;
    f.l.updateTemplate("tpl", {
      templateId: "typed",
      version: 1,
      name: "Typed task",
      description: "",
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
        additionalProperties: false,
      },
      defaults: {},
      resultContract: {},
    });
    const s = {
      scheduleId: "cron",
      taskId: task.taskId,
      templateId: "typed",
      templateVersion: 1,
      enabled: true,
      cron: "0 8 * * *",
      timeZone: "Asia/Shanghai",
      nextDueAt: f.now(),
      overlap: "queue",
      input: { wrong: 1 },
    };
    assert.throws(
      () => f.l.createSchedule("schedule", s),
      E("SCHEMA_VALIDATION"),
    );
    assert.equal(f.l.snapshot().schedules.length, 0);
    const valid = { ...s, input: { topic: "valid" } };
    f.l.createSchedule("valid-schedule", valid);
    f.l.fireSchedule("valid-fire", {
      scheduleId: "cron",
      occurrenceAt: f.now(),
    });
    assert.equal(f.l.snapshot().runs.length, 1);
    assert.equal(f.l.getSchedule("cron").nextDueAt, "2026-10-02T00:00:00.000Z");
  } finally {
    f.close();
  }
});
test("parent all-settled quiet window refreshes after a later child is admitted", () => {
  const f = fixture();
  try {
    const parent = f.l.createTask("root", { title: "Parent" }).value;
    const child = f.l.createTask("child", {
      title: "Child",
      parentTaskId: parent.taskId,
    }).value;
    const run = f.l.createRun("childrun", { taskId: child.taskId }).value;
    assert.equal(f.l.allSettled(parent.taskId).settled, false);
    f.l.cancel("cancelchild", {
      taskId: child.taskId,
      reason: "No longer required",
    });
    assert.equal(f.l.allSettled(parent.taskId).settled, false);
    f.advance(1001);
    assert.equal(f.l.allSettled(parent.taskId).settled, true);
    const second = f.l.createTask("nextchild", {
      title: "Later child",
      parentTaskId: parent.taskId,
    }).value;
    f.l.createRun("secondrun", { taskId: second.taskId });
    assert.equal(f.l.allSettled(parent.taskId).settled, false);
  } finally {
    f.close();
  }
});
test("child scopes cannot widen parent deny lists and runtime/delegation budgets", () => {
  const f = fixture();
  try {
    const parent = f.l.createTask("parent", {
      title: "Bounded parent",
      policy: {
        allowedNodeIds: [],
        allowedTools: ["read"],
        maxRuntimeMs: 1000,
        maxDepth: 1,
      },
    }).value;
    assert.throws(
      () =>
        f.l.createTask("widen", {
          title: "Bad child",
          parentTaskId: parent.taskId,
          policy: { allowedNodeIds: ["worker"] },
        }),
      E("FORBIDDEN"),
    );
    assert.throws(
      () =>
        f.l.createTask("budget", {
          title: "Bad budget",
          parentTaskId: parent.taskId,
          policy: { maxRuntimeMs: 2000 },
        }),
      E("FORBIDDEN"),
    );
    const child = f.l.createTask("child", {
      title: "Safe child",
      parentTaskId: parent.taskId,
    }).value;
    assert.deepEqual(child.policy.allowedNodeIds, []);
    assert.throws(
      () =>
        f.l.createTask("deep", {
          title: "Too deep",
          parentTaskId: child.taskId,
        }),
      E("FORBIDDEN"),
    );
  } finally {
    f.close();
  }
});
test("blocked continuation is atomic, preserves task identity and rejects stale cards", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    const a = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    f.l.submit("blocked", {
      ...lease(a),
      outcome: "blocked",
      summary: "Need more input",
    });
    const next = f.l.continueRun("continue", {
      taskId: task.taskId,
      runId: run.runId,
    });
    assert.equal(next.value.taskId, task.taskId);
    assert.equal(next.value.configuration.continuationOf, run.runId);
    assert.deepEqual(
      f.l.continueRun("continue", { taskId: task.taskId, runId: run.runId }),
      next,
    );
    assert.throws(
      () =>
        f.l.continueRun("stale-card", {
          taskId: task.taskId,
          runId: run.runId,
        }),
      E("CONFLICT"),
    );
  } finally {
    f.close();
  }
});
test("null child policy values cannot erase inherited node, workspace or tool constraints", () => {
  const f = fixture();
  try {
    const p = f.l.createTask("parent", {
      title: "Parent",
      policy: {
        allowedNodeIds: ["worker"],
        allowedWorkspaceIds: [],
        allowedTools: [],
      },
    }).value;
    for (const field of [
      "allowedNodeIds",
      "allowedWorkspaceIds",
      "allowedTools",
    ])
      assert.throws(
        () =>
          f.l.createTask("null-" + field, {
            title: "Invalid child",
            parentTaskId: p.taskId,
            policy: { [field]: null },
          }),
        E("INVALID"),
      );
    assert.throws(
      () =>
        f.l.createTask("null-policy", {
          title: "Invalid",
          parentTaskId: p.taskId,
          policy: null,
        }),
      E("INVALID"),
    );
    assert.equal(f.l.snapshot().tasks.length, 1);
  } finally {
    f.close();
  }
});
test("run-scoped cancellation cannot cancel another node run under the same stable task", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    f.l.registerNode("other-node", {
      nodeId: "other",
      roles: ["executor"],
      capabilities: ["text"],
      models: [{ provider: "test", model: "model", reasoningEfforts: ["low"] }],
      workspaceIds: [],
      enabled: true,
      lastSeenAt: f.now(),
    });
    const other = f.l.createRun("other-run", {
      taskId: task.taskId,
      route: { ...run.route, nodeId: "other" },
    }).value;
    f.l.cancel("stop-one", {
      taskId: task.taskId,
      runId: run.runId,
      reason: "Stop only this assignment",
    });
    assert.equal(f.l.getRun(other.runId).cancellationRequested, undefined);
    assert.equal(
      f.l.claim("claim-other", {
        runId: other.runId,
        nodeId: "other",
        ttlMs: 1000,
      }).value.task.state,
      "running",
    );
  } finally {
    f.close();
  }
});
test("one successful run cannot hide another active run for the same stable task", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    const other = f.l.createRun("parallel", {
      taskId: task.taskId,
      route: run.route,
    }).value;
    const a = f.l.claim("a", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    const b = f.l.claim("b", {
      runId: other.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    f.l.submit("finish-a", {
      ...lease(a),
      outcome: "success",
      summary: "First done",
    });
    assert.equal(f.l.getTask(task.taskId).state, "running");
    f.l.submit("finish-b", {
      ...lease(b),
      outcome: "partial",
      summary: "Partial result",
    });
    assert.equal(f.l.getTask(task.taskId).state, "completed");
    assert.equal(f.l.getRun(other.runId).reviewStatus, "pending_user");
  } finally {
    f.close();
  }
});
test("multiple blocked continuations retain prior outcomes without blocking the next explicit continuation", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    let current = run;
    for (let i = 0; i < 3; i++) {
      const a = f.l.claim("claim-" + i, {
        runId: current.runId,
        nodeId: "worker",
        ttlMs: 1000,
      }).value.attempt;
      f.l.submit("blocked-" + i, {
        ...lease(a),
        outcome: "blocked",
        summary: "Need input",
      });
      current = f.l.continueRun("continue-" + i, {
        taskId: task.taskId,
        runId: current.runId,
      }).value;
    }
    assert.equal(f.l.history(task.taskId).runs.length, 4);
    assert.equal(
      f.l.history(task.taskId).runs.filter((r) => r.outcome === "blocked")
        .length,
      3,
    );
  } finally {
    f.close();
  }
});
test("late completion of an older run cannot regress the newest completed run projection", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    const newer = f.l.createRun("newer", {
      taskId: task.taskId,
      route: run.route,
    }).value;
    const a = f.l.claim("older-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    const b = f.l.claim("newer-claim", {
      runId: newer.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    f.l.submit("newer-done", {
      ...lease(b),
      outcome: "success",
      summary: "Current result",
    });
    f.l.submit("older-late", {
      ...lease(a),
      outcome: "failure",
      summary: "Earlier run failure",
    });
    assert.equal(f.l.getTask(task.taskId).state, "completed");
    assert.equal(f.l.history(task.taskId).runs[0].outcome, "failure");
  } finally {
    f.close();
  }
});
test("schedule management validates boolean state and versions without rewriting existing run snapshots", () => {
  const f = fixture();
  try {
    const task = f.l.createTask("task", { title: "Manage schedule" }).value;
    f.l.updateTemplate("template", {
      templateId: "custom",
      version: 1,
      name: "Custom",
      description: "",
      inputSchema: { type: "object" },
      defaults: {},
      resultContract: {},
    });
    const schedule = {
      scheduleId: "managed",
      taskId: task.taskId,
      templateId: "custom",
      templateVersion: 1,
      enabled: true,
      intervalMs: 1000,
      nextDueAt: f.now(),
      overlap: "queue",
      input: { version: "old" },
    };
    assert.throws(
      () => f.l.createSchedule("badbool", { ...schedule, enabled: "false" }),
      E("INVALID"),
    );
    f.l.createSchedule("create", schedule);
    f.l.fireSchedule("first", { scheduleId: "managed", occurrenceAt: f.now() });
    assert.throws(
      () =>
        f.l.setScheduleEnabled("bad-toggle", {
          scheduleId: "managed",
          enabled: "false",
        }),
      E("INVALID"),
    );
    f.l.updateSchedule("update", {
      scheduleId: "managed",
      expectedRevision: 1,
      changes: { input: { version: "new" } },
    });
    assert.equal(f.l.snapshot().runs[0].configuration.input.version, "old");
    assert.equal(f.l.getSchedule("managed").input.version, "new");
    assert.throws(
      () =>
        f.l.updateSchedule("stale", {
          scheduleId: "managed",
          expectedRevision: 1,
          changes: { enabled: false },
        }),
      E("CONFLICT"),
    );
    f.l.retireSchedule("retire", { scheduleId: "managed" });
    assert.equal(f.l.getSchedule("managed").enabled, false);
    assert.equal(f.l.snapshot().runs.length, 1);
  } finally {
    f.close();
  }
});
test("missed schedules coalesce by default and skip when configured without unbounded backlog dispatch", () => {
  for (const misfire of ["once", "skip"]) {
    const f = fixture();
    try {
      const task = f.l.createTask("task", { title: "Missed work" }).value;
      f.l.updateTemplate("template", {
        templateId: "custom",
        version: 1,
        name: "Custom",
        description: "",
        inputSchema: { type: "object" },
        defaults: {},
        resultContract: {},
      });
      const due = f.now();
      f.l.createSchedule("s", {
        scheduleId: "s",
        taskId: task.taskId,
        templateId: "custom",
        templateVersion: 1,
        enabled: true,
        intervalMs: 1000,
        nextDueAt: due,
        overlap: "queue",
        misfire,
        input: {},
      });
      f.advance(100_000);
      const result = f.l.fireSchedule("fire", {
        scheduleId: "s",
        occurrenceAt: due,
      }).value;
      assert.equal(f.l.snapshot().runs.length, misfire === "once" ? 1 : 0);
      assert.ok(
        Date.parse(f.l.getSchedule("s").nextDueAt) > Date.parse(f.now()),
      );
      assert.equal(f.l.scheduleDue().length, 0);
      if (misfire === "skip") assert.equal(result.status, "skipped-misfire");
    } finally {
      f.close();
    }
  }
});
test("cancelling an old already-terminal run cannot change the task projection", () => {
  const f = fixture();
  try {
    const { task, run } = prepare(f.l);
    const a = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    f.l.submit("done", { ...lease(a), outcome: "success", summary: "Done" });
    const before = f.l.getTask(task.taskId);
    f.l.cancel("stale-cancel", {
      taskId: task.taskId,
      runId: run.runId,
      reason: "Old control",
    });
    assert.deepEqual(f.l.getTask(task.taskId), before);
  } finally {
    f.close();
  }
});
test("custom structured report schemas validate data and preserve it beside human-readable reports", () => {
  const f = fixture();
  try {
    const { task, run: unused } = prepare(f.l);
    f.l.cancel("discard-fixture-run", {
      taskId: task.taskId,
      runId: unused.runId,
      reason: "Use structured route",
    });
    const template = {
      templateId: "structured",
      version: 1,
      name: "Structured custom report",
      description: "",
      inputSchema: { type: "object" },
      defaults: {},
      resultContract: {
        type: "object",
        properties: {
          outcome: { type: "string" },
          summary: { type: "string" },
          report: {
            type: "object",
            properties: {
              data: {
                type: "object",
                properties: { count: { type: "integer", minimum: 0 } },
                required: ["count"],
                additionalProperties: false,
              },
            },
            required: ["data"],
          },
        },
        required: ["report"],
      },
    };
    const run = f.l.createRun("structured-run", {
      taskId: task.taskId,
      route: unused.route,
      configuration: { template, input: {} },
    }).value;
    const a = f.l.claim("structured-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value.attempt;
    const input = {
      ...lease(a),
      outcome: "success",
      summary: "Validated",
      report: {
        title: "Custom report",
        body: "Counted three",
        schemaId: "custom.count.v1",
        data: { count: "wrong" },
      },
    };
    assert.throws(
      () => f.l.submit("invalid-data", input),
      E("SCHEMA_VALIDATION"),
    );
    f.l.submit("valid-data", {
      ...input,
      report: { ...input.report, data: { count: 3 } },
    });
    assert.deepEqual(f.l.history(task.taskId).reports[0].data, { count: 3 });
    assert.equal(
      f.l.history(task.taskId).reports[0].schemaId,
      "custom.count.v1",
    );
  } finally {
    f.close();
  }
});

test("execution ownership binds atomically across connections and survives restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-owner-"));
  const path = join(dir, "ledger.sqlite");
  const a = TaskLedger.open(path),
    b = TaskLedger.open(path);
  try {
    const { run } = prepare(a);
    const claim = a.claim("claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    const first = { ...lease(claim.attempt), executionId: "first-execution" };
    const second = { ...lease(claim.attempt), executionId: "second-execution" };
    assert.throws(
      () => a.markRunning("missing-owner", lease(claim.attempt)),
      E("INVALID"),
    );
    a.markRunning("start-first", first);
    assert.throws(
      () => b.markRunning("start-second", second),
      E("EXECUTION_OWNER"),
    );
    assert.throws(
      () =>
        b.bindSession("bind-second", { ...second, sessionId: "other-session" }),
      E("EXECUTION_OWNER"),
    );
    assert.throws(
      () => b.renew("renew-second", { ...second, ttlMs: 60000 }),
      E("EXECUTION_OWNER"),
    );
    assert.throws(
      () =>
        b.submit("submit-second", {
          ...second,
          outcome: "unknown",
          summary: "Not my execution",
        }),
      E("EXECUTION_OWNER"),
    );
    assert.throws(
      () =>
        b.submit("submit-missing", {
          ...lease(claim.attempt),
          outcome: "success",
          summary: "Missing owner",
        }),
      E("EXECUTION_OWNER"),
    );
    a.bindSession("bind-first", { ...first, sessionId: "original-session" });
    assert.equal(
      b.getAttempt(claim.attempt.attemptId).executionId,
      first.executionId,
    );
    b.submit("submit-first", {
      ...first,
      outcome: "success",
      summary: "Owned result",
    });
    assert.equal(a.getRun(run.runId).state, "succeeded");
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinned semantic validator fails closed and cannot be bypassed by valid JSON shape", () => {
  const f = fixture();
  try {
    const { run } = prepare(f.l);
    const template = {
      templateId: "semantic",
      version: 1,
      name: "Checked accounting",
      description: "Fixture",
      inputSchema: {},
      defaults: {},
      resultContract: {},
      resultValidator: "accounting-v1",
    };
    const second = f.l.createRun("semantic-run", {
      taskId: run.taskId,
      route: run.route,
      configuration: { template },
    }).value;
    const claim = f.l.claim("semantic-claim", {
      runId: second.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    const ref = { ...lease(claim.attempt), executionId: "validator-execution" };
    f.l.markRunning("semantic-start", ref);
    const submission = {
      ...ref,
      outcome: "success",
      summary: "Reported success",
      report: {
        title: "Numbers",
        body: "Count must match",
        data: { items: ["one"], count: 2 },
      },
    };
    assert.throws(
      () => f.l.submit("semantic-result", submission),
      E("VALIDATOR_UNAVAILABLE"),
    );
    f.l.registerResultValidator("accounting-v1", async () => ({ valid: true }));
    assert.throws(
      () => f.l.submit("semantic-result", submission),
      E("RESULT_VALIDATION"),
    );
    const stale = f.l.registerResultValidator("accounting-v1", () => ({
      valid: false,
    }));
    const current = f.l.registerResultValidator(
      "accounting-v1",
      ({ submission, run, attempt, task }) => ({
        valid:
          submission.report.data.count ===
            submission.report.data.items.length &&
          run.taskId === task.taskId &&
          attempt.executionId === ref.executionId,
      }),
    );
    stale();
    assert.throws(
      () => f.l.submit("semantic-result", submission),
      E("RESULT_VALIDATION"),
    );
    assert.equal(f.l.getRun(second.runId).state, "running");
    assert.equal(f.l.history(run.taskId).reports.length, 0);
    assert.equal(f.l.deliveries().length, 0);
    current();
    assert.throws(
      () => f.l.submit("semantic-result", submission),
      E("VALIDATOR_UNAVAILABLE"),
    );
    f.l.registerResultValidator("accounting-v1", ({ submission }) => ({
      valid:
        submission.report.data.count === submission.report.data.items.length,
    }));
    submission.report.data.count = 1;
    f.l.submit("semantic-result", submission);
    assert.equal(f.l.getRun(second.runId).state, "succeeded");
    assert.equal(f.l.history(run.taskId).reports[0].data.count, 1);
  } finally {
    f.close();
  }
});

test("operator confirmation persists, gates direct claims and uses revision-bound decisions", () => {
  const f = fixture();
  try {
    const base = prepare(f.l);
    const task = f.l.createTask("guarded-task", {
      title: "Needs explicit approval",
      requiresConfirmation: true,
    }).value;
    const run = f.l.createRun("guarded-run", {
      taskId: task.taskId,
      route: base.run.route,
    }).value;
    assert.equal(task.confirmation.state, "pending");
    assert.equal(f.l.getTask(task.taskId).state, "waiting");
    assert.ok(!f.l.pendingRuns("worker").some((r) => r.runId === run.runId));
    assert.throws(
      () =>
        f.l.claim("guarded-claim", {
          runId: run.runId,
          nodeId: "worker",
          ttlMs: 60000,
        }),
      E("CONFIRMATION_REQUIRED"),
    );
    f.reopen();
    const rejection = {
      taskId: task.taskId,
      expectedRevision: 2,
      approved: false,
      actor: "operator-fixture",
      reason: "Not yet",
    };
    f.l.setTaskConfirmation("reject", rejection);
    assert.throws(
      () =>
        f.l.setTaskConfirmation("stale-approve", {
          ...rejection,
          approved: true,
        }),
      E("CONFLICT"),
    );
    const approved = f.l.setTaskConfirmation("approve", {
      ...rejection,
      expectedRevision: 3,
      approved: true,
      reason: "Exact task reviewed",
    });
    assert.equal(approved.value.confirmation.revision, 4);
    assert.deepEqual(
      f.l.setTaskConfirmation("approve", {
        ...rejection,
        expectedRevision: 3,
        approved: true,
        reason: "Exact task reviewed",
      }),
      approved,
    );
    assert.ok(f.l.pendingRuns("worker").some((r) => r.runId === run.runId));
    const claim = f.l.claim("guarded-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    assert.throws(
      () =>
        f.l.setTaskConfirmation("revoke-active", {
          ...rejection,
          expectedRevision: 4,
        }),
      E("CONFLICT"),
    );
    assert.equal(claim.attempt.state, "leased");
    const child = f.l.createTask("child-approval", {
      title: "Separate child effects",
      parentTaskId: task.taskId,
      requiresConfirmation: false,
    }).value;
    assert.equal(child.confirmation.state, "pending");
  } finally {
    f.close();
  }
});

test("dispatch preserves configured immediacy then urgency, while importance remains descriptive", () => {
  const f = fixture();
  try {
    const base = prepare(f.l);
    const add = (key, urgency, immediacy, importance) => {
      const task = f.l.createTask(key, {
        title: key,
        userImmediacy: immediacy,
        urgency,
        importance,
      }).value;
      return f.l.createRun("run-" + key, {
        taskId: task.taskId,
        route: base.run.route,
      }).value;
    };
    const low = add("low", 100, 20, 100),
      urgent = add("urgent", 90, 60, 0),
      same = add("same", 10, 60, 100),
      immediate = add("immediate", 0, 100, 0);
    assert.deepEqual(
      f.l.pendingRuns("worker").map((r) => r.runId),
      [immediate.runId, urgent.runId, same.runId, base.run.runId, low.runId],
    );
    f.l.updateTask("raise", {
      taskId: low.taskId,
      userImmediacy: 100,
      urgency: 100,
    });
    assert.equal(f.l.pendingRuns("worker")[0].runId, low.runId);
    assert.throws(
      () => f.l.createTask("bad-priority", { title: "Bad", urgency: 1.5 }),
      E("INVALID"),
    );
  } finally {
    f.close();
  }
});

test("blocked continuation retains its pinned template and semantic validator", () => {
  const f = fixture();
  try {
    const base = prepare(f.l);
    f.l.registerResultValidator("retained-v1", ({ submission }) => ({
      valid: submission.outcome === "blocked",
    }));
    const run = f.l.createRun("contract-run", {
      taskId: base.task.taskId,
      route: base.run.route,
      configuration: {
        template: {
          templateId: "retain",
          version: 1,
          name: "Keep",
          description: "",
          defaults: {},
          inputSchema: {},
          resultContract: {},
          resultValidator: "retained-v1",
        },
        input: { source: "fixture" },
      },
    }).value;
    // Finish the unrelated prepared run so only this blocked continuation is current.
    const initial = f.l.claim("initial-claim", {
      runId: base.run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    f.l.submit("initial-result", {
      ...lease(initial.attempt),
      outcome: "success",
      summary: "Initial complete",
    });
    const claim = f.l.claim("contract-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    f.l.submit("blocked-result", {
      ...lease(claim.attempt),
      outcome: "blocked",
      summary: "Needs input",
    });
    const next = f.l.continueRun("continue-contract", {
      taskId: run.taskId,
      runId: run.runId,
    }).value;
    assert.equal(next.configuration.template.resultValidator, "retained-v1");
    assert.deepEqual(next.configuration.input, { source: "fixture" });
    const nextClaim = f.l.claim("next-contract-claim", {
      runId: next.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    assert.throws(
      () =>
        f.l.submit("bypass", {
          ...lease(nextClaim.attempt),
          outcome: "success",
          summary: "Try dropping validator",
        }),
      E("RESULT_VALIDATION"),
    );
  } finally {
    f.close();
  }
});

test("changed task intent and newly queued plans invalidate stale human approval", () => {
  const f = fixture();
  try {
    const { run: base } = prepare(f.l);
    const task = f.l.createTask("approval-task", {
      title: "Original",
      requiresConfirmation: true,
    }).value;
    const revision = task.confirmation.revision;
    f.l.updateTask("changed-intent", {
      taskId: task.taskId,
      title: "Changed scope",
    });
    assert.throws(
      () =>
        f.l.setTaskConfirmation("stale-card", {
          taskId: task.taskId,
          expectedRevision: revision,
          approved: true,
          actor: "human-fixture",
          reason: "Old card",
        }),
      E("CONFLICT"),
    );
    const changed = f.l.getTask(task.taskId).confirmation.revision;
    f.l.setTaskConfirmation("approve-intent", {
      taskId: task.taskId,
      expectedRevision: changed,
      approved: true,
      actor: "human-fixture",
      reason: "Reviewed changed title",
    });
    const run = f.l.createRun("new-plan", {
      taskId: task.taskId,
      route: base.route,
      configuration: { input: "new executable plan" },
    }).value;
    assert.equal(f.l.getTask(task.taskId).confirmation.state, "pending");
    assert.throws(
      () =>
        f.l.claim("unapproved-plan", {
          runId: run.runId,
          nodeId: "worker",
          ttlMs: 60000,
        }),
      E("CONFIRMATION_REQUIRED"),
    );
  } finally {
    f.close();
  }
});

test("required resource policy cannot be omitted by automatic or remote claims", () => {
  const f = fixture();
  try {
    const { run: base } = prepare(f.l);
    const a = f.l.createTask("resource-a", {
      title: "Shared device A",
      policy: { requiredResources: ["device:screen"] },
    }).value;
    const b = f.l.createTask("resource-b", {
      title: "Shared device B",
      policy: { requiredResources: ["device:screen"] },
    }).value;
    const runA = f.l.createRun("resource-run-a", {
      taskId: a.taskId,
      route: base.route,
    }).value;
    const runB = f.l.createRun("resource-run-b", {
      taskId: b.taskId,
      route: base.route,
    }).value;
    const claimed = f.l.claim("resource-claim-a", {
      runId: runA.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    assert.throws(
      () =>
        f.l.claim("resource-claim-b", {
          runId: runB.runId,
          nodeId: "worker",
          ttlMs: 60000,
        }),
      E("BUSY"),
    );
    assert.throws(
      () =>
        f.l.createTask("resource-child", {
          title: "Cannot drop",
          parentTaskId: a.taskId,
          policy: { requiredResources: [] },
        }),
      E("FORBIDDEN"),
    );
    f.l.submit("release-resource", {
      ...lease(claimed.attempt),
      outcome: "success",
      summary: "Quiescent",
    });
    assert.equal(
      f.l.claim("resource-claim-b", {
        runId: runB.runId,
        nodeId: "worker",
        ttlMs: 60000,
      }).value.run.runId,
      runB.runId,
    );
  } finally {
    f.close();
  }
});

test("configured narrative reporting creates authoritative outbox intents and none suppresses only delivery", () => {
  const f = fixture({ reportDestinations: ["feishu:chat:fixture"] });
  try {
    const { task, run } = prepare(f.l);
    const a = f.l.claim("notify-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    const result = {
      ...lease(a.attempt),
      outcome: "failure",
      summary: "Actual failure",
      report: { title: "Failure detail", body: "Authoritative stored report" },
      notifications: [
        { destination: "feishu:chat:fixture", kind: "report", payload: {} },
      ],
    };
    f.l.submit("notify-result", result);
    f.l.submit("notify-result", result);
    assert.equal(f.l.deliveries().length, 1);
    assert.equal(
      f.l.deliveries()[0].reportId,
      f.l.history(task.taskId).reports[0].reportId,
    );
    const quiet = f.l.createRun("quiet-run", {
      taskId: task.taskId,
      route: run.route,
      configuration: { reporting: "none" },
    }).value;
    const b = f.l.claim("quiet-claim", {
      runId: quiet.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    f.l.submit("quiet-result", {
      ...lease(b.attempt),
      outcome: "success",
      summary: "No narrative requested",
    });
    assert.equal(f.l.getRun(quiet.runId).state, "succeeded");
    assert.equal(f.l.deliveries().length, 1);
  } finally {
    f.close();
  }
});

test("reversible non-task curation preserves lifecycle and later reports without re-admitting", () => {
  const f = fixture({ reportDestinations: ["feishu:chat:fixture"] });
  try {
    const { task, run } = prepare(f.l);
    f.l.setTaskAdmission("dismiss", {
      taskId: task.taskId,
      state: "dismissed",
      expectedRevision: 1,
      actor: "operator",
      reason: "Not a reportable task",
    });
    assert.equal(f.l.getTask(task.taskId).state, "ready");
    assert.equal(f.l.querySnapshot().tasks.length, 0);
    assert.equal(f.l.snapshot().tasks.length, 1);
    assert.equal(f.l.decisionCatalog().tasks.length, 0);
    f.l.appendReport("later-history", {
      taskId: task.taskId,
      title: "Later evidence",
      body: "Retained under same objective",
    });
    assert.equal(f.l.querySnapshot().reports.length, 0);
    assert.equal(f.l.history(task.taskId).reports.length, 1);
    const claim = f.l.claim("curated-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    f.l.submit("curated-result", {
      ...lease(claim.attempt),
      outcome: "success",
      summary: "Recorded but excluded from automatic narrative",
    });
    assert.equal(f.l.deliveries().length, 0);
    assert.equal(f.l.getTask(task.taskId).admissionState, "dismissed");
    assert.throws(
      () =>
        f.l.setTaskAdmission("stale-restore", {
          taskId: task.taskId,
          state: "admitted",
          expectedRevision: 1,
          actor: "operator",
          reason: "Stale",
        }),
      E("CONFLICT"),
    );
    f.l.setTaskAdmission("restore", {
      taskId: task.taskId,
      state: "admitted",
      expectedRevision: 2,
      actor: "operator",
      reason: "Include again",
    });
    assert.equal(f.l.querySnapshot().tasks.length, 1);
    assert.equal(f.l.history(task.taskId).task.state, "completed");
  } finally {
    f.close();
  }
});

test("imported run evidence stays observe-only after an explicit new task continuation", () => {
  const f = fixture();
  try {
    const base = prepare(f.l);
    const importedTask = {
      ...base.task,
      taskId: "historical-task",
      kind: "observed",
      state: "ready",
    };
    const importedRun = {
      ...base.run,
      taskId: importedTask.taskId,
      runId: "historical-run",
      state: "queued",
    };
    const snapshot = {
      schemaVersion: "1",
      generatedAt: f.now(),
      source: {
        kind: "explicit-import",
        label: "Synthetic historical evidence",
        observedAt: f.now(),
        staleAfterMs: 60000,
      },
      tasks: [importedTask],
      runs: [importedRun],
      reports: [],
      artifacts: [],
      events: [],
      templates: [],
    };
    f.l.importSnapshot("import-history", snapshot);
    assert.equal(f.l.getRun(importedRun.runId).observationOnly, true);
    assert.ok(
      !f.l.pendingRuns("worker").some((r) => r.runId === importedRun.runId),
    );
    assert.throws(
      () =>
        f.l.claim("claim-history", {
          runId: importedRun.runId,
          nodeId: "worker",
          ttlMs: 60000,
        }),
      E("OBSERVE_ONLY"),
    );
    f.l.setTaskAdmission("exclude-history", {
      taskId: importedTask.taskId,
      state: "dismissed",
      expectedRevision: 1,
      actor: "operator",
      reason: "Curated",
    });
    f.l.importSnapshot("same-source-new-command", snapshot);
    assert.equal(f.l.getTask(importedTask.taskId).admissionState, "dismissed");
    f.l.setTaskAdmission("restore-history", {
      taskId: importedTask.taskId,
      state: "admitted",
      expectedRevision: 2,
      actor: "operator",
      reason: "New explicit request",
    });
    const route = base.run.route;
    f.l.recordDecision("record-continuation", {
      decisionId: "continued",
      inputDigest: "fixture",
      receipt: {},
      proposal: {
        kind: "proposal",
        persistence: "attach",
        attachTaskId: importedTask.taskId,
        executor: { id: route.nodeId },
        modelRoute: {
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
        },
        workspace: null,
        reporting: { narrative: "summary" },
      },
      stateHash: "fixture-catalog",
      validUntil: Date.parse(f.now()) + 60000,
      input: { title: "Explicit new request" },
    });
    const continuation = f.l.applyDecision("apply-continuation", {
      decisionId: "continued",
      currentStateHash: "fixture-catalog",
      title: "Continue explicitly",
      description: "Only execute a new run",
      attachTaskId: importedTask.taskId,
      persistence: "attach",
      route,
      reporting: "summary",
    }).value;
    assert.equal(f.l.getTask(importedTask.taskId).kind, "ad_hoc");
    assert.ok(
      f.l.pendingRuns("worker").some((r) => r.runId === continuation.runId),
    );
    assert.ok(
      !f.l.pendingRuns("worker").some((r) => r.runId === importedRun.runId),
    );
    assert.throws(
      () =>
        f.l.claim("claim-old-again", {
          runId: importedRun.runId,
          nodeId: "worker",
          ttlMs: 60000,
        }),
      E("OBSERVE_ONLY"),
    );
  } finally {
    f.close();
  }
});

test("owned delegation is atomic, bounded, capacity-aware and scoped to its task tree", () => {
  const f = fixture();
  try {
    const base = prepare(f.l);
    const templateNode = f.l.getNode("worker");
    f.l.registerNode("capacity-one", { ...templateNode, maxConcurrent: 1 });
    f.l.registerNode("second-node", {
      ...templateNode,
      nodeId: "second",
      maxConcurrent: 1,
    });
    const root = f.l.createTask("bounded-root", {
      title: "Coordinate",
      policy: { maxChildren: 1, maxDescendants: 2, settlementQuietMs: 100 },
    }).value;
    const run = f.l.createRun("bounded-root-run", {
      taskId: root.taskId,
      route: base.run.route,
    }).value;
    const claim = f.l.claim("root-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    const ref = { ...lease(claim.attempt), executionId: "root-instance" };
    f.l.markRunning("root-start", ref);
    assert.throws(
      () => f.l.delegateTask("deadlock-child", { ...ref, title: "Same slot" }),
      E("DELEGATION_DEADLOCK"),
    );
    assert.equal(f.l.allSettled(root.taskId, 0).taskIds.length, 0);
    const child = f.l.delegateTask("child", {
      ...ref,
      title: "Separate executor",
      route: { ...base.run.route, nodeId: "second" },
    }).value;
    assert.throws(
      () =>
        f.l.delegateTask("too-many", {
          ...ref,
          title: "Excess fanout",
          route: { ...base.run.route, nodeId: "second" },
        }),
      E("DELEGATION_LIMIT"),
    );
    assert.throws(
      () => f.l.scopedHistory({ ...ref, taskId: base.task.taskId }),
      E("FORBIDDEN"),
    );
    assert.throws(
      () =>
        f.l.appendScopedReport("foreign-report", {
          ...ref,
          taskId: base.task.taskId,
          title: "Outside",
          body: "Denied",
        }),
      E("FORBIDDEN"),
    );
    f.l.appendScopedReport("child-progress", {
      ...ref,
      taskId: child.task.taskId,
      title: "Context from parent",
      body: "Retained in this child history",
    });
    assert.equal(
      f.l.scopedHistory({ ...ref, taskId: child.task.taskId }).reports.length,
      1,
    );
    assert.equal(f.l.scopedAllSettled(ref).settled, false);
    assert.throws(
      () =>
        f.l.submit("premature-root", {
          ...ref,
          outcome: "success",
          summary: "Not yet",
        }),
      E("CHILDREN_PENDING"),
    );
    const childClaim = f.l.claim("child-claim", {
      runId: child.run.runId,
      nodeId: "second",
      ttlMs: 60000,
    }).value;
    f.l.submit("child-result", {
      ...lease(childClaim.attempt),
      outcome: "success",
      summary: "Child actually settled",
    });
    assert.throws(
      () =>
        f.l.submit("premature-root", {
          ...ref,
          outcome: "success",
          summary: "Not yet",
        }),
      E("CHILDREN_PENDING"),
    );
    f.advance(101);
    f.l.submit("root-result", {
      ...ref,
      outcome: "success",
      summary: "All descendants settled after quiet window",
    });
    assert.equal(f.l.getRun(run.runId).state, "succeeded");
  } finally {
    f.close();
  }
});

test("queue-only notes survive restart and enter exactly one subsequent run without waking work", () => {
  const f = fixture();
  try {
    const base = prepare(f.l);
    const initial = f.l.claim("initial-note-claim", {
      runId: base.run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    f.l.submit("initial-note-result", {
      ...lease(initial.attempt),
      outcome: "success",
      summary: "First run finished",
    });
    const note = f.l.queueTaskNote("queue-note", {
      taskId: base.task.taskId,
      body: "Use this in the next explicitly created run",
      actor: "operator-fixture",
    }).value;
    assert.equal(f.l.snapshot().runs.length, 1);
    assert.equal(f.l.pendingRuns("worker").length, 0);
    f.reopen();
    assert.equal(
      f.l.queueTaskNote("queue-note", {
        taskId: base.task.taskId,
        body: "Use this in the next explicitly created run",
        actor: "operator-fixture",
      }).value.reportId,
      note.reportId,
    );
    const next = f.l.createRun("followup-note", {
      taskId: base.task.taskId,
      route: base.run.route,
    }).value;
    assert.deepEqual(next.contextNotes, [
      { reportId: note.reportId, body: note.body, actor: "operator-fixture" },
    ]);
    const later = f.l.createRun("later-note", {
      taskId: base.task.taskId,
      route: base.run.route,
    }).value;
    assert.equal(later.contextNotes, undefined);
    assert.equal(
      f.l.history(base.task.taskId).reports.filter((r) => r.kind === "note")
        .length,
      1,
    );
  } finally {
    f.close();
  }
});

test("recurring executions get independent delegation budgets and causal settlement views", () => {
  const f = fixture();
  try {
    const base = prepare(f.l),
      node = f.l.getNode("worker");
    f.l.registerNode("other-node", {
      ...node,
      nodeId: "other",
      maxConcurrent: 1,
    });
    const root = f.l.createTask("recurring-root", {
      title: "One stable recurring goal",
      policy: { maxChildren: 1, maxDescendants: 1, settlementQuietMs: 0 },
    }).value;
    let first;
    for (let day = 0; day < 3; day++) {
      const run = f.l.createRun("daily-root-" + day, {
        taskId: root.taskId,
        route: base.run.route,
      }).value;
      const claim = f.l.claim("daily-root-claim-" + day, {
        runId: run.runId,
        nodeId: "worker",
        ttlMs: 60000,
      }).value;
      const ref = { ...lease(claim.attempt), executionId: "day-" + day };
      f.l.markRunning("daily-start-" + day, ref);
      const child = f.l.delegateTask("daily-child-" + day, {
        ...ref,
        title: "This day only",
        route: { ...base.run.route, nodeId: "other" },
      }).value;
      assert.equal(child.task.parentRunId, run.runId);
      assert.equal(child.run.parentRunId, run.runId);
      assert.equal(f.l.allSettled(root.taskId, 0, run.runId).taskIds.length, 1);
      assert.throws(
        () =>
          f.l.delegateTask("daily-extra-" + day, {
            ...ref,
            title: "Over this run budget",
            route: { ...base.run.route, nodeId: "other" },
          }),
        E("DELEGATION_LIMIT"),
      );
      if (first) {
        assert.equal(f.l.allSettled(root.taskId, 0, first).settled, true);
        assert.equal(f.l.allSettled(root.taskId, 0).settled, false);
      }
      const cc = f.l.claim("daily-child-claim-" + day, {
        runId: child.run.runId,
        nodeId: "other",
        ttlMs: 60000,
      }).value;
      f.l.submit("daily-child-result-" + day, {
        ...lease(cc.attempt),
        outcome: "success",
        summary: "This execution settled",
      });
      f.l.submit("daily-root-result-" + day, {
        ...ref,
        outcome: "success",
        summary: "Complete this occurrence",
      });
      first ??= run.runId;
      f.advance(1000);
    }
    assert.equal(
      f.l.snapshot().tasks.filter((t) => t.parentTaskId === root.taskId).length,
      3,
    );
    assert.equal(f.l.history(root.taskId).runs.length, 3);
  } finally {
    f.close();
  }
});

test("known quiescent terminal receipt recovers after lease expiry without replaying execution", () => {
  const f = fixture();
  try {
    const { run } = prepare(f.l);
    const claim = f.l.claim("spool-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
      resources: ["screen"],
    }).value;
    const ref = { ...lease(claim.attempt), executionId: "spooled-instance" };
    f.l.markRunning("spool-start", ref);
    f.l.bindSession("spool-session", { ...ref, sessionId: "spool-session" });
    const settlement = {
      ...ref,
      outcome: "success",
      summary: "Known result before authority write",
      report: { title: "Preserved result", body: "No new model invocation" },
    };
    const proof = {
      readyAt: f.now(),
      sessionId: "spool-session",
      quiescent: true,
      sessionPersisted: true,
    };
    f.advance(1001);
    f.l.recoverExpired("expired");
    assert.throws(
      () => f.l.submit("spool-result", settlement),
      E("LEASE_EXPIRED"),
    );
    const recovered = f.l.recoverSettlement("spool-result", {
      ...settlement,
      recovery: proof,
    });
    assert.equal(recovered.value.state, "succeeded");
    assert.equal(f.l.history(run.taskId).reports.length, 1);
    f.reopen();
    assert.deepEqual(f.l.submit("spool-result", settlement), recovered);
    assert.equal(f.l.history(run.taskId).reports.length, 1);
  } finally {
    f.close();
  }
});

test("terminal journal recovery cannot bypass cancellation or fabricate ready/session evidence", () => {
  const f = fixture();
  try {
    const { run } = prepare(f.l);
    const claim = f.l.claim("proof-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    }).value;
    const ref = { ...lease(claim.attempt), executionId: "proof-instance" };
    f.l.markRunning("proof-start", ref);
    f.l.bindSession("proof-session", { ...ref, sessionId: "proof-session" });
    const settlement = { ...ref, outcome: "success", summary: "Uncommitted" };
    const proof = {
      readyAt: f.now(),
      sessionId: "proof-session",
      quiescent: true,
      sessionPersisted: true,
    };
    assert.throws(
      () =>
        f.l.recoverSettlement("bad-proof", {
          ...settlement,
          recovery: { ...proof, sessionId: "wrong" },
        }),
      E("RECOVERY_PROOF"),
    );
    f.l.cancel("cancel-proof", {
      taskId: run.taskId,
      runId: run.runId,
      reason: "User stopped it",
    });
    assert.throws(
      () =>
        f.l.recoverSettlement("after-cancel", {
          ...settlement,
          recovery: proof,
        }),
      E("CANCELLED"),
    );
    assert.equal(f.l.history(run.taskId).reports.length, 0);
  } finally {
    f.close();
  }
});

test("foreign executor contract preflight validates cloned evidence without authority mutation", () => {
  const f = fixture();
  const executor = TaskLedger.open(":memory:", { role: "executor" });
  try {
    const { task, run } = prepare(f.l);
    const claim = f.l.claim("preflight-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 60000,
    }).value;
    const template = {
      templateId: "preflight",
      version: 1,
      name: "Bound source",
      description: "Fixture",
      inputSchema: {},
      defaults: {},
      resultContract: {},
      resultValidator: "prepared-source",
    };
    const context = {
      task,
      run: { ...run, configuration: { template } },
      attempt: claim.attempt,
      submission: {
        ...lease(claim.attempt),
        outcome: "success",
        summary: "Prepared",
        report: { title: "Report", body: "Source", data: { prepared: false } },
      },
      phase: "executor-preflight",
    };
    executor.registerResultValidator("prepared-source", (cloned) => {
      assert.equal(cloned.phase, "executor-preflight");
      cloned.task.title = "Must not leak mutation";
      return { valid: cloned.submission.report.data.prepared === true };
    });
    assert.throws(
      () => executor.validateResultContract(context),
      E("RESULT_VALIDATION"),
    );
    context.submission.report.data.prepared = true;
    executor.validateResultContract(context);
    assert.equal(context.task.title, "Review a project");
    assert.equal(executor.snapshot().tasks.length, 0);
    assert.equal(f.l.history(task.taskId).reports.length, 0);
    assert.equal(f.l.getRun(run.runId).state, "running");
  } finally {
    executor.close();
    f.close();
  }
});
