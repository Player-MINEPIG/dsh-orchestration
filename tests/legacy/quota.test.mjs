// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, readdir, stat, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectDeepSeek, collectAlibaba, readEcsRoleCredentials, QuotaError, safeFailure, openQuotaStore, createQuotaProviders, createQuotaMonitor, mountQuotaMonitor, summarizeQuotaDay, readQuotaSnapshots } from '../../examples/legacy-task-pack/quota/index.mjs';
import { createSourceScope } from '../../examples/legacy-task-pack/readers/index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { Context, Service } from '@deepseek-ai/cordis';
import { TaskLedger } from '../../packages/task-system/dist/ledger.js';
import { createQuotaPlugin, Config as QuotaConfig } from '../../examples/legacy-task-pack/quota/plugin.mjs';
import { deepSeekFixture, alibabaFixture, metricFixture, jsonResponse } from '../../examples/legacy-task-pack/quota/synthetic-fixtures.mjs';

const withStore = async fn => { const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-quota-test-'))); let store = openQuotaStore({ directory }); try { await fn(store, directory); } finally { try { store.close(); } catch {} await rm(directory, { recursive: true, force: true }); } };
const syntheticKey = 'SYNTHETIC-SECRET-MUST-NOT-PERSIST';
const boundary = '2026-09-30T16:00:00.000Z';

test('quota providers remain disabled and do not consult ambient credentials or transport', async () => {
  let calls = 0; const transport = () => { calls++; throw Error('should not run'); };
  await assert.rejects(collectDeepSeek({ apiKey: syntheticKey, transport }), { code: 'disabled' });
  await assert.rejects(collectAlibaba({ transport }), { code: 'disabled' });
  await assert.rejects(readEcsRoleCredentials({ transport }), { code: 'disabled' });
  assert.deepEqual(createQuotaProviders({ transport }), []); assert.equal(calls, 0);
});
test('DeepSeek exact decimal multi-currency metrics are the only returned provider data', async () => {
  const result = await collectDeepSeek({ enabled: true, apiKey: syntheticKey, transport: async request => { assert.equal(request.url, 'https://api.deepseek.com/user/balance'); assert.equal(request.method, 'GET'); assert.equal(request.headers.Authorization, `Bearer ${syntheticKey}`); assert.equal(request.redirect, 'error'); return jsonResponse({ ...deepSeekFixture, leakedSecret: syntheticKey }); } });
  assert.equal(result.metrics.length, 6); assert.equal(result.metrics[0].value, '100.5000'); assert.equal(result.metrics[3].unit, 'USD'); assert.ok(!JSON.stringify(result).includes(syntheticKey));
});
test('Alibaba signs only the pinned read-only balance action using explicit transient credentials', async () => {
  const result = await collectAlibaba({ enabled: true, credentials: { accessKeyId: 'synthetic-id', accessKeySecret: syntheticKey, securityToken: 'synthetic-token' }, nonce: () => 'synthetic-nonce', now: () => new Date('2026-10-01T00:00:00Z'), transport: async request => { const url = new URL(request.url); assert.equal(url.origin, 'https://business.aliyuncs.com'); assert.equal(url.searchParams.get('Action'), 'QueryAccountBalance'); assert.equal(url.searchParams.get('Version'), '2017-12-14'); assert.equal(url.searchParams.get('SecurityToken'), 'synthetic-token'); assert.equal(url.searchParams.get('Timestamp'), '2026-10-01T00:00:00Z'); assert.match(url.searchParams.get('Signature'), /^[A-Za-z0-9+/]+=*$/); assert.ok(!request.url.includes(syntheticKey)); return jsonResponse({ ...alibabaFixture, Message: syntheticKey }); } });
  assert.deepEqual(result.metrics.map(item => item.value), ['200.50', '180.50', '20.00']); assert.ok(!JSON.stringify(result).includes(syntheticKey));
});
test('explicit ECS IMDSv2 sequence is fixed, bounded and stays transient', async () => {
  const calls = [];
  const credentials = await readEcsRoleCredentials({ enabled: true, transport: async request => { calls.push(request); if (calls.length === 1) { assert.equal(request.method, 'PUT'); return { status: 200, body: 'synthetic-imds-token' }; } assert.equal(request.headers['X-aliyun-ecs-metadata-token'], 'synthetic-imds-token'); if (calls.length === 2) return { status: 200, body: 'synthetic-role\n' }; return jsonResponse({ Code: 'Success', AccessKeyId: 'synthetic-id', AccessKeySecret: syntheticKey, SecurityToken: 'synthetic-session' }); } });
  assert.equal(calls.length, 3); assert.equal(calls[2].url, 'http://100.100.100.200/latest/meta-data/ram/security-credentials/synthetic-role'); assert.equal(credentials.accessKeySecret, syntheticKey); assert.ok(!('role' in credentials));
  await assert.rejects(readEcsRoleCredentials({ enabled: true, transport: async request => ({ status: 200, body: request.method === 'PUT' ? 'token' : '../escape' }) }), { code: 'credentials' });
});
test('provider reads bound timeout/bytes, reject redirects and suppress secret error bodies', async () => {
  const read = extra => collectDeepSeek({ enabled: true, apiKey: syntheticKey, ...extra });
  await assert.rejects(read({ timeoutMs: 10, transport: () => new Promise(() => {}) }), { code: 'timeout' });
  await assert.rejects(read({ maxBytes: 20, transport: async () => ({ status: 200, body: 'x'.repeat(21) }) }), { code: 'limit' });
  await assert.rejects(read({ transport: async () => ({ status: 302, body: syntheticKey }) }), error => error.code === 'http' && !error.retryable && !error.message.includes(syntheticKey));
  await assert.rejects(read({ transport: async () => { throw new Error(syntheticKey); } }), error => error.code === 'network' && error.retryable && !JSON.stringify(safeFailure(error)).includes(syntheticKey));
  for (const value of [1.5, 'NaN', '1e3', 'Infinity', syntheticKey]) await assert.rejects(read({ transport: async () => jsonResponse({ balance_infos: [{ currency: 'CNY', total_balance: value, granted_balance: '0', topped_up_balance: '0' }] }) }), { code: 'response' });
});
test('private metric persistence round-trips exact decimal values and strips extra/raw secret fields', async () => withStore(async (store, directory) => {
  const id = store.begin({ provider: 'deepseek', boundaryAt: boundary, observedAt: boundary, attempt: 1 });
  store.finish(id, { status: 'ok', metrics: [{ ...metricFixture().metrics[0], unsafeExtra: syntheticKey }], rawPayload: { secret: syntheticKey }, completedAt: boundary });
  const snapshotPath = join(directory, 'snapshots', '2026-10-01', `${id}.json`); const text = await readFile(snapshotPath, 'utf8');
  assert.equal(JSON.parse(text).metrics[0].value, '100.00'); assert.ok(!text.includes(syntheticKey)); assert.equal((await stat(directory)).mode & 0o777, 0o700); assert.equal((await stat(store.path)).mode & 0o777, 0o600); assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);
  assert.equal(store.samples().length, 1); assert.equal(store.latest('deepseek', boundary).status, 'ok');
  assert.throws(() => store.finish(id, { status: 'ok', metrics: metricFixture().metrics }), { code: 'configuration' });
}));
test('store rejects public directories and symlinked files without changing permissions', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-quota-private-')));
  try { await chmod(directory, 0o755); assert.throws(() => openQuotaStore({ directory }), { code: 'configuration' }); await chmod(directory, 0o700); await symlink(join(directory, 'elsewhere'), join(directory, 'quota_snapshots.sqlite')); assert.throws(() => openQuotaStore({ directory }), { code: 'configuration' }); } finally { await rm(directory, { recursive: true, force: true }); }
});
test('midnight collection is model-free, failure-only retries at 30s/60s, all providers required and successes deduplicated', async () => withStore(async (store, directory) => {
  let now = Date.parse(boundary); const counts = { deepseek: 0, aliyun: 0 }, alerts = [];
  const providers = ['deepseek', 'aliyun'].map(id => ({ id, async collect() { counts[id]++; if (id === 'aliyun' && counts[id] < 3) throw new QuotaError('network', { retryable: true }); return metricFixture(id); } }));
  const make = () => createQuotaMonitor({ enabled: true, store, providers, now: () => new Date(now), onFailure: value => alerts.push(value) }); const monitor = make();
  assert.equal((await monitor.tick()).status, 'retry_wait'); assert.deepEqual(counts, { deepseek: 1, aliyun: 1 });
  now += 29999; await monitor.tick(); assert.equal(counts.aliyun, 1); now += 1; await monitor.tick(); assert.equal(counts.aliyun, 2);
  now += 59999; await monitor.tick(); assert.equal(counts.aliyun, 2); now += 1; const done = await monitor.tick(); assert.equal(done.status, 'ok'); assert.equal(done.output, '');
  await make().tick(); assert.deepEqual(counts, { deepseek: 1, aliyun: 3 }); assert.equal(alerts.length, 0); assert.equal((await readdir(join(directory, 'snapshots', '2026-10-01'))).length, 4);
}));
test('exhausted failure alerts once, never records secret errors, and retries do not survive their finite budget', async () => withStore(async store => {
  let now = Date.parse(boundary), calls = 0; const alerts = [];
  const monitor = createQuotaMonitor({ enabled: true, store, providers: [{ id: 'deepseek', async collect() { calls++; throw new QuotaError('timeout', { retryable: true }); } }], now: () => new Date(now), onFailure: result => alerts.push(result) });
  await monitor.tick(); now += 30000; await monitor.tick(); now += 60000; const failed = await monitor.tick();
  assert.equal(failed.status, 'failed'); assert.equal(alerts.length, 1); assert.equal(JSON.parse(failed.output).success, false); now += 100000; await monitor.tick(); assert.equal(calls, 3); assert.equal(alerts.length, 1);
}));
test('pending interrupted reads remain unknown and never silently repeat after restart', async () => withStore(async store => {
  store.begin({ provider: 'deepseek', boundaryAt: boundary, observedAt: boundary, attempt: 1 }); let calls = 0; const alerts = [];
  const monitor = createQuotaMonitor({ enabled: true, store, providers: [{ id: 'deepseek', async collect() { calls++; return metricFixture(); } }], now: () => new Date(boundary), onFailure: result => alerts.push(result) });
  const result = await monitor.tick(); assert.equal(result.status, 'failed'); assert.equal(result.providers[0].status, 'pending'); assert.equal(calls, 0); assert.equal(alerts.length, 1); await monitor.tick(); assert.equal(alerts.length, 1);
}));
test('closing and reopening the private DB retains successful provider deduplication', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-quota-reopen-'))); let store, calls = 0;
  try {
    store = openQuotaStore({ directory }); const provider = { id: 'deepseek', async collect() { calls++; return metricFixture(); } };
    let monitor = createQuotaMonitor({ enabled: true, store, providers: [provider], now: () => new Date(boundary) }); await monitor.tick(); await monitor.dispose(); store.close();
    store = openQuotaStore({ directory }); monitor = createQuotaMonitor({ enabled: true, store, providers: [provider], now: () => new Date(boundary) }); assert.equal((await monitor.tick()).status, 'ok'); assert.equal(calls, 1); await monitor.dispose();
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});
test('host calls outside midnight window are inert and configured zones honor DST', async () => withStore(async store => {
  let calls = 0; const provider = { id: 'deepseek', async collect() { calls++; return metricFixture(); } };
  const monitor = createQuotaMonitor({ enabled: true, store, providers: [provider], timezone: 'America/New_York', now: () => new Date('2026-03-08T05:00:00Z') });
  const result = await monitor.tick(); assert.equal(result.boundaryAt, '2026-03-08T05:00:00.000Z'); assert.equal(result.nextBoundary, '2026-03-09T04:00:00.000Z');
  const outside = createQuotaMonitor({ enabled: true, store, providers: [provider], now: () => new Date('2026-10-01T05:00:00Z') }); assert.equal((await outside.tick()).status, 'outside_window'); assert.equal(calls, 1);
}));
test('disabled lifecycle installs no timers; enabled lifecycle is disposable and serializes concurrent ticks', async () => withStore(async store => {
  let timers = 0; const disabled = mountQuotaMonitor({ setTimer: () => timers++ }); assert.equal(timers, 0); assert.equal((await disabled.tick()).status, 'disabled'); await disabled.dispose();
  let calls = 0; const monitor = createQuotaMonitor({ enabled: true, store, now: () => new Date(boundary), providers: [{ id: 'deepseek', collect({ signal }) { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new QuotaError('cancelled')))); } }] });
  const one = monitor.tick(), two = monitor.tick(); assert.equal(one, two); await monitor.dispose(); assert.equal((await one).status, 'failed'); assert.equal(calls, 1);
}));
test('mounted host lifecycle schedules through injected timers and cancels them on disposal', async () => withStore(async store => {
  const timers = new Map(); let id = 0, calls = 0;
  const monitor = mountQuotaMonitor({ enabled: true, store, now: () => new Date(boundary), providers: [{ id: 'deepseek', async collect() { calls++; return metricFixture(); } }], setTimer: callback => { const handle = { id: ++id, unref() {} }; timers.set(handle, callback); return handle; }, clearTimer: handle => timers.delete(handle) });
  assert.equal(timers.size, 1); const [handle, callback] = timers.entries().next().value; timers.delete(handle); await callback(); assert.equal(calls, 1); assert.equal(timers.size, 1); await monitor.dispose(); assert.equal(timers.size, 0);
}));
test('a hanging host credential/provider callback still has a finite whole-attempt timeout', async () => withStore(async store => {
  const providers = createQuotaProviders({ enabled: true, providers: ['deepseek'], credentials: () => new Promise(() => {}), transport: async () => { throw Error('No HTTP expected'); } });
  const monitor = createQuotaMonitor({ enabled: true, store, providers, now: () => new Date(boundary), attemptTimeoutMs: 10, retryDelaysMs: [] });
  const result = await monitor.tick(); assert.equal(result.status, 'failed'); assert.equal(result.providers[0].error.code, 'timeout'); await monitor.dispose();
}));
test('summary preserves exact string decimals, missing boundaries and net movement semantics', async () => withStore(async store => {
  for (const [observedAt, value] of [[boundary, '10.50'], ['2026-10-01T16:00:00.000Z', '8.25']]) { const id = store.begin({ provider: 'deepseek', boundaryAt: observedAt, observedAt, attempt: 1 }); store.finish(id, { status: 'ok', metrics: metricFixture('deepseek', value).metrics, completedAt: observedAt }); }
  const report = summarizeQuotaDay(store, { date: '2026-10-01' }); assert.equal(report.quota_changes[0].change, '-2.25'); assert.equal(report.quota_changes[0].observability, 'exact'); assert.equal(report.quota_changes[0].movement_kind, 'net_balance_movement');
  assert.equal(summarizeQuotaDay(store, { date: '2026-10-02' }).quota_changes[0].observability, 'unavailable');
}));
test('scoped quota reader reads native and original metric formats without modifying source files', async () => withStore(async (store, directory) => {
  for (const [observedAt, value] of [[boundary, '10.50'], ['2026-10-01T16:00:00.000Z', '8.25']]) { const id = store.begin({ provider: 'deepseek', boundaryAt: observedAt, observedAt, attempt: 1 }); store.finish(id, { status: 'ok', metrics: metricFixture('deepseek', value).metrics }); }
  const before = await readFile(store.path), info = await stat(store.path), window = { start: boundary, end: '2026-10-01T16:00:00.000Z' };
  const result = await readQuotaSnapshots({ scope: await createSourceScope(directory), databasePath: 'quota_snapshots.sqlite', window });
  assert.equal(result.quota_changes[0].change, '-2.25'); assert.equal(result.data_quality.status, 'complete'); assert.deepEqual(await readFile(store.path), before); assert.equal((await stat(store.path)).mtimeMs, info.mtimeMs);
  const legacyPath = join(directory, 'legacy.sqlite'), legacy = new DatabaseSync(legacyPath);
  legacy.exec("CREATE TABLE collections(collection_id TEXT, status TEXT); CREATE TABLE metrics(collection_id TEXT,provider TEXT,metric TEXT,dimension TEXT,unit TEXT,value_text TEXT,observed_at TEXT); INSERT INTO collections VALUES('one','ok'); INSERT INTO metrics VALUES('one','deepseek','balance.total','CNY','CNY','1.23','2026-09-30T16:00:00Z');"); legacy.close();
  const old = await readQuotaSnapshots({ scope: await createSourceScope(directory), databasePath: 'legacy.sqlite', window, format: 'hermes' }); assert.equal(old.quota_changes[0].observability, 'unavailable'); assert.equal(old.quota_changes[0].start_value, null);
  const missing = await readQuotaSnapshots({ scope: await createSourceScope(directory), databasePath: 'missing.sqlite', window }); assert.equal(missing.data_quality.status, 'unavailable');
  await assert.rejects(readQuotaSnapshots({ scope: await createSourceScope(directory), databasePath: '../outside.sqlite', window }), { code: 'scope' });
}));

async function pluginHarness(role, dependencies, input = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-quota-native-'))); const ctx = new Context();
  const ledger = TaskLedger.open(join(directory, 'tasks.sqlite'), { role, nodeId: 'quota-test' });
  class TestAuthority extends Service {
    constructor() { super(ctx, 'taskSystem'); this.ledger = ledger; this.drains = new Set(); }
    addDrain(drain) { this.drains.add(drain); return () => this.drains.delete(drain); }
    async drain() { await Promise.all([...this.drains].map(drain => drain())); }
  }
  const authority = new TestAuthority(); const timers = new Map(); let serial = 0;
  const plugin = createQuotaPlugin({ now: () => new Date(boundary), setTimer: callback => { const token = ++serial; timers.set(token, callback); return token; }, clearTimer: token => timers.delete(token), ...dependencies });
  const config = { enabled: true, storePath: join(directory, 'quota'), providers: ['deepseek'], deepseekApiKeyEnv: 'SYNTHETIC_QUOTA_KEY', retryDelaysMs: [], ...input };
  try { await ctx.plugin(plugin, config); assert.ok(ctx.quotaMonitor); }
  catch (error) { await ctx.fiber.dispose(); ledger.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return { ctx, ledger, directory, timers, authority, async close() { await ctx.fiber.dispose(); ledger.close(); await rm(directory, { recursive: true, force: true }); } };
}
test('native quota plugin is disabled by default and creates no timers, store or credential reads', async () => {
  assert.equal(QuotaConfig({}).enabled, false); let reads = 0;
  const host = await pluginHarness('both', { readEnvironment: () => { reads++; throw Error('must not read'); } }, { enabled: false });
  try { assert.equal(host.ctx.quotaMonitor.enabled, false); assert.equal(host.timers.size, 0); assert.equal(reads, 0); assert.equal((await host.ctx.quotaMonitor.tick()).status, 'disabled'); await assert.rejects(stat(join(host.directory, 'quota')), { code: 'ENOENT' }); } finally { await host.close(); }
});
test('native planner plugin reads only named synthetic env slots and raises one sanitized durable alert', async () => {
  const reads = []; const host = await pluginHarness('planner', { readEnvironment: name => { reads.push(name); return syntheticKey; }, transport: async () => { throw Error(syntheticKey); } });
  try {
    assert.equal(reads.length, 0); assert.equal(host.timers.size, 1); const result = await host.ctx.quotaMonitor.tick(); assert.equal(result.status, 'failed');
    assert.deepEqual(reads, ['SYNTHETIC_QUOTA_KEY']); const [alert] = host.ledger.alerts(); assert.equal(alert.dedupeKey, `quota:deepseek:${boundary}`); assert.equal(alert.severity, 'warning'); assert.ok(!JSON.stringify(alert).includes(syntheticKey)); assert.match(alert.body, /network/); assert.equal(host.ledger.deliveries().length, 0);
    await host.ctx.quotaMonitor.tick(); assert.equal(host.ledger.alerts().length, 1); assert.equal(host.ledger.alerts()[0].occurrences, 1);
  } finally { await host.close(); }
});
test('native quota success resolves only a known same-boundary alert and stays silent otherwise', async () => {
  const host = await pluginHarness('both', { readEnvironment: () => syntheticKey, transport: async () => jsonResponse(deepSeekFixture) });
  try {
    const known = host.ledger.raiseAlert('known-boundary', { dedupeKey: `quota:deepseek:${boundary}`, title: 'Known quota failure', body: 'Synthetic prior failure', severity: 'warning' }).value;
    const other = host.ledger.raiseAlert('other-boundary', { dedupeKey: 'quota:deepseek:2026-09-29T16:00:00.000Z', title: 'Other quota failure', body: 'Synthetic prior failure', severity: 'warning' }).value;
    const result = await host.ctx.quotaMonitor.tick(); assert.equal(result.status, 'ok'); assert.equal(result.output, ''); assert.equal(host.ledger.getAlert(known.alertId).status, 'resolved'); assert.equal(host.ledger.getAlert(other.alertId).status, 'open'); assert.equal(host.ctx.quotaMonitor.lastFailure, null);
  } finally { await host.close(); }
});
test('executor native quota plugin rejects alert authority and supports explicit local-only monitoring', async () => {
  const ctx = new Context(), plugin = createQuotaPlugin({ readEnvironment: () => { throw Error('must not read'); } });
  class ExecutorAuthority extends Service { constructor() { super(ctx, 'taskSystem'); this.ledger = { role: 'executor' }; } } new ExecutorAuthority();
  assert.throws(() => plugin.apply(ctx, { enabled: true, storePath: '/tmp/synthetic-not-created', providers: ['deepseek'], deepseekApiKeyEnv: 'SYNTHETIC_QUOTA_KEY' }), /planner authority/); await ctx.fiber.dispose();
  const host = await pluginHarness('executor', { readEnvironment: () => syntheticKey, transport: async () => ({ status: 503, body: syntheticKey }) }, { localOnly: true });
  try { assert.equal((await host.ctx.quotaMonitor.tick()).status, 'failed'); assert.equal(host.ledger.alerts().length, 0); assert.equal(host.ctx.quotaMonitor.lastFailure.providers[0].code, 'http'); } finally { await host.close(); }
});
test('native authority drain aborts provider reads before ledger shutdown and cleanup is idempotent', async () => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const host = await pluginHarness('both', { readEnvironment: () => syntheticKey, transport: ({ signal }) => new Promise((_, reject) => { began(); signal.addEventListener('abort', () => reject(new QuotaError('cancelled')), { once: true }); }) });
  try {
    const result = host.ctx.quotaMonitor.tick(); await started; assert.equal(host.authority.drains.size, 1); await host.authority.drain(); assert.equal(host.timers.size, 0); assert.equal((await result).status, 'failed'); assert.equal((await host.ctx.quotaMonitor.tick()).status, 'disabled');
    await host.authority.drain(); assert.equal(host.ledger.alerts().length, 1);
  } finally { await host.close(); }
});
test('native quota config rejects accidental credential values, ambiguous Alibaba modes and duplicate providers', async () => {
  const ctx = new Context(), plugin = createQuotaPlugin(); class Authority extends Service { constructor() { super(ctx, 'taskSystem'); this.ledger = { role: 'planner' }; } } new Authority();
  const base = { enabled: true, storePath: '/tmp/synthetic-not-created' };
  for (const bad of [{ providers: ['deepseek'], deepseekApiKeyEnv: 'Bearer secret-value' }, { providers: ['deepseek', 'deepseek'], deepseekApiKeyEnv: 'SYNTHETIC_KEY' }, { providers: ['aliyun'], ecsMetadata: true, alibabaAccessKeyIdEnv: 'SYNTHETIC_ID' }, { providers: ['aliyun'], alibabaAccessKeyIdEnv: 'SYNTHETIC_ID' }]) assert.throws(() => plugin.apply(ctx, { ...base, ...bad }), { code: 'configuration' });
  await ctx.fiber.dispose();
});
