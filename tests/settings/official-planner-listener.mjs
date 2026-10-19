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
  workspaceRoots: [{ id: "fixture-root", path: tmp, allowCreate: false }],
  localNode: {
    workspaceIds: ["default"],
    models: [
      { provider: "test-offline", model: "script", reasoningEfforts: [] },
    ],
    maxConcurrent: 4,
  },
};
delete taskConfig.localNode;taskConfig.role="planner";
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

let ctx;const {createServer}=await import('node:net');const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
rows.push({id:'task-remote-execution',name:'@dsh-task/task-system/remote',config:{role:'executor',nodeId:'fixture',paused:true,authMode:'trusted-network',statePath:join(tmp,'remote.sqlite'),exposeHttp:true,audience:'fixture',trustedNetwork:{listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.2'],peers:[{address:'127.0.0.2',nodeId:'peer',role:'executor',audience:'fixture',operations:['executorIdentity'],workspaces:[],capabilities:[]}]}}});
writeFileSync(profile.patchPath,JSON.stringify([{insert:rows}]));
try {
 ctx=await start();peer=new Peer(ctx,{principal:{kind:'owner'}});const invoke=(method,args={})=>ctx.typertGateway.invoke({peer,namespace:'taskPluginSettings',method,args});
 const before=await invoke('startup');assert.equal(before.remote.values.role,'planner');assert.equal(before.remote.values.endpoint,null);
 const connection=await invoke('connectionSettings');assert.equal(connection.values.listenerEnabled,false);
 const enabled=await invoke('saveConnectionSettings',{input:{expected:connection.revision,value:{...connection.values,listenerEnabled:true}}});assert.equal(enabled.values.listenerEnabled,true);
 assert.equal(ctx.get('remoteExecution').settingsSnapshot().role,'planner');assert.equal(ctx.get('remoteExecution').nativeWorker,undefined);
 const {connect}=await import('node:net');const socket=connect({host:'127.0.0.1',port});await new Promise((done,fail)=>{socket.once('connect',done);socket.once('error',fail)});socket.destroy();
 const current=await invoke('connectionSettings');await invoke('saveConnectionSettings',{input:{expected:current.revision,value:{...current.values,listenerEnabled:false}}});
 console.log(JSON.stringify({ok:true,plannerWithoutUpstreamCanActivateValidListener:true,remoteEffectiveRole:'planner',independentExecutorRoleIgnored:true,productionWrites:0,modelCalls:0}));
} finally {if(ctx)await ctx.fiber.dispose();rmSync(tmp,{recursive:true,force:true});}
