import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TaskLedger } from '../../packages/task-system/dist/index.js';
import { RemoteGateway, RemoteClient, RemoteLedgerClient, RecoveryStore, ExecutorWorker, IdentityVerifier, nativeExecutionAdapter, observationForwarder } from '../../packages/remote-execution/dist/api.js';
import { createNativeHarness } from './native-harness.mjs';
import * as deepseekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';

for (const code of ['NO_ADAPTER', 'MISSING_CREDENTIAL', 'AUTH', 'TOKEN_SECRET_SENTINEL']) {
  test(`signed remote native ${code} returns a safe canonical code to authority without a result report or retry`, { timeout: 20000 }, async () => {
    const h = await createNativeHarness({ config: { role: 'executor', nodeId: 'worker', safeRetry: { maxRetries: 2 } }, script: [() => { throw new LlmError('raw-secret-sentinel', code, { cause: new Error('nested-secret-sentinel') }); }] });
    const ledger = TaskLedger.open(join(h.dir, 'coordinator.sqlite'), { role: 'planner', nodeId: 'planner' });
    const stores = ['server', 'client', 'worker'].map(name => new RecoveryStore(join(h.dir, `${name}.sqlite`)));
    let gateway, worker;
    const terminalCodes = [];
    h.ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') terminalCodes.push(event.data.reason.error?.code); });
    try {
      if (code === 'MISSING_CREDENTIAL') {
        h.ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_TASK_TEST_EMPTY_KEY: '' } }]));
        await h.ctx.plugin(deepseekApiKey, { apiKeyEnv: 'DSH_TASK_TEST_EMPTY_KEY', baseURL: 'https://must-not-request.invalid/anthropic' });
      }
      const routeModel = code === 'NO_ADAPTER' ? { provider: 'intentionally-unconfigured', model: 'test-model' } : code === 'MISSING_CREDENTIAL' ? { provider: 'deepseek-official', model: 'deepseek-flash' } : { provider: 'test-offline', model: 'script' };
      const keys = generateKeyPairSync('ed25519');
      const peer = { keyId: 'offline-key', nodeId: 'worker', publicKey: keys.publicKey, audience: 'planner', operations: ['claim', 'renew', 'submit', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt', 'listWork', 'taskWait'], workspaces: ['workspace'], capabilities: ['native-offline'] };
      ledger.registerWorkspace('workspace', { workspaceId: 'workspace', nodeId: 'worker', path: h.dir, label: 'Isolated error workspace', state: 'ready', createdAt: new Date().toISOString() });
      ledger.registerNode('node', { nodeId: 'worker', roles: ['executor'], capabilities: ['native-offline'], models: [{ ...routeModel, reasoningEfforts: [] }], workspaceIds: ['workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
      const task = ledger.createTask('task', { title: 'Native remote missing-provider diagnostics', workspaceId: 'workspace', policy: { allowedTools: [], maxRuntimeMs: 10000 } }).value;
      const run = ledger.createRun('run', { taskId: task.taskId, route: { nodeId: 'worker', ...routeModel, requiredCapabilities: ['native-offline'], workspaceId: 'workspace' } }).value;
      gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: stores[0], verifier: new IdentityVerifier({ audience: 'planner', peers: [peer] }) });
      const client = new RemoteClient({ endpoint: 'https://offline-fixture.invalid/commands', nodeId: 'worker', keyId: peer.keyId, audience: 'planner', privateKey: keys.privateKey, store: stores[1], fetch: async (_url, options) => new Response(JSON.stringify(await gateway.handle(options.body))) });
      const remote = new RemoteLedgerClient(client, 'worker');
      const provider = nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: routeModel.provider, models: [{ model: routeModel.model, reasoningEfforts: [] }], capabilities: ['native-offline'] });
      worker = new ExecutorWorker({ ledger: remote, provider, store: stores[2], policy: { role: 'executor', nodeId: 'worker', capabilities: ['native-offline'], workspaces: [{ workspaceId: 'workspace', nodeId: 'worker', path: h.dir, allowedRoot: h.dir }] } });
      const results = await worker.pollOnce(1);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'fulfilled');
      const dispatch = results[0].value;
      assert.equal(dispatch.state, 'acknowledged');
      assert.equal(dispatch.result.outcome, 'unknown');
      assert.equal(dispatch.result.retryWitness, undefined);
      const canonical = code === 'TOKEN_SECRET_SENTINEL' ? 'RUNTIME_ERROR' : code;
      assert.match(dispatch.result.summary, new RegExp(`ended with ${canonical} without`));
      const authority = ledger.getRun(run.runId);
      assert.equal(authority.state, 'uncertain');
      assert.equal(authority.outcome, 'unknown');
      assert.equal(authority.validation, 'not-submitted');
      assert.equal(authority.retry, undefined);
      const history = ledger.history(task.taskId);
      assert.equal(history.reports.length, 0);
      assert.equal(history.events.find(event => event.type === 'run.settled').detail.summary, dispatch.result.summary);
      assert.doesNotMatch(JSON.stringify(history), /raw-secret-sentinel|nested-secret-sentinel|TOKEN_SECRET_SENTINEL|DSH_TASK_TEST_EMPTY_KEY|must-not-request/);
      assert.equal(terminalCodes.at(-1), code);
      assert.equal(h.adapter.requests.length, ['NO_ADAPTER', 'MISSING_CREDENTIAL'].includes(code) ? 0 : 1);
      assert.equal((await worker.pollOnce()).length, 0);
    } finally {
      await worker?.dispose(); await gateway?.dispose();
      for (const store of stores) store.close();
      ledger.close(); await h.dispose();
    }
  });
}

test('signed remote discovery and worker execute through actual DSH AgentLoop; model and network are external fixtures', { timeout: 20000 }, async () => {
  const h = await createNativeHarness({ config: { role: 'executor', nodeId: 'worker' }, script: [{ name: 'task_settle', args: { outcome: 'success', summary: 'Native remote task verified', reportTitle: 'Native remote result', reportBody: 'Generated by the actual owned DSH agent with a scripted external model.' } }] });
  const ledger = TaskLedger.open(join(h.dir, 'coordinator.sqlite'), { role: 'planner', nodeId: 'planner' });
  const stores = ['server', 'client', 'worker'].map(name => new RecoveryStore(join(h.dir, `${name}.sqlite`)));
  const [serverStore, clientStore, workerStore] = stores;
  let gateway, worker;
  try {
    const keys = generateKeyPairSync('ed25519');
    const peer = { keyId: 'offline-key', nodeId: 'worker', publicKey: keys.publicKey, audience: 'planner', operations: ['claim', 'renew', 'submit', 'cancel', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt', 'acknowledgeCancellation', 'listWork', 'taskWait'], workspaces: ['workspace'], capabilities: ['native-offline'] };
    ledger.registerWorkspace('workspace', { workspaceId: 'workspace', nodeId: 'worker', path: h.dir, label: 'Isolated native workspace', state: 'ready', createdAt: new Date().toISOString() });
    ledger.registerNode('node', { nodeId: 'worker', roles: ['executor'], capabilities: ['native-offline'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: ['workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
    const task = ledger.createTask('task', { title: 'Native remote execution', workspaceId: 'workspace', policy: { allowedNodeIds: ['worker'], allowedWorkspaceIds: ['workspace'], allowedTools: [], maxRuntimeMs: 10000 } }).value;
    const run = ledger.createRun('run', { taskId: task.taskId, route: { nodeId: 'worker', provider: 'test-offline', model: 'script', requiredCapabilities: ['native-offline'], workspaceId: 'workspace' } }).value;
    gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: serverStore, verifier: new IdentityVerifier({ audience: 'planner', peers: [peer] }) });
    const client = new RemoteClient({ endpoint: 'https://offline-fixture.invalid/commands', nodeId: 'worker', keyId: peer.keyId, audience: 'planner', privateKey: keys.privateKey, store: clientStore, fetch: async (_url, options) => new Response(JSON.stringify(await gateway.handle(options.body))) });
    const remote = new RemoteLedgerClient(client, 'worker');
    const provider = nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: 'test-offline', models: [{ model: 'script', reasoningEfforts: [] }], capabilities: ['native-offline'] });
    worker = new ExecutorWorker({ ledger: remote, provider, store: workerStore, policy: { role: 'executor', nodeId: 'worker', capabilities: ['native-offline'], workspaces: [{ workspaceId: 'workspace', nodeId: 'worker', path: h.dir, allowedRoot: h.dir }] } });
    const result = await worker.pollOnce(1);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'fulfilled');
    assert.equal(result[0].value.state, 'acknowledged');
    assert.equal(ledger.getRun(run.runId).state, 'succeeded');
    assert.equal(ledger.history(task.taskId).reports.length, 1);
    assert.equal(h.adapter.requests.length, 1);
    assert.equal(h.ledger.snapshot().tasks.length, 0, 'remote execution must never borrow or write local task identities');
    assert.equal(h.ctx.taskSystem.native.activeCount, 0);
    assert.equal((await worker.pollOnce()).length, 0, 'completed work is not executed again');
  } finally {
    await worker?.dispose(); await gateway?.dispose();
    for (const store of stores) store.close();
    ledger.close(); await h.dispose();
  }
});

test('native observed text reaches signed planner intake within workspace scope and recovers a lost response without dispatch', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-observation-'));
  let h = await createNativeHarness({ dir, config: { role: 'executor', nodeId: 'observer', observationEnabled: true }, script: ['Inside workspace result', 'Outside workspace result', 'Missing workspace result'] });
  const ledger = TaskLedger.open(join(dir, 'coordinator.sqlite'), { role: 'planner', nodeId: 'planner' });
  const serverStore = new RecoveryStore(join(dir, 'server.sqlite'));
  const clientStore = new RecoveryStore(join(dir, 'client.sqlite'));
  let gateway, client, detach;
  let networkCalls = 0, loseResponse = true;
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'native signed observation condition timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    const keys = generateKeyPairSync('ed25519');
    const peer = { keyId: 'observer-key', nodeId: 'observer', publicKey: keys.publicKey, audience: 'planner', operations: ['observe'], workspaces: ['workspace'], capabilities: [] };
    gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: serverStore, verifier: new IdentityVerifier({ audience: 'planner', peers: [peer] }) });
    client = new RemoteClient({ endpoint: 'https://offline-fixture.invalid/commands', nodeId: 'observer', keyId: peer.keyId, audience: 'planner', privateKey: keys.privateKey, store: clientStore, fetch: async (_url, options) => {
      networkCalls++;
      const envelope = JSON.parse(options.body);
      assert.equal(envelope.operation, 'observe');
      assert.equal(envelope.payload.cwd, undefined, 'local filesystem paths are not transmitted');
      const receipt = await gateway.handle(options.body);
      if (loseResponse) { loseResponse = false; throw new Error('Response lost after coordinator commit'); }
      return new Response(JSON.stringify(receipt));
    } });
    const remote = new RemoteLedgerClient(client, 'observer');
    const sink = observationForwarder(remote, { workspaceId: 'workspace', nodeId: 'observer', path: dir, allowedRoot: dir });
    // Exercise durable backlog replay, not only events emitted after subscribing.
    for (const [index, cwd] of [dir, tmpdir(), undefined].entries()) {
      const handle = await h.ctx.agents.create({ sessionId: SessionId(`observation-${index}`), ...(cwd ? { meta: { cwd } } : {}), agentOptions: { provider: 'test-offline', model: 'script' } });
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'An ordinary human request' }] }));
      await handle.agent.whenIdle();
      await h.ctx.sessions.flush(handle.agent.session);
      await handle.dispose();
    }
    assert.equal(h.ledger.observationCandidates('pending').length, 3);
    detach = h.ctx.taskSystem.subscribeObservations(sink);
    await until(() => ledger.observationCandidates('pending').length === 1 && clientStore.pendingObservations().length === 1);
    detach(); await h.dispose();
    h = await createNativeHarness({ dir, config: { role: 'executor', nodeId: 'observer', observationEnabled: true } });
    detach = h.ctx.taskSystem.subscribeObservations(sink);
    await until(() => clientStore.pendingObservations().length === 0);
    assert.equal(networkCalls, 2, 'one delivery and one exact receipt retry; outside or missing workspace never sent');
    const [candidate] = ledger.observationCandidates('pending');
    assert.equal(candidate.body, 'Inside workspace result');
    assert.match(candidate.sourceId, /^remote-dsh:observer:workspace:/);
    assert.equal(candidate.cwd, undefined);
    assert.equal(h.ledger.observationCandidates('pending').length, 3, 'local source records remain durable for review');
    assert.equal(h.ledger.snapshot().tasks.length, 0);
    assert.equal(ledger.snapshot().tasks.length, 0);
    assert.equal(ledger.snapshot().runs.length, 0);
    assert.equal(h.ctx.taskSystem.native.activeCount, 0);
  } finally {
    detach?.(); await h.dispose(); await client?.dispose(); await gateway?.dispose();
    clientStore.close(); serverStore.close(); ledger.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('two real native executor hosts delegate through the signed coordinator, enforce subtree scope, wait, and recover without replay', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-recursion-'));
  const configA = { role: 'executor', nodeId: 'alpha', executionTools: ['task_delegate', 'task_note'] };
  let a = await createNativeHarness({ dir: join(dir, 'alpha'), config: configA });
  const b = await createNativeHarness({ dir: join(dir, 'beta'), config: { role: 'executor', nodeId: 'beta' } });
  const ledger = TaskLedger.open(join(dir, 'coordinator.sqlite'), { role: 'planner', nodeId: 'planner' });
  const serverStore = new RecoveryStore(join(dir, 'server.sqlite'));
  const nodes = ['alpha', 'beta'];
  const keys = nodes.map(() => generateKeyPairSync('ed25519'));
  const operations = ['claim', 'renew', 'submit', 'cancel', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt', 'acknowledgeCancellation', 'listWork', 'delegate', 'taskHistory', 'taskWait', 'taskNote', 'taskReport'];
  const peers = nodes.map((nodeId, index) => ({ keyId: `key-${nodeId}`, nodeId, publicKey: keys[index].publicKey, audience: 'planner', operations, workspaces: ['workspace-alpha', 'workspace-beta'], capabilities: ['native-offline'] }));
  const gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: serverStore, verifier: new IdentityVerifier({ audience: 'planner', peers }) });
  const bindings = [a, b].map((h, index) => ({ workspaceId: `workspace-${nodes[index]}`, nodeId: nodes[index], path: h.dir, allowedRoot: h.dir }));
  let clients = [], stores = [], workers = [];
  const startWorker = (index, h) => {
    const nodeId = nodes[index];
    const clientStore = new RecoveryStore(join(dir, `client-${nodeId}.sqlite`));
    const workerStore = new RecoveryStore(join(dir, `worker-${nodeId}.sqlite`));
    const client = new RemoteClient({ endpoint: 'https://offline-fixture.invalid/commands', nodeId, keyId: peers[index].keyId, audience: 'planner', privateKey: keys[index].privateKey, store: clientStore, fetch: async (_url, options) => new Response(JSON.stringify(await gateway.handle(options.body))) });
    const remote = new RemoteLedgerClient(client, nodeId);
    const provider = nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: 'test-offline', models: [{ model: 'script', reasoningEfforts: [] }], capabilities: ['native-offline'] });
    const worker = new ExecutorWorker({ ledger: remote, provider, store: workerStore, policy: { role: 'executor', nodeId, capabilities: ['native-offline'], workspaces: [bindings[index]] } });
    clients[index] = client; stores[index] = [clientStore, workerStore]; workers[index] = worker;
    return worker;
  };
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'recursive native progress timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  const toolValue = options => {
    const result = options.messages.findLast(message => message.role === 'tool');
    assert.equal(result?.isError, false, JSON.stringify(result?.content));
    return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
  };
  let child, waiting = false;
  try {
    for (const [index, nodeId] of nodes.entries()) {
      ledger.registerWorkspace(`workspace-${nodeId}`, { ...bindings[index], label: `Isolated ${nodeId}`, state: 'ready', createdAt: new Date().toISOString() });
      ledger.registerNode(`node-${nodeId}`, { nodeId, roles: ['executor'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], capabilities: ['native-offline'], workspaceIds: [bindings[index].workspaceId], maxConcurrent: 1, enabled: true, lastSeenAt: new Date().toISOString() });
    }
    const route = index => ({ nodeId: nodes[index], workspaceId: bindings[index].workspaceId, provider: 'test-offline', model: 'script', requiredCapabilities: ['native-offline'] });
    const parent = ledger.createTask('recursive-root', { title: 'Coordinate scoped native child', workspaceId: bindings[0].workspaceId, policy: { allowedNodeIds: nodes, allowedWorkspaceIds: bindings.map(binding => binding.workspaceId), allowedTools: ['task_delegate', 'task_note'], maxRuntimeMs: 15000, settlementQuietMs: 50, maxDepth: 2 } }).value;
    ledger.queueTaskNote('root-context-note', { taskId: parent.taskId, body: 'Coordinator-provided context for the next run.', actor: 'offline-operator' });
    const run = ledger.createRun('recursive-root-run', { taskId: parent.taskId, route: route(0) }).value;
    const foreign = ledger.createTask('foreign-recursive-task', { title: 'Confidential unrelated coordinator task' }).value;
    a.adapter.script.push(
      { name: 'task_delegate', args: { commandId: 'delegate-child', title: 'Scoped child on beta', route: route(1) } },
      options => { child = toolValue(options).value; assert.equal(child.task.parentTaskId, parent.taskId); return { name: 'task_note', args: { commandId: 'future-child-note', taskId: child.task.taskId, body: 'Only a future child run may consume this note.' } }; },
      { name: 'task_history', args: { taskId: foreign.taskId } },
      options => { assert.equal(options.messages.findLast(message => message.role === 'tool').isError, true); assert.ok(!JSON.stringify(options.messages).includes(foreign.title)); return { name: 'task_report', args: { commandId: 'parent-progress', taskId: parent.taskId, title: 'Delegated', body: 'Waiting for a scoped child.' } }; },
      { name: 'task_settle', args: { outcome: 'success', summary: 'Premature parent completion must be rejected' } },
      options => { assert.equal(options.messages.findLast(message => message.role === 'tool').isError, true); waiting = true; return { name: 'task_wait', args: { taskId: parent.taskId, quietMs: 50, timeoutMs: 5000 } }; },
      options => { assert.equal(toolValue(options).settled, true); return { name: 'task_settle', args: { outcome: 'success', summary: 'Child reviewed after quiet settlement', reportBody: 'The owned child completed on beta.' } }; },
    );
    b.adapter.script.push(
      () => ({ name: 'task_report', args: { commandId: 'child-progress', taskId: child.task.taskId, title: 'Child work', body: 'Scoped beta evidence.' } }),
      { name: 'task_settle', args: { outcome: 'success', summary: 'Child completed', reportBody: 'Beta result verified.' } },
    );
    const first = startWorker(0, a).pollOnce(1);
    await until(() => waiting);
    assert.equal(ledger.getRun(run.runId).state, 'running');
    const second = await startWorker(1, b).pollOnce(1);
    assert.equal(second[0].status, 'fulfilled');
    assert.equal(second[0].value.state, 'acknowledged');
    const parentResult = await first;
    assert.equal(parentResult[0].status, 'fulfilled');
    assert.equal(parentResult[0].value.state, 'acknowledged');
    assert.equal(ledger.getRun(run.runId).state, 'succeeded');
    assert.equal(ledger.getRun(child.run.runId).state, 'succeeded');
    assert.equal(ledger.history(parent.taskId).reports.filter(report => report.kind === 'result').length, 1);
    assert.equal(ledger.history(foreign.taskId).reports.length, 0);
    assert.equal(a.ledger.snapshot().tasks.length, 0);
    assert.equal(b.ledger.snapshot().tasks.length, 0);
    assert.ok(JSON.stringify(a.adapter.requests).includes('Coordinator-provided context for the next run.'));
    assert.ok(!JSON.stringify(b.adapter.requests).includes('Only a future child run may consume this note.'));
    await workers[0].dispose(); await clients[0].dispose(); stores[0].forEach(store => store.close()); await a.dispose();
    a = await createNativeHarness({ dir: join(dir, 'alpha'), config: configA });
    const restored = startWorker(0, a);
    const recovered = await restored.recoverResults();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].state, 'acknowledged');
    assert.deepEqual(await restored.pollOnce(1), []);
    assert.equal(a.adapter.requests.length, 0, 'restarting completed owner never replays model work');
    const followup = ledger.createRun('child-next-run', { taskId: child.task.taskId, route: route(1) }).value;
    assert.equal(followup.contextNotes.length, 1);
    assert.equal(followup.contextNotes[0].body, 'Only a future child run may consume this note.');
    assert.ok(followup.contextNotes[0].reportId);
  } finally {
    await Promise.allSettled(workers.map(worker => worker?.dispose()));
    await Promise.allSettled(clients.map(client => client?.dispose()));
    for (const group of stores) for (const store of group ?? []) store.close();
    await gateway.dispose(); serverStore.close(); ledger.close(); await a.dispose(); await b.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});

test('signed remote retry uses real native zero-tool evidence, recovers a lost transition receipt, and resumes the same session', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-safe-retry-'));
  const safeRetry = { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 100 };
  const config = { role: 'executor', nodeId: 'worker', safeRetry };
  let h = await createNativeHarness({ dir: join(dir, 'host'), config, script: [() => { throw new LlmError('Synthetic provider connection failed', 'TRANSPORT'); }] });
  const ledger = TaskLedger.open(join(dir, 'coordinator.sqlite'), { role: 'planner', nodeId: 'planner', safeRetry });
  const serverStore = new RecoveryStore(join(dir, 'server.sqlite'));
  const keys = generateKeyPairSync('ed25519');
  const peer = { keyId: 'retry-key', nodeId: 'worker', publicKey: keys.publicKey, audience: 'planner', operations: ['claim', 'renew', 'submit', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt', 'acknowledgeCancellation', 'listWork', 'taskWait', 'retryBeforeEffects'], workspaces: ['workspace'], capabilities: ['native-offline'] };
  const gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: serverStore, verifier: new IdentityVerifier({ audience: 'planner', peers: [peer] }) });
  let client, worker, clientStore, workerStore, loseRetryResponse = true;
  const start = () => {
    clientStore = new RecoveryStore(join(dir, 'client.sqlite')); workerStore = new RecoveryStore(join(dir, 'worker.sqlite'));
    client = new RemoteClient({ endpoint: 'https://offline-fixture.invalid/commands', nodeId: 'worker', keyId: peer.keyId, audience: 'planner', privateKey: keys.privateKey, store: clientStore, fetch: async (_url, options) => {
      const envelope = JSON.parse(options.body);
      const receipt = await gateway.handle(options.body);
      if (envelope.operation === 'retryBeforeEffects' && loseRetryResponse) { loseRetryResponse = false; throw new Error('Retry response lost after coordinator commit'); }
      return new Response(JSON.stringify(receipt));
    } });
    const remote = new RemoteLedgerClient(client, 'worker');
    const provider = nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: 'test-offline', models: [{ model: 'script', reasoningEfforts: [] }], capabilities: ['native-offline'] });
    worker = new ExecutorWorker({ ledger: remote, provider, store: workerStore, policy: { role: 'executor', nodeId: 'worker', capabilities: ['native-offline'], workspaces: [{ workspaceId: 'workspace', nodeId: 'worker', path: h.dir, allowedRoot: h.dir }] } });
  };
  try {
    ledger.registerWorkspace('retry-workspace', { workspaceId: 'workspace', nodeId: 'worker', path: h.dir, label: 'Retry fixture', state: 'ready', createdAt: new Date().toISOString() });
    ledger.registerNode('retry-node', { nodeId: 'worker', roles: ['executor'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], capabilities: ['native-offline'], workspaceIds: ['workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
    const task = ledger.createTask('remote-retry-task', { title: 'Safe native retry', workspaceId: 'workspace', policy: { maxRuntimeMs: 5000 } }).value;
    const run = ledger.createRun('remote-retry-run', { taskId: task.taskId, route: { nodeId: 'worker', provider: 'test-offline', model: 'script', workspaceId: 'workspace', requiredCapabilities: ['native-offline'] } }).value;
    start();
    const [first] = await worker.pollOnce(1);
    assert.equal(first.status, 'fulfilled'); assert.equal(first.value.state, 'retry_pending');
    const queued = ledger.getRun(run.runId);
    assert.equal(queued.state, 'queued'); assert.equal(queued.retry.count, 1);
    assert.equal(first.value.result.retryWitness.kind, 'dsh-owned-zero-tools-v1');
    assert.equal(first.value.result.retryWitness.toolCallCount, 0);
    const sessionId = first.value.sessionId;
    assert.equal(h.ctx.agents.get(sessionId), undefined);
    await worker.dispose(); await client.dispose(); clientStore.close(); workerStore.close(); await h.dispose();
    h = await createNativeHarness({ dir: join(dir, 'host'), config, script: [{ name: 'task_settle', args: { outcome: 'success', summary: 'Recovered remote native provider', reportBody: 'No tool effects were repeated.' } }] });
    start();
    const recovered = await worker.recoverResults();
    assert.equal(recovered[0].state, 'retry_scheduled');
    assert.equal(h.adapter.requests.length, 0, 'receipt recovery alone never dispatches a model');
    while (Date.now() < Date.parse(queued.retry.notBefore)) await new Promise(resolve => setTimeout(resolve, 10));
    const [second] = await worker.pollOnce(1);
    assert.equal(second.status, 'fulfilled'); assert.equal(second.value.state, 'acknowledged');
    assert.equal(second.value.sessionId, sessionId);
    assert.equal(ledger.getRun(run.runId).state, 'succeeded');
    assert.equal(ledger.getRun(run.runId).executionStartedAt, queued.executionStartedAt);
    assert.equal(h.adapter.requests.length, 1);
    assert.equal(h.ledger.snapshot().tasks.length, 0);
    const attempts = ledger.history(task.taskId).events.filter(event => event.type === 'attempt.claimed').map(event => ledger.getAttempt(event.detail.attemptId));
    assert.equal(attempts.length, 2); assert.deepEqual(attempts.map(attempt => attempt.fence), [1, 2]);
    assert.equal(attempts[0].retryEvidence.disposed, true);
  } finally {
    await worker?.dispose(); await client?.dispose(); clientStore?.close(); workerStore?.close();
    await gateway.dispose(); serverStore.close(); ledger.close(); await h.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});

test('signed native approval holds the live external call and rejects an allowed response arriving after expiry', { timeout: 15000 }, async () => {
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  for (const late of [false, true]) {
    const h = await createNativeHarness({ config: { role: 'executor', nodeId: 'worker', executionTools: ['remote_review'], trustedUnconfinedTools: true }, script: [
      { name: 'remote_review', args: { operation: 'bounded-fixture-effect' } },
      options => { const msg = options.messages.findLast(item => item.role === 'tool'); const value = JSON.parse(msg.content.filter(item => item.type === 'text').map(item => item.text).join('\n')); return { name: 'task_settle', args: { outcome: value.executed ? 'success' : 'blocked', summary: value.executed ? 'Reviewed external effect completed' : 'Live approval did not authorize this effect' } }; },
    ] });
    const ledger = TaskLedger.open(join(h.dir, 'authority.sqlite'), { role: 'planner', nodeId: 'planner' });
    const stores = ['approval-server', 'approval-client', 'approval-worker'].map(name => new RecoveryStore(join(h.dir, `${name}.sqlite`)));
    let effects = 0, delayed = false, worker, client, gateway;
    try {
      await h.ctx.loader.create({ id: 'approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'ask' } });
      await h.ctx.loader.create({ id: 'bridge', name: pathToFileURL(resolve('packages/task-system/dist/approval-bridge.js')).href, config: { enabled: true, reviewableTools: [{ toolName: 'remote_review', argumentKeys: ['operation'] }], timeoutMs: late ? 200 : 3000, pollIntervalMs: 20 } });
      await h.ctx.loader.await();
      const fixture = h.ctx.plugin({ name: 'remote-approval-effect', inject: ['tools', 'approval'], apply(ctx) { ctx.tools.register(defineTool({ name: 'remote_review', description: 'Offline approval fixture', parameters: { operation: { type: 'string', required: true } }, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (_args, exec) => { const decision = await ctx.approval.request({ agent: exec.agent, toolName: 'remote_review', callId: exec.callId, reason: 'One configured fixture effect', signal: exec.signal }); if (decision !== 'allowed-once') return { executed: false, decision }; effects++; return { executed: true }; } })); } });
      await fixture.await();
      const keys = generateKeyPairSync('ed25519');
      const peer = { keyId: 'approval-key', nodeId: 'worker', publicKey: keys.publicKey, audience: 'planner', operations: ['claim', 'renew', 'submit', 'cancel', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt', 'acknowledgeCancellation', 'listWork', 'taskWait', 'offerApproval', 'approvalStatus', 'cancelApproval'], workspaces: ['workspace'], capabilities: ['native-offline'] };
      ledger.registerWorkspace('workspace', { workspaceId: 'workspace', nodeId: 'worker', path: h.dir, label: 'Approval fixture workspace', state: 'ready', createdAt: new Date().toISOString() });
      ledger.registerNode('node', { nodeId: 'worker', roles: ['executor'], capabilities: ['native-offline'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: ['workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
      const task = ledger.createTask('task', { title: 'Review one remote effect', workspaceId: 'workspace', policy: { allowedTools: ['remote_review'] } }).value;
      const run = ledger.createRun('run', { taskId: task.taskId, route: { nodeId: 'worker', provider: 'test-offline', model: 'script', workspaceId: 'workspace', requiredCapabilities: ['native-offline'] } }).value;
      gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: stores[0], verifier: new IdentityVerifier({ audience: 'planner', peers: [peer] }) });
      client = new RemoteClient({ endpoint: 'https://offline-fixture.invalid/commands', nodeId: 'worker', keyId: peer.keyId, audience: 'planner', privateKey: keys.privateKey, store: stores[1], fetch: async (_url, options) => {
        const operation = JSON.parse(options.body).operation;
        const receipt = await gateway.handle(options.body);
        if (late && operation === 'approvalStatus' && JSON.stringify(receipt).includes('allowed-once')) { delayed = true; await new Promise(resolve => setTimeout(resolve, 250)); }
        return new Response(JSON.stringify(receipt));
      } });
      const remote = new RemoteLedgerClient(client, 'worker');
      worker = new ExecutorWorker({ ledger: remote, provider: nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: 'test-offline', models: [{ model: 'script', reasoningEfforts: [] }], capabilities: ['native-offline'] }), store: stores[2], policy: { role: 'executor', nodeId: 'worker', capabilities: ['native-offline'], workspaces: [{ workspaceId: 'workspace', nodeId: 'worker', path: h.dir, allowedRoot: h.dir }] } });
      const running = worker.pollOnce(1);
      const deadline = Date.now() + 3000;
      while (!ledger.approvals().length) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
      const approval = ledger.approvals()[0];
      assert.equal(effects, 0); assert.equal(h.ledger.approvals().length, 0);
      ledger.respondApproval('trusted-operator', { requestId: approval.requestId, expectedRevision: approval.revision, decision: 'allowed-once', actor: 'offline-operator' });
      const [result] = await running;
      assert.equal(result.status, 'fulfilled');
      assert.equal(ledger.getRun(run.runId).state, late ? 'blocked' : 'succeeded');
      assert.equal(effects, late ? 0 : 1); assert.equal(delayed, late);
      assert.equal(h.ledger.snapshot().tasks.length, 0);
      assert.equal(h.ctx.taskSystem.native.activeCount, 0);
    } finally { await worker?.dispose(); await client?.dispose(); await gateway?.dispose(); for (const store of stores) store.close(); ledger.close(); await h.dispose(); }
  }
});

test('signed external native result preflight requires this execution source preparation before remote journaling', { timeout: 20000 }, async () => {
  const { pathToFileURL } = await import('node:url'); const { resolve } = await import('node:path');
  const { createLegacyTemplates, registerLegacyTaskPack } = await import('../../examples/legacy-task-pack/index.mjs');
  const packPolicy = { timeZone: 'UTC', automationIds: ['custom-example'], nodeAliases: { worker: 'synthetic-node' } };
  const h = await createNativeHarness({ config: { role: 'executor', nodeId: 'worker', executionTools: ['legacy_sources_read', 'legacy_report_prepare'], trustedUnconfinedTools: true } });
  const ledger = TaskLedger.open(join(h.dir, 'preflight-authority.sqlite'), { role: 'planner', nodeId: 'planner' });
  const unmountPack = registerLegacyTaskPack(ledger, packPolicy);
  const stores = ['preflight-server', 'preflight-client', 'preflight-worker'].map(name => new RecoveryStore(join(h.dir, `${name}.sqlite`)));
  let worker, client, gateway;
  try {
    await h.ctx.loader.create({ id: 'external-source-pack', name: pathToFileURL(resolve('examples/legacy-task-pack/plugin.mjs')).href, config: { ...packPolicy, sourceRegistry: [{ id: 'synthetic-source', root: resolve('examples/legacy-task-pack/readers/fixtures'), manifest: 'manifest.json' }] } });
    await h.ctx.loader.await();
    const keys = generateKeyPairSync('ed25519');
    const peer = { keyId: 'preflight-key', nodeId: 'worker', publicKey: keys.publicKey, audience: 'planner', operations: ['claim', 'renew', 'submit', 'cancel', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt', 'acknowledgeCancellation', 'listWork', 'taskWait'], workspaces: ['workspace'], capabilities: ['legacy.task-pack.v1'] };
    ledger.registerWorkspace('workspace', { workspaceId: 'workspace', nodeId: 'worker', path: h.dir, label: 'Native source preparation fixture', state: 'ready', createdAt: new Date().toISOString() });
    ledger.registerNode('node', { nodeId: 'worker', roles: ['executor'], capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: ['workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
    const template = createLegacyTemplates(packPolicy).find(item => item.defaults.kind === 'game_daily');
    const make = suffix => { const task = ledger.createTask(`task-${suffix}`, { title: `Remote source gate ${suffix}`, workspaceId: 'workspace', policy: { allowedTools: ['legacy_sources_read', 'legacy_report_prepare'] } }).value; const run = ledger.createRun(`run-${suffix}`, { taskId: task.taskId, configuration: { template, input: { sourceIds: ['synthetic-source'], windowStart: '2026-09-15T00:00:00Z', windowEnd: '2026-09-16T00:00:00Z' } }, route: { nodeId: 'worker', provider: 'test-offline', model: 'script', workspaceId: 'workspace', requiredCapabilities: ['legacy.task-pack.v1'] } }).value; return { task, run }; };
    gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: stores[0], verifier: new IdentityVerifier({ audience: 'planner', peers: [peer] }) });
    client = new RemoteClient({ endpoint: 'https://offline-fixture.invalid/commands', nodeId: 'worker', keyId: peer.keyId, audience: 'planner', privateKey: keys.privateKey, store: stores[1], fetch: async (_url, options) => new Response(JSON.stringify(await gateway.handle(options.body))) });
    const remote = new RemoteLedgerClient(client, 'worker');
    worker = new ExecutorWorker({ ledger: remote, provider: nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: 'test-offline', models: [{ model: 'script', reasoningEfforts: [] }], capabilities: ['legacy.task-pack.v1'] }), store: stores[2], policy: { role: 'executor', nodeId: 'worker', capabilities: ['legacy.task-pack.v1'], workspaces: [{ workspaceId: 'workspace', nodeId: 'worker', path: h.dir, allowedRoot: h.dir }] } });
    const value = options => { const response = options.messages.findLast(item => item.role === 'tool'); assert.equal(response.isError, false, JSON.stringify(response.content)); return JSON.parse(response.content.filter(item => item.type === 'text').map(item => item.text).join('\n')); };
    let prepared;
    h.adapter.script.push(
      { name: 'legacy_sources_read', args: { sourceIds: ['synthetic-source'] } },
      options => ({ name: 'legacy_report_prepare', args: { commandId: 'external-prepared', kind: 'game_daily', input: { sourceReceiptId: value(options).sourceReceiptId, sourceId: 'synthetic-source' } } }),
      options => { prepared = value(options); return { name: 'task_settle', args: { outcome: 'success', summary: prepared.summary, reportTitle: prepared.report.title, reportBody: prepared.report.body, reportData: prepared.report.data, reportSchemaId: prepared.report.schemaId } }; },
    );
    const first = make('prepared');
    assert.equal((await worker.pollOnce(1))[0].status, 'fulfilled');
    assert.equal(ledger.getRun(first.run.runId).state, 'succeeded');
    assert.equal(ledger.history(first.task.taskId).reports[0].schemaId, 'game_daily_report.v1');
    const second = make('unprepared');
    const copied = structuredClone(prepared.report);
    copied.data.binding = { task_id: second.task.taskId, run_id: second.run.runId };
    // Deterministic coordinator semantics alone accept this internally consistent
    // payload; executor preflight must additionally prove fresh source preparation.
    h.adapter.script.push({ name: 'task_settle', args: { outcome: 'success', summary: prepared.summary, reportTitle: copied.title, reportBody: copied.body, reportData: copied.data, reportSchemaId: copied.schemaId } });
    assert.equal((await worker.pollOnce(1))[0].status, 'fulfilled');
    assert.equal(ledger.getRun(second.run.runId).state, 'uncertain');
    assert.equal(ledger.getRun(second.run.runId).validation, 'not-submitted');
    assert.equal(ledger.history(second.task.taskId).reports.length, 0);
    assert.equal(h.adapter.requests.length, 4);
    assert.equal(h.ledger.snapshot().tasks.length, 0);
  } finally { await worker?.dispose(); await client?.dispose(); await gateway?.dispose(); for (const store of stores) store.close(); unmountPack(); ledger.close(); await h.dispose(); }
});

test('signed completed-tool native continuation recovers its retry receipt and prevents exact prior dispatch replay', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-safe-retry-'));
  const safeRetry = { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 100, resumableTools: ['reviewed_effect'] };
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  let effects = 0;
  const mount = async host => { const fiber = host.ctx.plugin({ name: 'reviewed-effect-fixture', inject: ['tools'], apply(ctx) { ctx.tools.register(defineTool({ name: 'reviewed_effect', description: 'Explicitly reviewed bounded fixture effect', parameters: { value: { type: 'string', required: true } }, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: args => { effects++; return { completed: true, value: args.value }; } })); } }); await fiber.await(); };
  const invocation = { name: 'reviewed_effect', args: { value: 'once' } };
  const config = { role: 'executor', nodeId: 'worker', safeRetry, executionTools: ['reviewed_effect'], trustedUnconfinedTools: true };
  let h = await createNativeHarness({ dir: join(dir, 'host'), config, script: [invocation, () => { throw new LlmError('Synthetic provider connection failed after completed tool', 'TRANSPORT'); }] });
  await mount(h);
  const ledger = TaskLedger.open(join(dir, 'coordinator.sqlite'), { role: 'planner', nodeId: 'planner', safeRetry });
  const serverStore = new RecoveryStore(join(dir, 'server.sqlite'));
  const keys = generateKeyPairSync('ed25519');
  const peer = { keyId: 'retry-key', nodeId: 'worker', publicKey: keys.publicKey, audience: 'planner', operations: ['claim', 'renew', 'submit', 'receipt', 'bindSession', 'markRunning', 'getRun', 'getAttempt', 'acknowledgeCancellation', 'listWork', 'taskWait', 'retryBeforeEffects'], workspaces: ['workspace'], capabilities: ['native-offline'] };
  const gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store: serverStore, verifier: new IdentityVerifier({ audience: 'planner', peers: [peer] }) });
  let client, worker, clientStore, workerStore, loseRetryResponse = true;
  const start = () => {
    clientStore = new RecoveryStore(join(dir, 'client.sqlite')); workerStore = new RecoveryStore(join(dir, 'worker.sqlite'));
    client = new RemoteClient({ endpoint: 'https://offline-fixture.invalid/commands', nodeId: 'worker', keyId: peer.keyId, audience: 'planner', privateKey: keys.privateKey, store: clientStore, fetch: async (_url, options) => {
      const envelope = JSON.parse(options.body);
      const receipt = await gateway.handle(options.body);
      if (envelope.operation === 'retryBeforeEffects' && loseRetryResponse) { loseRetryResponse = false; throw new Error('Retry response lost after coordinator commit'); }
      return new Response(JSON.stringify(receipt));
    } });
    const remote = new RemoteLedgerClient(client, 'worker');
    const provider = nativeExecutionAdapter(h.ctx.taskSystem.native, { provider: 'test-offline', models: [{ model: 'script', reasoningEfforts: [] }], capabilities: ['native-offline'] });
    worker = new ExecutorWorker({ ledger: remote, provider, store: workerStore, policy: { role: 'executor', nodeId: 'worker', capabilities: ['native-offline'], workspaces: [{ workspaceId: 'workspace', nodeId: 'worker', path: h.dir, allowedRoot: h.dir }] } });
  };
  try {
    ledger.registerWorkspace('retry-workspace', { workspaceId: 'workspace', nodeId: 'worker', path: h.dir, label: 'Retry fixture', state: 'ready', createdAt: new Date().toISOString() });
    ledger.registerNode('retry-node', { nodeId: 'worker', roles: ['executor'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], capabilities: ['native-offline'], workspaceIds: ['workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
    const task = ledger.createTask('remote-retry-task', { title: 'Safe native retry', workspaceId: 'workspace', policy: { maxRuntimeMs: 5000 } }).value;
    const run = ledger.createRun('remote-retry-run', { taskId: task.taskId, route: { nodeId: 'worker', provider: 'test-offline', model: 'script', workspaceId: 'workspace', requiredCapabilities: ['native-offline'] } }).value;
    start();
    const [first] = await worker.pollOnce(1);
    assert.equal(first.status, 'fulfilled'); assert.equal(first.value.state, 'retry_pending');
    const queued = ledger.getRun(run.runId);
    assert.equal(queued.state, 'queued'); assert.equal(queued.retry.count, 1);
    assert.equal(first.value.result.retryWitness.kind, 'dsh-owned-completed-tools-v1');
    assert.equal(first.value.result.retryWitness.toolCallCount, 1);
    assert.equal(first.value.result.retryWitness.toolResultCount, 1);
    assert.equal(effects, 1); assert.equal(queued.retry.completedTools.length, 1);
    const sessionId = first.value.sessionId;
    assert.equal(h.ctx.agents.get(sessionId), undefined);
    await worker.dispose(); await client.dispose(); clientStore.close(); workerStore.close(); await h.dispose();
    h = await createNativeHarness({ dir: join(dir, 'host'), config, script: [invocation, options => { const prior = options.messages.findLast(message => message.role === 'tool'); assert.equal(prior.isError, true); assert.match(JSON.stringify(prior.content), /already completed/); return { name: 'task_settle', args: { outcome: 'success', summary: 'Recovered remote native provider', reportBody: 'No tool effects were repeated.' } }; }] });
    await mount(h);
    start();
    const recovered = await worker.recoverResults();
    assert.equal(recovered[0].state, 'retry_scheduled');
    assert.equal(h.adapter.requests.length, 0, 'receipt recovery alone never dispatches a model');
    while (Date.now() < Date.parse(queued.retry.notBefore)) await new Promise(resolve => setTimeout(resolve, 10));
    const [second] = await worker.pollOnce(1);
    assert.equal(second.status, 'fulfilled'); assert.equal(second.value.state, 'acknowledged');
    assert.equal(second.value.sessionId, sessionId);
    assert.equal(ledger.getRun(run.runId).state, 'succeeded');
    assert.equal(ledger.getRun(run.runId).executionStartedAt, queued.executionStartedAt);
    assert.equal(h.adapter.requests.length, 2);
    assert.equal(effects, 1, 'reviewed completed effect never runs a second time');
    assert.equal(h.ledger.snapshot().tasks.length, 0);
    const attempts = ledger.history(task.taskId).events.filter(event => event.type === 'attempt.claimed').map(event => ledger.getAttempt(event.detail.attemptId));
    assert.equal(attempts.length, 2); assert.deepEqual(attempts.map(attempt => attempt.fence), [1, 2]);
    assert.equal(attempts[0].retryEvidence.disposed, true);
  } finally {
    await worker?.dispose(); await client?.dispose(); clientStore?.close(); workerStore?.close();
    await gateway.dispose(); serverStore.close(); ledger.close(); await h.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});
