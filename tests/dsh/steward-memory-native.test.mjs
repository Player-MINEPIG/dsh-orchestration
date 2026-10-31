import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createNativeHarness } from './native-harness.mjs';

const optionalRoot = resolve('.runtime/steward-plugins');
const managerRoot = join(optionalRoot, 'manager'), assemblerRoot = join(optionalRoot, 'assembler');
const available = existsSync(join(managerRoot, 'src/index.js')) && existsSync(join(assemblerRoot, 'src/plugin.js'));
const optional = { skip: available ? false : 'requires pinned optional sources under .runtime/steward-plugins', timeout: 40000 };
const sourceId = 'dsh-task.steward';
const text = request => JSON.stringify(request.messages);
async function waitFor(service, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await service.reconcile({ conversationId: 'main' });
    if (predicate(value)) return value;
    await new Promise(done => setTimeout(done, 20));
  }
  throw Error('Native memory fixture did not reach its durable response');
}
async function mount(h) {
  assert.equal(JSON.parse(readFileSync(join(managerRoot, 'package.json'))).version, '1.0.0');
  assert.equal(JSON.parse(readFileSync(join(assemblerRoot, 'package.json'))).version, '1.1.3');
  process.env.DSH_OFFICIAL_ROOT ??= resolve('.runtime/official-dsh-0.2.1-rc.2');
  const { attachProjectSessionHost } = await import('../../packages/task-system/test/fixtures/project-session-host.mjs');
  await attachProjectSessionHost(h);
  await h.ctx.loader.create({ id: 'steward-memory-manager', name: pathToFileURL(join(managerRoot, 'src/index.js')).href, config: { storageDir: join(h.dir, 'manager') } });
  await h.ctx.loader.create({ id: 'steward-prompt-assembler', name: pathToFileURL(join(assemblerRoot, 'src/plugin.js')).href, config: { storageDir: join(h.dir, 'assembler') } });
  await h.ctx.loader.await();
  assert.ok(h.ctx.dshMemoryManager, 'Public Manager must provide the actual Host service');
  assert.ok(h.ctx.dshPromptAssembler, 'Public Assembler must provide the actual Host service');
  assert.ok(h.ctx.dshMemoryManager.adapters.has(sourceId), 'Task adapter registers through Manager');
  assert.equal(h.ctx.taskSystem.steward.memory.capability().mode, 'available-not-delegated');
  const preset = h.ctx.dshPromptAssembler.store.save({ format: 'dsh-tavern-request-assembly', version: 1, name: 'Explicit steward native memory fixture', backend: 'native', rules: [
    { id: 'system', kind: 'native-system' }, { id: 'memory', kind: 'memory-manager.resources', role: 'system' },
    { id: 'history', kind: 'history' }, { id: 'input', kind: 'input' },
  ] });
  const stopPreset = h.ctx.on('agent/created', ({ agent }) => h.ctx.dshPromptAssembler.store.apply(agent.id, preset.id));
  const observations = [];
  h.ctx.on('llm/stream', async function* (options, next) {
    const session = h.ctx.get('agents')?.get(options.sessionId)?.session;
    observations.push({ sessionId: options.sessionId, assembly: h.ctx.dshPromptAssembler.runtime.observeNativeRequest(options, session) });
    yield* next();
  });
  return { manager: h.ctx.dshMemoryManager, preset, observations, stopPreset };
}
async function configure(h, manager, ids, revision = 2, rule = true) {
  const entries = ids.map(id => ({ id, adapterId: sourceId, whitelist: [{ global: true }], blacklist: [], retrieve: { on: 'before_model_request', rule, strategy: [{ operation: 'memory.read_content' }, { operation: 'memory.to_text' }] } }));
  writeFileSync(join(h.dir, 'manager/config.json'), JSON.stringify({ schemaVersion: 1, revision, entries, presets: {} }));
  await manager.reload();
}
const config = { role: 'both', schedulerEnabled: false, projectAgentOptions: { provider: 'test-offline', model: 'script' } };

test('public Manager1.0 and Assembler1.1.3 compose persona and authority project facts on official native isolated sessions', optional, async () => {
  const h = await createNativeHarness({ config });
  try {
    const { manager, observations } = await mount(h);
    const projects = h.ctx.taskSystem.projects, service = h.ctx.taskSystem.steward;
    projects.saveSettings({ root: join(h.dir, 'projects'), expectedRevision: 0 });
    const a = await projects.create({ commandId: 'memory-a', title: 'Memory Alpha', goal: 'A_PRIVATE_GOAL_MEMORY' });
    const b = await projects.create({ commandId: 'memory-b', title: 'Memory Beta', goal: 'B_PRIVATE_GOAL_MEMORY' });
    for (const [id, marker] of [[a.projectId, 'A_PRIVATE_TASK_MEMORY'], [b.projectId, 'B_PRIVATE_TASK_MEMORY']]) {
      const task = h.ledger.createTask('memory-task-' + id, { title: marker }).value;
      projects.linkTask(projects.placementProject(id).session, task.taskId);
    }
    await configure(h, manager, ['dsh-steward', `steward.project.${a.projectId}`, `steward.project.${b.projectId}`]);
    service.memory.delegateToManager();
    const send = async (commandId, target) => {
      const reply = `REPLY_${commandId}`;
      h.adapter.script.push(reply);
      await service.send({ conversationId: 'main', commandId, text: `INPUT_${commandId}`, target });
      return waitFor(service, value => value.messages.some(message => message.role === 'assistant' && message.text === reply));
    };
    await send('personal-memory', { kind: 'personal' });
    const sa = await send('alpha-memory', { kind: 'project', projectId: a.projectId });
    await send('beta-memory', { kind: 'project', projectId: b.projectId });
    assert.equal(h.adapter.requests.length, 3);
    const [personal, alpha, beta] = h.adapter.requests;
    for (const request of h.adapter.requests) {
      assert.equal((text(request).match(/\[persona dsh-steward@1\]/g) ?? []).length, 1, 'Manager is the sole persona path');
      assert.ok(observations.find(observed => observed.sessionId === request.sessionId)?.assembly, 'Assembler validates complete actual native provider request at llm/stream');
    }
    assert.doesNotMatch(text(personal), /A_PRIVATE|B_PRIVATE/);
    assert.match(text(alpha), /A_PRIVATE_GOAL_MEMORY/); assert.match(text(alpha), /A_PRIVATE_TASK_MEMORY/);
    assert.doesNotMatch(text(alpha), /B_PRIVATE|INPUT_personal-memory/);
    assert.match(text(beta), /B_PRIVATE_GOAL_MEMORY/); assert.match(text(beta), /B_PRIVATE_TASK_MEMORY/);
    assert.doesNotMatch(text(beta), /A_PRIVATE|INPUT_personal-memory/);
    assert.equal(new Set(h.adapter.requests.map(request => request.sessionId)).size, 3);
    const recorded = service.snapshot({ conversationId: 'main' }).requests;
    assert.equal(recorded.length, 3);
    assert.ok(recorded.every(request => request.assemblerObserved && /^[a-f0-9]{64}$/.test(request.assemblyHash)), 'Durable Host receipt retains public Assembler observation/hash');
    const source = manager.adapters.get(sourceId);
    assert.deepEqual(source.list({ scope: {} }), [], 'No global resource content catalog');
    const bound = source.listBound({ scope: { sessionId: alpha.sessionId, projectId: b.projectId } });
    assert.ok(bound.checkCurrent());
    assert.deepEqual(bound.items.map(item => item.id), ['dsh-steward', `steward.project.${a.projectId}`], 'Caller project claim cannot change native binding');
    assert.ok(bound.items.every(item => !Object.hasOwn(item, 'content')));
    const changed = h.ledger.createTask('memory-new-alpha-task', { title: 'A_NEW_AUTHORITY_TASK' }).value;
    projects.linkTask(projects.placementProject(a.projectId).session, changed.taskId);
    assert.equal(bound.checkCurrent(), false, 'Authority resource revision changes revoke a prior metadata lease');
    assert.equal(source.read({ id: `steward.project.${b.projectId}`, scope: { sessionId: alpha.sessionId } }), null);
    assert.throws(() => source.read({ id: 'dsh-steward', scope: { sessionId: 'unbound-native-session' } }), { code: 'FORBIDDEN' });
    const query = await manager.query({ scope: { sessionId: alpha.sessionId }, adapterId: sourceId });
    assert.equal(query.rows.length, 2);
    const applied = manager.traces.filter(trace => trace.phase === 'applied' && trace.sessionId === alpha.sessionId && trace.adapterId === sourceId);
    assert.deepEqual(new Set(applied.map(trace => trace.id)), new Set(['dsh-steward', `steward.project.${a.projectId}`]));
    assert.ok(applied.every(trace => trace.requestId.includes(':native:')));
    assert.ok(applied.every(trace => trace.detail.includes('不代表网络送达')));
    assert.ok(!manager.traces.some(trace => trace.phase === 'applied' && trace.sessionId === alpha.sessionId && trace.id === `steward.project.${b.projectId}`));
    await projects.handoff(a.projectId);
    assert.equal(bound.checkCurrent(), false, 'Changed PM generation revokes old binding');
    assert.throws(() => source.read({ id: 'dsh-steward', scope: { sessionId: alpha.sessionId } }), { code: 'FORBIDDEN' });
    assert.equal(sa.context.mode, 'manager-assembler');
    writeFileSync(join(optionalRoot, 'native-evidence.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), host: 'official @deepseek-ai/* 0.2.1-rc.2',
      manager: { version: '1.0.0', source: 'd8fe9cfea344f972d34fd9a7e8eb2fd28acf8831', entrySha256: createHash('sha256').update(readFileSync(join(managerRoot, 'src/index.js'))).digest('hex') },
      assembler: { version: '1.1.3', source: '374ab6107e4c98ce99fc69eeefcf3714314a73b7', entrySha256: createHash('sha256').update(readFileSync(join(assemblerRoot, 'src/plugin.js'))).digest('hex') },
      actualRequests: h.adapter.requests.map(request => ({ sessionId: request.sessionId, messages: request.messages })), recordedRequests: recorded, applied,
      assertions: ['native full-request observation', 'one persona', 'personal/A/B isolation', 'authoritative task facts', 'forged project ignored', 'foreign read denied', 'generation lease revoked'],
      limits: 'Offline ScriptedModel is the model boundary. No remote owner, paid provider delivery, semantic memory or advanced history replacement acceptance.'
    }, null, 2));
  } finally { await h.dispose(); }
});

test('invalid Manager config and optional unload never restore a second native persona injector, including restart', optional, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-memory-restart-'));
  let h = await createNativeHarness({ config, dir });
  try {
    const { manager } = await mount(h);
    await configure(h, manager, ['dsh-steward']);
    h.ctx.taskSystem.steward.memory.delegateToManager();
    h.adapter.script.push('INITIAL_MEMORY');
    await h.ctx.taskSystem.steward.send({ conversationId: 'main', commandId: 'memory-initial', text: 'INITIAL_INPUT', target: { kind: 'personal' } });
    await waitFor(h.ctx.taskSystem.steward, value => value.messages.some(message => message.text === 'INITIAL_MEMORY'));
    writeFileSync(join(dir, 'manager/config.json'), '{invalid');
    await assert.rejects(manager.reload());
    assert.equal(manager.requestAssemblyResources().available, false);
    h.adapter.script.push('INVALID_CONFIG_MEMORY');
    await h.ctx.taskSystem.steward.send({ conversationId: 'main', commandId: 'memory-invalid', text: 'INVALID_INPUT', target: { kind: 'personal' } });
    await waitFor(h.ctx.taskSystem.steward, value => value.messages.some(message => message.text === 'INVALID_CONFIG_MEMORY'));
    assert.equal((text(h.adapter.requests.at(-1)).match(/\[persona dsh-steward@1\]/g) ?? []).length, 0, 'Config error cannot reactivate native fallback');
    h.ctx.loader.remove('steward-memory-manager'); await h.ctx.loader.await();
    assert.equal(h.ctx.taskSystem.steward.memory.capability().mode, 'unavailable');
    assert.equal(h.ctx.taskSystem.steward.memory.assembled, true, 'Ownership latch survives optional unload');
    await h.dispose();
    h = await createNativeHarness({ config, dir });
    assert.equal(h.ctx.taskSystem.steward.memory.capability().mode, 'unavailable');
    h.adapter.script.push('AFTER_RESTART_MEMORY');
    await h.ctx.taskSystem.steward.send({ conversationId: 'second', commandId: 'memory-restart', text: 'RESTART_INPUT', target: { kind: 'personal' } });
    const deadline = Date.now() + 10000;
    while (!h.adapter.requests.length && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    assert.equal(h.adapter.requests.length, 1);
    assert.doesNotMatch(text(h.adapter.requests[0]), /\[persona dsh-steward@1\]/);
  } finally { await h.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('installed optional services and configured rules do not silently take persona ownership before trusted Host opt-in', optional, async () => {
  const h = await createNativeHarness({ config });
  try {
    const { manager } = await mount(h);
    const service = h.ctx.taskSystem.steward;
    assert.equal(service.memory.assembled, false);
    assert.throws(() => service.memory.delegateToManager(), { code: 'CONFIGURATION' });
    const send = async commandId => {
      h.adapter.script.push(`REPLY_${commandId}`);
      await service.send({ conversationId: 'main', commandId, text: commandId, target: { kind: 'personal' } });
      await waitFor(service, value => value.messages.some(message => message.text === `REPLY_${commandId}`));
      assert.equal((text(h.adapter.requests.at(-1)).match(/\[persona dsh-steward@1\]/g) ?? []).length, 1);
    };
    await send('before-memory-rule');
    await configure(h, manager, ['dsh-steward']);
    await send('before-memory-handover');
    assert.equal(service.memory.assembled, false);
    assert.equal(manager.traces.filter(trace => trace.phase === 'applied' && trace.adapterId === sourceId).length, 0);
    service.memory.delegateToManager();
    await send('after-memory-handover');
    assert.equal(service.memory.assembled, true);
    assert.equal(manager.traces.filter(trace => trace.phase === 'applied' && trace.adapterId === sourceId).length, 1);
  } finally { await h.dispose(); }
});

test('delegated source with missing native session preset reports configuration gap and does not reactivate fallback', optional, async () => {
  const h = await createNativeHarness({ config });
  try {
    const { manager, stopPreset } = await mount(h);
    await configure(h, manager, ['dsh-steward']);
    h.ctx.taskSystem.steward.memory.delegateToManager();
    stopPreset();
    h.adapter.script.push('NO_SESSION_PRESET_REPLY');
    await h.ctx.taskSystem.steward.send({ conversationId: 'main', commandId: 'missing-native-preset', text: 'NO_SESSION_PRESET_INPUT', target: { kind: 'personal' } });
    const snapshot = await waitFor(h.ctx.taskSystem.steward, value => value.messages.some(message => message.text === 'NO_SESSION_PRESET_REPLY'));
    assert.match(snapshot.context.diagnostic, /缺少/);
    assert.doesNotMatch(text(h.adapter.requests[0]), /\[persona dsh-steward@1\]/);
    assert.equal(manager.traces.filter(trace => trace.phase === 'applied' && trace.adapterId === sourceId).length, 0);
  } finally { await h.dispose(); }
});
