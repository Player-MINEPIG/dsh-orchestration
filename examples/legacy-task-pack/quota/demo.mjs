// SPDX-License-Identifier: MIT
// Runnable entirely offline: no ambient env, credentials, model calls, or network.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuotaProviders, createQuotaMonitor, openQuotaStore, summarizeQuotaDay } from './index.mjs';
import { deepSeekFixture, alibabaFixture, jsonResponse } from './synthetic-fixtures.mjs';
const directory = await mkdtemp(join(tmpdir(), 'dsh-quota-offline-demo-'));
const store = openQuotaStore({ directory }); let instant = new Date('2026-09-30T16:00:00Z');
try {
  const providers = createQuotaProviders({ enabled: true, providers: ['deepseek', 'aliyun'], credentials: async provider => provider === 'deepseek' ? { apiKey: 'synthetic-only' } : { accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret' }, transport: async request => jsonResponse(request.url.startsWith('https://api.deepseek.com/') ? deepSeekFixture : alibabaFixture) });
  const monitor = createQuotaMonitor({ enabled: true, store, providers, now: () => instant });
  await monitor.tick(); instant = new Date('2026-10-01T16:00:00Z'); await monitor.tick();
  process.stdout.write(`${JSON.stringify({ fixture: 'synthetic-only', ...summarizeQuotaDay(store, { date: '2026-10-01' }) }, null, 2)}\n`);
  await monitor.dispose();
} finally { store.close(); await rm(directory, { recursive: true, force: true }); }
