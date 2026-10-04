import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { TaskLedger } from '../../packages/task-system/dist/ledger.js';
import { RemoteGateway, RemoteClient, RemoteLedgerClient, RecoveryStore, ExecutorWorker, IdentityVerifier, nativeExecutionAdapter } from '../../packages/task-system/dist/remote/api.js';
import { createNativeHarness } from './native-harness.mjs';

const template = {
  templateId: 'immutable-context-contract', version: 1, name: 'Pinned result rules', description: 'The original template rules',
  inputSchema: { type: 'object' }, defaults: {},
  resultContract: { type: 'object', required: ['report'], properties: { report: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['pinned'], properties: { pinned: { const: 1 } } } } } } },
};
const initialTitle = 'Original run intent';
const initialDescription = 'Run the original scope only';

function configure(ledger, nodeId, workspacePath) {
  ledger.registerWorkspace('workspace', { workspaceId: 'workspace', nodeId, path: workspacePath, label: 'Isolated context test', state: 'ready', createdAt: new Date().toISOString() });
  ledger.registerNode('node', { nodeId, roles: ['executor'], capabilities: [], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: ['workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
  ledger.updateTemplate('template-v1', template);
  const task = ledger.createTask('task', { title: initialTitle, description: initialDescription, goal: 'Original goal', workspaceId: 'workspace', policy: { allowedTools: [], maxRuntimeMs: 10000 } }).value;
  const note = ledger.queueTaskNote('selected-note', { taskId: task.taskId, body: 'Selected immutable note body', actor: 'operator-fixture' }).value;
  const run = ledger.createRun('run', { taskId: task.taskId, route: { nodeId, provider: 'test-offline', model: 'script', workspaceId: 'workspace', requiredCapabilities: [] }, configuration: { templateRef: { templateId: template.templateId, version: 1 }, input: {} } }).value;
  ledger.updateTemplate('template-v2', { ...template, version: 2, description: 'Later template rules must not replace pinned rules', resultContract: { type: 'object', required: ['neverSubmitThisField'], properties: { neverSubmitThisField: { type: 'boolean' } } } });
  ledger.queueTaskNote('later-note', { taskId: task.taskId, body: 'Later unselected note must not enter this run', actor: 'operator-fixture' });
  ledger.updateTask('new-intent', { taskId: task.taskId, expectedRevision: task.revision, title: 'Changed task title for future runs', description: 'Changed requirements for future runs', goal: 'Changed future goal' });
  return { task, run, note };
}
function assertPrompt(request) {
  const prompt = JSON.stringify(request.messages);
  assert.match(prompt, /Original run intent/);
  assert.match(prompt, /Run the original scope only/);
  assert.match(prompt, /Original goal/);
  assert.match(prompt, /Selected immutable note body/);
  assert.match(prompt, /operator-fixture/);
  assert.match(prompt, /The original template rules/);
  assert.doesNotMatch(prompt, /Changed task title|Changed requirements|Changed future goal|Later unselected note|Later template rules|forged-note/);
}

for (const valid of [true, false]) {
  test(`signed remote claim carries fixed context to real native ${valid ? 'validated success' : 'fail-closed contract validation'}`, { timeout: 20000 }, async () => {
    const h = await createNativeHarness({ config: { role: 'executor', nodeId: 'worker' }, script: [options => {
      assertPrompt(options);
      return { name: 'task_settle', args: { outcome: 'success', summary: 'Fixed contract execution', reportBody: 'Actual native execution result', reportData: valid ? { pinned: 1 } : { wrongField: true } } };
    }] });
    const ledger = TaskLedger.open(join(h.dir, 'coordinator.sqlite'), { role: 'planner', nodeId: 'planner' });
    const stores = ['server', 'client', 'worker'].map(name => new RecoveryStore(join(h.dir, `${name}.sqlite`)));
    let gateway, worker;
    try {
      const { task, run, note } = configure(ledger, 'worker', h.dir);
      // Ephemeral test identity only; no runtime credentials or configuration are changed.
      const keys = generateKeyPairSync('ed25519');
      const peer = { keyId: 'context-fixture', nodeId: 'worker', publicKey: keys.publicKey, audience: 'planner', operations: ['claim', 'renew', 'submit', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt', 'listWork', 'taskWait'], workspaces: ['workspace'], capabilities: [] };
      gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: stores[0], verifier: new IdentityVerifier({ audience: 'planner', peers: [peer] }) });
      const client = new RemoteClient({ endpoint: 'https://isolated-context-fixture.invalid/commands', nodeId: 'worker', keyId: peer.keyId, audience: 'planner', privateKey: keys.privateKey, store: stores[1], fetch: async (_url, options) => new Response(JSON.stringify(await gateway.handle(options.body))) });
      const remote = new RemoteLedgerClient(client, 'worker');
      worker = new ExecutorWorker({ ledger: remote, provider: nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: 'test-offline', models: [{ model: 'script', reasoningEfforts: [] }], capabilities: [] }), store: stores[2], policy: { role: 'executor', nodeId: 'worker', capabilities: [], workspaces: [{ workspaceId: 'workspace', nodeId: 'worker', path: h.dir, allowedRoot: h.dir }] } });
      const dispatch = await worker.execute(run.runId, 'claim-pinned-context');
      assert.equal(dispatch.state, 'acknowledged');
      assert.equal(dispatch.claim.task.title, 'Changed task title for future runs');
      assert.equal(dispatch.claim.run.intentSnapshot.title, initialTitle);
      assert.deepEqual(dispatch.claim.run.contextNotes, [note.reportId]);
      assert.equal(dispatch.claim.run.configuration.template, undefined);
      assert.equal(dispatch.claim.executionContext.template.version, 1);
      assert.deepEqual(dispatch.claim.executionContext.reports, [{ reportId: note.reportId, body: note.body, actor: 'operator-fixture' }]);
      assert.equal(ledger.getRun(run.runId).state, valid ? 'succeeded' : 'uncertain');
      assert.equal(ledger.history(task.taskId).reports.filter(report => report.kind === 'result').length, valid ? 1 : 0);
      assert.equal(h.adapter.requests.length, 1);
      assert.equal(h.ledger.snapshot().tasks.length, 0, 'executor must not import authority task identities');
      assert.equal(h.ledger.snapshot().templates.length, 0, 'executor validation must use the claim rather than its local template registry');
      assert.equal(ledger.getRun(run.runId).executionContext, undefined, 'resolved transport bodies must not be saved in Run');
    } finally {
      await worker?.dispose(); await gateway?.dispose();
      for (const store of stores) store.close();
      ledger.close(); await h.dispose();
    }
  });
}

test('local native refresh ignores forged context and uses the fixed intent snapshot', { timeout: 20000 }, async () => {
  const h = await createNativeHarness({ script: [options => {
    assertPrompt(options);
    return { name: 'task_settle', args: { outcome: 'success', summary: 'Authoritative local context used', reportData: { pinned: 1 } } };
  }] });
  try {
    const { run } = configure(h.ledger, 'local', h.dir);
    const claim = h.ledger.claim('local-claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    claim.run.intentSnapshot.title = 'forged-note';
    claim.executionContext = { template: { ...template, resultContract: {} }, reports: [{ reportId: claim.run.contextNotes[0], body: 'forged-note', actor: 'forged' }] };
    await h.ctx.taskSystem.native.execute(claim);
    assert.equal(h.ledger.getRun(run.runId).state, 'succeeded');
    assert.equal(h.adapter.requests.length, 1);
  } finally { await h.dispose(); }
});


test('native creation tools accept approved task intent and priority fields with pinned Run configuration', async () => {
  const h = await createNativeHarness();
  const call = (name, args) => h.ctx.tools.execute({ callId: ToolCallId(`context-${name}`), name, arguments: args, signal: new AbortController().signal });
  const value = result => {
    assert.equal(result.isError, false, result.error?.message);
    return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).value;
  };
  try {
    h.ledger.updateTemplate('tool-template', template);
    const task = value(await call('task_create', { commandId: 'tool-create', title: 'Native approved fields', goal: 'Explicit work goal', acceptanceCriteria: [{ description: 'Review the actual output', kind: 'manual_check', requiredEvidence: 'A result report' }], priorityOverride: 'high', targetAt: '2026-12-01T00:00:00Z' }));
    assert.equal(task.goal, 'Explicit work goal');
    assert.equal(task.priorityOverride, 'high');
    assert.equal(task.targetAt, '2026-12-01T00:00:00.000Z');
    assert.equal(task.acceptanceCriteria[0].description, 'Review the actual output');
    for (const obsolete of ['userImmediacy', 'importance', 'urgency', 'admissionRevision']) assert.equal(task[obsolete], undefined);
    const run = value(await call('task_run', { commandId: 'tool-run', taskId: task.taskId, configuration: { templateRef: { templateId: template.templateId, version: 1 }, input: {} } }));
    assert.equal(run.intentSnapshot.goal, task.goal);
    assert.deepEqual(run.intentSnapshot.acceptanceCriteria, task.acceptanceCriteria);
    assert.deepEqual(run.configuration.templateRef, { templateId: template.templateId, version: 1 });
    assert.equal(run.configuration.template, undefined);
    const curate = await call('task_curate', { commandId: 'tool-curate', taskId: task.taskId, state: 'dismissed', expectedRevision: 1, reason: 'Legacy entry point cannot create new admission facts' });
    assert.equal(curate.isError, true);
    assert.match(curate.error.message, /legacy|Admission curation/i);
    assert.equal(h.ledger.getTask(task.taskId).admissionRevision, undefined);
  } finally { await h.dispose(); }
});
