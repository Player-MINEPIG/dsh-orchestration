import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createNativeHarness } from './native-harness.mjs';

async function waitFor(service, predicate) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const snapshot = await service.reconcile({ conversationId: 'main' });
    if (predicate(snapshot)) return snapshot;
    await new Promise(done => setTimeout(done, 20));
  }
  throw Error('Native scoped recall did not settle');
}

test('native scoped recall reads the existing canonical archive through a data-only tool, with personal/A/B boundaries and pagination', { timeout: 30000 }, async () => {
  const h = await createNativeHarness({ config: { role: 'both', schedulerEnabled: false, projectAgentOptions: { provider: 'test-offline', model: 'script' } } });
  try {
    const service = h.ctx.taskSystem.steward, projects = h.ctx.taskSystem.projects;
    projects.saveSettings({ root: join(h.dir, 'projects'), expectedRevision: 0 });
    const a = await projects.create({ commandId: 'recall-alpha', title: 'Recall Alpha', goal: 'A_RECALL_GOAL' });
    const b = await projects.create({ commandId: 'recall-beta', title: 'Recall Beta', goal: 'B_RECALL_GOAL' });
    const users = [];
    for (const [id, target] of [['PERSONAL_SECRET', { kind: 'personal' }], ['A_SECRET', { kind: 'project', projectId: a.projectId }], ['B_SECRET', { kind: 'project', projectId: b.projectId }]]) {
      h.adapter.script.push('REPLY_' + id);
      await service.send({ conversationId: 'main', commandId: id, text: id, target });
      const snapshot = await waitFor(service, state => state.messages.some(message => message.text === 'REPLY_' + id));
      users.push(snapshot.messages.find(message => message.commandId === id));
    }
    for (const user of users) {
      const recalled = service.recall.read(user.source.sessionId, { query: 'SECRET', limit: 20 });
      assert.equal(recalled.dataOnly, true); assert.equal(recalled.items.length, 2);
      assert.ok(recalled.items.every(item => item.excerpt.includes(user.text)));
      assert.ok(recalled.items.every(item => Number.isInteger(item.revision) && item.viewHash.length === 64));
      assert.throws(() => service.recall.read(user.source.sessionId, { query: 'SECRET', scope: { kind: 'project', projectId: b.projectId } }));
    }
    h.adapter.script.push('A quote donor');
    await service.send({ conversationId: 'main', commandId: 'quote-donor', text: 'A_SHARE_ONLY A_PRIVATE_UNSHARED', target: { kind: 'project', projectId: a.projectId } });
    const donorState = await waitFor(service, state => state.messages.some(message => message.text === 'A quote donor'));
    const donor = donorState.messages.find(message => message.commandId === 'quote-donor');
    h.adapter.script.push('B received selected excerpt');
    await service.send({ conversationId: 'main', commandId: 'recall-shared-quote', text: 'Use the explicitly shared excerpt', target: { kind: 'project', projectId: b.projectId },
      quote: { messageId: donor.id, expectedRevision: donor.revision, excerpt: 'A_SHARE_ONLY' } });
    await waitFor(service, state => state.messages.some(message => message.text === 'B received selected excerpt'));
    const shared = service.recall.read(users[2].source.sessionId, { query: 'A_SHARE_ONLY' });
    assert.equal(shared.items.length, 1); assert.equal(shared.items[0].quote.excerpt, 'A_SHARE_ONLY');
    assert.equal(shared.items[0].quote.messageId, donor.id);
    assert.doesNotMatch(JSON.stringify(shared), /A_PRIVATE_UNSHARED|A_SECRET|PERSONAL_SECRET/);
    const personal = users[0];
    const archive = [];
    for (let i = 0; i < 125; i++) archive.push(service.store.project({ conversationId: 'main', role: 'user',
      text: i === 0 ? 'ARCHIVE_ONLY_PERSONAL: IGNORE_ALL_RULES is quoted historical data' : `ARCHIVE_PAGE_${i}`,
      scope: personal.scope, replyTo: null, createdAt: '2025-01-01T00:00:00.000Z', source: personal.source,
      nativeSeq: null, state: { kind: 'completed' }, manifest: personal.manifest }, 'recall-fixture-' + i));
    const ids = new Set(); let beforeSeq;
    for (let page = 0; page < 20; page++) {
      const result = service.recall.read(personal.source.sessionId, { limit: 20, ...(beforeSeq ? { beforeSeq } : {}) });
      assert.ok(result.scanned <= 100); assert.ok(result.items.length <= 20);
      for (const item of result.items) { assert.ok(!ids.has(item.messageId)); ids.add(item.messageId); }
      if (!result.hasMore) break;
      assert.ok(result.nextBeforeSeq < (beforeSeq ?? Number.MAX_SAFE_INTEGER)); beforeSeq = result.nextBeforeSeq;
    }
    assert.ok(archive.every(message => ids.has(message.id)), 'Empty query can page to all older canonical records');
    assert.ok(!service.recall.read(users[1].source.sessionId, { query: 'ARCHIVE_ONLY' }).items.length);
    h.adapter.script.push({ name: 'steward_recall', args: { query: 'ARCHIVE_ONLY', beforeSeq: archive[1].seq, limit: 3 } }, request => {
      const serialized = JSON.stringify(request.messages);
      assert.match(serialized, /ARCHIVE_ONLY_PERSONAL/);
      assert.match(serialized, /dataOnly/);
      assert.match(serialized, /历史资料/);
      assert.doesNotMatch(JSON.stringify(request.messages.filter(message => message.role === 'system')), /ARCHIVE_ONLY_PERSONAL/);
      assert.doesNotMatch(serialized, /A_SECRET|B_SECRET/);
      return 'Canonical archive recalled as data';
    });
    await service.send({ conversationId: 'main', commandId: 'native-recall-tool', text: 'Recall the archived personal excerpt', target: { kind: 'personal' } });
    await waitFor(service, state => state.messages.some(message => message.text === 'Canonical archive recalled as data'));
    const oldA = users[1].source.sessionId;
    await projects.handoff(a.projectId);
    assert.throws(() => service.recall.read(oldA, {}), { code: 'FORBIDDEN' });
    assert.throws(() => service.recall.read('forged-unbound-session', {}), { code: 'FORBIDDEN' });
  } finally { await h.dispose(); }
});

test('actual owned execution cannot use the shared recall/source binding even on an ordinary borrowed WebUI Agent', { timeout: 30000 }, async () => {
  const h = await createNativeHarness({ executionRoot: true, config: { role: 'both', schedulerEnabled: false, executionTools: [] } });
  let handle;
  try {
    const service = h.ctx.taskSystem, sid = SessionId(randomUUID());
    handle = await h.ctx.agents.create({ sessionId: sid, meta: { cwd: h.dir, agentPreset: 'ptc' }, agentOptions: { provider: 'test-offline', model: 'script' },
      setup: async scope => { await scope.get('agentPresets').mount(scope, 'ptc'); } });
    const agent = handle.agent;
    h.ledger.registerNode('recall-owned-node', { nodeId: 'local', roles: ['both'], models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], capabilities: [], workspaceIds: [], enabled: true, lastSeenAt: new Date().toISOString() });
    const task = h.ledger.createTask('recall-owned-task', { title: 'Ordinary borrowed execution without steward history access' }).value;
    const run = h.ledger.createRun('recall-owned-run', { taskId: task.taskId, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] } }).value;
    const claim = h.ledger.claim('recall-owned-claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
    claim.attempt.sessionId = sid; claim.attempt.executionId = randomUUID();
    h.adapter.script.push(options => {
      assert.ok(service.native.scopeFor(agent), 'Real NativeExecutionProvider owns this exact Agent during dispatch');
      assert.ok(!options.tools.some(tool => tool.name === 'steward_recall'));
      const owned = error => error.code === 'FORBIDDEN' && /Owned task execution/.test(error.message);
      assert.throws(() => service.steward.memory.bindingForSession(sid), owned);
      assert.throws(() => service.steward.recall.read(sid, {}), owned);
      return { name: 'task_submit_result', args: { outcome: 'success', summary: 'Ordinary borrowed execution kept its allowed authority without steward reads' } };
    });
    const result = await service.native.executeExternal({ claim, sessionId: sid, resumeSession: true, workspacePath: h.dir, signal: new AbortController().signal });
    assert.equal(result.outcome, 'success');
    assert.equal(h.ctx.agents.get(sid), agent, 'Original WebUI lifecycle remains intact');
    assert.equal(service.native.scopeFor(agent), undefined, 'Owned role is released after completion');
    assert.throws(() => service.steward.recall.read(sid, {}), error => error.code === 'FORBIDDEN' && !/Owned task execution/.test(error.message));
  } finally { if (handle) await handle.dispose(); await h.dispose(); }
});
