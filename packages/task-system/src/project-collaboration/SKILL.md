---
name: session-project-collaboration
description: 当前会话通过 /project 激活后，使用中央项目工具派发、同步进度和提交复核。
disable-model-invocation: true
---

# 当前项目协作

此技能只在当前会话协作模式有效时注入；项目身份由插件绑定，不能自行选择其他项目。普通对话可以直接回应。用户授权执行项目工作后按以下流程行动：

1. 用 `project_status` 查看中央已有任务和结果，避免重复派发；用 `project_nodes` 查询真实可用节点和完整路线 `routes`。从 `routes` 选择符合用户执行端、模型和推理强度要求的对象；没有符合要求的完整可用路线时说明阻塞。
2. 用 `project_dispatch` 派发明确的工作项，提供标题、完整任务说明和稳定 `requestId`。显式 `routeJson` 必须把 `project_nodes.routes` 中选中的完整对象序列化为 JSON 原样传入，保留 `nodeId`、`provider`、`model`、`reasoningEffort`、`workspaceId`、`requiredCapabilities`（包括空数组）以及返回的 `backend`；只复制返回字段，不凭记忆拼装或编造 `routeId`。需要中央自动选路时可省略 `routeJson`。独立可并行工作可派发多个任务。中央回执如仍是 proposed、pending 或 routing pending，不代表执行已开始。
3. 用 `project_status` 跟踪实际任务、Run、报告和验收状态。用 `project_progress` 将已发生的进度、证据和阻塞同步中央；不要编造结果。保持同一工作项 requestId；新进度版本使用新的 requestId。
4. 工作完成后先检查真实任务结果、测试和交付证据，再用 `project_finish` 提交摘要供用户或中央复核。提交不等于验收通过，不得替用户批准或关闭审查。

写入工具要求 requestId。网络失败或中央尚未确认时，以相同 requestId 和完全相同参数重试，先查状态再决定是否新建工作。不可因超时重发成新任务。不要通过旧的 packet 上报工具替代当前会话协作流程；历史补录仍使用 `/project history`。

`/project leave` 暂停当前会话注入和协作工具；恢复同一会话后绑定自动恢复，前提是原节点、原工作目录和 active 状态均匹配。待确认激活不会自动视为已激活。
