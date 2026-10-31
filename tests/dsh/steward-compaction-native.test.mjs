import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createNativeHarness} from './native-harness.mjs';
import {attachOfficialCompaction} from './steward-live-provider.mjs';
import {mountStewardMemory, stewardMemoryAvailable} from './fixtures/steward-memory-host.mjs';

const official = resolve('.runtime/official-dsh-0.2.1-rc.2');
const available = stewardMemoryAvailable && existsSync(resolve(official, 'node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'));
async function waitFor(service, commandId) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const snapshot = await service.reconcile({conversationId: 'main'});
    if (snapshot.messages.some(message => message.commandId === commandId && message.state.kind === 'completed')) return snapshot;
    await new Promise(done => setTimeout(done, 20));
  }
  throw Error('Compaction native turn did not settle');
}

test('official compaction replaces a small-context native surface while persona and scoped canonical recall survive', {skip: available ? false : 'requires installed official compaction and pinned optional memory sources', timeout: 40000}, async () => {
  const h = await createNativeHarness({config: {role: 'both', schedulerEnabled: false, projectAgentOptions: {provider: 'test-offline', model: 'script'}}});
  try {
    h.adapter.resolveModel = (provider, model) => ({provider, id: model, name: 'Small native compaction fixture', context: {contextWindow: 4096}, defaultMaxTokens: 256});
    const memory = await mountStewardMemory(h);
    await memory.configure({kind: 'personal'}, {commandId: 'compact-memory-personal'});
    const {compaction, tokenMeter, version} = await attachOfficialCompaction(h.ctx, {runtimeRoot: official});
    assert.equal(version, '0.2.1-rc.2');
    const service = h.ctx.taskSystem.steward;
    const early = 'EARLY_CANONICAL_EXACT_7491';
    const tail = 'CANONICAL_SPILL_TAIL_9286';
    let recalled;
    h.ctx.on('tools/result', (exec, result) => {
      if (exec.name === 'steward_recall' && !result.isError)
        recalled = JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    });
    h.adapter.script.push('Early synthetic entry recorded.');
    await service.send({conversationId: 'main', commandId: 'compact-early', text: `${early}: synthetic remembered value is cobalt. ${'Earlier synthetic context. '.repeat(500)}${tail}`, target: {kind: 'personal'}});
    const first = await waitFor(service, 'compact-early');
    const user = first.messages.find(message => message.commandId === 'compact-early');
    const agent = h.ctx.agents.get(SessionId(user.source.sessionId));
    assert.ok(agent);
    assert.equal(agent.status, 'idle');
    const generation = agent.session.surface.replaceGeneration;
    const before = tokenMeter.measure(agent.session).totalTokens;
    h.adapter.script.push('Earlier synthetic work was condensed. Exact prior values are available through the scoped canonical archive.');
    const compacted = await compaction.compactNow(agent, new AbortController().signal, 'forced-small-context');
    assert.ok(compacted?.shadowedSeqs.length, 'The official backend must commit a real surface replacement');
    assert.ok(agent.session.surface.replaceGeneration > generation);
    assert.ok(tokenMeter.measure(agent.session).totalTokens < before);
    const countBeforeRecall = h.adapter.requests.length;
    let fullText = '', pages = 0;
    const follow = request => {
      const serialized = JSON.stringify(request.messages);
      assert.ok(recalled?.dataOnly, 'Actual native tool results must remain historical data');
      if (recalled.kind === 'steward-scoped-history') {
        const {tool: _tool, ...args} = recalled.items.find(item => item.messageId === user.id).lookup;
        h.adapter.script.push(follow);
        return {name: 'steward_recall', args};
      }
      assert.equal(recalled.kind, 'steward-scoped-message'); pages++;
      fullText += recalled.content;
      if (recalled.next) {
        const {tool: _tool, ...args} = recalled.next;
        h.adapter.script.push(follow);
        return {name: 'steward_recall', args};
      }
      assert.equal(fullText, user.text);
      assert.ok(fullText.endsWith(tail));
      assert.match(serialized, new RegExp(tail));
      assert.doesNotMatch(JSON.stringify(request.messages.filter(message => message.role === 'system')), new RegExp(tail));
      assert.equal((serialized.match(/\[persona dsh-steward@1\]/g) ?? []).length, 1);
      return 'Recovered cobalt and the complete historical tail after official compaction.';
    };
    h.adapter.script.push(request => {
      const serialized = JSON.stringify(request.messages);
      assert.doesNotMatch(serialized, new RegExp(early), 'The old exact value must have left the active surface');
      assert.equal((serialized.match(/\[persona dsh-steward@1\]/g) ?? []).length, 1);
      return {name: 'steward_recall', args: {query: early, limit: 3}};
    }, follow);
    await service.send({conversationId: 'main', commandId: 'compact-recall', text: 'Use scoped archive lookup to recover the exact earlier synthetic value.', target: {kind: 'personal'}});
    const restored = await waitFor(service, 'compact-recall');
    assert.equal(h.adapter.requests.length, countBeforeRecall + pages + 2);
    assert.ok(pages > 2);
    assert.ok(restored.messages.some(message => message.text.startsWith(early)), 'Canonical history remains intact after native surface compaction');
    assert.ok(restored.messages.some(message => message.text === 'Recovered cobalt and the complete historical tail after official compaction.'));
  } finally { await h.dispose(); }
});
