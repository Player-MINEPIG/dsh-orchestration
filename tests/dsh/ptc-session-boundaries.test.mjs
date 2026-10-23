import test from "node:test";
import assert from "node:assert/strict";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createNativeHarness } from "./native-harness.mjs";

async function nativeOnlyHost() {
  const h = await createNativeHarness({presets:false,executionRoot:true});
  await h.ctx.loader.create({
    id: "presets",
    name: "@deepseek-ai/dsh-agent-preset-registry",
    config: { default: "standard" },
  });
  await h.ctx.loader.create({
    id: "standard",
    name: "@deepseek-ai/dsh-agent-preset",
    config: { id: "standard", plugins: [] },
  });
  await h.ctx.loader.await();
  h.ledger.registerNode("node", {
    nodeId: "local",
    roles: ["both"],
    capabilities: [],
    models: [
      { provider: "test-offline", model: "script", reasoningEfforts: [] },
    ],
    workspaceIds: [],
    enabled: true,
  });
  return h;
}
function seed(h) {
  const task = h.ledger.createTask("task", {
    title: "Preset boundary fixture",
  }).value;
  const run = h.ledger.createRun("run", {
    taskId: task.taskId,
    route: {
      nodeId: "local",
      provider: "test-offline",
      model: "script",
      requiredCapabilities: [],
    },
  }).value;
  return h.ledger.claim("claim", {
    runId: run.runId,
    nodeId: "local",
    ttlMs: 10000,
  }).value;
}

test("a preset-enabled host without PTC rejects a new task session explicitly", async () => {
  const h = await nativeOnlyHost();
  try {
    await assert.rejects(h.ctx.agentPresets.resolve('ptc'),/Unknown agent preset/);
    const claim = seed(h);
    await assert.rejects(
      h.ctx.taskSystem.native.execute(claim),
      (error) => error.code === "EXECUTION_PRESET_UNAVAILABLE",
    );
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(h.ctx.taskSystem.native.activeCount, 0);
  } finally {
    await h.dispose();
  }
});

test("an existing native session resumes its recorded preset when PTC is unavailable", async () => {
  const h = await nativeOnlyHost();
  try {
    await assert.rejects(h.ctx.agentPresets.resolve('ptc'),/Unknown agent preset/);
    const claim = seed(h);
    const sessionId = SessionId(`native-${claim.attempt.attemptId}`);
    const handle = await h.ctx.agents.create({
      sessionId,
      meta: { cwd:h.dir,agentPreset: "standard" },
      agentOptions: { provider: "test-offline", model: "script" },
      setup: async (ctx) => {
        await h.ctx.agentPresets.mount(ctx, "standard");
      },
    });
    await h.ctx.sessions.flush(handle.agent.session);
    await handle.dispose();
    h.ledger.bindSession("bind", {
      runId: claim.run.runId,
      attemptId: claim.attempt.attemptId,
      nodeId: "local",
      fence: claim.attempt.fence,
      sessionId,
    });
    h.adapter.script.push({
      name: "task_submit_result",
      args: { outcome: "success", summary: "Recorded native session resumed" },
    });
    const result = await h.ctx.taskSystem.native.resume({
      ...claim,
      attempt: h.ledger.getAttempt(claim.attempt.attemptId),
    });
    assert.equal(result.run.state, "succeeded");
    assert.equal(result.sessionId, sessionId);
    assert.ok(
      h.adapter.requests[0].tools.some((tool) => tool.name === "task_submit_result"),
    );
    assert.ok(
      !h.adapter.requests[0].tools.some((tool) => tool.name === "run_code"),
    );
    const stored = await h.ctx.sessionPersistence.open(sessionId, "read");
    try {
      assert.equal(stored.header.agentPreset, "standard");
    } finally {
      await stored.close();
    }
  } finally {
    await h.dispose();
  }
});
