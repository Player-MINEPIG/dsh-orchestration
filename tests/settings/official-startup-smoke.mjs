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
const { Peer } = await import(url("@deepseek-ai/dsh-client-connection"));
let peer;
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
  symlinkSync(resolve("packages/jev"),join(modules,"dsh-jev-plugin"),"dir");
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
  sessionDecisionEnabled:true,
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
  ["remote-access", "@deepseek-ai/dsh-api-remote-access"],
  ["gateway", "@deepseek-ai/dsh-api-gateway"],
].map(([id, p, config]) => ({ id, name: url(p), config }));
rows.push({id:"jev",name:"dsh-jev-plugin",config:{provider:"native",nativeProvider:"test-offline",model:"script",profiles:[{id:"a",name:"A",provider:"native",nativeProvider:"test-offline",model:"script"},{id:"b",name:"B",provider:"native",nativeProvider:"test-offline",model:"script"}]}});
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
  ctx.typertGateway.invoke({ peer, namespace: "taskPluginSettings", method, args });
try {
  ctx = await start();
  peer = new Peer(ctx, { principal: { kind: "owner" } });
  ctx.get("taskSystem").ledger.registerWorkspace("fixture-workspace", {
    workspaceId: "default",
    nodeId: "fixture",
    path: tmp,
    label: "Fixture",
    state: "ready",
    createdAt: new Date().toISOString(),
  });
  const blank=await invoke("connectionSettings");assert.equal(blank.exists,false);
  for(const role of ["executor","both"]){const roleSnapshot=await invoke("startup");await invoke("saveStartup",{input:{target:"task",expected:roleSnapshot.task.values,changes:{role}}});}
  const draft={...blank.values,listenAddress:"127.0.0.1",listenPort:45678,serviceAudience:"fixture-audience",peers:[{address:"127.0.0.2",nodeId:"connection-only",role:"executor",audience:"fixture-audience",operations:["executorIdentity"],workspaces:[],capabilities:[]}],outbound:{endpoint:"http://127.0.0.3:45679/commands",audience:"scheduler",target:{address:"127.0.0.3",port:45679,localAddress:"127.0.0.2",allowHttp:true}}};
  const created=await invoke("saveConnectionSettings",{input:{expected:blank.revision,value:draft}});assert.equal(created.exists,true);assert.equal(created.paused,true);assert.equal(created.values.listenerEnabled,false);assert.equal(ctx.get("remoteExecution").store,undefined);
  assert.deepEqual(created.values.peers,draft.peers);assert.deepEqual(created.values.outbound,draft.outbound);assert.equal(ctx.get("taskSystem").ledger.nodeStatuses().some(n=>n.nodeId==="connection-only"),false);
  await assert.rejects(invoke("saveConnectionSettings",{input:{expected:blank.revision,value:draft}}),/changed|conflict/i);
  const changed=await invoke("saveConnectionSettings",{input:{expected:created.revision,value:{...created.values,listenPort:45680}}});assert.equal(changed.values.listenPort,45680);assert.equal(changed.paused,true);
  pass("official Gateway creates paused connection config explicitly, persists both endpoint roles, refuses stale CAS and creates no execution grants or network store");
  const snapshot = await invoke("startup");
  assert.equal(snapshot.applies, "plugin-restart");
  assert.equal(snapshot.writable, true);
  assert.equal(snapshot.remote.values.paused,true);
  assert.equal(snapshot.task.entryId, "task-system");
  assert.deepEqual(Object.keys(snapshot.task.values).sort(), [
    "nodeCapacities",
    "planningDecisionEnabled",
    "role",
    "sessionDecisionEnabled",
  ]);
  assert.equal(snapshot.task.values.planningDecisionEnabled, true);
  const directory = await invoke("workspaces");
  assert.equal(directory.scope.entryId, snapshot.task.entryId);
  assert.equal(directory.scope.nodeId, "fixture");
  assert.ok(
    directory.items.some(
      (item) =>
        item.workspaceId === snapshot.task.values.defaultWorkspaceId ||
        item.available,
    ),
  );
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
      planningDecisionEnabled: false,
    },
  };
  const connectionEditor=ctx.get("configEditor"),connectionEntry=connectionEditor.entries().find(e=>e.options.id==="task-remote-execution");
  const originalConnectionRole=connectionEntry.options.config.role;
  const {createServer}=await import("node:net");const socket=createServer();await new Promise(done=>socket.listen(0,"127.0.0.1",done));const listenerPort=socket.address().port;await new Promise(done=>socket.close(done));
  await connectionEditor.edit(connectionEntry,current=>({...current,paused:false,exposeHttp:true,coordinator:null,trustedNetwork:{...current.trustedNetwork,listen:{...current.trustedNetwork.listen,port:listenerPort}}}));
  const beforeRoleBytes=readFileSync(profile.patchPath,"utf8"),beforeRoleService=ctx.get("taskSystem");
  await assert.rejects(invoke("saveStartup",{input}),/conflict|role|listener|Pause/i);
  assert.equal(readFileSync(profile.patchPath,"utf8"),beforeRoleBytes);assert.equal(ctx.get("taskSystem").config.role,"both");assert.equal(ctx.get("remoteExecution").settingsSnapshot().role,"both");
  const activeSnapshot=await invoke("startup");await invoke("saveStartup",{input:{target:"remote",expected:activeSnapshot.remote.values,changes:{paused:true}}});
  pass("top-level role preflight rejects executor plus active scheduler listener before writing, preserving both running services");
  const oldRemote=ctx.get("remoteExecution"),combinedConnection=await invoke("connectionSettings");
  const result = await invoke("saveStartup", { input });
  const combinedSave=await invoke("saveConnectionSettings",{input:{expected:combinedConnection.revision,value:{...combinedConnection.values,routePath:"/fixture-new-commands"}}});assert.equal(combinedSave.values.routePath,"/fixture-new-commands");
  await assert.rejects(invoke("saveConnectionSettings",{input:{expected:combinedConnection.revision,value:{...combinedConnection.values,routePath:"/stale-commands"}}}),/conflict|changed/i);
  pass("real RPC ordering saves role plus decision switches then a preexisting connection draft once; concurrent connection edits still conflict");
  assert.notEqual(ctx.get("remoteExecution"),oldRemote);assert.equal(ctx.get("remoteExecution").settingsSnapshot().role,"executor");
  assert.equal(ctx.get("configEditor").entries().find(e=>e.options.id==="task-remote-execution").options.config.role,originalConnectionRole);
  await assert.rejects(invoke("saveStartup",{input:{target:"remote",expected:(await invoke("startup")).remote.values,changes:{role:"both"}}}));
  const connectionView=await invoke("connectionSettings");assert.equal("role" in connectionView.values,false);await assert.rejects(invoke("saveConnectionSettings",{input:{expected:connectionView.revision,value:{...connectionView.values,role:"both"}}}));
  pass("one task role drives dependent remote HMR and rejects independent connection role writes without migrating old profile values");
  assert.deepEqual(result, { saved: true, applies: "plugin-restart" });
  const updated = await invoke("startup");
  const service = ctx.get("taskSystem");
  assert.notEqual(service, originalService);
  assert.equal(service.config.role, "executor");
  assert.equal(service.config.defaultWorkspaceId, undefined);
  assert.equal(service.config.planningDecisionEnabled, false);
  assert.equal(updated.task.values.planningDecisionEnabled, false);
  assert.equal(service.config.sessionDecisionEnabled, true);
  assert.equal(service.config.schedulerEnabled, false);
  assert.equal(service.config.autoExecute, false);
  assert.equal(service.ledger.schedulerIdentity(), identity);
  assert.equal(updated.task.values.role, "executor");
  assert.equal("defaultWorkspaceId" in updated.task.values,false);
  pass(
    "public Gateway save really restarts the plugin and read-after-save confirms role/workspace/decision values without model calls",
  );
  const persisted = readFileSync(profile.patchPath, "utf8");
  assert.ok(persisted.includes("sessionDecisionEnabled"));
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
  await assert.rejects(invoke("executorIdentity"), /authenticated|connection|REMOTE_PAUSED/i);
  const queue = await invoke("queue");
  assert.equal(queue.items.length, 0);
  pass(
    "actual Gateway rejects stale startup edits, identity mutation and unconfigured identity queries; queue remains read only",
  );
  await ctx.fiber.dispose();
  ctx = await start();
  peer = new Peer(ctx, { principal: { kind: "owner" } });
  const reopened = await invoke("startup");
  assert.equal("defaultWorkspaceId" in reopened.task.values,false);
  assert.equal((await invoke("connectionSettings")).values.listenPort,listenerPort);
  assert.equal(reopened.task.values.planningDecisionEnabled, false);
  assert.equal(reopened.task.values.sessionDecisionEnabled, true);
  assert.equal(ctx.get("taskSystem").ledger.schedulerIdentity(), identity);
  const restored = await invoke("saveStartup", {
    input: {
      target: "task",
      expected: reopened.task.values,
      changes: {
        role: "both",
        planningDecisionEnabled: true,
      },
    },
  });
  assert.equal(restored.saved, true);
  const final = await invoke("startup");
  assert.equal("defaultWorkspaceId" in final.task.values,false);
  assert.equal(final.task.values.role, "both");
  assert.equal(final.task.values.planningDecisionEnabled, true);
  assert.equal(final.task.values.sessionDecisionEnabled, true);
  pass(
    "restart persistence and explicit null default restoration use the real official ConfigEditor",
  );
  // Provision one existing node in this isolated fixture, then edit only its capacity through the public RPC.
  const editor = ctx.get("configEditor");
  const taskEntry = editor.entries().find(entry => entry.options.id === "task-system");
  await editor.edit(taskEntry, current => ({...current, remoteNodes: [{nodeId:"capacity-worker", roles:["executor"], enabled:true, models:[{provider:"test-offline",model:"script",reasoningEfforts:[]}], workspaceIds:[], capabilities:[], maxConcurrent:1}]}));
  const capacityBefore = await invoke("startup");
  assert.equal(ctx.get("taskSystem").ledger.getNode("capacity-worker").maxConcurrent, 1);
  const capacityService=ctx.get("taskSystem"), remoteService=ctx.get("remoteExecution");
  const capacityResult=await invoke("saveStartup", {input:{target:"task",expected:capacityBefore.task.values,changes:{nodeCapacities:[{nodeId:"capacity-worker",maxConcurrent:2}]}}});
  assert.equal(capacityResult.applies,"live");assert.equal(ctx.get("taskSystem").ledger===capacityService.ledger,true,"task service must survive capacity save");assert.equal(ctx.get("remoteExecution")?.config===remoteService?.config,true,"remote service must survive capacity save");
  assert.equal(ctx.get("taskSystem").ledger.getNode("capacity-worker").maxConcurrent, 2);
  await ctx.fiber.dispose();
  ctx = await start();
  peer = new Peer(ctx, { principal: { kind: "owner" } });
  assert.equal(ctx.get("taskSystem").ledger.getNode("capacity-worker").maxConcurrent, 2);
  assert.equal((await invoke("startup")).task.values.nodeCapacities[0].maxConcurrent, 2);
  const remoteEntry=ctx.get("configEditor").entries().find(entry=>entry.options.id==="task-remote-execution"), remoteFiber=remoteEntry.fiber;
  const remoteBefore=await invoke("startup");
  const limitsResult=await invoke("saveStartup",{input:{target:"remote",expected:remoteBefore.remote.values,changes:{concurrency:2,pollIntervalMs:1100}}});
  assert.equal(limitsResult.applies,"live");assert.equal(remoteEntry.fiber,remoteFiber);
  assert.equal(ctx.get("remoteExecution").settingsSnapshot().concurrency,2);assert.equal(ctx.get("remoteExecution").settingsSnapshot().pollIntervalMs,1100);
  const decisionEntry=ctx.get("configEditor").entries().find(entry=>entry.options.id==="jev"), decisionFiber=decisionEntry.fiber;
  const {readDecisionPreferences,saveDecisionPreference}=await import("../../packages/task-system/dist/decision-preferences.js");
  const view=readDecisionPreferences(ctx);
  const bindingResult=await saveDecisionPreference(ctx,{expected:view.revision,consumer:"task-planning",id:"b"});
  assert.equal(bindingResult.applies,"live");assert.equal(decisionEntry.fiber,decisionFiber);assert.equal(ctx.get("taskSystem").config.decisionBindings["task-planning"],"b");
  await ctx.fiber.dispose();ctx=await start();
  peer = new Peer(ctx, { principal: { kind: "owner" } });
  assert.equal(ctx.get("remoteExecution").settingsSnapshot().concurrency,2);assert.equal(ctx.get("taskSystem").config.decisionBindings["task-planning"],"b");
  pass("official ConfigEditor hot-updates remote execution limits and decision bindings without replacing fibers; both persist across boot");
  pass("public capacity RPC updates the ledger without replacing either service and remains effective after a fresh host boot");
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
