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

优先级：Run 显式工作区 → Task 显式工作区 → 节点/执行器配置的默认工作区。Task 显式工作区不能被可选会话决策改写。

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
