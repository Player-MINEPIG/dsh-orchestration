// SPDX-License-Identifier: MIT
// Synthetic evidence only; no accounts or original logs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSourceScope } from '../../examples/legacy-task-pack/readers/common.mjs';
import { readAutoMasDaily } from '../../examples/legacy-task-pack/readers/automas.mjs';
import { validateGameDaily } from '../../examples/legacy-task-pack/reporting.mjs';

async function fixture(t, lines, retry) {
  const root = await mkdtemp(join(tmpdir(), 'sra-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const json = (name, value) => writeFile(join(root, name), JSON.stringify(value));
  await json('script.json', { instances: [{ uid: 'old', type: 'GeneralConfig' }, { uid: 'sra', type: 'HSRConfig' }],
    old: { Info: { Name: 'March7th' }, SubConfigsInfo: { UserData: { instances: [{ uid: 'u' }], u: { Info: { Name: 'wrong' } } } } },
    sra: { Info: { Name: 'SR-SRA', SRAPath: 'synthetic' }, SubConfigsInfo: { UserData: { instances: [{ uid: 'u' }], u: { Info: { Name: 'synthetic-sra', Status: true } } } } } });
  await json('queue.json', { instances: [{ uid: 'q' }], q: { Info: { TimeEnabled: true }, SubConfigsInfo: {
    TimeSet: { instances: [{ uid: 'time' }] }, QueueItem: { instances: [{ uid: 'item' }], item: { Info: { ScriptId: 'sra' } } } } } });
  await json('run.json', { hsr_result: 'HSR 用户任务完成' });
  await writeFile(join(root, 'run.log'), lines.map((line, i) => `[07:00:${String(i).padStart(2, '0')}] ${line}`).join('\n'));
  const historyFiles = [{ resultFile: 'run.json', fallbackDate: '2026-10-11' }];
  if (retry) {
    await json('retry.json', { hsr_result: 'HSR 失败任务补跑部分失败' });
    await writeFile(join(root, 'retry.log'), retry.map((line, i) => `[07:01:${String(i).padStart(2, '0')}] ${line}`).join('\n'));
    historyFiles.push({ resultFile: 'retry.json', fallbackDate: '2026-10-11' });
  }
  const report = await readAutoMasDaily({ scope: await createSourceScope(root), historyFiles, scriptConfigFile: 'script.json', queueConfigFile: 'queue.json',
    reportMeta: { device_id: 'synthetic', business_date: '2026-10-11', report_timezone: 'Asia/Shanghai', source_timezone: 'Australia/Melbourne', collected_at: '2026-10-11T06:00:00+08:00' } });
  validateGameDaily(report);
  const hsr = report.automations[0];
  assert.equal(hsr.automation_id, 'hsr_march7thassistant');
  assert.equal(hsr.engine, 'StarRailAssistant (SRA)');
  assert.equal(hsr.account, 'synthetic-sra');
  assert.ok(hsr.reported_top_level_status.includes('HSR 用户任务完成'));
  assert.ok(hsr.metrics.every(m => m.value === null));
  return hsr;
}
const success = ['SRA 登录/切号 执行完成', '模块「体力与培养目标」执行完成', '没有巡星之礼活动',
  '任务完成：领取派遣奖励', '任务完成：领取每日实训奖励', '任务完成：签证奖励'];

test('SRA no-event gift is nonblocking and selects queued HSRConfig account', async t => {
  const hsr = await fixture(t, success);
  assert.equal(hsr.status_hint, 'ok');
  assert.equal(hsr.tasks.find(t => t.task_id === 'hsr.stellar_gift').outcome, 'skipped_nonblocking');
});
test('SRA partial retry recovers weekly task while real rewards failure remains', async t => {
  const hsr = await fixture(t, [...success, '开始执行 SRA 历战余响', '模块「历战余响」执行失败', '模块「日常与奖励」执行失败'],
    ['模块「历战余响」执行完成', '模块「日常与奖励」执行失败']);
  assert.equal(hsr.status_hint, 'action_required');
  assert.equal(hsr.tasks.find(t => t.task_id === 'hsr.echo_of_war').outcome, 'success');
  assert.equal(hsr.tasks.find(t => t.task_id === 'hsr.daily_training').outcome, 'failed');
  assert.equal(hsr.tasks.find(t => t.task_id === 'hsr.stellar_gift').outcome, 'failed');
});
test('SRA missing terminal evidence stays uncertain', async t => {
  const hsr = await fixture(t, ['SRA 登录/切号 执行完成']);
  assert.equal(hsr.status_hint, 'verify');
  assert.equal(hsr.tasks.find(t => t.task_id === 'hsr.daily_training').outcome, 'uncertain');
});
