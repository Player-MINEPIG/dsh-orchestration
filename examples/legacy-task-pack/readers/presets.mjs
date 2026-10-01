// SPDX-License-Identifier: MIT
// Optional data presets. These are rule sets for readGameDaily, not task plugins.

export function hsrRules({ prefix = 'hsr', trainingGoal = '当前分数: 500/500' } = {}) {
  const task = (name, label, marker, category = 'daily') => ({ taskId: `${prefix}.${name}`, label, category, required: true, successMarkers: [marker], missingOutcome: 'failed' });
  const tasks = [
    { ...task('login', 'Launch game', '游戏启动：', 'startup'), missingOutcome: 'not_observed' },
    task('stellar_gift', 'Collect stellar gift', '领取巡星之礼奖励完成', 'rewards'),
    task('energy_spend', 'Complete energy runs', '副本任务完成', 'resource_spend'),
    task('commissions', 'Complete commissions', '完成任务: 派遣委托或收取1次委托奖励'),
    task('daily_training', 'Complete daily training', '每日实训已完成'),
    { ...task('shutdown', 'Close game', '游戏终止：StarRail', 'cleanup'), timestampRequired: true },
    { ...task('support_reward', 'Collect support reward', '支援奖励完成', 'rewards'), required: false, missingOutcome: 'skipped_nonblocking', optionalWhenTaskSucceeds: `${prefix}.daily_training` },
    ...Object.entries({ support_character: '使用支援角色并获得战斗胜利1次: 待完成', omni_synthesizer: '使用1次「万能合成机」: 待完成', simulated_mode: '完成1次「差分宇宙」或「货币战争」: 待完成' }).map(([name, marker]) => ({ taskId: `${prefix}.${name}`, label: name, category: 'optional_daily', required: false, skipWhenAllMarkers: [marker, trainingGoal] })),
    { taskId: `${prefix}.post_shutdown_screenshot`, label: 'Post-shutdown screenshot', category: 'cleanup', required: false,
      failureMarkers: ['截图失败：没有找到游戏窗口'], successMarkers: ['截图保存成功'], nonblockingAfterTaskId: `${prefix}.shutdown` },
  ];
  return { tasks, includeUntimedMarkers: true, metrics: [
    { metricId: `${prefix}.trailblaze_power_spent`, label: 'Energy spent', marker: '开拓力', mode: 'difference', unit: 'points' },
    { metricId: `${prefix}.daily_training_score`, label: 'Daily training score', marker: '当前分数:', mode: 'last', unit: 'points' },
    { metricId: `${prefix}.stage_runs`, label: 'Stage challenge count', marker: '开始刷侵蚀隧洞', afterMarker: '每轮包含', mode: 'last', unit: 'runs' },
  ] };
}

export function oneDragonRules({ prefix = 'zzz', enabledTasks } = {}) {
  const labels = {
    login: '打开并登录游戏', redeem_codes: '兑换码', mail: '邮件', video_store: '录像店营业', scratch_card: '刮刮卡',
    coffee_shop: '咖啡店', howl_bakery: '吼吼饼铺', energy_plan: '体力刷本', notorious_hunt: '恶名狩猎',
    activity_rewards: '活跃度奖励', city_fund: '丽都城募', true_acceptance: '真·拿命验收', shiyu_defense: '式舆防卫战',
    weekly_rewards: '丽都周纪 (领奖励)', drive_disc_dismantle: '驱动盘拆解', casual_stroll: '随便观', lost_void: '迷失之地',
    notification: '通知', overworld_farming: '锄大地', withering_garden: '枯萎之都', intel_board: '情报板', divination: '卦象集录',
  };
  const usual = new Set(enabledTasks ?? ['login', 'redeem_codes', 'mail', 'video_store', 'coffee_shop', 'howl_bakery', 'energy_plan', 'activity_rewards', 'city_fund', 'weekly_rewards', 'drive_disc_dismantle', 'casual_stroll']);
  return { tasks: Object.entries(labels).map(([name, label]) => ({ taskId: `${prefix}.${name}`, label, category: name === 'login' ? 'startup' : 'daily',
    enabled: usual.has(name), required: usual.has(name), terminalPolicy: 'failure_precedence', successMarkers: [`指令[ ${label} ] 执行成功`], failureMarkers: [`指令[ ${label} ] 执行失败`], disabledMarkers: [`应用未启用 ${label}`],
    ...(name === 'login' ? { retryMarkers: [{ all: ['指令[ 进入游戏 ]', '返回状态 返回重试'] }] } : {}),
  })), includeUntimedMarkers: true, cascadeFromTaskId: `${prefix}.coffee_shop`, metrics: [
    { metricId: `${prefix}.error_line_count`, label: 'Error lines', marker: '[ERROR]', mode: 'count', target: 0, unit: 'lines' },
    { metricId: `${prefix}.login_retry_count`, label: 'Login retries', marker: { all: ['指令[ 进入游戏 ]', '返回状态 返回重试'] }, mode: 'count', target: 0, unit: 'retries' },
    { metricId: `${prefix}.world_wait_failures_before_recovery`, label: 'World wait failures', marker: '指令[ 等待大世界画面 ] 执行失败', mode: 'count', target: 0, unit: 'failures' },
    { metricId: `${prefix}.failed_enabled_task_count`, label: 'Failed enabled tasks', mode: 'task_count', outcomes: ['failed'], requiredOnly: true, target: 0, unit: 'tasks' },
  ] };
}

export function maaRules({ prefix = 'maa', manualAnnihilationDue = false, routineKind, annihilationKind, sanityTarget = 210 } = {}) {
  const routine = routineKind ? { runKinds: [routineKind] } : {};
  const gui = (name, label, category = 'daily') => ({ taskId: `${prefix}.${name}`, label, category, required: true,
    timestampRequired: true, startMarkers: [`开始任务: ${label}`], successMarkers: [`完成任务: ${label}`] });
  const tasks = [
    { taskId: `${prefix}.annihilation`, label: 'Manual annihilation', category: 'weekly', enabled: manualAnnihilationDue, required: false, manual: true },
    gui('startup', '开始唤醒', 'startup'), gui('sanity_fight', '理智作战', 'resource_spend'),
    { ...gui('infrastructure', '基建换班'), failureMarkers: [{ all: ['TaskChainError', '"taskchain":"Infrast"'], compact: true }] },
    { taskId: `${prefix}.clue_handling`, label: 'Clue substep', category: 'daily_subtask', required: false,
      failureMarkers: [{ all: ['SubTaskError', '"taskchain":"Infrast"'], compact: true }], followMainTaskId: `${prefix}.infrastructure`, mainSuccessOutcome: 'success' },
    gui('visit_friends', '访问好友'), gui('credit_collection', '信用收支'),
    { taskId: `${prefix}.credit_purchase`, label: 'Credit shop substep', category: 'daily_subtask', required: false,
      successMarkers: [{ all: ['TaskChainCompleted', '"taskchain":"Mall"'], compact: true }],
      failureMarkers: [{ all: ['TaskChainError', '"taskchain":"Mall"'], compact: true }] },
    gui('awards', '领取奖励', 'rewards'),
    ...[['auto_recruit', '自动公招'], ['roguelike', '自动肉鸽']].map(([name, label]) => ({ taskId: `${prefix}.${name}`, label, category: 'optional', required: false,
      successMarkers: [`完成任务: ${label}`], disabledMarkers: [`Name ${label}, IsEnable false`] })),
  ].map(task => task.taskId === `${prefix}.annihilation` ? { ...task, ...(annihilationKind ? { runKinds: [annihilationKind] } : {}) } : { ...task, ...routine });
  return { tasks, ...(routineKind && annihilationKind ? { mergeRunKinds: [annihilationKind, routineKind] } : {}), metrics: [
    { metricId: `${prefix}.annihilation_navigation_retry_count`, label: 'Automatic annihilation navigation retries', mode: 'constant', value: 0, unit: 'retries', target: 0 },
    { metricId: `${prefix}.sanity`, label: 'Sanity', marker: '理智:', mode: 'last', unit: 'points', target: sanityTarget, estimatedAtPath: ['sanity_full_at'], runKind: routineKind, ...routine },
    { metricId: `${prefix}.stage_runs`, label: 'Stage challenge count', marker: '开始行动', mode: 'maximum_range', unit: 'runs', ...routine },
    { metricId: `${prefix}.drops`, label: 'Drop statistics', mode: 'result', resultPath: ['drop_statistics'], fallbackValue: {}, runKind: routineKind, unit: 'items_by_type' },
    { metricId: `${prefix}.subtask_error_counts`, label: 'Subtask errors', mode: 'grouped_count', countsByMarkers: {
      infrastructure: { all: ['SubTaskError', '"taskchain":"Infrast"'], compact: true }, mall: { all: ['SubTaskError', '"taskchain":"Mall"'], compact: true },
    }, unit: 'errors_by_chain', target: 0, ...routine },
  ] };
}
