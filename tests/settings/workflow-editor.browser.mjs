import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright",
);
const source = readFileSync(
  new URL("../../packages/task-system/src/workflow-ui.js", import.meta.url),
  "utf8",
);
const html = readFileSync(
  new URL("../../packages/task-system/src/workflow-page.html", import.meta.url),
  "utf8",
)
  .replace("/*__WORKFLOW_UI__*/", () => source)
  .replace(
    "<head>",
    '<head><script>window.__DSH_WORKFLOW_CONTEXT__={projectId:"p",workflowId:"w"};</script>',
  );
const stages = [
  ["a", "VPS"],
  ["b", "MBP"],
  ["c", "VPS"],
].map(([stageId, nodeId], i) => ({
  stageId,
  nodeId,
  title: `阶段 ${stageId}`,
  position: { x: i * 330, y: 10 },
}));
const steps = stages.map((stage) => ({
  stepId: stage.stageId,
  title: `步骤 ${stage.stageId}`,
  stageId: stage.stageId,
  nodeId: stage.nodeId,
  position: { x: 0, y: 0 },
  workspaceId: `${stage.nodeId}-ws`,
  dependsOn: [],
  inputs: {},
  execution: { kind: "program", programId: "work", version: "1" },
  maxRetries: 0,
}));
const definition = {
  workflowId: "w",
  projectId: "p",
  revision: 1,
  title: "Agent 日报",
  description: "调用顺序",
  stages,
  steps,
  calls: [],
};
const fixture = {
  definitions: [definition],
  runs: [],
  taskBindings: [],
  nodes: [
    { nodeId: "VPS", state: "online" },
    { nodeId: "MBP", state: "stale" },
  ],
  programs: ["VPS", "MBP"].map((nodeId) => ({
    nodeId,
    programId: "work",
    version: "1",
    title: "工作",
  })),
  workspaces: ["VPS", "MBP"].map((nodeId) => ({
    nodeId,
    workspaceId: `${nodeId}-ws`,
    label: nodeId,
    path: "/tmp",
    state: "ready",
  })),
  models: [],
};
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<html><body style="margin:0"><iframe id="app" style="width:100%;height:100dvh;border:0"></iframe></body></html>',
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
      viewport: { width: 1440, height: 1050 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(
    ({ fixture, html }) => {
      window.fixture = fixture;
      window.calls = [];
      window.addEventListener("message", (event) => {
        if (
          event.data?.channel !== "dsh-project-runtime" ||
          event.data.method === "detailFullscreen"
        )
          return;
        const { id, method, input } = event.data;
        window.calls.push({ method, input });
        let value;
        if (method === "workflowSnapshot") value = window.fixture;
        else if (method === "saveWorkflow") {
          value = { ...input.definition, revision: input.expectedRevision + 1 };
          window.fixture.definitions = [value];
        } else throw Error(`Unexpected ${method}`);
        event.source.postMessage(
          { channel: "dsh-project-runtime", id, value },
          "*",
        );
      });
      document.querySelector("#app").srcdoc = html;
    },
    { fixture, html },
  );
  const app = page.frameLocator("#app");
  await app.locator("#workflow-heading").getByText("Agent 日报").waitFor();
  assert.equal(await app.locator("[data-card]").count(), 3);
  const canvas = app.locator("#graph-container");
  const before = await canvas.boundingBox();
  const card = app.locator('[data-card="a"] .card-main'),
    start = await card.boundingBox();
  await page.mouse.move(start.x + 80, start.y + 30);
  await page.mouse.down();
  await page.mouse.move(start.x + 140, start.y + 65, { steps: 8 });
  await page.mouse.up();
  await app.locator("#connection-form summary").click();
  await app.locator("#call-from").selectOption("a");
  await app.locator("#call-to").selectOption("b");
  await app.locator("#add-call").click();
  await app.locator("#call-from").selectOption("b");
  await app.locator("#call-to").selectOption("c");
  await app.locator("#add-call").click();
  assert.equal(await app.locator(".route").count(), 2);
  await app.locator("#save-workflow").click();
  await app.locator("#revision").getByText("版本 2").waitFor();
  const saved = await page.evaluate(() => window.fixture.definitions[0]);
  assert.notEqual(saved.stages[0].position.x, 0);
  assert.equal(saved.calls.length, 2);
  assert.deepEqual(saved.steps[2].dependsOn, ["b"]);
  await app.locator('[data-card="c"] .port.out').scrollIntoViewIfNeeded();
  const exit = await app.locator('[data-card="c"] .port.out').boundingBox();
  const entry = await app.locator('[data-card="a"] .port.in').boundingBox();
  await page.mouse.move(exit.x + exit.width / 2, exit.y + exit.height / 2);
  await page.mouse.down();
  await page.mouse.move(entry.x + entry.width / 2, entry.y + entry.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  assert.equal(await app.locator("#call-from").inputValue(), "c");
  assert.equal(await app.locator("#call-to").inputValue(), "a");
  await app.locator("#add-call").click();
  assert.match(await app.locator("#notice").innerText(), /循环/);
  assert.equal(await app.locator(".route").count(), 2);
  await app.locator("#fit-graph").click();
  assert.equal((await canvas.boundingBox()).height, before.height);
  await app.locator("#fullscreen-graph").click();
  assert.ok((await canvas.boundingBox()).height > before.height);
  await app.locator("#fullscreen-graph").click();
  assert.equal((await canvas.boundingBox()).height, before.height);
  await app.locator('[data-stage="b"]').click();
  await app.locator("#enter-stage").click();
  assert.equal(await app.locator("[data-card]").count(), 1);
  await app.locator("#leave-stage").click();
  assert.equal(await app.locator("[data-card]").count(), 3);
  await page.evaluate(() => {
    const d = structuredClone(window.fixture.definitions[0]);
    window.fixture.runs = [
      {
        workflowRunId: "old",
        workflowId: "w",
        definitionRevision: 2,
        definition: d,
        input: {},
        createdAt: "2026-10-01T00:00:00Z",
        state: "succeeded",
        steps: d.steps.map((s) => ({
          stepId: s.stepId,
          nodeId: s.nodeId,
          state: "succeeded",
          attemptCount: 1,
          output: { ok: true },
        })),
      },
    ];
  });
  await app.locator("#refresh").click();
  await app.locator("#history").selectOption("old");
  assert.equal(await app.locator(".port").count(), 0);
  assert.ok(await app.locator(".graph-card .succeeded").count());
  assert.match(
    await app.locator('[data-card="b"]').innerText(),
    /当前设备.*离线/s,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await app.locator("#fit-graph").click();
  const mobile = await canvas.boundingBox();
  assert.ok(mobile.width < 390);
  assert.ok(mobile.height >= 340);
  assert.equal(await app.locator("#fullscreen-graph").isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(
    "Workflow editor browser acceptance passed: saved stage drag/calls, repeated devices, internal graph, fixed fit/fullscreen, frozen history, separate availability and mobile controls.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
