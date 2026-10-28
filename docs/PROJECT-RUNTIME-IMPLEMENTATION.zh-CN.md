# 项目入口后端与手机任务闭环

已确认的 C 版现已挂载在官方 DSH「项目与任务」侧栏入口，项目、任务、执行、报告及节点状态读取原有测试 SQLite 账本。项目根目录、项目会话和派发候选顺序也存在同一账本中。原型示例数据不进入此入口。

## 使用路径

1. 打开「项目与任务」→ 项目设置，填入调度端上的绝对目录。
2. 新建项目，填写名称与目标。宿主创建 `project-<UUID>` 子目录、`PROJECT.md`、`TOOLS.md`，以及以该目录为 cwd 的持久初始统筹会话。创建项目本身不调用模型。
3. 进入项目详情，再打开项目对话。向统筹端说明工作，不必提供执行模型或路线。
4. 统筹模型看到 `task_nodes`、`task_dispatch`、`task_query`、`task_history`、`task_wait`。主模型对特定设备明确 nodeId 或目录中的 route；通用工作由宿主按授权池的就绪和容量分配，执行模型沿用节点默认或用户明确选择，工作区仍受项目约束，也没有文件或 shell 工具。
5. Task 先登记，候选执行端顺序持久保存。宿主依次检查授权、心跳、可用槽位；可以接单才创建 Run。全部不可用时保留 Task 的 `inbox` 状态，页面显示「待派发」，后续心跳自动触发派发。派发后未领取显示「待领取」。
6. 执行端使用自身已授权的本地工作区和原生任务会话，提交 `task_settle` 后回传真实结果。纯 planner 的 VPS 不能接受或执行工作负载；其身份限制同时作用于路线校验和领取。

`inbox` 表示已收到但尚未处理的任务，不是等待发送消息的通用名称。协议待发送消息通常属于 outbox；它与 Task、Run、Attempt 的生命周期分开。界面的「等待开始」筛选包含待派发与待领取，具体任务卡和详情区分二者。

VPS 项目目录保存轻量统筹上下文。它不会被当作远程执行端的目录约束，也不会自动接收重型工程文件或运行产物。执行端通过原有工作区授权选择本地目录。

## 模型配置归属

| 层级 | 配置及作用 |
| --- | --- |
| 调度会话模型 | 调度端 `task-system.projectAgentOptions` 指定 provider、model、reasoningEffort、maxTokens，用于理解项目消息和调用派发工具。 |
| 决策模型 | 调度端 typed-decisions 与 native-completion 配置，负责从候选目录中选路线与备用顺序。它与统筹会话模型可以不同。 |
| 执行候选目录 | 调度端 `remoteNodes` 描述每个执行端允许的 provider/model/effort；项目路由有明确思考强度时必须选中其中一个，不提供可能超出声明范围的供应商默认强度选项。 |
| 执行约束与 API | 执行端的 `coordinator.nativeRoutes`、工作区授权、本地模型服务与凭据配置共同校验和执行 Run 中选定的路线。API 凭据保留在执行端。 |

节点配置没有声明任何思考强度的模型仍使用供应商默认值；若要固定强度，应明确声明候选值。已开始的历史执行不会被新配置重写。

## 派发与恢复边界

- 候选是已注册、已授权的执行端，不会因为模型建议而新增授权。
- 离线、暂停、忙碌或者已不符合授权的候选会按顺序跳过；恢复上线后继续等待中的工作。
- 创建 Run 的命令代次先持久化，再提交账本，避免宿主中途退出后重用已取消的派发命令。
- 领取前失联超过 15 秒，且没有任何 Attempt 的 queued Run 可以取消并回到待派发，再检查候选顺序。已有 Attempt 或结果不确定的执行不会自动换节点重做。业务失败保留真实失败，需检查原因后明确重试。
- 执行端心跳只表明运行服务可用，不等于提前验证 API 能调用成功。
- 暂无合适注册候选时任务仍可登记，但不会自动扩大候选或授权；新增执行端后需要重新规划候选。
- 配置 `requireConfirmation: true` 时仍保留原有操作员确认门槛。当前自动闭环测试沿用原配置的默认 `false`，不是由模型自行批准任务。
- 同一 commandId 与相同内容可幂等重放；同 ID 不同内容拒绝。消息中断会明确标记，宿主重启不会擅自重放已经发往模型的消息。

## 会话整理

「整理并继续」在同一项目工作区建立下一统筹会话，保留目标、账本中的未完成任务、已完成报告引用及最近 16 条可见对话（最多 24,000 字符）；任务和执行 ID 不变，原始会话仍在历史中。会话切换期间阻止并发发送。返回按钮回到 C 版任务中心并保留项目和状态筛选。

当前是依据真实账本的确定性整理，尚未接入 memory-manager，也不承诺对整段长历史进行模型审查。重要的长程约束应保存在项目目标中。新会话下一次响应时会注入交接内容；原始历史不会被删除。

## 状态颜色契约

颜色只由状态决定，状态框、选中边框、任务标签、图节点边框和提示共用同一组 CSS 变量。选中筛选保持原状态颜色，额外显示同色边框；不增加“当前筛选”提示文字。

| 语义状态 | 颜色 | CSS token / 适用位置 |
| --- | --- | --- |
| 正在执行、当前、信息提示 | 蓝 `#7CA4EF` | `--status-running`：running/current/info；执行中任务、节点、选中状态框及信息提示。 |
| 待确认、警告 | 琥珀 `#D3B686` | `--status-review`：review/warning；有 `pending_user` 审核状态的任务及其结果。 |
| 等待开始、待派发、待领取、已暂停、已归档、已处理、取消中、已取消 | 灰 `#A1A1A1` | `--status-queued`：queued/paused/archived/handled/cancelling/cancelled；inbox 和 queued 的等待投影、灰色虚线节点边框。 |
| 已完成、执行成功、在线、已启用、成功提示 | 绿 `#91B9A4` | `--status-done`：done/success/online/enabled；completed/succeeded 的成功投影、报告来源节点与成功提示。 |
| 需处理、失败、受阻、结果不确定、部分完成、审核未通过、错误提示 | 红 `#E58F8F` | `--status-error`：error；failed/blocked/uncertain/partial/rejected 的异常投影以及错误提示。 |
| 尚无心跳、离线/过期、暂停/未就绪、已禁用 | 灰 `#A1A1A1` | 节点不可用状态投影到 queued；详情保留具体原因，避免把离线误报为任务执行失败。 |

Task 待确认与 Run 已执行成功是两个不同字段：任务/结果可为琥珀色待审核，同时实际 Run 为绿色成功。领取前取消的旧 Run 保留灰色已取消记录，回到待派发的 Task 显示灰色；这不是同一状态换颜色。

形状与颜色正交：项目为六边形，任务为圆角矩形，执行为平行四边形，产物入口为折角文档。项目详情图当前显示各任务最近一次执行及结果报告；完整面板保留所有执行历史，结果报告作为图中的产物入口。既有 artifact、milestone、schedule 记录在完整面板中读取，当前入口尚未提供这些对象的完整编辑器。

## 验收与测试入口

真实验收在既有 candidate-3 测试环境完成，保留原有测试数据库、API 和工作区授权，不迁移生产库。手机入口是同一个 VPS 私有 HTTPS WebUI 的 `/#tasks`；也可从 DSH 侧栏进入「项目与任务」。临时登录 token 不写入代码或本文，服务重启会更换 token。

- 手机尺寸模拟 393×852：配置目录、创建项目、发送离线/在线消息、查看真实报告、独立项目筛选页、C 版返回路径、项目内节点图以及统筹会话 1→2。
- 桌面 1440×900：两张项目卡的 grid gap 为 20px；项目详情节点图和页面宽度正常。
- 第一项先离线登记为 inbox，没有 Run/Attempt；上线后同一 Task 执行成功并 ACK。中途误加确认门槛已恢复原值，该测试任务按用户已给的小规模执行授权作一次操作员确认；另一个领取前失联 Run 已取消且没有 Attempt，没有重复运行。
- 第二项在执行端在线、原默认确认配置下由手机页面提交，自动创建、派发、执行、回传报告并 ACK。
- 前两项原生请求使用 DeepSeek Flash 的供应商默认 high。验收发现该默认值超出声明的 off 后，已修正项目候选列表为显式强度，并用第三项 43+58=101 验证修正后的 off 路线：原生 request/header 确认 off、任务成功、结果报告回传并 ACK。

具体 Task、Run、Attempt、Report、决策 receipt 和 ACK 见 [验收证据](validation/project-runtime-20261006-checks.json)。

用户自行测试时，先在本地执行端任务插件启动配置开启「暂停远程运行」并保存重启；从手机新建/进入项目、发送一项任务，应显示待派发。再关闭该开关并保存重启，让同一任务自动完成。随后保持在线再发新任务。只关闭本地自动执行并不会暂停远程轮询。交付时本地测试执行端保持暂停，VPS 调度接口保持运行。

## 异常、确认与关闭事项

任务中心排列为：需处理、待确认、执行中、等待开始、取消中、已完成、已处理、已取消。历史归档事项在完整任务列表保留。

- 待确认有两种明确标签：「待批准执行」使用「批准执行」；「待审核结果」使用「审核通过 / 审核不通过」。审核不通过进入需处理。审核接受部分结果不会把部分完成改为完整成功。
- 需处理表示失败、受阻、部分完成或结果不确定。已终止且结果明确的异常可「标记已处理」，并可「恢复到需处理」。这是关注状态，原 Task/Run/Report 的执行事实保留；新执行或新证据出现时旧处理标记自动失效。
- 「取消任务」终止后续派发并禁用任务计划；未领取的执行立即取消。已领取的执行先显示取消中，直到执行端确认停止或实际结束。取消后的普通结果提交沿用原账本的取消校验，不会把任务重新打开。
- 结果不确定不会被「已处理」隐藏。取消后显示「取消待核实」；用户确实核实执行端停止后，可点击「确认执行已停止」并勾选核实声明，再转入已取消。
- 这些按钮仅属于已登录操作员页面，不暴露为模型工具。操作使用账本命令去重和状态版本校验，避免旧详情误操作新执行。

「重新尝试派发」对原执行已失败或受阻且安全结束的任务开放，包括没有项目归属、没有旧候选记录的任务。它保留同一 Task、旧 Run、Report 和关注记录，重新评估已授权候选目录，按新的推荐顺序检查授权、心跳和槽位；只有执行端可接单才创建新的 Run。离线时保留待派发。按钮始终可见，运行中、待领取、结果不确定、待确认、部分完成等状态显示禁用原因。重新规划和入队之间仍做账本版本校验，取消或新执行发生后拒绝过期操作。

按钮版本回归为 622 项通过、5 项跳过、0 项失败。真实 VPS 手机页面验证了标记已处理、恢复到需处理和未派发任务取消；数据库确认处理标记没有改写原失败执行，也没有创建新执行。批准、审核、运行中取消及继续派发条件由集成测试验证，详见 [按钮验收记录](validation/task-actions-20261007-checks.json)。

## 2026-10-07 独立决策设置交付

MBP 已安装 task-system `project-runtime-15` 与 typed-decisions `settings-6`。DSH 仍在 `127.0.0.1:3082`，profile 为 `executor`，节点 `mbp-executor`，remote paused=true；默认决策保留 Rules，任务消费者 binding 已恢复为空。当前受控进程记录为 `.runtime/project-runtime-20261006/mbp-decisions-18-host.json`（PID 81744）。停止时使用此记录，不能再使用旧的 runtime-13/14/15/16/17 进程记录。沿用原测试数据库和用户凭据。

新增 **设置 → 决策** 独立入口，支持预设、Rules 规则集新建/编辑/移除/导入/导出及连接检测。任务页分别选择执行者决策和会话/工作区决策的预设。其他插件使用 `typedDecisions.presets()` 取得 ID/名称，并把自己选择的 ID 放进 `DecisionRequest.preset`；详细使用说明在 typed-decisions README。

真实 GUI 留下 `DeepSeek 决策测试` 预设（`preset-486d0d20`，deepseek-official/deepseek-flash/off）和未被任务引用的测试规则集 `rules-gui-smoke`。两次小型 API 探针都返回正确候选答案，耗时 891 ms / 1006 ms；没有派发工作任务。任务绑定选择/保存/恢复以及规则导出后重新导入已验证。探针结果是页面内带时间戳的检测记录，刷新或切换页面后须重新检测。

390 px 手机宽度下，原 DSH 侧栏将内容挤到 101 px；已对决策和任务设置页调整为上方导航，内容宽度 341 px，scrollWidth 同为 341 px。状态色沿用任务面板原契约，具体表见 `packages/task-system/docs/settings-ui.zh-CN.md`。最终回归 638 通过、5 跳过、0 失败；证据见 `docs/validation/decision-presets-20261007-checks.json`。VPS 仍为之前的部署，本次安装目标是用户当前测试的 MBP。


## 2026-10-07 独立源码仓库与设置内边距

决策插件构建脚本已移入自身 `scripts/build-settings.mjs`，声明完整的开发依赖和独立 lockfile；Loader 测试通过相对构建入口加载自身，避免借用工作区的包链接。

本地独立 Git 仓库：`.runtime/dsh-typed-decisions`，提交 `d311f83`；源码 ZIP 和 Git bundle 分别为 `.runtime/dsh-typed-decisions-source.zip`、`.runtime/dsh-typed-decisions.bundle`。GitHub 可见性尚待用户选择，未创建远端仓库。原工作区中的包保留用于现有任务插件集成。

把源码复制到父仓库之外 `/private/tmp/dsh-typed-decisions-isolated-20261007`，仅根据自身 lockfile 安装 15 个依赖，构建、40 项测试与打包均通过。安装包包含独立配置页面及 MIT LICENSE。

MBP 更新到 `typed-decisions-settings-7.tgz`；task-system 仍为 project-runtime-15。当前 PID **84189**，启动记录 `.runtime/project-runtime-20261006/mbp-decisions-19-host.json`，沿用同一 profile、启动参数和 3082 端口。VPS 本轮未更新。

设置页 main 桌面 padding 从 4px 改为 24px，手机从 0px 改为 16px；卡片统一 16px。真实浏览器桌面测量 body/scrollWidth 均 564px；390px 手机视口中的 iframe body/scrollWidth 均 341px，无水平溢出。截图 `mbp-decision-padding-desktop-19.png`。

规则仍为五个必填字段：questionId、questionVersion、path、equals、answer；本轮未改动规则编辑交互，路径、值和答案仍使用 JSON。README 已补充字段表、答案格式及零命中/多命中语义；尚无调用插件提供的 GUI 问题/候选项目录。

本轮工作区 `npm test`：456 项，455 通过、1 跳过、0 失败。独立仓库测试 40 项全部通过，Git bundle verify 与 diff whitespace 检查均通过。


## 2026-10-07 嵌套规则卡片与表单编辑

决策设置的 rule set 采用单列卡片，每张卡的“编辑规则集”在本卡内展开；内部规则以子卡片呈现，“展开编辑”也在子卡内显示表单。收起保留未完成输入，说明到按钮有 16px 间距。摘要展示可读答案，不显示 JSON。路径逐段增删，匹配值通过类型控件编辑，支持嵌套对象和列表；答案有选项、0～1 数值、评分、放弃四种控件。导入导出继续自动读写原 schemaVersion=1 文件，不要求用户手写 JSON。

完成规则编辑只更新草稿；直接“保存规则集”也会提交当前展开的表单。重复字段名、非法数值等在表单内给出提示。导出只导出保存版本；保存仍由已有配置服务验证并重载决策插件。

本地独立仓库已同步，提交 `8b8e30d`，原源码 ZIP / Git bundle 均更新。父仓库之外构建及 45 项独立测试通过；工作区回归共 461 项，460 通过、1 跳过、0 失败。

MBP 最终安装 `typed-decisions-settings-9.tgz`，当前 PID **16285**，记录 `.runtime/project-runtime-20261006/mbp-decisions-21-host.json`，同一 profile、补丁、端口 3082；task-system 仍为 project-runtime-15，执行端身份与暂停远程运行不变。VPS 未更新，本轮没有模型 API 调用或任务派发。

真实 UI 创建并保存了无预设引用的 `rules-form-smoke`，一条 form-probe/v1 规则，path=[flags]、equals={enabled:false,items:[3,"3"]}、choice=new，版本 ce9586538fba2414。重读保留所有类型；重复对象字段阻止保存。旧 rules-gui-smoke 版本 11bc6e78be0a3059 保持原样。

390px 手机视口中 body/scrollWidth 均 341px，子规则卡宽 273px，无横向溢出；没有手写 JSON 标签。截图为 mbp-nested-rule-cards-21.png 和 mbp-rule-form-controls-21.png。完整证据 `docs/validation/decision-rule-forms-20261007-checks.json`。

### 2026-10-07：MBP 决策预设卡片与 API 凭据管理（settings-11）

- 本地服务沿用 executor profile、127.0.0.1:3082；启动记录 `.runtime/project-runtime-20261006/mbp-decisions-23-host.json`，PID 32478。远端执行仍暂停，默认 Rules/default 与既有 DeepSeek 预设均未改动。
- 预设编辑嵌入原卡片，收起再展开保留未保存草稿；16px 内外间距。390px 视口下 iframe 实测 clientWidth/scrollWidth 均为 341，无横向溢出。
- Typesafe / compatible API 在插件内管理独立密钥，存入宿主私有 credentials 服务；配置与公开快照不含密钥。密钥轮换下一次调用生效，配置更新失败恢复此前密钥。
- UI 新建未绑定预设 `preset-9db460de`（Typesafe Jev/jev-1.13.0），未填写密钥，未设为默认。缺少凭据的检测在预检返回，不发外部 API 请求。方便用户直接在该卡片配置自己的密钥。
- 47 项决策插件测试全部通过；独立复制到 /private/tmp 后 build/test 同样通过；工作区 463 项测试，462 通过、1 跳过、0 失败。初次沙箱运行的 loopback listen EPERM 在允许本地端口的重跑中消失。
- 已查证 AnyJev（training-free Decider）、notjev（Node 单 token/logprobs）、jevper（Python 多读出方式）；未安装模型、未部署推理服务、未声称当前适配器已经接入它们。AnyJev 当前 `/v1/decide` 与 notjev 的附加字段及不同 confidence 公式均需专门适配。
- OpenAI Decisions API 在官方 DevDay 页面宣布；本次官方 developer docs 检索未定位请求/响应合同，未虚构接口。
- 截图 `.runtime/project-runtime-20261006/mbp-nested-presets-23.png` 与 `mbp-api-credentials-23.png`。

### 2026-10-07：浅色主题与 notjev backlog

notjev 按用户要求暂不接入，已记录到 `packages/typed-decisions/BACKLOG.md`；有实际插件用户及需求反馈后再评估。

决策设置与任务项目页面移除固定深色，初始配色及后续变更跟随 DSH 的浅色/深色/系统外观。主题消息仅接受各自 iframe 的父页面，不重载内容、不消费业务 RPC 响应。表单、嵌套规则/预设卡、对话、详情、节点图与提示使用语义色；浅色/深色状态对照表在 `packages/task-system/docs/settings-ui.zh-CN.md`。手机设置导航明确采用横向滚动，避免宿主默认 column 挤占内容。

真实 MBP DSH 验证浅色、深色及系统外观；390×844 下决策内容宽度和 scrollWidth 均为 341 px，导航高 45 px。调度端任务中心/图使用仅显示的示例数据检验，手机 graph 为纵向布局且正文宽度与 scrollWidth 均为 390 px；未授予本机调度端身份。完整工作区回归 465 通过、1 跳过、0 失败；独立包 49 项全通过，最终主题/项目专项 6 项全通过。

MBP 最终安装 typed-decisions settings-13、task-system project-runtime-17，DSH PID **40717**，启动记录 `.runtime/project-runtime-20261006/mbp-decisions-25-host.json`。沿用 3082、executor profile、补丁及测试数据库/凭据；外观已恢复跟随系统。VPS 本轮未部署，未调用真实模型或派发任务。独立仓库本地提交 **750c80b**，源码 ZIP 与完整历史 bundle 已更新。证据见 `docs/validation/light-theme-20261007-checks.json`。


### 2026-10-07：单滚动条、预设按钮间距与独立部署验收

MBP 3082 已安装 typed-decisions settings-14、task-system project-runtime-20，PID **47333**，记录 `.runtime/project-runtime-20261006/mbp-decisions-26-host.json`。保留 executor 身份、现有 API 凭据／预设／数据库及远程暂停状态；VPS 未改动。更新经用户明确允许后完成，原服务按原启动参数恢复。

预设选择到保存按钮实测 12px。决策 iframe 使用 main 实际高度向上取整并加 2px，内层 overflow:hidden，外层宿主设置容器负责滚动；本机 DOM 实测仅一个可滚动祖先。展开／收起预设编辑实测 1397→921px，不再保留过高的旧视口尺寸。此次新验收使用桌面 Chrome；没有新做物理手机／Safari 验收。

决策依赖未安装或被禁用时，两处开关关闭且禁用，并提示安装启用 @dsh-task/typed-decisions 后刷新；预设入口隐藏。后台也拒绝开启请求（STARTUP_DECISION_REQUIRED）。快照新增 task.decisionAvailable；原已保存的开关不静默改写。

两个独立的官方 DSH CLI profile 分别只装一个 npm 包，确认另一个包／服务不存在。决策侧通过真实 ConfigEditor 保存规则、预设并重启保留，规则选择和 GUI 校验成功；GUI 编辑预设也显示保存成功。任务侧项目工作区／PROJECT.md／统筹初始会话创建成功，默认会话策略不依赖决策插件，使用项目工作区和明确路由的原生任务通过 task_settle 成功结算。模型仅使用测试桩，没有付费 API 请求。任务发布包已内置所需纯校验代码，修正此前可选 peer 仍被运行时静态导入的问题。独立 profile 仅为临时本机测试，不替换既有 3082 配置。

工作区 npm test：470 项，469 通过、1 跳过、0 失败。父仓库以外的决策源码 build/test：50 项全通过。独立决策仓库提交 a5ab702，源码 ZIP 与 Git bundle 更新。完整证据见 `docs/validation/layout-standalone-plugins-20261007-checks.json`。


### 2026-10-07：VPS 同步最新插件与连接排查

按用户要求，VPS candidate-3 的官方 planner profile 已更新到 task-system project-runtime-20 与 typed-decisions settings-14，和 MBP 保持一致。由原 systemd 单元 dsh-orchestration-web.service 重启运行，PID **1964193**；仍为纯 planner/vps-planner，autoExecute=false、schedulerEnabled=false，未赋予执行端身份。原测试数据库、模型配置、API 凭据及项目目录未改动。升级前配置与三份 SQLite 备份在 `/opt/dsh-task-management-test/candidate-3-ece68974/backups/settings14-runtime20-20261007`。

检查开始时原服务仍在运行（PID 1240082，NRestarts=0），3082 与 18440 均监听；MBP 的身份检验在升级前成功。升级后曾复现一次 CONNECTION_TIMEOUT（检验固定 5 秒期限），随后界面身份检验成功。另做三次完整身份协议请求，耗时 736／728／724ms；固定源地址 TCP/HTTP 路径也正常。超时的具体根因尚未确定，不能归因为持续服务中断；没有因此引入自动重试或改变超时配置。

原 entities 的各类型计数全部保持一致，项目／会话／派发记录计数保持一致；WebUI 能展示原任务和报告。真实 HTTPS 浏览器已登录并验证新版独立决策页、单滚动条和调度端设置。重启后新的临时登录入口保存在私有运行记录中，不进入仓库。任务协议地址仍为 `http://100.123.230.75:18440/dsh-task/v1/commands`，WebUI 仍是原 Tailscale HTTPS 10000 入口。

此次无模型 API 请求、无新任务派发；MBP 执行端远程运行仍暂停。证据见 `docs/validation/vps-update-20261007-checks.json`。


### 2026-10-07：临时任务工作区、独立规划对话与安全重试（runtime-22）

任务中心新增「临时任务」入口，汇总没有项目归属的原任务。详情可进入该任务的独立规划对话。会话在既有 `pr_settings.root` 下的 `temporary-tasks/task-<digest>` 保存轻量上下文，没有新增普通用户项目、执行工作区授权或调度设置管理会话。会话首次打开不调用模型；规划工具限定在既有 task_nodes/task_dispatch/task_query/task_history/task_wait。规划的 taskId 由宿主绑定，模型不能选择另一任务、另填路线或创建同名任务。已失败任务的重新执行须使用操作员重试入口，模型对话不能绕过此门槛。

原 `pr_sessions.project` 与 `pr_turns.project` 列迁移为 `owner`，既有项目和原生会话 ID 保持不变；临时任务归属存在独立 `pr_adhoc` 表。规划输入采用真实项目 ID 或明确的 taskId，不把临时任务标识传入 Workbench 的 projectId。已应用的同任务规划收据在重启时恢复派发候选；旧失败记录没有候选也可经新重试重新评估。确认按钮在评估期间禁用，防止重复请求。

真实 VPS 上两个原任务：
- 95：`9993d86e-0107-43bc-9239-69c98267beab`，旧失败 Run `188ba175-278e-4e04-90ba-d4f2d54edccd`。点击一次重新尝试派发后，推荐 `mbp-executor/deepseek-flash/off`，当前 inbox/待派发，generation=0；没有新 Run 或 Attempt，等待用户恢复执行端。
- 96：`65de1ab9-dd49-48d8-860f-355b3816fe81`，旧失败 Run `912b0aae-a136-4d3d-9eff-df5f4514f5e5`。仍保留 waiting/需处理，重试按钮可用。

两项均已有不同的持久临时规划会话；最终 VPS 重启后映射和原 ID 保持不变。Task 总数仍为 9，普通项目没有增加。原 Run、Attempt、Report、Decision、关注记录在最终重启前后内容一致。95 原先没有结果报告，没有把旧失败伪造为成功。

最终安装包 `task-system-adhoc-runtime-22-20261007-b.tgz`；typed-decisions 仍为最新 settings-14。MBP PID **73558**，启动记录 `.runtime/project-runtime-20261006/mbp-adhoc-28-host.json`，executor/mbp-executor，远程运行 paused=true、autoExecute=false、schedulerEnabled=false。VPS PID **1992979**，原 systemd 服务、planner/vps-planner、autoExecute=false、schedulerEnabled=false；没有本机工作负载执行服务。两个环境的配置和三份 SQLite 已分别备份到 `backups/adhoc-runtime22-20261007`，原启动参数、API 凭据和授权保持。

最终全量测试 **477 项，476 通过、1 跳过、0 失败**；真实 SDK Loader/AgentLoop 与远程协议工具链 **71 项全部通过**。覆盖旧数据库列迁移、会话隔离、无候选恢复、离线候选排队、上线只创建一次新 Run、运行/不确定/待确认保护、规划期间取消的 CAS 拒绝、重复确认防护和项目原对话。模型测试采用现有脚本模型；VPS 实际重试调用既有配置的决策服务，没有开启 MBP 远程轮询。

Chrome 390×844 验证临时工作区、两项旧任务详情/对话、长标题按钮和浅色/深色主题；iframe clientWidth/scrollWidth 均为 334 px，外观恢复跟随系统，浏览器视口覆盖已撤销。原项目对话仍可返回任务中心。没有新增物理手机/Safari 验收。新手机登录入口已在同一私有 HTTPS WebUI 验证，URL 与二维码仅存于忽略的私有运行文件，本文和验收 JSON 不含 token。上次偶发连接超时根因仍未确定。

证据：[临时任务与重试验收](validation/adhoc-runtime-20261007-checks.json)。手机截图与详细测试日志在 `.runtime/adhoc-runtime-20261007`。


### 2026-10-07：执行端开关联动心跳与接单（runtime-23）

简单／高级设置共用正向「启用执行端」开关，替代隐藏在高级页中的反向暂停开关。切换立即使用既有 ConfigEditor 保存并重启远程插件。配置内部保留 paused 兼容旧部署，不引入可手动伪造的在线状态。启用时旧的零领取／心跳间隔恢复为 1000ms／5000ms，已有非零间隔保持；未配置授权执行路线时拒绝启用，不扩大工作区、模型或身份授权。纯调度端没有执行器，不因更新而承担任务。

连接检测仍只验证任务协议及身份，不发送心跳、不接单。启用后设置区显示等待心跳确认／最近确认时间／发送失败，刷新可读回；最近确认不保证心跳尚在有效期。关闭时停止新接单、排空现有实例，在最后一条正在发送的心跳完成之后发 runtimeReady=false。网络不可达时由调度端心跳有效期判定下线。运行中、已领取、状态未确认、正在通信等仍可能使配置编辑被拒绝，保存失败时开关恢复此前状态。

全量工作区回归 480 项，479 通过、1 跳过、0 失败；原生 DSH／远程协议回归 72 项全部通过。新增两宿主集成测试通过脚本模型验证关闭时可检测但不在线、启用后自动心跳并完成一次任务、关闭后立即不可用、重新开启不重复执行。验证模型边界是测试桩，没有付费请求。

MBP 安装 task-system-executor-switch-23-20261007.tgz，PID 83290，记录 .runtime/project-runtime-20261006/mbp-executor-switch-29-host.json。仍为 executor/mbp-executor，paused=true，保留用户离线／上线测试条件。VPS 安装同包，原 dsh-orchestration-web.service active，PID 2011848，NRestarts=0；仍为 planner/vps-planner。两侧配置及三份 SQLite 更新前备份到各自 backups/executor-switch23-20261007。VPS 9 个 Task、10 个 Run、9 个 Attempt、14 个 Report、12 个 Decision 内容与更新前一致，项目／会话／临时归属／派发记录保持。typed-decisions settings-14、预设与凭据保持。

真实 MBP 简单页开关可见且关闭，检测更新后的 VPS 成功，并明确显示连接检测不会开启心跳／接单。390×844 实测 document scrollWidth=390，无横向溢出，视口覆盖已恢复。VPS 新私有登录入口验证成功，token 只保存在忽略的私有运行文件。本轮没有派发现有线上任务；95 仍待派发，用户开启 MBP 后才恢复派发。没有新增物理手机／Safari 验收，既有偶发诊断超时根因仍未确定。

证据：[执行端开关与心跳验收](validation/executor-switch-20261007-checks.json)。


### 2026-10-07：项目中心导航、设置迁移与 GUI 新建临时任务（runtime-24）

项目中心顶部新增「任务」按钮回到任务中心；项目详情返回项目中心。项目父目录配置移入「设置 → 任务系统 → 调度端 · 项目工作区」，简单和高级模式都可见，执行端隐藏此项。原项目页设置弹窗和按钮移除。设置页实测保存成功，原 VPS 根目录保持不变，revision=2。

临时任务入口移到项目中心的独立区域；任务中心保留全局任务状态汇总。临时区沿用原任务列表、详情和独立规划对话，新增名称／完整指令表单及「创建并派发」。操作先幂等创建一个 Task、准备其规划上下文，再评估路线并持久排队；离线时不创建 Run。重复点击、响应丢失后的同命令重放不会重复创建 Task／会话／执行。决策缺失或失败时保留已创建任务，提示进入对话继续规划。调度端不执行工作负载。

已确认原项目创建包含独立目录、任务账本 Workspace、PROJECT.md／TOOLS.md 和原生会话，但缺少 DSH workspaceRegistry 登记。本次补上官方 registry.create(path,title) 与 attachSession，启动时登记已有 runtime 项目及其全部会话，新建和换代会话也挂入同一工作区。真实 VPS 侧栏已显示「手机闭环验收 20261006」，下挂原两代会话，ID／路径／历史保持。

目前两项项目中，「手机闭环验收」为有独立 VPS 工作区的 runtime 项目；「二游日常」是历史项目，仅关联 MBP 的 acceptance 执行工作区，没有 VPS 统筹工作区。本次保留其既有关系。实际目录为父目录/project-<UUID>，DSH 在该工作区下分组会话，原生日志由 sessionPersistence 保存；没有为每次会话创建物理子目录。临时规划目录为父目录/temporary-tasks/task-<digest>，没有新增普通用户项目。MBP 执行端仍使用本机已授权工作区，不自动复制调度端项目目录。

真实新建验收发现在线健康变化导致 request-snapshot-mismatch：决策请求中的候选说明含 health／slots，规划期间恢复心跳会让说明变化，虽然授权目录未变化仍拒绝收据。已保留请求提交时的健康说明用于推荐证据，继续校验当前目录、权限、TTL，并在真正接单时检查最新心跳与槽位。针对性测试验证恢复在线可以继续，授权被关闭仍拒绝。第一项未派发验收任务 ee94205b-b77e-43aa-827f-b2972e2dbea1 已取消，0 Run／Attempt，保留诊断记录。

最终手机 GUI 新建任务 7f417ee5-e7cd-430a-82b5-7d1c869dc53b，经 mbp-executor／deepseek-official／deepseek-flash／off 完成 7+8=15 并回传报告 3104077b-5217-4a14-b9c4-b126fa97ce17。仅一个 Run dd0111a9-dfac-49cc-abc5-0289f19bcf07、一个 Attempt 30ba3789-6a29-472d-bffd-f45d9d5325c8；执行端 dispatch=acknowledged。没有重复执行。报告通过返回列表再进入详情确认；现有详情打开期间不自动重绘。

最终包 task-system-project-center-24-20261007-b.tgz 已安装两端，typed-decisions settings-14 保持。MBP PID 98997，记录 .runtime/project-runtime-20261006/mbp-project-center-31-host.json，保留用户已开启状态 paused=false；VPS 原 systemd 服务 PID 2042952，纯 planner/vps-planner，autoExecute=false、schedulerEnabled=false。更新前配置和 SQLite 备份为两端 backups/project-center24b-20261007。升级前后已有 Task／Run／Attempt／Report／Decision 内容一致，实时心跳正常更新；随后仅新增上述单次验收 Task 和执行。最终 Task=11、Run=13、Attempt=12、Report=19、Decision=15，普通项目仍为 2，runtime 项目为 1。

工作区回归 487 项，486 通过、1 跳过、0 失败；真实原生 DSH／远程协议 72 项全部通过。Chrome 390×844 实测 iframe clientWidth／scrollWidth 均 334px，验证导航、临时表单、列表、报告和设置；视口已恢复。无新增物理手机／Safari 验收。新登录入口仅存于忽略的私有运行文件，不写入文档、Git 或验收 JSON。

证据：[项目中心与 GUI 临时任务验收](validation/project-center-20261007-checks.json)。


### 2026-10-07：执行端项目工作区与版本化派发协议（runtime-25b）

在「临时任务工作区、对话与重新派发」任务 01a114fe-a63a-7ca1-836d-9b070a05c163 完成并部署 runtime-24b 后实施。调度端创建 Run 时从 Workbench 固定项目身份、revision、名称、目标／说明及验收上下文，临时任务明确 project=null；执行端不能用调用方提供的项目路径或上下文替换权威快照。多个项目归属含糊时拒绝，子任务继承父 Run 的项目上下文。带新上下文的 Claim 要求 projectContextVersion=1，旧领取请求在创建 Attempt 前被拒绝；旧无上下文 Run 保持原路径。

执行端以原 route.workspaceId 的本地授权目录为父目录，按调度端身份／项目身份创建工作区；临时任务位于该调度端 temporary-tasks／任务身份目录。各任务拥有自己的原生会话，并通过官方 workspaceRegistry 登记，实际 session header.cwd 与持久映射一致。重试和继续沿用自己的 cwd，不迁移旧会话、不扩大根目录授权。普通同项目在一个 Worker 中串行，已有 Git 项目的新会话使用 detached worktree，保留原目录／文件，未做自动合并或大文件同步。目录拒绝未知既有路径、符号链接和越界。

手机尺寸浏览器从 VPS 项目对话发起「项目归属派发验收25」，任务 63afb891-5657-4886-84de-6c01d0b07248、Run 53ffd20f-a21f-4f47-aa2d-04b397a4ca9e、Attempt c76119a6-e161-44d1-949f-3ec422af7049，由 mbp-executor/deepseek-official/deepseek-flash/off 完成 8+9=17。报告 07f5d0ac-5e99-41e3-8a86-88bc277726bf 如实回传项目 5f71728b-0049-4e94-946e-5874ad4dadc0 的 ID／title；规划模型误称 name 字段，执行端没有臆造。项目 cwd 位于 MBP 本地 scheduler／project 层级，重启后侧栏仍挂载该会话。

这次真实项目验收还发现既有权限配置只允许最终提交和任务等待，但模型看到了辅助报告／历史／查询工具，三次调用失败；最终 task_settle 已正常成功。修复为 sessionContext 返回实际 availableOperations，原生模型工具按权限过滤，不扩大现有 grants。保留原失败诊断和历史报告。

25b 再从手机尺寸 GUI 创建「执行端临时目录验收25b」，任务 a9cbd15e-4908-43bb-98e7-10f2440d1d34、Run ee5c56e7-0185-4fff-8fd4-1e34fe67af0f、Attempt 3ac6c40e-7d1b-45b8-8da3-80899685cb25，在独立 temporary-tasks/task-… 目录完成 10+11=21，确认 project=null，报告 3ec1e08f-566e-4131-ac6d-584992186c6c。模型实际仅看到 task_children、task_nodes、task_settle、task_wait，并只调用一次 task_settle，0 工具错误；持久 dispatch=acknowledged。两项各有一个 Run／Attempt，纯 planner 没有执行工作负载；没有文件或 shell 工具调用。

最终包 task-system-executor-project-25-20261007-b.tgz 已安装 MBP 和 VPS，typed-decisions settings-14 保持。MBP PID 8422，记录 .runtime/project-runtime-20261006/mbp-executor-project-33-host.json，executor/mbp-executor，paused=false、taskSessionsEnabled=true；VPS 原 systemd 服务 dsh-orchestration-web.service active，PID 2074761，NRestarts=0，planner/vps-planner、autoExecute=false、schedulerEnabled=false。两侧升级前备份在各自 backups/executor-project25b-20261007；配置文件内容和其他插件依赖保持一致，任务／会话／项目／恢复映射保持，实时在线状态正常更新。最终权威账本 Task=13、Run=15、Attempt=14、Report=23、Decision=17，普通项目 3、runtime 项目 2。

最终 npm run check：工作区 494 项（493 通过、1 跳过）、原生 73 全通过、旧工作流 98 全通过、管理 18 项（14 通过、4 跳过），0 失败。针对实际两个原生宿主的脚本模型测试额外确认并发数 2 时同项目第二任务仍排队、不同任务会话隔离、同任务继续复用、临时 cwd、新协议旧客户端拒绝。Git worktree 和多调度端隔离使用本地测试夹具验证，未做真实重型并行代码任务。

Chrome 390×844 验证真实任务创建、回传报告及两端项目／临时任务侧栏。iframe clientWidth=scrollWidth=334px，视口已恢复；没有新增物理手机或 Safari 验收。当前私有登录入口仅在忽略的运行文件中，不写入 Git 或公开证据。详情需返回刷新后的列表再打开以查看新报告，这个既有界面行为保持。

协议：[执行端项目与派发协议](../packages/task-system/docs/executor-project-protocol.zh-CN.md)。证据：[执行端项目验收](validation/executor-project-20261007-checks.json)。

### 2026-10-07：公共临时执行工作区、工具预设与默认 high（runtime-28）

新建的执行端临时任务共用本机授权父目录下 scheduler-…/temporary-tasks 工作区，各 Task 有独立原生会话。同一 Worker 中共享该目录的任务串行；不同调度端仍隔离。DSH 侧栏统一显示「临时任务」，不再每任务登记一个工作区。既有会话 cwd 不可修改；按用户授权，归档「只是测试」和 25b 的旧测试会话、移除两个旧工作区入口，保留原文件、原日志和账本诊断。Hermes 数据库未访问、未修改。

「只是测试」首次远程执行只看见 task_children、task_nodes、task_settle、task_wait，没有文件工具；只调用 task_nodes 和 task_settle 就宣称完成。当时 test.md 没创建。之后浏览器普通会话使用 high 和完整工具，实际 write 生成文件，但已失去原 Attempt 归属，无法通过 task_settle 改写原任务结果。因此不能把首次失败归因于 off，也不能把第二次成功归因于 high：会话的工具组成同时改变了。

远端发送任务、路线及固定项目上下文，不传递浏览器的权限菜单。实际权限由执行端 executionTools、任务 allowedTools、远程操作 grants、文件边界及 DSH 权限机制共同限定。排查还发现原生执行直接创建 Agent，漏挂 DSH WebUI 会挂载的工具预设；只加白名单时 tools.restrict 因未知 read/write/edit 拒绝初始化。已通过官方 agentPresets 在限制工具之前挂载预设，新会话记录预设、恢复时沿用记录；无预设服务的独立宿主继续使用已加载工具。原生回归用真实预设注册服务复现了修复前错误，并验证修复后文件工具、共享 cwd 和同任务恢复。

MBP 任务白名单由空列表改为 read/write/edit，工作区根目录和远程 grants 保持。执行提示明确缺少必要工具时应 blocked，文件任务必须实际操作并核验。它仍是提示约束，普通未声明结果契约的 success 不等于自动产物校验；本次使用原生工具日志与磁盘独立验证。DSH 个别 scope-local 工具可能仍出现在列表中（本次 standard 预设的 subagent），但任务 guard 会拒绝未在白名单中的调用。

26 的第一次验收在模型执行前初始化失败，没有发布原生会话，没有写入；不确定运行没有自动重放。核实 MBP 停止后，通过官方 GUI 取消并确认停止，原诊断保留。27 加上预设后 off 实际 write/read 成功，但模型编造了 12:34:56Z，实际文件修改时刻为 09:19:13Z，时间验收未通过。28 在执行提示增加宿主 currentTimeUTC；该值是提示生成时刻，不是每个工具调用重新读取的系统时间。

用户随后要求不用 off、默认 high。现已将 MBP localNode 与 coordinator.nativeRoutes 的单一执行元组、MBP 模型决策预设默认值、VPS remoteNodes 的候选元组、projectAgentOptions 和 agent-default-model 默认值改为 high。能力声明中供应商真实支持的其它强度仍保留，不影响默认值。用户未提供路线时，决策从当前授权目录中选择并固定到新 Run.route；浏览器模型菜单不代替它。原有 Run 的 off 记录保留。

最终通过手机尺寸 GUI 新建两个未指定路线的真实任务：

- 写入任务「共享临时工作区文件验收28」：Task 8b8b56e7-bb99-42f4-b95d-f11a2dc0609b，Run b6bd78ec-832a-49fc-8cf7-98219bf36502，Session task-8239faff-a382-41b2-9adf-99eb575df68d。原生 request/header 确认 deepseek-official/deepseek-flash/high。第一次覆盖既有文件被 DSH 的 FS_NOT_OBSERVED 拒绝；模型读取后再写入、再读取，最终内容含 SHARED-TEMP-28-20261007 和宿主 2026-10-07T09:29:14.724Z。一次 Run／Attempt 内完成，没有自动重放。
- 读取任务「共享临时工作区读取验收28」：Task f949de5b-7664-4b67-bbc6-83de9c65976d，Run a8130003-4d34-400c-ad69-efd77d7db196，Session task-d7783ec2-7db4-47c5-a8f8-e1e73403f744。新会话同 cwd，原生请求 high，只调用 read、task_settle，报告回传同一磁盘内容，未写入。两项均 succeeded／acknowledged，每项一个 Run／Attempt。

最终两侧安装 task-system-shared-temporary-28-20261007.tgz；MBP PID 39918，记录 .runtime/project-runtime-20261006/mbp-high-default-37-host.json，executor、paused=false、taskSessionsEnabled=true；VPS dsh-orchestration-web.service active，PID 2127595、NRestarts=0，仍纯 planner，autoExecute=false、schedulerEnabled=false。升级备份分别为 shared-temporary26／27／28-20261007，思考强度修改前备份 high-default-20261007。凭据保持，已有工作实体保持，节点模型目录与实时心跳按新配置更新；只操作 DSH 测试服务。

最终 npm run check：678 通过、5 跳过、0 失败。Chrome 390×844 验证真实派发、high 路线和回传报告；MBP 侧栏实测同一个「临时任务」下有 27 写入、28 写入、28 读取三个独立会话。视口已恢复。未新增物理手机／Safari 验收。私有登录 token 只在忽略的运行文件中保存。

证据：[公共临时工作区与 high 验收](validation/shared-temporary-20261007-checks.json)。


### 2026-10-07：调度端容量入口与设置对齐（runtime-29）

设置 → 任务系统新增「调度端 · 执行节点容量」，简单／高级模式均显示已有 remoteNodes 的逐节点容量。通过原有官方 ConfigEditor 和 saveStartup RPC 保存并重启任务插件；只修改已有登记节点的 maxConcurrent（1–32），保留节点 ID、模型、工作区、权限及其它配置，不新增节点。已有 CAS、配置覆写与活动任务／不确定运行保护继续适用。执行端 concurrency 和本机自动执行 maxConcurrent 仍分别配置；共享工作区串行约束仍适用。实际 MBP 节点容量保持 1，未改变并行行为。

截图中的空白按钮实际为禁用「保存」，原生表单按钮的深色文字与覆盖后的深色背景混用，并叠加 opacity=0.4。已按主题文字令牌设置普通按钮及禁用态颜色。两列部署表 dt 误复用提示段落的 5px 顶部／12px 底部边距，现两列同为 margin=0、line-height=1.65，顶部偏差从 5px 变为 0。通用按钮边框覆盖原生 Switch，造成圆点上下和左右 1px 偏差；现排除 Switch，原生轨道／圆点保持上下居中，端点内边距 2px。队列表格单元格统一顶部与左侧对齐。

完整 npm run check：687 项，682 通过、5 跳过、0 失败。真实隔离 DSH ConfigEditor／Gateway 额外 5 项通过，验证容量 1→2 更新账本、插件重启和宿主重新启动后仍为 2，0 模型调用。Chrome 实测 VPS 容量输入草稿 2 启用保存、丢弃恢复 1；390×844 下设置 clientWidth=scrollWidth=337px。深浅色桌面验证保存按钮可读、所有可见开关圆点垂直偏差 0、只读两列顶部偏差 0。主题与视口已恢复。未新增物理手机或 Safari 验收。

已安装 task-system-settings-layout-29-20261007.tgz 到两端，typed-decisions settings-14 保持。MBP PID 64564，记录 .runtime/project-runtime-20261006/mbp-settings-layout-38-host.json，原 executor、paused=false 参数保持；VPS 同一 systemd 服务 PID 2196501、NRestarts=0，原纯 planner、autoExecute=false／schedulerEnabled=false 保持。升级前备份均为 backups/settings-layout29-20261007。两端历史工作实体保持，执行端既有 Dispatch 保持；实时心跳继续确认。私有入口仅存在忽略的运行文件。

证据：[设置布局与容量验收](validation/settings-layout-20261007-checks.json)。
