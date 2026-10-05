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
window.fixtureWrites=[];window.fixtureIdentityQueries=0;window.fixturePluginSection=null;window.fixtureNavigationAvailable=false;
const live={available:true,writable:true,saving:false,dirty:false,valid:true,fields:Object.fromEntries(ui.keys.map(key=>[key,{text:['schedulerEnabled','autoExecute','healthAlerts'].includes(key)?'false':'1000',overridden:false,invalid:false}]))};
const props={openPlugins:()=>window.fixtureNavigationAvailable&&ui.openPlugins({slots:{entries:()=>[{options:{store:{create:()=>({actions:{openSection:id=>{window.fixturePluginSection=id;}}})}}}]}}),t:key=>ui.zh[key]??key,useTaskSettings:project=>project(live),edit(){},resetField(){},save(){},discard(){},
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
    await call("Page.navigate", { url: origin });
    await until(() =>
      run(
        `window.fixtureReady&&!!document.querySelector('#task-startup-task-role')`,
      ),
    );
    await run(
      mode === "dark"
        ? `document.body.setAttribute('data-ds-dark-theme','')`
        : `document.body.removeAttribute('data-ds-dark-theme')`,
    );
    await frame();
    const simple = await run(
      `({pressed:document.querySelector('[data-task-mode] button').getAttribute('aria-pressed'),queue:fixtureVisible(document.querySelector('[data-task-local-queue]')),debug:fixtureVisible(document.querySelector('#task-startup-remote-concurrency')),decision:fixtureVisible(document.querySelector('[data-task-decision-entry]'))})`,
    );
    assert.deepEqual(simple, {
      pressed: "true",
      queue: true,
      debug: false,
      decision: false,
    });
    await run(
      `fixtureSet('#task-startup-task-defaultWorkspaceId','workspace-draft')`,
    );
    await frame();
    await click(btn("高级"));
    assert.equal(
      await run(
        `document.querySelector('#task-startup-task-defaultWorkspaceId').value`,
      ),
      "workspace-draft",
    );
    await run(`fixtureSet('#task-startup-remote-concurrency','2')`);
    await frame();
    await click(btn("简单"));
    assert.equal(
      await run(
        `document.querySelector('#task-startup-remote-concurrency').value`,
      ),
      "2",
    );
    await click(
      `document.querySelector('[data-task-executor-decision] button[role="switch"]')`,
    );
    assert.equal(
      await run(
        `fixtureVisible(document.querySelector('[data-task-decision-entry]'))`,
      ),
      true,
    );
    await click(btn("执行端决策模型配置"));
    assert.equal(
      await run(
        `document.querySelector('[data-task-mode] button[aria-pressed="true"]').textContent.trim()`,
      ),
      "高级",
    );
    assert.equal(await run(`document.activeElement.id`), "task-decision-model");
    await run(`window.fixtureNavigationAvailable=true`);
    await click(btn("执行端决策模型配置"));
    assert.equal(await run(`window.fixturePluginSection`), "plugins");
    await click(btn("简单"));
    await click(scopedBtn('[data-startup-target="task"]', "保存并重启插件"));
    const taskWrite = await run(`fixtureWrites[0]`);
    assert.deepEqual(taskWrite.expected, {
      role: "executor",
      defaultWorkspaceId: "workspace-fixture",
      planningDecisionEnabled: true,
      sessionDecisionEnabled: false,
    });
    assert.deepEqual(taskWrite.changes, {
      defaultWorkspaceId: "workspace-draft",
      sessionDecisionEnabled: true,
    });
    assert.equal(
      await run(
        `document.querySelector('#task-startup-remote-concurrency').value`,
      ),
      "2",
    );
    await click(scopedBtn('[data-startup-target="remote"]', "保存并重启插件"));
    assert.deepEqual((await run(`fixtureWrites[1]`)).changes, {
      concurrency: 2,
    });
    await run(`fixtureSet('#task-startup-task-role','planner')`);
    await frame();
    assert.equal(
      await run(
        `fixtureVisible(document.querySelector('[data-startup-target="remote"]'))`,
      ),
      false,
    );
    assert.equal(
      await run(
        `fixtureVisible(document.querySelector('[data-task-executor-connections]'))`,
      ),
      true,
    );
    await run(`fixtureSet('#task-startup-task-role','executor')`);
    await frame();
    assert.equal(
      await run(
        `fixtureVisible(document.querySelector('[data-startup-target="remote"]'))`,
      ),
      true,
    );
    assert.equal(
      await run(
        `document.querySelector('#task-startup-remote-concurrency').value`,
      ),
      "2",
    );
    await click(scopedBtn('[data-startup-target="task"]', "丢弃草稿"));
    await click(btn("高级"));
    const paused = await run(
      `(()=>{const el=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='向调度端查询本机执行端 ID');return {disabled:el.disabled,queries:fixtureIdentityQueries};})()`,
    );
    assert.deepEqual(paused, { disabled: true, queries: 0 });
    const advancedComputed = await run(
      `[...document.querySelectorAll('[data-task-plugin-settings] button')].filter(fixtureVisible).map(el=>{const s=getComputedStyle(el);return {text:el.textContent.trim().slice(0,80),borderWidth:s.borderTopWidth,borderColor:s.borderTopColor,borderStyle:s.borderTopStyle,background:s.backgroundColor,disabled:el.disabled};})`,
    );
    for (const entry of advancedComputed) {
      assert.ok(parseFloat(entry.borderWidth) >= 1);
      assert.notEqual(entry.borderStyle, "none");
      assert.notEqual(entry.borderColor, "rgba(0, 0, 0, 0)");
    }
    const advancedLayout = await call("Page.getLayoutMetrics");
    const advancedPng = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: 1100,
        height: Math.ceil(advancedLayout.cssContentSize.height),
        scale: 1,
      },
    });
    writeFileSync(
      join(evidence, `${mode}-advanced.png`),
      Buffer.from(advancedPng.data, "base64"),
    );
    await click(btn("简单"));
    await run(`window.scrollTo(0,0)`);
    await frame();
    const computed = await run(
      `(()=>{const style=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {text:el.textContent.trim().slice(0,80),borderWidth:s.borderTopWidth,borderColor:s.borderTopColor,borderStyle:s.borderTopStyle,background:s.backgroundColor,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};};return {buttons:[...document.querySelectorAll('[data-task-plugin-settings] button')].filter(fixtureVisible).map(style),inputs:['#task-startup-task-role','#task-startup-task-defaultWorkspaceId'].map(x=>style(document.querySelector(x))),dividers:[...document.querySelectorAll('[data-task-startup-settings], [data-startup-target=remote], [data-task-local-queue], [data-task-runtime]')].filter(fixtureVisible).map(style)};})()`,
    );
    for (const entry of [
      ...computed.buttons,
      ...computed.inputs,
      ...computed.dividers,
    ]) {
      assert.ok(parseFloat(entry.borderWidth) >= 1, JSON.stringify(entry));
      assert.notEqual(entry.borderStyle, "none");
      assert.notEqual(entry.borderColor, "rgba(0, 0, 0, 0)");
    }
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
    const imagePath = join(evidence, `${mode}-simple.png`);
    writeFileSync(imagePath, Buffer.from(screenshot.data, "base64"));
    receipts.push({
      theme: mode,
      defaultSimple: true,
      sharedDraftPreserved: true,
      hiddenConcurrencySavedWithoutConnectionMutation: true,
      roleConditionalPeer: true,
      decisionEntryConditional: true,
      modelEntryClickable: true,
      pausedIdentityQueryBlocked: true,
      actualPointerButtonClicks: true,
      taskExpectedSnapshot: taskWrite.expected,
      taskChanges: taskWrite.changes,
      computed,
      advancedComputed,
      publicPluginNavigationRequested: true,
      imagePath,
    });
  }
  // Read actual screenshot pixels using the already installed SDK image library.
  const sharp = req("sharp");
  for (const row of receipts) {
    const { data, info } = await sharp(row.imagePath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sample = (x, y) => {
      const index =
        (Math.round(y) * info.width + Math.round(x)) * info.channels;
      return Array.from(data.subarray(index, index + 3));
    };
    const entries = [
      ["button", row.computed.buttons[1]],
      ["role", row.computed.inputs[0]],
      ["workspace", row.computed.inputs[1]],
      ["divider", row.computed.dividers[0]],
    ];
    row.pixels = entries.map(([kind, entry]) => {
      const r = entry.rect;
      const border =
        kind === "divider"
          ? sample(r.x + r.width / 2, r.y)
          : sample(r.x, r.y + r.height / 2);
      const inside =
        kind === "divider"
          ? sample(r.x + r.width / 2, r.y + 4)
          : sample(r.x + 4, r.y + r.height / 2);
      const delta = Math.max(...border.map((v, i) => Math.abs(v - inside[i])));
      assert.ok(
        delta >= 3,
        `${row.theme} ${kind}: border is not visibly distinct ${border} / ${inside}`,
      );
      return { kind, border, inside, maxChannelDelta: delta };
    });
  }
  writeFileSync(
    join(evidence, "browser-acceptance.json"),
    JSON.stringify(
      {
        officialRuntime: "0.2.0-rc.2",
        browser: "isolated local Google Chrome",
        syntheticRpc: true,
        realModelCalls: 0,
        activeDSHServicesTouched: false,
        receipts,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      ok: true,
      themes: receipts.map((x) => x.theme),
      actualPointerButtonClicks: true,
      sharedDraft: true,
      computedBorders: true,
      realPixelBorders: true,
      evidence,
    }),
  );
} finally {
  ws?.close();
  chrome?.kill("SIGTERM");
  server.close();
  await delay(200);
  rmSync(profile, { recursive: true, force: true });
}
