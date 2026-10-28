import {registerExecutor,publishModels} from '../../../tests/dsh/executor-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { TaskLedger, TaskError } from '../dist/ledger.js';
import { Workbench } from '../dist/workbench.js';
import { TaskPlanner, taskDecisionCatalog } from '../dist/planning.js';
import { ProjectCollaborationAuthority } from '../dist/project-collaboration/authority.js';
import { RecoveryStore, RemoteGateway, RemoteClient, RemoteLedgerClient, ExecutorWorker, IdentityVerifier, signEnvelope, httpHandler } from '../dist/remote/api.js';
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'collaboration-authority-'));
  const ledger = TaskLedger.open(join(dir, 'central.sqlite'), { role: 'planner', nodeId: 'central', ...options });
  const resources = [ledger];
  t.after(async () => { for (const r of resources.reverse()) await (r.dispose?.() ?? r.close?.()); rmSync(dir, { recursive: true, force: true }); });
  for (const nodeId of ['mbp', 'other']) {
    ledger.registerWorkspace(`workspace:${nodeId}`, { workspaceId: `ws-${nodeId}`, nodeId, path: dir, label: nodeId, state: 'ready', createdAt: new Date().toISOString() });
    registerExecutor(ledger, `node:${nodeId}`, { nodeId, roles: ['executor'], enabled: true, capabilities: ['read'], models: [{ provider: 'fixture', model: 'fixture', reasoningEfforts: ['low'] }], workspaceIds: [`ws-${nodeId}`], maxConcurrent: 4 });
  }
  const authority = new ProjectCollaborationAuthority(ledger);
  const route = { nodeId: 'other', provider: 'fixture', model: 'fixture', reasoningEffort: 'low', workspaceId: 'ws-other', requiredCapabilities: ['read'] };
  const input = { sessionId: 'local-session', cwd: '/test/local-project' };
  const call = (command, action, more = {}) => authority.projectCollaborate('mbp', command, { ...input, action, ...more });
  return { dir, ledger, resources, authority, route, input, call };
}
test('central activation persists real workbench records, restores binding, scopes status and rejects arbitrary attachment', async t => {
  const f = fixture(t);
  const a = await f.call('activate', 'activate');
  assert.equal(a.confirmed, true); assert.equal(a.binding.ownerNodeId, 'mbp'); assert.equal(a.binding.title, 'local-project');
  assert.equal(new Workbench(f.ledger).snapshot().projects.length, 1);
  const restored = new ProjectCollaborationAuthority(f.ledger);
  assert.equal((await restored.projectCollaborate('mbp', 'restore', { ...f.input, action: 'activate' })).projectId, a.projectId);
  await assert.rejects(f.call('changed-key', 'activate', { projectId: 'arbitrary-central-project' }), { code: 'CONFLICT' });
  assert.equal((await restored.projectCollaborate('other', 'attach-authorized-peer', {...f.input,action:'activate',projectId:a.projectId})).projectId,a.projectId);
  await assert.rejects(f.call('wrong-cwd', 'activate', { cwd: '/other', projectId: a.projectId }), { code: 'CONFLICT' });
  const attached = await f.call('attach', 'activate', { sessionId: 'second-session', projectId: a.projectId });
  assert.equal(attached.projectId, a.projectId);
  assert.equal(f.authority.collaborationSummaries('other').length, 1);
  const unrelated = f.ledger.createTask('private', { title: 'Private unrelated task' }).value;
  const status = await f.call('status', 'status');
  assert.equal(status.tasks.some(x => x.taskId === unrelated.taskId), false);
  assert.equal(status.binding.sessionId, f.input.sessionId);
  assert.equal(f.ledger.snapshot().tasks.some(x => x.kind === 'observed'), false);
  const nodes = await f.call('nodes', 'nodes', {read:{details:true}}); assert.equal(nodes.nodes.length, 2);
  assert.equal(JSON.stringify(nodes).includes(f.dir), false);
});
test('concurrent stable dispatch creates one linked execution; submit waits for quiescence and never accepts results', async t => {
  const f = fixture(t); const a = await f.call('a', 'activate');
  const dispatch = () => f.call('dispatch', 'dispatch', { title: 'Cross-node work', route: f.route });
  const [one, two] = await Promise.all([dispatch(), dispatch()]); assert.deepEqual(one, two);
  assert.equal(f.ledger.snapshot().tasks.length, 1); assert.equal(f.ledger.snapshot().runs.length, 1);
  assert.equal(new Workbench(f.ledger).snapshot().backlogTasks[0].backlogId, a.binding.backlogId);
  await assert.rejects(f.call('dispatch', 'dispatch', { title: 'Changed work', route: f.route }), { code: 'CONFLICT' });
  await assert.rejects(f.call('submit-before', 'submit'), { code: 'PROJECT_NOT_QUIESCENT' });
  const run = f.ledger.snapshot().runs[0];
  const claim = f.ledger.claim('claim', { runId: run.runId, nodeId: 'other', ttlMs: 60000 }).value;
  const ref = { runId: run.runId, attemptId: claim.attempt.attemptId, nodeId: 'other', fence: claim.attempt.fence, executionId: 'fixture-owner' };
  f.ledger.markRunning('running', ref); f.ledger.submit('settle', { ...ref, outcome: 'success', summary: 'Evidence complete' });
  const submitted = await f.call('submit-after', 'submit', { summary: 'Please review this project' });
  assert.equal(submitted.binding.state, 'pending_review');
  assert.notEqual(f.ledger.getRun(run.runId).reviewStatus, 'accepted');
  const reopened = new ProjectCollaborationAuthority(f.ledger);
  assert.deepEqual(await reopened.projectCollaborate('mbp', 'dispatch', { ...f.input, action: 'dispatch', title: 'Cross-node work', route: f.route }), one);
  assert.equal(f.ledger.snapshot().runs.length, 1);
});
test('dynamic central planner preserves confirmation for pooled and explicit routes and rejects unsupported models', async t => {
  const f = fixture(t, { requireConfirmation: true });
  let planner;
  const authority = new ProjectCollaborationAuthority(f.ledger, { planner: () => planner });
  const call = (id, action, extra = {}) => authority.projectCollaborate('mbp', id, { ...f.input, action, ...extra });
  await call('a', 'activate');
  await assert.rejects(call('no-model', 'dispatch', { title: 'No supported workload model', executionModel: {provider:'missing',model:'missing'} }), { code: 'EXECUTOR_REQUIRED' });
  assert.equal(f.ledger.snapshot().tasks.length, 0);
  const pooled = await call('pooled-route', 'dispatch', {title:'Use an authorized executor'});
  assert.equal(pooled.pendingConfirmation,true);assert.equal(f.ledger.getTask(pooled.taskId).confirmation.state,'pending');assert.equal(f.ledger.snapshot().runs.length,0);
  assert.deepEqual(await call('pooled-route','dispatch',{title:'Use an authorized executor'}),pooled);
  planner = new TaskPlanner(f.ledger, undefined, () => taskDecisionCatalog(f.ledger, {}), () => {});
  const queued = await call('with-route', 'dispatch', { title: 'Needs operator confirmation', route: f.route });
  assert.equal(queued.pendingConfirmation, true);
  assert.equal(f.ledger.getTask(queued.taskId).confirmation.state, 'pending');
  assert.equal(f.ledger.snapshot().runs.length, 0);
  await assert.rejects(call('submit', 'submit'), { code: 'PROJECT_NOT_QUIESCENT' });
});

test('existing project dispatch preserves its explicit estimate and rejects changed command replay', async t => {
  const f = fixture(t);
  await f.call('estimate-activate', 'activate');
  const draft = (await f.call('estimate-draft', 'session', { command: { kind: 'create', title: 'Existing bounded work' } })).result.value;
  const input = { taskId: draft.taskId, route: f.route, expectedExecutionMs: 75000 };
  const dispatched = await f.call('estimate-dispatch', 'dispatch', input);
  const run = f.ledger.getRun(dispatched.dispatch.runId);
  assert.deepEqual(run.executionExpectation, { phase: 'pending_start', expectedExecutionMs: 75000 });
  assert.deepEqual(await f.call('estimate-dispatch', 'dispatch', input), dispatched);
  for (const expectedExecutionMs of [undefined, 76000]) {
    await assert.rejects(f.call('estimate-dispatch', 'dispatch', { ...input, expectedExecutionMs }), { code: 'CONFLICT' });
  }
  assert.equal(f.ledger.snapshot().runs.length, 1);
  f.ledger.cancel('estimate-cancel', { taskId: draft.taskId, reason: 'Explicit test cancellation before execution' });
  const retry = await f.call('estimate-retry', 'dispatch', {
    taskId: draft.taskId, route: f.route, retry: true,
    expectedActionVersion: f.ledger.taskActionState(draft.taskId).version,
  });
  assert.notEqual(retry.dispatch.runId, run.runId);
  assert.equal(f.ledger.getRun(retry.dispatch.runId).executionExpectation, undefined);
  assert.deepEqual(f.ledger.getRun(run.runId).executionExpectation, { phase: 'pending_start', expectedExecutionMs: 75000 });
});

test('project collaboration strictly validates expected execution estimates before dispatch', async t => {
  const f = fixture(t);
  await f.call('strict-estimate-activate', 'activate');
  for (const [index, expectedExecutionMs] of [0, -1, 1.5, '1000', null, 30 * 86400000 + 1].entries()) {
    await assert.rejects(f.call(`strict-estimate-${index}`, 'dispatch', {
      title: 'Reject invalid estimate', route: f.route, expectedExecutionMs,
    }), { code: 'INVALID' });
  }
  await assert.rejects(f.call('estimate-status', 'status', { expectedExecutionMs: 1000 }), { code: 'INVALID' });
  await assert.rejects(f.call('estimate-unknown', 'dispatch', {
    title: 'Unknown duration field', route: f.route, expectedExecutionSeconds: 10,
  }), { code: 'INVALID' });
  assert.equal(f.ledger.snapshot().tasks.length, 0);
  assert.equal(f.ledger.snapshot().runs.length, 0);
  const accepted = await f.call('estimate-maximum', 'dispatch', {
    title: 'Maximum supported estimate', route: f.route, expectedExecutionMs: 30 * 86400000,
  });
  assert.deepEqual(f.ledger.getRun(accepted.dispatch.runId).executionExpectation, { phase: 'pending_start', expectedExecutionMs: 30 * 86400000 });
});

test('confirmation defers direct project dispatch without storing an estimate for a later dispatch', async t => {
  const f = fixture(t, { requireConfirmation: true });
  await f.call('confirmation-estimate-activate', 'activate');
  for (const [index, nextEstimate] of [undefined, 90000].entries()) {
    const request = { title: `Confirm bounded work ${index}`, route: f.route, expectedExecutionMs: 1000 };
    const queued = await f.call(`confirmation-estimate-${index}`, 'dispatch', request);
    assert.equal(queued.pendingConfirmation, true);
    assert.equal(f.ledger.history(queued.taskId).runs.length, 0);
    const task = f.ledger.getTask(queued.taskId);
    f.ledger.setTaskConfirmation(`approve-estimate-${index}`, {
      taskId: task.taskId, expectedRevision: task.confirmation.revision,
      expectedActionVersion: f.ledger.taskActionState(task.taskId).version,
      approved: true, actor: 'test-operator', reason: 'Operator authorized this task',
    });
    assert.deepEqual(await f.call(`confirmation-estimate-${index}`, 'dispatch', request), queued);
    assert.equal(f.ledger.history(queued.taskId).runs.length, 0);
    const dispatched = await f.call(`confirmed-estimate-dispatch-${index}`, 'dispatch', {
      taskId: task.taskId, route: f.route,
      ...(nextEstimate !== undefined ? { expectedExecutionMs: nextEstimate } : {}),
    });
    assert.equal(dispatched.pendingConfirmation, false);
    const run = f.ledger.getRun(dispatched.dispatch.runId);
    assert.deepEqual(run.executionExpectation, nextEstimate === undefined ? undefined : { phase: 'pending_start', expectedExecutionMs: 90000 });
    assert.equal(f.ledger.history(task.taskId).runs.length, 1);
  }
});
test('signed remote collaboration binds trusted node, preserves domain errors and recovers committed work after lost ACK', async t => {
  const f = fixture(t), keys = generateKeyPairSync('ed25519');
  let failAfterCommit = false;
  f.ledger.projectCollaborate = async (...args) => { const result = await f.authority.projectCollaborate(...args); if (failAfterCommit) { failAfterCommit = false; throw new Error('simulated lost adapter response'); } return result; };
  const server = new RecoveryStore(join(f.dir, 'server.sqlite')), clientStore = new RecoveryStore(join(f.dir, 'client.sqlite'));
  const peer = { keyId: 'fixture-key', nodeId: 'mbp', audience: 'central', publicKey: keys.publicKey, operations: ['projectCollaborate'], workspaces: ['ws-mbp'], capabilities: ['read'] };
  const gateway = new RemoteGateway({ role: 'planner', nodeId: 'central', ledger: f.ledger, store: server, verifier: new IdentityVerifier({ audience: 'central', peers: [peer] }) });
  const client = new RemoteClient({ endpoint: 'https://fixture.invalid/commands', nodeId: 'mbp', audience: 'central', keyId: 'fixture-key', privateKey: keys.privateKey, store: clientStore, fetch: async (_url, options) => new Response(JSON.stringify(await gateway.handle(options.body))) });
  f.resources.push(server, clientStore, gateway, client);
  const remote = new RemoteLedgerClient(client, 'mbp');
  const activate = await remote.projectCollaborate('mbp', 'activate', { ...f.input, action: 'activate' });
  assert.equal(activate.binding.ownerNodeId, 'mbp');
  await assert.rejects(remote.projectCollaborate('other', 'spoof', { ...f.input, action: 'status' }), /WRONG_CLIENT_NODE/);
  await assert.rejects(remote.projectCollaborate('mbp', 'no-model', { ...f.input, action: 'dispatch', title: 'Unsupported model', executionModel:{provider:'missing',model:'missing'} }), /EXECUTOR_REQUIRED/);
  failAfterCommit = true;
  const request = { ...f.input, action: 'dispatch', title: 'Exactly once despite missing ACK', route: f.route };
  await assert.rejects(remote.projectCollaborate('mbp', 'dispatch', request), /REMOTE_OUTCOME_UNCERTAIN/);
  const recovered = await remote.projectCollaborate('mbp', 'dispatch', request);
  assert.equal(recovered.confirmed, true); assert.equal(f.ledger.snapshot().runs.length, 1);
  const now = Date.now();
  const injected = signEnvelope({ version: 1, keyId: 'fixture-key', nodeId: 'mbp', audience: 'central', commandId: 'inject', nonce: 'inject-nonce', sequence: 1000, issuedAt: now, expiresAt: now + 60000, operation: 'projectCollaborate', payload: { input: { ...f.input, action: 'status' }, nodeId: 'other' } }, keys.privateKey);
  await assert.rejects(gateway.handle(JSON.stringify(injected)), /PAYLOAD_FIELDS/);
});

test('backend discovery uses fresh authenticated advertisements and strips private configuration from project status', async t => {
  const f = fixture(t); await f.call('activate', 'activate');
  const node = f.ledger.getNode('other');
  registerExecutor(f.ledger, 'backend-node', { ...node, capabilities: [...node.capabilities, 'official-codex'] });
  const route = { ...f.route, backend: 'host-owned-profile', requiredCapabilities: ['official-codex'] };
  f.ledger.recordNodeHeartbeat('advertise', { nodeId: 'other', sampledAt: Date.now(), runtimeReady: true, activeExecutions: 0, providerStatus: { state: 'not-probed', providers: [], executionRoutes: [{ ...route, cliPath: '/private/binary' }, { ...route, nodeId: 'mbp' }, { ...route, model: 'ungranted' }] } });
  publishModels(f.ledger,'other',[{provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort,backend:route.backend}]);
  const nodes = await f.call('nodes', 'nodes', {read:{details:true}});
  assert.ok(nodes.routes.some(route=>route.nodeId==='other'&&route.backend==='host-owned-profile')); assert.equal(nodes.routes.find(route=>route.backend==='host-owned-profile').backend, 'host-owned-profile');
  assert.equal(JSON.stringify(nodes).includes('/private/binary'), false);
  const d = await f.call('dispatch', 'dispatch', { title: 'Private execution configuration', route });
  const run = f.ledger.createRun('secret-run', { taskId: d.taskId, route, configuration: { input: { secretToken: 'PRIVATE_MARKER' } } }).value;
  const status = await f.call('status', 'status');
  assert.ok(status.runs.some(r => r.runId === run.runId));
  assert.equal(JSON.stringify(status).includes('PRIVATE_MARKER'), false);
  f.ledger.recordNodeHeartbeat('offline', { nodeId: 'other', sampledAt: Date.now() + 1, runtimeReady: false, activeExecutions: 0 });
  assert.ok((await f.call('nodes-offline', 'nodes', {read:{details:true}})).routes.some(route=>route.nodeId==='other'),'fresh catalog remains available for offline queuing; admission still rechecks readiness');
});

test('actual HTTP malformed collaboration rejection remains INVALID; other remote requests retain uncertainty semantics', async t => {
  const f = fixture(t), keys = generateKeyPairSync('ed25519');
  f.ledger.projectCollaborate = f.authority.projectCollaborate.bind(f.authority);
  const serverStore = new RecoveryStore(join(f.dir, 'http-server.sqlite')), clientStore = new RecoveryStore(join(f.dir, 'http-client.sqlite'));
  const peer = { keyId: 'fixture', nodeId: 'mbp', audience: 'central', publicKey: keys.publicKey, operations: ['projectCollaborate', 'getRun'], workspaces: ['ws-mbp'], capabilities: [] };
  const gateway = new RemoteGateway({ role: 'planner', nodeId: 'central', ledger: f.ledger, store: serverStore, verifier: new IdentityVerifier({ audience: 'central', peers: [peer] }) });
  const server = createServer(httpHandler(gateway, { allowLoopbackHttp: true }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const client = new RemoteClient({ endpoint: `http://127.0.0.1:${server.address().port}/commands`, allowLoopbackHttp: true, nodeId: 'mbp', audience: 'central', keyId: 'fixture', privateKey: keys.privateKey, store: clientStore });
  f.resources.push(serverStore, clientStore, gateway, { async dispose() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } }, client);
  const remote = new RemoteLedgerClient(client, 'mbp');
  await assert.rejects(remote.projectCollaborate('mbp', 'malformed', { ...f.input, action: 'unsupported-action' }), { code: 'INVALID', status: 400 });
  assert.equal(serverStore.receipt('mbp', 'malformed'), undefined);
  assert.equal(f.authority.collaborationSummaries().length, 0);
  assert.equal(f.ledger.snapshot().runs.length, 0);
  assert.equal((await client.send('getRun', 'legacy-malformed', { illegal: 'field' })).state, 'uncertain');
  const active = await remote.projectCollaborate('mbp', 'activate', { ...f.input, action: 'activate' });
  assert.equal(active.confirmed, true);
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await assert.rejects(remote.projectCollaborate('mbp', 'offline-status', { ...f.input, action: 'status' }), { code: 'REMOTE_OUTCOME_UNCERTAIN' });
});

test('new accepted work reopens all project bindings; replay cannot undo a later submission', async t => {
  let now = Date.now();
  const f = fixture(t, { now: () => now });
  const activated = await f.call('activate', 'activate');
  await f.call('attach', 'activate', { sessionId: 'second-session', projectId: activated.projectId });
  const firstFinish = await f.call('first-finish', 'submit', { summary: 'Initial local work ready for review' });
  now += 1000;
  const dispatched = await f.call('new-work', 'dispatch', { title: 'Additional requested work', route: f.route });
  assert.equal(dispatched.binding.state, 'active');
  assert.ok(dispatched.binding.updatedAt > firstFinish.binding.updatedAt);
  assert.ok(f.authority.collaborationSummaries('mbp').every(b => b.state === 'active' && b.updatedAt === dispatched.binding.updatedAt));
  const run = f.ledger.snapshot().runs[0];
  f.ledger.cancel('cancel-additional', { taskId: run.taskId, reason: 'Test work quiescent without execution' });
  now += 1000;
  await f.call('second-finish', 'submit', { summary: 'Additional work no longer needed; ready for review' });
  const beforeReplay = f.authority.collaborationSummaries('mbp');
  const replay = await f.call('new-work', 'dispatch', { title: 'Additional requested work', route: f.route });
  assert.deepEqual(replay, dispatched);
  assert.deepEqual(f.authority.collaborationSummaries('mbp'), beforeReplay);
  assert.ok(beforeReplay.every(b => b.state === 'pending_review'));
});

test('planner authorization refusal cancels only the unstarted task and does not block project finish', async t => {
  const f = fixture(t);
  let authorized=false;
  const planner = new TaskPlanner(f.ledger, {ask:async()=>{throw Error('Formal dispatch must not ask a model');}}, () => taskDecisionCatalog(f.ledger, {}), () => {if(!authorized)throw new TaskError('FORBIDDEN','Operator policy denies this dispatch');});
  const authority = new ProjectCollaborationAuthority(f.ledger, { planner });
  const call = (id, action, extra = {}) => authority.projectCollaborate('mbp', id, { ...f.input, action, ...extra });
  await call('activate', 'activate');
  const rejected = () => call('authorization-denied', 'dispatch', { title: 'Operator policy rejects this work' });
  await assert.rejects(rejected(), { code: 'FORBIDDEN' });
  assert.equal(f.ledger.snapshot().tasks.length, 1);
  assert.equal(f.ledger.snapshot().tasks[0].state, 'cancelled');
  assert.equal(f.ledger.snapshot().runs.length, 0);
  await assert.rejects(rejected(), { code: 'FORBIDDEN' });
  assert.equal(f.ledger.snapshot().tasks.length, 1);
  const finished = await call('finish', 'submit');
  assert.equal(finished.binding.state, 'pending_review');
  authorized=true;
  const accepted = await call('explicit-route', 'dispatch', { title: 'Operator supplied a valid route', route: f.route });
  assert.equal(accepted.confirmed, true);
  assert.equal(accepted.binding.state, 'active');
  assert.equal(f.ledger.snapshot().runs.length, 1);
});

test('advertised model routes support managed directories and explicit unavailable workspaces cannot dispatch', async t => {
  const f = fixture(t); await f.call('activate', 'activate');
  const node = f.ledger.getNode('other');
  f.ledger.registerWorkspace('unready-workspace', { workspaceId: 'not-ready', nodeId: 'other', path: '/private/path/not-advertised', label: 'Unavailable', state: 'planned', createdAt: new Date().toISOString() });
  registerExecutor(f.ledger, 'worker-with-backend', { ...node, capabilities: [...node.capabilities, 'official-codex'], workspaceIds: [...node.workspaceIds, 'not-ready'] });
  const advertised = { nodeId: 'other', provider: 'fixture', model: 'fixture', reasoningEffort: 'low', backend: 'fixture-host-profile', requiredCapabilities: ['official-codex'] };
  f.ledger.recordNodeHeartbeat('routes-heartbeat', { nodeId: 'other', sampledAt: Date.now(), runtimeReady: true, activeExecutions: 0, providerStatus: { state: 'not-probed', providers: [], executionRoutes: [advertised] } });
  publishModels(f.ledger,'other',[{provider:advertised.provider,model:advertised.model,reasoningEffort:advertised.reasoningEffort,backend:advertised.backend}]);
  const nodes = await f.call('nodes', 'nodes', {read:{details:true}});
  const available=nodes.routes.find(route=>route.nodeId==='other');
  assert.equal(available.workspaceId,undefined);assert.equal(available.backend,advertised.backend);
  assert.equal(JSON.stringify(nodes).includes('/private/path'), false);
  await assert.rejects(f.call('incomplete', 'dispatch', { title: 'Reject incomplete route before persistence', route: {...advertised,workspaceId:'not-ready'} }), { code: 'FORBIDDEN' });
  assert.equal(f.ledger.snapshot().tasks.length, 0); assert.equal(f.ledger.snapshot().runs.length, 0);
  assert.equal(new Workbench(f.ledger).snapshot().backlogTasks.length, 0);
  const dispatched = await f.call('complete', 'dispatch', { title: 'Use exact advertised route', route: {...available,workspaceId:'ws-other'} });
  const run = f.ledger.snapshot().runs.find(r => r.taskId === dispatched.taskId);
  assert.equal(run.route.workspaceId, 'ws-other');
  const store = new RecoveryStore(join(f.dir, 'executor-worker.sqlite'));
  let calls = 0;
  const worker = new ExecutorWorker({ ledger: f.ledger, store, policy: { role: 'executor', nodeId: 'other', capabilities: ['read', 'official-codex'], workspaces: [{ workspaceId: 'ws-other', nodeId: 'other', path: f.dir, allowedRoot: f.dir }] }, provider: { id: 'fixture', capabilities: ['read', 'official-codex'], supports: route => route.backend === 'fixture-host-profile', async execute(request) { calls++; assert.equal(request.claim.run.route.workspaceId, 'ws-other'); return { outcome: 'success', summary: 'Fixture execution was actually claimed and settled' }; } } });
  f.resources.push(store, worker);
  await worker.pollOnce(1);
  assert.equal(calls, 1);
  assert.equal(f.ledger.getRun(run.runId).state, 'succeeded');
});

test('project recovery reuses an unstarted Task, scopes cancel/repair, and explicit retry preserves prior Runs', async t => {
  const f=fixture(t),activation=await f.call('recovery-activate','activate');
  const session=(id,command)=>f.call(id,'session',{command});
  const draft=(await session('recovery-draft',{kind:'create',title:'Original work',description:'Keep this intent'})).result.value;
  f.ledger.projectExecutionSettings.save({projectId:activation.projectId,expectedRevision:0,allowedNodeIds:['mbp'],executionBindings:{}});
  await assert.rejects(f.call('not-allowed','dispatch',{taskId:draft.taskId,nodeId:'other',executionModel:{provider:'fixture',model:'fixture',reasoningEffort:'low'}}),{code:'PROJECT_NODE_NOT_ALLOWED'});
  assert.equal(f.ledger.snapshot().tasks.length,1);assert.equal(f.ledger.snapshot().runs.length,0);
  f.ledger.projectExecutionSettings.save({projectId:activation.projectId,expectedRevision:1,allowedNodeIds:['other'],executionBindings:{}});
  const dispatched=await f.call('recovery-dispatch','dispatch',{taskId:draft.taskId,route:f.route});
  const run=dispatched.dispatch;
  assert.equal(run.taskId,draft.taskId);assert.equal(f.ledger.snapshot().tasks.length,1);
  assert.deepEqual(await f.call('recovery-dispatch','dispatch',{taskId:draft.taskId,route:f.route}),dispatched);
  await assert.rejects(f.call('accidental-double','dispatch',{taskId:draft.taskId,route:f.route}),{code:'CONFLICT'});
  await session('repair-original',{kind:'repair',taskId:draft.taskId,runId:run.runId,expectedActionVersion:f.ledger.taskActionState(draft.taskId).version});
  assert.equal(f.ledger.snapshot().runs.length,1);
  const stranger=f.ledger.createTask('stranger-task',{title:'Other project'}).value;
  await assert.rejects(session('cancel-stranger',{kind:'cancel',taskId:stranger.taskId,reason:'No permission'}),{code:'FORBIDDEN'});
  await assert.rejects(f.call('dispatch-stranger','dispatch',{taskId:stranger.taskId,route:f.route}),{code:'FORBIDDEN'});
  const cancelled=await session('cancel-original',{kind:'cancel',taskId:draft.taskId,reason:'User deferred optional work'});
  assert.equal(cancelled.result.runs[0].state,'cancelled');
  await f.call('stage-finish','submit',{summary:'Stage delivered; optional work deferred'});
  const retried=await f.call('retry-original','dispatch',{taskId:draft.taskId,route:f.route,retry:true,expectedActionVersion:f.ledger.taskActionState(draft.taskId).version});
  assert.notEqual(retried.dispatch.runId,run.runId);assert.equal(f.ledger.getRun(run.runId).state,'cancelled');
  assert.equal(f.ledger.snapshot().runs.length,2);
  const claimed=f.ledger.claim('claim-retry',{runId:retried.dispatch.runId,nodeId:'other',ttlMs:60000}).value;
  const ref={runId:claimed.run.runId,attemptId:claimed.attempt.attemptId,nodeId:'other',fence:claimed.attempt.fence,executionId:'retry-owner'};
  f.ledger.markRunning('retry-running',ref);
  await session('cancel-running',{kind:'cancel',taskId:draft.taskId,reason:'User requested stop'});
  assert.equal(f.ledger.getRun(ref.runId).state,'running');
  await assert.rejects(f.call('running-finish','submit'),error=>error.code==='PROJECT_NOT_QUIESCENT' && error.message.includes(ref.runId) && error.message.includes('task_wait'));
  await assert.rejects(f.call('running-rerun','dispatch',{taskId:draft.taskId,route:f.route,retry:true,expectedActionVersion:f.ledger.taskActionState(draft.taskId).version}),{code:'CONFLICT'});
  f.ledger.acknowledgeCancellation('confirmed-stop',ref);
  await f.call('confirmed-finish','submit',{summary:'Cancellation confirmed'});
});

test('project write receipts stay compact and default reads hide bodies while detail pagination retains safe diagnosis',async t=>{
 const f=fixture(t);await f.call('read-activate','activate');
 const dispatched=await f.call('read-dispatch','dispatch',{title:'Read work',description:'LARGE_INTENT_'+('x'.repeat(10000)),route:f.route});
 const taskId=dispatched.taskId;
 for(let i=0;i<7;i++)f.ledger.appendReport('read-report-'+i,{taskId,title:'Report '+i,body:'REPORT_BODY_'+i,kind:'progress'});
 const result=await f.call('small-progress','update',{summary:'Recorded progress'});
 assert.equal(result.tasks,undefined);assert.equal(result.reports,undefined);
 const query=(await f.call('read-query','session',{command:{kind:'query'}})).result;
 assert.equal(query.reports.length,1);assert.equal(query.reports[0].title,'Report 6');
 assert.doesNotMatch(JSON.stringify(query),/LARGE_INTENT|REPORT_BODY/);
 const ids=[];let cursor;
 do {
  const page=(await f.call('history-'+(cursor??'0'),'session',{command:{kind:'history',taskId,read:{details:true,section:'reports',limit:2,...(cursor?{cursor}:{})}}})).result;
  ids.push(...page.reports.map(report=>report.reportId));
  assert.ok(page.reports.every(report=>report.body.startsWith('REPORT_BODY')));
  cursor=page.page.nextCursor;
 }while(cursor);
 assert.equal(new Set(ids).size,7);
 await assert.rejects(f.call('different-read-target','session',{command:{kind:'history',taskId,read:{taskId:'different'}}}),/target differs/);
 const waiting=(await f.call('read-wait','session',{command:{kind:'wait',taskId,quietMs:0}})).result;
 assert.ok(waiting.pending.some(value=>value.taskId===taskId && value.recoveryActions.includes('task_cancel')));
});

test('uncertain effects cannot be retried or hidden by task cancellation and drafts have actionable wait entries',async t=>{
 const f=fixture(t);await f.call('uncertain-activate','activate');
 const draft=(await f.call('unstarted-draft','session',{command:{kind:'create',title:'Unstarted work'}})).result.value;
 const waiting=(await f.call('unstarted-wait','session',{command:{kind:'wait',taskId:draft.taskId,quietMs:0}})).result;
 assert.equal(waiting.pending[0].phase,'unstarted');assert.deepEqual(waiting.pending[0].recoveryActions,['task_dispatch','task_cancel']);
 await f.call('dispose-draft','session',{command:{kind:'cancel',taskId:draft.taskId,reason:'Optional draft deferred'}});
 const dispatched=await f.call('uncertain-dispatch','dispatch',{title:'Uncertain effects',route:f.route}),run=dispatched.dispatch;
 const claim=f.ledger.claim('uncertain-claim',{runId:run.runId,nodeId:'other',ttlMs:60000}).value;
 const ref={runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'other',fence:claim.attempt.fence,executionId:'uncertain-owner'};
 f.ledger.markRunning('uncertain-running',ref);f.ledger.submit('uncertain-outcome',{...ref,outcome:'unknown',summary:'Cannot confirm effects'});
 await f.call('cancel-uncertain','session',{command:{kind:'cancel',taskId:run.taskId,reason:'User requested stop'}});
 assert.equal(f.ledger.getRun(run.runId).state,'uncertain');
 await assert.rejects(f.call('retry-uncertain','dispatch',{taskId:run.taskId,route:f.route,retry:true,expectedActionVersion:f.ledger.taskActionState(run.taskId).version}),{code:'CONFLICT'});
 await assert.rejects(f.call('finish-uncertain','submit'),error=>error.code==='PROJECT_NOT_QUIESCENT' && error.message.includes('verify_stopped'));
 const status=f.ledger.allSettled(run.taskId,0,undefined,true);assert.equal(status.pending[0].phase,'uncertain');assert.equal(status.pending[0].needsAction,true);
});
