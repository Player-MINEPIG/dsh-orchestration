import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSessionCarrier, ProjectSessionOwnerCarrier } from "../dist/project-session-carrier.js";
import { TaskError } from "../dist/ledger.js";
import { RemoteClient, RemoteLedgerClient, RecoveryStore } from "../dist/remote/api.js";
import { parseCommandEnvelope, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_RESPONSE_BYTES } from "../dist/remote/protocol.js";

const binding = { kind: "native", projectId: "project", generation: 2, nodeId: "mbp", sessionId: "ordinary-session", workspaceId: "registry-project", workspaceRevision: "catalog-1", cwd: "/owner/project" };
const catalog = { revision: "catalog-1", available: true, workspaces: [{ workspaceId: "registry-project", label: "项目", path: "/owner/project" }] };
const ledger = database => ({ managementDatabase: () => database });
const authorize = node => { if (!["aws", "mbp"].includes(node)) throw new TaskError("FORBIDDEN", "Unknown owner"); };

for (const [name, text] of [
  ["backslashes", "\\".repeat(23_000)],
  ["quotes", '"'.repeat(23_000)],
  ["controls", "\u0000\n\r\t\b\f".repeat(3_000)],
  ["escaped Unicode", '"\\\u0000😀中'.repeat(1_900)],
]) {
  test(`owner exchanges ${name} within actual signed request and receipt limits after acknowledgement loss`, async t => {
    const centralDb = new DatabaseSync(":memory:"), ownerDb = new DatabaseSync(":memory:");
    const directory = mkdtempSync(join(tmpdir(), "project-carrier-wire-"));
    const store = new RecoveryStore(join(directory, "outbound.sqlite"));
    const central = new ProjectSessionCarrier(ledger(centralDb), "aws", async () => { throw Error("wrong device"); }, authorize);
    let commands = 0, executions = 0, lostPart, maxRequestBytes = 0, maxResponseBytes = 0;
    const sentParts = [];
    const client = new RemoteClient({
      endpoint: "https://fixture.invalid/commands", nodeId: "mbp", audience: "central",
      keyId: "test-key", privateKey: generateKeyPairSync("ed25519").privateKey, store,
      fetch: async (_url, options) => {
        maxRequestBytes = Math.max(maxRequestBytes, Buffer.byteLength(options.body));
        assert.ok(maxRequestBytes <= DEFAULT_MAX_BODY_BYTES);
        const envelope = parseCommandEnvelope(options.body, "ed25519");
        const input = envelope.payload.input.request.input;
        if (input.result) sentParts.push(input.result);
        const receipt = JSON.stringify({ commandId: envelope.commandId, state: "done", result: { value: central.exchange("mbp", input) } });
        maxResponseBytes = Math.max(maxResponseBytes, Buffer.byteLength(receipt));
        assert.ok(maxResponseBytes <= DEFAULT_MAX_RESPONSE_BYTES);
        return new Response(receipt, { headers: { "content-type": "application/json" } });
      },
    });
    const remote = new RemoteLedgerClient(client, "mbp");
    const owner = new ProjectSessionOwnerCarrier(ledger(ownerDb), async input => {
      const result = await remote.projectCollaborate("mbp", `exchange-${++commands}`, { action: "project-session", request: { kind: "exchange", input } });
      if (input.result && !lostPart) { lostPart = input.result; throw Error("lost acknowledgement"); }
      return result;
    }, () => catalog, async () => { executions++; return executions === 1 ? { text } : { ready: true }; });
    const input = { kind: "native", binding, operation: { kind: "native-capabilities" } };
    const callId = name + "\u0000".repeat(200 - name.length);
    const abort = new AbortController();
    const pending = central.request("mbp", callId, input, abort.signal);
    try {
      assert.ok(Buffer.byteLength(JSON.stringify({ text })) <= 48 * 1024);
      await owner.poll();
      await assert.rejects(owner.poll(), /lost acknowledgement/);
      await owner.poll();
      assert.deepEqual(sentParts[1], lostPart);
      for (let polls = 0; polls < 20 && !centralDb.prepare("SELECT result FROM project_session_carrier_calls WHERE id=?").get(callId).result; polls++) await owner.poll();
      assert.deepEqual(await pending, { text });
      assert.deepEqual(await central.request("mbp", callId, input), { text });
      assert.equal(executions, 1);
      const next = central.request("mbp", `${name}-next`, input, abort.signal);
      await owner.poll();
      await owner.poll();
      assert.deepEqual(await next, { ready: true });
      assert.equal(executions, 2);
      t.diagnostic(`${name} used at most ${maxRequestBytes} request bytes and ${maxResponseBytes} response bytes`);
    } finally {
      abort.abort();
      await pending.catch(() => {});
      await owner.dispose(); client.dispose(); store.close();
      centralDb.close(); ownerDb.close(); rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("local reads expire without polling while unfinished reads and mutation outcomes remain", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const db = new DatabaseSync(":memory:");
  let finishRead, finishMutation;
  const owner = new ProjectSessionOwnerCarrier(ledger(db), async () => ({}), () => catalog, async (_request, callId) => {
    if (callId === "unfinished-read") return new Promise(resolve => { finishRead = resolve; });
    if (callId === "unfinished-mutation") return new Promise(resolve => { finishMutation = resolve; });
    return { ready: true };
  });
  const read = { kind: "native", binding, operation: { kind: "native-capabilities" } };
  const mutation = { kind: "native", binding, operation: { kind: "session-prompt", requestId: "native-request", mode: "queue", content: [{ type: "text", text: "one input" }] } };
  try {
    await owner.perform(read, "expired-read");
    await owner.perform(mutation, "completed-mutation");
    void owner.perform(mutation, "unfinished-mutation");
    const unfinished = owner.perform(read, "unfinished-read");
    t.mock.timers.tick(120_001);
    await owner.perform(read, "fresh-read");
    assert.deepEqual(db.prepare("SELECT id FROM project_session_owner_calls ORDER BY id").all().map(row => row.id), ["completed-mutation", "fresh-read", "unfinished-mutation", "unfinished-read"]);
    await owner.poll();
    assert.ok(db.prepare("SELECT id FROM project_session_owner_calls WHERE id=?").get("unfinished-read"));
    finishRead({ ready: true });
    assert.deepEqual(await unfinished, { ready: true });
    t.mock.timers.tick(120_001);
    await owner.perform(read, "new-read");
    assert.deepEqual(db.prepare("SELECT id FROM project_session_owner_calls ORDER BY id").all().map(row => row.id), ["completed-mutation", "new-read", "unfinished-mutation"]);
  } finally { finishRead?.({ ready: true }); finishMutation?.({ ready: true }); await owner.dispose(); db.close(); }
});

test("owner polling preserves large Unicode results and an acknowledgement lost after commit", async () => {
  const centralDb = new DatabaseSync(":memory:"), ownerDb = new DatabaseSync(":memory:");
  const central = new ProjectSessionCarrier(ledger(centralDb), "aws", async () => { throw Error("wrong device"); }, authorize);
  let executions = 0, lost = false, packets = 0;
  const owner = new ProjectSessionOwnerCarrier(ledger(ownerDb), async input => {
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < 64 * 1024);
    packets++;
    const response = central.exchange("mbp", input);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 64 * 1024);
    if (input.result && !lost) { lost = true; throw Error("lost acknowledgement"); }
    return response;
  }, () => catalog, async request => {
    executions++;
    assert.equal(request.binding.sessionId, binding.sessionId);
    return { text: "真实原会话😀".repeat(12_000) };
  });
  owner.start(100);
  try {
    const input = { kind: "native", binding, operation: { kind: "native-capabilities" } };
    const result = await central.request("mbp", "large-read", input);
    assert.equal(result.text, "真实原会话😀".repeat(12_000));
    assert.equal(executions, 1);
    assert.ok(lost && packets > 5);
    assert.deepEqual(await central.request("mbp", "large-read", input), result);
    assert.equal(executions, 1);
    await assert.rejects(central.request("aws", "large-read", input), { code: "CONFLICT" });
    assert.equal(central.lookup("large-read").nodeId, "mbp");
  } finally { await owner.dispose(); centralDb.close(); ownerDb.close(); }
});

test("a lifecycle retry can recover from unavailability with the same immutable command", async () => {
  const db = new DatabaseSync(":memory:");
  let attempts = 0;
  const owner = new ProjectSessionOwnerCarrier(ledger(db), async () => ({}), () => catalog, async () => {
    if (++attempts === 1) throw new TaskError("UNAVAILABLE", "SDK is still starting");
    return { ready: true };
  });
  const request = { kind: "lifecycle", command: { kind: "status", operationId: "move", sessionId: binding.sessionId } };
  try {
    await assert.rejects(owner.perform(request, "status-retry"), { code: "UNAVAILABLE" });
    assert.deepEqual(await owner.perform(request, "status-retry"), { ready: true });
    assert.equal(attempts, 2);
  } finally { await owner.dispose(); db.close(); }
});

test("an interrupted native mutation is uncertain instead of executing again after restart", async () => {
  const db = new DatabaseSync(":memory:");
  let executions = 0, stopFirst;
  const request = { kind: "native", binding, operation: { kind: "session-prompt", requestId: "native-request", mode: "queue", content: [{ type: "text", text: "one input" }] } };
  const first = new ProjectSessionOwnerCarrier(ledger(db), async () => ({}), () => catalog, async () => { executions++; return new Promise((_resolve,reject) => { stopFirst = reject; }); });
  void first.perform(request, "native-command").catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const restarted = new ProjectSessionOwnerCarrier(ledger(db), async () => ({}), () => catalog, async () => { executions++; return { accepted: true }; });
  try {
    await assert.rejects(restarted.perform(request, "native-command"), { code: "PROJECT_SESSION_UNCERTAIN" });
    assert.equal(executions, 1);
    await assert.rejects(restarted.perform(request, "native-command"), { code: "PROJECT_SESSION_UNCERTAIN" });
    assert.equal(executions, 1);
  } finally { stopFirst?.(new TaskError("UNAVAILABLE", "Interrupted fixture stopped")); await first.dispose(); await restarted.dispose(); db.close(); }
});

test("bounded exchange refuses a foreign receipt and discards an expired read receipt", async () => {
  const db = new DatabaseSync(":memory:");
  const central = new ProjectSessionCarrier(ledger(db), "aws", async () => null, authorize);
  const abort = new AbortController();
  const pending = central.request("mbp", "bounded-read", { kind: "native", binding, operation: { kind: "native-capabilities" } }, abort.signal).catch(error => error);
  const part = { callId: "bounded-read", index: 0, count: 1, digest: "0".repeat(64), text: "{}" };
  assert.throws(() => central.exchange("aws", { result: part }), { code: "FORBIDDEN" });
  db.prepare("UPDATE project_session_carrier_calls SET expires=0 WHERE id=?").run("bounded-read");
  assert.equal(central.exchange("mbp", { result: part }).acknowledged.callId, "bounded-read");
  assert.equal(central.lookup("bounded-read"), undefined);
  assert.throws(() => central.exchange("mbp", { catalog: { ...catalog, workspaces: Array.from({ length: 20 }, (_, i) => ({ workspaceId: `workspace-${i}`, label: "项目", path: "/" + "路".repeat(4000) })) } }), { code: "PROJECT_SESSION_SIZE" });
  abort.abort();
  await pending;
  db.close();
});

test('carrier stop drains durable local outcomes and parked waiters never query a closed database',async()=>{
 const db=new DatabaseSync(':memory:');let finish,entered;const started=new Promise(resolve=>entered=resolve);const owner=new ProjectSessionOwnerCarrier(ledger(db),async()=>({}),()=>catalog,async()=>{entered();return new Promise(resolve=>finish=resolve);});const central=new ProjectSessionCarrier(ledger(db),'mbp',(request,callId)=>owner.perform(request,callId),authorize);const request={kind:'native',binding,operation:{kind:'file-upload-finish',uploadId:'fixture-upload'}};const pending=central.request('mbp','stop-inflight',request).then(value=>({value}),error=>({code:error.code}));await started;let drained=false;const stopping=Promise.all([central.dispose(),owner.dispose()]).then(()=>drained=true);await Promise.resolve();assert.equal(drained,false);await assert.rejects(central.request('mbp','late-request',request),{code:'UNAVAILABLE'});await assert.rejects(owner.perform(request,'late-owner'),{code:'UNAVAILABLE'});finish({receiptId:'durable-fixture-receipt'});await stopping;assert.ok(db.prepare('SELECT result FROM project_session_owner_calls WHERE id=?').get('stop-inflight').result);assert.ok(db.prepare('SELECT result FROM project_session_carrier_calls WHERE id=?').get('stop-inflight').result);db.close();assert.deepEqual(await pending,{code:'PROJECT_SESSION_PENDING'});
});
