import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../../dist/ledger.js";
import { ExecutorWorker, RecoveryStore } from "../../dist/remote/api.js";

test("worker reports missing explicit binding before claim and repairs the same run after binding is restored", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "admission-repair-"))),
    ledger = TaskLedger.open(join(dir, "ledger.sqlite"), {
      role: "planner",
      nodeId: "planner",
    }),
    store = new RecoveryStore(":memory:");
  let worker;
  try {
    ledger.registerWorkspace("ws", {
      workspaceId: "ws",
      nodeId: "worker",
      path: dir,
      label: "Fixture",
      state: "ready",
      createdAt: new Date().toISOString(),
    });
    ledger.registerNode("node", {
      nodeId: "worker",
      roles: ["executor"],
      capabilities: [],
      workspaceIds: ["ws"],
      models: [{ provider: "fixture", model: "fixture", reasoningEfforts: [] }],
      enabled: true,
    });
    const task = ledger.createTask("task", {
      title: "Same-run admission repair",
    }).value;
    const run = ledger.createRun("run", {
      taskId: task.taskId,
      route: {
        nodeId: "worker",
        workspaceId: "ws",
        provider: "fixture",
        model: "fixture",
        requiredCapabilities: [],
      },
    }).value;
    const policy = {
      role: "executor",
      nodeId: "worker",
      capabilities: [],
      workspaces: [],
    };
    let executions = 0;
    const provider = {
      id: "fixture",
      capabilities: [],
      supports: () => true,
      execute: async () => {
        executions++;
        return { outcome: "success", summary: "Restored binding executed" };
      },
    };
    worker = new ExecutorWorker({ ledger, store, policy, provider });
    assert.deepEqual(await worker.pollOnce(), []);
    const blocked = ledger.getRun(run.runId);
    assert.equal(blocked.state, "queued");
    assert.equal(blocked.currentAttemptId, undefined);
    assert.equal(blocked.dispatchIssue.code, "WORKSPACE_BINDING_REQUIRED");
    assert.equal(blocked.dispatchIssue.source, "executor");
    assert.equal(executions, 0);
    assert.equal(ledger.snapshot().attempts.length, 0);
    await worker.dispose();
    worker = new ExecutorWorker({
      ledger,
      store,
      provider,
      policy: {
        ...policy,
        workspaces: [
          { workspaceId: "ws", nodeId: "worker", path: dir, allowedRoot: dir },
        ],
      },
    });
    const result = await worker.pollOnce();
    assert.equal(result.length, 1);
    assert.equal(result[0].value.state, "acknowledged", JSON.stringify(result));
    assert.equal(ledger.getRun(run.runId).state, "succeeded");
    assert.equal(executions, 1);
    assert.equal(ledger.snapshot().attempts.length, 1);
  } finally {
    await worker?.dispose();
    store.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
