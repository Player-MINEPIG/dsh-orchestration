import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
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
const failFlag=join(tmp,"fail");writeFileSync(join(staged,"remote.mjs"),`export * from ${JSON.stringify(pathToFileURL(resolve("packages/task-system/dist/remote/index.js")).href)};import {apply as realApply} from ${JSON.stringify(pathToFileURL(resolve("packages/task-system/dist/remote/index.js")).href)};import {existsSync,readFileSync} from 'node:fs';export async function apply(ctx,config){if(existsSync(${JSON.stringify(failFlag)}) && (readFileSync(${JSON.stringify(failFlag)},'utf8')==='fail' || readFileSync(${JSON.stringify(failFlag)},'utf8')===config.coordinator?.endpoint))throw Error('fixture HMR activation failed');return realApply(ctx,config);}`);
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
const {TaskLedger}=await import('../../packages/task-system/dist/ledger.js');
const seed=TaskLedger.open(taskConfig.databasePath,{nodeId:'fixture',role:'both'});seed.registerWorkspace('seed-workspace',{workspaceId:'default',nodeId:'fixture',path:tmp,label:'Original workspace',state:'ready',createdAt:new Date().toISOString()});seed.close();taskConfig.defaultWorkspaceId='default';
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
const {createServer}=await import('node:http');

const {RecoveryStore,RemoteGateway,TrustedNetworkVerifier,httpHandler}=await import('../../packages/task-system/dist/remote/api.js');
const {setTimeout:delay}=await import('node:timers/promises');
const until=async predicate=>{for(let i=0;i<400;i++){if(await predicate())return;await delay(10);}throw Error('fixture condition timed out');};
const coordinator=async suffix=>{
 const ledger=TaskLedger.open(join(tmp,`planner-${suffix}.sqlite`),{role:'planner',nodeId:`planner-${suffix}`}),store=new RecoveryStore(join(tmp,`server-${suffix}.sqlite`));
 let handler,hold=null;const server=createServer((req,res)=>handler(req,res));await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;
 const policy={listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1'],peers:[{address:'127.0.0.1',nodeId:'',nickname:'fixture',role:'executor',audience:'planner',operations:[],workspaces:[],capabilities:[]}]};
 const gateway=new RemoteGateway({role:'planner',nodeId:`planner-${suffix}`,ledger,store,verifier:new TrustedNetworkVerifier({...policy,audience:'planner',pairings:store})});
 const state={heartbeats:0,reads:0};const actualHandle=gateway.handle.bind(gateway);gateway.handle=async(body,transport)=>{const envelope=JSON.parse(String(body));if(envelope.operation==='heartbeat'){state.heartbeats++;if(hold){const gate=hold;hold=null;gate.entered();await gate.promise;if(gate.fail)throw Error('fixture delayed heartbeat failure');}}else state.reads++;return actualHandle(body,transport);};handler=httpHandler(gateway,{trustedNetwork:policy});
 return {...state,port,endpoint:`http://127.0.0.1:${port}/commands`,target:{address:'127.0.0.1',port,localAddress:'127.0.0.1',allowHttp:true},state,hold(fail=false){let entered,release;const seen=new Promise(done=>entered=done),promise=new Promise(done=>release=done);hold={entered,promise,fail};return {seen,release};},close:async()=>{await gateway.dispose();await new Promise(done=>server.close(done));store.close();ledger.close();}};
};
const first=await coordinator('first'),second=await coordinator('second');
rows.push({id:'task-remote-execution',name:'@dsh-task/task-system/remote',config:{role:'executor',nodeId:'fixture',paused:false,pauseScope:'executor',authMode:'trusted-network',statePath:join(tmp,'remote.sqlite'),exposeHttp:false,pollIntervalMs:100,taskSessionsEnabled:true,coordinator:{endpoint:first.endpoint,audience:'planner',authMode:'trusted-network',trustedNetwork:first.target,heartbeatIntervalMs:1000,nativeRoutes:[]}}});
writeFileSync(profile.patchPath,JSON.stringify([{insert:rows}]));
const invoke=(method,args={})=>ctx.typertGateway.invoke({peer,namespace:'taskPluginSettings',method,args});
const change=async endpoint=>{const snapshot=await invoke('startup');const destination=endpoint===first.endpoint?first:second;return invoke('saveStartup',{input:{target:'remote',expected:snapshot.remote.values,changes:{endpoint,trustedNetworkTarget:destination.target}}});};
try {
 const initial=first.hold();ctx=await start();peer=new Peer(ctx,{principal:{kind:'owner'}});await initial.seen;
 const old=ctx.get('remoteExecution'),count=first.state.heartbeats;let completed=false;const saving=change(second.endpoint).then(value=>{completed=true;return value;});await until(()=>old.configurationPaused);
 await assert.rejects(old.beginConfigurationEdit(),{code:'CONFIGURATION_BUSY'});await assert.rejects(old.heartbeatNow(),{code:'CONFIGURATION_BUSY'});await delay(1100);assert.equal(first.state.heartbeats,count);assert.equal(completed,false);
 initial.release();assert.equal((await saving).saved,true);await until(()=>ctx.get('remoteExecution').heartbeatSnapshot().state==='acknowledged');assert.equal(ctx.get('remoteExecution').settingsSnapshot().endpoint,second.endpoint);assert.throws(()=>old.store.networkPairings(),/closed|not open/i);passed++;
 const held=second.hold();const pending=ctx.get('remoteExecution').heartbeatNow();await held.seen;const bytes=readFileSync(profile.patchPath,'utf8');writeFileSync(failFlag,first.endpoint);
 const failed=change(first.endpoint);await until(()=>ctx.get('remoteExecution').configurationPaused);held.release();await pending;await assert.rejects(failed,error=>error.details?.reason==='STARTUP_SAVE_FAILED');assert.equal(readFileSync(profile.patchPath,'utf8'),bytes);assert.equal(ctx.get('remoteExecution').settingsSnapshot().endpoint,second.endpoint);rmSync(failFlag);
 const restored=second.state.heartbeats;await until(()=>second.state.heartbeats>restored);await until(()=>ctx.get('remoteExecution').heartbeatSnapshot().state==='acknowledged');passed++;
 const bad=second.hold(true);const rejected=ctx.get('remoteExecution').heartbeatNow().catch(()=>null);await bad.seen;const switched=change(first.endpoint);await until(()=>ctx.get('remoteExecution').configurationPaused);bad.release();await rejected;assert.equal((await switched).saved,true);await until(()=>ctx.get('remoteExecution').heartbeatSnapshot().state==='acknowledged');assert.equal(ctx.get('remoteExecution').settingsSnapshot().endpoint,first.endpoint);passed++;
 const final=first.hold(true);const failedHeartbeat=ctx.get('remoteExecution').heartbeatNow().catch(()=>null);await final.seen;const retiring=ctx.get('remoteExecution'),disposal=ctx.fiber.dispose();final.release();await failedHeartbeat;await disposal;ctx=undefined;assert.throws(()=>retiring.store.networkPairings(),/closed|not open/i);passed++;
 console.log(JSON.stringify({ok:true,checks:passed,topology:'official profile ConfigEditor HMR + delayed real HTTP heartbeat',saveWaitsForHeartbeat:true,noNewHeartbeatWhileEditing:true,concurrentEditRejected:true,hmrSwitchesCoordinator:true,failedSaveRestoresOldHeartbeats:true,failedHeartbeatDoesNotBlockSwitch:true,failedHeartbeatDisposalClosesStore:true,productionWrites:0,modelCalls:0}));
} finally {if(ctx)await ctx.fiber.dispose();await first.close();await second.close();rmSync(tmp,{recursive:true,force:true});}
