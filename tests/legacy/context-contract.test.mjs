import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeReport, validateNodeEvidenceGate } from '../../examples/legacy-task-pack/reporting.mjs';
import { dailyInput, collectorEvidence } from './synthetic-fixtures.mjs';

function evidence() {
  const input = dailyInput();
  const report = buildNodeReport({ nodeId: 'node-one', ...collectorEvidence() });
  input.candidates.push({ ...input.candidates[0], candidate_id: report.work_candidates[0].candidate_id });
  const node = { nodeId: 'node-one', rootTaskId: input.report_context.root_task_id, rootRunId: input.report_context.root_run_id, state: 'succeeded', settlement: { type: 'run.settled', detail: { outcome: 'success' } }, report };
  return { input, node };
}

test('new Run node evidence uses terminal state and actual settlement evidence without obsolete validation', () => {
  const { input, node } = evidence();
  assert.equal(node.outcome, undefined);
  assert.equal(node.validation, undefined);
  assert.equal(validateNodeEvidenceGate(input, [node], ['node-one']), true);
  assert.throws(() => validateNodeEvidenceGate(input, [{ ...node, settlement: undefined }], ['node-one']), /must be declared/);
  assert.throws(() => validateNodeEvidenceGate(input, [{ ...node, state: 'partial' }], ['node-one']), /must be declared/);
  assert.throws(() => validateNodeEvidenceGate(input, [{ ...node, state: 'failed' }], ['node-one']), /must be declared/);
  assert.throws(() => validateNodeEvidenceGate(input, [{ ...node, report: { ...node.report, device_id: 'wrong-node' } }], ['node-one']), /node/i);
});

test('legacy-shaped node evidence still requires its explicit historical outcome and validation', () => {
  const { input, node } = evidence();
  delete node.state; delete node.settlement;
  node.outcome = 'success'; node.validation = 'valid';
  assert.equal(validateNodeEvidenceGate(input, [node], ['node-one']), true);
  delete node.validation;
  assert.throws(() => validateNodeEvidenceGate(input, [node], ['node-one']), /must be declared/);
});
