import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StewardConversations, stewardBindingKey } from '../dist/steward-conversations.js';
import { stewardSend } from '../dist/steward-contracts.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'steward-store-'));
  const path = join(dir, 'state.sqlite');
  let db = new DatabaseSync(path);
  db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT)');
  let store = new StewardConversations({ managementDatabase: () => db });
  return { get db() { return db; }, get store() { return store; },
    restart() { db.close(); db = new DatabaseSync(path); store = new StewardConversations({ managementDatabase: () => db }); },
    close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const personal = { kind: 'personal' };
const binding = { kind: 'personal', nodeId: 'host', sessionId: 'personal', generation: 1, cwd: '/isolated/personal' };
const request = (commandId, extra = {}) => stewardSend.parse({ conversationId: 'main', commandId, text: 'Hello', target: personal, ...extra });
function accept(f, input, scope = personal, source = binding) {
  f.store.resolveScope(input);
  return f.store.accept(input, scope, source, -1);
}
test('quotation attaches to the next message with current, explicit, or automatic routing independently of reply', () => {
  const quote = { messageId: 'source', expectedRevision: 0, excerpt: 'selected text' };
  for (const destination of [{ target: undefined }, { target: personal }, { target: undefined, routingMode: 'auto' }])
    assert.deepEqual(request('quote', { ...destination, quote }).quote, quote);
  assert.throws(() => request('quote-reply', { quote, replyTo: 'source' }), /cannot be combined with a reply/);
  assert.throws(() => request('quote-over-limit', { quote: { ...quote, excerpt: 'x'.repeat(2001) } }));
});
test('topic activity includes creation and exact window boundary, excludes expired/foreign/inaccessible activity, and reports the real latest message independently', () => {
  const f = fixture();
  try {
    const seed = accept(f, request('activity-seed'));
    const { id, seq, ...base } = seed;
    const observedAt = '2030-02-01T00:00:00.000Z', cutoffAt = '2030-01-02T00:00:00.000Z';
    const projects = ['boundary','expired','current','new'].map(projectId => ({ projectId, title: projectId, createdAt: projectId === 'new' ? '2030-01-31T00:00:00.000Z' : '2000-01-01T00:00:00.000Z' }));
    const add = (projectId, createdAt, conversationId = 'main') => f.store.project({ ...base, conversationId, role: 'notification', commandId: null,
      scope: { kind: 'project', projectId }, createdAt, state: { kind: 'completed' } }, `activity-${projectId}-${conversationId}`);
    add('boundary',cutoffAt);add('current','2030-01-30T00:00:00.000Z');
    add('hidden','2030-01-31T23:00:00.000Z');add('expired','2030-01-31T23:00:00.000Z','foreign');
    const latest = add('expired','2030-01-01T23:59:59.999Z');
    const activity = f.store.topicActivity('main',projects,30,observedAt);
    assert.equal(activity.cutoffAt,cutoffAt);assert.equal(activity.hasMore,false);
    assert.deepEqual(activity.items.map(item => item.scope.projectId),['new','current','boundary']);
    assert.equal(activity.items.at(-1).lastActiveAt,cutoffAt);
    assert.deepEqual(activity.latestMessage,{ id: latest.id, scope: latest.scope, source: latest.source, createdAt: latest.createdAt });
    assert.deepEqual(f.store.current('main'),personal,'Reading browse topics never changes the send destination');
    assert.equal(f.store.topicActivity('main',projects,1,observedAt).items.length,1);
    f.restart();assert.deepEqual(f.store.topicActivity('main',projects,30,observedAt),activity);
  } finally { f.close(); }
});
test('topic activity output is bounded and exposes truncation', () => {
  const f = fixture();
  try {
    const projects = Array.from({ length: 101 }, (_,n) => ({ projectId: `p${n}`, title: `Project ${n}`, createdAt: '2030-01-31T00:00:00.000Z' }));
    const activity = f.store.topicActivity('main',projects,30,'2030-02-01T00:00:00.000Z');
    assert.equal(activity.items.length,100);assert.equal(activity.hasMore,true);assert.equal(activity.latestMessage,null);
  } finally { f.close(); }
});
test('steward worker provenance follows exact admitted project commands and task ancestors, never a display title', () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT,data TEXT); CREATE TABLE pr_dispatch(task TEXT,decision TEXT); CREATE TABLE pr_turns(command TEXT,owner TEXT,session TEXT)");
    const scope = { kind: 'project', projectId: 'A' }, source = { ...binding, kind: 'managed', projectId: 'A' };
    const origin = accept(f, request('worker-origin', { target: scope }), scope, source);
    for (const [taskId,parentTaskId] of [['root',null],['child','root'],['grandchild','child'],['ordinary',null],['forged',null]])
      f.db.prepare('INSERT INTO entities VALUES(?,?,?)').run(taskId,'task',JSON.stringify({title:'管家 is only a name',parentTaskId}));
    f.db.prepare('INSERT INTO pr_dispatch VALUES(?,?)').run('root',`project-message:steward-${origin.id}`);
    f.db.prepare('INSERT INTO pr_turns VALUES(?,?,?)').run(`steward-${origin.id}`,'A',source.sessionId);
    assert.equal(f.store.isStewardTask('root'),true);assert.equal(f.store.isStewardTask('grandchild'),true);
    assert.equal(f.store.isStewardTask('ordinary'),false);
    f.db.prepare('INSERT INTO pr_dispatch VALUES(?,?)').run('forged','project-message:steward-not-a-canonical-message');
    assert.equal(f.store.isStewardTask('forged'),false);
    f.db.prepare("UPDATE pr_turns SET owner='different-project'").run();
    assert.equal(f.store.isStewardTask('root'),false,'A real command from another project does not establish origin');
    f.store.bindTask('main','root',origin.id);
    assert.equal(f.store.isStewardTask('grandchild'),true,'The durable accepted origin continues to prove descendants');
    f.restart();assert.equal(f.store.isStewardTask('grandchild'),true);
  } finally { f.close(); }
});
test('exact retry remains one durable user message after restart; changed retry rejects', () => {
  const f = fixture();
  try {
    const input = request('one'), message = accept(f, input);
    f.restart();
    assert.equal(f.store.replay(input).id, message.id);
    assert.equal(f.store.accept(input, personal, binding, -1).id, message.id);
    assert.equal(f.store.messages('main').length, 1);
    assert.equal(f.store.messages('main')[0].commandId, 'one');
    assert.throws(() => f.store.replay({ ...input, text: 'Different' }), { code: 'CONFLICT' });
    assert.throws(() => f.store.replay({ ...input, conversationId: 'other' }), { code: 'CONFLICT' });
  } finally { f.close(); }
});
test('reply chooses only its original conversation and scope', () => {
  const f = fixture();
  try {
    const a = { kind: 'project', projectId: 'A' };
    const b = { kind: 'managed', projectId: 'A', nodeId: 'host', sessionId: 'a', generation: 1, cwd: '/a' };
    const message = accept(f, request('a', { target: a }), a, b);
    const reply = request('reply', { target: undefined, replyTo: message.id });
    assert.deepEqual(f.store.resolveScope(reply), a);
    assert.throws(() => f.store.resolveScope({ ...reply, target: personal }), { code: 'CONFLICT' });
    assert.throws(() => f.store.resolveScope({ ...reply, conversationId: 'other' }), { code: 'FORBIDDEN' });
  } finally { f.close(); }
});
test('same session IDs on different owners or generations keep independent cursors', () => {
  const f = fixture();
  try {
    const scope = { kind: 'project', projectId: 'A' };
    const first = { kind: 'managed', projectId: 'A', nodeId: 'one', sessionId: 'same', generation: 1, cwd: '/a' };
    const second = { ...first, nodeId: 'two' };
    const third = { ...first, generation: 2 };
    for (const [i, source] of [first, second, third].entries()) accept(f, request('c' + i, { target: scope }), scope, source);
    const cursors = f.store.cursors('main');
    assert.equal(cursors.length, 3);
    assert.equal(new Set(cursors.map(c => stewardBindingKey(c.binding))).size, 3);
    f.store.saveCursor('main', { ...cursors[1], afterSeq: 29 });
    f.restart();
    assert.deepEqual(f.store.cursors('main').map(c => c.afterSeq).sort((a,b)=>a-b), [-1,-1,29]);
  } finally { f.close(); }
});
test('uncertain admission survives restart and blocks a second effect in the same scope', () => {
  const f = fixture();
  try {
    const message = accept(f, request('unknown'));
    f.store.setState(message.id, { kind: 'needs-reconciliation', reason: 'Receipt lost' });
    f.restart();
    assert.equal(f.store.replay(request('unknown')).state.kind, 'needs-reconciliation');
    assert.throws(() => accept(f, request('new')), { code: 'BUSY' });
    assert.equal(f.store.messages('main').length, 1);
    f.store.setState(message.id, { kind: 'completed' });
    assert.equal(accept(f, request('next')).role, 'user');
  } finally { f.close(); }
});
test('native and independent notification projections deduplicate across restart without changing selection', () => {
  const f = fixture();
  try {
    const message = accept(f, request('source'));
    const { id, seq, ...base } = message;
    const reply = { ...base, role: 'assistant', commandId: null, replyTo: id, text: 'Reply', nativeSeq: 10, state: { kind: 'completed' } };
    const one = f.store.project(reply, 'native-owner-session-generation:10');
    const notification = { ...reply, role: 'notification', text: 'Task started', nativeSeq: null };
    const two = f.store.project(notification, 'ledger:event-1');
    f.restart();
    assert.equal(f.store.project(reply, 'native-owner-session-generation:10').id, one.id);
    assert.equal(f.store.project(notification, 'ledger:event-1').id, two.id);
    assert.equal(f.store.messages('main').length, 3);
    assert.deepEqual(f.store.current('main'), personal);
    assert.equal(f.store.messages('main')[1].replyTo, id);
  } finally { f.close(); }
});
test('independent event checkpoint starts at subscription and advances monotonically', () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO events(data) VALUES(?)').run('{}');
    f.store.ensure('main');
    assert.equal(f.store.eventCursor('main'), 1);
    f.store.advanceEvents('main', 7);
    f.store.advanceEvents('main', 3);
    f.restart();
    assert.equal(f.store.eventCursor('main'), 7);
  } finally { f.close(); }
});
test('task origin remains the exact dispatch message after newer project conversation and restart', () => {
  const f = fixture();
  try {
    const scope = { kind: 'project', projectId: 'A' };
    const source = { kind: 'managed', projectId: 'A', nodeId: 'host', sessionId: 'a', generation: 1, cwd: '/a' };
    const original = accept(f, request('dispatch', { target: scope }), scope, source);
    f.store.bindTask('main', 'task-a', original.id);
    f.store.setState(original.id, { kind: 'completed' });
    const newer = accept(f, request('newer', { target: scope, text: 'Unrelated later question' }), scope, source);
    f.store.bindTask('main', 'task-a', newer.id);
    f.restart();
    assert.equal(f.store.taskOrigin('main', 'task-a').id, original.id);
    assert.equal(f.store.taskOrigin('other', 'task-a'), undefined);
  } finally { f.close(); }
});
test('human uncertainty closure is CAS protected, durable, never rewrites original request, and keeps later evidence', () => {
  const f = fixture();
  try {
    const input = request('crash-before-native'), message = accept(f, input);
    f.restart();
    const resolution = { conversationId: 'main', messageId: message.id, commandId: 'resolve-1',
      expectedRevision: 0, expectedState: 'accepted', confirm: true };
    assert.throws(() => f.store.release({ ...resolution, expectedRevision: 99 }), { code: 'CONFLICT' });
    const released = f.store.release(resolution);
    assert.equal(released.state.kind, 'released');
    assert.equal(released.resolution.priorState, 'accepted');
    assert.equal(f.store.replay(input).id, message.id, 'the original command still cannot send a new effect');
    f.restart();
    assert.equal(f.store.resolutionReplay(resolution).id, message.id);
    assert.throws(() => f.store.resolutionReplay({ ...resolution, expectedState: 'admitted' }), { code: 'CONFLICT' });
    accept(f, request('continue-after-explicit-resolution'));
    f.store.setState(message.id, { kind: 'completed' });
    const observed = f.store.message(message.id);
    assert.equal(observed.state.kind, 'completed');
    assert.equal(observed.resolution.commandId, 'resolve-1', 'later native evidence keeps the human decision');
  } finally { f.close(); }
});
test('native request evidence is immutable across restart and reads return the latest bounded window', () => {
  const f = fixture();
  try {
    const evidence = { id: 'request-0', conversationId: 'main', source: binding, stepSeq: 1,
      observedAt: '2026-10-30T00:00:00.000Z', requestHash: 'request-hash', messageHash: 'message-hash',
      selectedResources: [{ id: 'dsh-steward', version: '1' }], personaObserved: true, assemblerObserved: false, assemblyHash: null };
    f.store.observeRequest(evidence);
    f.store.observeRequest({ ...evidence, personaObserved: false });
    f.restart();
    assert.deepEqual(f.store.requests('main'), [evidence]);
    for(let i=1;i<55;i++) f.store.observeRequest({ ...evidence, id: `request-${i}`, stepSeq: i+1 });
    assert.equal(f.store.requests('main').length,50);
    assert.equal(f.store.requests('main')[0].id,'request-5');
    assert.equal(f.store.requests('other').length,0);
  } finally { f.close(); }
});
