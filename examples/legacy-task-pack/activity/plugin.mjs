import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createHash, randomUUID } from 'node:crypto';
import { collectCodex } from './codex.mjs';
import { collectDsh } from './dsh.mjs';
import { canonicalJson } from '../reporting.mjs';
import { NODE_SCHEMA, DAILY_SCHEMA, NODE_VALIDATOR, DAILY_VALIDATOR, inputWindow, sameWindow, buildNodeReport, validateNodeReport, buildDailyReport, renderReport } from './report.mjs';

export const name = 'dsh-codex-activity-reports';
export const inject = ['taskSystem', 'tools', 'sessionPersistence'];
export const Config = z.object({ codexExecutable: z.string().default(''), expectedNodeIds: z.array(z.string()).default([]), maxSourceBytes: z.number().min(1024).max(16777216).default(2097152) });
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function apply(ctx, config) {
  const captures = new Map(), prepared = new Map(), abort = new AbortController(), jobs = new Set();
  const ledger = ctx.taskSystem.ledger;
  const owned = agent => { const scope = ctx.taskSystem.native?.scopeFor(agent); if (!scope) throw new Error('Activity collection requires an owned task attempt'); return scope; };
  const live = entry => { const agent = entry.agent.deref(), scope = agent && ctx.taskSystem.native?.scopeFor(agent); return scope && scope.ref.attemptId === entry.attemptId && scope.ref.executionId === entry.executionId; };
  const cleanup = () => { for (const map of [captures, prepared]) for (const [key, entry] of map) if (!live(entry)) map.delete(key); };
  const validator = (schema, root) => ({ task, run, attempt, submission, phase }) => {
    try {
      if (submission.report?.schemaId !== schema) throw new Error('Wrong activity report schema');
      const payload = submission.report.data, window = inputWindow(run.configuration?.input);
      if (!sameWindow(payload?.window, window)) throw new Error('Activity window differs from pinned input');
      if (submission.report.body !== renderReport(payload)) throw new Error('Activity report text differs from its evidence');
      if (phase === 'executor-preflight') {
        const proof = prepared.get(`${attempt.attemptId}:${hash(payload)}`);
        if (!proof || !live(proof) || proof.taskId !== task.taskId || proof.runId !== run.runId) throw new Error('Activity report was not prepared from this attempt');
      }
      if (root) {
        const local = payload.nodes?.find(n => n.nodeId === run.route?.nodeId);
        if (!local) throw new Error('Authority source missing');
        const expected = buildDailyReport({ ledger, run, local, expectedNodes: config.expectedNodeIds });
        if (canonicalJson(expected) !== canonicalJson(payload)) throw new Error('Daily report differs from accepted child results');
      } else {
        validateNodeReport(payload);
        if (payload.nodeId !== run.route?.nodeId) throw new Error('Activity report node mismatch');
      }
      if (submission.outcome === 'success' && payload.partial) throw new Error('Partial source evidence cannot settle as complete success');
      return { valid: true };
    } catch (error) { return { valid: false, errors: [error.message] }; }
  };
  ctx.effect(() => ledger.registerResultValidator(NODE_VALIDATOR, validator(NODE_SCHEMA, false)));
  ctx.effect(() => ledger.registerResultValidator(DAILY_VALIDATOR, validator(DAILY_SCHEMA, true)));
  ctx.effect(() => async () => { abort.abort(); await Promise.allSettled([...jobs]); captures.clear(); prepared.clear(); });
  ctx.tools.register(defineTool({ name: 'activity_sources_read', description: 'Read this node’s DSH/Codex activity for the immutable task window through official read APIs. No Hermes source, no model calls, no session mutations. Returns source references and an attempt-bound receipt.', parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (_args, exec) => {
    const scope = owned(exec.agent), window = inputWindow(scope.claim.run.configuration?.input), signal = AbortSignal.any([abort.signal, exec.signal]);
    cleanup(); if (captures.size >= 64) throw new Error('Activity capture capacity reached');
    const job = (async () => {
      const sources = [];
      for (const [runtime, collect] of [
        ['dsh', () => collectDsh({ persistence: ctx.sessionPersistence, window, signal })],
        ...(config.codexExecutable ? [['codex', () => collectCodex({ executable: config.codexExecutable, window, signal })]] : []),
      ]) {
        try { sources.push(await collect()); }
        catch (error) { signal.throwIfAborted(); sources.push({ runtime, method: 'official-api', window, entries: [], errors: [{ error: error.message }], usage: { observability: 'unavailable' } }); }
      }
      const capture = { nodeId: scope.ref.nodeId, window, sources };
      if (Buffer.byteLength(canonicalJson(capture)) > config.maxSourceBytes) throw new Error('Activity source output exceeds configured bound; narrow the window');
      const sourceReceiptId = randomUUID(); captures.set(sourceReceiptId, { agent: new WeakRef(exec.agent), attemptId: scope.ref.attemptId, executionId: scope.ref.executionId, capture });
      return { sourceReceiptId, ...capture };
    })(); jobs.add(job); try { return await job; } finally { jobs.delete(job); }
  } }));
  ctx.tools.register(defineTool({ name: 'activity_report_prepare', description: 'Prepare a node or authority daily report from this attempt’s source receipt. Supply exactly one factual Chinese summary per sourceRef. kind=daily requires all delegated node reports to be settled on this authority. Then pass the returned report and recommended outcome to task_settle.', parameters: { sourceReceiptId: { type: 'string', required: true }, kind: { type: 'string', enum: ['node', 'daily'], required: true }, summaries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { sourceRef: { type: 'string', required: true }, title: { type: 'string', required: true }, summary: { type: 'string', required: true }, status: { type: 'string', required: true, enum: ['completed', 'in_progress', 'blocked', 'failed', 'cancelled', 'unknown'] } } }, required: true } }, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, exec) => {
    const scope = owned(exec.agent); cleanup(); const capture = captures.get(args.sourceReceiptId);
    if (!capture || capture.attemptId !== scope.ref.attemptId || !live(capture)) throw new Error('Source receipt does not belong to this attempt');
    const local = buildNodeReport(capture.capture, args.summaries);
    const payload = args.kind === 'daily' ? buildDailyReport({ ledger, run: ledger.getRun(scope.ref.runId), local, expectedNodes: config.expectedNodeIds }) : local;
    const body = renderReport(payload), report = { title: args.kind === 'daily' ? 'DSH / Codex Agent 工作日报' : `${scope.ref.nodeId} 工作采集`, body, schemaId: args.kind === 'daily' ? DAILY_SCHEMA : NODE_SCHEMA, data: payload };
    if (prepared.size >= 512) throw new Error('Prepared activity report capacity reached');
    prepared.set(`${scope.ref.attemptId}:${hash(payload)}`, { agent: new WeakRef(exec.agent), attemptId: scope.ref.attemptId, executionId: scope.ref.executionId, taskId: scope.claim.task.taskId, runId: scope.ref.runId });
    return { outcome: payload.partial ? 'partial' : 'success', summary: `${report.title}：${payload.turnCount} 个工作轮次${payload.partial ? '，存在来源缺口或截断' : ''}`, report };
  } }));
}
