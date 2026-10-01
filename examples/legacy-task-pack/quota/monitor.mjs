// SPDX-License-Identifier: MIT
import { calendarWindow } from '../readers/time.mjs';
import { summarizeQuotaBoundaries } from '../reporting.mjs';
import { collectAlibaba, collectDeepSeek, createDirectHttpTransport, QuotaError, readEcsRoleCredentials, safeFailure } from './providers.mjs';

const requireValue = value => { if (!value) throw new QuotaError('configuration'); };
/** Credentials are provided explicitly by the operator's host. No env files, credential discovery, or model calls. */
export function createQuotaProviders({ enabled = false, providers = [], credentials, transport = createDirectHttpTransport(), timeoutMs = 12000, maxBytes = 262144, ecsMetadata = false } = {}) {
  if (!enabled) return [];
  requireValue(Array.isArray(providers) && providers.length > 0 && new Set(providers).size === providers.length && providers.every(provider => ['deepseek', 'aliyun'].includes(provider)) && typeof credentials === 'function');
  return providers.map(provider => ({ id: provider, async collect({ signal }) {
    let auth; try { auth = await credentials(provider); } catch { throw new QuotaError('credentials'); }
    if (provider === 'deepseek') return collectDeepSeek({ enabled: true, apiKey: auth?.apiKey, transport, timeoutMs, maxBytes, signal });
    if (!auth && ecsMetadata === true) auth = await readEcsRoleCredentials({ enabled: true, transport, timeoutMs: Math.min(timeoutMs, 5000), maxBytes, signal });
    return collectAlibaba({ enabled: true, credentials: auth, transport, timeoutMs, maxBytes, signal });
  } }));
}
/** Host invokes tick or mounts the timer. Only known failed reads retry; pending/crashed reads remain explicit. */
export function createQuotaMonitor({ enabled = false, store, providers = [], timezone = 'Asia/Shanghai', retryDelaysMs = [30000, 60000], maxLatenessMs = 1200000, attemptTimeoutMs = 60000, now = () => new Date(), onFailure = () => {}, onSuccess = () => {} } = {}) {
  requireValue(Array.isArray(retryDelaysMs) && retryDelaysMs.length <= 4 && retryDelaysMs.every(delay => Number.isInteger(delay) && delay >= 1 && delay <= 300000));
  requireValue(Number.isInteger(maxLatenessMs) && maxLatenessMs >= 1 && maxLatenessMs <= 3600000 && Number.isInteger(attemptTimeoutMs) && attemptTimeoutMs > 0 && attemptTimeoutMs <= 60000);
  requireValue(Array.isArray(providers) && new Set(providers.map(provider => provider.id)).size === providers.length && providers.every(provider => ['deepseek', 'aliyun'].includes(provider.id) && typeof provider.collect === 'function'));
  if (enabled) requireValue(store && providers.length > 0);
  calendarWindow({ timeZone: timezone, now: new Date(now()).toISOString() });
  let running = null, disposed = false, current; const successNotified = new Map();
  async function notifySuccess(provider, boundaryAt, collectionId) { if (successNotified.get(provider) === boundaryAt) return; await onSuccess({ provider, boundaryAt, collectionId }); successNotified.set(provider, boundaryAt); }
  async function run() {
    if (!enabled || disposed) return { status: 'disabled', providers: [], output: '' };
    const instant = new Date(now()); requireValue(Number.isFinite(instant.getTime())); const window = calendarWindow({ timeZone: timezone, now: instant.toISOString() });
    const boundaryAt = window.start; const age = instant.getTime() - Date.parse(boundaryAt);
    if (age > maxLatenessMs) return { status: 'outside_window', boundaryAt, nextBoundary: window.end, providers: [], output: '' };
    const results = [];
    for (const provider of providers) {
      let row = store.latest(provider.id, boundaryAt);
      if (row?.status === 'ok' || row?.status === 'pending') { if (row.status === 'ok') await notifySuccess(provider.id, boundaryAt, row.collection_id); results.push({ provider: provider.id, status: row.status, attempt: row.attempt }); continue; }
      if (row?.status === 'error' && (!row.error.retryable || row.attempt > retryDelaysMs.length)) { results.push({ provider: provider.id, status: 'error', attempt: row.attempt, error: row.error }); continue; }
      const dueAt = row ? Date.parse(row.completed_at ?? row.observed_at) + retryDelaysMs[row.attempt - 1] : Date.parse(boundaryAt);
      if (instant.getTime() < dueAt) { results.push({ provider: provider.id, status: 'retry_wait', attempt: row.attempt, dueAt: new Date(dueAt).toISOString() }); continue; }
      const attempt = (row?.attempt ?? 0) + 1;
      const collectionId = store.begin({ provider: provider.id, boundaryAt, observedAt: instant.toISOString(), attempt });
      current = new AbortController(); const controller = current; let timer;
      let outcome;
      try {
        const timeout = new Promise((_, reject) => { controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); timer = setTimeout(() => controller.abort(new QuotaError('timeout', { retryable: true })), attemptTimeoutMs); });
        const result = await Promise.race([provider.collect({ signal: current.signal }), timeout]);
        requireValue(result?.provider === provider.id); outcome = { status: 'ok', metrics: result.metrics };
      } catch (error) { outcome = { status: 'error', error }; }
      finally { clearTimeout(timer); current = undefined; }
      // A persistence failure is not a provider failure and must never trigger an uncertain repeat read.
      const record = store.finish(collectionId, { ...outcome, completedAt: new Date(now()).toISOString() });
      if (record.status === 'ok') await notifySuccess(provider.id, boundaryAt, collectionId);
      results.push({ provider: provider.id, status: record.status === 'error' && record.error.retryable && attempt <= retryDelaysMs.length ? 'retry_wait' : record.status, attempt, ...(record.error ? { error: record.error } : {}) });
      if (disposed) break;
    }
    const allOk = results.length === providers.length && results.every(result => result.status === 'ok');
    const settled = results.length === providers.length && results.every(result => ['ok', 'error', 'pending'].includes(result.status));
    const result = { schema_version: 'quota_collection_result.v1', status: allOk ? 'ok' : settled ? 'failed' : 'retry_wait', boundaryAt, nextBoundary: window.end, providers: results, output: '' };
    if (settled && !allOk) {
      const failed = providers.map(provider => store.latest(provider.id, boundaryAt)).filter(row => row && ['error', 'pending'].includes(row.status));
      result.output = JSON.stringify({ schema_version: 'quota_collection_failure.v1', success: false, boundaryAt, providers: results });
      if (failed.some(row => !row.failure_reported) && await onFailure(JSON.parse(result.output)) !== false) for (const row of failed) store.markFailureReported(row.collection_id);
    }
    return result;
  }
  const tick = () => running ?? (running = run().finally(() => { running = null; }));
  return { tick, async dispose() { disposed = true; current?.abort(new QuotaError('cancelled')); await running; } };
}
/** Optional host-lifecycle timer, never a standalone daemon or external scheduler. */
export function mountQuotaMonitor(options = {}) {
  const { enabled = false, pollIntervalMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {}, ...config } = options;
  requireValue(Number.isInteger(pollIntervalMs) && pollIntervalMs >= 10 && pollIntervalMs <= 60000);
  const monitor = createQuotaMonitor({ ...config, enabled }); let stopped = !enabled, timer;
  const arm = () => { if (stopped) return; timer = setTimer(async () => { try { await monitor.tick(); } catch (error) { onError(safeFailure(error)); } finally { arm(); } }, pollIntervalMs); timer?.unref?.(); };
  arm(); return { tick: monitor.tick, async dispose() { stopped = true; clearTimer(timer); await monitor.dispose(); } };
}
export function summarizeQuotaDay(store, { date, timezone = 'Asia/Shanghai', toleranceMinutes = 20 } = {}) {
  const window = calendarWindow({ businessDate: date, timeZone: timezone });
  return { schema_version: 'quota_summary.v1', window, quota_changes: summarizeQuotaBoundaries(store.samples(), { windowStart: window.start, windowEnd: window.end, toleranceMinutes }), notes: ['Net account-balance movements only; no per-task or gross-spend inference.'] };
}
