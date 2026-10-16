import test from "node:test";
import assert from "node:assert/strict";
import { TaskLedger } from "../dist/ledger.js";

test("node status counts live and uncertain claims without hydrating unrelated historical Run input", (t) => {
  const ledger = TaskLedger.open(":memory:", {
    role: "planner",
    nodeId: "central",
  });
  t.after(() => ledger.close());
  for (const [nodeId, enabled] of [
    ["worker", true],
    ["disabled", false],
    ["unknown", true],
  ])
    ledger.registerNode("node-" + nodeId, {
      nodeId,
      enabled,
      roles: ["executor"],
      models: [{ provider: "fixture", model: "small", reasoningEfforts: [] }],
      capabilities: [],
      workspaceIds: [],
      maxConcurrent: 4,
    });
  ledger.recordNodeHeartbeat("heartbeat", {
    nodeId: "worker",
    sampledAt: Date.now(),
    runtimeReady: true,
    activeExecutions: 2,
    source: "host-local",
  });
  const db = ledger.managementDatabase();
  const seed = (id, state, extra = {}) =>
    db
      .prepare(
        "INSERT INTO entities(kind,id,parent,state,data) VALUES(?,?,?,?,?)",
      )
      .run(
        "run",
        id,
        "fixture-task",
        state,
        JSON.stringify({
          runId: id,
          taskId: "fixture-task",
          state,
          route: { nodeId: "worker" },
          configuration: { input: "x".repeat(64000) },
          ...extra,
        }),
      );
  seed("running", "running");
  seed("uncertain", "uncertain");
  seed("queued", "queued");
  seed("done", "succeeded");
  seed("cancelled", "cancelled");
  seed("old", "running", { historyOnly: true });
  seed("observed", "uncertain", { observationOnly: true });
  seed("root", "running", { route: undefined });
  const original = ledger.projectEntity.bind(ledger);
  ledger.projectEntity = (kind, value) => {
    assert.notEqual(
      kind,
      "run",
      "status must not expand historical Run contexts",
    );
    return original(kind, value);
  };
  const statuses = ledger.nodeStatuses(),
    worker = statuses.find((row) => row.nodeId === "worker");
  assert.equal(worker.activeClaims, 2);
  assert.equal(worker.availableSlots, 2);
  assert.equal(worker.state, "online");
  assert.equal(
    statuses.find((row) => row.nodeId === "disabled").state,
    "disabled",
  );
  assert.equal(
    statuses.find((row) => row.nodeId === "unknown").state,
    "unknown",
  );
  db.prepare(
    "UPDATE entities SET state='cancelled',data=json_set(data,'$.state','cancelled') WHERE id='running'",
  ).run();
  assert.equal(
    ledger.nodeStatuses().find((row) => row.nodeId === "worker").activeClaims,
    1,
    "next status read observes changes without a long-lived cache",
  );
  assert.equal(
    ledger
      .nodeStatuses(Date.now() + 120000)
      .find((row) => row.nodeId === "worker").state,
    "stale",
  );
});
