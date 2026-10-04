import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { TaskLedger } from "../dist/ledger.js";
const E = (code) => (e) => e.code === code;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reviewed-model-")),
    path = join(dir, "authority.sqlite");
  let l = TaskLedger.open(path, { nodeId: "authority", role: "planner" });
  const node = {
    nodeId: "executor",
    roles: ["executor"],
    capabilities: [],
    models: [{ provider: "synthetic", model: "offline", reasoningEfforts: [] }],
    workspaceIds: [],
    enabled: true,
    lastSeenAt: new Date().toISOString(),
  };
  l.registerNode("node", node);
  return {
    get l() {
      return l;
    },
    path,
    route: {
      nodeId: "executor",
      provider: "synthetic",
      model: "offline",
      requiredCapabilities: [],
    },
    reopen() {
      l.close();
      l = TaskLedger.open(path, { nodeId: "authority", role: "planner" });
    },
    close() {
      l.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const template = {
  templateId: "test-fixed",
  version: 1,
  name: "fixed",
  description: "",
  defaults: {},
  inputSchema: { type: "object" },
  resultContract: {
    type: "object",
    properties: { report: { type: "object" } },
    required: ["report"],
  },
};
const lease = (a) => ({
  runId: a.runId,
  attemptId: a.attemptId,
  nodeId: a.nodeId,
  fence: a.fence,
});
test("new task/run persist reviewed fields, fixed template and immutable report references", () => {
  const f = fixture();
  try {
    const task = f.l.createTask("task", {
      title: "Original intent",
      goal: "A result",
      priorityOverride: "high",
    }).value;
    assert.equal(task.priority, "high");
    assert.equal(task.revision, 1);
    assert.equal(task.intentRevision, 1);
    assert.equal(task.admissionState, undefined);
    assert.equal(task.admissionRevision, undefined);
    assert.equal(task.userImmediacy, undefined);
    const note = f.l.queueTaskNote("note", {
      taskId: task.taskId,
      body: "Fixed context",
      actor: "host-test",
    }).value;
    const run = f.l.createRun("run", {
      taskId: task.taskId,
      route: f.route,
      configuration: { template, input: {}, reporting: "none" },
    }).value;
    assert.deepEqual(run.configuration.templateRef, {
      templateId: template.templateId,
      version: 1,
    });
    assert.equal(run.configuration.template, undefined);
    assert.deepEqual(run.contextNotes, [note.reportId]);
    f.l.updateTask("edit", {
      taskId: task.taskId,
      expectedRevision: 1,
      title: "Future intent",
    });
    assert.equal(f.l.getRun(run.runId).intentSnapshot.title, "Original intent");
    assert.equal(f.l.getTask(task.taskId).intentRevision, 2);
    f.reopen();
    assert.equal(
      f.l.executionContext(run.runId).reports[0].body,
      "Fixed context",
    );
    assert.deepEqual(f.l.executionContext(run.runId).template, template);
    const db = new DatabaseSync(f.path, { readOnly: true });
    const raw = JSON.parse(
      db
        .prepare("SELECT data FROM entities WHERE kind='run' AND id=?")
        .get(run.runId).data,
    );
    assert.equal(raw.sessionIds, undefined);
    assert.equal(raw.occurrenceId, undefined);
    assert.equal(raw.outcome, undefined);
    assert.equal(raw.validation, undefined);
    assert.equal(raw.observationOnly, undefined);
    db.close();
  } finally {
    f.close();
  }
});
test("partial is terminal execution state with independent review; sessions derive from attempt", () => {
  const f = fixture();
  try {
    const task = f.l.createTask("task", { title: "Partial task" }).value;
    const run = f.l.createRun("run", {
      taskId: task.taskId,
      route: f.route,
    }).value;
    const claim = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "executor",
      ttlMs: 60000,
    }).value;
    assert.deepEqual(claim.executionContext.reports, []);
    const ref = lease(claim.attempt);
    f.l.bindSession("bind", { ...ref, sessionId: "internal-session" });
    const result = f.l.submit("result", {
      ...ref,
      outcome: "partial",
      summary: "Only some work completed",
      report: { title: "Partial", body: "Missing source" },
    }).value;
    assert.equal(result.state, "partial");
    assert.equal(result.reviewStatus, "pending_user");
    assert.equal(result.outcome, undefined);
    assert.equal(result.validation, undefined);
    assert.deepEqual(f.l.getRun(run.runId).sessionIds, ["internal-session"]);
    assert.equal(f.l.getTask(task.taskId).state, "waiting");
    f.reopen();
    assert.equal(f.l.getRun(run.runId).state, "partial");
    assert.equal(f.l.snapshot().attempts[0].nodeId, "executor");
    f.l.reviewRun("review", {
      runId: run.runId,
      decision: "accepted",
      reason: "Reviewed partial result",
    });
    assert.equal(f.l.getRun(run.runId).state, "partial");
  } finally {
    f.close();
  }
});
test("pinned template validation stays effective and conflicting version reuse rolls back", () => {
  const f = fixture();
  try {
    const task = f.l.createTask("task", { title: "Template task" }).value;
    const run = f.l.createRun("run", {
      taskId: task.taskId,
      route: f.route,
      configuration: { template, input: {} },
    }).value;
    const claim = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "executor",
      ttlMs: 60000,
    }).value;
    assert.throws(
      () =>
        f.l.submit("bad", {
          ...lease(claim.attempt),
          outcome: "failure",
          summary: "No report",
        }),
      E("SCHEMA_VALIDATION"),
    );
    assert.throws(
      () =>
        f.l.validateResultContract({
          ...claim,
          phase: "executor-preflight",
          executionContext: undefined,
          submission: {
            ...lease(claim.attempt),
            outcome: "failure",
            summary: "No report",
          },
        }),
      E("CONTEXT_MISSING"),
    );
    assert.throws(
      () =>
        f.l.createRun("conflict", {
          taskId: task.taskId,
          configuration: {
            template: { ...template, name: "Overwritten" },
            input: {},
          },
        }),
      E("CONFLICT"),
    );
    assert.equal(f.l.snapshot().runs.length, 1);
  } finally {
    f.close();
  }
});
test("candidate and imported historyOnly are never dispatchable", () => {
  const f = fixture();
  try {
    const task = f.l.createTask("task", { title: "Candidate" }).value;
    f.l.updateTask("candidate", {
      taskId: task.taskId,
      expectedRevision: 1,
      state: "candidate",
    });
    assert.throws(
      () => f.l.createRun("blocked", { taskId: task.taskId, route: f.route }),
      E("CLOSED"),
    );
    assert.throws(
      () =>
        f.l.updateTask("stale", {
          taskId: task.taskId,
          expectedRevision: 1,
          title: "bad",
        }),
      E("CONFLICT"),
    );
    const source = {
      schemaVersion: "1",
      generatedAt: new Date().toISOString(),
      source: {
        kind: "explicit-import",
        label: "synthetic historical fact",
        observedAt: new Date().toISOString(),
        staleAfterMs: 60000,
      },
      tasks: [
        {
          taskId: "old",
          title: "Old",
          description: "",
          kind: "observed",
          state: "completed",
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          tags: [],
        },
      ],
      runs: [
        {
          runId: "old-run",
          taskId: "old",
          state: "succeeded",
          sessionIds: ["legacy-original"],
          configuration: null,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
        },
      ],
      reports: [],
      artifacts: [],
      templates: [],
      events: [],
    };
    f.l.importSnapshot("import", source);
    const historical = f.l.getRun("old-run");
    assert.equal(historical.historyOnly, true);
    assert.deepEqual(historical.sessionIds, ["legacy-original"]);
    assert.throws(
      () => f.l.createRun("history", { taskId: "old", route: f.route }),
      E("OBSERVE_ONLY"),
    );
  } finally {
    f.close();
  }
});
test("finishing an older intent does not complete the edited current task", () => {
  const f = fixture();
  try {
    const task = f.l.createTask("task", { title: "Old goal" }).value;
    const run = f.l.createRun("run", {
      taskId: task.taskId,
      route: f.route,
    }).value;
    f.l.updateTask("edit", {
      taskId: task.taskId,
      expectedRevision: 1,
      title: "New goal",
    });
    const claim = f.l.claim("claim", {
      runId: run.runId,
      nodeId: "executor",
      ttlMs: 60000,
    }).value;
    f.l.submit("result", {
      ...lease(claim.attempt),
      outcome: "success",
      summary: "Old goal done",
    });
    assert.equal(f.l.getRun(run.runId).state, "succeeded");
    assert.equal(f.l.getTask(task.taskId).state, "waiting");
    assert.equal(f.l.getRun(run.runId).intentSnapshot.title, "Old goal");
    assert.equal(f.l.getTask(task.taskId).title, "New goal");
  } finally {
    f.close();
  }
});

// These paths mirror the real management form, including its optional empty goal.
for (const state of ["running", "completed"])
  test(`priority-only form edit preserves ${state} task intent and state`, async () => {
    const { commandFromForm } = await import(
      "../../../dashboard/public/management-model.js"
    );
    const f = fixture();
    try {
      const task = f.l.createTask("task", {
        title: "Stable task",
        description: "Stable description",
      }).value;
      const run = f.l.createRun("run", {
        taskId: task.taskId,
        route: f.route,
      }).value;
      const claim = f.l.claim("claim", {
        runId: run.runId,
        nodeId: "executor",
        ttlMs: 60000,
      }).value;
      if (state === "completed")
        f.l.submit("done", {
          ...lease(claim.attempt),
          outcome: "success",
          summary: "Done",
        });
      const before = f.l.getTask(task.taskId);
      const command = commandFromForm(
        "task",
        {
          title: before.title,
          description: before.description,
          goal: "",
          acceptanceCriteria: "[]",
          priorityOverride: "high",
          state: "",
        },
        before,
      );
      const result = f.l.updateTask("priority", command.data).value;
      assert.equal(result.priority, "high");
      assert.equal(result.state, state);
      assert.equal(result.intentRevision, before.intentRevision);
      assert.equal(result.revision, before.revision + 1);
      f.reopen();
      assert.equal(f.l.getTask(task.taskId).state, state);
      assert.equal(
        f.l.getTask(task.taskId).intentRevision,
        before.intentRevision,
      );
    } finally {
      f.close();
    }
  });
test("Task API rejects invalid description and tags on create/update without durable mutation", () => {
  const f = fixture();
  try {
    const task = f.l.createTask("task", { title: "Good task" }).value;
    const invalid = [
      { description: {} },
      { description: null },
      { description: 7 },
      { tags: {} },
      { tags: null },
      { tags: ["good", false] },
      { tags: Array(129).fill("x") },
      { tags: ["x".repeat(201)] },
    ];
    for (const [n, patch] of invalid.entries()) {
      assert.throws(
        () => f.l.createTask(`bad-create-${n}`, { title: "Bad", ...patch }),
        E("INVALID"),
      );
      assert.throws(
        () =>
          f.l.updateTask(`bad-update-${n}`, {
            taskId: task.taskId,
            expectedRevision: task.revision,
            ...patch,
          }),
        E("INVALID"),
      );
    }
    assert.equal(f.l.snapshot().tasks.length, 1);
    assert.deepEqual(f.l.getTask(task.taskId).tags, []);
    assert.equal(f.l.getTask(task.taskId).description, "");
    assert.equal(f.l.getTask(task.taskId).revision, 1);
  } finally {
    f.close();
  }
});
