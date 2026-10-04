# 两套核心插件与上游复用结论

结论：采用一个私有 monorepo，两个核心安装包：通用类型化决策、任务与互联套件。飞书是独立可选适配器，WebUI 是原账本的读取端。

## 实际耦合

原 `typed-decisions` 没有导入任务、互联、飞书或账本实现。规则模式仅依赖 Cordis／Schemastery，任务侧 `TaskPlanner` 通过 `evaluate(DecisionRequest) → DecisionReceipt` 单向消费。任务侧仅在 `typedDecisions` 服务存在时动态挂载规划，因此单机任务和远端执行仍能不安装决策包。

原互联源码用 `LedgerPort` 隔离导入，但原生插件强制 `inject = ['taskSystem']`。它需要同一账本的 claim/renew/submit、fencing、取消静止确认、审批、子任务、观察、节点心跳与回执恢复，以及任务宿主的 native 执行端。因此源码无循环不代表安装层松耦合；其可靠性契约与任务生命周期高度耦合，合为一套安装包更简单。单机模式仍只挂任务服务，跨设备模式再显式挂 `/remote`。

任务专用候选目录、workspace/执行端/模型组合和落账授权检查移到任务包的 `/task-policy`。通用决策保留请求、回执、provider 和验证协议，不知道任务实现。互联代码及测试整体移入任务套件，协议与存储逻辑保持原样。

飞书原有的聊天、卡片、消息幂等、审批、取消和未知送达待核对语义保留在可选包。适配器消费公开结构化 `TaskChannelPort`，两核心包没有飞书包或 Lark SDK 依赖。后续渠道插件可接入现有 delivery claim/finish 和原生取消端口；无需扩建通用路由平台。

## 已经复用与无需重写的部分

当前任务执行已通过 DSH 的 Agent、AgentLoop、Session 和持久化插件运行。当前决策的原生模型适配已经使用官方 `llm.prepareCall`，一轮无工具请求，接收完整输出后做严格契约验证；它没有自己另造 Agent 执行循环。

它尚未使用 `ctx.subagents.start(outputSchema)`。官方 rc.2 的该接口支持结构化值、persona、工具过滤和取消，但需要真实父 Agent；结构化输出是 object-root schema 子集，失败或无成功 capture 返回 error。现有无会话规则／定时规划并没有父 Agent，强行替换会引入额外 Agent 生命周期。故保留现有独立决策与已接入的 DSH LLM 薄适配；已有 Agent 的消费者可使用官方结构化子代理，不能从失败结果的末尾文本挽救判定。[官方 subagent 契约](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/subsystems/subagent.md)、[结构化 driver](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/subagent/subagent-in-process-driver/README.md)。

官方 workflow、jobs、goal、plan 分别解决组合执行、进程内作业、会话目标和人审规划，没有整体替代这套跨设备持久化账本、权限及结果回执。[workflow](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/workflow/workflow-ptc/README.md)、[jobs](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/jobs/jobs/README.md)、[goal](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/goal/goal/README.md)、[plan](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/plan/plan-mode/README.md)。

## 社区候选的接入成本

| 候选 | 当前判断 |
|---|---|
| [dsh-task-orchestrator](https://github.com/hasan-aghayev/dsh-task-orchestrator) | 有依赖图、worker 和审阅，但自带编排策略，兼容证据偏旧 alpha；不是当前决策／远程协议的替换件。 |
| [dsh-jev-decide](https://github.com/nanami-0713/dsh-jev-decide) | 外部 Jev 分类判定工具，不能替代任务规划；当前已保留可选 Jev provider，再加工具插件没有必需收益。 |
| [dsh-plan-lattice](https://github.com/1052326311/dsh-plan-lattice) | 偏上下文恢复且固定较旧依赖；不为本次安装边界引入。 |
| [fan56/dsh-feishu](https://github.com/fan56/dsh-feishu) | 已有会话绑定、卡片、询问和停止能力，适合作为可选入口候选。机器人全局单会话绑定与当前任务级送达语义不同；不直接替代 durable delivery。版本兼容需要实际验证，不仅看 manifest 声明。 |
| [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im) | 多渠道主动投递候选，但 rc.2 的适配成本未证明；本次不强接。 |

检索范围内未确认一个 rc.2 成熟插件能完整替换当前领域决策与跨设备契约。取舍是复用已经可用的官方执行／模型机制、保留必要的小契约层，不引入第三方编排平台。渠道候选未安装、未设置操作者或凭据。
