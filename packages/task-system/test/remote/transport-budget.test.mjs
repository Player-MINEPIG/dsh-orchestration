import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../../dist/ledger.js";
import {
  RecoveryStore,
  RemoteClient,
  RemoteLedgerClient,
  RemoteGateway,
  IdentityVerifier,
  httpHandler,
} from "../../dist/remote/api.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "default budgets admit a signed 256KB result over a real sixteen-second upload without extending envelope validity",
  { timeout: 25000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "slow-result-http-")),
      ledger = TaskLedger.open(join(dir, "central.sqlite"), {
        role: "planner",
        nodeId: "central",
      }),
      serverStore = new RecoveryStore(":memory:"),
      clientStore = new RecoveryStore(":memory:");
    const keys = generateKeyPairSync("ed25519"),
      peer = {
        keyId: "slow-fixture",
        nodeId: "worker",
        audience: "central",
        publicKey: keys.publicKey,
        operations: ["submit"],
        workspaces: ["ws"],
        capabilities: [],
      };
    const gateway = new RemoteGateway({
      role: "planner",
      nodeId: "central",
      ledger,
      store: serverStore,
      maxBodyBytes: 512000,
      verifier: new IdentityVerifier({ audience: "central", peers: [peer] }),
    });
    const server = http.createServer(
      httpHandler(gateway, { allowLoopbackHttp: true, maxBodyBytes: 512000 }),
    );
    let client;
    t.after(async () => {
      await client?.dispose();
      await gateway.dispose();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      serverStore.close();
      clientStore.close();
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    });
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
      enabled: true,
      roles: ["executor"],
      workspaceIds: ["ws"],
      capabilities: [],
      models: [{ provider: "fixture", model: "fixture", reasoningEfforts: [] }],
    });
    const task = ledger.createTask("task", {
        title: "Slow upload",
        policy: { settlementQuietMs: 0 },
      }).value,
      run = ledger.createRun("run", {
        taskId: task.taskId,
        route: {
          nodeId: "worker",
          workspaceId: "ws",
          provider: "fixture",
          model: "fixture",
          requiredCapabilities: [],
        },
      }).value;
    const claim = ledger.claim("claim", {
        runId: run.runId,
        nodeId: "worker",
        ttlMs: 180000,
      }).value,
      lease = {
        runId: run.runId,
        attemptId: claim.attempt.attemptId,
        nodeId: "worker",
        fence: claim.attempt.fence,
        executionId: "slow-upload-owner",
      };
    ledger.markRunning("running", lease);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let transmitted;
    const slowFetch = (url, options) =>
      new Promise((resolve, reject) => {
        transmitted = JSON.parse(options.body);
        const request = http.request(
          url,
          {
            method: options.method,
            headers: options.headers,
            signal: options.signal,
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode,
                  headers: response.headers,
                }),
              ),
            );
          },
        );
        request.on("error", reject);
        void (async () => {
          const body = Buffer.from(options.body),
            size = Math.ceil(body.length / 17);
          for (let offset = 0; offset < body.length; offset += size) {
            if (request.destroyed) return;
            request.write(body.subarray(offset, offset + size));
            if (offset + size < body.length) await delay(1000);
          }
          request.end();
        })().catch(reject);
      });
    client = new RemoteClient({
      endpoint: `http://127.0.0.1:${server.address().port}/commands`,
      allowLoopbackHttp: true,
      nodeId: "worker",
      audience: "central",
      keyId: peer.keyId,
      privateKey: keys.privateKey,
      store: clientStore,
      maxBodyBytes: 512000,
      fetch: slowFetch,
    });
    const remote = new RemoteLedgerClient(client, "worker");
    await remote.submit("large-result", {
      ...lease,
      outcome: "success",
      summary: "Uploaded",
      report: {
        title: "Evidence",
        body: "Collected",
        data: { evidence: "x".repeat(255940) },
      },
    });
    assert.equal(ledger.getRun(run.runId).state, "succeeded");
    assert.equal(
      ledger.history(task.taskId).reports[0].data.evidence.length,
      255940,
    );
    assert.equal(transmitted.expiresAt - transmitted.issuedAt, 60000);
  },
);

test("a queued request keeps its original budget and never signs or sends after expiry", async (t) => {
  const store = new RecoveryStore(":memory:"),
    keys = generateKeyPairSync("ed25519");
  let sends = 0,
    release;
  const gate = new Promise((resolve) => (release = resolve));
  const client = new RemoteClient({
    endpoint: "https://queue.invalid/commands",
    nodeId: "worker",
    audience: "central",
    keyId: "queue-fixture",
    privateKey: keys.privateKey,
    store,
    timeoutMs: 20,
    fetch: async (_url, options) => {
      sends++;
      await gate;
      return new Response(
        JSON.stringify({
          commandId: JSON.parse(options.body).commandId,
          state: "done",
          result: [],
        }),
      );
    },
  });
  t.after(async () => {
    release();
    await client.dispose();
    store.close();
  });
  const first = client.send("listWork", "first", {});
  const rejected = assert.rejects(
    client.send("listWork", "queued", {}),
    /TRANSPORT_ABORTED/,
  );
  await delay(40);
  release();
  await first;
  await rejected;
  assert.equal(sends, 1);
  assert.equal(store.outbound("queued"), undefined);
});
