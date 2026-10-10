import test from "node:test";
import { liveConfiguration } from "../../../tests/dsh/recursive-live/config.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TaskLedger,
  delegationDisplay,
  executeOfficialSubagent,
  authorizeOfficialBackend,
  verifyOfficialProfile,
  officialProfileConfig,
} from "../dist/index.js";
const backend = (home) => ({
  backend: "codex-luna-low",
  provider: "codex",
  model: "gpt-6-luna",
  reasoningEffort: "low",
  permissionContract: "codex-native",
  codexHome: home,
});
const route = {
  nodeId: "mbp",
  provider: "codex",
  backend: "codex-luna-low",
  model: "gpt-6-luna",
  reasoningEffort: "low",
  requiredCapabilities: [],
};
function profile(t) {
  const home = mkdtempSync(join(tmpdir(), "official-fixture-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(
    join(home, "config.toml"),
    officialProfileConfig({ model: "gpt-6-luna", reasoningEffort: "low" }),
  );
  return backend(home);
}
test("display advice respects explicit intent, defaults to task and changes no authority", () => {
  assert.deepEqual(
    delegationDisplay({ requested: "task", complexity: "small" }),
    { mode: "task", reason: "explicit-request" },
  );
  assert.equal(delegationDisplay({ complexity: "small" }).mode, "step");
  assert.equal(delegationDisplay({ complexity: "independent" }).mode, "task");
  assert.equal(delegationDisplay({}, "step").mode, "step");
  assert.throws(() => delegationDisplay({ requested: "hidden" }));
});
test("official route fails closed on omitted grant, wrong effort and unsafe config", (t) => {
  const b = profile(t);
  assert.throws(() => authorizeOfficialBackend(route, {}, [b]));
  assert.throws(() =>
    authorizeOfficialBackend(
      { ...route, reasoningEffort: "high" },
      { allowedBackends: [b.backend] },
      [b],
    ),
  );
  verifyOfficialProfile(b);
  writeFileSync(
    join(b.codexHome, "config.toml"),
    'model = "gpt-6-luna"\nsandbox_mode = "danger-full-access"\n',
  );
  assert.throws(() => verifyOfficialProfile(b));
});
test("fixture official result awaits quiescent disposal, sends no unsupported capabilities and remains pending review", async (t) => {
  const b = profile(t),
    order = [];
  let request;
  const subagents = {
    getProvider: () => ({
      capabilities: {
        agentOptions: false,
        toolFilter: false,
        depthLimit: false,
      },
    }),
    start: async (name, r) => {
      assert.equal(name, b.backend);
      request = r;
      return {
        id: "official-fixture-id",
        result: Promise.resolve({
          stopReason: "completed",
          output: [{ type: "text", text: "analysis artifact" }],
        }),
        dispose: async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push("disposed");
        },
      };
    },
  };
  const result = await executeOfficialSubagent({
    subagents,
    parent: {},
    route,
    policy: { allowedBackends: [b.backend] },
    backends: [b],
    prompt: "fixture",
    signal: new AbortController().signal,
    onPublished: (id) => order.push(id),
  });
  order.push("returned");
  assert.deepEqual(Object.keys(request).sort(), ["parent", "prompt", "signal"]);
  assert.deepEqual(order, ["official-fixture-id", "disposed", "returned"]);
  assert.equal(result.report.data.acceptance, "pending_user");
  assert.equal(result.outcome, "success");
});
test("fixture abort drains official child and suppresses result commitment", async (t) => {
  const b = profile(t),
    abort = new AbortController();
  let disposed = false;
  const subagents = {
    getProvider: () => ({
      capabilities: {
        agentOptions: false,
        toolFilter: false,
        depthLimit: false,
      },
    }),
    start: async () => ({
      id: "cancel-fixture",
      result: new Promise((resolve) =>
        abort.signal.addEventListener("abort", () =>
          resolve({ stopReason: "cancelled", output: [] }),
        ),
      ),
      dispose: async () => {
        disposed = true;
      },
    }),
  };
  const promise = executeOfficialSubagent({
    subagents,
    parent: {},
    route,
    policy: { allowedBackends: [b.backend] },
    backends: [b],
    prompt: "fixture",
    signal: abort.signal,
    onPublished: () => abort.abort(),
  });
  await assert.rejects(promise);
  assert.equal(disposed, true);
});
test("central ledger pins parent execution, inherits backend grants, retains step record and rejects scope expansion", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "recursive-ledger-"));
  const l = TaskLedger.open(join(dir, "tasks.sqlite"), {
    role: "both",
    nodeId: "mbp",
  });
  t.after(() => {
    l.close();
    rmSync(dir, { recursive: true, force: true });
  });
  l.registerNode("node", {
    nodeId: "mbp",
    roles: ["both"],
    capabilities: [],
    models: [
      { provider: "codex", model: "gpt-6-luna", reasoningEfforts: ["low"] },
    ],
    workspaceIds: [],
    enabled: true,
    maxConcurrent: 4,
    lastSeenAt: new Date().toISOString(),
  });
  const ungranted = l.createTask("ungranted", {
    title: "No backend grants",
  }).value;
  const denyRun = l.createRun("deny-run", {
    taskId: ungranted.taskId,
    route: { ...route, backend: undefined },
  }).value;
  const denyClaim = l.claim("deny-claim", {
    runId: denyRun.runId,
    nodeId: "mbp",
    ttlMs: 60000,
  }).value;
  const denyRef = {
    runId: denyRun.runId,
    nodeId: "mbp",
    attemptId: denyClaim.attempt.attemptId,
    fence: denyClaim.attempt.fence,
    executionId: "deny-owned",
  };
  l.markRunning("deny-start", denyRef);
  assert.throws(
    () =>
      l.delegateTask("self-grant", {
        ...denyRef,
        title: "Try self grant",
        policy: { allowedBackends: ["codex-luna-low"] },
      }),
    (e) => e.code === "FORBIDDEN",
  );
  const parent = l.createTask("parent", {
    title: "Parent",
    policy: {
      allowedBackends: ["codex-luna-low"],
      allowedTools: ["task_delegate"],
      maxChildren: 3,
    },
  }).value;
  const run = l.createRun("run", { taskId: parent.taskId, route }).value;
  const claim = l.claim("claim", {
    runId: run.runId,
    nodeId: "mbp",
    ttlMs: 60000,
  }).value;
  const ref = {
    runId: run.runId,
    nodeId: "mbp",
    attemptId: claim.attempt.attemptId,
    fence: claim.attempt.fence,
    executionId: "fixture-owned",
  };
  l.markRunning("running", ref);
  const child = l.delegateTask("child", {
    ...ref,
    title: "Small analysis",
    display: { complexity: "small" },
  }).value;
  assert.equal(child.task.parentRunId, run.runId);
  assert.equal(child.run.parentRunId, run.runId);
  assert.equal(child.task.delegationDisplay.mode, "step");
  assert.deepEqual(child.task.policy.allowedBackends, ["codex-luna-low"]);
  assert.equal(l.snapshot().tasks.length, 3);
  assert.equal(l.snapshot().attempts.length, 2);
  const event = l
    .history(child.task.taskId)
    .events.find((e) => e.type === "task.delegated");
  assert.equal(event.detail.parentExecutionId, ref.executionId);
  assert.equal(event.detail.parentFence, ref.fence);
  assert.throws(
    () =>
      l.delegateTask("expand", {
        ...ref,
        title: "Bad",
        policy: { allowedBackends: ["other"] },
      }),
    (e) => e.code === "FORBIDDEN",
  );
  assert.throws(
    () =>
      l.delegateTask("foreign", {
        ...ref,
        executionId: "forged",
        title: "Bad",
      }),
    (e) => e.code === "EXECUTION_OWNER",
  );
});

test("official execution success stays awaiting review; rejection and rework keep prior parent run identity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "official-review-"));
  const l = TaskLedger.open(join(dir, "tasks.sqlite"), {
    role: "both",
    nodeId: "mbp",
  });
  t.after(() => {
    l.close();
    rmSync(dir, { recursive: true, force: true });
  });
  l.registerNode("node", {
    nodeId: "mbp",
    roles: ["both"],
    capabilities: [],
    models: [
      { provider: "codex", model: "gpt-6-luna", reasoningEfforts: ["low"] },
    ],
    workspaceIds: [],
    enabled: true,
    maxConcurrent: 3,
    lastSeenAt: new Date().toISOString(),
  });
  const task = l.createTask("task", {
    title: "Official analysis",
    policy: { allowedBackends: ["codex-luna-low"] },
  }).value;
  const run = l.createRun("run", { taskId: task.taskId, route }).value;
  const claim = l.claim("claim", {
    runId: run.runId,
    nodeId: "mbp",
    ttlMs: 60000,
  }).value;
  const ref = {
    runId: run.runId,
    nodeId: "mbp",
    attemptId: claim.attempt.attemptId,
    fence: claim.attempt.fence,
    executionId: "review-fixture",
  };
  l.markRunning("start", ref);
  const settled = l.submit("result", {
    ...ref,
    outcome: "success",
    summary: "Execution done",
    report: { title: "Analysis", body: "Fixture official analysis" },
  }).value;
  assert.equal(settled.reviewStatus, "pending_user");
  assert.equal(settled.state, "succeeded");
  assert.equal(l.getTask(task.taskId).state, "waiting");
  l.reviewRun("reject", {
    runId: run.runId,
    decision: "rejected",
    reason: "Fixture director requests revision",
  });
  assert.equal(l.getTask(task.taskId).state, "waiting");
  const next = l.createRun("rework", { taskId: task.taskId, route }).value;
  assert.notEqual(next.runId, run.runId);
  assert.equal(l.getRun(run.runId).reviewStatus, "rejected");
  assert.equal(l.history(task.taskId).runs.length, 2);
});

test("live test endpoints follow the configured authority and isolate the Codex profile", () => {
  const config = liveConfiguration({
    DSH_RECURSIVE_RUNTIME: "/private/tmp/joint-test",
    DSH_RECURSIVE_ENDPOINT: "http://127.0.0.1:43672/commands",
    DSH_RECURSIVE_CODEX_HOME: "/private/tmp/joint-profile",
  });
  assert.equal(config.snapshotEndpoint.href, "http://127.0.0.1:43672/snapshot");
  assert.equal(config.codexHome, "/private/tmp/joint-profile");
  assert.equal(config.workspace, "/private/tmp/joint-test/workspace");
  assert.throws(
    () =>
      liveConfiguration({
        DSH_RECURSIVE_ENDPOINT: "http://127.0.0.1:43672/commands",
        DSH_RECURSIVE_SNAPSHOT_ENDPOINT: "http://127.0.0.1:43172/snapshot",
      }),
    /same authority/,
  );
});
