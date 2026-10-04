import test from 'node:test'
import assert from 'node:assert/strict'
import { resolvedClaimContext } from '../../dist/remote/context.js'
import { ExecutorWorker, RecoveryStore } from '../../dist/remote/api.js'

const template = {
  templateId: 'pinned-template', version: 1, name: 'Pinned rules', description: '',
  inputSchema: { type: 'object' }, defaults: {}, resultContract: { type: 'object' },
}
const report = { reportId: 'selected-report-v1', body: 'Immutable queued note', actor: 'operator-fixture' }
const referenced = () => ({
  run: { configuration: { templateRef: { templateId: template.templateId, version: 1 }, input: {} }, contextNotes: [report.reportId] },
  executionContext: { template, reports: [report] },
})

test('claim context selects only the exact pinned template and requested report versions', () => {
  const claim = referenced()
  claim.executionContext.reports.push({ reportId: 'unselected-report', body: 'Must not enter instructions', actor: 'other' })
  assert.deepEqual(resolvedClaimContext(claim), { template, reports: [report] })
  assert.deepEqual(claim.run.contextNotes, [report.reportId])
  assert.equal(claim.run.configuration.template, undefined)
})

test('missing or mismatched reference context fails closed instead of using local or latest values', () => {
  const absent = referenced(); delete absent.executionContext
  assert.throws(() => resolvedClaimContext(absent), /EXECUTION_TEMPLATE_CONTEXT_REQUIRED/)
  const wrongVersion = referenced(); wrongVersion.executionContext.template = { ...template, version: 2 }
  assert.throws(() => resolvedClaimContext(wrongVersion), /EXECUTION_TEMPLATE_CONTEXT_REQUIRED/)
  const missingReport = referenced(); missingReport.executionContext.reports = []
  assert.throws(() => resolvedClaimContext(missingReport), /EXECUTION_REPORT_CONTEXT_REQUIRED/)
  const duplicate = referenced(); duplicate.executionContext.reports = [report, report]
  assert.throws(() => resolvedClaimContext(duplicate), /EXECUTION_REPORT_CONTEXT_REQUIRED/)
})

test('imported embedded snapshots remain readable without reinterpretation or new body storage', () => {
  const claim = {
    run: { configuration: { template, input: {} }, contextNotes: [report] },
    executionContext: { template: { ...template, version: 2 }, reports: [{ ...report, body: 'Changed registry value' }] },
  }
  assert.deepEqual(resolvedClaimContext(claim), { template, reports: [report] })
  delete claim.executionContext
  assert.deepEqual(resolvedClaimContext(claim), { template, reports: [report] })
  assert.deepEqual(resolvedClaimContext({ run: { configuration: null } }), { reports: [] })
})

test('context selection keeps the existing maximum 128 note bound', () => {
  assert.throws(() => resolvedClaimContext({ run: { configuration: null, contextNotes: Array(129).fill(report) } }), /EXECUTION_CONTEXT_LIMIT/)
})

test('worker never dispatches historyOnly work even when an adapter exposes it as queued', async () => {
  const run = { runId: 'historical-run', taskId: 'task', state: 'queued', historyOnly: true, configuration: null, route: { nodeId: 'worker', provider: 'unused', model: 'unused', requiredCapabilities: [], workspaceId: 'workspace' } }
  const store = new RecoveryStore(':memory:')
  let executions = 0
  const worker = new ExecutorWorker({
    ledger: { pendingRuns: () => [run], claim: () => ({ value: { run } }) },
    provider: { supports: () => true, capabilities: [], execute: async () => { executions++; throw new Error('not reachable') } },
    store,
    policy: { role: 'executor', nodeId: 'worker', capabilities: [], workspaces: [] },
  })
  try {
    assert.deepEqual(await worker.pollOnce(), [])
    await assert.rejects(worker.execute(run.runId, 'claim-history'), /OBSERVE_ONLY/)
    assert.equal(executions, 0)
  } finally { await worker.dispose(); store.close() }
})
