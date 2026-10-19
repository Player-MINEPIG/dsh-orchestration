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
import { existsSync } from "node:fs";
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
const staged=join(tmp,"package");mkdirSync(staged);const modules=join(dir,"node_modules");mkdirSync(join(modules,"@dsh-task"),{recursive:true});symlinkSync(staged,join(modules,"@dsh-task","task-system"));
writeFileSync(join(staged,"package.json"),JSON.stringify({name:"@dsh-task/task-system",type:"module",exports:{".":"./settings.mjs","./plugin":"./plugin.mjs","./remote":"./remote.mjs"}}));
symlinkSync(resolve("packages/task-system/dist/index.js"),join(staged,"settings.mjs"));symlinkSync(resolve("packages/task-system/dist/dsh-plugin.js"),join(staged,"plugin.mjs"));
symlinkSync(resolve("packages/jev"),join(modules,"dsh-jev-plugin"));
const failFlag=join(tmp,"fail");writeFileSync(join(staged,"remote.mjs"),`export * from ${JSON.stringify(pathToFileURL(resolve("packages/task-system/dist/remote/index.js")).href)};import {apply as realApply} from ${JSON.stringify(pathToFileURL(resolve("packages/task-system/dist/remote/index.js")).href)};import {existsSync} from 'node:fs';export async function apply(ctx,config){if(existsSync(${JSON.stringify(failFlag)}))throw Error('fixture HMR activation failed');return realApply(ctx,config);}`);
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
let ctx;let passed=0;
const invoke=(method,args={})=>ctx.typertGateway.invoke({peer,namespace:"taskPluginSettings",method,args});
try {
 ctx=await start();peer=new Peer(ctx,{principal:{kind:"owner"}});
 const before=await invoke("connectionSettings"),bytes=readFileSync(profile.patchPath,"utf8");writeFileSync(failFlag,"fail");
 await assert.rejects(invoke("saveConnectionSettings",{input:{expected:before.revision,value:before.values}}),/failed|activate|entry|loading/i);
 assert.equal(readFileSync(profile.patchPath,"utf8"),bytes);assert.equal((await invoke("connectionSettings")).exists,false);assert.equal(ctx.get("taskSystem").configurationPaused,false);assert.equal(ctx.get("remoteExecution"),undefined);passed++;
 rmSync(failFlag);const result=await invoke("saveConnectionSettings",{input:{expected:(await invoke("connectionSettings")).revision,value:before.values}});assert.equal(result.exists,true);assert.equal(result.paused,true);assert.equal(ctx.get("remoteExecution").store,undefined);passed++;
 const expected=result.revision;const attempts=await Promise.allSettled([1,2].map(n=>invoke("saveConnectionSettings",{input:{expected,value:{...result.values,serviceAudience:"audience-"+n}}})));assert.equal(attempts.filter(r=>r.status==="fulfilled").length,1);assert.equal(attempts.filter(r=>r.status==="rejected").length,1);assert.equal(ctx.get("taskSystem").configurationPaused,false);passed++;
 console.log(JSON.stringify({ok:true,checks:passed,topology:"official runtime boot plus profile-installed plugin",activationFailureRolledBack:true,saveAfterFailure:true,concurrentCAS:true,productionWrites:0}));
} finally {if(ctx)await ctx.fiber.dispose();rmSync(tmp,{recursive:true,force:true});}
