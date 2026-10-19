/** Isolated local Chrome fixture: actual rc.2 React/primitives/theme, synthetic RPCs.
 * No active DSH profile, user browser state, credentials or model calls are used. */
import assert from "node:assert/strict";
import {validateNetworkTarget} from "../../packages/task-system/dist/remote/network-client.js";
import {assertEndpoint} from "../../packages/task-system/dist/remote/http.js";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const assets = process.env.DSH_WEB_ASSETS;
const runtime = process.env.DSH_OFFICIAL_ROOT;
const evidence = process.env.DSH_BROWSER_EVIDENCE_DIR;
assert.ok(
  assets && runtime && evidence,
  "Set DSH_WEB_ASSETS, DSH_OFFICIAL_ROOT and DSH_BROWSER_EVIDENCE_DIR",
);
mkdirSync(evidence, { recursive: true });
const req = createRequire(join(runtime, "package.json"));
const theme = readFileSync(
  req.resolve("@deepseek-ai/dsh-client-ui-theme/client"),
  "utf8",
);
const themeCss = [...theme.matchAll(/"(?:[^"\\]|\\.)*"/g)]
  .filter((m) => m[0].includes("--dsw-alias-border-l3"))
  .map((m) => JSON.parse(m[0]))
  .join("\n");
assert.ok(themeCss.includes("body[data-ds-dark-theme]"));
const indexName = readdirSync(assets).find((x) => /^index-.*\.js$/.test(x));
const source = readFileSync(join(assets,indexName),"utf8");
const sharedName=source.match(/function (\w+)\(\)\{return\{react:/)?.[1];
const boot=source.lastIndexOf('try{const e=document.getElementById("root")');
assert.ok(sharedName && boot>0,"installed official shared module export and bootstrap found");
const platform=source.slice(0,boot)+`\nexport {${sharedName} as sharedModules};\n`;
const css = readdirSync(assets).filter((x) =>
  /^(index|vendor)-.*\.css$/.test(x),
);
const fixture = String.raw`
import {sharedModules} from '/assets/platform-fixture.js';
const modules=sharedModules(), React=modules.react, root=modules['react-dom/client'].createRoot(document.getElementById('fixture'));
window.__ModuleLoader__={load(row){window.taskUI=row.factory(name=>{if(!modules[name])throw Error('Missing shared module '+name);return modules[name];});}};
await new Promise((done,fail)=>{const s=document.createElement('script');s.src='/candidate.js';s.onload=done;s.onerror=fail;document.head.append(s);});
const ui=window.taskUI;
let startup={writable:true,applies:'plugin-restart',task:{entryId:'task-system',values:{role:'executor',nodeId:'fixture-node',databasePath:'/fixture/tasks.sqlite',planningDecisionEnabled:true,sessionDecisionEnabled:false},decisionAvailable:true},remote:{entryId:'task-remote-execution',loaded:true,loaderDisabled:false,values:{role:'executor',paused:true,endpoint:'http://100.64.0.2:8443/commands',audience:'fixture-authority',pollIntervalMs:0,concurrency:1,taskSessionsEnabled:true,trustedNetworkTarget:{address:'100.64.0.2',port:8443,localAddress:'100.64.0.3',allowHttp:true}}}};
window.fixtureFailRemote=false;window.fixtureDecision={revision:'fixture-rev',writable:true,bindings:{'task-planning':'plan','task-session':'session'},presets:[{id:'plan',name:'调度模型'},{id:'session',name:'执行模型'}]};window.fixtureWorkspaceMode='ready';window.fixtureWorkspaceReads=0;window.fixtureWrites=[];window.fixtureIdentityQueries=0;window.fixturePluginSection=null;window.fixtureNavigationAvailable=false;
const live={available:true,writable:true,saving:false,dirty:false,valid:true,fields:Object.fromEntries(ui.keys.map(key=>[key,{text:['schedulerEnabled','autoExecute','healthAlerts'].includes(key)?'false':'1000',overridden:false,invalid:false}]))};
let connection={exists:true,writable:true,revision:'connection-1',paused:true,values:{nodeId:'fixture-node',authMode:'trusted-network',listenerEnabled:false,listenAddress:'',listenPort:null,routePath:'/commands',serviceAudience:'',peers:[],outbound:null},operations:['executorIdentity','claim'],peersStatus:[],executionNodes:[]};
window.fixturePeerState=values=>{connection.peersStatus=values;connection.values.peers=connection.values.peers.map(peer=>({...peer,nodeId:values.find(value=>value.address===peer.address)?.nodeId??peer.nodeId}));};window.fixtureRemoveRemote=()=>{startup.remote=null;};window.fixtureSetRemote=(endpoint,target,authMode)=>{startup.remote.values.endpoint=endpoint;startup.remote.values.trustedNetworkTarget=target;connection.values.authMode=authMode;};
window.fixtureResetConnection=()=>{connection={...connection,exists:false,revision:connection.revision+'empty'};};window.fixtureConnection=()=>connection;
const props={readConnectionSettings:async()=>structuredClone(connection),saveConnectionSettings:async input=>{window.fixtureWrites.push(input);if(!startup.remote)startup.remote={entryId:'task-remote-execution',loaded:true,loaderDisabled:false,values:{role:startup.task.values.role,paused:true,endpoint:input.value.outbound?.endpoint??null,audience:input.value.outbound?.audience??null,pollIntervalMs:0,concurrency:1,taskSessionsEnabled:true,trustedNetworkTarget:input.value.outbound?.target??null}};connection={...connection,exists:true,revision:connection.revision+'x',values:input.value};return structuredClone(connection);},onNavigate:target=>{window.fixtureNav=target;},readDecisionConsole:async()=>structuredClone(window.fixtureDecision),setDecisionPreset:async input=>{window.fixtureWrites.push(input);window.fixtureDecision.bindings[input.consumer]=input.id;window.fixtureDecision.revision+='x';},openDecisions:()=>true,readProjectSettings:async()=>({enabled:true,root:'/projects/planning',revision:'fixture'}),saveProjectSettings:async input=>{window.fixtureWrites.push(input);return{root:input.root,revision:'next'};},readExecutionDirectorySettings:async()=>({enabled:true,root:'/projects/execution',revision:'fixture'}),saveExecutionDirectorySettings:async()=>true,readDecisionSettings:async()=>({available:false,writable:false,snapshot:null,catalog:[],readiness:[]}),saveDecisionSettings:async()=>{throw Error('No decision entry in this fixture');},openModels:()=>{window.fixturePluginSection='models';return true;},openPlugins:()=>window.fixtureNavigationAvailable&&ui.openPlugins({slots:{entries:()=>[{options:{store:{create:()=>({actions:{openSection:id=>{window.fixturePluginSection=id;}}})}}}]}}),t:key=>ui.zh[key]??key,useTaskSettings:project=>project(live),edit(){},resetField(){},save(){},discard(){},
readWorkspaces:async()=>{window.fixtureWorkspaceReads++;if(window.fixtureWorkspaceMode==='error')throw {code:'CATALOG_UNAVAILABLE'};return {scope:{entryId:'task-system',nodeId:'fixture-node',schedulerId:'fixture-scheduler'},source:'official',items:[{workspaceId:'workspace-fixture',title:'同名项目',path:'/projects/original',available:true},...(window.fixtureWorkspaceMode==='missing'?[]:[{workspaceId:'workspace-draft',title:'同名项目',path:'/projects/second',available:true}])]};},
startup:async()=>{const snapshot=structuredClone(startup);if(snapshot.remote?.values.endpoint){const url=new URL(snapshot.remote.values.endpoint);snapshot.remote.values.endpoint=url.protocol+"//"+url.host+url.pathname;}return snapshot;}, saveStartup:async input=>{if(input.changes.role&&window.fixtureFailRole)throw {code:'STARTUP_ROLE_CONFLICT'};if(input.target==='remote'&&window.fixtureFailRemote)throw {code:'CONFIG_CONFLICT'};window.fixtureWrites.push(structuredClone(input));Object.assign(startup[input.target].values,input.changes);},
read:async()=>({nodeId:'fixture-node',role:startup.task.values.role,databasePath:'/fixture/tasks.sqlite',profilePatch:'/fixture/cordis.patch.yml',schedulerId:'fixture-scheduler',defaultWorkspaceId:startup.task.values.defaultWorkspaceId,planningDecisionEnabled:startup.task.values.planningDecisionEnabled,sessionDecisionEnabled:startup.task.values.sessionDecisionEnabled,remote:{...startup.remote.values,nodeId:'fixture-node',polling:false,authMode:'trusted-network',executorIdentity:null}}),
readQueue:async()=>({sampledAt:'2026-10-05T00:00:00.000Z',nodeId:'fixture-node',items:[{taskId:'fixture-task',runId:'fixture-run',title:'示例：整理交付材料',state:'queued',sessionId:null,workspaceId:'workspace-fixture'}],truncated:false}),
queryIdentity:async()=>{window.fixtureIdentityQueries++;throw {code:'REMOTE_PAUSED'};}};
window.fixtureModelViews={};
const modelView=nodeId=>window.fixtureModelViews[nodeId]??(window.fixtureModelViews[nodeId]={nodeId,catalog:{state:'fresh',snapshot:{revision:'models-1',observedAt:Date.now(),expiresAt:Date.now()+60000,complete:true,models:[{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'},{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'low'},{provider:'native-provider',model:'another-model',reasoningEffort:'medium'}]}},policy:{revision:0}});
props.nodeModelApi={read:async({nodeId})=>structuredClone(modelView(nodeId)),refresh:async({nodeId})=>structuredClone(modelView(nodeId)),save:async input=>{window.fixtureWrites.push(input);const view=modelView(input.nodeId);if(view.policy.revision!==input.expectedRevision)throw {code:'EXECUTION_MODEL_POLICY_CONFLICT'};view.policy={revision:view.policy.revision+1,choice:input.choice};return structuredClone(view);}};
window.fixtureProps=props;const surface=new ui.TaskSettingsSurface();
function App({shown}){return React.createElement(React.Fragment,null,React.createElement(ui.TaskSettingsPortal,{...props,surface}),shown?React.createElement(ui.TaskSettingsPanel,{surface}):React.createElement('div',null,'模型管理 fixture'));}
window.fixtureSwitch=shown=>root.render(React.createElement(App,{shown}));window.fixtureSwitch(true);
window.fixtureVisible=el=>!!el&&el.getClientRects().length>0;
window.fixtureSet=(selector,value)=>{const el=document.querySelector(selector);if(!el)throw Error('Missing '+selector);Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};
window.fixtureReady=true;
`;
const html = `<!doctype html><meta charset="utf-8"><title>Task settings · isolated fixture</title>${css.map((x) => `<link rel="stylesheet" href="/assets/${x}">`).join("")}<style>${themeCss}\nhtml,body{height:100%;}body{margin:0;padding:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:14px/1.55 system-ui;}#fixture{height:100%;width:100%;margin:auto;}</style><div id="fixture"></div><script type="module" src="/fixture.js"></script>`;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost"),
    name = decodeURIComponent(url.pathname);
  if (name === "/") {
    response.setHeader("Content-Type", "text/html");
    return response.end(html);
  }
  if (name === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    return response.end(fixture);
  }
  if (name === "/candidate.js") {
    response.setHeader("Content-Type", "text/javascript");
    return response.end(
      readFileSync(resolve("packages/task-system/dist/settings-client.js")),
    );
  }
  if (name === "/assets/platform-fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    return response.end(platform);
  }
  if (
    name.startsWith("/assets/") &&
    basename(name) === name.slice("/assets/".length) &&
    existsSync(join(assets, basename(name)))
  ) {
    response.setHeader(
      "Content-Type",
      name.endsWith(".css") ? "text/css" : "text/javascript",
    );
    return response.end(readFileSync(join(assets, basename(name))));
  }
  response.statusCode = 404;
  response.end("fixture route not found");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`,
  profile = mkdtempSync(join(tmpdir(), "dsh-simple-chrome-"));
let chrome, ws;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (check) => {
  for (let i = 0; i < 120; i++) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw Error("fixture readiness timed out");
};
try {
  chrome = spawn(
    process.env.DSH_CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const port = await until(
    () =>
      existsSync(join(profile, "DevToolsActivePort")) &&
      readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0],
  );
  const tab = await until(async () => {
    const tabs = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    return tabs.find((x) => x.type === "page");
  });
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    ws.addEventListener("open", done, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if(message.method === "Runtime.exceptionThrown") console.error(JSON.stringify(message.params));
    if (message.id) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      message.error
        ? p?.reject(Error(JSON.stringify(message.error)))
        : p?.resolve(message.result);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const run = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.text +
          " " +
          JSON.stringify(result.exceptionDetails.exception),
      );
    return result.result.value;
  };
  const frame = () => delay(100);
  const click = async (selector) => {
    const rect = await run(
      `(()=>{const el=${selector};if(!window.fixtureVisible(el))throw Error('Button is not visible');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    );
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...rect,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...rect,
    });
    await frame();
  };
  const btn = (text) =>
    `[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&fixtureVisible(el))`;
  const scopedBtn = (scope, text) =>
    `[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&fixtureVisible(el))`;
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const receipts=[];
  for(const mode of ["light","dark"]){
    await call("Page.navigate",{url:origin});
    await until(()=>run(`window.fixtureReady && !!document.querySelector('#task-preset-select-planner') && !!document.querySelector('#task-startup-task-role')`));
    await run(mode==="dark"?`document.body.setAttribute('data-ds-dark-theme','')`:`document.body.removeAttribute('data-ds-dark-theme')`);
    await frame();
    assert.equal(await run(`document.querySelector('[data-task-mode]')===null && document.querySelector('[data-task-workspace-selector]')===null`),true);
    assert.equal(await run(`document.querySelectorAll('[id$="-role"]').length`),1);
    assert.equal(await run(`document.body.textContent.includes("连接角色")`),false);
    assert.deepEqual(await run(`[...document.querySelectorAll('.task-primary-nav button')].map(el=>el.textContent)`),["任务","项目","完整面板","设置"]);
    assert.equal(await run(`document.querySelector('h1').textContent`),"设置");
    assert.equal(await run(`document.querySelector('.task-primary-nav [aria-current=page]').textContent`),"设置");
    await click(btn("项目"));assert.equal(await run(`window.fixtureNav`),"projects");
    assert.deepEqual(await run(`[...document.querySelectorAll('[data-settings-area] > header h2')].map(el=>el.textContent)`),["本机与工作区","协作连接","决策模型","运行控制","状态与诊断"]);
    assert.equal(await run(`document.querySelectorAll('#task-preset-select-planner').length===1 && document.querySelectorAll('#task-preset-select-executor').length===1`),true);
    assert.equal(await run(`document.querySelector('[data-task-plugin-settings] header').textContent.includes('fixture-node')`),true);
    assert.equal(await run(`fixtureVisible(document.querySelector('[data-connection-settings] [data-connection-role=planner]'))`),false);
    assert.equal(await run(`document.querySelectorAll('[data-collaboration-controls] [role=switch]').length`),1);
    await run(`fixtureSet('#task-startup-task-role','both');fixtureSet('#task-connection-serviceAudience','scheduler-draft');fixtureSet('#task-startup-remote-connectionAddress','unfinished')`);await frame();
    await run(`fixtureSet('#task-startup-task-role','executor')`);await frame();
    assert.equal(await run(`fixtureVisible(document.querySelector('[data-connection-settings] [data-connection-role=planner]'))`),false);
    await run(`fixtureSet('#task-startup-task-role','planner')`);await frame();
    assert.equal(await run(`fixtureVisible(document.querySelector('[data-startup-target=remote] [data-connection-role=executor]'))`),false);
    assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),false,'hidden incomplete executor draft cannot block planner save');
    await click(`document.querySelector('[data-task-save-bar] button')`);
    assert.equal(await run(`window.fixtureWrites.some(input=>input.changes?.endpoint?.includes('unfinished'))`),false);
    await run(`fixtureSet('#task-startup-task-role','both')`);await frame();
    assert.equal(await run(`document.querySelector('#task-startup-remote-connectionAddress').value`),'unfinished');
    assert.equal(await run(`document.querySelector('#task-connection-serviceAudience').value`),'scheduler-draft');
    await click(btn('丢弃全部草稿'));
    await run(`fixtureSet('#task-startup-task-role','executor')`);await frame();await click(`document.querySelector('[data-task-save-bar] button')`);
    await run(`window.fixtureWrites=[]`);
    await click(`document.querySelector('[data-task-executor-decision] [role=switch]')`);
    assert.equal(await run(`window.fixtureWrites.length`),0);
    await click(`document.querySelector('[data-task-save-bar] button')`);
    assert.deepEqual(await run(`window.fixtureWrites[0].changes`),{sessionDecisionEnabled:true});
    await run(`fixtureSet('#task-startup-remote-concurrency','2')`);await frame();
    assert.equal(await run(`window.fixtureWrites.length`),1);
    await click(btn("丢弃全部草稿"));
    assert.equal(await run(`document.querySelector('#task-startup-remote-concurrency').value`),"1");
    await click(`document.querySelector('[data-task-executor-decision] [role=switch]')`);
    await run(`fixtureSet('#task-startup-remote-concurrency','3');fixtureSet('#task-preset-select-planner','session');fixtureSet('#task-preset-select-executor','plan')`);await frame();
    await run(`window.fixtureSwitch(false)`);await frame();await run(`window.fixtureSwitch(true)`);await frame();
    assert.equal(await run(`document.querySelector('#task-startup-task-role').value`),"executor");
    assert.equal(await run(`document.querySelector('#task-startup-remote-concurrency').value`),"3");
    await click(btn("刷新启动配置"));
    assert.equal(await run(`document.querySelector('#task-startup-remote-concurrency').value`),"3");
    await run(`window.fixtureFailRemote=true`);await click(`document.querySelector('[data-task-save-bar] button')`);await frame();
    assert.equal(await run(`document.querySelector('#task-startup-remote-concurrency').value`),"3");
    assert.equal(await run(`document.querySelector('#task-preset-select-planner').value`),"session");
    assert.equal(await run(`document.querySelector('[data-task-save-bar]').textContent.includes('部分设置已保存')`),true);
    await run(`window.fixtureFailRemote=false`);await click(`document.querySelector('[data-task-save-bar] button')`);await frame();
    assert.equal(await run(`window.fixtureDecision.bindings['task-planning']`),"session");
    assert.equal(await run(`window.fixtureDecision.bindings['task-session']`),"plan");
    assert.equal(await run(`document.querySelector('[data-task-save-bar]').textContent.includes('设置已保存')`),true);
    await run(`fixtureSet('#task-startup-task-role','both');window.fixtureFailRole=true`);await frame();
    await click(`document.querySelector('[data-task-save-bar] button')`);assert.equal(await run(`document.querySelector('#task-startup-task-role').value`),'both');await run(`window.fixtureFailRole=false`);
    await click(`document.querySelector('[data-task-save-bar] button')`);
    await run(`window.fixtureResetConnection()`);await click(`[...document.querySelectorAll("summary")].find(el=>el.textContent==="连接信息与刷新")`);await click(btn("刷新连接配置"));
    assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),true);
    await run(`fixtureSet('#task-connection-serviceAudience','draft-audience')`);await frame();
    await run(`window.fixtureSwitch(false)`);await frame();await run(`window.fixtureSwitch(true)`);await frame();
    assert.equal(await run(`document.querySelector('#task-connection-serviceAudience').value`),"draft-audience");
    assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),false);
    await click(`document.querySelector('[data-task-save-bar] button')`);assert.equal(await run(`window.fixtureConnection().exists`),true);assert.equal(await run(`window.fixtureConnection().values.serviceAudience`),"draft-audience");
    for(const width of [1440,390]){
      await call("Emulation.setDeviceMetricsOverride",{width,height:1100,deviceScaleFactor:1,mobile:false});
      await run(`window.scrollTo(0,0)`);await frame();
      const layout=await run(`({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,columns:getComputedStyle(document.querySelector('.task-directory-grid')).gridTemplateColumns,header:getComputedStyle(document.querySelector('[data-settings-area] > header h2')).color})`);
      assert.ok(layout.scroll<=layout.width,JSON.stringify(layout));
      const rows=await run(`[...document.querySelectorAll('.task-directory-card')].map(card=>{const choose=[...card.querySelectorAll('button')].find(el=>el.textContent==='选择目录').getBoundingClientRect(),refresh=[...card.querySelectorAll('button')].find(el=>el.textContent==='刷新').getBoundingClientRect();return {choose:choose.y,refresh:refresh.y};})`);assert.equal(rows.length,2);for(const row of rows)assert.ok(Math.abs(row.choose-row.refresh)<2,JSON.stringify(rows));if(width>760)assert.ok(Math.abs(rows[0].choose-rows[1].choose)<2,JSON.stringify(rows));
      const path=join(evidence,`settings-${mode}-${width}.png`);
      writeFileSync(path,Buffer.from((await call("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"));
      receipts.push({mode,width,layout,path});
    }
    await click(`[...document.querySelectorAll("summary")].find(el=>el.textContent==="连接信息与刷新")`);
    for(const role of ['planner','executor','both']){
      await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await run(`fixtureSet('#task-startup-task-role',${JSON.stringify(role)})`);await frame();
      await run(`document.querySelector('#task-connections').scrollIntoView({block:'start'})`);await frame();
      const checks=await run(`({planner:fixtureVisible(document.querySelector('[data-connection-settings] [data-connection-role=planner]')),executor:fixtureVisible(document.querySelector('[data-startup-target=remote] [data-connection-role=executor]')),masters:[...document.querySelectorAll('[data-collaboration-controls] [role=switch]')].filter(fixtureVisible).length,technical:document.querySelector('[data-startup-target=remote]').textContent.includes('插件已停用')})`);
      assert.equal(checks.planner,role!=='executor');assert.equal(checks.executor,role!=='planner');assert.equal(checks.masters,role==='planner'?0:1);assert.equal(checks.technical,false);
      writeFileSync(join(evidence,`connections-${mode}-${role}.png`),Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
    }
    await click(btn('丢弃全部草稿'));

  }
  await run(`window.fixtureRemoveRemote();window.fixtureResetConnection()`);await click(btn('刷新启动配置'));await click(`[...document.querySelectorAll("summary")].find(el=>el.textContent==="连接信息与刷新")`);await click(btn('刷新连接配置'));
  assert.equal(await run(`document.querySelectorAll('[data-collaboration-controls]').length`),0);
  await run(`fixtureSet('#task-connection-outbound-connectionAddress','hidden-draft');fixtureSet('#task-startup-task-role','planner');fixtureSet('#task-connection-serviceAudience','planner-only')`);await frame();
  await click(`document.querySelector('[data-task-save-bar] button')`);await frame();
  assert.equal(await run(`window.fixtureConnection().values.outbound`),null,'initial planner save must not send hidden executor draft');
  await run(`fixtureSet('#task-startup-task-role','both')`);await frame();assert.equal(await run(`document.querySelector('#task-startup-remote-connectionAddress').value`),'hidden-draft','new remote draft owner receives retained executor inputs after creation');
  await click(btn('丢弃全部草稿'));
  const fresh=async()=>{if(await run(`[...document.querySelectorAll('button')].some(el=>el.textContent==='丢弃全部草稿' && !el.disabled)`))await click(btn('丢弃全部草稿'));await call('Page.navigate',{url:origin});await until(()=>run(`window.fixtureReady && !!document.querySelector('#task-startup-remote-connectionAddress')`));await frame();};
  await fresh();
  await run(`fixtureSet('#task-startup-task-role','both');fixtureSet('#task-startup-remote-connectionAddress','incomplete');fixtureSet('#task-connection-listenAddress','127.0.0.1');fixtureSet('#task-connection-listenPort','8443');fixtureSet('#task-connection-serviceAudience','fixture-listener')`);await frame();
  await click(`document.querySelector('[data-connection-settings] [role=switch]')`);await frame();
  assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),false,'paused incomplete executor cannot block a valid listener save');
  await click(`document.querySelector('[data-task-save-bar] button')`);assert.equal(await run(`window.fixtureWrites.some(x=>x.value?.listenerEnabled===true)`),true);assert.equal(await run(`window.fixtureWrites.some(x=>x.changes?.endpoint?.includes('incomplete'))`),false);assert.equal(await run(`document.querySelector('#task-startup-remote-connectionAddress').value`),'incomplete');
  await click(`document.querySelector('[data-collaboration-controls] [role=switch]')`);assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),true,'enabling executor requires its own valid fields');assert.equal(await run(`document.querySelector('[data-collaboration-controls] [role=switch]').disabled`),false);await click(`document.querySelector('[data-collaboration-controls] [role=switch]')`);
  await fresh();await run(`fixtureSet('#task-startup-task-role','both');fixtureSet('#task-connection-listenAddress','incomplete')`);await click(`document.querySelector('[data-collaboration-controls] [role=switch]')`);await frame();
  assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),false,'disabled incomplete listener cannot block valid executor enable');await click(`document.querySelector('[data-task-save-bar] button')`);assert.equal(await run(`window.fixtureWrites.some(x=>x.changes?.paused===false)`),true);assert.equal(await run(`window.fixtureWrites.some(x=>x.value?.listenAddress==='incomplete')`),false);assert.equal(await run(`document.querySelector('#task-connection-listenAddress').value`),'incomplete');
  await fresh();
  assert.equal(await run(`document.querySelector('#task-startup-remote-endpoint')===null && document.querySelector('#task-startup-remote-targetAddress')===null`),true);
  assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),true,'reading existing endpoint must not dirty or write');
  await run(`fixtureSet('#task-startup-remote-connectionAddress','2001:0DB8::2');fixtureSet('#task-startup-remote-connectionPort','80');fixtureSet('#task-startup-remote-connectionPath','/custom/tasks/commands');fixtureSet('#task-startup-remote-targetLocalAddress','2001:db8::3')`);await frame();
  await run(`window.fixtureFailRemote=true`);await click(`document.querySelector('[data-task-save-bar] button')`);assert.equal(await run(`document.querySelector('#task-startup-remote-connectionAddress').value`),'2001:0DB8::2');assert.equal(await run(`window.fixtureWrites.length`),0);await run(`window.fixtureFailRemote=false`);await click(`document.querySelector('[data-task-save-bar] button')`);
  const ipv6=await run(`window.fixtureWrites.find(input=>input.target==='remote').changes`);
  assert.equal(ipv6.endpoint,'http://[2001:db8::2]:80/custom/tasks/commands');validateNetworkTarget(ipv6.endpoint,ipv6.trustedNetworkTarget);assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),true,'default-port projection refresh must leave no phantom draft');
  assert.equal(ipv6.trustedNetworkTarget.localAddress,'2001:db8::3');
  await run(`fixtureSet('#task-startup-remote-connectionAddress','100.64.0.20');fixtureSet('#task-startup-remote-connectionPort','8088');fixtureSet('#task-startup-remote-targetLocalAddress','100.64.0.3')`);await frame();await click(`document.querySelector('[data-task-save-bar] button')`);
  const updated=await run(`window.fixtureWrites.at(-1).changes`);assert.equal(updated.endpoint,'http://100.64.0.20:8088/custom/tasks/commands');validateNetworkTarget(updated.endpoint,updated.trustedNetworkTarget);
  for(const width of [1440,390]){await call('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});await run(`document.querySelector('#task-connections').scrollIntoView({block:'start'})`);await frame();assert.equal(await run(`document.documentElement.scrollWidth<=document.documentElement.clientWidth`),true);const row=await run(`[...document.querySelectorAll('[data-startup-target=remote] [data-outbound-address-fields] input')].slice(0,2).map(el=>el.getBoundingClientRect().top)`);assert.equal(row.length,2);assert.equal(width>760?Math.abs(row[0]-row[1])<2:row[1]>row[0],true);writeFileSync(join(evidence,`outbound-existing-${width}.png`),Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));}
  await fresh();await run(`window.fixtureSetRemote('http://100.64.0.2:8443/commands',{address:'100.64.0.99',port:9443,localAddress:'100.64.0.3',allowHttp:true},'trusted-network')`);await click(btn('刷新启动配置'));
  assert.equal(await run(`!!document.querySelector('[data-outbound-mismatch]')`),true);assert.equal(await run(`document.querySelector('#task-startup-remote-connectionAddress').value`),'100.64.0.2');assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),true);assert.equal(await run(`window.fixtureWrites.length`),0);
  await run(`fixtureSet('#task-startup-remote-concurrency','2')`);await frame();await click(`document.querySelector('[data-task-save-bar] button')`);assert.deepEqual(await run(`window.fixtureWrites.at(-1).changes`),{concurrency:2});
  await click(btn('按当前地址同步'));await click(`document.querySelector('[data-task-save-bar] button')`);const synced=await run(`window.fixtureWrites.at(-1).changes`);assert.equal(synced.trustedNetworkTarget.address,'100.64.0.2');assert.equal(synced.trustedNetworkTarget.port,8443);validateNetworkTarget('http://100.64.0.2:8443/commands',synced.trustedNetworkTarget);
  await fresh();await run(`window.fixtureSetRemote('https://example.test:443/private/tasks/v2',null,'ed25519')`);await click(btn('刷新启动配置'));await click(`[...document.querySelectorAll('summary')].find(el=>el.textContent==='连接信息与刷新')`);await click(btn('刷新连接配置'));
  assert.equal(await run(`document.querySelector('#task-startup-remote-connectionProtocol').value`),'https');assert.equal(await run(`document.querySelector('#task-startup-remote-targetLocalAddress')===null`),true);assert.equal(await run(`document.querySelector('[data-task-save-bar] button').disabled`),true);
  await run(`fixtureSet('#task-startup-remote-connectionPath','/different/commands')`);await frame();await click(`document.querySelector('[data-task-save-bar] button')`);const signed=await run(`window.fixtureWrites.at(-1).changes`);assert.equal(signed.endpoint,'https://example.test:443/different/commands');assert.equal(Object.hasOwn(signed,'trustedNetworkTarget'),false);assertEndpoint(signed.endpoint);
  await fresh();await run(`window.fixtureRemoveRemote();window.fixtureResetConnection()`);await click(btn('刷新启动配置'));await click(`[...document.querySelectorAll('summary')].find(el=>el.textContent==='连接信息与刷新')`);await click(btn('刷新连接配置'));
  await run(`fixtureSet('#task-connection-outbound-connectionAddress','100.64.0.2');fixtureSet('#task-connection-outbound-connectionPort','80');fixtureSet('#task-connection-outbound-connectionPath','/first/custom');fixtureSet('#task-connection-outbound-audience','first-authority');fixtureSet('#task-connection-outbound-targetLocalAddress','100.64.0.3')`);await frame();
  await run(`document.querySelector('#task-connections').scrollIntoView({block:'start'})`);await frame();writeFileSync(join(evidence,'outbound-first.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
  await click(`document.querySelector('[data-task-save-bar] button')`);const created=await run(`window.fixtureWrites.find(input=>input.value?.outbound).value.outbound`);assert.equal(created.endpoint,'http://100.64.0.2:80/first/custom');validateNetworkTarget(created.endpoint,created.target);assert.equal(Object.hasOwn(created,'_fields'),false);assert.equal(await run(`document.querySelector('#task-startup-remote-connectionPath').value`),'/first/custom');
  await fresh();
  assert.equal(await run(`document.querySelector('[data-local-node-identity] code').textContent`),'fixture-node');assert.equal(await run(`document.querySelector('[data-task-database-settings]').hidden`),true);assert.equal(await run(`document.body.textContent.includes('高级')`),false);
  await run(`fixtureSet('#task-startup-task-role','both')`);await frame();await click(`document.querySelector('[data-task-save-bar] button')`);
  await run(`fixtureSet('#task-startup-task-databasePath','/fixture/selected.sqlite')`);await frame();await run(`fixtureSet('#task-startup-task-role','executor')`);await frame();assert.equal(await run(`document.querySelector('[data-task-database-settings]').hidden`),true);await click(`document.querySelector('[data-task-save-bar] button')`);assert.equal(await run(`window.fixtureWrites.some(input=>input.changes?.databasePath==='/fixture/selected.sqlite')`),false);await run(`fixtureSet('#task-startup-task-role','both')`);await frame();assert.equal(await run(`document.querySelector('#task-startup-task-databasePath').value`),'/fixture/selected.sqlite');await click(btn('丢弃全部草稿'));
  await run(`fixtureSet('#task-startup-task-role','both')`);await frame();await run(`fixtureSet('#task-connection-listenAddress','100.64.0.2');fixtureSet('#task-connection-listenPort','8443');fixtureSet('#task-connection-serviceAudience','fixture-authority')`);await frame();await click(btn('添加执行端节点'));await run(`fixtureSet('.task-connection-peer label:nth-child(1) input','我的笔记本');fixtureSet('.task-connection-peer label:nth-child(2) input','100.64.0.3')`);await frame();await click(btn('检测'));assert.equal(await run(`document.querySelector('.task-connection-peer').textContent.includes('草稿尚未保存')`),true);assert.equal(await run(`document.querySelectorAll('.task-connection-peer input[type=checkbox]').length`),0);assert.equal(await run(`document.querySelector('.task-connection-peer').textContent.includes('节点昵称')`),true);assert.equal(await run(`document.querySelector('.task-connection-peer').textContent.includes('连接受众标识')`),false);
  await click(`document.querySelector('[data-task-save-bar] button')`);await run(`window.fixturePeerState([{address:'100.64.0.3',nodeId:'device-uuid-fixture',nickname:'我的笔记本',state:'stale',sampledAt:1792340000000,registered:true,models:1}])`);await click(btn('检测'));assert.equal(await run(`document.querySelector('.task-connection-peer').textContent.includes('心跳已过期')`),true);assert.equal(await run(`document.querySelector('.task-connection-peer').textContent.includes('device-uuid-fixture')`),true);
  await until(()=>run(`!!document.querySelector('[data-node-model-settings] select[aria-label="默认执行模型"]') && !document.querySelector('[data-node-model-settings] select').disabled`));
  await run(`(()=>{const el=document.querySelector('[data-node-model-settings] select[aria-label="默认执行模型"]');fixtureSet('[data-node-model-settings] select[aria-label="默认执行模型"]',[...el.options].find(option=>option.textContent.includes('deepseek-flash')).value);})()`);await frame();
  assert.equal(await run(`document.querySelector('[data-node-model-settings] select[aria-label="默认推理档位"]').value`),'high');
  await click(`document.querySelector('[data-task-save-bar] button')`);assert.equal(await run(`window.fixtureWrites.at(-1).nodeId`),'device-uuid-fixture');assert.equal(await run(`window.fixtureModelViews['device-uuid-fixture'].policy.choice.model`),'deepseek-flash');
  receipts.push('node-model-and-effort-single-authority-save');
  for(const mode of ['light','dark'])for(const width of [1440,390]){
    await run(mode==='dark'?`document.body.setAttribute('data-ds-dark-theme','')`:`document.body.removeAttribute('data-ds-dark-theme')`);
    await call('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
    await run(`document.querySelector('[data-node-model-settings]').scrollIntoView({block:'center'})`);await frame();
    assert.equal(await run(`document.documentElement.scrollWidth<=document.documentElement.clientWidth`),true);
    assert.deepEqual(await run(`[...document.querySelectorAll('[data-node-model-settings] select')].map(el=>{const s=getComputedStyle(el);return {appearance:s.appearance,padding:s.paddingRight,position:s.backgroundPosition};})`),[{appearance:'none',padding:'36px',position:'calc(100% - 12px) 50%'},{appearance:'none',padding:'36px',position:'calc(100% - 12px) 50%'}]);
    writeFileSync(join(evidence,`nodes-${mode}-${width}.png`),Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
  }
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await run(`document.querySelector('#task-local').scrollIntoView({block:'start'})`);await frame();writeFileSync(join(evidence,'identity-database.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
  await click(btn('添加执行端节点'));await run(`(()=>{const inputs=document.querySelectorAll('.task-connection-peer input');fixtureSet('.task-connection-peer:last-of-type label:nth-child(1) input','第二台');fixtureSet('.task-connection-peer:last-of-type label:nth-child(2) input','100.64.0.4');})()`);await frame();await click(`document.querySelector('[data-task-save-bar] button')`);await run(`window.fixturePeerState([{address:'100.64.0.3',nodeId:'device-uuid-fixture',nickname:'我的笔记本',state:'stale',sampledAt:1792340000000,registered:true,models:1},{address:'100.64.0.4',nodeId:'second-device',nickname:'第二台',state:'online',sampledAt:1792340000000,registered:true,models:1}])`);await click(`[...document.querySelectorAll('.task-connection-peer')][1].querySelectorAll('button') && [...[...document.querySelectorAll('.task-connection-peer')][1].querySelectorAll('button')].find(el=>el.textContent.trim()==='检测')`);await click(`[...[...document.querySelectorAll('.task-connection-peer')][0].querySelectorAll('button')].find(el=>el.textContent.trim()==='移除执行端节点')`);assert.equal(await run(`document.querySelector('.task-connection-peer').textContent.includes('second-device')`),true);assert.equal(await run(`document.querySelector('.task-connection-peer').textContent.includes('device-uuid-fixture')`),false);
  await click(btn('移除执行端节点'));assert.equal(await run(`document.querySelectorAll('.task-connection-peer').length`),0);await click(`document.querySelector('[data-task-save-bar] button')`);assert.equal(await run(`window.fixtureConnection().values.peers.length`),0);
  writeFileSync(join(evidence,"wide-settings-browser.json"),JSON.stringify({syntheticRpc:true,userProfileWrites:0,realModelCalls:0,receipts},null,2));
  console.log(JSON.stringify({ok:true,receipts}));

} finally {
  ws?.close();
  chrome?.kill("SIGTERM");
  server.close();
  await delay(200);
  rmSync(profile, { recursive: true, force: true });
}
