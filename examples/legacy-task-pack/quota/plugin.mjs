// SPDX-License-Identifier: MIT
// Optional native Cordis plugin. No model/tools, direct sends, or standalone process.
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { isAbsolute } from 'node:path';
import { createQuotaProviders, mountQuotaMonitor } from './monitor.mjs';
import { openQuotaStore } from './store.mjs';
import { QuotaError } from './providers.mjs';

export const name = 'dsh-provider-quota-monitor';
export const inject = ['taskSystem'];
export const Config = z.object({
  enabled: z.boolean().default(false),
  storePath: z.string().default(''),
  timezone: z.string().default('Asia/Shanghai'),
  providers: z.array(z.union([z.const('deepseek'), z.const('aliyun')])).default([]),
  localOnly: z.boolean().default(false),
  deepseekApiKeyEnv: z.string().default(''),
  alibabaAccessKeyIdEnv: z.string().default(''),
  alibabaAccessKeySecretEnv: z.string().default(''),
  alibabaSecurityTokenEnv: z.string().default(''),
  ecsMetadata: z.boolean().default(false),
  timeoutMs: z.number().min(1).max(60000).step(1).default(12000),
  maxBytes: z.number().min(1).max(1048576).step(1).default(262144),
  attemptTimeoutMs: z.number().min(1).max(60000).step(1).default(60000),
  maxLatenessMs: z.number().min(1).max(3600000).step(1).default(1200000),
  retryDelaysMs: z.array(z.number().min(1).max(300000).step(1)).default([30000, 60000]),
  pollIntervalMs: z.number().min(10).max(60000).step(1).default(1000),
});
const insist = value => { if (!value) throw new QuotaError('configuration'); };
const envName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
const boundaryKey = (provider, boundaryAt) => {
  insist(['deepseek', 'aliyun'].includes(provider) && typeof boundaryAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(boundaryAt) && Number.isFinite(Date.parse(boundaryAt)));
  return `quota:${provider}:${boundaryAt}`;
};
class QuotaMonitorService extends Service {
  constructor(ctx, { enabled, localOnly }) { super(ctx, 'quotaMonitor'); this.enabled = enabled; this.localOnly = localOnly; this.lastFailure = null; this.lastError = null; this.tick = async () => ({ status: 'disabled', providers: [], output: '' }); }
}

/** Dependency injection for offline native lifecycle tests; production Config never accepts callbacks or credentials. */
export function createQuotaPlugin({ readEnvironment = variable => process.env[variable], transport, now, setTimer, clearTimer } = {}) {
  return { name, inject, Config, apply(ctx, input) {
    const config = Config(input ?? {});
    if (!config.enabled) { new QuotaMonitorService(ctx, { enabled: false, localOnly: config.localOnly }); return; }
    const taskSystem = ctx.taskSystem, ledger = taskSystem?.ledger;
    insist(ledger && ['planner', 'executor', 'both'].includes(ledger.role));
    if (ledger.role === 'executor' && !config.localOnly) throw new Error('Quota alerts require planner authority; executor hosts must explicitly choose localOnly:true');
    insist(isAbsolute(config.storePath) && config.providers.length > 0 && new Set(config.providers).size === config.providers.length && config.retryDelaysMs.length <= 4);
    if (config.providers.includes('deepseek')) insist(envName(config.deepseekApiKeyEnv));
    if (config.providers.includes('aliyun')) {
      const explicitKeys = Boolean(config.alibabaAccessKeyIdEnv || config.alibabaAccessKeySecretEnv || config.alibabaSecurityTokenEnv);
      // Metadata and explicit key credentials are two deliberate, non-fallback modes.
      insist(config.ecsMetadata ? !explicitKeys : envName(config.alibabaAccessKeyIdEnv) && envName(config.alibabaAccessKeySecretEnv) && (!config.alibabaSecurityTokenEnv || envName(config.alibabaSecurityTokenEnv)));
    } else insist(!config.ecsMetadata);
    const service = new QuotaMonitorService(ctx, config);
    ctx.effect(() => {
      const store = openQuotaStore({ directory: config.storePath, timezone: config.timezone }); let monitor, cleanupPromise;
      const dispose = () => cleanupPromise ??= (async () => { try { await monitor?.dispose(); } finally { store.close(); } })();
      let removeDrain;
      try {
        const providers = createQuotaProviders({ enabled: true, providers: config.providers, timeoutMs: config.timeoutMs, maxBytes: config.maxBytes, ecsMetadata: config.ecsMetadata,
          ...(transport ? { transport } : {}),
          credentials: async provider => {
            if (provider === 'deepseek') return { apiKey: readEnvironment(config.deepseekApiKeyEnv) };
            if (config.ecsMetadata) return undefined;
            return { accessKeyId: readEnvironment(config.alibabaAccessKeyIdEnv), accessKeySecret: readEnvironment(config.alibabaAccessKeySecretEnv), ...(config.alibabaSecurityTokenEnv ? { securityToken: readEnvironment(config.alibabaSecurityTokenEnv) } : {}) };
          },
        });
        monitor = mountQuotaMonitor({ enabled: true, store, providers, timezone: config.timezone, retryDelaysMs: config.retryDelaysMs, maxLatenessMs: config.maxLatenessMs, attemptTimeoutMs: config.attemptTimeoutMs, pollIntervalMs: config.pollIntervalMs,
          ...(now ? { now } : {}), ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}),
          onError: error => { service.lastError = error; },
          onFailure: event => {
            const failures = event.providers.filter(provider => ['error', 'pending'].includes(provider.status));
            service.lastFailure = { boundaryAt: event.boundaryAt, providers: failures.map(provider => ({ provider: provider.provider, status: provider.status, attempt: provider.attempt, code: provider.error?.code ?? 'unknown_outcome' })) };
            // Keep the delivery marker unset: later explicit planner mounting
            // may publish this known failed boundary to its own alert ledger.
            if (config.localOnly) return false;
            for (const failure of failures) {
              const dedupeKey = boundaryKey(failure.provider, event.boundaryAt);
              const code = failure.status === 'pending' ? 'unknown_outcome' : ['disabled', 'credentials', 'configuration', 'timeout', 'cancelled', 'network', 'http', 'limit', 'response'].includes(failure.error?.code) ? failure.error.code : 'response';
              ledger.raiseAlert(`${dedupeKey}:failed:${failure.attempt}`, { dedupeKey, title: `${failure.provider} quota snapshot unavailable`, body: `The configured read-only quota collector could not establish the ${event.boundaryAt} boundary. Status: ${code}. Attempts: ${failure.attempt}. No task-spend inference is available.`, severity: 'warning' });
            }
          },
          onSuccess: event => {
            if (config.localOnly) return;
            const dedupeKey = boundaryKey(event.provider, event.boundaryAt);
            const alert = ledger.alerts().find(alert => alert.dedupeKey === dedupeKey);
            if (alert) ledger.setAlertState(`${dedupeKey}:recovered:${alert.revision}`, { alertId: alert.alertId, expectedRevision: alert.revision, state: 'resolved', actor: 'quota-monitor', reason: 'A successful persisted snapshot now establishes this same boundary' });
          },
        });
        service.tick = monitor.tick;
        // The task authority drains this collector before closing its ledger,
        // even if host plugin disposal order differs from mounting order.
        removeDrain = taskSystem.addDrain?.(dispose);
      } catch (error) { store.close(); throw error; }
      return async () => { try { await dispose(); } finally { removeDrain?.(); } };
    });
  } };
}
export const apply = createQuotaPlugin().apply;
