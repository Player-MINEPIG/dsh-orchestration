import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createNativeHarness } from './native-harness.mjs';
import { ScriptedModel } from './scripted-model.mjs';
import { TaskPluginSettings } from '../../packages/task-system/dist/settings.js';

// Controlled correctness stress only. Scripted holds are not model latency or throughput.
const output = resolve(process.env.DSH_BURST_OUTPUT ?? '.runtime/steward-burst-integration');
mkdirSync(output, { recursive: true });
const receipt = {
  claim: 'Twenty feedback messages over four projects through actual Settings HTTP and native sessions. Deterministic holds test isolation and delivery correctness, not production capacity.',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
  node: process.version, cores: cpus().length, loadBefore: loadavg(),
  workspaceDependencyRealpaths: Object.fromEntries(['@dsh-task/task-system', '@dsh-task/feishu-channel', '@dsh-orchestration/dashboard', 'dsh-jev-plugin'].map(name => [name, realpathSync(join('node_modules', name))])),
  dependencyReuse: 'Only this worktree node_modules namespace directories and links were changed; external dependencies and pinned runtime/plugin sources are read from the preserved installation. No writes through source symlinks were performed.',
  timingBoundary: 'receivedAt: parsed HTTP request; acknowledgedAt: Settings response; saved/queued/completedObservedAt: first sampled canonical state; nativeInputAt: actual native user event; modelStartedAt: actual scripted adapter boundary. Samples are observation upper bounds, not transaction timestamps. No separate routing-complete event is exposed.',
  rounds: [], errors: [],
};
const delay = ms => new Promise(done => setTimeout(done, ms));
function barrier() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }
async function until(check, label) { const deadline = Date.now() + 15000; while (!await check()) { if (Date.now() > deadline) throw Error(`Timed out: ${label}`); await delay(5); } }
function stats(values) { const ordered = [...values].sort((a, b) => a - b); return { unit: 'ms', count: ordered.length, median: ordered[Math.floor(ordered.length / 2)], min: ordered[0], max: ordered.at(-1) }; }
async function round(index) {
  const h = await createNativeHarness({ config: { role: 'both', schedulerEnabled: false, projectAgentOptions: { provider: 'test-offline', model: 'script' } } });
  const classifier = barrier(), slowA = barrier(), events = [], records = new Map(), t0 = performance.now();
  const now = () => performance.now() - t0;
  const result = { index, events, messages: [], counters: {}, maxBacklog: 0, maxQueuedObserved: 0 };
  let server, timer, classifierArrived = false, slowArrived = false;
  try {
    const task = h.ctx.taskSystem, service = task.steward, projects = task.projects;
    projects.saveSettings({ root: join(h.dir, 'projects'), expectedRevision: 0 });
    const owners = [];
    for (const label of ['A', 'B', 'C', 'D']) owners.push(await projects.create({ commandId: `project-${label}`, title: `Burst ${label}`, goal: `Isolated project ${label}` }));
    const inputs = Array.from({ length: 20 }, (_, position) => {
      const target = position === 0 ? 3 : (position - 1) % 4;
      const input = { conversationId: 'main', commandId: `burst-${index}-${position}`, text: `FEEDBACK_${index}_${position}`, ...(position === 0 ? { routingMode: 'auto' } : { target: { kind: 'project', projectId: owners[target].projectId } }) };
      records.set(input.commandId, { commandId: input.commandId, text: input.text, expectedProject: owners[target].projectId, expectedSession: projects.placementProject(owners[target].projectId).session, position });
      return input;
    });
    h.ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return;
      const rpcId = event.data.source.rpcId;
      if (!rpcId?.startsWith('steward-')) return;
      events.push({ kind: 'native-input', rpcId, sessionId: String(session.id), seq: event.seq, ms: now() });
    });
    h.adapter.stream = async function* (options) {
      this.requests.push(options);
      const user = [...options.messages].reverse().find(message => message.role === 'user' && message.source?.kind !== 'runtime-context');
      const text = user?.content.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
      if (user?.source?.kind === 'dsh-steward-route-classifier') {
        classifierArrived = true; events.push({ kind: 'classifier-started', ms: now() }); await classifier.promise;
        yield* new ScriptedModel([JSON.stringify({ kind: 'route', target: { kind: 'project', projectId: owners[3].projectId } })]).stream(options);
      } else {
        events.push({ kind: 'model-started', text, sessionId: options.sessionId, ms: now() });
        if (text === inputs[1].text) { slowArrived = true; await slowA.promise; }
        yield* new ScriptedModel([`REPLY:${text}`]).stream(options);
      }
    };
    const settings = Object.assign(Object.create(TaskPluginSettings.prototype), { ctx: h.ctx });
    const sample = () => {
      let backlog = 0, queued = 0;
      for (const record of records.values()) {
        const message = service.store.commandMessage('main', record.commandId);
        if (!message) continue;
        record.savedObservedAt ??= now(); record.canonicalId = message.id; record.seq = message.seq; record.actualProject = message.scope.projectId; record.actualSession = message.source.sessionId;
        if (message.state.kind === 'queued') { record.queuedObservedAt ??= now(); queued++; }
        if (message.state.kind === 'completed') record.completedObservedAt ??= now(); else backlog++;
      }
      result.maxBacklog = Math.max(result.maxBacklog, backlog); result.maxQueuedObserved = Math.max(result.maxQueuedObserved, queued);
    };
    timer = setInterval(sample, 5);
    server = createServer(async (request, response) => {
      let commandId;
      try {
        let body = ''; for await (const chunk of request) body += chunk;
        const { method, input } = JSON.parse(body); assert.equal(method, 'stewardSend'); commandId = input.commandId;
        records.get(commandId).receivedAt = now(); events.push({ kind: 'http-received', commandId, ms: now() });
        const value = await settings.stewardSend(input); sample();
        const record = records.get(commandId); record.acknowledgedAt = now(); record.stateAtAck = value.commandMessage?.state.kind;
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value }));
      } catch (error) { events.push({ kind: 'http-error', commandId, error: error.message, ms: now() }); response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message, details: error.details })); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const send = async input => { const response = await fetch(`http://127.0.0.1:${server.address().port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'stewardSend', input }) }); const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value; };
    const pendingClassifier = send(inputs[0]); pendingClassifier.catch(() => {}); await until(() => classifierArrived, 'classifier reached actual adapter');
    const firstA = await send(inputs[1]); assert.ok(['admitted', 'queued'].includes(firstA.value.commandMessage.state.kind)); await until(() => slowArrived, 'A reached actual adapter');
    await Promise.all(inputs.slice(2).map(send)); sample();
    assert.equal(records.get(inputs[0].commandId).savedObservedAt, undefined, 'Held classification is not a durable canonical admission');
    assert.ok(inputs.slice(1).every(input => records.get(input.commandId).savedObservedAt !== undefined), 'All nineteen direct messages are saved before either hold is released');
    await until(async () => { await service.reconcile({ conversationId: 'main', limit: 100 }); sample(); return [...records.values()].filter(record => record.expectedProject !== owners[0].projectId && record.position !== 0).every(record => record.completedObservedAt !== undefined); }, 'Other projects finish while A and classifier wait');
    events.push({ kind: 'release-classifier', ms: now() }); classifier.release(); await pendingClassifier;
    await until(async () => { await service.reconcile({ conversationId: 'main', limit: 100 }); sample(); return records.get(inputs[0].commandId).completedObservedAt !== undefined; }, 'Classified D completes while A waits');
    events.push({ kind: 'release-slow-A', ms: now() }); slowA.release();
    await until(async () => { await service.reconcile({ conversationId: 'main', limit: 100 }); sample(); return [...records.values()].every(record => record.completedObservedAt !== undefined); }, 'All twenty messages complete');
    const finalMessages = service.snapshot({ conversationId: 'main', limit: 100 }).messages;
    const canonical = finalMessages.filter(message => message.role === 'user');
    assert.equal(canonical.length, 20); assert.equal(new Set(canonical.map(message => message.commandId)).size, 20);
    const native = events.filter(event => event.kind === 'native-input'), models = events.filter(event => event.kind === 'model-started');
    for (const record of records.values()) {
      const ownNative = native.filter(event => event.rpcId === `steward-${record.canonicalId}`), ownModels = models.filter(event => event.text === record.text);
      assert.equal(ownNative.length, 1); assert.equal(ownModels.length, 1);
      assert.equal(ownNative[0].sessionId, record.expectedSession); assert.equal(ownModels[0].sessionId, record.expectedSession);
      assert.equal(record.actualProject, record.expectedProject); assert.equal(record.actualSession, record.expectedSession);
      const replies = finalMessages.filter(message => message.role === 'assistant' && message.text === `REPLY:${record.text}`);
      assert.equal(replies.length, 1); assert.equal(replies[0].replyTo, record.canonicalId); assert.equal(replies[0].scope.projectId, record.expectedProject);
      record.nativeInputAt = ownNative[0].ms; record.modelStartedAt = ownModels[0].ms;
    }
    for (const owner of owners) {
      const accepted = [...records.values()].filter(record => record.expectedProject === owner.projectId).sort((a, b) => a.seq - b.seq);
      const started = models.filter(event => event.sessionId === projects.placementProject(owner.projectId).session).map(event => event.text);
      assert.deepEqual(started, accepted.map(record => record.text), 'Native session consumes accepted messages in canonical order');
      const direct = accepted.filter(record => record.position !== 0);
      assert.deepEqual(direct.map(record => record.commandId), [...direct].sort((a, b) => a.receivedAt - b.receivedAt).map(record => record.commandId), 'Same-project direct messages preserve HTTP intake order');
    }
    result.messages = [...records.values()];
    result.counters = { received: records.size, canonicalRows: canonical.length, saved: result.messages.filter(record => record.savedObservedAt !== undefined).length, queuedObserved: result.messages.filter(record => record.queuedObservedAt !== undefined).length, nativeInputs: native.length, completed: result.messages.filter(record => record.completedObservedAt !== undefined).length, classifierRequests: h.adapter.requests.length - models.length, modelRequests: models.length, httpErrors: events.filter(event => event.kind === 'http-error').length, duplicates: native.length - new Set(native.map(event => event.rpcId)).size, wrongTargets: 0, missing: records.size - native.length, orderingErrors: 0 };
    result.directAdmissionLatency = stats(result.messages.filter(record => record.position !== 0).map(record => record.acknowledgedAt - record.receivedAt));
    result.observedCompletionLatency = stats(result.messages.map(record => record.completedObservedAt - record.receivedAt));
    return result;
  } catch (error) { result.error = { message: error.message, stack: error.stack }; result.messages = [...records.values()]; receipt.rounds.push(result); throw error; }
  finally { classifier.release(); slowA.release(); if (timer) clearInterval(timer); if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); } await h.dispose(); }
}
try { for (let index = 0; index < Number(process.env.DSH_BURST_ROUNDS ?? 5); index++) { const result = await round(index); receipt.rounds.push(result); process.stdout.write(JSON.stringify({ index, counters: result.counters, maxBacklog: result.maxBacklog, maxQueuedObserved: result.maxQueuedObserved, directAdmissionLatency: result.directAdmissionLatency, observedCompletionLatency: result.observedCompletionLatency }) + '\n'); } }
catch (error) { receipt.errors.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
finally { receipt.loadAfter = loadavg(); writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)); }
