import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(
  process.env.DSH_PROJECT_WORKFLOW_ROOT ||
    join(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const { createNativeHarness } = await import(
  pathToFileURL(join(root, "tests/dsh/native-harness.mjs"))
);
const { Workbench } = await import(
  pathToFileURL(join(root, "packages/task-system/dist/workbench.js"))
);
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const h = await createNativeHarness({
  config: {
    role: "planner",
    nodeId: "vps",
    projectAgentOptions: { provider: "test-offline", model: "script" },
  },
});
let browser, server;
try {
  const ledger = h.ledger,
    service = h.ctx.taskSystem,
    projects = service.projects,
    workflows = service.workflows;
  new Workbench(ledger).manage("browser-project", "create_project", {
    projectId: "browser-project",
    title: "浏览器验收项目",
    goal: "Verify project-owned workflow and ordinary manual tasks",
  });
  ledger.registerWorkspace("browser-workspace", {
    workspaceId: "browser-ws",
    nodeId: "vps",
    path: h.dir,
    label: "Browser temporary workspace",
    state: "ready",
    createdAt: new Date().toISOString(),
  });
  ledger.registerNode("browser-node", {
    nodeId: "vps",
    enabled: true,
    roles: ["both"],
    capabilities: [],
    workspaceIds: ["browser-ws"],
    models: [
      { provider: "test-offline", model: "script", reasoningEfforts: [] },
    ],
    lastSeenAt: new Date().toISOString(),
  });
  service.programs.register({
    programId: "browser.fixture",
    version: "1",
    title: "浏览器验收程序",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    execute: async () => ({ data: { ok: true }, summary: "Local fixture" }),
  });
  ledger.recordNodeHeartbeat("browser-heartbeat", {
    nodeId: "vps",
    runtimeReady: true,
    activeExecutions: 0,
    source: "host-local",
    sampledAt: Date.now(),
    providerStatus: {
      programs: service.programs.catalog(),
      executionRoutes: [
        {
          nodeId: "vps",
          provider: "test-offline",
          model: "script",
          requiredCapabilities: [],
        },
      ],
    },
  });
  ledger.registerWorkspace("browser-agent-workspace", {
    workspaceId: "browser-agent-ws",
    nodeId: "worker",
    path: h.dir,
    label: "Ordinary Agent workspace",
    state: "ready",
    createdAt: new Date().toISOString(),
  });
  ledger.registerNode("browser-agent-node", {
    nodeId: "worker",
    enabled: true,
    roles: ["executor"],
    capabilities: [],
    workspaceIds: ["browser-agent-ws"],
    models: [
      { provider: "test-offline", model: "script", reasoningEfforts: [] },
    ],
    lastSeenAt: new Date().toISOString(),
  });
  ledger.recordNodeHeartbeat("browser-agent-heartbeat", {
    nodeId: "worker",
    runtimeReady: true,
    activeExecutions: 0,
    source: "host-local",
    sampledAt: Date.now(),
    providerStatus: {
      executionRoutes: [
        {
          nodeId: "worker",
          provider: "test-offline",
          model: "script",
          requiredCapabilities: [],
        },
      ],
    },
  });
  assert.ok(
    projects.scheduleOptions().routes.length,
    "fixture advertises an authorized Agent route",
  );
  const stage = {
    stageId: "prepare",
    title: "准备阶段",
    nodeId: "vps",
    position: { x: 10, y: 20 },
  };
  workflows.save({
    commandId: "browser-workflow",
    expectedRevision: 0,
    definition: {
      workflowId: "browser-flow",
      projectId: "browser-project",
      revision: 0,
      title: "项目验收流程",
      description: "Temporary browser fixture",
      stages: [stage],
      calls: [],
      steps: [
        {
          stepId: "fixture",
          stageId: stage.stageId,
          title: "执行本地程序",
          nodeId: "vps",
          workspaceId: "browser-ws",
          position: { x: 10, y: 10 },
          dependsOn: [],
          inputs: {},
          execution: {
            kind: "program",
            programId: "browser.fixture",
            version: "1",
          },
          maxRetries: 0,
        },
      ],
    },
  });
  const operations = {
    projectSnapshot: () => projects.snapshot(),
    workflowSnapshot: () => workflows.snapshot(),
    scheduleOptions: () => projects.scheduleOptions(),
    saveWorkflow: (input) => workflows.save(input),
    configureWorkflowTask: (input) => workflows.configureTask(input),
    startWorkflow: (input) => workflows.start(input),
    createProjectTask: (input) => projects.createDirectTask(input),
    runProjectTask: (input) => projects.runDirectTask(input),
  };
  const rpcCalls = [];
  const host = `<!doctype html><html><body style="margin:0"><iframe id="app" style="width:100%;height:100dvh;border:0" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe><script>
 const frame=document.getElementById('app');
 async function show(method,context){const html=await(await fetch('/page/'+method)).text();const name=method==='workflowPage'?'__DSH_WORKFLOW_CONTEXT__':'__DSH_PROJECT_CONTEXT__';const json=JSON.stringify(context||null).replace(/</g,'\\u003c');frame.srcdoc=html.replace('<head>',()=>'<head><script>window.'+name+'='+json+';<'+ '/script>');}
 window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.data?.channel!=='dsh-project-runtime')return;const {id,method,input}=event.data;if(method==='detailFullscreen')return;try{if(method==='openWorkflow'||method==='closeWorkflow'){event.source.postMessage({channel:'dsh-project-runtime',id,value:{}},'*');await show(method==='openWorkflow'?'workflowPage':'projectPage',input);return;}const result=await(await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,input})})).json();event.source.postMessage({channel:'dsh-project-runtime',id,...result},'*');}catch(error){event.source.postMessage({channel:'dsh-project-runtime',id,error:error.message},'*');}});show('projectPage');
 </script></body></html>`;
  server = createServer(async (req, res) => {
    try {
      if (req.url === "/rpc" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { method, input } = JSON.parse(body);
        rpcCalls.push({ method, input });
        if (!Object.hasOwn(operations, method))
          throw Error(`Unexpected runtime RPC ${method}`);
        const value = await operations[method](input);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ value }));
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.url === "/page/projectPage" || req.url === "/page/workflowPage") {
        const name = req.url.endsWith("workflowPage")
          ? "workflow-page.html"
          : "project-page.html";
        res.end(
          readFileSync(join(root, "packages/task-system/dist", name), "utf8"),
        );
        return;
      }
      res.end(host);
    } catch (error) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: error.message, errorCode: error.code }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
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
      viewport: { width: 1440, height: 1080 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  page.setDefaultTimeout(10000);
  const app = page.frameLocator("#app");
  await app.locator('[data-action="projects"]').first().click();
  await app
    .locator('[data-action="project"][data-id="browser-project"]')
    .click();
  await app
    .locator(".project-execution")
    .getByText("执行调用图", { exact: true })
    .waitFor();
  await app
    .locator(".project-flow-stage")
    .getByText("准备阶段", { exact: true })
    .click();
  await app
    .locator("#canvas-breadcrumb")
    .getByText("准备阶段 · 内部步骤", { exact: true })
    .waitFor();
  assert.equal(
    await app.locator('[data-card="fixture"]').count(),
    1,
    "stage context opens internal steps",
  );
  await app.locator("#leave-stage").click();
  const card = app.locator('[data-card="prepare"] .card-main');
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + 80, box.y + 35);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 65, { steps: 8 });
  await page.mouse.up();
  await app.locator("#save-workflow").click();
  await app.locator("#revision").getByText("版本 2", { exact: true }).waitFor();
  const savedPosition = structuredClone(
    workflows
      .snapshot()
      .definitions.find((row) => row.workflowId === "browser-flow").stages[0]
      .position,
  );
  assert.notDeepEqual(
    savedPosition,
    { x: 10, y: 20 },
    "drag saves real SQLite coordinates",
  );
  await app.locator("#back-project").click();
  await app
    .locator(".project-execution")
    .getByText("执行调用图", { exact: true })
    .waitFor();
  await app
    .locator('.project-flow-stage [data-action="workflow-stage"]')
    .click();
  await app.locator('#leave-stage').click();
  await app.locator('[data-card="prepare"]').waitFor();
  const reopenedPosition = await app
    .locator('[data-card="prepare"]')
    .evaluate((node) => ({
      x: parseFloat(node.style.left),
      y: parseFloat(node.style.top),
    }));
  assert.deepEqual(
    reopenedPosition,
    savedPosition,
    "reopened editor uses persisted coordinates",
  );
  await app.locator('#workflow-result-settings summary').click();
  await app.locator('#workflow-result-mode').selectOption('explicit');
  await app.locator('[data-result-step="fixture"]').waitFor();
  assert.equal(await app.locator('[data-result-step="fixture"]').isChecked(), true);
  await app.locator('#save-workflow').click();
  await app.locator('#revision').getByText('版本 3', {exact:true}).waitFor();
  assert.deepEqual(workflows.snapshot().definitions.find(row=>row.workflowId==='browser-flow').resultStepIds,['fixture']);
  await app.locator("#back-project").click();
  await app.locator('[data-action="project-create-task"]').click();
  await app.locator('[data-plan="title"]').fill("手动工作流任务");
  await app
    .locator('[data-plan="description"]')
    .fill("Use the selected project workflow when explicitly started");
  await app.locator('[data-plan="executionKind"]').selectOption("workflow");
  await app.locator('[data-plan="workflowId"]').selectOption("browser-flow");
  await app
    .locator('[data-plan="workflowInput"]')
    .fill('{"source":"real-browser"}');
  assert.equal(await app.locator('[data-plan="mode"]').inputValue(), "manual");
  await app.locator('[data-action="create-schedule-confirm"]').click();
  await app
    .locator(".drawer h2")
    .getByText("手动工作流任务", { exact: true })
    .waitFor();
  const configured = workflows
    .snapshot()
    .taskBindings.find(
      (row) => ledger.getTask(row.taskId).title === "手动工作流任务",
    );
  assert.ok(configured);
  assert.equal(
    ledger.history(configured.taskId).runs.length,
    0,
    "manual workflow Task has no Run before the Run action",
  );
  assert.equal(
    workflows.snapshot().runs.length,
    0,
    "configuration does not invoke the workflow",
  );
  await app.locator('[data-action="workflow-task-run"]').click();
  await app.locator('[data-action="workflow-cancel"]').waitFor();
  const roots = ledger.history(configured.taskId).runs;
  assert.equal(roots.length, 1, "Run action admits one real root Run");
  assert.ok(roots[0].configuration.workflowInvocation);
  assert.equal(roots[0].route, undefined);
  assert.equal(workflows.snapshot().runs[0].runId, roots[0].runId);
  const close = app.locator('#overlays [data-action="close"]').first();
  await close.click();
  await app.locator('[data-action="project-create-task"]').click();
  await app.locator('[data-plan="title"]').fill("普通 Agent 手动任务");
  await app
    .locator('[data-plan="description"]')
    .fill("Independent agent task without a workflow");
  assert.equal(
    await app.locator('[data-plan="executionKind"]').inputValue(),
    "agent",
  );
  assert.equal(await app.locator('[data-plan="mode"]').inputValue(), "manual");
  await app.locator('[data-action="create-schedule-confirm"]').click();
  await app
    .locator(".drawer h2")
    .getByText("普通 Agent 手动任务", { exact: true })
    .waitFor();
  const ordinary = ledger
    .snapshot()
    .tasks.find((row) => row.title === "普通 Agent 手动任务");
  assert.ok(ordinary);
  assert.equal(ledger.history(ordinary.taskId).runs.length, 0);
  assert.equal(
    workflows
      .snapshot()
      .taskBindings.some((row) => row.taskId === ordinary.taskId),
    false,
  );
  assert.ok(
    rpcCalls.some(
      (row) => row.method === "createProjectTask" && row.input.start === false,
    ),
  );
  assert.deepEqual(errors, []);
  assert.equal(
    h.adapter.requests.length,
    0,
    "manual creation never calls an external model",
  );
  console.log(
    "Real runtime browser acceptance passed: project/stage navigation, saved layout reopening, manual workflow configuration without execution, explicit root Run admission, and ordinary Agent manual task creation.",
  );
} finally {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await h.dispose();
}
