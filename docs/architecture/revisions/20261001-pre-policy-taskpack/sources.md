# 架构证据与状态边界

记录日期：2026-10-01。本文区分 2026-09-08 的历史观察、固定源码证据、2026-10-01 的目标约定与本次新实现；它不是当前生产运行证明。此文刻意不复制私人主机地址、账号、安装路径或凭据。

## 原实现：历史源码与旧现场记录

固定 Plugins 源码：`1dfacb5e5949d9f248b1feacbc36644fb351f19e`。下列路径均相对于 [Personal-Hermes-Plugins](https://github.com/Player-MINEPIG/Personal-Hermes-Plugins/tree/1dfacb5e5949d9f248b1feacbc36644fb351f19e)。旧 Archify README 的现场记录日期为 2026-09-08，不能升级为 2026-10-01 的在线检查。

- O01 宿主与入口：`plugins/hermes_monitor/hermes_monitor_plugin/__init__.py:11765-11832` 的 register 初始化 Registry、启动准入/派发/cron worker，并向 Hermes Gateway 注册工具、命令与 hook。飞书对话和 Cron 是入口；hermes_monitor 挂载于宿主，core/server 是被导入模块。
- O02 派发：同文件 `7360-7395` 先选 queued 且确认通过的任务，再选择 worker/node；实际执行分支使用官方 Serve WS RPC 或本地 CLI。宿主拥有 agent/session，插件拥有任务编排；旧站点不参与执行。
- O03 Registry 所有权：同文件 `975-998` 由 monitor 打开 SQLite 读写或 query-only 连接；`3244-3298` 将 activity candidate 的最新 revision/envelope upsert；`7771-7833` 校验结果提交身份与幂等冲突。旧 latest-row 机制不保证每个报告修订都永久留存。
- O04 Observer：`systems/hermes-task-system/client/hermes_task_client/observer.py:33-38` 只读打开本地 state.db；`transport.py:33-77` 通过持久化 outbox 发送 HTTP activity-intake、保存 ACK/绑定、失败重试。已观察工作只收录和对账，不能因此重派发。
- O05 执行与结果：`plugins/hermes_monitor/hermes_monitor_plugin/serve_transport.py:486-589` 提交/等待 Serve 请求；主模块 `8006-8135` 归并运行终态、结构化 claim 与校验。进程退出、语义结果和送达不是一个状态。
- O06 输出消费者：`plugins/hermes_monitor/scripts/bitable_sync.py:391-404` 查询 task/current run；`build_agent_daily_report.py:365-452` 创建报告工件；`send_agent_daily_report.py:250-316` 校验并送出报告。它们是不同执行位置，不是统一报告微服务。
- O07 只读浏览：`plugins/hermes_monitor/systemd/hermes-monitor-datasette.service:2-20` 配置独立 Datasette 读取同一 Registry。箭头应由读取者指向数据库；数据库不会主动推送。
- O08 定时与历史限制：主模块 `2371-2506` 保存 schedule binding，`2751-2867` 的 occurrence 创建新任务，`8462-8536` 的 follow-up/retry 创建后续任务。目标中的稳定 task 跨 occurrence/run 是重构要求，不能当成旧保证。
- O09 保活边界：旧材料与用户说明中的 supervisor 保活的是 Hermes Gateway/Serve 宿主，插件由宿主挂载。旧额外 observer、Datasette、Bitable timer 是历史机制，不是新插件必须复刻的服务边界。

## 新方案：设计约定与当前实现边界

- T01 生命周期：外部 supervisor → 长驻 DSH host → native mounted plugins。插件不拥有 OS daemon、平台自维护或专用 Codex 后端；宿主配置/skill 可选择工具与委派。
- T02 管理核心：Task System 是配置、管理、历史的中心；一个 TaskLedger 事务所有者使用 SQLite。task_id 是稳定目标；task、session、run、attempt、report、revision、artifact、delivery receipt 分开。
- T03 配置扩展：版本化 Template/Schedule 使用统一接口；日报、游戏日报和用户自定义任务是配置示例，核心不写任务名分支。每次 occurrence/run 保留生效配置。
- T04 执行：明确执行路由经过节点角色、能力、模型/effort、工作区与 lease/fence 校验；attempt 在副作用前原子绑定 executionId，后续续租、session 绑定、submit 与取消 ACK 校验同一执行实例；Remote Execution 是 DSH 内的可选插件，不能绕过 admission，也不另启独立 daemon。
- T05 决策：Typed Decisions 是可选、可替换模型策略插件；类型化输出要验证，abstain/拒绝保留，模型不能替代确定性权限门。
- T06 工作区：Workspace 是节点上的真实目录；创建/复用与 task/session 独立。路径必须落在授权范围，运行记录实际 workspace。
- T07 报告：同 task 可以跨 session 多次报告；追加报告/修订保留原内容及来源。精确重复命令回放返回原 receipt，内容冲突拒绝；相同正文的独立报告仍是两份。
- T08 迟到证据与取消：过期 lease 或取消后的报告可作为历史证据；不得逆转权威终态。unknown/uncertain 不自动当失败后重跑。
- T09 查询与导入：私有 dashboard 只消费相同 TaskLedger/query 或明确导入的任务快照，显示 source observedAt 与 stale 状态；不得新建第二本权威账本，不得把新闻/AI feed 当任务。
- T10 渠道：Feishu 作为 DSH channel 可独立对话，Task System 的报告送达是可选集成。通知 outbox/receipt 与任务结果分离；未知外部送达结果不能宣称 exactly-once。

## 新代码核实记录

以下为本次工作树的静态源码检查，尚不能代替固定提交 provenance、测试或生产验证。实现仍在并行修订，因此以下使用可检索符号导航，固定行号留待真实 origin 和最终提交后补核。repository-draft.json 是初稿证据引用，尚未最终固定，不可作为当前提交证明。

- N01 `packages/task-system/src/ledger.ts` 的 `TaskLedger` constructor / `command`：SQLite WAL / synchronous FULL；command ID、内容摘要和 receipt 在同一 BEGIN IMMEDIATE 事务保存，冲突回滚。
- N02 同文件 `newTask` / `newRun` / `validateRoute` / `claim` / `owned` / `bindSession`：稳定 task、独立 run 与 attempt；route 校验角色/能力/模型/effort/workspace；lease/fence 与 session 绑定。`markRunning` 通过 `command` 原子写入首个 executionId；`owned` 与 `acknowledgeCancellation` 拒绝不同实例继续操作。同节点身份不能替代实例所有权。
- N03 同文件 `report` / `appendReport` / `registerArtifact`：reportId 不覆盖；previousReportId 关联修订；工件同 task 且 finalized。报告、正文、来源与 artifactIds 追加保存。
- N04 同文件 `submit` / `cancel` / `recoverExpired`：结构化 settlement 决定 run 状态；通知 intent 同事务写入；取消与过期 lease 阻止后续权威结果写入；过期执行归 uncertain。停止请求与已确认停止必须区分。
- N05 同文件 `updateTemplate` / `createSchedule` / `fireSchedule` / `history` / `snapshot`：版本化模板、interval schedule、skip/queue overlap 与 occurrence 去重；history/snapshot 从同一本账本查询。首版并非完整 cron/DST/misfire 产品。
- N06 `packages/task-system/src/dsh-plugin.ts` 的 `apply` / `TaskSystemService` / `NativeExecutionProvider.drive`：native 注册服务/tools，加载配置，恢复过期尝试，绑定卸载清理；localNode / remoteNodes 从显式配置建立节点记录；markRunning 绑定实例后才创建/恢复自有 agent。flush session、等候 idle 后提交 staged task_settle，success / partial 还要求后代 allSettled quiet window。没有结构化提交只记 unknown；维护循环处理 due schedules，可选 autoExecute 受 maxConcurrent 限制。工具白名单取 node 配置与 task policy 交集，文件路径校验失败即拒绝；shell 默认不开放，trustedUnconfinedTools 必须显式启用。
- N07 `packages/remote-execution/src/index.ts` 的 `apply` / `RemoteExecutionService`：挂载 taskSystem ledger，使用宿主 webServer 的可选 route，卸载时 drain；`worker.ts` 的 `ExecutorWorker.executeOwned` / `deliver` 先获 lease、检查 workspace，再保存 dispatch intent，随后 markRunning 原子绑定 executionId；绑定成功后才创建 session / 调用 provider。`store.ts` 的 `RecoveryStore` 持久化非秘密 instance UUID，`executionId` 由此身份与 attempt 派生，独立恢复日志不能复用另一实例所有权。续租 / bind / submit / cancel ACK 携带同一实例身份；重试只送已有结果，uncertain 不重跑 provider。`NativeExecutionProvider.executeExternal` 只拥有本机 agent、返回结构化结果；签名 remote worker 拥有远端 lease 与 settlement。
- N08 `packages/typed-decisions/src/index.ts` 的 `TypedDecisionService` / `apply`：注册独立 service；rules-only 不依赖 task ledger。`task-policy.ts` 的 `buildTaskDecisionRequest` / `consumeTaskDecisionReceipt` 只返回提案并要求消费者最终授权检查。新 `packages/task-system/src/planning.ts` 的 `TaskPlanner.plan/apply` 读取权威 catalog、调用决策、复核 snapshot，再经显式 authorize 和账本事务应用；`packages/typed-decisions/src/dsh-completion.ts` 的 `DshCompletionService.complete/run/close` 提供可选 native 单次模型桥接，通过宿主 llm.prepareCall 发出无工具请求，限制 route / effort、输入输出、时长和并发；卸载取消 active calls。modelVersionSource=configured-pin 是运营配置，不是供应商版本证明。真实模型调用仍需外部运行验证。
- N09 `dashboard/server.mjs` 的 `createDashboardHandler` / `main`：注入 snapshot callback 提供只读 HTTP 数据；本地入口以 readOnly 打开同一 TaskLedger。`public/model.js` 的 `validateSnapshot` / `sourceIsStale` 校验来源与过期窗口。站点部署与真实数据导入需分别确认。
- N10 `packages/task-system/src/workspaces.ts` 的 `WorkspaceManager.provision`：实际创建或复用受控 root 下目录、拒绝 symlink/path escape、保存创建请求 marker；`ArtifactStore.put` 保存内容地址工件并校验 digest。目录创建不是新 task，也不自动执行 Git 初始化或远端仓库创建。
- N11 `packages/feishu-channel/src/dsh-chat.ts` 的 `FeishuChatService.consume/start/drive/close` 与 `ChatJournal`：可选 native chat 复用/持久化会话，按 authenticated sender + host config 限制 planner tools；request journal 在处理前提交，已完成请求只返回保存的回复，中断为 uncertain 且不自动重放。宿主只拥有本入口创建的 agent handles；对话回复和 idle 不代表任务成功。`dsh-plugin.ts` 的渠道 inbox/outbox 与报告送达回执和 TaskLedger 的执行结果分开。
- N12 `packages/task-system/src/observer-dsh.ts` 的 native session projection、`ledger.ts` 的 `captureObservation/admitObservation/observe` 和 `planning.ts` 的观察提案：候选持久保存，manual 或可选 typed observe-only 收录只能新建 observed task / 追加 observation report，不派发。`packages/remote-execution/src/index.ts` 的 `observationForwarding` 显式工作区配置，`observation.ts` 的 `observationForwarder` 在传输前用宿主捕获的 cwd 做 realpath/root 校验；无匹配目录只留本地。远端转发与本地自动收录不得同时成为 authority。
- N13 外部运行证据仍独立：Feishu live 凭据/渠道、supervisor 实际安装、真实跨机器执行与真实模型调用未由本图验证。组合 boot / 原生测试以项目测试报告为准，不从静态接口推断生产已连通。

## 2026-10-01 执行实例协议更新

本轮同步目标架构、任务/报告 lifecycle 与 Before / Delta / After 对比。执行入口和生命周期转换明确显示实例绑定条件；卡片补充 native decision bridge、Feishu chat、按工作区观察转发以及受控执行。历史原图保持原字节。

三个 repository-draft.json 已按本轮 candidate 重建并重新定位源码行；`source-snapshot.json` 记录这些工作树文件的 SHA-256 和读取时间。它们只是本地读取快照，未提供或伪造 Git origin / commit / blob provenance。并行代码修订后仍需重新核实，不能将 source-snapshot 的文件哈希称作 Git commit。
