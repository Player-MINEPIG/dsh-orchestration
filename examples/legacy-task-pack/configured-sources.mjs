import { resolve } from 'node:path';
import { createSourceScope, readCodexDaily, readHermesDaily, readGameDaily, readAutoMasDaily } from './readers/index.mjs';
import { readQuotaSnapshots } from './quota/index.mjs';
import { readAutomationDiagnostics } from './diagnostics/index.mjs';
import { canonicalJson, ReportContractError } from './reporting.mjs';
import { readGameCollector } from './readers/collector.mjs';

/** Registry entries are operator configuration. A caller supplies IDs, never paths/SQL/code. */
export async function readConfiguredSources({ registry, authorizedIds, sourceIds = authorizedIds, input, nodeId, timeZone = 'Asia/Shanghai', maxOutputBytes = 1024 * 1024, signal }) {
  signal?.throwIfAborted();
  const entries = new Map(registry.map(entry => [entry.id, entry]));
  if (entries.size !== registry.length) throw new ReportContractError('Repeated configured source ID');
  if (!Array.isArray(authorizedIds) || !authorizedIds.length || !Array.isArray(sourceIds) || !sourceIds.length || sourceIds.some(id => !authorizedIds.includes(id) || !entries.has(id))) throw new ReportContractError('Source ID is outside this task input/configured registry');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16 * 1024 * 1024) throw new ReportContractError('Invalid source output bound');
  const zone = input.timeZone ?? timeZone; const start = Date.parse(input.windowStart); const end = Date.parse(input.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new ReportContractError('Invalid current task report window');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(start)).map(p => [p.type, p.value]));
  const window = { date: `${parts.year}-${parts.month}-${parts.day}`, timezone: zone, start: input.windowStart, end: input.windowEnd };
  const sources = [];
  for (const sourceId of sourceIds) {
    signal?.throwIfAborted(); const entry = entries.get(sourceId); const scope = await createSourceScope(resolve(entry.root)); const manifest = await scope.json(entry.manifest);
    const data = {};
    if (manifest.gameCollector) {
      if (manifest.game || manifest.automas) throw new ReportContractError('Choose one game source reader');
      data.game = await readGameCollector({ config: manifest.gameCollector, window, nodeId, maxOutputBytes, signal });
    }
    if (manifest.codex) data.codex = await readCodexDaily({ ...manifest.codex, scope, window });
    if (manifest.hermes) data.hermes = await readHermesDaily({ ...manifest.hermes, scope, window });
    if (manifest.quota) data.quota = await readQuotaSnapshots({ ...manifest.quota, scope, window });
    if (manifest.diagnostics) {
      const { processInventoryFile, ...diagnostics } = manifest.diagnostics;
      const processInventory = processInventoryFile ? await scope.json(processInventoryFile) : diagnostics.processInventory;
      data.diagnostics = await readAutomationDiagnostics({ ...diagnostics, scope, processInventory, deviceId: nodeId ?? diagnostics.deviceId, collectedAt: input.windowEnd });
    }
    const gameMeta = config => ({ ...config, reportMeta: { ...config.reportMeta, business_date: window.date, report_timezone: zone, collected_at: new Date().toISOString() } });
    if (manifest.game) data.game = await readGameDaily({ ...gameMeta(manifest.game), scope, window });
    if (manifest.automas) data.game = await readAutoMasDaily({ ...gameMeta(manifest.automas), scope, window });
    if (!Object.keys(data).length) throw new ReportContractError(`Source ${sourceId} has no supported reader`);
    signal?.throwIfAborted(); sources.push({ sourceId, data });
  }
  const bundle = { schema_version: 'legacy_source_bundle.v1', window, sources };
  if (Buffer.byteLength(canonicalJson(bundle)) > maxOutputBytes) throw new ReportContractError('SOURCE_OUTPUT_TOO_LARGE: full evidence exceeds configured bound; no truncated success returned');
  return bundle;
}
