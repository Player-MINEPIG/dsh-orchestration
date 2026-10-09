import { createHash } from 'node:crypto';
import type { DecisionAnswer, DecisionQuestion, DecisionRequest, Json } from './decision-types.js';

export class DecisionValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'DecisionValidationError'; }
}
export function fail(message: string): never { throw new DecisionValidationError(message); }
export function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object`);
}
export function keys(value: Record<string, unknown>, allowed: string[], required: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}: unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}: missing ${key}`);
}
export function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 65536) fail(`${label} must be a nonempty string of at most 65536 characters`);
}
export function id(value: unknown, label: string): asserts value is string {
  text(value, label);
  if (value.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(value)) fail(`${label} is not a safe identifier`);
}
export function finite(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be finite in [${min}, ${max}]`);
}
export function positiveInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  finite(value, 1, max, label);
  if (!Number.isSafeInteger(value)) fail(`${label} must be an integer`);
}
export function json(value: unknown, label = 'context', seen = new Set<object>(), depth = 0): asserts value is Json {
  if (depth > 64) fail(`${label} exceeds maximum depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { finite(value, -Number.MAX_VALUE, Number.MAX_VALUE, label); return; }
  if (typeof value !== 'object' || value === undefined) fail(`${label} must be JSON`);
  if (seen.has(value)) fail(`${label} contains a cycle`);
  seen.add(value);
  if (!Array.isArray(value)) object(value, label);
  else if (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index))) fail(`${label} must not contain sparse arrays or extra array properties`);
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label}: unsafe key`);
    json(child, `${label}.${key}`, seen, depth + 1);
  }
  seen.delete(value);
}
export function validateQuestion(value: unknown): asserts value is DecisionQuestion {
  object(value, 'question');
  const base = ['questionId', 'questionVersion', 'instructions', 'type', 'abstainWhen'];
  const extra = value.type === 'choice' ? ['candidates'] : value.type === 'noul' ? ['criteria'] : value.type === 'score' ? ['levels'] : fail('unsupported question type');
  keys(value, [...base, ...extra], base.filter(k => k !== 'abstainWhen'), 'question');
  id(value.questionId, 'questionId'); text(value.questionVersion, 'questionVersion'); text(value.instructions, 'instructions');
  if (value.abstainWhen !== undefined) {
    if (!Array.isArray(value.abstainWhen)) fail('abstainWhen must be an array');
    for (const condition of value.abstainWhen) text(condition, 'abstainWhen');
  }
  if (value.type === 'choice') {
    object(value.candidates, 'candidates');
    positiveInteger(Object.keys(value.candidates).length, 'candidate count', 255);
    for (const [key, label] of Object.entries(value.candidates)) { id(key, 'candidate'); if (label !== null) text(label, 'candidate rubric'); }
  } else if (value.type === 'noul') {
    if (value.criteria !== undefined) {
      object(value.criteria, 'criteria'); keys(value.criteria, ['true', 'false'], ['true', 'false'], 'criteria');
      text(value.criteria.true, 'true criteria'); text(value.criteria.false, 'false criteria');
    }
  } else {
    if (!Array.isArray(value.levels) || value.levels.length < 2 || value.levels.length > 10) fail('score requires 2–10 levels');
    for (const level of value.levels) text(level, 'score level');
  }
}
export function validateRequest(value: unknown): asserts value is DecisionRequest {
  json(value, 'request'); object(value, 'request');
  keys(value, ['requestId', 'stateHash', 'context', 'questions', 'provider', 'model', 'reasoningEffort', 'preset'], ['requestId', 'stateHash', 'context', 'questions'], 'request');
  if (value.preset !== undefined) {
    id(value.preset, 'preset');
    if (value.provider !== undefined || value.model !== undefined || value.reasoningEffort !== undefined) fail('preset cannot be mixed with explicit routing');
  }
  id(value.requestId, 'requestId'); text(value.stateHash, 'stateHash');
  if (value.provider !== undefined) id(value.provider, 'provider');
  if (value.model !== undefined) text(value.model, 'model');
  if (value.reasoningEffort !== undefined) text(value.reasoningEffort, 'reasoningEffort');
  if (!Array.isArray(value.questions) || !value.questions.length || value.questions.length > 128) fail('questions must contain 1–128 items');
  const used = new Set<string>();
  for (const question of value.questions) {
    validateQuestion(question);
    if (used.has(question.questionId)) fail(`duplicate questionId ${question.questionId}`);
    used.add(question.questionId);
  }
}
function distribution(value: Record<string, unknown>, candidates: string[]): Record<string, number> | undefined {
  if (value.confidence !== undefined) finite(value.confidence, 0, 1, 'confidence');
  if (value.probabilities === undefined) {
    if (value.confidence !== undefined) fail('confidence requires a distribution');
    return;
  }
  object(value.probabilities, 'probabilities');
  keys(value.probabilities, candidates, candidates, 'probabilities');
  let sum = 0;
  for (const probability of Object.values(value.probabilities)) { finite(probability, 0, 1, 'probability'); sum += probability; }
  if (Math.abs(sum - 1) > 1e-6) fail('probabilities must sum to one');
  return value.probabilities as Record<string, number>;
}
export function validateAnswer(value: unknown, question: DecisionQuestion, distributions: boolean): asserts value is DecisionAnswer {
  object(value, `answer ${question.questionId}`);
  if (value.type === 'abstain') { keys(value, ['type', 'reason'], ['type', 'reason'], 'abstain'); text(value.reason, 'abstain reason'); return; }
  if (value.type !== question.type) fail('answer type does not match question');
  const optional = distributions ? ['probabilities', 'confidence'] : [];
  if (question.type === 'choice') {
    keys(value, ['type', 'choice', ...optional], ['type', 'choice'], 'choice answer');
    if (typeof value.choice !== 'string' || !Object.hasOwn(question.candidates, value.choice)) fail('choice is outside finite candidates');
    const p = distribution(value, Object.keys(question.candidates));
    if (p && Object.values(p).some(n => n > p[value.choice as string]! + 1e-6)) fail('choice must have maximum probability');
  } else if (question.type === 'noul') {
    keys(value, ['type', 'noul'], ['type', 'noul'], 'noul answer'); finite(value.noul, 0, 1, 'noul');
  } else {
    keys(value, ['type', 'score', ...(distributions ? ['legend'] : []), ...optional], ['type', 'score'], 'score answer');
    finite(value.score, 0, question.levels.length - 1, 'score');
    const levelKeys = question.levels.map((_, i) => String(i));
    const p = distribution(value, levelKeys);
    if (p && Math.abs(Object.entries(p).reduce((n, [key, v]) => n + Number(key) * v, 0) - value.score) > 1e-6) fail('score must match probability-weighted levels');
    if (value.legend !== undefined) {
      object(value.legend, 'legend'); keys(value.legend, levelKeys, levelKeys, 'legend');
      for (const key of levelKeys) if (value.legend[key] !== question.levels[Number(key)]) fail('legend must match question levels');
    }
  }
}
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(stableStringify(value)).digest('hex'); }
