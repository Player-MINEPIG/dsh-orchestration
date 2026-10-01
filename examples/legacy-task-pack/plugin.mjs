import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createHash } from 'node:crypto';
import { canonicalJson, buildAgentDaily, buildNodeReport, createDailyWorkInput, buildDailyWorkSummary, prepareLegacyReport, registerLegacyTaskPack, registerLegacyRenderers } from './index.mjs';
import { readConfiguredSources } from './configured-sources.mjs';
export const name = 'configurable-legacy-task-pack';
export const inject = ['taskSystem', 'tools'];
export const Config = z.object({ validatorPrefix: z.string().default('legacy-task-pack'), artifactDirectory: z.string().default('.runtime/legacy-report-artifacts'), timeZone: z.string().default('Asia/Shanghai'), accountMeasurementNodeId: z.string().default(''), policySkippedSources: z.array(z.object({ nodeId: z.string().required(), runtime: z.union([z.const('codex'), z.const('hermes')]).required() })).default([]), sourceRegistry: z.array(z.object({ id: z.string().required(), root: z.string().required(), manifest: z.string().required() })).default([]), maxSourceOutputBytes: z.number().min(1024).max(16777216).step(1).default(1048576), nodeAliases: z.dict(String).default({}), nodeIds: z.array(z.string()).default([]), expectedNodeIds: z.array(z.string()).default([]), quietWindowMs: z.number().min(0).max(300000).default(0), automationIds: z.array(z.string()).default(['hsr_march7thassistant', 'zzz_onedragon', 'arknights_maa']) });
export function apply(ctx, config) {
  if (config.policySkippedSources.some(item => !item.nodeId.trim())) throw new Error('Policy-skipped sources need exact nonempty node IDs');
  const preparedEnvelopes = new Map();
  const envelopeHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const policy = { ...config, ...(config.nodeIds.length ? { nodeIds: config.nodeIds } : { nodeIds: undefined }), verifyPreparedEnvelope({ kind, envelope, task, run, attempt }) {
    const proof = preparedEnvelopes.get(`${attempt.attemptId}:${kind}:${envelopeHash(envelope)}`);
    return Boolean(proof && alive(proof) && proof.taskId === task.taskId && proof.runId === run.runId && proof.attemptId === attempt.attemptId && proof.executionId === attempt.executionId);
  } };
  const captures = new Map(); const controller = new AbortController(); const jobs = new Set(); let captureSequence = 0;
  const alive = value => { const agent = value.agent.deref(); const live = agent && ctx.taskSystem.native?.scopeFor(agent); return live && live.ref.attemptId === value.attemptId && live.ref.executionId === value.executionId; };
  const cleanup = () => { for (const [key, value] of captures) if (!alive(value)) captures.delete(key); for (const [key, value] of preparedEnvelopes) if (!alive(value)) preparedEnvelopes.delete(key); };
  ctx.effect(() => async () => { controller.abort(new Error('Legacy source reader unloaded')); await Promise.allSettled([...jobs]); captures.clear(); preparedEnvelopes.clear(); });
  ctx.effect(() => registerLegacyTaskPack(ctx.taskSystem.ledger, policy));
  ctx.inject(['feishuChannel'], channelCtx => { channelCtx.effect(() => registerLegacyRenderers(channelCtx.feishuChannel, ctx.taskSystem.ledger, policy)); });
  ctx.tools.register(defineTool({ name: 'legacy_report_prepare', description: 'Build and prepare a validated configured legacy report. Does not settle execution; pass the returned structured report to task_settle only after all work is quiescent.', parameters: { commandId: { type: 'string', required: true }, kind: { type: 'string', enum: ['agent_daily', 'game_daily', 'agent_daily_node', 'daily_work_summary', 'automation_diagnostics'], required: true }, input: { type: 'json', required: true } }, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, exec) => {
    exec.signal.throwIfAborted(); const scope = ctx.taskSystem.native?.scopeFor(exec.agent);
    if (!scope) throw new Error('legacy_report_prepare requires the exact owned native attempt');
    const identity = { taskId: scope.claim.task.taskId, runId: scope.claim.run.runId };
    let payload;
    if (args.kind === 'agent_daily') payload = buildAgentDaily(args.input, identity, policy);
    else {
      cleanup(); const capture = captures.get(args.input.sourceReceiptId);
      if (!capture || capture.attemptId !== scope.ref.attemptId || capture.executionId !== scope.ref.executionId) throw new Error('Node/game preparation requires this owned attempt source receipt');
      const source = capture.bundle.sources.find(s => s.sourceId === args.input.sourceId);
      if (!source) throw new Error('Source receipt has no selected source ID');
      if (args.kind === 'game_daily') { if (!source.data.game) throw new Error('Configured source has no game reader'); payload = source.data.game; }
      else if (args.kind === 'automation_diagnostics') { if (!source.data.diagnostics) throw new Error('Configured source has no automation diagnostics reader'); payload = source.data.diagnostics; }
      else if (args.kind === 'daily_work_summary') { payload = buildDailyWorkSummary(createDailyWorkInput({ nodeId: config.nodeAliases[scope.ref.nodeId] ?? scope.ref.nodeId, codex: source.data.codex, hermes: source.data.hermes, semantic: args.input.semantic, language: args.input.language ?? 'zh' })); }
      else { if (!source.data.codex || !source.data.hermes) throw new Error('Configured node source needs Codex and Hermes readers'); payload = buildNodeReport({ nodeId: config.nodeAliases[scope.ref.nodeId] ?? scope.ref.nodeId, codex: source.data.codex, hermes: source.data.hermes, semantic: args.input.semantic, sources: { codex: `source:${source.sourceId}:codex`, hermes: `source:${source.sourceId}:hermes` }, accountMeasurementNodeId: config.accountMeasurementNodeId }); }
    }
    const prepared = prepareLegacyReport(ctx.taskSystem.ledger, args.commandId, { kind: args.kind, lease: scope.ref, identity, payload, ...(args.kind === 'agent_daily' ? { builderInput: args.input, artifactDirectory: config.artifactDirectory } : {}), config: policy });
    if (args.kind !== 'agent_daily') {
      cleanup(); const key = `${scope.ref.attemptId}:${args.kind}:${envelopeHash(prepared.report.data)}`;
      if (!preparedEnvelopes.has(key) && preparedEnvelopes.size >= 512) throw new Error('Prepared source envelope capacity reached; unresolved proofs retained');
      preparedEnvelopes.set(key, { agent: new WeakRef(exec.agent), taskId: identity.taskId, runId: identity.runId, attemptId: scope.ref.attemptId, executionId: scope.ref.executionId });
    }
    exec.signal.throwIfAborted(); return { summary: prepared.summary, report: prepared.report };
  } }));
  ctx.tools.register(defineTool({ name: 'legacy_sources_read', description: 'Read only configured source IDs authorized by the current task input; paths, SQL and commands cannot be supplied. Returns full bounded evidence and an attempt-bound source receipt.', parameters: { sourceIds: { type: 'array', items: { type: 'string' } } }, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: async (args, exec) => {
    exec.signal.throwIfAborted(); controller.signal.throwIfAborted(); const scope = ctx.taskSystem.native?.scopeFor(exec.agent);
    if (!scope) throw new Error('legacy_sources_read requires the exact owned native attempt');
    cleanup(); if (captures.size >= 64) throw new Error('Source receipt capacity reached; unresolved owned captures retained');
    const input = scope.claim.run.configuration?.input;
    const job = readConfiguredSources({ registry: config.sourceRegistry, authorizedIds: input?.sourceIds, sourceIds: args.sourceIds ?? input?.sourceIds, input: input ?? {}, nodeId: config.nodeAliases[scope.ref.nodeId] ?? scope.ref.nodeId, timeZone: config.timeZone, maxOutputBytes: config.maxSourceOutputBytes, signal: AbortSignal.any([exec.signal, controller.signal]) });
    jobs.add(job); let bundle; try { bundle = await job; } finally { jobs.delete(job); }
    exec.signal.throwIfAborted(); controller.signal.throwIfAborted(); const sourceReceiptId = `legacy-source-${scope.ref.attemptId}-${++captureSequence}`;
    captures.set(sourceReceiptId, { agent: new WeakRef(exec.agent), attemptId: scope.ref.attemptId, executionId: scope.ref.executionId, bundle });
    return { sourceReceiptId, ...bundle };
  } }));
}
