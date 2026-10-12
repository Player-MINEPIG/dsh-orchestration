import { canonicalJson } from '../reporting.mjs';

export const NODE_SCHEMA = 'dsh_agent_activity_node.v1';
export const DAILY_SCHEMA = 'dsh_agent_activity_daily.v1';
export const NODE_VALIDATOR = 'dsh-activity.node.v1';
export const DAILY_VALIDATOR = 'dsh-activity.daily.v1';
const requireThat = (value, message) => { if (!value) throw new Error(message); };
const statuses = ['completed', 'in_progress', 'blocked', 'failed', 'cancelled', 'unknown'];
export function sameWindow(a, b) { return Date.parse(a?.start) === Date.parse(b?.start) && Date.parse(a?.end) === Date.parse(b?.end) && a?.timeZone === b?.timeZone; }
export function inputWindow(input) {
  requireThat(typeof input?.timeZone === 'string' && input.timeZone.length > 0, 'Explicit report time zone required');
  requireThat(Number.isFinite(Date.parse(input?.windowStart)) && Date.parse(input.windowStart) < Date.parse(input.windowEnd), 'Pinned report window required');
  new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format();
  return { start: new Date(input.windowStart).toISOString(), end: new Date(input.windowEnd).toISOString(), timeZone: input.timeZone };
}
export function buildNodeReport(capture, summaries) {
  requireThat(Array.isArray(summaries), 'Evidence summaries required');
  const entries = capture.sources.flatMap(s => s.entries), refs = new Set(entries.map(e => e.sourceRef));
  requireThat(refs.size === entries.length && summaries.length === refs.size, 'Every observed turn needs exactly one summary');
  for (const item of summaries) {
    requireThat(item && refs.delete(item.sourceRef) && typeof item.title === 'string' && item.title.trim() && item.title.length <= 300 && typeof item.summary === 'string' && item.summary.length <= 2000 && statuses.includes(item.status), 'Invalid or repeated evidence summary');
  }
  requireThat(refs.size === 0, 'Source evidence omitted');
  return { schema_version: NODE_SCHEMA, nodeId: capture.nodeId, window: capture.window, sources: capture.sources,
    summaries, turnCount: entries.length, partial: capture.sources.some(s => s.errors.length > 0 || s.entries.some(e => e.truncated)) };
}
export function validateNodeReport(payload) {
  requireThat(payload?.schema_version === NODE_SCHEMA && typeof payload.nodeId === 'string' && Array.isArray(payload.sources), 'Invalid activity node report');
  requireThat(payload.sources.length > 0 && new Set(payload.sources.map(s => s.runtime)).size === payload.sources.length, 'Repeated or absent runtime sources');
  for (const source of payload.sources) {
    requireThat(['dsh', 'codex'].includes(source.runtime) && sameWindow(source.window, payload.window) && Array.isArray(source.entries) && Array.isArray(source.errors), 'Invalid activity source');
    requireThat(source.entries.every(e => e.runtime === source.runtime && typeof e.sourceRef === 'string'), 'Source runtime mismatch');
  }
  requireThat(canonicalJson(buildNodeReport(payload, payload.summaries)) === canonicalJson(payload), 'Activity report derived fields changed');
  return payload;
}
export function makeTemplate(kind) {
  const node = kind === 'node';
  return { templateId: `dsh-activity-${kind}`, version: 1, name: node ? 'DSH/Codex 节点采集' : 'DSH/Codex Agent 日报',
    description: 'Read official host APIs and summarize only DSH and Codex work with source references.',
    inputSchema: { type: 'object', properties: { windowStart: { type: 'string' }, windowEnd: { type: 'string' }, timeZone: { type: 'string' } }, required: ['windowStart', 'windowEnd', 'timeZone'], additionalProperties: false }, defaults: {},
    resultValidator: node ? NODE_VALIDATOR : DAILY_VALIDATOR,
    resultContract: { type: 'object', properties: { outcome: { enum: ['success', 'partial', 'failure', 'blocked', 'unknown'] }, summary: { type: 'string' }, report: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, schemaId: { const: node ? NODE_SCHEMA : DAILY_SCHEMA }, data: { type: 'object' } }, required: ['title', 'body', 'schemaId', 'data'] } }, required: ['outcome', 'summary', 'report'] } };
}
export function buildDailyReport({ ledger, run, local, expectedNodes }) {
  validateNodeReport(local);
  const nodes = [local], errors = [], childTasks = ledger.snapshot().tasks.filter(t => t.parentRunId === run.runId);
  for (const nodeId of expectedNodes.filter(id => id !== local.nodeId)) {
    const candidates = [];
    for (const task of childTasks) {
      const history = ledger.history(task.taskId);
      for (const childRun of history.runs ?? []) {
        if (childRun.parentRunId !== run.runId || childRun.route?.nodeId !== nodeId) continue;
        const report = (history.reports ?? []).filter(r => r.runId === childRun.runId && r.kind === 'result' && r.schemaId === NODE_SCHEMA).at(-1);
        if (report && ['succeeded', 'partial'].includes(childRun.state)) candidates.push(report.data);
      }
    }
    requireThat(candidates.length <= 1, 'Multiple accepted node reports for one daily window');
    if (candidates.length) { validateNodeReport(candidates[0]); requireThat(candidates[0].nodeId === nodeId, 'Child report node mismatch'); requireThat(sameWindow(candidates[0].window, local.window), 'Child report window mismatch'); nodes.push(candidates[0]); }
    else errors.push({ nodeId, error: 'No accepted node report for this root run' });
  }
  const start = Date.parse(local.window.start), end = Date.parse(local.window.end);
  const snapshot = ledger.snapshot();
  const tasks = new Map(snapshot.tasks.map(t => [t.taskId, t]));
  const isReportTask = task => { const seen = new Set(); while (task && !seen.has(task.taskId)) { if (task.tags?.includes('daily-report')) return true; seen.add(task.taskId); task = tasks.get(task.parentTaskId); } return false; };
  const executions = snapshot.runs.filter(r => { const task = tasks.get(r.taskId); return task && !isReportTask(task) && Date.parse(r.createdAt) >= start && Date.parse(r.createdAt) < end; }).map(r => ({ taskId: r.taskId, runId: r.runId, nodeId: r.route?.nodeId ?? null, state: r.state }));
  return { schema_version: DAILY_SCHEMA, window: local.window, rootRunId: run.runId, nodes, missingNodes: errors, executions,
    turnCount: nodes.reduce((n, node) => n + node.turnCount, 0), partial: errors.length > 0 || nodes.some(n => n.partial),
    note: 'Conversation turns and managed DSH executions are separate counts; completion statuses in summaries are semantic assessments.' };
}
export function renderReport(payload) {
  const nodes = payload.schema_version === NODE_SCHEMA ? [payload] : payload.nodes;
  return [`# DSH / Codex 工作日报`, `${payload.window.start} — ${payload.window.end} (${payload.window.timeZone})`,
    ...nodes.flatMap(node => [`\n## ${node.nodeId}`, ...node.summaries.map(s => `- **${s.title}** · ${s.status}\n  ${s.summary}\n  来源：${s.sourceRef}`), ...(node.turnCount ? [] : ['本窗口未观测到符合条件的用户工作轮次。']), ...node.sources.flatMap(s => s.errors.map(e => `- 来源缺口 (${s.runtime})：${e.error}`))]),
    ...(payload.missingNodes ?? []).map(e => `\n缺失节点：${e.nodeId} — ${e.error}`),
    ...(payload.executions ? [`\nDSH 托管执行：${payload.executions.length} 次（与会话轮次数分开统计）。`] : []),
    '\n用量未获得可核实的每日接口数据时标为不可用，不按零计。'].join('\n');
}
