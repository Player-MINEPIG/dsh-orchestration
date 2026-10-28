# 调度器身份与按 Task 会话

本次扩展在现有认证、租约、fence 和运行结果协议上工作，不创建登录凭据，也不自动扩大 peer 权限。

## 身份

- 调度器的 `schedulerId` 由自己的 TaskLedger 持久保存，独立于监听地址
- 经现有认证并已注册的 executor 调用 `executorIdentity`，调度器在 RecoveryStore 为其分配稳定 `executorId`
- 同一调度器重连/重启保持 ID；同一旧 nodeId 在不同调度器获得不同 executorId
- 现有 nodeId 保留为内部认证和路由身份，不改写正在执行的 attempt/fence
- 执行器以 endpoint、audience、认证绑定、nodeId 保存调度器映射。同一绑定返回不同身份时拒绝继续；不能因为 URL 相似就当成同一调度器
- 身份查询不接收目标 nodeId，也不授予任何新能力或工作区权限。界面应显示调度器和分配所得 ID，而不是要求用户再填写一套 ID

## 默认工作区与会话

任务插件配置新增 `defaultWorkspaceId: string|null` 和 `sessionDecisionEnabled: boolean=false`，均为重启生效字段。工作区必须已注册、ready、归属于当前 node 且在其授予列表中；无效配置明确失败，不创建目录或推断路径。节点目录也支持 `defaultWorkspaceId`，使未指定工作区的路由在调度器创建 Run 时得到明确工作区。

优先级：Run 显式工作区 → Task 显式工作区 → 此 Task 已选会话的工作区 → 节点/执行器配置的默认工作区。Task 显式工作区不能被可选会话决策改写。

本地新执行默认复用当前 Task 已绑定的 session；首个执行才创建。映射保留 schedulerId、taskId、nodeId、workspaceId、sessionId。在另一调度器出现同名 Task 不会重用该 session。普通对话、观察历史、其他 Task 的会话不进入可复用目录。复用前检查真实 DSH session 的不可变 cwd。并发尝试不能同时拥有同一 session。safe retry 保持其原有权威 session 与工作区，不重新决策。

旧的纯文本、无任何工作区授予的配置保持兼容；它不会凭空获得文件访问。新连接应明确选择已有默认工作区。历史会话不会仅凭名字自动收编为 Task 默认会话；在升级后首次新执行建立映射，仍在执行的旧 attempt 按原绑定继续。

可选决策实际调用已有 typed-decisions 服务，不另建 provider。仅当 `sessionDecisionEnabled` 且该服务存在时请求有限 `session`/`workspace` 选择。普通结构化模型、Jev、兼容接口走同一消费合同。缺服务、错误或无效响应回到合法默认绑定；被取消、默认配置非法、连接授权失败不会伪装为默认执行。采用的回执在会话选择事务中、模型执行前写入事件。

## 连接升级与明确授权

远程配置保留兼容字段 `taskSessionsEnabled`：旧配置缺失时继续旧协议；新建连接应在授权已就绪时写入 `true`，不需要展示为长期产品开关。

在真实调度器启用前，操作者必须明确批准为指定 executor peer 增加以下操作，其他 workspace/capability/key/address grant 不变：

1. `executorIdentity`：查询并持久分配本 peer 在本调度器的 executorId
2. `sessionContext`：在自己的有效运行租约内读取本 Task、node 的可复用绑定
3. `selectTaskSession`：在自己的 executionId/fence 内提交合法工作区和 session 选择

随后在对应执行器连接写入 `taskSessionsEnabled:true`，选择已注册的默认工作区并重启相关插件。缺权限时身份/会话协商明确失败，不改成随机新会话绕过。重建/更换调度器存储后，旧 endpoint 的身份 pin 不会自动接受新调度器；需操作者确认新连接身份与数据迁移。

## Settings API

- `taskPluginSettings.describe()`：增加 schedulerId、defaultWorkspaceId、sessionDecisionEnabled；remote 内增加 executorIdentity（未查询为 null）、taskSessionsEnabled
- `taskPluginSettings.executorIdentity()`：无参数，向当前已认证调度器查询自身身份
- `taskPluginSettings.queue()`：无参数，本地只读快照 `{sampledAt,nodeId,items,truncated}`，最多 100 条；每项仅含 taskId、runId、title、state、sessionId、workspaceId，不包含 prompt、原始配置或凭据

远程队列显示本地执行 journal 和上次 polling 已发现的待处理项；查看设置不会额外触发调度或模型。快照时间表示本地读取时间，不能当作调度器刚刚完成网络刷新。


## 可保存的启动设置

新增 `taskPluginSettings.startup()` 返回严格裁剪的 task/remote 字段与 `applies: "plugin-restart"`；不返回凭据、环境变量引用、peer grant 或全量原始配置。

`taskPluginSettings.saveStartup({target,expected,changes})` 只接受 startup 结果中对应 `values` 作为 expected，以及明确允许字段的局部 changes：

- target=task：role、defaultWorkspaceId、planningDecisionEnabled、sessionDecisionEnabled
- target=remote：role、paused、endpoint、audience、pollIntervalMs、concurrency、taskSessionsEnabled、trustedNetworkTarget

每次只保存一个目标，expected 快照必须匹配当前可见值。保存使用公开 `Context.get('configEditor')` 与 `ConfigEditor.edit`，在宿主回调中合并当前完整配置，因此保留未知字段及未编辑的鉴权信息。CLI 层提前拒绝；Home/CLI 覆盖的最终判定、原子落盘与失败回滚由 ConfigEditor 负责。不能通过任意 namespace、nodeId、key、credential、grant 或原始 Config 绕过白名单。

保存会按官方 Loader 生命周期重启受影响插件。已有本地/远程 execution、claimed run、未定结果或待恢复 journal 时拒绝保存；写入期间暂停新 claim/native/remote admission，避免检查后又插入执行。界面应提示插件重启并在保存后重新读取，不把草稿值当成生效值。新 endpoint/auth binding 使用新的已验证连接映射，不沿用旧 endpoint 的缓存身份。

已有连接可编辑非秘密字段。首次连接仅允许在已选 trusted-network mode 且已有 configured nodeId 时，由用户同时明确保存 endpoint、audience、exact source/target；初始化保持 polling=0、nativeRoutes=[]，按新连接写入 taskSessionsEnabled=true。调度器必须已有该 peer 的认证和操作 grant，连接失败不会自行授权。此 RPC 不创建签名凭据、不切换 auth mode、不扫描或探测网络、不授予 peer；signed 首次连接仍需操作者配置现成 signing references。

决策等待期间已启动 native 与 remote lease renewal；返回后重新取得权威 Task/会话/合法工作区快照，用刷新后的绑定执行 CAS。过期选项回到仍合法的默认值。决策选过其他工作区后，后续无显式覆盖的 Run 继续使用该 Task 会话的真实工作区，不退回节点默认而破坏复用。

## 此增量的离线验收

修复反例和启动编辑相关 44 项定向测试通过；最终 task-system 248 项、既有离线 native/protocol 71 项均通过，构建与格式检查通过。测试仅使用自写 fixture、脚本化模型/网络边界及临时目录；真实 GUI 保存路径和真实 peer grant 启用由对应环境 owner 做授权验收。

`describe().schedulerId` 是本地 TaskLedger 的 authority ID；执行器展示上游调度器时应使用 `describe().remote.executorIdentity.schedulerId`，不要把本地备用账本 ID 误标为上游调度器。executorIdentity 未查询前为 null。


## Loader 已加载与远程连接暂停

远程配置新增 `paused: boolean`，默认 `false` 保留已启用旧部署的行为。`paused: true` 保持插件配置 fiber 存在，因此可以使用公开 ConfigEditor 保存；远程 `apply` 在创建 RecoveryStore、读取签名环境变量、初始化 client/listener/worker/poll/heartbeat 之前返回。不另设 connectionDraft 或第二个运行 owner。

- `startup().remote` 增加 `loaded` 和 `loaderDisabled`，`values.paused` 是连接暂停状态
- `describe().remote.paused` 标记远程运行是否暂停；暂停时 `polling=false`、队列为空、身份查询与执行入口返回 `REMOTE_PAUSED`
- 编辑连接字段时若仍 `paused=true`，保存只重载配置服务，不连接、不派活
- 将 `paused` 改为 `false` 是用户明确的“恢复/连接”动作，界面不能把它当成普通草稿保存；已有 active-work / unresolved-recovery 拦截继续生效

官方 rc.2 的 ConfigEditor 不支持 Loader-disabled 且没有 fiber 的条目。该场景现在明确返回 `STARTUP_REMOTE_DISABLED`，不会为了可编辑而偷偷启用旧连接。已有 disabled 配置需要操作者在保持原身份、grant 和其他字段等值的前提下先配置 `paused:true`，再显式加载插件。该一次性迁移不由本 RPC 自动实施；rc.2 无法用同一个 disabled-edit API 完成其首步。

真实官方回归：`DSH_OFFICIAL_ROOT=<现有官方rc.2安装目录> node --expose-internals tests/settings/disabled-remote-config-editor.mjs`。它在临时 profile 中复现 disabled-save 失败，证明公开 Entry.update 不持久保存 profile patch；再预置 paused 等值迁移，使用真正 ConfigEditor 保存 endpoint/concurrency，卸载重启读回，并验证全程无 remote journal/client/listener/worker/heartbeat。未配置连接的恢复被拒，文件和 paused 状态不变。测试不修改现有真实 profile。

## 调度与执行端独立的决策开关

- `planningDecisionEnabled: true` 是兼容默认值，只控制调度端 TaskPlanner；`sessionDecisionEnabled` 继续独立控制执行端 Session/Workspace 选择
- 两个字段均经 Task Config、`describe()`、`startup().task.values` 与 `saveStartup(target='task')` 暴露，保存按原普通配置生命周期生效
- 正式派发不调用 JEV。主模型通过 `task_nodes` 核对设备语义要求，再直接调用 `task_dispatch`；宿主保留确定性候选校验、授权与幂等落账。
- 明确 route/nodeId 和项目/工作区约束优先。省略节点表示接受授权池通用调度，按就绪、可用容量、稳定节点 ID 排序，项目队列保留同池备用顺序。离线或忙碌候选按既有队列等待，不重跑已开始工作。
- 执行模型沿用节点 policy；用户明确模型原样保留，不支持该模型的泛池节点被排除，明确节点不支持时返回具体错误。
- 工作区与会话按授权目录和 Task 绑定确定，不调用 JEV。独立定时发生使用新会话，重试/恢复沿用既有绑定。

### 自然语言任务与优先派发

用户只提供任务描述时，会话先决定本地处理或正式委派。委派时通过 `task_nodes` 查询能力、模型和健康状态，再直接调用 `task_dispatch`，提供稳定 commandId、标题和完整说明。涉及特定设备或文件位置时由主模型明确 nodeId；仅通用工作可省略节点接受授权池分配。没有另一个规划模型重复判断任务目的、是否落账和执行者。

中央宿主仅向具有当前项目协作绑定、活动 dispatcher 职责或宿主项目／临时任务统筹职责的会话增加优先派发提示。普通未绑定会话不默认承担调度职责，仍可按用户请求使用公开的绑定与派发工具。普通协作会话退出项目后移除此提示；仍有活动 dispatcher 时保留至该职责结束。已绑定会话恢复后按持久状态重新判断。此提示要求：已授权的执行任务优先交给合适的执行端，简短对话可本地回答；无法形成合法分配时说明具体缺失条件。提示不加入 Task 拥有的工作负载 Agent。执行模型来自节点 policy 或用户明确的 executionModel/route。

飞书原生入口允许 task_nodes 作为 operator 的 plannerTools。宿主仍需配置 taskIntegration、operatorUserIds 和 plannerTools；模型只看到该入口实际允许的工具，普通发送者不会因提示获得调度权限。

新 Run 的可选 `workspaceConstraint` 固定明确 Task/Run/Schedule 的 workspace。执行端候选和权威 selectTaskSession 同时验证它；自动补全的执行端默认/已有 Task session workspace 不标为约束。继续旧 Run 只保留已有 constraint，不倒推来源。该字段是原 claim 数据中的兼容可选字段，没有新增操作或 grant。

ExecutionRoute.workspaceId 类型本来可选，newRun 可从明确 Task、已有 Task session 或该节点已登记的 defaultWorkspaceId 补全。远程 gateway 仍要求领取前存在具体授权 workspace；若节点没配置合法默认且任务无明确工作区，应补配置后派活，不能让调度模型代选。

本次检查：44 项核心定向测试（含两开关四组合的真实 native 接线）、随后全部 266 项 task-system 与 71 项离线 native 回归通过；官方 rc.2 ConfigEditor 真实临时 profile 保存 planningDecisionEnabled=false 并重启读回，同时 executor session 开关未改变。未调用真实模型或更改真实连接、凭据、peer grant。
