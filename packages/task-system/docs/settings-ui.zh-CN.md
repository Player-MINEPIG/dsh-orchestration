# DSH 自身 WebUI 的任务插件设置

DSH 自带 WebUI；入口是 `dsh web` 或 `dsh --profile web`。自定义名称的 profile 必须由 Web 模板创建，并且在同一 profile 安装任务插件，才会同时有聊天界面和插件管理入口。只有 base/headless profile 不会自动变成 WebUI。

本包的设置入口是：侧栏 **插件 → 已安装的 @dsh-task/task-system → task-system → 配置**。浏览器伴生组件由同包的 `task-system-settings` 行提供。任务管理面板仍是 VPS 上独立访问的网页；此页只管理插件运行设置，不搬运任务列表、数据库或业务逻辑。

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

当前 GUI 没有“暂停远程节点”按钮。远程轮询由启动配置 pollIntervalMs 控制：设为 0 并重启后不自动轮询；已经领取的任务和显式调用仍需分别处理。此页不编辑远端授权、节点身份、密钥或登录凭据。

## 启动配置和覆盖层

只读区显示当前节点 ID、角色、真实 DB 路径、profile 配置路径、维护设置、租约、工具允许列表与远端连接摘要。地址中的用户信息、query 和 fragment 均不发送到浏览器。密钥内容、环境变量引用和完整 Config 不会进入只读响应。

数据库、身份、角色、租约、授权和远端连接属于启动配置。修改现有 profile 文件后重启。不要为了此 GUI 建立第二份数据库、额外授权或新凭据。

配置层顺序是 bundle → profile → Home patch → 命令行 --patch。**config 是整对象替换，不是逐字段合并。** 若 Home 或 CLI 覆写 task-system.config，GUI 保存会由官方宿主拒绝，并且不会落盘。仅从 CLI config 删掉六个可编辑字段仍不能解决。

使用独立测试 profile 时，应把完整 task-system 配置原样放入该 profile，让 profile 拥有这条配置；保留原安全值。task-remote-execution 可继续独立放在既有固定覆盖层里。界面显示命令行覆写是否存在，并在存在 Home patch 时提示其可能覆盖配置；最终拒绝由官方 ConfigEditor 判断。

官方 rc.2 的持久配置表单仅用于受支持的 loopback Host 连接。推荐在运行 DSH 的机器上打开它打印的本机 URL；远程非 loopback 连接可能不提供可编辑表单。不要为此把 WebUI 暴露到公网或新建凭据。

## 为什么需要浏览器伴生组件

官方 rc.2 的 schema 中虽有 autoGenerate，但官方文档明确说明尚无 shipped client 自动生成页面。仅导出 Config 或通过 schema dump 不会产生 GUI。此实现使用官方插件配置槽位；其六个 volatile 字段保留 Loader 所有的稳定引用，不重启任务服务。

## 验证状态

无凭据的官方 Loader/Settings 验证覆盖每个字段的真实运行读取、保持 plugin fiber 和账本实例、过期 revision/非法范围/启动字段拒绝、重启持久化、官方 client-modules 读取浏览器包及 CLI 整对象覆盖拒写。

实际官方 SettingsFormModel 的离线测试覆盖草稿、保存、重复保存、范围错误、冲突保留、恢复默认、只读与卸载。云浏览器受环境限制，未完成真实页面渲染验收；不能把这些测试视为真实 WebUI 端到端通过。首次启动官方 WebUI 需要浏览器认证初始化；需按操作者授权进行。
