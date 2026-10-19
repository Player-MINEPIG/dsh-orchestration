import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { ToolCallId, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ScriptedModel } from './scripted-model.mjs';
import * as deepseekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-task-native-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let serial = 0;
const pluginUrl = pathToFileURL(resolve('packages/task-system/dist/dsh-plugin.js')).href;
async function harness({ role = 'both', script = [], dir, native = true, config = {} } = {}) {
  dir ??= join(scratch, `host-${serial++}`);
  const ctx = new Context();
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(resolve('package.json')).href });
  const rows = [
    ['llm', '@deepseek-ai/dsh-llm'],
    ['sessions', '@deepseek-ai/dsh-session'],
    ['sessionProjections', '@deepseek-ai/dsh-session-projection'],
    ['systemPrompt', '@deepseek-ai/dsh-system-prompt'],
    ['tools', '@deepseek-ai/dsh-tools'],
    ...(native ? [
      ['agents', '@deepseek-ai/dsh-agent'],
      ['persistence', '@deepseek-ai/dsh-session-persistence-jsonl', { root: join(dir, 'sessions'), compression: 'none' }],
      ['agentLoop', '@deepseek-ai/dsh-agent-loop', { agents: [] }],
    ] : []),
    ['task', pluginUrl, { role, nodeId: 'local', databasePath: join(dir, 'tasks.sqlite'), keepAlive: false, leaseTtlMs: 10000, ...config }],
  ].map(([id, name, config]) => ({ id, name, config }));
  await ctx.loader.root.update(rows);
  await ctx.loader.await();
  assert.ok(ctx.taskSystem, 'real Loader must activate taskSystem');
  if(role!== 'planner' && !ctx.taskSystem.executionDirectories.settings().root)ctx.taskSystem.executionDirectories.save({root:realpathSync(dir),expectedRevision:0});
  if (native && role !== 'planner') assert.ok(ctx.taskSystem.native, 'native provider injection must activate');
  const adapter = new ScriptedModel(script);
  ctx.llm.registerAdapter(['test-offline'], adapter);
  return { ctx, dir, adapter, ledger: ctx.taskSystem.ledger, dispose: () => ctx.fiber.dispose() };
}
function seed(h, suffix = '', taskOptions = {}, modelRoute = { provider: 'test-offline', model: 'script' }) {
  const ledger = h.ledger;
  ledger.registerNode(`node${suffix}`, {
    nodeId: 'local', roles: ['both'], capabilities: [], models: [{ ...modelRoute, reasoningEfforts: [] }], workspaceIds: taskOptions.workspaceId ? [taskOptions.workspaceId] : [], enabled: true, lastSeenAt: new Date().toISOString(),
  });
  const task = ledger.createTask(`create${suffix}`, { title: `Offline native attempt ${suffix}`, ...taskOptions }).value;
  const run = ledger.createRun(`run${suffix}`, { taskId: task.taskId, route: { nodeId: 'local', ...modelRoute, requiredCapabilities: [], ...(taskOptions.workspaceId ? { workspaceId: taskOptions.workspaceId } : {}) } }).value;
  const claim = ledger.claim(`claim${suffix}`, { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
  return { task, run, claim };
}
function tool(ctx, name, args, agent) {
  return ctx.tools.execute({ callId: ToolCallId(`test-${serial++}`), name, arguments: args, signal: new AbortController().signal, ...(agent ? { agent } : {}) });
}
async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('native acceptance condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('actual Loader + AgentLoop commits only the owned causal result and retains reports after unload', async () => {
  const h = await harness({ script: [
    { name: 'task_submit_result', args: { outcome: 'success', summary: 'Work verified', reportTitle: 'Result', reportBody: 'Explicit structured result from owned attempt' } },
    'Finished',
  ] });
  const { task, run, claim } = seed(h);
  const result = await h.ctx.taskSystem.native.execute(claim);
  assert.equal(result.submitted, true);
  assert.equal(h.adapter.requests.length, 1, 'task_submit_result concludes the native turn');
  assert.equal(result.run.state, 'succeeded');
  assert.equal(h.ledger.getTask(task.taskId).state, 'completed');
  assert.equal(h.ledger.getAttempt(claim.attempt.attemptId).sessionId, result.sessionId);
  assert.equal(h.ctx.agents.get(result.sessionId), undefined, 'owned handle disposed after drain');
  assert.equal(h.ledger.history(task.taskId).reports.length, 1);
  const dbPath = join(h.dir, 'tasks.sqlite');
  await h.dispose();
  assert.ok(existsSync(dbPath), 'unload retains durable database');
  const recovered = await harness({ dir: h.dir });
  assert.equal(recovered.ledger.getRun(run.runId).state, 'succeeded');
  assert.equal(recovered.ledger.history(task.taskId).reports[0].body, 'Explicit structured result from owned attempt');
  await recovered.dispose();
});

test('assistant completion text and idle become uncertain without task_submit_result', async () => {
  const h = await harness({ config: { safeRetry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 200 } }, script: ['Successfully completed everything'] });
  try {
    const { task, claim } = seed(h);
    const result = await h.ctx.taskSystem.native.execute(claim);
    assert.equal(result.submitted, false);
    assert.equal(result.run.state, 'uncertain');
    assert.equal(result.run.retry, undefined, 'plain idle is never classified as a transient request failure');
    assert.notEqual(h.ledger.getTask(task.taskId).state, 'completed');
  } finally { await h.dispose(); }
});

for (const code of ['NO_ADAPTER', 'MISSING_CREDENTIAL']) {
  test(`native ${code} publishes only its canonical code without inventing a result or retry`, async () => {
    const h = await harness({ config: { safeRetry: { maxRetries: 2 } } });
    const terminals = [];
    h.ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') terminals.push(event); });
    try {
      if (code === 'MISSING_CREDENTIAL') {
        h.ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_TASK_TEST_EMPTY_KEY: '' } }]));
        await h.ctx.plugin(deepseekApiKey, { apiKeyEnv: 'DSH_TASK_TEST_EMPTY_KEY', baseURL: 'https://must-not-request.invalid/anthropic' });
      }
      const route = code === 'NO_ADAPTER' ? { provider: 'intentionally-unconfigured', model: 'test-model' } : { provider: 'deepseek-official', model: 'deepseek-flash' };
      const { task, claim } = seed(h, '', {}, route);
      const result = await h.ctx.taskSystem.native.execute(claim);
      assert.equal(result.run.state, code === 'NO_ADAPTER' ? 'blocked' : 'uncertain');
      assert.equal(result.run.validation, undefined);
      assert.equal(result.submitted, false);
      assert.equal(result.run.retry, undefined);
      assert.equal(h.adapter.requests.length, 0);
      const history = h.ledger.history(task.taskId);
      assert.equal(history.reports.length, 0);
      if (code === 'NO_ADAPTER') { assert.equal(terminals.length, 0); assert.equal(result.sessionId, undefined); assert.equal(history.events.find(e=>e.type==='run.pre_dispatch_failed').detail.code, code); }
      else assert.equal(terminals.at(-1).data.reason.error.code, code);
      const summary = history.events.find(event => event.type === 'run.settled').detail.summary;
      assert.match(summary, code === 'NO_ADAPTER' ? /blocked before dispatch: NO_ADAPTER/ : new RegExp(`ended with ${code} without`));
      assert.ok(!summary.includes('DSH_TASK_TEST_EMPTY_KEY'));
      assert.ok(!summary.includes('must-not-request'));
      assert.equal(h.ledger.pendingRuns('local').length, 0);
    } finally { await h.dispose(); }
  });
}

test('native summaries redact raw diagnostics and arbitrary error codes', async () => {
  for (const [code, canonical] of [['AUTH', 'AUTH'], ['INVALID_CREDENTIAL', 'INVALID_CREDENTIAL'], ['TOKEN_SECRET_SENTINEL_123', 'RUNTIME_ERROR']]) {
    const h = await harness({ config: { safeRetry: { maxRetries: 2 } }, script: [() => { throw new LlmError('Bearer raw-secret-sentinel', code, { cause: new Error('nested-secret-sentinel'), headers: { authorization: 'header-secret-sentinel' } }); }] });
    try {
      const { task, claim } = seed(h);
      const result = await h.ctx.taskSystem.native.execute(claim);
      const history = h.ledger.history(task.taskId);
      assert.equal(result.run.state, 'uncertain');
      assert.equal(result.run.retry, undefined);
      assert.equal(result.run.validation, undefined);
      assert.match(history.events.find(event => event.type === 'run.settled').detail.summary, new RegExp(`ended with ${canonical} without`));
      assert.doesNotMatch(JSON.stringify(history), /raw-secret-sentinel|nested-secret-sentinel|header-secret-sentinel|TOKEN_SECRET_SENTINEL_123/);
      assert.equal(h.adapter.requests.length, 1);
    } finally { await h.dispose(); }
  }
});

test('native terminal observation ignores foreign sessions and clears prior errors when this invocation completes', async () => {
  const h = await harness({ script: [() => { throw new LlmError('earlier private error', 'AUTH'); }, 'Recovered without a settlement'] });
  let foreign;
  let queued = false;
  let foreignTerminals = 0;
  try {
    foreign = await h.ctx.agents.create({ sessionId: SessionId('foreign-terminal-fixture'), agentOptions: { provider: 'test-offline', model: 'script' } });
    const { task, claim } = seed(h);
    const ownedSessionId = () => h.ledger.getAttempt(claim.attempt.attemptId).sessionId;
    h.ctx.on('agent/status', ({ agent, status }) => {
      if (agent.id !== ownedSessionId() || status !== 'idle' || queued) return;
      queued = true;
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Complete the same invocation' }] }));
    });
    // Register after owned setup, then emit a foreign terminal after its final
    // completion. An unscoped observer would overwrite the owned outcome.
    h.adapter.script[1] = () => {
      h.ctx.on('session/event', (session, event) => {
        if (session.id === ownedSessionId() && event.type === 'turn/end' && event.data.reason.kind === 'completed') {
          foreign.agent.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'foreign-secret-sentinel' } } });
          foreignTerminals++;
        }
      });
      return 'Recovered without a settlement';
    };
    const result = await h.ctx.taskSystem.native.execute(claim);
    const history = h.ledger.history(task.taskId);
    assert.equal(queued, true);
    assert.equal(h.adapter.requests.length, 2);
    assert.equal(foreignTerminals, 1);
    assert.equal(result.run.state, 'uncertain');
    const summary = history.events.find(event => event.type === 'run.settled').detail.summary;
    assert.match(summary, /reached idle without/);
    assert.doesNotMatch(summary, /AUTH|MISSING_CREDENTIAL|foreign-secret/);
  } finally { await foreign?.dispose(); await h.dispose(); }
});

test('causal task_submit_result takes precedence over a later native terminal error', async () => {
  const h = await harness({ script: [{ name: 'task_submit_result', args: { outcome: 'success', summary: 'Verified causal result', reportBody: 'Explicit task outcome remains authoritative.' } }] });
  const terminalCodes = [];
  h.ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') terminalCodes.push(event.data.reason.error?.code); });
  try {
    const { task, claim } = seed(h);
    h.ctx.on('agent/turn-stopping', ({ agent }) => {
      if (agent.id === h.ledger.getAttempt(claim.attempt.attemptId).sessionId) throw new LlmError('late-secret-sentinel', 'AUTH');
    });
    const result = await h.ctx.taskSystem.native.execute(claim);
    assert.equal(terminalCodes.at(-1), 'AUTH');
    assert.equal(result.submitted, true);
    assert.equal(result.run.state, 'succeeded');
    assert.equal(result.run.validation, undefined);
    const history = h.ledger.history(task.taskId);
    assert.equal(history.reports.length, 1);
    assert.equal(history.events.find(event => event.type === 'run.settled').detail.summary, 'Verified causal result');
    assert.doesNotMatch(JSON.stringify(history), /late-secret-sentinel|ended with AUTH/);
  } finally { await h.dispose(); }
});

test('native transient retry requires live zero-tool evidence and resumes the exact durable session after host restart', async () => {
  const config = { safeRetry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 200 } };
  const first = await harness({ config, script: [() => { throw new LlmError('Synthetic provider diagnostic must remain outside ledger summaries', 'SERVER', { status: 503 }); }] });
  const { task, claim } = seed(first, '', { policy: { maxRuntimeMs: 5000 } });
  const result = await first.ctx.taskSystem.native.execute(claim);
  assert.equal(result.retryScheduled, true);
  assert.equal(result.run.state, 'queued');
  assert.equal(result.run.retry.count, 1);
  assert.equal(result.run.retry.sessionId, result.sessionId);
  const previous = first.ledger.getAttempt(claim.attempt.attemptId);
  assert.equal(previous.retryEvidence.kind, 'dsh-owned-zero-tools-v1');
  assert.equal(previous.retryEvidence.toolCallCount, 0);
  assert.equal(previous.retryEvidence.toolDispatchCount, 0);
  assert.ok(previous.retryEvidence.terminalSeq < previous.retryEvidence.toSeq);
  assert.equal(first.ctx.agents.get(result.sessionId), undefined, 'old owned handle is disposed before retry transition');
  assert.equal(first.ledger.pendingRuns('local').length, 0, 'persisted delay is enforced');
  assert.ok(!JSON.stringify(first.ledger.snapshot()).includes('Synthetic provider diagnostic'));
  const startedAt = result.run.executionStartedAt;
  await first.dispose();
  const second = await harness({ dir: first.dir, config: { ...config, keepAlive: true, maintenanceIntervalMs: 100 }, script: [{ name: 'task_submit_result', args: { outcome: 'success', summary: 'Recovered without repeating any tool effects' } }] });
  try {
    await until(() => second.ledger.getRun(claim.run.runId).state === 'succeeded');
    const history = second.ledger.history(task.taskId);
    const attempts = history.events.filter(event => event.type === 'attempt.claimed').map(event => second.ledger.getAttempt(event.detail.attemptId));
    assert.equal(history.runs.length, 1);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map(attempt => attempt.sessionId), [result.sessionId, result.sessionId]);
    assert.deepEqual(attempts.map(attempt => attempt.fence), [1, 2]);
    assert.equal(second.ledger.getRun(claim.run.runId).executionStartedAt, startedAt);
    assert.equal(second.adapter.requests.length, 1);
  } finally { await second.dispose(); }
});

test('native safe retry refuses post-tool failures and non-transient errors and ignores the legacy host deadline', async () => {
  const retry = { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 200 };
  const effects = await harness({ config: { safeRetry: retry, executionTools: ['fixture_effect'], trustedUnconfinedTools: true }, script: [{ name: 'fixture_effect', args: {} }, () => { throw new LlmError('Synthetic server interruption', 'SERVER'); }] });
  let calls = 0;
  effects.ctx.tools.register(defineTool({ name: 'fixture_effect', description: 'Count fixture effects', parameters: {}, output: { schema: { type: 'json' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: () => { calls++; return true; } }));
  try {
    const { claim } = seed(effects);
    const result = await effects.ctx.taskSystem.native.execute(claim);
    assert.equal(calls, 1); assert.equal(result.run.state, 'uncertain'); assert.equal(result.run.retry, undefined);
  } finally { await effects.dispose(); }
  const auth = await harness({ config: { safeRetry: retry }, script: [() => { throw new LlmError('Synthetic rejected credential', 'AUTH'); }] });
  try {
    const { claim } = seed(auth); const result = await auth.ctx.taskSystem.native.execute(claim);
    assert.equal(result.run.state, 'uncertain'); assert.equal(result.run.retry, undefined);
  } finally { await auth.dispose(); }
  const expired = await harness({ config: { safeRetry: retry, executionTimeoutMs: 100 }, script: [() => { throw new LlmError('Synthetic transient', 'RATE_LIMIT', { status: 429 }); }] });
  try {
    const { claim } = seed(expired); const result = await expired.ctx.taskSystem.native.execute(claim);
    assert.equal(result.run.state, 'queued'); assert.equal(result.run.validation, undefined); assert.equal(result.run.retry.count, 1);
    assert.equal(expired.ledger.getAttempt(claim.attempt.attemptId).retryEvidence.toolCallCount, 0);
  } finally { await expired.dispose(); }
});

test('bounded native retries stop after the configured count without resetting execution time', async () => {
  const failure = () => { throw new LlmError('Synthetic transport unavailable', 'TRANSPORT'); };
  const h = await harness({ config: { keepAlive: true, maintenanceIntervalMs: 100, safeRetry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 100 } }, script: [failure, failure, failure] });
  try {
    const { claim, task } = seed(h, '', { policy: { maxRuntimeMs: 5000 } });
    const first = await h.ctx.taskSystem.native.execute(claim);
    assert.equal(first.run.state, 'queued');
    await until(() => h.ledger.getRun(claim.run.runId).state === 'failed');
    const history = h.ledger.history(task.taskId);
    const attempts = history.events.filter(event => event.type === 'attempt.claimed').map(event => h.ledger.getAttempt(event.detail.attemptId));
    assert.equal(history.runs.length, 1);
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map(attempt => attempt.sessionId)).size, 1);
    assert.equal(h.adapter.requests.length, 3);
    assert.equal(h.ledger.getRun(claim.run.runId).executionStartedAt, first.run.executionStartedAt);
    assert.equal(h.ledger.getRun(claim.run.runId).validation, undefined);
    assert.ok(attempts.every(attempt => attempt.retryEvidence.toolCallCount === 0));
  } finally { await h.dispose(); }
});

test('native local heartbeat reports capability readiness without provider probes and reconciles health alerts', async () => {
  const h = await harness({ config: { localNode: { models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], capabilities: [], workspaceIds: [], enabled: true }, requireFreshHeartbeat: true, healthAlerts: true, alertDestinations: ['offline-alert-destination'] } });
  try {
    const first = h.ledger.nodeStatuses()[0];
    assert.equal(first.state, 'online'); assert.equal(first.source, 'host-local'); assert.equal(first.providerStatus.state, 'not-probed');
    h.ctx.taskSystem.tick(); h.ctx.taskSystem.tick();
    assert.equal(h.ledger.nodeStatuses()[0].observedAt, first.observedAt, 'ordinary maintenance does not persist a heartbeat every tick');
    assert.equal(h.adapter.requests.length, 0);
    await h.ctx.loader.resolve('agentLoop').fiber.dispose(); await h.ctx.loader.await();
    h.ctx.taskSystem.tick();
    assert.equal((await tool(h.ctx, 'task_nodes', {})).value[0].state, 'unavailable');
    const alerts = (await tool(h.ctx, 'task_alerts', {})).value;
    assert.equal(alerts.length, 1); assert.equal(alerts[0].status, 'open');
    assert.ok(h.ledger.deliveries().some(delivery => delivery.destination === 'offline-alert-destination' && delivery.state === 'pending'));
    h.ctx.loader.remove('agentLoop');
    await h.ctx.loader.create({ id: 'agentLoop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } }); await h.ctx.loader.await();
    h.ctx.taskSystem.tick();
    assert.equal(h.ledger.nodeStatuses()[0].state, 'online');
    assert.equal((await tool(h.ctx, 'task_alerts', { includeResolved: true })).value[0].status, 'resolved');
    assert.equal(h.adapter.requests.length, 0);
  } finally { await h.dispose(); }
});

test('independent native providers cannot execute the same leased attempt twice', async () => {
  const h = await harness({ script: [{ name: 'task_submit_result', args: { outcome: 'success', summary: 'One durable execution owner' } }] });
  const { NativeExecutionProvider } = await import(pluginUrl);
  const duplicate = new NativeExecutionProvider(h.ctx, h.ctx.taskSystem);
  try {
    const { claim } = seed(h);
    const first = h.ctx.taskSystem.native.execute(claim);
    await assert.rejects(duplicate.execute(claim), /execution|owner/i);
    const result = await first;
    assert.equal(result.run.state, 'succeeded');
    assert.equal(h.adapter.requests.length, 1, 'losing owner cannot create model or workload effects');
    assert.ok(h.ledger.getAttempt(claim.attempt.attemptId).executionId);
    assert.equal(h.ledger.history(claim.task.taskId).events.filter(event => event.type === 'run.settled').length, 1, 'losing owner cannot settle uncertainty for the winner');
  } finally { await duplicate.dispose(); await h.dispose(); }
});

test('unowned tool calls cannot submit results and planner role blocks execution in tool guard and service', async () => {
  const h = await harness({ role: 'planner', native: false });
  try {
    assert.equal(h.ctx.taskSystem.native, undefined);
    assert.throws(() => h.ctx.taskSystem.assertExecuting(), /planner/);
    const denied = await tool(h.ctx, 'task_claim', { commandId: 'bad', runId: 'absent' });
    assert.equal(denied.isError, true);
    assert.throws(() => h.ledger.claim('direct-bypass', { runId: 'absent', nodeId: 'local', ttlMs: 10000 }));
  } finally { await h.dispose(); }
  const execution = await harness();
  try {
    const denied = await tool(execution.ctx, 'task_submit_result', { outcome: 'success', summary: 'forged success' });
    assert.equal(denied.isError, true);
  } finally { await execution.dispose(); }
});

test('native provider disposal aborts and drains its owned agent without stopping host', async () => {
  const h = await harness({ script: ['hang'] });
  const { claim } = seed(h);
  const running = h.ctx.taskSystem.native.execute(claim);
  running.catch(() => undefined);
  await until(() => h.adapter.requests.length);
  await h.ctx.taskSystem.native.dispose();
  await assert.rejects(running, /interrupted/);
  assert.ok(h.ctx.tools, 'shared host tools remain alive');
  assert.equal(h.ctx.agents.get(h.ledger.getAttempt(claim.attempt.attemptId).sessionId), undefined);
  assert.equal(h.ledger.getRun(claim.run.runId).state, 'uncertain');
  await h.dispose();
});

test('real Loader unload removes tools and restart can recover durable state', async () => {
  const h = await harness({ native: false, role: 'planner' });
  const task = h.ledger.createTask('retained', { title: 'Persist through Loader removal' }).value;
  const fiber = h.ctx.loader.resolve('task').fiber;
  await fiber.dispose();
  assert.equal(h.ctx.get('taskSystem'), undefined);
  const missing = await tool(h.ctx, 'task_query', {});
  assert.equal(missing.isError, true);
  assert.ok(existsSync(join(h.dir, 'tasks.sqlite')));
  await h.dispose();
  const again = await harness({ dir: h.dir, role: 'planner', native: false });
  assert.equal(again.ledger.getTask(task.taskId).title, 'Persist through Loader removal');
  await again.dispose();
});

test('native resume restores the exact persisted session bound to an unexpired attempt', async () => {
  const first = await harness({ script: ['Earlier work was inspected'] });
  const { claim } = seed(first);
  const ref = { runId: claim.run.runId, attemptId: claim.attempt.attemptId, nodeId: 'local', fence: claim.attempt.fence };
  const sessionId = `task-${ref.attemptId}`;
  first.ledger.bindSession('resume-bind-fixture', { ...ref, sessionId });
  const handle = await first.ctx.agents.create({ sessionId: SessionId(sessionId), meta:{cwd:first.dir}, agentOptions: { provider: 'test-offline', model: 'script' } });
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Earlier persisted input' }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  await first.ctx.sessions.flush(handle.agent.session);
  await handle.dispose();
  await first.dispose();
  const resumed = await harness({ dir: first.dir, script: [{ name: 'task_submit_result', args: { outcome: 'success', summary: 'Reconciled existing session' } }] });
  try {
    const result = await resumed.ctx.taskSystem.native.resume({ task: resumed.ledger.getTask(claim.task.taskId), run: resumed.ledger.getRun(ref.runId), attempt: resumed.ledger.getAttempt(ref.attemptId) });
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.run.state, 'succeeded');
    assert.ok(JSON.stringify(resumed.adapter.requests[0].messages).includes('Earlier persisted input'));
  } finally { await resumed.dispose(); }
});

test('provider loss unloads native capability and provider return reactivates it', async () => {
  const h = await harness();
  try {
    await h.ctx.loader.resolve('agentLoop').fiber.dispose();
    await h.ctx.loader.await();
    assert.equal(h.ctx.taskSystem.native, undefined);
    assert.ok(h.ctx.tools.get('task_query'));
    h.ctx.loader.remove('agentLoop');
    await h.ctx.loader.create({ id: 'agentLoop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } });
    await h.ctx.loader.await();
    assert.ok(h.ctx.taskSystem.native);
  } finally { await h.dispose(); }
});

test('durable cancellation is acknowledged after the native agent actually stops', async () => {
  const h = await harness({ script: ['hang'] });
  const { task, claim } = seed(h);
  try {
    const running = h.ctx.taskSystem.native.execute(claim);
    running.catch(() => undefined);
    await until(() => h.adapter.requests.length);
    const cancelled = await tool(h.ctx, 'task_cancel', { commandId: 'cancel-running', taskId: task.taskId, reason: 'test cancellation' });
    assert.equal(cancelled.isError, false);
    await assert.rejects(running);
    assert.equal(h.ctx.agents.get(h.ledger.getAttempt(claim.attempt.attemptId).sessionId), undefined);
    assert.equal(h.ledger.getRun(claim.run.runId).state, 'cancelled');
  } finally { await h.dispose(); }
});

test('configured timer admits a scheduled slot and native autoExecute commits explicit output', async () => {
  const h = await harness({ config: { keepAlive: true, maintenanceIntervalMs: 100, autoExecute: true, maxConcurrent: 1 }, script: [{ name: 'task_submit_result', args: { outcome: 'success', summary: 'Scheduled custom report done', reportBody: 'A reusable configured task type ran through real DSH.', reportData: { itemsVerified: 3 }, reportSchemaId: 'custom-report-v1' } }] });
  try {
    h.ledger.registerNode('scheduled-node', { nodeId: 'local', roles: ['both'], capabilities: [], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    h.ledger.updateTemplate('scheduled-template', { templateId: 'custom-report', version: 1, name: 'Custom report', description: 'A configured report type', inputSchema: { type: 'object' }, defaults: {}, resultContract: { type: 'object', required: ['report'], properties: { report: { type: 'object', required: ['data', 'schemaId'], properties: { data: { type: 'object', required: ['itemsVerified'], properties: { itemsVerified: { type: 'integer', minimum: 1 } } }, schemaId: { const: 'custom-report-v1' } } } } } });
    const task = h.ledger.createTask('scheduled-task', { title: 'Timer-driven custom report' }).value;
    h.ledger.createSchedule('scheduled-schedule', { scheduleId: 'custom-daily', taskId: task.taskId, templateId: 'custom-report', templateVersion: 1, enabled: true, intervalMs: 60000, nextDueAt: new Date(Date.now() - 10).toISOString(), overlap: 'skip', input: {}, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] } });
    await until(() => h.ledger.history(task.taskId).runs.some(run => run.state === 'succeeded'));
    const history = h.ledger.history(task.taskId);
    assert.equal(history.runs.length, 1);
    assert.equal(history.runs[0].state, 'succeeded');
    assert.equal(h.ledger.getTask(task.taskId).state, 'ready', 'recurring task remains available for its next occurrence');
    assert.equal(history.reports.length, 1);
    assert.deepEqual(history.reports[0].data, { itemsVerified: 3 });
    assert.equal(history.reports[0].schemaId, 'custom-report-v1');
    const progress = await tool(h.ctx, 'task_report', { commandId: 'structured-progress', taskId: task.taskId, title: 'Additional detail', body: 'Structured reporting also works independently of settlement.', data: { reviewed: true }, schemaId: 'review-v1' });
    assert.equal(progress.isError, false);
    assert.deepEqual(progress.value.value.data, { reviewed: true });
    assert.equal(progress.value.value.schemaId, 'review-v1');
    assert.equal(history.runs[0].configuration.templateRef.templateId, 'custom-report');
  } finally { await h.dispose(); }
});

test('automatic native dispatch obeys maxConcurrent and leaves the next run queued', async () => {
  const h = await harness({ config: { autoExecute: true, maxConcurrent: 1 }, script: ['hang'] });
  try {
    h.ledger.registerNode('bound-node', { nodeId: 'local', roles: ['both'], capabilities: [], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const route = { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] };
    const a = h.ledger.createTask('bound-task-a', { title: 'First' }).value;
    const b = h.ledger.createTask('bound-task-b', { title: 'Second' }).value;
    const first = h.ledger.createRun('bound-run-a', { taskId: a.taskId, route }).value;
    const second = h.ledger.createRun('bound-run-b', { taskId: b.taskId, route }).value;
    h.ctx.taskSystem.tick();
    await until(() => h.adapter.requests.length);
    h.ctx.taskSystem.tick();
    assert.equal(h.ledger.getRun(first.runId).state, 'running');
    assert.equal(h.ledger.getRun(second.runId).state, 'queued');
    assert.equal(h.ctx.taskSystem.native.activeCount, 1);
  } finally { await h.dispose(); }
});

test('native confirmation gate cannot be bypassed by model task creation and blocks effects until trusted approval', async () => {
  const h = await harness({ config: { requireConfirmation: true, autoExecute: true }, script: [{ name: 'task_submit_result', args: { outcome: 'success', summary: 'Ran after operator approval' } }] });
  try {
    h.ledger.registerNode('approval-node', { nodeId: 'local', roles: ['both'], capabilities: [], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const created = await tool(h.ctx, 'task_create', { commandId: 'approval-task', title: 'Gated task', requiresConfirmation: false, priorityOverride: 'high' });
    assert.equal(created.isError, false);
    const task = created.value.value;
    assert.equal(task.confirmation.required, true, 'configured global gate overrides model request');
    assert.equal(task.confirmation.state, 'pending');
    assert.equal(task.priority, 'high'); assert.equal(task.userImmediacy, undefined);
    const run = h.ledger.createRun('approval-run', { taskId: task.taskId, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] } }).value;
    h.ctx.taskSystem.tick();
    const denied = await tool(h.ctx, 'task_execute', { commandId: 'approval-execute-denied', runId: run.runId });
    assert.equal(denied.isError, true);
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(h.ledger.getRun(run.runId).state, 'queued');
    assert.equal(h.ctx.tools.get('task_approve'), undefined, 'approval is never a model tool');
    h.ledger.setTaskConfirmation('operator-approves', { taskId: task.taskId, expectedRevision: h.ledger.getTask(task.taskId).confirmation.revision, approved: true, actor: 'offline-test-operator', reason: 'Explicit synthetic approval' });
    h.ctx.taskSystem.tick();
    await until(() => h.ledger.getRun(run.runId).state === 'succeeded');
    assert.equal(h.adapter.requests.length, 1);
  } finally { await h.dispose(); }
});

test('native results enqueue only operator-configured reporting destinations and honor narrative policy', async () => {
  const h = await harness({ config: { reportDestinations: ['offline-authorized-destination'] }, script: ['summary', 'none', 'escalate'].map(mode => ({ name: 'task_submit_result', args: { outcome: 'success', summary: `Finished ${mode}`, reportBody: `Authoritative report for ${mode}` } })) });
  try {
    h.ledger.registerNode('reporting-node', { nodeId: 'local', roles: ['both'], capabilities: [], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    for (const reporting of ['summary', 'none', 'escalate']) {
      const task = h.ledger.createTask(`reporting-task-${reporting}`, { title: `Reporting ${reporting}` }).value;
      const run = h.ledger.createRun(`reporting-run-${reporting}`, { taskId: task.taskId, configuration: { reporting }, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] } }).value;
      const claim = h.ledger.claim(`reporting-claim-${reporting}`, { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
      await h.ctx.taskSystem.native.execute(claim);
      const deliveries = h.ledger.deliveries().filter(delivery => delivery.taskId === task.taskId);
      assert.equal(deliveries.length, reporting === 'none' ? 0 : 1);
      if (reporting !== 'none') {
        assert.equal(deliveries[0].destination, 'offline-authorized-destination');
        assert.equal(deliveries[0].kind, 'report');
        assert.equal(deliveries[0].state, 'pending', 'native execution does not perform live channel delivery');
        assert.equal(deliveries[0].reportId, h.ledger.history(task.taskId).reports[0].reportId);
        assert.equal(deliveries[0].payload.reporting, reporting);
      }
    }
    assert.equal(h.ledger.deliveries().length, 2);
  } finally { await h.dispose(); }
});

test('native curation is reversible, preserves history, and remains forbidden to owned execution and executor profiles', async () => {
  const h = await harness({ config: { executionTools: ['task_curate'], trustedUnconfinedTools: true }, script: ['hang'] });
  try {
    const task = h.ledger.createTask('curated-task', { title: 'Reviewable legacy task admission' }).value;
    task.admissionState = 'admitted'; task.admissionRevision = 1; h.ledger.managementDatabase().prepare("UPDATE entities SET data=? WHERE kind='task' AND id=?").run(JSON.stringify(task),task.taskId);
    const dismissed = await tool(h.ctx, 'task_curate', { commandId: 'dismiss-task', taskId: task.taskId, state: 'dismissed', expectedRevision: task.admissionRevision, reason: 'Not currently an actionable task' });
    assert.equal(dismissed.isError, false);
    assert.equal(h.ledger.getTask(task.taskId).state, task.state, 'curation does not rewrite lifecycle state');
    assert.equal((await tool(h.ctx, 'task_query', {})).value.tasks.length, 0);
    assert.equal((await tool(h.ctx, 'task_query', { includeDismissed: true })).value.tasks.length, 1);
    await tool(h.ctx, 'task_report', { commandId: 'dismissed-report', taskId: task.taskId, title: 'Later evidence', body: 'New evidence preserves the explicit admission decision.' });
    assert.equal(h.ledger.getTask(task.taskId).admissionState, 'dismissed');
    assert.equal(h.ledger.history(task.taskId).reports.length, 1);
    const restored = await tool(h.ctx, 'task_curate', { commandId: 'restore-task', taskId: task.taskId, state: 'admitted', expectedRevision: h.ledger.getTask(task.taskId).admissionRevision, reason: 'Explicitly return to task views' });
    assert.equal(restored.isError, false);
    assert.equal((await tool(h.ctx, 'task_query', {})).value.tasks.length, 1);
    const { claim } = seed(h);
    const running = h.ctx.taskSystem.native.execute(claim);
    running.catch(() => undefined);
    await until(() => h.adapter.requests.length === 1);
    const agent = h.ctx.agents.get(h.ledger.getAttempt(claim.attempt.attemptId).sessionId);
    const denied = await tool(h.ctx, 'task_curate', { commandId: 'owned-curation', taskId: claim.task.taskId, state: 'dismissed', expectedRevision: h.ledger.getTask(claim.task.taskId).admissionRevision, reason: 'Forbidden self-curation' }, agent);
    assert.equal(denied.isError, true);
    assert.equal(h.ledger.getTask(claim.task.taskId).admissionState, undefined);
  } finally { await h.dispose(); }
  const executor = await harness({ role: 'executor' });
  try { assert.equal(executor.ctx.tools.get('task_curate'), undefined); }
  finally { await executor.dispose(); }
});

test('malformed structured native result records retryable failure and bounded diagnostic without raw data', async () => {
  const h = await harness({ script: [{ name: 'task_submit_result', args: { outcome: 'success', summary: 'Claimed success', reportData: { wrongField: 'sensitive-provider-detail' }, reportSchemaId: 'strict-v1' } }] });
  try {
    h.ledger.registerNode('strict-node', { nodeId: 'local', roles: ['both'], capabilities: [], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const template = { templateId: 'strict', version: 1, name: 'Strict structured result', description: '', inputSchema: { type: 'object' }, defaults: {}, resultContract: { type: 'object', required: ['report'], properties: { report: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['itemsVerified'], properties: { itemsVerified: { type: 'integer' } } } } } } } };
    h.ledger.updateTemplate('strict-template', template);
    const task = h.ledger.createTask('strict-task', { title: 'Validate structured result' }).value;
    const run = h.ledger.createRun('strict-run', { taskId: task.taskId, configuration: { template, input: {} }, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] } }).value;
    const claim = h.ledger.claim('strict-claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    await h.ctx.taskSystem.native.execute(claim);
    const settled = h.ledger.getRun(run.runId);
    assert.equal(settled.state, 'failed');
    assert.equal(settled.resultValidationFailure.code, 'SCHEMA_VALIDATION');
    assert.equal(settled.validation, undefined);
    const history = h.ledger.history(task.taskId);
    assert.equal(history.reports.length, 1);
    assert.equal(history.reports[0].schemaId, 'execution-diagnostic.v1');
    const settlement = history.events.find(event => event.type === 'run.settled');
    assert.match(settlement.detail.summary, /报告校验未通过：SCHEMA_VALIDATION/);
    assert.ok(!JSON.stringify(history).includes('sensitive-provider-detail'));
    assert.equal(h.ctx.taskSystem.native.activeCount, 0);
  } finally { await h.dispose(); }
});

test('missing required report is rejected before ending the attempt and can be corrected in place', async () => {
  const h = await harness({ script: [{ name: 'task_submit_result', args: { outcome: 'partial', summary: 'Still processing evidence' } }, options => { const error = options.messages.findLast(m => m.role === 'tool'); assert.equal(error.isError, true); assert.match(JSON.stringify(error.content), /This attempt remains active/); return { name: 'task_submit_result', args: { outcome: 'success', summary: 'Full report prepared', reportData: { itemsVerified: 44 }, reportSchemaId: 'strict-v1' } }; }] });
  try {
    h.ledger.registerNode('strict-node', { nodeId: 'local', roles: ['both'], capabilities: [], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const template = { templateId: 'strict', version: 1, name: 'Strict structured result', description: '', inputSchema: { type: 'object' }, defaults: {}, resultContract: { type: 'object', required: ['report'], properties: { report: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['itemsVerified'], properties: { itemsVerified: { type: 'integer' } } } } } } } };
    h.ledger.updateTemplate('strict-template', template);
    const task = h.ledger.createTask('strict-task', { title: 'Validate structured result' }).value;
    const run = h.ledger.createRun('strict-run', { taskId: task.taskId, configuration: { template, input: {} }, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] } }).value;
    const claim = h.ledger.claim('strict-claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    await h.ctx.taskSystem.native.execute(claim);
    const settled = h.ledger.getRun(run.runId);
    assert.equal(settled.state, 'succeeded');
    assert.equal(settled.resultValidationFailure, undefined);
    assert.equal(h.adapter.requests.length, 2);
    const history = h.ledger.history(task.taskId);
    assert.equal(history.runs.length, 1);
    assert.equal(history.reports.filter(r => r.kind === 'result').length, 1);
    assert.equal(history.reports.find(r => r.kind === 'result').data.itemsVerified, 44);
    assert.equal(h.ctx.taskSystem.native.activeCount, 0);
  } finally { await h.dispose(); }
});

test('trusted semantic validation rejects shape-valid native success with retry feedback', async () => {
  const h = await harness({ script: [{ name: 'task_submit_result', args: { outcome: 'success', summary: 'Claimed all items verified', reportData: { items: ['one'], count: 2 } } }] });
  let checked = 0;
  try {
    h.ledger.registerNode('semantic-node', { nodeId: 'local', roles: ['both'], capabilities: [], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const dispose = h.ledger.registerResultValidator('count-equals-items-v1', ({ submission, attempt }) => {
      checked++;
      assert.ok(attempt.executionId);
      return { valid: submission.report.data.count === submission.report.data.items.length };
    });
    const template = { templateId: 'semantic', version: 1, name: 'Semantically checked report', description: '', inputSchema: { type: 'object' }, defaults: {}, resultValidator: 'count-equals-items-v1', resultContract: { type: 'object', required: ['report'], properties: { report: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['items', 'count'], properties: { items: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' } } } } } } } };
    const task = h.ledger.createTask('semantic-task', { title: 'Semantic native result rejection' }).value;
    const run = h.ledger.createRun('semantic-run', { taskId: task.taskId, configuration: { template, input: {} }, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] } }).value;
    const claim = h.ledger.claim('semantic-claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    await h.ctx.taskSystem.native.execute(claim);
    assert.equal(checked, 1, 'valid JSON shape alone does not establish semantic success');
    assert.equal(h.ledger.getRun(run.runId).state, 'failed');
    assert.equal(h.ledger.getRun(run.runId).resultValidationFailure.code, 'RESULT_VALIDATION');
    assert.equal(h.ledger.getRun(run.runId).validation, undefined);
    assert.equal(h.ledger.history(task.taskId).reports.filter(r=>r.kind==='result').length, 0);
    assert.equal(h.adapter.requests.length, 1);
    dispose();
  } finally { await h.dispose(); }
});

test('maintained legacy task-pack mounts through real Loader and missing validator after unload fails closed', async () => {
  const errorResult = { name: 'task_submit_result', args: { outcome: 'blocked', summary: 'Source evidence unavailable', reportTitle: 'Report blocked', reportBody: 'Offline fixture has no source evidence.', reportSchemaId: 'legacy_task_pack_error.v1', reportData: { errors: ['Offline fixture has no source evidence.'] } } };
  const h = await harness({ script: [errorResult, errorResult] });
  try {
    const { createLegacyTemplates } = await import('../../examples/legacy-task-pack/index.mjs');
    await h.ctx.loader.create({ id: 'legacy-task-pack', name: pathToFileURL(resolve('examples/legacy-task-pack/plugin.mjs')).href, config: {} });
    await h.ctx.loader.await();
    assert.equal(h.ctx.get('feishuChannel'), undefined, 'semantic validators do not require a live channel');
    await h.ctx.loader.create({ id: 'offline-pack-channel', name: pathToFileURL(resolve('packages/feishu-channel/dist/dsh-plugin.js')).href, config: { enabled: false } });
    await h.ctx.loader.await();
    assert.equal(h.ctx.feishuChannel.inspect().enabled, false);
    assert.ok(h.ctx.feishuChannel.inspect().rendererSchemaIds.includes('agent_daily_report.v1'), 'optional renderer registration activates through the actual service dependency');
    const template = createLegacyTemplates().find(item => item.templateId === 'legacy-agent-daily-node');
    assert.ok(template);
    h.ledger.registerNode('legacy-pack-node', { nodeId: 'local', roles: ['both'], capabilities: [], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const invoke = suffix => {
      const task = h.ledger.createTask(`legacy-pack-task-${suffix}`, { title: `Legacy host extension ${suffix}` }).value;
      const run = h.ledger.createRun(`legacy-pack-run-${suffix}`, { taskId: task.taskId, configuration: { template, input: { sourceIds: ['offline-fixture'], windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-01T01:00:00Z' } }, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] } }).value;
      return h.ledger.claim(`legacy-pack-claim-${suffix}`, { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    };
    const mounted = invoke('mounted');
    const first = await h.ctx.taskSystem.native.execute(mounted);
    assert.equal(first.run.state, 'blocked');
    assert.equal(first.run.validation, undefined);
    assert.equal(h.ledger.history(mounted.task.taskId).reports[0].schemaId, 'legacy_task_pack_error.v1');
    await h.ctx.loader.resolve('legacy-task-pack').fiber.dispose();
    await h.ctx.loader.await();
    assert.deepEqual(h.ctx.feishuChannel.inspect().rendererSchemaIds, [], 'unloading task pack removes cross-plugin renderer registrations');
    const unmounted = invoke('unmounted');
    await assert.rejects(h.ctx.taskSystem.native.execute(unmounted), { code: 'VALIDATOR_UNAVAILABLE' });
    assert.equal(h.ledger.getRun(unmounted.run.runId).state, 'uncertain');
    assert.equal(h.ledger.getRun(unmounted.run.runId).validation, undefined);
    assert.equal(h.ledger.history(unmounted.task.taskId).reports.length, 0);
  } finally { await h.dispose(); }
});

test('actual native legacy preparation creates a bound artifact then task_submit_result commits after quiescence', async () => {
  const h = await harness({ config: { executionTools: ['legacy_report_prepare'], trustedUnconfinedTools: true } });
  try {
    const { createLegacyTemplates } = await import('../../examples/legacy-task-pack/index.mjs');
    const { dailyInput, WINDOW } = await import('../legacy/synthetic-fixtures.mjs');
    const artifactDirectory = join(h.dir, 'reviewed-report-artifacts');
    await h.ctx.loader.create({ id: 'native-legacy-pack', name: pathToFileURL(resolve('examples/legacy-task-pack/plugin.mjs')).href, config: { artifactDirectory } });
    await h.ctx.loader.await();
    const template = createLegacyTemplates().find(item => item.defaults.kind === 'agent_daily');
    h.ledger.registerNode('native-legacy-node', { nodeId: 'local', roles: ['both'], capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const task = h.ledger.createTask('native-legacy-task', { title: 'Synthetic daily report through native tools' }).value;
    const run = h.ledger.createRun('native-legacy-run', { taskId: task.taskId, configuration: { template, input: { sourceIds: ['synthetic-fixture'], windowStart: WINDOW.start, windowEnd: WINDOW.end } }, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: ['legacy.task-pack.v1'] } }).value;
    h.adapter.script.push(
      { name: 'legacy_report_prepare', args: { commandId: 'native-prepare-artifact', kind: 'agent_daily', input: dailyInput(task.taskId, run.runId) } },
      options => {
        const result = options.messages.findLast(message => message.role === 'tool');
        assert.ok(result, 'next model call receives the real native tool result');
        assert.equal(result.isError, false, JSON.stringify(result.content));
        const prepared = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
        assert.equal(h.ledger.getRun(run.runId).state, 'running', 'prepare must not settle inside a running agent');
        assert.equal(h.ledger.history(task.taskId).reports.length, 0);
        assert.equal(prepared.report.artifactIds.length, 1);
        return { name: 'task_submit_result', args: { outcome: 'success', summary: prepared.summary, reportTitle: prepared.report.title, reportBody: prepared.report.body, reportData: prepared.report.data, reportSchemaId: prepared.report.schemaId, reportArtifactIds: prepared.report.artifactIds } };
      },
    );
    const claim = h.ledger.claim('native-legacy-claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    const result = await h.ctx.taskSystem.native.execute(claim);
    assert.equal(result.run.state, 'succeeded');
    assert.equal(result.run.validation, undefined);
    assert.equal(h.ctx.agents.get(result.sessionId), undefined);
    const history = h.ledger.history(task.taskId);
    assert.equal(history.reports[0].schemaId, 'agent_daily_report.v1');
    assert.equal(history.reports[0].data.payload.summary.task_counts.total, 2);
    assert.equal(history.artifacts.length, 1);
    assert.ok(history.artifacts[0].uri.startsWith(realpathSync(artifactDirectory)));
    assert.equal(createHash('sha256').update(readFileSync(history.artifacts[0].uri)).digest('hex'), history.artifacts[0].sha256);
  } finally { await h.dispose(); }
});

test('actual native configured readers bind source evidence to one attempt before game report preparation', async () => {
  const h = await harness({ config: { executionTools: ['legacy_sources_read', 'legacy_report_prepare'], trustedUnconfinedTools: true } });
  let sourceReceiptId;
  try {
    const { createLegacyTemplates } = await import('../../examples/legacy-task-pack/index.mjs');
    await h.ctx.loader.create({ id: 'reader-legacy-pack', name: pathToFileURL(resolve('examples/legacy-task-pack/plugin.mjs')).href, config: { timeZone: 'UTC', automationIds: ['custom-example'], nodeAliases: { local: 'synthetic-node' }, sourceRegistry: [{ id: 'synthetic-source', root: resolve('examples/legacy-task-pack/readers/fixtures'), manifest: 'manifest.json' }] } });
    await h.ctx.loader.await();
    h.ledger.registerNode('native-reader-node', { nodeId: 'local', roles: ['both'], capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const template = createLegacyTemplates().find(item => item.defaults.kind === 'game_daily');
    const make = suffix => {
      const task = h.ledger.createTask(`native-reader-task-${suffix}`, { title: `Configured source fixture ${suffix}` }).value;
      const run = h.ledger.createRun(`native-reader-run-${suffix}`, { taskId: task.taskId, configuration: { template, input: { sourceIds: ['synthetic-source'], windowStart: '2026-09-15T00:00:00Z', windowEnd: '2026-09-16T00:00:00Z' } }, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: ['legacy.task-pack.v1'] } }).value;
      return h.ledger.claim(`native-reader-claim-${suffix}`, { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    };
    const toolValue = options => {
      const result = options.messages.findLast(message => message.role === 'tool');
      assert.equal(result?.isError, false, JSON.stringify(result?.content));
      return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    };
    h.adapter.script.push(
      { name: 'legacy_sources_read', args: { sourceIds: ['unapproved-source'] } },
      options => { assert.equal(options.messages.findLast(message => message.role === 'tool').isError, true); return { name: 'legacy_sources_read', args: { sourceIds: ['synthetic-source'] } }; },
      options => { const source = toolValue(options); sourceReceiptId = source.sourceReceiptId; assert.equal(source.sources[0].sourceId, 'synthetic-source'); assert.ok(source.sources[0].data.game); return { name: 'legacy_report_prepare', args: { commandId: 'prepare-reader-game', kind: 'game_daily', input: { sourceReceiptId, sourceId: 'synthetic-source' } } }; },
      options => { const prepared = toolValue(options); assert.deepEqual(prepared.report.artifactIds, []); return { name: 'task_submit_result', args: { outcome: 'success', summary: prepared.summary, reportTitle: prepared.report.title, reportBody: prepared.report.body, reportData: prepared.report.data, reportSchemaId: prepared.report.schemaId } }; },
    );
    const first = make('first');
    assert.equal((await h.ctx.taskSystem.native.execute(first)).run.state, 'succeeded');
    const report = h.ledger.history(first.task.taskId).reports[0];
    assert.equal(report.schemaId, 'game_daily_report.v1');
    assert.equal(report.data.payload.report_meta.device_id, 'synthetic-node');
    h.adapter.script.push(
      { name: 'legacy_report_prepare', args: { commandId: 'forbidden-old-source-receipt', kind: 'game_daily', input: { sourceReceiptId, sourceId: 'synthetic-source' } } },
      options => { assert.equal(options.messages.findLast(message => message.role === 'tool').isError, true); return { name: 'task_submit_result', args: { outcome: 'blocked', summary: 'Cannot reuse another attempt source receipt', reportSchemaId: 'legacy_task_pack_error.v1', reportData: { errors: ['Fresh source capture required for this attempt.'] } } }; },
    );
    const second = make('second');
    assert.equal((await h.ctx.taskSystem.native.execute(second)).run.state, 'blocked');
    assert.equal(h.ledger.history(second.task.taskId).reports[0].schemaId, 'legacy_task_pack_error.v1');
  } finally { await h.dispose(); }
});

test('task tool policy remains enforced but legacy runtime budgets never stop an active task', async () => {
  const h = await harness({ config: { executionTools: ['fixture_work'] }, script: [{ name: 'fixture_work', args: {} }, { name: 'task_submit_result', args: { outcome: 'success', summary: 'Forbidden capability was denied' } }] });
  let effects = 0;
  h.ctx.tools.register(defineTool({ name: 'fixture_work', description: 'Test-only observable effect', parameters: {}, output: { schema: { type: 'json' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => { effects++; return true; } }));
  try {
    const { claim } = seed(h, '', { policy: { allowedTools: [] } });
    assert.equal((await h.ctx.taskSystem.native.execute(claim)).run.state, 'succeeded');
    assert.equal(effects, 0, 'node configuration cannot override a narrower task capability policy');
  } finally { await h.dispose(); }
  const bounded = await harness({ config: {executionTimeoutMs: 100}, script: ['hang'] });
  try {
    const { claim } = seed(bounded, '', { policy: { maxRuntimeMs: 100 } });
    const pending = assert.rejects(bounded.ctx.taskSystem.native.execute(claim), /interrupted/);
    await until(() => bounded.adapter.requests.length === 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(bounded.ctx.taskSystem.native.activeCount, 1);
    assert.equal(bounded.ledger.getRun(claim.run.runId).state, 'running');
    await bounded.ctx.taskSystem.native.dispose();
    await pending;
    assert.equal(bounded.ledger.getRun(claim.run.runId).state, 'uncertain');
    assert.equal(bounded.ctx.agents.get(bounded.ledger.getAttempt(claim.attempt.attemptId).sessionId), undefined);
  } finally { await bounded.dispose(); }
});

test('executor task_schedule mutations are denied by real tool execution without writes', async () => {
  const h = await harness({ role: 'executor' });
  try {
    for (const action of ['template', 'create', 'enable']) {
      const result = await tool(h.ctx, 'task_schedule', { commandId: `forbidden-${action}`, action, value: {} });
      assert.equal(result.isError, true);
      assert.match(result.error.message, /only inspect due schedules/);
    }
    assert.equal(h.ledger.snapshot().templates.length, 0);
    assert.equal((await tool(h.ctx, 'task_schedule', { commandId: 'read-due', action: 'due' })).isError, false);
  } finally { await h.dispose(); }
});

test('owned query/history/report tools cannot read or alter another task', async () => {
  const h = await harness();
  try {
    const other = h.ledger.createTask('other-task', { taskId: 'other-task', title: 'Unrelated confidential task title' }).value;
    const foreignPath = join(h.dir, 'foreign-artifact.txt');
    const foreignBytes = Buffer.from('foreign report evidence');
    writeFileSync(foreignPath, foreignBytes);
    h.ledger.registerArtifact('foreign-artifact-registration', { artifactId: 'foreign-artifact', taskId: other.taskId, name: 'foreign.txt', mediaType: 'text/plain', uri: foreignPath, sha256: createHash('sha256').update(foreignBytes).digest('hex'), bytes: foreignBytes.length, finalized: true });
    h.adapter.script.push(
      { name: 'task_query', args: {} },
      { name: 'task_history', args: { taskId: other.taskId } },
      { name: 'task_report', args: { commandId: 'cross-task', taskId: other.taskId, title: 'forged', body: 'wrong task' } },
      { name: 'task_submit_result', args: { outcome: 'success', summary: 'Forbidden foreign artifact', reportArtifactIds: ['foreign-artifact'] } },
      { name: 'task_submit_result', args: { outcome: 'success', summary: 'Forbidden oversized artifact list', reportArtifactIds: Array.from({ length: 33 }, (_, index) => `artifact-${index}`) } },
      { name: 'task_submit_result', args: { outcome: 'success', summary: 'Scope isolation verified' } },
    );
    const { claim } = seed(h);
    await h.ctx.taskSystem.native.execute(claim);
    assert.equal(h.ledger.history(other.taskId).reports.length, 0);
    assert.ok(!JSON.stringify(h.adapter.requests).includes('Unrelated confidential task title'));
  } finally { await h.dispose(); }
});

test('native observer captures human session output as a candidate and never dispatches observed work', async () => {
  const h = await harness({ config: { observationEnabled: true }, script: ['Human-visible work result', { name: 'task_submit_result', args: { outcome: 'success', summary: 'Owned result' } }] });
  try {
    const handle = await h.ctx.agents.create({ sessionId: SessionId('observed-human-session'), meta: { cwd: h.dir }, agentOptions: { provider: 'test-offline', model: 'script' } });
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Summarize this human request' }] }));
    await handle.agent.whenIdle();
    assert.equal(h.ledger.snapshot().tasks.length, 0);
    const candidates = h.ledger.observationCandidates('pending');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].body, 'Human-visible work result');
    assert.equal(candidates[0].cwd, h.dir, 'source directory comes from immutable native session metadata');
    const admitted = await tool(h.ctx, 'task_observations', { action: 'create', commandId: 'admit-native', candidateId: candidates[0].candidateId });
    assert.equal(admitted.isError, false);
    assert.equal(h.ledger.snapshot().runs.length, 0);
    assert.throws(() => h.ledger.createRun('never-dispatch-observed', { taskId: admitted.value.value.taskId }), /Observed work cannot be dispatched/);
    const { claim } = seed(h);
    await h.ctx.taskSystem.native.execute(claim);
    assert.equal(h.ledger.observationCandidates().length, 1, 'owned task output is not rediscovered as outside work');
    await handle.dispose();
  } finally { await h.dispose(); }
});

test('native projection catches up resumed sessions within bounds and records omitted history', async () => {
  const initial = await harness({ script: ['First visible result', 'Second visible result', 'Third visible result'] });
  const sessionId = SessionId('bounded-catchup-session');
  const handle = await initial.ctx.agents.create({ sessionId, agentOptions: { provider: 'test-offline', model: 'script' } });
  for (let i = 0; i < 3; i++) {
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `human input ${i}` }] }));
    await handle.agent.whenIdle();
  }
  await initial.ctx.sessions.flush(handle.agent.session);
  await handle.dispose(); await initial.dispose();
  const h = await harness({ dir: initial.dir, config: { observationEnabled: true, observationMaxMessages: 2 } });
  try {
    const restored = await h.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'test-offline', model: 'script' } });
    assert.equal(h.ledger.observationCandidates().length, 2);
    assert.ok(h.ledger.snapshot().events.some(event => event.type === 'observation.catchup_gap' && event.detail.dropped === 1));
    assert.equal(h.ledger.snapshot().tasks.length, 0);
    await restored.dispose();
  } finally { await h.dispose(); }
});

test('native observation replay preserves historical candidates without newly inferred workspace authority', async () => {
  const first = await harness({ script: ['Previously clipped observation with additional text'] });
  let assistantEvent;
  first.ctx.on('session/event', (_session, event) => { if (event.type === 'assistant/message') assistantEvent = event; });
  const sessionId = SessionId('legacy-observation-metadata');
  const handle = await first.ctx.agents.create({ sessionId, meta: { cwd: first.dir }, agentOptions: { provider: 'test-offline', model: 'script' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'An existing session' }] }));
  await handle.agent.whenIdle();
  await first.ctx.sessions.flush(handle.agent.session);
  first.ledger.captureObservation('legacy-capture', { seq: assistantEvent.seq, sessionId, sourceId: `dsh-session:${sessionId}`, sourceRevision: String(assistantEvent.seq), title: 'Previously clipped observation', body: 'Previously clipped observation', observedAt: new Date(assistantEvent.time).toISOString(), truncated: true });
  await handle.dispose(); await first.dispose();
  const resumed = await harness({ dir: first.dir, config: { observationEnabled: true } });
  try {
    const restored = await resumed.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'test-offline', model: 'script' } });
    const candidates = resumed.ledger.observationCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].body, 'Previously clipped observation');
    assert.equal(candidates[0].cwd, undefined, 'replay cannot invent a new forwarding grant for historical text');
    await restored.dispose();
  } finally { await resumed.dispose(); }
});

test('explicit delegation tools create only descendants, inherit policy, and expose all-settled review', async () => {
  const h = await harness({ config: { executionTools: ['task_create', 'task_dispatch'], maxConcurrent: 2 }, script: ['hang'] });
  try {
    const { task, claim } = seed(h, '', { policy: { allowedTools: ['task_create', 'task_dispatch'], maxDepth: 1 } });
    h.ledger.registerNode('delegation-capacity', { ...h.ledger.getNode('local'), maxConcurrent: 2 });
    const other = h.ledger.createTask('unrelated', { title: 'Other task' }).value;
    const pending = h.ctx.taskSystem.native.execute(claim);
    pending.catch(() => undefined);
    await until(() => h.adapter.requests.length);
    const agent = h.ctx.agents.get(h.ledger.getAttempt(claim.attempt.attemptId).sessionId);
    const unrelated = await tool(h.ctx, 'task_dispatch', { commandId: 'forbidden-sibling', taskId: other.taskId }, agent);
    assert.equal(unrelated.isError, true);
    const childRun = await tool(h.ctx, 'task_dispatch', { commandId: 'child-run', title: 'Delegated child', route: claim.run.route }, agent);
    assert.equal(childRun.isError, false, JSON.stringify(childRun));
    const child = childRun.value.value.task;
    assert.equal(child.parentTaskId, task.taskId);
    assert.deepEqual(child.policy.allowedTools, task.policy.allowedTools);
    const waiting = await tool(h.ctx, 'task_wait', { taskId: task.taskId, quietMs: 0, timeoutMs: 0 }, agent);
    assert.equal(waiting.value.settled, false);
    assert.deepEqual(waiting.value.pendingRunIds, [childRun.value.value.run.runId]);
    const premature = await tool(h.ctx, 'task_submit_result', { outcome: 'success', summary: 'Too early' }, agent);
    assert.equal(premature.isError, true);
    h.ledger.cancel('cancel-child', { taskId: child.taskId, reason: 'Complete fixture by explicit cancellation' });
    const reviewed = await tool(h.ctx, 'task_history', { taskId: child.taskId }, agent);
    assert.equal(reviewed.isError, false);
    const waited = await tool(h.ctx, 'task_wait', { taskId: task.taskId, quietMs: 0, timeoutMs: 100 }, agent);
    assert.equal(waited.value.settled, true);
    await h.ctx.taskSystem.native.dispose();
    await assert.rejects(pending);
  } finally { await h.dispose(); }
});

test('resume continues a live lease even after its legacy runtime budget', async () => {
  const initial = await harness();
  const { claim } = seed(initial, '', { policy: { maxRuntimeMs: 100 } });
  const ref = { runId: claim.run.runId, attemptId: claim.attempt.attemptId, nodeId: 'local', fence: claim.attempt.fence };
  const sessionId = `task-${ref.attemptId}`;
  initial.ledger.bindSession('budget-resume-bind', { ...ref, sessionId });
  const handle = await initial.ctx.agents.create({ sessionId: SessionId(sessionId), meta:{cwd:initial.dir}, agentOptions: { provider: 'test-offline', model: 'script' } });
  await initial.ctx.sessions.flush(handle.agent.session);
  await handle.dispose(); await initial.dispose();
  await until(() => Date.now() - Date.parse(claim.attempt.createdAt) > 110);
  const h = await harness({ dir: initial.dir, script: [{name: 'task_submit_result', args: {outcome: 'success', summary: 'Continued beyond old budget'}}] });
  try {
    const restoredClaim = { task: h.ledger.getTask(claim.task.taskId), run: h.ledger.getRun(ref.runId), attempt: h.ledger.getAttempt(ref.attemptId) };
    const result = await h.ctx.taskSystem.native.resume(restoredClaim);
    assert.equal(result.run.state, 'succeeded');
    assert.equal(h.adapter.requests.length, 1);
    assert.equal(h.ctx.taskSystem.native.activeCount, 0);
    assert.equal(h.ctx.agents.get(sessionId), undefined);
  } finally { await h.dispose(); }
});

test('planning tool keeps a deterministic path before provider load and after unload', async () => {
  const h = await harness({ role: 'planner' });
  try {
    assert.ok(h.ctx.tools.get('task_plan'));
    const before = await tool(h.ctx, 'task_plan', { requestId: 'before-provider', title: 'Await assignment without a model' });
    assert.equal(before.isError, false); assert.equal(h.ledger.getDecision('before-provider').receipt.kind, 'deterministic-planning-v1');
    await h.ctx.loader.create({ id: 'decisions', name: pathToFileURL(resolve('packages/jev/lib/index.js')).href, config: {provider:'native',nativeProvider:'test-offline',model:'script'} });
    await h.ctx.loader.await();
    await until(() => h.ctx.tools.get('task_plan'));
    assert.ok(h.ctx.tools.get('task_plan'));
    const result = await tool(h.ctx, 'task_plan', { requestId: 'optional-plan', title: 'Inspect whether work should persist' });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(h.ledger.snapshot().tasks.length, 0);
    assert.ok(h.ledger.getDecision('optional-plan'));
    await h.ctx.loader.resolve('decisions').fiber.dispose();
    await h.ctx.loader.await();
    assert.ok(h.ctx.tools.get('task_plan'));
    const after = await tool(h.ctx, 'task_plan', { requestId: 'after-provider', title: 'Still available without a model' });
    assert.equal(after.isError, false); assert.equal(h.ledger.getDecision('after-provider').receipt.kind, 'deterministic-planning-v1');
  } finally { await h.dispose(); }
});

test('actual DSH file tools reject traversal, outside absolute paths, symlinks and escalation; shell stays withheld', async () => {
  const h = await harness({ config: { executionTools: ['read', 'write', 'bash'] }, script: ['hang'] });
  try {
    const workspace = join(h.dir, 'assigned'); mkdirSync(workspace);
    const outside = join(h.dir, 'outside.txt'); writeFileSync(outside, 'OUTSIDE SECRET');
    writeFileSync(join(workspace, 'inside.txt'), 'Inside allowed data');
    symlinkSync(outside, join(workspace, 'escape.txt'));
    symlinkSync(join(h.dir, 'not-created.txt'), join(workspace, 'dangling.txt'));
    await h.ctx.loader.create({ id: 'fs', name: '@deepseek-ai/dsh-fs-local', config: { cwd: workspace } });
    await h.ctx.loader.create({ id: 'working-directory', name: '@deepseek-ai/dsh-working-directory', config: {} });
    await h.ctx.loader.create({ id: 'file-tools', name: '@deepseek-ai/dsh-tool-fs', config: {} });
    await h.ctx.loader.await();
    let shellEffects = 0;
    h.ctx.tools.register(defineTool({ name: 'bash', description: 'A shell-shaped fixture which must never run', parameters: { command: { type: 'string', required: true } }, output: { schema: { type: 'json' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async () => { shellEffects++; return true; } }));
    h.ledger.registerWorkspace('file-workspace', { workspaceId: 'workspace', nodeId: 'local', path: workspace, label: 'Assigned root', state: 'ready', createdAt: new Date().toISOString() });
    const { claim } = seed(h, '', { workspaceId: 'workspace' });
    const running = h.ctx.taskSystem.native.execute(claim); running.catch(() => undefined);
    await until(() => h.adapter.requests.length);
    const agent = h.ctx.agents.get(h.ledger.getAttempt(claim.attempt.attemptId).sessionId);
    const inside = await tool(h.ctx, 'read', { file_path: 'inside.txt' }, agent);
    assert.equal(inside.isError, false, JSON.stringify(inside));
    assert.ok(JSON.stringify(inside).includes('Inside allowed data'));
    for (const file_path of ['../outside.txt', outside, 'escape.txt']) {
      const denied = await tool(h.ctx, 'read', { file_path }, agent);
      assert.equal(denied.isError, true);
      assert.ok(!JSON.stringify(denied).includes('OUTSIDE SECRET'));
    }
    assert.equal((await tool(h.ctx, 'write', { file_path: 'dangling.txt', content: 'forbidden' }, agent)).isError, true);
    assert.ok(!existsSync(join(h.dir, 'not-created.txt')));
    assert.equal((await tool(h.ctx, 'write', { file_path: 'inside.txt', content: 'forbidden', sandbox_permissions: 'danger-full-access' }, agent)).isError, true);
    assert.equal(readFileSync(join(workspace, 'inside.txt'), 'utf8'), 'Inside allowed data');
    assert.equal((await tool(h.ctx, 'bash', { command: 'cat /outside' }, agent)).isError, true);
    assert.equal(shellEffects, 0);
    await h.ctx.taskSystem.native.dispose(); await assert.rejects(running);
  } finally { await h.dispose(); }
});

test('configured physical roots allow operator provisioning and reject traversal and planner work', async () => {
  const root = join(scratch, 'provision-root'); mkdirSync(root);
  const config = { workspaceRoots: [{ id: 'approved', path: root, allowCreate: true }] };
  const h = await harness({ config, role: 'executor' });
  const request = { action: 'provision', commandId: 'provision-once', workspaceId: 'created-project', rootId: 'approved', relativePath: 'project', label: 'Created project', mode: 'create' };
  try {
    const first = await tool(h.ctx, 'task_workspace', request);
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.ok(existsSync(join(root, 'project/.dsh-task-workspace')));
    assert.equal((await tool(h.ctx, 'task_workspace', request)).isError, false);
    const denied = await tool(h.ctx, 'task_workspace', { ...request, commandId: 'escape', workspaceId: 'escape', relativePath: '../escape' });
    assert.equal(denied.isError, true);
  } finally { await h.dispose(); }
  const planner = await harness({ config, role: 'planner' });
  try { assert.equal((await tool(planner.ctx, 'task_workspace', { ...request, workspaceId: 'planner-project' })).isError, true); }
  finally { await planner.dispose(); }
});

test('trusted node bootstrap enables a local executor and unchanged restart preserves registration', async () => {
  const config = { localNode: { models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], capabilities: ['native-offline'], workspaceIds: [], enabled: true } };
  const first = await harness({ role: 'executor', config });
  const node = first.ledger.getNode('local');
  assert.deepEqual(node.roles, ['executor']);
  assert.equal(node.models[0].provider, 'test-offline');
  await first.dispose();
  const second = await harness({ role: 'executor', config, dir: first.dir });
  try { assert.deepEqual(second.ledger.getNode('local'), node); }
  finally { await second.dispose(); }
  const coordinator = await harness({ role: 'planner', native: false, config: { remoteNodes: [{ nodeId: 'remote', roles: ['executor'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], capabilities: [], workspaceIds: [], enabled: true }] } });
  try {
    assert.equal(coordinator.ledger.getNode('remote').nodeId, 'remote');
    assert.equal(coordinator.ctx.taskSystem.native, undefined);
  } finally { await coordinator.dispose(); }
});

test('optional automatic typed observation admission creates observe-only history once and never dispatches it', async () => {
  const config = { observationEnabled: true, autoAdmitObservations: true, maintenanceIntervalMs: 100 };
  const rules = Object.entries({ persist: 'create', attach: 'none', executor: 'none', modelEffort: 'none', workspace: 'none', reporting: 'none' }).map(([questionId, choice]) => ({ questionId, questionVersion: '1', path: ['state', 'request', 'mode'], equals: 'observe-existing-no-dispatch', answer: { type: 'choice', choice } }));
  const mountRules = async h => {
    h.ctx.llm.registerAdapter(['observation-offline'], new ScriptedModel([JSON.stringify({answers:{persist:{type:'choice',choice:'create'},reporting:{type:'choice',choice:'none'}}})]));
    await h.ctx.loader.create({ id: 'observation-decisions', name: pathToFileURL(resolve('packages/jev/lib/index.js')).href, config: {provider:'native',nativeProvider:'observation-offline',model:'script'} });
    await h.ctx.loader.await();
    await until(() => h.ctx.tools.get('task_plan'));
  };
  const first = await harness({ config, script: ['Finished outside the task manager'] });
  await mountRules(first);
  const handle = await first.ctx.agents.create({ sessionId: SessionId('automatic-observation'), agentOptions: { provider: 'test-offline', model: 'script' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'An ordinary user request' }] }));
  await handle.agent.whenIdle();
  await until(() => first.ledger.observationCandidates('admitted').length === 1);
  const candidate = first.ledger.observationCandidates('admitted')[0];
  assert.ok(first.ledger.getDecision(`observe:${candidate.candidateId}`));
  assert.equal(first.ledger.getTask(candidate.taskId).kind, 'observed');
  assert.equal(first.ledger.snapshot().runs.length, 0);
  await handle.dispose(); await first.dispose();
  const restarted = await harness({ dir: first.dir, config });
  try {
    await mountRules(restarted);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(restarted.ledger.snapshot().tasks.length, 1);
    assert.equal(restarted.ledger.snapshot().reports.length, 1);
    assert.equal(restarted.ledger.snapshot().runs.length, 0);
    assert.equal(restarted.adapter.requests.length, 0);
  } finally { await restarted.dispose(); }
});

test('cross-plugin observation subscriptions replay durable failures and stale disposal cannot detach replacements', async () => {
  const first = await harness({ config: { observationEnabled: true }, script: ['A durable observation for the coordinator'] });
  let failedCalls = 0;
  const fixture = first.ctx.plugin({ name: 'observation-sink-fixture', inject: ['taskSystem'], apply(consumerCtx) {
    const detach = consumerCtx.taskSystem.subscribeObservations(async candidate => {
      assert.ok(first.ledger.observationCandidates().some(item => item.candidateId === candidate.candidateId), 'sink only runs after commit');
      failedCalls++;
      throw new Error('External transport unavailable');
    });
    consumerCtx.effect(() => detach);
  } });
  await fixture.await();
  const handle = await first.ctx.agents.create({ sessionId: SessionId('forwarded-native-observation'), agentOptions: { provider: 'test-offline', model: 'script' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ordinary host request' }] }));
  await handle.agent.whenIdle();
  await until(() => failedCalls === 1);
  assert.equal(first.ledger.observationCandidates('pending').length, 1);
  await handle.dispose(); await fixture.dispose(); await first.dispose();
  const restarted = await harness({ dir: first.dir, config: { observationEnabled: true } });
  let deliveries = 0;
  try {
    const old = restarted.ctx.taskSystem.subscribeObservations(async () => {});
    old();
    const replacement = restarted.ctx.plugin({ name: 'replacement-observation-sink', inject: ['taskSystem'], apply(consumerCtx) {
      const detach = consumerCtx.taskSystem.subscribeObservations(async candidate => {
        deliveries++;
        assert.equal(candidate.body, 'A durable observation for the coordinator');
      });
      old();
      consumerCtx.effect(() => detach);
    } });
    await replacement.await();
    await until(() => deliveries === 1);
    assert.throws(() => restarted.ctx.taskSystem.subscribeObservations(async () => {}), /already subscribed/);
    assert.equal(restarted.ledger.snapshot().tasks.length, 0);
    assert.equal(restarted.ledger.snapshot().runs.length, 0);
    await replacement.dispose();
    const candidate = restarted.ledger.observationCandidates('pending')[0];
    restarted.ledger.admitObservation('ignore-forwarding-candidate', { candidateId: candidate.candidateId, action: 'ignore' });
    let ignoredDeliveries = 0;
    const ignored = restarted.ctx.taskSystem.subscribeObservations(async () => { ignoredDeliveries++; });
    restarted.ctx.taskSystem.publishObservation(candidate);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(ignoredDeliveries, 0, 'stale pending receipt cannot forward an observation already ignored locally');
    ignored();
    const final = restarted.ctx.taskSystem.subscribeObservations(async () => {});
    final();
  } finally { await restarted.dispose(); }
});

test('observation sink cancellation drains before ledger close and local automatic admission rejects forwarding', async () => {
  const h = await harness({ config: { observationEnabled: true }, script: ['Shutdown-safe observation'] });
  let started = false, aborted = false;
  h.ctx.taskSystem.subscribeObservations(async (_candidate, { signal }) => {
    started = true;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      assert.equal(h.ledger.observationCandidates('pending').length, 1, 'database remains open through sink cancellation');
      aborted = true;
      reject(signal.reason);
    }, { once: true }));
  });
  const handle = await h.ctx.agents.create({ sessionId: SessionId('sink-shutdown'), agentOptions: { provider: 'test-offline', model: 'script' } });
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ordinary host request' }] }));
  await handle.agent.whenIdle();
  await until(() => started);
  await handle.dispose(); await h.dispose();
  assert.equal(aborted, true);
  const authority = await harness({ config: { autoAdmitObservations: true } });
  try { assert.throws(() => authority.ctx.taskSystem.subscribeObservations(async () => {}), /conflicts with local automatic admission/); }
  finally { await authority.dispose(); }
});

async function mountApprovalFixture(h, options = {}) {
  await h.ctx.loader.create({ id: 'sdk-approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'ask' } });
  await h.ctx.loader.create({ id: 'approval-bridge', name: pathToFileURL(resolve('packages/task-system/dist/approval-bridge.js')).href, config: { enabled: true, reviewableTools: [{ toolName: 'fixture_approval', argumentKeys: ['operation'] }], timeoutMs: 5000, pollIntervalMs: 20, ...options } });
  await h.ctx.loader.await();
  const state = { effects: 0, decisions: [] };
  h.ctx.on('session/event', (_session, event) => { if (event.type === 'approval/decided') state.decisions.push(event.data.outcome); });
  const fixture = h.ctx.plugin({ name: 'native-approval-fixture', inject: ['approval', 'tools'], apply(ctx) {
    ctx.tools.register(defineTool({ name: 'fixture_approval', description: 'One bounded fixture effect requiring host approval', parameters: { operation: { type: 'string', required: true } }, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, exec) => {
      const decision = await ctx.approval.request({ agent: exec.agent, toolName: 'fixture_approval', callId: exec.callId, reason: 'Confirm this fixture operation once', signal: exec.signal });
      if (decision !== 'allowed-once') return { executed: false, decision };
      state.effects++; return { executed: true, operation: args.operation };
    } }));
  } });
  await fixture.await();
  return state;
}
const approvalOutcome = options => {
  const message = options.messages.findLast(message => message.role === 'tool');
  const data = message.isError ? { executed: false } : JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
  return { name: 'task_submit_result', args: { outcome: data.executed ? 'success' : 'blocked', summary: data.executed ? 'Reviewed fixture effect completed' : 'Fixture effect was not authorized' } };
};

test('public native approval hook holds the exact call and applies trusted allow-once or deny without a model approval tool', async () => {
  for (const decision of ['allowed-once', 'denied']) {
    const h = await harness({ config: { executionTools: ['fixture_approval'], trustedUnconfinedTools: true, approvalDestinations: ['offline-approval-destination'] }, script: [{ name: 'fixture_approval', args: { operation: 'write-fixture-result' } }, approvalOutcome] });
    try {
      const state = await mountApprovalFixture(h);
      const { claim } = seed(h, '', { policy: { allowedTools: ['fixture_approval'] } });
      const running = h.ctx.taskSystem.native.execute(claim);
      await until(() => h.ledger.approvals().length === 1);
      const request = h.ledger.approvals()[0];
      assert.equal(request.state, 'pending'); assert.equal(request.toolName, 'fixture_approval');
      assert.equal(request.sessionId, h.ledger.getAttempt(claim.attempt.attemptId).sessionId);
      assert.equal(request.executionId, h.ledger.getAttempt(claim.attempt.attemptId).executionId);
      assert.ok(request.description.includes('write-fixture-result'));
      assert.equal(state.effects, 0); assert.equal(h.ledger.getRun(claim.run.runId).state, 'running');
      assert.ok(h.ledger.deliveries().some(delivery => delivery.kind === 'approval' && delivery.approvalId === request.requestId));
      assert.equal(h.ctx.tools.get('approval_respond'), undefined);
      h.ledger.respondApproval('operator-decision', { requestId: request.requestId, expectedRevision: request.revision, decision, actor: 'offline-operator' });
      const result = await running;
      assert.equal(result.run.state, decision === 'allowed-once' ? 'succeeded' : 'blocked');
      assert.equal(state.effects, decision === 'allowed-once' ? 1 : 0);
      assert.deepEqual(state.decisions, [decision === 'allowed-once' ? 'allowed-once' : 'rejected']);
      assert.throws(() => h.ledger.respondApproval('late-repeat', { requestId: request.requestId, expectedRevision: request.revision, decision: 'allowed-once', actor: 'offline-operator' }));
    } finally { await h.dispose(); }
  }
});

test('native approval bridge fails closed on unreviewable arguments, hard policy denial, and unload of a pending closure', async () => {
  for (const mode of ['sensitive', 'policy', 'unload']) {
    const h = await harness({ config: { executionTools: ['fixture_approval'], trustedUnconfinedTools: true }, script: [{ name: 'fixture_approval', args: { operation: mode === 'sensitive' ? 'Bearer SYNTHETIC-SECRET-CREDENTIAL' : 'reviewable-fixture' } }, approvalOutcome] });
    try {
      const state = await mountApprovalFixture(h);
      const { claim } = seed(h, '', { policy: { allowedTools: mode === 'policy' ? [] : ['fixture_approval'] } });
      const running = h.ctx.taskSystem.native.execute(claim);
      if (mode === 'unload') {
        await until(() => h.ledger.approvals().length === 1);
        await h.ctx.loader.resolve('approval-bridge').fiber.dispose(); await h.ctx.loader.await();
      }
      const result = await running;
      assert.equal(result.run.state, 'blocked'); assert.equal(state.effects, 0);
      if (mode === 'unload') assert.equal(h.ledger.approvals()[0].state, 'cancelled');
      else assert.equal(h.ledger.approvals().length, 0);
      assert.ok(!JSON.stringify(h.ledger.snapshot()).includes('SYNTHETIC-SECRET-CREDENTIAL'));
    } finally { await h.dispose(); }
  }
});

test('standard native file tools cannot read or mutate authority database, SQLite sidecars, aliases or protected operator controls', async () => {
  const dir = join(scratch, 'protected-authority');
  const controls = join(dir, 'control'); mkdirSync(controls, { recursive: true });
  writeFileSync(join(controls, 'settings.json'), '{"approval":"operator-only"}');
  const h = await harness({ dir, config: { executionTools: ['read', 'write', 'edit'], protectedPaths: [controls] }, script: ['hang'] });
  try {
    linkSync(join(dir, 'tasks.sqlite'), join(dir, 'ledger-alias.sqlite'));
    await h.ctx.loader.create({ id: 'authority-fs', name: '@deepseek-ai/dsh-fs-local', config: { cwd: dir } });
    await h.ctx.loader.create({ id: 'authority-file-tools', name: '@deepseek-ai/dsh-tool-fs', config: {} }); await h.ctx.loader.await();
    h.ledger.registerWorkspace('authority-workspace', { workspaceId: 'workspace', nodeId: 'local', path: dir, label: 'Workspace containing authority state', state: 'ready', createdAt: new Date().toISOString() });
    const { claim } = seed(h, '', { workspaceId: 'workspace' });
    const running = h.ctx.taskSystem.native.execute(claim); running.catch(() => undefined);
    await until(() => h.adapter.requests.length);
    const agent = h.ctx.agents.get(h.ledger.getAttempt(claim.attempt.attemptId).sessionId);
    for (const file_path of ['tasks.sqlite', 'tasks.sqlite-wal', 'tasks.sqlite-shm', 'tasks.sqlite-journal', 'tasks.sqlite.results.sqlite', 'tasks.sqlite.results.sqlite-wal', 'tasks.sqlite.results.sqlite-shm', 'ledger-alias.sqlite', 'control/settings.json']) {
      for (const name of ['read', 'write', 'edit']) {
        const args = name === 'read' ? { file_path } : name === 'write' ? { file_path, content: 'forbidden' } : { file_path, old_string: 'operator-only', new_string: 'model-approved' };
        const result = await tool(h.ctx, name, args, agent);
        assert.equal(result.isError, true, `${name} must reject ${file_path}`);
        assert.match(JSON.stringify(result), /protected runtime authority|protected operator|aliases protected/);
      }
    }
    assert.equal(readFileSync(join(controls, 'settings.json'), 'utf8'), '{"approval":"operator-only"}');
    assert.equal(h.ledger.getRun(claim.run.runId).state, 'running');
  } finally { await h.dispose(); }
});

test('quiescent native terminal journal survives authority SQLite lock and host restart without another model invocation', { timeout: 15000 }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = join(scratch, 'native-terminal-recovery');
  let h = await harness({ dir, config: { leaseTtlMs: 1000 }, script: [{ name: 'task_submit_result', args: { outcome: 'success', summary: 'Known terminal result before authority outage', reportTitle: 'Durable native report', reportBody: 'This exact owned result survived the independent authority lock.' } }] });
  let lock;
  try {
    const { task, run, claim } = seed(h);
    h.ledger.renew('short-test-lease', { runId: run.runId, attemptId: claim.attempt.attemptId, nodeId: 'local', fence: claim.attempt.fence, ttlMs: 1000 });
    h.ctx.on('session/event', (session, event) => {
      if (session.id === h.ledger.getAttempt(claim.attempt.attemptId).sessionId && event.type === 'turn/end' && !lock) {
        lock = new DatabaseSync(join(dir, 'tasks.sqlite'));
        lock.exec('BEGIN IMMEDIATE');
      }
    });
    await assert.rejects(h.ctx.taskSystem.native.execute(claim), /locked/);
    assert.ok(lock, 'actual terminal event acquired an independent SQLite write lock');
    assert.equal(h.adapter.requests.length, 1);
    assert.equal(h.ctx.taskSystem.native.activeCount, 0);
    assert.equal(h.ctx.agents.get(h.ledger.getAttempt(claim.attempt.attemptId).sessionId), undefined);
    const [entry] = h.ctx.taskSystem.results.pending();
    assert.equal(entry.state, 'held'); assert.equal(entry.reasonCode, 'AUTHORITY_UNAVAILABLE');
    assert.equal(entry.settlement.outcome, 'success');
    assert.equal(entry.quiescent, true); assert.equal(entry.sessionPersisted, true);
    assert.ok(entry.readyAt <= Date.parse(h.ledger.getAttempt(claim.attempt.attemptId).leaseExpiresAt));
    assert.equal(h.ledger.getRun(run.runId).state, 'running');
    assert.equal(h.ledger.history(task.taskId).reports.length, 0);
    lock.exec('ROLLBACK'); lock.close(); lock = undefined;
    await h.dispose();
    h = await harness({ dir });
    assert.equal(h.adapter.requests.length, 0, 'journal replay never invokes a model');
    assert.equal(h.ledger.getRun(run.runId).state, 'succeeded');
    assert.equal(h.ledger.history(task.taskId).reports.length, 1);
    assert.equal(h.ledger.history(task.taskId).reports[0].body, entry.settlement.report.body);
    assert.equal(h.ctx.taskSystem.results.get(entry.commandId).state, 'committed');
    assert.equal(h.ctx.taskSystem.results.pending().length, 0);
    h.ctx.taskSystem.tick();
    assert.equal(h.ledger.history(task.taskId).reports.length, 1);
    assert.equal(h.ledger.history(task.taskId).events.filter(event => event.type === 'run.settled').length, 1);
  } finally { if (lock) { lock.exec('ROLLBACK'); lock.close(); } await h.dispose(); }
});

test('actual native daily work summary derives turn shares from configured Codex and Hermes reader receipts', async () => {
  const h = await harness({ config: { executionTools: ['legacy_sources_read', 'legacy_report_prepare'], trustedUnconfinedTools: true } });
  try {
    const { createLegacyTemplates } = await import('../../examples/legacy-task-pack/index.mjs');
    await h.ctx.loader.create({ id: 'daily-work-pack', name: pathToFileURL(resolve('examples/legacy-task-pack/plugin.mjs')).href, config: { timeZone: 'UTC', automationIds: ['custom-example'], nodeAliases: { local: 'synthetic-node' }, sourceRegistry: [{ id: 'synthetic-source', root: resolve('examples/legacy-task-pack/readers/fixtures'), manifest: 'manifest.json' }] } });
    await h.ctx.loader.await();
    h.ledger.registerNode('native-daily-work-node', { nodeId: 'local', roles: ['both'], capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const template = createLegacyTemplates().find(item => item.defaults.kind === 'daily_work_summary');
    assert.ok(template);
    const task = h.ledger.createTask('native-daily-work-task', { title: 'Ad-hoc daily work summary from approved local sources' }).value;
    const run = h.ledger.createRun('native-daily-work-run', { taskId: task.taskId, configuration: { template, input: { sourceIds: ['synthetic-source'], windowStart: '2026-09-15T00:00:00Z', windowEnd: '2026-09-16T00:00:00Z' } }, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: ['legacy.task-pack.v1'] } }).value;
    const toolValue = options => { const message = options.messages.findLast(item => item.role === 'tool'); assert.equal(message.isError, false, JSON.stringify(message.content)); return JSON.parse(message.content.filter(item => item.type === 'text').map(item => item.text).join('\n')); };
    const refs = ['codex:synthetic-codex:synthetic-turn', 'hermes:synthetic-hermes:synthetic-hermes:m3'];
    h.adapter.script.push(
      { name: 'legacy_sources_read', args: { sourceIds: ['synthetic-source'] } },
      options => { const source = toolValue(options); return { name: 'legacy_report_prepare', args: { commandId: 'native-daily-work-prepare', kind: 'daily_work_summary', input: { sourceReceiptId: source.sourceReceiptId, sourceId: 'synthetic-source', language: 'en', semantic: { turns: refs.map(source_ref => ({ source_ref, status: 'completed' })), groups: [{ group_id: 'fixture-project', title: 'Verified fixture work', importance: 50, turn_refs: refs, accomplishments: ['Verified the Codex fixture outcome', 'Confirmed the Hermes fixture outcome'] }], attention: [] } } } }; },
      options => { const prepared = toolValue(options); assert.equal(h.ledger.history(task.taskId).reports.length, 0); assert.deepEqual(prepared.report.artifactIds, []); return { name: 'task_submit_result', args: { outcome: 'success', summary: prepared.summary, reportTitle: prepared.report.title, reportBody: prepared.report.body, reportData: prepared.report.data, reportSchemaId: prepared.report.schemaId } }; },
    );
    const claim = h.ledger.claim('native-daily-work-claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    const result = await h.ctx.taskSystem.native.execute(claim);
    assert.equal(result.run.state, 'succeeded'); assert.equal(result.run.validation, undefined);
    const report = h.ledger.history(task.taskId).reports[0];
    assert.equal(report.schemaId, 'daily_work_summary.v1');
    assert.equal(report.data.payload.summary.user_turns.total, 2);
    assert.equal(report.data.payload.themes[0].share_percent, 100);
    assert.equal(h.adapter.requests.length, 3);
  } finally { await h.dispose(); }
});

test('reviewed completed native tools continue the same session across two restarts and exact prior writes cannot replay', { timeout: 15000 }, async () => {
  const dir = join(scratch, 'completed-tools-continuation');
  const config = { executionTools: ['write'], safeRetry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 100, resumableTools: ['write'] } };
  const mountFiles = async h => { await h.ctx.loader.create({ id: 'continuation-fs', name: '@deepseek-ai/dsh-fs-local', config: { cwd: dir } }); await h.ctx.loader.create({ id: 'continuation-directory', name: '@deepseek-ai/dsh-working-directory', config: {} }); await h.ctx.loader.create({ id: 'continuation-files', name: '@deepseek-ai/dsh-tool-fs', config: {} }); await h.ctx.loader.await(); };
  const writeA = { name: 'write', args: { file_path: 'completed-a.txt', content: 'first completed effect' } };
  const writeB = { name: 'write', args: { file_path: 'completed-b.txt', content: 'second completed effect' } };
  let h = await harness({ dir, config, script: [writeA, () => { throw new LlmError('Synthetic transient after confirmed write', 'SERVER'); }] });
  try {
    await mountFiles(h);
    h.ledger.registerWorkspace('continuation-workspace', { workspaceId: 'workspace', nodeId: 'local', path: dir, label: 'Reviewed continuation workspace', state: 'ready', createdAt: new Date().toISOString() });
    const { task, run, claim } = seed(h, '', { workspaceId: 'workspace', policy: { allowedTools: ['write'], maxRuntimeMs: 10000 } });
    const first = await h.ctx.taskSystem.native.execute(claim);
    assert.equal(first.run.state, 'queued'); assert.equal(first.retryScheduled, true);
    assert.equal(readFileSync(join(dir, 'completed-a.txt'), 'utf8'), 'first completed effect');
    const firstProof = h.ledger.getAttempt(claim.attempt.attemptId).retryEvidence;
    assert.equal(firstProof.kind, 'dsh-owned-completed-tools-v1');
    assert.equal(firstProof.toolCallCount, 1); assert.equal(firstProof.toolDispatchCount, 1); assert.equal(firstProof.toolResultCount, 1);
    assert.equal(first.run.retry.completedTools.length, 1);
    const sessionId = first.sessionId, executionStartedAt = first.run.executionStartedAt;
    await h.dispose();
    h = await harness({ dir, config, script: [writeB, () => { throw new LlmError('Synthetic next transient after confirmed write', 'TRANSPORT'); }] }); await mountFiles(h);
    while (Date.now() < Date.parse(first.run.retry.notBefore)) await new Promise(resolve => setTimeout(resolve, 5));
    const secondClaim = h.ledger.claim('continuation-claim-2', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    const second = await h.ctx.taskSystem.native.execute(secondClaim);
    assert.equal(second.run.state, 'queued'); assert.equal(second.run.retry.count, 2);
    assert.equal(second.sessionId, sessionId); assert.equal(second.run.retry.completedTools.length, 2);
    assert.equal(second.run.executionStartedAt, executionStartedAt);
    const latestUser = h.adapter.requests[0].messages.findLast(message => message.role === 'user');
    const continuation = JSON.stringify(latestUser.content);
    assert.match(continuation, /Continue this run from its persisted session/);
    assert.ok(!continuation.includes(task.title), 'continuation wake does not resend the original task');
    await h.dispose();
    h = await harness({ dir, config, script: [writeA,
      options => { const msg = options.messages.findLast(message => message.role === 'tool'); assert.equal(msg.isError, true); assert.match(JSON.stringify(msg.content), /already completed/); return writeB; },
      options => { const msg = options.messages.findLast(message => message.role === 'tool'); assert.equal(msg.isError, true); assert.match(JSON.stringify(msg.content), /already completed/); return { name: 'task_submit_result', args: { outcome: 'success', summary: 'Continued from two persisted writes without repeating either' } }; },
    ] }); await mountFiles(h);
    while (Date.now() < Date.parse(second.run.retry.notBefore)) await new Promise(resolve => setTimeout(resolve, 5));
    const thirdClaim = h.ledger.claim('continuation-claim-3', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    const third = await h.ctx.taskSystem.native.execute(thirdClaim);
    assert.equal(third.run.state, 'succeeded'); assert.equal(third.sessionId, sessionId);
    assert.equal(readFileSync(join(dir, 'completed-a.txt'), 'utf8'), 'first completed effect');
    assert.equal(readFileSync(join(dir, 'completed-b.txt'), 'utf8'), 'second completed effect');
    assert.equal(h.ledger.history(task.taskId).runs.length, 1);
    assert.equal(h.ledger.getAttempt(thirdClaim.attempt.attemptId).fence, 3);
  } finally { await h.dispose(); }
});
