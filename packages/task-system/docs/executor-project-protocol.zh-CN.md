# 执行端项目工作区与派发协议

调度端的项目工作区只保存统筹上下文。执行端以 route.workspaceId 对应的**本地授权工作区**为父目录，不使用 VPS 的绝对路径。设置页中的默认工作区仍必须已登记、就绪并授予该执行端；自动创建子目录不授予新的根目录权限。

```
执行端授权父目录/
└── scheduler-<调度端身份及短摘要>/
    ├── project-<项目身份及短摘要>/       普通项目工作区
    │   └── .dsh-project-context/         项目版本快照、工具说明
    ├── temporary-tasks/                 公共临时任务工作区
    │   └── .dsh-project-context/         临时任务类型及工具说明
    └── worktrees/
        └── project-<项目身份及短摘要>/
            └── task-<任务及会话摘要>/   Git 任务独立 worktree
```

项目名称不作为目录身份，重命名不会移动目录。不同调度端、项目有不同目录；同一调度端的临时任务共用一个 temporary-tasks 工作区，各个任务有自己的 DSH 执行会话。会话日志仍由原生 sessionPersistence 管理，不是物理任务子目录。工作区通过官方 workspaceRegistry 登记到 DSH 侧栏，临时工作区只登记一次，worktree 单独登记，因为官方 attachSession 要求会话 cwd 与工作区路径完全一致。

同项目以及同一调度端的临时任务在一个 Worker 上依次执行，避免共享普通目录并发写入；不同项目可按已授权并发数执行。当项目目录本身已经是有提交的 Git 仓库时，新执行会话创建以该项目 HEAD 为起点的独立 detached worktree。同一任务的后续 Run／安全重试使用已保存的会话与 cwd；不会自动合并提交、复制未提交文件或清理产物。新会话有独立 worktree。

## 项目上下文 v1

创建 Run 的权威账本从 Workbench 关联读取项目，固定在 `Run.projectContext` 中。ProjectRuntime 临时任务明确携带 `project: null`。调用方和模型不能覆盖这份上下文；多项目关联含糊时拒绝创建 Run，子任务继承父 Run 的项目快照。后续项目编辑不改变已经派发的快照，新 Run 读取最新项目 revision。

| 字段 | 作用 |
| --- | --- |
| version = 1 | 确定结构版本，未知版本拒绝执行 |
| schedulerId | 固定账本身份，与会话协商返回的身份核对，隔离多个调度端 |
| project = null | 临时任务，共用该调度端的 temporary-tasks 工作区 |
| project.projectId | 两端共享的项目身份，本地路径由此派生 |
| project.revision | 派发时的项目上下文版本 |
| project.title | 显示名称，登记 DSH 工作区 |
| project.goal / description | 项目目标与必要说明，注入原生执行提示 |
| project.acceptanceCriteria | 项目验收上下文；Task 的具体验收仍由 intentSnapshot 固定 |

Claim 和 getRun 传输这份 Run 快照，sessionContext 也提供同一份项目上下文用于会话选择。任务标题、描述、具体验收、模板输入／结果契约及选定报告仍使用原有 intentSnapshot、configuration 和 executionContext。上下文遵循现有正文、总量和 Claim 字节预算，超限在领取提交前拒绝。

带项目上下文的 Run 要求领取请求明确携带 `projectContextVersion: 1`。旧客户端缺少此字段时，Gateway 返回 `PROJECT_CONTEXT_UPGRADE_REQUIRED`，不创建 Attempt；新版 Worker 只对新格式 Run 发送该字段，旧格式任务仍兼容旧调度端。

sessionContext 同时返回该执行端实际获准的 `availableOperations`。模型可见的历史、查询、子任务、辅助报告、委派和备注工具按这些权限过滤；最终结果仍由 `task_submit_result` 提交。隐藏工具不改变服务端权限检查，也不会自动扩大执行端授权。旧调度端不返回此字段时保留原有工具兼容行为。

## 兼容与产物

既有 Run 没有 projectContext 时保留原执行路径。已存在的旧执行会话只在恢复库中有同一任务／会话证据、且旧身份映射唯一归属于当前调度端时保留原 cwd，不搬迁会话。不能证明归属或变更项目时拒绝复用，需显式选择新会话。旧版临时任务的会话 cwd 也保持原位；DSH 会话头不可修改。测试环境可以归档旧会话、移除旧工作区入口；生产迁移需要明确的交接方案。新建临时任务不会再登记每任务工作区。

新会话的本地路径映射持久化在执行端恢复库中，重启、继续和安全重试不会重新定位目录。

目录组件从身份生成，已有未登记目录、符号链接、越出授权父目录以及会话换项目都不能被自动采用。纯 planner 仍没有执行器。

大文件和完整执行记录保留在执行端；返回既有报告和必要的文件相对路径、版本或哈希引用。协议不会自动同步仓库、大文件或未提交代码。需要输入材料时，继续使用现有模板 input、选定报告或在任务指令中提供可访问的仓库／版本引用。文件搬运与自动合并不在本次交付范围。

## 执行工具与未指定模型时的路线

远程派发在 MBP 原生执行实例上应用任务插件的 executionTools 白名单，并与任务 allowedTools、远程操作 grants 和文件边界取交集；它与浏览器普通对话的宿主工具列表独立。执行实例结束后释放；普通对话恢复同一个 session 时不再持有原 Attempt，因此不能通过 task_submit_result 改写旧任务结果。切换 reasoningEffort 不授予权限。任务执行通过官方 agentPresets 服务先挂载默认工具预设，再应用任务白名单；新会话记录预设身份，恢复时沿用会话中记录的预设。未提供预设服务的独立宿主仍使用其已挂载的工具。继承的预设工具按白名单筛选，执行 guard 还会拒绝所有未列入白名单的调用。DSH 某些预设会在 Agent 自身作用域另行登记工具（例如 subagent），可能仍出现在工具列表中，但不会获得此任务的执行权限。

执行提示列出实际可用工具：需要的工具缺失时应报告 blocked；创建文件必须实际调用文件工具并验证，不能用报告文本代替。这个提示不等于通用产物校验；普通未声明结果契约的任务仍不能只凭模型的 success 保证文件或外部副作用真实发生。对文件验收应同时核对工具日志与磁盘，或使用已验证的结构化产物契约。

用户不指定 route 时，调度端使用 task-planning 决策预设，从登记的执行端 provider/model/reasoningEffort 元组中选择，随后固定到 Run.route；执行端校验并使用这组路线，不使用浏览器当前的模型菜单。决策模型本身与执行模型是两个角色。本次排查开始时，测试目录仅登记 mbp-executor 的 deepseek-official/deepseek-flash/off，因此用户未指定时也只能选择 off。用户随后要求默认 high，现已将调度候选、执行端声明及决策／统筹默认配置改为 high；历史 Run 保留原路线。

执行提示中的 `currentTimeUTC` 由执行宿主在派发给模型时生成，供没有 shell／时钟工具的任务使用。它表示提示生成时刻，不能保证后续每一次工具调用的精确秒级时刻；模型仍需按要求使用该值，而不是编造时间。
