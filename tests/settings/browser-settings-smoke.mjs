/** Browser-only fixture: uses shipped rc.2 React/UI primitives, with synthetic config transport.
 * No DSH Host, credential provider, model adapter or real node is started.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import http from "node:http";
const runtime = process.env.DSH_OFFICIAL_ROOT;
assert.ok(runtime, "Set DSH_OFFICIAL_ROOT");
const { chromium } = createRequire("/opt/codex/cua_node/package.json")(
  "playwright",
);
const dist = join(runtime, "node_modules/@deepseek-ai/dsh-web-frontend/dist");
const assets = join(dist, "assets");
const indexName = readdirSync(assets).find((f) => /^index-.*\.js$/.test(f));
const source = readFileSync(join(assets, indexName), "utf8");
const platform =
  /function (\w+)\(\)\{return\{react:[^}]+"@deepseek-ai\/dsh-client-ui-primitives"[^}]+\}\}/.exec(
    source,
  );
assert.ok(
  platform,
  "exact rc.2 platform getter must be identifiable; fail rather than fake shared UI",
);
const bootIndex = source.indexOf("const fo=globalThis.dshDesktopBoot");
assert.ok(bootIndex > 0);
const platformOnly =
  source.slice(0, bootIndex) + `\nwindow.__TEST_PLATFORM__=${platform[1]}();`;
const styles = readdirSync(assets)
  .filter((f) => f.endsWith(".css"))
  .map((f) => `<link rel="stylesheet" href="/assets/${f}">`)
  .join("");
const html = `<!doctype html><html lang="zh" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<title>Task plugin settings · isolated fixture</title><style>body{margin:0;background:var(--dsw-bg-primary,#f8f9fa);color:var(--dsw-text-primary,#202327);font-family:system-ui,sans-serif}main{max-width:820px;margin:24px auto;padding:20px 28px 60px;background:var(--dsw-bg-secondary,#fff);border-radius:16px}header{font-size:13px;color:#687078;margin-bottom:20px}h1{font-size:26px;margin:10px 0 24px}button{cursor:pointer}</style><main><header>插件 / 任务系统 / 配置 · 离线合成验收</header><h1>任务系统设置</h1><div id="root"></div></main><script type="module">
import '/assets/platform-only.js';
const P=window.__TEST_PLATFORM__,R=P.react;
window.__ModuleLoader__={load(row){window.plugin=row.factory(name=>P[name]);}};
await new Promise((resolve,reject)=>{let s=document.createElement('script');s.src='/settings-client.js';s.onload=resolve;s.onerror=reject;document.head.append(s)});
const base={schedulerEnabled:true,autoExecute:false,maxConcurrent:1,executionTimeoutMs:300000,healthAlerts:false,localHeartbeatIntervalMs:30000};
let snap={status:'ready',value:{...base},base:{...base},user:{},writable:true,revision:1};
const listeners=new Set();window.writes=[];window.rejectNext=false;window.delayNext=false;window.readFail=false;
const notify=()=>{for(const l of listeners)l()};
const scope={getSnapshot:()=>snap,subscribe:f=>(listeners.add(f),()=>listeners.delete(f)),async mutate(ops,revision){window.writes.push({ops,revision});if(window.delayNext){window.delayNext=false;await new Promise(r=>setTimeout(r,200))}if(window.rejectNext){window.rejectNext=false;snap={...snap,revision:snap.revision+1};notify();return false;}const user={...snap.user};for(const op of ops){if(op.op==='set')user[op.path[0]]=op.value;else delete user[op.path[0]];}snap={...snap,user,value:{...base,...user},revision:snap.revision+1};notify();return true;}};
window.snapshot=()=>snap;
const controller=new plugin.Controller(scope),actions=controller.form.actions();
const root=P['react-dom/client'].createRoot(document.getElementById('root'));
const read=async()=>{if(window.readFail)throw new Error('synthetic unavailable');return {nodeId:'mbp-test',role:'executor',databasePath:'/tmp/isolated-dsh/tasks.sqlite',homePatch:null,commandLineConfigOverride:false,profilePatch:'/tmp/isolated-dsh/profiles/web/cordis.patch.yml',keepAlive:true,maintenanceIntervalMs:1000,leaseTtlMs:60000,executionTools:[],remote:{nodeId:'mbp-test',role:'executor',endpoint:'http://127.0.0.1:4300/dsh-task/v1/commands',pollIntervalMs:5000,concurrency:1,polling:true,authMode:'trusted-network'}}};
window.render=(language='zh',visible=true)=>{root.render(visible?R.createElement(plugin.Page,{view:'page',t:k=>plugin[language][k]||k,useTaskSettings:selector=>selector(R.useSyncExternalStore(controller.store.subscribe,controller.store.getSnapshot)),...actions,read}):R.createElement('p',null,'Other page'));};
window.render();
</script></html>`;
const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/") {
    res.setHeader("content-type", "text/html");
    res.end(html);
    return;
  }
  if (path === "/settings-client.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(
      readFileSync(resolve("packages/task-system/dist/settings-client.js")),
    );
    return;
  }
  if (path === "/assets/platform-only.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(platformOnly);
    return;
  }
  const file = path.startsWith("/assets/") ? path.slice("/assets/".length) : "";
  if (!file || file.includes("/") || file.includes("..")) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    res.setHeader(
      "content-type",
      file.endsWith(".css") ? "text/css" : "text/javascript",
    );
    res.end(readFileSync(join(assets, file)));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
if (process.env.DSH_FIXTURE_ONLY === "1") {
  console.log(`FIXTURE_URL=http://127.0.0.1:${server.address().port}`);
  await new Promise(() => {});
}
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1120, height: 1100 },
});
const page = await context.newPage();
await context.route("**/*", (route) => {
  const u = new URL(route.request().url());
  return u.hostname === "127.0.0.1" && u.port === String(server.address().port)
    ? route.continue()
    : route.abort("blockedbyclient");
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const checks = [];
const pass = (s) => {
  checks.push(s);
  console.log(`PASS ${s}`);
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("[data-task-plugin-settings]").waitFor();
  await page
    .getByText("/tmp/isolated-dsh/tasks.sqlite", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("switch").count(), 3);
  assert.match(
    await page.locator("[role=note]").innerText(),
    /不会暂停远程领取/,
  );
  assert.equal(
    await page.locator("[data-setting=polling]").innerText(),
    "开启",
  );
  pass(
    "official shared UI renders six fields, startup details, and independent remote-polling warning",
  );
  const concurrency = page.locator("#task-setting-maxConcurrent");
  await concurrency.fill("3");
  assert.equal(await page.evaluate(() => writes.length), 0);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(() => snapshot().value.maxConcurrent === 3);
  pass(
    "numeric edit remains staged until Save and uses revision-fenced path mutation",
  );
  await concurrency.fill("33");
  assert.ok(
    await page.getByRole("button", { name: "保存", exact: true }).isDisabled(),
  );
  assert.equal(await page.evaluate(() => writes.length), 1);
  await concurrency.fill("2");
  await page.evaluate(() => render("zh", false));
  await page.getByText("Other page").waitFor();
  await page.evaluate(() => render());
  await concurrency.waitFor();
  assert.equal(await concurrency.inputValue(), "3");
  pass(
    "invalid range blocks Save; leaving and reopening discards unsaved edits",
  );
  await page
    .getByRole("switch", { name: "自动执行本机队列", exact: true })
    .click();
  assert.equal(await page.evaluate(() => snapshot().value.autoExecute), false);
  await page.evaluate(() => {
    delayNext = true;
  });
  const save = page.getByRole("button", { name: "保存", exact: true });
  await save.click();
  assert.ok(
    await page
      .getByRole("button", { name: "保存中…", exact: true })
      .isDisabled(),
  );
  await page.waitForFunction(() => snapshot().value.autoExecute === true);
  assert.equal(await page.evaluate(() => writes.length), 2);
  pass(
    "switches stage boolean values and repeated saves are blocked while pending",
  );
  await concurrency.fill("4");
  await page.evaluate(() => {
    rejectNext = true;
  });
  await save.click();
  await page.getByText(/保存被拒绝/).waitFor();
  assert.equal(await concurrency.inputValue(), "4");
  assert.equal(await page.evaluate(() => snapshot().value.maxConcurrent), 3);
  pass("rejected/stale save keeps drafts and does not show an accepted value");
  await page.evaluate(() => render("zh", false));
  await page.getByText("Other page").waitFor();
  await page.evaluate(() => render());
  await concurrency.waitFor();
  await concurrency.fill("");
  await save.click();
  await page.waitForFunction(() => snapshot().value.maxConcurrent === 1);
  pass(
    "blank numeric reset restores the inherited value through an unset operation",
  );
  await page.evaluate(() => {
    readFail = true;
  });
  await page.getByRole("button", { name: "刷新部署详情", exact: true }).click();
  await page.getByText(/未能读取部署详情/).waitFor();
  assert.equal(
    await page.locator("[data-setting=databasePath]").innerText(),
    "/tmp/isolated-dsh/tasks.sqlite",
  );
  await page.evaluate(() => {
    readFail = false;
  });
  await page.getByRole("button", { name: "刷新部署详情", exact: true }).click();
  await page.waitForFunction(
    () => !document.body.textContent.includes("未能读取部署详情"),
  );
  pass("read failure preserves prior deployment details and Retry recovers");
  const out = resolve("tests/settings/results");
  mkdirSync(out, { recursive: true });
  await page.screenshot({
    path: join(out, "task-settings-zh.png"),
    fullPage: true,
  });
  await page.evaluate(() => render("en"));
  await page
    .getByText("Current deployment · read only", { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(out, "task-settings-en.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.evaluate(() => render());
  await page.getByText("当前部署 · 只读", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(out, "task-settings-mobile.png"),
    fullPage: true,
  });
  pass(
    "English/Chinese and narrow viewport render without horizontal overflow",
  );
  assert.deepEqual(errors, []);
  writeFileSync(
    join(out, "browser-receipt.json"),
    JSON.stringify(
      {
        ok: true,
        checks,
        errors,
        host: "synthetic transport, actual rc.2 React and UI primitives",
        credentials: "none",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
