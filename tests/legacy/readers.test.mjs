// SPDX-License-Identifier: MIT
// Every source below is invented test data created in a temporary export root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, readdir, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSourceScope, readCodexDaily, readHermesDaily, readGameDaily, hsrRules, oneDragonRules, maaRules, parseLogLines,
  readAutoMasDaily, autoMasDefinitions, calendarWindow, localTimestamp } from '../../examples/legacy-task-pack/readers/index.mjs';
import { decodeText } from '../../examples/legacy-task-pack/readers/common.mjs';
import { validateGameDaily } from '../../examples/legacy-task-pack/reporting.mjs';

const window = { date: '2026-09-15', timezone: 'UTC', start: '2026-09-15T00:00:00Z', end: '2026-09-16T00:00:00Z' };
const epoch = text => Date.parse(text) / 1000;
const meta = { device_id: 'synthetic-node', business_date: window.date, report_timezone: 'UTC', source_timezone: 'UTC', source_utc_offset: '+00:00', collected_at: '2026-09-16T01:00:00Z' };
async function fixture(t, limits) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reader-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, scope: await createSourceScope(root, limits),
    json: (file, value) => writeFile(join(root, file), JSON.stringify(value)),
    text: (file, value) => writeFile(join(root, file), value),
    jsonl: (file, rows) => writeFile(join(root, file), rows.map(row => JSON.stringify(row)).join('\n') + '\n') };
}
const codexMessage = (time, role, text, turn = 'turn-a', phase = role === 'assistant' ? 'final_answer' : undefined) => ({ timestamp: time, type: 'response_item', payload: { type: 'message', role, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turn } } });
const thread = (id, overrides = {}) => ({ id, title: 'Synthetic work', created_at: epoch('2026-09-14T10:00:00Z'), updated_at: epoch(window.end), source: 'cli', rollout_path: `${id}.jsonl`, tokens_used: 0, archived: 0, ...overrides });
const hermesSession = (id, overrides = {}) => ({ id, source: 'cli', title: 'Synthetic work', origin_json: '{}', started_at: epoch('2026-09-15T01:00:00Z'), ended_at: epoch('2026-09-15T02:00:00Z'), end_reason: 'complete', message_count: 2, tool_call_count: 0, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 1, ...overrides });
const hermesMessage = (session_id, id, role, time, content, overrides = {}) => ({ session_id, id, role, timestamp: epoch(time), content, finish_reason: role === 'assistant' ? 'stop' : null, tool_name: null, ...overrides });

test('Codex keeps continued turns, ignores injected/subagent/collector work, and excludes future completion', async t => {
  const f = await fixture(t);
  await f.json('threads.json', { threads: [thread('human'), thread('child', { source: '{"subagent":{"parent":"human"}}' }), thread('collector', { title: 'codex daily work summary' })] });
  await f.jsonl('human.jsonl', [
    codexMessage('2026-09-14T23:59:00Z', 'user', 'Continue yesterday’s requested work'),
    codexMessage(window.start, 'assistant', 'Completed at the inclusive start'),
    codexMessage('2026-09-15T03:00:00Z', 'user', '<environment_context>Injected data</environment_context>', 'injected'),
    codexMessage('2026-09-15T03:01:00Z', 'assistant', 'Injected response', 'injected'),
    codexMessage('2026-09-15T23:58:00Z', 'user', 'Work still running', 'turn-b'),
    codexMessage(window.end, 'assistant', 'Future final must not leak', 'turn-b'),
    { timestamp: '2026-09-15T02:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } }, rate_limits: { primary: { used_percent: 2, window_minutes: 60, resets_at: epoch(window.end) } } } },
  ]);
  for (const id of ['child', 'collector']) await f.jsonl(`${id}.jsonl`, [codexMessage('2026-09-15T10:00:00Z', 'user', `${id} request`)]);
  const result = await readCodexDaily({ scope: f.scope, window, threadsFile: 'threads.json', includeSubagents: true });
  assert.equal(result.counts.top_level_session_count, 1);
  assert.equal(result.counts.continued_session_count, 1);
  assert.equal(result.counts.user_turn_count, 2);
  assert.equal(result.counts.subagent_session_count, 1);
  assert.equal(result.counts.completed_turn_count_by_final_answer, 1);
  assert.equal(result.top_level_sessions[0].turns[0].user_requests[0].in_window, false);
  assert.equal(result.top_level_sessions[0].turns[1].has_final_answer, false);
  assert.equal(result.token_totals_all_sessions.total_tokens, 11);
  assert.equal(result.account_usage.first.primary.resets_at, '2026-09-16T00:00:00.000Z');
  assert.deepEqual(result.excluded.collector_session_ids, ['collector']);
  assert.equal(JSON.stringify(result).includes('Future final'), false);
  assert.equal(result.data_quality.complete, true);
});

test('Codex unavailable, measured zero, and malformed partial evidence are distinct', async t => {
  const f = await fixture(t);
  const missing = await readCodexDaily({ scope: f.scope, window, threadsFile: 'missing.json' });
  assert.equal(missing.counts, null);
  assert.equal(missing.token_totals_all_sessions.observability, 'unavailable');
  await f.json('empty.json', { threads: [] });
  const empty = await readCodexDaily({ scope: f.scope, window, threadsFile: 'empty.json' });
  assert.equal(empty.counts.user_turn_count, 0);
  assert.equal(empty.token_totals_all_sessions.total_tokens, 0);
  assert.equal(empty.token_totals_all_sessions.observability, 'exact');
  await f.json('partial.json', { threads: [thread('partial')] });
  await f.text('partial.jsonl', `${JSON.stringify(codexMessage(window.start, 'user', 'Retain valid evidence'))}\n{malformed\n`);
  const partial = await readCodexDaily({ scope: f.scope, window, threadsFile: 'partial.json' });
  assert.equal(partial.counts.user_turn_count, 1);
  assert.equal(partial.data_quality.complete, false);
  assert.equal(partial.token_totals_all_sessions.observability, 'partial');
});

test('Scope rejects path traversal, symlink escape, oversized inputs, and oversized JSONL rows', async t => {
  const f = await fixture(t, { maxBytes: 64, maxLineBytes: 12 });
  const outside = await mkdtemp(join(tmpdir(), 'dsh-reader-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside'), 'not readable through scope');
  await symlink(join(outside, 'outside'), join(f.root, 'link'));
  await assert.rejects(f.scope.read('../escape'), { code: 'scope' });
  await assert.rejects(f.scope.read('link'), { code: 'scope' });
  await f.text('large', 'x'.repeat(65));
  await assert.rejects(f.scope.read('large'), { code: 'limit' });
  const normal = await fixture(t, { maxLineBytes: 30 });
  await normal.json('threads.json', { threads: [thread('long')] });
  await normal.jsonl('long.jsonl', [codexMessage(window.start, 'user', 'A line longer than its allowed limit')]);
  const result = await readCodexDaily({ scope: normal.scope, window, threadsFile: 'threads.json' });
  assert.equal(result.data_quality.errors[0].code, 'limit');
});

test('SQLite reads include uncheckpointed WAL records using a private snapshot and leave sources unchanged', async t => {
  const f = await fixture(t), path = join(f.root, 'state.sqlite'), db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT,title TEXT,created_at REAL,updated_at REAL,source TEXT,rollout_path TEXT,tokens_used INTEGER,archived INTEGER);');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)').run('wal', 'Synthetic WAL', epoch(window.start), epoch(window.start), 'cli', 'wal.jsonl', 0, 0);
  await f.jsonl('wal.jsonl', [codexMessage(window.start, 'user', 'WAL fixture request')]);
  const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  const before = await Promise.all([hash(path), hash(path + '-wal'), readdir(f.root)]);
  const result = await readCodexDaily({ scope: f.scope, window, database: 'state.sqlite' });
  assert.equal(result.counts.user_turn_count, 1);
  assert.deepEqual(await Promise.all([hash(path), hash(path + '-wal'), readdir(f.root)]), before);
});

test('Hermes ACK excludes only acknowledged turns and preserves the human remainder with partial usage', async t => {
  const f = await fixture(t);
  const sessions = [hermesSession('human'), hermesSession('service', { source: 'cron' }), hermesSession('bound'), hermesSession('collector', { title: 'agent daily report' })];
  const messages = [
    hermesMessage('human', 1, 'user', '2026-09-14T23:59:00Z', 'Previous-day request'),
    hermesMessage('human', 2, 'assistant', window.start, 'Completed acknowledged turn'),
    hermesMessage('human', 3, 'user', '2026-09-15T01:00:00Z', 'Keep this local turn'),
    hermesMessage('human', 4, 'assistant', '2026-09-15T01:05:00Z', '等待授权'),
    hermesMessage('human', 5, 'user', '2026-09-15T23:59:00Z', 'Keep unfinished turn'),
    hermesMessage('human', 6, 'assistant', window.end, 'Future completion'),
    ...sessions.slice(1).flatMap((s, n) => [hermesMessage(s.id, 10 + n * 2, 'user', '2026-09-15T02:00:00Z', 'Service request'), hermesMessage(s.id, 11 + n * 2, 'assistant', '2026-09-15T02:01:00Z', 'Service result')]),
  ];
  await f.json('hermes.json', { sessions, messages, worker_bindings: { bound: { task_id: 'synthetic-task' } }, ack_bindings: [{ session_id: 'human', payload_json: JSON.stringify({ origin: { turn_id: 'human:m1' } }) }] });
  const result = await readHermesDaily({ scope: f.scope, window, exportFile: 'hermes.json' });
  assert.equal(result.counts.local_user_turn_count, 2);
  assert.equal(result.counts.local_blocked_turn_count, 1);
  assert.equal(result.counts.local_running_turn_count, 1);
  assert.equal(result.counts.service_session_count_excluded, 4);
  assert.deepEqual(result.local_unregistered_sessions[0].turns.map(turn => turn.turn_id), ['human:m3', 'human:m5']);
  assert.equal(result.usage_local_sessions.observability, 'partial');
  assert.equal(result.usage_local_sessions.total_tokens, 15);
  assert.equal(JSON.stringify(result).includes('Future completion'), false);
});

test('Hermes injected turns, full ACK, unknown ACK IDs, and profile restrictions do not erase unrelated work', async t => {
  const f = await fixture(t);
  await f.json('hermes.json', { sessions: [hermesSession('h')], messages: [
    hermesMessage('h', 1, 'user', window.start, '<app-context>Injected</app-context>'),
    hermesMessage('h', 2, 'assistant', '2026-09-15T00:01:00Z', 'Not human work'),
    hermesMessage('h', 3, 'user', '2026-09-15T01:00:00Z', 'Actual work'),
    hermesMessage('h', 4, 'assistant', '2026-09-15T01:01:00Z', 'Complete'),
  ], ack_bindings: [{ session_id: 'h', turn_id: 'h:m999' }] });
  const actual = await readHermesDaily({ scope: f.scope, window, exportFile: 'hermes.json' });
  assert.equal(actual.counts.local_user_turn_count, 1);
  assert.equal(actual.local_unregistered_sessions[0].turns[0].turn_id, 'h:m3');
  const skipped = await readHermesDaily({ scope: f.scope, window, exportFile: 'hermes.json', profile: 'other' });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.usage_local_sessions.observability, 'unavailable');
  const data = JSON.parse(await readFile(join(f.root, 'hermes.json'), 'utf8'));
  data.ack_bindings = [{ session_id: 'h', turn_id: 'h:m3' }];
  await f.json('hermes.json', data);
  const acknowledged = await readHermesDaily({ scope: f.scope, window, exportFile: 'hermes.json' });
  assert.equal(acknowledged.counts.local_user_turn_count, 0);
  assert.equal(acknowledged.counts.service_session_count_excluded, 1);
  assert.equal(acknowledged.usage_local_sessions.total_tokens, 0);
});

test('Hermes native SQLite sessions/messages and separate ACK/worker tables are translated', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(join(f.root, 'hermes.sqlite'));
  db.exec('CREATE TABLE sessions(id TEXT,source TEXT,title TEXT,origin_json TEXT,started_at REAL,ended_at REAL,end_reason TEXT,message_count INTEGER,tool_call_count INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,finish_reason TEXT,tool_name TEXT);');
  const s = hermesSession('sqlite');
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...['id','source','title','origin_json','started_at','ended_at','end_reason','message_count','tool_call_count','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens'].map(key => s[key]));
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(1, 'sqlite', 'user', 'Bound request', epoch(window.start), null, null);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(2, 'sqlite', 'user', 'Unbound remainder', epoch('2026-09-15T01:00:00Z'), null, null);
  db.close();
  const ack = new DatabaseSync(join(f.root, 'ack.sqlite'));
  ack.exec('CREATE TABLE candidate_bindings(session_id TEXT,task_id TEXT,run_id TEXT,candidate_id TEXT,updated_at REAL); CREATE TABLE outbox(candidate_id TEXT,payload_json TEXT);');
  ack.prepare('INSERT INTO candidate_bindings VALUES (?,?,?,?,?)').run('sqlite','task','run','candidate',0);
  ack.prepare('INSERT INTO outbox VALUES (?,?)').run('candidate', JSON.stringify({ origin: { turn_id: 'sqlite:m1' } })); ack.close();
  const workers = new DatabaseSync(join(f.root, 'workers.sqlite'));
  workers.exec('CREATE TABLE state_meta(key TEXT,value TEXT);'); workers.close();
  const result = await readHermesDaily({ scope: f.scope, window, database: 'hermes.sqlite', ackDatabase: 'ack.sqlite', workerDatabase: 'workers.sqlite' });
  assert.deepEqual(result.local_unregistered_sessions[0].turns.map(turn => turn.turn_id), ['sqlite:m2']);
  assert.equal(result.data_quality.complete, true);
});

test('SQLite row bounds reject whole input instead of silently dropping sessions', async t => {
  const f = await fixture(t, { maxRows: 1 }), db = new DatabaseSync(join(f.root, 'too-many.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,title TEXT,created_at REAL,updated_at REAL,source TEXT,rollout_path TEXT,tokens_used INTEGER,archived INTEGER); INSERT INTO threads VALUES ("a","a",0,0,"cli","a.jsonl",0,0),("b","b",0,0,"cli","b.jsonl",0,0);'.replaceAll('"', "'")); db.close();
  const result = await readCodexDaily({ scope: f.scope, window, database: 'too-many.sqlite' });
  assert.equal(result.counts, null);
  assert.equal(result.data_quality.errors[0].code, 'limit');
});

test('HSR main outcomes survive late screenshot noise and optional skipped training', async t => {
  const f = await fixture(t);
  await f.text('hsr.log', [
    '[2026-09-15 01:00:00] 游戏启动：StarRail', '[2026-09-15 01:01:00] 领取巡星之礼奖励完成',
    '[2026-09-15 01:02:00] 开拓力: 240/300', '[2026-09-15 01:03:00] 副本任务完成',
    '[2026-09-15 01:04:00] 开拓力剩余: 0/300', '[2026-09-15 01:05:00] 完成任务: 派遣委托或收取1次委托奖励',
    '[2026-09-15 01:06:00] 当前分数: 500/500', '[2026-09-15 01:07:00] 每日实训已完成',
    '[2026-09-15 01:07:10] 使用支援角色并获得战斗胜利1次: 待完成', '[2026-09-15 01:07:20] 使用1次「万能合成机」: 待完成', '[2026-09-15 01:07:30] 完成1次「差分宇宙」或「货币战争」: 待完成',
    '[2026-09-15 01:08:00] 游戏终止：StarRail', '[2026-09-15 01:09:00] 截图失败：没有找到游戏窗口',
  ].join('\n'));
  await f.json('hsr.json', { general_result: 'Success!' });
  const report = await readGameDaily({ scope: f.scope, window, reportMeta: meta, automations: [{ id: 'custom-hsr', ...hsrRules(), runs: [{ logFile: 'hsr.log', resultFile: 'hsr.json' }] }] });
  const a = report.automations[0];
  assert.equal(a.status_hint, 'ok');
  assert.equal(a.tasks.find(task => task.task_id === 'hsr.post_shutdown_screenshot').outcome, 'skipped_nonblocking');
  assert.equal(a.tasks.find(task => task.task_id === 'hsr.support_character').outcome, 'skipped_nonblocking');
  assert.equal(a.metrics.find(metric => metric.metric_id === 'hsr.trailblaze_power_spent').value, 240);
  assert.equal(validateGameDaily(report, { automationIds: ['custom-hsr'] }).overallStatus, 'ok');
});

test('OneDragon uses child failures despite Success!, marks only chronological suspected cascades, and respects disabled apps', async t => {
  const f = await fixture(t);
  await f.text('zzz.log', [
    '[2026-09-15 02:00:00] 指令[ 打开并登录游戏 ] 执行成功',
    '[2026-09-15 02:01:00] 指令[ 咖啡店 ] 执行失败',
    '[2026-09-15 02:02:00] 指令[ 体力刷本 ] 执行失败',
    '[2026-09-15 02:03:00] 应用未启用 邮件',
  ].join('\n'));
  await f.json('zzz.json', { general_result: 'Success!' });
  const report = await readGameDaily({ scope: f.scope, window, reportMeta: meta, automations: [{ id: 'custom-zzz', ...oneDragonRules({ enabledTasks: ['login', 'coffee_shop', 'energy_plan', 'mail'] }), runs: [{ logFile: 'zzz.log', resultFile: 'zzz.json' }] }] });
  const a = report.automations[0], energy = a.tasks.find(task => task.task_id === 'zzz.energy_plan');
  assert.equal(a.reported_top_level_status, 'Success!');
  assert.equal(a.status_hint, 'action_required');
  assert.equal(a.tasks.find(task => task.task_id === 'zzz.mail').outcome, 'disabled');
  assert.equal(energy.caused_by_task_id, 'zzz.coffee_shop');
  assert.equal(energy.causal_confidence, 'suspected');
  assert.equal(a.diagnosis.cascade_suspected, true);
  assert.equal(validateGameDaily(report, { automationIds: ['custom-zzz'] }).overallStatus, 'action_required');
});

test('MAA preserves completed main/credit tasks with subtask noise and configured manual reminders', async t => {
  const f = await fixture(t);
  await f.text('maa.log', ['开始唤醒','理智作战','基建换班','访问好友','信用收支','领取奖励'].map((label, n) => `[2026-09-15 03:0${n}:00] 完成任务: ${label}`).concat([
    '[2026-09-15 03:06:00] Name 自动公招, IsEnable false', '[2026-09-15 03:07:00] Name 自动肉鸽, IsEnable false',
  ]).join('\n'));
  await f.text('asst.log', [
    '[2026-09-15 03:01:00] SubTaskError {"taskchain": "Infrast"}',
    '[2026-09-15 03:04:00] SubTaskError {"taskchain": "Mall", "task":"CreditShop-NoMoney"}',
    '[2026-09-15 03:04:30] TaskChainCompleted {"taskchain": "Mall"}',
  ].join('\n'));
  const report = await readGameDaily({ scope: f.scope, window, reportMeta: meta, automations: [{ id: 'custom-maa', ...maaRules({ manualAnnihilationDue: true }), runs: [{ logFile: 'maa.log', engineLogFile: 'asst.log' }] }] });
  const a = report.automations[0];
  assert.equal(a.status_hint, 'ok');
  assert.equal(a.tasks.find(task => task.task_id === 'maa.credit_purchase').outcome, 'success');
  assert.equal(a.tasks.find(task => task.task_id === 'maa.clue_handling').outcome, 'success');
  assert.equal(a.tasks.find(task => task.task_id === 'maa.annihilation').required, false);
  assert.equal(report.action_candidates[0].type, 'manual_reminder');
  validateGameDaily(report, { automationIds: ['custom-maa'] });
});

test('Scheduler start without matching end is verify; unrelated later completion cannot close it', async t => {
  const f = await fixture(t);
  await f.text('scheduler.log', '[2026-09-15 04:00:00] 定时唤起任务\n[2026-09-15 04:00:01] 任务 aaaa-1111 检索完成，包含 3 个脚本项\n[2026-09-15 05:00:00] 定时唤起任务\n[2026-09-15 05:10:00] 任务结束: aaaa-1111');
  await f.text('frontend.log', '[2026-09-15 04:10:00] 收到Accomplish信号 bbbb-2222');
  const report = await readGameDaily({ scope: f.scope, window, reportMeta: meta, scheduler: { appLog: 'scheduler.log', frontendLog: 'frontend.log', expectedItems: 3 }, automations: [{ id: 'empty', tasks: [], runs: [] }] });
  assert.equal(report.scheduler.status_hint, 'verify');
  assert.equal(report.scheduler.ended_at, null);
  assert.equal(report.automations[0].reported_top_level_status, 'not_observed');
  assert.equal(report.automations[0].status_hint, 'not_run');
  validateGameDaily(report, { automationIds: ['empty'] });
});

test('Unavailable game files remain explicit and differ from a supplied no-run inventory', async t => {
  const f = await fixture(t);
  const report = await readGameDaily({ scope: f.scope, window, reportMeta: meta, automations: [
    { id: 'zero', tasks: [], runs: [] }, { id: 'unavailable', tasks: [], runs: [{ logFile: 'missing.log' }] },
  ] });
  assert.equal(report.automations[0].warnings.length, 0);
  assert.ok(report.automations[1].warnings.some(value => value.includes('unavailable')));
  assert.deepEqual(report.evidence.missing_sources, ['unavailable.run1.log']);
  validateGameDaily(report, { automationIds: ['zero', 'unavailable'] });
});

test('Raw game windows use source offsets and midnight rollover; future success cannot cure earlier failure', async t => {
  const f = await fixture(t);
  const parsed = parseLogLines(Buffer.from('[23:59:00] start\n[00:01:00] end'), { fallbackDate: '2026-09-14', sourceUtcOffset: '+00:00', limits: f.scope.limits });
  assert.equal(new Date(parsed[1].time).toISOString(), '2026-09-15T00:01:00.000Z');
  await f.text('future.log', '[2026-09-16 07:59:00] FAIL\n[2026-09-16 08:00:00] SUCCESS');
  const report = await readGameDaily({ scope: f.scope, window, reportMeta: { ...meta, source_timezone: 'Asia/Shanghai', source_utc_offset: '+08:00' }, automations: [{ id: 'offset', tasks: [{ taskId: 'custom.task', required: true, failureMarkers: ['FAIL'], successMarkers: ['SUCCESS'] }], runs: [{ logFile: 'future.log' }] }] });
  assert.equal(report.automations[0].tasks[0].outcome, 'failed');
  assert.equal(report.automations[0].tasks[0].ended_at, '2026-09-15T23:59:00.000Z');
});

test('Message clipping keeps evidence bounded and reports truncation', async t => {
  const f = await fixture(t, { maxMessageChars: 80 });
  await f.json('threads.json', { threads: [thread('clip')] });
  await f.jsonl('clip.jsonl', [codexMessage(window.start, 'user', 'A'.repeat(1000) + 'ENDING')]);
  const report = await readCodexDaily({ scope: f.scope, window, threadsFile: 'threads.json' });
  const message = report.top_level_sessions[0].turns[0].user_requests[0];
  assert.equal(message.text.length, 80);
  assert.ok(message.text.endsWith('ENDING'));
  assert.equal(message.truncated, true);
});

test('Legacy UTF-8 BOM, GB18030/CP936 and explicit UTF-16 logs decode without lossy replacement', async t => {
  const f = await fixture(t);
  const gbk = Buffer.concat([Buffer.from('[2026-09-15 01:00:00] '), Buffer.from('b3c9b9a6', 'hex')]);
  assert.equal(decodeText(gbk, 'auto'), '[2026-09-15 01:00:00] 成功');
  assert.equal(decodeText(gbk, 'cp936'), '[2026-09-15 01:00:00] 成功');
  assert.equal(decodeText(Buffer.from([0x90, 0x30, 0x81, 0x30]), 'gb18030').codePointAt(0), 0x10000);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('成功', 'utf16le')])), '成功');
  assert.equal(decodeText(Buffer.from('\uFEFF成功', 'utf8')), '成功');
  await writeFile(join(f.root, 'gbk.log'), gbk);
  const r = await readGameDaily({ scope: f.scope, window, reportMeta: meta, automations: [{ id: 'gbk', tasks: [{ taskId: 'gbk.main', successMarkers: ['成功'] }], runs: [{ logFile: 'gbk.log' }] }] });
  assert.equal(r.automations[0].tasks[0].outcome, 'success');
  assert.throws(() => decodeText(Buffer.from([0xff]), 'utf-8'), { code: 'encoding' });
});

test('IANA windows handle 23/25-hour Melbourne days and explicit ambiguity policies', () => {
  const spring = calendarWindow({ businessDate: '2026-10-04', timeZone: 'Australia/Melbourne' });
  const autumn = calendarWindow({ businessDate: '2026-04-05', timeZone: 'Australia/Melbourne' });
  assert.equal(Date.parse(spring.end) - Date.parse(spring.start), 23 * 3600000);
  assert.equal(Date.parse(autumn.end) - Date.parse(autumn.start), 25 * 3600000);
  const earlier = localTimestamp('2026-04-05', '02:30:00', { sourceTimezone: 'Australia/Melbourne' });
  const later = localTimestamp('2026-04-05', '02:30:00', { sourceTimezone: 'Australia/Melbourne', disambiguation: 'later' });
  assert.equal(later - earlier, 3600000);
  assert.throws(() => localTimestamp('2026-04-05', '02:30:00', { sourceTimezone: 'Australia/Melbourne', disambiguation: 'reject' }), { code: 'timestamp' });
  assert.throws(() => localTimestamp('2026-10-04', '02:30:00', { sourceTimezone: 'Australia/Melbourne', disambiguation: 'reject' }), { code: 'timestamp' });
  const reportZone = calendarWindow({ businessDate: '2026-08-03T23:30:00+00:00', timeZone: 'Asia/Shanghai' });
  assert.equal(reportZone.date, '2026-08-04');
  assert.equal(reportZone.start, '2026-08-03T16:00:00.000Z');
});

test('Raw IANA timestamps cross DST without fixed-offset drift', async t => {
  const f = await fixture(t);
  const lines = parseLogLines(Buffer.from('[2026-10-04 01:59:00] BEFORE\n[2026-10-04 03:01:00] AFTER'), { sourceTimezone: 'Australia/Melbourne', limits: f.scope.limits });
  assert.equal(lines[1].time - lines[0].time, 120000);
  const report = await readGameDaily({ scope: f.scope, reportMeta: { ...meta, business_date: '2026-10-04', source_timezone: 'Australia/Melbourne', report_timezone: 'Australia/Melbourne', collected_at: '2026-10-05T01:00:00+11:00' }, automations: [] });
  assert.equal(report.report_meta.source_utc_offset, '+10:00');
  assert.equal(report.report_meta.business_date, '2026-10-04');
});

test('Explicit AUTO-MAS history/config/screenshot roots merge MAA runs and preserve historical metrics', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'history', window.date, 'nested'), { recursive: true });
  await mkdir(join(f.root, 'screenshots'));
  const base = `history/${window.date}/nested`;
  await f.json(`${base}/ann.json`, { maa_result: 'Success!' });
  await f.text(`${base}/ann.log`, '[2026-09-15 03:00:00] MaaAssistantArknights selected Annihilation\n[2026-09-15 03:02:00] 剿灭作战');
  await f.json(`${base}/routine.json`, { maa_result: 'Success!', drop_statistics: { 'synthetic-item': 6 }, sanity_full_at: 'Expected 2026-09-15 11:23' });
  const complete = ['开始唤醒', '理智作战', '基建换班', '访问好友', '信用收支', '领取奖励'];
  await f.text(`${base}/routine.log`, [
    '[2026-09-15 03:10:00] MaaAssistantArknights routine', '[2026-09-15 03:10:01] 理智: 135/210',
    ...complete.map((label, n) => `[2026-09-15 03:1${n}:30] 完成任务: ${label}`),
    '[2026-09-15 03:16:00] 开始行动 1~6 次', '[2026-09-15 03:17:00] 理智: 5/210',
    '[2026-09-15 03:18:00] Name 自动公招, IsEnable false', '[2026-09-15 03:19:00] Name 自动肉鸽, IsEnable false',
  ].join('\n'));
  await f.text('engine.log', '[2026-09-15 03:00:30] SubTaskError {"taskchain":"Infrast"}\n[2026-09-15 03:11:30] SubTaskError {"taskchain":"Infrast"}\n[2026-09-15 03:14:00] SubTaskError {"taskchain":"Mall","task":"CreditShop-NoMoney"}\n[2026-09-15 03:14:10] TaskChainCompleted {"taskchain":"Mall"}');
  await f.json('scripts.json', { instances: [{ uid: 'maa-config', type: 'MAAConfig' }], 'maa-config': { Info: { Name: 'Synthetic MAA' }, SubConfigsInfo: { UserData: { instances: [{ uid: 'off' }, { uid: 'on' }], off: { Info: { Name: 'Disabled account', Status: false } }, on: { Info: { Name: 'Synthetic active account', Status: true } } } } } });
  await f.json('queues.json', { instances: [{ uid: 'daily' }], daily: { Info: { Name: 'Synthetic queue', TimeEnabled: false } } });
  await writeFile(join(f.root, 'screenshots', 'proof.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zy1cAAAAASUVORK5CYII=', 'base64'));
  await utimes(join(f.root, 'screenshots', 'proof.png'), epoch('2026-09-15T03:18:00Z'), epoch('2026-09-15T03:18:00Z'));
  const definitions = autoMasDefinitions({ manualAnnihilationDue: true }).filter(def => def.id === 'arknights_maa');
  const report = await readAutoMasDaily({ scope: f.scope, window, reportMeta: meta, historyRoot: 'history', scriptConfigFile: 'scripts.json', queueConfigFile: 'queues.json',
    engineLogFiles: { default: 'engine.log' }, automations: definitions, screenshotDirectories: [{ path: 'screenshots', automation_id: 'arknights_maa' }] });
  const automation = report.automations[0], metrics = Object.fromEntries(automation.metrics.map(metric => [metric.metric_id, metric]));
  assert.equal(automation.started_at, '2026-09-15T03:00:00.000Z');
  assert.equal(automation.ended_at, '2026-09-15T03:19:00.000Z');
  assert.equal(automation.account, 'Synthetic active account');
  assert.equal(automation.status_hint, 'ok');
  assert.equal(report.scheduler.name, 'Synthetic queue');
  assert.equal(report.scheduler.expected_to_run, false);
  assert.equal(metrics['maa.sanity'].before, 135);
  assert.equal(metrics['maa.sanity'].after, 5);
  assert.equal(metrics['maa.sanity'].value, 5);
  assert.equal(metrics['maa.sanity'].estimated_at, '2026-09-15T11:23:00.000Z');
  assert.equal(metrics['maa.stage_runs'].value, 6);
  assert.deepEqual(metrics['maa.drops'].value, { 'synthetic-item': 6 });
  assert.deepEqual(metrics['maa.subtask_error_counts'].value, { infrastructure: 1, mall: 1 });
  assert.equal(metrics['maa.annihilation_navigation_retry_count'].value, 0);
  assert.equal(report.evidence.screenshots.length, 1);
  assert.equal(report.evidence.sources.filter(source => source.kind === 'configuration').length, 2);
  validateGameDaily(report, { automationIds: ['arknights_maa'] });
});

test('Explicit AUTO-MAS history inventory supports mtime fallback and reports missing screenshots', async t => {
  const f = await fixture(t);
  await f.json('record.json', { general_result: 'Success!' });
  await f.text('record.log', 'Synthetic un-timestamped classification text');
  await utimes(join(f.root, 'record.json'), epoch('2026-09-15T08:00:00Z'), epoch('2026-09-15T08:00:00Z'));
  const report = await readAutoMasDaily({ scope: f.scope, window, reportMeta: meta, historyFiles: [{ resultFile: 'record.json', kind: 'custom' }],
    automations: [{ id: 'custom', historyKinds: ['custom'], tasks: [] }], screenshots: [{ screenshot_id: 'missing-image', automation_id: 'custom', path: 'missing.png', description: 'Expected exported evidence' }] });
  assert.equal(report.automations[0].run_observed, true);
  assert.equal(report.automations[0].started_at, '2026-09-15T08:00:00.000Z');
  assert.ok(report.evidence.missing_sources.includes('missing-image'));
});

test('Policy cycles reject and chronological recovery does not turn early cleanup failure into harmless late noise', async t => {
  const f = await fixture(t);
  await f.text('policy.log', '[2026-09-15 01:00:00] CLEANUP FAIL\n[2026-09-15 01:01:00] MAIN DONE\n[2026-09-15 01:02:00] RECOVER FAIL\n[2026-09-15 01:03:00] RECOVER DONE');
  const settings = { scope: f.scope, window, reportMeta: meta, automations: [{ id: 'policy', tasks: [
    { taskId: 'cleanup', required: false, failureMarkers: ['CLEANUP FAIL'], nonblockingAfterTaskId: 'main' }, { taskId: 'main', successMarkers: ['MAIN DONE'] },
    { taskId: 'recover', successMarkers: ['RECOVER DONE'], failureMarkers: ['RECOVER FAIL'] },
  ], runs: [{ logFile: 'policy.log' }] }] };
  const report = await readGameDaily(settings);
  assert.equal(report.automations[0].tasks[0].outcome, 'failed');
  assert.equal(report.automations[0].tasks[2].outcome, 'success');
  settings.automations[0].tasks[1].followMainTaskId = 'cleanup';
  await assert.rejects(readGameDaily(settings), { code: 'config' });
});

test('Configured tail reads are bounded and explicitly partial, with complete text lines retained', async t => {
  const f = await fixture(t);
  const text = '[2026-09-15 00:00:00] ' + 'older data '.repeat(100) + '\n[2026-09-15 01:00:00] MAIN START\n[2026-09-15 01:01:00] MAIN DONE\n';
  await f.text('large.log', text);
  const report = await readGameDaily({ scope: f.scope, window, reportMeta: meta, automations: [{ id: 'tail', tasks: [{ taskId: 'tail.main', successMarkers: ['MAIN DONE'] }], runs: [{ logFile: 'large.log', readMode: 'tail', maxBytes: 120 }] }] });
  assert.equal(report.automations[0].tasks[0].outcome, 'success');
  assert.equal(report.evidence.sources[0].read_status, 'partial');
  assert.ok(report.automations[0].warnings.some(text => text.includes('tail')));
  assert.equal(f.scope.evidence[0].bytes, 120);
  assert.ok(f.scope.evidence[0].original_bytes > 1000);
});

test('Configured untimed marker compatibility keeps exact task timestamps unknown', async t => {
  const f = await fixture(t);
  await f.text('untimed.log', '[2026-09-15 01:00:00] START\nMAIN DONE\n[2026-09-15 01:05:00] END');
  const report = await readGameDaily({ scope: f.scope, window, reportMeta: meta, automations: [{ id: 'untimed', includeUntimedMarkers: true, tasks: [{ taskId: 'untimed.main', successMarkers: ['MAIN DONE'] }, { taskId: 'untimed.strict', timestampRequired: true, successMarkers: ['MAIN DONE'] }], runs: [{ logFile: 'untimed.log' }] }] });
  assert.equal(report.automations[0].tasks[0].outcome, 'success');
  assert.equal(report.automations[0].tasks[0].ended_at, null);
  assert.equal(report.automations[0].tasks[1].outcome, 'uncertain');
});

test('Legacy OneDragon failure precedence and explicit unscoped frontend fallback are available', async t => {
  const f = await fixture(t);
  await f.text('zzz-recovery.log', '[2026-09-15 01:00:00] 指令[ 咖啡店 ] 执行失败\n[2026-09-15 01:01:00] 指令[ 咖啡店 ] 执行成功');
  await f.text('app.log', '[2026-09-15 00:59:00] 定时唤起任务\n[2026-09-15 00:59:01] 任务 abc-123 检索完成，包含 1 个脚本项');
  await f.text('front.log', '[2026-09-15 01:02:00] 收到Accomplish信号');
  const report = await readGameDaily({ scope: f.scope, window, reportMeta: meta, scheduler: { appLog: 'app.log', frontendLog: 'front.log', allowUnscopedFrontendEnd: true }, automations: [{ id: 'legacy-zzz', ...oneDragonRules({ enabledTasks: ['coffee_shop'] }), runs: [{ logFile: 'zzz-recovery.log' }] }] });
  assert.equal(report.automations[0].tasks.find(task => task.task_id === 'zzz.coffee_shop').outcome, 'failed');
  assert.equal(report.scheduler.status_hint, 'verify');
  assert.equal(report.scheduler.ended_at, null);
  assert.equal(report.scheduler.reported_top_level_status, 'unscoped_completion_observed');
  assert.ok(report.scheduler.warnings.some(text => text.includes('unscoped')));
});
