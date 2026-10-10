import test from "node:test";
import assert from "node:assert/strict";
import {
  recursiveForest,
  recursivePanel,
  executionLabel,
} from "../public/recursive-ui.js";
import { visibleTasks, taskStats } from "../public/model.js";
import { dashboardSnapshot } from "../server.mjs";
const data = () => ({
  schemaVersion: "1",
  source: {
    kind: "task-system",
    label: "fixture",
    observedAt: new Date().toISOString(),
    staleAfterMs: 60000,
  },
  tasks: [
    { taskId: "parent", title: "Parent", state: "running" },
    {
      taskId: "step",
      title: "Small <step>",
      state: "completed",
      parentTaskId: "parent",
      parentRunId: "old",
      delegationDisplay: { mode: "step", reason: "small-execution" },
    },
  ],
  runs: [
    { taskId: "parent", runId: "new", state: "running" },
    { taskId: "parent", runId: "old", state: "failed" },
    {
      taskId: "step",
      runId: "child",
      parentRunId: "old",
      state: "succeeded",
      reviewStatus: "pending_user",
      route: {
        backend: "codex-luna-low",
        nodeId: "mbp",
        model: "gpt-6-luna",
        reasoningEffort: "low",
      },
    },
  ],
  reports: [],
  attempts: [
    {
      attemptId: "a",
      runId: "child",
      taskId: "step",
      executionId: "exec",
      fence: 2,
    },
  ],
  artifacts: [],
  templates: [],
  events: [],
});
test("small steps excluded from primary counts but expand beneath exact historical parent run", () => {
  const d = data();
  assert.equal(visibleTasks(d).length, 1);
  assert.equal(visibleTasks(d, { includeSteps: true }).length, 2);
  assert.equal(taskStats(d).total, 1);
  const forest = recursiveForest(d);
  assert.equal(forest.length, 1);
  assert.equal(
    forest[0].runs.find((r) => r.run.runId === "new").children.length,
    0,
  );
  assert.equal(
    forest[0].runs.find((r) => r.run.runId === "old").children[0].task.taskId,
    "step",
  );
  const html = recursivePanel(d);
  assert.match(html, /执行完成 · 待验收/);
  assert.match(html, /Small &lt;step&gt;/);
  assert.match(html, /fence 2/);
  assert.match(html, /execution exec/);
  assert.doesNotMatch(
    html,
    /<details class="delegation-task" open data-task-id="step"/,
  );
});
test("dashboard preserves provenance and selected official proof, strips arbitrary config/data", () => {
  const d = data();
  d.reports = [
    {
      reportId: "r",
      data: { officialSubagentId: "official-id", secret: "private-key" },
    },
  ];
  d.runs[0].configuration = { secret: "private-key" };
  const projected = dashboardSnapshot(d);
  assert.equal(projected.tasks[1].parentRunId, "old");
  assert.equal(projected.runs[2].parentRunId, "old");
  assert.equal(projected.runs[2].route.backend, "codex-luna-low");
  assert.equal(projected.attempts[0].executionId, "exec");
  assert.equal(projected.reports[0].data.officialSubagentId, "official-id");
  assert.doesNotMatch(JSON.stringify(projected), /private-key/);
});
test("cycles remain visible and review rejection is distinct from execution completion", () => {
  const d = data();
  d.tasks[0].parentTaskId = "step";
  assert.match(recursivePanel(d), /循环父任务关系/);
  assert.equal(
    executionLabel({ state: "succeeded", reviewStatus: "rejected" }),
    "返修中",
  );
  assert.equal(
    executionLabel({ state: "succeeded", reviewStatus: "accepted" }),
    "已验收",
  );
});

test("imported run parent and re-execution attach only the matching run to each parent epoch", () => {
  const d = data();
  delete d.tasks[1].parentRunId;
  d.runs.push({
    taskId: "step",
    runId: "child-rework",
    parentRunId: "new",
    state: "running",
  });
  const forest = recursiveForest(d),
    parent = forest[0];
  assert.deepEqual(
    parent.runs
      .find((r) => r.run.runId === "old")
      .children[0].runs.map((r) => r.run.runId),
    ["child"],
  );
  assert.deepEqual(
    parent.runs
      .find((r) => r.run.runId === "new")
      .children[0].runs.map((r) => r.run.runId),
    ["child-rework"],
  );
  assert.equal(parent.unbound.length, 0);
  d.tasks[1].parentRunId = "old";
  const again = recursiveForest(d)[0];
  assert.equal(
    again.runs.find((r) => r.run.runId === "new").children[0].runs[0].run.runId,
    "child-rework",
  );
});

test("partial delivery and acknowledged cancellation keep their distinct facts", () => {
  assert.equal(
    executionLabel({
      state: "succeeded",
      outcome: "partial",
      reviewStatus: "pending_user",
    }),
    "部分交付 / 已派发 · 待验收",
  );
  const d = data();
  d.runs[0].state = "cancelled";
  d.runs[0].cancellationRequested = true;
  const html = recursivePanel(d);
  assert.match(html, /已确认静止/);
  assert.doesNotMatch(html, /取消请求已发出，等待静止/);
});
