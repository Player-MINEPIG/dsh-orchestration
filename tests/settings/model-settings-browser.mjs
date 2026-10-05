/** Isolated local Chrome fixture: actual rc.2 React/primitives/theme, synthetic RPCs.
 * No active DSH profile, user browser state, credentials or model calls are used. */
import assert from "node:assert/strict";
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
const source = readFileSync(join(assets, indexName), "utf8"),
  boot = source.lastIndexOf('try{const e=document.getElementById("root")');
assert.ok(
  boot > 0 && source.includes("function rM(){return{react:"),
  "fixture expects the installed rc.2 frontend shared-module map",
);
// Remove only the app bootstrap in this served fixture copy. Reuse its exact platform modules.
const platform = source.slice(0, boot) + "\nexport {rM as sharedModules};\n";
const css = readdirSync(assets).filter((x) =>
  /^(index|vendor)-.*\.css$/.test(x),
);
const fixture = String.raw`
import {sharedModules} from '/assets/platform-fixture.js';
const modules=sharedModules(), React=modules.react, root=modules['react-dom/client'].createRoot(document.getElementById('fixture'));
window.__ModuleLoader__={load(row){window.taskUI=row.factory(name=>{if(!modules[name])throw Error('Missing shared module '+name);return modules[name];});}};
await new Promise((done,fail)=>{const s=document.createElement('script');s.src='/candidate.js';s.onload=done;s.onerror=fail;document.head.append(s);});
const ui=window.taskUI;
let startup={writable:true,applies:'plugin-restart',task:{entryId:'task-system',values:{role:'executor',defaultWorkspaceId:'workspace-fixture',planningDecisionEnabled:true,sessionDecisionEnabled:false}},remote:{entryId:'task-remote-execution',loaded:true,loaderDisabled:false,values:{role:'executor',paused:true,endpoint:'http://fixture.invalid:8443/commands',audience:'fixture-authority',pollIntervalMs:0,concurrency:1,taskSessionsEnabled:true,trustedNetworkTarget:{address:'fixture.invalid',port:8443,localAddress:'fixture.local',allowHttp:true}}}};
window.fixtureWorkspaceMode='ready';window.fixtureWorkspaceReads=0;window.fixtureWrites=[];window.fixtureIdentityQueries=0;window.fixturePluginSection=null;window.fixtureNavigationAvailable=false;
const live={available:true,writable:true,saving:false,dirty:false,valid:true,fields:Object.fromEntries(ui.keys.map(key=>[key,{text:['schedulerEnabled','autoExecute','healthAlerts'].includes(key)?'false':'1000',overridden:false,invalid:false}]))};
let decision={available:true,writable:true,snapshot:{entryId:'task-typed-decisions',defaultProvider:'rules',providers:[{id:'rules',kind:'rules'},{id:'jev-existing',kind:'jev',model:'jev-old',modelVersion:'old-version'},{id:'compatible',kind:'compatible',model:'old',modelVersion:'old-version',endpoint:'https://fixture.invalid/decision'}],completion:{entryId:'typed-decision-native-completion',routes:[{model:'keep',modelVersion:'keep-model',provider:'offline',reasoningEfforts:[]}]}},catalog:[{provider:'offline',name:'Existing local provider',credential:'missing',available:true,models:[{id:'keep-model',name:'Keep model'},{id:'selected-model',name:'Selected model'}]}],readiness:[{providerId:'rules',status:'ready'},{providerId:'jev-existing',status:'credential-missing'},{providerId:'compatible',status:'credential-missing'}]};
window.fixtureDecisionWrites=[];window.fixtureDecisionMode='ok';window.fixtureDecisionReads=0;
const props={readDecisionSettings:async()=>{window.fixtureDecisionReads++;if(window.fixtureDecisionMode==='read-error')throw {code:'MODEL_READ_FAILED'};return structuredClone(decision);},
saveDecisionSettings:async input=>{if(window.fixtureDecisionMode==='conflict')throw {code:'gateway/invocation-failed',message:'DECISION_CONFLICT'};if(JSON.stringify(input.expected)!==JSON.stringify(decision.snapshot))throw {code:'DECISION_CONFLICT'};window.fixtureDecisionWrites.push(structuredClone(input));const v=input.selection;decision.snapshot.defaultProvider=v.providerId;let p=decision.snapshot.providers.find(p=>p.id===v.providerId);if(!p){p={id:v.providerId,kind:v.kind};decision.snapshot.providers.push(p);}if(v.kind==='structured'){const alias='native:'+v.nativeProvider+'/'+v.modelVersion;p.models=[{model:alias,version:v.modelVersion,reasoningEfforts:[]}];if(!decision.snapshot.completion.routes.some(r=>r.model===alias))decision.snapshot.completion.routes.push({model:alias,modelVersion:v.modelVersion,provider:v.nativeProvider,reasoningEfforts:[]});}else Object.assign(p,Object.fromEntries(Object.entries(v).filter(([k])=>!['providerId','kind'].includes(k))));decision.readiness=decision.snapshot.providers.map(p=>({providerId:p.id,status:p.kind==='rules'?'ready':'credential-missing'}));},
openModels:()=>{window.fixturePluginSection='models';return true;},openPlugins:()=>window.fixtureNavigationAvailable&&ui.openPlugins({slots:{entries:()=>[{options:{store:{create:()=>({actions:{openSection:id=>{window.fixturePluginSection=id;}}})}}}]}}),t:key=>ui.zh[key]??key,useTaskSettings:project=>project(live),edit(){},resetField(){},save(){},discard(){},
readWorkspaces:async()=>{window.fixtureWorkspaceReads++;if(window.fixtureWorkspaceMode==='error')throw {code:'CATALOG_UNAVAILABLE'};return {scope:{entryId:'task-system',nodeId:'fixture-node',schedulerId:'fixture-scheduler'},source:'official',items:[{workspaceId:'workspace-fixture',title:'同名项目',path:'/projects/original',available:true},...(window.fixtureWorkspaceMode==='missing'?[]:[{workspaceId:'workspace-draft',title:'同名项目',path:'/projects/second',available:true}])]};},
startup:async()=>structuredClone(startup), saveStartup:async input=>{window.fixtureWrites.push(structuredClone(input));Object.assign(startup[input.target].values,input.changes);},
read:async()=>({nodeId:'fixture-node',role:startup.task.values.role,databasePath:'/fixture/tasks.sqlite',profilePatch:'/fixture/cordis.patch.yml',schedulerId:'fixture-scheduler',defaultWorkspaceId:startup.task.values.defaultWorkspaceId,planningDecisionEnabled:startup.task.values.planningDecisionEnabled,sessionDecisionEnabled:startup.task.values.sessionDecisionEnabled,remote:{...startup.remote.values,nodeId:'fixture-node',polling:false,authMode:'trusted-network',executorIdentity:null}}),
readQueue:async()=>({sampledAt:'2026-10-05T00:00:00.000Z',nodeId:'fixture-node',items:[{taskId:'fixture-task',runId:'fixture-run',title:'示例：整理交付材料',state:'queued',sessionId:null,workspaceId:'workspace-fixture'}],truncated:false}),
queryIdentity:async()=>{window.fixtureIdentityQueries++;throw {code:'REMOTE_PAUSED'};}};
root.render(React.createElement(ui.Page,props));
window.fixtureVisible=el=>!!el&&el.getClientRects().length>0;
window.fixtureSet=(selector,value)=>{const el=document.querySelector(selector);if(!el)throw Error('Missing '+selector);Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};
window.fixtureReady=true;
`;
const html = `<!doctype html><meta charset="utf-8"><title>Task settings · isolated fixture</title>${css.map((x) => `<link rel="stylesheet" href="/assets/${x}">`).join("")}<style>${themeCss}\nbody{margin:0;padding:24px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:14px/1.55 system-ui;}#fixture{max-width:920px;margin:auto;}</style><div id="fixture"></div><script type="module" src="/fixture.js"></script>`;
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
  const receipts = [];
  for (const mode of ["light", "dark"]) {
    await call("Page.navigate", { url: `${origin}/?theme=${mode}` });
    await until(() =>
      run(
        `!!(window.fixtureReady&&document.querySelector('[data-task-startup-settings]'))`,
      ),
    );
    await until(() =>
      run(`!!document.querySelector('#task-startup-task-role')`),
    );
    await run(
      `document.body.toggleAttribute('data-ds-dark-theme',${mode === "dark"})`,
    );
    await run(
      `fixtureSet('#task-startup-task-defaultWorkspaceId','workspace-draft')`,
    );
    await frame();
    await click(
      `document.querySelector('[data-task-executor-decision] button[role="switch"]')`,
    );
    await click(btn("执行端决策模型配置"));
    await until(() =>
      run(`!!document.querySelector('#task-decision-providerId')`),
    );
    assert.equal(await run(`fixturePluginSection`), null);
    assert.equal(
      await run(`document.activeElement.id`),
      "task-decision-model-form",
    );
    await run(`fixtureSet('#task-decision-providerId','ordinary')`);
    await frame();
    assert.equal(
      await run(
        `document.querySelector('#task-decision-nativeProvider').value`,
      ),
      "",
    );
    await run(`fixtureSet('#task-decision-nativeProvider','offline')`);
    await frame();
    assert.equal(
      await run(`document.querySelector('#task-decision-modelVersion').value`),
      "",
    );
    await run(`fixtureSet('#task-decision-modelVersion','selected-model')`);
    await frame();
    assert.ok(
      await run(
        `document.querySelector('[data-decision-model-form]').textContent.includes('凭据尚未配置')`,
      ),
    );
    await click(scopedBtn("[data-decision-model-form]", "丢弃草稿"));
    assert.equal(
      await run(`document.querySelector('#task-decision-providerId').value`),
      "rules",
    );
    assert.equal(await run(`fixtureDecisionWrites.length`), 0);
    for (const [key, v] of [
      ["providerId", "ordinary"],
      ["nativeProvider", "offline"],
      ["modelVersion", "selected-model"],
    ]) {
      await run(`fixtureSet('#task-decision-${key}','${v}')`);
      await frame();
    }
    await click(btn("高级"));
    await click(btn("简单"));
    assert.equal(
      await run(`document.querySelector('#task-decision-modelVersion').value`),
      "selected-model",
    );
    await click(scopedBtn("[data-decision-model-form]", "保存决策模型"));
    await until(() =>
      run(
        `fixtureDecisionWrites.length===1&&document.querySelector('[data-decision-model-form]').textContent.includes('已保存')`,
      ),
    );
    const nativeLayout = await call("Page.getLayoutMetrics");
    const nativeScreenshot = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: 1100,
        height: Math.ceil(nativeLayout.cssContentSize.height),
        scale: 1,
      },
    });
    writeFileSync(
      join(evidence, `${mode}-native-model-settings.png`),
      Buffer.from(nativeScreenshot.data, "base64"),
    );
    const first = await run(`fixtureDecisionWrites[0]`);
    assert.equal(first.expected.defaultProvider, "rules");
    assert.deepEqual(first.selection, {
      kind: "structured",
      providerId: "ordinary",
      nativeProvider: "offline",
      modelVersion: "selected-model",
    });
    assert.equal(
      await run(
        `document.querySelector('#task-startup-task-defaultWorkspaceId').value`,
      ),
      "workspace-draft",
    );
    assert.equal(await run(`fixtureWrites.length`), 0);
    await click(
      scopedBtn("[data-decision-model-form]", "在“模型”中管理 provider 与凭据"),
    );
    assert.equal(await run(`fixturePluginSection`), "models");
    await run(
      `fixtureSet('#task-decision-modelVersion','keep-model');window.fixtureDecisionMode='conflict'`,
    );
    await frame();
    await click(scopedBtn("[data-decision-model-form]", "保存决策模型"));
    await until(() =>
      run(
        `document.querySelector('[data-decision-model-form]').textContent.includes('配置已变化')`,
      ),
    );
    assert.equal(
      await run(`document.querySelector('#task-decision-modelVersion').value`),
      "keep-model",
    );
    assert.equal(await run(`fixtureDecisionWrites.length`), 1);
    await click(scopedBtn("[data-decision-model-form]", "丢弃草稿"));
    assert.equal(
      await run(`document.querySelector('#task-decision-modelVersion').value`),
      "selected-model",
    );
    await run(
      `window.fixtureDecisionMode='ok';fixtureSet('#task-decision-providerId','compatible')`,
    );
    await frame();
    await run(
      `fixtureSet('#task-decision-modelVersion','updated-version');fixtureSet('#task-decision-endpoint','https://fixture.invalid/new')`,
    );
    await frame();
    await click(scopedBtn("[data-decision-model-form]", "保存决策模型"));
    await until(() =>
      run(
        `fixtureDecisionWrites.length===2&&document.querySelector('[data-decision-model-form]').textContent.includes('已保存')`,
      ),
    );
    assert.equal(
      await run(`fixtureDecisionWrites[1].selection.endpoint`),
      "https://fixture.invalid/new",
    );
    assert.equal(
      await run(`fixtureDecisionWrites[1].selection.modelVersion`),
      "updated-version",
    );
    await click(btn("关闭模型配置"));
    assert.equal(
      await run(`document.querySelector('[data-decision-model-settings]')`),
      null,
    );
    await click(btn("执行端决策模型配置"));
    await until(() =>
      run(
        `document.querySelector('#task-decision-providerId')?.value==='compatible'`,
      ),
    );
    assert.equal(
      await run(`document.querySelector('#task-decision-endpoint').value`),
      "https://fixture.invalid/new",
    );
    await run(`fixtureSet('#task-startup-task-role','both')`);
    await frame();
    await click(btn("关闭模型配置"));
    await click(btn("调度端决策模型配置"));
    await until(() =>
      run(
        `document.querySelector('#task-decision-providerId')?.value==='compatible'`,
      ),
    );
    assert.equal(
      await run(`document.querySelector('#task-decision-endpoint').value`),
      "https://fixture.invalid/new",
    );
    assert.equal(await run(`fixtureIdentityQueries`), 0);
    assert.equal(
      await run(
        `document.querySelector('[data-startup-target="remote"]').textContent.includes('暂停')`,
      ),
      true,
    );
    const layout = await call("Page.getLayoutMetrics");
    const screenshot = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: 1100,
        height: Math.ceil(layout.cssContentSize.height),
        scale: 1,
      },
    });
    const imagePath = join(evidence, `${mode}-model-settings.png`);
    writeFileSync(imagePath, Buffer.from(screenshot.data, "base64"));
    receipts.push({
      theme: mode,
      directFormEntry: true,
      noAutomaticModelSelection: true,
      selectCancel: true,
      nativeSave: true,
      compatibleSave: true,
      staleCASDraftRetained: true,
      closeAndReopenPersistence: true,
      sharedAcrossRoles: true,
      workspaceDraftPreserved: true,
      modelsNavigation: true,
      remotePaused: true,
      identityQueries: 0,
      modelCalls: 0,
      imagePath,
    });
  }
  writeFileSync(
    join(evidence, "acceptance.json"),
    JSON.stringify({ ok: true, receipts }, null, 2),
  );
  console.log(
    JSON.stringify({
      ok: true,
      themes: receipts.length,
      cases: 10,
      modelCalls: 0,
      remotePaused: true,
    }),
  );
} finally {
  ws?.close();
  chrome?.kill("SIGTERM");
  server.close();
  await delay(200);
  rmSync(profile, { recursive: true, force: true });
}
