// SPDX-License-Identifier: MIT
import { SourceError, normalizeWindow } from '../readers/common.mjs';
import { summarizeQuotaBoundaries } from '../reporting.mjs';

/** Read an explicit stable exported DB through the existing path/byte/row-bounded source scope. */
export async function readQuotaSnapshots({ scope, databasePath, window: inputWindow, format = 'native', toleranceMinutes = 20 } = {}) {
  if (!scope?.sqlite || typeof databasePath !== 'string' || !['native', 'hermes'].includes(format)) throw new SourceError('configuration', 'An explicit scoped quota snapshot database and supported format are required');
  const window = normalizeWindow(inputWindow); let samples;
  try {
    samples = await scope.sqlite(databasePath, query => {
      // Both statements are constant; manifest/model input cannot supply SQL or identifiers.
      const sql = format === 'native'
        ? "SELECT m.provider,m.metric,m.dimension,m.unit,m.value_text AS value,m.observed_at AS capturedAt FROM quota_metrics m JOIN quota_collections c USING(collection_id) WHERE c.status='ok' ORDER BY m.observed_at,m.collection_id"
        : "SELECT m.provider,m.metric,m.dimension,m.unit,m.value_text AS value,m.observed_at AS capturedAt FROM metrics m JOIN collections c USING(collection_id) WHERE c.status='ok' ORDER BY m.observed_at,m.collection_id";
      return query(sql).map(row => ({ ...row }));
    });
  } catch (error) {
    if (error.code !== 'missing') throw error;
    return { schema_version: 'quota_summary.v1', window, quota_changes: [], data_quality: { status: 'unavailable', complete: false, unavailable_fields: ['provider quota snapshots'], notes: ['The configured exported quota snapshot database is unavailable'] }, evidence: structuredClone(scope.evidence) };
  }
  const quotaChanges = summarizeQuotaBoundaries(samples, { windowStart: window.start, windowEnd: window.end, toleranceMinutes });
  const unavailable = quotaChanges.filter(row => row.observability === 'unavailable').map(row => `${row.provider} ${row.metric} ${row.unit}: missing daily boundary`);
  const usable = quotaChanges.filter(row => row.observability !== 'unavailable');
  return { schema_version: 'quota_summary.v1', window, quota_changes: quotaChanges,
    data_quality: { status: !usable.length ? 'unavailable' : unavailable.length || usable.some(row => row.observability === 'partial') ? 'partial' : 'complete', complete: Boolean(usable.length && !unavailable.length && usable.every(row => row.observability === 'exact')), unavailable_fields: unavailable.length || usable.length ? unavailable : ['provider quota snapshots'], notes: ['Read from a bounded private copy of an explicit exported metric database', 'Balance changes are net account movements, not per-task or gross spend'] }, evidence: structuredClone(scope.evidence) };
}
