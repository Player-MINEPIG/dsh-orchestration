// SPDX-License-Identifier: MIT
// Independent implementation. Format provenance is documented in README.md.
import { constants } from 'node:fs';
import { open, realpath, stat, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export class SourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceError'; this.code = code; }
}

const defaults = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 128, maxRows: 20_000, maxLineBytes: 1024 * 1024, maxMessageChars: 6000, maxDirectories: 256 });
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)); };

/** All inputs must be explicit exported files below one operator-selected root. */
export async function createSourceScope(root, options = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new SourceError('scope', 'An explicit absolute export root is required');
  const directory = await realpath(root);
  if (!(await stat(directory)).isDirectory()) throw new SourceError('scope', 'Export root must be a directory');
  const limits = { ...defaults, ...options };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024) throw new SourceError('limit', `Invalid ${key}`);
  const state = { files: 0, bytes: 0, directories: 0 };
  const evidence = [];
  async function scopedPath(path, { optional = false } = {}) {
    if (typeof path !== 'string' || !path) throw new SourceError('path', 'Explicit input path is required');
    const requested = resolve(directory, path);
    if (!within(directory, requested)) throw new SourceError('scope', 'Input path is outside the export scope');
    let target;
    try { target = await realpath(requested); } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw new SourceError(error.code === 'ENOENT' ? 'missing' : 'read', `Input is unavailable: ${path}`);
    }
    if (!within(directory, target)) throw new SourceError('scope', 'Resolved input path is outside the export scope');
    return target;
  }
  async function read(path, { optional = false, maxBytes = limits.maxBytes, tail = false } = {}) {
    const target = await scopedPath(path, { optional });
    if (target === null) return null;
    if (++state.files > limits.maxFiles) throw new SourceError('limit', 'Source file count exceeds configured bound');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new SourceError('type', 'Only regular exported files are supported');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limits.maxBytes) throw new SourceError('limit', 'Per-file byte bound must fit the source scope');
      const lengthLimit = Math.min(info.size, maxBytes), start = tail ? info.size - lengthLimit : 0;
      if ((!tail && info.size > maxBytes) || state.bytes + lengthLimit > limits.maxTotalBytes) throw new SourceError('limit', `Input exceeds configured byte bound: ${path}`);
      // A fixed buffer also bounds a file that grows after stat(). Never read to EOF unbounded.
      const buffer = Buffer.alloc(lengthLimit + 1);
      let length = 0;
      while (length < buffer.length) {
        const part = await handle.read(buffer, length, buffer.length - length, start + length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      if (length > lengthLimit) throw new SourceError('changed', 'Input changed while being read; provide a stable export');
      state.bytes += length;
      evidence.push({ path: relative(directory, target), bytes: length, original_bytes: info.size, last_modified_at: new Date(info.mtimeMs).toISOString(), read_status: info.size > length ? 'partial' : 'ok' });
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }
  async function json(path, { encoding = 'utf-8' } = {}) {
    const bytes = await read(path);
    const text = decodeText(bytes, encoding);
    try { return JSON.parse(text); }
    catch { throw new SourceError('json', `Invalid JSON export: ${path}`); }
  }
  async function metadata(path) {
    const target = await scopedPath(path), info = await stat(target);
    if (!info.isFile()) throw new SourceError('type', 'Only regular files have input metadata');
    return { path: relative(directory, target), bytes: info.size, last_modified_at: new Date(info.mtimeMs).toISOString() };
  }
  async function list(path, { recursive = false, extensions } = {}) {
    const target = await scopedPath(path);
    const output = [];
    const walk = async folder => {
      if (++state.directories > limits.maxDirectories) throw new SourceError('limit', 'Directory traversal exceeds configured bound');
      const entries = await readdir(folder, { withFileTypes: true });
      if (entries.length > limits.maxRows) throw new SourceError('limit', 'Directory entry count exceeds configured bound');
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(folder, entry.name);
        // Explicit file reads resolve symlinks; recursive discovery never follows them.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && recursive) await walk(child);
        else if (entry.isFile() && (!extensions || extensions.some(extension => entry.name.endsWith(extension)))) {
          output.push(relative(directory, child));
          if (output.length > limits.maxFiles) throw new SourceError('limit', 'Discovered files exceed configured bound');
        }
      }
    };
    await walk(target);
    return output;
  }
  async function sqlite(path, callback) {
    const bytes = await read(path);
    const wal = await read(`${path}-wal`, { optional: true });
    const folder = await mkdtemp(join(tmpdir(), 'dsh-export-snapshot-'));
    let database;
    try {
      const snapshot = join(folder, basename(path));
      await writeFile(snapshot, bytes, { mode: 0o600 });
      if (wal) await writeFile(`${snapshot}-wal`, wal, { mode: 0o600 });
      database = new DatabaseSync(snapshot, { enableExtensions: false });
      database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const query = (sql, ...params) => {
        const rows = database.prepare(`${sql} LIMIT ?`).all(...params, limits.maxRows + 1);
        if (rows.length > limits.maxRows) throw new SourceError('limit', 'SQLite result exceeds configured row bound');
        return rows;
      };
      return await callback(query);
    } finally { database?.close(); await rm(folder, { recursive: true, force: true }); }
  }
  return { root: directory, limits, evidence, read, json, sqlite, list, metadata };
}

export function assertRows(rows, scope, label) {
  if (!Array.isArray(rows)) throw new SourceError('format', `${label} must be an array`);
  if (rows.length > scope.limits.maxRows) throw new SourceError('limit', `${label} exceeds configured row bound`);
  return rows;
}
export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value !== 'string') return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return parseTime(Number(value));
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
export function normalizeWindow(window) {
  const start = parseTime(window?.start), end = parseTime(window?.end);
  if (start === null || end === null || end <= start) throw new SourceError('window', 'Window requires ordered timestamps with explicit offsets');
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), interval: 'left_closed_right_open', ...(window.date ? { date: window.date } : {}), ...(window.timezone ? { timezone: window.timezone } : {}) };
}
export const iso = value => value === null || value === undefined ? null : new Date(value).toISOString();
export const inWindow = (time, window) => time !== null && time >= Date.parse(window.start) && time < Date.parse(window.end);
export function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}
export function clip(value, limit) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return { text, truncated: false };
  const marker = ' …[bounded]… ';
  if (limit < marker.length + 4) return { text: text.slice(0, limit), truncated: true };
  const tail = Math.floor((limit - marker.length) / 4);
  return { text: text.slice(0, limit - marker.length - tail) + marker + text.slice(-tail), truncated: true };
}
export const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
export const zeroTokens = () => Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0]));
export function addTokens(target, values) {
  for (const key of TOKEN_FIELDS) if (Number.isSafeInteger(values?.[key]) && values[key] >= 0) target[key] += values[key];
}
export function failure(error) { return { code: error.code ?? 'read', message: String(error.message).slice(0, 500) }; }
export const INJECTED_PREFIXES = ['<recommended_plugins>', '<environment_context>', '<in-app-browser-context', '<app-context>', '<permissions instructions>'];
export const isHuman = (text, prefixes = INJECTED_PREFIXES) => Boolean(text.trim()) && !prefixes.some(prefix => text.trimStart().startsWith(prefix));
export function decodeUtf8(bytes) {
  return decodeText(bytes, 'utf-8');
}
export function decodeText(bytes, encoding = 'auto') {
  const names = encoding === 'auto' ? bytes[0] === 0xff && bytes[1] === 0xfe ? ['utf-16le'] : bytes[0] === 0xfe && bytes[1] === 0xff ? ['utf-16be'] : ['utf-8', 'gb18030', 'gbk'] : [encoding === 'cp936' ? 'gbk' : encoding];
  for (const name of names) {
    if (!['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'gbk'].includes(name)) throw new SourceError('encoding', `Unsupported configured encoding: ${name}`);
    try { return new TextDecoder(name, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { /* Try the explicitly supported legacy encoding fallback. */ }
  }
  throw new SourceError('encoding', 'Input cannot be decoded using the configured supported encodings');
}
export function completeTailLines(bytes, encoding = 'auto') {
  const separator = encoding === 'utf-16le' ? Buffer.from([10, 0]) : encoding === 'utf-16be' ? Buffer.from([0, 10]) : Buffer.from([10]);
  const newline = bytes.indexOf(separator);
  if (newline < 0) throw new SourceError('limit', 'Bounded log tail contains no complete line');
  return bytes.subarray(newline + separator.length);
}
export function jsonLines(bytes, scope) {
  const records = [], errors = [];
  const lines = decodeUtf8(bytes).split(/\r?\n/);
  if (lines.length > scope.limits.maxRows + 1) throw new SourceError('limit', 'JSONL record count exceeds configured bound');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > scope.limits.maxLineBytes) throw new SourceError('limit', 'JSONL line exceeds configured byte bound');
    try { records.push({ record: JSON.parse(line), line: index + 1 }); }
    catch { errors.push({ code: 'jsonl', line: index + 1, message: 'Malformed JSONL record omitted' }); }
  });
  return { records, errors };
}
