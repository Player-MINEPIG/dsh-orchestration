import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteClient, RemoteGateway, RecoveryStore, IdentityVerifier } from '../../dist/remote/api.js';
const keys = generateKeyPairSync('ed25519');
const peer = { keyId: 'ordering-fixture', nodeId: 'worker', audience: 'central', publicKey: keys.publicKey, operations: ['listWork'], workspaces: [], capabilities: [] };
function client(store, fetch) {
  return new RemoteClient({ endpoint: 'https://ordering.invalid/commands', nodeId: 'worker', audience: 'central', keyId: peer.keyId, privateKey: keys.privateKey, store, fetch });
}
function response(error = 'OUT_OF_ORDER', status = 409) { return new Response(JSON.stringify({ error }), { status }); }
test('two RemoteClient instances sharing SQLite recover reversed arrival with identical business input and fresh envelope identity', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'client-ordering-'));
  const store1 = new RecoveryStore(join(dir, 'outbox.sqlite')), store2 = new RecoveryStore(join(dir, 'outbox.sqlite')), central = new RecoveryStore(join(dir, 'central.sqlite'));
  let reads = 0;
  const gateway = new RemoteGateway({ role: 'planner', nodeId: 'central', verifier: new IdentityVerifier({ audience: 'central', peers: [peer] }), store: central, ledger: { pendingRuns() { reads++; return []; } } });
  let releaseFirst, enteredFirst;
  const firstEntered = new Promise(resolve => enteredFirst = resolve), holdFirst = new Promise(resolve => releaseFirst = resolve);
  const wire = [], arrivals = [];
  const fetch = async (_url, options) => {
    const envelope = JSON.parse(options.body); wire.push(envelope);
    if (envelope.commandId === 'first' && wire.filter(e => e.commandId === 'first').length === 1) { enteredFirst(); await holdFirst; }
    arrivals.push(envelope.sequence);
    try { return new Response(JSON.stringify(await gateway.handle(options.body))); }
    catch (error) { return response(error.code, error.status); }
  };
  const one = client(store1, fetch), two = client(store2, fetch);
  t.after(async () => { releaseFirst(); await one.dispose(); await two.dispose(); await gateway.dispose(); store1.close(); store2.close(); central.close(); rmSync(dir, { recursive: true, force: true }); });
  const first = one.send('listWork', 'first', {});
  await firstEntered;
  assert.equal((await two.send('listWork', 'second', {})).state, 'done');
  releaseFirst();
  assert.equal((await first).state, 'done');
  assert.deepEqual(arrivals, [2, 1, 3]);
  const retries = wire.filter(e => e.commandId === 'first');
  assert.equal(retries.length, 2); assert.deepEqual(retries.map(e => e.payload), [{}, {}]);
  assert.deepEqual(retries.map(e => e.sequence), [1, 3]); assert.notEqual(retries[0].nonce, retries[1].nonce);
  assert.equal(reads, 2); // The rejected envelope never enters the ledger.
  assert.equal((await one.send('listWork', 'first', {})).state, 'done');
  assert.equal(wire.length, 3); // The successful result replays locally.
});
test('ordering retry is bounded to three total attempts and preserves diagnostic and legacy failure surfaces', async t => {
  const store = new RecoveryStore(':memory:'); let wire = [];
  const c = client(store, async (_url, options) => { wire.push(JSON.parse(options.body)); return response(); });
  t.after(async () => { await c.dispose(); store.close(); });
  assert.equal((await c.send('listWork', 'bounded', {})).state, 'uncertain');
  assert.equal(wire.length, 3); assert.equal(new Set(wire.map(e => e.nonce)).size, 3);
  assert.deepEqual(wire.map(e => e.sequence), [1, 2, 3]);
  assert.ok(wire.every(e => e.commandId === 'bounded' && JSON.stringify(e.payload) === '{}'));
  wire = [];
  await assert.rejects(c.send('listWork', 'diagnostic-bounded', {}, { diagnostic: true }), { code: 'OUT_OF_ORDER', status: 409 });
  assert.equal(wire.length, 3);
});
test('unknown network outcomes, ambiguous server errors and unrelated conflicts are never automatically replayed', async t => {
  for (const [name, fetch] of [
    ['network-after-possible-commit', async () => { throw new Error('connection lost after server may have committed'); }],
    ['server-failure', async () => response('OUT_OF_ORDER', 503)],
    ['unrelated-conflict', async () => response('COMMAND_CONFLICT', 409)],
    ['oversized-rejection', async () => new Response(JSON.stringify({ error: 'OUT_OF_ORDER', extra: 'x'.repeat(5000) }), { status: 409 })],
    ['unknown-response', async () => new Response(JSON.stringify({ commandId: 'unknown-response', state: 'uncertain' }))],
  ]) {
    const store = new RecoveryStore(':memory:'); let calls = 0;
    const c = client(store, async (...args) => { calls++; return fetch(...args); });
    try { assert.equal((await c.send('listWork', name, {})).state, 'uncertain'); assert.equal(calls, 1, name); }
    finally { await c.dispose(); store.close(); }
  }
});
test('a network failure following an explicit ordering rejection stops further automatic attempts', async t => {
  const store = new RecoveryStore(':memory:'); let calls = 0;
  const c = client(store, async () => { if (++calls === 1) return response(); throw new Error('unknown network outcome'); });
  t.after(async () => { await c.dispose(); store.close(); });
  assert.equal((await c.send('listWork', 'stop-on-unknown', {})).state, 'uncertain');
  assert.equal(calls, 2);
});
