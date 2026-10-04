# Candidate3 交付状态与入口

基线 `ece68974a5c1632bc2c3f7427fe8743ce8aa6fe8`，本地独立分支 `integration/task-management-candidate-1` 的内容已升级为 candidate3。源码位于 `/Users/pmp/AI/deepseek-harness/dsh-orchestration-candidate-1`；私有远端为 `https://github.com/Player-MINEPIG/dsh-orchestration`。本次提交保留 main 和原产品 WIP，未 merge/push。

## 已实现与验证

- 文件 SQLite 持久管理 Domain/Project/需求 Backlog/Task 及关系；管理页支持创建、编辑、关联、优先级继承与显式覆盖。原 Task/Run/Attempt/Report、租约、fence、幂等与取消回执语义保留。
- 固定模板与轻量意图上下文、明确系统阻塞证据、Report 与真实执行归属呈现；candidate3 修复真实 schema Claim 深度，两个端点须使用一致版本。
- MBP 原生 CUA 验证创建/关联、优先级、编辑刷新、归档任务非意图编辑和桌面/390px 界面；正常重启后，同一非空数据库的全部记录与修订保持一致。本机使用 Node 24.13.0 构建通过。
- 父任务和 VPS 执行线于 2026-10-04 确认真实 VPS DSH → MBP DSH 单次 seed/dispatch、最终 ACK；Run `blocked`、Attempt `settled`、executor journal `acknowledged`，系统原因 `NO_ADAPTER` / `before-agent-start`。结果持久化并可通过新库 UI 查询；模型调用、原生 Agent 启动及执行结果 Report 均为 0。此项是传输与真实阻塞闭环，不是游戏执行成功。现场临时测试执行服务已停止。
- 云端 candidate2 报告 513 项测试及独立审阅 29 项通过；candidate3 相关 384 项测试、独立审阅 7 项与官方 task-system 安装/boot gate 通过。本机未重复云端全套；其他未完成的可选包发行 gate 不据此宣称通过。

## 尚未实现或验证

- 真供应商/模型执行、原游戏脚本与日志、游戏 success/partial 以及原 Python 语义校验尚未完成；不以结构校验或系统阻塞替代这些证据。
- 管理页尚无筛选/搜索入口，也没有直接标记 Task completed 的内容表单；完成状态仍由既有执行/检查语义维护，已知 UI 缺口不在本次收口中补做。
- Skill/Milestone/Artifact/检查关系有持久 API，专用完整表单、个人账号与公开发布投影仍未交付。未整合决策或飞书插件，未迁移旧 Hermes 或改真实日报计划。

## 操作入口与数据边界

- MBP UI 检查页：`http://127.0.0.1:4318/manage.html`，仅本机 loopback。横幅为“本机 UI 检查库 · 非跨设备验收”，稳定 databaseId `mbp-candidate-1-ui-smoke`。这里保留 CUA 创建的内容记录，不是 VPS 真实结果库；Run/Attempt/Report 当前均为 0。
- VPS 真实结果：使用既有 8443 面板。父任务报告 VPS owner 正恢复该面板并绑定真实 candidate3 结果库；此提交不声称该入口已完成恢复或提供未经核实的 URL。具体访问地址、DB 身份及原始现场回执由 VPS 执行线交付；查看时先核横幅/数据库身份，再核 blocked 原因和实际执行归属。
- 复现与检查命令见 [验收说明](TASK-MANAGEMENT-ACCEPTANCE.zh-CN.md)；管理能力及边界见 [实施说明](TASK-MANAGEMENT-IMPLEMENTATION.zh-CN.md)。不要重放旧 uncertain Run，不清空 journal，不补造 Report/settle，不启用原计划通知。

本次 Git 只包含候选源码、测试和必要文档；测试数据库、私有导出、现场 fixture/证据、凭据与运行日志不入提交。工作区名称及本机测试数据库 ID 中的 candidate1 是保留的稳定名称，不表示仍运行 candidate1 代码。
