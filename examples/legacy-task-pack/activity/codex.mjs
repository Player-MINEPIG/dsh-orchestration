import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

/** Local official read API. Never starts/resumes a thread or starts a model turn. */
export async function openCodexReader(executable, { signal, timeoutMs = 30000 } = {}) {
  if (!isAbsolute(executable)) throw new Error('Codex executable must be an operator-configured absolute path');
  signal?.throwIfAborted();
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const pending = new Map(); let sequence = 0, buffer = '', closed = false;
  const fail = error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  const exited = new Promise(resolve => child.once('close', () => { closed = true; fail(new Error('Codex reader closed')); resolve(); }));
  const stop = () => child.kill();
  signal?.addEventListener('abort', stop, { once: true });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { fail(new Error('Codex response exceeds read bound')); stop(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message; try { message = JSON.parse(line); } catch { fail(new Error('Invalid Codex API response')); stop(); return; }
      const request = pending.get(message.id); if (!request) continue;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`Codex ${request.method} failed (${message.error.code})`));
      else request.resolve(message.result);
    }
  });
  function call(method, params) {
    signal?.throwIfAborted();
    if (closed || !['initialize', 'thread/list', 'thread/read', 'thread/turns/list'].includes(method)) return Promise.reject(new Error('Unsupported read method'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out`)); stop(); }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async function close() {
    signal?.removeEventListener('abort', stop);
    if (!closed) { stop(); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await exited; clearTimeout(timer); }
  }
  try {
    await call('initialize', { clientInfo: { name: 'dsh_daily_reader', title: 'DSH Daily Reader', version: '0.2.5' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return { call, close };
  } catch (error) { await close(); throw error; }
}

const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(x => x?.text ?? '').join('\n') : '';
const millis = value => typeof value === 'number' ? value * 1000 : Date.parse(value);
const injected = value => /^\s*<(environment_context|app-context|permissions instructions|recommended_plugins|codex_delegation|system)/.test(value);

export function codexEntries(thread, turns, window) {
  const start = Date.parse(window.start), end = Date.parse(window.end);
  return turns.flatMap(turn => {
    const started = millis(turn.startedAt), completed = millis(turn.completedAt);
    const active = turn.status === 'inProgress' && millis(thread.updatedAt) >= start && millis(thread.updatedAt) < end && started < end;
    if (!(started >= start && started < end) && !(completed >= start && completed < end) && !active) return [];
    const prompts = (turn.items ?? []).filter(i => i.type === 'userMessage').map(i => text(i.content ?? i.text)).filter(x => x.trim() && !injected(x));
    if (!prompts.length) return [];
    const answers = (turn.items ?? []).filter(i => i.type === 'agentMessage' && i.phase !== 'commentary').map(i => text(i.text ?? i.content));
    // Item summaries lack individual timestamps; never attribute a later final answer to this day.
    const request = prompts.join('\n'), answer = Number.isFinite(completed) && completed < end ? answers.join('\n') : '';
    return [{ sourceRef: `codex:${thread.id}:${turn.id}`, runtime: 'codex', sessionId: thread.id, turnId: turn.id,
      title: thread.name || thread.preview?.slice(0, 200) || thread.id,
      startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null,
      completedAt: Number.isFinite(completed) && completed < end ? new Date(completed).toISOString() : null,
      state: Number.isFinite(completed) && completed >= end ? 'inProgress' : turn.status,
      request: request.slice(0, 6000), answer: answer.slice(0, 6000), truncated: request.length > 6000 || answer.length > 6000,
      observation: active && started < start ? 'ongoing-turn; exact within-day message times unavailable' : 'turn-boundary timestamps' }];
  });
}

export async function collectCodex({ executable, window, signal, maxThreads = 500, maxTurns = 5000, readerFactory = openCodexReader }) {
  const reader = await readerFactory(executable, { signal }); const entries = [], errors = []; let seenThreads = 0, seenTurns = 0;
  try {
    for (const archived of [false, true]) {
      let cursor;
      do {
        const page = await reader.call('thread/list', { cursor, limit: 50, archived, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['cli', 'vscode', 'appServer', 'exec'], useStateDbOnly: true });
        if (!Array.isArray(page.data)) throw new Error('Invalid thread listing');
        let reachedOlder = false;
        for (const thread of page.data) {
          if (millis(thread.updatedAt) < Date.parse(window.start)) { reachedOlder = true; break; }
          if (++seenThreads > maxThreads) throw new Error('Daily Codex thread bound exceeded');
          if (thread.parentThreadId || String(thread.source).startsWith('subAgent') || (thread.source && typeof thread.source === 'object' && 'subAgent' in thread.source)) continue;
          let turnCursor;
          try {
            do {
              const turns = await reader.call('thread/turns/list', { threadId: thread.id, cursor: turnCursor, limit: 20, sortDirection: 'desc', itemsView: 'summary' });
              if (!Array.isArray(turns.data)) throw new Error('Invalid turn listing');
              seenTurns += turns.data.length; if (seenTurns > maxTurns) throw new Error('Daily Codex turn bound exceeded');
              entries.push(...codexEntries(thread, turns.data, window));
              if (turns.data.length && turns.data.every(t => t.completedAt != null && millis(t.completedAt) < Date.parse(window.start))) break;
              turnCursor = turns.nextCursor;
            } while (turnCursor);
          } catch (error) { signal?.throwIfAborted(); errors.push({ source: `codex:${thread.id}`, error: error.message }); }
        }
        if (reachedOlder) break;
        cursor = page.nextCursor;
      } while (cursor);
    }
  } finally { await reader.close(); }
  return { runtime: 'codex', method: 'official-app-server', window, entries, errors,
    usage: { observability: 'unavailable', reason: 'Historical turn API does not expose per-day token accounting' } };
}
