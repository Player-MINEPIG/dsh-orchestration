import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
export const name = 'task-system-removal-probe';
export const inject = ['tools'];
export function apply(ctx) {
  assert.equal(ctx.get('taskSystem'), undefined);
  assert.equal(ctx.tools.get('task_query'), undefined);
  writeFileSync(process.env.DSH_TASK_PROBE_OUT, JSON.stringify({ ok: true, removed: true }));
  // Keep only the test host alive until the acceptance runner requests shutdown.
  const timer = setInterval(() => {}, 1000);
  ctx.effect(() => () => clearInterval(timer));
}
