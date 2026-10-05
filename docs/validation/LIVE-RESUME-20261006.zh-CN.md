# Orchestration 双端恢复验收

目标：从本地交接的 effb24c 恢复，在 MBP 与 aliyun-vps 上完成小规模真实派发与 Task 会话验证。

授权：用户于 2026-10-06 明确批准恢复、SSH VPS、使用现有 API 与小规模真实任务。仅限定已配置的 VPS–MBP、acceptance 工作区；并发 1，无文件或 shell 工具，无自动重试。原 workbench WIP 保留。

验收：实际工作区和模型设置可读；真实模型决策；VPS 派发、MBP 原生执行、业务结果/报告成功与 ACK；同 Task 后续运行会话复用；结束后清空活动执行并恢复远程暂停。

基线：effb24c；本机已安装 Task effb、typed e080。VPS 原 Task 较旧，需要更新为相同基线。既有负例 ACK 不算业务成功。

结果：全部限定验收通过。可分享的合并证据为 `live-20261006-checks.json`；私有启动记录、探针和截图位于当前 worktree 的 `.runtime/live-20261006`，未纳入 Git。

## 实际完成的验收

- 本机 effb 工作区公开目录正常返回 `workspace` 名称、完整路径、available=true；真实 Chrome 可以选择并丢弃工作区草稿。
- 模型 GUI 可以从已有官方目录选择 DeepSeek-V41-Flash；官方保存、相关插件重启、重新读取均通过。随后恢复原 profile，保存操作没有修改 API 凭据。
- VPS 更新为 Task effb / typed e080。VPS candidate-3 中原本没有凭据；通过临时同机 `.env` 引用复用旧 `86d8fb0` 环境中已经配置的 DeepSeek API，没有复制到本机或输出密钥。
- 真实 VPS TaskPlanner 选择 `mbp-executor / deepseek-official / deepseek-flash / off`。测试执行器再用确定性策略创建仅允许 acceptance 工作区、无工作负载工具、45 秒预算的 Task；本次没有调用 `TaskPlanner.apply`。
- MBP 两次真实会话决策都 answered，分别选择 new / reuse-0 和 acceptance。两次原生运行均 succeeded，分别落账一份 result 报告；Worker 持久记录均为 acknowledged。
- 同一 Task 会话 `task-679cb7d9-5f0d-46c2-8c09-46331f664b34` 完成两个 turn。第二次配置未包含首次标记，报告仍正确写出 `ORCH-20261006-CEDAR-42` 与算式结果 42。会话实际 cwd 是配置的 acceptance 目录。
- 总计 5 次真实模型请求：VPS 决策 1、MBP 会话决策 2、MBP 执行 2。输入含缓存 7,415 token，输出 736 token。原生执行只有两次 `task_settle`，没有文件、shell、消息、子任务或重试。

测试脚本曾将阶段字段直接放在 Run configuration 顶层，触发 `Unsupported Run configuration field`；按契约移到 `configuration.input` 后通过。失败发生在创建 Run 前，无模型工作负载被派发；恢复时复用原 decision / Task / command identity，没有重发模型决策。此问题只涉及测试脚本，没有修改插件核心。

## 收尾状态与继续工作

本机 3082 保持运行（验收结束 PID 27539），remote 已加载且 paused=true、polling=false、队列为空；profile 已逐字节恢复为测试前版本。VPS 测试 Host 已停止，队列没有 queued / running / uncertain Run；只读面板已完成冷启动验收（PID 407275）。临时三项 peer grants 和模型决策覆盖层没有写回原部署配置；VPS 临时凭据引用已移除，原凭据保留。两份真实报告与会话历史保留供复核。两端插件的已验证新安装包保留。

面板重启暴露了独立 consumer 的导入问题：新版 `index.js` 同时导出 Web 设置插件，独立面板没有宿主的模块解析，因而报缺少 `@deepseek-ai/dsh-typert-protocol`。`dashboard/server.mjs` 与 `scripts/task-management-acceptance.mjs` 已改为直接导入 Ledger / Workbench / contracts 核心模块；VPS 私有面板启动器也采用同样修复。没有增加依赖或改变权限。真实 VPS 冷启动和页面读取通过；相关 Dashboard / Management acceptance 回归 62 通过、0 失败、1 个既有私有原始导出 fixture 跳过。首次沙箱内测试因禁止绑定 loopback 端口失败，解除此限制后相关测试全部通过。

VPS 私有面板顶部既有负例提示已标注为“历史负例验收”，保留原 NO_ADAPTER / ACK 证据；新任务详情同时展示两个成功 Run 和两份 result 报告。修改前启动器保存在 VPS `live-dashboard/backups/before-history-label-20261006.mjs`。

当前源码分支为 `codex/two-end-live-test`，基于 effb24c。原 multi-project-workbench WIP 未修改，也没有 push。

继续派发时需显式恢复 VPS Host 与本机远程连接。真实测试覆盖交接约定的 VPS 调度 → MBP 执行拓扑，不声称反向拓扑、生产可靠性或自定义报告语义验证已经通过。
