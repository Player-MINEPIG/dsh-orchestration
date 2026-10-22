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

const { Peer } = await import(url("@deepseek-ai/dsh-client-connection"));
let peer;
const tmp = mkdtempSync(join(tmpdir(), "dsh-executor-preset-ui-"));
const home = join(tmp, "home"),
  dir = join(home, "profiles", "startup-fixture");
mkdirSync(home, { recursive: true });
initProfile(dir, []);
const staged=join(tmp,"package");mkdirSync(staged);const modules=join(dir,"node_modules");mkdirSync(join(modules,"@dsh-task"),{recursive:true});symlinkSync(staged,join(modules,"@dsh-task","task-system"));
writeFileSync(join(staged,"package.json"),JSON.stringify({name:"@dsh-task/task-system",type:"module",exports:{".":"./settings.mjs","./plugin":"./plugin.mjs"}}));
symlinkSync(resolve("packages/task-system/dist/index.js"),join(staged,"settings.mjs"));symlinkSync(resolve("packages/task-system/dist/dsh-plugin.js"),join(staged,"plugin.mjs"));
symlinkSync(resolve("packages/jev"),join(modules,"dsh-jev-plugin"));
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
  role: "executor",
  keepAlive: false,
  schedulerEnabled: false,
  autoExecute: false,
  healthAlerts: false,
  executionTools:["activity_sources_read","task_dispatch"],
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

rows.push({id:'official-agent-presets',name:url('@deepseek-ai/dsh-agent-preset-registry'),config:{default:'files'}});
rows.push({id:'files-preset',name:url('@deepseek-ai/dsh-agent-preset'),config:{id:'files',name:'只读文件 preset',description:'官方文件读取工具；不提供写入工具',plugins:[{name:url('@deepseek-ai/dsh-tool-fs'),config:{read:true,readImage:false,write:false,edit:false}}]}});
rows.push({id:'empty-preset',name:url('@deepseek-ai/dsh-agent-preset'),config:{id:'empty',name:'空工具 preset',plugins:[]}});
rows.push({id:'fs',name:url('@deepseek-ai/dsh-fs-local'),config:{cwd:tmp}});
rows.push({id:'working-directory',name:url('@deepseek-ai/dsh-working-directory'),config:{defaultDirectory:tmp}});
writeFileSync(profile.patchPath,JSON.stringify([{insert:rows}]));
const ctx=await start();peer=new Peer(ctx,{principal:{kind:'owner'}});
const frontend=join(runtime,'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets');
const {readdirSync}=await import('node:fs');const assets=readdirSync(frontend),index=assets.find(f=>/^index-.*\.js$/.test(f)),source=readFileSync(join(frontend,index),'utf8');
const platform=/function (\w+)\(\)\{return\{react:[^}]+"@deepseek-ai\/dsh-client-ui-primitives"[^}]+\}\}/.exec(source);assert.ok(platform);
const bootIndex=source.search(/const \w+=globalThis.dshDesktopBoot/);assert.ok(bootIndex>0);const platformOnly=source.slice(0,bootIndex)+`\nwindow.__TEST_PLATFORM__=${platform[1]}();`;
const css=assets.filter(f=>f.endsWith('.css')).map(f=>`<link rel="stylesheet" href="/assets/${f}">`).join('');
const html=`<!doctype html><html lang="zh" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css}<title>执行端 preset · 隔离真实 DSH</title><div id="root"></div><script type="module">
import '/assets/platform-only.js';const P=window.__TEST_PLATFORM__,R=P.react;window.__ModuleLoader__={load(row){window.plugin=row.factory(name=>P[name]);}};await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/settings-client.js';s.onload=resolve;s.onerror=reject;document.head.append(s)});
window.calls=[];window.uiErrors=[];window.addEventListener('error',e=>uiErrors.push(e.message));
async function invoke(method,input){const d=[plugin.startupDescriptor,plugin.saveStartupDescriptor,plugin.descriptor,...plugin.projectDescriptors].find(x=>x.method===method);if(!d)throw Error('Missing client descriptor '+method);const args=d.parameters.length?{input}:{};calls.push({method,args});const result=await(await fetch('/rpc',{method:'POST',body:JSON.stringify({method,args})})).json();if(result.error)throw Object.assign(new Error(result.error.message),result.error);return d.result.create().parse(result.value);}
const base={schedulerEnabled:false,autoExecute:false,maxConcurrent:1,executionTimeoutMs:0,healthAlerts:false,localHeartbeatIntervalMs:30000},snap={status:'ready',value:base,base,user:{},writable:true,revision:1};const scope={getSnapshot:()=>snap,subscribe:()=>()=>{},mutate:async()=>true};const controller=new plugin.Controller(scope),actions=controller.form.actions();
const root=P['react-dom/client'].createRoot(document.getElementById('root'));root.render(R.createElement(plugin.Page,{view:'page',t:k=>plugin.zh[k]||k,useTaskSettings:selector=>selector(R.useSyncExternalStore(controller.store.subscribe,controller.store.getSnapshot)),...actions,read:()=>invoke('describe'),startup:()=>invoke('startup'),saveStartup:input=>invoke('saveStartup',input),readExecutionPresets:()=>invoke('executionPresets'),readWorkspaces:async()=>({items:[]}),readProjectSettings:async()=>({enabled:false}),readExecutionDirectorySettings:async()=>({enabled:false}),readExecutorWorkspaceGrants:async()=>({enabled:false}),onNavigate:()=>{}}));
</script></html>`;
const {createServer}=await import('node:http');const calls=[];
const server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/rpc'){let body='';for await(const part of req)body+=part;const call=JSON.parse(body);assert.ok(['startup','saveStartup','executionPresets','describe'].includes(call.method));calls.push(call);const value=await ctx.get('typertGateway').invoke({peer,namespace:'taskPluginSettings',method:call.method,args:call.args});res.setHeader('content-type','application/json');res.end(JSON.stringify({value}));}
 else if(pathname==='/evidence'){res.setHeader('content-type','application/json');res.end(JSON.stringify({fixture:tmp,startup:await ctx.get('taskPluginSettings').startup(),presets:await ctx.get('taskPluginSettings').executionPresets(),calls}));}
 else if(pathname==='/settings-client.js'){res.setHeader('content-type','text/javascript');res.end(readFileSync(resolve('packages/task-system/dist/settings-client.js')));}
 else if(pathname==='/assets/platform-only.js'){res.setHeader('content-type','text/javascript');res.end(platformOnly);}
 else if(pathname.startsWith('/assets/')){res.setHeader('content-type',pathname.endsWith('.css')?'text/css':'text/javascript');res.end(readFileSync(join(frontend,pathname.slice(8))));}
 else{res.setHeader('content-type','text/html');res.end(html);}
 }catch(error){res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{message:error.message,code:error.code,details:error.details}}));}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port,fixture:tmp,realTypertGateway:true,realConfigEditor:true,productionWrites:0}));
process.on('SIGTERM',async()=>{await new Promise(done=>server.close(done));await ctx.fiber.dispose();process.exit(0)});
