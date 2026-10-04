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
- T08 迟到证据与取消：过期 lease 或取消后的报告可作为历史证据；不得逆转权威终态。unknown/uncertain 不自动当失败后重跑；只有受信本机终态日志的早先就绪证明可经专属恢复门提交，不能变成普通迟到结果的豁免。
- T09 查询与导入：私有 dashboard 只消费相同 TaskLedger/query 或明确导入的任务快照，显示 source observedAt 与 stale 状态；不得新建第二本权威账本，不得把新闻/AI feed 当任务。
- T10 渠道：Feishu 作为 DSH channel 可独立对话，Task System 的报告送达是可选集成。通知 outbox/receipt 与任务结果分离；未知外部送达结果不能宣称 exactly-once。

## 新代码核实记录

以下为本次工作树的静态源码检查，尚不能代替固定提交 provenance、测试或生产验证。实现仍在并行修订，因此以下使用可检索符号导航，固定行号留待真实 origin 和最终提交后补核。repository-draft.json 是初稿证据引用，尚未最终固定，不可作为当前提交证明。

- N01 `packages/task-system/src/ledger.ts` 的 `TaskLedger` constructor / `command`：SQLite WAL / synchronous FULL；command ID、内容摘要和 receipt 在同一 BEGIN IMMEDIATE 事务保存，冲突回滚。
- N02 同文件 `newTask` / `newRun` / `validateRoute` / `claim` / `owned` / `bindSession`：稳定 task、独立 run 与 attempt；route 校验角色/能力/模型/effort/workspace；lease/fence 与 session 绑定。`markRunning` 通过 `command` 原子写入首个 executionId；`owned` 与 `acknowledgeCancellation` 拒绝不同实例继续操作。同节点身份不能替代实例所有权。
- N03 同文件 `report` / `appendReport` / `registerArtifact`：reportId 不覆盖；previousReportId 关联修订；工件同 task 且 finalized。报告、正文、来源与 artifactIds 追加保存。
- N04 同文件 `submit` / `cancel` / `recoverExpired`：结构化 settlement 决定 run 状态；通知 intent 同事务写入；取消阻止后续权威结果写入，普通过期 lease 执行归 uncertain；受信本机终态日志的 recoverSettlement 另核实早先就绪证明。停止请求与已确认停止必须区分。
- N05 同文件 `updateTemplate` / `createSchedule` / `fireSchedule` / `history` / `snapshot`：版本化模板；interval 或 cron + timeZone，skip/queue overlap、once/skip/all misfire 与 occurrence 去重；history/snapshot 从同一本账本查询。此处是当前实现检查，不等于所有生产时区/错过调度情形已实测。
- N06 `packages/task-system/src/dsh-plugin.ts` 的 `apply` / `TaskSystemService` / `NativeExecutionProvider.drive`：native 注册服务/tools，加载配置，恢复过期尝试，绑定卸载清理；localNode / remoteNodes 从显式配置建立节点记录；markRunning 绑定实例后才创建/恢复自有 agent。flush session、等候 idle 后提交 staged task_settle，success / partial 还要求后代 allSettled quiet window；该最终门也在核心 TaskLedger.submit 内检查，remote adapter 不能绕过。没有结构化提交只记 unknown；维护循环处理 due schedules，可选 autoExecute 受 maxConcurrent 限制。工具白名单取 node 配置与 task policy 交集，文件路径校验失败即拒绝；shell 默认不开放，trustedUnconfinedTools 必须显式启用。
- N07 `packages/remote-execution/src/index.ts` 的 `apply` / `RemoteExecutionService`：挂载 taskSystem ledger，默认 signed 模式使用宿主 webServer 可选 route，trusted-network 显式模式使用宿主拥有的专用 HTTP carrier，卸载时 drain（见 N32）；`worker.ts` 的 `ExecutorWorker.executeOwned` / `deliver` 先获 lease、检查 workspace，再保存 dispatch intent，随后 markRunning 原子绑定 executionId；绑定成功后才创建 session / 调用 provider。`store.ts` 的 `RecoveryStore` 持久化非秘密 instance UUID，`executionId` 由此身份与 attempt 派生，独立恢复日志不能复用另一实例所有权。续租 / bind / submit / cancel ACK 携带同一实例身份；重试只送已有结果，uncertain 不重跑 provider。`NativeExecutionProvider.executeExternal` 只拥有本机 agent、返回结构化结果；所选认证模式核实的 remote worker 拥有远端 lease 与 settlement（两种模式见 N32）。
- N08 `packages/typed-decisions/src/index.ts` 的 `TypedDecisionService` / `apply`：注册独立 service；rules-only 不依赖 task ledger。`task-policy.ts` 的 `buildTaskDecisionRequest` / `consumeTaskDecisionReceipt` 只返回提案并要求消费者最终授权检查。新 `packages/task-system/src/planning.ts` 的 `TaskPlanner.plan/apply` 读取权威 catalog、调用决策、复核 snapshot，再经显式 authorize 和账本事务应用；`packages/typed-decisions/src/dsh-completion.ts` 的 `DshCompletionService.complete/run/close` 提供可选 native 单次模型桥接，通过宿主 llm.prepareCall 发出无工具请求，限制 route / effort、输入输出、时长和并发；卸载取消 active calls。modelVersionSource=configured-pin 是运营配置，不是供应商版本证明。真实模型调用仍需外部运行验证。
- N09 `dashboard/server.mjs` 的 `createDashboardHandler` / `main`：注入 snapshot callback 提供只读 HTTP 数据；本地入口以 readOnly 打开同一 TaskLedger。`public/model.js` 的 `validateSnapshot` / `sourceIsStale` 校验来源与过期窗口。站点部署与真实数据导入需分别确认。
- N10 `packages/task-system/src/workspaces.ts` 的 `WorkspaceManager.provision`：实际创建或复用受控 root 下目录、拒绝 symlink/path escape、保存创建请求 marker；`ArtifactStore.put` 保存内容地址工件并校验 digest。目录创建不是新 task，也不自动执行 Git 初始化或远端仓库创建。
- N11 `packages/feishu-channel/src/dsh-chat.ts` 的 `FeishuChatService.consume/start/drive/close` 与 `ChatJournal`：可选 native chat 复用/持久化会话，按 authenticated sender + host config 限制 planner tools；request journal 在处理前提交，已完成请求只返回保存的回复，中断为 uncertain 且不自动重放。宿主只拥有本入口创建的 agent handles；对话回复和 idle 不代表任务成功。`dsh-plugin.ts` 的渠道 inbox/outbox 与报告送达回执和 TaskLedger 的执行结果分开。
- N12 `packages/task-system/src/observer-dsh.ts` 的 native session projection、`ledger.ts` 的 `captureObservation/admitObservation/observe` 和 `planning.ts` 的观察提案：候选持久保存，manual 或可选 typed observe-only 收录只能新建 observed task / 追加 observation report，不派发。`packages/remote-execution/src/index.ts` 的 `observationForwarding` 显式工作区配置，`observation.ts` 的 `observationForwarder` 在传输前用宿主捕获的 cwd 做 realpath/root 校验；无匹配目录只留本地。远端转发与本地自动收录不得同时成为 authority。
- N13 外部运行证据仍独立：Feishu live 凭据/渠道、supervisor 实际安装、真实跨机器执行与真实模型调用未由本图验证。组合 boot / 原生测试以项目测试报告为准，不从静态接口推断生产已连通。

## 2026-10-01 执行实例协议更新

本轮同步目标架构、任务/报告 lifecycle 与 Before / Delta / After 对比。执行入口和生命周期转换明确显示实例绑定条件；卡片补充 native decision bridge、Feishu chat、按工作区观察转发以及受控执行。历史原图保持原字节。

三个 repository-draft.json 已按本轮 candidate 重建并重新定位源码行；`source-snapshot.json` 记录这些工作树文件的 SHA-256 和读取时间。它们只是本地读取快照，未提供或伪造 Git origin / commit / blob provenance。并行代码修订后仍需重新核实，不能将 source-snapshot 的文件哈希称作 Git commit。

## 2026-10-01 确认、协作与任务包迭代

以下符号已在本轮读取；精确文件哈希与读取时刻记录于 source-snapshot.json。设计图保持 system-description 范围，源文件哈希不替代 Git provenance。

- N14 确认门：`ledger.ts` 的 `invalidateConfirmation` / `setTaskConfirmation` / `confirmationAllows` / `claim` 使用 confirmation revision。需要确认的任务在新 run 或意图变更后重新 pending；可信操作入口须带 expectedRevision。该方法没有模型审批工具；`packages/feishu-channel/src/dsh-plugin.ts` 的命令/回调路径先校验鉴权身份与 revision，再调用批准/拒绝。typed proposal 和模型自然语言均不能代替批准。
- N15 优先级与独立收录：`ledger.ts` 的 `pendingRuns` 按 userImmediacy、urgency、task createdAt、run createdAt 排序，importance 独立存储；`setTaskAdmission` 用 admissionRevision 切换 admitted/dismissed。收录视图不改执行状态，不是批准、取消、清除历史或停止已排队执行。
- N16 排队备注：`note` / `queueTaskNote` / `queueScopedNote` 先追加 kind=note 的报告并保留 actor；`newRun` 在同一事务中核实原报告、把未消费备注放入 contextNotes，并标记 consumedByRunId。备注是任务数据，不扩大配置/权限；待处理数量和 run context 都有界。
- N17 委派与资源：`newTask` 继承并约束 allowedNodeIds / allowedWorkspaceIds / allowedTools / runtime / requiredResources，检查 maxChildren、maxDescendants 和 maxDepth；`claim` 检查节点 maxConcurrent 与资源占用，`newRun` 拒绝单槽节点上祖先占用导致的委派死锁。`submit` 对 success / partial 在事务内再次校验后代 allSettled 与 settlementQuietMs。
- N18 跨节点协作：`packages/remote-execution/src/collaboration.ts` 的 `bindCollaboration` 捕获 executionId + lease，提供 delegate / history / wait / note / report；调用者不能重写父任务或所有权字段。`ledger.ts` 的 `scoped` / `delegateTask` / `scopedHistory` / `scopedAllSettled` / `queueScopedNote` / `appendScopedReport` 限制为当前任务及其后代，并重新检查有效 lease。HTTP 操作映射、peer 权限与字段检查在 `gateway.ts`；native adapter 通过这些 ports 返回权威数据。
- N19 可选 Task Pack：`packages/task-system/package.json` 导出 task-pack、task-pack/plugin、task-pack/readers 子路径，源码在 `examples/legacy-task-pack/`，由 `scripts/build-task-pack.mjs` 打包。`index.mjs` 的 `createLegacyTemplates` / `registerLegacyTaskPack` 挂载结构化 contract 与可信同步语义校验器；模型不能注册/替换校验器。`plugin.mjs` 的 native `legacy_report_prepare` 要求 exact owned attempt，只准备报告，随后通过 task_settle 提交。`prepareLegacyReport` 保留 binding / builder input、生成并核验 finalized artifact；核心 `report` 在 settlement 事务中检查实际工件字节。`registerLegacyRenderers` 按 schema 注册 Feishu renderer，仅从 ledger-owned report 重建正文/卡片并复核工件，准备、结算和投递仍分离。
- N20 可配置 readers：`examples/legacy-task-pack/readers/common.mjs` 的 `createSourceScope` 要求显式 export root、realpath 范围及有限文件/字节/行数量；`readers/index.mjs` 导出 Codex/Hermes 日报、Game/AUTO-MAS 等读者。输入路径/规则由配置选择，不扫描推测私有安装路径；来源缺失与成功读取的零记录区分。真实历史导出、跨节点覆盖和外部投递仍需独立验收。
- N21 大负载限制：`packages/remote-execution/src/protocol.ts` 的 `byteLimit` / `MAX_WIRE_BYTES` 为 request / response 提供独立上限，默认 64 KiB / 128 KiB，可配置到 16 MiB；client、HTTP carrier、gateway 与 recovery receipt store 都保留界限。支持增大限额不表示无界读取或无限历史返回。


## 2026-10-01 运行安全与维护中 Task Pack（revision 6）

本轮更新覆盖当前本地源码的设计关系，仍不把图形门当作运行验收。下面的符号导航已在 SOURCE FREEZE 后重定位；source-snapshot.json 记录冻结读取的精确文件字节，而非 Git 对象证明。

- N22 独立 native 终态日志：`packages/task-system/src/native-result-journal.ts` 的 `NativeResultJournal` 使用独立 SQLite 文件、WAL / synchronous FULL 与有界容量，保留 ready/held/committed/rejected；满容量拒绝写入，不淘汰旧结果。`dsh-plugin.ts` 的 `NativeExecutionProvider.drive` 在 idle、session flush、结果预检、owned handle dispose 后写 `results.ready`；`TaskSystemService.commitResult/recoverResults` 只重放已经就绪的精确 settlement。`ledger.ts` 的 `recoverSettlement` 保留同 command ID 内容摘要，校验 session、executionId、当前 attempt、取消、readyAt 位于 lease 范围及 24 小时恢复窗口，随后重新执行权威结果/后代门。该日志不打开/锁定权威账本，也不是第二个任务 authority；任意外来报告不能使用专属恢复接口。
- N23 运行时工具批准：`approval-bridge.ts` 的 `apply` 观察 native tool/call 与实际 validated arguments，只处理显式 reviewable tools，并绑定 scope、session、agent、call、executionId、参数摘要和过期。`ledger.ts` 的 `offerApproval/respondApproval/approvalStatus/cancelApproval` 记录一次批准/拒绝，Feishu 路径通过认证用户与带摘要的回调消费。bridge 仅返回 allowed-once/rejected/cancelled，不扩展已有工具/文件 guard；过期、取消、实例变化或闭包结束不能复用批准。它与任务 confirmation revision 分开，不把自然语言或模型提案当批准。
- N24 节点健康与 Alerts：`ledger.ts` 的 `recordNodeHeartbeat/nodeStatuses/reconcileNodeHealth/raiseAlert/setAlertState` 保留 authenticated-peer 或 host-local 来源、freshness、available slots、dedupe/revision/cycle 与确认/解决状态；`dsh-plugin.ts` 的宿主 tick、remote `index.ts` 的可选 heartbeatNow 提供实际采样。默认 providerStatus 为 not-probed，runtime online 不证明 provider 网络/账号可用。告警目的地为空、healthAlerts 关闭，实际采集和推送需显式配置。
- N25 运行因果范围：`Task/Run.parentRunId`、`ledger.ts` 的 `executionScope/inferParentRun/checkExecutionBudget/newTask/newRun/delegateTask/allSettled` 为每轮执行绑定子执行和未启动占位，沿祖先 run 检查 fanout/descendant 限额；稳定 Task 的历史周期不耗尽当前 run 的后代预算。权限继承、任务历史范围、深度、节点容量和资源占用仍分别核实；成功/部分成功仅在当前 run 的后代 quiet window 通过后收束。
- N26 生命周期通知：`ledger.ts` 的 `lifecycleDelivery` 按 task+destination 保存一次创建锚点，每个本轮终态产生依赖锚点的 delivery；`feishu-channel/src/dsh-plugin.ts` 的 `deliveryReply/renderLifecycleDelivery` 校验同 task、目的地、锚点类型和成功回执，再以真实 message ID 回复。未知外部送达保持 uncertain，不通过新消息自动绕过锚点；run 结果和送达结果独立。lifecycleDestinations 默认空。
- N27 Task Pack 源读取与执行端预检：`examples/legacy-task-pack/configured-sources.mjs` 和 `plugin.mjs` 仅接受配置注册的 source IDs 与任务允许的范围，native receipt 绑定具体 attempt/execution。`index.mjs` 的 `registerLegacyTaskPack` 在 executor-preflight 核实非 root 报告的 prepared envelope；`dsh-plugin.ts` 的 `validateOutcome` 对 authenticated foreign claim 做纯预检，不查询另一本本地 ledger 当 authority。root prepare 留在 authority host，校验本轮 expected node 证据与 finalized artifact；来源缺失/partial 保留，不伪造完整覆盖。
- N28 维护中 readers/业务配置：Task Pack 提供 Codex/Hermes 日报读者、AUTO-MAS / Game readers、`ad-hoc.mjs` 的 included-turn 工作摘要、`diagnostics/index.mjs` 的有界 26 小时诊断与 `compatibility/index.mjs` 的显式 legacy 解析。诊断只读授权导出与宿主提供的进程 inventory，不自行发现安装、枚举或控制进程。读者结果经过可信语义校验，历史 fallback 不能代替当前权威执行。具体覆盖与 live pending 以 `docs/PARITY.md` 64 项 outcome 映射为准。
- N29 可选 quota：`examples/legacy-task-pack/quota/plugin.mjs` 默认 enabled=false；仅显式 providers、存储路径与已有 credential-variable 名称或显式 ECS role mode 可启用。固定 read-only provider 请求、精确 decimal metric 与私有 SQLite/JSON 快照由宿主生命周期管理；未授权时不读凭据、不访问 provider。已知暂态读取有限重试，崩溃 pending 保持 unknown。planner/both 可把 sanitized failure 接入 TaskLedger Alerts，executor 须 localOnly；quota 指标独立保存，不构成第二本任务账本，也不推断 per-task cost 或 gross spend。

本轮冻结读取时工程没有 Git origin；当时 HEAD 为初始本地提交，新增/修改工作树不能冒充该提交 blob。随后本地提交也不自动提供真实 origin 或远端 blob 验证。最终快照由 SOURCE FREEZE 协调确认；浏览器仍受环境 socket 限制，没有重新尝试、绕过或伪造通过。

- N30 两种有限续跑证据：`native-retry.ts` 的 `NativeRetryObservation` 跟踪同一 live session 的连续序列、准确 request-error/step/terminal，默认接受 zero-tools witness。显式 `safeRetry.resumableTools` 才允许 completed-tools witness：每个 call 的运行时 dispatch 参数摘要一致、每个成功 result 唯一指向该 call，且全部早于相符暂态错误；最多 32 个调用，idle/flush/dispose 后才形成证明。`dsh-plugin.ts` 的 `resumableTools/resumeBoundary` 取宿主与 run 配置交集，同 session 恢复后拒绝历史成功的 name+argumentsDigest 精确重放；`ledger.ts.retryBeforeEffects` 保存证明、累计已完成摘要、有限次数/退避与总运行预算。缺省 maxRetries=0、resumableTools=[]；未知或未闭合副作用仍须显式 reconcile。它不承诺任意 shell 或参数改写后的语义等价调用 exactly-once。remote retry schema 仅验证证据形状，最终授权与预算仍由 coordinator 核心拥有。


## 2026-10-02 安全错误回传（revision 7）

- N31 `packages/task-system/src/dsh-plugin.ts` 的 `NATIVE_ERROR_CODES`、`NativeExecutionProvider.observeTerminal/missingResultSummary`：只观察本次真实 owned agent 的同一 session 对象产生的公开 `turn/end`，从 error reason 提取固定 allowlist 错误码（如 NO_ADAPTER、MISSING_CREDENTIAL），其他码归 RUNTIME_ERROR；非错误终态清除旧码。local drive 与 external native 路径都调用同一摘要函数。缺少因果 task_settle 时保留 outcome=unknown / run uncertain 语义，不把错误分类当结构化失败/成功或新增重试授权；已有有限重试证据路径另行适用。摘要不复制原 error message、cause、headers 或 credentials，不从他人 session 或旧日志推断原因。本轮图仅追加卡片说明，节点、关系和几何均不改；runtime 实测与 provider 配置验收由独立回执负责。

本轮 SOURCE FREEZE 的包版本为 Task System / Remote Execution / Feishu 0.1.1，Typed Decisions 0.1.0；Feishu 仅 peer 依赖相容调整。版本号与图形门不代表现场已经使用新包。冻结后记录真实本地文件哈希，继续明确区分 Git 对象来源门、浏览器门与运行验收。


## 本轮追加的可选 trusted-network 设计

以下新增授权设计已按 SOURCE FREEZE 后源码重读；图形不构成运行或 live 验收：保留默认 signed+TLS；增加显式 trusted-network v2，把实际 socket 来源精确 IP 映射至固定 peer node/role/operations/workspaces/capabilities。专用 HTTP carrier 由宿主挂载，限制明确 bind IP/port、Host/Origin；客户端显式 source IP 并校验实际 target。两模式均保留 nonce、command receipt、lease/fence 与权限门。generic trusted-network 不把 Tailscale 产品写死；IP 库存由运营方冻结配置，不随网络发现自动扩展。仅在网络允许列表的其它设备不自动获得应用 peer 权限；通用产品和架构图不内置私人 IP。源码与包版本已按最终冻结读取，哈希在 source-snapshot.json。

- N32 已核实冻结工作树的认证/传输路径：`remote-execution/src/trusted-network.ts` 的 `validateTrustedNetwork/networkPeer/TrustedNetworkVerifier` 要求显式 allowHttp、非 wildcard 字面 listen IP/port、逐个精确 allowedAddresses 以及唯一 source IP→nodeId peer 映射；actual socket 的 local endpoint 与 remote address 都核对，不把只在网络名单里的设备当 peer。v2 trusted-network envelope 无 signature/keyId；固定 peer 的 role/node/audience/operations/时效与既有 workspace/capability/lease/fence 门继续核实，跨模式不能静默回退。`http.ts` 的 `httpHandler/startTrustedNetworkCarrier` 先核对 socket，强制单一精确 Host、拒绝 Origin 和 Forwarded/X-Forwarded-*，只收固定 POST route/JSON/有界字节。`network-client.ts` 的 `validateNetworkTarget/trustedNetworkFetch` 要求字面目标 IP/port 与显式 localAddress，连接后验证真实 socket 再发 body；不经 DNS、proxy env、redirect、pool 或 fetch substitution。`index.ts.apply` 的默认 ed25519 分支仍复用宿主 webServer/TLS；显式 trusted-network 分支挂载专用 carrier 并随 service drain/close，不另启 daemon。`client.ts` 绑定 auth mode、目标与 source 配置到 outbound recovery receipt，旧 pending 不能跨模式或目标重用。trusted-network 使用 HTTP 并依赖运营方已提供的可信网络，不宣称应用层签名/TLS；Tailscale 是可选部署环境，库存快照不动态授权，新包不内置私人 IP。

同一来源 IP 上的设备进程共享 trusted-network 应用身份；本模式不调用 Tailscale WhoIs、不动态认证成员关系、不提供独立进程/密钥身份。地址重新分配或信任变化需运营方更新快照；默认签名模式可保留独立密钥身份。根 README / docs/SECURITY.md 同样说明这些边界，架构图不代替网络部署验收。
