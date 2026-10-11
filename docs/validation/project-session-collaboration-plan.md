# 当前任务约定与验收

路由：project-collaboration / writing-for-agents / code-review-and-quality。

目标：`/project` 激活当前 DSH 会话，自动加载插件 skill，由 agent 派发、同步、提交；同会话恢复有效；历史补录和原任务面板保留。

分支：从 `codex/project-runtime @ ab2bf26` 建独立 `codex/project-session-collaboration` worktree；实现 checkpoint 789ebcb，真实联调修复 815543e。最终报告与证据记录见本目录 evidence JSON 和 `../reports/orchestration-final.html`。

架构：中央原 TaskLedger/Workbench 是唯一业务权威；协作绑定固定节点、会话、cwd。执行端保存绑定、会话、重试记录；官方动态 systemPrompt 加载实际 SKILL；authenticated projectCollaborate 与工具约束项目权限；提交仍待中央复核。

验收已通过：真实官方 `/project` 激活、真实 DeepSeek agent 派发两项工作；Tailscale VPS → MBP → 官方 Codex gpt-6-luna/low 两次真实调用均完成；同一会话 session-collaboration-real-v4 在独立进程恢复，只 project_status 与 project_finish，未重复派发；项目 pending_review，两个任务/Run/Attempt。Chrome 验收 VPS 和 MBP 原面板的来源会话、摘要、结果与待审核状态，另通过裸 `/project` UI 中央确认激活。

历史回归：真实官方 preview/history 经 Tailscale 登记明确标注的 generic-history fixture；1 observed-only run，模型调用0，总attempt 4→4，本地无第二中央。真实 PV 导入与三级递归沿用上一阶段 ab2bf26 的已验收记录，本轮不冒称重新执行。

测试：路由修复后完整 check 828 项，823过/5跳过/0失败；新增远端乱序修复后完整 remote 115项，114过/1跳过/0失败，定向18/18；authority/native 10/10，相关会话/命令7/7。独立审查通过。

打回与修复：公开路线缺 workspaceId 导致不可领取，现只公布授权且ready的完整路线，并在创建任务前拒绝不完整路线；同节点多进程顺序冲突仅对明确409 OUT_OF_ORDER自动最多3次重试，网络未知不自动重放。失败v2/v3证据保留，v3零模型调用且进程停止后经正式恢复接口取消。

隔离：默认 ~/.dsh、PV只读，Hermes生产数据库未参与。运行目录为本worktree `.runtime/session-collaboration` 和 VPS `/root/dsh-orchestration-tests/session-collaboration-20261011/run1`。中央43971/历史43972，原面板VPS43980与MBP43981。全程Tailscale业务网络，无SSH转发。

剩余：报告最终结构检查、提交并快进合并codex/project-runtime，保护目标既有未跟踪package-lock.json；暂停已完成监督自动化。
