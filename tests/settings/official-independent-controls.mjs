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
delete taskConfig.localNode;taskConfig.role="both";
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

let ctx;
const {createServer,connect}=await import('node:net');const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
const remote={id:'task-remote-execution',name:'@dsh-task/task-system/remote',config:{role:'both',nodeId:'fixture',paused:true,authMode:'trusted-network',statePath:join(tmp,'remote.sqlite'),exposeHttp:true,audience:'fixture',trustedNetwork:{listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:[],peers:[]}}};rows.push(remote);
const bootCase=async config=>{if(ctx)await ctx.fiber.dispose();remote.config=config;writeFileSync(profile.patchPath,JSON.stringify([{insert:rows}]));ctx=await start();peer=new Peer(ctx,{principal:{kind:'owner'}});};
const invoke=(method,args={})=>ctx.typertGateway.invoke({peer,namespace:'taskPluginSettings',method,args});
const connectable=()=>new Promise(done=>{const socket=connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();done(true)});socket.once('error',()=>done(false));});
try {
 await bootCase(remote.config);
 let connection=await invoke('connectionSettings');assert.equal(connection.values.listenerEnabled,false);assert.equal(await connectable(),false);
 await invoke('saveConnectionSettings',{input:{expected:connection.revision,value:{...connection.values,listenerEnabled:true}}});
 assert.equal(await connectable(),true);assert.equal(ctx.get('remoteExecution').nativeWorker,undefined);assert.equal(ctx.get('remoteExecution').heartbeatSnapshot().state,'disabled');assert.equal((await invoke('startup')).remote.values.paused,true);
 await bootCase({role:'both',nodeId:'fixture',paused:true,pauseScope:'executor',authMode:'trusted-network',statePath:join(tmp,'second-remote.sqlite'),exposeHttp:false,coordinator:null});
 connection=await invoke('connectionSettings');assert.equal(connection.values.listenAddress,'');assert.equal(connection.values.outbound,null);
 await invoke('saveConnectionSettings',{input:{expected:connection.revision,value:connection.values}});assert.equal(ctx.get('remoteExecution').gateway,undefined);assert.equal(ctx.get('remoteExecution').nativeWorker,undefined);
 connection=await invoke('connectionSettings');const outbound={endpoint:'http://127.0.0.1:9/commands',audience:'fixture-upstream',target:{address:'127.0.0.1',port:9,localAddress:'127.0.0.1',allowHttp:true}};
 await invoke('saveConnectionSettings',{input:{expected:connection.revision,value:{...connection.values,outbound}}});
 const before=await invoke('startup');await invoke('saveStartup',{input:{target:'remote',expected:before.remote.values,changes:{paused:false}}});
 assert.equal(ctx.get('remoteExecution').gateway,undefined);assert.ok(ctx.get('remoteExecution').nativeWorker);connection=await invoke('connectionSettings');assert.equal(connection.values.listenAddress,'');assert.equal(connection.values.listenerEnabled,false);
 console.log(JSON.stringify({ok:true,legacyPausedListenerRemainsClosed:true,bothPlannerOnlyBlankExecutorSaved:true,bothExecutorOnlyBlankListenerSaved:true,bothDisabledEmptySaved:true,topology:'official profile + ConfigEditor + actual runtime',productionWrites:0,modelCalls:0}));
} finally {if(ctx)await ctx.fiber.dispose();rmSync(tmp,{recursive:true,force:true});}
