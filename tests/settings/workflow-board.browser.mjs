import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const pageHtml = readFileSync(
  new URL(
    "../../packages/task-system/dist/workflow-page.html",
    import.meta.url,
  ),
  "utf8",
);
assert.ok(
  !pageHtml.includes("/*__WORKFLOW_UI__*/"),
  "built page contains its executable client",
);
const definition = {
  workflowId: "daily",
  revision: 1,
  title: "Agent 日报",
  description: "两台设备的日报",
  steps: [
    {
      stepId: "collect",
      title: "读取本机来源",
      nodeId: "MBP",
      workspaceId: "mbp-work",
      dependsOn: [],
      inputs: { window: { kind: "workflow-input", path: [] } },
      execution: {
        kind: "program",
        programId: "activity.collect",
        version: "1",
      },
      maxRetries: 0,
    },
    {
      stepId: "digest",
      title: "归纳工作",
      nodeId: "VPS",
      workspaceId: "vps-work",
      dependsOn: ["collect"],
      inputs: { sources: { kind: "step-output", stepId: "collect", path: [] } },
      execution: {
        kind: "agent",
        provider: "codex",
        model: "gpt-6-luna",
        instructions: "按工作内容汇总",
        allowedTools: ["task_settle"],
        reasoningEffort: "high",
      },
      maxRetries: 2,
    },
    {
      stepId: "render",
      title: "生成报告",
      nodeId: "VPS",
      workspaceId: "vps-work",
      dependsOn: ["digest"],
      inputs: { digest: { kind: "step-output", stepId: "digest", path: [] } },
      execution: {
        kind: "program",
        programId: "activity.render",
        version: "1",
      },
      maxRetries: 0,
    },
  ],
  schedule: {
    enabled: true,
    cron: "0 7 * * *",
    timeZone: "Asia/Shanghai",
    dayOffset: -1,
  },
};
const fixture = {
  definitions: [definition],
  runs: [],
  nodes: [
    { nodeId: "MBP", state: "online", enabled: true, activeClaims: 0 },
    { nodeId: "VPS", state: "online", enabled: true, activeClaims: 0 },
    { nodeId: "PC_AU", state: "stale", enabled: true, activeClaims: 0 },
  ],
  workspaces: [
    {
      workspaceId: "mbp-work",
      nodeId: "MBP",
      label: "MBP tasks",
      path: "/tmp/mbp",
      state: "ready",
    },
    {
      workspaceId: "vps-work",
      nodeId: "VPS",
      label: "VPS tasks",
      path: "/tmp/vps",
      state: "ready",
    },
    {
      workspaceId: "au-work",
      nodeId: "PC_AU",
      label: "AU tasks",
      path: "/tmp/au",
      state: "ready",
    },
  ],
  programs: [
    {
      nodeId: "MBP",
      programId: "activity.collect",
      version: "1",
      title: "采集来源",
    },
    {
      nodeId: "VPS",
      programId: "activity.render",
      version: "1",
      title: "渲染报告",
    },
  ],
  models: [
    {
      nodeId: "VPS",
      models: [
        {
          provider: "codex",
          model: "gpt-6-luna",
          reasoningEfforts: ["low", "high"],
        },
      ],
    },
  ],
};
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><html><body style="margin:0"><iframe id="app" style="width:100%;height:100vh;border:0"></iframe></body></html>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(
    ({ fixture, pageHtml }) => {
      window.fixture = fixture;
      window.calls = [];
      window.addEventListener("message", (event) => {
        if (event.data?.channel !== "dsh-project-runtime") return;
        const { id, method, input } = event.data;
        window.calls.push({ method, input });
        let value;
        if (method === "workflowSnapshot") value = window.fixture;
        else if (method === "saveWorkflow") {
          value = { ...input.definition, revision: input.expectedRevision + 1 };
          window.fixture.definitions = window.fixture.definitions
            .filter((row) => row.workflowId !== value.workflowId)
            .concat(value);
        } else if (method === "startWorkflow") {
          const definition = structuredClone(
            window.fixture.definitions.find(
              (row) => row.workflowId === input.workflowId,
            ),
          );
          value = {
            workflowRunId: "run1",
            workflowId: definition.workflowId,
            definitionRevision: definition.revision,
            title: definition.title,
            definition,
            input: input.input,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: "running",
            steps: definition.steps.map((step) => ({
              stepId: step.stepId,
              nodeId: step.nodeId,
              title: step.title,
              kind: step.execution.kind,
              state: "pending",
              attemptCount: 0,
            })),
          };
          window.fixture.runs.unshift(value);
        } else if (method === "cancelWorkflow") {
          value = window.fixture.runs[0];
          value.state = "cancelled";
        } else if (method === "retryWorkflowStep") {
          value = window.fixture.runs[0];
          value.steps.find((row) => row.stepId === input.stepId).state =
            "queued";
        } else if (method === "projectSnapshot")
          value = {
            tasks: [
              { id: "task-render", title: "报告生成", status: "accepted" },
            ],
          };
        else throw Error(`Unexpected RPC ${method}`);
        event.source.postMessage(
          { channel: "dsh-project-runtime", id, value },
          "*",
        );
      });
      document.querySelector("#app").srcdoc = pageHtml;
    },
    { fixture, pageHtml },
  );
  const app = page.frameLocator("#app");
  await app.locator("#workflow-heading").getByText("Agent 日报").waitFor();
  assert.equal(await app.locator(".device").count(), 2);
  assert.equal(await app.locator(".route").count(), 1);
  await app.locator('[data-node="VPS"]').click();
  await app.locator('[data-step="digest"]').click();
  await app.locator("#step-instructions").fill("按项目归纳。保留成果和缺口。");
  const editorBefore = await app.locator("#step-instructions").elementHandle();
  await app
    .locator("#step-instructions")
    .evaluate((el) => (el.dataset.probe = "preserve"));
  await page.evaluate(
    () =>
      (window.fixture.nodes.find((row) => row.nodeId === "MBP").state =
        "stale"),
  );
  await app.locator("#refresh").click();
  await app.locator('[data-node="MBP"].offline').waitFor();
  assert.equal(
    await app.locator("#step-instructions").getAttribute("data-probe"),
    "preserve",
    "poll does not remount editor",
  );
  assert.equal(
    await app.locator("#step-instructions").inputValue(),
    "按项目归纳。保留成果和缺口。",
  );
  assert.equal(
    await app.locator('[data-node="VPS"]').getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(await app.locator(".route.waiting").count(), 1);
  await editorBefore.dispose();
  await app.locator("#save-workflow").click();
  await app.locator("#revision").getByText("版本 2", { exact: true }).waitFor();
  const saved = await page.evaluate(() =>
    window.calls.findLast((row) => row.method === "saveWorkflow"),
  );
  assert.equal(saved.input.expectedRevision, 1);
  assert.equal(
    saved.input.definition.steps[1].execution.instructions,
    "按项目归纳。保留成果和缺口。",
  );
  await app.locator("#add-device-select").selectOption("PC_AU");
  await app.locator("#add-device").click();
  await app.locator("#add-step").click();
  await app.locator("#step-title").fill("离线设备测试");
  assert.match(
    await app.locator("#step-program").textContent(),
    /未公布可用程序/,
  );
  await app.locator("#remove-step").click();
  await app.locator("#save-workflow").click();
  await app.locator("#revision").getByText("版本 3", { exact: true }).waitFor();
  await app.locator('[data-node="MBP"]').click();
  await app.locator("#add-step").click();
  await app.locator("#step-title").fill("回传后归档");
  await app
    .locator("#step-program")
    .selectOption(JSON.stringify(["activity.collect", "1"]));
  await app.locator("#add-binding").click();
  await app.locator('[data-binding="name"]').fill("report");
  await app.locator('[data-binding="name"]').blur();
  await app.locator('[data-binding="kind"]').selectOption("step-output");
  await app.locator('[data-binding="stepId"]').selectOption("render");
  await app.locator('[data-binding="path"]').fill("presentation");
  await app.locator('[data-binding="path"]').blur();
  assert.equal(
    await app.locator(".route").count(),
    2,
    "a device may appear again later in a step DAG",
  );
  await app.locator("#save-workflow").click();
  await app.locator("#revision").getByText("版本 4", { exact: true }).waitFor();
  const mapped = await page.evaluate(() =>
    window.calls
      .findLast((row) => row.method === "saveWorkflow")
      .input.definition.steps.at(-1),
  );
  assert.deepEqual(mapped.inputs.report, {
    kind: "step-output",
    stepId: "render",
    path: ["presentation"],
  });
  assert.deepEqual(mapped.dependsOn, ["render"]);
  await app.locator('[data-node="VPS"]').click();
  await app.locator('[data-step="digest"]').click();
  await app.locator('[data-dependency="render"]').check();
  await app.locator("#save-workflow").click();
  await app
    .locator("#error")
    .getByText(/依赖存在循环/)
    .waitFor();
  await app.locator('[data-dependency="render"]').uncheck();
  await app.locator("#save-workflow").click();
  await app.locator("#revision").getByText("版本 5", { exact: true }).waitFor();
  if (process.env.WORKFLOW_DESKTOP_SCREENSHOT)
    await page.screenshot({
      path: process.env.WORKFLOW_DESKTOP_SCREENSHOT,
      fullPage: true,
    });
  await app.locator("#start-workflow").click();
  await app
    .locator("#run-state")
    .getByText("执行中", { exact: true })
    .waitFor();
  await page.evaluate(() => {
    const run = window.fixture.runs[0];
    run.steps[2] = {
      ...run.steps[2],
      state: "failed",
      attemptCount: 1,
      taskId: "task-render",
      summary: '<img src=x onerror="alert(1)">',
      output: {
        presentation: {
          mediaType: "text/html",
          templateVersion: "daily1",
          body: "<!doctype html><html><body><h1>日报成果</h1><script>parent.hacked=true</script></body></html>",
        },
      },
    };
  });
  await app.locator("#refresh").click();
  await app.locator('[data-node="VPS"]').click();
  await app.locator('[data-step="render"]').click();
  await app.locator(".html-preview").waitFor();
  assert.equal(await app.locator(".html-preview").getAttribute("sandbox"), "");
  assert.equal(await app.locator("#step-detail img").count(), 0);
  assert.equal(
    await app.frameLocator(".html-preview").locator("h1").textContent(),
    "日报成果",
  );
  assert.equal(await page.evaluate(() => window.hacked), undefined);
  await app.locator("#show-task").click();
  await app
    .locator("#task-record")
    .getByText(/报告生成/)
    .waitFor();
  await app.locator("#retry-step").click();
  await app.locator("#step-detail .badge.queued").waitFor();
  await app.locator("#cancel-workflow").click();
  await app.locator("#run-state .badge.cancelled").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await app.locator("#edit-definition").click();
  await app.locator('[data-node="VPS"]').click();
  await app.locator('[data-step="digest"]').click();
  await app.locator("#step-instructions").fill("手机编辑未保存");
  await app.locator("#step-tools").scrollIntoViewIfNeeded();
  const position = await app.locator("body").evaluate(() => window.scrollY);
  await app
    .locator("body")
    .evaluate(() => document.querySelector("#refresh").click());
  await page.waitForTimeout(200);
  assert.equal(
    await app.locator("body").evaluate(() => window.scrollY),
    position,
    "refresh preserves mobile scroll",
  );
  assert.equal(
    await app.locator("#step-instructions").inputValue(),
    "手机编辑未保存",
  );
  assert.equal(
    await app
      .locator("body")
      .evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    true,
    "device graph scroll stays within viewport",
  );
  if (process.env.WORKFLOW_SCREENSHOT)
    await page.screenshot({
      path: process.env.WORKFLOW_SCREENSHOT,
      fullPage: true,
    });
  assert.deepEqual(errors, []);
  console.log(
    "Workflow browser acceptance passed. Device routes, offline states, editing, save/start, retry/cancel, sandboxed HTML, history, and mobile refresh verified.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
