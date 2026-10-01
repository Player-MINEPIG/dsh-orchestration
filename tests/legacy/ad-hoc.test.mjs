// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { TaskLedger } from '../../packages/task-system/dist/index.js';
import { createSourceScope, readCodexDaily, readHermesDaily } from '../../examples/legacy-task-pack/readers/index.mjs';
import { createDailyWorkInput, buildDailyWorkSummary, validateDailyWorkSummary, renderDailyWorkSummary, getDailyWorkInput, createLegacyTemplates, registerLegacyTaskPack, registerLegacyRenderers, prepareLegacyReport } from '../../examples/legacy-task-pack/index.mjs';
const window = { start: '2026-09-15T00:00:00Z', end: '2026-09-16T00:00:00Z', date: '2026-09-15', timezone: 'UTC' };
async function input() {
  const scope = await createSourceScope(resolve('examples/legacy-task-pack/readers/fixtures'));
  const codex = await readCodexDaily({ scope, window, threadsFile: 'codex-threads.json' });
  const hermes = await readHermesDaily({ scope, window, exportFile: 'hermes-export.json' });
  const continued = structuredClone(codex.top_level_sessions[0].turns[0]); continued.turn_id = 'synthetic-ongoing'; continued.has_final_answer = false; continued.final_answers = [];
  codex.top_level_sessions[0].turns.push(continued); codex.counts.user_turn_count++;
  const refs = ['codex:synthetic-codex:synthetic-turn', 'codex:synthetic-codex:synthetic-ongoing', 'hermes:synthetic-hermes:synthetic-hermes:m3'];
  const semantic = { turns: refs.map((source_ref, i) => ({ source_ref, status: i === 1 ? 'ongoing' : 'completed' })), groups: [
    { group_id: 'objective-one', title: '完成合成项目的第一步', importance: 20, turn_refs: refs.slice(0, 2), accomplishments: ['完成第一步验证', '确认继续推进的边界'] },
    { group_id: 'objective-two', title: '确认独立请求', importance: 80, turn_refs: [refs[2]], accomplishments: ['完成独立请求', '保留独立任务证据'] },
  ], attention: [{ title: '尚待完成后续工作', detail: '源 turn 尚无最终回复', turn_refs: [refs[1]] }] };
  return createDailyWorkInput({ nodeId: 'worker', codex, hermes, semantic });
}
test('Ad-hoc themes use included turns, span sessions, retain continued sessions and never use root task shares', async () => {
  const source = await input(), before = structuredClone(source), report = buildDailyWorkSummary(source);
  assert.deepEqual(source, before); assert.equal(report.summary.user_turns.total, 3); assert.equal(report.summary.user_turns.completed, 2);
  assert.deepEqual(report.themes.map(t => t.share_percent), [66.67, 33.33]); assert.equal(report.summary.sessions.codex.continued, 1);
  assert.equal(report.themes[0].importance, 20); assert.equal(report.usage.codex_all.observability, 'exact'); assert.equal(report.usage.hermes_local.observability, 'partial');
  assert.doesNotThrow(() => validateDailyWorkSummary(report)); assert.deepEqual(getDailyWorkInput(report), source);
  const grouped = structuredClone(source); grouped.semantic.groups[0].turn_refs.push(grouped.semantic.groups[1].turn_refs[0]); grouped.semantic.groups.pop(); assert.equal(buildDailyWorkSummary(grouped).themes[0].turn_count, 3);
});
test('Ad-hoc source closure rejects omitted/invented/repeated turns, fake completion, invalid attention and model counts', async () => {
  const source = await input();
  for (const change of [x => x.semantic.groups.pop(), x => x.semantic.groups[0].turn_refs.push('fabricated'), x => x.semantic.groups[1].turn_refs.push(x.semantic.groups[0].turn_refs[0]), x => x.semantic.turns[1].status = 'completed', x => x.semantic.attention[0].turn_refs = [x.semantic.turns[0].source_ref], x => x.semantic.counts = 100]) { const changed = structuredClone(source); change(changed); assert.throws(() => buildDailyWorkSummary(changed)); }
  for (const change of [x => x.summary.user_turns.total++, x => x.themes[0].share_percent = 50, x => x.summary.sessions.codex.new++, x => x.themes[0].completed_turn_count++]) { const changed = buildDailyWorkSummary(source); change(changed); assert.throws(() => validateDailyWorkSummary(changed)); }
});
test('Ad-hoc rendering is outcome-first, compact evidence, conditional attention, tokens and explicit non-time shares', async () => {
  const source = await input(), report = buildDailyWorkSummary(source), output = renderDailyWorkSummary(report);
  assert.match(output.body, /^2026-09-15 共推进 2/); assert.match(output.body, /完成 2\/3 个用户任务/); assert.match(output.body, /任务 1\/2 · 66.67%/); assert.match(output.body, /需关注/); assert.match(output.body, /不是时间占比/); assert.match(output.body, /codex_all: input 0/);
  source.language = 'en'; source.semantic.attention = []; const english = renderDailyWorkSummary(buildDailyWorkSummary(source)); assert.match(english.body, /Shares are included user-turn counts/); assert.doesNotMatch(english.body, /Needs attention/);
});
test('Ad-hoc empty and unavailable source quality remain explicit rather than invented activity', async () => {
  const scope = await createSourceScope(resolve('examples/legacy-task-pack/readers/fixtures'));
  const codex = await readCodexDaily({ scope, window, threadsFile: 'missing.json' }); const hermes = await readHermesDaily({ scope, window, exportFile: 'missing.json' });
  const report = buildDailyWorkSummary(createDailyWorkInput({ nodeId: 'worker', codex, hermes, semantic: { turns: [], groups: [], attention: [] } }));
  assert.equal(report.data_quality.status, 'unavailable'); assert.equal(report.summary.user_turns.total, 0); assert.equal(report.usage.codex_all.total_tokens, null); assert.match(renderDailyWorkSummary(report).body, /unavailable/);
});
test('Ad-hoc preparation and trusted semantic renderer integrate with real ledger without early settlement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-ad-hoc-')); const ledger = TaskLedger.open(join(directory, 'tasks.sqlite'));
  const dispose = registerLegacyTaskPack(ledger), renderers = new Map(); const unmount = registerLegacyRenderers({ registerTaskReportRenderer(id, callback) { renderers.set(id, callback); return () => renderers.delete(id); } }, ledger);
  try {
    const template = createLegacyTemplates().find(t => t.defaults.kind === 'daily_work_summary'); ledger.updateTemplate('template', template);
    ledger.registerNode('node', { nodeId: 'worker', enabled: true, roles: ['executor'], capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'synthetic', model: 'synthetic', reasoningEfforts: [] }], workspaceIds: [], lastSeenAt: new Date().toISOString() });
    const task = ledger.createTask('task', { title: 'Ad-hoc review' }).value, run = ledger.createRun('run', { taskId: task.taskId, route: { nodeId: 'worker', provider: 'synthetic', model: 'synthetic', requiredCapabilities: ['legacy.task-pack.v1'] }, configuration: { template, input: { sourceIds: ['synthetic'], windowStart: window.start, windowEnd: window.end } } }).value;
    const attempt = ledger.claim('claim', { runId: run.runId, nodeId: 'worker', ttlMs: 60000 }).value.attempt, lease = { runId: run.runId, attemptId: attempt.attemptId, nodeId: 'worker', fence: attempt.fence };
    const prepared = prepareLegacyReport(ledger, 'prepare', { kind: 'daily_work_summary', lease, payload: buildDailyWorkSummary(await input()) });
    assert.equal(ledger.getRun(run.runId).state, 'running'); assert.equal(ledger.snapshot().reports.length, 0); assert.deepEqual(prepared.report.artifactIds, []);
    const drift = structuredClone(prepared.report); drift.data.payload.summary.user_turns.total++;
    assert.throws(() => ledger.submit('fake', { ...lease, outcome: 'success', summary: 'Fake', report: drift }), error => error.code === 'RESULT_VALIDATION');
    ledger.submit('settle', { ...lease, outcome: 'success', summary: prepared.summary, report: prepared.report });
    const stored = ledger.snapshot().reports[0]; assert.equal(renderers.get(stored.schemaId)({ task, run: ledger.getRun(run.runId), report: stored }).card.schema, '2.0');
    assert.equal(ledger.getRun(run.runId).state, 'succeeded');
  } finally { unmount(); dispose(); ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});
