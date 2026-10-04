import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AnyJevCompatibleProvider, DecisionEngine, JevProvider, ProviderError, RulesProvider, StructuredModelProvider,
  parseStrictJson, validateRequest,
} from '../dist/core.js';

const choice = { questionId: 'route', questionVersion: '1', type: 'choice', instructions: 'Select a route', candidates: { a: 'Route A', b: 'Route B' } };
const request = (requestId = 'r', questions = [choice]) => ({ requestId, stateHash: 's1', context: { kind: 'route' }, questions });
const model = { model: 'small', version: 'small-2026-09', reasoningEfforts: ['low', 'high'] };
function structured(output = { answers: { route: { type: 'choice', choice: 'a' } } }, extra = {}) {
  return new StructuredModelProvider('model', [model], { complete: async () => ({ output, modelVersion: model.version, ...extra }) });
}
function engine(provider, options = {}) { return new DecisionEngine([provider], { defaultProvider: provider.id, ...options }); }

test('strict request rejects duplicate IDs, unknown fields, NaN, infinity and unknown question variants', () => {
  for (const value of [
    { ...request(), questions: [choice, choice] }, { ...request(), approve: true },
    { ...request(), context: { score: NaN } }, { ...request(), context: Infinity },
    request('x', [{ ...choice, type: 'command' }]), request('x', [{ ...choice, candidates: {} }]),
    request('x', [{ ...choice, candidates: { constructor: 'bad' } }]),
    request('x', [{ questionId: 's', questionVersion: '1', type: 'score', instructions: 'Score', levels: ['only'] }]),
  ]) assert.throws(() => validateRequest(value));
});

test('rules are versioned, deterministic and abstain on no match or ambiguity', async () => {
  const rule = { questionId: 'route', questionVersion: '1', path: ['kind'], equals: 'route', answer: { type: 'choice', choice: 'a' } };
  const e = engine(new RulesProvider('rules', 'revision-2', [rule]));
  const receipt = await e.evaluate(request());
  assert.equal(receipt.status, 'answered'); assert.equal(receipt.modelVersion, 'revision-2');
  assert.deepEqual(receipt.evidence, { kind: 'deterministic', calibration: 'not-applicable' });
  assert.deepEqual(receipt.answers.route, { type: 'choice', choice: 'a' });
  const noMatch = await e.evaluate({ ...request('no-match'), context: { kind: 'unrelated' } });
  assert.equal(noMatch.answers.route.reason, 'no-matching-rule');
  const ambiguous = await engine(new RulesProvider('rules', '1', [rule, rule])).evaluate(request());
  assert.equal(ambiguous.answers.route.reason, 'ambiguous-rules');
  await e.close();
});

test('simultaneous and completed replay call provider once and return the same immutable receipt', async () => {
  let calls = 0;
  const p = new StructuredModelProvider('model', [model], { complete: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 5));
    return { output: { answers: { route: { type: 'choice', choice: 'a' } } }, modelVersion: model.version };
  } });
  const e = engine(p); const input = request();
  const pending = e.evaluate(input);
  const [a, b] = await Promise.all([pending, e.evaluate(input)]);
  assert.equal(a, b); assert.equal(await e.evaluate(input), a); assert.equal(calls, 1);
  assert.throws(() => { a.answers.route.choice = 'b'; }, TypeError);
  assert.throws(() => e.evaluate({ ...input, stateHash: 'changed' }), /requestId/);
  assert.throws(() => e.evaluate({ ...input, context: { kind: 'other' } }), /requestId/);
});

test('receipt capacity fails closed rather than losing replay identity', async () => {
  const e = engine(structured(), { maxReceipts: 1 }); await e.evaluate(request());
  assert.throws(() => e.evaluate(request('new')), /capacity/);
  assert.equal((await e.evaluate(request())).status, 'answered');
});

test('ordinary structured models do not gain calibrated confidence or probabilities', async () => {
  for (const output of [
    { answers: { route: { type: 'choice', choice: 'a', confidence: 0.99 } } },
    { answers: { route: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 } } } },
    { answers: { route: { type: 'choice', choice: 'outside' } } },
    { answers: {} }, { answers: { route: { type: 'choice', choice: 'a' }, extra: { type: 'noul', noul: 1 } } },
    { answers: { route: { type: 'choice', choice: 'a' } }, authorize: true },
    '```json\n{"answers":{"route":{"type":"choice","choice":"a"}}}\n```',
    '{"answers":{}} {"answers":{}}',
    '{"answers":{"route":{"type":"choice","choice":"b","choice":"a"}}}',
  ]) {
    const receipt = await engine(structured(output)).evaluate(request());
    assert.equal(receipt.error.code, 'invalid-output'); assert.equal(receipt.status, 'abstained');
    assert.equal(receipt.evidence.calibration, 'none');
  }
});

test('strict JSON parser rejects escaped duplicate keys and sparse JavaScript arrays', () => {
  assert.throws(() => parseStrictJson('{"answers":{},"answ\\u0065rs":{}}'), /duplicate/);
  assert.deepEqual(parseStrictJson('{"a":[{"b":"escaped \\\" text"},true,1,null]}'), { a: [{ b: 'escaped " text' }, true, 1, null] });
  const sparse = []; sparse.length = 2;
  assert.throws(() => validateRequest({ ...request(), context: sparse }), /sparse/);
});

test('noul and score must be finite, bounded and have matching types', async () => {
  const noul = { questionId: 'n', questionVersion: '1', instructions: 'Urgent?', type: 'noul' };
  const score = { questionId: 's', questionVersion: '1', instructions: 'Rank', type: 'score', levels: ['low', 'medium', 'high'] };
  for (const [q, answer] of [[noul, { type: 'noul', noul: NaN }], [noul, { type: 'noul', noul: 1.1 }], [score, { type: 'score', score: Infinity }], [score, { type: 'score', score: 3 }], [score, { type: 'noul', noul: 1 }]]) {
    const receipt = await engine(structured({ answers: { [q.questionId]: answer } })).evaluate(request('bad', [q]));
    assert.equal(receipt.error.code, 'invalid-output');
  }
});

test('unsupported model/reasoning is deterministic and never calls completion', async () => {
  let calls = 0;
  const provider = new StructuredModelProvider('m', [model], { complete: async () => { calls++; throw Error('must not call'); } });
  const e = engine(provider);
  for (const override of [{ model: 'unknown' }, { reasoningEffort: 'ultra' }]) {
    const result = await e.evaluate({ ...request(JSON.stringify(override)), ...override });
    assert.equal(result.error.code, 'unsupported'); assert.equal(result.attempts, 0);
  }
  assert.equal(calls, 0);
});

test('model version mismatch abstains and does not pretend an alias was the actual version', async () => {
  const receipt = await engine(structured(undefined, { modelVersion: 'different-version' })).evaluate(request());
  assert.equal(receipt.error.code, 'invalid-output'); assert.equal(receipt.modelVersion, null);
});

test('timeout aborts provider and late completion cannot replace an idempotent receipt', async () => {
  let signal; let finish;
  const p = new StructuredModelProvider('m', [model], { complete: input => {
    signal = input.signal; return new Promise(resolve => { finish = resolve; });
  } });
  const e = engine(p, { timeoutMs: 10 }); const timedOut = await e.evaluate(request());
  assert.equal(timedOut.error.code, 'timeout'); assert.equal(signal.aborted, true);
  finish({ output: { answers: { route: { type: 'choice', choice: 'a' } } }, modelVersion: model.version });
  await Promise.resolve();
  assert.equal(await e.evaluate(request()), timedOut); await e.close();
});

test('cancel/unload aborts accepted work, drains evaluation and rejects new requests', async () => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const p = new StructuredModelProvider('m', [model], { complete: input => new Promise((_, reject) => {
    input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }); started();
  }) });
  const e = engine(p); const pending = e.evaluate(request()); await ready; await e.close();
  assert.equal((await pending).error.code, 'cancelled');
  await assert.rejects(e.evaluate(request('new')), /closed/);
});

test('failure circuit bounds requests and redacts arbitrary provider exception text', async () => {
  let calls = 0;
  const p = new StructuredModelProvider('m', [model], { complete: async () => { calls++; throw Error('secret example api token and prompt'); } });
  const e = engine(p, { failureLimit: 2 });
  const first = await e.evaluate(request('1')); await e.evaluate(request('2')); const third = await e.evaluate(request('3'));
  assert.equal(first.error.message, 'provider evaluation failed'); assert.equal(third.error.code, 'circuit-open'); assert.equal(calls, 2);
});

function typedResponse(answers, status = 200, headers = {}) {
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 4 } }), { status, headers });
}
const validChoice = { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.4 };
test('Jev uses exact official URL, request/response schema, Bearer and actual model version', async () => {
  let captured;
  const questions = [choice, { questionId: 'n', questionVersion: '2', instructions: 'Urgent?', type: 'noul' }, { questionId: 's', questionVersion: '3', instructions: 'Rank', type: 'score', levels: ['low', 'high'] }];
  const provider = new JevProvider({ id: 'jev', apiKey: () => 'test-not-a-real-key', fetch: async (url, init) => {
    captured = { url, init }; return typedResponse({ route: validChoice, n: { type: 'noul', noul: 0.7 }, s: { type: 'score', score: 0.75, probabilities: { 0: 0.25, 1: 0.75 }, confidence: 0.2, legend: { 0: 'low', 1: 'high' } } });
  } });
  const receipt = await engine(provider).evaluate(request('wire', questions));
  assert.equal(receipt.status, 'answered'); assert.equal(receipt.modelVersion, 'jev-1.13.0');
  assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.headers.authorization, 'Bearer test-not-a-real-key');
  assert.deepEqual(JSON.parse(captured.init.body), { state: { kind: 'route' }, model: 'jev-1.13.0', questions: {
    route: { type: 'choice', instructions: 'Select a route', criteria: { a: 'Route A', b: 'Route B' } },
    n: { type: 'noul', instructions: 'Urgent?' }, s: { type: 'score', instructions: 'Rank', criteria: ['low', 'high'] },
  } });
  assert.equal(receipt.evidence.calibration, 'provider-claimed'); assert.ok(!JSON.stringify(receipt).includes('test-not-a-real-key'));
});

test('Jev rejects malformed distributions, extra fields, wrong scores and missing metadata', async () => {
  for (const answer of [
    { ...validChoice, probabilities: { a: 0.8, b: 0.4 } }, { ...validChoice, probabilities: { a: 1 } },
    { ...validChoice, choice: 'b' }, { ...validChoice, probabilities: { a: 1, b: -0.1 } },
    { ...validChoice, confidence: 2 }, { type: 'choice', choice: 'a' }, { ...validChoice, grantAccess: true },
  ]) {
    const result = await engine(new JevProvider({ id: 'jev', fetch: async () => typedResponse({ route: answer }) })).evaluate(request());
    assert.equal(result.error.code, 'invalid-output');
  }
});

test('Jev limits are honest: unsupported native abstention/effort performs no network call', async () => {
  let calls = 0;
  const e = engine(new JevProvider({ id: 'jev', fetch: async () => { calls++; throw Error(); } }));
  assert.equal((await e.evaluate({ ...request('effort'), reasoningEffort: 'low' })).error.code, 'unsupported');
  assert.equal((await e.evaluate(request('abstain', [{ ...choice, abstainWhen: ['insufficient evidence'] }]))).error.code, 'unsupported');
  assert.equal(calls, 0);
});

test('Jev retries 429 within attempt bound; 401 and 422 are never retried', async () => {
  for (const status of [401, 422, 429, 529]) {
    let calls = 0;
    const e = engine(new JevProvider({ id: 'jev', fetch: async () => { calls++; return new Response('{}', { status }); } }), { maxAttempts: 3, retryBaseMs: 1 });
    const result = await e.evaluate(request());
    assert.equal(calls, status === 429 || status === 529 ? 3 : 1); assert.equal(result.error.message, `http-${status}`);
  }
});

const declaration = { readout: 'logits', calibration: 'L0', maxChoices: 26, maxScoreLevels: 10, questionTypes: ['choice', 'noul', 'score'], reasoningEfforts: [] };
test('compatible adapter requires actual readout declaration and L1/L2 calibration provenance', async () => {
  const base = { id: 'local', endpoint: 'http://127.0.0.1:9090/v1/systemone', model: 'local', modelVersion: 'local-revision-1', capabilityDeclaration: declaration };
  assert.throws(() => new AnyJevCompatibleProvider({ ...base, capabilityDeclaration: { ...declaration, readout: 'json-text' } }), /readout/);
  assert.throws(() => new AnyJevCompatibleProvider({ ...base, capabilityDeclaration: { ...declaration, calibration: 'L1' } }), /calibrationArtifact/);
  assert.throws(() => new AnyJevCompatibleProvider({ ...base, capabilityDeclaration: { ...declaration, reasoningEfforts: ['high'] } }), /reasoningEffort/);
  assert.throws(() => new AnyJevCompatibleProvider({ ...base, endpoint: 'http://untrusted.example/v1/systemone' }), /HTTPS/);
  const p = new AnyJevCompatibleProvider({ ...base, fetch: async () => new Response(JSON.stringify({ model: 'local-revision-1', answers: { route: validChoice }, usage: { input_tokens: 1, output_tokens: 1 } })) });
  const result = await engine(p).evaluate(request());
  assert.equal(result.status, 'answered'); assert.deepEqual(result.evidence, { kind: 'logits', calibration: 'L0' });
  const overLimit = { ...choice, candidates: Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`c${i}`, `Candidate ${i}`])) };
  assert.equal((await engine(p).evaluate(request('wide', [overLimit]))).error.code, 'unsupported');
});
