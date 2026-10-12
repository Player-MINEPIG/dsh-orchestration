// SPDX-License-Identifier: MIT
// AUTO-MAS SRA wrapper markers; keep the historical automation and task IDs.
export function sraRules() {
  const rewardsFailure = '模块「日常与奖励」执行失败';
  const task = (id, label, success, failure, extra = {}) => ({ taskId: `hsr.${id}`, label, category: 'daily',
    successMarkers: [success], failureMarkers: [failure], missingOutcome: 'uncertain', ...extra });
  return { includeUntimedMarkers: true, mergeRuns: true, retryResultMarker: '补跑', tasks: [
    task('login', '启动并进入游戏', 'SRA 登录/切号 执行完成', 'SRA 登录/切号 执行失败', {
      category: 'startup', successMarkers: ['SRA 登录/切号 执行完成', "任务 'StartGameTask' 已完成。"] }),
    task('stellar_gift', '领取巡星之礼', '任务完成：巡星之礼', rewardsFailure, {
      skipWhenAllMarkers: ['没有巡星之礼活动'], skipOnlyAfterFailure: true }),
    task('energy_spend', '体力与培养目标', '模块「体力与培养目标」执行完成', '模块「体力与培养目标」执行失败'),
    task('commissions', '委托收取与派遣', '任务完成：领取派遣奖励', rewardsFailure),
    task('daily_training', '每日实训与奖励', '任务完成：领取每日实训奖励', rewardsFailure),
    task('support_reward', '支援奖励', '任务完成：签证奖励', rewardsFailure, { required: false }),
    task('echo_of_war', '历战余响', '模块「历战余响」执行完成', '模块「历战余响」执行失败', {
      category: 'weekly', enabledWhenMarkers: ['开始执行 SRA 历战余响'] }),
    ...['support_character', 'omni_synthesizer', 'simulated_mode', 'shutdown', 'post_shutdown_screenshot'].map(name => ({
      taskId: `hsr.${name}`, label: name, enabled: false, required: false })),
  ], metrics: ['trailblaze_power_spent', 'daily_training_score', 'stage_runs'].map(name => ({
    metricId: `hsr.${name}`, label: name, mode: 'constant', value: null,
  })) };
}
