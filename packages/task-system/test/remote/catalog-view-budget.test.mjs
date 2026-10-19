import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  RemoteGateway,
  RecoveryStore,
  IdentityVerifier,
  signEnvelope,
  RemoteLedgerClient,
} from "../../dist/remote/api.js";

for (const budget of [8192, 1024])
  test(`signed model view respects ${budget} byte responses with long valid tuples`, async () => {
    const keys = generateKeyPairSync("ed25519"),
      store = new RecoveryStore(":memory:");
    const models = Array.from({ length: 40 }, (_, index) => ({
      provider: "p".repeat(100),
      model: `${index}-` + "m".repeat(190),
      backend: "b".repeat(100),
      reasoningEffort: "e".repeat(100),
      kind: "official-codex",
      resume: false,
    }));
    const snapshot = {
      revision: "catalog",
      observedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      complete: true,
      models,
    };
    const view = {
      nodeId: "worker",
      catalog: { state: "fresh", snapshot, positiveSnapshot: snapshot },
      policy: { revision: 0 },
    };
    const gateway = new RemoteGateway({
      role: "planner",
      nodeId: "planner",
      store,
      maxResponseBytes: budget,
      ledger: {
        executionModelView: () => structuredClone(view),
        nodeStatuses: () => [{ nodeId: "worker" }],
      },
      verifier: new IdentityVerifier({
        audience: "planner",
        peers: [
          {
            keyId: "fixture",
            nodeId: "worker",
            publicKey: keys.publicKey,
            audience: "planner",
            operations: ["executionModelView"],
            workspaces: [],
            capabilities: [],
          },
        ],
      }),
    });
    let sequence = 0;
    const receipts = [];
    const client = {
      send: async (operation, commandId, payload) => {
        const now = Date.now(),
          envelope = signEnvelope(
            {
              version: 1,
              keyId: "fixture",
              nodeId: "worker",
              audience: "planner",
              commandId,
              nonce: randomUUID(),
              sequence: ++sequence,
              issuedAt: now,
              expiresAt: now + 60000,
              operation,
              payload,
            },
            keys.privateKey,
          );
        const result = await gateway.handle(JSON.stringify(envelope));
        receipts.push(result);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= budget);
        assert.equal(result.state, "done");
        return result;
      },
    };
    try {
      const remote = new RemoteLedgerClient(client, "worker");
      if (budget === 8192) {
        const result = await remote.executionModelView("worker");
        assert.deepEqual(result, view);
        assert.ok(receipts.length > 1);
        assert.ok(receipts.every((receipt) => receipt.result.count < 32));
      } else
        await assert.rejects(remote.executionModelView("worker"), {
          code: "RESPONSE_LIMIT",
        });
      await assert.rejects(
        client.send("executionModelView", "bad-limit", { limit: 33 }),
        { code: "INVALID_LIMIT" },
      );
    } finally {
      store.close();
    }
  });
