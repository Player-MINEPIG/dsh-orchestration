import test from "node:test";
import assert from "node:assert/strict";
import {
  taskPriority,
  projectTasks,
  runDetails,
  parseManagementRoute,
  commandFromForm,
  validateManagementSnapshot,
} from "../public/management-model.js";
import { managementSnapshot } from "../management.mjs";
const base = () => ({
  schemaVersion: "1",
  generatedAt: "2026-10-04T12:00:00Z",
  source: { staleAfterMs: 60000 },
  tasks: [],
  runs: [],
  attempts: [],
  reports: [],
  artifacts: [],
  events: [],
});
const organization = () => ({
  domains: [],
  projects: [],
  backlogs: [],
  domainProjects: [],
  backlogTasks: [],
  projectWorkspaces: [],
  artifactRelations: [],
});
test("management omits obsolete fields, derives sessions and retains actual attempt identity", () => {
  const data = base();
  data.tasks = [
    {
      taskId: "t",
      admissionState: "dismissed",
      admissionRevision: 8,
      priority: "normal",
    },
  ];
  data.runs = [
    {
      runId: "r",
      taskId: "t",
      state: "partial",
      route: { nodeId: "planned" },
      outcome: "partial",
      validation: "valid",
      sessionIds: ["s", "inherited-context"],
      configuration: { apiKey: "secret" },
      historyOnly: true,
    },
  ];
  data.attempts = [
    {
      attemptId: "a",
      runId: "r",
      taskId: "t",
      nodeId: "actual",
      sessionId: "s",
      executionId: "x",
      fence: 2,
    },
  ];
  data.reports = [{ reportId: "q", runId: "r", taskId: "t", sessionId: "s" }];
  const view = managementSnapshot(data, organization(), {
    databaseId: "isolated",
    label: "隔离验收",
    path: "/tmp/isolated.sqlite",
  });
  assert.deepEqual(view.runs[0].sessionIds, ["s", "inherited-context"]);
  assert.equal(view.runs[0].state, "partial");
  assert.equal(view.attempts[0].executionId, "x");
  assert.doesNotMatch(
    JSON.stringify(view),
    /admission|outcome|validation|secret|not-authoritative/,
  );
  assert.equal(validateManagementSnapshot(view), view);
});
test("priority uses explicit override, otherwise maximum linked backlog, otherwise normal", () => {
  const data = {
    backlogs: [
      { backlogId: "b", priority: "urgent" },
      { backlogId: "c", priority: "low" },
    ],
    backlogTasks: [
      { taskId: "t", backlogId: "b" },
      { taskId: "t", backlogId: "c" },
      { taskId: "low", backlogId: "c" },
    ],
  };
  assert.equal(
    taskPriority({ taskId: "t", priorityOverride: "low" }, data).value,
    "low",
  );
  assert.equal(taskPriority({ taskId: "t" }, data).value, "urgent");
  assert.equal(taskPriority({ taskId: "low" }, data).value, "low");
  assert.equal(taskPriority({ taskId: "none" }, data).value, "normal");
});
test("many to many project tasks are deduplicated, including shared tasks across projects", () => {
  const data = {
    tasks: [{ taskId: "t" }, { taskId: "u" }],
    backlogs: [
      { backlogId: "a", projectId: "p" },
      { backlogId: "b", projectId: "p" },
      { backlogId: "c", projectId: "q" },
    ],
    backlogTasks: [
      { backlogId: "a", taskId: "t" },
      { backlogId: "b", taskId: "t" },
      { backlogId: "c", taskId: "t" },
    ],
  };
  assert.deepEqual(projectTasks(data, "p"), [{ taskId: "t" }]);
  assert.deepEqual(projectTasks(data, "q"), [{ taskId: "t" }]);
});
test("route cannot masquerade as actual ownership; failures use recorded results and events", () => {
  const data = { attempts: [], reports: [], events: [] };
  const run = {
    runId: "r",
    state: "failed",
    route: { nodeId: "planned" },
    sessionIds: [],
  };
  let detail = runDetails(data, run);
  assert.deepEqual(detail.actualNodes, []);
  assert.deepEqual(detail.sessionIds, []);
  assert.match(detail.failure, /尚无明确/);
  data.events.push({ runId: "r", detail: { reason: "Script not found" } });
  assert.equal(runDetails(data, run).failure, "Script not found");
  data.attempts.push({ runId: "r", nodeId: "actual", sessionId: "s" });
  data.reports.push({
    runId: "r",
    kind: "result",
    body: "Missing script: real failure",
    sessionId: "s",
  });
  detail = runDetails(data, run);
  assert.equal(detail.plannedNode, "planned");
  assert.deepEqual(detail.actualNodes, ["actual"]);
  assert.equal(detail.failure, "Missing script: real failure");
});
test("content form produces revision-checked commands and never derived priority or authority", () => {
  const next = commandFromForm(
    "task",
    {
      title: " New ",
      goal: "Goal",
      priorityOverride: "",
      state: "",
      acceptanceCriteria: "[]",
      policy: "ignore",
    },
    { taskId: "t", revision: 3 },
  );
  assert.deepEqual(next, {
    operation: "update_task",
    data: {
      title: "New",
      goal: "Goal",
      description: "",
      acceptanceCriteria: [],
      priorityOverride: null,
      taskId: "t",
      expectedRevision: 3,
    },
  });
  assert.throws(
    () => commandFromForm("backlog", { title: "T", acceptanceCriteria: "bad" }),
    /JSON/,
  );
  assert.throws(() => commandFromForm("task", { title: " " }), /名称/);
});
test("management routes safely decode stable IDs and reject malformed fragments", () => {
  assert.deepEqual(parseManagementRoute("#task/legacy%3Atask"), {
    view: "task",
    id: "legacy:task",
  });
  assert.deepEqual(parseManagementRoute("#task/%broken"), { view: "projects" });
});
test("registered artifacts keep version references and process relationships", () => {
  const work = organization();
  work.artifacts = [
    {
      artifactId: "a",
      contentRef: {
        kind: "native",
        provider: "docs",
        fileId: "f",
        version: "v1",
      },
      availability: "unknown",
      versionStatus: "pinned",
    },
  ];
  work.artifactRelations = [
    {
      relationId: "r",
      artifactId: "a",
      kind: "task",
      targetId: "t",
      action: "modified",
      context: "Retain background",
    },
  ];
  const view = managementSnapshot(base(), work, {
    databaseId: "id",
    label: "Test",
    path: "/tmp/test.sqlite",
  });
  assert.equal(view.artifacts[0].contentRef.version, "v1");
  assert.equal(view.artifactRelations[0].targetId, "t");
});

test("exact native pre-start failure uses authoritative event without claiming an agent report or native session", () => {
  const run = {
    runId: "r",
    taskId: "t",
    state: "blocked",
    currentAttemptId: "a",
    route: { nodeId: "mbp", provider: "missing-provider", model: "model" },
    sessionIds: ["reserved-session"],
  };
  const data = {
    attempts: [
      {
        attemptId: "a",
        runId: "r",
        taskId: "t",
        nodeId: "mbp",
        sessionId: "reserved-session",
        fence: 1,
      },
    ],
    reports: [],
    events: [
      {
        eventId: "settled",
        runId: "r",
        taskId: "t",
        type: "run.settled",
        at: "2026-10-04T20:00:02Z",
        detail: { summary: "Ordinary settlement" },
      },
      {
        eventId: "pre",
        runId: "r",
        taskId: "t",
        type: "run.pre_dispatch_failed",
        at: "2026-10-04T20:00:01Z",
        detail: {
          origin: "native-adapter",
          phase: "before-agent-start",
          code: "NO_ADAPTER",
          provider: "missing-provider",
          model: "model",
          attemptId: "a",
          nodeId: "mbp",
          summary: "Provider adapter is not installed",
        },
      },
    ],
  };
  const details = runDetails(data, run);
  assert.equal(details.executionStartMessage, "模型调用与工作尚未开始");
  assert.equal(details.failure, "Provider adapter is not installed");
  assert.equal(details.preDispatchFailure.eventId, "pre");
  assert.match(details.sessionLabel, /预留.*不代表 native session 已创建/);
  assert.deepEqual(details.actualNodes, ["mbp"]);
  assert.deepEqual(details.sessionIds, ["reserved-session"]);
  assert.deepEqual(details.reports, []);
  for (const patch of [
    { code: "MISSING_CREDENTIAL" },
    { phase: "after-agent-start" },
    { origin: "claimed-actor" },
    { attemptId: "different" },
    { nodeId: "other" },
    { provider: "other" },
  ]) {
    const altered = structuredClone(data);
    Object.assign(altered.events[1].detail, patch);
    assert.equal(runDetails(altered, run).executionStartMessage, null);
  }
  assert.equal(
    runDetails(data, { ...run, state: "uncertain" }).executionStartMessage,
    null,
  );
  const wrongTask = structuredClone(data);
  wrongTask.events[1].taskId = "other-task";
  assert.equal(runDetails(wrongTask, run).executionStartMessage, null);
});

test("pre-dispatch projection exposes only the bounded diagnostic fields", () => {
  const execution = base();
  execution.events = [
    {
      eventId: "e",
      taskId: "t",
      runId: "r",
      type: "run.pre_dispatch_failed",
      detail: {
        origin: "native-adapter",
        phase: "before-agent-start",
        code: "NO_ADAPTER",
        provider: "missing",
        model: "model",
        attemptId: "a",
        nodeId: "mbp",
        summary: "No adapter",
        configuration: { apiKey: "never" },
        token: "never",
        rawError: "never",
      },
    },
  ];
  const view = managementSnapshot(execution, organization(), {
    databaseId: "isolated",
    label: "隔离库",
    path: "/tmp/isolated.sqlite",
  });
  assert.deepEqual(view.events[0].detail, {
    summary: "No adapter",
    code: "NO_ADAPTER",
    origin: "native-adapter",
    phase: "before-agent-start",
    provider: "missing",
    model: "model",
    attemptId: "a",
    nodeId: "mbp",
  });
  assert.doesNotMatch(JSON.stringify(view), /never/);
});
