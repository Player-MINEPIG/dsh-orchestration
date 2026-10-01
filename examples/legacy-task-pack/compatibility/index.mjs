// SPDX-License-Identifier: MIT
// Parsing historical evidence never creates or settles a task, run, or artifact.
import { createHash } from 'node:crypto';
import { canonicalJson, validateAgentDaily } from '../reporting.mjs';

export class LegacyOutputError extends Error {
  constructor(code) { super({ disabled: 'Legacy mixed-output parsing requires explicit enablement', limit: 'Historical output exceeds the configured parser bound', format: 'No complete supported historical report was found', invalid: 'Historical report failed its schema contract', ambiguous: 'Historical output contains inconsistent report candidates', path: 'Historical patch names an untrusted path', patch: 'Historical patch is not a complete all-added JSON document' }[code] ?? 'Invalid historical output'); this.name = 'LegacyOutputError'; this.code = code; }
}
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = code => { throw new LegacyOutputError(code); };
const isReport = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.report_meta?.schema_version === 'agent_daily_report.v1');
function trustedPath(value, allowedPaths) {
  let path = value.replace(/^[ab]\//, '');
  if (!/^[A-Za-z0-9_./-]{1,512}$/.test(path) || path.split('/').some(part => part === '.' || part === '..') || path.startsWith('//') || !allowedPaths.includes(path)) reject('path');
  return path;
}
function patchCandidates(raw, allowedPaths, maxCandidates) {
  const lines = raw.split('\n'); const candidates = []; const masked = [...lines]; let offset = 0, current = null;
  const finish = () => {
    if (!current) return;
    if (!current.hunk || !current.lines.length) reject('patch');
    let report; try { report = JSON.parse(current.lines.join('\n')); } catch { reject('patch'); }
    if (!isReport(report)) reject('format');
    candidates.push({ report, format: 'all_added_unified_diff', start: current.start, end: current.end, path: current.path, declaredLineCount: current.count, actualLineCount: current.lines.length, warnings: current.count === current.lines.length ? [] : ['Historical hunk line count differs from the recovered complete document'] });
    if (candidates.length > maxCandidates) reject('limit');
    current = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '');
    const git = /^diff --git (\S+) (\S+)$/.exec(line), arrow = /^(\S+) → (\S+)$/.exec(line);
    if (git || arrow) {
      finish(); const match = git ?? arrow; const before = trustedPath(match[1], allowedPaths), after = trustedPath(match[2], allowedPaths); if (before !== after) reject('patch');
      current = { path: after, lines: [], hunk: false, start: offset, end: offset + line.length }; masked[index] = ' '.repeat(lines[index].length);
    } else if (line.startsWith('--- ')) {
      const path = line.slice(4); if (current?.hunk) { finish(); }
      const before = path === '/dev/null' ? null : trustedPath(path, allowedPaths);
      current ??= { path: null, lines: [], hunk: false, start: offset, end: offset + line.length };
      current.before = before;
      masked[index] = ' '.repeat(lines[index].length);
    } else if (line.startsWith('+++ ')) {
      const path = trustedPath(line.slice(4), allowedPaths);
      current ??= { path: null, lines: [], hunk: false, start: offset, end: offset + line.length };
      if (current.before && current.before !== path) reject('patch');
      if (current.path && current.path !== path) reject('patch'); current.path = path; masked[index] = ' '.repeat(lines[index].length);
    } else if (line.startsWith('@@')) {
      const hunk = /^@@ -0,0 \+1,(\d+) @@(?:.*)?$/.exec(line);
      if (!current?.path || current.hunk || !hunk) reject('patch');
      current.hunk = true; current.count = Number(hunk[1]); if (!Number.isSafeInteger(current.count) || current.count < 1) reject('patch'); masked[index] = ' '.repeat(lines[index].length);
    } else if (current?.hunk && line.startsWith('+')) {
      current.lines.push(line.slice(1)); current.end = offset + line.length; masked[index] = ' '.repeat(lines[index].length);
    } else if (current?.hunk && line === '\\ No newline at end of file') {
      masked[index] = ' '.repeat(lines[index].length);
    } else if (current?.hunk && (line.startsWith('-') || line.startsWith(' '))) {
      reject('patch');
    } else if (current?.hunk) {
      finish();
    }
    offset += lines[index].length + 1;
  }
  finish(); return { candidates, masked: masked.join('\n') };
}
/** Strict JSON, or explicitly enabled mixed stdout / complete all-added unified diffs. */
export function parseLegacyAgentOutput(raw, { allowLegacyFallback = false, allowedPatchPaths = [], sourceId = 'historical-stdout', maxBytes = 4 * 1024 * 1024, maxCandidates = 32, maxDepth = 128, validation = {} } = {}) {
  if (typeof raw !== 'string' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024 || Buffer.byteLength(raw) > maxBytes || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 128 || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 256) reject('limit');
  if (!Array.isArray(allowedPatchPaths) || !allowedPatchPaths.every(path => typeof path === 'string') || typeof sourceId !== 'string' || sourceId.length > 512) reject('format');
  let direct; try { direct = JSON.parse(raw); } catch { /* Explicit historical fallback below. */ }
  let candidates;
  if (direct !== undefined) { if (!isReport(direct)) reject('format'); candidates = [{ report: direct, format: 'strict_json', start: 0, end: raw.length, warnings: [] }]; }
  else {
    if (!allowLegacyFallback) reject('disabled');
    const patches = patchCandidates(raw, allowedPatchPaths, maxCandidates); candidates = patches.candidates;
    const text = patches.masked, stack = []; let quoted = false, escaped = false, parsedCount = 0;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"' && stack.length) { quoted = true; continue; }
      if (char === '{') { stack.push(index); if (stack.length > maxDepth) reject('limit'); }
      else if (char === '}' && stack.length) {
        const start = stack.pop(), segment = text.slice(start, index + 1);
        // Only plausible report roots are decoded; nested report fields are not candidates.
        if (!segment.includes('"report_meta"') || !segment.includes('"agent_daily_report.v1"')) continue;
        if (++parsedCount > maxCandidates * maxDepth) reject('limit');
        try { const report = JSON.parse(segment); if (isReport(report)) candidates.push({ report, format: 'mixed_stdout', start, end: index + 1, warnings: [] }); } catch { /* Tool noise and malformed objects are not repaired. */ }
        if (candidates.length > maxCandidates) reject('limit');
      }
    }
  }
  if (!candidates.length) reject('format');
  for (const candidate of candidates) {
    const pending = [[candidate.report, 0]];
    while (pending.length) { const [value, depth] = pending.pop(); if (!value || typeof value !== 'object') continue; if (depth > maxDepth) reject('limit'); for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push([child, depth + 1]); }
  }
  const representations = new Set(candidates.map(candidate => canonicalJson(candidate.report)));
  if (representations.size !== 1) reject('ambiguous');
  let report; try { report = validateAgentDaily(candidates[0].report, validation); } catch { reject('invalid'); }
  return {
    schema_version: 'historical_report_import.v1', report, authoritativeExecution: false,
    provenance: { sourceId, sourceSha256: hash(raw), candidateSha256: hash([...representations][0]), normalizedSha256: hash(canonicalJson(report)), ambiguity: candidates.length > 1 ? 'equivalent_copies' : 'none', candidateCount: candidates.length, candidates: candidates.map(({ report: _report, ...candidate }) => ({ ...candidate, offsetUnit: 'utf16_code_units' })) },
    warnings: ['Historical text is evidence only; parsing does not establish a new authoritative execution', ...candidates.flatMap(candidate => candidate.warnings)],
  };
}
