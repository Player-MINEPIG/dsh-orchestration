// SPDX-License-Identifier: MIT
// IANA-zone conversion through the runtime's ICU data. No host-local timezone use.
import { SourceError, parseTime } from './common.mjs';

const cache = new Map();
function formatter(timeZone) {
  if (!cache.has(timeZone)) {
    try { cache.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })); }
    catch { throw new SourceError('timezone', `Invalid IANA timezone: ${timeZone}`); }
  }
  return cache.get(timeZone);
}
export function localParts(time, timeZone) {
  return Object.fromEntries(formatter(timeZone).formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
const wallTime = parts => Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
export function timezoneOffset(time, timeZone) { return wallTime(localParts(time, timeZone)) - Math.floor(time / 1000) * 1000; }
export function offsetText(time, timeZone) {
  const minutes = timezoneOffset(time, timeZone) / 60000, total = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
export function localTimestamp(date, clock, { sourceTimezone, sourceUtcOffset, disambiguation = 'compatible' } = {}) {
  const naive = `${date}T${clock}`;
  const parts = naive.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  const raw = Date.parse(`${naive}Z`);
  if (!parts || !Number.isFinite(raw) || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59 || new Date(raw).toISOString().slice(0, 10) !== date) throw new SourceError('timestamp', 'Invalid naive log timestamp');
  if (sourceUtcOffset) {
    const result = parseTime(`${naive}${sourceUtcOffset}`);
    if (result === null) throw new SourceError('timezone', 'Invalid explicit source offset or timestamp');
    return result;
  }
  if (!sourceTimezone) throw new SourceError('timezone', 'A sourceTimezone or sourceUtcOffset is required');
  if (!['compatible', 'earlier', 'later', 'reject'].includes(disambiguation)) throw new SourceError('timezone', 'Invalid DST disambiguation policy');
  const milliseconds = raw % 1000;
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) offsets.add(timezoneOffset(raw + hours * 3600000, sourceTimezone));
  const candidates = [...offsets].map(offset => raw - offset).sort((a, b) => a - b);
  const exact = candidates.filter(candidate => wallTime(localParts(candidate, sourceTimezone)) + milliseconds === raw);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    if (disambiguation === 'reject') throw new SourceError('timestamp', 'Ambiguous local time at DST fallback');
    return disambiguation === 'later' ? exact.at(-1) : exact[0];
  }
  if (disambiguation === 'reject') throw new SourceError('timestamp', 'Nonexistent local time at DST jump');
  // Compatible matches fold=0/forward behavior: retain elapsed clock offset across a gap.
  return disambiguation === 'earlier' ? candidates[0] : candidates.at(-1);
}
export function dateInZone(time, timeZone) {
  const parts = localParts(time, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}
export function calendarWindow({ businessDate, timeZone, now = new Date().toISOString() }) {
  const instant = parseTime(businessDate ?? now);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(businessDate ?? '') ? businessDate : instant !== null ? dateInZone(instant, timeZone) : null;
  if (!date) throw new SourceError('window', 'Business date must be a date or offset timestamp');
  const tomorrow = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { date, timezone: timeZone, start: new Date(localTimestamp(date, '00:00:00', { sourceTimezone: timeZone })).toISOString(),
    end: new Date(localTimestamp(tomorrow, '00:00:00', { sourceTimezone: timeZone })).toISOString(), interval: 'left_closed_right_open' };
}
