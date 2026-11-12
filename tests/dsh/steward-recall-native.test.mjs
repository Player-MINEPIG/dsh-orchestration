import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const args = ({ tool: _tool, ...input }) => input;

test('versioned message pointers follow a same-scope reply chain, preserve long Unicode text and authorized quote tails, and survive restart', { timeout: 40000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-chain-'));
  const config = { role: 'both', schedulerEnabled: false, projectAgentOptions: { provider: 'test-offline', model: 'script' } };
  let h = await createNativeHarness({ dir, config });
  try {
    let service = h.ctx.taskSystem.steward;
    const projects = h.ctx.taskSystem.projects;
    projects.saveSettings({ root: join(dir, 'projects'), expectedRevision: 0 });
    const a = await projects.create({ commandId: 'chain-a', title: 'Chain Alpha', goal: 'A only' });
    const b = await projects.create({ commandId: 'chain-b', title: 'Chain Beta', goal: 'B only' });
    const users = [];
    for (const [id, target] of [['chain-personal', { kind: 'personal' }], ['chain-a-seed', { kind: 'project', projectId: a.projectId }], ['chain-b-seed', { kind: 'project', projectId: b.projectId }]]) {
      h.adapter.script.push('REPLY_' + id);
      await service.send({ conversationId: 'main', commandId: id, text: id, target });
      const snapshot = await waitFor(service, value => value.messages.some(message => message.text === 'REPLY_' + id));
      users.push(snapshot.messages.find(message => message.commandId === id));
    }
    const [personal, alpha, beta] = users;
    const project = (source, text, key, extra = {}) => service.store.project({ ...source, commandId: null, nativeSeq: null,
      role: 'user', text, replyTo: null, state: { kind: 'completed' }, ...extra }, key);
    const longText = 'CHAIN_PARENT_' + 'x'.repeat(1986) + '😀' + '正文🦉'.repeat(1500) + 'EXACT_TAIL_7491';
    const parent = project(alpha, longText, 'chain-long-parent');
    const child = project(alpha, 'CHAIN_CHILD', 'chain-child', { replyTo: parent.id });
    const card = service.recall.read(alpha.source.sessionId, { query: 'CHAIN_CHILD' }).items[0];
    assert.equal(card.lookup.messageId, child.id);
    const childPage = service.recall.read(alpha.source.sessionId, args(card.lookup));
    assert.equal(childPage.replyTo.messageId, parent.id);
    assert.equal(childPage.content, 'CHAIN_CHILD');
    const parentArgs = args(childPage.replyTo);
    const parentCard = service.recall.read(alpha.source.sessionId, { query: 'CHAIN_PARENT_' }).items[0];
    assert.equal(parentCard.truncated, true);
    let cursor = parentArgs, recovered = '', pages = 0;
    while (cursor) {
      const page = service.recall.read(alpha.source.sessionId, cursor);
      assert.equal(page.offset, Buffer.byteLength(recovered));
      assert.ok(Buffer.byteLength(page.content) <= 2000);
      assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(page.content));
      assert.equal(page.coordinate, 'utf-8-bytes');
      recovered += page.content; pages++;
      cursor = page.next && args(page.next);
    }
    assert.ok(pages > 2); assert.equal(recovered, longText);
    assert.match(recovered, /EXACT_TAIL_7491$/);
    const emojiCard = project(alpha, '😀'.repeat(1700), 'chain-emoji-card');
    const emojiResult = service.recall.read(alpha.source.sessionId, { query: '😀' }).items.find(item => item.messageId === emojiCard.id);
    assert.equal(Array.from(emojiResult.excerpt).length, 1600); assert.equal(emojiResult.truncated, true);
    const exactEmoji = project(alpha, '🦉'.repeat(1600), 'chain-exact-emoji-card');
    assert.equal(service.recall.read(alpha.source.sessionId, { query: '🦉' }).items.find(item => item.messageId === exactEmoji.id).truncated, false);
    const foreignRead = sid => assert.throws(() => service.recall.read(sid, parentArgs), { code: 'FORBIDDEN' });
    foreignRead(beta.source.sessionId); foreignRead(personal.source.sessionId);
    const hidden = project(alpha, 'UNLINKED_CONVERSATION', 'chain-hidden', { conversationId: 'unlinked' });
    assert.throws(() => service.recall.read(alpha.source.sessionId, { messageId: hidden.id, expectedRevision: 'forged' }), { code: 'FORBIDDEN' });
    assert.throws(() => service.recall.read(alpha.source.sessionId, { ...parentArgs, messageId: randomUUID() }), { code: 'NOT_FOUND' });
    for (const offset of [-1, 0.5, Buffer.byteLength(longText) + 1, Number.MAX_SAFE_INTEGER, 2000])
      assert.throws(() => service.recall.read(alpha.source.sessionId, { ...parentArgs, offset }));
    assert.throws(() => service.recall.read(alpha.source.sessionId, { messageId: parent.id }));
    assert.throws(() => service.recall.read(alpha.source.sessionId, { ...parentArgs, query: 'mixed' }));
    assert.throws(() => service.recall.read(alpha.source.sessionId, { offset: 2000 }));
    const end = service.recall.read(alpha.source.sessionId, { ...parentArgs, offset: Buffer.byteLength(longText) });
    assert.equal(end.content, ''); assert.equal(end.next, null);
    const huge = project(alpha, 'HUGE_CHAIN_' + 'h'.repeat(2004000) + 'HUGE_TAIL', 'chain-huge');
    const hugeCard = service.recall.read(alpha.source.sessionId, { query: 'HUGE_CHAIN_' }).items[0];
    let hugePage = service.recall.read(alpha.source.sessionId, { ...args(hugeCard.lookup), offset: 2000000 });
    assert.equal(hugePage.nextOffset, 2002000);
    hugePage = service.recall.read(alpha.source.sessionId, args(hugePage.next));
    hugePage = service.recall.read(alpha.source.sessionId, args(hugePage.next));
    assert.equal(hugePage.hasMore, false); assert.ok(hugePage.content.endsWith('HUGE_TAIL'));
    assert.equal(hugePage.source.messageId, huge.id);
    const nulText = '\0NUL_CHAIN_' + 'n'.repeat(1987) + '\0😀\0' + 'after\0'.repeat(900);
    const nul = project(alpha, nulText, 'chain-nul');
    const nulCard = service.recall.read(alpha.source.sessionId, {}).items.find(item => item.messageId === nul.id);
    assert.equal(nulCard.excerpt, ''); assert.equal(nulCard.truncated, true);
    let nulArgs = args(nulCard.lookup), nulRecovered = '';
    while (nulArgs) {
      const page = service.recall.read(alpha.source.sessionId, nulArgs);
      assert.equal(page.totalBytes, Buffer.byteLength(nulText));
      nulRecovered += page.content; nulArgs = page.next && args(page.next);
    }
    assert.equal(nulRecovered, nulText);
    const bomText = '\ufeffBOM_CHAIN_' + 'b'.repeat(1987) + '\ufeff😀tail';
    const bom = project(alpha, bomText, 'chain-bom');
    const bomCard = service.recall.read(alpha.source.sessionId, { query: 'BOM_CHAIN_' }).items.find(item => item.messageId === bom.id);
    const bomFirst = service.recall.read(alpha.source.sessionId, args(bomCard.lookup));
    const bomSecond = service.recall.read(alpha.source.sessionId, args(bomFirst.next));
    assert.equal(bomFirst.nextOffset, 2000);
    assert.ok(bomFirst.content.startsWith('\ufeff')); assert.ok(bomSecond.content.startsWith('\ufeff'));
    assert.equal(bomFirst.content + bomSecond.content, bomText);

    const sharedText = 'AUTHORIZED_' + 'q'.repeat(1950) + 'QUOTE_TAIL';
    const donor = project(alpha, sharedText + ' PRIVATE_DONOR_TAIL', 'chain-donor');
    h.adapter.script.push('Selected excerpt received');
    await service.send({ conversationId: 'main', commandId: 'chain-quote', text: 'CHAIN_QUOTE', target: beta.scope,
      quote: { messageId: donor.id, expectedRevision: donor.revision, excerpt: sharedText } });
    await waitFor(service, value => value.messages.some(message => message.text === 'Selected excerpt received'));
    const sharedCard = service.recall.read(beta.source.sessionId, { query: 'CHAIN_QUOTE' }).items[0];
    assert.equal(sharedCard.quote.excerptTruncated, true);
    const sharedPage = service.recall.read(beta.source.sessionId, args(sharedCard.lookup));
    assert.equal(sharedPage.quote.excerpt, sharedText);
    assert.match(sharedPage.quote.excerpt, /QUOTE_TAIL$/);
    assert.doesNotMatch(JSON.stringify(sharedPage), /PRIVATE_DONOR_TAIL/);
    assert.equal(sharedPage.quote.lookup, undefined);
    const donorCard = service.recall.read(alpha.source.sessionId, { query: 'AUTHORIZED_' }).items[0];
    assert.throws(() => service.recall.read(beta.source.sessionId, args(donorCard.lookup)), { code: 'FORBIDDEN' });
    const crossParent = project(beta, 'CROSS_SCOPE_PARENT', 'chain-cross-parent', { replyTo: donor.id });
    const crossCard = service.recall.read(beta.source.sessionId, { query: crossParent.text }).items[0];
    assert.equal(crossCard.replyToLookup, null);
    assert.equal(service.recall.read(beta.source.sessionId, args(crossCard.lookup)).replyTo, null);

    const stale = project(alpha, 'STALE_CONTENT_' + 'm'.repeat(4000), 'chain-stale');
    const staleCard = service.recall.read(alpha.source.sessionId, { query: 'STALE_CONTENT_' }).items[0];
    const firstPage = service.recall.read(alpha.source.sessionId, args(staleCard.lookup));
    service.store.setState(stale.id, { kind: 'stopped', reason: 'New native evidence changed this message version' });
    assert.throws(() => service.recall.read(alpha.source.sessionId, args(firstPage.next)), { code: 'CONFLICT' });
    const oldSession = alpha.source.sessionId;
    await projects.handoff(a.projectId);
    assert.throws(() => service.recall.read(oldSession, parentArgs), { code: 'FORBIDDEN' });
    h.adapter.script.push('Current generation connected');
    await service.send({ conversationId: 'main', commandId: 'chain-new-generation', text: 'New generation', target: alpha.scope });
    const current = await waitFor(service, value => value.messages.some(message => message.text === 'Current generation connected'));
    const currentUser = current.messages.find(message => message.commandId === 'chain-new-generation');
    assert.equal(service.recall.read(currentUser.source.sessionId, parentArgs).content, longText.slice(0, 1999));
    await h.dispose(); h = await createNativeHarness({ dir, config }); service = h.ctx.taskSystem.steward;
    assert.equal(service.recall.read(currentUser.source.sessionId, parentArgs).content, longText.slice(0, 1999));
    assert.throws(() => service.recall.read(oldSession, parentArgs), { code: 'FORBIDDEN' });
    assert.throws(() => service.recall.read(beta.source.sessionId, parentArgs), { code: 'FORBIDDEN' });
    const restartCard = service.recall.read(currentUser.source.sessionId, { query: 'CHAIN_CHILD' }).items[0];
    assert.equal(service.recall.read(currentUser.source.sessionId, args(restartCard.lookup)).replyTo.messageId, parent.id);
  } finally { await h.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

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
      assert.throws(() => service.steward.recall.read(sid, { messageId: 'canonical-message', expectedRevision: 'version' }), owned);
      return { name: 'task_submit_result', args: { outcome: 'success', summary: 'Ordinary borrowed execution kept its allowed authority without steward reads' } };
    });
    const result = await service.native.executeExternal({ claim, sessionId: sid, resumeSession: true, workspacePath: h.dir, signal: new AbortController().signal });
    assert.equal(result.outcome, 'success');
    assert.equal(h.ctx.agents.get(sid), agent, 'Original WebUI lifecycle remains intact');
    assert.equal(service.native.scopeFor(agent), undefined, 'Owned role is released after completion');
    assert.throws(() => service.steward.recall.read(sid, {}), error => error.code === 'FORBIDDEN' && !/Owned task execution/.test(error.message));
  } finally { if (handle) await handle.dispose(); await h.dispose(); }
});
