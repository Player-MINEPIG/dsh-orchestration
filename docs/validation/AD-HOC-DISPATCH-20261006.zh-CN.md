# 未指定执行模型的自然语言派发验收

用户场景：给调度端发送任务描述，不明确指定执行端、供应商、执行模型或思考强度。调度模型需要知道自己能调度其他执行端，并优先派发合适的执行任务。

实现：planner/both 的普通会话在原生 systemPrompt 中获得调度提示；Task 拥有的执行 Agent 不继承这段提示。task_nodes 除采样健康状态外，返回可见节点的角色、能力、模型/强度目录和工作区标识，执行端及 Task Agent 仍只查询自己的节点。task_plan 说明用户无需给 route，先 propose，再用同一 requestId apply；apply 本身创建 Run，不重复调用 task_run。参数说明区分决策调用覆盖项与执行路线，workspaceId 只承接用户明确约束。

规划决策的执行端描述增加能力及模型信息。任务收录提示明确：用户要求执行并提交结果时，即使只执行一次，也需要可追踪 Task；忽略对话时不能同时选择执行路线。飞书原生入口允许 operator 配置 task_nodes；实际可见工具仍由 taskIntegration、operatorUserIds 和 plannerTools 决定，没有开启真实飞书连接。

## 真实成功证据

- 用户输入只要求计算 39+58、提交短中文报告和标记 ORCH-ADHOC-20261006-97；没有指定执行端、模型、强度或工作区。
- VPS 真实调度会话收到 task_nodes、task_plan、task_query，实际调用 task_nodes → task_plan propose → task_plan apply，四步结束。不是测试脚本直接调用 TaskPlanner 来代替会话模型。
- 真实结构化决策 answered，选择 mbp-executor / deepseek-official / deepseek-flash；记录的输入没有 route，也没有 decision provider/model/effort 覆盖项。apply 创建一条 Run，无手工 createRun 或路线替换。
- 生成的 route 没有 reasoningEffort。MBP request/header 记录实际解析为 high，adapterDefaults.reasoningEffort=true，验证未指定强度沿用执行端模型默认。真实会话决策 answered。
- Task `2eb7efee-11c6-454b-b79a-cf4c11190d62`；Run `04e1cdae-d213-4239-9fe3-ed859a99c281` succeeded，只有一条 attempt 和一份 result 报告，算式及标记正确。MBP RecoveryStore acknowledged，receiptState=succeeded。工作负载只调用 task_settle。
- 原生工作负载用量：输入 2,248，输出 188 token。这不是本轮所有模型调用的总量；调度、决策、诊断和宿主自动标题另有调用。

可分享证据为同目录 `AD-HOC-DISPATCH-20261006-checks.json`；完整私有运行记录、覆盖层、错误诊断和日志在 `.runtime/ad-hoc-20261006`。

## 诊断与收尾

首次脚本模块路径错误发生在模型调用前。之后发现同路径、同版本 tarball 被安装缓存复用；最终改用唯一包文件地址，并读取已安装源码确认新调度提示、节点目录和收录提示实际生效。旧提示的两次 ignore/dispatch 矛盾回执保留，校验没有派发它们。

默认 high 的决策调用在较小输出上限下出现 native-stream-incomplete；保留失败回执，将测试输出上限提升到有界 8,192 后 answered。没有自动重试或静默改路线。

MBP 直连官方 API 的 TLS 连接被 reset，产生没有工具调用的 uncertain 测试运行。成功验收使用 VPS loopback 上只允许官方 DeepSeek Messages 路径的临时 TLS 转发，经 SSH 连接供 MBP 模型请求使用；执行过程、工作区、会话与 task_settle 仍在 MBP 原生运行。临时覆盖层最初遗漏原凭据引用，又产生一条调用前 MISSING_CREDENTIAL；按原完整模型配置修正后成功。两条无工具副作用的 uncertain Run 都在检查会话、确认执行停止及 ACK 后复核为 failed，未盲目重放。

成功后停止 VPS 测试 Host、临时出口与 SSH 通道，移除 VPS 临时凭据引用，恢复两端原 profile 配置；本机 GUI Host 在 remote.paused=true、空队列下继续运行。没有 queued/running/uncertain 的活动 Run。两端保留已核对的新 Task 包，真实报告及负例证据保留；原 workbench WIP 未修改。

验证：Task/remote/chat 相关回归 304 通过、0 失败、1 个既有 fixture 跳过；原生回归 71 通过；最后参数说明及节点作用域定向回归 27 通过。编译和差异检查通过。网络测试在解除 loopback 绑定限制后验证。

范围：真实拓扑是 VPS 调度 → MBP 执行，仅配置一个物理执行端；两个执行端候选及不同模型/强度选择由真实 DSH Loader、AgentLoop、工具和账本的离线模型边界测试覆盖。没有声称真实多节点择优、生产可靠性或飞书网络连通已通过。实际持续使用需要可用模型规划配置、远程连接恢复及 MBP API 出口连通；本轮仍按测试范围恢复暂停。
