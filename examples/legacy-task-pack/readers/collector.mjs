import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { ReportContractError, validateGameDaily } from '../reporting.mjs';
import { calendarWindow } from './time.mjs';

/** Fixed operator-owned collector. The task can select a source ID and window, never a command. */
export async function readGameCollector({ config, window, nodeId, maxOutputBytes, signal }) {
  const day = calendarWindow({ businessDate: window.date, timeZone: window.timezone });
  if (Date.parse(window.start) !== Date.parse(day.start) || Date.parse(window.end) !== Date.parse(day.end))
    throw new ReportContractError('Daily game collector requires a complete calendar-day window');
  if (!config || !isAbsolute(config.executable ?? '') || !isAbsolute(config.cwd ?? '') ||
      !Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string'))
    throw new ReportContractError('Collector needs an absolute executable, cwd and fixed argv');
  const timeoutMs = config.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
    throw new ReportContractError('Invalid collector timeout');
  const substitutions = { date: window.date, timeZone: window.timezone, windowStart: window.start, windowEnd: window.end };
  const args = config.args.map(arg => arg.replace(/\{(date|timeZone|windowStart|windowEnd)\}/g, (_, name) => substitutions[name]));
  signal?.throwIfAborted();
  const output = await new Promise((resolve, reject) => {
    const child = spawn(config.executable, args, { cwd: config.cwd, shell: false, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = []; let size = 0, error, forceTimer;
    const stop = reason => { error ??= reason; child.kill(); forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000); };
    const abort = () => stop(signal.reason ?? new Error('Collector aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error('Collector timed out')), timeoutMs);
    child.on('error', reason => { error ??= reason; });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxOutputBytes) stop(new Error('SOURCE_OUTPUT_TOO_LARGE: collector output exceeds bound'));
      else chunks.push(chunk);
    });
    child.once('close', (code, childSignal) => {
      clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (code !== 0) reject(new Error(`Collector failed (${code ?? childSignal})`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
  let report; try { report = JSON.parse(output); } catch { throw new ReportContractError('Collector must emit one JSON report on stdout'); }
  if (report.report_meta?.business_date !== window.date || report.report_meta?.report_timezone !== window.timezone)
    throw new ReportContractError('Collector report date/time zone differs from pinned task window');
  validateGameDaily(report, { deviceId: nodeId, ...(config.automationIds ? { automationIds: config.automationIds } : {}) });
  return report;
}
