import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DecisionEngine, StructuredModelProvider, JevProvider, AnyJevCompatibleProvider } from '@dsh-task/typed-decisions/core';
import { defaultTaskSessionSelection, TaskSessionConfigurationError } from '../dist/session-default.js';
import { buildTaskSessionDecisionRequest, consumeTaskSessionDecisionReceipt, resolveTaskSessionDecision } from '../dist/session-policy.js';

const model = { model: 'judge', version: 'judge-1', reasoningEfforts: [] };
const base = {
  taskId: 'task-1', nodeId: 'local', defaultWorkspaceId: 'default', validUntil: 2000,
  context: { title: 'Build the requested artifact' },
  workspaces: [
    { workspaceId: 'default', nodeId: 'local', eligible: true, description: 'Default workspace' },
    { workspaceId: 'alternate', nodeId: 'local', eligible: true, description: 'Alternate workspace' },
    { workspaceId: 'disabled', nodeId: 'local', eligible: false, description: 'Disabled workspace' },
    { workspaceId: 'remote', nodeId: 'remote', eligible: true, description: 'Other node' },
  ],
  sessions: [
    { sessionId: 'session-1', taskId: 'task-1', nodeId: 'local', workspaceId: 'default', eligible: true, description: 'This Task in default workspace' },
    { sessionId: 'session-2', taskId: 'task-1', nodeId: 'local', workspaceId: 'alternate', eligible: true, description: 'This Task in alternate workspace' },
    { sessionId: 'foreign', taskId: 'other', nodeId: 'local', workspaceId: 'default', eligible: true, description: 'Another Task' },
    { sessionId: 'not-ready', taskId: 'task-1', nodeId: 'local', workspaceId: 'default', eligible: false, description: 'Unavailable' },
  ],
};
const answers = (session = 'reuse-0', workspace = 'default') => ({ session: { type: 'choice', choice: session }, workspace: { type: 'choice', choice: workspace } });
function ordinary(output = { answers: answers() }, complete) {
  return new StructuredModelProvider('ordinary', [model], { complete: complete ?? (async () => ({ output, modelVersion: model.version })) });
}
function engine(provider, options = {}) { return new DecisionEngine([provider], { defaultProvider: provider.id, maxAttempts: 1, ...options }); }
async function resolve(provider, snapshot = base, options = {}) {
  const decisions = engine(provider);
  try { return await resolveTaskSessionDecision(snapshot, { requestId: 'selection', decisions, now: () => 1000, ...options }); }
  finally { await decisions.close(); }
}

// This module is the runtime default path, including installations without the optional peer.
test('default selection runs without installed typed-decisions and gives one bound session per Task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-session-default-'));
  try {
    const path = join(directory, 'session-default.mjs');
    copyFileSync(new URL('../dist/session-default.js', import.meta.url), path);
    const independent = await import(pathToFileURL(path).href);
    assert.deepEqual(independent.defaultTaskSessionSelection(base), { source: 'default', session: { mode: 'new' }, workspaceId: 'default', reason: 'decision-unavailable' });
    assert.deepEqual(independent.defaultTaskSessionSelection({ ...base, taskSessionId: 'session-1' }).session, { mode: 'reuse', sessionId: 'session-1' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing default, duplicate catalog IDs, or incompatible existing binding are deterministic configuration errors', () => {
  for (const change of [
    { defaultWorkspaceId: '' }, { defaultWorkspaceId: 'disabled' }, { defaultWorkspaceId: 'remote' },
    { taskSessionId: 'session-2' }, { taskSessionId: 'not-ready' }, { taskSessionId: 'foreign' },
    { workspaces: [...base.workspaces, base.workspaces[0]] },
  ]) assert.throws(() => defaultTaskSessionSelection({ ...base, ...change }), TaskSessionConfigurationError);
});

test('finite request excludes unowned sessions and ineligible workspaces', () => {
  const request = buildTaskSessionDecisionRequest('selection', base, {}, 1000);
  assert.deepEqual(Object.keys(request.questions[0].candidates), ['new', 'reuse-0', 'reuse-1']);
  assert.deepEqual(Object.keys(request.questions[1].candidates), ['default', 'alternate']);
  assert.equal(request.context.sessions.length, 2);
  assert.equal(request.context.taskId, 'task-1');
});

test('ordinary model uses typed questions and validated Jev-shaped choices for reuse or new workspace', async () => {
  let observed;
  const reused = await resolve(ordinary(undefined, async input => {
    observed = input;
    return { output: JSON.stringify({ answers: answers('reuse-1', 'alternate') }), modelVersion: model.version };
  }));
  assert.equal(reused.source, 'decision');
  assert.deepEqual(reused.session, { mode: 'reuse', sessionId: 'session-2' });
  assert.equal(reused.workspaceId, 'alternate');
  assert.equal(observed.responseSchema.additionalProperties, false);
  assert.deepEqual(observed.responseSchema.required, ['answers']);
  assert.equal(reused.receipt.evidence.calibration, 'none');
  const created = await resolve(ordinary({ answers: answers('new', 'alternate') }));
  assert.equal(created.source, 'decision');
  assert.deepEqual(created.session, { mode: 'new' });
  assert.equal(created.workspaceId, 'alternate');
});

test('Jev and Jev-compatible wire normalize to the same selection without live calls', async () => {
  for (const kind of ['jev', 'compatible']) {
    let body;
    const version = kind === 'jev' ? 'jev-1.13.0' : 'local-1';
    const fetch = async (_, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ model: version, answers: {
        session: { type: 'choice', choice: 'reuse-0', probabilities: { new: 0, 'reuse-0': 1, 'reuse-1': 0 }, confidence: 1 },
        workspace: { type: 'choice', choice: 'default', probabilities: { default: 1, alternate: 0 }, confidence: 1 },
      }, usage: { input_tokens: 1, output_tokens: 1 } }));
    };
    const provider = kind === 'jev' ? new JevProvider({ id: kind, fetch }) : new AnyJevCompatibleProvider({
      id: kind, fetch, endpoint: 'http://localhost:9999/v1/systemone', model: version, modelVersion: version,
      capabilityDeclaration: { readout: 'logits', calibration: 'L0', maxChoices: 26, maxScoreLevels: 10, questionTypes: ['choice'], reasoningEfforts: [] },
    });
    const result = await resolve(provider);
    assert.deepEqual({ source: result.source, session: result.session, workspaceId: result.workspaceId }, { source: 'decision', session: { mode: 'reuse', sessionId: 'session-1' }, workspaceId: 'default' });
    assert.equal(body.questions.session.type, 'choice');
    assert.deepEqual(Object.keys(body.questions.workspace.criteria), ['default', 'alternate']);
  }
});

test('missing service and all unsuccessful replies fall back to the same Task session and workspace', async () => {
  const bound = { ...base, taskSessionId: 'session-1' };
  const absent = await resolveTaskSessionDecision(bound, { requestId: 'absent', now: () => 1000 });
  assert.equal(absent.source, 'default');
  for (const output of [
    'not JSON', '```json\n{}\n```', '{"answers":{},"answers":{}}', { answers: {} },
    { answers: answers('invented', 'default') }, { answers: answers('new', '/arbitrary/path') },
    { answers: answers(), authorize: true },
    { answers: { ...answers(), session: { type: 'abstain', reason: 'insufficient-evidence' } } },
    { answers: answers('reuse-0', 'alternate') },
  ]) {
    const result = await resolve(ordinary(output), bound);
    assert.equal(result.source, 'default');
    assert.deepEqual(result.session, absent.session);
    assert.equal(result.workspaceId, absent.workspaceId);
  }
  const failed = await resolve(ordinary(undefined, async () => { throw Error('private provider detail'); }), bound);
  assert.equal(failed.source, 'default');
  assert.equal(JSON.stringify(failed).includes('private provider detail'), false);
});

test('engine timeout falls back, with no extra retry or provider substitution', async () => {
  let calls = 0;
  const decisions = engine(ordinary(undefined, () => { calls++; return new Promise(() => {}); }), { timeoutMs: 5 });
  try {
    const result = await resolveTaskSessionDecision(base, { requestId: 'timeout', decisions, now: () => 1000 });
    assert.equal(result.source, 'default');
    assert.equal(result.receipt.error.code, 'timeout');
    assert.equal(calls, 1);
  } finally { await decisions.close(); }
});

test('receipt binding, version, candidates and catalog freshness are rechecked', async () => {
  const decisions = engine(ordinary());
  const request = buildTaskSessionDecisionRequest('receipt', base, {}, 1000);
  const receipt = await decisions.evaluate(request);
  for (const changed of [
    { ...receipt, requestId: 'another-request' }, { ...receipt, requestDigest: 'wrong' },
    { ...receipt, stateHash: 'wrong' }, { ...receipt, schemaVersion: 2 },
    { ...receipt, questionVersions: { session: '2', workspace: '1' } },
    { ...receipt, answers: { ...answers(), extra: { type: 'choice', choice: 'new' } } },
    { ...receipt, answers: answers('unknown', 'default') },
  ]) assert.equal(consumeTaskSessionDecisionReceipt(changed, request, base, 1000).source, 'default');
  assert.equal(consumeTaskSessionDecisionReceipt(receipt, request, base, 2000).reason, 'stale-decision');
  assert.equal(consumeTaskSessionDecisionReceipt(receipt, request, { ...base, context: { title: 'Changed task' } }, 1000).reason, 'stale-decision');
  await decisions.close();
  const changed = await resolve(ordinary(), base, { currentSnapshot: () => ({ ...base, context: { title: 'Changed after call' } }) });
  assert.equal(changed.reason, 'stale-decision');
});

test('caller cancellation never converts to a fallback execution', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveTaskSessionDecision(base, { requestId: 'cancelled', signal: controller.signal }), { name: 'AbortError' });
  const midCall = new AbortController();
  await assert.rejects(resolveTaskSessionDecision(base, {
    requestId: 'cancel-during-call', now: () => 1000, signal: midCall.signal,
    decisions: { evaluate: async () => { midCall.abort(); throw Error('provider aborted'); } },
  }), { name: 'AbortError' });
});

test('executor uses its selected preset and verifies the original preset request on receipt consumption', async () => {
  const decisions = new DecisionEngine([ordinary({answers:answers('new','alternate')})], {defaultProvider:'ordinary',presets:[{id:'executor-work',name:'Executor work',provider:'ordinary',model:'judge'}]});
  const consumers=[];
  try {
    const result=await resolveTaskSessionDecision(base,{requestId:'preset-selection',now:()=>1000,decisions:{presetFor(consumer){consumers.push(consumer);return 'executor-work';},evaluate(request,options){assert.equal(request.preset,'executor-work');assert.equal(request.provider,undefined);return decisions.evaluate(request,options);}}});
    assert.equal(result.source,'decision');assert.equal(result.workspaceId,'alternate');assert.deepEqual(result.session,{mode:'new'});assert.deepEqual(consumers,['task-session','task-session']);
  } finally {await decisions.close();}
});
