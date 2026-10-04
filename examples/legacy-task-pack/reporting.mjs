/** Independent, configurable implementations of legacy report/evidence contracts.
 * No original executable source is vendored. No network or credential access. */
import { createHash } from 'node:crypto';

export class ReportContractError extends Error {
  constructor(message) { super(message); this.name = 'ReportContractError'; this.code = 'REPORT_CONTRACT'; }
}
const insist = (condition, message) => { if (!condition) throw new ReportContractError(message); };
const object = (v, name) => { insist(v && typeof v === 'object' && !Array.isArray(v), `${name} must be an object`); return v; };
const array = (v, name) => { insist(Array.isArray(v), `${name} must be an array`); return v; };
const text = (v, name) => { insist(typeof v === 'string' && v.trim(), `${name} must be non-empty`); return v; };
const integer = (v, name) => { insist(Number.isSafeInteger(v) && v >= 0, `${name} must be a non-negative integer`); return v; };
const strings = (v, name) => array(v, name).forEach(x => insist(typeof x === 'string', `${name} must contain strings`));
const unique = (values, name) => insist(new Set(values).size === values.length, `${name} must be unique`);
const timestamp = (v, name, nullable = false) => { if (v === null && nullable) return null; insist(typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)), `${name} must have a timezone`); return Date.parse(v); };
const fields = (v, keys, name, exact = false) => { object(v, name); keys.forEach(k => insist(Object.hasOwn(v, k), `${name}.${k} is required`)); if (exact) insist(Object.keys(v).every(k => keys.includes(k)), `${name} contains unsupported semantic fields`); };
const copy = v => structuredClone(v);
const digest = v => createHash('sha256').update(v).digest('hex');
const retainedBuilderInputs = new WeakMap();
export const getAgentBuilderInput = report => retainedBuilderInputs.has(report) ? copy(retainedBuilderInputs.get(report)) : undefined;
export const TASK_STATUSES = ['completed', 'running', 'failed', 'blocked', 'cancelled'];
const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens'];
const OBSERVABILITY = ['exact', 'partial', 'unavailable'];
export function canonicalJson(value) {
  const normalize = v => {
    if (typeof v === 'number') insist(Number.isFinite(v), 'Non-finite JSON number');
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])]));
    insist(v !== undefined, 'Undefined JSON value'); return v;
  };
  return JSON.stringify(normalize(value));
}
function counts(tasks) {
  const value = Object.fromEntries(['total', ...TASK_STATUSES].map(k => [k, 0]));
  for (const task of tasks) { insist(TASK_STATUSES.includes(task.status), 'Unknown task status'); value[task.status]++; value.total++; }
  return value;
}
function usage(rows) {
  rows.forEach(row => { insist(OBSERVABILITY.includes(row.observability), 'Invalid usage observability'); TOKEN_FIELDS.forEach(k => { if (row[k] !== null) integer(row[k], k); }); });
  const usable = rows.filter(row => row.observability !== 'unavailable');
  return { ...Object.fromEntries(TOKEN_FIELDS.map(k => [k, usable.some(r => r[k] !== null) ? usable.reduce((a, r) => a + (r[k] ?? 0), 0) : null])), observability: !usable.length ? 'unavailable' : rows.every(r => r.observability === 'exact') ? 'exact' : 'partial' };
}
function validateUsage(v, name) {
  fields(v, [...TOKEN_FIELDS, 'observability'], name);
  insist(OBSERVABILITY.includes(v.observability), `${name}.observability invalid`);
  TOKEN_FIELDS.forEach(k => { if (v[k] !== null) integer(v[k], `${name}.${k}`); if (v.observability === 'unavailable') insist(v[k] === null, `${name} unavailable values must be null`); });
}
function validateWindow(window, prefix = 'window') {
  fields(window, ['date', 'timezone', 'start', 'end'], prefix);
  insist(/^\d{4}-\d{2}-\d{2}$/.test(window.date), `${prefix}.date invalid`); text(window.timezone, `${prefix}.timezone`);
  insist(timestamp(window.start, `${prefix}.start`) < timestamp(window.end, `${prefix}.end`), `${prefix} must be half-open and positive`);
}
export function normalizeAgentDaily(input, { policySkippedSources = [] } = {}) {
  const report = copy(input); object(report, 'report');
  const skipped = value => typeof value === 'string' && policySkippedSources.some(s => value.toLowerCase().includes(String(s.nodeId).toLowerCase()) && value.toLowerCase().includes(String(s.runtime).toLowerCase()) && /policy|intentional|disabled|策略|停用/i.test(value));
  for (const key of ['unavailable_fields', 'notes']) if (Array.isArray(report.data_quality?.[key])) report.data_quality[key] = report.data_quality[key].filter(v => !skipped(v));
  if (Array.isArray(report.attention_items)) report.attention_items = report.attention_items.filter(a => !skipped(`${a.title ?? ''} ${a.summary ?? ''}`));
  const ids = new Set((report.work_items ?? []).map(w => w.work_id));
  for (const a of report.attention_items ?? []) if (typeof a.work_id === 'string' && a.work_id && !ids.has(a.work_id)) a.work_id = ''; // Historical report-wide pseudo IDs.
  return report;
}
export const normalizeGameDaily = input => copy(input); // Never repair producer errors silently.
export function validateAgentDaily(input, config) {
  const report = normalizeAgentDaily(input, config);
  fields(report, ['report_meta', 'summary', 'work_items', 'attention_items', 'usage', 'data_quality', 'trace'], 'report', true);
  const meta = report.report_meta;
  fields(meta, ['schema_version', 'report_kind', 'report_date', 'timezone', 'window_start', 'window_end', 'collected_at', 'data_status'], 'report_meta', true);
  insist(meta.schema_version === 'agent_daily_report.v1' && meta.report_kind === 'agent_work_daily', 'Agent Daily schema invalid');
  validateWindow({ date: meta.report_date, timezone: meta.timezone, start: meta.window_start, end: meta.window_end }); timestamp(meta.collected_at, 'collected_at');
  insist(['complete', 'partial'].includes(meta.data_status), 'data_status invalid');
  fields(report.summary, ['overall_status', 'headline', 'work_theme_count', 'task_counts'], 'summary', true);
  text(report.summary.headline, 'headline'); insist(['ok', 'partial', 'attention'].includes(report.summary.overall_status), 'overall_status invalid');
  const tasks = []; const ids = [];
  for (const work of array(report.work_items, 'work_items')) {
    fields(work, ['work_id', 'title', 'status', 'outcome', 'task_counts', 'share_percent', 'highlights', 'tasks'], 'work', true);
    ids.push(text(work.work_id, 'work_id')); text(work.title, 'work title'); text(work.outcome, 'work outcome');
    insist(['completed', 'in_progress', 'attention', 'failed'].includes(work.status), 'work status invalid'); strings(work.highlights, 'highlights');
    insist(Number.isFinite(work.share_percent) && work.share_percent >= 0 && work.share_percent <= 100, 'share_percent invalid');
    for (const task of array(work.tasks, 'tasks')) {
      fields(task, ['task_id', 'title', 'status', 'device_id', 'runtime', 'summary'], 'task', true);
      ['task_id', 'title', 'device_id', 'summary'].forEach(k => text(task[k], k));
      insist(['hermes', 'codex', 'registry'].includes(task.runtime), 'runtime invalid'); tasks.push(task);
    }
    insist(canonicalJson(work.task_counts) === canonicalJson(counts(work.tasks)), 'Theme counts do not match tasks');
  }
  unique(ids, 'work IDs'); unique(tasks.map(t => t.task_id), 'Deduplicated task IDs');
  insist(report.summary.work_theme_count === report.work_items.length, 'Theme count mismatch');
  insist(canonicalJson(report.summary.task_counts) === canonicalJson(counts(tasks)), 'Root counts mismatch');
  if (report.work_items.length) insist(Math.abs(report.work_items.reduce((n, w) => n + w.share_percent, 0) - 100) <= 1, 'Shares must total approximately 100');
  const attention = array(report.attention_items, 'attention_items');
  unique(attention.map(a => text(a.attention_id, 'attention_id')), 'attention IDs');
  for (const item of attention) { fields(item, ['priority', 'title', 'summary', 'work_id'], 'attention'); insist(['p1', 'p2', 'p3'].includes(item.priority), 'priority invalid'); text(item.title, 'attention title'); text(item.summary, 'attention summary'); insist(item.work_id === '' || ids.includes(item.work_id), 'Unknown attention work_id'); }
  fields(report.usage, ['hermes', 'codex', 'by_device', 'quota_changes'], 'usage'); validateUsage(report.usage.hermes, 'usage.hermes'); validateUsage(report.usage.codex, 'usage.codex');
  unique(report.usage.by_device.map(node => node.device_id), 'Usage device IDs');
  for (const node of array(report.usage.by_device, 'by_device')) { text(node.device_id, 'device_id'); validateUsage(node.hermes, 'node.hermes'); validateUsage(node.codex, 'node.codex'); }
  array(report.usage.quota_changes, 'quota_changes').forEach(q => { fields(q, ['provider', 'metric', 'start_value', 'end_value', 'change', 'unit', 'observability'], 'quota'); insist(OBSERVABILITY.includes(q.observability), 'Quota observability invalid'); });
  ['missing_devices', 'unavailable_fields', 'notes'].forEach(k => strings(report.data_quality[k], `quality.${k}`));
  if (meta.data_status === 'complete') insist(!report.data_quality.missing_devices.length && !report.data_quality.unavailable_fields.length, 'Complete cannot conceal source gaps');
  text(report.trace.root_task_id, 'root task'); text(report.trace.root_run_id, 'root run'); array(report.trace.collectors, 'collectors').forEach(v => insist(typeof v === 'string' || v && typeof v === 'object' && !Array.isArray(v), 'Collector provenance must be strings or objects'));
  return report;
}
export function buildAgentDaily(input, identity, config) {
  const value = copy(input);
  insist(['agent_daily_builder_input.v1', 'agent_daily_builder_input.v2'].includes(value.schema_version), 'Builder schema version invalid');
  fields(value, ['schema_version', 'report_context', 'candidates', 'semantic', 'usage_measurements', 'quota_changes', 'data_quality', 'collectors', ...(value.schema_version.endsWith('.v2') ? ['node_tasks'] : [])], 'builder', true);
  if (identity) value.report_context = { ...value.report_context, root_task_id: text(identity.taskId, 'trusted taskId'), root_run_id: text(identity.runId, 'trusted runId') };
  fields(value.semantic, ['headline', 'groups', 'attention', 'duplicate_resolutions'], 'semantic', true);
  const candidates = new Map(array(value.candidates, 'candidates').map(c => { fields(c, ['candidate_id', 'task_id', 'title', 'status', 'device_id', 'runtime', 'summary'], 'root candidate', true); text(c.candidate_id, 'candidate_id'); counts([c]); return [c.candidate_id, c]; }));
  insist(candidates.size === value.candidates.length, 'Repeated candidate_id');
  const duplicateMap = new Map();
  for (const d of array(value.semantic.duplicate_resolutions, 'duplicate_resolutions')) {
    fields(d, ['duplicate_candidate_id', 'canonical_candidate_id'], 'duplicate', true);
    insist(candidates.has(d.duplicate_candidate_id) && candidates.has(d.canonical_candidate_id) && d.duplicate_candidate_id !== d.canonical_candidate_id, 'Unknown/self duplicate');
    insist(!duplicateMap.has(d.duplicate_candidate_id), 'Repeated duplicate resolution'); duplicateMap.set(d.duplicate_candidate_id, d.canonical_candidate_id);
  }
  for (const key of duplicateMap.keys()) { const visited = new Set([key]); let next = duplicateMap.get(key); while (duplicateMap.has(next)) { insist(!visited.has(next), 'Cyclic duplicate resolution'); visited.add(next); next = duplicateMap.get(next); } }
  const groups = array(value.semantic.groups, 'groups'); const used = []; const workRefs = new Map();
  const stable = (prefix, n, seed) => `${prefix}_${String(n).padStart(2, '0')}_${digest(seed).slice(0, 10)}`;
  const total = candidates.size - duplicateMap.size;
  const works = groups.map((g, i) => {
    fields(g, ['group_ref', 'title', 'outcome', 'candidate_ids', 'highlights'], 'group', true); text(g.group_ref, 'group_ref'); insist(!workRefs.has(g.group_ref), 'Repeated group_ref');
    const groupIds = array(g.candidate_ids, 'candidate_ids'); insist(groupIds.length, 'Empty group');
    const tasks = groupIds.map(key => { insist(candidates.has(key) && !duplicateMap.has(key), 'Invented/duplicate candidate in group'); used.push(key); const c = candidates.get(key); return Object.fromEntries(['task_id', 'title', 'status', 'device_id', 'runtime', 'summary'].map(k => [k, c[k]])); });
    const c = counts(tasks); const work_id = stable('work', i + 1, [...groupIds].sort().join('|')); workRefs.set(g.group_ref, work_id);
    return { work_id, title: text(g.title, 'group title'), status: c.failed ? 'failed' : c.blocked || c.cancelled ? 'attention' : c.running ? 'in_progress' : 'completed', outcome: text(g.outcome, 'outcome'), task_counts: c, share_percent: total ? Number((100 * tasks.length / total).toFixed(4)) : 0, highlights: g.highlights, tasks };
  });
  unique(used, 'Group candidate partition'); insist(used.length === total, 'Missing nonduplicate candidates');
  unique(works.flatMap(w => w.tasks).map(t => t.task_id), 'Canonical task IDs collide');
  const c = counts(works.flatMap(w => w.tasks)); const context = value.report_context; const quality = value.data_quality;
  const nodeIds = [...new Set([...value.candidates, ...value.usage_measurements].map(x => x.device_id))].sort();
  const report = {
    report_meta: { schema_version: 'agent_daily_report.v1', report_kind: 'agent_work_daily', report_date: context.report_date, timezone: context.timezone, window_start: context.window_start, window_end: context.window_end, collected_at: context.collected_at, data_status: context.source_data_status === 'partial' || quality.missing_devices.length || quality.unavailable_fields.length ? 'partial' : 'complete' },
    summary: { overall_status: c.failed || c.blocked || c.cancelled ? 'attention' : c.running ? 'partial' : 'ok', headline: text(value.semantic.headline, 'headline'), work_theme_count: works.length, task_counts: c },
    work_items: works,
    attention_items: array(value.semantic.attention, 'attention').map((a, i) => { fields(a, ['priority', 'title', 'summary', 'group_ref'], 'attention semantic', true); insist(a.group_ref === '' || workRefs.has(a.group_ref), 'Unknown attention group'); return { attention_id: stable('attention', i + 1, `${a.group_ref}|${a.title}|${a.summary}`), priority: a.priority, title: a.title, summary: a.summary, work_id: workRefs.get(a.group_ref) ?? '' }; }),
    usage: { hermes: usage(value.usage_measurements.filter(x => x.runtime === 'hermes')), codex: usage(value.usage_measurements.filter(x => x.runtime === 'codex')), by_device: nodeIds.map(device_id => ({ device_id, hermes: usage(value.usage_measurements.filter(x => x.device_id === device_id && x.runtime === 'hermes')), codex: usage(value.usage_measurements.filter(x => x.device_id === device_id && x.runtime === 'codex')) })), quota_changes: value.quota_changes },
    data_quality: { ...quality, notes: [...quality.notes, 'Built deterministically by configurable legacy-task-pack.v1.'] }, trace: { root_task_id: context.root_task_id, root_run_id: context.root_run_id, collectors: value.collectors },
  };
  const validated = validateAgentDaily(report, config);
  // Keep helper metadata outside the unchanged legacy wire schema. The ledger
  // adapter persists it in its separate, explicitly versioned result envelope.
  retainedBuilderInputs.set(validated, value);
  return validated;
}

export function validateGameDaily(input, { automationIds, deviceId } = {}) {
  const r = normalizeGameDaily(input); fields(r, ['schema_version', 'report_meta', 'scheduler', 'automations', 'action_candidates', 'evidence', 'analysis_notes'], 'game', true);
  insist(r.schema_version === 'game_daily_report.v1', 'Game schema invalid');
  ['report_id', 'device_id', 'business_date', 'report_timezone', 'source_timezone', 'source_utc_offset', 'collected_at'].forEach(k => text(r.report_meta[k], `meta.${k}`)); timestamp(r.report_meta.collected_at, 'collected_at');
  if (deviceId) insist(r.report_meta.device_id === deviceId, 'Wrong source device');
  const expected = automationIds ?? ['hsr_march7thassistant', 'zzz_onedragon', 'arknights_maa'];
  const ids = array(r.automations, 'automations').map(a => a.automation_id); unique(ids, 'automation IDs'); insist(canonicalJson([...ids].sort()) === canonicalJson([...expected].sort()), 'Missing/extra automations');
  const evidence = new Set(); fields(r.evidence, ['sources', 'screenshots', 'missing_sources'], 'evidence'); strings(r.evidence.missing_sources, 'missing_sources');
  for (const source of array(r.evidence.sources, 'sources')) { fields(source, ['source_id', 'kind', 'path', 'last_modified_at', 'read_status'], 'source'); text(source.source_id, 'source_id'); insist(!evidence.has(source.source_id), 'Duplicate evidence'); evidence.add(source.source_id); ['kind', 'path', 'read_status'].forEach(k => text(source[k], k)); timestamp(source.last_modified_at, 'source time', true); }
  for (const shot of array(r.evidence.screenshots, 'screenshots')) { fields(shot, ['screenshot_id', 'path', 'automation_id', 'description'], 'screenshot'); text(shot.screenshot_id, 'screenshot_id'); insist(!evidence.has(shot.screenshot_id), 'Duplicate screenshot evidence'); evidence.add(shot.screenshot_id); insist(ids.includes(shot.automation_id), 'Unknown screenshot automation'); text(shot.path, 'screenshot path'); text(shot.description, 'screenshot description'); }
  const times = (v, name, scheduler = false) => { const start = timestamp(v.started_at, `${name}.started_at`, !v.run_observed); const end = timestamp(v.ended_at, `${name}.ended_at`, scheduler || !v.run_observed); if (start !== null && end !== null) insist(start <= end, `${name} reversed time`); if (scheduler && v.run_observed && end === null) insist(v.status_hint === 'verify' && v.warnings.length, 'Open scheduler needs verify and warning'); };
  fields(r.scheduler, ['scheduler_id', 'name', 'expected_to_run', 'run_observed', 'started_at', 'ended_at', 'reported_top_level_status', 'status_hint', 'items_detected', 'retry_count', 'warnings'], 'scheduler');
  ['scheduler_id', 'name', 'status_hint'].forEach(k => text(r.scheduler[k], `scheduler.${k}`));
  ['expected_to_run', 'run_observed'].forEach(k => insist(typeof r.scheduler[k] === 'boolean', `scheduler.${k} must be boolean`)); strings(r.scheduler.warnings, 'scheduler warnings'); integer(r.scheduler.items_detected, 'items_detected'); integer(r.scheduler.retry_count, 'retry_count');
  if (r.scheduler.run_observed || r.scheduler.reported_top_level_status !== null) text(r.scheduler.reported_top_level_status, 'scheduler status'); times(r.scheduler, 'scheduler', true);
  const tasks = new Map(); const owners = new Map(); const statuses = {};
  for (const a of r.automations) {
    fields(a, ['automation_id', 'engine', 'game', 'account', 'instance', 'expected_to_run', 'run_observed', 'started_at', 'ended_at', 'reported_top_level_status', 'status_hint', 'tasks', 'metrics', 'diagnosis', 'warnings'], 'automation');
    ['engine', 'game', 'account', 'instance', 'status_hint'].forEach(k => text(a[k], k)); ['expected_to_run', 'run_observed'].forEach(k => insist(typeof a[k] === 'boolean', `${k} must be boolean`)); strings(a.warnings, 'automation warnings');
    if (!a.run_observed) insist(a.reported_top_level_status === 'not_observed' && a.status_hint === 'not_run', 'No-run automation must have explicit non-null sentinel');
    else { text(a.reported_top_level_status, 'automation reported status'); insist(a.reported_top_level_status !== 'not_observed' && a.status_hint !== 'not_run', 'Observed automation cannot be no-run'); }
    times(a, 'automation');
    for (const t of array(a.tasks, 'tasks')) {
      fields(t, ['task_id', 'label', 'category', 'enabled', 'required', 'outcome', 'attempts', 'started_at', 'ended_at', 'reason', 'evidence_refs', 'caused_by_task_id', 'causal_confidence'], 'automation task');
      text(t.task_id, 'task_id'); insist(!tasks.has(t.task_id), 'Duplicate task ID'); tasks.set(t.task_id, t); owners.set(t.task_id, a.automation_id);
      ['enabled', 'required'].forEach(k => insist(typeof t[k] === 'boolean', `${k} must be boolean`)); integer(t.attempts, 'attempts');
      ['label', 'category', 'reason'].forEach(k => insist(typeof t[k] === 'string', `${k} must be string`));
      insist(['success', 'failed', 'uncertain', 'disabled', 'skipped_nonblocking', 'not_observed'].includes(t.outcome), 'Invalid task outcome'); insist(['confirmed', 'suspected', 'unknown'].includes(t.causal_confidence), 'Invalid causal confidence');
      strings(t.evidence_refs, 'evidence_refs'); t.evidence_refs.forEach(ref => insist(evidence.has(ref), 'Unknown evidence reference')); timestamp(t.started_at, 'task start', true); timestamp(t.ended_at, 'task end', true);
    }
    const metricIds = []; for (const metric of array(a.metrics, 'metrics')) { fields(metric, ['metric_id', 'label', 'value', 'target', 'unit', 'before', 'after', 'estimated_at'], 'metric'); metricIds.push(text(metric.metric_id, 'metric_id')); timestamp(metric.estimated_at, 'estimated_at', true); } unique(metricIds, 'metric IDs');
    fields(a.diagnosis, ['first_unrecovered_task_id', 'cascade_suspected', 'note'], 'diagnosis'); insist(typeof a.diagnosis.cascade_suspected === 'boolean', 'cascade_suspected must be boolean');
    if (a.diagnosis.first_unrecovered_task_id !== null) insist(a.tasks.some(t => t.task_id === a.diagnosis.first_unrecovered_task_id), 'First unrecovered task belongs to another automation');
    const active = a.tasks.filter(t => t.enabled);
    statuses[a.automation_id] = !a.expected_to_run ? 'ok' : !a.run_observed || active.some(t => t.required && ['failed', 'not_observed'].includes(t.outcome)) ? 'action_required' : active.some(t => ['failed', 'uncertain', 'not_observed'].includes(t.outcome) || t.outcome === 'success' && !t.evidence_refs.length) ? 'verify' : 'ok';
  }
  for (const [id, t] of tasks) if (t.caused_by_task_id !== null) insist(tasks.has(t.caused_by_task_id) && t.caused_by_task_id !== id, 'Invalid/self causal task reference');
  const actions = array(r.action_candidates, 'action_candidates'); unique(actions.map(a => text(a.action_id, 'action_id')), 'action IDs');
  for (const a of actions) { fields(a, ['priority', 'automation_id', 'task_ids', 'type', 'title', 'detail'], 'action'); insist(['p1', 'p2', 'p3'].includes(a.priority) && ids.includes(a.automation_id), 'Invalid action owner/priority'); insist(array(a.task_ids, 'action task_ids').length, 'Action needs task IDs'); a.task_ids.forEach(id => insist(owners.get(id) === a.automation_id, 'Action task belongs to another automation')); ['type', 'title', 'detail'].forEach(k => text(a[k], k)); }
  strings(r.analysis_notes, 'analysis_notes');
  return { report: r, statusById: statuses, overallStatus: Object.values(statuses).includes('action_required') ? 'action_required' : Object.values(statuses).includes('verify') ? 'verify' : 'ok' };
}

/** Apply configurable main/substep policies to already observed evidence; never rerun automation. */
export function normalizeAutomationEvidence(input, policy = {}) {
  const automation = copy(input);
  if (!automation.run_observed) { automation.reported_top_level_status = 'not_observed'; automation.status_hint = 'not_run'; automation.started_at = null; automation.ended_at = null; }
  for (const task of automation.tasks) {
    if (!task.enabled) { task.required = false; task.outcome = 'disabled'; }
    const rule = policy.rules?.find(r => r.category === task.category);
    if (rule?.nonblockingAfterCategory && automation.tasks.some(t => t.category === rule.nonblockingAfterCategory && t.outcome === 'success') && task.outcome === 'failed') { task.required = false; task.outcome = 'skipped_nonblocking'; task.reason = `${task.reason} [post-main cleanup, nonblocking]`; }
    if (rule?.mainTaskCategory && automation.tasks.some(t => t.category === rule.mainTaskCategory && t.outcome === 'success')) { task.required = false; if (task.outcome === 'failed') task.outcome = 'skipped_nonblocking'; }
  }
  if (policy.cascadeSuspectedFromCategory) {
    const first = automation.tasks.find(t => t.enabled && t.category === policy.cascadeSuspectedFromCategory && t.outcome === 'failed');
    if (first) { automation.diagnosis.first_unrecovered_task_id = first.task_id; for (const t of automation.tasks.slice(automation.tasks.indexOf(first) + 1)) if (t.enabled && t.outcome === 'failed') { t.caused_by_task_id = first.task_id; t.causal_confidence = 'suspected'; automation.diagnosis.cascade_suspected = true; } }
  }
  return automation;
}

export function renderAgentDaily(input, config) {
  const r = validateAgentDaily(input, config);
  const lines = [r.summary.headline, ...r.work_items.map(w => `${w.title} (${w.share_percent}%): ${w.outcome}`), ...r.attention_items.map(a => `${a.priority}: ${a.title} · ${a.summary}`), `Tasks: ${r.summary.task_counts.total}; data: ${r.report_meta.data_status}`];
  const detail = { usage: r.usage, tasks: r.work_items.flatMap(w => w.tasks), dataQuality: r.data_quality, trace: r.trace };
  return { title: `Daily review · ${r.report_meta.report_date}`, body: lines.join('\n'), detail, card: reportCard(lines, detail) };
}
export function renderGameDaily(input, config) {
  const { report: r, statusById, overallStatus } = validateGameDaily(input, config);
  const lines = [`Game daily · ${r.report_meta.business_date} · ${overallStatus}`, ...r.automations.map(a => `${a.game}: ${statusById[a.automation_id]} (${a.tasks.filter(t => t.enabled && t.outcome === 'failed').length} failed tasks)`), ...r.action_candidates.map(a => `${a.priority}: ${a.title} · ${a.detail}`)];
  const detail = { scheduler: r.scheduler, automations: r.automations, evidence: r.evidence, analysisNotes: r.analysis_notes };
  return { title: lines[0], body: lines.join('\n'), detail, statusById, overallStatus, card: reportCard(lines, detail) };
}
function reportCard(lines, detail) {
  return { schema: '2.0', header: { title: { tag: 'plain_text', content: lines[0].slice(0, 150) }, template: 'blue' }, body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: lines.join('\n').slice(0, 12000) } }, { tag: 'collapsible_panel', header: { title: { tag: 'plain_text', content: 'Evidence and measurements' } }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: canonicalJson(detail).slice(0, 12000) } }] }] } };
}

export function validateNodeReport(input, { nodeIds, timeZone } = {}) {
  const r = copy(input); fields(r, ['schema_version', 'device_id', 'profile', 'window', 'work_candidates', 'usage', 'source_counts', 'data_quality', 'evidence'], 'node');
  insist(r.schema_version === 'agent_daily_node_report.v1', 'Node schema invalid'); text(r.device_id, 'device_id');
  if (nodeIds) insist(nodeIds.includes(r.device_id), 'Unknown node'); insist(r.profile === 'default', 'Node profile must be default'); validateWindow(r.window);
  if (timeZone) insist(r.window.timezone === timeZone, 'Unexpected node timezone');
  const candidates = array(r.work_candidates, 'work_candidates'); insist(candidates.length <= 1000, 'Node candidate limit exceeded');
  unique(candidates.map(c => text(c.candidate_id, 'candidate_id')), 'candidate IDs'); const ids = new Set(candidates.map(c => c.candidate_id));
  for (const c of candidates) {
    fields(c, ['candidate_id', 'runtime', 'session_id', 'turn_id', 'title', 'request_summary', 'outcome_summary', 'status', 'started_at', 'ended_at', 'possible_duplicate_ids'], 'candidate');
    insist(['codex', 'hermes'].includes(c.runtime) && TASK_STATUSES.includes(c.status), 'Node candidate runtime/status invalid');
    ['session_id', 'turn_id', 'title', 'request_summary', 'outcome_summary'].forEach(k => text(c[k], k)); timestamp(c.started_at, 'started_at'); timestamp(c.ended_at, 'ended_at', true);
    strings(c.possible_duplicate_ids, 'possible_duplicate_ids'); c.possible_duplicate_ids.forEach(id => insist(ids.has(id) && id !== c.candidate_id, 'Unknown/self duplicate candidate'));
  }
  validateUsage(r.usage.codex, 'usage.codex'); validateUsage(r.usage.hermes, 'usage.hermes');
  fields(r.usage.codex_account, ['metric', 'unit', 'observability', 'start_value', 'end_value', 'change'], 'codex_account');
  insist(r.usage.codex_account.unit === '%' && OBSERVABILITY.includes(r.usage.codex_account.observability), 'Account unit/observability invalid');
  for (const key of ['start_value', 'end_value', 'change']) { const v = r.usage.codex_account[key]; insist(v === null || Number.isFinite(v), 'Account value invalid'); if (r.usage.codex_account.observability === 'unavailable') insist(v === null, 'Unavailable account measurement must be null'); }
  ['codex_top_level_sessions', 'codex_subagent_sessions', 'hermes_local_unregistered_sessions', 'hermes_service_sessions_excluded'].forEach(k => integer(r.source_counts[k], k));
  insist(['complete', 'partial'].includes(r.data_quality.status), 'Node data quality invalid'); strings(r.data_quality.unavailable_fields, 'unavailable_fields'); strings(r.data_quality.notes, 'quality notes');
  if (r.data_quality.status === 'complete') insist(!r.data_quality.unavailable_fields.length, 'Complete node cannot conceal unavailable data');
  text(r.evidence.codex_activity_file, 'codex evidence label'); text(r.evidence.hermes_activity_file, 'hermes evidence label'); return r;
}

/** Build from reader results, with source labels and account node supplied by operator config. */
export function buildNodeReport({ nodeId, codex, hermes, semantic, sources, accountMeasurementNodeId }) {
  text(nodeId, 'nodeId'); object(codex, 'codex'); object(hermes, 'hermes'); validateWindow(codex.window); validateWindow(hermes.window);
  insist(canonicalJson(codex.window) === canonicalJson(hermes.window), 'Collector windows do not match'); insist((hermes.profile ?? 'default') === 'default', 'Collector profile mismatch');
  const evidence = new Map();
  for (const [runtime, sessions] of [['codex', codex.top_level_sessions ?? []], ['hermes', hermes.local_unregistered_sessions ?? []]]) for (const s of sessions) for (const turn of s.turns ?? []) {
    const session_id = text(s.session_id, 'session_id'); const turn_id = text(turn.turn_id, 'turn_id'); const ref = `${runtime}:${session_id}:${turn_id}`;
    insist(!evidence.has(ref), 'Duplicate collector source ref');
    evidence.set(ref, { runtime, session_id, turn_id, started_at: turn.started_at ?? turn.first_activity, ended_at: turn.ended_at ?? (turn.has_final_answer ? turn.last_activity : null) });
  }
  const decisions = new Map();
  for (const s of array(semantic.candidates, 'semantic candidates')) {
    fields(s, ['source_ref', 'title', 'request_summary', 'outcome_summary', 'status', 'possible_duplicate_refs'], 'candidate semantic', true);
    insist(evidence.has(s.source_ref) && !decisions.has(s.source_ref), 'Invented/repeated source ref'); insist(TASK_STATUSES.includes(s.status), 'Semantic status invalid');
    s.possible_duplicate_refs.forEach(ref => insist(evidence.has(ref) && ref !== s.source_ref, 'Unknown/self duplicate source ref')); decisions.set(s.source_ref, s);
  }
  const missing = [...evidence.keys()].filter(ref => !decisions.has(ref)); insist(!missing.length, `Missing collector turns: ${missing.slice(0, 5).join(', ')}`);
  const candidateId = ref => `candidate_${digest(`${nodeId}\0${ref}`).slice(0, 20)}`;
  const work_candidates = [...evidence].sort(([, a], [, b]) => Date.parse(a.started_at) - Date.parse(b.started_at)).map(([ref, e]) => {
    const d = decisions.get(ref); return { candidate_id: candidateId(ref), ...e, title: d.title, request_summary: d.request_summary, outcome_summary: d.outcome_summary, status: d.status, possible_duplicate_ids: [...new Set(d.possible_duplicate_refs)].map(candidateId) };
  });
  const unavailable_fields = []; const notes = [];
  for (const [runtime, data] of [['codex', codex], ['hermes', hermes]]) if (!data.data_quality?.complete) { unavailable_fields.push(`${runtime} activity details`); notes.push(...(data.data_quality?.errors ?? []).map(e => `${runtime}: ${typeof e === 'string' ? e : e.message ?? e.code}`)); }
  const unavailable = Object.fromEntries(TOKEN_FIELDS.map(k => [k, null]));
  const codexTokens = { ...unavailable, ...codex.token_totals_all_sessions, observability: codex.token_totals_all_sessions?.observability ?? (codex.data_quality?.complete ? 'exact' : 'partial') };
  const hermesTokens = { ...unavailable, ...hermes.usage_local_sessions, observability: hermes.usage_local_sessions?.observability ?? 'unavailable' };
  let account = { metric: 'primary window used percent', unit: '%', observability: 'unavailable', start_value: null, end_value: null, change: null };
  if (nodeId === accountMeasurementNodeId) {
    const first = codex.account_usage?.first?.primary; const last = codex.account_usage?.last?.primary;
    if (last && Number.isFinite(last.used_percent)) { const comparable = first && Number.isFinite(first.used_percent) && first.window_minutes === last.window_minutes && first.resets_at === last.resets_at; account = { ...account, observability: 'partial', start_value: comparable ? first.used_percent : null, end_value: last.used_percent, change: comparable ? last.used_percent - first.used_percent : null }; }
  }
  return validateNodeReport({ schema_version: 'agent_daily_node_report.v1', device_id: nodeId, profile: 'default', window: codex.window, work_candidates, usage: { codex: codexTokens, hermes: hermesTokens, codex_account: account }, source_counts: { codex_top_level_sessions: codex.counts?.top_level_session_count ?? 0, codex_subagent_sessions: codex.counts?.subagent_session_count ?? 0, hermes_local_unregistered_sessions: hermes.counts?.local_unregistered_session_count ?? 0, hermes_service_sessions_excluded: hermes.counts?.service_session_count_excluded ?? 0 }, data_quality: { status: unavailable_fields.length ? 'partial' : 'complete', unavailable_fields, notes }, evidence: { codex_activity_file: text(sources.codex, 'codex source label'), hermes_activity_file: text(sources.hermes, 'hermes source label') } });
}

/** A root cannot omit accepted successful node candidates or claim a valid node is missing. */
export function validateNodeEvidenceGate(builderInput, nodes, expectedNodeIds) {
  const references = new Map(array(nodes, 'node results').map(n => [n.nodeId, n]));
  unique(nodes.map(n => n.nodeId), 'node identities');
  for (const nodeId of expectedNodeIds) {
    const node = references.get(nodeId); const missing = builderInput.data_quality.missing_devices.includes(nodeId);
    const succeeded = node?.state !== undefined
      ? node.state === 'succeeded' && node.settlement?.type === 'run.settled' && node.settlement.detail?.outcome === 'success'
      : node?.outcome === 'success' && node.validation === 'valid';
    if (!succeeded) { insist(missing && builderInput.report_context.source_data_status === 'partial', `Missing/failed node ${nodeId} must be declared`); continue; }
    insist(!missing, `Successful node ${nodeId} cannot be labeled missing`); insist(node.rootTaskId === builderInput.report_context.root_task_id, 'Node belongs to wrong root');
    const report = validateNodeReport(node.report, { nodeIds: expectedNodeIds }); insist(report.device_id === nodeId, 'Wrong node payload');
    if (node.rootRunId) insist(node.rootRunId === builderInput.report_context.root_run_id, 'Node belongs to wrong root run');
    insist(Date.parse(report.window.start) === Date.parse(builderInput.report_context.window_start) && Date.parse(report.window.end) === Date.parse(builderInput.report_context.window_end), 'Node evidence window differs from root report');
    for (const candidate of report.work_candidates) insist(builderInput.candidates.some(c => c.candidate_id === candidate.candidate_id), `Omitted accepted node candidate ${candidate.candidate_id}`);
  }
  return true;
}

/** Exact string decimal movement, not floating-point money or inferred gross spend. */
export function summarizeQuotaBoundaries(samples, { windowStart, windowEnd, toleranceMinutes = 20 }) {
  const start = timestamp(windowStart, 'windowStart'); const end = timestamp(windowEnd, 'windowEnd'); insist(start < end, 'Quota window reversed');
  insist(Number.isFinite(toleranceMinutes) && toleranceMinutes >= 1 && toleranceMinutes <= 120, 'Invalid tolerance');
  const groups = new Map();
  for (const s of samples) { fields(s, ['provider', 'metric', 'unit', 'capturedAt', 'value'], 'snapshot'); timestamp(s.capturedAt, 'capturedAt'); insist(/^-?\d+(?:\.\d+)?$/.test(s.value), 'Snapshot value must be exact decimal string'); const key = `${s.provider}\0${s.metric}\0${s.unit}`; groups.set(key, [...(groups.get(key) ?? []), s]); }
  const difference = (a, b) => { const precision = Math.max(a.split('.')[1]?.length ?? 0, b.split('.')[1]?.length ?? 0); const scaled = x => { const sign = x.startsWith('-') ? -1n : 1n; const [whole, fraction = ''] = x.replace(/^-/, '').split('.'); return sign * BigInt(whole + fraction.padEnd(precision, '0')); }; const n = scaled(b) - scaled(a); const negative = n < 0n; const digits = (negative ? -n : n).toString().padStart(precision + 1, '0'); return `${negative ? '-' : ''}${precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits}`; };
  return [...groups.values()].map(rows => {
    const closest = time => rows.toSorted((a, b) => Math.abs(Date.parse(a.capturedAt) - time) - Math.abs(Date.parse(b.capturedAt) - time))[0]; const first = closest(start); const last = closest(end);
    const within = (s, time) => Math.abs(Date.parse(s.capturedAt) - time) <= toleranceMinutes * 60000; const available = within(first, start) && within(last, end);
    return { provider: rows[0].provider, metric: rows[0].metric, unit: rows[0].unit, start_value: available ? first.value : null, end_value: available ? last.value : null, change: available ? difference(first.value, last.value) : null, observability: !available ? 'unavailable' : Math.abs(Date.parse(first.capturedAt) - start) <= 120000 && Math.abs(Date.parse(last.capturedAt) - end) <= 120000 ? 'exact' : 'partial', observed_start: first.capturedAt, observed_end: last.capturedAt, movement_kind: 'net_balance_movement' };
  });
}
