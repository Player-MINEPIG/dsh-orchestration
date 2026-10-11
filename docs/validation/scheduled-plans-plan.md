# 定时计划入口

目标：从 codex/project-runtime @ 4f80aa2 开始，独立 codex/scheduled-plans 分支及 scheduled-plans worktree；原项目页并列临时任务和定时计划。计划可关联项目，支持创建、暂停、恢复和触发历史，每次触发创建新 Run。

阶段：验收通过，合并交付。沿用中央 TaskLedger 的 Schedule / occurrence / Run；不新建调度数据库。计划启停与任务状态分开。默认重叠跳过、离线错过合并一次；人工恢复从下个时点开始，不补跑暂停期间。

接口：原 project RPC 新增 scheduleOptions、createScheduledPlan、controlScheduledPlan；执行路线由已注册执行端及授权工作区形成目录，面板选择目录条目。支持固定分钟间隔和每天指定时间（显式时区）。历史保留触发时刻、跳过原因、Run 和结果。

验收：状态/权限/幂等/重启/时区定向测试；VPS 隔离原面板创建关联项目的计划，通过 Tailscale 派发 MBP 官方 GPT-6 Luna / low，至少两次新 Run；面板暂停后无新触发，恢复不补跑；VPS 与 MBP 原面板查看历史。失败打回修复，验收后合并并更新 HTML 报告。

边界：默认 ~/.dsh 与 PV 只读；Hermes 生产库禁止修改。复用已授权 VPS /root/dsh-orchestration-tests/session-collaboration-20261011/run1，运行时切换至本 worktree 构建；本机测试状态使用此前隔离 .runtime/session-collaboration，不修改默认 profile。Tailscale 直接业务网络，无 SSH 转发。目标 worktree 既有未跟踪 package-lock.json 必须保留。

路由：project-collaboration；交付前 code-review-and-quality。定时任务不是状态列；当前计划不新增任意 cron 编辑、自动审核、主动终止当前执行或删除历史。

本地验证：107 项定向回归与 13 项官方 rc.2 settings/RPC 检查通过。真实原面板发现并修复 settings-client.js 中独立 RPC 白名单遗漏。首轮真实 Codex 已成功，暂停未打断执行；等待恢复后的第二轮。

最终验收：VPS 原面板创建关联项目的一分钟计划，真实官方 GPT-6 Luna / low 共调用 2 次，两轮 succeeded；暂停跨过原定下一时点未新增 Run，恢复后下一分钟产生第二个 Run。VPS 与 MBP 原面板分别验证两轮历史报告，执行端只读。测试计划已暂停，worker 已退出。code-review-and-quality 检查通过；合并到 codex/project-runtime，保留目标原有未跟踪 lockfile。证据见 scheduled-plans-evidence.json，HTML 报告已更新。
