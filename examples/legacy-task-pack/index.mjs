import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync, lstatSync, fstatSync, readSync, realpathSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { canonicalJson, buildAgentDaily, getAgentBuilderInput, validateNodeEvidenceGate, validateAgentDaily, validateGameDaily, validateNodeReport, renderAgentDaily, renderGameDaily, ReportContractError } from './reporting.mjs';
import { buildDailyWorkSummary, getDailyWorkInput, validateDailyWorkSummary, renderDailyWorkSummary } from './ad-hoc.mjs';
import { validateAutomationDiagnostics, renderAutomationDiagnostics } from './diagnostics/index.mjs';
export * from './reporting.mjs';
export * from './ad-hoc.mjs';
export { readConfiguredSources } from './configured-sources.mjs';
export * from './quota/index.mjs';
export { parseLegacyAgentOutput } from './compatibility/index.mjs';
export * from './diagnostics/index.mjs';

export const SCHEMAS = { agent_daily: 'agent_daily_report.v1', game_daily: 'game_daily_report.v1', agent_daily_node: 'agent_daily_node_report.v1', daily_work_summary: 'daily_work_summary.v1', automation_diagnostics: 'automation_diagnostics.v1' };
const hash = value => createHash('sha256').update(value).digest('hex');
const checked = (value, message) => { if (!value) throw new ReportContractError(message); };
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
function readBoundedArtifact(path, expectedBytes) {
  checked(Number.isSafeInteger(expectedBytes) && expectedBytes >= 0 && expectedBytes <= MAX_ARTIFACT_BYTES, 'Artifact exceeds maximum size');
  const before = lstatSync(path); checked(before.isFile() && !before.isSymbolicLink() && before.size === expectedBytes, 'Artifact file type/size changed before delivery');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(descriptor); checked(actual.isFile() && actual.size === expectedBytes && actual.ino === before.ino && actual.dev === before.dev, 'Artifact changed while opening');
    const bytes = Buffer.alloc(expectedBytes); let offset = 0;
    while (offset < expectedBytes) { const n = readSync(descriptor, bytes, offset, expectedBytes - offset, offset); checked(n > 0, 'Truncated artifact'); offset += n; }
    checked(readSync(descriptor, Buffer.alloc(1), 0, 1, expectedBytes) === 0 && fstatSync(descriptor).size === expectedBytes, 'Artifact grew during bounded read');
    return bytes;
  } finally { closeSync(descriptor); }
}
const validatorId = (kind, config) => `${config.validatorPrefix ?? 'legacy-task-pack'}:${kind}:v1`;
function validate(kind, payload, config) {
  if (kind === 'agent_daily') return validateAgentDaily(payload, config);
  if (kind === 'game_daily') return validateGameDaily(payload, config).report;
  if (kind === 'agent_daily_node') return validateNodeReport(payload, config);
  if (kind === 'daily_work_summary') return validateDailyWorkSummary(payload);
  if (kind === 'automation_diagnostics') return validateAutomationDiagnostics(payload);
  throw new ReportContractError('Unknown task pack kind');
}
function rendered(kind, payload, config) {
  if (kind === 'agent_daily') return renderAgentDaily(payload, config);
  if (kind === 'game_daily') return renderGameDaily(payload, config);
  if (kind === 'daily_work_summary') return renderDailyWorkSummary(payload);
  if (kind === 'automation_diagnostics') return renderAutomationDiagnostics(payload, { maxOutputChars: payload.bounds.maxOutputChars });
  return { title: `Node evidence · ${payload.device_id}`, body: `${payload.work_candidates.length} evidence-bound work candidates; data: ${payload.data_quality.status}`, detail: payload };
}
export function createLegacyTemplates(config = {}) {
  return Object.keys(SCHEMAS).map(kind => ({
    templateId: `${config.templatePrefix ?? 'legacy'}-${kind.replaceAll('_', '-')}`, version: config.version ?? 1,
    name: kind.replaceAll('_', ' '), description: 'Reviewed configurable legacy evidence/report task; no implicit data access or automation control',
    inputSchema: { type: 'object', properties: { sourceIds: { type: 'array', items: { type: 'string' }, minItems: 1 }, windowStart: { type: 'string' }, windowEnd: { type: 'string' }, timeZone: { type: 'string' }, semantic: { type: 'object' } }, required: ['sourceIds', 'windowStart', 'windowEnd'], additionalProperties: false },
    defaults: { sourcePolicy: 'explicit-read-only', kind, capability: 'legacy.task-pack.v1', validatorVersion: 1, expectedNodeIds: config.expectedNodeIds ?? [] },
    resultValidator: validatorId(kind, config),
    resultContract: { type: 'object', properties: { outcome: { enum: ['success', 'partial', 'failure', 'blocked', 'unknown'] }, summary: { type: 'string', minLength: 1 }, report: { type: 'object', properties: { title: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1 }, data: { type: 'object' }, schemaId: { enum: [SCHEMAS[kind], 'legacy_task_pack_error.v1'] }, artifactIds: { type: 'array', items: { type: 'string' } } }, required: ['title', 'body', 'data', 'schemaId'], additionalProperties: false } }, required: ['outcome', 'summary', 'report'], additionalProperties: false },
  }));
}

/** Trusted operator code only. A model cannot register or substitute this validator. */
export function registerLegacyTaskPack(ledger, config = {}) {
  const disposers = [];
  for (const kind of Object.keys(SCHEMAS)) {
    disposers.push(ledger.registerResultValidator(validatorId(kind, config), ({ task, run, attempt, submission, phase }) => {
      const report = submission.report;
      checked(report && report.data, 'Structured report is required');
      if (report.schemaId === 'legacy_task_pack_error.v1') {
        checked(submission.outcome === 'failure' || submission.outcome === 'blocked', 'Error receipt cannot claim success');
        checked(Array.isArray(report.data.errors) && report.data.errors.length && report.data.errors.every(e => typeof e === 'string' && e.length <= 1000), 'Error receipt needs bounded diagnostics');
        return { valid: true };
      }
      checked(report.schemaId === SCHEMAS[kind], 'Wrong structured result contract');
      const envelope = report.data;
      checked(envelope.schema_version === 'legacy_task_pack_result.v1' && envelope.binding?.task_id === task.taskId && envelope.binding?.run_id === run.runId, 'Structured result binding does not match assignment');
      if (phase === 'executor-preflight' && kind !== 'agent_daily') checked(typeof config.verifyPreparedEnvelope === 'function' && config.verifyPreparedEnvelope({ kind, envelope, task, run, attempt }) === true, 'Source result was not prepared from this exact native attempt capture');
      const data = validate(kind, envelope.payload, config);
      if (kind !== 'agent_daily') {
        const sourceNode = config.nodeAliases?.[run.route?.nodeId] ?? run.route?.nodeId;
        checked((kind === 'game_daily' ? data.report_meta.device_id : data.device_id) === sourceNode, 'Report source node does not match authenticated assignment');
      }
      if (kind === 'daily_work_summary') {
        checked(envelope.builder_input && canonicalJson(buildDailyWorkSummary(envelope.builder_input)) === canonicalJson(data), 'Daily-work report differs from retained source/semantic input');
        const input = run.configuration?.input;
        checked(input && Date.parse(input.windowStart) === Date.parse(data.window.start) && Date.parse(input.windowEnd) === Date.parse(data.window.end), 'Daily-work source window differs from pinned task input');
      }
      if (kind === 'automation_diagnostics') checked(Date.parse(run.configuration?.input?.windowEnd) === Date.parse(data.collected_at), 'Diagnostic lookback endpoint differs from pinned task input');
      if (kind === 'agent_daily') {
        checked(data.trace.root_task_id === task.taskId && data.trace.root_run_id === run.runId, 'Root report trace does not match current assignment');
        checked(envelope.builder_input, 'Root must preserve its bounded builder/evidence input');
        const rebuilt = buildAgentDaily(envelope.builder_input, { taskId: task.taskId, runId: run.runId }, config);
        checked(canonicalJson(rebuilt) === canonicalJson(data), 'Root derived fields were not built from the retained semantic input');
        const expectedNodeIds = config.expectedNodeIds ?? [];
        if (expectedNodeIds.length) {
          const state = ledger.allSettled(task.taskId, config.quietWindowMs ?? 0, run.runId);
          checked(state.settled, 'Node task settlement is not complete');
          const nodes = [];
          const belongsToRootRun = (candidate, childTask) => {
            let parent = candidate.parentRunId ?? childTask.parentRunId;
            // Preserve the core's explicit unbound-legacy compatibility scope.
            if (!parent) return true;
            const seen = new Set();
            while (parent && !seen.has(parent)) {
              if (parent === run.runId) return true;
              seen.add(parent); const ancestor = ledger.getRun(parent);
              parent = ancestor.parentRunId ?? ledger.getTask(ancestor.taskId).parentRunId;
            }
            return false;
          };
          for (const childId of state.taskIds) {
            const history = ledger.history(childId); const latest = history.runs.filter(candidate => !candidate.historyOnly && !candidate.observationOnly && belongsToRootRun(candidate, history.task)).at(-1);
            const accepted = history.reports.filter(r => r.runId === latest?.runId && r.kind === 'result' && r.schemaId === SCHEMAS.agent_daily_node).at(-1);
            if (accepted) {
              // New Runs provide their actual state and terminal evidence,
              // never a fabricated validation field. An arbitrary appended
              // result alone cannot establish successful submitted evidence.
              const appended = history.events.findIndex(event => event.type === 'report.appended' && event.runId === latest.runId && event.detail.reportId === accepted.reportId);
              const settled = history.events.findIndex(event => event.type === 'run.settled' && event.runId === latest.runId && event.detail.attemptId === accepted.attemptId);
              const execution = latest.intentSnapshot
                ? { state: latest.state, ...(appended >= 0 && settled > appended ? { settlement: history.events[settled] } : {}) }
                : { outcome: latest.outcome, validation: latest.validation };
              nodes.push({ nodeId: accepted.data.payload.device_id, rootTaskId: task.taskId, rootRunId: run.runId, ...execution, report: accepted.data.payload });
            }
          }
          validateNodeEvidenceGate(envelope.builder_input, nodes, expectedNodeIds);
        }
      }
      const body = rendered(kind, data, config);
      checked(report.title === body.title && report.body === body.body, 'Presentation must be derived from validated authoritative payload');
      const ids = report.artifactIds ?? [];
      checked(kind !== 'agent_daily' || ids.length === 1, 'One finalized root report artifact is required');
      if (kind !== 'agent_daily' && ids.length === 0) return { valid: true };
      checked(ids.length === 1, 'At most one finalized report artifact is supported');
      const artifact = ledger.history(task.taskId).artifacts.find(a => a.artifactId === ids[0]);
      const bytes = Buffer.from(canonicalJson(envelope));
      checked(artifact && artifact.taskId === task.taskId && artifact.finalized && artifact.sha256 === hash(bytes) && artifact.bytes === bytes.length, 'Finalized artifact metadata does not match authoritative payload');
      // Core report() verifies actual file bytes after this pure metadata gate,
      // inside the same authoritative settlement transaction.
      return { valid: true };
    }));
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

/** Render only ledger-owned data, never an arbitrary model-supplied outbox card. */
export function registerLegacyRenderers(channel, ledger, config = {}) {
  const disposers = Object.entries(SCHEMAS).map(([kind, schemaId]) => channel.registerTaskReportRenderer(schemaId, ({ task, run, report }) => {
    const envelope = report.data;
    const data = validate(kind, envelope.payload, config);
    const runId = run?.runId ?? report.runId;
    if (kind === 'agent_daily') checked(data.trace.root_task_id === task.taskId && data.trace.root_run_id === runId, 'Wrong authoritative report trace');
    checked(envelope.schema_version === 'legacy_task_pack_result.v1' && envelope.binding?.task_id === task.taskId && envelope.binding?.run_id === runId, 'Wrong authoritative report binding');
    checked(kind !== 'agent_daily' || report.artifactIds?.length === 1, 'Finalized root artifact required for report delivery');
    if (report.artifactIds?.length) {
      checked(report.artifactIds.length === 1, 'At most one report artifact supported');
      const artifact = ledger.history(task.taskId).artifacts.find(a => a.artifactId === report.artifactIds[0]);
      const expected = Buffer.from(canonicalJson(envelope));
      checked(artifact?.finalized && artifact.sha256 === hash(expected) && artifact.bytes === expected.length && artifact.uri, 'Artifact provenance mismatch');
      const actual = readBoundedArtifact(artifact.uri, expected.length); checked(hash(actual) === artifact.sha256, 'Artifact bytes changed before delivery');
    }
    const presentation = rendered(kind, data, config);
    return presentation.card ? { card: presentation.card } : { text: presentation.body };
  }));
  disposers.push(channel.registerTaskReportRenderer('legacy_task_pack_error.v1', ({ run, report }) => {
    checked(!run || ['failed', 'blocked'].includes(run.state), 'Error report cannot conceal successful execution');
    checked(Array.isArray(report.data?.errors) && report.data.errors.length && report.data.errors.every(e => typeof e === 'string'), 'Invalid error receipt');
    const content = report.data.errors.join('\n').slice(0, 5000);
    return { card: { header: { title: { tag: 'plain_text', content: 'Report unavailable' }, template: 'red' }, elements: [{ tag: 'div', text: { tag: 'plain_text', content } }] } };
  }));
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

function writeArtifact(directory, filename, bytes) {
  checked(bytes.length <= MAX_ARTIFACT_BYTES, 'Artifact exceeds maximum size');
  const root = resolve(directory); mkdirSync(root, { recursive: true, mode: 0o700 });
  checked(!lstatSync(root).isSymbolicLink(), 'Artifact directory must not be a symbolic link');
  const target = join(realpathSync(root), filename); const temporary = `${target}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  try {
    try { linkSync(temporary, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readBoundedArtifact(target, bytes.length);
      checked(hash(existing) === hash(bytes), 'Immutable artifact already exists with different bytes');
    }
    const dir = openSync(root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { try { unlinkSync(temporary); } catch {} }
  return target;
}

/** Prepare only. Native agents must subsequently use task_settle for quiescent commit. */
export function prepareLegacyReport(ledger, commandId, { kind, lease, payload, builderInput, identity, artifactDirectory, config = {} }) {
  const binding = identity ?? { taskId: ledger.getRun(lease.runId).taskId, runId: lease.runId };
  checked(binding.runId === lease.runId, 'Preparation run identity mismatch');
  let data = structuredClone(payload);
  data = validate(kind, data, config);
  const presentation = rendered(kind, data, config);
  const envelope = { schema_version: 'legacy_task_pack_result.v1', binding: { task_id: binding.taskId, run_id: binding.runId }, payload: data, ...(kind === 'agent_daily' ? { builder_input: getAgentBuilderInput(payload) ?? builderInput } : kind === 'daily_work_summary' ? { builder_input: builderInput ?? getDailyWorkInput(payload) } : {}) };
  checked(kind !== 'agent_daily' || envelope.builder_input, 'Root requires its bounded builder input');
  checked(kind !== 'daily_work_summary' || envelope.builder_input, 'Daily-work summary requires its bounded source/semantic input');
  const report = { title: presentation.title, body: presentation.body, data: envelope, schemaId: SCHEMAS[kind], artifactIds: [] };
  if (kind !== 'agent_daily' && !artifactDirectory) return { report, summary: presentation.body.slice(0, 5000), presentation };
  checked(artifactDirectory, 'Root preparation requires operator artifact directory');
  const run = ledger.getRun(lease.runId); checked(run.taskId === binding.taskId, 'Root must be prepared on its authority host');
  const bytes = Buffer.from(canonicalJson(envelope)); const sha256 = hash(bytes);
  const artifactId = `legacy_${hash(`${run.taskId}\0${run.runId}\0${sha256}`).slice(0, 40)}`;
  const uri = writeArtifact(artifactDirectory, `${artifactId}.json`, bytes);
  checked(hash(readBoundedArtifact(uri, bytes.length)) === sha256, 'Artifact write verification failed');
  ledger.registerArtifact(`${commandId}:artifact`, { artifactId, taskId: run.taskId, name: `${kind}.json`, mediaType: 'application/json', uri, sha256, bytes: bytes.length, finalized: true });
  report.artifactIds = [artifactId];
  return { report, summary: presentation.body.slice(0, 5000), artifactId, sha256, bytes: bytes.length, presentation };
}
/** For externally managed, already-quiescent execution; never call from a model preparation tool. */
export function settleLegacyReport(ledger, commandId, input) {
  const prepared = prepareLegacyReport(ledger, commandId, input);
  const receipt = ledger.submit(commandId, { ...input.lease, outcome: input.outcome ?? 'success', summary: prepared.summary, report: prepared.report, ...(input.destination ? { notifications: [{ destination: input.destination, kind: 'legacy-report', payload: { schemaId: prepared.report.schemaId, artifactId: prepared.artifactId ?? null } }] } : {}) });
  return { ...prepared, receipt };
}

export function settleLegacyFailure(ledger, commandId, { lease, errors, blocked = false, destination }) {
  const diagnostics = errors.map(e => String(e).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 1000));
  checked(diagnostics.length, 'Failure needs diagnostics'); const title = blocked ? 'Report blocked' : 'Invalid report'; const body = diagnostics.join('\n').slice(0, 5000);
  return ledger.submit(commandId, { ...lease, outcome: blocked ? 'blocked' : 'failure', summary: title, report: { title, body, schemaId: 'legacy_task_pack_error.v1', data: { errors: diagnostics } }, ...(destination ? { notifications: [{ destination, kind: 'legacy-report-error', payload: { text: body, card: { header: { title: { tag: 'plain_text', content: title }, template: 'red' }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: body } }] } } }] } : {}) });
}
