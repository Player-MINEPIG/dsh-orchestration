import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TaskLedger,
  Workbench,
  NATIVE_PROVIDER_UNAVAILABLE_SUMMARY,
} from "../../packages/task-system/dist/index.js";
import { createDashboardServer } from "../server.mjs";
import { managementAdapter } from "../management.mjs";
import { runDetails } from "../public/management-model.js";
async function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-management-api-")),
    file = path.join(dir, "isolated.sqlite");
  let ledger = TaskLedger.open(file),
    workbench = new Workbench(ledger);
  const identity = {
    databaseId: "isolated-api-regression",
    label: "隔离 API 回归库",
    path: file,
  };
  const management = {
    snapshot: () => workbench.snapshot(),
    manage: (...args) => managementAdapter(ledger, workbench).manage(...args),
  };
  const server = createDashboardServer({
    snapshot: () => ledger.snapshot(),
    management,
    databaseIdentity: identity,
    localRole: "manager",
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    base,
    file,
    identity,
    get ledger() {
      return ledger;
    },
    reopen() {
      ledger.close();
      ledger = TaskLedger.open(file);
      workbench = new Workbench(ledger);
    },
    view: async () => {
      const r = await fetch(base + "/api/workbench");
      assert.equal(r.status, 200);
      return r.json();
    },
    post: (body, headers = {}) =>
      fetch(base + "/api/manage", {
        method: "POST",
        headers: {
          Origin: base,
          "X-DSH-Management": "1",
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
  };
}
const command = (operation, data, commandId = crypto.randomUUID()) => ({
  commandId,
  operation,
  data,
});
async function ok(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
test("real isolated SQLite management API creates, edits and links durable hierarchy with exact idempotency", async (t) => {
  const f = await fixture(t);
  const create = command(
    "create_project",
    { title: "Project", goal: "Useful outcome" },
    "stable-project",
  );
  const receipt = await ok(await f.post(create));
  assert.deepEqual(await ok(await f.post(create)), receipt);
  await ok(await f.post(command("create_domain", { title: "Practice" })));
  await ok(
    await f.post(
      command("create_task", {
        title: "Concrete work",
        goal: "Inspect result",
      }),
    ),
  );
  let view = await f.view();
  assert.deepEqual(view.database, f.identity);
  assert.equal(view.permissions.canManage, true);
  assert.equal(view.projects.length, 1);
  const p = view.projects[0],
    d = view.domains[0],
    task = view.tasks[0];
  await ok(
    await f.post(
      command("create_backlog", {
        projectId: p.projectId,
        title: "Demand item",
        priority: "urgent",
        acceptanceCriteria: [
          { description: "Read actual output", kind: "manual_check" },
        ],
      }),
    ),
  );
  view = await f.view();
  const b = view.backlogs[0];
  assert.equal(b.state, "open");
  assert.equal(b.acceptanceCriteria[0].observedStatus, "pending");
  await ok(
    await f.post(
      command("link_domain_project", {
        domainId: d.domainId,
        projectId: p.projectId,
      }),
    ),
  );
  await ok(
    await f.post(
      command("link_backlog_task", {
        backlogId: b.backlogId,
        taskId: task.taskId,
      }),
    ),
  );
  await ok(
    await f.post(
      command("update_task", {
        taskId: task.taskId,
        expectedRevision: task.revision,
        title: "Updated concrete work",
        priorityOverride: "low",
      }),
    ),
  );
  await ok(
    await f.post(
      command("update_project", {
        projectId: p.projectId,
        expectedRevision: p.revision,
        title: "Updated project",
      }),
    ),
  );
  const stale = await f.post(
    command("update_project", {
      projectId: p.projectId,
      expectedRevision: p.revision,
      title: "Stale overwrite",
    }),
  );
  assert.equal(stale.status, 409);
  assert.ok(statSync(f.file).size > 0);
  f.reopen();
  view = await f.view();
  assert.equal(view.projects[0].title, "Updated project");
  assert.equal(view.tasks[0].title, "Updated concrete work");
  assert.equal(view.tasks[0].priority, "low");
  assert.equal(view.domainProjects.length, 1);
  assert.equal(view.backlogTasks.length, 1);
  assert.deepEqual(await ok(await f.post(create)), receipt);
  await ok(
    await f.post(
      command("unlink_backlog_task", {
        backlogId: b.backlogId,
        taskId: task.taskId,
      }),
    ),
  );
  assert.equal((await f.view()).backlogTasks.length, 0);
});
test("trusted server role and same-origin JSON custom header are required, payload cannot elevate authority", async (t) => {
  const viewer = await fixture(t, { localRole: "viewer" });
  assert.equal((await viewer.view()).permissions.canManage, false);
  assert.equal(
    (await viewer.post(command("create_task", { title: "No" }))).status,
    403,
  );
  const f = await fixture(t);
  for (const headers of [
    { Origin: "https://evil.invalid" },
    { Origin: "null" },
    { Origin: "" },
    { "X-DSH-Management": "" },
    { "Sec-Fetch-Site": "cross-site" },
  ])
    assert.equal(
      (await f.post(command("create_task", { title: "No" }), headers)).status,
      403,
    );
  assert.equal(
    (
      await f.post(command("create_task", { title: "No" }), {
        "Content-Type": "text/plain",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await f.post({
        ...command("create_task", { title: "No" }),
        role: "manager",
      })
    ).status,
    400,
  );
  for (const data of [
    { title: "No", policy: { allowedNodeIds: ["evil"] } },
    { title: "No", state: "running" },
    { title: "No", actor: "owner" },
    { title: "No", priority: "urgent" },
  ])
    assert.equal((await f.post(command("create_task", data))).status, 400);
  assert.equal(
    (await f.post(command("queue_run", { taskId: "none" }))).status,
    400,
  );
  assert.equal((await f.view()).tasks.length, 0);
});
test("existing authentication adapters must explicitly grant role and configure a fixed origin", async (t) => {
  assert.throws(
    () =>
      createDashboardServer({
        snapshot: () => ({}),
        management: { snapshot: () => ({}) },
        databaseIdentity: {
          databaseId: "x",
          label: "x",
          path: "/tmp/test.sqlite",
        },
        authorize: () => true,
      }),
    /managementOrigin/,
  );
  const f = await fixture(t, {
    authorize: () => ({ role: "viewer", expiresAt: Date.now() + 60000 }),
    requireSessionExpiry: true,
    managementOrigin: "https://private.test",
  });
  assert.equal(
    (
      await f.post(command("create_task", { title: "No" }), {
        Origin: "https://private.test",
      })
    ).status,
    403,
  );
  const permitted = await fixture(t, {
    authorize: () => ({ role: "manager", expiresAt: Date.now() + 60000 }),
    requireSessionExpiry: true,
    managementOrigin: "https://private.test",
  });
  assert.equal(
    (
      await permitted.post(command("create_task", { title: "Managed" }), {
        Origin: "https://private.test",
      })
    ).status,
    200,
  );
  assert.equal(
    (await permitted.post(command("create_task", { title: "Wrong origin" })))
      .status,
    403,
  );
});
test("HTTP projection reads real persisted failed Run, actual Attempt and report with no legacy result fields", async (t) => {
  const f = await fixture(t),
    l = f.ledger;
  l.registerNode("node", {
    nodeId: "mbp-test",
    roles: ["executor"],
    capabilities: ["text"],
    models: [
      { provider: "fixture", model: "model", reasoningEfforts: ["low"] },
    ],
    workspaceIds: [],
    enabled: true,
    lastSeenAt: new Date().toISOString(),
  });
  const task = l.createTask("task", { title: "Isolated failure" }).value;
  const run = l.createRun("run", {
    taskId: task.taskId,
    route: {
      nodeId: "mbp-test",
      provider: "fixture",
      model: "model",
      requiredCapabilities: ["text"],
    },
  }).value;
  const attempt = l.claim("claim", {
    runId: run.runId,
    nodeId: "mbp-test",
    ttlMs: 60000,
  }).value.attempt;
  const lease = {
    runId: run.runId,
    attemptId: attempt.attemptId,
    nodeId: attempt.nodeId,
    fence: attempt.fence,
  };
  l.bindSession("session", { ...lease, sessionId: "isolated-session" });
  l.submit("failure", {
    ...lease,
    outcome: "failure",
    summary: "Missing test script",
    report: {
      title: "Execution failed",
      body: "File not found: acceptance fixture script",
    },
  });
  f.reopen();
  const view = await f.view();
  assert.equal(view.runs[0].state, "failed");
  assert.equal(view.runs[0].route.nodeId, "mbp-test");
  assert.equal(view.attempts[0].nodeId, "mbp-test");
  assert.equal(view.attempts[0].attemptId, attempt.attemptId);
  assert.deepEqual(view.runs[0].sessionIds, ["isolated-session"]);
  assert.match(view.reports[0].body, /File not found/);
  for (const key of ["outcome", "validation", "observationOnly"])
    assert.equal(key in view.runs[0], false);
  assert.equal("admissionState" in view.tasks[0], false);
});
test("management page and relative modules are served without opening source files", async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.base + "/manage.html");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /management-app.js/);
  for (const name of [
    "management-app.js",
    "management-client.js",
    "management-model.js",
    "management.css",
  ])
    assert.equal((await fetch(f.base + "/" + name)).status, 200);
  assert.equal((await fetch(f.base + "/management.mjs")).status, 404);
  assert.equal(
    (await f.post(command("create_task", { title: "x".repeat(270000) })))
      .status,
    413,
  );
});

test("HTTP preserves exact pre-start blocked evidence with no fabricated report or created-session claim", async (t) => {
  const f = await fixture(t),
    l = f.ledger;
  l.registerNode("pre-node", {
    nodeId: "mbp-preflight",
    roles: ["executor"],
    capabilities: ["text"],
    models: [
      { provider: "missing-native-provider", model: "unavailable-model" },
    ],
    workspaceIds: [],
    enabled: true,
    lastSeenAt: new Date().toISOString(),
  });
  const task = l.createTask("pre-task", { title: "Provider preflight" }).value;
  const run = l.createRun("pre-run", {
    taskId: task.taskId,
    route: {
      nodeId: "mbp-preflight",
      provider: "missing-native-provider",
      model: "unavailable-model",
      requiredCapabilities: ["text"],
    },
  }).value;
  const attempt = l.claim("pre-claim", {
    runId: run.runId,
    nodeId: "mbp-preflight",
    ttlMs: 60000,
  }).value.attempt;
  const lease = {
    runId: run.runId,
    attemptId: attempt.attemptId,
    nodeId: attempt.nodeId,
    fence: attempt.fence,
    executionId: "preflight-execution",
  };
  l.markRunning("pre-start-owner", lease);
  l.bindSession("pre-reserved-session", {
    ...lease,
    sessionId: "reserved-not-created",
  });
  l.submit("pre-settle", {
    ...lease,
    outcome: "blocked",
    summary: NATIVE_PROVIDER_UNAVAILABLE_SUMMARY,
    preDispatchFailure: {
      kind: "native-provider-unavailable-v1",
      code: "NO_ADAPTER",
      provider: "missing-native-provider",
      model: "unavailable-model",
    },
  });
  f.reopen();
  const view = await f.view(),
    persisted = view.runs.find((x) => x.runId === run.runId),
    event = view.events.find(
      (x) => x.runId === run.runId && x.type === "run.pre_dispatch_failed",
    );
  assert.equal(persisted.state, "blocked");
  assert.equal(view.reports.filter((x) => x.runId === run.runId).length, 0);
  assert.ok(event.eventId);
  assert.equal(event.taskId, task.taskId);
  assert.deepEqual(event.detail, {
    summary: NATIVE_PROVIDER_UNAVAILABLE_SUMMARY,
    code: "NO_ADAPTER",
    origin: "native-adapter",
    phase: "before-agent-start",
    provider: "missing-native-provider",
    model: "unavailable-model",
    attemptId: attempt.attemptId,
    nodeId: "mbp-preflight",
  });
  const details = runDetails(view, persisted);
  assert.equal(details.failure, NATIVE_PROVIDER_UNAVAILABLE_SUMMARY);
  assert.equal(details.executionStartMessage, "模型调用与工作尚未开始");
  assert.match(details.sessionLabel, /不代表 native session 已创建/);
  assert.deepEqual(details.sessionIds, ["reserved-not-created"]);
  assert.equal(details.attempts[0].executionId, "preflight-execution");
});
