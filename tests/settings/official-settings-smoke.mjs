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
const tmp = mkdtempSync(join(tmpdir(), "dsh-task-settings-"));
const home = join(tmp, "home"),
  dir = join(home, "profiles", "settings-fixture");
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
  name: "settings-fixture",
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
    "task-settings-smoke",
    root,
    readProfilePatches("task-settings-smoke", profile),
    (ctx) => ctx.provide("profileContext", profile),
  );
const route = {
  nodeId: "fixture",
  workspaceId: "default",
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
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
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
  assert.ok(ctx.taskSystem?.native);
  const read = () =>
    ctx.settings.describe().find((d) => d.ns === "task-system");
  const expected = [
    "schedulerEnabled",
    "autoExecute",
    "maxConcurrent",
    "decisionBindings",
    "nodeCapacityOverrides",
    "planningDecisionEnabled",
    "sessionDecisionEnabled",
    "healthAlerts",
    "localHeartbeatIntervalMs",
  ];
  assert.deepEqual(Object.keys(read().value).sort(), expected.sort());
  const service = ctx.taskSystem,
    native = service.native,
    entry = ctx.configEditor
      .entries()
      .find((e) => e.options.id === "task-system"),
    fiber = entry.fiber;
  const mutate = async (values) => {
    await ctx.settings.mutate(
      "task-system",
      Object.entries(values).map(([field, value]) => ({
        op: "set",
        path: [field],
        value,
      })),
      read().revision,
    );
    assert.ok(
      entry.fiber === fiber,
      "live edit must preserve the original plugin fiber",
    );
    assert.ok(
      ctx.taskSystem.ledger === service.ledger,
      "live edit must preserve the opened task ledger",
    );
    for (const [key, value] of Object.entries(values))
      assert.deepEqual(service.config[key], value);
  };
  const before = readFileSync(profile.patchPath, "utf8");
  await assert.rejects(
    ctx.settings.mutate(
      "task-system",
      [{ op: "set", path: ["databasePath"], value: "forbidden.sqlite" }],
      read().revision,
    ),
    /volatile|editable/i,
  );
  assert.equal(readFileSync(profile.patchPath, "utf8"), before);
  pass(
    "current live runtime fields exposed; startup path write rejected without changing profile",
  );
  const adapter = new ScriptedModel(["hang", "hang", "hang"]);
  ctx.llm.registerAdapter(["test-offline"], adapter);
  service.ledger.updateTemplate("template", {
    templateId: "fixture",
    version: 1,
    name: "Fixture",
    description: "",
    defaults: {},
    inputSchema: { type: "object" },
    resultContract: { type: "object" },
  });
  const scheduled = service.ledger.createTask("scheduled", {
    title: "Settings fixture",
  }).value;
  service.ledger.createSchedule("schedule", {
    scheduleId: "fixture",
    taskId: scheduled.taskId,
    templateId: "fixture",
    templateVersion: 1,
    enabled: true,
    intervalMs: 60000,
    nextDueAt: new Date(Date.now() - 20).toISOString(),
    overlap: "skip",
    input: {},
    route,
  });
  service.tick();
  assert.equal(service.ledger.snapshot().runs.length, 0);
  await mutate({ schedulerEnabled: true });
  service.tick();
  assert.equal(service.ledger.snapshot().runs.length, 1);
  assert.equal(adapter.requests.length, 0);
  pass(
    "scheduler toggle changes actual next-tick admission, without invoking the model",
  );
  await mutate({ schedulerEnabled: false, autoExecute: true });
  service.tick();
  await until(() => adapter.requests.length === 1);
  await mutate({ autoExecute: false });
  const task2 = service.ledger.createTask("task2", {
    title: "Second fixture",
  }).value;
  const run2 = service.ledger.createRun("run2", {
    taskId: task2.taskId,
    route,
  }).value;
  service.tick();
  assert.equal(service.ledger.getRun(run2.runId).state, "queued");
  assert.equal(native.activeCount, 1);
  pass(
    "local autoExecute gates new local claims but leaves the active native attempt running",
  );
  await mutate({ autoExecute: true, maxConcurrent: 1 });
  service.tick();
  assert.equal(service.ledger.getRun(run2.runId).state, "queued");
  await mutate({ maxConcurrent: 2 });
  service.tick();
  await until(() => adapter.requests.length === 2);
  assert.equal(native.activeCount, 2);
  pass(
    "live maxConcurrent change admits the next queued local run without remounting",
  );
  await mutate({ autoExecute: false, planningDecisionEnabled: false, sessionDecisionEnabled: true, decisionBindings: {"task-planning":"fixture-preset"}, nodeCapacityOverrides: {fixture: 4} });
  await assert.rejects(ctx.settings.mutate("task-system", [{op:"set",path:["executionTimeoutMs"],value:100}], read().revision), /volatile|editable/i);
  assert.equal(service.config.executionTimeoutMs, taskConfig.executionTimeoutMs);
  assert.equal(native.activeCount, 2);
  pass("current decision and capacity fields update live; startup execution timeout is not a live-edit field");
  let healthCalls = 0;
  const health = service.ledger.reconcileNodeHealth;
  service.ledger.reconcileNodeHealth = () => {
    healthCalls++;
  };
  await mutate({ healthAlerts: false });
  service.tick();
  assert.equal(healthCalls, 0);
  await mutate({ healthAlerts: true });
  service.tick();
  assert.equal(healthCalls, 1);
  service.ledger.reconcileNodeHealth = health;
  pass("healthAlerts toggle controls real tick reconciliation");
  let heartbeats = 0;
  const heartbeat = service.ledger.recordNodeHeartbeat;
  service.ledger.recordNodeHeartbeat = (...args) => {
    heartbeats++;
    return heartbeat.apply(service.ledger, args);
  };
  await mutate({ localHeartbeatIntervalMs: 3600000 });
  service.tick();
  assert.equal(heartbeats, 0);
  await mutate({ localHeartbeatIntervalMs: 100 });
  await new Promise((r) => setTimeout(r, 110));
  service.tick();
  assert.equal(heartbeats, 1);
  service.ledger.recordNodeHeartbeat = heartbeat;
  pass(
    "live localHeartbeatIntervalMs changes actual next heartbeat eligibility",
  );
  const stale = read().revision;
  await mutate({ maxConcurrent: 3 });
  const saved = readFileSync(profile.patchPath, "utf8");
  await assert.rejects(
    ctx.settings.mutate(
      "task-system",
      [{ op: "set", path: ["maxConcurrent"], value: 4 }],
      stale,
    ),
    /changed since|revision/i,
  );
  await assert.rejects(
    ctx.settings.mutate(
      "task-system",
      [{ op: "set", path: ["maxConcurrent"], value: 33 }],
      read().revision,
    ),
  );
  assert.equal(readFileSync(profile.patchPath, "utf8"), saved);
  pass("stale revision and invalid limits rejected atomically");
  const info = await ctx.taskPluginSettings.describe();
  assert.equal(info.databasePath, taskConfig.databasePath);
  assert.equal(info.profilePatch, profile.patchPath);
  assert.equal(info.remote, null);
  assert.deepEqual(ctx.typert.local.list().filter(d=>d.namespace==="taskPluginSettings").map(d=>d.method).sort(), [
    "describe","queue","workspaces","executorIdentity","startup","saveStartup","checkConnection","decisionSettings","saveDecisionSettings","decisionConsole","setDecisionPreset",
    "projectSettings","projectSnapshot","projectPage","saveProjectSettings","createProject","createTemporaryTask","conversationModels","selectConversationModel","sendExecutorMessage","taskConversation","sendTaskMessage","projectConversation","sendProjectMessage","handoffProject","actOnProjectTask","reviewProjectTask"
  ].sort());
  assert.equal(
    ctx.typert.local.get("taskPluginSettings/describe").parameters.length,
    0,
  );
  assert.equal(
    Object.keys(info).some((key) => /key|secret|token|password/i.test(key)),
    false,
  );
  pass("allowlisted deployment data and current typed settings/project Remote methods");
  assert.deepEqual(
    await ctx.typertGateway.invoke({
      namespace: "taskPluginSettings",
      method: "describe",
      args: {},
    }),
    info,
  );
  await assert.rejects(
    ctx.typertGateway.invoke({
      namespace: "taskPluginSettings",
      method: "describe",
      args: { extra: true },
    }),
  );
  await assert.rejects(
    ctx.typertGateway.invoke({
      namespace: "taskPluginSettings",
      method: "update",
      args: {},
    }),
  );
  pass(
    "official Typert Gateway invokes the read-only method and rejects extra arguments or a write method",
  );
  await ctx.fiber.dispose();
  ctx = await start();
  const persisted = ctx.settings
    .describe()
    .find((d) => d.ns === "task-system").value;
  assert.equal(persisted.maxConcurrent, 3);
  assert.equal(Object.hasOwn(persisted, "executionTimeoutMs"), false);
  assert.equal(ctx.taskSystem.config.executionTimeoutMs, taskConfig.executionTimeoutMs);
  assert.equal(persisted.planningDecisionEnabled, false);
  assert.equal(persisted.sessionDecisionEnabled, true);
  assert.deepEqual(persisted.decisionBindings, {"task-planning":"fixture-preset"});
  assert.deepEqual(persisted.nodeCapacityOverrides, {fixture:4});
  assert.equal(persisted.autoExecute, false);
  pass(
    "saved runtime settings survive a fresh official boot from the same isolated profile",
  );
  const { default: ClientModules } = await import(
    url("@deepseek-ai/dsh-client-modules")
  );
  await ctx.plugin(ClientModules);
  const graph = ctx.clientModules.graph();
  const own = graph.entries.filter((e) => e.id === "@dsh-task/task-system");
  assert.equal(own.length, 1);
  const bundle = await ctx.clientModules.fetchBundle(
    new Request(new URL(own[0].url, "http://fixture.invalid/")),
  );
  assert.equal(bundle.status, 200);
  assert.match(await bundle.text(), /plugins.row.config/);
  pass(
    "official client module graph serves the package browser half once, without starting Web/auth",
  );
  await ctx.fiber.dispose();
  profile.overlays = [
    { id: "task-system", config: { ...taskConfig, maxConcurrent: 4 } },
  ];
  ctx = await start();
  assert.equal(
    (await ctx.taskPluginSettings.describe()).commandLineConfigOverride,
    true,
  );
  const fixed = readFileSync(profile.patchPath, "utf8");
  const revision = ctx.settings
    .describe()
    .find((d) => d.ns === "task-system").revision;
  await assert.rejects(
    ctx.settings.mutate(
      "task-system",
      [{ op: "set", path: ["maxConcurrent"], value: 5 }],
      revision,
    ),
    /overridden/,
  );
  assert.equal(readFileSync(profile.patchPath, "utf8"), fixed);
  pass(
    "command-line whole-config override is reported and refuses Save without a disk write",
  );
  console.log(
    JSON.stringify({
      ok: true,
      checks: passed.length,
      network: "none",
      credentials: "none",
      scope: "disposable profile and synthetic scripted model only",
    }),
  );
} finally {
  if (ctx) await ctx.fiber.dispose();
  rmSync(tmp, { recursive: true, force: true });
}
