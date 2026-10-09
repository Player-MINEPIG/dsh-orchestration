import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Config } from '../dist/dsh-completion.js';

const success = '{"answers":{"q":{"type":"noul","noul":0.75}}}';
const request = (requestId = 'one', extra = {}) => ({ requestId, stateHash: 'state-1', context: { evidence: 'bounded facts' }, questions: [{ questionId: 'q', questionVersion: '1', type: 'noul', instructions: 'Does the evidence support the claim?' }], ...extra });
const route = { model: 'judge', modelVersion: 'test-model-2026-09', provider: 'test-offline', reasoningEfforts: ['low', 'high'] };
const limits = { maxOutputTokens: 256, maxInputBytes: 16384, maxOutputBytes: 16384, maxRuntimeMs: 1000, maxConcurrent: 2 };
function* textChunks(text = success, finish = true) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 5 } };
  if (finish) yield { type: 'finish', reason: { kind: 'stop' } };
}
class StubModel extends LlmAdapter {
  requests = []; resolved = []; finished = 0;
  constructor(script, efforts = ['low', 'high']) { super(); this.script = [...script]; this.efforts = efforts; }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted(); this.resolved.push({ provider, model });
    return { provider, id: model, name: model, ...(this.efforts.length ? { reasoning: { efforts: this.efforts.map(id => ({ id, name: id })) } } : {}) };
  }
  async *stream(options) {
    this.requests.push(options);
    try {
      const entry = this.script.shift() ?? success;
      if (entry === 'hang') {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        await delay(60000, undefined, { signal: options.signal });
      } else if (Array.isArray(entry)) yield* entry;
      else yield* textChunks(entry);
    } finally { this.finished++; }
  }
}
async function harness(t, { script = [success], config = {}, efforts, versionSource = 'configured-pin', timeoutMs = 2000 } = {}) {
  const ctx = new Context();
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(fileURLToPath(new URL('../package.json', import.meta.url))).href });
  const rows = [
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'completion', name: './dist/dsh-completion.js', config: { routes: [route], ...limits, ...config } },
    { id: 'decisions', name: './dist/index.js', config: { defaultProvider: 'ordinary', timeoutMs, failureLimit: 20, providers: [{ id: 'ordinary', kind: 'structured', models: [{ model: route.model, version: route.modelVersion, versionSource, reasoningEfforts: route.reasoningEfforts }] }] } },
  ];
  await ctx.loader.root.update(structuredClone(rows));
  await ctx.loader.await();
  assert.ok(ctx.get('typedDecisionCompletion'), 'native completion must load through real DSH Loader');
  assert.ok(ctx.get('typedDecisions'));
  const adapter = new StubModel(script, efforts);
  ctx.llm.registerAdapter(['test-offline'], adapter);
  t.after(async () => { await ctx.fiber.dispose(); });
  return { ctx, adapter, rows, completion: ctx.get('typedDecisionCompletion') };
}
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(5); }
  assert.fail('condition did not settle');
}

test('real DSH Loader composes standalone ordinary decisions with a tool-free native call and honest version source', async t => {
  const { ctx, adapter, completion } = await harness(t);
  const receipt = await ctx.typedDecisions.evaluate(request('one', { reasoningEffort: 'high' }));
  assert.equal(receipt.status, 'answered'); assert.equal(receipt.answers.q.noul, 0.75);
  assert.equal(receipt.modelVersion, route.modelVersion); assert.equal(receipt.modelVersionSource, 'configured-pin');
  assert.equal(ctx.typedDecisions.capabilities().models[0].versionSource, 'configured-pin');
  assert.deepEqual(receipt.usage, { input_tokens: 15, output_tokens: 5 });
  assert.deepEqual(receipt.evidence, { kind: 'structured-output', calibration: 'none' });
  const sent = adapter.requests[0];
  assert.equal(sent.provider, route.provider); assert.equal(sent.model, route.modelVersion); assert.equal(sent.reasoningEffort, 'high');
  assert.equal(sent.maxTokens, limits.maxOutputTokens); assert.deepEqual(sent.tools, []);
  assert.equal(sent.messages.length, 1); assert.equal(sent.messages[0].role, 'user');
  assert.equal(JSON.parse(sent.messages[0].content[0].text).responseSchema.additionalProperties, false);
  assert.ok(Object.isFrozen(sent.messages)); assert.equal(sent.sessionId, undefined);
  assert.equal(ctx.get('agents'), undefined); assert.equal(ctx.get('sessions'), undefined); assert.equal(ctx.get('tools'), undefined);
  assert.equal(completion.activeCount, 0); assert.equal(adapter.finished, 1);
});

test('native output remains subject to exact JSON validation, including duplicate keys and prose fences', async t => {
  const { ctx } = await harness(t, { script: ['```json\n' + success + '\n```', '{"answers":{"q":{"type":"noul","noul":1,"noul":0}}}', '{"answers":{"q":{"type":"noul","noul":2}}}'] });
  for (let i = 0; i < 3; i++) {
    const receipt = await ctx.typedDecisions.evaluate(request(`invalid-${i}`));
    assert.equal(receipt.status, 'abstained'); assert.equal(receipt.error.code, 'invalid-output');
    assert.equal(receipt.modelVersion, null); assert.equal(receipt.modelVersionSource, null);
  }
});

test('declared reasoning efforts cannot bypass the real DSH adapter capability check', async t => {
  const { ctx, adapter } = await harness(t, { efforts: ['low'] });
  const receipt = await ctx.typedDecisions.evaluate(request('high', { reasoningEffort: 'high' }));
  assert.equal(receipt.error.code, 'unsupported'); assert.equal(adapter.requests.length, 0);
  assert.equal(adapter.resolved[0].model, route.modelVersion);
  const unsupported = await ctx.typedDecisions.evaluate(request('ultra', { reasoningEffort: 'ultra' }));
  assert.equal(unsupported.error.code, 'unsupported'); assert.equal(adapter.requests.length, 0);
});

test('configured pin cannot be relabeled as a provider-reported response', async t => {
  const { ctx } = await harness(t, { versionSource: 'provider-reported' });
  const receipt = await ctx.typedDecisions.evaluate(request());
  assert.equal(receipt.error.code, 'invalid-output'); assert.equal(receipt.modelVersion, null);
});

test('native stream rejects tools, truncation, missing terminal finish and data after finish', async t => {
  const tool = { type: 'block-start', index: 0, blockType: 'tool-call' };
  const { ctx, adapter } = await harness(t, { script: [
    [tool], [...textChunks(success, false)], [...textChunks(success, false), { type: 'finish', reason: { kind: 'max-tokens' } }],
    [...textChunks(success), { type: 'text-delta', index: 0, text: 'extra' }],
  ] });
  for (let i = 0; i < 4; i++) {
    const receipt = await ctx.typedDecisions.evaluate(request(`stream-${i}`));
    assert.equal(receipt.status, 'abstained'); assert.ok(receipt.error);
  }
  await until(() => adapter.finished === 4);
});

test('caller cancellation aborts native provider and cleans up only its owned call', async t => {
  const { ctx, adapter, completion } = await harness(t, { script: ['hang', success] });
  const controller = new AbortController();
  const pending = ctx.typedDecisions.evaluate(request('cancel'), { signal: controller.signal });
  await until(() => adapter.requests.length === 1);
  controller.abort();
  assert.equal((await pending).error.code, 'cancelled');
  await until(() => adapter.finished === 1 && completion.activeCount === 0);
  assert.equal(adapter.requests[0].signal.aborted, true);
  assert.equal((await ctx.typedDecisions.evaluate(request('after-cancel'))).status, 'answered');
});

test('native runtime limit bounds a hung provider independently of the decision engine timeout', async t => {
  const { ctx, adapter, completion } = await harness(t, { script: ['hang'], config: { maxRuntimeMs: 25 } });
  const receipt = await ctx.typedDecisions.evaluate(request());
  assert.equal(receipt.error.code, 'timeout');
  await until(() => adapter.finished === 1 && completion.activeCount === 0);
  assert.equal(adapter.requests[0].signal.aborted, true);
});

test('native plugin unload aborts active streams, removes only its service and permits clean reload', async t => {
  const { ctx, rows, adapter, completion } = await harness(t, { script: ['hang', success] });
  const pending = ctx.typedDecisions.evaluate(request('during-unload'));
  await until(() => adapter.requests.length === 1);
  await ctx.loader.root.update(structuredClone(rows.filter(row => row.id !== 'completion'))); await ctx.loader.await();
  assert.equal((await pending).error.code, 'cancelled');
  await until(() => adapter.finished === 1 && completion.activeCount === 0);
  assert.equal(ctx.get('typedDecisionCompletion'), undefined); assert.ok(ctx.get('llm')); assert.ok(ctx.get('typedDecisions'));
  await ctx.loader.root.update(structuredClone(rows)); await ctx.loader.await();
  await until(() => ctx.get('typedDecisionCompletion'));
  assert.notEqual(ctx.get('typedDecisionCompletion'), completion);
  const reloaded = await ctx.typedDecisions.evaluate(request('after-reload'));
  assert.equal(reloaded.status, 'answered');
});

test('explicit request, response and token budgets reject oversized input or output', async t => {
  const { ctx, adapter } = await harness(t, { config: { maxInputBytes: 2000, maxOutputBytes: 512 }, script: ['x'.repeat(600), [...textChunks(success, false)].map(chunk => chunk.type === 'usage' ? { type: 'usage', usage: { inputTokens: 1, outputTokens: 257 } } : chunk)] });
  const tooLarge = await ctx.typedDecisions.evaluate(request('large-input', { context: 'x'.repeat(5000) }));
  assert.equal(tooLarge.status, 'abstained'); assert.equal(adapter.requests.length, 0);
  assert.equal((await ctx.typedDecisions.evaluate(request('large-output'))).status, 'abstained');
  assert.equal((await ctx.typedDecisions.evaluate(request('large-token-usage'))).status, 'abstained');
  await until(() => adapter.finished === 2);
});

test('native concurrency budget refuses excess work without invoking another provider call', async t => {
  const { ctx, adapter, completion } = await harness(t, { script: ['hang'], config: { maxConcurrent: 1 } });
  const controller = new AbortController();
  const pending = ctx.typedDecisions.evaluate(request('first'), { signal: controller.signal });
  await until(() => adapter.requests.length === 1);
  assert.equal((await ctx.typedDecisions.evaluate(request('second'))).status, 'abstained');
  assert.equal(adapter.requests.length, 1); assert.equal(completion.activeCount, 1);
  controller.abort(); await pending;
  await until(() => adapter.finished === 1 && completion.activeCount === 0);
});

test('native bridge requires explicit finite budgets and an exact configured model pin', async t => {
  assert.throws(() => Config({ routes: [route] }));
  assert.throws(() => Config({ routes: [route], ...limits, maxRuntimeMs: 0 }));
  const { completion, adapter } = await harness(t);
  await assert.rejects(completion.complete({ model: route.model, modelVersion: 'other', system: '', input: {}, responseSchema: {}, signal: new AbortController().signal }), /unsupported/);
  assert.equal(adapter.requests.length, 0);
});

test('native model defaults cannot silently expand the configured reasoning allowlist', async t => {
  const { ctx, adapter } = await harness(t, { config: { routes: [{ ...route, reasoningEfforts: ['low'] }] } });
  const resolve = adapter.resolveModel.bind(adapter);
  adapter.resolveModel = async (...args) => {
    const info = await resolve(...args);
    return { ...info, reasoning: { ...info.reasoning, defaultEffort: 'high' } };
  };
  const receipt = await ctx.typedDecisions.evaluate(request());
  assert.equal(receipt.error.code, 'unsupported'); assert.equal(adapter.requests.length, 0);
});

test('parent cancellation during native model preparation prevents any generation', async t => {
  const { ctx, adapter, completion } = await harness(t);
  let resolving = false, preparationSignal;
  adapter.resolveModel = async (_provider, _model, signal) => {
    resolving = true; preparationSignal = signal;
    await delay(60000, undefined, { signal });
    assert.fail('cancelled model preparation must not finish normally');
  };
  const controller = new AbortController();
  const pending = ctx.typedDecisions.evaluate(request(), { signal: controller.signal });
  await until(() => resolving); controller.abort();
  assert.equal((await pending).error.code, 'cancelled');
  await until(() => completion.activeCount === 0);
  assert.equal(preparationSignal.aborted, true); assert.equal(adapter.requests.length, 0);
});

test('native output byte budget includes multibyte text and accepts the exact payload limit', async t => {
  const output = '{"answers":{"q":{"type":"abstain","reason":"未知"}}}';
  const bytes = Buffer.byteLength(output, 'utf8') * 2 + 1;
  const exact = await harness(t, { script: [output], config: { maxOutputBytes: bytes } });
  const receipt = await exact.ctx.typedDecisions.evaluate(request('exact'));
  assert.equal(receipt.error, undefined); assert.equal(receipt.answers.q.reason, '未知');
  const short = await harness(t, { script: [output], config: { maxOutputBytes: bytes - 1 } });
  assert.equal((await short.ctx.typedDecisions.evaluate(request('one-byte-short'))).error.code, 'provider-error');
});
