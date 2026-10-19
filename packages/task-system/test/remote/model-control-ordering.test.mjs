import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../../dist/ledger.js";
import { ExecutionModelInventory } from "../../dist/executor-models.js";
import { ExecutorModelControl } from "../../dist/remote/model-control.js";
import {
  RemoteClient,
  RemoteLedgerClient,
  RemoteGateway,
  RecoveryStore,
  IdentityVerifier,
} from "../../dist/remote/api.js";

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("shared signed client orders delayed catalog, heartbeat and claim; discovery and borrowed disposal do not hold the send queue", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "catalog-sequence-"))),
    ledger = TaskLedger.open(":memory:", {
      role: "planner",
      nodeId: "planner",
    }),
    outbox = new RecoveryStore(":memory:"),
    inbox = new RecoveryStore(":memory:"),
    keys = generateKeyPairSync("ed25519");
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
    capabilities: [],
    workspaceIds: ["ws"],
    models: [{ provider: "fixture", model: "fixture", reasoningEfforts: [] }],
    enabled: true,
  });
  const task = ledger.createTask("task", {
    title: "Concurrent claim intent",
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
  ledger.executionModels.request("catalog", { nodeId: "worker" });
  const peer = {
    keyId: "fixture",
    nodeId: "worker",
    publicKey: keys.publicKey,
    audience: "planner",
    operations: [
      "executorIdentity",
      "executionModelRequests",
      "completeExecutionModels",
      "heartbeat",
      "claim",
    ],
    workspaces: ["ws"],
    capabilities: [],
  };
  const gateway = new RemoteGateway({
    role: "planner",
    nodeId: "planner",
    ledger,
    store: inbox,
    verifier: new IdentityVerifier({ audience: "planner", peers: [peer] }),
  });
  const arrivals = [],
    errors = [];
  let releaseRequest,
    requestEntered = false,
    releaseDiscovery,
    discoveryStarted = false;
  const client = new RemoteClient({
      endpoint: "https://fixture.invalid/commands",
      nodeId: "worker",
      audience: "planner",
      keyId: "fixture",
      privateKey: keys.privateKey,
      store: outbox,
      fetch: async (_url, options) => {
        const envelope = JSON.parse(options.body);
        if (
          envelope.operation === "executionModelRequests" &&
          !requestEntered
        ) {
          requestEntered = true;
          await new Promise((resolve) => {
            releaseRequest = resolve;
          });
        }
        arrivals.push(envelope);
        try {
          return new Response(
            JSON.stringify(await gateway.handle(options.body)),
          );
        } catch (error) {
          errors.push(error.code);
          return new Response(JSON.stringify({ error: error.code }), {
            status: error.status ?? 500,
          });
        }
      },
    }),
    remote = new RemoteLedgerClient(client, "worker");
  const inventory = new ExecutionModelInventory({
    llm: () => ({
      listProviders: () => [{ id: "fixture" }],
      listModels: () => {
        discoveryStarted = true;
        return new Promise((resolve) => {
          releaseDiscovery = resolve;
        });
      },
      resolveModelInfo: async () => ({}),
    }),
    nativeReady: () => true,
    officialBackends: () => [],
    officialAvailable: () => false,
  });
  const control = new ExecutorModelControl({
    nodeId: "worker",
    client,
    remote,
    inventory,
    ownsClient: false,
  });
  try {
    const catalog = control.pollNow();
    await until(() => requestEntered);
    const heartbeat = remote.recordNodeHeartbeat("concurrent-heartbeat", {
      nodeId: "worker",
      sampledAt: Date.now(),
      runtimeReady: true,
      activeExecutions: 0,
    });
    const claim = remote.claim("concurrent-claim", {
      runId: run.runId,
      nodeId: "worker",
      ttlMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
      !arrivals.some(
        (item) => item.operation === "heartbeat" || item.operation === "claim",
      ),
    );
    releaseRequest();
    await until(() => discoveryStarted);
    await Promise.all([heartbeat, claim]);
    assert.equal(ledger.getRun(run.runId).state, "running");
    assert.ok(!errors.includes("OUT_OF_ORDER"));
    assert.deepEqual(
      arrivals.map((item) => item.sequence),
      arrivals.map((_, index) => index + 1),
    );
    const resume = await Promise.race([
      control.beginConfigurationEdit(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("control drain timeout")), 1000),
      ),
    ]);
    await catalog;
    releaseDiscovery([{ id: "fixture" }]);
    resume();
    await control.dispose();
    await remote.recordNodeHeartbeat("after-control-dispose", {
      nodeId: "worker",
      sampledAt: Date.now() + 1,
      runtimeReady: true,
      activeExecutions: 0,
    });
    assert.ok(
      !errors.includes("OUT_OF_ORDER"),
      "borrowed client remains usable",
    );
  } finally {
    releaseRequest?.();
    releaseDiscovery?.([]);
    await control.dispose();
    await client.dispose();
    await gateway.dispose();
    outbox.close();
    inbox.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
