import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TaskLedger } from '../../packages/task-system/dist/ledger.js';
import { NATIVE_PROVIDER_UNAVAILABLE_SUMMARY } from '../../packages/task-system/dist/contracts.js';
import { RemoteGateway, RemoteClient, RemoteLedgerClient, RecoveryStore, ExecutorWorker, IdentityVerifier, nativeExecutionAdapter } from '../../packages/task-system/dist/remote/api.js';
import { runDetails } from '../../dashboard/public/management-model.js';
import { createNativeHarness } from './native-harness.mjs';

const missingRoute = { provider: 'unmounted-provider', model: 'configured-model' };
function seed(ledger, nodeId, path, model = missingRoute) {
  ledger.registerWorkspace('workspace', { workspaceId: 'workspace', nodeId, path, label: 'Isolated pre-dispatch test', state: 'ready', createdAt: new Date().toISOString() });
  ledger.registerNode('node', { nodeId, roles: ['executor'], capabilities: [], models: [{ ...model, reasoningEfforts: [] }], workspaceIds: ['workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
  ledger.updateTemplate('strict-template', { templateId: 'strict', version: 1, name: 'Strict agent output', description: '', defaults: {}, inputSchema: { type: 'object' }, resultContract: { type: 'object', required: ['report'], properties: { report: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['complete'], properties: { complete: { const: true } } } } } } } });
  const task = ledger.createTask('task', { title: 'Strict output cannot disguise missing provider configuration', workspaceId: 'workspace', policy: { allowedTools: [], maxRuntimeMs: 10000 } }).value;
  const run = ledger.createRun('run', { taskId: task.taskId, route: { nodeId, ...model, workspaceId: 'workspace', requiredCapabilities: [] }, configuration: { templateRef: { templateId: 'strict', version: 1 }, input: {} } }).value;
  return { task, run };
}
function assertBlocked(ledger, task, runId) {
  const run = ledger.getRun(runId), history = ledger.history(task.taskId);
  assert.equal(run.state, 'blocked');
  assert.equal(run.retry, undefined);
  assert.equal(history.reports.length, 0, 'host diagnostics never fabricate an agent Report');
  const evidence = history.events.find(event => event.type === 'run.pre_dispatch_failed');
  assert.ok(evidence, 'system-origin pre-dispatch evidence is durable');
  assert.equal(evidence.detail.origin, 'native-adapter');
  assert.equal(evidence.detail.phase, 'before-agent-start');
  assert.match(JSON.stringify(evidence.detail), /NO_ADAPTER/);
  assert.equal(history.events.find(event => event.type === 'run.settled').detail.summary, NATIVE_PROVIDER_UNAVAILABLE_SUMMARY);
  const details = runDetails(ledger.snapshot(), run);
  assert.match(details.failure, /NO_ADAPTER/);
  assert.match(details.failure, /before dispatch/);
  assert.doesNotMatch(JSON.stringify(history), /raw-secret|Bearer|api-key|token-sentinel/);
  return run;
}

test('verified missing adapter blocks before native session/model/workload and exposes a safe management reason', async () => {
  const h = await createNativeHarness({ config: { safeRetry: { maxRetries: 2 } } });
  const events = [];
  h.ctx.on('session/event', (_session, event) => events.push(event));
  try {
    const { task, run } = seed(h.ledger, 'local', h.dir);
    const claim = h.ledger.claim('claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    const result = await h.ctx.taskSystem.native.execute(claim);
    assert.equal(result.submitted, false);
    assert.equal(result.sessionId, undefined);
    assert.equal(h.ledger.getAttempt(claim.attempt.attemptId).sessionId, undefined);
    assert.equal(events.length, 0, 'no native session was created to manufacture failure evidence');
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(h.ctx.taskSystem.results.pending().length, 0, 'preflight is not a fabricated native-ready result');
    assertBlocked(h.ledger, task, run.runId);
  } finally { await h.dispose(); }
});

test('signed remote pre-dispatch witness uses the existing durable fenced settlement and strict-template exemption', async () => {
  const h = await createNativeHarness({ config: { role: 'executor', nodeId: 'worker', safeRetry: { maxRetries: 2 } } });
  const ledger = TaskLedger.open(join(h.dir, 'coordinator.sqlite'), { role: 'planner', nodeId: 'planner' });
  const stores = ['server', 'client', 'worker'].map(name => new RecoveryStore(join(h.dir, `${name}.sqlite`)));
  let worker, gateway;
  const nativeEvents = [];
  h.ctx.on('session/event', (_session, event) => nativeEvents.push(event));
  try {
    const { task, run } = seed(ledger, 'worker', h.dir);
    const keys = generateKeyPairSync('ed25519'); // Disposable fixture, never runtime configuration.
    const peer = { keyId: 'preflight-fixture', nodeId: 'worker', publicKey: keys.publicKey, audience: 'planner', operations: ['claim', 'renew', 'submit', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt', 'listWork'], workspaces: ['workspace'], capabilities: [] };
    gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: stores[0], verifier: new IdentityVerifier({ audience: 'planner', peers: [peer] }) });
    const client = new RemoteClient({ endpoint: 'https://isolated-preflight-fixture.invalid/commands', nodeId: 'worker', keyId: peer.keyId, audience: 'planner', privateKey: keys.privateKey, store: stores[1], fetch: async (_url, options) => new Response(JSON.stringify(await gateway.handle(options.body))) });
    const remote = new RemoteLedgerClient(client, 'worker');
    const provider = nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: missingRoute.provider, models: [{ model: missingRoute.model, reasoningEfforts: [] }], capabilities: [] });
    worker = new ExecutorWorker({ ledger: remote, provider, store: stores[2], policy: { role: 'executor', nodeId: 'worker', capabilities: [], workspaces: [{ workspaceId: 'workspace', nodeId: 'worker', path: h.dir, allowedRoot: h.dir }] } });
    const dispatch = await worker.execute(run.runId, 'claim');
    assert.equal(dispatch.state, 'acknowledged');
    assert.equal(dispatch.result.outcome, 'blocked');
    assert.deepEqual(dispatch.result.preDispatchFailure, { kind: 'native-provider-unavailable-v1', code: 'NO_ADAPTER', ...missingRoute });
    assert.equal(dispatch.result.report, undefined);
    assert.equal(dispatch.result.retryWitness, undefined);
    assert.equal(nativeEvents.length, 0);
    assert.equal(h.adapter.requests.length, 0);
    assertBlocked(ledger, task, run.runId);
    const replay = await worker.execute(run.runId, 'claim');
    assert.equal(replay.state, 'acknowledged');
    assert.equal(ledger.history(task.taskId).events.filter(event => event.type === 'run.pre_dispatch_failed').length, 1);
    assert.equal(h.ledger.snapshot().tasks.length, 0);
  } finally {
    await worker?.dispose(); await gateway?.dispose();
    for (const store of stores) store.close();
    ledger.close(); await h.dispose();
  }
});

test('NO_ADAPTER emitted after a registered adapter starts is still uncertain, never zero-dispatch evidence', async () => {
  const h = await createNativeHarness({ script: [() => { throw new LlmError('Bearer raw-secret token-sentinel', 'NO_ADAPTER'); }] });
  try {
    const { task, run } = seed(h.ledger, 'local', h.dir, { provider: 'test-offline', model: 'script' });
    const claim = h.ledger.claim('claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    const result = await h.ctx.taskSystem.native.execute(claim);
    assert.equal(result.run.state, 'uncertain');
    assert.equal(h.adapter.requests.length, 1);
    const history = h.ledger.history(task.taskId);
    assert.equal(history.events.some(event => event.type === 'run.pre_dispatch_failed'), false);
    assert.equal(history.reports.length, 0);
    assert.match(runDetails(h.ledger.snapshot(), result.run).failure, /NO_ADAPTER/);
    assert.doesNotMatch(JSON.stringify(history), /raw-secret|Bearer|token-sentinel/);
  } finally { await h.dispose(); }
});


test('existing native session keeps uncertainty when the configured provider is later unavailable', async () => {
  const h = await createNativeHarness({ script: ['Earlier session work was inspected'] });
  let previous;
  try {
    const { task, run } = seed(h.ledger, 'local', h.dir);
    const claim = h.ledger.claim('claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    const ref = { runId: run.runId, attemptId: claim.attempt.attemptId, nodeId: 'local', fence: claim.attempt.fence };
    const sessionId = SessionId('preexisting-session');
    h.ledger.bindSession('previous-session', { ...ref, sessionId });
    previous = await h.ctx.agents.create({ sessionId, meta: { cwd: h.dir, agentPreset: 'ptc' }, agentOptions: { provider: 'test-offline', model: 'script' } });
    previous.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Earlier work cannot be assumed effect-free by a registry check' }], source: { kind: 'user' } }));
    await previous.agent.whenIdle();
    await h.ctx.sessions.flush(previous.agent.session);
    await previous.dispose(); previous = undefined;
    const result = await h.ctx.taskSystem.native.resume({ ...claim, attempt: h.ledger.getAttempt(claim.attempt.attemptId) });
    assert.equal(result.run.state, 'uncertain');
    assert.equal(h.ledger.history(task.taskId).events.some(event => event.type === 'run.pre_dispatch_failed'), false);
    assert.equal(h.ledger.history(task.taskId).reports.length, 0);
  } finally { await previous?.dispose(); await h.dispose(); }
});

test('model task_submit_result cannot attach trusted pre-dispatch evidence or bypass its report contract', async () => {
  const route = { provider: 'test-offline', model: 'script' };
  const h = await createNativeHarness({ script: [{ name: 'task_submit_result', args: { outcome: 'blocked', summary: NATIVE_PROVIDER_UNAVAILABLE_SUMMARY, preDispatchFailure: { kind: 'native-provider-unavailable-v1', code: 'NO_ADAPTER', ...route } } }] });
  try {
    const { task, run } = seed(h.ledger, 'local', h.dir, route);
    const claim = h.ledger.claim('claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    try { await h.ctx.taskSystem.native.execute(claim); } catch { /* Rejected model output can surface as the existing native contract error. */ }
    assert.equal(h.ledger.getRun(run.runId).state, 'uncertain');
    const history = h.ledger.history(task.taskId);
    assert.equal(history.events.some(event => event.type === 'run.pre_dispatch_failed'), false);
    assert.equal(history.reports.length, 0);
    assert.ok(h.adapter.requests.length > 0, 'a dispatched model error is never trusted preflight evidence');
  } finally { await h.dispose(); }
});
