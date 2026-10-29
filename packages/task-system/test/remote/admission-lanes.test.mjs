import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IdentityVerifier, RecoveryStore, RemoteClient, RemoteGateway, TrustedNetworkVerifier, signEnvelope } from '../../dist/remote/api.js';

const keys = generateKeyPairSync('ed25519');
const peer = { keyId: 'lanes', nodeId: 'worker', audience: 'central', publicKey: keys.publicKey, operations: ['submit', 'listWork', 'projectCollaborate'], workspaces: ['workspace'], capabilities: [] };
const owner = { input: { action: 'project-session', request: { kind: 'exchange', input: {} } } };
function envelope(sequence, commandId, operation = 'listWork', payload = {}, overrides = {}) {
  return signEnvelope({ version: 1, keyId: peer.keyId, nodeId: peer.nodeId, audience: peer.audience, sequence, commandId, nonce: `nonce-${commandId}-${sequence}`, issuedAt: Date.now(), expiresAt: Date.now() + 60000, operation, payload, ...overrides }, keys.privateKey);
}
function fixture(t, { file = ':memory:', collaborate = () => ({}), verifier = new IdentityVerifier({ audience: 'central', peers: [peer] }) } = {}) {
  const store = new RecoveryStore(file);
  let settlements = 0;
  const run = { runId: 'run', state: 'running', route: { nodeId: 'worker', workspaceId: 'workspace', requiredCapabilities: [] } };
  const ledger = {
    pendingRuns: () => [], nodeStatuses: () => [{ nodeId: 'worker', enabled: true }],
    getRun: () => run,
    getAttempt: () => ({ runId: 'run', nodeId: 'worker', fence: 1, state: 'running', leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }),
    projectCollaborate: (_node, _command, input) => collaborate(input),
    submit: commandId => { settlements++; return { commandId, acceptedAt: new Date().toISOString(), value: { ...run, state: 'succeeded' } }; },
  };
  const gateway = new RemoteGateway({ role: 'planner', nodeId: 'central', verifier, store, ledger, maxBodyBytes: 1024 * 1024 });
  t.after(async () => { await gateway.dispose(); store.close(); });
  return { store, gateway, settlements: () => settlements };
}
function client(t, fetch) {
  const outbox = new RecoveryStore(':memory:');
  const value = new RemoteClient({ endpoint: 'https://lanes.invalid/commands', nodeId: 'worker', audience: 'central', keyId: peer.keyId, privateKey: keys.privateKey, store: outbox, fetch, maxBodyBytes: 1024 * 1024 });
  t.after(async () => { await value.dispose(); outbox.close(); });
  return value;
}
async function response(gateway, body) {
  try { return new Response(JSON.stringify(await gateway.handle(body))); }
  catch (error) { return new Response(JSON.stringify({ error: error.code }), { status: error.status }); }
}

test('continuous owner traffic cannot starve one client large durable result or execute it twice', async t => {
  const f = fixture(t), wire = []; let c, ownerCalls = 0;
  c = client(t, async (_url, options) => {
    const e = JSON.parse(options.body); wire.push(e);
    if (e.operation === 'submit') {
      assert.ok(Buffer.byteLength(options.body) > 300000);
      for (let i = 0; i < 3; i++) assert.equal((await c.send('projectCollaborate', `owner-${++ownerCalls}`, owner)).state, 'done');
    }
    return response(f.gateway, options.body);
  });
  const result = { runId: 'run', attemptId: 'attempt', fence: 1, outcome: 'success', summary: 'Synthetic durable result', report: { title: 'Fixture', body: 'Fixture', data: { content: 'x'.repeat(320000) } } };
  assert.equal((await c.send('submit', 'result-original-execution', result)).state, 'done');
  assert.equal(f.settlements(), 1); assert.equal(ownerCalls, 3);
  assert.equal(wire.filter(e => e.operation === 'submit').length, 1);
  assert.equal((await c.send('submit', 'result-original-execution', result)).state, 'done');
  assert.equal(f.settlements(), 1);
});

test('owner responses remain independent while a default project request awaits them', { timeout: 2000 }, async t => {
  let ready, finish;
  const entered = new Promise(resolve => ready = resolve);
  const pending = new Promise(resolve => finish = resolve);
  const f = fixture(t, { collaborate: input => {
    if (input.action === 'status') { ready(); return pending; }
    finish({ complete: true }); return {};
  } });
  const c = client(t, (_url, options) => response(f.gateway, options.body));
  const request = c.send('projectCollaborate', 'await-owner', { input: { action: 'status', sessionId: 'session', cwd: '/fixture' } });
  await entered;
  assert.equal((await c.send('projectCollaborate', 'independent-owner', owner)).state, 'done');
  assert.equal((await request).state, 'done');
});

test('each lane rejects its own reversed sequence while nonce and command identity remain node-global', async t => {
  const f = fixture(t);
  await f.gateway.handle(JSON.stringify(envelope(10, 'owner10', 'projectCollaborate', owner)));
  const application = { input: { action: 'project-session', request: { kind: 'application', input: { kind: 'execution-settings', projectId: 'fixture-project' } } } };
  await f.gateway.handle(JSON.stringify(envelope(8, 'application8', 'projectCollaborate', application)));
  await f.gateway.handle(JSON.stringify(envelope(5, 'default5')));
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope(7, 'application7', 'projectCollaborate', application))), { code: 'OUT_OF_ORDER' });
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope(4, 'default4'))), { code: 'OUT_OF_ORDER' });
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope(9, 'owner9', 'projectCollaborate', owner))), { code: 'OUT_OF_ORDER' });
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope(11, 'other-owner', 'projectCollaborate', owner, { nonce: 'nonce-default5-5' }))), { code: 'REPLAY' });
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope(12, 'default5', 'projectCollaborate', owner))), { code: 'COMMAND_CONFLICT' });
});

test('legacy baseline is frozen for unused lanes across owner traffic and restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-baseline-')), file = join(dir, 'store.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE peer_sequences(node TEXT PRIMARY KEY,sequence INTEGER NOT NULL); INSERT INTO peer_sequences VALUES('worker',100)"); legacy.close();
  let store = new RecoveryStore(file);
  store.admit(envelope(102, 'owner102', 'projectCollaborate', owner), Date.now()); store.close();
  store = new RecoveryStore(file);
  assert.equal(store.admit(envelope(101, 'default101'), Date.now()), undefined);
  assert.throws(() => store.admit(envelope(101, 'default-old'), Date.now()), { code: 'OUT_OF_ORDER' });
  store.admit(envelope(103, 'owner103', 'projectCollaborate', owner), Date.now()); store.close();
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare("SELECT sequence FROM peer_sequences WHERE node='worker'").get().sequence, 103); db.close();
});

test('new lane baselines also respect commands accepted during an older receiver rollback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'admission-rollback-')), file = join(dir, 'store.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new RecoveryStore(file); store.admit(envelope(10, 'owner10', 'projectCollaborate', owner), Date.now()); store.close();
  const legacy = new DatabaseSync(file); legacy.prepare("UPDATE peer_sequences SET sequence=20 WHERE node='worker'").run(); legacy.close();
  store = new RecoveryStore(file);
  assert.throws(() => store.admit(envelope(19, 'old-default'), Date.now()), { code: 'OUT_OF_ORDER' });
  assert.throws(() => store.admit(envelope(19, 'old-owner', 'projectCollaborate', owner), Date.now()), { code: 'OUT_OF_ORDER' });
  store.admit(envelope(21, 'new-default'), Date.now()); store.close();
});

test('invalid signatures and payloads cannot advance a lane admission sequence', async t => {
  const f = fixture(t);
  const invalid = envelope(1000, 'bad-signature', 'projectCollaborate', owner); invalid.payload = {};
  await assert.rejects(f.gateway.handle(JSON.stringify(invalid)), { code: 'BAD_SIGNATURE' });
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope(1001, 'bad-payload', 'projectCollaborate', {}))), { code: 'PAYLOAD_FIELDS' });
  assert.equal((await f.gateway.handle(JSON.stringify(envelope(1, 'valid-owner', 'projectCollaborate', owner)))).state, 'done');
});


test('unchanged trusted-network sender envelopes use independent receiver lanes', async t => {
  const port = 49152, address = '127.0.0.1';
  const verifier = new TrustedNetworkVerifier({ audience: 'central', listen: { address, port }, allowHttp: true, allowedAddresses: [address], peers: [{ address, nodeId: peer.nodeId, role: 'executor', audience: peer.audience, operations: peer.operations, workspaces: peer.workspaces, capabilities: [] }] });
  const f = fixture(t, { verifier });
  const wire = (...args) => {
    const { signature, keyId, ...value } = envelope(...args);
    return JSON.stringify({ ...value, version: 2, authMode: 'trusted-network' });
  };
  const transport = { remoteAddress: address, localAddress: address, localPort: port };
  await f.gateway.handle(wire(10, 'network-owner', 'projectCollaborate', owner), transport);
  assert.equal((await f.gateway.handle(wire(5, 'network-default'), transport)).state, 'done');
  await assert.rejects(f.gateway.handle(wire(4, 'network-old-default'), transport), { code: 'OUT_OF_ORDER' });
});
