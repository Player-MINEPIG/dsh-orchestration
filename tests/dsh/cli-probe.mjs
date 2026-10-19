import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ScriptedModel } from './scripted-model.mjs';
import { dailyInput, WINDOW } from '../legacy/synthetic-fixtures.mjs';

export const name = 'task-system-acceptance-probe';
export const inject = ['taskSystem', 'tools', 'llm', 'quotaMonitor', 'sessionPersistence'];
export async function apply(ctx) {
  const service = ctx.taskSystem;
  const ledger = service.ledger;
  if (service.config.role !== 'executor') {
    ledger.createTask('cli-acceptance-create', { taskId: 'cli-retained-task', title: 'Installed tarball persisted task' });
    ledger.appendReport('cli-acceptance-report', { taskId: 'cli-retained-task', title: 'Boot proof', body: 'Written by actual DSH CLI-loaded taskSystem service', kind: 'observation' });
  }
  assert.equal(ledger.getTask('cli-retained-task').title, 'Installed tarball persisted task');
  assert.equal(ledger.history('cli-retained-task').reports.length, 1);
  assert.ok(ctx.tools.get('task_query'));
  assert.ok(ctx.tools.get('legacy_report_prepare'), 'installed optional task-pack plugin must register its native tool');
  assert.ok(ctx.tools.get('activity_sources_read'));
  assert.ok(ctx.tools.get('activity_report_prepare'));
  assert.equal(ctx.quotaMonitor.enabled, false);
  assert.equal((await ctx.quotaMonitor.tick()).status, 'disabled');
  const requireInstalled = createRequire(join(process.env.DSH_TEST_PROFILE_DIR, 'package.json'));
  const bridge = await import(pathToFileURL(requireInstalled.resolve('@dsh-task/task-system/approval-bridge')).href);
  assert.equal(bridge.Config({}).enabled, false);
  assert.equal([...ctx.loader.entries()].find(entry => entry.options.id === 'installed-native-approval-bridge')?.fiber?.state, 2 /* pinned Cordis FiberState.ACTIVE (const enum) */);
  assert.equal([...ctx.loader.entries()].find(entry => entry.options.id === 'installed-quota-monitor')?.fiber?.state, 2 /* pinned Cordis FiberState.ACTIVE (const enum) */);
  let preparedArtifact = false;
  if (service.config.role === 'planner') {
    assert.equal(service.native, undefined);
    assert.throws(() => service.assertExecuting(), /planner/);
  } else {
    const deadline = Date.now() + 10000;
    while (!service.native && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(service.native, 'real native provider must be available');
  }
  if (service.config.role === 'both') {
    const require = createRequire(join(process.env.DSH_TEST_PROFILE_DIR, 'package.json'));
    const { createLegacyTemplates } = await import(pathToFileURL(require.resolve('@dsh-task/task-system/task-pack')).href);
    const template = createLegacyTemplates().find(item => item.defaults.kind === 'agent_daily');
    ledger.registerNode('cli-native-node', { nodeId: service.config.nodeId, roles: ['both'], capabilities: ['legacy.task-pack.v1'], models: [{ provider: 'cli-offline', model: 'script', reasoningEfforts: [] }, { provider: 'cli-activity', model: 'script', reasoningEfforts: [] }], workspaceIds: [], maxConcurrent: 1, enabled: true, lastSeenAt: new Date().toISOString() });
    const task = ledger.createTask('cli-native-task', { title: 'Installed native task-pack report', policy: { allowedTools: ['legacy_report_prepare'] } }).value;
    const run = ledger.createRun('cli-native-run', { taskId: task.taskId, configuration: { template, input: { sourceIds: ['synthetic-fixture'], windowStart: WINDOW.start, windowEnd: WINDOW.end } }, route: { nodeId: service.config.nodeId, provider: 'cli-offline', model: 'script', requiredCapabilities: ['legacy.task-pack.v1'] } }).value;
    const adapter = new ScriptedModel([
      { name: 'legacy_report_prepare', args: { commandId: 'cli-native-prepare', kind: 'agent_daily', input: dailyInput(task.taskId, run.runId) } },
      options => {
        const response = options.messages.findLast(message => message.role === 'tool');
        assert.equal(response?.isError, false, JSON.stringify(response?.content));
        const prepared = JSON.parse(response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
        assert.equal(ledger.getRun(run.runId).state, 'running');
        assert.equal(ledger.history(task.taskId).reports.length, 0);
        return { name: 'task_submit_result', args: { outcome: 'success', summary: prepared.summary, reportTitle: prepared.report.title, reportBody: prepared.report.body, reportData: prepared.report.data, reportSchemaId: prepared.report.schemaId, reportArtifactIds: prepared.report.artifactIds } };
      },
    ]);
    ctx.llm.registerAdapter(['cli-offline'], adapter);
    const claim = ledger.claim('cli-native-claim', { runId: run.runId, nodeId: service.config.nodeId, ttlMs: 10000 }).value;
    const result = await service.native.execute(claim);
    assert.equal(result.run.state, 'succeeded');
    assert.equal(result.run.validation, undefined);
    assert.equal(result.run.outcome, undefined);
    assert.equal(ledger.history(task.taskId).artifacts.length, 1);
    assert.equal(adapter.requests.length, 2);
    preparedArtifact = true;
    const { makeTemplate } = await import(pathToFileURL(require.resolve('@dsh-task/task-system/activity/plugin')).href.replace(/plugin\.mjs$/, 'report.mjs'));
    const activityTemplate = makeTemplate('daily');
    const activityTask = ledger.createTask('cli-activity-task', { title: 'Installed official activity reader', tags: ['daily-report'], policy: { allowedTools: ['activity_sources_read', 'activity_report_prepare'] } }).value;
    const activityRun = ledger.createRun('cli-activity-run', { taskId: activityTask.taskId, configuration: { template: activityTemplate, input: { windowStart: new Date(Date.now() - 86400000).toISOString(), windowEnd: new Date(Date.now() + 86400000).toISOString(), timeZone: 'UTC' } }, route: { nodeId: service.config.nodeId, provider: 'cli-activity', model: 'script', requiredCapabilities: [] } }).value;
    const activityAdapter = new ScriptedModel([
      { name: 'activity_sources_read', args: {} },
      options => {
        const response = options.messages.findLast(message => message.role === 'tool');
        assert.equal(response?.isError, false, JSON.stringify(response?.content));
        const capture = JSON.parse(response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
        assert.deepEqual(capture.sources[0].errors, []);
        assert.deepEqual(capture.sources[0].entries, [], 'Task-injected work must not become human conversation activity');
        return { name: 'activity_report_prepare', args: { sourceReceiptId: capture.sourceReceiptId, kind: 'daily', summaries: [] } };
      },
      options => {
        const response = options.messages.findLast(message => message.role === 'tool');
        assert.equal(response?.isError, false, JSON.stringify(response?.content));
        const result = JSON.parse(response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
        return { name: 'task_submit_result', args: { outcome: result.outcome, summary: result.summary, reportTitle: result.report.title, reportBody: result.report.body, reportData: result.report.data, reportSchemaId: result.report.schemaId } };
      },
    ]);
    ctx.llm.registerAdapter(['cli-activity'], activityAdapter);
    const activityClaim = ledger.claim('cli-activity-claim', { runId: activityRun.runId, nodeId: service.config.nodeId, ttlMs: 10000 }).value;
    const activityResult = await service.native.execute(activityClaim);
    assert.equal(activityResult.run.state, 'succeeded');
    assert.equal(ledger.history(activityTask.taskId).reports.at(-1).schemaId, 'dsh_agent_activity_daily.v1');
  }
  writeFileSync(process.env.DSH_TASK_PROBE_OUT, JSON.stringify({
    ok: true, role: service.config.role, native: Boolean(service.native),
    tools: ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('task_')),
    taskId: ledger.getTask('cli-retained-task').taskId,
    installedTaskPack: true, installedDisabledQuota: true, installedDisabledApprovalBridge: true, preparedArtifact,
  }));
  // Deliberately no exit request: the acceptance runner verifies the host
  // remains alive after this finite probe returns, then sends SIGTERM.
}
