---
name: session-project-collaboration
description: 当前会话通过 /project 激活后，使用中央项目工具派发、同步进度和提交复核。
disable-model-invocation: true
---

# 当前项目协作

此技能只在当前会话协作模式有效时注入；项目身份由插件绑定，不能自行选择其他项目。普通对话可以直接回应。用户授权执行项目工作后按以下流程行动：

1. 用 `project_status` 查看中央已有任务和结果，避免重复派发；用 `project_nodes` 查询真实可用节点、模型和工作区。用户指定执行端、模型或推理强度时遵守约束；缺少所需能力时说明阻塞。
2. 用 `project_dispatch` 派发明确的工作项，提供标题、完整任务说明和稳定 `requestId`。省略 route 时由中央配置选择；显式 route 只能使用查询所得能力。独立可并行工作可派发多个任务。中央回执如仍是 proposed、pending 或 routing pending，不代表执行已开始。
3. 用 `project_status` 跟踪实际任务、Run、报告和验收状态。用 `project_progress` 将已发生的进度、证据和阻塞同步中央；不要编造结果。保持同一工作项 requestId；新进度版本使用新的 requestId。
4. 工作完成后先检查真实任务结果、测试和交付证据，再用 `project_finish` 提交摘要供用户或中央复核。提交不等于验收通过，不得替用户批准或关闭审查。

写入工具要求 requestId。网络失败或中央尚未确认时，以相同 requestId 和完全相同参数重试，先查状态再决定是否新建工作。不可因超时重发成新任务。不要通过旧的 packet 上报工具替代当前会话协作流程；历史补录仍使用 `/project history`。

`/project leave` 暂停当前会话注入和协作工具；恢复同一会话后绑定自动恢复，前提是原节点、原工作目录和 active 状态均匹配。待确认激活不会自动视为已激活。
