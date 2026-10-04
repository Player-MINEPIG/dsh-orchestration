import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionEngine, StructuredModelProvider } from '@dsh-task/typed-decisions/core';
import { buildTaskDecisionRequest, consumeTaskDecisionReceipt } from '../dist/task-policy.js';
const model = { model: 'small', version: 'small-2026-09', reasoningEfforts: ['low', 'high'] };
function structured(output) { return new StructuredModelProvider('model', [model], { complete: async () => ({ output, modelVersion: model.version }) }); }
function engine(provider) { return new DecisionEngine([provider], { defaultProvider: provider.id, maxAttempts: 1 }); }

const snapshot = {
  stateHash: 'policy-state', validUntil: 2000, context: { task: 'build artifact' }, tasks: [{ id: 'task-1', description: 'Existing task' }],
  executors: [{ id: 'laptop', description: 'Laptop', eligible: true }, { id: 'offline', description: 'Offline', eligible: false }],
  modelRoutes: [{ id: 'route-1', description: 'Model + high effort', executorId: 'laptop', provider: 'p', model: 'm', reasoningEffort: 'high', eligible: true }],
  workspaces: [{ id: 'project', description: 'Existing project', executorId: 'laptop', action: 'reuse', workspaceRef: 'catalog:project', eligible: true }],
  mandatoryReportingReasons: ['authorization-needed'],
};
async function policyReceipt(snapshotValue = snapshot, choices = {}) {
  const req = buildTaskDecisionRequest('policy', snapshotValue, {}, 1000);
  const values = { persist: 'attach', attach: 'task-1', executor: 'laptop', modelEffort: 'route-1', workspace: 'project', reporting: 'none', ...choices };
  const e = engine(structured({ answers: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: 'choice', choice: v }])) }));
  return { req, receipt: await e.evaluate(req) };
}
test('task consumer returns proposal only, preserves mandatory protocol/narrative reporting', async () => {
  const { req, receipt } = await policyReceipt();
  assert.ok(!Object.hasOwn(req.questions.find(q => q.questionId === 'executor').candidates, 'offline'));
  const result = consumeTaskDecisionReceipt(receipt, req, snapshot, 1000);
  assert.equal(result.kind, 'proposal'); assert.equal(result.attachTaskId, 'task-1');
  assert.equal(result.modelRoute.reasoningEffort, 'high'); assert.equal(result.workspace.action, 'reuse');
  assert.equal(result.requiresAuthorizationCheck, true); assert.equal(result.reporting.protocolReceiptRequired, true); assert.equal(result.reporting.narrative, 'escalate');
});
test('task consumer refuses stale catalog, explicit route changes, ignored dispatch and bad attachment', async () => {
  const { req, receipt } = await policyReceipt();
  assert.equal(consumeTaskDecisionReceipt(receipt, req, snapshot, 2001).reason, 'stale-snapshot');
  const changed = structuredClone(snapshot); changed.executors[0].eligible = false;
  assert.equal(consumeTaskDecisionReceipt(receipt, req, changed, 1000).kind, 'abstain');
  assert.throws(() => buildTaskDecisionRequest('bad', { ...snapshot, explicit: { executorId: 'offline' } }, {}, 1000), /explicit executor/);
  const ignored = await policyReceipt(snapshot, { persist: 'ignore', attach: 'none' });
  assert.equal(consumeTaskDecisionReceipt(ignored.receipt, ignored.req, snapshot, 1000).reason, 'ignored-task-cannot-dispatch');
  const unattached = await policyReceipt(snapshot, { attach: 'none' });
  assert.equal(consumeTaskDecisionReceipt(unattached.receipt, unattached.req, snapshot, 1000).reason, 'attach-without-task');
  const explicit = { ...snapshot, explicit: { executorId: 'laptop' } };
  const mismatch = await policyReceipt(explicit, { executor: 'none', modelEffort: 'none', workspace: 'none' });
  assert.equal(consumeTaskDecisionReceipt(mismatch.receipt, mismatch.req, explicit, 1000).reason, 'explicit-executor-not-preserved');
});
