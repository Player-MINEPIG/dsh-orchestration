import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const runtime = process.env.DSH_OFFICIAL_ROOT;
assert.ok(
  runtime,
  "Set DSH_OFFICIAL_ROOT to an existing official rc.2 installation (directory containing package.json and node_modules)",
);
const req = createRequire(join(runtime, "package.json"));
const url = (p) => pathToFileURL(req.resolve(p)).href;
const { boot, initProfile, readProfilePatches } = await import(
  url("@deepseek-ai/dsh-app-boot")
);
const { ScriptedModel } = await import("../dsh/scripted-model.mjs");
const tmp = mkdtempSync(join(tmpdir(), "dsh-task-startup-"));
const home = join(tmp, "home"),
  dir = join(home, "profiles", "startup-fixture");
mkdirSync(home, { recursive: true });
initProfile(dir, []);
if (process.env.DSH_TASK_SETTINGS_PACKAGE) {
  const modules = join(dir, "node_modules");
  mkdirSync(join(modules, "@dsh-task"), { recursive: true });
  symlinkSync(
    resolve(process.env.DSH_TASK_SETTINGS_PACKAGE),
    join(modules, "@dsh-task", "task-system"),
    "dir",
  );
} else symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
const profile = {
  name: "startup-fixture",
  dir,
  patchPath: join(dir, "cordis.patch.yml"),
  installAnchor: join(runtime, "package.json"),
  cwd: tmp,
  home,
  startedBundles: [],
  overlays: [],
  telemetryDisabledEnv: "1",
};
const taskConfig = {
  databasePath: join(tmp, "task.sqlite"),
  nodeId: "fixture",
  role: "both",
  keepAlive: false,
  schedulerEnabled: false,
  autoExecute: false,
  healthAlerts: false,
  executionTimeoutMs: 2000,
  workspaceRoots: [{ id: "fixture-root", path: tmp, allowCreate: false }],
  localNode: {
    workspaceIds: ["default"],
    models: [
      { provider: "test-offline", model: "script", reasoningEfforts: [] },
    ],
    maxConcurrent: 4,
  },
};
const rows = [
  ["config-editor", "@deepseek-ai/dsh-config-editor"],
  ["settings", "@deepseek-ai/dsh-settings"],
  ["sessionProjections", "@deepseek-ai/dsh-session-projection"],
  ["llm", "@deepseek-ai/dsh-llm"],
  ["sessions", "@deepseek-ai/dsh-session"],
  ["systemPrompt", "@deepseek-ai/dsh-system-prompt"],
  ["tools", "@deepseek-ai/dsh-tools"],
  ["agents", "@deepseek-ai/dsh-agent"],
  ["agentLoop", "@deepseek-ai/dsh-agent-loop", { agents: [] }],
  [
    "persistence",
    "@deepseek-ai/dsh-session-persistence-jsonl",
    { root: join(tmp, "sessions"), compression: "none" },
  ],
  ["typert", "@deepseek-ai/dsh-typert-registry"],
  ["gateway", "@deepseek-ai/dsh-api-gateway"],
].map(([id, p, config]) => ({ id, name: url(p), config }));
rows.push({
  id: "task-system",
  name: "@dsh-task/task-system/plugin",
  config: taskConfig,
});
rows.push({ id: "task-system-settings", name: "@dsh-task/task-system" });
writeFileSync(profile.patchPath, JSON.stringify([{ insert: rows }]));
const root = join(dir, "cordis.yml");
writeFileSync(root, "[]\n");
const start = () =>
  boot(
    "task-startup-smoke",
    root,
    readProfilePatches("task-startup-smoke", profile),
    (ctx) => ctx.provide("profileContext", profile),
  );
const route = {
  nodeId: "fixture",
  provider: "test-offline",
  model: "script",
  requiredCapabilities: [],
};
let ctx;
const passed = [];
const pass = (name) => {
  passed.push(name);
  console.log(`PASS ${name}`);
};
const invoke = (method, args = {}) =>
  ctx.typertGateway.invoke({ namespace: "taskPluginSettings", method, args });
try {
  ctx = await start();
  ctx.get("taskSystem").ledger.registerWorkspace("fixture-workspace", {
    workspaceId: "default",
    nodeId: "fixture",
    path: tmp,
    label: "Fixture",
    state: "ready",
    createdAt: new Date().toISOString(),
  });
  const snapshot = await invoke("startup");
  assert.equal(snapshot.applies, "plugin-restart");
  assert.equal(snapshot.writable, true);
  assert.equal(snapshot.remote, null);
  assert.equal(snapshot.task.entryId, "task-system");
  assert.deepEqual(Object.keys(snapshot.task.values).sort(), [
    "defaultWorkspaceId",
    "planningDecisionEnabled",
    "role",
    "sessionDecisionEnabled",
  ]);
  assert.equal(snapshot.task.values.planningDecisionEnabled, true);
  const originalService = ctx.get("taskSystem");
  const identity = originalService.ledger.schedulerIdentity();
  const workspace = originalService.ledger
    .snapshot()
    .workspaces.find((w) => w.nodeId === "fixture" && w.state === "ready");
  assert.ok(
    workspace,
    "Official task startup must register its default workspace",
  );
  pass(
    "actual official DSH exposes the narrow startup snapshot and registered default workspace",
  );
  const input = {
    target: "task",
    expected: snapshot.task.values,
    changes: {
      role: "executor",
      defaultWorkspaceId: workspace.workspaceId,
      planningDecisionEnabled: false,
      sessionDecisionEnabled: true,
    },
  };
  const result = await invoke("saveStartup", { input });
  assert.deepEqual(result, { saved: true, applies: "plugin-restart" });
  const updated = await invoke("startup");
  const service = ctx.get("taskSystem");
  assert.notEqual(service, originalService);
  assert.equal(service.config.role, "executor");
  assert.equal(service.config.defaultWorkspaceId, workspace.workspaceId);
  assert.equal(service.config.planningDecisionEnabled, false);
  assert.equal(updated.task.values.planningDecisionEnabled, false);
  assert.equal(service.config.sessionDecisionEnabled, true);
  assert.equal(service.config.schedulerEnabled, false);
  assert.equal(service.config.autoExecute, false);
  assert.equal(service.ledger.schedulerIdentity(), identity);
  assert.equal(updated.task.values.role, "executor");
  assert.equal(updated.task.values.defaultWorkspaceId, workspace.workspaceId);
  pass(
    "public Gateway save really restarts the plugin and read-after-save confirms role/workspace/decision values without model calls",
  );
  const persisted = readFileSync(profile.patchPath, "utf8");
  assert.ok(persisted.includes(workspace.workspaceId));
  await assert.rejects(
    invoke("saveStartup", {
      input: { ...input, changes: { role: "planner" } },
    }),
    /changed|snapshot|conflict/i,
  );
  assert.equal(readFileSync(profile.patchPath, "utf8"), persisted);
  await assert.rejects(
    invoke("saveStartup", {
      input: {
        target: "task",
        expected: updated.task.values,
        changes: { nodeId: "foreign-node" },
      },
    }),
  );
  await assert.rejects(invoke("executorIdentity"), /authenticated|connection/i);
  const queue = await invoke("queue");
  assert.equal(queue.items.length, 0);
  pass(
    "actual Gateway rejects stale startup edits, identity mutation and unconfigured identity queries; queue remains read only",
  );
  await ctx.fiber.dispose();
  ctx = await start();
  const reopened = await invoke("startup");
  assert.equal(reopened.task.values.defaultWorkspaceId, workspace.workspaceId);
  assert.equal(reopened.task.values.planningDecisionEnabled, false);
  assert.equal(reopened.task.values.sessionDecisionEnabled, true);
  assert.equal(ctx.get("taskSystem").ledger.schedulerIdentity(), identity);
  const restored = await invoke("saveStartup", {
    input: {
      target: "task",
      expected: reopened.task.values,
      changes: {
        role: "both",
        defaultWorkspaceId: null,
        planningDecisionEnabled: true,
        sessionDecisionEnabled: false,
      },
    },
  });
  assert.equal(restored.saved, true);
  const final = await invoke("startup");
  assert.equal(final.task.values.defaultWorkspaceId, null);
  assert.equal(final.task.values.role, "both");
  assert.equal(final.task.values.planningDecisionEnabled, true);
  assert.equal(final.task.values.sessionDecisionEnabled, false);
  pass(
    "restart persistence and explicit null default restoration use the real official ConfigEditor",
  );
  console.log(
    JSON.stringify({
      ok: true,
      checks: passed.length,
      modelCalls: 0,
      credentials: "none",
      existingServicesTouched: false,
    }),
  );
} finally {
  if (ctx) await ctx.fiber.dispose();
  rmSync(tmp, { recursive: true, force: true });
}
