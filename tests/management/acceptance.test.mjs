import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialize, validateSource, seed, readManifest, inspectPersisted, verify, inspectJournal, ORIGINAL} from '../../scripts/task-management-acceptance.mjs';
import {TaskLedger, Workbench, NATIVE_PROVIDER_UNAVAILABLE_SUMMARY} from '../../packages/task-system/dist/index.js';
import {RecoveryStore} from '../../packages/task-system/dist/remote/store.js';
import {createDashboardServer} from '../../dashboard/server.mjs';
import {managementAdapter} from '../../dashboard/management.mjs';

// All records below are explicitly SYNTHETIC unit inputs. They test the inspector;
// they are never used by the real-device CLI and establish no live DSH acceptance.
function sourceFixture() {
  return {format: 'dsh-task-management-source.v1', source: {label: 'SYNTHETIC unit fixture', exportedAt: '2026-10-04T00:00:00.000Z'},
    task: {taskId: 'synthetic-original-task', title: 'Synthetic source task', description: 'Not a real device task'},
    template: {templateId: ORIGINAL.templateId, version: 1, name: 'Synthetic template', description: 'Unit boundary only',
      defaults: {producer: ORIGINAL.producer, manual_json_fallback: false, schema_id: ORIGINAL.schemaId},
      inputSchema: {type: 'object'}, resultContract: {type: 'object'}},
    schedule: {scheduleId: ORIGINAL.scheduleId, taskId: 'synthetic-original-task', templateId: ORIGINAL.templateId,
      templateVersion: 1, enabled: false, cron: ORIGINAL.cron, timeZone: ORIGINAL.timeZone, input: {}}};
}
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-acceptance-unit-')));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const db = join(dir, 'authority.sqlite'), journal = join(dir, 'executor-journal.sqlite'), sourceFile = join(dir, 'source.json');
  writeFileSync(sourceFile, JSON.stringify(sourceFixture()));
  const init = {db, authorityNode: 'synthetic-planner', executorJournal: journal, label: 'SYNTHETIC test database'};
  const args = {db, templateJson: sourceFile, node: 'synthetic-mbp', provider: 'synthetic-provider', model: 'synthetic-model',
    workspace: 'synthetic-workspace', requiredCapabilities: ['read'], allowedTools: [], maxRuntimeMs: 10000};
  return {dir, db, journal, sourceFile, init, args};
}
function registerSyntheticRuntime(f, heartbeat = true) {
  const ledger = TaskLedger.open(f.db, {nodeId: 'synthetic-planner'});
  try {
    ledger.registerWorkspace('unit-workspace', {workspaceId: f.args.workspace, nodeId: f.args.node, path: f.dir, label: 'SYNTHETIC', state: 'ready', createdAt: new Date().toISOString()});
    ledger.registerNode('unit-node', {nodeId: f.args.node, enabled: true, roles: ['executor'], capabilities: ['read'],
      models: [{provider: f.args.provider, model: f.args.model, reasoningEfforts: []}], workspaceIds: [f.args.workspace], lastSeenAt: new Date().toISOString()});
    if (heartbeat) ledger.recordNodeHeartbeat('unit-heartbeat', {nodeId: f.args.node, activeExecutions: 0, runtimeReady: true});
  } finally { ledger.close(); }
}
function syntheticSettlement(f, outcome = 'failure', reasonCode = 'NO_ADAPTER') {
  const ledger = TaskLedger.open(f.db, {nodeId: 'synthetic-planner'});
  const manifest = readManifest(f.db), runId = manifest.seed.runId;
  const claim = ledger.claim('unit-claim', {runId, nodeId: f.args.node, ttlMs: 10000}).value;
  const lease = {runId, attemptId: claim.attempt.attemptId, nodeId: f.args.node, fence: claim.attempt.fence, executionId: 'synthetic-execution'};
  ledger.markRunning('unit-running', lease);
  ledger.bindSession('unit-session', {...lease, sessionId: 'synthetic-session'});
  ledger.submit('unit-result', {...lease, outcome, summary: outcome === 'unknown' ? `${reasonCode}: synthetic diagnostic` : 'Synthetic missing script',
    ...(outcome === 'unknown' ? {} : {report: {title: 'Synthetic failure', body: 'SYNTHETIC ENOENT: original producer unavailable', schemaId: ['success', 'partial'].includes(outcome) ? ORIGINAL.schemaId : 'legacy_task_pack_error.v1', data: {errors: ['Synthetic missing script']}}})});
  return {ledger, manifest, claim, lease};
}

test('init requires a NEW absolute file DB and a distinct MBP journal', t => {
  const f = fixture(t);
  assert.throws(() => initialize({...f.init, db: ':memory:'}), /absolute/);
  assert.throws(() => initialize({...f.init, db: 'relative.sqlite'}), /absolute/);
  assert.throws(() => initialize({...f.init, executorJournal: f.db}), /separate/);
  const result = initialize(f.init);
  assert.equal(result.status, 'initialized');
  assert.equal(readFileSync(f.db).subarray(0, 15).toString(), 'SQLite format 3');
  assert.throws(() => initialize(f.init), /existing path/);
  assert.equal(readManifest(f.db).database.path, f.db);
});

test('source export rejects unrelated templates, enabled schedules and manual fallback', () => {
  assert.equal(validateSource(sourceFixture()).template.defaults.manual_json_fallback, false);
  assert.deepEqual(validateSource(sourceFixture()).input, sourceFixture().schedule.input);
  for (const change of [
    source => { source.template.templateId = 'unrelated'; },
    source => { source.schedule.enabled = true; },
    source => { source.schedule.taskId = 'another-task'; },
    source => { source.schedule.cron = '* * * * *'; },
    source => { source.schedule.input.manual_json_fallback = true; },
    source => { source.template.defaults.producer = '/tmp/fake.py'; },
    source => { delete source.template.defaults.schema_id; },
    source => { source.template.defaults.api_key = 'do-not-export'; },
  ]) { const source = sourceFixture(); change(source); assert.throws(() => validateSource(source)); }
});

test('seed never creates node/workspace or fabricates online status', t => {
  const f = fixture(t); initialize(f.init);
  assert.throws(() => seed(f.args), /node not found/);
  registerSyntheticRuntime(f, false);
  assert.throws(() => seed(f.args), /authenticated MBP/);
  const ledger = TaskLedger.open(f.db, {readOnly: true});
  try { assert.equal(ledger.snapshot().tasks.length, 0); assert.equal(ledger.snapshot().templates.length, 0); }
  finally { ledger.close(); }
});

test('seed pins the exported template, preserves source identity, is idempotent and creates no schedule', t => {
  const f = fixture(t); initialize(f.init); registerSyntheticRuntime(f);
  const first = seed(f.args), second = seed(f.args);
  assert.equal(first.runId, second.runId);
  assert.equal(first.taskId, sourceFixture().task.taskId);
  const manifest = readManifest(f.db), ledger = TaskLedger.open(f.db, {readOnly: true});
  try {
    assert.equal(ledger.snapshot().tasks.length, 1);
    assert.equal(ledger.snapshot().runs.length, 1);
    assert.deepEqual(ledger.getTemplate(ORIGINAL.templateId, 1), sourceFixture().template);
    assert.equal(ledger.snapshot().schedules.length, 0);
    assert.equal(ledger.deliveries().length, 0);
    const result = inspectPersisted(manifest, ledger);
    assert.equal(result.status, 'pending'); assert.deepEqual(result.attempts, []);
    assert.equal(new Workbench(ledger).snapshot().backlogs[0].conditionStatus, 'pending');
  } finally { ledger.close(); }
  assert.throws(() => seed({...f.args, allowedTools: ['different-tool']}), /Seed identity/);
});

test('truthful terminal failure requires UI and separate acknowledged journal evidence', async t => {
  const f = fixture(t); initialize(f.init); registerSyntheticRuntime(f); seed(f.args);
  const {ledger, manifest, claim, lease} = syntheticSettlement(f);
  const server = createDashboardServer({snapshot: () => ledger.snapshot(), management: managementAdapter(ledger, new Workbench(ledger)), databaseIdentity: manifest.database});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); ledger.close(); });
  const uiUrl = `http://127.0.0.1:${server.address().port}/api/workbench`;
  const withoutJournal = await verify({db: f.db, uiUrl});
  assert.equal(withoutJournal.runState, 'failed'); assert.equal(withoutJournal.status, 'inconclusive');
  assert.match(withoutJournal.diagnostics.join(' '), /SYNTHETIC ENOENT/);
  assert.equal(withoutJournal.reports.length, 1);
  const store = new RecoveryStore(f.journal);
  store.createDispatch({attemptId: lease.attemptId, state: 'acknowledged', claim, lease, sessionId: 'synthetic-session'}); store.close();
  const evidence = inspectJournal({manifestFile: `${f.db}.acceptance.json`, journal: f.journal});
  const evidencePath = join(f.dir, 'journal-evidence.json'); writeFileSync(evidencePath, JSON.stringify(evidence));
  const result = await verify({db: f.db, uiUrl, journalEvidence: evidencePath});
  assert.equal(result.status, 'verified'); assert.equal(result.runState, 'failed');
  assert.equal(result.humanAcceptance, 'not asserted'); assert.deepEqual(result.missing, []);
  evidence.dispatches[0].state = 'result'; writeFileSync(evidencePath, JSON.stringify(evidence));
  await assert.rejects(verify({db: f.db, uiUrl, journalEvidence: evidencePath}), /acknowledged/);
  await assert.rejects(verify({db: f.db, uiUrl: 'http://192.0.2.1:8443/api/workbench'}), /loopback/);
});

for (const reasonCode of ['NO_ADAPTER', 'MISSING_CREDENTIAL']) test(`${reasonCode} unknown runtime errors without a Report remain inconclusive`, async t => {
  const f = fixture(t); initialize(f.init); registerSyntheticRuntime(f); seed(f.args);
  const {ledger} = syntheticSettlement(f, 'unknown', reasonCode); ledger.close();
  const result = await verify({db: f.db});
  assert.equal(result.status, 'inconclusive'); assert.equal(result.runState, 'uncertain');
  assert.equal(result.reports.length, 0); assert.match(result.missing.join(' '), /reconciliation/);
  assert.match(result.diagnostics.join(' '), new RegExp(reasonCode));
  assert.equal(result.evidenceKind, 'not-established'); assert.equal(result.workloadExecution, 'unknown');
});


test('system-origin pre-dispatch block verifies without an agent Report or a created native session', async t => {
  const f = fixture(t); initialize(f.init); registerSyntheticRuntime(f); seed(f.args);
  const manifest = readManifest(f.db), ledger = TaskLedger.open(f.db, {nodeId: 'synthetic-planner'});
  const runId = manifest.seed.runId;
  const claim = ledger.claim('unit-pre-claim', {runId, nodeId: f.args.node, ttlMs: 10000}).value;
  const lease = {runId, attemptId: claim.attempt.attemptId, nodeId: f.args.node, fence: claim.attempt.fence, executionId: 'synthetic-pre-execution'};
  ledger.markRunning('unit-pre-running', lease);
  // Deliberately no bindSession, agent creation, fabricated Report or workload tool.
  ledger.submit('unit-pre-blocked', {...lease, outcome: 'blocked', summary: NATIVE_PROVIDER_UNAVAILABLE_SUMMARY,
    preDispatchFailure: {kind: 'native-provider-unavailable-v1', code: 'NO_ADAPTER', provider: f.args.provider, model: f.args.model}});
  let hideUiReason = false;
  const server = createDashboardServer({snapshot: () => {
    const snapshot = ledger.snapshot();
    if (hideUiReason) snapshot.events = snapshot.events.map(event => event.type === 'run.pre_dispatch_failed'
      ? {...event, detail: {...event.detail, code: undefined}} : event);
    return snapshot;
  }, management: managementAdapter(ledger, new Workbench(ledger)), databaseIdentity: manifest.database});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); ledger.close(); });
  const uiUrl = `http://127.0.0.1:${server.address().port}/api/workbench`;
  const store = new RecoveryStore(f.journal);
  store.createDispatch({attemptId: lease.attemptId, state: 'acknowledged', claim, lease, sessionId: 'synthetic-reserved-not-created'}); store.close();
  const evidencePath = join(f.dir, 'pre-journal-evidence.json');
  const evidence = inspectJournal({manifestFile: `${f.db}.acceptance.json`, journal: f.journal});
  writeFileSync(evidencePath, JSON.stringify(evidence));
  const result = await verify({db: f.db, uiUrl, journalEvidence: evidencePath});
  assert.equal(result.status, 'verified'); assert.equal(result.runState, 'blocked');
  assert.equal(result.evidenceKind, 'system-pre-dispatch-block'); assert.equal(result.workloadExecution, 'not-started');
  assert.equal(result.systemFailure.detail.code, 'NO_ADAPTER');
  assert.equal(result.systemFailure.detail.phase, 'before-agent-start');
  assert.equal(result.systemFailure.detail.attemptId, lease.attemptId);
  assert.equal(result.reports.length, 0); assert.equal(result.attempts[0].sessionId, undefined);
  hideUiReason = true;
  await assert.rejects(verify({db: f.db, uiUrl, journalEvidence: evidencePath}), /UI system-origin/);
  hideUiReason = false;
  evidence.dispatches[0].fence++; writeFileSync(evidencePath, JSON.stringify(evidence));
  await assert.rejects(verify({db: f.db, uiUrl, journalEvidence: evidencePath}), /acknowledged fenced/);
});


function adaptedSourceFixture() {
  const source = sourceFixture();
  source.source.originalSchedule = {enabled: true, status: 'active', notModified: true};
  source.source.normalization = {templateVersion: 'SYNTHETIC export revision, not original version',
    inputSchema: 'SYNTHETIC adapter input', resultContract: 'SYNTHETIC structural schema only', resultValidator: 'Not mounted'};
  source.source.contractReference = {sourceModule: 'synthetic-validator.py', language: 'python', entrypoint: 'synthetic_validate',
    sha256: 'synthetic-declared-reference', bytes: 12, semanticRules: ['SYNTHETIC rule'], sourceCode: 'NOT EXECUTED'};
  source.template.defaults = {schema_id: ORIGINAL.schemaId, report_producer: {entrypoint: ORIGINAL.producerPlaceholder, manual_json_fallback: false}};
  source.template.inputSchema = {type: 'object', additionalProperties: false,
    properties: {format: {const: 'json'}, timeZone: {const: 'Asia/Shanghai'}}};
  source.schedule.input = {format: 'json', timeZone: 'Asia/Shanghai'};
  return source;
}
for (const outcome of ['success', 'partial']) test(`adapted source keeps exact input and rejects ${outcome} semantic acceptance without original validator`, async t => {
  const f = fixture(t), source = adaptedSourceFixture();
  writeFileSync(f.sourceFile, JSON.stringify(source)); initialize(f.init); registerSyntheticRuntime(f); seed(f.args);
  const {ledger} = syntheticSettlement(f, outcome);
  try {
    const manifest = readManifest(f.db), run = ledger.getRun(manifest.seed.runId);
    assert.deepEqual(run.configuration.input, source.schedule.input);
    assert.deepEqual(ledger.getTemplate(ORIGINAL.templateId, 1).defaults, source.template.defaults);
    assert.deepEqual(manifest.seed.source.normalization, source.source.normalization);
    assert.equal(manifest.seed.source.originalSchedule.enabled, true);
    assert.equal(manifest.seed.exportedSchedule.enabled, false);
    assert.equal(manifest.seed.source.contractReference.sourceCode, undefined);
    assert.equal(manifest.seed.source.contractReference.sha256, source.source.contractReference.sha256);
    const result = inspectPersisted(manifest, ledger);
    assert.equal(result.status, 'inconclusive');
    assert.match(result.missing.join(' '), /Original Python semantic validation is not established/);
  } finally { ledger.close(); }
});

test('externally supplied private original export validates and seeds exact adapted input (synthetic route only)',
  {skip: !process.env.DSH_ACCEPTANCE_SOURCE_EXPORT}, t => {
    const f = fixture(t);
    const sourcePath = realpathSync(process.env.DSH_ACCEPTANCE_SOURCE_EXPORT);
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
    const checked = validateSource(source);
    assert.deepEqual(checked.input, source.schedule.input);
    initialize(f.init); registerSyntheticRuntime(f);
    const result = seed({...f.args, templateJson: sourcePath});
    const manifest = readManifest(f.db), ledger = TaskLedger.open(f.db, {readOnly: true});
    try {
      assert.equal(result.taskId, source.task.taskId);
      assert.deepEqual(ledger.getRun(result.runId).configuration.input, source.schedule.input);
      assert.deepEqual(ledger.getTemplate(source.template.templateId, source.template.version), source.template);
      assert.deepEqual(manifest.seed.source.normalization, source.source.normalization);
      assert.deepEqual(manifest.seed.source.originalSchedule, source.source.originalSchedule);
      assert.equal(manifest.seed.source.contractReference.sourceCode, undefined);
      assert.equal(manifest.seed.semanticValidation.status, 'not-established');
      assert.equal(ledger.snapshot().attempts.length, 0, 'No real or simulated workload dispatch is performed');
    } finally { ledger.close(); }
  });
