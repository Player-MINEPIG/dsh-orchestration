import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../../dist/ledger.js";
import { ExecutorWorker, RecoveryStore } from "../../dist/remote/api.js";

function fixture(t, options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "result-delivery-")));
  const ledger = TaskLedger.open(join(dir, "ledger.sqlite"), {
      role: "planner",
      nodeId: "central",
    }),
    store = new RecoveryStore(join(dir, "worker.sqlite"));
  ledger.registerWorkspace("workspace", {
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
    models: [{ provider: "fixture", model: "fixture", reasoningEfforts: [] }],
    workspaceIds: ["ws"],
    capabilities: [],
    enabled: true,
  });
  const task = ledger.createTask("task", {
    title: "Durable result fixture",
    policy: { settlementQuietMs: 0 },
  }).value;
  const run = ledger.createRun("run", {
    taskId: task.taskId,
    route: {
      nodeId: "worker",
      provider: "fixture",
      model: "fixture",
      workspaceId: "ws",
      requiredCapabilities: [],
    },
  }).value;
  let executions = 0,
    signal;
  const worker = new ExecutorWorker({
    ledger,
    store,
    ttlMs: 1000,
    maxResultBytes: 512000,
    policy: {
      role: "executor",
      nodeId: "worker",
      capabilities: [],
      workspaces: [
        { workspaceId: "ws", nodeId: "worker", path: dir, allowedRoot: dir },
      ],
    },
    provider: {
      id: "fixture",
      capabilities: [],
      supports: () => true,
      execute: async (request) => {
        executions++;
        signal = request.signal;
        return (
          options.execute?.(request) || {
            outcome: "success",
            summary: "Preserved result",
            report: {
              title: "Evidence",
              body: "Local collector evidence",
              data: { items: ["x".repeat(255940)] },
            },
          }
        );
      },
    },
  });
  t.after(async () => {
    await worker.dispose();
    store.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ledger,
    store,
    worker,
    task,
    run,
    executions: () => executions,
    signal: () => signal,
  };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "provider completion retains lease renewal while a large result submission crosses the original lease",
  { timeout: 7000 },
  async (t) => {
    const f = fixture(t),
      submit = f.ledger.submit.bind(f.ledger),
      renew = f.ledger.renew.bind(f.ledger);
    let delivering = false,
      renewalsDuringDelivery = 0;
    f.ledger.renew = (id, input) => {
      if (delivering) renewalsDuringDelivery++;
      return renew(id, input);
    };
    f.ledger.submit = async (id, input) => {
      delivering = true;
      assert.equal(f.signal().aborted, false);
      assert.ok(Buffer.byteLength(JSON.stringify(input)) > 255940);
      await delay(1500);
      assert.equal(f.signal().aborted, false);
      return submit(id, input);
    };
    const record = await f.worker.execute(f.run.runId, "claim");
    assert.equal(record.state, "acknowledged");
    assert.ok(renewalsDuringDelivery >= 2);
    assert.equal(f.ledger.getRun(f.run.runId).state, "succeeded");
    assert.equal(f.executions(), 1);
    assert.equal(f.signal().aborted, true);
    const count = renewalsDuringDelivery;
    await delay(400);
    assert.equal(
      renewalsDuringDelivery,
      count,
      "settlement releases renewal timers",
    );
  },
);

test(
  "submission renews immediately before a serialized upload and never reexecutes on lost acknowledgment",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t, {
        execute: async () => {
          await delay(650);
          return {
            outcome: "success",
            summary: "Collected",
            report: {
              title: "Evidence",
              body: "Collected",
              data: { items: ["x".repeat(255940)] },
            },
          };
        },
      }),
      submit = f.ledger.submit.bind(f.ledger),
      renew = f.ledger.renew.bind(f.ledger);
    let calls = 0,
      uploading = false,
      uploadDone;
    const gate = new Promise((resolve) => (uploadDone = resolve));
    f.ledger.renew = async (id, input) => {
      if (uploading) await gate;
      return renew(id, input);
    };
    f.ledger.submit = async (id, input) => {
      calls++;
      uploading = true;
      await delay(750);
      const receipt = submit(id, input);
      uploading = false;
      uploadDone();
      if (calls === 1) throw Error("acknowledgment lost after commit");
      return receipt;
    };
    const record = await f.worker.execute(f.run.runId, "claim");
    assert.equal(
      record.state,
      "result",
      "an authoritative settled result retains its exact acknowledgment retry",
    );
    assert.equal(record.result.report.data.items[0].length, 255940);
    assert.equal(f.executions(), 1);
    assert.equal(f.ledger.getRun(f.run.runId).state, "succeeded");
    // An exact retry may retrieve its committed receipt even after renewal is no longer authorized.
    record.state = "result";
    f.store.saveDispatch(record);
    assert.equal((await f.worker.deliver(record)).state, "acknowledged");
    assert.equal(f.executions(), 1);
  },
);

test(
  "expired durable result becomes explicit uncertainty with original evidence and never replays provider",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t),
      submit = f.ledger.submit.bind(f.ledger);
    let offline = true;
    f.ledger.submit = (id, input) => {
      if (offline) throw Error("network unavailable before submission");
      return submit(id, input);
    };
    const record = await f.worker.execute(f.run.runId, "claim");
    assert.equal(record.state, "result");
    await delay(1150);
    offline = false;
    const recovered = await f.worker.recoverResults();
    assert.equal(recovered[0].state, "uncertain");
    assert.equal(recovered[0].result.report.data.items[0].length, 255940);
    assert.match(recovered[0].detail, /reconciliation/);
    assert.equal(f.executions(), 1);
    assert.notEqual(f.ledger.getRun(f.run.runId).state, "succeeded");
    f.ledger.recoverExpired("expire-authority");
    f.ledger.resolveUncertain("confirmed-stopped", {runId:f.run.runId,outcome:"failed",reason:"Provider stopped; original evidence retained"});
    const reconciled=(await f.worker.recoverResults())[0];
    assert.equal(reconciled.state,"acknowledged");
    assert.equal(reconciled.reconciliation.runState,"failed");
    assert.equal(reconciled.result.report.data.items[0].length,255940);
    assert.equal(f.executions(), 1);
  },
);
