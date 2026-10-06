# DSH 自身 WebUI 的任务插件设置

DSH 自带 WebUI；入口是 `dsh web` 或 `dsh --profile web`。自定义名称的 profile 必须由 Web 模板创建，并且在同一 profile 安装任务插件，才会同时有聊天界面和插件管理入口。只有 base/headless profile 不会自动变成 WebUI。

本包的直接设置入口是：侧栏 **设置 → 任务系统**。原 **插件 → 已安装的 @dsh-task/task-system → task-system → 配置** 入口仍可使用；两处复用同一六字段表单和官方配置保存机制。浏览器伴生组件由同包的 `task-system-settings` 行提供。任务管理面板仍是 VPS 上独立访问的网页；此页管理插件运行设置和本机运行队列摘要；完整任务管理和数据库仍由各自的宿主持有。

## 可保存的设置

使用官方 `plugins.row.config`、`configForms` 和 `SettingsFormModel`。只有点 **保存** 才提交；离开本页丢弃未保存草稿；字段可恢复继承值。保存由官方 Settings/ConfigEditor 校验，并写入当前 profile 的 `cordis.patch.yml`。

| 字段 | 实际作用 |
| --- | --- |
| schedulerEnabled | 规划节点在下一维护轮询接收到期计划；不会取消已排队运行 |
| autoExecute | 本机队列的自动执行接收；不是全节点暂停 |
| maxConcurrent | 本机自动执行器的接收并发上限；节点容量或任务策略可能更严格 |
| executionTimeoutMs | 新原生尝试开始时的预算；包括远程领取的原生尝试；正在运行的计时器不变 |
| healthAlerts | 下一维护轮询是否进行规划端健康告警检查 |
| localHeartbeatIntervalMs | 下一维护轮询是否应记录本地账本心跳；不是远端协调器心跳 |

新安装 bundle 显式关闭 schedulerEnabled 和 autoExecute。页面始终读取当前配置，不静默替换已有 profile 的选择。若 keepAlive=false，自动维护轮询未运行，相关开关不会自行启动一个维护计时器。

## 远程领取独立

关闭 autoExecute 不会停止 `task-remote-execution` 的远程轮询，也不会取消正在运行的任务。已配置的安全重试同样独立。只读区明确显示远端地址、角色、轮询间隔、远程并发以及自动领取状态。

远程启动表单提供独立 paused 控制，保持连接配置可编辑；paused=true 时远程请求、领取与轮询停止。pollIntervalMs=0 只关闭自动轮询，不能替代 paused。此页不编辑远端授权、节点身份、密钥或登录凭据。已有连接地址可由独立启动表单修改；后端检查 expected snapshot 并保留现有认证、grant 和未知字段。

## 本机队列与会话摘要

本机队列通过独立公开读 API `taskPluginSettings.queue()` 读取有界快照，仅显示 Task/Run 标识、标题、状态、Session/Workspace 标识、读取时间及截断提示。页面首次打开和点击刷新时读取；没有后台领取、执行、取消或数据库写入。读取失败明确显示失败，不能解释为队列为空；刷新失败保留上次样本及其读取时间。

新版后端 `describe()` 顶层提供 schedulerId、defaultWorkspaceId 和 sessionDecisionEnabled，remote 提供 executorIdentity 和 taskSessionsEnabled。执行端身份只读显示调度端与分配的 executorId；nodeId 明确标为内部 ID，不提供文本编辑器。旧连接沿用原会话协议，界面不扩展 peer grant。

默认工作区须已在本机登记，启动配置改变后重启生效。决策使用已有 typed-decisions 适配器及其 provider/model 配置，本 GUI 增量没有新增 JEV 协议或凭据输入。角色、默认工作区、会话决策和调度端连接在独立启动表单中编辑；身份仅通过显式查询确认，没有 ID 文本编辑器。启动表单通过公开 startup/saveStartup RPC 保存，原六字段运行表单继续使用官方 SettingsFormModel。

队列及新版会话摘要需要配套后端。旧宿主不具备队列接口时会显示读取失败；缺少新版启动字段时明确提示接口未加载。仅更新浏览器脚本不能激活新的后端接口。

## 独立启动配置保存

启动表单先读取 `startup()` 的条目和值；草稿仅在点击 **保存并重启插件** 后提交。`saveStartup({target, expected, changes})` 只接收指定 task/remote 的严格字段子集；后端使用实际公开 ConfigEditor.edit 合并保存，拒绝旧快照、配置覆盖层与运行中工作。保存后重新读取 startup，并清除旧部署／队列摘要；改变连接不会继承页面之前显示的执行端身份。

Task 允许 role、defaultWorkspaceId、planningDecisionEnabled、sessionDecisionEnabled；remote 允许 role、paused、endpoint、audience、pollIntervalMs、concurrency 和受限制的 trustedNetworkTarget。旧连接的 Task 会话迁移使用明确的“保存并重启”操作，无常驻开关，也不扩展 peer grant。身份查询只在点击 **向调度端查询本机执行端 ID** 时调用无参数 RPC，不能指定其他节点。

未配置连接时，表单要求显式填写 endpoint、audience、精确目标地址／端口和本机 source address。只有已有 trusted-network 认证模式及固定内部节点身份才能由后端建立此连接；不创建 key、grant 或 native route，新连接保持远程轮询关闭。signed 连接缺少预配置引用会被拒绝，需使用官方安全配置流程完成。

默认工作区从本机已登记、ready、已授权目录选择，显示名称与路径；内部保留原稳定 workspace ID，高级页面只读显示 ID。决策模型使用上面的独立表单，未新增 JEV 协议。

## 决策模型配置

在任务系统设置中点击 **调度端决策模型配置** 或 **执行端决策模型配置**，直接打开同一表单；两个角色共用 typed-decisions 配置。普通 DSH LLM 从官方已有 provider/model 目录选择，初始空值不自动选第一项。**在“模型”中管理 provider 与凭据** 直接打开官方 Models 页面；返回后刷新目录。

表单沿用已有规则、structured、Typesafe Jev、已注册 compatible 模式。Jev 可保存非秘密 model/modelVersion；compatible 保存已有条目的 model/modelVersion/endpoint，保留其 capabilityDeclaration、凭据/env 引用及未知字段。缺凭据时明确未就绪，仍允许保存非秘密配置；本表单没有 secret 输入，也不创建凭据或测试模型连接。

独立 `decisionSettings()` / `saveDecisionSettings({ expected, selection })` RPC 使用严格字段白名单。配置编辑由 typed-decisions 的公开 `./settings` 模块拥有，任务系统只适配该公开接口。普通模型保留既有模型和 native bridge 路由，同步新增或选用对应 selector，并把选定模型放到该 provider 的默认首项。保存通过实际 ConfigEditor.edit 校验、持久化和正常插件重启，不重启 DSH。第二个条目保存失败时只按 CAS 撤回本次 bridge 新增；无法确认撤回则明确报 partial save，不显示成功。

选择和取消不写配置。刷新保留草稿和原 expected 快照；配置变化后保存拒绝覆盖，取消草稿可载入当前值。简单／高级切换保留模型草稿和工作区草稿。远端 paused 与授权不会因模型配置改变。

新版 typed-decisions bundle 安装声明包含一条 routes=[] 的空闲 native bridge，具备原有有限预算，仅在显式保存路由后才有可用模型；空 bridge 不发请求。升级时应使用正常 bundle 组合补齐该条目；已有 bridge 配置、ID 与预算需原样保留，不能重复加载第二个实例。旧宿主缺少条目时表单如实提示安装未齐，不要求用户编辑 profile JSON。

## 启动配置和覆盖层

只读区显示当前节点 ID、角色、真实 DB 路径、profile 配置路径、维护设置、租约、工具允许列表与远端连接摘要。地址中的用户信息、query 和 fragment 均不发送到浏览器。密钥内容、环境变量引用和完整 Config 不会进入只读响应。

数据库、身份、角色、租约、授权和远端连接属于启动配置。角色、工作区及允许的连接字段通过独立启动表单保存并重启受影响插件；不会重启整个 DSH。数据库、租约、授权和凭据仍由原安全配置流程管理。不要为了此 GUI 建立第二份数据库、额外授权或新凭据。

配置层顺序是 bundle → profile → Home patch → 命令行 --patch。**config 是整对象替换，不是逐字段合并。** 若 Home 或 CLI 覆写 task-system.config，GUI 保存会由官方宿主拒绝，并且不会落盘。仅从 CLI config 删掉六个可编辑字段仍不能解决。

使用独立测试 profile 时，应把完整 task-system 配置原样放入该 profile，让 profile 拥有这条配置；保留原安全值。task-remote-execution 可继续独立放在既有固定覆盖层里。界面显示命令行覆写是否存在，并在存在 Home patch 时提示其可能覆盖配置；最终拒绝由官方 ConfigEditor 判断。

官方 rc.2 的共享 configForms 在非 loopback 连接使用内存作用域。任务页为这种连接提供专用适配器，通过已认证的公开 Settings.describe/mutate 读取和保存上述六个字段；保存仍使用宿主 revision 校验、字段白名单和 ConfigEditor。它不会改变宿主的 loopback 判定、其他插件的设置页、认证或授权。缺少命名空间、只读宿主和读取失败均禁止保存。

远程访问可使用已有私有网络中的 HTTPS 反向代理，DSH 继续监听 loopback，并配置精确 trustedHosts。首次访问使用运行中的 DSH 打印的登录链接；服务重启会更换该入口 token，已建立的登录 cookie 按宿主规则保留。登录链接属于访问凭据，不应提交到仓库。

任务页在 640px 以下将宿主设置导航改为横向换行，详情和操作区可换行，表单控件保留可触摸高度。规则只作用于正在显示任务页的对话框。实际 VPS 页面已检查 320、390、430、768 和 1280px 视口，记录见仓库手机验收文档；这不等同于物理手机或 Safari 验收。

## 为什么需要浏览器伴生组件

官方 rc.2 的 schema 中虽有 autoGenerate，但官方文档明确说明尚无 shipped client 自动生成页面。仅导出 Config 或通过 schema dump 不会产生 GUI。此实现使用官方插件配置槽位；其六个 volatile 字段保留 Loader 所有的稳定引用，不重启任务服务。

## 验证状态

无凭据的官方 Loader/Settings 验证覆盖每个字段的真实运行读取、保持 plugin fiber 和账本实例、过期 revision/非法范围/启动字段拒绝、重启持久化、官方 client-modules 读取浏览器包及 CLI 整对象覆盖拒写。

实际官方 SettingsFormModel 的离线测试覆盖草稿、保存、重复保存、范围错误、冲突保留、恢复默认、只读与卸载。本机 3082 已完成真实 DOM 验收：设置入口、六字段、官方并发保存 1→2→1，原值恢复且调度／自动执行保持关闭。只读部署旧实现存在 Cordis 未声明动态命名空间依赖和未解包 RemoteResult 的问题；新客户端使用公开 Context.get 读取已挂载服务、检查成功／失败分支并校验业务快照。该修复已由实际官方 Gateway 和 Cordis 的无凭据 fixture 验证，真实浏览器读取与新版启动表单验收由测试环境一次更新后单独记录。


独立官方 DSH 启动 fixture 通过真实公开 Gateway/ConfigEditor 验证窄快照、保存后插件重启及重读、旧 snapshot 拒绝、身份改写拒绝、重启持久化和 null 默认值恢复；没有真实模型或凭据调用。浏览器 Gateway fixture 则验证 Context.get、RemoteResult 解包和 saveStartup 的精确 input 参数。
