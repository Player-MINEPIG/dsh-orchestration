import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../dist/index.js';

test('native Cordis plugin Config loads standalone rules service and unmount removes it', async () => {
  const ctx = new Context();
  const fiber = ctx.plugin(plugin, {}); await fiber;
  const service = ctx.get('typedDecisions'); assert.ok(service);
  const result = await service.evaluate({ requestId: 'native', stateHash: '1', context: {}, questions: [{ questionId: 'q', questionVersion: '1', type: 'noul', instructions: 'Yes?' }] });
  assert.equal(result.status, 'abstained'); assert.equal(result.answers.q.reason, 'no-matching-rule');
  await fiber.dispose();
  assert.equal(ctx.get('typedDecisions'), undefined);
  await assert.rejects(service.evaluate({ requestId: 'after-unload', stateHash: '1', context: {}, questions: [{ questionId: 'q', questionVersion: '1', type: 'noul', instructions: 'Yes?' }] }), /closed/);
});

test('native configuration rejects out-of-range retry/timeouts and invalid provider config', () => {
  assert.throws(() => plugin.Config({ timeoutMs: -1 }));
  assert.throws(() => plugin.Config({ maxAttempts: 100 }));
  assert.throws(() => plugin.Config({ providers: [{ kind: 'jev' }] }));
});

test('native structured adapter is optional, called with schema and cannot silently change effort', async () => {
  const ctx = new Context(); let captured;
  const adapterFiber = ctx.plugin({ name: 'test-completion', apply(ctx) {
    ctx.provide('typedDecisionCompletion', { complete: async input => {
      captured = input; return { modelVersion: 'pinned', output: { answers: { q: { type: 'noul', noul: 1 } } } };
    } });
  } });
  await adapterFiber;
  const fiber = ctx.plugin(plugin, { defaultProvider: 'model', providers: [{ id: 'model', kind: 'structured', models: [{ model: 'test-model', version: 'pinned', reasoningEfforts: ['high'] }] }] });
  await fiber;
  const request = { requestId: 'structured', stateHash: '1', context: {}, reasoningEffort: 'high', questions: [{ questionId: 'q', questionVersion: '1', type: 'noul', instructions: 'Yes?' }] };
  assert.equal((await ctx.typedDecisions.evaluate(request)).status, 'answered');
  assert.equal(captured.reasoningEffort, 'high'); assert.equal(captured.responseSchema.additionalProperties, false);
  await adapterFiber.dispose();
  const missing = await ctx.typedDecisions.evaluate({ ...request, requestId: 'provider-lost' });
  assert.equal(missing.error.code, 'provider-error');
  await fiber.dispose();
});
