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
    h.adapter.script.push('Early synthetic entry recorded.');
    await service.send({conversationId: 'main', commandId: 'compact-early', text: `${early}: synthetic remembered value is cobalt. ${'Earlier synthetic context. '.repeat(500)}`, target: {kind: 'personal'}});
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
    h.adapter.script.push(request => {
      const serialized = JSON.stringify(request.messages);
      assert.doesNotMatch(serialized, new RegExp(early), 'The old exact value must have left the active surface');
      assert.equal((serialized.match(/\[persona dsh-steward@1\]/g) ?? []).length, 1);
      return {name: 'steward_recall', args: {query: early, limit: 3}};
    }, request => {
      const serialized = JSON.stringify(request.messages);
      assert.match(serialized, new RegExp(early));
      assert.match(serialized, /dataOnly/);
      assert.match(serialized, /历史资料/);
      assert.equal((serialized.match(/\[persona dsh-steward@1\]/g) ?? []).length, 1);
      assert.doesNotMatch(JSON.stringify(request.messages.filter(message => message.role === 'system')), new RegExp(early));
      return 'Recovered cobalt from scoped historical data after official compaction.';
    });
    await service.send({conversationId: 'main', commandId: 'compact-recall', text: 'Use scoped archive lookup to recover the exact earlier synthetic value.', target: {kind: 'personal'}});
    const restored = await waitFor(service, 'compact-recall');
    assert.equal(h.adapter.requests.length, countBeforeRecall + 2);
    assert.ok(restored.messages.some(message => message.text.startsWith(early)), 'Canonical history remains intact after native surface compaction');
    assert.ok(restored.messages.some(message => message.text === 'Recovered cobalt from scoped historical data after official compaction.'));
  } finally { await h.dispose(); }
});
