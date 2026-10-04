import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskLedger } from '../../packages/task-system/dist/index.js';
import {
  RecoveryStore, RemoteGateway, RemoteClient, RemoteLedgerClient, ExecutorWorker,
  IdentityVerifier, TrustedNetworkVerifier, nativeExecutionAdapter, httpHandler,
  validatePayload, parseEnvelope, byteLimit, MAX_WIRE_BYTES,
} from '../../packages/task-system/dist/remote/api.js';
import * as protocol from '../../packages/task-system/dist/remote/protocol.js';
import { validateSource } from '../../scripts/task-management-acceptance.mjs';
import { createNativeHarness } from '../dsh/native-harness.mjs';

const missingRoute = { provider: 'unmounted-provider', model: 'configured-model' };
const operations = ['listWork', 'claim', 'renew', 'submit', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt'];
const grants = { nodeId: 'worker', audience: 'planner', operations, workspaces: ['workspace'], capabilities: [] };
const nested = (depth, leaf = null, key = 'value') => {
  let value = leaf;
  for (let index = 0; index < depth; index++) value = { [key]: value };
  return value;
};
const template = overrides => ({ templateId: 'depth-fixture', version: 1, name: 'Bounded schema fixture', description: '', defaults: {}, inputSchema: { type: 'object' }, resultContract: { type: 'object' }, ...overrides });
function localLedger(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-schema-boundary-')));
  const ledger = TaskLedger.open(join(root, 'ledger.sqlite'), { role: 'planner', nodeId: 'planner' });
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return ledger;
}

// The private source export is deliberately external to this repository. These
// tests use isolated SQLite files and loopback only, and never run its workload.
for (const authMode of ['ed25519', 'trusted-network']) {
  test(`${authMode}: exact external Template survives claim, receipt replay and reopened native worker journals`,
    { skip: !process.env.DSH_ACCEPTANCE_SOURCE_EXPORT }, async t => {
      const source = JSON.parse(readFileSync(realpathSync(process.env.DSH_ACCEPTANCE_SOURCE_EXPORT), 'utf8'));
      validateSource(source);
      const originalTemplate = structuredClone(source.template);
      const h = await createNativeHarness({ config: { role: 'executor', nodeId: 'worker' } });
      const ledger = TaskLedger.open(join(h.dir, 'authority.sqlite'), { role: 'planner', nodeId: 'planner' });
      const paths = Object.fromEntries(['server', 'client', 'worker'].map(name => [name, join(h.dir, `${name}-schema.sqlite`)]));
      let serverStore = new RecoveryStore(paths.server), clientStore = new RecoveryStore(paths.client), workerStore = new RecoveryStore(paths.worker);
      let gateway, client, worker, handler;
      let requests = 0, providerEntries = 0;
      const nativeEvents = [];
      h.ctx.on('session/event', (_session, event) => nativeEvents.push(event));
      const server = http.createServer((req, res) => { requests++; void handler(req, res); });
      t.after(async () => {
        await worker?.dispose(); await client?.dispose(); await gateway?.dispose();
        if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        serverStore.close(); clientStore.close(); workerStore.close(); ledger.close(); await h.dispose();
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const port = server.address().port;
      const networkPolicy = { listen: { address: '127.0.0.1', port }, allowHttp: true, allowedAddresses: ['127.0.0.1'], peers: [{ ...grants, address: '127.0.0.1', role: 'executor' }] };
      // Disposable test signing identity; no credential is saved or configured.
      const keys = authMode === 'ed25519' ? generateKeyPairSync('ed25519') : undefined;
      const peer = keys ? { ...grants, keyId: 'schema-fixture-key', publicKey: keys.publicKey } : undefined;
      const connect = () => {
        const verifier = authMode === 'ed25519'
          ? new IdentityVerifier({ audience: 'planner', peers: [peer] })
          : new TrustedNetworkVerifier({ audience: 'planner', ...networkPolicy });
        gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: serverStore, verifier });
        handler = httpHandler(gateway, authMode === 'ed25519' ? { allowLoopbackHttp: true } : { trustedNetwork: networkPolicy });
        client = new RemoteClient({ endpoint: `http://127.0.0.1:${port}/commands`, nodeId: 'worker', audience: 'planner', store: clientStore,
          ...(authMode === 'ed25519' ? { keyId: peer.keyId, privateKey: keys.privateKey, allowLoopbackHttp: true }
            : { authMode, trustedNetwork: { address: '127.0.0.1', port, localAddress: '127.0.0.1', allowHttp: true } }) });
        return new RemoteLedgerClient(client, 'worker');
      };
      ledger.registerWorkspace('workspace', { workspaceId: 'workspace', nodeId: 'worker', path: h.dir, label: 'Isolated schema regression', state: 'ready', createdAt: new Date().toISOString() });
      ledger.registerNode('node', { nodeId: 'worker', roles: ['executor'], capabilities: [], models: [{ ...missingRoute, reasoningEfforts: [] }], workspaceIds: ['workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
      ledger.updateTemplate('source-template', source.template);
      const task = ledger.createTask('task', { title: 'Exact exported schema transport regression', workspaceId: 'workspace', policy: { allowedTools: [], maxRuntimeMs: 10000 } }).value;
      const run = ledger.createRun('run', { taskId: task.taskId, route: { nodeId: 'worker', ...missingRoute, workspaceId: 'workspace', requiredCapabilities: [] },
        configuration: { templateRef: { templateId: source.template.templateId, version: source.template.version }, input: source.schedule.input } }).value;
      let remote = connect();
      assert.equal(run.state, 'queued');
      assert.equal(ledger.snapshot().attempts.length, 0);
      const payload = { runId: run.runId, ttlMs: 60000 };
      const receipt = await client.send('claim', 'exact-source-claim', payload);
      assert.equal(receipt.state, 'done', 'claim must serialize after committing its durable Attempt');
      const claim = receipt.result.value;
      assert.deepEqual(claim.executionContext.template, originalTemplate);
      assert.deepEqual(claim.run.configuration.input, source.schedule.input);
      assert.equal(ledger.snapshot().attempts.length, 1);
      assert.deepEqual(serverStore.receipt('worker', 'exact-source-claim'), receipt);
      assert.equal(clientStore.outbound('exact-source-claim').state, 'done');
      assert.deepEqual(clientStore.outbound('exact-source-claim').receipt, receipt);
      assert.equal(workerStore.dispatches().length, 0);

      await client.dispose(); await gateway.dispose(); serverStore.close(); clientStore.close();
      serverStore = new RecoveryStore(paths.server); clientStore = new RecoveryStore(paths.client);
      remote = connect();
      const beforeCachedReplay = requests;
      assert.deepEqual(await client.send('claim', 'exact-source-claim', payload), receipt);
      assert.equal(requests, beforeCachedReplay, 'reopened outbound journal supplies its stored receipt');
      const receiptRead = await client.send('receipt', 'read-exact-source-claim', { commandId: 'exact-source-claim' });
      assert.equal(receiptRead.state, 'done');
      assert.deepEqual(receiptRead.result, receipt);
      // A fresh authenticated envelope, same command ID, must read the gateway's
      // durable receipt rather than creating another Attempt.
      const now = Date.now();
      const common = { nodeId: 'worker', audience: 'planner', commandId: 'exact-source-claim', nonce: 'schema-replay', sequence: clientStore.nextSequence('worker'), issuedAt: now, expiresAt: now + 60000, operation: 'claim', payload };
      const replayEnvelope = authMode === 'ed25519'
        ? protocol.signEnvelope({ version: 1, keyId: peer.keyId, ...common }, keys.privateKey)
        : { version: 2, authMode, ...common };
      assert.deepEqual(await gateway.handle(JSON.stringify(replayEnvelope), authMode === 'trusted-network' ? { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: port } : undefined), receipt);
      assert.equal(ledger.snapshot().attempts.length, 1);

      const native = nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: missingRoute.provider, models: [{ model: missingRoute.model, reasoningEfforts: [] }], capabilities: [] });
      worker = new ExecutorWorker({ ledger: remote, store: workerStore, policy: { role: 'executor', nodeId: 'worker', capabilities: [], workspaces: [{ workspaceId: 'workspace', nodeId: 'worker', path: h.dir, allowedRoot: h.dir }] },
        provider: { ...native, async execute(request) {
          providerEntries++;
          const intent = workerStore.dispatch(request.claim.attempt.attemptId);
          assert.equal(intent.state, 'dispatching', 'deep Template must persist before native provider entry');
          assert.deepEqual(intent.claim.executionContext.template, originalTemplate);
          return native.execute(request);
        } } });
      const dispatch = await worker.execute(run.runId, 'exact-source-claim');
      assert.equal(dispatch.state, 'acknowledged');
      assert.equal(dispatch.result.outcome, 'blocked');
      assert.deepEqual(dispatch.result.preDispatchFailure, { kind: 'native-provider-unavailable-v1', code: 'NO_ADAPTER', ...missingRoute });
      assert.equal(dispatch.result.report, undefined);
      assert.equal(providerEntries, 1);
      assert.equal(nativeEvents.length, 0, 'missing adapter creates no native session');
      assert.equal(h.adapter.requests.length, 0, 'no model or original game workload was invoked');
      assert.equal(ledger.getRun(run.runId).state, 'blocked');
      assert.equal(ledger.getAttempt(claim.attempt.attemptId).sessionId, dispatch.sessionId, 'worker reserves an identity; native session events above prove no session was created');
      assert.equal(ledger.history(task.taskId).reports.length, 0);
      assert.equal(ledger.history(task.taskId).events.filter(event => event.type === 'run.pre_dispatch_failed').length, 1);
      assert.deepEqual(await worker.execute(run.runId, 'exact-source-claim'), dispatch);
      assert.equal(providerEntries, 1);
      await worker.dispose(); worker = undefined; workerStore.close();
      workerStore = new RecoveryStore(paths.worker);
      assert.deepEqual(workerStore.dispatch(claim.attempt.attemptId), dispatch);
      assert.deepEqual(workerStore.recoverDispatches(), [dispatch]);
      assert.deepEqual(workerStore.dispatch(claim.attempt.attemptId).claim.executionContext.template, originalTemplate);
      assert.deepEqual(ledger.getTemplate(source.template.templateId, source.template.version), originalTemplate);
      assert.equal(ledger.snapshot().attempts.length, 1);
    });
}

test('read-only external live claim fixture fits real wire/storage wrappers without altering bytes or schemas',
  { skip: !process.env.DSH_ACCEPTANCE_CLAIM_FIXTURE }, () => {
    const path = realpathSync(process.env.DSH_ACCEPTANCE_CLAIM_FIXTURE);
    const originalBytes = readFileSync(path);
    assert.equal(originalBytes.length, 13231);
    const durableReceipt = JSON.parse(originalBytes.toString('utf8'));
    const originalReceipt = structuredClone(durableReceipt);
    const originalTemplate = structuredClone(durableReceipt.value.executionContext.template);
    assert.throws(() => protocol.canonicalData(durableReceipt), /MAX_DEPTH/, 'the former depth-16 transport codec rejected this actual durable receipt');
    const commandId = 'codec-only-never-transmitted';
    const gatewayReceipt = { commandId, state: 'done', result: durableReceipt };
    const receiptRead = { commandId: 'codec-only-receipt-read', state: 'done', result: gatewayReceipt };
    const outbound = receipt => ({ sender: 'codec-only-worker', audience: 'codec-only-planner', endpoint: 'https://codec-only.invalid/commands',
      authMode: 'ed25519', authBinding: 'codec-only', digest: 'codec-only', operation: 'claim',
      payload: { runId: durableReceipt.value.run.runId, ttlMs: 60000 }, state: 'done', receipt });
    // Pure serialization only: never seed, submit, replay, or persist this
    // fixture's real identities into a TaskLedger, gateway, or recovery store.
    for (const value of [durableReceipt, gatewayReceipt, outbound(gatewayReceipt), receiptRead, outbound(receiptRead)]) {
      const decoded = JSON.parse(protocol.canonical(value));
      assert.deepEqual(decoded, value, 'wire encoding preserves every field and value');
    }
    for (const field of ['inputSchema', 'resultContract']) {
      assert.deepEqual(JSON.parse(protocol.canonicalSchema(originalTemplate[field])), originalTemplate[field]);
    }
    assert.deepEqual(durableReceipt, originalReceipt);
    assert.deepEqual(durableReceipt.value.executionContext.template, originalTemplate);
    assert.deepEqual(readFileSync(path), originalBytes, 'external fixture bytes remain untouched');
  });

test('ordinary JSON, Template schemas and transport each retain their explicit depth ceiling', () => {
  for (const [codec, limit] of [[protocol.canonicalData, 16], [protocol.canonicalSchema, 24], [protocol.canonical, 32]]) {
    assert.doesNotThrow(() => codec(nested(limit)));
    assert.throws(() => codec(nested(limit + 1)), /MAX_DEPTH/);
    assert.doesNotThrow(() => codec(Array(256).fill(null)));
    assert.throws(() => codec(Array(257).fill(null)), /ARRAY_LIMIT/);
    assert.doesNotThrow(() => codec(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`field${i}`, null]))));
    assert.throws(() => codec(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`field${i}`, null]))), /INVALID_KEYS/);
    for (const key of ['__proto__', 'prototype', 'constructor']) assert.throws(() => codec(JSON.parse(`{"${key}":null}`)), /INVALID_KEYS/);
    assert.throws(() => codec({ value: Infinity }), /INVALID_NUMBER/);
  }
  assert.throws(() => parseEnvelope('x'.repeat(65537)), /BODY_LIMIT/);
  assert.throws(() => byteLimit(MAX_WIRE_BYTES + 1, 65536), /INVALID_BYTE_LIMIT/);
});

test('Template registration accepts schema depth 24 but rejects schema depth 25 and ordinary defaults depth 17', t => {
  const ledger = localLedger(t);
  const valid = template({ resultContract: nested(24, true, 'not') });
  ledger.updateTemplate('schema-at-limit', valid);
  assert.deepEqual(ledger.getTemplate(valid.templateId, valid.version), valid);
  for (const field of ['inputSchema', 'resultContract']) {
    assert.throws(() => ledger.updateTemplate(`deep-${field}`, template({ templateId: `deep-${field}`, [field]: nested(25, true, 'not') })), { code: 'INVALID_SCHEMA' });
  }
  assert.throws(() => ledger.updateTemplate('deep-defaults', template({ templateId: 'deep-defaults', defaults: nested(17) })), /MAX_DEPTH|depth/i);
  assert.equal(ledger.snapshot().templates.length, 1, 'rejected schemas/defaults do not persist a Template');
});

test('actual Run input and remote report/delegation data keep the ordinary depth 16 bound', t => {
  const ledger = localLedger(t);
  const task = ledger.createTask('task', { title: 'Bounded ordinary input' }).value;
  assert.doesNotThrow(() => ledger.createRun('input-at-limit', { taskId: task.taskId, configuration: { input: nested(16) } }));
  assert.throws(() => ledger.createRun('input-too-deep', { taskId: task.taskId, configuration: { input: nested(17) } }), /MAX_DEPTH|depth/i);
  const owned = { runId: 'run', attemptId: 'attempt', fence: 1, executionId: 'owner' };
  for (const depth of [16, 17]) {
    const report = { title: 'Bounded report', body: 'Boundary only', data: nested(depth) };
    const inputs = [
      { operation: 'submit', payload: { ...owned, outcome: 'failure', summary: 'Boundary only', report } },
      { operation: 'taskReport', payload: { ...owned, ...report } },
      { operation: 'delegate', payload: { ...owned, title: 'Bounded delegated input', configuration: { input: nested(depth) } } },
    ];
    for (const input of inputs) {
      const check = () => validatePayload({ nodeId: 'worker', ...input });
      if (depth === 16) assert.doesNotThrow(check);
      else assert.throws(check, /MAX_DEPTH/);
    }
  }
});

test('over-bound legacy Template or Run rows fail context resolution and roll back new runs and claims', t => {
  const cases = [
    ['inputSchema', 'template', nested(25, false, 'not')],
    ['resultContract', 'template', nested(25, true, 'not')],
    ['defaults', 'template', nested(17)],
    ['input', 'run', nested(17)],
    ['trigger', 'run', nested(17)],
  ];
  for (const [field, kind, badValue] of cases) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-legacy-schema-')));
    const path = join(root, 'ledger.sqlite');
    const now = Date.now();
    const ledger = TaskLedger.open(path, { role: 'planner', nodeId: 'planner', now: () => now });
    const legacy = new DatabaseSync(path);
    t.after(() => { legacy.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
    ledger.registerNode('node', { nodeId: 'worker', roles: ['executor'], capabilities: [], models: [{ ...missingRoute, reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    ledger.updateTemplate('template', template());
    const task = ledger.createTask('task', { title: 'Legacy bounds rollback fixture', policy: { requiredResources: ['schema-test-resource'] } }).value;
    const route = { nodeId: 'worker', ...missingRoute, requiredCapabilities: [] };
    const configuration = { templateRef: { templateId: 'depth-fixture', version: 1 }, input: {} };
    const run = ledger.createRun('original-run', { taskId: task.taskId, route, configuration }).value;
    // Simulate an already-persisted older row in this synthetic database only.
    // New registration/run APIs above cannot create this over-bound content.
    const id = kind === 'template' ? 'depth-fixture@1' : run.runId;
    const row = JSON.parse(legacy.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, id).data);
    if (kind === 'template') row[field] = badValue;
    else row.configuration[field] = badValue;
    assert.equal(legacy.prepare('UPDATE entities SET data=? WHERE kind=? AND id=?').run(JSON.stringify(row), kind, id).changes, 1);
    const before = ledger.snapshot();
    assert.throws(() => ledger.executionContext(run.runId), /MAX_DEPTH/, `${kind}.${field} must fail before consumer dispatch`);
    const nextConfiguration = kind === 'template' ? configuration : { ...configuration, [field]: badValue };
    assert.throws(() => ledger.createRun('rejected-new-run', { taskId: task.taskId, route, configuration: nextConfiguration }), /MAX_DEPTH/);
    assert.equal(ledger.commandReceipt('rejected-new-run'), undefined);
    assert.throws(() => ledger.claim('rejected-claim', { runId: run.runId, nodeId: 'worker', ttlMs: 60000 }), /MAX_DEPTH/);
    assert.equal(ledger.commandReceipt('rejected-claim'), undefined);
    assert.equal(ledger.getRun(run.runId).state, 'queued');
    assert.equal(ledger.getRun(run.runId).currentAttemptId, undefined);
    assert.equal(ledger.snapshot().attempts.length, 0);
    assert.equal(legacy.prepare('SELECT COUNT(*) AS total FROM resources').get().total, 0, 'failed claim rolls back resource leases');
    assert.deepEqual(ledger.snapshot(), before, 'failed context validation leaves no new Run, Attempt, event, or task state');
  }
});
