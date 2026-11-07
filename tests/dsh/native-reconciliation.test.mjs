import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ToolCallId, LlmError, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createNativeHarness } from "./native-harness.mjs";
import { terminalStopFacts } from "../../packages/task-system/dist/execution-reconciliation.js";
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
  { wait = true, captureOrigin = false, setup } = {},
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
  try{await setup?.(h);}catch(error){await h.dispose();throw error;}
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
  const creator = captureOrigin ? (await h.ctx.sessionController.resolveAgent(SessionId(sessionId))).agent : undefined;
  const task = creator ? h.ctx.taskSystem.withDispatchOrigin(creator,()=>ledger.createTask("task", { title: "Failed native task" }).value) : ledger.createTask("task", { title: "Failed native task" }).value;
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

test("ordinary output and later idle turns may prove only stopping; foreign coordinator scopes remain forbidden", async () => {
  const h = await fixture(["Output happened before any formal result"]);
  try {
    const request = {
      action: "inspect",
      taskId: h.task.taskId,
      runId: h.run.runId,
    };
    const inspected = await tool(h, h.pm, request);
    assert.equal(inspected.isError, false, JSON.stringify(inspected));
    assert.equal(inspected.value.canReconcile, true);
    assert.equal(inspected.value.evidence.kind,"native-terminal-stopped-v1");
    assert.equal(inspected.value.evidence.businessResult,"unproven");
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
    assert.equal(result.value.canReconcile, true);
    assert.equal(result.value.evidence.businessResult,"unproven");
    assert.equal(zero.ledger.getRun(zero.run.runId).state, "uncertain");
  } finally {
    await zero.dispose();
  }
});

test("tool dispatch preserves unknown business effects; live ownership, stale action versions and fence changes fail closed", async () => {
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
    assert.equal(result.value.canReconcile, true);
    assert.equal(result.value.evidence.kind,"native-terminal-stopped-v1");
    assert.equal(result.value.evidence.toolCallCount,1);
    assert.equal(result.value.evidence.businessResult,"unproven");
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

test('local managed retry borrows the actual WebUI-owned original executor and submits without replacing its Agent',async()=>{
  const h=await fixture();try{
    const inspected=await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId});
    assert.equal(inspected.isError,false);assert.equal(inspected.value.canReconcile,true);
    const settled=await tool(h,h.pm,{action:'reconcile',taskId:h.task.taskId,runId:h.run.runId,commandId:'before-local-owner-retry',expectedEvidenceVersion:inspected.value.evidence.evidenceVersion,expectedActionVersion:inspected.value.actionVersion});
    assert.equal(settled.isError,false);
    const target=h.ledger.sessionMessageTargets(h.task.taskId)[0];
    const opened=await h.ctx.sessionController.resolveAgent(SessionId(target.sessionId));assert.equal(opened.error,undefined);
    const live=opened.agent,globalBefore=h.ctx.agentDefaultModel.currentSelection();
    h.adapter.resolveModel=async(provider,id)=>({provider,id,name:id,reasoning:{efforts:[{id:'high',name:'High'}]}});
    h.ctx.llm.registerAdapter(['test-other'],h.adapter);
    const {registerExecutor}=await import('./executor-fixture.mjs');
    registerExecutor(h.ledger,'local-owner-models',{nodeId:'local',roles:['both'],enabled:true,models:[{provider:'test-offline',model:'script',reasoningEfforts:[]},{provider:'test-other',model:'usable',reasoningEfforts:['high']}],workspaceIds:[],capabilities:[],maxConcurrent:2});
    await h.projects.actOnTask({commandId:'local-owner-retry',taskId:h.task.taskId,runId:h.run.runId,action:'retry',expectedVersion:h.ledger.taskActionState(h.task.taskId).version,confirmationRevision:1,retryRouting:{nodeId:'local',executionModel:{provider:'test-other',model:'usable',reasoningEffort:'high'}}});
    h.ledger.recordNodeHeartbeat('local-owner-up',{nodeId:'local',runtimeReady:true,activeExecutions:0});h.projects.tick();h.projects.tick();
    const run=h.ledger.snapshot().runs.find(run=>run.runId!==h.run.runId);assert.ok(run);
    h.adapter.script.push(options=>{assert.equal(options.provider,'test-other');assert.equal(options.model,'usable');assert.equal(options.reasoningEffort,'high');return{name:'task_submit_result',args:{outcome:'success',summary:'REUSED_WEBUI_OWNER',reportTitle:'Owned retry proof',reportBody:'Same controller Agent submitted a scoped result'}};});
    const claim=h.ledger.claim('claim-local-owner',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
    const result=await h.ctx.taskSystem.native.execute(claim);
    assert.equal(result.run.state,'succeeded');assert.equal(h.ctx.agents.get(SessionId(target.sessionId)),live);
    assert.equal(h.ledger.getRun(h.run.runId).state,'failed');assert.equal(h.ledger.snapshot().runs.length,2);
    assert.deepEqual(h.ctx.agentDefaultModel.currentSelection(),globalBefore);
  }finally{await h.dispose();}
});

test('local retry never takes over or cancels a busy original WebUI executor session',async()=>{
  const h=await fixture(),release=Promise.withResolvers();try{
    const inspected=await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId});
    await tool(h,h.pm,{action:'reconcile',taskId:h.task.taskId,runId:h.run.runId,commandId:'before-busy-retry',expectedEvidenceVersion:inspected.value.evidence.evidenceVersion,expectedActionVersion:inspected.value.actionVersion});
    const target=h.ledger.sessionMessageTargets(h.task.taskId)[0],opened=await h.ctx.sessionController.resolveAgent(SessionId(target.sessionId)),entered=Promise.withResolvers();
    const live=opened.agent;
    h.adapter.script.push(async()=>{entered.resolve();await release.promise;return 'ORIGINAL_UI_TURN_PRESERVED';});
    live.followup(createUserMessage({source:{kind:'user',rpcId:'existing-ui-work'},content:[{type:'text',text:'Synthetic UI work, no external effects'}]}));
    await entered.promise;const calls=h.adapter.requests.length;
    await h.projects.actOnTask({commandId:'busy-local-retry',taskId:h.task.taskId,runId:h.run.runId,action:'retry',expectedVersion:h.ledger.taskActionState(h.task.taskId).version,confirmationRevision:1});
    h.ledger.recordNodeHeartbeat('busy-local-up',{nodeId:'local',runtimeReady:true,activeExecutions:0});h.projects.tick();h.projects.tick();
    const run=h.ledger.snapshot().runs.find(run=>run.runId!==h.run.runId),claim=h.ledger.claim('claim-busy-local',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
    await assert.rejects(h.ctx.taskSystem.native.execute(claim),error=>error.code==='SESSION_BUSY');
    assert.equal(h.ctx.agents.get(SessionId(target.sessionId)),live);assert.equal(h.adapter.requests.length,calls);assert.notEqual(live.status,'idle');
    release.resolve();await live.whenIdle();assert.equal(h.ctx.agents.get(SessionId(target.sessionId)),live);
  }finally{release.resolve();await h.dispose();}
});

async function interruptedFixture(captureOrigin=false){
 const h=await fixture(undefined,{captureOrigin});try{
  const inspected=await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId});
  await tool(h,h.pm,{action:'reconcile',taskId:h.task.taskId,runId:h.run.runId,commandId:'close-original-auth',expectedEvidenceVersion:inspected.value.evidence.evidenceVersion,expectedActionVersion:inspected.value.actionVersion});
  await h.projects.actOnTask({action:'retry',commandId:'prepare-generic-interruption',taskId:h.task.taskId,runId:h.run.runId,expectedVersion:h.ledger.taskActionState(h.task.taskId).version,confirmationRevision:1,expectedExecutionMs:60000});
  h.ledger.recordNodeHeartbeat('interrupted-local-up',{nodeId:'local',runtimeReady:true,activeExecutions:0});h.projects.tick();h.projects.tick();
  const previous=h.run,run=h.ledger.snapshot().runs.find(run=>run.runId!==previous.runId),claim=h.ledger.claim('interrupted-local-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
  const resume=h.ctx.agents.resume.bind(h.ctx.agents);h.ctx.agents.resume=async()=>{throw Error('Injected writer acquisition failure before input admission');};
  try{await assert.rejects(h.ctx.taskSystem.native.execute(claim),/Injected writer acquisition/);}finally{h.ctx.agents.resume=resume;}
  return{...h,previous,run:h.ledger.getRun(run.runId),claim};
 }catch(error){await h.dispose();throw error;}
}

test('bound PM verifies a durable pre-input interruption stopped while preserving business result uncertainty, then replays the exact receipt',async()=>{
 const h=await interruptedFixture();try{
  const inspected=await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId});assert.equal(inspected.isError,false);
  assert.equal(inspected.value.canReconcile,true);assert.equal(inspected.value.evidence.status,'stopped-result-unproven');assert.equal(inspected.value.evidence.businessResult,'unproven');
  const request={action:'reconcile',commandId:'formal-stopped-only',taskId:h.task.taskId,runId:h.run.runId,expectedEvidenceVersion:inspected.value.evidence.evidenceVersion,expectedActionVersion:inspected.value.actionVersion};
  const result=await tool(h,h.pm,request);assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.reconciled,true);assert.equal(result.value.runState,'failed');assert.equal(result.value.evidence.businessResult,'unproven');
  const replay=await tool(h,h.pm,request);assert.equal(replay.isError,false);assert.equal(replay.value.evidence.evidenceVersion,result.value.evidence.evidenceVersion);
  assert.equal(h.ledger.snapshot().runs.length,2);assert.equal(h.ledger.getRun(h.previous.runId).state,'failed');
  const later=await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId});assert.equal(later.value.evidence.businessResult,'unproven');assert.equal(later.value.hasResultReport,false);
 }finally{await h.dispose();}
});

test('interruption proof rejects missing or mismatched durable receipts, unmatched ledger timing and actual execution-start evidence',async()=>{
 const h=await interruptedFixture();try{
  const db=h.ledger.managementDatabase(),id='interrupted:'+h.claim.attempt.attemptId,row=db.prepare('SELECT digest,receipt FROM commands WHERE id=?').get(id);
  db.prepare('UPDATE commands SET digest=? WHERE id=?').run('tampered',id);
  assert.equal((await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId})).value.canReconcile,false);
  db.prepare('UPDATE commands SET digest=? WHERE id=?').run(row.digest,id);
  const receipt=JSON.parse(row.receipt);receipt.value.currentAttemptId='another-attempt';db.prepare('UPDATE commands SET receipt=? WHERE id=?').run(JSON.stringify(receipt),id);
  assert.equal((await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId})).value.canReconcile,false);
  db.prepare('UPDATE commands SET receipt=? WHERE id=?').run(row.receipt,id);
  const eventRow=db.prepare("SELECT seq,data FROM events WHERE run_id=? AND json_extract(data,'$.type')='run.settled'").get(h.run.runId),event=JSON.parse(eventRow.data);
  event.at=new Date(Date.parse(JSON.parse(row.receipt).acceptedAt)+3).toISOString();db.prepare('UPDATE events SET data=? WHERE seq=?').run(JSON.stringify(event),eventRow.seq);
  assert.equal((await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId})).value.canReconcile,true,'Real3ms transaction timestamp skew is valid');
  event.at=new Date(Date.parse(JSON.parse(row.receipt).acceptedAt)+31000).toISOString();db.prepare('UPDATE events SET data=? WHERE seq=?').run(JSON.stringify(event),eventRow.seq);
  assert.equal((await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId})).value.canReconcile,false);
  db.prepare('UPDATE events SET data=? WHERE seq=?').run(eventRow.data,eventRow.seq);
  db.prepare('INSERT INTO events(id,task_id,run_id,data) VALUES(?,?,?,?)').run('injected-start',h.task.taskId,h.run.runId,JSON.stringify({type:'run.execution_started',at:new Date().toISOString(),detail:{attemptId:h.claim.attempt.attemptId}}));
  assert.equal((await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId})).value.canReconcile,false);
  assert.equal(h.ledger.getRun(h.run.runId).state,'uncertain');assert.equal(h.ledger.snapshot().runs.length,2);
 }finally{await h.dispose();}
});

test('an active later user turn blocks stop verification and its later reply never becomes the old business result',async()=>{
 const h=await interruptedFixture(),release=Promise.withResolvers();try{
  const target=h.ledger.sessionMessageTargets(h.task.taskId)[0],opened=await h.ctx.sessionController.resolveAgent(SessionId(target.sessionId)),entered=Promise.withResolvers();
  h.adapter.script.push(async()=>{entered.resolve();await release.promise;return 'A later ordinary acknowledgement, not the old task result';});
  opened.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Only acknowledge this new user turn'}]}));await entered.promise;
  const busy=await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId});assert.equal(busy.value.canReconcile,false);
  release.resolve();await opened.agent.whenIdle();await h.ctx.sessions.flush(opened.agent.session);
  const stopped=await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId});assert.equal(stopped.value.canReconcile,true);assert.equal(stopped.value.evidence.businessResult,'unproven');assert.equal(stopped.value.hasResultReport,false);
 }finally{release.resolve();await h.dispose();}
});

test('the task-center manual check drives the real PM through status, evidence inspection and settlement without retry',async()=>{
 const h=await interruptedFixture(true);try{

  await h.projects.actOnTask({action:'check',commandId:'manual-stop-button',taskId:h.task.taskId,runId:h.run.runId,expectedVersion:h.ledger.taskActionState(h.task.taskId).version,confirmationRevision:1});
  const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'}).find(message=>message.checkIn?.manualChecks?.some(scope=>scope.taskId===h.task.taskId));assert.ok(message,JSON.stringify({view:h.ledger.checkins.view(h.task.taskId),pending:h.ledger.pendingSessionMessages('local',{kind:'continuation'})}));
  const results=[];h.ctx.on('tools/result',(exec,result)=>{if(exec.agent===h.pm&&['task_checkin','task_execution_status'].includes(exec.name))results.push({name:exec.name,result});});
  h.adapter.script.push(options=>{
   assert.ok(options.tools.some(tool=>tool.name==='task_checkin'));assert.ok(options.tools.some(tool=>tool.name==='task_execution_status'));assert.ok(!options.tools.some(tool=>tool.name==='task_dispatch'));
   return{name:'task_checkin',args:{action:'status',taskId:h.task.taskId}};
  },()=>{assert.equal(results.at(-1)?.result.isError,false);return{name:'task_execution_status',args:{action:'inspect',taskId:h.task.taskId,runId:h.run.runId}};},()=>{
   const inspected=results.at(-1).result;assert.equal(inspected.isError,false);assert.equal(inspected.value.canReconcile,true);
   return{name:'task_execution_status',args:{action:'reconcile',commandId:'manual-pm-stopped',taskId:h.task.taskId,runId:h.run.runId,expectedEvidenceVersion:inspected.value.evidence.evidenceVersion,expectedActionVersion:inspected.value.actionVersion}};
  },()=>{assert.equal(results.at(-1).result.isError,false);return{name:'task_checkin',args:{action:'update',commandId:'manual-final-progress',taskId:h.task.taskId,observation:'blocked',summary:'Invocation stopped; business result remains unproven',plan:{kind:'paused',reason:'Stopped verification completed; separate retry authorization required'}}};},()=>{
   assert.equal(results.at(-1).result.isError,false,JSON.stringify(results.at(-1).result));h.ledger.demandReads.reconcileFacts(Number.MAX_SAFE_INTEGER);h.ledger.checkins.tick();assert.equal(h.ledger.getSessionMessage(message.messageId).withdrawn,true,JSON.stringify({state:h.ledger.getSessionMessage(message.messageId).state,reply:h.ledger.getSessionMessage(message.messageId).reply,view:h.ledger.checkins.view(h.task.taskId)}));
   return 'The invocation has stopped; its research result remains unproven. No retry was performed.';
  });
  const receipt=await h.ctx.taskSystem.taskReturns.deliver(message);h.ledger.completeSessionMessage('manual-stop-ack',{messageId:message.messageId,nodeId:'local',state:'completed',...receipt});
  assert.equal(h.ledger.getRun(h.run.runId).state,'failed');assert.equal(h.ledger.snapshot().runs.length,2);assert.equal(h.ledger.getSessionMessage(message.messageId).state,'completed');assert.equal(h.ledger.getSessionMessage(message.messageId).withdrawn,undefined,'Actual admitted owner completion supersedes premature withdrawal');const source=await h.ctx.sessionPersistence.open(SessionId(h.sessionId),'read');try{const {events}=await source.read();assert.ok(events.some(event=>event.type==='assistant/message'&&JSON.stringify(event.data).includes('research result remains unproven')));}finally{await source.close();}
 }finally{await h.dispose();}
});


test('a quiescent exact native terminal journal proves stopping after tools, without claiming no effects or a business result',async()=>{
 const h=await fixture([{name:'fixture_effect',args:{}},()=>{throw new Error('Synthetic runtime failure after a harmless fixture artifact');}],{setup(h){h.ctx.tools.register(defineTool({name:'fixture_effect',description:'Write a fixture marker only',parameters:{},output:{schema:{type:'json'},render:(_,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async()=>{writeFileSync(join(h.dir,'effect.txt'),'PARTIAL_ARTIFACT');return{written:true};}}));}});
 try{
  assert.equal(readFileSync(join(h.dir,'effect.txt'),'utf8'),'PARTIAL_ARTIFACT');
  const executor=(await h.ctx.sessionController.resolveAgent(SessionId(h.ledger.sessionMessageTargets(h.task.taskId)[0].sessionId))).agent, entered=Promise.withResolvers(),release=Promise.withResolvers();
  const child=await h.ctx.agents.create({sessionId:SessionId('unsettled-proof-child'),parentAgent:executor,meta:{cwd:executor.session.header.cwd,parentSession:executor.id},agentOptions:{provider:'test-offline',model:'script'}});
  try{
   h.adapter.script.push(async()=>{entered.resolve();await release.promise;return 'Child work actually stopped';});child.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Controlled child activity'}]}));await entered.promise;
   assert.equal((await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId})).value.canReconcile,false,'A related active child prevents claiming quiescence');
  }finally{release.resolve();await child.agent.whenIdle();await child.dispose();}
  const inspected=await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId});assert.equal(inspected.isError,false);assert.equal(inspected.value.canReconcile,true,JSON.stringify(inspected));assert.equal(inspected.value.evidence.kind,'native-terminal-stopped-v1');assert.equal(inspected.value.evidence.toolCallCount,1);assert.equal(inspected.value.evidence.businessResult,'unproven');
  const persisted=await h.ctx.sessionPersistence.open(executor.id,'read');let actual;try{actual=(await persisted.read()).events;}finally{await persisted.close();}
  const terminalIndex=actual.findIndex(event=>event.seq===inspected.value.evidence.terminalSeq),withPendingChild=structuredClone(actual);withPendingChild.splice(terminalIndex,0,{type:'subagent/catalog',time:actual[terminalIndex].time,data:{version:0,mode:'continuable',childId:'unreturned-child',childCreatedAt:actual[terminalIndex].time,label:'Awaited child'}});withPendingChild.forEach((event,seq)=>event.seq=seq);
  assert.equal(terminalStopFacts(h.ctx.taskSystem,h.ledger.getRun(h.run.runId),h.ledger.getAttempt(h.claim.attempt.attemptId),withPendingChild),undefined,'An admitted child without its durable settled notice is not quiescent proof');
  const withAccount=[...withPendingChild,{type:'user/message',seq:withPendingChild.length,time:Date.now(),data:{source:{kind:'subagent-settled',form:'notice',senderSessionId:'unreturned-child',summary:'Stopped'},content:[]}}];
  assert.ok(terminalStopFacts(h.ctx.taskSystem,h.ledger.getRun(h.run.runId),h.ledger.getAttempt(h.claim.attempt.attemptId),withAccount));
  const journal=h.ctx.taskSystem.results.get('missing-result:'+h.claim.attempt.attemptId), get=h.ctx.taskSystem.results.get.bind(h.ctx.taskSystem.results);
  h.ctx.taskSystem.results.get=()=>({...journal,ref:{...journal.ref,fence:journal.ref.fence+1}});
  try{assert.equal((await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId})).value.canReconcile,false);}finally{h.ctx.taskSystem.results.get=get;}
  const settled=await tool(h,h.pm,{action:'reconcile',commandId:'stop-runtime-journal',taskId:h.task.taskId,runId:h.run.runId,expectedEvidenceVersion:inspected.value.evidence.evidenceVersion,expectedActionVersion:inspected.value.actionVersion});assert.equal(settled.isError,false);assert.equal(settled.value.evidence.businessResult,'unproven');assert.equal(h.ledger.getRun(h.run.runId).state,'failed');assert.equal(h.ledger.snapshot().runs.length,1);assert.equal(readFileSync(join(h.dir,'effect.txt'),'utf8'),'PARTIAL_ARTIFACT');
 }finally{await h.dispose();}
});


async function prepareWebOwnerRetry(h,command){
 const inspected=await tool(h,h.pm,{action:'inspect',taskId:h.task.taskId,runId:h.run.runId});
 await tool(h,h.pm,{action:'reconcile',commandId:command+'-close',taskId:h.task.taskId,runId:h.run.runId,expectedEvidenceVersion:inspected.value.evidence.evidenceVersion,expectedActionVersion:inspected.value.actionVersion});
 const target=h.ledger.sessionMessageTargets(h.task.taskId)[0],live=(await h.ctx.sessionController.resolveAgent(SessionId(target.sessionId))).agent;
 await h.projects.actOnTask({action:'retry',commandId:command,taskId:h.task.taskId,runId:h.run.runId,expectedVersion:h.ledger.taskActionState(h.task.taskId).version,confirmationRevision:1});
 h.ledger.recordNodeHeartbeat(command+'-up',{nodeId:'local',runtimeReady:true,activeExecutions:0});h.projects.tick();h.projects.tick();
 const run=h.ledger.snapshot().runs.find(run=>run.runId!==h.run.runId),claim=h.ledger.claim(command+'-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
 return{live,run,claim};
}

test('a WebUI-owned execution accepts only child relay activated during that exact attempt and submits normally',async()=>{
 const h=await fixture();try{
  const req=createRequire(join(process.env.DSH_OFFICIAL_ROOT,'package.json'));
  for(const [id,name,config] of [['relay-fs','@deepseek-ai/dsh-fs-local',{cwd:h.dir}],['relay-cwd','@deepseek-ai/dsh-working-directory',{defaultDirectory:h.dir}],['relay-runtime','@deepseek-ai/dsh-subagent'],['relay-spawn','@deepseek-ai/dsh-subagent-spawn-in-process']])await h.ctx.loader.create({id,name:pathToFileURL(req.resolve(name)).href,config});
  await h.ctx.loader.await();
  const {live,run,claim}=await prepareWebOwnerRetry(h,'current-child-relay'),relayed=Promise.withResolvers();let activation,startError;
  h.adapter.script.push(async()=>{
   try{activation=await live.ctx.get('subagents').startActivation({provider:'spawn',childId:SessionId('current-attempt-child'),label:'One safe fixture child',request:{parent:live,prompt:[{type:'text',text:'Send only the safe fixture relay'}]},signal:new AbortController().signal,delivery:'parent'});}catch(error){startError=error;throw error;}
   await relayed.promise;await activation.result;return{name:'task_query',args:{taskId:h.task.taskId}};
  },async()=>{
   const child=h.ctx.agents.get(SessionId('current-attempt-child'));assert.ok(child);
   await child.ctx.get('subagents').sendMessage(child,live.id,[{type:'text',text:'CURRENT_ATTEMPT_CHILD_EVIDENCE'}],{signal:new AbortController().signal});relayed.resolve();return 'Child fixture done';
  },options=>{assert.ok(options.messages.some(message=>message.source?.kind==='subagent-settled'),'The standard settled notice is consumed inside the leased turn');return{name:'task_submit_result',args:{outcome:'success',summary:'CURRENT_CHILD_RELAY_ACCEPTED',reportTitle:'Safe child relay proof',reportBody:'Only current-attempt authorized child relay and settled notice were consumed'}};} );
  const executed=await h.ctx.taskSystem.native.execute(claim);assert.equal(startError,undefined,startError?.stack);assert.ok(activation,JSON.stringify(executed));await activation.result;
  assert.equal(executed.run.state,'succeeded');assert.equal(h.ctx.agents.get(live.id),live);assert.equal(h.ledger.snapshot().runs.length,2);assert.equal(h.ledger.getRun(run.runId).resultSummary,'CURRENT_CHILD_RELAY_ACCEPTED');
 }finally{await h.dispose();}
});

for(const inputKind of ['old-child','foreign-child','old-notice','foreign-notice','user'])test('a borrowed executor still rejects '+inputKind+' input outside the current subagent activation',async()=>{
 const h=await fixture();let child;
 try{
  const {live,claim}=await prepareWebOwnerRetry(h,'reject-'+inputKind);
  if(inputKind!=='user')child=await h.ctx.agents.create({sessionId:SessionId('untrusted-'+inputKind),...(inputKind.startsWith('old-')?{parentAgent:live}:{}),meta:{cwd:live.session.header.cwd},agentOptions:{provider:'test-offline',model:'script'}});
  if(inputKind.startsWith('old-'))assert.equal(h.ctx.agents.isOwnedBy(child.agent.id,live),true);
  h.adapter.script.push(()=>{live.steer(createUserMessage({source:inputKind==='user'?{kind:'user'}:inputKind.endsWith('notice')?{kind:'subagent-settled',form:'notice',summary:'Not this attempt',senderSessionId:child.agent.id}:{kind:'agent-message',form:'relay',senderSessionId:child.agent.id},content:[{type:'text',text:'Must not become leased task input'}]}));return{name:'task_query',args:{taskId:h.task.taskId}};});
  const result=await h.ctx.taskSystem.native.execute(claim);assert.equal(result.run.state,'uncertain');assert.equal(result.submitted,false);
  const source=await h.ctx.sessionPersistence.open(live.id,'read');try{const {events}=await source.read();assert.ok(events.some(event=>event.type==='turn/end'&&event.data.reason.kind==='error'&&event.data.reason.error.message==='Another input reached the task-owned session'));}finally{await source.close();}
  assert.equal(h.ledger.snapshot().runs.length,2);
 }finally{await child?.dispose();await h.dispose();}
});
