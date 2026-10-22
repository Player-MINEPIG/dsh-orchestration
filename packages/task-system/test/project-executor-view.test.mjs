import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createNativeHarness } from "../../../tests/dsh/native-harness.mjs";
import { Workbench } from "../dist/workbench.js";
import { TaskPluginSettings } from "../dist/settings.js";
import {
  RemoteClient,
  RemoteLedgerClient,
  RemoteGateway,
  RecoveryStore,
  IdentityVerifier,
} from "../dist/remote/api.js";
import { fixture as registrationPacket } from "./fixtures/registration.mjs";

async function setup(t) {
  const central = await createNativeHarness({
    config: { role: "both", nodeId: "central" },
  });
  const executor = await createNativeHarness({
    config: { role: "executor", nodeId: "mbp" },
  });
  const ledger = central.ledger;
  let n = 0;
  const key = () => `view-${++n}`;
  for (const nodeId of ["central", "mbp", "other"]) {
    ledger.registerWorkspace(key(), {
      workspaceId: nodeId + "-ws",
      nodeId,
      path: join(central.dir, nodeId),
      label: nodeId,
      state: "ready",
      createdAt: new Date().toISOString(),
    });
    ledger.registerNode(key(), {
      nodeId,
      roles: ["executor"],
      enabled: true,
      workspaceIds: [nodeId + "-ws"],
      capabilities: [],
      models: [
        { provider: "test-offline", model: "script", reasoningEfforts: [] },
      ],
      lastSeenAt: new Date().toISOString(),
    });
  }
  const route = (nodeId) => ({
    nodeId,
    provider: "test-offline",
    model: "script",
    requiredCapabilities: [],
    workspaceId: nodeId + "-ws",
  });
  const task = ledger.createTask(key(), {
    title: "Ancestor context",
    policy: {
      allowedNodeIds: ["central", "mbp", "other"],
      maxDepth: 8,
      maxChildren: 20,
      maxDescendants: 100,
    },
  }).value;
  const run = ledger.createRun(key(), {
    taskId: task.taskId,
    route: route("central"),
  }).value;
  const lease = (run) => {
    const claim = ledger.claim(key(), {
      runId: run.runId,
      nodeId: run.route.nodeId,
      ttlMs: 60000,
    }).value;
    const ref = {
      runId: run.runId,
      nodeId: run.route.nodeId,
      attemptId: claim.attempt.attemptId,
      fence: claim.attempt.fence,
      executionId: key(),
    };
    ledger.markRunning(key(), ref);
    return ref;
  };
  const parent = lease(run);
  const own = ledger.delegateTask(key(), {
    ...parent,
    title: "Own branch",
    route: route("mbp"),
  }).value;
  const sibling = ledger.delegateTask(key(), {
    ...parent,
    title: "Other sibling PRIVATE",
    route: route("other"),
  }).value;
  const grandchild = ledger.delegateTask(key(), {
    ...lease(own.run),
    title: "Own recursive child on other host",
    route: route("other"),
    display: { requested: "step" },
  }).value;
  const unrelated = ledger.createTask(key(), {
    title: "Unrelated PRIVATE",
    workspaceId: "other-ws",
  }).value;
  ledger.createRun(key(), { taskId: unrelated.taskId, route: route("other") });
  const wb = new Workbench(ledger);
  wb.manage(key(), "create_project", {
    projectId: "shared-project",
    title: "Shared project",
    goal: "Observe own branch",
    state: "active",
  });
  wb.manage(key(), "create_backlog", {
    backlogId: "parent-backlog",
    projectId: "shared-project",
    title: "Parent work",
  });
  wb.manage(key(), "link_backlog_task", {
    backlogId: "parent-backlog",
    taskId: task.taskId,
  });
  wb.manage(key(), "link_project_workspace", {
    projectId: "shared-project",
    workspaceId: "mbp-ws",
    isDefault: true,
  });
  wb.manage(key(), "create_project", {
    projectId: "foreign-project",
    title: "Foreign PRIVATE",
    goal: "Other host only",
    state: "active",
  });
  wb.manage(key(), "create_backlog", {
    backlogId: "foreign-backlog",
    projectId: "foreign-project",
    title: "Foreign work",
  });
  wb.manage(key(), "link_backlog_task", {
    backlogId: "foreign-backlog",
    taskId: unrelated.taskId,
  });
  wb.manage(key(), "link_project_workspace", {
    projectId: "foreign-project",
    workspaceId: "other-ws",
    isDefault: true,
  });
  const stores = ["server", "client"].map(
    (name) => new RecoveryStore(join(central.dir, name + ".sqlite")),
  );
  const keys = generateKeyPairSync("ed25519");
  const gateway = new RemoteGateway({
    role: "planner",
    nodeId: "central",
    store: stores[0],
    ledger,
    verifier: new IdentityVerifier({
      audience: "central",
      peers: [
        {
          keyId: "view-key",
          nodeId: "mbp",
          publicKey: keys.publicKey,
          audience: "central",
          operations: ["projectSnapshot"],
          workspaces: ["mbp-ws"],
          capabilities: [],
        },
      ],
    }),
  });
  const client = new RemoteClient({
    endpoint: "https://project-view-fixture.invalid/commands",
    nodeId: "mbp",
    keyId: "view-key",
    audience: "central",
    privateKey: keys.privateKey,
    store: stores[1],
    fetch: async (_url, options) =>
      new Response(JSON.stringify(await gateway.handle(options.body))),
  });
  executor.ctx.provide("remoteExecution", {
    coordinatorLedger: new RemoteLedgerClient(client, "mbp"),
    coordinatorPanelUrl: () => "https://central.example/tasks",
  });
  // Actual method implementation with actual execution host Context; Typert UI transport is immaterial to scoped data.
  const settings = Object.assign(Object.create(TaskPluginSettings.prototype), {
    ctx: executor.ctx,
  });
  t.after(async () => {
    await gateway.dispose();
    for (const store of stores) store.close();
    await executor.dispose();
    await central.dispose();
  });
  return {
    central,
    executor,
    ledger,
    settings,
    key,
    parentTask: task,
    parentRun: run,
    own,
    sibling,
    grandchild,
    unrelated,
  };
}

test("remote protocol projection retains its recursive branch and ancestor context without same-project sibling leakage", async (t) => {
  const f = await setup(t);
  const before = f.ledger.snapshot();
  const snapshot = await f.executor.ctx.remoteExecution.coordinatorLedger.projectSnapshot();
  assert.deepEqual(
    new Set(snapshot.tasks.map((x) => x.id)),
    new Set([f.parentTask.taskId, f.own.task.taskId, f.grandchild.task.taskId]),
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /Other sibling PRIVATE|Unrelated PRIVATE|Foreign PRIVATE/,
  );
  const child = snapshot.tasks.find((x) => x.id === f.own.task.taskId);
  assert.equal(child.project, "shared-project");
  assert.equal(child.parentTaskId, f.parentTask.taskId);
  assert.equal(child.parentRunId, f.parentRun.runId);
  assert.equal(
    snapshot.tasks.find((x) => x.id === f.grandchild.task.taskId)
      .delegationDisplay,
    "step",
  );
  assert.equal(
    snapshot.runs.find((x) => x.id === f.grandchild.run.runId).parentRunId,
    f.own.run.runId,
  );
  assert.deepEqual(snapshot.viewContext, {
    role: "executor",
    scope: "node",
    nodeId: "mbp",
    observedAt: snapshot.sampledAt,
  });
  assert.deepEqual(snapshot.settings, { enabled: false });
  for (const row of snapshot.tasks)
    for (const [name, value] of Object.entries(row))
      if (/^can[A-Z]/.test(name)) assert.equal(value, false, name);
  assert.ok(
    snapshot.projects.every((p) => p.canChat === false && p.sessionId === null),
  );
  assert.deepEqual(
    f.ledger.snapshot().attempts,
    before.attempts,
    "read never starts or alters execution",
  );
});

test("remote protocol projection includes its registered source project as observation only and forbids planner mutation", async (t) => {
  const f = await setup(t);
  for (const nodeId of ["mbp", "other"]) {
    const p = registrationPacket();
    p.projectExternalId = nodeId;
    p.origin.nodeId = nodeId;
    p.project.title = "Imported " + nodeId;
    p.tasks[0].title = "Imported task " + nodeId;
    f.ledger.registerProject(f.key(), p, [p.namespace]);
  }
  const before = f.ledger.snapshot();
  const snapshot = await f.executor.ctx.remoteExecution.coordinatorLedger.projectSnapshot();
  const imported = snapshot.tasks.find((x) => x.title === "Imported task mbp");
  assert.ok(imported);
  assert.equal(imported.observationOnly, true);
  assert.ok(
    snapshot.runs
      .filter((r) => r.taskId === imported.id)
      .every((r) => r.observationOnly && r.executionDriver === "source"),
  );
  assert.ok(
    snapshot.projectRegistrations.some((r) => r.projectId === imported.project),
  );
  assert.equal(
    snapshot.tasks.some((x) => x.title === "Imported task other"),
    false,
  );
  assert.equal(
    snapshot.projects.some((x) => x.title === "Imported other"),
    false,
  );
  assert.equal(imported.canRetry, false);
  const denied = (e) =>
    e.isDSHRemoteError && e.details?.reason === "PLANNER_REQUIRED";
  await assert.rejects(
    f.settings.createProject({
      commandId: "forbidden",
      title: "Forbidden",
      goal: "Forbidden",
    }),
    denied,
  );
  await assert.rejects(
    f.settings.actOnProjectTask({
      commandId: "forbidden-action",
      taskId: f.own.task.taskId,
      action: "cancel",
    }),
    denied,
  );
  assert.deepEqual(f.ledger.snapshot().tasks, before.tasks);
  assert.deepEqual(f.ledger.snapshot().attempts, before.attempts);
  assert.equal(
    f.executor.ledger.snapshot().tasks.length,
    0,
    "executor shows central facts without duplicating the business ledger",
  );
});

test('session collaboration without runs is visible only to its owner node in original project projection', async () => {
  const h = await createNativeHarness({ config: { role: 'both', nodeId: 'central' } });
  try {
    h.ledger.registerNode('collaboration-owner', {nodeId:'mbp',roles:['executor'],enabled:true,workspaceIds:[],capabilities:[],models:[],lastSeenAt:new Date().toISOString()});
    const result=await h.ledger.projectCollaborate('mbp','activate-empty-project',{action:'activate',sessionId:'local-conversation',cwd:h.dir,title:'No tasks yet'});
    const own=h.ctx.taskSystem.projects.snapshotForNode('mbp');
    const other=h.ctx.taskSystem.projects.snapshotForNode('other');
    assert.equal(own.projectCollaborations.length,1);
    assert.equal(own.projects.find(p=>p.id===result.projectId)?.stage,'会话协作');
    assert.equal(own.projects.find(p=>p.id===result.projectId)?.canChat,false);
    assert.equal(other.projectCollaborations.length,0);
    assert(!other.projects.some(p=>p.id===result.projectId));
  } finally { await h.dispose(); }
});
