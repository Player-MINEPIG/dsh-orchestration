import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleInput } from '../dist/schedule-window.js';
import { TaskLedger } from '../dist/index.js';

test('scheduled calendar windows advance independently of recovery time and respect DST', () => {
  const schedule = { input: { sourceIds: ['node'] }, calendarWindow: { timeZone: 'Asia/Shanghai', dayOffset: -1 } };
  const first = scheduleInput(schedule, '2026-10-12T23:00:00Z'), next = scheduleInput(schedule, '2026-10-13T23:00:00Z');
  assert.equal(first.windowStart, '2026-10-11T16:00:00.000Z'); assert.equal(next.windowStart, first.windowEnd);
  const dst = scheduleInput({ input: {}, calendarWindow: { timeZone: 'Australia/Melbourne', dayOffset: -1 } }, '2026-10-04T22:00:00Z');
  assert.equal(Date.parse(dst.windowEnd) - Date.parse(dst.windowStart), 23 * 3600000);
  const today = scheduleInput({ input: {}, calendarWindow: { timeZone: 'Asia/Shanghai', dayOffset: 0 } }, '2026-10-12T16:00:00Z');
  assert.equal(today.windowStart, '2026-10-12T16:00:00.000Z');
});
test('real scheduler pins the occurrence window and exact retry cannot rewrite it', t => {
  let now = Date.parse('2026-10-12T23:00:00Z'); const ledger = TaskLedger.open(':memory:', { role: 'planner', now: () => now }); t.after(() => ledger.close());
  const task = ledger.createTask('task', { title: 'Daily' }).value;
  ledger.updateTemplate('template', { templateId: 'daily', version: 1, name: 'Daily', description: '', defaults: {}, inputSchema: { type: 'object', required: ['windowStart', 'windowEnd'], properties: { windowStart: { type: 'string' }, windowEnd: { type: 'string' }, timeZone: { type: 'string' } } }, resultContract: {} });
  ledger.createSchedule('schedule', { scheduleId: 'daily', taskId: task.taskId, templateId: 'daily', templateVersion: 1, enabled: true, cron: '0 7 * * *', timeZone: 'Asia/Shanghai', nextDueAt: new Date(now).toISOString(), overlap: 'queue', input: {}, calendarWindow: { timeZone: 'Asia/Shanghai', dayOffset: -1 } });
  const first = ledger.fireSchedule('fire-one', { scheduleId: 'daily', occurrenceAt: new Date(now).toISOString() });
  const before = ledger.getRun(first.value.runId).configuration.input;
  now += 86400000;
  const second = ledger.fireSchedule('fire-two', { scheduleId: 'daily', occurrenceAt: new Date(now).toISOString() });
  assert.equal(ledger.getRun(second.value.runId).configuration.input.windowStart, before.windowEnd);
  assert.deepEqual(ledger.fireSchedule('fire-one', { scheduleId: 'daily', occurrenceAt: '2026-10-12T23:00:00.000Z' }), first);
});
