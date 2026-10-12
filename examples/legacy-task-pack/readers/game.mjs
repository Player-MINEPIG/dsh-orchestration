// SPDX-License-Identifier: MIT
// Independent configurable reader for explicitly supplied automation log exports.
import { SourceError, assertRows, normalizeWindow, parseTime, iso, inWindow, failure, decodeText, completeTailLines } from './common.mjs';
import { localTimestamp, calendarWindow, offsetText } from './time.mjs';

const has = (line, marker) => typeof marker === 'string' ? line.includes(marker) : Array.isArray(marker?.all) && marker.all.every(part => (marker.compact ? line.replace(/\s/g, '') : line).includes(marker.compact ? part.replace(/\s/g, '') : part));
const matches = (lines, markers = []) => lines.filter(line => markers.some(marker => has(line.text, marker)));

/** Naive source timestamps need an explicit offset; no host-local timezone guesses. */
export function parseLogLines(bytes, { sourceUtcOffset, sourceTimezone, disambiguation, fallbackDate, limits, encoding = 'auto' }) {
  if (!sourceTimezone && !sourceUtcOffset) throw new SourceError('timezone', 'Raw logs require an explicit source timezone or offset');
  if (sourceUtcOffset && (!/^[+-]\d{2}:\d{2}$/.test(sourceUtcOffset) || Number(sourceUtcOffset.slice(1, 3)) > 23 || Number(sourceUtcOffset.slice(4)) > 59)) throw new SourceError('timezone', 'Invalid sourceUtcOffset');
  const lines = decodeText(bytes, encoding).split(/\r?\n/);
  if (lines.length > limits.maxRows + 1) throw new SourceError('limit', 'Log line count exceeds configured bound');
  let prior = null, date = fallbackDate;
  return lines.filter(line => line.trim()).map((text, index) => {
    if (Buffer.byteLength(text) > limits.maxLineBytes) throw new SourceError('limit', 'Log line exceeds configured bound');
    let time = null;
    const full = text.match(/(20\d{2}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,6}))?(Z|[+-]\d{2}:\d{2})?/);
    const short = text.match(/^\[(\d{2}:\d{2}:\d{2})(?:[.,](\d{1,6}))?\]/);
    if (full) {
      date = full[1];
      const clock = `${full[2]}${full[3] ? '.' + full[3].slice(0, 3) : ''}`;
      time = full[4] ? parseTime(`${date}T${clock}${full[4]}`) : localTimestamp(date, clock, { sourceTimezone, sourceUtcOffset, disambiguation });
    } else if (short && /^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
      const clock = `${short[1]}${short[2] ? '.' + short[2].slice(0, 3) : ''}`;
      time = localTimestamp(date, clock, { sourceTimezone, sourceUtcOffset, disambiguation });
      if (prior !== null && time < prior && prior - time > 12 * 60 * 60 * 1000) {
        date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
        time = localTimestamp(date, clock, { sourceTimezone, sourceUtcOffset, disambiguation });
      }
    }
    if (time !== null) prior = time;
    return { text, time, line: index + 1 }; // Untimed lines are never silently assigned another event's time.
  });
}

function evaluateTask(spec, lines, observed, evidenceRefs) {
  let success = matches(lines, spec.successMarkers);
  if (spec.successAllMarkers) success = spec.successAllMarkers.every(marker => matches(lines, [marker]).length) ? matches(lines, spec.successAllMarkers) : [];
  const failed = matches(lines, spec.failureMarkers), starts = matches(lines, spec.startMarkers);
  const disabled = matches(lines, spec.disabledMarkers).length > 0 || spec.enabled === false || (spec.enabledWhenMarkers && !matches(lines, spec.enabledWhenMarkers).length);
  const enabled = !disabled;
  const lastSuccess = success.at(-1), lastFailure = failed.at(-1);
  if (spec.terminalPolicy && !['latest', 'failure_precedence'].includes(spec.terminalPolicy)) throw new SourceError('config', 'Invalid terminalPolicy');
  const terminal = spec.terminalPolicy === 'failure_precedence' && lastFailure ? lastFailure : [lastSuccess, lastFailure].filter(Boolean).sort((a, b) => (a.time ?? a.contextTime) - (b.time ?? b.contextTime) || a.line - b.line).at(-1);
  const missingOutcome = spec.missingOutcome ?? 'uncertain';
  if (!['failed', 'uncertain', 'not_observed', 'skipped_nonblocking'].includes(missingOutcome)) throw new SourceError('config', 'Invalid missingOutcome policy');
  let outcome = !enabled ? 'disabled' : !observed ? 'not_observed' : terminal === lastSuccess && lastSuccess ? 'success' : terminal ? 'failed' : missingOutcome;
  if (enabled && observed && spec.skipWhenAllMarkers?.length && spec.skipWhenAllMarkers.every(marker => matches(lines, [marker]).length)) {
    const skip = matches(lines, spec.skipWhenAllMarkers).at(-1);
    if (!spec.skipOnlyAfterFailure || !lastFailure || (skip.time ?? skip.contextTime) > (lastFailure.time ?? lastFailure.contextTime) ||
      ((skip.time ?? skip.contextTime) === (lastFailure.time ?? lastFailure.contextTime) && skip.line > lastFailure.line)) outcome = 'skipped_nonblocking';
  }
  if (spec.manual) outcome = enabled ? 'not_observed' : 'disabled';
  const relevant = [...starts, ...success, ...failed].sort((a, b) => a.time - b.time || a.line - b.line);
  const retryCount = matches(lines, spec.retryMarkers).length;
  return { task_id: spec.taskId, label: spec.label ?? spec.taskId, category: spec.category ?? 'daily', enabled,
    required: enabled && !spec.manual && spec.required !== false, outcome,
    attempts: disabled || spec.manual || !relevant.length ? 0 : Math.max(1, starts.length) + retryCount,
    started_at: iso(relevant[0]?.time), ended_at: iso(terminal?.time),
    reason: spec.manual ? 'Configured manual task; excluded from automatic main-task failure.' : outcome === 'success' ? 'Completion marker observed in the supplied report window.' : outcome === 'failed' ? terminal ? 'Latest terminal marker reports failure.' : 'Required completion evidence is missing under the configured failure policy.' : outcome === 'disabled' ? 'Task is explicitly disabled.' : outcome === 'not_observed' ? 'No run evidence observed in the supplied report window.' : 'No terminal marker observed; completion is unconfirmed.',
    evidence_refs: relevant.length ? [...new Set(relevant.map(line => line.sourceId))] : observed ? evidenceRefs : [],
    caused_by_task_id: null, causal_confidence: 'unknown' };
}

function applyTaskPolicies(tasks, specs) {
  const byId = new Map(tasks.map(task => [task.task_id, task]));
  const definitions = new Map(specs.map(spec => [spec.taskId, spec])), visited = new Set(), visiting = new Set();
  function apply(spec) {
    if (visited.has(spec.taskId)) return;
    if (visiting.has(spec.taskId)) throw new SourceError('config', 'Cyclic task policy references');
    visiting.add(spec.taskId);
    for (const key of ['nonblockingAfterTaskId', 'followMainTaskId', 'optionalWhenTaskSucceeds']) if (spec[key]) apply(definitions.get(spec[key]));
    const task = byId.get(spec.taskId);
    if (spec.nonblockingAfterTaskId && task.enabled && ['failed', 'uncertain'].includes(task.outcome)) {
      const main = byId.get(spec.nonblockingAfterTaskId);
      if (main?.outcome === 'success' && main.ended_at && task.ended_at && Date.parse(task.ended_at) >= Date.parse(main.ended_at)) {
        task.required = false; task.outcome = 'skipped_nonblocking'; task.reason = 'Optional cleanup failed after confirmed main-task completion; main result is preserved.';
      }
    }
    if (spec.followMainTaskId && task.enabled) {
      const main = byId.get(spec.followMainTaskId);
      task.required = false;
      if (main?.outcome === 'success') {
        task.outcome = spec.mainSuccessOutcome ?? (task.outcome === 'failed' ? 'skipped_nonblocking' : 'success');
        if (!['success', 'skipped_nonblocking'].includes(task.outcome)) throw new SourceError('config', 'Invalid mainSuccessOutcome');
        task.reason = 'Configured parent task completed; subordinate noise is nonblocking.';
        task.evidence_refs = [...new Set([...task.evidence_refs, ...main.evidence_refs])];
      }
    }
    if (spec.optionalWhenTaskSucceeds && task.enabled && ['uncertain', 'not_observed'].includes(task.outcome)) {
      const main = byId.get(spec.optionalWhenTaskSucceeds);
      if (main?.outcome === 'success') { task.required = false; task.outcome = 'skipped_nonblocking'; task.reason = 'Configured optional work is unnecessary after the goal task succeeds.'; task.evidence_refs = [...main.evidence_refs]; }
    }
    visiting.delete(spec.taskId); visited.add(spec.taskId);
  }
  for (const spec of specs) apply(spec);
}

function metricsFromLines(specs, lines, runs = [], timestampOptions = {}, tasks = []) {
  return (specs ?? []).map(spec => {
    const scopedLines = spec.runKinds ? lines.filter(line => spec.runKinds.includes(line.runKind)) : lines;
    const found = scopedLines.filter(line => has(line.text, spec.marker));
    const numbers = found.map(line => {
      let text = typeof spec.marker === 'string' ? line.text.slice(line.text.indexOf(spec.marker) + spec.marker.length) : line.text;
      if (spec.afterMarker) text = text.includes(spec.afterMarker) ? text.slice(text.indexOf(spec.afterMarker) + spec.afterMarker.length) : '';
      const match = spec.mode === 'maximum_range' ? text.match(/(\d+)(?:\s*~\s*(\d+))?/) : text.match(/(-?\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/);
      if (spec.mode === 'maximum_range' && match) return { value: Number(match[2] ?? match[1]), target: null, time: line.time };
      return match ? { value: Number(match[1]), target: match[2] ? Number(match[2]) : null, time: line.time } : null;
    }).filter(Boolean);
    const before = numbers[0]?.value ?? null, end = numbers.at(-1);
    const mode = spec.mode ?? 'last';
    if (!['count', 'last', 'difference', 'maximum', 'maximum_range', 'result', 'constant', 'grouped_count', 'task_count'].includes(mode)) throw new SourceError('config', `Unsupported metric mode: ${mode}`);
    const run = runs.find(run => !spec.runKind || run.kind === spec.runKind);
    const pathValue = path => (path ?? []).reduce((value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined, run?.result);
    const value = mode === 'task_count' ? tasks.filter(task => task.enabled && (!spec.outcomes || spec.outcomes.includes(task.outcome)) && (!spec.requiredOnly || task.required)).length : mode === 'constant' ? spec.value : mode === 'result' ? pathValue(spec.resultPath) ?? spec.fallbackValue ?? null : mode === 'grouped_count' ? Object.fromEntries(Object.entries(spec.countsByMarkers ?? {}).map(([key, marker]) => [key, scopedLines.filter(line => has(line.text, marker)).length])) : mode === 'count' ? found.length : mode === 'difference' ? end ? before - end.value : null : ['maximum', 'maximum_range'].includes(mode) ? numbers.length ? Math.max(...numbers.map(item => item.value)) : null : end?.value ?? null;
    let estimated = found.at(-1)?.time ?? run?.end;
    if (spec.estimatedAtPath) {
      const raw = String(pathValue(spec.estimatedAtPath) ?? '');
      const match = raw.match(/(20\d{2}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
      estimated = parseTime(raw) ?? (match ? localTimestamp(match[1], `${match[2]}:${match[3] ?? '00'}`, timestampOptions) : null);
    }
    return { metric_id: spec.metricId, label: spec.label ?? spec.metricId, value, target: spec.target ?? end?.target ?? null,
      unit: spec.unit ?? null, before: ['difference', 'last'].includes(mode) ? before : null, after: ['difference', 'last'].includes(mode) ? end?.value ?? null : null, estimated_at: iso(estimated) };
  });
}

function schedulerFromLines(lines, frontend, config, window) {
  const startMarker = config.startMarker ?? '定时唤起任务';
  const candidates = lines.filter(line => inWindow(line.time, window));
  const start = candidates.find(line => line.text.includes(startMarker));
  let end = null, id = null, items = 0, retries = 0;
  if (start) for (const line of candidates.filter(line => line.time >= start.time)) {
    if (line !== start && line.text.includes(startMarker)) break; // A later run cannot close an earlier incomplete run.
    const found = line.text.match(/任务\s+([\w-]+)\s+检索完成，包含\s+(\d+)\s+个脚本项/);
    if (found && id === null) { id = found[1]; items = Number(found[2]); }
    const attempt = line.text.match(/尝试次数:\s*(\d+)\/(\d+)/);
    if (attempt && Number(attempt[1]) > 1) retries++;
    if ((config.endMarker && line.text.includes(config.endMarker)) || (id && line.text.includes(`任务结束: ${id}`))) { end = line; break; }
  }
  // Frontend fallback must identify this run; an unrelated Accomplish signal is insufficient.
  if (!end && start && id) end = frontend.find(line => inWindow(line.time, window) && line.time >= start.time && line.text.includes('收到Accomplish信号') && (line.text.includes(id) || config.allowUnscopedFrontendEnd === true)) ?? null;
  const unscopedCompletion = end && id && !end.text.includes(id) ? end : null;
  if (unscopedCompletion) end = null;
  const warnings = [];
  if (start && !end) warnings.push('Scheduler start observed without a matching end; verify the run.');
  if (unscopedCompletion) warnings.push(`An unscoped frontend completion at ${iso(unscopedCompletion.time)} was observed under the configured compatibility policy; attribution is unconfirmed.`);
  if (start && config.expectedItems !== undefined && items !== config.expectedItems) warnings.push(`Detected ${items} items; configuration expects ${config.expectedItems}.`);
  return { scheduler_id: config.id ?? 'automas', name: config.name ?? 'Configured scheduler', expected_to_run: config.expectedToRun !== false,
    run_observed: Boolean(start), started_at: iso(start?.time), ended_at: iso(end?.time), reported_top_level_status: !start ? 'not_observed' : end ? 'ended' : unscopedCompletion ? 'unscoped_completion_observed' : 'started',
    status_hint: !start ? 'not_run' : end ? 'ok' : 'verify', items_detected: items, retry_count: retries, warnings };
}

/** Read supplied raw runs; no home directories, history discovery, accounts or network. */
export async function readGameDaily({ scope, window: inputWindow, reportMeta: inputMeta, scheduler: schedulerConfig = {}, automations: configurations, screenshots: screenshotInputs = [], additionalSources = [] } = {}) {
  if (!inputMeta?.device_id || !inputMeta?.source_timezone || !inputMeta?.report_timezone || parseTime(inputMeta.collected_at) === null) throw new SourceError('config', 'Explicit device, source timezone, report timezone and collected_at are required');
  const window = normalizeWindow(inputWindow ?? calendarWindow({ businessDate: inputMeta.business_date, timeZone: inputMeta.report_timezone, now: inputMeta.collected_at }));
  const reportMeta = { ...inputMeta, business_date: window.date ?? calendarWindow({ businessDate: inputMeta.business_date, timeZone: inputMeta.report_timezone }).date,
    source_utc_offset: offsetText(Date.parse(window.start), inputMeta.source_timezone) };
  assertRows(configurations, scope, 'automations');
  const sourceIds = new Set(), sources = [], missing = [], errors = [], screenshots = [];
  const options = config => ({ limits: scope.limits, sourceUtcOffset: config.sourceUtcOffset, sourceTimezone: config.sourceTimezone ?? reportMeta.source_timezone,
    disambiguation: config.disambiguation, encoding: config.encoding ?? 'auto', fallbackDate: config.fallbackDate ?? reportMeta.business_date });
  async function readFile(path, id, kind, config = {}, json = false) {
    if (!path) return null;
    if (sourceIds.has(id)) throw new SourceError('config', 'Duplicate evidence source ID');
    sourceIds.add(id);
    const source = { source_id: id, kind, path, last_modified_at: null, read_status: 'ok' }; sources.push(source);
    try {
      const bytes = json ? null : await scope.read(path, { maxBytes: config.maxBytes ?? scope.limits.maxBytes, tail: config.readMode === 'tail' });
      const observation = scope.evidence.at(-1);
      const textBytes = !json && observation?.read_status === 'partial' ? completeTailLines(bytes, config.encoding ?? 'auto') : bytes;
      const result = json ? await scope.json(path, { encoding: config.encoding ?? 'auto' }) : parseLogLines(textBytes, options(config)).map(line => ({ ...line, sourceId: id }));
      source.last_modified_at = (await scope.metadata(path)).last_modified_at;
      if (!json && observation?.read_status === 'partial') { source.read_status = 'partial'; errors.push(`${id}: only the configured tail was observed`); }
      return result;
    } catch (error) { source.read_status = error.code ?? 'unavailable'; missing.push(id); errors.push(`${id}: ${failure(error).message}`); return null; }
  }
  for (const item of additionalSources) await readFile(item.path, item.source_id, item.kind ?? 'configuration', item, true);
  const schedulerLines = await readFile(schedulerConfig.appLog, 'scheduler.app', 'scheduler_log', schedulerConfig) ?? [];
  const frontendLines = await readFile(schedulerConfig.frontendLog, 'scheduler.frontend', 'scheduler_frontend_log', schedulerConfig) ?? [];
  const scheduler = schedulerFromLines(schedulerLines, frontendLines, schedulerConfig, window);
  if (missing.some(id => id.startsWith('scheduler.'))) scheduler.warnings.push('Configured scheduler evidence unavailable; absent events do not establish zero activity.');
  const automations = [], actions = [], allTasks = new Set(), automationIds = new Set();
  for (const config of configurations) {
    if (!config.id || automationIds.has(config.id)) throw new SourceError('config', 'Automation IDs must be nonempty and unique');
    automationIds.add(config.id);
    if (config.runSelection && !['earliest', 'latest'].includes(config.runSelection)) throw new SourceError('config', 'runSelection must be earliest or latest');
    const specs = assertRows(config.tasks, scope, 'automation tasks');
    for (const spec of specs) {
      if (!spec.taskId || allTasks.has(spec.taskId)) throw new SourceError('config', 'Task IDs must be globally unique');
      allTasks.add(spec.taskId);
    }
    const localIds = new Set(specs.map(spec => spec.taskId));
    for (const spec of specs) for (const key of ['nonblockingAfterTaskId', 'followMainTaskId', 'optionalWhenTaskSucceeds']) if (spec[key] && (!localIds.has(spec[key]) || spec[key] === spec.taskId)) throw new SourceError('config', `Invalid local task policy reference: ${key}`);
    if (config.cascadeFromTaskId && !localIds.has(config.cascadeFromTaskId)) throw new SourceError('config', 'Cascade source must belong to this automation');
    const runs = [];
    for (const [index, run] of assertRows(config.runs ?? [], scope, 'runs').entries()) {
      const prefix = `${config.id}.run${index + 1}`;
      const result = await readFile(run.resultFile, `${prefix}.result`, 'automation_result', run, true);
      const raw = await readFile(run.logFile, `${prefix}.log`, 'automation_log', run) ?? [];
      const engine = await readFile(run.engineLogFile, `${prefix}.engine`, 'engine_log', run) ?? [];
      const boundLines = raw.filter(line => line.time !== null);
      const start = parseTime(run.startedAt) ?? boundLines[0]?.time ?? null;
      const end = parseTime(run.endedAt) ?? boundLines.at(-1)?.time ?? start;
      if (start === null || end === null) { if (raw.length || result) errors.push(`${prefix}: run time unavailable; supply startedAt/endedAt or timestamped logs`); continue; }
      if (end < Date.parse(window.start) || start >= Date.parse(window.end)) continue;
      const withinRun = line => line.time !== null && inWindow(line.time, window) && line.time >= start - (run.enginePaddingMs ?? 3000) && line.time <= end + (run.enginePaddingMs ?? 3000);
      const includeUntimed = (run.includeUntimedMarkers ?? config.includeUntimedMarkers) === true && start >= Date.parse(window.start) && end < Date.parse(window.end);
      const logLines = raw.filter(line => withinRun(line) || (includeUntimed && line.time === null)).map(line => ({ ...line, contextTime: start }));
      const lines = [...logLines, ...engine.filter(withinRun)].map(line => ({ ...line, runKind: run.kind })).sort((a, b) => (a.time ?? a.contextTime) - (b.time ?? b.contextTime) || a.line - b.line);
      runs.push({ start, end, lines, result, kind: run.kind, index, refs: sources.filter(source => source.source_id.startsWith(prefix + '.') && ['ok', 'partial'].includes(source.read_status)).map(source => source.source_id) });
    }
    runs.sort((a, b) => a.start - b.start || a.index - b.index);
    const withinScheduler = scheduler.started_at && scheduler.ended_at ? runs.filter(run => run.start >= Date.parse(scheduler.started_at) - 120000 && run.end <= Date.parse(scheduler.ended_at) + 120000) : [];
    const candidates = withinScheduler.length ? withinScheduler : runs;
    const selected = config.mergeRuns ? candidates.filter((run, index) => index === 0 || !config.retryResultMarker ||
      String(run.result?.hsr_result ?? run.result?.general_result ?? '').includes(config.retryResultMarker)) : config.mergeRunKinds ? config.mergeRunKinds.map(kind => {
      const matching = runs.filter(run => run.kind === kind), bounded = withinScheduler.filter(run => run.kind === kind);
      return (bounded.length ? bounded : matching).at(config.runSelection === 'latest' ? -1 : 0);
    }).filter(Boolean) : [candidates.at(config.runSelection === 'latest' ? -1 : 0)].filter(Boolean);
    const chosen = selected.length ? { start: Math.min(...selected.map(run => run.start)), end: Math.max(...selected.map(run => run.end)), refs: [...new Set(selected.flatMap(run => run.refs))] } : null;
    const observed = Boolean(chosen), lines = selected.flatMap(run => run.lines).sort((a, b) => a.time - b.time || a.line - b.line);
    const tasks = specs.map(spec => {
      const matchingRuns = spec.runKinds ? selected.filter(run => spec.runKinds.includes(run.kind)) : selected;
      const evidenceLines = matchingRuns.flatMap(run => run.lines).filter(line => !spec.timestampRequired || line.time !== null).sort((a, b) => (a.time ?? a.contextTime) - (b.time ?? b.contextTime) || a.line - b.line);
      return evaluateTask(spec, evidenceLines, matchingRuns.length > 0, matchingRuns.flatMap(run => run.refs));
    });
    applyTaskPolicies(tasks, specs);
    const failed = tasks.filter(task => task.enabled && task.outcome === 'failed').sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at));
    const first = failed[0];
    let cascade = false;
    if (first && first.task_id === config.cascadeFromTaskId) for (const task of failed.slice(1)) {
      if (task.ended_at && first.ended_at && Date.parse(task.ended_at) > Date.parse(first.ended_at)) {
        task.caused_by_task_id = first.task_id; task.causal_confidence = 'suspected'; cascade = true;
        task.reason += ' Temporal ordering suggests a possible cascade; causation is unconfirmed.';
      }
    }
    const requiredFailed = tasks.some(task => task.enabled && task.required && task.outcome === 'failed');
    const requiredUnknown = tasks.some(task => task.enabled && task.required && ['uncertain', 'not_observed'].includes(task.outcome));
    const warnings = [];
    if (missing.some(id => id.startsWith(config.id + '.'))) warnings.push('Configured source unavailable; lack of observed activity is not a measured zero.');
    if (sources.some(source => source.source_id.startsWith(config.id + '.') && source.read_status === 'partial')) warnings.push('Only a configured log tail was read; earlier activity may be absent.');
    if (observed) warnings.push('Top-level result is retained as evidence; task markers determine task outcomes.');
    if (cascade) warnings.push('Cascade is suspected from timestamps only; root cause is unconfirmed.');
    const statuses = [...new Set(selected.map(run => run.result?.general_result ?? run.result?.maa_result ?? run.result?.hsr_result ?? run.result?.status).filter(value => value !== null && value !== undefined && String(value).trim()).map(String))];
    const status = statuses.join('; ');
    automations.push({ automation_id: config.id, engine: config.engine ?? 'configured', game: config.game ?? config.id,
      account: config.account ?? 'operator-unspecified', instance: config.instance ?? 'default', expected_to_run: config.expectedToRun !== false,
      run_observed: observed, started_at: iso(chosen?.start), ended_at: iso(chosen?.end),
      reported_top_level_status: observed ? String(status ?? '').trim() || 'unknown' : 'not_observed',
      status_hint: !observed ? 'not_run' : requiredFailed ? 'action_required' : requiredUnknown ? 'verify' : 'ok',
      tasks, metrics: metricsFromLines(config.metrics, lines, selected, options(config), tasks), diagnosis: { first_unrecovered_task_id: first?.task_id ?? null,
        cascade_suspected: cascade, note: cascade ? 'Possible downstream cascade; evidence does not establish causation.' : 'Main and optional task outcomes evaluated from configured source markers.' }, warnings });
    const actionable = tasks.filter(task => task.enabled && task.required && ['failed', 'uncertain'].includes(task.outcome));
    if (actionable.length) actions.push({ action_id: `${config.id}.verify`, priority: actionable.some(task => task.outcome === 'failed') ? 'p1' : 'p2', automation_id: config.id,
      task_ids: actionable.map(task => task.task_id), type: 'investigate_then_rerun', title: `Verify ${config.game ?? config.id} incomplete tasks`, detail: 'Inspect source evidence and confirm the cause before rerunning required tasks.' });
    const manual = tasks.filter(task => task.enabled && specs.find(spec => spec.taskId === task.task_id)?.manual);
    if (manual.length) actions.push({ action_id: `${config.id}.manual`, priority: 'p2', automation_id: config.id, task_ids: manual.map(task => task.task_id), type: 'manual_reminder', title: `Complete configured manual tasks for ${config.game ?? config.id}`, detail: 'These manual tasks are excluded from automatic main-task failure.' });
  }
  for (const item of assertRows(screenshotInputs, scope, 'screenshots')) {
    if (!item.screenshot_id || sourceIds.has(item.screenshot_id) || !automationIds.has(item.automation_id)) throw new SourceError('config', 'Screenshot needs a unique ID and configured automation owner');
    sourceIds.add(item.screenshot_id);
    try { await scope.read(item.path); screenshots.push({ screenshot_id: item.screenshot_id, path: item.path, automation_id: item.automation_id, description: item.description ?? 'Configured screenshot evidence' }); }
    catch (error) { missing.push(item.screenshot_id); errors.push(`${item.screenshot_id}: ${failure(error).message}`); }
  }
  return { schema_version: 'game_daily_report.v1', report_meta: { report_id: reportMeta.report_id ?? `${reportMeta.device_id}-game-${reportMeta.business_date}`, ...reportMeta },
    scheduler, automations, action_candidates: actions, evidence: { sources, screenshots, missing_sources: missing },
    analysis_notes: [errors.length ? `Source reading is partial: ${errors.slice(0, 2).join('; ')}`.slice(0, 240) : 'All configured source files read within explicit bounds.',
      'Only timestamps inside the half-open report window support task outcomes; manual and optional rules are configuration.' ] };
}
