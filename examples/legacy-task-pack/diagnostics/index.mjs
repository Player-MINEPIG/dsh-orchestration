// SPDX-License-Identifier: MIT
// Independent lookback diagnostics over operator-selected exports, never a live scan.
import { createSourceScope, SourceError, assertRows, parseTime, decodeText, completeTailLines, object } from '../readers/common.mjs';
import { parseLogLines } from '../readers/game.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson, ReportContractError } from '../reporting.mjs';

const DEFAULT_BOUNDS = Object.freeze({ maxHistoryRuns: 40, maxEventsPerLog: 12, maxEventsPerHistory: 10, maxTextChars: 700, maxOutputChars: 32_000, logMaxBytes: 3_000_000, historyLogMaxBytes: 1_500_000 });
// Public diagnostic vocabulary; caller markers extend it without executable regular expressions.
const INTEREST = /\b(?:error|err|warning|warn|success)\b|异常|失败|超时|任务已全部完成|执行成功|游戏终止|开拓力|理智将在|掉落统计|完成任务|全部结束|队列.*(?:完成|结束)/i;
const NOISE = /HTTP Request:|127\.0\.0\.1:|开始检查更新|获取版本信息成功|Request headers:|authorization|token|password|secret|api[_-]?key/i;
const SECRET_KEY = /authorization|token|password|secret|api[_-]?key|credential|penguinid/i;
const PROCESS_HINTS = ['auto-mas', 'maa.exe', 'march7th', 'onedragon', 'zenlesszonezero'];

/** Redact before truncating, including quoted credentials and complete bearer values. */
export function redactDiagnosticsText(value, maxChars = 700) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1_000_000) throw new SourceError('limit', 'Invalid diagnostic text bound');
  return String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\b(?:authorization|token|password|secret|api[_-]?key|credential)\b["']?\s*[:=]\s*(?:["'][^"'\r\n]*["']|(?:Bearer|Basic)\s+\S+|[^\s,;]+)/gi, '<redacted>')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]+/gi, '<redacted>')
    .replace(/\bPenguinID\s+\d+/gi, 'PenguinID <redacted>')
    .replace(/\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b|\b[a-f\d]{28,}\b/gi, '<opaque-id: redacted>')
    .replace(/\b[A-Z\d._%+-]+@[A-Z\d.-]+\.[A-Z]{2,}\b/gi, '<email: redacted>')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"']+|\/(?:home|Users|root)\/[^\s"']+/g, '<local-path: redacted>')
    .trim().slice(0, maxChars);
}

function bounds(input, scope) {
  const result = { ...DEFAULT_BOUNDS, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Object.hasOwn(DEFAULT_BOUNDS, key) || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) throw new SourceError('limit', 'Invalid diagnostic bound');
  }
  if (result.maxHistoryRuns > scope.limits.maxRows || result.maxEventsPerLog > scope.limits.maxRows || result.maxEventsPerHistory > scope.limits.maxRows) throw new SourceError('limit', 'Diagnostic row bounds must fit the source scope');
  if (result.maxTextChars > 1_000_000 || result.maxOutputChars < 128 || result.maxOutputChars > 1_000_000) throw new SourceError('limit', 'Invalid diagnostic text/output bound');
  result.logMaxBytes = Math.min(result.logMaxBytes, scope.limits.maxBytes);
  result.historyLogMaxBytes = Math.min(result.historyLogMaxBytes, scope.limits.maxBytes);
  return result;
}
const isSuccess = value => /success|成功/i.test(value);
const markerMatch = (text, markers) => markers.some(marker => text.toLowerCase().includes(marker.toLowerCase()));
function markers(value, scope, label) {
  return assertRows(value ?? [], scope, label).map(item => {
    if (typeof item !== 'string' || !item || item.length > 512) throw new SourceError('config', 'Markers must be nonempty bounded strings');
    return item;
  });
}

function scriptsFromConfig(config, scope, clean) {
  const rows = assertRows(config.instances ?? [], scope, 'script instances');
  return rows.filter(row => row && typeof row === 'object').map(row => {
    const entry = object(config[String(row.uid)]), info = object(entry.Info), script = object(entry.Script);
    const users = object(object(entry.SubConfigsInfo).UserData);
    return { id: clean(row.uid), name: clean(info.Name || row.type || row.uid || 'unnamed'), type: clean(row.type),
      // Paths in configuration are never resolved; the host must map exported logs explicitly.
      hasConfiguredRoot: Boolean(info.Path || info.RootPath), hasConfiguredLog: Boolean(script.LogPath),
      successMarker: clean(script.SuccessLog), errorMarker: clean(script.ErrorLog),
      users: assertRows(users.instances ?? [], scope, 'script user instances').filter(row => row && typeof row === 'object').map(user => {
        const value = object(users[String(user.uid)]), userInfo = object(value.Info), data = object(value.Data);
        return { enabled: userInfo.Status === undefined ? null : typeof userInfo.Status === 'boolean' ? userInfo.Status : clean(userInfo.Status), lastProxyAt: clean(data.LastProxyDate), proxyCount: Number.isSafeInteger(data.ProxyTimes) ? data.ProxyTimes : clean(data.ProxyTimes) };
      }) };
  });
}
function queuesFromConfig(config, scope, clean) {
  return assertRows(config.instances ?? [], scope, 'queue instances').filter(row => row && typeof row === 'object').map(row => {
    const entry = object(config[String(row.uid)]), info = object(entry.Info), data = object(entry.Data), times = object(object(entry.SubConfigsInfo).TimeSet);
    return { name: clean(info.Name || 'unnamed queue'), timedEnabled: info.TimeEnabled === undefined ? null : typeof info.TimeEnabled === 'boolean' ? info.TimeEnabled : clean(info.TimeEnabled), lastTimedStart: clean(data.LastTimedStart),
      schedules: assertRows(times.instances ?? [], scope, 'queue schedules').filter(row => row && typeof row === 'object').map(time => {
        const info = object(object(times[String(time.uid)]).Info);
        return { time: clean(info.Time), enabled: info.Enabled === undefined ? null : typeof info.Enabled === 'boolean' ? info.Enabled : clean(info.Enabled) };
      }) };
  });
}
function classifyHistory(text, scripts) {
  const low = text.toLowerCase();
  if (/maaassistantarknights|taskqueueviewmodel|asstproxy/.test(low)) return scripts.find(script => script.type.toLowerCase() === 'maaconfig')?.name ?? 'MAA';
  if (/starrail|每日实训|开拓力|march7th/.test(low)) return scripts.find(script => /march7/i.test(script.name))?.name ?? 'March7thAssistant';
  if (/一条龙|one_dragon|zenless|绝区零/.test(low)) return scripts.find(script => /onedragon|绝区零/i.test(script.name))?.name ?? 'OneDragon';
  return scripts.find(script => [script.successMarker, script.errorMarker].some(marker => marker && text.includes(marker)))?.name ?? 'unclassified';
}
function resourceDetails(value, scope, clean) {
  const output = {};
  for (const key of ['sanity', 'sanity_full_at', 'drop_statistics', 'recruit_statistics']) {
    if (!Object.hasOwn(value, key)) continue;
    const source = value[key];
    if (source && typeof source === 'object') {
      // Flat statistics only, with credential-like keys omitted and a strict row bound.
      const entries = Object.entries(source);
      if (entries.length > scope.limits.maxRows) throw new SourceError('limit', 'Result statistics exceed configured row bound');
      output[key] = Object.fromEntries(entries.filter(([name]) => !SECRET_KEY.test(name)).slice(0, 40).map(([name, value]) => [clean(name), clean(typeof value === 'object' ? '[nested statistics omitted]' : value)]));
    } else output[key] = clean(source);
  }
  return output;
}

/**
 * Build evidence-only on-demand diagnostics. No installed-app discovery, process
 * enumeration, shell, network, account lookup or implicit absolute config paths.
 * History file mtime (not its event date) is the legacy inclusion evidence.
 */
export async function readAutomationDiagnostics({ scope: suppliedScope, exportRoot, sourceLimits, deviceId = 'operator-unspecified', collectedAt, hours = 26,
  sourceTimezone, sourceUtcOffset, encoding = 'auto', scriptConfigFile, queueConfigFile, historyRoot, historyFiles = [],
  logs = [], processInventory, processMarkers = PROCESS_HINTS, interestMarkers = [], noiseMarkers = [], bounds: inputBounds = {} } = {}) {
  const scope = suppliedScope ?? await createSourceScope(exportRoot, sourceLimits);
  const now = parseTime(collectedAt);
  if (now === null || typeof collectedAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(collectedAt)) throw new SourceError('time', 'Explicit collectedAt timestamp with an offset is required');
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 366) throw new SourceError('window', 'Lookback hours must be between 1 and 8784');
  if (!sourceTimezone && !sourceUtcOffset) throw new SourceError('timezone', 'Explicit sourceTimezone or sourceUtcOffset is required');
  if (sourceTimezone) {
    try { new Intl.DateTimeFormat('en', { timeZone: sourceTimezone }).format(now); }
    catch { throw new SourceError('timezone', 'Invalid sourceTimezone'); }
  }
  // Validate timestamp options even when every configured file is missing or empty.
  parseLogLines(Buffer.alloc(0), { sourceTimezone, sourceUtcOffset, limits: scope.limits, encoding });
  const limit = bounds(inputBounds, scope), clean = value => redactDiagnosticsText(value, limit.maxTextChars), cutoff = now - hours * 3_600_000;
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 256 || clean(deviceId) !== deviceId) throw new SourceError('config', 'A bounded non-sensitive deviceId is required');
  const extraInterest = markers(interestMarkers, scope, 'interest markers'), extraNoise = markers(noiseMarkers, scope, 'noise markers');
  const relatedProcesses = markers(processMarkers, scope, 'process markers');
  const sources = [], errors = [], warnings = [], truncations = [];
  const sourceIds = new Set();
  const window = { kind: 'lookback', hours, start: new Date(cutoff).toISOString(), end: new Date(now).toISOString(), interval: 'left_closed_right_closed' };
  async function file(path, id, kind, { json = false, maxBytes = limit.logMaxBytes, ...options } = {}) {
    const sourceId = clean(id);
    if (sourceIds.has(sourceId)) throw new SourceError('config', 'Diagnostic source IDs must be unique after redaction');
    sourceIds.add(sourceId);
    const safePath = typeof path === 'string' && !/^(?:[/\\]|[A-Za-z]:)/.test(path) && !path.split(/[\\/]/).includes('..') ? clean(path) : '[unresolved export input]';
    const source = { source_id: sourceId, kind, path: safePath, read_status: 'unavailable', last_modified_at: null };
    sources.push(source);
    try {
      const metadata = await scope.metadata(path);
      source.path = clean(metadata.path); source.last_modified_at = metadata.last_modified_at;
      const bytes = await scope.read(path, { maxBytes: json ? scope.limits.maxBytes : maxBytes, tail: !json });
      const observation = scope.evidence.at(-1);
      source.read_status = observation.read_status;
      source.bytes = observation.bytes; source.original_bytes = observation.original_bytes;
      source.sha256 = createHash('sha256').update(bytes).digest('hex');
      if (source.read_status === 'partial') truncations.push(clean(id));
      const content = source.read_status === 'partial' ? completeTailLines(bytes, options.encoding ?? encoding) : bytes;
      const text = decodeText(content, options.encoding ?? encoding);
      if (json) {
        let value; try { value = JSON.parse(text); } catch { throw new SourceError('json', 'Malformed exported JSON'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceError('format', 'Expected an exported JSON object');
        return { value, source };
      }
      const lines = parseLogLines(content, { sourceTimezone: options.sourceTimezone ?? sourceTimezone, sourceUtcOffset: options.sourceUtcOffset ?? sourceUtcOffset,
        disambiguation: options.disambiguation, fallbackDate: options.fallbackDate, encoding: options.encoding ?? encoding, limits: scope.limits });
      return { text, lines, source };
    } catch (error) {
      source.read_status = error.code ?? 'read';
      errors.push({ source_id: clean(id), code: error.code ?? 'read', message: 'Configured exported evidence is unavailable or invalid' });
      return { source };
    }
  }
  function events(lines, maximum, id) {
    let prior = null, omitted = 0;
    const selected = [];
    for (const line of lines ?? []) {
      if (line.time !== null && (line.time < cutoff || line.time > now)) continue;
      const text = clean(line.text);
      if (!text || text === prior) { omitted++; continue; }
      prior = text;
      // Test raw lines so redaction cannot hide a noise/credential marker.
      if (NOISE.test(line.text) || markerMatch(line.text, extraNoise)) continue;
      if (INTEREST.test(text) || markerMatch(text, extraInterest)) selected.push({ text, at: line.time === null ? null : new Date(line.time).toISOString(), timestamped: line.time !== null });
    }
    if (selected.length > maximum) truncations.push(clean(`${id}.events`));
    return { events: selected.slice(-maximum), repeated_lines_omitted: omitted };
  }

  const scriptInput = scriptConfigFile ? await file(scriptConfigFile, 'configuration.scripts', 'script_config', { json: true }) : null;
  const queueInput = queueConfigFile ? await file(queueConfigFile, 'configuration.queues', 'queue_config', { json: true }) : null;
  const scripts = scriptInput?.value ? scriptsFromConfig(scriptInput.value, scope, clean) : [];
  const queues = queueInput?.value ? queuesFromConfig(queueInput.value, scope, clean) : [];
  if (!scriptConfigFile) warnings.push('Script configuration was not supplied');
  if (!queueConfigFile) warnings.push('Queue configuration was not supplied');
  const inventory = assertRows(historyFiles, scope, 'history files').map(value => typeof value === 'string' ? { resultFile: value } : value);
  if (historyRoot) {
    try { inventory.push(...(await scope.list(historyRoot, { recursive: true, extensions: ['.json'] })).map(resultFile => ({ resultFile }))); }
    catch (error) { errors.push({ source_id: 'history.inventory', code: error.code ?? 'read', message: 'Configured history inventory is unavailable' }); }
  }
  assertRows(inventory, scope, 'history inventory');
  // Metadata selection happens before reading results, so recent runs win the bound.
  const recent = [], seenFiles = new Set();
  for (const entry of inventory) {
    if (!entry || typeof entry.resultFile !== 'string') throw new SourceError('config', 'History entries require resultFile');
    try {
      const metadata = await scope.metadata(entry.resultFile), time = parseTime(metadata.last_modified_at);
      if (seenFiles.has(metadata.path)) continue; seenFiles.add(metadata.path);
      if (time >= cutoff && time <= now) recent.push({ ...entry, metadata, time });
    } catch (error) { errors.push({ source_id: 'history.inventory', code: error.code ?? 'read', message: 'A configured history entry is unavailable' }); }
  }
  recent.sort((a, b) => a.time - b.time || a.metadata.path.localeCompare(b.metadata.path));
  if (recent.length > limit.maxHistoryRuns) truncations.push('history.runs');
  const history = [];
  for (const [index, entry] of recent.slice(-limit.maxHistoryRuns).entries()) {
    const id = `history.${index + 1}`, result = await file(entry.resultFile, `${id}.result`, 'history_result', { json: true, encoding: entry.encoding });
    const logFile = entry.logFile ?? entry.resultFile.replace(/\.json$/i, '.log');
    const log = await file(logFile, `${id}.log`, 'history_log', { ...entry, maxBytes: Math.min(entry.maxBytes ?? limit.historyLogMaxBytes, limit.historyLogMaxBytes) });
    if (!result.value) continue;
    const script = clean(entry.script ?? classifyHistory(log.text ?? '', scripts));
    history.push({ script, source: result.source.path, at: new Date(entry.time).toISOString(),
      reported_result: clean(result.value.maa_result ?? result.value.general_result ?? 'unrecorded'),
      ...resourceDetails(result.value, scope, clean), ...events(log.lines, limit.maxEventsPerHistory, id), evidence_refs: [result.source.source_id, log.source.source_id] });
  }
  const sections = [];
  for (const [index, entry] of assertRows(logs, scope, 'diagnostic logs').entries()) {
    if (!entry || typeof entry.path !== 'string') throw new SourceError('config', 'Diagnostic log entries require path');
    const id = entry.id ?? `diagnostic.${index + 1}`;
    if (typeof id !== 'string' || !id || id.length > 512) throw new SourceError('config', 'Invalid diagnostic source ID');
    const log = await file(entry.path, id, 'diagnostic_log', { ...entry, maxBytes: Math.min(entry.maxBytes ?? limit.logMaxBytes, limit.logMaxBytes) });
    sections.push({ label: clean(entry.label ?? id), source_id: clean(id), path: log.source.path, read_status: log.source.read_status,
      last_modified_at: log.source.last_modified_at, age_hours: log.source.last_modified_at ? Math.max(0, now - Date.parse(log.source.last_modified_at)) / 3_600_000 : null,
      ...events(log.lines, limit.maxEventsPerLog, id) });
  }
  let processSnapshot = { supplied: false, names: null, note: 'No host process inventory supplied; process state is unknown' };
  if (processInventory !== undefined) {
    const names = assertRows(processInventory, scope, 'host process inventory').map(item => {
      const name = typeof item === 'string' ? item : item?.name;
      if (typeof name !== 'string' || name.length > scope.limits.maxMessageChars) throw new SourceError('config', 'Process inventory entries require a bounded image name');
      // Command lines, paths, PIDs and environment fields are never consumed.
      if (/[\\/\r\n\x00]/.test(name)) throw new SourceError('config', 'Supply process image names, not paths or command lines');
      return name;
    }).filter(name => markerMatch(name, relatedProcesses));
    processSnapshot = { supplied: true, names: [...new Set(names.map(clean))].sort((a, b) => a.localeCompare(b)), note: 'Host-supplied snapshot only; exited or absent processes do not establish task failure' };
  }
  const names = [...new Set([...scripts.map(script => script.name), ...history.map(run => run.script)])];
  const statuses = names.map(name => {
    const runs = history.filter(run => run.script === name), latest = runs.at(-1), failures = runs.filter(run => !isSuccess(run.reported_result)).length;
    return { script: name, run_count: runs.length, status_hint: !latest ? 'not_observed' : isSuccess(latest.reported_result) ? 'latest_reported_success' : 'verify',
      latest_result: latest?.reported_result ?? null, previous_failure_count: latest && isSuccess(latest.reported_result) ? failures : 0,
      latest_age_hours: latest ? (now - Date.parse(latest.at)) / 3_600_000 : null };
  });
  if (history.some(run => run.events.some(event => !event.timestamped)) || sections.some(section => section.events.some(event => !event.timestamped))) warnings.push('Untimed signals are retained as unscoped diagnostic context, never proof of in-window task completion');
  if (truncations.length) warnings.push('Configured bounds limited the evidence; earlier events or runs may be absent');
  const report = { schema_version: 'automation_diagnostics.v1', authoritativeExecution: false, device_id: deviceId, collected_at: new Date(now).toISOString(), window,
    bounds: limit, source_limits: Object.fromEntries(['maxBytes', 'maxTotalBytes', 'maxFiles', 'maxRows', 'maxLineBytes', 'maxMessageChars', 'maxDirectories'].map(key => [key, scope.limits[key]])),
    scripts, queues, history, statuses, diagnostic_logs: sections, process_snapshot: processSnapshot, evidence: { sources },
    data_quality: { complete: errors.length === 0 && truncations.length === 0, errors, warnings, truncations: [...new Set(truncations)] },
    limitations: ['Exported history result and mtime are evidence only, not authoritative task execution', 'No root discovery, live process enumeration, OS scan or network query', 'A rolling lookback differs from the strict calendar GameDaily report'] };
  const rendered = renderAutomationDiagnostics(report, { maxOutputChars: limit.maxOutputChars });
  report.text = rendered.text; report.text_truncated = rendered.truncated;
  return validateAutomationDiagnostics(report);
}

/** Bounded plain text, suitable for an on-demand task artifact or host delivery. */
export function renderAutomationDiagnostics(report, { mode = 'evidence', maxOutputChars = report?.bounds?.maxOutputChars ?? 32_000 } = {}) {
  if (report?.schema_version !== 'automation_diagnostics.v1' || report.authoritativeExecution !== false) throw new SourceError('format', 'Expected evidence-only automation diagnostics');
  if (!['evidence', 'summary'].includes(mode)) throw new SourceError('config', 'Diagnostic text mode must be evidence or summary');
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 128 || maxOutputChars > 1_000_000) throw new SourceError('limit', 'Invalid diagnostic output bound');
  const out = [`自动化诊断（仅导出证据）`, `采集：${report.collected_at}`, `回溯：${report.window.hours} 小时；${report.window.start} 至 ${report.window.end}`];
  for (const status of report.statuses) out.push(`${status.script}：${status.status_hint === 'not_observed' ? '未发现运行记录' : status.status_hint === 'latest_reported_success' ? '最新记录报告成功' + (status.previous_failure_count ? `；之前失败 ${status.previous_failure_count} 次，后续记录成功` : '') : `最新记录需核实（${status.latest_result}）`}`);
  out.push(`进程：${report.process_snapshot.supplied ? report.process_snapshot.names.join(', ') || '所给清单无匹配项' : '未提供清单'}；进程缺失不能证明失败`);
  for (const queue of report.queues) out.push(`队列 ${queue.name}：定时启用=${queue.timedEnabled ?? '未知'}；计划=${queue.schedules.map(schedule => `${schedule.time} (${schedule.enabled ?? '未知'})`).join(', ') || '无'}；最近启动=${queue.lastTimedStart || '未知'}`);
  if (mode === 'evidence') {
    out.push('[脚本配置]');
    for (const script of report.scripts) out.push(`${script.name} (${script.type})；用户状态条目=${script.users.length}；根路径/日志仅作配置存在性记录`);
    out.push('[历史证据]');
    for (const run of report.history) {
      out.push(`${run.script} | ${run.at} | ${run.reported_result} | ${run.source}`);
      for (const key of ['sanity', 'sanity_full_at', 'drop_statistics', 'recruit_statistics']) if (Object.hasOwn(run, key)) out.push(`  ${key}=${typeof run[key] === 'object' ? JSON.stringify(run[key]) : run[key]}`);
      out.push(...run.events.map(event => `  ${event.timestamped ? '' : '[时间未定] '}${event.text}`));
    }
    out.push('[日志信号]');
    for (const section of report.diagnostic_logs) {
      out.push(`${section.label} | ${section.path} | ${section.read_status} | 更新=${section.last_modified_at ?? '未知'}`);
      out.push(...section.events.map(event => `  ${event.timestamped ? '' : '[时间未定] '}${event.text}`));
    }
  }
  out.push(...report.data_quality.warnings.map(warning => `注意：${warning}`));
  out.push(...report.data_quality.errors.map(error => `证据不可用：${error.source_id} (${error.code})`));
  const text = out.map(line => redactDiagnosticsText(line, maxOutputChars)).join('\n');
  const suffix = '\n[输出已达到配置长度限制]';
  const truncated = text.length > maxOutputChars;
  const output = truncated ? text.slice(0, maxOutputChars - suffix.length) + suffix : text;
  return { text: output, truncated, title: `自动化诊断 · ${report.device_id}`, body: output, detail: structuredClone(report) };
}

/** Closed contract gate for retained export evidence; never grants execution authority. */
export function validateAutomationDiagnostics(input) {
  const check = (value, message) => { if (!value) throw new ReportContractError(message); };
  const shape = (value, required, optional = []) => {
    check(value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Unsupported or missing automation diagnostic fields');
  };
  const rowBound = 20_000;
  const rows = (value, maximum = rowBound) => { check(Array.isArray(value) && value.length <= maximum, 'Diagnostic array exceeds contract bound'); return value; };
  const integer = value => check(Number.isSafeInteger(value) && value >= 0, 'Invalid diagnostic count');
  const string = (value, maximum = 1000, empty = true) => check(typeof value === 'string' && value.length <= maximum && (empty || Boolean(value.trim())), 'Invalid bounded diagnostic string');
  const stamp = (value, nullable = false) => {
    if (nullable && value === null) return null;
    check(typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'Invalid diagnostic timestamp'); return Date.parse(value);
  };
  shape(input, ['schema_version', 'authoritativeExecution', 'device_id', 'collected_at', 'window', 'bounds', 'source_limits', 'scripts', 'queues', 'history', 'statuses', 'diagnostic_logs', 'process_snapshot', 'evidence', 'data_quality', 'limitations', 'text', 'text_truncated']);
  check(input.schema_version === 'automation_diagnostics.v1' && input.authoritativeExecution === false, 'Diagnostics cannot claim execution authority');
  string(input.device_id, 256, false); const now = stamp(input.collected_at);
  shape(input.window, ['kind', 'hours', 'start', 'end', 'interval']);
  const start = stamp(input.window.start), end = stamp(input.window.end);
  check(input.window.kind === 'lookback' && input.window.interval === 'left_closed_right_closed' && Number.isFinite(input.window.hours) && input.window.hours >= 1 && input.window.hours <= 8784 && end === now && Math.abs(end - start - input.window.hours * 3_600_000) < 1, 'Rolling diagnostic window mismatch');
  shape(input.bounds, Object.keys(DEFAULT_BOUNDS));
  shape(input.source_limits, ['maxBytes', 'maxTotalBytes', 'maxFiles', 'maxRows', 'maxLineBytes', 'maxMessageChars', 'maxDirectories']);
  for (const value of [...Object.values(input.bounds), ...Object.values(input.source_limits)]) { integer(value); check(value > 0 && value <= 1_000_000_000, 'Invalid retained diagnostic bound'); }
  check(input.bounds.maxTextChars <= 1_000_000 && input.bounds.maxOutputChars >= 128 && input.bounds.maxOutputChars <= 1_000_000 && input.bounds.logMaxBytes <= input.source_limits.maxBytes && input.bounds.historyLogMaxBytes <= input.source_limits.maxBytes, 'Diagnostic bounds exceed retained source limits');
  for (const key of ['maxHistoryRuns', 'maxEventsPerLog', 'maxEventsPerHistory']) check(input.bounds[key] <= input.source_limits.maxRows, 'Diagnostic rows exceed retained source limit');
  const cleanString = (value, empty = true) => { string(value, input.bounds.maxTextChars, empty); check(redactDiagnosticsText(value, input.bounds.maxTextChars) === value, 'Diagnostic string is not redacted/normalized'); };
  const strings = (value, maximum = rowBound) => rows(value, maximum).forEach(item => string(item, 1000));
  const unique = values => check(new Set(values).size === values.length, 'Repeated diagnostic identifiers');
  const scalarState = value => { if (value !== null && typeof value !== 'boolean') cleanString(value); };
  rows(input.scripts, Math.min(rowBound, input.source_limits.maxRows)).forEach(script => {
    shape(script, ['id', 'name', 'type', 'hasConfiguredRoot', 'hasConfiguredLog', 'successMarker', 'errorMarker', 'users']);
    ['id', 'name', 'type', 'successMarker', 'errorMarker'].forEach(key => cleanString(script[key]));
    check(typeof script.hasConfiguredRoot === 'boolean' && typeof script.hasConfiguredLog === 'boolean', 'Invalid script configuration flags');
    rows(script.users, Math.min(rowBound, input.source_limits.maxRows)).forEach(user => {
      shape(user, ['enabled', 'lastProxyAt', 'proxyCount']); scalarState(user.enabled); cleanString(user.lastProxyAt);
      if (typeof user.proxyCount === 'number') integer(user.proxyCount); else cleanString(user.proxyCount);
    });
  });
  rows(input.queues, Math.min(rowBound, input.source_limits.maxRows)).forEach(queue => {
    shape(queue, ['name', 'timedEnabled', 'lastTimedStart', 'schedules']); cleanString(queue.name); scalarState(queue.timedEnabled); cleanString(queue.lastTimedStart);
    rows(queue.schedules, Math.min(rowBound, input.source_limits.maxRows)).forEach(schedule => { shape(schedule, ['time', 'enabled']); cleanString(schedule.time); scalarState(schedule.enabled); });
  });
  shape(input.evidence, ['sources']);
  const sources = new Map(); let readBytes = 0, successfulReads = 0;
  rows(input.evidence.sources).forEach(source => {
    shape(source, ['source_id', 'kind', 'path', 'read_status', 'last_modified_at'], ['bytes', 'original_bytes', 'sha256']);
    cleanString(source.source_id, false); cleanString(source.path, false); stamp(source.last_modified_at, true);
    check(['script_config', 'queue_config', 'history_result', 'history_log', 'diagnostic_log'].includes(source.kind), 'Unknown diagnostic evidence kind');
    check(['ok', 'partial', 'unavailable', 'missing', 'scope', 'read', 'type', 'limit', 'changed', 'encoding', 'json', 'format', 'timezone', 'timestamp', 'path'].includes(source.read_status), 'Unknown diagnostic read status');
    check(!sources.has(source.source_id), 'Repeated diagnostic source ID'); sources.set(source.source_id, source);
    const hasBytes = Object.hasOwn(source, 'bytes');
    check(hasBytes === Object.hasOwn(source, 'original_bytes') && hasBytes === Object.hasOwn(source, 'sha256'), 'Incomplete diagnostic byte provenance');
    if (hasBytes) {
      integer(source.bytes); integer(source.original_bytes); string(source.sha256, 64, false);
      check(/^[a-f\d]{64}$/.test(source.sha256) && source.bytes <= source.original_bytes && source.bytes <= input.source_limits.maxBytes, 'Invalid diagnostic byte provenance'); readBytes += source.bytes; successfulReads++;
    }
    if (['ok', 'partial'].includes(source.read_status)) {
      check(hasBytes && source.last_modified_at !== null && !/^(?:[/\\]|[A-Za-z]:)/.test(source.path) && !source.path.split(/[\\/]/).includes('..'), 'Diagnostic evidence is not a bounded export-relative source');
      check(source.read_status === 'ok' ? source.bytes === source.original_bytes : source.bytes < source.original_bytes, 'Source partial flag disagrees with bytes');
    }
  });
  check(readBytes <= input.source_limits.maxTotalBytes && successfulReads <= input.source_limits.maxFiles, 'Diagnostic provenance exceeds retained cumulative source limits');
  if (input.scripts.length) check(sources.get('configuration.scripts')?.kind === 'script_config' && sources.get('configuration.scripts').read_status === 'ok', 'Scripts lack readable configuration provenance');
  if (input.queues.length) check(sources.get('configuration.queues')?.kind === 'queue_config' && sources.get('configuration.queues').read_status === 'ok', 'Queues lack readable configuration provenance');
  function eventRows(value, maximum) {
    rows(value, maximum).forEach(event => {
      shape(event, ['text', 'at', 'timestamped']); cleanString(event.text, false);
      check(typeof event.timestamped === 'boolean' && event.timestamped === (event.at !== null), 'Event timestamp scope mismatch');
      const time = stamp(event.at, true); if (time !== null) check(time >= start && time <= end, 'Diagnostic event is outside its lookback');
    });
  }
  let previousHistory = -Infinity;
  rows(input.history, Math.min(rowBound, input.bounds.maxHistoryRuns)).forEach(run => {
    shape(run, ['script', 'source', 'at', 'reported_result', 'events', 'repeated_lines_omitted', 'evidence_refs'], ['sanity', 'sanity_full_at', 'drop_statistics', 'recruit_statistics']);
    cleanString(run.script, false); cleanString(run.source, false); cleanString(run.reported_result, false); integer(run.repeated_lines_omitted);
    const time = stamp(run.at); check(time >= start && time <= end && time >= previousHistory, 'History result lies outside window or ordering'); previousHistory = time;
    const refs = rows(run.evidence_refs, 2); check(refs.length === 2, 'History requires explicit result and paired-log provenance');
    const [result, log] = refs.map(ref => sources.get(ref));
    check(result?.kind === 'history_result' && result.read_status === 'ok' && result.path === run.source && stamp(result.last_modified_at) === time && log?.kind === 'history_log', 'History provenance does not match its result/log sources');
    eventRows(run.events, input.bounds.maxEventsPerHistory);
    if (run.events.length) check(['ok', 'partial'].includes(log.read_status), 'History signals lack readable log evidence');
    for (const key of ['sanity', 'sanity_full_at', 'drop_statistics', 'recruit_statistics']) if (Object.hasOwn(run, key)) {
      const value = run[key];
      if (value && typeof value === 'object') { shape(value, [], Object.keys(value)); check(Object.keys(value).length <= 40 && !Object.keys(value).some(name => SECRET_KEY.test(name)), 'Unsupported resource statistic fields'); Object.entries(value).forEach(([name, count]) => { cleanString(name); cleanString(count); }); }
      else cleanString(value);
    }
  });
  rows(input.diagnostic_logs).forEach(log => {
    shape(log, ['label', 'source_id', 'path', 'read_status', 'last_modified_at', 'age_hours', 'events', 'repeated_lines_omitted']);
    ['label', 'source_id', 'path'].forEach(key => cleanString(log[key])); integer(log.repeated_lines_omitted);
    const source = sources.get(log.source_id);
    check(source?.kind === 'diagnostic_log' && source.path === log.path && source.read_status === log.read_status && source.last_modified_at === log.last_modified_at, 'Log section/source provenance mismatch');
    const time = stamp(log.last_modified_at, true); check(log.age_hours === (time === null ? null : Math.max(0, now - time) / 3_600_000), 'Log source age mismatch');
    eventRows(log.events, input.bounds.maxEventsPerLog); if (log.events.length) check(['ok', 'partial'].includes(log.read_status), 'Diagnostic signals lack readable source evidence');
  });
  unique(input.diagnostic_logs.map(log => log.source_id));
  unique(input.history.map(run => run.source));
  check(input.diagnostic_logs.length === [...sources.values()].filter(source => source.kind === 'diagnostic_log').length, 'Diagnostic source/section inventory mismatch');
  const names = [...new Set([...input.scripts.map(script => script.name), ...input.history.map(run => run.script)])];
  const expectedStatuses = names.map(name => {
    const runs = input.history.filter(run => run.script === name), latest = runs.at(-1), failures = runs.filter(run => !isSuccess(run.reported_result)).length;
    return { script: name, run_count: runs.length, status_hint: !latest ? 'not_observed' : isSuccess(latest.reported_result) ? 'latest_reported_success' : 'verify', latest_result: latest?.reported_result ?? null,
      previous_failure_count: latest && isSuccess(latest.reported_result) ? failures : 0, latest_age_hours: latest ? (now - Date.parse(latest.at)) / 3_600_000 : null };
  });
  rows(input.statuses); input.statuses.forEach(status => shape(status, ['script', 'run_count', 'status_hint', 'latest_result', 'previous_failure_count', 'latest_age_hours']));
  check(canonicalJson(input.statuses) === canonicalJson(expectedStatuses), 'Diagnostic status hints differ from retained history');
  shape(input.process_snapshot, ['supplied', 'names', 'note']);
  check(typeof input.process_snapshot.supplied === 'boolean', 'Invalid host process snapshot flag'); string(input.process_snapshot.note, 256, false);
  check(input.process_snapshot.note === (input.process_snapshot.supplied ? 'Host-supplied snapshot only; exited or absent processes do not establish task failure' : 'No host process inventory supplied; process state is unknown'), 'Process snapshot interpretation is not the configured evidence policy');
  if (input.process_snapshot.supplied) { rows(input.process_snapshot.names).forEach(name => { cleanString(name); check(!/[\\/\r\n\x00]/.test(name), 'Process inventory contains a path'); }); unique(input.process_snapshot.names); }
  else check(input.process_snapshot.names === null, 'Unsupplied process inventory is not a measured empty result');
  shape(input.data_quality, ['complete', 'errors', 'warnings', 'truncations']);
  rows(input.data_quality.errors).forEach(error => {
    shape(error, ['source_id', 'code', 'message']); cleanString(error.source_id, false); string(error.code, 64, false); string(error.message, 256, false);
    check(sources.has(error.source_id) || error.source_id === 'history.inventory', 'Diagnostic gap names an unknown source');
  });
  strings(input.data_quality.warnings); strings(input.data_quality.truncations); unique(input.data_quality.truncations); strings(input.limitations, 10);
  check(input.data_quality.complete === (input.data_quality.errors.length === 0 && input.data_quality.truncations.length === 0), 'Diagnostic completeness hides source errors or bounds');
  const allowedWarnings = ['Script configuration was not supplied', 'Queue configuration was not supplied', 'Untimed signals are retained as unscoped diagnostic context, never proof of in-window task completion', 'Configured bounds limited the evidence; earlier events or runs may be absent'];
  check(input.data_quality.warnings.every(warning => allowedWarnings.includes(warning)), 'Unsupported diagnostic interpretation');
  const expectedWarnings = [];
  if (!sources.has('configuration.scripts')) expectedWarnings.push(allowedWarnings[0]);
  if (!sources.has('configuration.queues')) expectedWarnings.push(allowedWarnings[1]);
  if (input.history.some(run => run.events.some(event => !event.timestamped)) || input.diagnostic_logs.some(log => log.events.some(event => !event.timestamped))) expectedWarnings.push(allowedWarnings[2]);
  if (input.data_quality.truncations.length) expectedWarnings.push(allowedWarnings[3]);
  check(canonicalJson(input.data_quality.warnings) === canonicalJson(expectedWarnings), 'Diagnostic warnings differ from retained scope/gaps');
  check(canonicalJson(input.limitations) === canonicalJson(['Exported history result and mtime are evidence only, not authoritative task execution', 'No root discovery, live process enumeration, OS scan or network query', 'A rolling lookback differs from the strict calendar GameDaily report']), 'Diagnostic limitations cannot be removed or replaced');
  for (const source of sources.values()) {
    if (source.read_status === 'partial') check(input.data_quality.truncations.includes(source.source_id), 'Partial source must be disclosed');
    else if (source.read_status !== 'ok') check(input.data_quality.errors.some(error => error.source_id === source.source_id && error.code === source.read_status), 'Unavailable source must have a diagnostic gap');
  }
  string(input.text, input.bounds.maxOutputChars, false); check(typeof input.text_truncated === 'boolean', 'Invalid text truncation flag');
  const rendered = renderAutomationDiagnostics(input, { maxOutputChars: input.bounds.maxOutputChars });
  check(rendered.text === input.text && rendered.truncated === input.text_truncated, 'Diagnostic text differs from deterministic retained evidence');
  check(Buffer.byteLength(canonicalJson(input)) <= 16 * 1024 * 1024, 'Diagnostic report exceeds artifact bound');
  return structuredClone(input);
}
