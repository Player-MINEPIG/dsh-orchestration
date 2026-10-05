import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
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
const tmp = mkdtempSync(join(tmpdir(), "dsh-workspace-labels-"));
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
  ["storage", "@deepseek-ai/dsh-storage"],
  [
    "storage-json",
    "@deepseek-ai/dsh-storage-json",
    { root: join(tmp, "domain-storage") },
  ],
  ["storage-domain", "@deepseek-ai/dsh-storage-domain", { backend: "json" }],
  ["workspace-registry", "@deepseek-ai/dsh-workspace"],
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
  const registry = ctx.get("workspaceRegistry");
  assert.ok(registry, "The real official WorkspaceRegistry must be loaded");
  const task = ctx.get("taskSystem"),
    ledger = task.ledger;
  const seeded = [];
  for (const [id, title] of [
    ["same-one", "Same name"],
    ["same-two", "Same name"],
    ["untitled", ""],
    ["missing", ""],
  ]) {
    const path = join(tmp, id);
    mkdirSync(path);
    const actual = await registry.create(path, title);
    assert.equal(actual.title, title);
    seeded.push({
      workspaceId: id,
      nodeId: "fixture",
      path: actual.path,
      state: "ready",
      createdAt: new Date().toISOString(),
    });
    // Reading this registry catalog must not touch session membership.
    Object.defineProperty(actual, "sessionIds", {
      get() {
        throw Error("Session membership must not be read");
      },
    });
  }
  const oldPath = join(tmp, "legacy-no-label");
  mkdirSync(oldPath);
  seeded.push({
    workspaceId: "legacy-no-label",
    nodeId: "fixture",
    path: realpathSync(oldPath),
    state: "ready",
    createdAt: new Date().toISOString(),
  });
  seeded.push({
    workspaceId: "unnamed-root",
    nodeId: "fixture",
    path: "/",
    state: "ready",
    createdAt: new Date().toISOString(),
  });
  for (const item of seeded)
    ledger.registerWorkspace(`fixture-${item.workspaceId}`, item);
  const node = ledger.getNode("fixture");
  ledger.registerNode("fixture-grants", {
    ...node,
    workspaceIds: [
      ...new Set([
        ...node.workspaceIds,
        ...seeded.map((item) => item.workspaceId),
      ]),
    ],
  });
  rmSync(join(tmp, "missing"), { recursive: true });
  const beforeTask = ledger.registeredWorkspaces("fixture");
  const beforeOfficial = registry
    .list()
    .map((item) => ({ id: item.id, path: item.path, title: item.title }));
  const beforeProfile = readFileSync(profile.patchPath, "utf8");
  const view = await invoke("workspaces");
  const items = new Map(view.items.map((item) => [item.workspaceId, item]));
  assert.equal(view.source, "official");
  assert.equal(items.get("untitled").title, "untitled");
  assert.equal(items.get("legacy-no-label").title, "legacy-no-label");
  assert.equal(items.get("unnamed-root").title, "未命名");
  assert.equal(items.get("untitled").available, true);
  pass(
    "real official Registry plus Gateway workspaces RPC accepts empty official titles and missing legacy Task labels",
  );
  assert.equal(items.get("same-one").title, "Same name");
  assert.equal(items.get("same-two").title, "Same name");
  assert.notEqual(items.get("same-one").path, items.get("same-two").path);
  assert.equal(items.get("same-one").workspaceId, "same-one");
  assert.equal(items.get("same-two").workspaceId, "same-two");
  assert.equal(items.get("missing").title, "missing");
  assert.equal(items.get("missing").available, false);
  pass(
    "official duplicate titles retain distinct paths and Task IDs; deleted directories remain visible and unavailable",
  );
  assert.deepEqual(ledger.registeredWorkspaces("fixture"), beforeTask);
  assert.deepEqual(
    registry
      .list()
      .map((item) => ({ id: item.id, path: item.path, title: item.title })),
    beforeOfficial,
  );
  assert.equal(readFileSync(profile.patchPath, "utf8"), beforeProfile);
  pass(
    "public metadata read preserves Task/official records and profile, without reading session membership",
  );
  console.log(
    JSON.stringify({
      ok: true,
      checks: passed.length,
      officialRegistry: true,
      modelCalls: 0,
      executionPerformed: false,
      identityOperationsCalled: false,
      workspaceWritesDuringRead: 0,
    }),
  );
} finally {
  if (ctx) await ctx.fiber.dispose();
  rmSync(tmp, { recursive: true, force: true });
}
