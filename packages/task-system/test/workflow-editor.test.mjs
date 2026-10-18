import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function editor(contextOverride = {}) {
  const source = readFileSync(
    new URL("../src/workflow-ui.js", import.meta.url),
    "utf8",
  ).replace(
    "  refresh();\n  setInterval(refresh, 10000);",
    "  window.editor={state,loadedRuns,normalized,derive,checkCalls,changeCall,visibleBoxes,graphTerminals,validate,fit,zoomAt,graph,act,fullRender,refresh};",
  );
  const elements = new Map(),
    listeners = {},
    windowEvents = {},
    requests = [];
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set(),
      events = {};
    const row = {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      disabled: false,
      dataset: {},
      style: {},
      events,
      open: false,
      classList: {
        toggle(name, force) {
          const next = force ?? !classes.has(name);
          next ? classes.add(name) : classes.delete(name);
          return next;
        },
        contains: (name) => classes.has(name),
      },
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 400,
      }),
      addEventListener: (name, fn) => (events[name] = fn),
      setPointerCapture() {},
      releasePointerCapture() {},
      setAttribute(name, value) {
        this[name] = value;
      },
      focus() {},
    };
    elements.set(id, row);
    return row;
  }
  const parent = { postMessage: (request) => requests.push(request) };
  const document = {
    getElementById: element,
    addEventListener: (name, fn) => (listeners[name] = fn),
    querySelector: () => null,
    querySelectorAll: () => [],
    elementFromPoint: () => null,
    documentElement: { dataset: {} },
  };
  const window = {
    __DSH_WORKFLOW_CONTEXT__: { projectId: "p", workflowId: "w", ...contextOverride },
    addEventListener: (name, fn) => (windowEvents[name] = fn),
    scrollTo() {},
  };
  let sequence = 0;
  const context = vm.createContext({
    document,
    window,
    parent,
    console,
    Date,
    Map,
    Set,
    JSON,
    crypto: { randomUUID: () => `id-${++sequence}` },
    confirm: () => true,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval() {},
    requestAnimationFrame: (fn) => fn(),
  });
  vm.runInContext(source, context);
  const api = window.editor;
  const stages = [
    ["a", "vps"],
    ["b", "mbp"],
    ["c", "vps"],
  ].map(([stageId, nodeId], i) => ({
    stageId,
    nodeId,
    title: stageId,
    position: { x: i * 320, y: 10 },
  }));
  const steps = stages.map((stage) => ({
    stepId: stage.stageId,
    title: stage.stageId,
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
    title: "Flow",
    description: "",
    stages,
    steps,
    calls: [],
  };
  api.state.draft = structuredClone(definition);
  api.state.workflowId = "w";
  api.state.stageId = "a";
  api.state.snapshot = {
    definitions: [structuredClone(definition)],
    runs: [],
    nodes: [
      { nodeId: "vps", state: "online" },
      { nodeId: "mbp", state: "stale" },
    ],
    models: [],
    workspaces: [],
    programs: [],
    taskBindings: [],
  };
  return {
    ...api,
    elements,
    element,
    listeners,
    windowEvents,
    requests,
    parent,
    document,
  };
}

test("explicit control calls order separate stages on the same device without adding input bindings", () => {
  const e = editor();
  e.changeCall("a", "b");
  e.changeCall("b", "c");
  assert.deepEqual(Array.from(e.state.draft.steps[2].dependsOn), ["b"]);
  assert.deepEqual(Object.keys(e.state.draft.steps[2].inputs), []);
  assert.equal(e.visibleBoxes().length, 3);
  assert.equal(e.state.draft.stages[0].nodeId, e.state.draft.stages[2].nodeId);
  const html = e.element("device-graph").innerHTML;
  assert.equal((html.match(/data-card=/g) || []).length, 3);
  assert.match(html, /a → b/);
  assert.match(html, /b → c/);
});

test("invalid self, cycle and missing endpoints leave the editable graph unchanged", () => {
  const e = editor();
  e.changeCall("a", "b");
  e.changeCall("b", "c");
  const before = JSON.stringify(e.state.draft);
  for (const pair of [
    ["a", "a"],
    ["c", "a"],
    ["a", "absent"],
  ])
    assert.throws(() => e.changeCall(...pair));
  assert.equal(JSON.stringify(e.state.draft), before);
});

test("removing a call cannot silently orphan a structured output binding", () => {
  const e = editor();
  e.changeCall("a", "b");
  e.state.draft.steps[1].inputs = {
    data: { kind: "step-output", stepId: "a", path: [] },
  };
  assert.throws(() => e.changeCall("a", "b", true), /重新绑定/);
  assert.equal(e.state.draft.calls.length, 1);
  delete e.state.draft.steps[1].inputs.data;
  e.changeCall("a", "b", true);
  assert.equal(e.state.draft.calls.length, 0);
});

test("historical graph stays read only and success is separate from current device availability", () => {
  const e = editor();
  const definition = structuredClone(e.state.draft);
  e.state.snapshot.runs = [
    {
      workflowRunId: "historic",
      workflowId: "w",
      definitionRevision: 1,
      createdAt: "2026-10-01",
      state: "succeeded",
      definition,
      steps: definition.steps.map((step) => ({
        stepId: step.stepId,
        nodeId: step.nodeId,
        state: "succeeded",
      })),
    },
  ];
  e.state.runId = "historic";
  e.state.draft.stages[0].title = "Changed now";
  e.graph();
  const html = e.element("device-graph").innerHTML;
  assert.match(html, /已完成/);
  assert.match(html, /当前设备/);
  assert.match(html, /离线/);
  assert.doesNotMatch(html, /Changed now|data-port=/);
  assert.throws(() => e.changeCall("a", "b"), /只读/);
  assert.equal(e.state.snapshot.runs[0].definition.stages[0].title, "a");
});

test("fit and zoom keep all cards in a fixed viewport without modifying saved coordinates", () => {
  const e = editor(),
    before = JSON.stringify(e.state.draft.stages);
  e.fit();
  const v = e.state.viewport;
  for (const b of e.visibleBoxes()) {
    assert.ok(b.x * v.zoom + v.x >= 0);
    assert.ok((b.x + b.w) * v.zoom + v.x <= 800);
    assert.ok((b.y + b.h) * v.zoom + v.y <= 400);
  }
  const worldX = (400 - v.x) / v.zoom;
  e.zoomAt(1.2, 400, 200);
  assert.ok(
    Math.abs((400 - e.state.viewport.x) / e.state.viewport.zoom - worldX) <
      1e-8,
  );
  assert.equal(JSON.stringify(e.state.draft.stages), before);
  assert.match(e.element("device-graph").style.transform, /translate.*scale/);
});

test("pointer drag persists stage positions in world coordinates and pan changes only viewport", () => {
  const e = editor();
  e.graph();
  e.state.viewport = { x: 10, y: 10, zoom: 0.5 };
  const canvas = e.element("graph-container"),
    card = { dataset: { card: "a" } };
  const event = (x, y, target) => ({
    button: 0,
    clientX: x,
    clientY: y,
    pointerId: 1,
    preventDefault() {},
    target: {
      closest: (selector) => (selector === "[data-card]" ? target : null),
    },
  });
  canvas.events.pointerdown(event(100, 100, card));
  canvas.events.pointermove(event(150, 125, card));
  canvas.events.pointerup(event(150, 125, card));
  assert.equal(e.state.draft.stages[0].position.x, 100);
  assert.equal(e.state.draft.stages[0].position.y, 60);
  assert.equal(e.state.dirty, true);
  const saved = JSON.stringify(e.state.draft.stages);
  canvas.events.pointerdown(event(100, 100, null));
  canvas.events.pointermove(event(130, 140, null));
  canvas.events.pointerup(event(130, 140, null));
  assert.equal(JSON.stringify(e.state.draft.stages), saved);
  assert.equal(e.state.viewport.x, 40);
  assert.equal(e.state.viewport.y, 50);
});

test("internal step graph and fullscreen share the fixed canvas and restore normal mode", async () => {
  const e = editor();
  e.graph();
  await e.act("enter-stage");
  assert.equal(e.visibleBoxes().length, 1);
  assert.match(e.element("device-graph").innerHTML, /data-step="a"/);
  await e.act("fullscreen-graph");
  assert.equal(
    e.element("graph-panel").classList.contains("canvas-fullscreen"),
    true,
  );
  await e.act("fullscreen-graph");
  assert.equal(
    e.element("graph-panel").classList.contains("canvas-fullscreen"),
    false,
  );
  assert.deepEqual(
    e.requests
      .filter((row) => row.method === "detailFullscreen")
      .map((row) => row.input),
    [true, false],
  );
  await e.act("leave-stage");
  assert.equal(e.visibleBoxes().length, 3);
});

test("failed optimistic save keeps the current graph draft and revision for conflict review", async () => {
  const e = editor();
  e.state.draft.title = "Unsaved operator edit";
  e.state.dirty = true;
  const pending = e.act("save-workflow"),
    request = e.requests[0];
  assert.equal(request.method, "saveWorkflow");
  e.windowEvents.message({
    source: e.parent,
    data: {
      channel: "dsh-project-runtime",
      id: request.id,
      error: "记录已变化，请刷新后核对",
    },
  });
  await pending;
  assert.equal(e.state.draft.title, "Unsaved operator edit");
  assert.equal(e.state.draft.revision, 1);
  assert.equal(e.state.dirty, true);
  assert.match(e.element("error").textContent, /记录已变化/);
});


test("Start and End frame repeated device stages and focused internal calls without executable sentinels", () => {
  const e = editor();
  e.changeCall("a", "b"); e.changeCall("b", "c"); e.fit();
  const html = e.element("device-graph").innerHTML;
  assert.match(html, /data-terminal="start"[^>]*>开始/);
  assert.match(html, /data-terminal="end"[^>]*>结束/);
  assert.equal((html.match(/class="stage-step"/g) || []).length, 3);
  assert.equal(e.state.draft.steps.length, 3);
  for (const box of e.graphTerminals()) {
    assert.ok(box.x * e.state.viewport.zoom + e.state.viewport.x >= 0);
    assert.ok((box.x + box.w) * e.state.viewport.zoom + e.state.viewport.x <= 800);
  }
  e.state.focusStage = true; e.graph();
  assert.match(e.element("device-graph").innerHTML, /data-terminal="start"/);
  assert.match(e.element("device-graph").innerHTML, /data-terminal="end"/);
});

test("new abstract steps are editable and saveable without a program, model or workspace", async () => {
  const e = editor();
  e.graph(); await e.act("add-step");
  const step = e.state.draft.steps.at(-1);
  assert.equal(step.execution.kind, "unbound");
  assert.equal(step.workspaceId, undefined);
  assert.doesNotThrow(() => e.validate(e.state.draft));
  const detail = e.element("step-detail").innerHTML;
  assert.match(detail, /待选执行方式/);
  assert.match(detail, /可以保存设计/);
  assert.doesNotMatch(detail, /id="step-workspace"|id="step-model"|id="step-program"/);
  const saving = e.act("save-workflow");
  const request = e.requests[0];
  assert.equal(request.method, "saveWorkflow");
  assert.equal(request.input.definition.steps.at(-1).execution.kind, "unbound");
  e.windowEvents.message({ source: e.parent, data: { channel: "dsh-project-runtime", id: request.id, error: "Stop fixture before refresh" } });
  await saving;
});

test("switching abstract steps to a bound executor restores workspace validation and can return to plan", () => {
  const e = editor();
  e.state.stepId = "a";
  e.listeners.change({ target: { id: "step-kind", value: "unbound", dataset: {} } });
  const step = e.state.draft.steps[0];
  assert.equal(step.execution.kind, "unbound");
  assert.equal(step.workspaceId, undefined);
  assert.doesNotThrow(() => e.validate(e.state.draft));
  e.listeners.change({ target: { id: "step-kind", value: "program", dataset: {} } });
  assert.throws(() => e.validate(e.state.draft), /工作区/);
  e.listeners.change({ target: { id: "step-kind", value: "unbound", dataset: {} } });
  assert.deepEqual(Object.keys(step.execution), ["kind"]);
});

test("starting an abstract plan names its missing bindings and sends no configuration or start request", async () => {
  const e = editor();
  e.state.draft.steps[0].execution = { kind: "unbound" };
  delete e.state.draft.steps[0].workspaceId;
  await e.act("start-workflow");
  assert.match(e.element("error").textContent, /执行前请为这些步骤选择执行方式（Agent 或程序）：a/);
  assert.equal(e.requests.length, 0);
});

test("historical task details use the selected workflow step Run rather than the Task latest", async () => {
  const e = editor();
  e.state.runId = "historical";
  e.state.stepId = "a";
  e.state.snapshot.runs.push({ workflowRunId: "historical", workflowId: "w", definitionRevision: 1, definition: structuredClone(e.state.draft), steps: [{ stepId: "a", taskId: "task-a", runId: "run-original", reportId: "report-original", summary: "Original result", output: { value: "Original output" } }], dispatches: [{ stepId: "a", taskId: "task-a", runId: "run-original", ordinal: 1 }, { stepId: "a", taskId: "task-a", runId: "run-another", ordinal: 2 }] });
  e.loadedRuns.set("historical", e.state.snapshot.runs[0]);
  await e.act("show-task");
  assert.equal(e.requests.length, 0);
  const html = e.element("task-record").innerHTML;
  assert.match(html, /run-original/);
  assert.match(html, /report-original/);
  assert.match(html, /Original output/);
  assert.doesNotMatch(html, /run-another/);
});


function runSummary(e, workflowRunId) {
  return { workflowRunId, workflowId: "w", definitionRevision: 1, definition: structuredClone(e.state.draft), input: {}, dispatches: [], createdAt: "2026-10-18", state: "succeeded", steps: [{ stepId: "a", nodeId: "vps", taskId: "task-a", runId: `${workflowRunId}-step-run`, reportId: `${workflowRunId}-report`, state: "succeeded", summary: "Summary only" }] };
}
function answer(e, request, value, error) {
  e.windowEvents.message({ source: e.parent, data: { channel: "dsh-project-runtime", id: request.id, value, error } });
}

test("default workflow view asks for summaries and requests selected historical details immediately", async () => {
  const e = editor();
  const summary = runSummary(e, "historic");
  e.state.snapshot.runs = [summary];
  const polling = e.refresh();
  const poll = e.requests.at(-1);
  assert.equal(poll.method, "workflowView");
  assert.equal(poll.input.workflowRunId, null);
  answer(e, poll, structuredClone(e.state.snapshot)); await polling;
  const selected = e.listeners.change({ target: { id: "history", value: "historic" } });
  const request = e.requests.at(-1);
  assert.equal(request.method, "workflowView");
  assert.equal(request.input.workflowRunId, "historic");
  assert.match(e.element("step-detail").innerHTML, /正在加载本次执行详情/);
  assert.doesNotMatch(e.element("step-detail").innerHTML, /尚未产生输出/);
  const full = { ...summary, input: { pinned: true }, dispatches: [{ stepId: "a", taskId: "task-a", runId: "historic-step-run" }], steps: [{ ...summary.steps[0], output: { value: "Full historical output" } }] };
  answer(e, request, { ...e.state.snapshot, runs: [full] }); await selected;
  assert.match(e.element("step-detail").innerHTML, /Full historical output/);
  assert.match(e.element("step-detail").innerHTML, /historic-step-run/);
  assert.equal(e.loadedRuns.get("historic").input.pinned, true);
});

test("history switches discard older responses and errors while retaining selected Run IDs and output", async () => {
  const e = editor();
  const first = runSummary(e, "first"), second = runSummary(e, "second");
  e.state.snapshot.runs = [first, second];
  const old = e.listeners.change({ target: { id: "history", value: "first" } });
  const firstRequest = e.requests.at(-1);
  const latest = e.listeners.change({ target: { id: "history", value: "second" } });
  const secondRequest = e.requests.at(-1);
  assert.equal(firstRequest.input.workflowRunId, "first");
  assert.equal(secondRequest.input.workflowRunId, "second");
  const full = { ...second, steps: [{ ...second.steps[0], output: { value: "Second precise output" } }] };
  answer(e, secondRequest, { ...e.state.snapshot, runs: [first, full] }); await latest;
  answer(e, firstRequest, undefined, "Old connection failed"); await old;
  assert.equal(e.state.runId, "second");
  assert.match(e.element("step-detail").innerHTML, /Second precise output/);
  assert.doesNotMatch(e.element("error").textContent, /Old connection failed/);
  const slow = e.refresh(); const slowRequest = e.requests.at(-1);
  const switched = e.listeners.change({ target: { id: "history", value: "first" } }); const switchedRequest = e.requests.at(-1);
  const selectedFirst = { ...first, steps: [{ ...first.steps[0], output: { value: "First precise output" } }] };
  answer(e, switchedRequest, { ...e.state.snapshot, runs: [selectedFirst, second] }); await switched;
  answer(e, slowRequest, { ...e.state.snapshot, runs: [first, full] }); await slow;
  assert.equal(e.state.runId, "first");
  assert.match(e.element("step-detail").innerHTML, /First precise output/);
  assert.equal(e.state.snapshot.runs[0].steps[0].output.value, "First precise output");
});

test("a failed detail refresh preserves the last exact output and can be retried", async () => {
  const e = editor(); const summary = runSummary(e, "historic");
  e.state.snapshot.runs = [summary];
  const selected = e.listeners.change({ target: { id: "history", value: "historic" } });
  const full = { ...summary, steps: [{ ...summary.steps[0], output: { value: "Known precise result" } }] };
  answer(e, e.requests.at(-1), { ...e.state.snapshot, runs: [full] }); await selected;
  const before = e.state.snapshot;
  const failing = e.refresh(); answer(e, e.requests.at(-1), undefined, "Connection unavailable"); await failing;
  assert.equal(e.state.snapshot, before);
  assert.match(e.element("step-detail").innerHTML, /Known precise result/);
  assert.match(e.element("connection").textContent, /可重试/);
  const retry = e.refresh({ force: true });
  const updated = { ...full, steps: [{ ...full.steps[0], output: { value: "Refreshed precise result" } }] };
  answer(e, e.requests.at(-1), { ...e.state.snapshot, runs: [updated] }); await retry;
  assert.match(e.element("step-detail").innerHTML, /Refreshed precise result/);
  assert.equal(e.element("error").textContent, "");
});

test("a deep link requests its exact Run on first load and then permits returning to the plan", async () => {
  const e = editor({ runId: "root-alias" });
  const summary = runSummary(e, "historic");
  const snapshot = { ...e.state.snapshot, runs: [{ ...summary, runId: "root-alias", steps: [{ ...summary.steps[0], output: { pinned: true } }] }] };
  e.state.draft = null; e.state.snapshot = null; e.state.workflowId = "";
  const initial = e.refresh();
  assert.equal(e.requests.at(-1).input.workflowRunId, "root-alias");
  answer(e, e.requests.at(-1), snapshot); await initial;
  assert.equal(e.state.runId, "historic");
  assert.equal(e.loadedRuns.get("historic").steps[0].output.pinned, true);
  const currentPlan = e.listeners.change({ target: { id: "history", value: "" } });
  assert.equal(e.requests.at(-1).input.workflowRunId, null);
  answer(e, e.requests.at(-1), { ...snapshot, runs: [summary] }); await currentPlan;
  assert.equal(e.state.runId, "");
});


test("switching between pending Runs with identical step state replaces the loading message", async () => {
  const e = editor();
  const first = runSummary(e, "first"), second = runSummary(e, "second");
  for (const run of [first, second]) run.steps = [{ stepId: "a", nodeId: "vps", state: "pending", attemptCount: 0 }];
  e.state.snapshot.runs = [first, second];
  const one = e.listeners.change({ target: { id: "history", value: "first" } });
  answer(e, e.requests.at(-1), structuredClone(e.state.snapshot)); await one;
  const two = e.listeners.change({ target: { id: "history", value: "second" } });
  assert.match(e.element("step-detail").innerHTML, /正在加载本次执行详情/);
  answer(e, e.requests.at(-1), structuredClone(e.state.snapshot)); await two;
  assert.doesNotMatch(e.element("step-detail").innerHTML, /正在加载本次执行详情/);
  assert.match(e.element("step-detail").innerHTML, /尚未产生输出/);
});

test("opening a historical task report sends the selected workflow, step, task, Run and report IDs", async () => {
  const e = editor(); const full = runSummary(e, "historic");
  full.steps[0].output = { value: "Precise report" };
  e.loadedRuns.set("historic", full); e.state.snapshot.runs = [full];
  e.state.runId = "historic"; e.state.stepId = "a"; e.fullRender();
  assert.match(e.element("step-detail").innerHTML, /id="open-task-execution"/);
  const opening = e.act("open-task-execution");
  const request = e.requests.at(-1);
  assert.equal(request.method, "closeWorkflow");
  assert.deepEqual(JSON.parse(JSON.stringify(request.input)), { projectId: "p", workflowId: "w", workflowRunId: "historic", taskId: "task-a", runId: "historic-step-run", reportId: "historic-report", stepId: "a" });
  answer(e, request, {}); await opening;
});

test("an execution report deep link restores the exact step and its stage in the pinned definition", async () => {
  const e = editor({ runId: "historic", stepId: "b", stageId: "a" });
  const full = runSummary(e, "historic");
  full.steps = [{ stepId: "b", nodeId: "mbp", taskId: "task-b", runId: "run-b", reportId: "report-b", state: "succeeded", output: { value: "Selected B report" } }];
  const snapshot = { ...e.state.snapshot, runs: [full] };
  e.state.draft = null; e.state.snapshot = null; e.state.workflowId = "";
  const initial = e.refresh(); answer(e, e.requests.at(-1), snapshot); await initial;
  assert.equal(e.state.stageId, "b");
  assert.equal(e.state.stepId, "b");
  assert.equal(e.state.focusStage, true);
  assert.match(e.element("step-detail").innerHTML, /Selected B report/);
  assert.match(e.element("step-detail").innerHTML, /run-b/);
});


test("a missing deep-linked historical Run reports an error and never falls back to the current plan", async () => {
  const e = editor({ runId: "missing-history" });
  const snapshot = structuredClone(e.state.snapshot);
  e.state.draft = null; e.state.snapshot = null; e.state.workflowId = "";
  const initial = e.refresh();
  answer(e, e.requests.at(-1), snapshot); await initial;
  assert.match(e.element("error").textContent, /所选历史执行不存在或不可读取/);
  assert.equal(e.state.draft, null);
  assert.equal(e.state.snapshot, null);
  assert.equal(e.state.workflowId, "");
  assert.equal(e.loadedRuns.size, 0);
});
