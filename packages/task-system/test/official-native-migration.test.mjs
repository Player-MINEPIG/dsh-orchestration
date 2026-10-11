import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeHarness } from "../../../tests/dsh/native-harness.mjs";
import {
  officialProfileConfig,
  recordOfficialRuntime,
  TaskLedger,
} from "../dist/index.js";

async function fixture(t, role) {
  const h = await createNativeHarness({
    config: { role, nodeId: "mbp", executionTools: null },
  });
  t.after(() => h.dispose());
  const home = join(h.dir, "codex-test");
  mkdirSync(home);
  const backend = {
    backend: "fixture-codex",
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    codexHome: home,
    permissionContract: "codex-native",
  };
  writeFileSync(join(home, "config.toml"), officialProfileConfig(backend));
  h.ctx.taskSystem.config.officialBackends = [backend];
  const calls = [];
  h.ctx.provide("subagents", {
    getProvider: () => ({
      capabilities: {
        agentOptions: false,
        toolFilter: false,
        depthLimit: false,
      },
    }),
    async start(name, input) {
      calls.push({
        name,
        prompt: JSON.parse(input.prompt[0].text),
        parent: input.parent.id,
      });
      // Adapter transport metadata is a fixture here; actual handshake is covered separately.
      recordOfficialRuntime(backend.codexHome, {
        cliVersion: "codex-cli 9.0.0-fixture",
        cliSource: "host-configured",
        verifiedModel: backend.model,
        verifiedReasoningEffort: backend.reasoningEffort,
        productThreadId: `product-thread-${calls.length}`,
      });
      return {
        id: `fixture-${calls.length}`,
        result: Promise.resolve({
          stopReason: "completed",
          output: [{ type: "text", text: "fixture verified output" }],
        }),
        async dispose() {},
      };
    },
  });
  return { ...h, backend, calls };
}
function seed(h, ledger = h.ledger) {
  ledger.registerWorkspace("ws", {
    workspaceId: "ws",
    nodeId: "mbp",
    path: h.dir,
    label: "fixture",
    state: "ready",
    createdAt: new Date().toISOString(),
  });
  ledger.registerNode("node", {
    nodeId: "mbp",
    roles: ["executor"],
    enabled: true,
    workspaceIds: ["ws"],
    capabilities: [],
    models: [
      { provider: "codex", model: "gpt-6-luna", reasoningEfforts: ["low"] },
    ],
    lastSeenAt: new Date().toISOString(),
  });
  const task = ledger.createTask("task", {
    title: "Pinned original intent",
    description: "Original instructions",
    workspaceId: "ws",
    policy: { allowedTools: [], allowedBackends: [h.backend.backend] },
  }).value;
  const route = {
    nodeId: "mbp",
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    backend: h.backend.backend,
    workspaceId: "ws",
    requiredCapabilities: [],
  };
  const run = ledger.createRun("run", { taskId: task.taskId, route }).value;
  return { task, run, route };
}
test("project-runtime local execution routes official backend outside DSH llm registry and preserves pinned intent", async (t) => {
  const h = await fixture(t, "both");
  const { task, run, route } = seed(h);
  h.ledger.updateTask("edit", {
    taskId: task.taskId,
    expectedRevision: h.ledger.getTask(task.taskId).revision,
    title: "Later task edit",
    description: "Later edit must not replace current run",
  });
  const claim = h.ledger.claim("claim", {
    runId: run.runId,
    nodeId: "mbp",
    ttlMs: 10000,
  }).value;
  const result = await h.ctx.taskSystem.native.execute(claim);
  assert.equal(result.run.state, "succeeded");
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].prompt.title, "Pinned original intent");
  assert.equal(h.calls[0].prompt.description, "Original instructions");
  assert.equal(
    h.ledger.history(task.taskId).reports.at(-1).data.acceptance,
    "pending_user",
  );
  h.ledger.appendReport("misleading-note", {
    taskId: task.taskId,
    runId: run.runId,
    attemptId: claim.attempt.attemptId,
    kind: "note",
    title: "Untrusted metadata note",
    body: "Ordinary note",
    data: {
      backend: h.backend.backend,
      cliVersion: "not-executed",
      verifiedModel: "wrong-model",
      privateConfig: "SECRET_NOT_PUBLIC",
    },
  });
  const diagnostics = h.ctx.taskSystem.projects
    .snapshot()
    .runs.find((r) => r.id === run.runId);
  assert.equal(diagnostics.runtimeVersion, "codex-cli 9.0.0-fixture");
  assert.equal(diagnostics.runtimeSource, "host-configured");
  assert.equal(diagnostics.actualModel, "gpt-6-luna");
  assert.equal(diagnostics.actualReasoningEffort, "low");
  assert.equal(diagnostics.productThreadId, "product-thread-1");
  assert.doesNotMatch(
    JSON.stringify(h.ctx.taskSystem.projects.snapshot()),
    /SECRET_NOT_PUBLIC/,
  );
  const followup = h.ledger.createRun("followup", {
    taskId: task.taskId,
    route,
  }).value;
  const beforeFollowup = h.ctx.taskSystem.projects
    .snapshot()
    .runs.find((r) => r.id === followup.runId);
  assert.equal(
    beforeFollowup.runtimeVersion,
    null,
    "new run cannot borrow earlier execution metadata",
  );
  assert.equal(
    beforeFollowup.actualModel,
    null,
    "requested model is not verified execution evidence",
  );
  const next = await h.ctx.taskSystem.native.execute(
    h.ledger.claim("claim2", {
      runId: followup.runId,
      nodeId: "mbp",
      ttlMs: 10000,
    }).value,
  );
  assert.equal(next.run.state, "succeeded");
  assert.equal(
    next.sessionId,
    result.sessionId,
    "reuse inert task carrier, not the Codex child",
  );
  assert.equal(h.calls.length, 2, "each run starts a fresh official child");
  assert.equal(h.calls[1].prompt.title, "Later task edit");
});
test("remote official execution uses foreign authenticated claim without populating executor ledger", async (t) => {
  const h = await fixture(t, "executor");
  const authority = TaskLedger.open(join(h.dir, "authority.sqlite"), {
    role: "planner",
    nodeId: "vps",
  });
  t.after(() => authority.close());
  const { run } = seed(h, authority);
  const claim = authority.claim("claim", {
    runId: run.runId,
    nodeId: "mbp",
    ttlMs: 10000,
  }).value;
  claim.attempt.executionId = "fixture-execution";
  const result = await h.ctx.taskSystem.native.executeExternal({
    claim,
    sessionId: "official-carrier",
    workspacePath: h.dir,
    signal: new AbortController().signal,
  });
  assert.equal(result.outcome, "success");
  assert.equal(h.calls.length, 1);
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.ledger.snapshot().tasks.length, 0);
  assert.equal(h.ctx.taskSystem.native.activeCount, 0);
});
