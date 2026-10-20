# 会话调度与任务结果回报

正式派发统一使用 `task_dispatch`。宿主从当前调用会话绑定发起者；系统调用绑定系统，不借用创建任务时的旧会话。规划工具 `task_plan` 只生成方案。`task_create` 只建草稿；修复未领取请求使用 `task_repair_dispatch`，本机 Desktop Codex 使用独立的 `codex_delegate`。节点查询统一为 `task_nodes`，宿主按当前项目协作或执行任务范围处理，不再公开重复的 `project_nodes`。`task_wait` 的 `timeoutMs=0` 查询子树状态，代替旧 `task_children`。本地领取/执行由宿主 worker 内部处理，不再公开 `task_claim` 或 `task_execute`。通用最终提交使用 `task_submit_result`，执行任务和协调父任务由宿主分别核验所有权。

普通会话可以按以下提示使用公开工具：

> 检索并选择当前工作目录对应的已有项目，创建一个整理任务，把本会话登记为该任务的调度会话。用统一派发工具把具体分析任务交给 MBP，保留父任务关联。等待结果自动返回本会话后，读取子任务正式报告，完成父任务的汇总报告与最终提交。若该业务定义了专门的提交工具，使用业务工具保存结果。

对应顺序：`project_list` → `project_bind_session` → `task_create` → `task_bind_dispatcher` → `task_dispatch` → 异步原会话续接 → `task_history` → `task_submit_result`。项目创建仍可在项目页完成；选择已有目录会采用原目录，省略选择才按项目父目录新建。项目父目录仅是新建项目的默认位置；已有注册工作区按设备工作区授权校验，允许位于该父目录之外。设备拥有的工作区不会把绝对路径当成另一台设备的目录；跨设备子任务使用目标设备的授权目录，递归任务仍遵守既有隔离规则。

Task/Run 保存持久发起者。终态与回报 outbox 在同一账本事务写入，事件 ID 稳定。原会话忙时结果排入下一轮；回报需观察对应轮次完成后才确认“已处理”。重启后根据持久 inbox、已消费消息及轮次结束记录恢复，已消费但中断的结果只追加续接提示，不重复结果正文或任务执行。

冷恢复保留原模型、预设和工具白名单。工具白名单与历史租约限制在恢复 setup 中安装，原工具可用性在宿主 `agent/created` 钩子完成后检查。业务插件可通过正常宿主钩子恢复角色工具，无需专用适配器；仍可选用 `registerOriginContinuation`。未知适配器或缺少原工具时保留待回报并显示失败原因。已退休的 `dmc-analysis-v1` 仅接受原 v1 形状和同一 sessionId，按正常宿主生命周期恢复，不重建 DMC 等待流程。历史执行租约不会因续接而恢复。`task_history` 的 `resultReturns` 显示投递次数和最近失败；`task_retry_return` 只重投同一回报事件，已处理事件幂等返回，不重跑任务。

DMC 0.1.2 的业务行为恢复至 9ab56c8：先保存首次分析，子任务报告送回后由原 Agent 查询当前分析并调用 `dmc_revise_analysis`。不引入 DMC 等待状态；修订保留原收据和历史，并继续执行内容版本、资料版本、角色与工作区校验。0.2.40 验证目录保留为当时版本的历史证据。

运行时仍提供 `pendingOriginReturns(sessionId)`，供可选业务插件区分“已派发且正在等待结果”和“没有提交的普通空闲”。仅持久 origin 任务或待回报证据构成等待依据；捕获会话上下文本身不表示任务已派发。

公开入口按功能收敛如下；实际可见工具仍由当前会话角色和授权过滤。

| 功能 | 当前公开入口 | 旧入口处理 |
| --- | --- | --- |
| 规划 | `task_plan` | 删除 `apply` 派发职责 |
| 正式派发 | `task_dispatch` | 删除 `task_run`、`task_delegate`、`project_dispatch` |
| 本机 Desktop Codex | `codex_delegate` | 从旧 `task_delegate` 分离 |
| 结果终结 | `task_submit_result` | 删除 `task_settle`，宿主核验执行或调度角色 |
| 子任务状态与短等 | `task_wait` | 删除 `task_children`，零超时只查询 |
| 节点查询 | `task_nodes` | 删除 `project_nodes`，按当前范围查询 |
| 原会话登记 | `project_bind_session`、`task_bind_dispatcher` | 分别选择项目、登记父任务调度者，均从宿主绑定当前会话 |
| 回报重投 | `task_retry_return` | 只重投持久事件，不创建新执行 |

`task_create` 保持草稿登记。`task_repair_dispatch` 只处理未领取派发的修复。`task_query` 提供概览，`task_history` 提供历史证据，`task_report` 追加报告，三者职责不同。`project_list` 与 `project_status` 分别列出项目和查询详情，`project_progress` 汇总项目进展。`task_claim` 和 `task_execute` 只保留为内部执行协议，不再作为 Agent 工具暴露。
