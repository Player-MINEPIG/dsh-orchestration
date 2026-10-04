# 任务互联：原二游日常的真机验收

本流程验证 **VPS DSH → MBP DSH → 文件 SQLite → 私有管理 WebUI**。准备脚本不启动替代 dispatcher，不调用 `claim/submit` 伪造执行，不注册虚拟节点。单元测试中的 synthetic 数据只测试检查器，不能作为真机证据。

## 1. 固定边界与部署前检查

- 原模板 `tpl_pc-au-game-daily-report`，schema `game_daily_report.v1`
- 原 producer basename 为 `scripts/auto_mas_daily_report.py`；本次脱敏导出保留 `${PC_AU_HERMES_HOME}/scripts/auto_mas_daily_report.py` 和 `manual_json_fallback=false`。不替换成猜测的 MBP home/路径
- schedule `pc-au-game-daily-report`，`0 6 * * *` / `Asia/Shanghai`：仅脱敏导出的验收定义 `enabled:false`。实际 source.originalSchedule 记录 `enabled:true/status:active/notModified:true`，原生产计划未被本流程修改；新验收库不创建任何 schedule
- VPS authority SQLite、VPS remote 协议恢复库、MBP task-system 本地库/native-result journal、MBP remote executor journal 各有独立路径。MBP 不共享或复制 authority DB 作为自身权威
- 新 UI 不接旧 VPS 8443；不动生产 Hermes、MBP 3098 Tavern、已有真实日报计划；不使用 `:memory:` 证明持久化
- 复用已核查的 DSH 0.2rc2 / Node 24+、既有 trusted-network 连接、真实节点、provider/model/effort 与授权 workspace；不编造 provider 或 key。凭据、网络安全、默认/生产配置变更另行确认

部署执行线先记录两端**实际** profile、节点 ID、模型元组、workspace ID/真实路径与允许工具、各数据库路径、已有网络端点和匹配版本。只在隔离验收 profile 安装/加载本次 task-system 构建，不能用测试 `ScriptedModel` 或自定义执行器代替真实 DSH native runtime。

两端 task-system 显式设 `schedulerEnabled:false`；authority 为 planner；关闭 `reportDestinations`、`alertDestinations`、`approvalDestinations`、`lifecycleDestinations`（均为空数组），不加载通知渠道。不要因缺失脚本而扩大工具/目录授权。原脚本在 MBP 不存在、日志不存在或模型不可用都应保留真实原因。

MBP remote 插件使用现有受信连接和真实 `coordinator.nativeRoutes`；真实插件负责 native worker 轮询。authority 的远程节点目录、已核对的 MBP workspace 记录必须来自真实设备配置；管理 Project–Workspace 关联不会 provision 目录或授予权限。允许既有 peer 的 heartbeat 操作后，需看到 `authenticated-peer`、`online`、`runtimeReady:true`。这些只证明 runtime 可达，不证明供应商调用成功。

## 2. 原条目导出契约

由 VPS 执行线只读导出原任务与模板，存到私有本地 JSON；不要从云端 SSH 读取。`--template-json` 接受以下**结构说明**，其中对象必须是实际导出/经过说明的字段映射，不能用示例任务替代：

```text
{
  format: "dsh-task-management-source.v1",
  source: { label: 原系统/设备来源说明, exportedAt: 实际导出时间 RFC3339 },
  task: { taskId: 已核实的原任务 ID, title: 原标题, description: 原要求 },
  template: {
    templateId, version, name, description,
    inputSchema, defaults, resultContract, resultValidator?  // 完整导出模板与适配说明
  },
  schedule: {
    scheduleId, taskId, templateId, templateVersion,
    enabled: false, cron: "0 6 * * *", timeZone: "Asia/Shanghai",
    input: 原计划输入对象
  }
}
```

模板必须是 TaskLedger 的完整 `Template` 结构。实际这份原库没有 version/inputSchema/resultContract 列：`version:1` 是本次 normalized export 修订号，inputSchema 是适配器输入，resultContract 是由原 Python 校验规则派生的结构 schema；不是声称原库原生存在这些字段。`source.normalization` 保留这些依据，taskId 保留已核实原 ID，标题/要求保留导出的软件级文本而非未导出的用户上下文。无法确定映射时先停止，不生成相似的新任务或猜值。导出不含凭据、API 配置或通知目的地。

脚本检查：模板/任务/导出计划身份一致；导出计划禁用；完整配置仍含原 producer 定义、`manual_json_fallback=false` 与原 schema ID。`Run.configuration.input` 严格等于 `schedule.input`，不合并 legacy defaults：实际 inputSchema 的 `additionalProperties:false` 只允许 format/timeZone/businessDate 等适配字段。defaults 中的 producer、历史源路由和策略原样保存在固定 Template，必要说明通过 note 进入上下文；实际执行 route 只来自已检查的 MBP 设置。placeholder/home、日志路径和共同业务日期未确定时不猜值，不制造 `--date` 参数。source.label 只是来源说明，不是身份认证。

本次 `resultValidator` 未注册，不能将结构 schema 通过等同于原 Python 语义校验通过。sidecar 保留 normalization、原生产计划事实和 contractReference 的模块、原声明 sha/bytes、entrypoint、规则等元数据，省略 sourceCode；脚本不执行 Python 字符串、不注册临时代码，也不把私有导出加入代码包。初次验收允许证明真实启动阻塞或缺脚本等失败；任何 succeeded/partial 游戏结果在未建立原语义校验证据时必为 inconclusive，不能宣称已验证日报。

## 3. 创建独立库，再由真实 DSH 注册执行设施

以下变量均由执行线填写已检查的实际值，不提供可误用的默认路径/节点。authority DB 的父目录须已存在且没有 symlink；MBP journal 是 MBP 上的独立绝对路径。

```sh
npm run build
node --test tests/management/acceptance.test.mjs
# 可选：只在持有私有导出的执行线上验证该实际 schema/映射；注册记录明确是单元测试 synthetic route，不执行工作负载
DSH_ACCEPTANCE_SOURCE_EXPORT="$ORIGINAL_EXPORT_JSON" node --test tests/management/acceptance.test.mjs

node scripts/task-management-acceptance.mjs init \
  --db "$AUTHORITY_DB" \
  --authority-node "$VPS_NODE_ID" \
  --executor-journal "$MBP_REMOTE_JOURNAL" \
  --label '独立二游日常验收库'
```

`init` 只接受从未存在的绝对路径，创建 file-backed SQLite 与 `<db>.acceptance.json`；重复运行拒绝，不会接管旧库。sidecar 固定 databaseId、标签、路径与文件身份；保留它，不把 sidecar 挪到另一份旧库旁冒充新库。

随后在两端的隔离 DSH profile 加载实际插件。authority 的 `task-system.databasePath` 指向刚创建的 `$AUTHORITY_DB`；MBP 的 `remote.statePath` 指向 `$MBP_REMOTE_JOURNAL`，其 task-system 本地库使用另一路径。已有协议恢复 journal 不可删除来重置执行身份。启动/停止沿用两端已核实的 DSH 管理方式，不启动旧官方交互 WebUI 做新系统验收。

检查上述真实注册和 heartbeat 后，再手动建立这一次 Run：

```sh
node scripts/task-management-acceptance.mjs seed \
  --db "$AUTHORITY_DB" --template-json "$ORIGINAL_EXPORT_JSON" \
  --node "$MBP_NODE_ID" --provider "$REAL_PROVIDER" --model "$REAL_MODEL" \
  --workspace "$REAL_WORKSPACE_ID" \
  --required-capabilities "$REAL_CAPABILITIES_CSV" \
  --allowed-tools "$REAL_ALLOWED_TOOLS_CSV" \
  --max-runtime-ms "$REAL_RUNTIME_BUDGET_MS"
# 仅真实模型要求时追加 --reasoning-effort "$REAL_EFFORT"
# 两个 CSV 参数均必须显式提供；已核实的空集合用 -，不是任意放权
```

脚本经业务 API 建立 Domain、Project、需求 Backlog、原任务在独立库中的副本、关系及固定模板版本的 Run。Task 保留原 ID 和导出的软件级标题/要求；来源与新库身份共同限定这份副本，不修改原系统的 Task。生成的仅是验收管理对象与本次 Run ID。附加一条明确标识的验收要求 note；它不是执行结果 Report。

seed 不创建 Artifact、Skill、假报告、计划或在线声明。已核实且新建的节点/workspace 仍由执行线配置；未注册、无认证心跳或 route 不匹配会在种业务数据前拒绝。完成 seed 后由**真实 MBP DSH remote native worker**自动发现、领取、运行、持久化会话并结算。重复同一 seed 命令复用幂等回执，不重跑任务；参数/来源改变时拒绝。中途失败后保留库与 sidecar，修复实际阻塞后重试原命令。进程异常留下 `.acceptance.lock` 时，先核查原进程确已停止，再由执行线处理锁；不要删除 journal 或换命令 ID 绕过不确定执行。

## 4. 新管理 UI 与双端证据

在 authority 机器上启动本仓库的管理 UI；只绑定 loopback，显式选择未占用的测试端口，禁止 8443/3098/18440：

```sh
node scripts/task-management-acceptance.mjs serve \
  --db "$AUTHORITY_DB" --port "$TEST_UI_PORT"
```

打开输出的 `/manage.html`。跨机器查看只使用已授权的既有访问方式，不由本脚本开公网端口或新增凭据。确认页面显示新 databaseId/标签/路径，并检查 Domain → Project → Backlog → Task、Run 的计划路由、Attempt 的实际 node/session/executionId、Report 和真实失败原因。截取新管理页，而不是旧 8443 看板。人工查看仍需本机执行线完成，API 检查不替代截图验收。

将本次 `<db>.acceptance.json` 通过已批准的私有传输复制到 MBP；**不要复制数据库替代远程连接**。MBP 在相同代码版本执行只读 journal 检查：

```sh
node scripts/task-management-acceptance.mjs journal \
  --manifest "$COPIED_ACCEPTANCE_MANIFEST" --journal "$MBP_REMOTE_JOURNAL" \
  > "$MBP_JOURNAL_EVIDENCE_JSON"
```

该命令不创建、不 recover、不清空 journal，只返回与本次 Run 对应的实际 dispatch/attempt/node/fence/session/executionId 和 acknowledgement 状态。journal 的 sessionId 可能只是预留标识，不证明 native session 已创建；启动前阻塞尤其不能据此宣称 agent 或 workload 已运行。将输出经已批准的私有方式带回 authority，保留 MBP 运行命令记录作为来源证据。证据 JSON 是本机检查输出，不是新的签名身份系统。

```sh
node scripts/task-management-acceptance.mjs verify \
  --db "$AUTHORITY_DB" \
  --ui-url "http://127.0.0.1:$TEST_UI_PORT/api/workbench" \
  --journal-evidence "$MBP_JOURNAL_EVIDENCE_JSON"
```

verify 重新只读打开持久库，核对管理关系、模板固定版本、通知/计划隔离、Task/Run/Attempt/Report；对比 UI 的同一数据库和实际结果；再比对 MBP journal acknowledged 身份链。原 VPS 计划的实际状态须由部署线在测试前后分别只读核对。此次来源明确记录原计划 active/未修改，只有验收定义 disabled；本脚本没有原库访问权，不对原生产计划执行暂停或启用。

- 退出 0 / `verified` + `evidenceKind:workload-report`：持久记录、UI API、MBP journal 对应，终态及实际 Report 齐全；`runState:failed` 是真实失败闭环，不能说日报成功
- 退出 0 / `verified` + `evidenceKind:system-pre-dispatch-block`：`runState:blocked`，`workloadExecution:not-started`。仅认可 core 持久化的 `run.pre_dispatch_failed` 事件，其 `origin=native-adapter`、`phase=before-agent-start`、`code=NO_ADAPTER`、provider/model、attemptId/nodeId 与实际受权 Attempt/route 一致；同时核对已结算的 executionId/fence、MBP acknowledged journal 和 UI 同一事件的具体原因。此时没有 agent Report，也不要求尚未创建的 native session；这是系统确认的启动前阻塞，不能表述为 workload 已执行
- 退出 2 / `pending`：仍在排队或运行。没有自动超时伪造失败，继续看真实 DSH 状态
- 退出 2 / `inconclusive`：例如 `uncertain`、普通执行缺 result Report、缺 UI/journal 证据，或 succeeded/partial 缺少原 Python 语义校验证据（显式报告 structural schema 不等于 semantic acceptance）。只有明确的启动前结构化证据才走上面的 blocked 分支；单凭 summary 中的 `NO_ADAPTER` 字样不能转换状态。进入 stream 后的 `MISSING_CREDENTIAL` 等失败仍保持 uncertain 和实际枚举原因；不要补造 Report、重分类 unknown 或手工 settle 来“通过”
- 退出 1：身份不符、错误库、配置隔离破坏、输入/权限/HTTP 错误等；先查阻塞

成功或失败执行不等于用户验收：Backlog 的 manual_check 不会自动标成通过，脚本也不提交人工同意。最终回传代码版本、双方 profile/真实路径清单、seed 的 taskId/runId、verify JSON、MBP journal 证据、实际存在的 DSH 会话/必要错误日志（启动前阻塞保留系统事件，不补造会话）和新 UI 截图；敏感配置与 keys 不进入交付。
