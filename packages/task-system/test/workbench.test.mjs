import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskLedger } from "../dist/ledger.js";
import { Workbench } from "../dist/workbench.js";
import { validateCriteria } from "../dist/workbench-contracts.js";
const E = (code) => (error) => error.code === code;
function fixture(options = {}, workbenchOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-workbench-"));
  const path = join(dir, "authority.sqlite");
  let now = Date.parse("2026-10-04T18:00:00Z");
  let ledger = TaskLedger.open(path, { ...options, now: () => now });
  let workbench = new Workbench(ledger, workbenchOptions);
  let sequence = 0;
  return {
    dir,
    path,
    get l() {
      return ledger;
    },
    get w() {
      return workbench;
    },
    advance() {
      now += 1000;
    },
    manage(operation, data) {
      return workbench.manage(`manage-${++sequence}`, operation, data).value;
    },
    reopen(nextOptions = options) {
      ledger.close();
      ledger = TaskLedger.open(path, { ...nextOptions, now: () => now });
      workbench = new Workbench(ledger, workbenchOptions);
    },
    close() {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function project(f, projectId = "p") {
  return f.manage("create_project", {
    projectId,
    title: "Synthetic project",
    goal: "Exercise the authority database",
    state: "active",
  });
}
function task(f, taskId = "t", extra = {}) {
  return f.l.createTask(`task-${taskId}`, {
    taskId,
    title: "Synthetic work",
    ...extra,
  }).value;
}
function backlog(f, backlogId = "b", extra = {}) {
  return f.manage("create_backlog", {
    backlogId,
    projectId: "p",
    title: "Demand, not a container",
    ...extra,
  });
}
const manual = (criterionId = "check") => ({
  criterionId,
  description: "Review the demonstration",
  kind: "manual_check",
  requiredEvidence: "Describe the reviewed evidence",
});
function complete(f, taskId = "t") {
  f.l.registerNode(`node-${taskId}`, {
    nodeId: "worker",
    roles: ["executor"],
    capabilities: ["text"],
    models: [{ provider: "test", model: "model", reasoningEfforts: ["low"] }],
    workspaceIds: [],
    enabled: true,
    lastSeenAt: "2026-10-04T18:00:00Z",
  });
  const run = f.l.createRun(`run-${taskId}`, {
    taskId,
    route: {
      nodeId: "worker",
      provider: "test",
      model: "model",
      requiredCapabilities: ["text"],
    },
  }).value;
  const attempt = f.l.claim(`claim-${taskId}`, {
    runId: run.runId,
    nodeId: "worker",
    ttlMs: 60_000,
  }).value.attempt;
  f.l.submit(`submit-${taskId}`, {
    runId: run.runId,
    attemptId: attempt.attemptId,
    nodeId: "worker",
    fence: attempt.fence,
    outcome: "success",
    summary: "Synthetic unit-test execution",
  });
  return { run, attempt };
}

test("relational management entities, M:N associations and shared receipts persist across file reopen", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.w.snapshot().projects, []);
    const input = {
      projectId: "p",
      title: "Synthetic project",
      goal: "Test persistence",
      state: "active",
    };
    const receipt = f.w.manage("stable-command", "create_project", input);
    project(f, "p2");
    f.manage("create_domain", { domainId: "d1", title: "Software" });
    f.manage("create_domain", { domainId: "d2", title: "Research" });
    for (const [domainId, projectId] of [
      ["d1", "p"],
      ["d2", "p"],
      ["d1", "p2"],
    ])
      f.manage("link_domain_project", { domainId, projectId });
    task(f);
    task(f, "t2");
    backlog(f);
    backlog(f, "b2", { projectId: "p2" });
    for (const [backlogId, taskId] of [
      ["b", "t"],
      ["b", "t2"],
      ["b2", "t"],
    ])
      f.manage("link_backlog_task", { backlogId, taskId });
    const snapshot = f.w.snapshot();
    f.reopen();
    assert.deepEqual(f.w.snapshot(), snapshot);
    assert.deepEqual(
      f.w.manage("stable-command", "create_project", input),
      receipt,
    );
    assert.throws(
      () =>
        f.w.manage("stable-command", "create_project", {
          ...input,
          title: "Changed",
        }),
      E("CONFLICT"),
    );
    assert.throws(
      () =>
        f.l.createTask("stable-command", { title: "Key reused by runtime" }),
      E("CONFLICT"),
    );
    const db = new DatabaseSync(f.path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO wb_backlog_tasks(backlog_id,task_id) VALUES(?,?)",
            )
            .run("b", "missing"),
        /FOREIGN KEY constraint/,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO wb_backlog_tasks(backlog_id,task_id) VALUES(?,?)",
            )
            .run("b", "t"),
        /UNIQUE constraint/,
      );
      const cols = db
        .prepare("PRAGMA table_info(wb_backlogs)")
        .all()
        .map((x) => x.name);
      assert.ok(cols.includes("project_id") && cols.includes("priority"));
      assert.ok(!cols.includes("data"));
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM wb_backlog_tasks").get().n,
        3,
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

test("management input is bounded, revision checked and rollback leaves no partial records", () => {
  const f = fixture();
  try {
    const p = project(f);
    f.advance();
    const next = f.manage("update_project", {
      projectId: "p",
      expectedRevision: 1,
      title: "Revised title",
    });
    assert.equal(next.revision, 2);
    assert.equal(next.createdAt, p.createdAt);
    assert.notEqual(next.updatedAt, p.updatedAt);
    assert.throws(
      () =>
        f.manage("update_project", {
          projectId: "p",
          expectedRevision: 1,
          title: "Lost update",
        }),
      E("CONFLICT"),
    );
    assert.throws(
      () =>
        f.manage("update_project", {
          projectId: "p",
          title: "Missing revision",
        }),
      E("INVALID"),
    );
    assert.throws(
      () =>
        f.manage("create_backlog", {
          projectId: "missing",
          title: "Broken parent",
        }),
      E("NOT_FOUND"),
    );
    assert.throws(
      () => f.manage("create_project", { title: "Untitled", state: "active" }),
      E("INVALID"),
    );
    assert.throws(
      () => f.manage("create_project", { title: "Spoofed", actor: "owner" }),
      E("INVALID"),
    );
    assert.throws(
      () =>
        f.manage("create_project", {
          title: "Too big",
          description: "x".repeat(256_000),
        }),
      E("TOO_LARGE"),
    );
    assert.throws(
      () =>
        f.manage("create_backlog", {
          backlogId: "empty",
          projectId: "p",
          title: "Cannot finish without criteria",
          state: "completed",
        }),
      E("CONDITION_UNMET"),
    );
    assert.equal(f.w.snapshot().backlogs.length, 0);
    assert.equal(f.w.getProject("p").title, "Revised title");
    project(f, "p2");
    backlog(f);
    assert.throws(
      () =>
        f.manage("update_backlog", {
          backlogId: "b",
          expectedRevision: 1,
          projectId: "p2",
        }),
      E("INVALID"),
    );
  } finally {
    f.close();
  }
});

test("priority follows all linked demands with explicit override first and no copied Task identity", () => {
  const f = fixture();
  try {
    project(f);
    task(f);
    backlog(f, "low", { priority: "low" });
    backlog(f, "urgent", { priority: "urgent" });
    assert.equal(f.w.effectivePriority("t"), "normal");
    f.manage("link_backlog_task", { backlogId: "low", taskId: "t" });
    assert.equal(f.w.effectivePriority("t"), "low");
    f.manage("link_backlog_task", { backlogId: "urgent", taskId: "t" });
    assert.equal(f.l.getTask("t").priority, "urgent");
    f.l.updateTask("override", {
      taskId: "t",
      expectedRevision: 1,
      priorityOverride: "normal",
    });
    assert.equal(f.w.effectivePriority("t"), "normal");
    f.manage("update_backlog", {
      backlogId: "urgent",
      expectedRevision: 1,
      priority: "high",
    });
    assert.equal(f.w.effectivePriority("t"), "normal");
    f.l.updateTask("clear-override", {
      taskId: "t",
      expectedRevision: 2,
      priorityOverride: null,
    });
    assert.equal(f.w.effectivePriority("t"), "high");
    f.reopen();
    assert.equal(f.l.effectivePriority("t"), "high");
    f.manage("unlink_backlog_task", { backlogId: "urgent", taskId: "t" });
    assert.equal(f.w.effectivePriority("t"), "low");
    f.manage("unlink_backlog_task", { backlogId: "low", taskId: "t" });
    assert.equal(f.w.effectivePriority("t"), "normal");
    assert.equal(f.l.snapshot().tasks.length, 1);
    assert.throws(
      () =>
        f.manage("link_backlog_task", { backlogId: "low", taskId: "absent" }),
      E("NOT_FOUND"),
    );
  } finally {
    f.close();
  }
});

test("empty criteria stay pending, trusted manual check records evidence without impersonating acceptance", () => {
  const f = fixture({}, { allowManualChecks: true });
  try {
    project(f);
    backlog(f);
    assert.equal(f.w.getBacklog("b").conditionStatus, "pending");
    const b = f.manage("update_backlog", {
      backlogId: "b",
      expectedRevision: 1,
      acceptanceCriteria: [manual()],
    });
    const data = {
      ownerType: "backlog",
      ownerId: "b",
      expectedRevision: b.revision,
      criterionId: "check",
      observedStatus: "met",
      note: "Checked the synthetic demonstration",
    };
    assert.throws(
      () => new Workbench(f.l).manage("forged-manual", "check_criterion", data),
      E("FORBIDDEN"),
    );
    assert.throws(
      () => f.manage("check_criterion", { ...data, actor: "the user" }),
      E("INVALID"),
    );
    const check = f.manage("check_criterion", data);
    assert.equal(check.source.kind, "management-check");
    assert.equal(check.source.role, "both");
    const checked = f.w.getBacklog("b");
    assert.equal(checked.state, "completed");
    assert.equal(checked.conditionStatus, "met");
    assert.ok(!("acceptance" in checked));
    assert.equal(checked.revision, 2, "checking is not a content edit");
    f.reopen();
    assert.equal(f.w.getBacklog("b").state, "completed");
    f.manage("update_backlog", {
      backlogId: "b",
      expectedRevision: 2,
      acceptanceCriteria: [
        { ...manual(), description: "A different requirement" },
      ],
    });
    assert.equal(f.w.getBacklog("b").state, "open");
    assert.equal(
      f.w.getBacklog("b").acceptanceCriteria[0].observedStatus,
      "pending",
    );
    assert.equal(
      f.w.snapshot().criterionChecks.length,
      1,
      "old check is retained, not transferred",
    );
  } finally {
    f.close();
  }
});

test("task completion criteria read runtime truth at a fixed intent revision, acceptance is separate", () => {
  const f = fixture();
  try {
    project(f);
    task(f);
    const criterion = {
      criterionId: "done",
      description: "Finish this work",
      kind: "task_completion",
      targetRef: { type: "task", id: "t", revision: 1 },
    };
    backlog(f, "completion", { acceptanceCriteria: [criterion] });
    backlog(f, "acceptance", {
      acceptanceCriteria: [{ ...criterion, kind: "task_acceptance" }],
    });
    assert.equal(f.w.getBacklog("completion").conditionStatus, "pending");
    assert.throws(
      () =>
        f.manage("check_criterion", {
          ownerType: "backlog",
          ownerId: "completion",
          expectedRevision: 1,
          criterionId: "done",
          observedStatus: "met",
        }),
      E("INVALID"),
    );
    complete(f);
    assert.equal(f.w.getBacklog("completion").state, "completed");
    assert.equal(f.w.getBacklog("acceptance").conditionStatus, "unknown");
    f.l.updateTask("new-intent", {
      taskId: "t",
      expectedRevision: 1,
      goal: "New goal",
    });
    assert.equal(f.w.getBacklog("completion").conditionStatus, "unknown");
    assert.equal(f.w.getBacklog("completion").state, "open");
    assert.throws(
      () => backlog(f, "stale", { acceptanceCriteria: [criterion] }),
      E("CONFLICT"),
    );
  } finally {
    f.close();
  }
});

test("criteria reject fabricated projections, missing targets and unbounded or duplicate definitions", () => {
  const f = fixture();
  try {
    project(f);
    assert.throws(
      () => validateCriteria([{ ...manual(), observedStatus: "met" }]),
      E("INVALID"),
    );
    assert.throws(() => validateCriteria([manual(), manual()]), E("INVALID"));
    assert.throws(
      () => validateCriteria(Array.from({ length: 129 }, () => manual())),
      E("INVALID"),
    );
    assert.throws(
      () => validateCriteria([{ ...manual(), kind: "task_completion" }]),
      E("INVALID"),
    );
    assert.throws(
      () =>
        backlog(f, "bad", {
          acceptanceCriteria: [
            {
              ...manual(),
              kind: "task_completion",
              targetRef: { type: "task", id: "missing", revision: 1 },
            },
          ],
        }),
      E("NOT_FOUND"),
    );
    const generated = validateCriteria([{ description: "Human observation" }]);
    assert.equal(generated[0].kind, "manual_check");
    assert.ok(generated[0].criterionId);
    assert.throws(
      () =>
        f.manage("update_project", {
          projectId: "p",
          expectedRevision: 1,
          state: "completed",
        }),
      E("INVALID"),
    );
  } finally {
    f.close();
  }
});

test("project-workspace M:N bindings respect readiness, revision and one default per node without changing policy", () => {
  const f = fixture();
  try {
    project(f);
    project(f, "p2");
    task(f, "t", { policy: { allowedWorkspaceIds: ["w1"] } });
    const originalPolicy = f.l.getTask("t").policy;
    for (const [workspaceId, nodeId, state] of [
      ["w1", "n1", "ready"],
      ["w2", "n1", "ready"],
      ["w3", "n2", "ready"],
      ["w4", "n1", "planned"],
    ])
      f.l.registerWorkspace(`workspace-${workspaceId}`, {
        workspaceId,
        nodeId,
        path: `/synthetic/${workspaceId}`,
        name: workspaceId,
        state,
        createdAt: "2026-10-04T18:00:00Z",
      });
    f.manage("link_project_workspace", {
      projectId: "p",
      workspaceId: "w1",
      isDefault: true,
    });
    f.manage("link_project_workspace", {
      projectId: "p2",
      workspaceId: "w1",
      isDefault: true,
    });
    f.manage("link_project_workspace", {
      projectId: "p",
      workspaceId: "w3",
      isDefault: true,
    });
    assert.throws(
      () =>
        f.manage("link_project_workspace", {
          projectId: "p",
          workspaceId: "w2",
          isDefault: true,
        }),
      E("CONFLICT"),
    );
    assert.throws(
      () =>
        f.manage("link_project_workspace", {
          projectId: "p",
          workspaceId: "w4",
        }),
      E("INVALID"),
    );
    assert.throws(
      () =>
        f.manage("link_project_workspace", {
          projectId: "p",
          workspaceId: "w1",
          isDefault: false,
        }),
      E("INVALID"),
    );
    f.manage("link_project_workspace", {
      projectId: "p",
      workspaceId: "w1",
      expectedRevision: 1,
      isDefault: false,
    });
    f.manage("link_project_workspace", {
      projectId: "p",
      workspaceId: "w2",
      isDefault: true,
    });
    assert.deepEqual(f.l.getTask("t").policy, originalPolicy);
    assert.equal(f.w.snapshot().projectWorkspaces.length, 4);
    assert.throws(
      () =>
        f.manage("unlink_project_workspace", {
          projectId: "p",
          workspaceId: "w1",
          expectedRevision: 1,
        }),
      E("CONFLICT"),
    );
    f.manage("unlink_project_workspace", {
      projectId: "p",
      workspaceId: "w1",
      expectedRevision: 2,
    });
  } finally {
    f.close();
  }
});

test("artifact registry retains fixed native/git versions, live references and full provenance without copying bytes", () => {
  const f = fixture();
  try {
    project(f);
    task(f);
    task(f, "t2");
    const report = f.l.appendReport("report", {
      taskId: "t",
      title: "Synthetic report",
      body: "Testing metadata only",
    }).value;
    const initial = f.manage("register_artifact", {
      artifactId: "a1",
      materialId: "material",
      name: "Source version",
      reportId: report.reportId,
      contentRef: {
        kind: "native",
        provider: "drive",
        fileId: "stable-file",
        version: "1",
      },
    });
    const later = f.manage("register_artifact", {
      artifactId: "a2",
      materialId: "material",
      name: "Revised source",
      contentRef: {
        kind: "git",
        repository: "https://example.invalid/repository",
        commit: "a".repeat(40),
        path: "src/example.ts",
      },
    });
    const live = f.manage("register_artifact", {
      artifactId: "live",
      name: "Current site",
      contentRef: { kind: "live", url: "https://example.invalid/demo" },
    });
    assert.equal(initial.taskId, "t");
    assert.equal(initial.versionStatus, "pinned");
    assert.equal(initial.availability, "unknown");
    assert.equal(later.sha256, undefined);
    assert.equal(later.bytes, undefined);
    assert.equal(live.versionStatus, "live");
    f.manage("link_artifact", {
      artifactId: "a2",
      kind: "predecessor",
      targetId: "a1",
      action: "derived",
    });
    f.manage("link_artifact", {
      artifactId: "a1",
      kind: "task",
      targetId: "t2",
      action: "modified",
      context: "A second task worked on this original version",
    });
    f.manage("link_artifact", {
      artifactId: "a1",
      kind: "project",
      targetId: "p",
      context: "Project evidence",
    });
    assert.throws(
      () =>
        f.manage("link_artifact", {
          artifactId: "a1",
          kind: "predecessor",
          targetId: "a2",
          action: "derived",
        }),
      E("INVALID"),
    );
    assert.throws(
      () =>
        f.manage("register_artifact", {
          name: "Wrong ownership",
          taskId: "t2",
          reportId: report.reportId,
          contentRef: initial.contentRef,
        }),
      E("INVALID"),
    );
    assert.throws(
      () =>
        f.manage("register_artifact", {
          name: "Branch is mutable",
          contentRef: {
            kind: "git",
            repository: "repo",
            commit: "main",
            path: "file",
          },
        }),
      E("INVALID"),
    );
    assert.throws(
      () =>
        f.manage("register_artifact", {
          name: "Credentials",
          contentRef: {
            kind: "live",
            url: "https://user:secret@example.invalid",
          },
        }),
      E("INVALID"),
    );
    const snapshot = f.w.snapshot();
    f.reopen();
    assert.deepEqual(f.w.snapshot(), snapshot);
    assert.equal(
      f.w.getArtifact("a1").taskId,
      "t",
      "later modifications do not overwrite original provenance",
    );
    assert.equal(
      f.l.snapshot().artifacts.length,
      0,
      "catalog references never impersonate finalized legacy attachments",
    );
    assert.ok(
      readdirSync(f.dir).every((name) => name.startsWith("authority.sqlite")),
      "metadata registration writes no content files",
    );
  } finally {
    f.close();
  }
});

test("artifact execution provenance rejects cross-task and cross-report source facts", () => {
  const f = fixture();
  try {
    task(f);
    task(f, "other");
    const { run, attempt } = complete(f);
    f.manage("register_artifact", {
      artifactId: "a",
      name: "Reference",
      contentRef: {
        kind: "object",
        provider: "archive",
        objectId: "existing-object",
        version: "1",
      },
    });
    assert.throws(
      () =>
        f.manage("link_artifact", {
          artifactId: "a",
          kind: "task",
          targetId: "other",
          action: "produced",
          runId: run.runId,
        }),
      E("INVALID"),
    );
    assert.throws(
      () =>
        f.manage("link_artifact", {
          artifactId: "a",
          kind: "task",
          targetId: "t",
          action: "produced",
          attemptId: attempt.attemptId,
        }),
      E("INVALID"),
    );
    const relation = f.manage("link_artifact", {
      artifactId: "a",
      kind: "task",
      targetId: "t",
      action: "produced",
      runId: run.runId,
      attemptId: attempt.attemptId,
    });
    assert.equal(relation.runId, run.runId);
    assert.equal(relation.attemptId, attempt.attemptId);
  } finally {
    f.close();
  }
});

test("skill evidence and milestone scopes are persisted, cyclic conditions rejected, met does not mean accepted", () => {
  const f = fixture({}, { allowManualChecks: true });
  try {
    project(f);
    project(f, "p2");
    task(f);
    backlog(f);
    backlog(f, "other", { projectId: "p2" });
    f.manage("create_skill", {
      skillId: "s",
      title: "Testing",
      summary: "Evidence of practice",
      methodNotes: "One optional aspect",
    });
    f.manage("link_skill_project", {
      skillId: "s",
      projectId: "p",
      context: "Practiced here",
    });
    const report = f.l.appendReport("report", {
      taskId: "t",
      title: "Practice",
      body: "Synthetic evidence",
    }).value;
    f.manage("link_skill_report", { skillId: "s", reportId: report.reportId });
    f.manage("create_milestone", {
      milestoneId: "m1",
      projectId: "p",
      title: "Demonstration",
      state: "active",
      conditions: [manual()],
    });
    f.manage("link_milestone_backlog", { milestoneId: "m1", backlogId: "b" });
    f.manage("link_milestone_task", { milestoneId: "m1", taskId: "t" });
    assert.throws(
      () =>
        f.manage("link_milestone_backlog", {
          milestoneId: "m1",
          backlogId: "other",
        }),
      E("INVALID"),
    );
    f.manage("check_criterion", {
      ownerType: "milestone",
      ownerId: "m1",
      expectedRevision: 1,
      criterionId: "check",
      observedStatus: "met",
      note: "Reviewed",
    });
    assert.equal(f.w.getMilestone("m1").state, "awaiting_review");
    assert.ok(!("acceptance" in f.w.getMilestone("m1")));
    f.manage("create_milestone", {
      milestoneId: "m2",
      projectId: "p",
      title: "Dependent",
      conditions: [
        {
          criterionId: "m1-done",
          description: "M1 approved",
          kind: "milestone_completion",
          targetRef: { type: "milestone", id: "m1", revision: 1 },
        },
      ],
    });
    assert.equal(
      f.w.getMilestone("m2").conditionStatus,
      "unknown",
      "conditions met cannot stand in for personal acceptance",
    );
    assert.throws(
      () =>
        f.manage("update_milestone", {
          milestoneId: "m1",
          expectedRevision: 1,
          conditions: [
            {
              criterionId: "m2-done",
              description: "Cycle",
              kind: "milestone_completion",
              targetRef: { type: "milestone", id: "m2", revision: 1 },
            },
          ],
        }),
      E("INVALID"),
    );
    assert.equal(f.w.getMilestone("m1").revision, 1);
    const snapshot = f.w.snapshot();
    f.reopen();
    assert.deepEqual(f.w.snapshot(), snapshot);
  } finally {
    f.close();
  }
});

test("read-only and executor contexts cannot manage or promote manual checks", () => {
  const f = fixture();
  try {
    project(f);
    f.reopen({ role: "executor", nodeId: "worker" });
    assert.equal(f.w.snapshot().projects.length, 1);
    assert.throws(
      () =>
        f.manage("create_domain", { title: "Unauthorized", actor: "planner" }),
      E("FORBIDDEN"),
    );
    f.reopen({ readOnly: true });
    assert.equal(f.w.snapshot().projects.length, 1);
    assert.throws(
      () => f.manage("create_domain", { title: "Read-only" }),
      E("READ_ONLY"),
    );
  } finally {
    f.close();
  }
});

test("read-only snapshot is available before any management schema has been initialized", () => {
  const f = fixture();
  try {
    f.reopen({ readOnly: true });
    assert.deepEqual(f.w.snapshot().projects, []);
  } finally {
    f.close();
  }
});
