import {registerExecutor} from '../../../../tests/dsh/executor-fixture.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../../dist/ledger.js";
import { Workbench } from "../../dist/workbench.js";
import { ExecutorWorker, RecoveryStore } from "../../dist/remote/api.js";

async function fixture(t, execute) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "recursive-worker-"))),
    ledger = TaskLedger.open(join(dir, "central.sqlite"), {
      role: "planner",
      nodeId: "central",
    }),
    store = new RecoveryStore(join(dir, "recovery.sqlite"));
  const route = {
    nodeId: "worker",
    provider: "fixture",
    model: "fixture",
    requiredCapabilities: [],
    workspaceId: "ws",
  };
  ledger.registerWorkspace("ws", {
    workspaceId: "ws",
    nodeId: "worker",
    path: dir,
    label: "Test",
    state: "ready",
    createdAt: new Date().toISOString(),
  });
  registerExecutor(ledger, "node", {
    nodeId: "worker",
    roles: ["executor"],
    models: [{ provider: "fixture", model: "fixture", reasoningEfforts: [] }],
    capabilities: [],
    workspaceIds: ["ws"],
    enabled: true,
    maxConcurrent: 8,
  });
  const wb = new Workbench(ledger);
  wb.manage("p", "create_project", {
    projectId: "p",
    title: "P",
    goal: "G",
    state: "active",
  });
  wb.manage("b", "create_backlog", {
    backlogId: "b",
    projectId: "p",
    title: "B",
  });
  const create = (id) => {
    const task = ledger.createTask("task-" + id, {
      title: id,
      policy: {
        maxDepth: 8,
        maxChildren: 10,
        maxDescendants: 30,
        settlementQuietMs: 0,
      },
    }).value;
    wb.manage("link-" + id, "link_backlog_task", {
      backlogId: "b",
      taskId: task.taskId,
    });
    return ledger.createRun("run-" + id, { taskId: task.taskId, route }).value;
  };
  const worker = new ExecutorWorker({
    ledger,
    store,
    provider: {
      id: "fixture",
      capabilities: [],
      supports: () => true,
      execute,
    },
    policy: {
      role: "executor",
      nodeId: "worker",
      capabilities: [],
      workspaces: [
        { workspaceId: "ws", nodeId: "worker", path: dir, allowedRoot: dir },
      ],
    },
  });
  t.after(async () => {
    await worker.dispose();
    store.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, ledger, store, worker, create, route };
}
async function until(predicate, signal, limit = 5000) {
  const start = Date.now();
  while (!predicate()) {
    signal?.throwIfAborted();
    if (Date.now() - start > limit) throw Error("fixture condition timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
test(
  "production polling discovers descendants and independent roots concurrently within node capacity",
  { timeout: 10000 },
  async (t) => {
    let f;
    const order = [],
      paths = new Map(),
      sessions = new Set();
    let concurrent = 0,
      max = 0;
    f = await fixture(t, async (request) => {
      const title = request.claim.task.title;
      order.push("start:" + title);
      paths.set(title, request.workspacePath);
      sessions.add(request.sessionId);
      max = Math.max(max, ++concurrent);
      try {
        writeFileSync(join(request.workspacePath, title + ".txt"), title);
        if (title === "parent" || title === "child") {
          const name = title === "parent" ? "child" : "codex-leaf";
          const child = (
            await request.collaboration.delegate("delegate-" + name, {
              title: name,
              route: f.route,
            })
          ).value;
          await until(
            () => f.ledger.getRun(child.run.runId).state === "succeeded",
            request.signal,
          );
        }
        assert.equal(
          readFileSync(join(request.workspacePath, title + ".txt"), "utf8"),
          title,
          "each task retains its own output even when independent roots share cwd",
        );
        order.push("end:" + title);
        return { outcome: "success", summary: "fixture completed" };
      } finally {
        concurrent--;
      }
    });
    const parent = f.create("parent"),
      unrelated = f.create("unrelated");
    f.worker.startPolling(100, 4);
    await until(
      () => [parent, unrelated].every(run => f.ledger.getRun(run.runId).state === "succeeded"),
      undefined,
      7000,
    );
    assert.equal(f.ledger.getRun(parent.runId).state, "succeeded");
    assert.ok(order.indexOf("start:child") < order.indexOf("end:parent"));
    assert.ok(order.indexOf("start:codex-leaf") < order.indexOf("end:child"));
    assert.ok(order.indexOf("start:unrelated") < order.indexOf("end:parent"));
    assert.equal(paths.get("parent"), paths.get("unrelated"));
    assert.notEqual(paths.get("child"), paths.get("parent"));
    assert.notEqual(paths.get("codex-leaf"), paths.get("child"));
    assert.equal(sessions.size, 4);
    assert.ok(max >= 2 && max <= 4);
    assert.ok(f.store.dispatches().every((r) => r.state === "acknowledged"));
  },
);
test(
  "nonblocking dispatch remains owned by dispose until cancellation quiesces",
  { timeout: 5000 },
  async (t) => {
    let stopped = false,
      started = false;
    const f = await fixture(t, async (request) => {
      started = true;
      await new Promise((r) =>
        request.signal.addEventListener("abort", r, { once: true }),
      );
      await new Promise((r) => setTimeout(r, 30));
      stopped = true;
      throw Error("fixture cancelled");
    });
    const run = f.create("parent");
    await f.worker.pollOnce(4, { waitForCompletion: false });
    await until(() => started);
    assert.equal(stopped, false);
    await f.worker.dispose();
    assert.equal(stopped, true);
    assert.notEqual(f.ledger.getRun(run.runId).state, "succeeded");
  },
);

test(
  "single-slot worker refuses recursive delegation before creating an unexecutable child",
  { timeout: 5000 },
  async (t) => {
    let f, reason;
    f = await fixture(t, async (request) => {
      try {
        await request.collaboration.delegate("child", {
          title: "Cannot fit",
          route: f.route,
        });
        assert.fail("expected capacity refusal");
      } catch (error) {
        reason = String(error);
        assert.match(reason, /RECURSIVE_CAPACITY_EXHAUSTED/);
      }
      return { outcome: "blocked", summary: reason };
    });
    const parent = f.create("parent");
    await f.worker.pollOnce(1);
    assert.equal(f.ledger.getRun(parent.runId).state, "blocked");
    assert.equal(f.ledger.snapshot().tasks.length, 1);
    assert.equal(f.ledger.snapshot().attempts.length, 1);
  },
);

test("authority blocks a child when its active ancestor chain fills node capacity; foreign nodes remain eligible", async (t) => {
  const f = await fixture(t, async () => ({
    outcome: "success",
    summary: "unused",
  }));
  f.ledger.setNodeCapacity("one-slot", "worker", 1);
  registerExecutor(f.ledger, "foreign-node", {
    nodeId: "foreign",
    roles: ["executor"],
    models: [{ provider: "fixture", model: "fixture", reasoningEfforts: [] }],
    capabilities: [],
    workspaceIds: [],
    enabled: true,
    maxConcurrent: 1,
  });
  const parent = f.create("parent");
  const claim = f.ledger.claim("parent-claim", {
    runId: parent.runId,
    nodeId: "worker",
    ttlMs: 60000,
  }).value;
  const ref = {
    runId: parent.runId,
    nodeId: "worker",
    attemptId: claim.attempt.attemptId,
    fence: claim.attempt.fence,
    executionId: "owner",
  };
  f.ledger.markRunning("parent-running", ref);
  assert.throws(
    () =>
      f.ledger.delegateTask("blocked-child", {
        ...ref,
        title: "Same host cannot fit",
        route: f.route,
      }),
    /DELEGATION_DEADLOCK|ancestor chain/,
  );
  assert.equal(
    f.ledger.snapshot().tasks.length,
    1,
    "failed command rolls back child Task and Run atomically",
  );
  const foreign = f.ledger.delegateTask("foreign-child", {
    ...ref,
    title: "Foreign can fit",
    route: { ...f.route, nodeId: "foreign", workspaceId: undefined },
  }).value;
  assert.equal(foreign.run.route.nodeId, "foreign");
  f.ledger.setNodeCapacity("two-slots", "worker", 2);
  const child = f.ledger.delegateTask("child", {
    ...ref,
    title: "Second slot child",
    route: f.route,
  }).value;
  const cc = f.ledger.claim("child-claim", {
    runId: child.run.runId,
    nodeId: "worker",
    ttlMs: 60000,
  }).value;
  const childRef = {
    runId: child.run.runId,
    nodeId: "worker",
    attemptId: cc.attempt.attemptId,
    fence: cc.attempt.fence,
    executionId: "child-owner",
  };
  f.ledger.markRunning("child-running", childRef);
  const before = f.ledger.snapshot().tasks.length;
  assert.throws(
    () =>
      f.ledger.delegateTask("blocked-grandchild", {
        ...childRef,
        title: "Third slot cannot fit",
        route: f.route,
      }),
    /DELEGATION_DEADLOCK|ancestor chain/,
  );
  assert.equal(f.ledger.snapshot().tasks.length, before);
});


test('independent roots with the same project and cwd reach capacity without duplicating a Run', {timeout:10000}, async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),entered=[];
 const f=await fixture(t,async request=>{entered.push(request);await gate;return {outcome:'success',summary:'Parallel output verified'};});
 const runs=['first','second','third'].map(f.create);
 try {
  await f.worker.pollOnce(2,{waitForCompletion:false});
  await until(()=>entered.length===2);
  assert.equal(entered[0].workspacePath,entered[1].workspacePath);
  assert.equal(f.ledger.getRun(runs[2].runId).state,'queued');
  assert.throws(()=>f.worker.execute(runs[0].runId,'duplicate-owner'),/RUN_ALREADY_ACTIVE/);
  assert.equal(f.ledger.snapshot().attempts.length,2);
 }finally{release();}
 await until(()=>runs.slice(0,2).every(run=>f.ledger.getRun(run.runId).state==='succeeded'));
 await f.worker.pollOnce(2);
 assert.equal(f.ledger.getRun(runs[2].runId).state,'succeeded');
 assert.equal(f.ledger.snapshot().attempts.length,3);
});
