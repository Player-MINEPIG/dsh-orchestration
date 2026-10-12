import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readConfiguredSources, buildNodeReport, validateGameDaily, createLegacyTemplates, registerLegacyTaskPack, prepareLegacyReport } from '../../examples/legacy-task-pack/index.mjs';
import { TaskLedger } from '../../packages/task-system/dist/index.js';
const root = fileURLToPath(new URL('../../examples/legacy-task-pack/readers/fixtures/', import.meta.url));
const registry = [{ id: 'configured-export', root, manifest: 'manifest.json' }];
const input = { sourceIds: ['configured-export'], windowStart: '2026-09-15T00:00:00Z', windowEnd: '2026-09-16T00:00:00Z', timeZone: 'UTC' };

test('Configured readers derive the window from the task and return full node/game evidence', async () => {
  const bundle = await readConfiguredSources({ registry, authorizedIds: input.sourceIds, input });
  assert.equal(bundle.window.date, '2026-09-15'); const data = bundle.sources[0].data;
  assert.equal(data.codex.counts.top_level_session_count, 1); assert.equal(data.hermes.local_unregistered_sessions[0].turns.length, 1);
  const candidates = [];
  for (const [runtime, sessions] of [['codex', data.codex.top_level_sessions], ['hermes', data.hermes.local_unregistered_sessions]]) for (const session of sessions) for (const turn of session.turns) candidates.push({ source_ref: `${runtime}:${session.session_id}:${turn.turn_id}`, title: 'Synthetic human work', request_summary: 'Review synthetic evidence', outcome_summary: 'Synthetic work completed', status: 'completed', possible_duplicate_refs: [] });
  const node = buildNodeReport({ nodeId: 'synthetic-node', codex: data.codex, hermes: data.hermes, semantic: { candidates }, sources: { codex: 'source:configured-export:codex', hermes: 'source:configured-export:hermes' } });
  assert.equal(node.work_candidates.length, 2); assert.equal(node.usage.hermes.observability, 'partial');
  assert.equal(validateGameDaily(data.game, { automationIds: ['custom-example'] }).statusById['custom-example'], 'ok');
});
test('Unauthorized source IDs/model paths and oversize evidence do not become truncated success', async () => {
  await assert.rejects(readConfiguredSources({ registry, authorizedIds: [], sourceIds: ['configured-export'], input }), /outside/);
  await assert.rejects(readConfiguredSources({ registry, authorizedIds: input.sourceIds, sourceIds: ['../other-source'], input }), /outside/);
  await assert.rejects(readConfiguredSources({ registry, authorizedIds: input.sourceIds, input, maxOutputBytes: 1024 }), /SOURCE_OUTPUT_TOO_LARGE/);
  const abort = new AbortController(); abort.abort(new Error('Read cancelled')); await assert.rejects(readConfiguredSources({ registry, authorizedIds: input.sourceIds, input, signal: abort.signal }), /Read cancelled/);
});
test('Fixed operator game collector validates current day, identity and bounded output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-fixed-collector-'));
  try {
    const original = (await readConfiguredSources({ registry, authorizedIds: input.sourceIds, input })).sources[0].data.game;
    const script = join(directory, 'collect.mjs');
    await writeFile(script, `const r=${JSON.stringify(original)}; r.report_meta.business_date=process.argv[2]; r.report_meta.report_timezone=process.argv[3]; console.log(JSON.stringify(r));`);
    const config = { executable: process.execPath, cwd: directory, args: [script, '{date}', '{timeZone}'], automationIds: ['custom-example'] };
    const local = [{ id: 'game', root: directory, manifest: 'manifest.json' }];
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ gameCollector: config }));
    const result = await readConfiguredSources({ registry: local, authorizedIds: ['game'], nodeId: original.report_meta.device_id, input });
    assert.equal(result.sources[0].data.game.report_meta.business_date, '2026-09-15');
    await assert.rejects(readConfiguredSources({ registry: local, authorizedIds: ['game'], nodeId: 'wrong-node', input }), /Wrong source device/);
    await assert.rejects(readConfiguredSources({ registry: local, authorizedIds: ['game'], input, maxOutputBytes: 1024 }), /SOURCE_OUTPUT_TOO_LARGE/);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ gameCollector: { ...config, args: [script, '2000-01-01', '{timeZone}'] } }));
    await assert.rejects(readConfiguredSources({ registry: local, authorizedIds: ['game'], input }), /differs from pinned/);
    await writeFile(script, 'setInterval(() => {}, 1000);');
    const controller = new AbortController(); const pending = readConfiguredSources({ registry: local, authorizedIds: ['game'], input, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error('Stopped collector')), 100);
    try { await assert.rejects(pending, /Stopped collector/); } finally { clearTimeout(timer); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('Configured quota snapshots are read-only full evidence under the current task window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-configured-quota-'));
  try {
    const database = new DatabaseSync(join(directory, 'quota.sqlite'));
    database.exec("CREATE TABLE collections(collection_id TEXT,status TEXT); CREATE TABLE metrics(collection_id TEXT,provider TEXT,metric TEXT,dimension TEXT,unit TEXT,value_text TEXT,observed_at TEXT); INSERT INTO collections VALUES('one','ok'),('two','ok'); INSERT INTO metrics VALUES('one','synthetic','balance.total','CNY','CNY','10.50','2026-09-15T00:00:00Z'),('two','synthetic','balance.total','CNY','CNY','8.25','2026-09-16T00:00:00Z');"); database.close();
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ quota: { databasePath: 'quota.sqlite', format: 'hermes' } }));
    const before = await readFile(join(directory, 'quota.sqlite'));
    const result = await readConfiguredSources({ registry: [{ id: 'quota-export', root: directory, manifest: 'manifest.json' }], authorizedIds: ['quota-export'], input });
    assert.equal(result.sources[0].data.quota.quota_changes[0].change, '-2.25');
    assert.equal(result.sources[0].data.quota.data_quality.status, 'complete');
    assert.deepEqual(await readFile(join(directory, 'quota.sqlite')), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('Configured lookback diagnostics derive host identity/time and settle through the real semantic gate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-configured-diagnostics-')); let ledger, dispose;
  try {
    await writeFile(join(directory, 'app.log'), '2026-09-15 12:00:00 ERROR Synthetic diagnostic failure\n');
    await writeFile(join(directory, 'processes.json'), JSON.stringify(['AUTO-MAS.exe', 'ordinary.exe']));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ diagnostics: { deviceId: 'manifest-cannot-override-native-identity', sourceTimezone: 'UTC', logs: [{ id: 'app', path: 'app.log' }], processInventoryFile: 'processes.json' } }));
    const bundle = await readConfiguredSources({ registry: [{ id: 'diagnostic-export', root: directory, manifest: 'manifest.json' }], authorizedIds: ['diagnostic-export'], nodeId: 'worker', input });
    const payload = bundle.sources[0].data.diagnostics;
    assert.equal(payload.device_id, 'worker'); assert.equal(Date.parse(payload.collected_at), Date.parse(input.windowEnd));
    assert.equal(payload.window.hours, 26); assert.deepEqual(payload.process_snapshot.names, ['AUTO-MAS.exe']);
    ledger = TaskLedger.open(join(directory, 'tasks.sqlite')); dispose = registerLegacyTaskPack(ledger);
    const template = createLegacyTemplates().find(t => t.defaults.kind === 'automation_diagnostics'); ledger.updateTemplate('template', template);
    ledger.registerNode('node', { nodeId: 'worker', roles: ['executor'], enabled: true, capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'synthetic', model: 'synthetic', reasoningEfforts: [] }], workspaceIds: [], lastSeenAt: new Date().toISOString() });
    const task = ledger.createTask('task', { title: 'Inspect exported automation evidence' }).value;
    const run = ledger.createRun('run', { taskId: task.taskId, route: { nodeId: 'worker', provider: 'synthetic', model: 'synthetic', requiredCapabilities: ['legacy.task-pack.v1'] }, configuration: { template, input } }).value;
    const attempt = ledger.claim('claim', { runId: run.runId, nodeId: 'worker', ttlMs: 60000 }).value.attempt;
    const lease = { runId: run.runId, attemptId: attempt.attemptId, nodeId: 'worker', fence: attempt.fence };
    const prepared = prepareLegacyReport(ledger, 'prepare', { kind: 'automation_diagnostics', lease, payload });
    const forged = structuredClone(prepared.report); forged.data.payload.statuses.push({ script: 'Invented success', run_count: 1, status_hint: 'latest_reported_success', latest_result: 'success', previous_failure_count: 0, latest_age_hours: 0 });
    assert.throws(() => ledger.submit('fake', { ...lease, outcome: 'success', summary: 'Fake', report: forged }), e => e.code === 'RESULT_VALIDATION');
    assert.equal(ledger.getRun(run.runId).state, 'running');
    ledger.submit('settle', { ...lease, outcome: 'success', summary: prepared.summary, report: prepared.report });
    assert.equal(ledger.getRun(run.runId).state, 'succeeded'); assert.match(ledger.snapshot().reports[0].body, /Synthetic diagnostic failure/);
  } finally { dispose?.(); ledger?.close(); await rm(directory, { recursive: true, force: true }); }
});
