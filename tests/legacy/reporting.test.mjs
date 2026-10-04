import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, truncateSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskLedger } from '../../packages/task-system/dist/index.js';
import { buildAgentDaily, validateAgentDaily, validateGameDaily, normalizeAgentDaily, normalizeGameDaily, normalizeAutomationEvidence, buildNodeReport, validateNodeEvidenceGate, summarizeQuotaBoundaries, canonicalJson, createLegacyTemplates, registerLegacyTaskPack, registerLegacyRenderers, prepareLegacyReport, settleLegacyReport, settleLegacyFailure } from '../../examples/legacy-task-pack/index.mjs';
import { dailyInput, gameReport, automationTask, collectorEvidence, WINDOW } from './synthetic-fixtures.mjs';
const clone = structuredClone;

test('Agent Daily builder owns IDs/counts/shares and canonical duplicate accounting', () => {
  const input = dailyInput(); const before = clone(input); const report = buildAgentDaily(input);
  assert.deepEqual(input, before); assert.equal(report.summary.task_counts.total, 2); assert.equal(report.summary.task_counts.failed, 1);
  assert.deepEqual(report.work_items.map(w => w.share_percent), [50, 50]); assert.equal(report.summary.overall_status, 'attention');
  assert.equal(canonicalJson(buildAgentDaily(input)), canonicalJson(report)); assert.equal(report.usage.hermes.observability, 'partial');
});
test('Agent Daily rejects omitted/fabricated/repeated semantics and duplicate cycles', () => {
  const missing = dailyInput(); missing.semantic.groups.pop(); assert.throws(() => buildAgentDaily(missing), /Missing/);
  const invented = dailyInput(); invented.semantic.groups[0].candidate_ids.push('unknown'); assert.throws(() => buildAgentDaily(invented), /Invented/);
  const repeated = dailyInput(); repeated.semantic.groups[1].candidate_ids.push('one'); assert.throws(() => buildAgentDaily(repeated), /unique/);
  const cyclic = dailyInput(); cyclic.semantic.duplicate_resolutions.push({ duplicate_candidate_id: 'one', canonical_candidate_id: 'copy-one' }); assert.throws(() => buildAgentDaily(cyclic), /Cyclic/);
  const injected = dailyInput(); injected.semantic.task_counts = { total: 300 }; assert.throws(() => buildAgentDaily(injected), /unsupported/);
});
test('Agent Daily validator rejects count/share/attention/quality drift', () => {
  for (const mutate of [r => r.summary.task_counts.total++, r => r.work_items[0].share_percent = 80, r => r.attention_items[0].priority = 'invalid', r => r.data_quality.missing_devices.push('missing')]) {
    const r = buildAgentDaily(dailyInput()); mutate(r); assert.throws(() => validateAgentDaily(r));
  }
});
test('Normalization preserves report-wide attention and only hides explicitly configured policy gaps', () => {
  const input = buildAgentDaily(dailyInput()); input.attention_items[0].work_id = 'source-quality-pseudo-id'; input.data_quality.notes = ['coordinator codex intentionally disabled by policy', 'node-one source read failed'];
  const normalized = normalizeAgentDaily(input, { policySkippedSources: [{ nodeId: 'coordinator', runtime: 'codex' }] });
  assert.equal(normalized.attention_items[0].work_id, ''); assert.equal(input.attention_items[0].work_id, 'source-quality-pseudo-id');
  assert.deepEqual(normalized.data_quality.notes, ['node-one source read failed']);
  const game = gameReport(); game.automations[0].reported_top_level_status = null; assert.equal(normalizeGameDaily(game).automations[0].reported_top_level_status, null); assert.throws(() => validateGameDaily(game));
});
test('Game business failure does not invalidate successful observation, and optional work only verifies', () => {
  const r = gameReport(); r.automations[0].tasks[0].outcome = 'failed'; r.automations[1].tasks[0].required = false; r.automations[1].tasks[0].outcome = 'uncertain';
  const validated = validateGameDaily(r); assert.equal(validated.statusById.hsr_march7thassistant, 'action_required'); assert.equal(validated.statusById.zzz_onedragon, 'verify');
  r.evidence.missing_sources.push('optional screenshot'); assert.equal(validateGameDaily(r).statusById.arknights_maa, 'ok');
});
test('Game rejects null/no-run mismatch, missing evidence, wrong causal/action ownership and scheduler fiction', () => {
  const invalids = [r => { r.automations[0].reported_top_level_status = null; }, r => { r.automations[0].run_observed = false; }, r => { r.automations[0].tasks[0].evidence_refs = ['absent']; }, r => { r.automations[0].tasks[0].caused_by_task_id = r.automations[0].tasks[0].task_id; }, r => { r.scheduler.ended_at = null; }];
  for (const mutate of invalids) { const r = gameReport(); mutate(r); assert.throws(() => validateGameDaily(r)); }
  const open = gameReport(); open.scheduler.ended_at = null; open.scheduler.status_hint = 'verify'; open.scheduler.warnings = ['Terminal signal not observed']; assert.doesNotThrow(() => validateGameDaily(open));
  const cross = gameReport(); cross.action_candidates = [{ action_id: 'action', priority: 'p1', automation_id: cross.automations[0].automation_id, task_ids: [cross.automations[1].tasks[0].task_id], type: 'investigate_then_rerun', title: 'Review', detail: 'No automatic rerun' }]; assert.throws(() => validateGameDaily(cross), /another automation/);
});
test('Configurable HSR cleanup, MAA main/substep and ZZZ suspected cascade retain distinctions', () => {
  let a = gameReport().automations[0]; a.tasks = [automationTask('shutdown'), automationTask('screenshot', 'failed')];
  a = normalizeAutomationEvidence(a, { rules: [{ category: 'screenshot', nonblockingAfterCategory: 'shutdown' }] }); assert.equal(a.tasks[1].outcome, 'skipped_nonblocking');
  let maa = gameReport().automations[2]; maa.tasks = [automationTask('infrastructure'), automationTask('clue-substep', 'failed')]; maa = normalizeAutomationEvidence(maa, { rules: [{ category: 'clue-substep', mainTaskCategory: 'infrastructure' }] }); assert.equal(maa.tasks[1].required, false);
  let zzz = gameReport().automations[1]; zzz.tasks = [automationTask('coffee', 'failed'), automationTask('later', 'failed')]; zzz = normalizeAutomationEvidence(zzz, { cascadeSuspectedFromCategory: 'coffee' }); assert.equal(zzz.tasks[1].causal_confidence, 'suspected'); assert.equal(zzz.diagnosis.cascade_suspected, true);
});
test('Node builder closes evidence and scopes account window; missing source stays unavailable', () => {
  const sources = collectorEvidence(); const built = buildNodeReport({ nodeId: 'node-one', accountMeasurementNodeId: 'node-one', ...sources });
  assert.equal(built.work_candidates.length, 1); assert.equal(built.usage.codex_account.change, 1);
  sources.codex.account_usage.last.primary.resets_at = '2026-10-04T00:00:00Z'; assert.equal(buildNodeReport({ nodeId: 'node-one', accountMeasurementNodeId: 'node-one', ...sources }).usage.codex_account.change, null);
  assert.equal(buildNodeReport({ nodeId: 'node-two', accountMeasurementNodeId: 'node-one', ...sources }).usage.codex_account.observability, 'unavailable');
  sources.semantic.candidates = []; assert.throws(() => buildNodeReport({ nodeId: 'node-one', ...sources }), /Missing collector turns/);
  const unavailable = collectorEvidence(); unavailable.codex.token_totals_all_sessions = { input_tokens: null, cached_input_tokens: null, output_tokens: null, total_tokens: null, observability: 'unavailable' }; unavailable.codex.data_quality = { complete: false, errors: [{ code: 'SOURCE_UNAVAILABLE', message: 'Synthetic source missing' }] };
  const partial = buildNodeReport({ nodeId: 'node-one', ...unavailable }); assert.equal(partial.usage.codex.observability, 'unavailable'); assert.equal(partial.usage.codex.total_tokens, null); assert.match(partial.data_quality.notes[0], /Synthetic source missing/);
});
test('Root node gate refuses omitted successful evidence and records failed-node source gaps', () => {
  const report = buildNodeReport({ nodeId: 'node-one', ...collectorEvidence() }); const input = dailyInput();
  const accepted = { nodeId: 'node-one', rootTaskId: input.report_context.root_task_id, outcome: 'success', validation: 'valid', report };
  assert.throws(() => validateNodeEvidenceGate(input, [accepted], ['node-one']), /Omitted/);
  input.candidates.push({ ...input.candidates[0], candidate_id: report.work_candidates[0].candidate_id }); assert.equal(validateNodeEvidenceGate(input, [accepted], ['node-one']), true);
  assert.throws(() => validateNodeEvidenceGate(input, [], ['node-one']), /must be declared/);
  input.data_quality.missing_devices = ['node-one']; input.report_context.source_data_status = 'partial'; assert.equal(validateNodeEvidenceGate(input, [], ['node-one']), true);
});
test('Quota preserves decimal precision, net movement, boundary tolerance and missing-first-day uncertainty', () => {
  const sample = (capturedAt, value) => ({ provider: 'configured-provider', metric: 'balance', unit: 'CNY', capturedAt, value });
  const rows = [sample(WINDOW.start, '9007199254740993.11'), sample(WINDOW.end, '9007199254740992.01')];
  const exact = summarizeQuotaBoundaries(rows, { windowStart: WINDOW.start, windowEnd: WINDOW.end })[0]; assert.equal(exact.change, '-1.10'); assert.equal(exact.movement_kind, 'net_balance_movement');
  const missing = summarizeQuotaBoundaries([rows[1]], { windowStart: WINDOW.start, windowEnd: WINDOW.end })[0]; assert.equal(missing.change, null); assert.equal(missing.observability, 'unavailable');
});

function ledgerFixture(kind = 'agent_daily') {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-task-pack-')); let clock = Date.now(); const ledger = TaskLedger.open(join(dir, 'ledger.sqlite'), { now: () => clock });
  const dispose = registerLegacyTaskPack(ledger); const template = createLegacyTemplates().find(t => t.defaults.kind === kind);
  ledger.updateTemplate('template', template); ledger.registerNode('node', { nodeId: 'worker', roles: ['executor'], capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'fixture', model: 'fixture', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
  const task = ledger.createTask('create', { taskId: 'task-daily', title: 'Synthetic configured report' }).value;
  const run = ledger.createRun('run', { taskId: task.taskId, runId: 'run-daily', route: { nodeId: 'worker', provider: 'fixture', model: 'fixture', requiredCapabilities: ['legacy.task-pack.v1'] }, configuration: { template, input: { sourceIds: ['synthetic'], windowStart: WINDOW.start, windowEnd: WINDOW.end } } }).value;
  const attempt = ledger.claim('claim', { runId: run.runId, nodeId: 'worker', ttlMs: 60000 }).value.attempt;
  return { ledger, dir, dispose, run, advance: ms => { clock += ms; }, lease: { runId: run.runId, attemptId: attempt.attemptId, nodeId: attempt.nodeId, fence: attempt.fence }, close() { dispose(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('Trusted semantic gate rejects model shape-only success before state/report/outbox mutation', () => {
  const f = ledgerFixture(); try {
    assert.throws(() => f.ledger.submit('forged', { ...f.lease, outcome: 'success', summary: 'looks valid', report: { title: 'Fake', body: 'Fake', schemaId: 'agent_daily_report.v1', data: { fake: true }, artifactIds: [] }, notifications: [{ destination: 'fixture', kind: 'test', payload: {} }] }), e => e.code === 'RESULT_VALIDATION');
    assert.equal(f.ledger.getRun(f.run.runId).state, 'running'); assert.equal(f.ledger.snapshot().reports.length, 0); assert.equal(f.ledger.deliveries().length, 0);
  } finally { f.close(); }
});
test('Validated daily artifact settles, persists full payload, and delivery remains separate/idempotent', () => {
  const f = ledgerFixture(); try {
    const payload = buildAgentDaily(dailyInput()); const input = { kind: 'agent_daily', lease: f.lease, payload, artifactDirectory: join(f.dir, 'artifacts'), destination: 'fixture' };
    const result = settleLegacyReport(f.ledger, 'settlement', input); const replay = settleLegacyReport(f.ledger, 'settlement', input);
    assert.deepEqual(replay.receipt, result.receipt); assert.equal(f.ledger.getRun(f.run.runId).state, 'succeeded'); assert.equal(f.ledger.snapshot().reports.length, 1);
    assert.equal(f.ledger.snapshot().reports[0].data.payload.summary.task_counts.total, 2); assert.equal(f.ledger.deliveries()[0].state, 'pending');
  } finally { f.close(); }
});
test('Missing provider/root binding/artifact and invalid report paths fail safely; failure card records failure', () => {
  const f = ledgerFixture(); try {
    const payload = buildAgentDaily(dailyInput()); payload.trace.root_run_id = 'wrong-run'; assert.throws(() => settleLegacyReport(f.ledger, 'wrong', { kind: 'agent_daily', lease: f.lease, payload, artifactDirectory: join(f.dir, 'artifacts') }), e => e.code === 'RESULT_VALIDATION');
    f.dispose(); assert.throws(() => settleLegacyReport(f.ledger, 'missing', { kind: 'agent_daily', lease: f.lease, payload: buildAgentDaily(dailyInput()), artifactDirectory: join(f.dir, 'artifacts') }), e => e.code === 'VALIDATOR_UNAVAILABLE');
    const reattach = registerLegacyTaskPack(f.ledger); settleLegacyFailure(f.ledger, 'failed', { lease: f.lease, errors: ['Invalid synthetic source'], destination: 'fixture' }); reattach();
    assert.equal(f.ledger.getRun(f.run.runId).state, 'failed'); assert.equal(f.ledger.snapshot().reports[0].schemaId, 'legacy_task_pack_error.v1');
  } finally { f.close(); }
});

test('Specialized renderer validates authoritative payload/artifact and refuses tampered delivery', () => {
  const f = ledgerFixture(); const providers = new Map();
  const detach = registerLegacyRenderers({ registerTaskReportRenderer(id, fn) { providers.set(id, fn); return () => providers.delete(id); } }, f.ledger);
  try {
    const result = settleLegacyReport(f.ledger, 'done', { kind: 'agent_daily', lease: f.lease, payload: buildAgentDaily(dailyInput()), artifactDirectory: join(f.dir, 'artifacts') });
    const task = f.ledger.getTask('task-daily'); const report = f.ledger.snapshot().reports[0]; const run = f.ledger.getRun('run-daily');
    assert.equal(providers.get(report.schemaId)({ task, run, report }).card.schema, '2.0');
    const artifact = f.ledger.history(task.taskId).artifacts.find(a => a.artifactId === result.artifactId); writeFileSync(artifact.uri, 'tampered');
    assert.throws(() => providers.get(report.schemaId)({ task, run, report }), /changed before delivery/);
    const altered = structuredClone(report); altered.data.payload.summary.task_counts.total++;
    assert.throws(() => providers.get(report.schemaId)({ task, run, report: altered }), /counts/);
  } finally { detach(); assert.equal(providers.size, 0); f.close(); }
});

test('Immutable settlement replay never repairs overwritten byte evidence', () => {
  const f = ledgerFixture(); try {
    const input = { kind: 'agent_daily', lease: f.lease, payload: buildAgentDaily(dailyInput()), artifactDirectory: join(f.dir, 'artifacts') };
    const result = settleLegacyReport(f.ledger, 'done', input); const artifact = f.ledger.history('task-daily').artifacts.find(a => a.artifactId === result.artifactId);
    const original = readFileSync(artifact.uri); const corrupt = Buffer.from(original); corrupt[0] = 88; writeFileSync(artifact.uri, corrupt);
    assert.throws(() => settleLegacyReport(f.ledger, 'done', input), /different bytes/);
    assert.deepEqual(readFileSync(artifact.uri), corrupt); assert.equal(f.ledger.history('task-daily').reports.length, 1);
  } finally { f.close(); }
});
test('Delivery refuses oversized and symbolic-link artifacts before reading bytes', () => {
  for (const mode of ['oversized', 'symlink']) {
    const f = ledgerFixture(); const providers = new Map(); const detach = registerLegacyRenderers({ registerTaskReportRenderer(id, fn) { providers.set(id, fn); return () => providers.delete(id); } }, f.ledger);
    try {
      const result = settleLegacyReport(f.ledger, 'done', { kind: 'agent_daily', lease: f.lease, payload: buildAgentDaily(dailyInput()), artifactDirectory: join(f.dir, 'artifacts') });
      const artifact = f.ledger.history('task-daily').artifacts.find(a => a.artifactId === result.artifactId);
      if (mode === 'oversized') truncateSync(artifact.uri, 16 * 1024 * 1024 + 1);
      else { const outside = join(f.dir, 'unrelated.txt'); writeFileSync(outside, 'Synthetic unrelated data'); unlinkSync(artifact.uri); symlinkSync(outside, artifact.uri); }
      assert.throws(() => providers.get('agent_daily_report.v1')({ task: f.ledger.getTask('task-daily'), run: f.ledger.getRun('run-daily'), report: f.ledger.history('task-daily').reports[0] }), /file type\/size/);
    } finally { detach(); f.close(); }
  }
});

test('Native preparation does not settle and root derived-field tampering fails despite valid shape', () => {
  const f = ledgerFixture(); try {
    const prepared = prepareLegacyReport(f.ledger, 'prepare', { kind: 'agent_daily', lease: f.lease, payload: buildAgentDaily(dailyInput()), artifactDirectory: join(f.dir, 'artifacts') });
    assert.equal(f.ledger.getRun(f.run.runId).state, 'running'); assert.equal(f.ledger.history('task-daily').reports.length, 0);
    prepared.report.data.builder_input.semantic.headline = 'Changed source meaning';
    assert.throws(() => f.ledger.submit('changed-builder', { ...f.lease, outcome: 'success', summary: prepared.summary, report: prepared.report }), e => e.code === 'RESULT_VALIDATION');
  } finally { f.close(); }
});
test('Node/game payloads work across executor-to-authority boundary without root-only artifact requirement', () => {
  const f = ledgerFixture('game_daily'); const detach = registerLegacyTaskPack(f.ledger, { nodeAliases: { worker: 'node-games' } });
  try {
    const payload = gameReport(); payload.automations[0].tasks[0].outcome = 'failed';
    const prepared = prepareLegacyReport(undefined, 'remote-prepare', { kind: 'game_daily', lease: f.lease, identity: { taskId: 'task-daily', runId: 'run-daily' }, payload });
    assert.deepEqual(prepared.report.artifactIds, []); assert.equal(prepared.presentation.overallStatus, 'action_required');
    f.ledger.submit('remote-result', { ...f.lease, outcome: 'success', summary: prepared.summary, report: prepared.report });
    assert.equal(f.ledger.getRun('run-daily').state, 'succeeded'); assert.equal(f.ledger.history('task-daily').artifacts.length, 0);
  } finally { detach(); f.close(); }
});
test('Actual ledger node results cannot be silently omitted from a finalized root', () => {
  const f = ledgerFixture(); const detach = registerLegacyTaskPack(f.ledger, { expectedNodeIds: ['collector'] });
  try {
    const template = createLegacyTemplates().find(t => t.defaults.kind === 'agent_daily_node'); f.ledger.updateTemplate('child-template', template);
    f.ledger.registerNode('collector-node', { nodeId: 'collector', roles: ['executor'], capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'fixture', model: 'fixture', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const child = f.ledger.createTask('child', { title: 'Collect synthetic node', parentTaskId: 'task-daily' }).value;
    const run = f.ledger.createRun('child-run', { taskId: child.taskId, route: { nodeId: 'collector', provider: 'fixture', model: 'fixture', requiredCapabilities: ['legacy.task-pack.v1'] }, configuration: { template, input: { sourceIds: ['synthetic'], windowStart: WINDOW.start, windowEnd: WINDOW.end } } }).value;
    const a = f.ledger.claim('child-claim', { runId: run.runId, nodeId: 'collector', ttlMs: 60000 }).value.attempt;
    const node = buildNodeReport({ nodeId: 'collector', ...collectorEvidence() });
    settleLegacyReport(f.ledger, 'child-done', { kind: 'agent_daily_node', lease: { runId: run.runId, attemptId: a.attemptId, nodeId: a.nodeId, fence: a.fence }, payload: node });
    f.advance(1001);
    assert.throws(() => settleLegacyReport(f.ledger, 'root-omits', { kind: 'agent_daily', lease: f.lease, payload: buildAgentDaily(dailyInput()), artifactDirectory: join(f.dir, 'artifacts') }), e => e.code === 'RESULT_VALIDATION');
    const input = dailyInput(); const id = node.work_candidates[0].candidate_id;
    input.candidates.push({ candidate_id: id, task_id: 'node-work', title: 'Node work', status: 'completed', device_id: 'collector', runtime: 'codex', summary: 'Synthetic node evidence included' }); input.semantic.groups[0].candidate_ids.push(id);
    settleLegacyReport(f.ledger, 'root-includes', { kind: 'agent_daily', lease: f.lease, payload: buildAgentDaily(input), artifactDirectory: join(f.dir, 'artifacts') });
    assert.equal(f.ledger.getRun('run-daily').state, 'succeeded');
  } finally { detach(); f.close(); }
});

test('Recurring roots consume only this root run node evidence and reject the wrong node report window', () => {
  const f = ledgerFixture(); const detach = registerLegacyTaskPack(f.ledger, { expectedNodeIds: ['collector'] });
  try {
    const childTemplate = createLegacyTemplates().find(t => t.defaults.kind === 'agent_daily_node'); f.ledger.updateTemplate('node-template', childTemplate);
    f.ledger.registerNode('recurring-collector', { nodeId: 'collector', roles: ['executor'], capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'fixture', model: 'fixture', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    function finishNode(key, parentRunId, evidence) {
      const child = f.ledger.createTask(`${key}:task`, { title: 'Scoped node evidence', parentTaskId: 'task-daily', parentRunId }).value;
      const run = f.ledger.createRun(`${key}:run`, { taskId: child.taskId, parentRunId, route: { nodeId: 'collector', provider: 'fixture', model: 'fixture', requiredCapabilities: ['legacy.task-pack.v1'] }, configuration: { template: childTemplate, input: { sourceIds: ['synthetic'], windowStart: evidence.codex.window.start, windowEnd: evidence.codex.window.end } } }).value;
      const a = f.ledger.claim(`${key}:claim`, { runId: run.runId, nodeId: 'collector', ttlMs: 60000 }).value.attempt;
      const payload = buildNodeReport({ nodeId: 'collector', ...evidence });
      settleLegacyReport(f.ledger, `${key}:settle`, { kind: 'agent_daily_node', lease: { runId: run.runId, attemptId: a.attemptId, nodeId: a.nodeId, fence: a.fence }, payload }); f.advance(1001); return { child, run, payload };
    }
    function withNode(node, rootRunId, dayWindow = WINDOW) {
      const input = dailyInput(); Object.assign(input.report_context, { report_date: dayWindow.date, window_start: dayWindow.start, window_end: dayWindow.end });
      input.candidates.push({ candidate_id: node.work_candidates[0].candidate_id, task_id: 'node-work', title: 'Current node work', status: 'completed', device_id: 'collector', runtime: 'codex', summary: 'Current source evidence' }); input.semantic.groups[0].candidate_ids.push(node.work_candidates[0].candidate_id);
      return buildAgentDaily(input, { taskId: 'task-daily', runId: rootRunId });
    }
    const old = finishNode('old', 'run-daily', collectorEvidence());
    settleLegacyReport(f.ledger, 'first-root', { kind: 'agent_daily', lease: f.lease, payload: withNode(old.payload, 'run-daily'), artifactDirectory: join(f.dir, 'artifacts') });
    const template = createLegacyTemplates().find(t => t.defaults.kind === 'agent_daily');
    const nextWindow = { ...WINDOW, date: '2026-10-01', start: '2026-10-01T00:00:00+08:00', end: '2026-10-02T00:00:00+08:00' };
    const second = f.ledger.createRun('next-root', { taskId: 'task-daily', route: { nodeId: 'worker', provider: 'fixture', model: 'fixture', requiredCapabilities: ['legacy.task-pack.v1'] }, configuration: { template, input: { sourceIds: ['synthetic'], windowStart: nextWindow.start, windowEnd: nextWindow.end } } }).value;
    const secondAttempt = f.ledger.claim('next-claim', { runId: second.runId, nodeId: 'worker', ttlMs: 60000 }).value.attempt;
    const secondLease = { runId: second.runId, attemptId: secondAttempt.attemptId, nodeId: secondAttempt.nodeId, fence: secondAttempt.fence };
    const evidence = collectorEvidence(); evidence.codex.window = { ...nextWindow }; evidence.hermes.window = { ...nextWindow };
    evidence.codex.top_level_sessions[0].session_id = 'second-session'; evidence.semantic.candidates[0].source_ref = 'codex:second-session:turn-one';
    const current = finishNode('current', second.runId, evidence);
    assert.throws(() => settleLegacyReport(f.ledger, 'wrong-period-root', { kind: 'agent_daily', lease: secondLease, payload: withNode(current.payload, second.runId), artifactDirectory: join(f.dir, 'artifacts') }), e => e.code === 'RESULT_VALIDATION');
    settleLegacyReport(f.ledger, 'second-root', { kind: 'agent_daily', lease: secondLease, payload: withNode(current.payload, second.runId, nextWindow), artifactDirectory: join(f.dir, 'artifacts') });
    assert.equal(f.ledger.getRun(second.runId).state, 'succeeded');
    assert.equal(f.ledger.history('task-daily').reports.length, 2); assert.equal(f.ledger.history(old.child.taskId).reports.length, 1);
  } finally { detach(); f.close(); }
});

test('Executor source preflight requires exact prepared envelope, while authority journal replay needs no ephemeral map', () => {
  const f = ledgerFixture('game_daily'); let expected, preparedLive = false;
  const detach = registerLegacyTaskPack(f.ledger, { verifyPreparedEnvelope({ envelope, run, attempt }) { return preparedLive && run.runId === f.run.runId && attempt.attemptId === f.lease.attemptId && attempt.executionId === 'host-owned-proof' && canonicalJson(envelope) === expected; } });
  try {
    f.lease.executionId = 'host-owned-proof'; f.ledger.markRunning('start-owned', f.lease);
    const payload = gameReport(); payload.report_meta.device_id = 'worker';
    const prepared = prepareLegacyReport(f.ledger, 'prepare-source', { kind: 'game_daily', lease: f.lease, payload });
    const submission = { ...f.lease, outcome: 'success', summary: prepared.summary, report: prepared.report };
    const context = { executionContext: f.ledger.executionContext('run-daily'), task: f.ledger.getTask('task-daily'), run: f.ledger.getRun('run-daily'), attempt: f.ledger.getAttempt(f.lease.attemptId), submission, phase: 'executor-preflight' };
    assert.throws(() => f.ledger.validateResultContract(context), e => e.code === 'RESULT_VALIDATION');
    expected = canonicalJson(prepared.report.data); preparedLive = true;
    assert.doesNotThrow(() => f.ledger.validateResultContract(context));
    const changed = clone(context); changed.submission.report.data.payload.report_meta.collected_at = '2026-10-01T02:00:00+08:00';
    assert.throws(() => f.ledger.validateResultContract(changed), e => e.code === 'RESULT_VALIDATION');
    const foreign = clone(context); foreign.attempt.executionId = 'another-owner'; assert.throws(() => f.ledger.validateResultContract(foreign), e => e.code === 'RESULT_VALIDATION');
    preparedLive = false; // Simulate process restart after ready journal was validated/fsynced.
    assert.doesNotThrow(() => f.ledger.validateResultContract({ ...context, phase: 'authority' }));
    assert.equal(f.ledger.snapshot().reports.length, 0, 'Pure validation has no report/state writes');
    f.ledger.submit('ready-journal-replay', submission); assert.equal(f.ledger.getRun('run-daily').state, 'succeeded');
  } finally { detach(); f.close(); }
});
