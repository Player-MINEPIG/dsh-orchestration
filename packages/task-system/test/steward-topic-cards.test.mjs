import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StewardConversations } from '../dist/steward-conversations.js';
import { StewardTopicCards } from '../dist/steward-topic-cards.js';

const topic = (projectId = 'A', conversationId = 'main') => ({ conversationId, scope: { kind: 'project', projectId } });
const binding = projectId => ({ kind: 'managed', projectId, nodeId: 'host', sessionId: `session-${projectId}`, generation: 1, cwd: `/projects/${projectId}` });
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT)');
  const ledger = { managementDatabase: () => db }, store = new StewardConversations(ledger);
  const projects = new Map([['A', { id: 'A', title: 'Alpha', revision: '1', goal: 'Build the alpha system' }]]);
  const denied = new Set(), calls = { authorize: 0, projects: [], compact: 0 };
  const host = {
    async authorize(ref) {
      calls.authorize++;
      if (ref.conversationId !== 'main' || denied.has(ref.scope.projectId)) {
        const { TaskError } = await import('../dist/ledger.js');
        throw new TaskError('FORBIDDEN', 'No read access');
      }
      if (ref.scope.kind !== 'project') return { title: ref.scope.kind, binding: null, project: null };
      const project = projects.get(ref.scope.projectId);
      if (!project) {
        const { TaskError } = await import('../dist/ledger.js');
        throw new TaskError('NOT_FOUND', 'No such project');
      }
      return { title: project.title, binding: binding(project.id), project: { id: project.id, revision: project.revision, goal: project.goal } };
    },
    async projects(input) {
      calls.projects.push(input);
      const all = [...projects.values()].filter(project => !input.query || `${project.title} ${project.goal}`.toLowerCase().includes(input.query.toLowerCase()));
      return { items: all.slice(input.page * input.limit, (input.page + 1) * input.limit).map(project => ({ projectId: project.id, title: project.title, summary: project.goal })),
        hasMore: (input.page + 1) * input.limit < all.length };
    },
  };
  const cards = new StewardTopicCards(ledger, host);
  let serial = 0;
  function add(text, { projectId = 'A', conversationId = 'main', role = 'user' } = {}) {
    serial++;
    return store.project({ conversationId, role, text, scope: { kind: 'project', projectId }, source: binding(projectId), commandId: null,
      replyTo: null, createdAt: `2030-01-01T00:00:${String(serial % 60).padStart(2, '0')}Z`, nativeSeq: null,
      state: { kind: 'completed' }, manifest: { persona: { id: 'dsh-steward', version: '1' }, scope: { kind: 'project', projectId }, history: 'scope-native-session', evidence: 'selection-only', resources: [] } }, `message-${serial}`);
  }
  function compact(fn) {
    host.compact = async (input, signal) => { calls.compact++; return fn(input, signal); };
  }
  return { db, store, projects, denied, calls, cards, host, add, compact, close: () => db.close() };
}
function generated(id, original, text = original.text) {
  return { id, section: 'constraint', text, origin: 'generated', state: 'active', sources: [original.source] };
}
function result(facts, originals, supersessions = []) {
  return { summary: 'Unsupported arbitrary summary must never be displayed', facts,
    evidence: facts.flatMap(fact => fact.sources.map(source => ({ factId: fact.id, source, quote: originals.find(original => original.source.id === source.id).text }))), supersessions };
}
const through = Number.MAX_SAFE_INTEGER;
const context = (f, maintain = false, ref = topic()) => f.cards.context({ topic: ref, throughSeq: through, maintain });
const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('short histories quote scoped originals directly without invoking a model or creating sessions', async () => {
  const f = fixture();
  try {
    f.add('Keep all data in Australia'); f.add('The schema is ready', { role: 'assistant' });
    f.add('Foreign secret', { conversationId: 'foreign' }); f.add('Other project secret', { projectId: 'B' });
    f.compact(() => { throw new Error('Should never call for short history'); });
    const value = await context(f, true);
    assert.equal(value.complete, true); assert.equal(value.card.freshness, 'current');
    assert.deepEqual(value.originals.map(original => original.text), ['Keep all data in Australia', 'The schema is ready']);
    assert.ok(bytes(value) <= 10240); assert.equal(f.calls.compact, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM steward_sources').get().count, 0);
    assert.equal(f.store.conversationIds().length, 0, 'Card reads do not create conversations');
  } finally { f.close(); }
});

test('long history maintenance processes one bounded oldest batch and retains omitted active facts', async () => {
  const f = fixture();
  try {
    f.add('Keep all data in Australia');
    for (let index = 0; index < 16; index++) f.add(`Progress ${index}`, { role: 'assistant' });
    f.compact(({ delta }) => { assert.ok(delta.length <= 16); assert.ok(bytes(delta) <= 8192); return result([generated('region', delta[0])], delta); });
    const first = await context(f, true);
    assert.equal(f.calls.compact, 1); assert.equal(first.card.coverageSeq, 16); assert.equal(first.card.freshness, 'stale');
    assert.equal(first.card.facts.find(fact => fact.id === 'region').text, 'Keep all data in Australia');
    f.compact(() => ({ summary: 'Forget the region', facts: [], evidence: [] }));
    const second = await context(f, true);
    assert.equal(f.calls.compact, 2); assert.equal(second.card.coverageSeq, 17);
    assert.equal(second.card.facts.find(fact => fact.id === 'region').state, 'active');
    assert.equal(second.card.summary, 'Build the alpha system', 'Overview is deterministically derived from sourced facts');
  } finally { f.close(); }
});

test('later user evidence supersedes a constraint while preserving its original provenance', async () => {
  const f = fixture();
  try {
    f.add('Keep all data in Australia');
    for (let index = 0; index < 15; index++) f.add(`Progress ${index}`, { role: 'assistant' });
    f.add('I replace the Australia requirement: allow New Zealand too');
    f.compact(({ delta }) => result([generated('region', delta[0])], delta));
    await context(f, true);
    f.compact(({ delta }) => result([generated('region-v2', delta[0])], delta, [{ factId: 'region', replacementId: 'region-v2', source: delta[0].source, quote: delta[0].text }]));
    const value = await context(f, true), old = value.card.facts.find(fact => fact.id === 'region');
    assert.equal(old.state, 'superseded'); assert.equal(old.supersededBy, 'region-v2');
    assert.equal(old.sources[0].seq, 1); assert.equal(value.card.facts.find(fact => fact.id === 'region-v2').state, 'active');
  } finally { f.close(); }
});

test('assistant text cannot authorize supersession and invalid output preserves prior facts', async () => {
  const f = fixture();
  try {
    f.add('Keep all data in Australia');
    for (let index = 0; index < 16; index++) f.add(`Assistant suggests change ${index}`, { role: 'assistant' });
    f.compact(({ delta }) => result([generated('region', delta[0])], delta)); await context(f, true);
    f.compact(({ delta }) => result([generated('replacement', delta[0])], delta, [{ factId: 'region', replacementId: 'replacement', source: delta[0].source, quote: delta[0].text }]));
    const value = await context(f, true);
    assert.equal(value.card.freshness, 'insufficient'); assert.equal(value.card.coverageSeq, 16);
    assert.equal(value.card.facts.find(fact => fact.id === 'region').state, 'active'); assert.equal(value.card.facts.some(fact => fact.id === 'replacement'), false);
  } finally { f.close(); }
});

test('fabricated evidence and unknown source references fail before replacing a card', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 17; index++) f.add(`Message ${index}`);
    f.compact(({ delta }) => ({ summary: 'invented', facts: [generated('bad', delta[0], 'Data can leave Australia')], evidence: [{ factId: 'bad', source: delta[0].source, quote: 'This quote never appeared' }] }));
    const value = await context(f, true);
    assert.equal(value.card.freshness, 'insufficient'); assert.equal(value.card.coverageSeq, 0);
    assert.equal(value.card.facts.some(fact => fact.id === 'bad'), false); assert.match(value.card.coverageReason, /未通过来源校验/);
  } finally { f.close(); }
});

test('source reads enforce conversation, scope, exact revision, binding, and current authorization', async () => {
  const f = fixture();
  try {
    f.add('Authorized original');
    const ref = (await context(f)).originals[0].source;
    assert.equal((await f.cards.source({ conversationId: 'main', ref })).content, 'Authorized original');
    await assert.rejects(f.cards.source({ conversationId: 'foreign', ref }), { code: 'FORBIDDEN' });
    await assert.rejects(f.cards.source({ conversationId: 'main', ref: { ...ref, scope: { kind: 'project', projectId: 'B' } } }), { code: 'NOT_FOUND' });
    await assert.rejects(f.cards.source({ conversationId: 'main', ref: { ...ref, revision: 99 } }), { code: 'CONFLICT' });
    await assert.rejects(f.cards.source({ conversationId: 'main', ref: { ...ref, binding: { ...ref.binding, sessionId: 'forged' } } }), { code: 'CONFLICT' });
    f.denied.add('A');
    await assert.rejects(f.cards.source({ conversationId: 'main', ref }), { code: 'FORBIDDEN' });
    await assert.rejects(context(f), { code: 'FORBIDDEN' });
  } finally { f.close(); }
});

test('message and authoritative source pages use exact UTF-8 byte coordinates', async () => {
  const f = fixture();
  try {
    f.add('中'.repeat(1000));
    const ref = (await context(f)).originals[0].source;
    const first = await f.cards.source({ conversationId: 'main', ref });
    assert.equal(Buffer.byteLength(first.content), 1998); assert.equal(first.nextOffset, 1998); assert.equal(first.totalBytes, 3000);
    const second = await f.cards.source({ conversationId: 'main', ref, offset: first.nextOffset });
    assert.equal(first.content + second.content, '中'.repeat(1000)); assert.equal(second.nextOffset, null);
    await assert.rejects(f.cards.source({ conversationId: 'main', ref, offset: 1 }), { code: 'INVALID' });
    await assert.rejects(f.cards.source({ conversationId: 'main', ref, offset: 3001 }), { code: 'INVALID' });
    const projectRef = { kind: 'project', id: 'A', revision: '1' };
    assert.equal((await f.cards.source({ conversationId: 'main', ref: projectRef })).content, 'Build the alpha system');
    f.projects.get('A').revision = '2';
    await assert.rejects(f.cards.source({ conversationId: 'main', ref: projectRef }), { code: 'CONFLICT' });
  } finally { f.close(); }
});

test('canonical revision changes invalidate previous generated facts and their exact source pages', async () => {
  const f = fixture();
  try {
    const first = f.add('Keep all data in Australia');
    for (let index = 0; index < 16; index++) f.add(`Progress ${index}`);
    f.compact(({ delta }) => result([generated('region', delta[0])], delta));
    const before = await context(f, true), ref = before.card.facts.find(fact => fact.id === 'region').sources[0];
    f.store.setState(first.id, { kind: 'released' });
    const after = await context(f);
    assert.equal(after.card.facts.some(fact => fact.id === 'region'), false); assert.equal(after.card.coverageSeq, 0);
    await assert.rejects(f.cards.source({ conversationId: 'main', ref }), { code: 'CONFLICT' });
  } finally { f.close(); }
});

test('derived term index finds bounded cards without supplying all project histories', async () => {
  const f = fixture();
  try {
    f.projects.get('A').goal = '';
    f.add('UniqueNebula operational requirement'); await context(f);
    for (let index = 0; index < 10; index++) f.projects.set(`P${index}`, { id: `P${index}`, title: `Nebula ${index}`, revision: '1', goal: 'A relevant goal' });
    const candidates = await f.cards.candidates({ conversationId: 'main', queries: ['UniqueNebula', 'Nebula'], exclude: { kind: 'personal' }, limit: 4 });
    assert.equal(candidates[0].topic.scope.projectId, 'A'); assert.ok(candidates.length <= 4);
    assert.ok(candidates.every(card => bytes(card) <= 2048)); assert.ok(bytes(candidates) <= 8192);
    assert.ok(f.calls.projects.every(call => call.page === 0 && call.limit === 4));
    f.denied.add('A');
    const denied = await f.cards.candidates({ conversationId: 'main', queries: ['UniqueNebula'], exclude: { kind: 'personal' } });
    assert.equal(denied.length, 0);
  } finally { f.close(); }
});

test('personal history is a candidate only when its indexed terms match the request', async () => {
  const f = fixture(), personal = { conversationId: 'main', scope: { kind: 'personal' } };
  try {
    f.store.accept({ commandId: 'personal-research', conversationId: 'main', text: 'UniqueNebula release prediction' }, personal.scope,
      { kind: 'personal', nodeId: 'host', sessionId: 'personal', generation: 1, cwd: '/personal' }, 0);
    await context(f, false, personal);
    const matched = await f.cards.candidates({ conversationId: 'main', queries: ['UniqueNebula'], exclude: topic().scope });
    assert.deepEqual(matched.map(card => card.topic.scope), [personal.scope]);
    const excluded = await f.cards.candidates({ conversationId: 'main', queries: ['UniqueNebula'], exclude: personal.scope });
    assert.deepEqual(excluded, []);
    const unrelated = await f.cards.candidates({ conversationId: 'main', queries: ['ElectionPolicy'], exclude: topic().scope });
    assert.deepEqual(unrelated, [], 'Unrelated personal history must not turn an empty search into a model candidate');
    assert.equal(f.calls.compact, 0);
  } finally { f.close(); }
});

test('overview is compact, paged, deterministic, and never invokes maintenance', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 24; index++) f.projects.set(`P${index}`, { id: `P${index}`, title: `Project ${index}`, revision: '1', goal: `Goal ${index}` });
    f.compact(() => { throw new Error('Overview must not compact'); });
    const first = await f.cards.list({ conversationId: 'main' });
    assert.equal(first.items.length, 12); assert.equal(first.hasMore, true); assert.ok(first.nextCursor);
    assert.ok(first.items.every(item => !('facts' in item) && !('sources' in item)));
    const second = await f.cards.list({ conversationId: 'main', cursor: first.nextCursor });
    const third = await f.cards.list({ conversationId: 'main', cursor: second.nextCursor });
    assert.equal(second.items.length, 12); assert.equal(third.items.length, 1); assert.equal(third.hasMore, false);
    assert.equal(new Set([...first.items, ...second.items, ...third.items].map(item => item.topic.scope.projectId)).size, 25);
    assert.equal(f.calls.compact, 0);
    await assert.rejects(f.cards.list({ conversationId: 'main', query: 'different', cursor: first.nextCursor }), { code: 'CONFLICT' });
  } finally { f.close(); }
});

test('oversized histories and authoritative goals expose missing coverage within the context budget', async () => {
  const f = fixture();
  try {
    f.add('中'.repeat(12000));
    f.projects.get('A').goal = 'A'.repeat(8000);
    const value = await context(f, true);
    assert.equal(value.complete, false); assert.equal(value.card.freshness, 'insufficient'); assert.ok(bytes(value) <= 10240);
    assert.equal(value.card.facts.length, 0); assert.equal(value.card.sources[0].kind, 'project'); assert.match(value.card.coverageReason, /预算|未整理|未纳入/);
    const source = await f.cards.source({ conversationId: 'main', ref: value.card.sources[0] });
    assert.equal(source.totalBytes, 8000); assert.equal(source.content.length, 2000);
  } finally { f.close(); }
});

test('concurrent actual requests share one bounded maintenance job per topic', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 17; index++) f.add(`Progress ${index}`);
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    f.compact(async ({ delta }) => { await pending; return result([generated('first', delta[0])], delta); });
    const first = context(f, true), second = context(f, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.compact, 1); finish();
    const values = await Promise.all([first, second]);
    assert.ok(values.every(value => value.card.coverageSeq === 16)); assert.equal(f.calls.compact, 1);
  } finally { f.close(); }
});

test('short extractive overview caches invalidate exact message references even before summary coverage exists', async () => {
  const f = fixture();
  try {
    f.projects.get('A').goal = '';
    const message = f.add('Keep the original requirement');
    await context(f);
    const before = await f.cards.list({ conversationId: 'main' });
    assert.match(before.items[0].summary, /original requirement/);
    const value = f.store.message(message.id);
    f.db.prepare('UPDATE steward_messages SET data=? WHERE id=?').run(JSON.stringify({ ...value, text: 'User changed this requirement', revision: value.revision + 1 }), message.id);
    const after = await f.cards.list({ conversationId: 'main' });
    assert.doesNotMatch(after.items[0].summary, /original requirement/);
    const refreshed = await context(f);
    assert.equal(refreshed.originals[0].text, 'User changed this requirement');
    assert.match(refreshed.card.summary, /User changed/);
  } finally { f.close(); }
});

test('fact-count overflow preserves earlier active constraints and exposes insufficient coverage', async () => {
  const f = fixture();
  try {
    f.add('Keep all data in Australia');
    for (let index = 0; index < 16; index++) f.add(`Progress ${index}`);
    f.compact(({ delta }) => result([generated('region', delta[0])], delta));
    await context(f, true);
    f.compact(({ delta }) => result(Array.from({ length: 32 }, (_, index) => generated(`overflow-${index}`, delta[0])), delta));
    const value = await context(f, true);
    assert.equal(value.card.freshness, 'insufficient'); assert.equal(value.card.coverageSeq, 16);
    assert.equal(value.card.facts.find(fact => fact.id === 'region').state, 'active');
    assert.equal(value.card.facts.some(fact => fact.id.startsWith('overflow-')), false);
  } finally { f.close(); }
});

test('maintenance shares only the originating request call budget and abort signal', async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    let claims = 0;
    const requestBudget = { signal: controller.signal, claimCall() { claims++; } };
    f.add('Original request');
    f.compact(({ delta }, signal) => { assert.equal(signal, controller.signal); return result([generated('first', delta[0])], delta); });
    await f.cards.context({ topic: topic(), throughSeq: through, maintain: true, requestBudget });
    assert.equal(claims, 0, 'Literal histories consume no provider call');
    for (let index = 0; index < 16; index++) f.add(`Progress ${index}`);
    await f.cards.context({ topic: topic(), throughSeq: through, maintain: true, requestBudget });
    assert.equal(claims, 1); assert.equal(f.calls.compact, 1);
    controller.abort();
    const value = await f.cards.context({ topic: topic(), throughSeq: through, maintain: true, requestBudget });
    assert.equal(claims, 1); assert.equal(f.calls.compact, 1); assert.equal(value.card.coverageSeq, 16);
    assert.equal(value.card.freshness, 'insufficient');
  } finally { f.close(); }
});

test('later recipient clarification constraints remain in versioned topic originals and exact source pages, separate from original text',async()=>{const f=fixture();try{f.store.ensure('main');const input={conversationId:'main',commandId:'clarified',text:'做X',target:{kind:'project',projectId:'A'}};const message=f.store.accept(input,input.target,binding('A'),-1,null,{routingClarification:{questionId:'q',question:'交给哪个项目？',answers:[{commandId:'answer',text:'给A，但只调研先别实现'}]}});const context=await f.cards.context({topic:topic(),throughSeq:message.seq,maintain:false});assert.equal(f.store.message(message.id).text,'做X');assert.match(context.originals[0].text,/给A，但只调研先别实现/);const page=await f.cards.source({conversationId:'main',ref:context.originals[0].source,offset:0});assert.match(page.content,/做X/);assert.match(page.content,/给A，但只调研先别实现/);}finally{f.close();}});

test('last discussion is the latest scoped user/assistant original and its own timestamp; notifications, goals, refreshes and foreign conversations never replace it',async()=>{const f=fixture();try{f.projects.set('B',{id:'B',title:'Beta',revision:'1',goal:'This is a goal, not a discussion'});f.add('用户请求');const assistant=f.add('助手真正回复',{role:'assistant'});f.add('较晚通知',{role:'notification'});f.add('别的窗口请求',{conversationId:'other'});const list=()=>f.cards.list({conversationId:'main'});let page=await list();assert.deepEqual(page.items.find(item=>item.topic.scope.projectId==='A').lastDiscussion,{role:'assistant',excerpt:'助手真正回复',at:assistant.createdAt,hasAttachments:false,truncated:false});assert.equal(page.items.find(item=>item.topic.scope.projectId==='B').lastDiscussion,null);assert.equal((await list()).items.find(item=>item.topic.scope.projectId==='A').lastDiscussion.at,assistant.createdAt);const latest=f.add('新请求'+ '字'.repeat(400));page=await list();const last=page.items.find(item=>item.topic.scope.projectId==='A').lastDiscussion;assert.equal(last.role,'user');assert.equal(last.at,latest.createdAt);assert.equal(Array.from(last.excerpt).length,160);assert.equal(last.truncated,true);assert.equal(f.calls.compact,0);}finally{f.close();}});

test('attachment-only last discussion remains factual without inventing text or changing its source',async()=>{const f=fixture();try{f.store.ensure('main');const input={conversationId:'main',commandId:'file-only-discussion',text:'',target:{kind:'project',projectId:'A'}};const message=f.store.accept(input,input.target,binding('A'),-1,null,{content:[{type:'file',attachment:{attachmentId:'test-file-ref',name:'proof.txt',bytes:3}}]});f.add('只是一条较晚通知',{role:'notification'});const last=(await f.cards.list({conversationId:'main'})).items.find(item=>item.topic.scope.projectId==='A').lastDiscussion;assert.deepEqual(last,{role:'user',excerpt:'',at:message.createdAt,hasAttachments:true,truncated:false});assert.equal(f.store.message(message.id).text,'');assert.equal(f.calls.compact,0);}finally{f.close();}});
