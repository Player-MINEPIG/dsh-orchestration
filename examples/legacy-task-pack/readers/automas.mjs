// SPDX-License-Identifier: MIT
// Explicit-root AUTO-MAS compatibility composition. No installed-app discovery.
import { join } from 'node:path';
import { SourceError, assertRows, normalizeWindow, parseTime, inWindow, decodeText, completeTailLines } from './common.mjs';
import { calendarWindow, dateInZone } from './time.mjs';
import { parseLogLines, readGameDaily } from './game.mjs';
import { hsrRules, oneDragonRules, maaRules } from './presets.mjs';

/** Data-only defaults matching the three original producer adapters. Override every ID/rule. */
export function autoMasDefinitions({ manualAnnihilationDue = false } = {}) {
  return [
    { id: 'hsr_march7thassistant', engine: 'March7thAssistant', game: '崩坏：星穹铁道', historyKinds: ['hsr'], scriptMarkers: ['march7'], ...hsrRules() },
    { id: 'zzz_onedragon', engine: 'ZenlessZoneZero-OneDragon', game: '绝区零', instance: '01', historyKinds: ['zzz'], scriptMarkers: ['onedragon', '绝区零'], ...oneDragonRules() },
    { id: 'arknights_maa', engine: 'MAA', game: '明日方舟', instance: 'single', historyKinds: ['maa_annihilation', 'maa_routine'], scriptTypes: ['maaconfig'],
      ...maaRules({ manualAnnihilationDue, routineKind: 'maa_routine', annihilationKind: 'maa_annihilation' }) },
  ];
}

const defaultClassifiers = [
  { kind: 'maa_annihilation', anyResultKeys: ['maa_result'], anyText: ['taskqueueviewmodel', 'maaassistantarknights'], requireAnyText: ['剿灭作战', 'selected annihilation', '"annihilation"'] },
  { kind: 'maa_routine', anyResultKeys: ['maa_result'], anyText: ['taskqueueviewmodel', 'maaassistantarknights'] },
  { kind: 'hsr', anyText: ['starrail', '每日实训', '开拓力', 'march7th'] },
  { kind: 'zzz', anyText: ['一条龙', 'one_dragon', 'zenless', '绝区零'] },
];
function classify(result, text, classifiers) {
  const lower = text.toLowerCase();
  return classifiers.find(rule => (!rule.requireAnyText || rule.requireAnyText.some(marker => lower.includes(marker.toLowerCase()))) &&
    ((rule.anyResultKeys ?? []).some(key => Object.hasOwn(result, key)) || (rule.anyText ?? []).some(marker => lower.includes(marker.toLowerCase()))))?.kind;
}
function accountLabels(scriptConfig, definitions) {
  const accounts = new Map();
  for (const item of scriptConfig.instances ?? []) {
    const entry = scriptConfig[String(item.uid)] ?? {}, info = entry.Info ?? {};
    const sourceName = `${info.Name ?? item.type ?? ''} ${info.Path ?? info.RootPath ?? ''}`.toLowerCase().replaceAll('-', '');
    const definition = definitions.find(def => (def.scriptTypes ?? []).includes(String(item.type ?? '').toLowerCase()) || (def.scriptMarkers ?? []).some(marker => sourceName.includes(marker.toLowerCase().replaceAll('-', ''))));
    if (!definition) continue;
    const users = entry.SubConfigsInfo?.UserData ?? {};
    const user = (users.instances ?? []).map(item => users[String(item.uid)]?.Info).find(info => info && Boolean(info.Status ?? true));
    if (user?.Name) accounts.set(definition.id, String(user.Name));
  }
  return accounts;
}
function queueSettings(config) {
  const item = config.instances?.[0], info = item ? config[String(item.uid)]?.Info : null;
  return info ? { name: String(info.Name ?? 'AUTO-MAS queue'), expectedToRun: Boolean(info.TimeEnabled) } : {};
}

/** Explicit paths replace the original machine-specific app/history/config defaults. */
export async function readAutoMasDaily({ scope, window: inputWindow, reportMeta, historyRoot, historyFiles,
  appLog, frontendLog, scriptConfigFile, queueConfigFile, engineLogFiles = {}, screenshots = [], screenshotDirectories = [],
  automations = autoMasDefinitions(), classifiers = defaultClassifiers, encoding = 'auto', scheduler = {}, allowMtimeFallback = true,
  historyLogMaxBytes = scope?.limits.maxBytes, historyReadMode = 'full' } = {}) {
  const window = normalizeWindow(inputWindow ?? calendarWindow({ businessDate: reportMeta?.business_date, timeZone: reportMeta?.report_timezone, now: reportMeta?.collected_at }));
  if (Boolean(historyRoot) === Boolean(historyFiles)) throw new SourceError('config', 'Supply exactly one explicit historyRoot or historyFiles inventory');
  assertRows(automations, scope, 'automations'); assertRows(classifiers, scope, 'classifiers');
  const additionalSources = [], errors = [], extraMissing = [];
  async function config(path, source_id) {
    if (!path) return {};
    additionalSources.push({ source_id, kind: 'configuration', path, encoding });
    try { return await scope.json(path, { encoding }); } catch (error) { errors.push(`${source_id}: ${error.message}`); return {}; }
  }
  const scripts = await config(scriptConfigFile, 'automas.script_config'), queues = await config(queueConfigFile, 'automas.queue_config');
  const accounts = accountLabels(scripts, automations);
  let inventory = historyFiles ? assertRows(historyFiles, scope, 'historyFiles').map(path => typeof path === 'string' ? { resultFile: path } : path) : [];
  if (historyRoot) {
    let date = dateInZone(Date.parse(window.start), reportMeta.source_timezone);
    const endDate = dateInZone(Date.parse(window.end) - 1, reportMeta.source_timezone);
    let days = 0;
    while (date <= endDate) {
      if (++days > scope.limits.maxDirectories) throw new SourceError('limit', 'History dates exceed configured traversal bound');
      try { inventory.push(...(await scope.list(join(historyRoot, date), { recursive: true, extensions: ['.json'] })).map(resultFile => ({ resultFile, fallbackDate: date }))); }
      catch (error) { if (error.code !== 'missing') throw error; }
      date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    }
  }
  assertRows(inventory, scope, 'discovered history');
  const byKind = new Map();
  for (const [index, entry] of inventory.entries()) {
    try {
      const result = await scope.json(entry.resultFile, { encoding: entry.encoding ?? encoding });
      const logFile = entry.logFile ?? entry.resultFile.replace(/\.json$/i, '.log');
      const rawBytes = await scope.read(logFile, { optional: true, maxBytes: entry.maxBytes ?? historyLogMaxBytes, tail: (entry.readMode ?? historyReadMode) === 'tail' });
      const bytes = rawBytes && scope.evidence.at(-1)?.read_status === 'partial' ? completeTailLines(rawBytes, entry.encoding ?? encoding) : rawBytes;
      const text = bytes ? decodeText(bytes, entry.encoding ?? encoding) : '';
      const kind = entry.kind ?? classify(result, text, classifiers);
      if (!kind) { errors.push(`History item ${index + 1} has no configured classifier; supply kind or a matching rule.`); continue; }
      const fallbackDate = entry.fallbackDate ?? entry.resultFile.match(/(?:^|[/\\])(20\d{2}-\d{2}-\d{2})(?:[/\\]|$)/)?.[1] ?? window.date;
      const rawLines = bytes ? parseLogLines(bytes, { sourceTimezone: reportMeta.source_timezone, sourceUtcOffset: entry.sourceUtcOffset,
        disambiguation: entry.disambiguation, fallbackDate, limits: scope.limits, encoding: entry.encoding ?? encoding }) : [];
      const stamps = rawLines.filter(line => line.time !== null).map(line => line.time);
      const fallback = allowMtimeFallback ? parseTime((await scope.metadata(entry.resultFile)).last_modified_at) : null;
      const started = parseTime(entry.startedAt) ?? stamps[0] ?? fallback, ended = parseTime(entry.endedAt) ?? stamps.at(-1) ?? started;
      if (started === null || ended === null) { errors.push(`History item ${index + 1} lacks supported time evidence.`); continue; }
      if (ended < Date.parse(window.start) || started >= Date.parse(window.end)) continue;
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push({ ...entry, kind, resultFile: entry.resultFile, logFile, fallbackDate, encoding: entry.encoding ?? encoding,
        maxBytes: entry.maxBytes ?? historyLogMaxBytes, readMode: entry.readMode ?? historyReadMode,
        startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), engineLogFile: entry.engineLogFile ?? engineLogFiles[kind] ?? engineLogFiles.default });
    } catch (error) { errors.push(`History item ${index + 1}: ${error.message}`); extraMissing.push(`history.item${index + 1}`); }
  }
  const imageInputs = [...screenshots];
  for (const [directoryIndex, directory] of assertRows(screenshotDirectories, scope, 'screenshotDirectories').entries()) {
    try {
      const files = await scope.list(directory.path, { recursive: directory.recursive === true, extensions: ['.png', '.jpg', '.jpeg', '.webp', '.PNG', '.JPG'] });
      for (const [index, path] of files.entries()) {
        const metadata = await scope.metadata(path);
        if (directory.filterByWindow !== false && !inWindow(parseTime(metadata.last_modified_at), window)) continue;
        imageInputs.push({ screenshot_id: `screenshot.directory${directoryIndex + 1}.${index + 1}`, path, automation_id: directory.automation_id, description: directory.description ?? 'Screenshot from an explicitly configured export directory' });
      }
    } catch (error) { errors.push(`Screenshot directory ${directoryIndex + 1}: ${error.message}`); extraMissing.push(`screenshot.directory${directoryIndex + 1}`); }
  }
  const report = await readGameDaily({ scope, window, reportMeta, scheduler: { ...queueSettings(queues), appLog, frontendLog, expectedItems: automations.length, encoding, ...scheduler },
    automations: automations.map(def => ({ ...def, account: def.account ?? accounts.get(def.id) ?? 'unknown', runs: (def.historyKinds ?? [def.id]).flatMap(kind => byKind.get(kind) ?? []) })),
    screenshots: imageInputs, additionalSources });
  report.evidence.missing_sources.push(...extraMissing);
  if (errors.length) report.analysis_notes.push(`Inventory reading is partial: ${errors.slice(0, 2).join('; ')}`.slice(0, 240));
  return report;
}
