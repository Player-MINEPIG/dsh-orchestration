# 任务看板反馈：本地交付记录

2026-10-18；执行 GPT-6.1-Sol / High。实际工作树：`/Users/pmp/.codex/worktrees/dashboard-feedback/dsh-orchestration`，基于 db9e2d1（task-system 0.2.24）。已获授权作本地提交用于整合；**没有推送、部署、生产数据修改或服务重启**。原始 dirty 工作树保留。

## 当前决定与结果

- 1/2/3/10：状态栏独立分页，每页最多5条；总量与分页分开，过滤/轮询修正页码。白卡/浅灰栏，标题状态、设备归属、时间详情分区；长标题可换行。
- 4/8：调度主列表默认根交付任务，明确工作流步骤和历史子任务不平铺。展示设置可逆提升子交付项；完整面板、精确执行和执行端授权树保持可访问。子任务协作放任务详情。根任务汇总旧 pending/rejected 的精确历史 Run；普通无 review 的失败仅当前仍需处理时提示，成功重试不永久报警。后续成功不清除旧 pending partial。
- 5：结果完成、验收事实、阅读事实独立。报告正文进入可视区才记录该报告版本已读，隐藏正文/仅打开详情不清除；失败保留未读可重试；旧运行未读保留。持久读取沿用现有项目 owner 范围。成功 backend 不再仅按执行器类型强制人工审核；自愿验收不覆盖已有 accepted/rejected。
- 6/7：项目关系图折叠键固定项目命名空间，poll/详情弹层不改变；保存滚动位置。大量节点保持原滚动结构并提供首尾导航和背景拖动。451节点场景的最后任务、执行与报告在桌面和390px视口可达。未证明用户原先“拖不到头”有单一线上根因，因此这是有证据的可达性修复。
- 9：复用 stages/steps/calls；可重复设备的独立阶段，派生开始结束，抽象待绑定步骤可保存，所有执行入口在副作用前拒绝未绑定配置。精确计划步骤↔历史 Task/Run/report 导航；20条历史摘要窗口外仍可查指定 Run。不实现真正循环。
- 11：加入 workflowView，未选历史仅摘要，选中历史保留完整内容与精确ID，沿用 planner/both 权限；旧 API 兼容。加载/失败提示保留缓存且可重试。**偶发线上断连未定位，不能称已解决。**

## 实施所有权与整合

| 执行者 | 所有权 | 依赖 |
|---|---|---|
| dashboard_execution | project-page/runtime、ledger、settings/client、scheduled-plans、构建脚本及对应测试 | 工作流预检与DTO接口 |
| workflow_execution（独立树） | workflow-contracts/graph/runtime/ui/page、workflow tests | ledger.workflowExecutionPreflight |

已整合本地提交：4c055d0（预检）；69f7eee（来自373b263工作流计划）；249de25（来自649555c精确选择/导航）；101b24a（来自1ae7056历史窗口外读取）。看板、阅读、呈现和传输投影补丁另作最终本地提交。生成 dist 和依赖链接不提交。

## 验证与证据

构建：`npm run build -w @dsh-task/task-system`（Node24）。最终套件与日志见 evidence/verification.md；相关行为覆盖独立分页/过滤、变更poll后展开与位置、可视报告版本阅读/失败、持久化重开、展示例外/完整树、旧pending与成功重试、unbound无副作用、20条外历史、跨页old report不回退latest、workflowView权限。

预览为合成数据：`http://127.0.0.1:4341/`，`?mobile=1` 为390px iframe。包含多个根交付、显式子交付、内部子任务、历史缺口和未读报告；并非生产改动。evidence 中 final-main/unread/read-detail/mobile/page2 是当前主列表规则，早期graph截图仅证实图可达性。390px证据不是实体手机或触摸测试。主会话实际操作已验证未读1→进入报告→关闭后0，未读筛选为空；截图已执行会话查看。

## 只读线上调查

用户提供 aliyun-vps 的 HTTPS 入口。只读核对运行版本、有限 service/proxy日志与SQLite：当前插件0.2.24；服务无重启循环。曾看到初始连接丢失/网关错误，但按钮随后可打开，未稳定复现并无对应后端堆栈，不能据此断言网络或快照是根因。

截图三项 PC_AU 是历史 partial/pending_user：子 f22e0641 / c71d485d / 52a39509 分别对应精确父 ef669359 / 715b257c / 0820f68a，三个父当次也 partial。当前根卡取另一较新 succeeded Run，不能证明这些来源缺口消解。生产未批量accept，partial语义未改。现存 successful backend pending_user 数量0，无需为成功默认策略纠正历史生产数据。

同一9条历史执行的UTF8、未压缩JSON序列化字节：完整5,955,333；默认摘要69,192；选中最新714,830。只测历史记录部分，非全RPC响应、带宽或延迟；不作性能或断连根因结论。

## 定位历史（已解决前置）

初始 cwd 位于 feature/multi-project-workbench / ece6897，旧0.2.0 dashboard并有用户改动，未拿它凑功能。匹配源码在干净 /private/tmp/dsh-rc2-upgrade 的 db9e2d1；主会话随后创建并附加当前专用树。早期“目录/4/5/9待确认”“不提交”已被后续授权与上述决定取代；不部署、不推送仍有效。

## 票据

1. [列表与卡片](issues/01-list-cards.md)
2. [结果/验收/阅读](issues/02-review-reading.md)
3. [节点图](issues/03-node-graph.md)
4. [详情归属与呈现](issues/04-task-collaboration.md)
5. [工作流与断连](issues/05-workflow.md)
