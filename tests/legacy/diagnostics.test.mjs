// SPDX-License-Identifier: MIT
// All data are invented fixtures within temporary operator export roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createSourceScope } from '../../examples/legacy-task-pack/readers/common.mjs';
import { readAutomationDiagnostics, renderAutomationDiagnostics, redactDiagnosticsText, validateAutomationDiagnostics } from '../../examples/legacy-task-pack/diagnostics/index.mjs';

const collectedAt = '2026-09-16T01:00:00Z';
const options = { collectedAt, sourceTimezone: 'UTC' };
async function fixture(t, sourceLimits) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-diagnostic-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'history'));
  async function text(path, content, time = '2026-09-15T12:00:00Z') {
    await writeFile(join(root, path), content);
    await utimes(join(root, path), new Date(time), new Date(time));
  }
  return { root, scope: await createSourceScope(root, sourceLimits), text,
    json: (path, value, time) => text(path, JSON.stringify(value), time) };
}
const scripts = { instances: [{ uid: 'march', type: 'CompanionConfig' }, { uid: 'maa', type: 'MaaConfig' }],
  march: { Info: { Name: 'March7thAssistant', Path: 'X:\\synthetic-private\\installation' }, Script: { LogPath: 'X:\\synthetic-private\\activity.log' }, SubConfigsInfo: { UserData: { instances: [{ uid: 'user' }], user: { Info: { Name: 'synthetic-private-account', Status: true }, Data: { LastProxyDate: '2026-09-15', ProxyTimes: 3 } } } } },
  maa: { Info: { Name: 'Synthetic MAA' } } };
const queues = { instances: [{ uid: 'queue' }], queue: { Info: { Name: 'Synthetic queue', TimeEnabled: true }, Data: { LastTimedStart: '2026-09-15T04:00:00Z' },
  SubConfigsInfo: { TimeSet: { instances: [{ uid: 'schedule' }], schedule: { Info: { Time: '04:00', Enabled: true } } } } } };

test('26-hour diagnostics retain cross-calendar history, queue/script evidence and retry recovery without live process inference', async t => {
  const f = await fixture(t);
  await f.json('scripts.json', scripts); await f.json('queues.json', queues);
  await f.json('history/start.json', { general_result: 'failed' }, '2026-09-14T23:00:00Z');
  await f.text('history/start.log', '2026-09-14 23:00:00 ERROR StarRail resolution mismatch', '2026-09-14T23:00:00Z');
  await f.json('history/retry.json', { general_result: 'success' });
  await f.text('history/retry.log', '2026-09-15 12:00:00 INFO StarRail 执行成功');
  await f.json('history/old.json', { general_result: 'old' }, '2026-09-14T22:59:59Z');
  await f.json('history/future.json', { general_result: 'future' }, '2026-09-16T01:00:01Z');
  await f.text('main.log', [
    '2026-09-14 22:59:59 ERROR too old', '2026-09-16 01:00:01 ERROR future',
    '2026-09-15 12:00:00 WARNING keep this', '2026-09-15 12:00:01 ERROR HTTP Request: noisy',
    '2026-09-15 12:00:02 ERROR token=synthetic-credential', 'ERROR untimed completion context',
    'ERROR untimed completion context', '2026-09-15 12:00:03 INFO irrelevant',
  ].join('\n'));
  const report = await readAutomationDiagnostics({ scope: f.scope, ...options, scriptConfigFile: 'scripts.json', queueConfigFile: 'queues.json', historyRoot: 'history',
    logs: [{ id: 'app', path: 'main.log', label: 'App export' }], processInventory: ['AUTO-MAS.exe', 'System Idle Process', 'ordinary.exe'] });
  assert.equal(report.authoritativeExecution, false);
  assert.deepEqual(report.window, { kind: 'lookback', hours: 26, start: '2026-09-14T23:00:00.000Z', end: '2026-09-16T01:00:00.000Z', interval: 'left_closed_right_closed' });
  assert.equal(report.history.length, 2);
  assert.equal(report.statuses[0].status_hint, 'latest_reported_success');
  assert.equal(report.statuses[0].previous_failure_count, 1);
  assert.equal(report.statuses[1].status_hint, 'not_observed');
  assert.equal(report.queues[0].schedules[0].time, '04:00');
  assert.equal(report.scripts[0].users[0].proxyCount, 3);
  assert.deepEqual(report.process_snapshot.names, ['AUTO-MAS.exe']);
  assert.equal(report.diagnostic_logs[0].events.length, 2);
  assert.equal(report.diagnostic_logs[0].repeated_lines_omitted, 1);
  assert.equal(report.diagnostic_logs[0].events[1].timestamped, false);
  assert.equal(report.evidence.sources.every(source => !source.path.startsWith(f.root)), true);
  const output = JSON.stringify(report);
  for (const forbidden of ['synthetic-private', 'synthetic-credential', 'too old', 'ERROR future', 'HTTP Request: noisy']) assert.equal(output.includes(forbidden), false);
  assert.match(report.text, /之前失败 1 次/);
  assert.equal(report.data_quality.complete, true);
});

test('explicit result-file mtime inclusion and host attribution do not establish authoritative task completion', async t => {
  const f = await fixture(t);
  await f.json('history/result.json', { maa_result: 'success', sanity: 72, sanity_full_at: '2026-09-16T03:00:00Z', drop_statistics: { item: 2, api_key: 'synthetic-leak' }, recruit_statistics: { rare: 1 } });
  await f.text('history/result.log', '2026-09-14 10:00:00 ERROR TaskQueueViewModel old log\nERROR current date unknown');
  const result = await readAutomationDiagnostics({ scope: f.scope, ...options, historyFiles: [{ resultFile: 'history/result.json', script: 'Operator supplied MAA' }], processInventory: [] });
  assert.equal(result.history[0].reported_result, 'success');
  assert.equal(result.history[0].script, 'Operator supplied MAA');
  assert.equal(result.history[0].sanity, '72');
  assert.deepEqual(result.history[0].drop_statistics, { item: '2' });
  assert.equal(result.history[0].events.length, 1);
  assert.equal(result.history[0].events[0].at, null);
  assert.equal(result.process_snapshot.supplied, true);
  assert.deepEqual(result.process_snapshot.names, []);
  assert.match(result.process_snapshot.note, /do not establish task failure/);
  assert.equal(JSON.stringify(result).includes('synthetic-leak'), false);
  assert.equal(result.authoritativeExecution, false);
});

test('missing, malformed and unsupplied exports are explicit evidence gaps, distinct from an empty supplied snapshot', async t => {
  const f = await fixture(t);
  await f.text('invalid.json', '{invalid');
  const report = await readAutomationDiagnostics({ scope: f.scope, ...options, scriptConfigFile: 'missing.json', queueConfigFile: 'invalid.json', historyRoot: 'missing-history', logs: [{ path: 'missing.log' }] });
  assert.equal(report.data_quality.complete, false);
  assert.equal(report.data_quality.errors.length, 4);
  assert.equal(report.evidence.sources[0].read_status, 'missing');
  assert.equal(report.evidence.sources[1].read_status, 'json');
  assert.equal(report.process_snapshot.supplied, false);
  assert.equal(report.process_snapshot.names, null);
  assert.equal(report.history.length, 0);
  assert.match(report.text, /证据不可用/);
});

test('bounds keep the newest history and events, support custom markers and report truncated source tails and text', async t => {
  const f = await fixture(t, { maxBytes: 128, maxTotalBytes: 1024 });
  for (let index = 0; index < 3; index++) {
    await f.json(`history/${index}.json`, { general_result: index ? 'success' : 'failed' }, `2026-09-15T0${index + 2}:00:00Z`);
    await f.text(`history/${index}.log`, 'DONE synthetic game');
  }
  await f.text('tail.log', 'x'.repeat(300) + '\nDROP this ERROR\nDONE first\nDONE newest\n');
  const report = await readAutomationDiagnostics({ scope: f.scope, ...options, hours: 24, historyRoot: 'history', logs: [{ path: 'tail.log' }], interestMarkers: ['DONE'], noiseMarkers: ['DROP'],
    bounds: { maxHistoryRuns: 2, maxEventsPerLog: 1, maxOutputChars: 200 } });
  assert.equal(report.history.length, 2);
  assert.equal(report.history[0].source, 'history/1.json');
  assert.deepEqual(report.diagnostic_logs[0].events.map(event => event.text), ['DONE newest']);
  assert.equal(report.diagnostic_logs[0].read_status, 'partial');
  assert.equal(report.data_quality.complete, false);
  assert.equal(report.data_quality.truncations.includes('history.runs'), true);
  assert.equal(report.data_quality.truncations.includes('diagnostic.1.events'), true);
  assert.equal(report.text_truncated, true);
  assert.equal(report.text.length <= 200, true);
});

test('scope rejects escapes and symlinks; diagnostics never follow installation paths from ScriptConfig', async t => {
  const f = await fixture(t), other = await mkdtemp(join(tmpdir(), 'dsh-diagnostic-outside-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(join(other, 'secret.log'), 'ERROR synthetic outside value');
  await symlink(join(other, 'secret.log'), join(f.root, 'link.log'));
  await f.json('scripts.json', scripts);
  const report = await readAutomationDiagnostics({ scope: f.scope, ...options, scriptConfigFile: 'scripts.json', logs: [{ path: '../escape.log' }, { path: 'link.log' }] });
  assert.deepEqual(report.diagnostic_logs.map(section => section.read_status), ['scope', 'scope']);
  assert.equal(JSON.stringify(report).includes('outside value'), false);
  assert.equal(report.evidence.sources.length, 3);
});

test('redaction precedes clipping and covers bearer/quoted credentials, opaque IDs, emails and private path forms', () => {
  const redacted = redactDiagnosticsText('ERROR authorization: Bearer synthetic-bearer token="synthetic token with spaces" PenguinID 123456 X:\\private\\path /home/synthetic/private person@example.test aabbccddeeff00112233445566778899 00112233-4455-6677-8899-aabbccddeeff');
  for (const value of ['synthetic-bearer', 'synthetic token', '123456', 'private', 'person@', 'aabbccddeeff0011', '00112233-4455']) assert.equal(redacted.includes(value), false);
  assert.equal(redactDiagnosticsText('token=' + 's'.repeat(500) + ' ERROR safe', 24).includes('ssss'), false);
});

test('invalid windows, timezone, bounds and process-path inputs fail before scanning', async t => {
  const f = await fixture(t);
  for (const hours of [0, -1, Infinity, 8785]) await assert.rejects(readAutomationDiagnostics({ scope: f.scope, ...options, hours }), { code: 'window' });
  await assert.rejects(readAutomationDiagnostics({ scope: f.scope, ...options, collectedAt: '2026-09-16T01:00:00' }), { code: 'time' });
  await assert.rejects(readAutomationDiagnostics({ scope: f.scope, ...options, collectedAt: '1234567890' }), { code: 'time' });
  await assert.rejects(readAutomationDiagnostics({ scope: f.scope, collectedAt }), { code: 'timezone' });
  await assert.rejects(readAutomationDiagnostics({ scope: f.scope, ...options, sourceTimezone: 'Invalid/Zone' }), { code: 'timezone' });
  await assert.rejects(readAutomationDiagnostics({ scope: f.scope, ...options, bounds: { maxHistoryRuns: -1 } }), { code: 'limit' });
  await assert.rejects(readAutomationDiagnostics({ scope: f.scope, ...options, interestMarkers: [/executable-regex/] }), { code: 'config' });
  await assert.rejects(readAutomationDiagnostics({ scope: f.scope, ...options, processInventory: ['X:\\private\\AUTO-MAS.exe'] }), { code: 'config' });
});

test('on-demand CLI renders text/JSON from an explicit-root config and leaves every export byte unchanged', async t => {
  const f = await fixture(t);
  await f.text('main.log', '2026-09-15 12:00:00 INFO 执行成功');
  await f.json('config.json', { ...options, logs: [{ path: 'main.log' }], processInventory: [] });
  const digest = async path => createHash('sha256').update(await readFile(join(f.root, path))).digest('hex');
  const before = await Promise.all(['main.log', 'config.json'].map(digest));
  const script = new URL('../../examples/legacy-task-pack/diagnostics/run.mjs', import.meta.url);
  const output = spawnSync(process.execPath, [script.pathname, f.root, 'config.json', 'json'], { encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const report = JSON.parse(output.stdout);
  assert.equal(report.schema_version, 'automation_diagnostics.v1');
  assert.equal(report.authoritativeExecution, false);
  const summary = renderAutomationDiagnostics(report, { mode: 'summary' });
  assert.equal(summary.text.includes('[日志信号]'), false);
  assert.equal(summary.truncated, false);
  const text = spawnSync(process.execPath, [script.pathname, f.root, 'config.json'], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /执行成功/);
  assert.deepEqual(await Promise.all(['main.log', 'config.json'].map(digest)), before);
});

test('closed validator rejects unsupported fields, authority escalation, invented status/text and broken export provenance', async t => {
  const f = await fixture(t);
  await f.json('history/result.json', { general_result: 'success' });
  await f.text('history/result.log', '2026-09-15 12:00:00 INFO StarRail 执行成功');
  await f.text('main.log', '2026-09-15 12:00:00 WARNING synthetic issue');
  const report = await readAutomationDiagnostics({ scope: f.scope, ...options, deviceId: 'synthetic-node', historyRoot: 'history', logs: [{ path: 'main.log' }] });
  assert.deepEqual(validateAutomationDiagnostics(report), report);
  for (const mutate of [
    value => { value.command = 'synthetic model command'; },
    value => { value.authoritativeExecution = true; },
    value => { value.window.hours = 24; },
    value => { value.statuses[0].run_count = 99; },
    value => { value.statuses[0].previous_failure_count = 10; },
    value => { value.history[0].evidence_refs[0] = 'invented'; },
    value => { value.history[0].at = '2026-09-15T13:00:00Z'; },
    value => { value.evidence.sources[0].path = '../untrusted'; },
    value => { value.evidence.sources[0].sha256 = 'invalid'; },
    value => { value.evidence.sources.push(structuredClone(value.evidence.sources[0])); },
    value => { value.diagnostic_logs[0].age_hours = 100; },
    value => { value.diagnostic_logs[0].events[0].at = '2026-09-16T01:00:01Z'; },
    value => { value.diagnostic_logs[0].events[0].text = 'password=synthetic-value'; },
    value => { value.process_snapshot.note = 'process exited proves failure'; },
    value => { value.data_quality.warnings.push('invented interpretation'); },
    value => { value.limitations = []; },
    value => { value.text = 'model-supplied replacement'; },
  ]) {
    const modified = structuredClone(report); mutate(modified);
    assert.throws(() => validateAutomationDiagnostics(modified), { code: 'REPORT_CONTRACT' });
  }
  const presentation = renderAutomationDiagnostics(report);
  assert.equal(presentation.title, '自动化诊断 · synthetic-node');
  assert.equal(presentation.body, report.text);
  assert.equal(presentation.text, report.text);
  assert.deepEqual(presentation.detail, report);
});
