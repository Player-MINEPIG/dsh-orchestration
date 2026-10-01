import { createNativeHarness } from './native-harness.mjs';

// No credentials or live model/network calls. The host and agent are real DSH.
const h = await createNativeHarness({
  config: {
    localNode: { models: [{ provider: 'test-offline', model: 'script', reasoningEfforts: [] }], capabilities: [], workspaceIds: [], enabled: true },
  },
  script: [{ name: 'task_settle', args: { outcome: 'success', summary: 'Offline DSH native demonstration complete', reportTitle: 'Demonstration', reportBody: 'An actual DSH AgentLoop submitted this result through the scoped task tool.' } }],
});
try {
  const task = h.ledger.createTask('demo-task', { title: 'Native DSH task demonstration' }).value;
  const run = h.ledger.createRun('demo-run', { taskId: task.taskId, route: { nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: [] } }).value;
  const claim = h.ledger.claim('demo-claim', { runId: run.runId, nodeId: 'local', ttlMs: 10000 }).value;
  const outcome = await h.ctx.taskSystem.native.execute(claim);
  process.stdout.write(JSON.stringify({ state: outcome.run.state, sessionId: outcome.sessionId, report: h.ledger.history(task.taskId).reports[0], model: 'scripted offline fixture', runtime: 'actual DSH Loader and AgentLoop' }, null, 2) + '\n');
} finally { await h.dispose(); }
