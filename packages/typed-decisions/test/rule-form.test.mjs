import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { valueDraft, readValueDraft, ruleForm, readRuleForm, valueSummary, answerSummary } from '../dist/rule-form.js';
import { validateRules } from '../dist/console.js';

const rule = { questionId: 'session', questionVersion: '1', path: ['task', 'id'], equals: '001', answer: { type: 'choice', choice: 'new' } };
test('form round-trips imported nested values without conflating strings, numbers, booleans or null', () => {
  const values = ['', '001', 'false', 0, 1.25, false, true, null, [], {}, { list: ['001', 1, false, null, { nested: 'x' }] }];
  for (const value of values) assert.deepEqual(readValueDraft(valueDraft(value)), value);
  assert.deepEqual(readRuleForm(ruleForm(rule)), rule);
  const form = ruleForm({ ...rule, path: [], equals: { '': 'empty-key', 'a.b': [] } });
  assert.deepEqual(readRuleForm(form).equals, { '': 'empty-key', 'a.b': [] });
});
test('form can create and edit object/list fields and preserve literal path segments', () => {
  const f = ruleForm(rule);
  f.path = ['field.with.dot', '0'];
  f.equals = valueDraft({});
  f.equals.items.push({ key: 'enabled', node: valueDraft(false) }, { key: 'items', node: valueDraft([3, '3']) });
  const result = readRuleForm(f);
  assert.deepEqual(result.path, ['field.with.dot', '0']);
  assert.deepEqual(result.equals, { enabled: false, items: [3, '3'] });
  validateRules([result]);
});
test('blank or nonfinite numbers, duplicate object fields and unsafe names cannot be saved by forms', () => {
  for (const value of ['', '   ', 'Infinity', 'NaN', '1e999']) assert.throws(() => readValueDraft({ kind: 'number', value }));
  const node = valueDraft({});
  node.items = [{ key: 'x', node: valueDraft(1) }, { key: 'x', node: valueDraft(2) }];
  assert.throws(() => readValueDraft(node), /重复/);
  node.items[1].key = '__proto__';
  assert.throws(() => readValueDraft(node), /字段名/);
  for (const path of [[''], ['constructor']]) assert.throws(() => readRuleForm({ ...ruleForm(rule), path }));
});
test('each answer control produces a valid typed rule and rejects invalid numeric ranges', () => {
  for (const [type, value] of [['choice', 'new'], ['noul', '0.8'], ['score', '2.5'], ['abstain', '缺少证据']]) {
    const result = readRuleForm({ ...ruleForm(rule), answerType: type, answerValue: value });
    validateRules([result]);
    assert.equal(result.answer.type, type);
    assert.ok(!answerSummary(result.answer).startsWith('{'));
  }
  for (const [type, value] of [['choice', ''], ['noul', '1.1'], ['score', '10'], ['score', ''], ['abstain', '']]) assert.throws(() => readRuleForm({ ...ruleForm(rule), answerType: type, answerValue: value }));
  assert.equal(valueSummary(false), '布尔值：否');
  assert.equal(valueSummary('false'), '文本：false');
});
test('built iframe includes form helpers and parses as ordinary browser JavaScript', () => {
  const html = readFileSync(new URL('../dist/console-page.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('/* RULE_FORM_HELPERS */'));
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
