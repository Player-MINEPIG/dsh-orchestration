// SPDX-License-Identifier: MIT
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, realpathSync, openSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dateInZone } from '../readers/time.mjs';
import { QuotaError, safeFailure } from './providers.mjs';

const SPECS = Object.freeze({ deepseek: { source: 'deepseek.user.balance', metrics: ['balance.total', 'balance.granted', 'balance.topped_up'] }, aliyun: { source: 'aliyun.bss.QueryAccountBalance', metrics: ['account.available', 'account.cash', 'account.credit'] } });
const requireValue = value => { if (!value) throw new QuotaError('configuration'); };
const time = value => { requireValue(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))); return new Date(value).toISOString(); };
function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); const info = lstatSync(directory);
  requireValue(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && realpathSync(directory) === directory);
}
function validMetrics(provider, input) {
  requireValue(Array.isArray(input) && input.length > 0 && input.length <= 96);
  const rows = input.map(item => { requireValue(item && SPECS[provider].metrics.includes(item.metric) && typeof item.value === 'string' && item.value.length <= 128 && /^-?\d+(?:\.\d+)?$/.test(item.value) && /^[A-Z]{3}$/.test(item.unit) && item.dimension === item.unit); return { metric: item.metric, dimension: item.unit, unit: item.unit, value: item.value }; });
  requireValue(new Set(rows.map(item => `${item.metric}:${item.dimension}`)).size === rows.length); return rows;
}
/** A private local metric index, not a task ledger. No tasks, model runs, credentials, or raw response bodies. */
export function openQuotaStore({ directory, timezone = 'Asia/Shanghai', maxSamples = 20000 } = {}) {
  requireValue(typeof directory === 'string' && isAbsolute(directory) && Number.isInteger(maxSamples) && maxSamples > 0 && maxSamples <= 100000);
  directory = resolve(directory); dateInZone(Date.now(), timezone); privateDirectory(directory);
  const path = join(directory, 'quota_snapshots.sqlite');
  try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); } catch (error) { if (error.code !== 'EEXIST') throw new QuotaError('configuration'); }
  const info = lstatSync(path); requireValue(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && realpathSync(path) === path);
  const db = new DatabaseSync(path, { enableExtensions: false });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS quota_collections (collection_id TEXT PRIMARY KEY, provider TEXT NOT NULL, boundary_at TEXT NOT NULL, observed_at TEXT NOT NULL, completed_at TEXT, attempt INTEGER NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, error_json TEXT, failure_reported INTEGER NOT NULL DEFAULT 0, UNIQUE(provider,boundary_at,attempt));
    CREATE TABLE IF NOT EXISTS quota_metrics (collection_id TEXT NOT NULL REFERENCES quota_collections(collection_id), provider TEXT NOT NULL, metric TEXT NOT NULL, dimension TEXT NOT NULL, unit TEXT NOT NULL, value_text TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(collection_id,metric,dimension));
    CREATE INDEX IF NOT EXISTS quota_metric_time ON quota_metrics(provider,metric,dimension,observed_at);`);
  const unpack = row => row ? { ...row, error: row.error_json ? JSON.parse(row.error_json) : null } : null;
  function latest(provider, boundaryAt) { requireValue(Object.hasOwn(SPECS, provider)); return unpack(db.prepare('SELECT * FROM quota_collections WHERE provider=? AND boundary_at=? ORDER BY attempt DESC LIMIT 1').get(provider, time(boundaryAt))); }
  function begin({ provider, boundaryAt, observedAt, attempt }) {
    requireValue(Object.hasOwn(SPECS, provider) && Number.isInteger(attempt) && attempt >= 1 && attempt <= 5);
    const collectionId = `quota_${randomUUID()}`;
    db.prepare('INSERT INTO quota_collections(collection_id,provider,boundary_at,observed_at,attempt,status,source) VALUES (?,?,?,?,?,?,?)').run(collectionId, provider, time(boundaryAt), time(observedAt), attempt, 'pending', SPECS[provider].source);
    return collectionId;
  }
  function finish(collectionId, outcome) {
    const row = db.prepare('SELECT * FROM quota_collections WHERE collection_id=?').get(collectionId); requireValue(row?.status === 'pending');
    const success = outcome?.status === 'ok'; requireValue(success || outcome?.status === 'error');
    const metrics = success ? validMetrics(row.provider, outcome.metrics) : [];
    const error = success ? null : safeFailure(outcome.error);
    const completedAt = time(outcome.completedAt ?? new Date().toISOString());
    const record = { schema_version: 'quota_snapshot.v1', collection_id: row.collection_id, provider: row.provider, boundary_at: row.boundary_at, observed_at: row.observed_at, completed_at: completedAt, attempt: row.attempt, status: success ? 'ok' : 'error', source: row.source, metrics, error };
    db.exec('BEGIN IMMEDIATE');
    try {
      requireValue(db.prepare('UPDATE quota_collections SET status=?,error_json=?,completed_at=? WHERE collection_id=? AND status=?').run(record.status, error ? JSON.stringify(error) : null, completedAt, collectionId, 'pending').changes === 1);
      for (const item of metrics) db.prepare('INSERT INTO quota_metrics(collection_id,provider,metric,dimension,unit,value_text,observed_at) VALUES (?,?,?,?,?,?,?)').run(collectionId, row.provider, item.metric, item.dimension, item.unit, item.value, row.observed_at);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const snapshots = join(directory, 'snapshots'); privateDirectory(snapshots);
    const day = join(snapshots, dateInZone(Date.parse(row.observed_at), timezone)); privateDirectory(day);
    const target = join(day, `${collectionId}.json`), temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, target);
    return record;
  }
  function samples() {
    const rows = db.prepare('SELECT provider,metric,dimension,unit,value_text AS value,observed_at AS capturedAt FROM quota_metrics ORDER BY observed_at,collection_id LIMIT ?').all(maxSamples + 1);
    requireValue(rows.length <= maxSamples); return rows.map(row => ({ ...row }));
  }
  function markFailureReported(collectionId) { return db.prepare("UPDATE quota_collections SET failure_reported=1 WHERE collection_id=? AND status IN ('error','pending') AND failure_reported=0").run(collectionId).changes === 1; }
  return { path, begin, finish, latest, samples, markFailureReported, close: () => db.close() };
}
