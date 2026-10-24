import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const root = fileURLToPath(new URL("../..", import.meta.url)),
  output = resolve(
    process.env.DSH_LAYOUT_OUTPUT || join(tmpdir(), "dsh-project-chat-layout"),
  );
mkdirSync(output, { recursive: true });
const markdown = readFileSync(
  require.resolve("markdown-it/browser"),
  "utf8",
).replace(/<\/script/gi, "<\\/script");
const html = readFileSync(
  join(root, "packages/task-system/src/project-page.html"),
  "utf8",
).replace("/*__TASK_MARKDOWN__*/", () => markdown);
const project = {
  id: "layout-project",
  title: "项目聊天布局验收",
  description: "专用布局 fixture",
  goal: "保持聊天宽度，按需查看项目目标、进度与历史。",
  stage: "正在推进",
  session: 3,
  workspace: "/fixture/project",
  canChat: true,
  next: "继续项目对话",
};
const snapshot = {
  projects: [project],
  tasks: [],
  settings: { root: "/fixture", revision: 0 },
  nodes: [],
  schedules: [],
  runs: [],
  attempts: [],
  reports: [],
  artifacts: [],
  milestones: [],
  projectRegistrations: [],
  projectCollaborations: [],
  workflowDefinitions: [],
  viewContext: { role: "planner" },
  viewCapabilities: { planner: true, executor: true },
};
const conversation = {
  messages: [
    {
      id: "layout-message",
      role: "assistant",
      text: "这里是聊天内容。项目资料可以在右侧按需查看。",
    },
  ],
  turns: [],
  sessions: [],
  executorTargets: [],
};
const calls = [],
  errors = [],
  results = [];
const host = `<!doctype html><html><body style="margin:0"><iframe id="app" src="/page" style="width:100%;height:100dvh;border:0;display:block"></iframe><script>const frame=document.getElementById('app');window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.data?.channel!=='dsh-project-runtime')return;const {id,method,input}=event.data;if(method==='detailFullscreen')return;const result=await(await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,input})})).json();event.source.postMessage({channel:'dsh-project-runtime',id,...result},'*');});</script></body></html>`;
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "text/html;charset=utf-8");
  if (req.url !== "/rpc") {
    res.end(req.url === "/page" ? html : host);
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const { method, input } = JSON.parse(body);
  calls.push({ method, input });
  const values = {
    projectSnapshot: snapshot,
    projectConversation: conversation,
  };
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      Object.hasOwn(values, method)
        ? { value: values[method] }
        : { error: "Unexpected layout fixture RPC " + method },
    ),
  );
});
let browser;
try {
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const executablePath =
    process.env.CHROME_EXECUTABLE ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const frame = page.frameLocator("#app");
  await frame.locator('[data-action="projects"]').click();
  await frame
    .locator('[data-action="project"][data-id="layout-project"]')
    .click();
  await frame.locator('[data-action="chat"]').click();
  const side = frame.locator("#project-context"),
    toggle = frame.locator('[data-action="project-context-toggle"]'),
    chat = frame.locator("[data-project-conversation-host]");
  await side.waitFor({ state: "visible" });
  assert.equal(
    await frame.locator(".session-bar").count(),
    0,
    "chat has no duplicate high session banner",
  );
  assert.match(await frame.locator(".topbar h1").innerText(), /统筹会话 3/);
  assert.equal(await side.getAttribute("role"), "complementary");
  assert.equal(await side.getAttribute("aria-modal"), null);
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(
    await side.locator(".project-context-empty").innerText(),
    "暂无需要关注的任务",
  );
  const controls = await side
    .locator(".project-context-links .btn")
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
  assert.equal(controls.length, 3);
  for (const rect of controls) assert.equal(rect.width, controls[0].width);
  for (let i = 1; i < controls.length; i++)
    assert.ok(
      controls[i].y - (controls[i - 1].y + controls[i - 1].height) >= 9,
      "sidebar controls have explicit gap",
    );
  const firstChat = await chat.boundingBox(),
    header = await frame.locator(".topbar").boundingBox(),
    sideRect = await side.boundingBox();
  assert.ok(
    Math.abs(firstChat.y - (header.y + header.height)) < 2,
    "chat begins directly below topbar",
  );
  assert.ok(
    firstChat.x + firstChat.width <= sideRect.x + 1,
    "desktop sidebar sits beside chat",
  );
  await frame.locator("#message-input").fill("保留的草稿");
  await chat.evaluate((el) => {
    el.dataset.layoutIdentity = "preserved";
  });
  await toggle.click();
  await side.waitFor({ state: "hidden" });
  const wideChat = await chat.boundingBox();
  assert.ok(wideChat.width > firstChat.width + 250);
  assert.equal(
    await chat.getAttribute("data-layout-identity"),
    "preserved",
    "collapse preserves conversation host",
  );
  assert.equal(
    await frame.locator("#message-input").inputValue(),
    "保留的草稿",
  );
  await toggle.click();
  await side.waitFor({ state: "visible" });
  await side.locator("summary").click();
  assert.ok(
    (await side.locator(".technical-details").getAttribute("open")) !== null,
  );
  const polls = calls.filter(
    (call) => call.method === "projectSnapshot",
  ).length;
  await new Promise((done, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      if (
        calls.filter((call) => call.method === "projectSnapshot").length > polls
      )
        done();
      else if (Date.now() > deadline)
        reject(Error("layout fixture did not receive next poll"));
      else setTimeout(check, 30);
    };
    check();
  });
  assert.equal(
    await chat.getAttribute("data-layout-identity"),
    "preserved",
    "poll preserves conversation host",
  );
  assert.ok(
    (await side.locator(".technical-details").getAttribute("open")) !== null,
    "poll preserves technical disclosure",
  );
  await page.screenshot({ path: join(output, "desktop.png") });
  results.push({
    viewport: "desktop",
    chat: firstChat,
    sidebar: sideRect,
    collapsedChat: wideChat,
    controls,
  });
  await frame.locator('[data-action="project-overview"]').click();
  await frame.locator(".project-detail-summary").waitFor();
  await frame.locator('.topbar [data-action="nav-back"]').click();
  await chat.waitFor();
  assert.equal(
    await frame.locator("#message-input").inputValue(),
    "保留的草稿",
    "overview return preserves conversation draft",
  );
  await frame.locator('.topbar [data-action="nav-back"]').click();
  await frame.locator(".project-detail-summary").waitFor();
  await frame.locator('.topbar [data-action="nav-back"]').click();
  await frame.locator(".project-grid").waitFor();
  await frame
    .locator('[data-action="project"][data-id="layout-project"]')
    .click();
  await frame.locator('[data-action="chat"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await side.waitFor({ state: "visible" });
  assert.equal(
    await side.getAttribute("role"),
    "dialog",
    "expanded desktop sidebar becomes mobile modal",
  );
  await page.keyboard.press("Escape");
  await side.waitFor({ state: "hidden" });
  assert.ok(
    await toggle.evaluate((el) => el === document.activeElement),
    "Escape returns focus to trigger",
  );
  const mobileChat = await chat.boundingBox();
  assert.equal(Math.round(mobileChat.width), 390);
  await toggle.click();
  await side.waitFor({ state: "visible" });
  const openMobileChat = await chat.boundingBox();
  assert.deepEqual(
    openMobileChat,
    mobileChat,
    "mobile overlay never squeezes chat",
  );
  assert.equal(await side.getAttribute("role"), "dialog");
  assert.equal(await side.getAttribute("aria-modal"), "true");
  assert.ok(await frame.locator(".topbar").evaluate((el) => el.inert));
  assert.ok(await chat.evaluate((el) => el.inert));
  const close = side.locator('[data-action="project-context-close"]');
  assert.ok(await close.evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Shift+Tab");
  assert.ok(
    await side.evaluate((el) => el.contains(document.activeElement)),
    "reverse tab remains inside drawer",
  );
  await page.keyboard.press("Tab");
  assert.ok(
    await close.evaluate((el) => el === document.activeElement),
    "tab wraps back to drawer close",
  );
  await page.screenshot({ path: join(output, "mobile-open.png") });
  await close.click();
  await side.waitFor({ state: "hidden" });
  assert.ok(await toggle.evaluate((el) => el === document.activeElement));
  await toggle.click();
  await side.waitFor({ state: "visible" });
  await frame
    .locator(".project-context-backdrop")
    .click({ position: { x: 8, y: 300 } });
  await side.waitFor({ state: "hidden" });
  assert.ok(await toggle.evaluate((el) => el === document.activeElement));
  assert.equal(
    await chat.getAttribute("data-layout-identity"),
    null,
    "navigation creates a fresh conversation host",
  );
  await chat.evaluate((el) => {
    el.dataset.layoutIdentity = "mobile-preserved";
  });
  await toggle.click();
  await side.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  assert.equal(
    await chat.getAttribute("data-layout-identity"),
    "mobile-preserved",
  );
  assert.ok(!(await chat.evaluate((el) => el.inert)));
  assert.equal(
    await frame.locator("html").evaluate((el) => el.scrollWidth <= innerWidth),
    true,
    "mobile document has no horizontal overflow",
  );
  await page.screenshot({ path: join(output, "mobile-closed.png") });
  results.push({
    viewport: "mobile",
    chat: mobileChat,
    openChat: openMobileChat,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await side.waitFor({ state: "hidden" });
  await toggle.click();
  await side.waitFor({ state: "visible" });
  assert.equal(await side.getAttribute("role"), "complementary");
  assert.ok(!(await frame.locator(".topbar").evaluate((el) => el.inert)));
  const phone = await browser.newPage({
    viewport: { width: 320, height: 740 },
  });
  phone.on("pageerror", (error) => errors.push(error.message));
  await phone.goto(`http://127.0.0.1:${server.address().port}`);
  const phoneFrame = phone.frameLocator("#app");
  await phoneFrame.locator('[data-action="projects"]').click();
  await phoneFrame
    .locator('[data-action="project"][data-id="layout-project"]')
    .click();
  await phoneFrame.locator('[data-action="chat"]').click();
  await phoneFrame.locator("[data-project-conversation-host]").waitFor();
  assert.equal(
    await phoneFrame.locator("#project-context").isVisible(),
    false,
    "mobile starts with sidebar closed",
  );
  assert.equal(
    await phoneFrame
      .locator('[data-action="project-context-toggle"]')
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.ok(
    await phoneFrame
      .locator("html")
      .evaluate((el) => el.scrollWidth <= innerWidth),
    "320px document fits viewport",
  );
  results.push({
    viewport: "narrow-mobile",
    chat: await phoneFrame
      .locator("[data-project-conversation-host]")
      .boundingBox(),
  });
  await phone.screenshot({ path: join(output, "narrow-mobile.png") });
  await phone.close();
  assert.deepEqual(errors, []);
  assert.ok(calls.some((call) => call.method === "projectConversation"));
  writeFileSync(
    join(output, "results.json"),
    JSON.stringify({ results, errors, calls }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ status: "passed", output, results }));
} finally {
  await browser?.close();
  if (server.listening) await new Promise((done) => server.close(done));
}
