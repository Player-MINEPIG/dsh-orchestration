import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { ToolCallId, LlmError, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createNativeHarness } from "./native-harness.mjs";
import { attachProjectSessionHost } from "../../packages/task-system/test/fixtures/project-session-host.mjs";
let serial = 0;
async function tool(h, agent, args) {
  return h.ctx.tools.execute({
    name: "task_execution_status",
    arguments: args,
    callId: ToolCallId("reconcile-" + ++serial),
    agent,
    signal: new AbortController().signal,
  });
}
async function fixture(
  script = [
    () => {
      throw new LlmError("private credential sentinel", "AUTH", {
        status: 401,
      });
    },
  ],
  { wait = true } = {},
) {
  const h = await createNativeHarness({
    executionRoot: true,
    config: {
      role: "both",
      schedulerEnabled: false,
      autoExecute: false,
      projectAgentOptions: { provider: "test-offline", model: "script" },
    },
    script,
  });
  await attachProjectSessionHost(h);
  const projects = h.ctx.taskSystem.projects,
    ledger = h.ledger;
  projects.saveSettings({ root: join(h.dir, "projects"), expectedRevision: 0 });
  const project = await projects.create({
      commandId: "reconcile-project",
      title: "Native reconciliation",
      goal: "Only inspect the original attempt",
    }),
    sessionId = projects.placementProject(project.projectId).session;
  ledger.registerNode("node", {
    nodeId: "local",
    roles: ["both"],
    enabled: true,
    models: [
      { provider: "test-offline", model: "script", reasoningEfforts: [] },
    ],
    workspaceIds: [],
    capabilities: [],
    maxConcurrent: 2,
  });
  const task = ledger.createTask("task", { title: "Failed native task" }).value;
  projects.linkTask(sessionId, task.taskId);
  const run = ledger.createRun("run", {
    taskId: task.taskId,
    route: {
      nodeId: "local",
      provider: "test-offline",
      model: "script",
      requiredCapabilities: [],
    },
  }).value;
  const claim = ledger.claim("claim", {
    runId: run.runId,
    nodeId: "local",
    ttlMs: 10000,
  }).value;
  const execution = h.ctx.taskSystem.native.execute(claim);
  void execution.catch(() => {});
  if (wait) await execution;
  else await until(() => h.adapter.requests.length > 0);
  const resolved = await h.ctx.sessionController.resolveAgent(
    SessionId(sessionId),
  );
  assert.equal(resolved.error, undefined);
  return {
    ...h,
    projects,
    task,
    run,
    claim,
    project,
    sessionId,
    execution,
    pm: resolved.agent,
  };
}
async function until(read) {
  const deadline = Date.now() + 10000;
  while (!read()) {
    assert.ok(Date.now() < deadline, "Native coordinator did not finish");
    await new Promise((done) => setTimeout(done, 10));
  }
}

test("a real bound PM inspects and reconciles its exact zero-effect AUTH attempt through formal tools; durable replay survives later session changes", async () => {
  const h = await fixture();
  try {
    assert.equal(h.ledger.getRun(h.run.runId).state, "uncertain");
    const target = h.ledger.sessionMessageTargets(h.task.taskId)[0];
    assert.equal(target.workspaceId, undefined);
    const metadata = await h.ctx.sessionPersistence.open(
      SessionId(target.sessionId),
      "write",
    );
    try {
      const records = (await metadata.read()).events;
      await metadata.append([
        {
          type: "session/end-seed",
          seq: records.length,
          time: Date.now(),
          data: {},
        },
        {
          type: "model/selection",
          seq: records.length + 1,
          time: Date.now(),
          data: { provider: "test-offline", model: "script" },
        },
        {
          type: "model/selection",
          seq: records.length + 2,
          time: Date.now(),
          data: { provider: "test-offline", model: "selected-later" },
        },
      ]);
      await metadata.flush();
    } finally {
      await metadata.close();
    }

    assert.throws(
      () =>
        h.ledger.queueSessionMessage("unsupported-chat", {
          taskId: h.task.taskId,
          nodeId: "local",
          sessionId: target.sessionId,
          text: "Do not rerun",
        }),
      (e) => e.code === "SESSION_MESSAGE_WORKSPACE_REQUIRED",
    );
    let inspected, reconciled;
    h.ctx.on("tools/result", (exec, result) => {
      if (exec.name === "task_execution_status" && !result.isError) {
        if (exec.arguments.action === "inspect") {
          inspected = result.value;
        } else reconciled = result.value;
      }
    });
    h.adapter.script.push(
      {
        name: "task_execution_status",
        args: { action: "inspect", taskId: h.task.taskId, runId: h.run.runId },
      },
      () => {
        assert.equal(inspected.canReconcile, true);
        assert.equal(inspected.evidence.httpStatus, 401);
        assert.equal(inspected.evidence.toolCallCount, 0);
        return {
          name: "task_execution_status",
          args: {
            action: "reconcile",
            taskId: h.task.taskId,
            runId: h.run.runId,
            commandId: "核实".repeat(80),
            expectedEvidenceVersion: inspected.evidence.evidenceVersion,
            expectedActionVersion: inspected.actionVersion,
          },
        };
      },
      "The original failed attempt is reconciled; no retry.",
    );
    await h.projects.send({
      projectId: h.project.projectId,
      commandId: "pm-verify",
      text: "Inspect the original failed native attempt and reconcile only if proven. Do not retry.",
    });
    await until(
      () =>
        h.ledger
          .managementDatabase()
          .prepare("SELECT state FROM pr_turns WHERE command=?")
          .get("pm-verify")?.state === "completed",
    );
    assert.equal(reconciled.reconciled, true);
    assert.equal(h.ledger.getRun(h.run.runId).state, "failed");
    assert.equal(h.ledger.snapshot().runs.length, 1);
    assert.equal(h.ledger.snapshot().reports.length, 0);
    const proof = h.ledger
      .history(h.task.taskId)
      .events.find((e) => e.type === "run.reconciled").detail;
    assert.equal(proof.evidence.coordinatorSessionId, h.sessionId);
    assert.equal(proof.evidence.attemptId, h.claim.attempt.attemptId);
    assert.equal(proof.evidence.fence, h.claim.attempt.fence);
    assert.doesNotMatch(
      JSON.stringify(proof),
      /private credential sentinel|用户已核实/,
    );
    const execution = await h.ctx.sessionPersistence.open(
      SessionId(target.sessionId),
      "write",
    );
    try {
      const events = (await execution.read()).events;
      await execution.append([
        {
          type: "session/title",
          seq: events.length,
          time: Date.now(),
          data: { title: "Later display metadata", source: { kind: "user" } },
        },
      ]);
      await execution.flush();
    } finally {
      await execution.close();
    }
    const request = {
      action: "reconcile",
      taskId: h.task.taskId,
      runId: h.run.runId,
      commandId: "核实".repeat(80),
      expectedEvidenceVersion: inspected.evidence.evidenceVersion,
      expectedActionVersion: inspected.actionVersion,
    };
    const again = await tool(h, h.pm, request);
    assert.equal(again.isError, false);
    assert.equal(again.value.reconciled, true);
    assert.equal(
      h.ledger
        .history(h.task.taskId)
        .events.filter((e) => e.type === "run.reconciled").length,
      1,
    );
    const changed = await tool(h, h.pm, {
      ...request,
      expectedEvidenceVersion: "changed",
    });
    assert.equal(changed.isError, true);
    const settled = await tool(h, h.pm, {
      action: "inspect",
      taskId: h.task.taskId,
      runId: h.run.runId,
    });
    assert.equal(settled.value.evidence.status, "ledger-terminal");
    const another = h.ledger.createTask("other-command-task", {
      title: "Another synthetic attempt",
    }).value;
    h.projects.linkTask(h.sessionId, another.taskId);
    const otherRun = h.ledger.createRun("other-command-run", {
      taskId: another.taskId,
      route: {
        nodeId: "local",
        provider: "test-offline",
        model: "script",
        requiredCapabilities: [],
      },
    }).value;
    const collision = await tool(h, h.pm, {
      ...request,
      taskId: another.taskId,
      runId: otherRun.runId,
    });
    assert.equal(collision.isError, true);
    assert.match(JSON.stringify(collision), /another execution/);
  } finally {
    await h.dispose();
  }
});

test("ordinary output, later turns and foreign coordinator scopes cannot be converted to a zero-effect failure", async () => {
  const h = await fixture(["Output happened before any formal result"]);
  try {
    const request = {
      action: "inspect",
      taskId: h.task.taskId,
      runId: h.run.runId,
    };
    const inspected = await tool(h, h.pm, request);
    assert.equal(inspected.isError, false, JSON.stringify(inspected));
    assert.equal(inspected.value.canReconcile, false);
    assert.equal(h.ledger.getRun(h.run.runId).state, "uncertain");
    const other = await h.projects.create({
        commandId: "other-project",
        title: "Other project",
        goal: "No access",
      }),
      resolved = await h.ctx.sessionController.resolveAgent(
        SessionId(h.projects.placementProject(other.projectId).session),
      );
    assert.equal((await tool(h, resolved.agent, request)).isError, true);
    const standalone = await h.ctx.agents.create({
      sessionId: SessionId("unbound"),
      meta: { cwd: h.dir },
      agentOptions: { provider: "test-offline", model: "script" },
    });
    assert.equal((await tool(h, standalone.agent, request)).isError, true);
  } finally {
    await h.dispose();
  }
  const zero = await fixture();
  try {
    const target = zero.ledger.sessionMessageTargets(zero.task.taskId)[0];
    const agent = (
      await zero.ctx.sessionController.resolveAgent(SessionId(target.sessionId))
    ).agent;
    zero.adapter.script.push("A later unrelated turn");
    agent.followup(
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "Later native conversation" }],
      }),
    );
    await agent.whenIdle();
    await zero.ctx.sessions.flush(agent.session);
    const result = await tool(zero, zero.pm, {
      action: "inspect",
      taskId: zero.task.taskId,
      runId: zero.run.runId,
    });
    assert.equal(result.value.canReconcile, false);
    assert.equal(zero.ledger.getRun(zero.run.runId).state, "uncertain");
  } finally {
    await zero.dispose();
  }
});

test("tool dispatch, live ownership, stale action versions and a fence changed during observation all fail closed", async () => {
  const effectful = await fixture([
    { name: "task_query", args: {} },
    () => {
      throw new LlmError("synthetic rejected credential", "AUTH", {
        status: 401,
      });
    },
  ]);
  try {
    const result = await tool(effectful, effectful.pm, {
      action: "inspect",
      taskId: effectful.task.taskId,
      runId: effectful.run.runId,
    });
    assert.equal(result.value.canReconcile, false);
    assert.equal(
      effectful.ledger.getRun(effectful.run.runId).state,
      "uncertain",
    );
  } finally {
    await effectful.dispose();
  }
  const active = await fixture(["hang"], { wait: false });
  try {
    const result = await tool(active, active.pm, {
      action: "inspect",
      taskId: active.task.taskId,
      runId: active.run.runId,
    });
    assert.equal(result.value.canReconcile, false);
    assert.equal(result.value.runState, "running");
    const worker = active.ctx.agents.get(
      SessionId(
        active.ledger.getAttempt(active.claim.attempt.attemptId).sessionId,
      ),
    );
    assert.equal(
      (
        await tool(active, worker, {
          action: "inspect",
          taskId: active.task.taskId,
          runId: active.run.runId,
        })
      ).isError,
      true,
    );
  } finally {
    active.ctx.agents
      .get(
        SessionId(
          active.ledger.getAttempt(active.claim.attempt.attemptId).sessionId,
        ),
      )
      ?.cancel({ kind: "user" });
    await active.execution;
    await active.dispose();
  }
  const stale = await fixture();
  try {
    const inspected = await tool(stale, stale.pm, {
      action: "inspect",
      taskId: stale.task.taskId,
      runId: stale.run.runId,
    });
    assert.equal(inspected.value.canReconcile, true);
    stale.ledger.appendReport("new-progress", {
      taskId: stale.task.taskId,
      title: "New facts",
      body: "Concurrent report",
      kind: "progress",
    });
    const denied = await tool(stale, stale.pm, {
      action: "reconcile",
      taskId: stale.task.taskId,
      runId: stale.run.runId,
      commandId: "stale-action",
      expectedEvidenceVersion: inspected.value.evidence.evidenceVersion,
      expectedActionVersion: inspected.value.actionVersion,
    });
    assert.equal(denied.isError, true);
    assert.equal(stale.ledger.getRun(stale.run.runId).state, "uncertain");
    const persistence = stale.ctx.sessionPersistence,
      stat = persistence.stat.bind(persistence);
    let observations = 0;
    persistence.stat = async (...args) => {
      const value = await stat(...args);
      if (++observations === 2) {
        const attempt = stale.ledger.getAttempt(stale.claim.attempt.attemptId);
        attempt.fence++;
        stale.ledger
          .managementDatabase()
          .prepare("UPDATE entities SET data=? WHERE kind='attempt' AND id=?")
          .run(JSON.stringify(attempt), attempt.attemptId);
      }
      return value;
    };
    const changed = await tool(stale, stale.pm, {
      action: "inspect",
      taskId: stale.task.taskId,
      runId: stale.run.runId,
    });
    assert.equal(changed.isError, true);
    assert.match(JSON.stringify(changed), /evidence changed/i);
    assert.equal(stale.ledger.getRun(stale.run.runId).state, "uncertain");
  } finally {
    await stale.dispose();
  }
});

test("a temporary-task PM can inspect and reconcile only its own task tree without a registered execution workspace", async () => {
  const h = await fixture();
  try {
    const task = h.ledger.createTask("temporary-owner-task", {
      title: "Temporary owner task",
    }).value;
    const source = await h.projects.taskConversation(task.taskId);
    const run = h.ledger.createRun("temporary-owner-run", {
      taskId: task.taskId,
      route: {
        nodeId: "local",
        provider: "test-offline",
        model: "script",
        requiredCapabilities: [],
      },
    }).value;
    const claim = h.ledger.claim("temporary-owner-claim", {
      runId: run.runId,
      nodeId: "local",
      ttlMs: 10000,
    }).value;
    h.adapter.script.push(() => {
      throw new LlmError("Synthetic credential failure", "AUTH", {
        status: 401,
      });
    });
    await h.ctx.taskSystem.native.execute(claim);
    const actor = (
      await h.ctx.sessionController.resolveAgent(
        SessionId(source.sessionId ?? source.session),
      )
    ).agent;
    assert.ok(actor);
    const status = await tool(h, actor, {
      action: "inspect",
      taskId: task.taskId,
      runId: run.runId,
    });
    assert.equal(status.isError, false, JSON.stringify(status));
    assert.equal(status.value.canReconcile, true);
    const settled = await tool(h, actor, {
      action: "reconcile",
      taskId: task.taskId,
      runId: run.runId,
      commandId: "temporary-owner-confirm",
      expectedEvidenceVersion: status.value.evidence.evidenceVersion,
      expectedActionVersion: status.value.actionVersion,
    });
    assert.equal(settled.isError, false, JSON.stringify(settled));
    assert.equal(h.ledger.getRun(run.runId).state, "failed");
    assert.equal(
      (
        await tool(h, actor, {
          action: "inspect",
          taskId: h.task.taskId,
          runId: h.run.runId,
        })
      ).isError,
      true,
    );
  } finally {
    await h.dispose();
  }
});

test("the official WebHost exposes the same formal PM evidence tool and preserves unknown when native permission is read-only", async () => {
  const { startHost } = await import("../ci/browser-native-project.mjs");
  const host = await startHost({ executionEnabled: true });
  try {
    const service = host.ctx.taskSystem,
      ledger = service.ledger;
    mkdirSync(join(host.directory, "executions"));
    service.executionDirectories.save({
      root: join(host.directory, "executions"),
      expectedRevision: 0,
    });
    ledger.registerNode("host-local-node", {
      nodeId: "local",
      roles: ["both"],
      enabled: true,
      models: [
        { provider: "test-offline", model: "script", reasoningEfforts: [] },
      ],
      workspaceIds: [],
      capabilities: [],
      maxConcurrent: 1,
    });
    const task = ledger.createTask("host-auth-task", {
        title: "Full-host synthetic AUTH failure",
      }).value,
      placement = host.runtime.placementProject(host.created.projectId);
    host.runtime.linkTask(placement.session, task.taskId);
    const run = ledger.createRun("host-auth-run", {
      taskId: task.taskId,
      route: {
        nodeId: "local",
        provider: "test-offline",
        model: "script",
        requiredCapabilities: [],
      },
    }).value;
    const claim = ledger.claim("host-auth-claim", {
      runId: run.runId,
      nodeId: "local",
      ttlMs: 10000,
    }).value;
    host.model.script.push(() => {
      throw new LlmError("full-host synthetic credential failure", "AUTH", {
        status: 401,
      });
    });
    await service.native.execute(claim);
    await service.steward.sourceSession({
      conversationId: "main",
      scope: { kind: "project", projectId: host.created.projectId },
    });
    const actor = (
      await host.ctx.sessionController.resolveAgent(
        SessionId(placement.session),
      )
    ).agent;
    host.ctx.permissionPresets.set(actor.session, "read-only");
    const read = await tool({ ctx: host.ctx }, actor, {
      action: "inspect",
      taskId: task.taskId,
      runId: run.runId,
    });
    assert.equal(read.isError, false, JSON.stringify(read));
    assert.equal(read.value.canReconcile, true);
    const request = {
      action: "reconcile",
      taskId: task.taskId,
      runId: run.runId,
      commandId: "host-native-proof",
      expectedEvidenceVersion: read.value.evidence.evidenceVersion,
      expectedActionVersion: read.value.actionVersion,
    };
    const denied = await tool({ ctx: host.ctx }, actor, request);
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /read-only/);
    assert.equal(ledger.getRun(run.runId).state, "uncertain");
    host.ctx.permissionPresets.set(actor.session, "workspace-write");
    let seen;
    host.ctx.on("tools/result", (exec, result) => {
      if (
        exec.name === "task_execution_status" &&
        !result.isError &&
        exec.arguments.action === "inspect"
      )
        seen = result.value;
    });
    host.model.script.push(
      {
        name: "task_execution_status",
        args: { action: "inspect", taskId: task.taskId, runId: run.runId },
      },
      () => {
        assert.equal(seen.canReconcile, true);
        return {
          name: "task_execution_status",
          args: {
            ...request,
            expectedEvidenceVersion: seen.evidence.evidenceVersion,
            expectedActionVersion: seen.actionVersion,
          },
        };
      },
      "Host PM verified the failed attempt without retry.",
    );
    await host.runtime.send({
      projectId: host.created.projectId,
      commandId: "host-verify-turn",
      text: "Verify only the existing native evidence; do not dispatch or retry.",
    });
    await until(
      () =>
        ledger
          .managementDatabase()
          .prepare("SELECT state FROM pr_turns WHERE command=?")
          .get("host-verify-turn")?.state === "completed",
    );
    assert.equal(ledger.getRun(run.runId).state, "failed");
    assert.equal(ledger.snapshot().runs.length, 1);
    assert.equal(
      host.model.requests.length,
      4,
      "One failed worker request plus the formal PM inspection/reconciliation sequence",
    );
  } finally {
    await host.close();
  }
});
