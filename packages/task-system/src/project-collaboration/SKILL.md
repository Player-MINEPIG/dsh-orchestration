---
name: session-project-collaboration
description: 当前会话通过 /project 激活后，使用中央项目工具派发、同步进度和提交复核。
disable-model-invocation: true
---

# 当前项目协作

此技能只在当前会话协作模式有效时注入；项目身份由插件绑定，不能自行选择其他项目。普通对话可以直接回应。用户授权执行项目工作后按以下流程行动：

1. 用 `project_status` 查看中央已有任务和结果，避免重复派发。用 `task_nodes` 查询执行端身份、默认模型、模型目录状态和显式路线。目录 pending、stale 或节点离线表示等待，不能据此判断某个模型已被移除。
2. 用 `task_dispatch` 提供标题、完整任务说明和稳定 `commandId`。用户明确指定执行端时传 `nodeId`，否则让中央选择执行端。未指定执行模型时省略模型参数，使用该节点默认模型。用户明确选择了执行模型时，从用户上下文提取 `executionModel`，内容为 `{provider,model,reasoningEffort?,backend?}`；这是工作负载模型，与中央规划决策模型分开。用户明确要求完整路线时，可原样传入 `task_nodes.routes` 返回的对象作为 `route`，保留返回字段，不与 `nodeId` 或 `executionModel` 同传。项目目录由执行端按权威 context 分配，普通项目任务不要求调用者创建 workspace。独立工作可分别派发。queued、pending 或 routing pending 回执不代表执行已开始。
3. 用 `project_status` 跟踪实际任务、Run、报告和验收状态。用 `project_progress` 将已发生的进度、证据和阻塞同步中央；不要编造结果。保持同一工作项 requestId；新进度版本使用新的 requestId。
4. 工作完成后先检查真实任务结果、测试和交付证据，再用 `project_finish` 提交摘要供用户或中央复核。提交不等于验收通过，不得替用户批准或关闭审查。

写入工具要求 requestId。网络失败或中央尚未确认时，以相同 requestId 和完全相同参数重试，先查状态再决定是否新建工作。不可因超时重发成新任务。不要通过旧的 packet 上报工具替代当前会话协作流程；历史补录仍使用 `/project history`。

`/project leave` 暂停当前会话注入和协作工具；恢复同一会话后绑定自动恢复，前提是原节点、原工作目录和 active 状态均匹配。待确认激活不会自动视为已激活。
