import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
export const name = 'independent-capability-removal-probe';
export const inject = ['tools'];
export function apply(ctx) {
  const service = process.env.DSH_TEST_CAPABILITY === 'typed' ? 'typedDecisions' : process.env.DSH_TEST_CAPABILITY === 'feishu' ? 'feishuChannel' : 'remoteExecution';
  assert.equal(ctx.get(service), undefined);
  writeFileSync(process.env.DSH_TASK_PROBE_OUT, JSON.stringify({ ok: true, removed: service }));
  const timer = setInterval(() => {}, 1000);
  ctx.effect(() => () => clearInterval(timer));
}
