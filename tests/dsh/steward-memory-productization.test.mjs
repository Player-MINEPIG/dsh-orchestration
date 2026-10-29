import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeHarness } from './native-harness.mjs';
import { mountStewardMemory, stewardMemoryAvailable as available, stewardMemoryPresetId as presetId } from './fixtures/steward-memory-host.mjs';
import { stewardProjectCheckpoint } from '../../packages/task-system/dist/steward-memory-context.js';
import { canonical } from '../../packages/task-system/dist/ledger.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const options = { timeout: 40000, skip: available ? false : 'Pinned optional Manager/Assembler sources are absent' };
const config = { role: 'both', schedulerEnabled: false, projectAgentOptions: { provider: 'test-offline', model: 'script' } };
const messages = request => JSON.stringify(request.messages);
async function waitFor(service, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await service.reconcile({ conversationId: 'main' });
    if (predicate(result)) return result;
    await new Promise(done => setTimeout(done, 20));
  }
  throw Error('Native memory settings turn did not settle');
}
async function waitProjectIdle(projects, projectId) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const current = await projects.conversation(projectId);
    if (current.turns.every(turn => !['queued', 'running'].includes(turn.state))) return;
    await new Promise(done => setTimeout(done, 20));
  }
  throw Error('Native PM did not finish its authoritative turn before handoff');
}
async function fixture() {
  const h = await createNativeHarness({ config });
  const memory = await mountStewardMemory(h);
  const service = h.ctx.taskSystem.steward, projects = h.ctx.taskSystem.projects;
  projects.saveSettings({ root: join(h.dir, 'projects'), expectedRevision: 0 });
  const a = await projects.create({ commandId: 'settings-alpha', title: 'Settings Alpha', goal: 'ALPHA_AUTHORITY_GOAL' });
  const b = await projects.create({ commandId: 'settings-beta', title: 'Settings Beta', goal: 'BETA_FOREIGN_GOAL' });
  const scope = projectId => ({ kind: 'project', projectId });
  const read = target => memory.read(target);
  const configure = async (commandId, target, extra = {}) => {
    const current = await read(target);
    return service.configureMemory({ conversationId: 'main', scope: target, commandId, expectedRevision: current.revision,
      expectedSelectionHash: current.selectionHash, mode: 'manager', presetId, initializeMissingRules: true,
      inheritProjectGenerations: true, ...extra });
  };
  const send = async (commandId, target, response = 'REPLY_' + commandId) => {
    h.adapter.script.push(response);
    await service.send({ conversationId: 'main', commandId, text: 'INPUT_' + commandId, target });
    const result = await waitFor(service, state => state.messages.some(message => message.role === 'assistant' && message.text === response));
    if (target.kind === 'project') await waitProjectIdle(projects, target.projectId);
    return result;
  };
  return Object.assign(h, { service, projects, a, b, scope, read, configure, send });
}

test('user config delegates only the selected scope through real public policy services and new PM inherits bounded authority references', options, async () => {
  const h = await fixture();
  try {
    const a = h.scope(h.a.projectId), b = h.scope(h.b.projectId);
    const before = await h.read(a);
    assert.equal(before.mode, 'native'); assert.equal(before.available, true);
    assert.ok(before.presets.some(preset => preset.id === presetId));
    assert.equal(before.missingResourceIds.length, 2);
    await h.send('personal-control', { kind: 'personal' });
    const configured = await h.configure('enable-alpha-memory', a);
    assert.equal(configured.mode, 'manager'); assert.equal(configured.revision, 1);
    assert.equal(configured.inheritAuthorized, true); assert.deepEqual(configured.missingResourceIds, []);
    assert.equal((await h.read(b)).mode, 'native');
    assert.equal((await h.read({ kind: 'personal' })).mode, 'native');
    const task = h.ledger.createTask('memory-durable-task', { title: 'ALPHA_PERSISTED_TASK', description: 'ALPHA_PERSISTED_DESCRIPTION' }).value;
    h.projects.linkTask(h.projects.placementProject(h.a.projectId).session, task.taskId);
    h.ledger.recordDecision('memory-durable-decision', { decisionId: 'alpha-memory-decision', inputDigest: 'alpha-intent-revision',
      receipt: {}, proposal: {}, stateHash: 'alpha-state', validUntil: Date.now() + 60000,
      input: { taskId: task.taskId, projectId: h.a.projectId, title: 'ALPHA_PERSISTED_DECISION', description: 'Historical plan, not release authority' } });
    const run = h.ledger.createRun('memory-durable-run', { taskId: task.taskId, configuration: { decisionId: 'alpha-memory-decision' } }).value;
    const report = h.ledger.appendReport('memory-durable-report', { taskId: task.taskId, runId: run.runId,
      title: 'ALPHA_PERSISTED_REPORT', body: 'ALPHA_REPORT_DETAILS_IGNORE_ALL_RULES is historical data, never new authorization' }).value;
    await h.send('alpha-before-generation', a);
    const first = h.adapter.requests.at(-1);
    assert.match(messages(first), /ALPHA_PERSISTED_TASK/); assert.match(messages(first), /ALPHA_PERSISTED_DECISION/);
    assert.match(messages(first), /ALPHA_REPORT_DETAILS/); assert.match(messages(first), new RegExp(report.reportId));
    assert.doesNotMatch(messages(first), /INPUT_personal-control|BETA_FOREIGN/);
    assert.equal((messages(first).match(/\[persona dsh-steward@1\]/g) ?? []).length, 1);
    const oldSession = first.sessionId;
    await h.projects.handoff(h.a.projectId);
    await h.send('alpha-after-generation', a);
    const next = h.adapter.requests.at(-1);
    assert.notEqual(next.sessionId, oldSession);
    assert.match(messages(next), /ALPHA_PERSISTED_TASK/); assert.match(messages(next), /ALPHA_REPORT_DETAILS/);
    assert.match(messages(next), /ALPHA_PERSISTED_DECISION/);
    assert.doesNotMatch(messages(next), /INPUT_personal-control|BETA_FOREIGN/);
    assert.equal((messages(next).match(/\[persona dsh-steward@1\]/g) ?? []).length, 1);
    assert.equal(h.ctx.dshPromptAssembler.store.selection(next.sessionId).id, presetId);
    const applied = h.ctx.dshMemoryManager.traces.filter(trace => trace.phase === 'applied' && trace.sessionId === next.sessionId);
    assert.ok(applied.some(trace => trace.id === `steward.project.${h.a.projectId}`));
    const audits = h.service.snapshot({ conversationId: 'main' }).requests.filter(request => request.source.sessionId === next.sessionId);
    assert.ok(audits.length && audits.every(request => request.assemblerObserved && request.assemblyHash));
    assert.throws(() => h.service.memory.bindingForSession(oldSession), { code: 'FORBIDDEN' });
  } finally { await h.dispose(); }
});

test('a partial public-policy failure remains blocked until trusted CAS release, including plugin unload and PM generation change', options, async () => {
  const h = await fixture();
  try {
    const scope = h.scope(h.a.projectId), manager = h.ctx.dshMemoryManager, id = `steward.project.${h.a.projectId}`;
    manager.registerAdapter({ id: 'fixture-conflicting-source', authority: 'fixture-conflicting-source', list: () => [],
      read: () => ({ id, type: 'fixture', revision: '1', content: 'Conflicting source data must never enter native request' }) });
    await manager.read({ adapterId: 'fixture-conflicting-source', id });
    const before = await h.read(scope);
    const original = { conversationId: 'main', scope, commandId: 'partial-memory-config', expectedRevision: before.revision,
      expectedSelectionHash: before.selectionHash, mode: 'manager', presetId, initializeMissingRules: true, inheritProjectGenerations: true };
    await assert.rejects(h.service.configureMemory(original));
    assert.ok(manager.configurationSnapshot({ id: 'dsh-steward', adapterId: 'dsh-task.steward' }).local, 'First public policy write really committed');
    assert.equal((await h.read(scope)).pendingChange.commandId, original.commandId);
    const requests = h.adapter.requests.length;
    const blocked = await h.service.send({ conversationId: 'main', commandId: 'while-memory-pending', text: 'Must not send', target: scope });
    assert.equal(h.adapter.requests.length, requests);
    assert.equal(blocked.messages.find(message => message.commandId === 'while-memory-pending').state.kind, 'rejected');
    h.ctx.loader.remove('product-memory-manager'); await h.ctx.loader.await();
    await h.projects.handoff(h.a.projectId);
    const failed = await h.read(scope);
    assert.equal(failed.available, false); assert.equal(failed.pendingChange.commandId, original.commandId);
    await assert.rejects(h.service.configureMemory({ conversationId: 'main', scope, commandId: 'wrong-memory-release', mode: 'native',
      expectedRevision: failed.revision, expectedSelectionHash: failed.selectionHash, endPendingCommandId: 'wrong-attempt', confirmEndPending: true }), { code: 'CONFLICT' });
    const restored = await h.service.configureMemory({ conversationId: 'main', scope, commandId: 'explicit-memory-release', mode: 'native',
      expectedRevision: failed.revision, expectedSelectionHash: failed.selectionHash, endPendingCommandId: original.commandId, confirmEndPending: true });
    assert.equal(restored.mode, 'native'); assert.equal(restored.pendingChange, null);
    assert.ok(JSON.parse(readFileSync(join(h.dir, 'manager/config.json'))).entries.some(entry => entry.id === 'dsh-steward'));
    assert.equal(h.ctx.dshPromptAssembler.store.selection(restored.session.sessionId), null, 'No user preset is rewritten by release');
    await h.send('after-explicit-memory-release', scope);
    assert.equal((messages(h.adapter.requests.at(-1)).match(/\[persona dsh-steward@1\]/g) ?? []).length, 1);
    assert.doesNotMatch(messages(h.adapter.requests.at(-1)), /Conflicting source data/);
    assert.equal((await h.service.configureMemory(original)).mode, 'native', 'Ended old command cannot re-enable delegated ownership');
  } finally { await h.dispose(); }
});

test('authority checkpoint orders recent updates and caps all serialized source text with versioned full-record lookup', options, async () => {
  const h = await fixture();
  try {
    const c = await h.projects.create({ commandId: 'bounded-memory-project', title: 'Bounded title', goal: 'G'.repeat(9000) });
    for (let i = 0; i < 12; i++) {
      const task = h.ledger.createTask(`bounded-memory-task-${i}`, { title: `task${i}` + 'T'.repeat(180), description: 'D'.repeat(8000) }).value;
      h.projects.linkTask(h.projects.placementProject(c.projectId).session, task.taskId);
      h.ledger.appendReport(`bounded-memory-report-${i}`, { taskId: task.taskId, title: 'R'.repeat(200), body: 'B'.repeat(12000) });
    }
    const project = h.projects.placementProject(c.projectId);
    const binding = { kind: 'managed', projectId: c.projectId, nodeId: 'local', sessionId: project.session, generation: project.generation, cwd: project.cwd };
    const checkpoint = stewardProjectCheckpoint(h.ctx.taskSystem, binding);
    assert.equal(checkpoint.taskCount, 12); assert.equal(checkpoint.tasksTruncated, true); assert.ok(checkpoint.tasks.length <= 8);
    assert.ok(canonical(checkpoint).length < 24000); assert.equal(checkpoint.budget.serializedCharacters, canonical(checkpoint).length);
    assert.equal(checkpoint.goalTruncated, true);
    assert.ok(checkpoint.tasks.every(task => task.descriptionTruncated && task.reports.every(report => report.truncated && report.titleTruncated)));
    assert.ok(checkpoint.tasks.every(task => task.lookup.recordKind === 'task' && task.reports[0].lookup.recordKind === 'report'));
    await h.configure('enable-bounded-memory', h.scope(c.projectId));
    await h.send('bounded-memory-turn', h.scope(c.projectId));
    const resource = await h.ctx.dshMemoryManager.read({ adapterId: 'dsh-task.steward', id: `steward.project.${c.projectId}`, scope: { sessionId: project.session } });
    assert.ok(resource.content.length <= 24000);
    const read = h.service.recall.read(project.session, { recordKind: 'project' });
    assert.equal(read.characterLimit, 2000); assert.equal(read.hasMore, true);
    const next = h.service.recall.read(project.session, { recordKind: 'project', offset: read.nextOffset, expectedRevision: read.source.revision });
    assert.equal(next.source.revision, read.source.revision);
    assert.throws(() => h.service.recall.read(project.session, { recordKind: 'project', recordId: h.b.projectId }), { code: 'FORBIDDEN' });
  } finally { await h.dispose(); }
});

test('configuration preserves existing Manager deny rules, rejects stale or changed commands and switches back only on explicit user choice', options, async () => {
  const h = await fixture();
  try {
    const scope = h.scope(h.a.projectId), manager = h.ctx.dshMemoryManager;
    const original = manager.configurationSnapshot({ id: 'dsh-steward', adapterId: 'dsh-task.steward' });
    await manager.saveEntry({ id: 'dsh-steward', adapterId: 'dsh-task.steward', expectedRevision: original.revision,
      entry: { id: 'dsh-steward', adapterId: 'dsh-task.steward', whitelist: [{ global: true }], blacklist: [],
        retrieve: { on: 'before_model_request', rule: false, strategy: [{ operation: 'memory.read_content' }] } } });
    const denied = manager.configurationSnapshot({ id: 'dsh-steward', adapterId: 'dsh-task.steward' }).local;
    const before = await h.read(scope);
    const request = { conversationId: 'main', scope, commandId: 'explicit-memory-policy', expectedRevision: before.revision,
      expectedSelectionHash: before.selectionHash, mode: 'manager', presetId, initializeMissingRules: true, inheritProjectGenerations: true };
    await h.service.configureMemory(request);
    assert.deepEqual(manager.configurationSnapshot({ id: 'dsh-steward', adapterId: 'dsh-task.steward' }).local, denied);
    const revision = manager.configurationSnapshot({ id: 'dsh-steward', adapterId: 'dsh-task.steward' }).revision;
    await h.service.configureMemory(request);
    assert.equal(manager.configurationSnapshot({ id: 'dsh-steward', adapterId: 'dsh-task.steward' }).revision, revision);
    await assert.rejects(h.service.configureMemory({ ...request, mode: 'native' }), { code: 'CONFLICT' });
    await assert.rejects(h.service.configureMemory({ ...request, commandId: 'stale-selection' }), { code: 'CONFLICT' });
    await h.send('alpha-rule-denied', scope);
    assert.doesNotMatch(messages(h.adapter.requests.at(-1)), /\[persona dsh-steward@1\]/, 'Existing explicit deny is honored without native bypass');
    await h.configure('explicit-native-return', scope, { mode: 'native', initializeMissingRules: false, inheritProjectGenerations: false });
    await h.send('alpha-native-return', scope);
    assert.equal((messages(h.adapter.requests.at(-1)).match(/\[persona dsh-steward@1\]/g) ?? []).length, 1);
    assert.deepEqual(manager.configurationSnapshot({ id: 'dsh-steward', adapterId: 'dsh-task.steward' }).local, denied);
  } finally { await h.dispose(); }
});

test('new PM explicit preset and changed old selection cannot be overwritten by inherited authorization', options, async () => {
  const h = await fixture();
  try {
    const scope = h.scope(h.a.projectId);
    await h.configure('inherit-guard-enable', scope);
    await h.send('inherit-guard-first', scope);
    await h.projects.handoff(h.a.projectId);
    const current = h.projects.placementProject(h.a.projectId);
    h.ctx.dshPromptAssembler.store.apply(current.session, null);
    const before = h.adapter.requests.length;
    h.adapter.script.push('MUST_NOT_RUN');
    const response = await h.service.send({ conversationId: 'main', commandId: 'inherit-conflict', text: 'Try current generation', target: scope });
    assert.equal(h.adapter.requests.length, before);
    assert.equal(h.ctx.dshPromptAssembler.store.selection(current.session), null);
    assert.equal(response.messages.find(message => message.commandId === 'inherit-conflict').state.kind, 'rejected');
    assert.match((await h.read(scope)).diagnostics.join(' '), /预设/);
  } finally { await h.dispose(); }
});

test('default native PM checkpoint and read-only recall include current human gate without relying on optional delegation', options, async () => {
  const h = await fixture();
  try {
    const root = h.ledger.createTask('checkpoint-gate-root', { title: 'Gate workstream' }).value;
    h.projects.linkTask(h.projects.placementProject(h.a.projectId).session, root.taskId);
    const repair = h.ledger.createTask('checkpoint-gate-repair', { title: 'Repair allowed', parentTaskId: root.taskId }).value;
    const downstream = h.ledger.createTask('checkpoint-gate-downstream', { title: 'Downstream blocked', parentTaskId: root.taskId }).value;
    h.ledger.withAcceptanceHumanAction({ action: 'arm', reference: 'synthetic-human-stage-boundary' }, () => h.ledger.armAcceptanceGate('checkpoint-gate-arm', {
      gateId: 'checkpoint-native-gate', projectId: h.a.projectId, workstreamTaskId: root.taskId,
      upstreamTaskIds: [repair.taskId], downstreamTaskIds: [downstream.taskId], instructionRef: 'synthetic-human-stage-boundary' }));
    const project = h.projects.placementProject(h.a.projectId);
    const binding = { kind: 'managed', projectId: h.a.projectId, nodeId: 'local', sessionId: project.session, generation: project.generation, cwd: project.cwd };
    const checkpoint = stewardProjectCheckpoint(h.ctx.taskSystem, binding);
    assert.equal(checkpoint.gates.total, 1);
    assert.equal(checkpoint.gates.gates[0].gateId, 'checkpoint-native-gate');
    assert.equal(checkpoint.gates.gates[0].downstream.blocked, true);
    assert.ok(checkpoint.gates.gates[0].repairAllowed.taskIds.includes(repair.taskId));
    assert.equal((await h.read(h.scope(h.a.projectId))).mode, 'native');
    await h.send('default-native-gate-visibility', h.scope(h.a.projectId));
    assert.match(messages(h.adapter.requests.at(-1)), /checkpoint-native-gate/);
    assert.match(messages(h.adapter.requests.at(-1)), /repairing/);
    const read = h.service.recall.read(project.session, { recordKind: 'gate', recordId: 'checkpoint-native-gate' });
    assert.equal(read.dataOnly, true); assert.match(read.content, /checkpoint-native-gate/);
    assert.equal(h.ledger.acceptanceGateView('checkpoint-native-gate').state, 'repairing', 'Reading never releases the human boundary');
  } finally { await h.dispose(); }
});

test('direct native ingress during asynchronous public configuration prevents preset mutation without interrupting the real turn', options, async () => {
  const h = await fixture();
  let handle;
  try {
    const scope = h.scope(h.a.projectId);
    await h.send('idle-config-warmup', scope);
    const project = h.projects.placementProject(h.a.projectId);
    handle = await h.ctx.agents.resume({ resumeSessionId: SessionId(project.session), agentOptions: { provider: 'test-offline', model: 'script' } });
    const current = await h.read(scope);
    const binding = { kind: 'managed', projectId: h.a.projectId, nodeId: 'local', sessionId: project.session, generation: project.generation, cwd: project.cwd };
    const request = { conversationId: 'main', scope, commandId: 'native-ingress-config-race', expectedRevision: current.revision,
      expectedSelectionHash: current.selectionHash, mode: 'manager', presetId, initializeMissingRules: true, inheritProjectGenerations: true };
    const changing = h.service.memory.configure(request, binding);
    h.adapter.script.push('hang');
    handle.agent.followup(createUserMessage({ source: { kind: 'user', rpcId: 'synthetic-direct-native-user' }, content: [{ type: 'text', text: 'DIRECT_NATIVE_INGRESS_DURING_CONFIG' }] }));
    await assert.rejects(changing, { code: 'BUSY' });
    assert.equal(h.ctx.dshPromptAssembler.store.selection(project.session), null, 'New input stops configuration before selecting the preset');
    assert.equal((await h.read(scope)).pendingChange.commandId, request.commandId);
    const until = Date.now() + 10000;
    while (h.adapter.requests.length < 2 && Date.now() < until) await new Promise(done => setTimeout(done, 20));
    assert.equal(h.adapter.requests.length, 2);
    assert.equal(h.adapter.requests.at(-1).signal.aborted, false, 'Configuration guard did not cancel the native turn');
  } finally {
    if (handle) { handle.agent.cancel({ kind: 'hook', reason: 'Owned synthetic native race fixture cleanup' }); await handle.agent.whenIdle(); await handle.dispose(); }
    await h.dispose();
  }
});
