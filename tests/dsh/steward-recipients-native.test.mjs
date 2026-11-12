import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startHost } from '../ci/browser-native-project.mjs';

async function completed(s, commandId) {
  for (let n = 0; n < 500; n++) {
    const result = await s.reconcile({ conversationId: 'main', commandId });
    if (result.commandMessage?.state.kind === 'completed') return result.commandMessage;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Real recipient request did not complete: ' + JSON.stringify({message:s.store.commandMessage('main', commandId)?.state,router:s.router.get(commandId)}));
}
async function ordinary(h, id, text, script) {
  h.model.script.push(...script);
  await h.ctx.taskSystem.steward.send({ conversationId: 'main', commandId: id, text, routeCreateTopic: true });
  return completed(h.ctx.taskSystem.steward, id);
}
const tool = (name, args) => ({ name, args });

test('a latest research source routes implementation to its existing sibling without sharing history or workspace grants; an exact reply stays at research', { timeout: 40000 }, async () => {
  const h = await startHost();
  try {
    const s = h.ctx.taskSystem.steward;
    const require = createRequire(join(process.env.DSH_OFFICIAL_ROOT, 'package.json'));
    await h.ctx.loader.create({ id: 'recipient-official-files', name: pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-fs')).href, config: { read: true, write: true, edit: true } });
    await h.ctx.loader.await();
    await s.configureRouting({ commandId: 'recipient-model', expectedRevision: 0, fallback: { provider: 'test-offline', model: 'script' } });
    const a = await ordinary(h, 'group-root', '共同讨论职责与产物', ['ROOT_PRIVATE_HISTORY']);
    const b = await ordinary(h, 'group-research', '研究来源和结论', [tool('write', { file_path: 'research.md', content: 'B_PRIVATE_RESEARCH_FILE' }), 'B_PRIVATE_RESEARCH_HISTORY']);
    const c = await ordinary(h, 'group-implementation', '实现代码和验证', [tool('write', { file_path: 'implementation.ts', content: 'C_PRIVATE_IMPLEMENTATION_FILE' }), 'C_PRIVATE_IMPLEMENTATION_HISTORY']);
    for (const [source, role, responsibility] of [[b, '研究', '核对 research.md 来源与结论'], [c, '实现', '修改 implementation.ts 并验证']]) {
      await s.topicRelationConfigure({ commandId: 'place-' + source.id, topic: { conversationId: 'main', scope: source.scope }, expectedRevision: 0, parent: a.scope, role, responsibility });
    }
    assert.equal(readFileSync(join(b.source.cwd, 'research.md'), 'utf8'), 'B_PRIVATE_RESEARCH_FILE');
    assert.equal(readFileSync(join(c.source.cwd, 'implementation.ts'), 'utf8'), 'C_PRIVATE_IMPLEMENTATION_FILE');
    const before = [a, b, c].map(message => ({ source: message.source, text: s.store.message(message.id).text }));
    h.model.script.push('B_LATEST_RESEARCH_REPLY');
    await s.send({ conversationId: 'main', commandId: 'research-latest-focus', replyTo: b.id, text: '核对这项研究的来源' });
    await completed(s, 'research-latest-focus');
    let readResult;
    const scriptErrors=[];
    const push=h.model.script.push.bind(h.model.script);
    h.model.script.push=(...entries)=>push(...entries.map(entry=>typeof entry==='function'?async request=>{try{return await entry(request)}catch(error){scriptErrors.push(String(error.stack??error));throw error}}:entry));
    h.ctx.on('tools/result', (exec, value) => { if (exec.name === 'read') readResult = value; });
    h.model.script.push(request => {
      const input=JSON.parse(request.messages[0].content.find(part=>part.type==='text').text);
      assert.equal(input.stage,'latest');
      assert.match(JSON.stringify(input),/修改 implementation\.ts 并验证/,'The outer topic router must see the sibling implementation responsibility');
      assert.doesNotMatch(JSON.stringify(input),/C_PRIVATE_IMPLEMENTATION_HISTORY|C_PRIVATE_IMPLEMENTATION_FILE/);
      return JSON.stringify({kind:'route',target:b.scope});
    }, request => {
      // The actual helper payload contains opaque seats and names, never donor history.
      const serialized = JSON.stringify(request.messages);
      assert.doesNotMatch(serialized, /B_PRIVATE_RESEARCH_HISTORY|C_PRIVATE_IMPLEMENTATION_HISTORY|B_PRIVATE_RESEARCH_FILE/);
      const objects = JSON.parse(request.messages.at(-1).content.find(part => part.type === 'text').text);
      const seats = objects.recipients ?? objects.input?.recipients;
      assert.equal(objects.stage, 'recipient');
      assert.equal(seats.length, 3);
      return JSON.stringify({ kind: 'recipient', id: seats.find(seat => seat.artifacts.includes('implementation.ts')).id });
    }, request => {
      const history = JSON.stringify(request.messages);
      assert.match(history, /C_PRIVATE_IMPLEMENTATION_HISTORY/);
      assert.doesNotMatch(history, /B_PRIVATE_RESEARCH_HISTORY|ROOT_PRIVATE_HISTORY/);
      return tool('read', { file_path: join(b.source.cwd, 'research.md') });
    }, () => {
      assert.equal(readResult?.isError, true, 'Logical membership does not grant sibling file reads');
      return 'IMPLEMENTATION_SIBLING_RECEIVED';
    });
    await s.send({ conversationId: 'main', commandId: 'implementation-next', routingMode: 'auto', text: '修改 implementation.ts 的代码' });
    const initial=s.store.commandMessage('main','implementation-next');
    assert.ok(initial, JSON.stringify({errors:scriptErrors,requests:h.model.requests.slice(-3).map(request=>({system:request.system,messages:request.messages})),router:s.router.get('implementation-next')}));
    const delivered = await completed(s, 'implementation-next');
    assert.equal(delivered.source.sessionId, c.source.sessionId);
    assert.deepEqual(delivered.recipient.topic, b.scope);
    assert.equal(delivered.recipient.reason, 'role');
    assert.equal(readFileSync(join(b.source.cwd, 'research.md'), 'utf8'), 'B_PRIVATE_RESEARCH_FILE');
    assert.equal(existsSync(join(b.source.cwd, 'implementation.ts')), false);
    h.model.script.push(request => {
      const history = JSON.stringify(request.messages);
      assert.match(history, /B_PRIVATE_RESEARCH_HISTORY/);
      assert.doesNotMatch(history, /C_PRIVATE_IMPLEMENTATION_HISTORY|IMPLEMENTATION_SIBLING_RECEIVED/);
      return 'REPLY_REMAINS_RESEARCH';
    });
    await s.send({ conversationId: 'main', commandId: 'research-exact-reply', replyTo: b.id, text: '继续核对这项来源' });
    const reply = await completed(s, 'research-exact-reply');
    assert.equal(reply.source.sessionId, b.source.sessionId);
    assert.equal(reply.recipient.reason, 'reply');
    assert.deepEqual([a, b, c].map(message => ({ source: s.store.message(message.id).source, text: s.store.message(message.id).text })), before);
    assert.equal(h.ctx.taskSystem.ledger.snapshot().tasks.length, 0);
    assert.equal(h.ctx.taskSystem.ledger.snapshot().runs.length, 0);
  } finally { await h.close(); }
});

test('an exact reply to an authorized source omitted from the eight-seat shortlist still reaches that original source without semantic inference', { timeout: 40000 }, async () => {
  const h = await startHost();
  try {
    const s = h.ctx.taskSystem.steward;
    const root = await ordinary(h, 'overflow-root', '普通总话题', ['ROOT_DONE']);
    const children = [];
    for (let n = 0; n < 9; n++) {
      const child = await ordinary(h, 'overflow-child-' + n, '具体讨论 ' + n, ['CHILD_PRIVATE_' + n]);
      await s.topicRelationConfigure({ commandId: 'overflow-place-' + n, topic: { conversationId: 'main', scope: child.scope }, expectedRevision: 0, parent: root.scope });
      children.push(child);
    }
    const listing = await s.topicSessions({ topic: { conversationId: 'main', scope: root.scope } });
    assert.equal(listing.complete, false);
    assert.equal(listing.seats.length, 8);
    const omitted = children.find(child => !listing.seats.some(seat => seat.source.sessionId === child.source.sessionId));
    assert.ok(omitted);
    const calls = h.model.requests.length;
    h.model.script.push('EXACT_OMITTED_REPLY_DONE');
    await s.send({ conversationId: 'main', commandId: 'omitted-reply', replyTo: omitted.id, text: '继续这条原会话' });
    const reply = await completed(s, 'omitted-reply');
    assert.equal(reply.source.sessionId, omitted.source.sessionId);
    assert.equal(h.model.requests.length, calls + 1);
    assert.equal(h.ctx.taskSystem.ledger.snapshot().runs.length, 0);
  } finally { await h.close(); }
});
