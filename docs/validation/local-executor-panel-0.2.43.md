# 本机任务面板 0.2.43

本轮从已 fetch 核对的 `main` / `origin/main` `1106f29` 创建 `codex/local-executor-task-panel` 独立工作树开发。原 WIP 保存在 stash commit `2b6330cecdba7eab3a1aab82f081686e2df85f3e`，没有恢复到本轮。

执行端总面板改为读取本机最近观察队列、持久 recovery、native ledger 与待提交 journal，不再请求远端 `projectSnapshot`。按 Run 去重并保留实际任务/父任务、执行/父执行、会话与目录记录；活跃 recovery 优先，历史读取有界。领取请求仅投影 Run ID 和回执状态，不复制 outbound 的业务 JSON。已回传不等于父任务已验收；无本机记录也不能证明远端无任务。会话任务面板使用相同分类色、卡片与筛选模式；执行会话按实际 sessionIds 关联。

右上角调度端/执行端切换仅选择读取视图，不修改角色或执行行为。可用项来自本机实际 task role，缺少身份的选项禁用；暂停/断网不会移除已有身份。单身份默认自身，both 默认调度端，手动与自动刷新保留当前选择。

## 验证与发布

源码运行版本为 `c6505564c62d4a40d51a1f5ce0fe2c53815a998f`；之后仅添加本记录。构建通过，19 项本机数据/会话/UI/RPC检查和 5 项角色切换检查通过。真实 Chrome 验证 planner/executor/both、disabled、切换，以及会话明暗主题/窄屏。截图使用隔离 fixture，没有创建生产任务。

```sh
npm run build -w @dsh-task/task-system
node --test packages/task-system/test/local-executor-panel.test.mjs packages/task-system/test/session-task-monitor.test.mjs tests/settings/session-task-panel.test.mjs tests/settings/task-panel-rpc.test.mjs
node --test --test-name-pattern='project RPC|executor view stays local|both identities switch|scheduler-only page' packages/task-system/test/project-page.test.mjs
```

首版候选 `fba516e` 在生产只读验收中发现 browser/host RPC 参数合同不一致，总面板首读失败；会话面板已成功。本轮立即修正手写 descriptor 和首次 `{}` 入参，并补真实 DSH browser Remote → Typert Gateway 验证首次 `{}`、两种 view 及 sessionTasks。最终两端安装均为修正后的同一归档：SHA-256 `6b331a535015b0f7d1996df8cf2dd3ebde383234c74f6a5a910be3e2a202d4e1`，319 文件逐一匹配。

生产只读结果：MBP 为 executor，默认本机执行视图、调度项禁用；显示 12 项本机任务记录和 2 个未确认领取 Run，真实执行会话显示 1 项已回传记录。AWS 实际为 both，调度视图与本机执行视图均可打开；执行端暂停、尚无队列观察和本机记录时身份仍可选择。没有领取、重新执行、清回执或创建生产任务。

任务目录采用候选解包与独立原子替换；没有运行依赖重算。Profile 只基于写前最新内容 CAS 更新 task 包引用。AWS 当前 DMC 的 47 项文件/链接安装激活前后相同；MBP 没有 DMC 安装，本轮没有新增。配置、凭据、默认策略和目录设置保持不变。AWS 后台维护只刷新了一个仍为 queued 的 Run 的 `updatedAt`；无 Task/Run/Attempt 新增或删除，不能将整个业务 DB 称为字节不变。

回退到本轮开始的 0.2.42 使用各端 `~/.dsh/releases/local-executor-panel-0.2.43/backup/task-system`；最终候选备份及激活记录位于 `~/.dsh/releases/local-executor-panel-0.2.43-final/`。DMC 不在回退操作范围内。

## 已知边界

指定 AWS 会话 `dmc-22f2a9a1-ed58-4072-bd5b-f4a4859c1b84` 的真实 sessionTasks 读取成功但仍为 0 项。现有派发索引只识别 `tool/call` + `tool/result`，未覆盖 PTC 子调用事件；本轮统一前端表现，没有扩改该历史索引或 DMC。既有 claim uncertain 也只读显示，没有修复协议或清理业务状态。

旧 `project-page.test.mjs` 的两项文案断言在基线源码已有对应失败条件：设置路径字面量已经改变，且新建项目原文已有“派发”而断言全文件禁止该字。这些与本轮状态/切换行为不同，未改无关文案。旧远端镜像 fixture 的两例先在 claim setup 报 `EXECUTION_CATALOG_PENDING`；本轮保留远端协议并将其测试读取指向协议入口，没有为其扩改 catalog。

[发布回执](local-executor-panel-0.2.43/release.json)包含初版失败、最终两端归档/激活和生产只读结果。完整生产截图保留在 `/private/tmp/*-panel-043.png`，没有把个人侧栏或业务正文提交到仓库。
