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
const tmp = mkdtempSync(join(tmpdir(), "dsh-decision-settings-"));
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
const compatible = {
  id: "compatible",
  kind: "compatible",
  endpoint: "https://fixture.invalid/decision",
  model: "old",
  modelVersion: "old-version",
  apiKeyEnv: "FIXTURE_UNSET_KEY",
  maxResponseBytes: 1024,
  capabilityDeclaration: {
    readout: "logits",
    calibration: "none",
    maxChoices: 26,
    maxScoreLevels: 10,
    questionTypes: ["choice"],
    reasoningEfforts: [],
  },
  unknownProvider: "preserved",
};
const decisionConfig = {
  defaultProvider: "rules",
  providers: [
    { id: "rules", kind: "rules", rulesVersion: "1", rules: [] },
    compatible,
  ],
  unknownTop: "preserved",
};
const bridgeConfig = {
  routes: [
    {
      model: "keep",
      provider: "offline",
      modelVersion: "keep-model",
      reasoningEfforts: [],
    },
  ],
  maxOutputTokens: 2048,
  maxInputBytes: 65536,
  maxOutputBytes: 131072,
  maxRuntimeMs: 10000,
  maxConcurrent: 2,
  unknownBridge: "preserved",
};
rows.push({
  id: "typed-decision-native-completion",
  name: "@dsh-task/typed-decisions/dsh-completion",
  config: bridgeConfig,
});
rows.push({
  id: "task-typed-decisions",
  name: "@dsh-task/typed-decisions",
  config: decisionConfig,
});
rows.push({
  id: "task-remote-execution",
  name: "@dsh-task/task-system/remote",
  config: {
    nodeId: "fixture",
    role: "executor",
    paused: true,
    pollIntervalMs: 0,
  },
});
writeFileSync(profile.patchPath, JSON.stringify([{ insert: rows }]));
writeFileSync(root, "[]\n");
const start = async () => {
  const host = await boot(
    "decision-settings-smoke",
    root,
    readProfilePatches("decision-settings-smoke", profile),
    (c) => c.provide("profileContext", profile),
  );
  const adapter = new ScriptedModel([]);
  adapter.listModels = async (provider) => [
    { provider, id: "keep-model", name: "Keep model" },
    { provider, id: "selected-model", name: "Selected model" },
  ];
  adapter.resolveModel = async (provider, model) => ({
    provider,
    id: model,
    name: model,
    reasoning: { efforts: [{ id: "low", name: "Low" }], defaultEffort: "low" },
  });
  host.llm.registerAdapter(["offline"], adapter);
  return { host, adapter };
};
let ctx, adapter;
const passed = [];
const pass = (name) => {
  passed.push(name);
  console.log(`PASS ${name}`);
};
const invoke = (method, args = {}) =>
  ctx.typertGateway.invoke({ namespace: "taskPluginSettings", method, args });
const raw = (name) =>
  ctx.configEditor.entries().find((e) => e.options.name === name).options
    .config;
try {
  ({ host: ctx, adapter } = await start());
  let view = await invoke("decisionSettings");
  assert.equal(view.available, true);
  assert.equal(view.snapshot.defaultProvider, "rules");
  assert.equal(view.catalog[0].provider, "offline");
  assert.equal(view.catalog[0].models.length, 2);
  assert.equal(
    view.readiness.find((r) => r.providerId === "compatible").status,
    "credential-missing",
  );
  assert.ok(!JSON.stringify(view).includes("FIXTURE_UNSET_KEY"));
  const originalDecision = ctx.get("typedDecisions"),
    originalBridge = ctx.get("typedDecisionCompletion");
  pass(
    "official Gateway projects existing local Models catalog without credentials or model calls",
  );
  const input = {
    expected: view.snapshot,
    selection: {
      kind: "structured",
      providerId: "ordinary",
      nativeProvider: "offline",
      modelVersion: "selected-model",
    },
  };
  assert.deepEqual(await invoke("saveDecisionSettings", { input }), {
    saved: true,
    applies: "plugin-restart",
  });
  view = await invoke("decisionSettings");
  assert.equal(view.snapshot.defaultProvider, "ordinary");
  assert.notEqual(ctx.get("typedDecisions"), originalDecision);
  assert.notEqual(ctx.get("typedDecisionCompletion"), originalBridge);
  assert.equal(
    ctx.get("typedDecisions").capabilities().models[0].version,
    "selected-model",
  );
  assert.equal(ctx.get("typedDecisionCompletion").routes.length, 2);
  assert.deepEqual(
    ctx.get("typedDecisionCompletion").routes[1].reasoningEfforts,
    ["low"],
  );
  assert.deepEqual(
    ctx.get("typedDecisionCompletion").routes[0].reasoningEfforts,
    [],
  );
  assert.deepEqual(
    raw("@dsh-task/typed-decisions").providers.find(
      (p) => p.id === "compatible",
    ),
    compatible,
  );
  assert.equal(raw("@dsh-task/typed-decisions").unknownTop, "preserved");
  assert.equal(
    raw("@dsh-task/typed-decisions/dsh-completion").unknownBridge,
    "preserved",
  );
  assert.deepEqual(
    raw("@dsh-task/typed-decisions/dsh-completion").routes[0],
    bridgeConfig.routes[0],
  );
  assert.equal(raw("@dsh-task/task-system/remote").paused, true);
  pass(
    "real ConfigEditor persists and restarts both route owners while preserving other routes, unknown fields and env references",
  );
  const persisted = readFileSync(profile.patchPath, "utf8");
  await assert.rejects(
    invoke("saveDecisionSettings", { input }),
    /DECISION_CONFLICT/,
  );
  await assert.rejects(
    invoke("saveDecisionSettings", {
      input: {
        expected: view.snapshot,
        selection: { ...input.selection, apiKeyEnv: "NEW_KEY" },
      },
    }),
  );
  assert.equal(readFileSync(profile.patchPath, "utf8"), persisted);
  pass(
    "actual Gateway rejects stale CAS and secret/env mutations without changing the profile",
  );
  const compatibleInput = {
    expected: view.snapshot,
    selection: {
      kind: "compatible",
      providerId: "compatible",
      model: "new",
      modelVersion: "new-version",
      endpoint: "https://fixture.invalid/new",
    },
  };
  await invoke("saveDecisionSettings", { input: compatibleInput });
  const changed = raw("@dsh-task/typed-decisions").providers.find(
    (p) => p.id === "compatible",
  );
  assert.equal(changed.model, "new");
  assert.equal(changed.endpoint, "https://fixture.invalid/new");
  assert.equal(changed.apiKeyEnv, compatible.apiKeyEnv);
  assert.deepEqual(
    changed.capabilityDeclaration,
    compatible.capabilityDeclaration,
  );
  assert.equal(changed.unknownProvider, "preserved");
  assert.equal(
    (await invoke("decisionSettings")).readiness.find(
      (p) => p.providerId === "compatible",
    ).status,
    "credential-missing",
  );
  pass(
    "non-secret compatible model/endpoint saves while missing credentials remain accurately not ready",
  );
  assert.equal(adapter.requests.length, 0);
  await ctx.fiber.dispose();
  ctx = undefined;
  ({ host: ctx, adapter } = await start());
  view = await invoke("decisionSettings");
  assert.equal(view.snapshot.defaultProvider, "compatible");
  assert.equal(
    view.snapshot.providers.find((p) => p.id === "compatible").modelVersion,
    "new-version",
  );
  assert.equal(raw("@dsh-task/task-system/remote").paused, true);
  assert.equal(adapter.requests.length, 0);
  pass(
    "isolated official host reboot restores saved model settings and keeps remote paused",
  );
  console.log(
    JSON.stringify({
      ok: true,
      checks: passed.length,
      modelCalls: 0,
      remotePaused: true,
      existingServicesTouched: false,
    }),
  );
} finally {
  if (ctx) await ctx.fiber.dispose();
  rmSync(tmp, { recursive: true, force: true });
}
