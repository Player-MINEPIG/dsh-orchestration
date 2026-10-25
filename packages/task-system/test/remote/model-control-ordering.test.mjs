import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskLedger } from "../../dist/ledger.js";
import { ExecutionModelInventory } from "../../dist/executor-models.js";
import { ExecutorModelControl } from "../../dist/remote/model-control.js";
import {
  RemoteClient,
  RemoteLedgerClient,
  RemoteGateway,
  RecoveryStore,
  IdentityVerifier,
  signEnvelope,
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

function catalogHarness(
  t,
  collect,
  intercept = async (_envelope, send) => send(),
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "catalog-recovery-")));
  const ledger = TaskLedger.open(":memory:", {
    role: "planner",
    nodeId: "planner",
  });
  const outbox = new RecoveryStore(":memory:"), inboxPath = join(dir,"inbox.sqlite");
  let inbox = new RecoveryStore(inboxPath);
  const keys = generateKeyPairSync("ed25519");
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
    enabled: true,
    capabilities: [],
    workspaceIds: ["ws"],
    models: [],
  });
  const task = ledger.createTask("task", {
    title: "Recover the original queued Run",
  }).value;
  const run = ledger.createRun("run", {
    taskId: task.taskId,
    route: {
      nodeId: "worker",
      workspaceId: "ws",
      provider: "fixture",
      model: "model-0",
      requiredCapabilities: [],
    },
    executionModel: { origin: "explicit", policyRevision: "fixture" },
  }).value;
  const gatewayOptions = {
    role: "planner",
    nodeId: "planner",
    ledger,
    store: inbox,
    verifier: new IdentityVerifier({
      audience: "planner",
      peers: [
        {
          keyId: "fixture",
          nodeId: "worker",
          publicKey: keys.publicKey,
          audience: "planner",
          operations: [
            "executorIdentity",
            "executionModelRequests",
            "executionModelView",
            "completeExecutionModels",
            "receipt",
            "heartbeat",
            "claim",
          ],
          workspaces: ["ws"],
          capabilities: [],
        },
      ],
    }),
  };
  let gateway = new RemoteGateway({...gatewayOptions,store:inbox});
  const arrivals = [];
  const client = new RemoteClient({
    endpoint: "https://fixture.invalid/commands",
    nodeId: "worker",
    audience: "planner",
    keyId: "fixture",
    privateKey: keys.privateKey,
    store: outbox,
    fetch: async (_url, options) => {
      const envelope = JSON.parse(options.body);
      arrivals.push(envelope);
      return intercept(
        envelope,
        async () =>
          new Response(JSON.stringify(await gateway.handle(options.body))),
      );
    },
  });
  const remote = new RemoteLedgerClient(client, "worker");
  const controlOptions = {
    nodeId: "worker",
    client,
    remote,
    inventory: { collect },
    store: outbox,
    ownsClient: false,
  };
  const controls = [];
  const control = () => {
    const value = new ExecutorModelControl(controlOptions);
    controls.push(value);
    return value;
  };
  t.after(async () => {
    for (const control of controls) await control.dispose();
    await client.dispose();
    await gateway.dispose();
    outbox.close();
    inbox.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ledger, run, task, remote, control, outbox, get inbox(){return inbox;}, get gateway(){return gateway;}, client, arrivals, keys,
    async restartGateway(legacySchema = false) {
      await gateway.dispose();inbox.close();
      if(legacySchema) {
        const db = new DatabaseSync(inboxPath);
        try {db.exec("ALTER TABLE commands DROP COLUMN operation");} finally {db.close();}
      }
      inbox = new RecoveryStore(inboxPath);
      gateway = new RemoteGateway({...gatewayOptions,store:inbox});
    },
  };
}

const catalogResult = (count = 40) => ({
  state: "success",
  complete: true,
  observedAt: Date.now() - 12000,
  models: Array.from({ length: count }, (_, index) => ({
    provider: "fixture",
    model: `model-${index}`,
  })),
});

test("signed catalog rejection is durable and refreshing resumes the original Task and Run", async (t) => {
  let malformed = true,
    collections = 0;
  const h = catalogHarness(t, async () => {
    collections++;
    const result = catalogResult();
    if (malformed) result.models[39] = result.models[0];
    return result;
  });
  const request = h.ledger.executionModels.pending("worker")[0];
  assert.equal(h.run.dispatchIssue.code, "EXECUTION_CATALOG_PENDING");
  const control = h.control();
  await control.pollNow();
  const blocked = h.ledger.getRun(h.run.runId);
  assert.equal(blocked.state, "queued");
  assert.equal(blocked.dispatchIssue.kind, "needs_action");
  assert.equal(blocked.dispatchIssue.code, "EXECUTION_CATALOG_FAILED");
  assert.match(blocked.dispatchIssue.message, /DUPLICATE_MODEL/);
  assert.match(blocked.dispatchIssue.message, /1\/2 pages/);
  assert.equal(blocked.currentAttemptId, undefined);
  const delivery = h.outbox.catalogDelivery("worker");
  assert.equal(delivery.error.kind, "rejected");
  assert.equal(delivery.error.code, "EXECUTION_CATALOG_DUPLICATE_MODEL");
  const firstRejection = await h.remote.completeExecutionModels(
    `catalog:${request.requestId}:1`,
    delivery.pages[1],
  );
  const replay = await h.remote.completeExecutionModels(
    `catalog:${request.requestId}:1`,
    delivery.pages[1],
  );
  assert.deepEqual(replay, firstRejection);
  assert.equal(replay.value.accepted, false);
  const view = await h.remote.executionModelView("worker");
  assert.equal(
    view.catalog.diagnostic.code,
    "EXECUTION_CATALOG_DUPLICATE_MODEL",
  );
  assert.equal(view.catalog.diagnostic.requestId, request.requestId);
  assert.equal(view.catalog.reason, "CATALOG_FAILED");
  malformed = false;
  await h.remote.executionModelView("worker", true);
  await control.pollNow();
  assert.equal(collections, 2);
  assert.equal(h.ledger.getRun(h.run.runId).dispatchIssue, undefined);
  assert.equal(h.ledger.executionModels.view("worker").catalog.state, "fresh");
  assert.deepEqual(
    await h.remote.completeExecutionModels(
      `catalog:${request.requestId}:1`,
      delivery.pages[1],
    ),
    firstRejection,
  );
  assert.equal(h.ledger.executionModels.view("worker").catalog.state, "fresh");
  const state = h.ledger.snapshot();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].taskId, h.task.taskId);
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].runId, h.run.runId);
  const claim = await h.remote.claim("claim-recovered", {
    runId: h.run.runId,
    nodeId: "worker",
    ttlMs: 1000,
  });
  assert.equal(claim.value.run.runId, h.run.runId);
  assert.equal(h.ledger.getRun(h.run.runId).state, "running");
});

test("signed page acknowledgement loss resumes the immutable command after control restart", async (t) => {
  let lost = false,
    collections = 0;
  const h = catalogHarness(
    t,
    async () => {
      collections++;
      return catalogResult(70);
    },
    async (envelope, send) => {
      const response = await send();
      if (
        envelope.operation === "completeExecutionModels" &&
        envelope.payload.page.index === 1 &&
        !lost
      ) {
        lost = true;
        throw new Error("Connection lost after commit");
      }
      return response;
    },
  );
  const first = h.control();
  await first.pollNow();
  assert.equal(h.outbox.catalogDelivery("worker").next, 1);
  assert.equal(h.outbox.catalogDelivery("worker").error.kind, "uncertain");
  assert.equal(
    h.ledger.executionModels.view("worker").catalog.progress.receivedPages,
    2,
  );
  await first.dispose();
  await h.control().pollNow();
  assert.equal(collections, 1);
  assert.equal(h.ledger.getRun(h.run.runId).dispatchIssue, undefined);
  assert.equal(
    h.ledger.executionModels.view("worker").catalog.snapshot.models.length,
    70,
  );
  const pages = h.arrivals.filter(
    (item) => item.operation === "completeExecutionModels",
  );
  assert.deepEqual(
    pages.map((item) => item.payload.page.index),
    [0, 1, 1, 2],
  );
  assert.equal(pages[1].commandId, pages[2].commandId);
  assert.deepEqual(pages[1].payload, pages[2].payload);
});

test("signed stale-generation rejection is definitive and cannot change the current request", async (t) => {
  const h = catalogHarness(t, async () => catalogResult());
  const request = h.ledger.executionModels.pending("worker")[0];
  const input = { ...request, result: catalogResult() };
  delete input.createdAt;
  delete input.expiresAt;
  input.generation++;
  const result = await h.remote.completeExecutionModels(
    "wrong-generation",
    input,
  );
  assert.deepEqual(result.value, {
    accepted: false,
    catalogError: { code: "EXECUTION_CATALOG_REQUEST_MISMATCH" },
  });
  assert.deepEqual(
    await h.remote.completeExecutionModels("wrong-generation", input),
    result,
  );
  assert.deepEqual(h.ledger.executionModels.pending("worker"), [request]);
  assert.equal(
    h.ledger.executionModels.view("worker").catalog.snapshot,
    undefined,
  );
});

test("catalog reconciliation preserves a durable negative outcome after an adapter acknowledgement failure", async (t) => {
  const h = catalogHarness(t, async () => catalogResult());
  const request = h.ledger.executionModels.pending("worker")[0];
  const result = catalogResult(1);
  result.models.push(result.models[0]);
  const input = {
    nodeId: "worker",
    requestId: request.requestId,
    generation: request.generation,
    result,
  };
  const complete = h.ledger.completeExecutionModels.bind(h.ledger);
  let calls = 0;
  h.ledger.completeExecutionModels = (...args) => {
    calls++;
    complete(...args);
    throw new Error("Adapter lost acknowledgement after ledger commit");
  };
  await assert.rejects(
    h.remote.completeExecutionModels("committed-rejection", input),
    { code: "REMOTE_OUTCOME_UNCERTAIN" },
  );
  const recovered = await h.remote.completeExecutionModels(
    "committed-rejection",
    input,
  );
  assert.deepEqual(recovered.value, {
    accepted: false,
    catalogError: { code: "EXECUTION_CATALOG_DUPLICATE_MODEL" },
  });
  assert.deepEqual(
    await h.remote.completeExecutionModels("committed-rejection", input),
    recovered,
  );
  assert.equal(calls, 1);
});

test("an arbitrary catalog adapter exception remains uncertain and cannot redispatch its command", async (t) => {
  const h = catalogHarness(t, async () => catalogResult());
  const request = h.ledger.executionModels.pending("worker")[0];
  const input = {
    nodeId: "worker",
    requestId: request.requestId,
    generation: request.generation,
    result: catalogResult(),
  };
  let calls = 0;
  h.ledger.completeExecutionModels = () => {
    calls++;
    throw new Error("Unknown adapter failure");
  };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      h.remote.completeExecutionModels("uncertain-catalog", input),
      { code: "REMOTE_OUTCOME_UNCERTAIN" },
    );
  }
  assert.equal(calls, 1);
  assert.deepEqual(h.ledger.executionModels.pending("worker"), [request]);
  assert.equal(
    h.ledger.executionModels.view("worker").catalog.snapshot,
    undefined,
  );
});

for (const [failure, issueCode, kind] of [
  ["TIMEOUT", "EXECUTION_CATALOG_TIMEOUT", "waiting"],
  ["CATALOG_UNSUPPORTED", "EXECUTION_CATALOG_UNSUPPORTED", "needs_action"],
]) {
  test(`${failure} remains actionable while retrying the original queued Run`, async (t) => {
    let failing = true;
    const h = catalogHarness(t, async () =>
      failing ? { state: "failure", code: failure } : catalogResult(),
    );
    const control = h.control();
    await control.pollNow();
    const blocked = h.ledger.getRun(h.run.runId);
    assert.equal(blocked.state, "queued");
    assert.equal(blocked.dispatchIssue.kind, kind);
    assert.equal(blocked.dispatchIssue.code, issueCode);
    assert.equal(blocked.dispatchIssue.action, "refresh_catalog");
    assert.match(blocked.dispatchIssue.message, new RegExp(failure));
    await h.remote.executionModelView("worker", true);
    assert.equal(
      h.ledger.executionModels.view("worker").catalog.reason,
      failure,
    );
    failing = false;
    await control.pollNow();
    assert.equal(h.ledger.getRun(h.run.runId).dispatchIssue, undefined);
    assert.equal(h.ledger.snapshot().tasks.length, 1);
    assert.equal(h.ledger.snapshot().runs.length, 1);
  });
}


for (const rejected of [false, true]) test(`generic receipt preserves ${rejected ? "rejected" : "accepted"} catalog completion before exact replay`, async t => {
  const h = catalogHarness(t, async () => catalogResult());
  const request = h.ledger.executionModels.pending("worker")[0];
  const result = catalogResult(1);
  if (rejected) result.models.push(result.models[0]);
  const input = {nodeId:"worker",requestId:request.requestId,generation:request.generation,result};
  const commandId = rejected ? "committed-negative" : "committed-positive";
  const complete = h.ledger.completeExecutionModels.bind(h.ledger);
  let applications = 0;
  h.ledger.completeExecutionModels = (...args) => {
    applications++;
    complete(...args);
    throw new Error("Lost adapter acknowledgement after authoritative commit");
  };
  await assert.rejects(h.remote.completeExecutionModels(commandId,input), {code:"REMOTE_OUTCOME_UNCERTAIN"});
  await h.restartGateway();
  const queried = await h.client.send("receipt", "query-"+commandId, {commandId});
  const expected = rejected ? {accepted:false,catalogError:{code:"EXECUTION_CATALOG_DUPLICATE_MODEL"}} : {accepted:true};
  assert.equal(queried.state,"done");
  assert.equal(queried.result.state,"done");
  assert.deepEqual(queried.result.result.value,expected,"generic receipt uses the original catalog wire contract");
  assert.deepEqual(h.inbox.receipt("worker",commandId).result.value,expected,"only the normalized result becomes durable done");
  const replay = await h.remote.completeExecutionModels(commandId,input);
  assert.deepEqual(replay.value,expected);
  assert.deepEqual(await h.remote.completeExecutionModels(commandId,input),replay);
  assert.equal(applications,1,"queries and exact retries do not reapply the ledger transaction");
});


test("legacy uncertain catalog receipt waits for authenticated exact replay after schema upgrade and restart", async t => {
  const h = catalogHarness(t,async()=>catalogResult());
  const request = h.ledger.executionModels.pending("worker")[0],result=catalogResult(1);
  result.models.push(result.models[0]);
  const input={nodeId:"worker",requestId:request.requestId,generation:request.generation,result};
  const complete=h.ledger.completeExecutionModels.bind(h.ledger);let applications=0;
  h.ledger.completeExecutionModels=(...args)=>{applications++;complete(...args);throw Error("Ledger committed before old gateway lost ACK");};
  await assert.rejects(h.remote.completeExecutionModels("legacy-completion",input),{code:"REMOTE_OUTCOME_UNCERTAIN"});
  await h.restartGateway(true);
  assert.equal(h.inbox.commandOperation("worker","legacy-completion"),undefined);
  const queried=await h.client.send("receipt","legacy-query",{commandId:"legacy-completion"});
  assert.equal(queried.result.state,"uncertain","unknown original operation cannot produce a guessed done value");
  assert.equal(h.inbox.receipt("worker","legacy-completion").state,"uncertain");
  const {signature,...original}=h.arrivals.find(e=>e.operation==="completeExecutionModels");
  const now=Date.now(),sequence=h.arrivals.at(-1).sequence+1;
  const changed=signEnvelope({...original,nonce:"legacy-conflicting-nonce",sequence,issuedAt:now,expiresAt:now+60000,payload:{...original.payload,generation:input.generation+1}},h.keys.privateKey);
  await assert.rejects(h.gateway.handle(JSON.stringify(changed)),{code:"COMMAND_CONFLICT"});
  assert.equal(h.inbox.commandOperation("worker","legacy-completion"),undefined,"a valid signature with conflicting fingerprint cannot fill provenance");
  await h.restartGateway();
  assert.equal(h.inbox.receipt("worker","legacy-completion").state,"uncertain");
  const expected={accepted:false,catalogError:{code:"EXECUTION_CATALOG_DUPLICATE_MODEL"}};
  assert.deepEqual((await h.remote.completeExecutionModels("legacy-completion",input)).value,expected);
  assert.equal(h.inbox.commandOperation("worker","legacy-completion"),"completeExecutionModels");
  await h.restartGateway();
  const final=await h.client.send("receipt","legacy-query-after-replay",{commandId:"legacy-completion"});
  assert.deepEqual(final.result.result.value,expected);
  assert.equal(applications,1);
});
