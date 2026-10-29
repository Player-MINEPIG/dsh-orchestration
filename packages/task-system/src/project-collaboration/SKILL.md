---
name: session-project-collaboration
description: 当前会话通过 /project 激活后，使用中央项目工具派发、同步进度和提交复核。
disable-model-invocation: true
---

# 当前项目协作

此技能只在当前会话协作模式有效时注入；项目身份由插件绑定，绑定后不能自行切换到其他项目。项目默认工作区只决定未指定位置时的新建会话目录；已有会话可在各自真实目录登记到同一项目，登记不会移动会话或授予执行目录权限。普通对话可以直接回应。用户授权执行项目工作后按以下流程行动：

1. 用 `project_status` 查看中央已有任务和结果，避免重复派发。用 `task_nodes` 查询执行端身份、默认模型和目录状态；需要显式模型路线时加 `details:true` 并按节点或模型筛选、分页。目录 pending、stale 或节点离线表示等待，不能据此判断某个模型已被移除。
2. 用 `task_dispatch` 提供标题、完整任务说明和稳定 `commandId`。任务涉及特定设备、操作系统、文件位置或能力时，先核对 `task_nodes` 并传 `nodeId`。仅当授权池内任意执行端均适合时省略，由中央按就绪、容量和稳定节点顺序分配，忙碌或离线时保留合法候选等待。未指定执行模型时省略模型参数，使用该节点默认模型。用户明确选择了执行模型时，从用户上下文提取 `executionModel`，内容为 `{provider,model,reasoningEffort?,backend?}`；这是实际执行任务的模型，不修改对话模型或观察归并预设。用户明确要求完整路线时，可原样传入 `task_nodes.routes` 返回的对象作为 `route`，保留返回字段，不与 `nodeId` 或 `executionModel` 同传。项目目录由执行端按权威 context 分配，普通项目任务不要求调用者创建 workspace。派发前自行划分写入文件范围、依赖和共享 Git index、分支及 GUI 应用的操作顺序。独立工作可并行，不要求逐任务填写资源声明。queued、pending 或 routing pending 回执不代表执行已开始。
3. 用 `project_status` 跟踪实际任务、Run、报告和验收状态。用 `project_progress` 将已发生的进度、证据和阻塞同步中央；不要编造结果。同一写操作重试保持 commandId；新进度版本使用新的 commandId。查询默认摘要，报告正文用 `task_history {taskId,details:true,reportId}` 精确读取，报告、事件和 Run 历史用 section 与 limit/cursor 分页。
4. 工作完成后先检查真实任务结果、测试和交付证据，再用 `project_finish` 提交摘要供用户或中央复核。提交不等于验收通过，不得替用户批准或关闭审查。

写入工具要求 commandId。网络失败或中央尚未确认时，以相同 commandId 和完全相同参数重试，先查状态再决定是否新建工作。不可因超时重发成新任务。不要通过旧的 packet 上报工具替代当前会话协作流程；历史补录仍使用 `/project history`。

`/project leave` 暂停当前会话注入和协作工具；恢复同一会话后绑定自动恢复，前提是原节点、原工作目录和 active 状态均匹配。待确认激活不会自动视为已激活。

配置修复后，原 Task 尚无 Run 时用 `task_dispatch {commandId:新ID,taskId,nodeId,executionModel?}` 沿用原意图。已有未领取 Run 用 `task_repair_dispatch` 和最新 actionVersion 修复原 Run。已有真实终态需要重新执行时，用同一个 taskId、`retry:true`、最新 expectedActionVersion 和新 commandId 创建新的 Run。active 或 uncertain 不得重跑。

用户授权取消或延期可选任务后，用 `task_cancel {commandId,taskId,reason}` 处置原 Task，在 reason 和项目摘要记录延期安排。未领取任务可立即取消；active 的 cancellationRequested 仅表示请求，须等执行端确认停止。project_finish 列出的 active、uncertain 和未处置草稿必须先解决，再提交阶段成果。任务执行完成、中央正式接收提交和用户验收通过是不同状态，分别核对回执。
