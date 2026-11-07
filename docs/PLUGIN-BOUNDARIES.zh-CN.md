# 当前插件边界

两个核心安装包是 `dsh-jev-plugin` 和 `@dsh-task/task-system`。任务套件可独立安装；自动观察归并等模型消费者通过 `ctx.decisionModels.ask` 使用可选 JEV 服务。提供商、模型与凭据由 JEV 和 DSH 原生模型服务管理；模型选择不授予任务、文件或执行权限。

任务套件拥有同一份 Task/Run/Attempt/Report 账本、工作区与项目、调度、租约/fencing、取消、审批及恢复回执。跨设备能力从同包 `/remote` 显式挂载，保持同一权威账本与授权边界。任务候选与确定性权限校验归 `/task-policy`，不由模型服务维护。

飞书是独立可选适配器，通过公开 `/channels` 结构接口消费任务与送达能力。核心包没有飞书 SDK 依赖。可移植 dashboard 是同一账本的只读消费者；其私有管理页仅暴露明示的内容管理 allowlist，保留角色、同源防护、幂等与 revision 冲突边界。

宿主运行复用官方 DSH Agent、AgentLoop、Session、持久化、模型适配及权限服务，不另建执行守护进程。JEV 普通模型调用使用官方 `llm.prepareCall`；任务派发、工作目录与会话所有权继续由确定性宿主代码控制。

当前入口与验证以根 README、[安装迁移](PACKAGE-MIGRATION.md)、[JEV 迁移](JEV-MIGRATION.zh-CN.md)和[CI](CI.md)为准。`docs/architecture`、`docs/validation` 与 `tests/dsh/results` 保留历史版本证据；它们不是当前部署指南。
