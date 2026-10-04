# Archify 验证记录

## 当前结果

四份独立 HTML 的当前字节均通过 9/9 showcase 检查，0 error、0 warning，并通过 strict artifact provenance 检查。本轮更新的 target、task-lifecycle、report-lifecycle 仅运行官方 deliver 与 strict check，两阶段均退出 0；按明确要求，没有重试被环境阻止的浏览器。它们的当前 browserEvidence 是 not-run-current-revision，不能宣称 finalize 整体通过。

历史 original HTML 保持原字节；其最新 finalize 退出 1，因本机 Chromium 在 browser-check 阶段遇到 socket() Operation not permitted。此前另外三图的 browser 失败回执属于旧 HTML hash，已保留为历史证据，不能套用为新版浏览器检查。

Before / Delta / After 对比 HTML 的 compare 命令成功，28/28 检查通过，proofLevel 为 authored。这个检查不包含真实浏览器、源代码 Git 对象、部署、运行影响或迁移安全证明。

所有浏览器截图与 Viewer 视觉检查都未完成。官方 visual-check 未生成任何 PNG。Cloud Chrome 对 file: 协议和 loopback HTTP 的访问受限；没有改变这些限制，也没有把其它渲染方式冒充浏览器截图。

## 范围与来源门

历史图是移交材料的系统描述；材料 mtime 为 2026-09-07 UTC，旧文档自述当地 2026-09-08。目标和 lifecycle 图仅表达批准的设计约定。来源映射在 sources.md；带源引用的 repository-draft.json 保留待后续补充真实 origin、固定 commit 和 Git blob 校验。当前未通过 repository provenance。

对比中的共同 ID 表示 supervisor、宿主、任务管理、执行、账本、查询等逻辑职责；不声称新旧代码是同一进程或已经迁移所有旧数据。

## 版本

官方 Archify 3.0.1，commit d5a1333d7447c866a765adac7d4d062f2f02e4d2；SKILL.md 文档 frontmatter 3.0；Node v24.19.0。读取了旧 2.17 流程，但没有更改用户已安装 skill。

## 文件指纹

| 图 | Specification SHA-256 | HTML SHA-256 | 当前 receipt |
| --- | --- | --- | --- |
| original | `4a26d33bbdb23ea4c45571e8b59eba69f244e9914cceb6ffa245f6ec8da7917a` | `f7e72035189ff28601ebc70df00f50b5bad4acdd929ba14eaa47c82f9b0cba3d` | `original/revision-6-check.json` |
| target | `f4aef3ad415a64053a1f9abd9f3363ddfdf060be92382bf4f0f545c9d6f51c71` | `9df3b0e99585c367d439c93d4a8f41a953bf2eb71494ea2c6661287974ae0d38` | `target/revision-7-deliver.json` |
| task-lifecycle | `e00cb8ffa060bfe3d1704321f8bce5455d877a671adb108e83cb0eac66f40834` | `e85b7ee10bf420e6d7296a7da08788bafdf84bc619ce4edbc11b136bae2c8efd` | `task-lifecycle/revision-7-deliver.json` |
| report-lifecycle | `0f0f9b5eb014b8f77afb546adfd62ce30dcb693e7fe0d6b9885ec071aebfc08c` | `b58f0054183b8a6b8507d63453fec7f93418519f0a34e439b15d1677391d75ef` | `report-lifecycle/revision-7-deliver.json` |

comparison.html SHA-256：`b1ca2d55e0e4ab19243adb8c8d8a1df10ccaaa313afb1772c05b86c0fc60b051`，2186453 bytes。

完整字节数、gate 结果与环境尝试见 [validation-manifest.json](validation-manifest.json)。

## 在可运行 Chromium 的环境补验

保持 candidate 与 HTML 字节不变，重新执行官方 finalize；随后 visual-check --summary --require-provenance 并逐张检查 captures。若 candidate 修改，使用新的 --out-dir 保留旧证据。

源代码门单独补验：核实真实仓库 origin、提交引用文件，更新带源 draft 的 meta.repository，使用 --repo-root；不得用预期远端 URL 或工作树哈希冒充 Git commit。

## SVG 备用检查的边界

官方 Viewer Runtime 文档仅提供 Viewer 导出菜单中的 dual-theme SVG；CLI --help 没有独立 SVG export 命令。当前浏览器无法打开本地 HTML，因此不能得到正式菜单导出的 SVG。环境有 Inkscape / ImageMagick，但另行提取 inline SVG 并解析 CSS 只能成为非 canonical 衍生渲染，不能称为官方 SVG 导出、浏览器截图或真实 Viewer 检查。

## 已完成的静态图形像素检查

另外从四份真实生成 HTML 中只读提取 inline SVG，按其 semantic CSS 和主题变量生成非 canonical 衍生 SVG；将 rgba fill/stroke 归一为等价的 SVG rgb + opacity，使用 Inkscape 1.4 栅格化。四图 × light/dark × 1440/2048 图形宽度，共 16 张 PNG 已逐张通过图像查看工具检查，源 HTML SHA-256 全部保持不变。

可见范围内未发现节点、标签、图例被裁切；关系未穿过无关不透明节点；任务返回与报告修订路径可区分，交叉避让保留。中文、代码名及主路径均可辨认。静态小图标颜色、阴影、背景与字体度量不保证和浏览器一致；小号低对比关系标签仍须在真实 Viewer 中复核。

此项只证明衍生 SVG 的静态构图检查，不能算官方菜单导出、浏览器截图、四个 viewport 测量或交互测试；不改变各图的浏览器失败或未运行状态，也不使 finalize 整体通过。它不包含 HTML 的工具栏、卡片、页面适配、缩放/搜索/聚焦与导出功能。详情和 PNG 见 [static-inspection/README.md](static-inspection/README.md)；所有图像绑定原 HTML hash。

## 本轮变更与精确旧字节

2026-10-01 执行实例更新：目标图与任务图明确 executionId 在执行副作用前原子绑定；renew / bind / submit / cancel ACK 需要相同实例。补充非秘密 remote instance UUID、native decision bridge、native Feishu chat、workspace 观察转发，以及工具与调度边界。报告图保留追加证据与权威 settlement 的区别。

本轮三份变更图的 12 张 PNG 在 light/dark、1440/2048 宽度下重新逐张查看，未见标签、节点或图例裁切，也未见路径穿过无关节点。原图的四张投影此前已检查且源 HTML 字节未变。这里的宽度是图形像素宽度，不是浏览器 viewport。

旧 candidate、HTML、delivery sidecar、对比文件和旧 manifest 已保存在 [revisions/20261001-pre-instance-binding](revisions/20261001-pre-instance-binding/)。执行实例迭代的 `revision-4-deliver.json`、`revision-4-check.json` 保留为前一轮回执。所有历史 `.finalize.json` 继续保留，只能按其 SHA-256 对应旧字节使用。

当前 source-linked drafts 的引用重新定位至被检查的工作树符号；[source-snapshot.json](source-snapshot.json) 记录读取时文件哈希，但不构成 Git 来源门通过。测试数量和生产连通结论以独立项目验证报告为准。

## 本轮确认、协作与 Task Pack 更新（revision 5）

目标图新增独立「可选 Task Pack」及受信注册关系；执行关系标注确认、策略和实例门。任务图显示 contextNotes 快照、确认后执行和核心最终收束；说明 confirmation revision 只能由可信操作入口批准，模型没有批准权限。说明 admitted/dismissed 是独立可逆的收录视图，不等于审批或取消。

补充 userImmediacy / urgency 排序、fanout / depth / capacity / resource 限制，绑定 lease 的跨节点 delegate/history/wait/note/report，以及核心 submit 的后代 quiet-window 最终门。报告图说明排队 note 的原子消费，及可选 readers → prepare/artifact → task_settle → schema Feishu renderer 管线。

三份当前 `revision-5-deliver.json` 与 `revision-5-check.json` 都退出 0、9/9 通过、0 error/warning；对比仍 28/28 通过。三图 12 张 light/dark、1440/2048 PNG 已重新逐张查看，未见标签裁切或无关节点遮挡。Task Pack 注册路径走独立空白通道，生命周期返回/取消路径可区分；深色小号辅助文字仍需真实浏览器复核。

旧版精确字节在 [revisions/20261001-pre-policy-taskpack](revisions/20261001-pre-policy-taskpack/)。浏览器未重试，当前三图仍是 not-run-current-revision；静态 PNG 不替代 Viewer 验收。source-snapshot.json 已记录本轮 27 个本地文件，最终 source freeze 状态以 validation-manifest.json 为准；文件哈希不等于 Git 对象来源验证。

本轮源码快照读取时刻（UTC）：`2026-10-01T22:10:28.439019+00:00`，27 个文件。交付时源码尚未 freeze；后续 alerts、health、safe transient retry、quota、mixed-parser 行为修订应在下一轮重新读取、映射及哈希，当前图未把这些后续工作宣称为已验证。


## 本轮运行安全与维护中 Task Pack 更新（revision 6）

2026-10-01 SOURCE FREEZE 后正式生成三份新版 HTML，所有 revision-6-deliver.json 与 revision-6-check.json 均退出 0：每图 9/9 showcase 检查通过、0 error、0 warning，artifact provenance=current。Before / Delta / After 对比重新生成，28/28，通过范围仍是 authored。最终 manifest 与表中 SHA-256 绑定当前候选和 HTML 字节；旧 revision-5 字节、回执和静态投影在 [revisions/20261001-pre-runtime-safety](revisions/20261001-pre-runtime-safety/)。历史 original 的 candidate 与 HTML 未变。

目标图明确本机独立 native 终态 SQLite 日志，由执行适配写入、Task System 读取精确终态并重新核实后提交唯一权威账本。Task System 仍由 DSH host 挂载/卸载。新增 runtime once/deny 与任务 confirmation revision 分离、Alerts / heartbeat freshness、创建锚点与各 run 终态回复；Task Pack 展示显式 readers、quota、ad-hoc 与 diagnostics 及 executor preflight 边界。

任务图将同 run 续跑分为默认零工具证据与显式 reviewed closed-tools 两条路径。后者要求完整连续调用/成功结果、flush/dispose、固定 session、有限预算与已完成 name+参数摘要的防重复 guard；默认 retry 次数为零、resumableTools 为空。未知副作用仍需 reconcile，不能把它解释为任意 shell exactly-once。parentRunId 使稳定 Task 的每轮子执行、descendant 预算与 quiet window 独立；历史周期不误耗新轮预算。权威终态恢复只允许可信本机日志的早先就绪证明，不能扩大普通迟到报告权限。

本轮 16 张静态 SVG 衍生 PNG 均实际逐张查看（新版 12 张及不变原图 4 张，两主题 × 1440/2048 图形宽度）。未发现节点、文字或图例裁切；线路避开无关不透明节点；两种续跑、批准、取消与终态日志路径可区分。任务循环返回移至主路径上方，相关 resolvedCrossovers 从初稿 12 降为 2。深色的小号弱对比关系文字仍须真实浏览器复核。未手工修改 HTML，图像 manifest 绑定当前 HTML hash。

浏览器步骤遵照要求未重试：三个新版 browserEvidence=not-run-current-revision；original 的旧 browser-check 仍因 socket() Operation not permitted 失败。没有整体 finalize 成功、真实 Viewer、部署连通、模型质量或完整业务等价声明。Git 无 origin；本地提交或文件哈希均未被伪装成远端/固定 blob 来源证明。运行能力与 live pending 仍应查阅项目 PARITY.md 和对应真实测试回执。

源码读取时刻：`2026-10-01T23:22:51.767699+00:00`；本地文件数：46。冻结说明：core/remote/native 功能代码由负责人在 `2026-10-01T23:18:25Z` 确认 SOURCE FREEZE，之后独立检查所列源文件哈希是否改变；验收文档仍可补充。source-snapshot 不包含当前仍在整理的 PARITY.md，避免把文档编辑冒充功能源码漂移。


## 安全错误摘要与可选网络认证（revision 7）

2026-10-02 的最小修订只更改三图说明卡片，并在原 execution 节点加入 signed+TLS / trusted-network 标签；节点 ID、关系、坐标和生命周期转换均未改。revision 6 的 candidate、HTML、回执、manifest 和静态投影保存在 [revisions/20261002-pre-safe-error-summary](revisions/20261002-pre-safe-error-summary/)，原历史图与旧回执保留。

无因果 task_settle 的 native local/external 结果只从真实 owned session 的公开 turn/end 提取固定 allowlist 错误码，其它码归 RUNTIME_ERROR；不外传原 message/cause/headers/credentials，不制造报告，仍保持 unknown/not-submitted（对应 uncertain）。该说明不授予新增重试权，也不把 provider 错误变成成功。

默认 ed25519 签名+TLS 保留。可选 trusted-network v2 需显式 allowHttp，按真实 socket 来源精确 IP 映射固定 node/role/operations/workspace/capability；网络允许列表与应用 peer grant 分开。专用 HTTP carrier 属于宿主生命周期，限制精确 listen/Host，拒绝 Origin 和代理身份头；client 绑定 source 并核对实际 target。nonce/sequence/receipt/lease/fence 与最终授权继续适用。该模式依赖运营方可信网络，同来源 IP 上的进程共享应用身份；不调用 Tailscale WhoIs，不动态扩展名单，不内置私人 IP，不提供独立进程/密钥身份。

本轮官方 revision-7-deliver.json / revision-7-check.json 全部退出 0：三图各 9/9 showcase、0 error、0 warning，artifact provenance=current；comparison 28/28 authored。已逐张查看更新三图的 12 张 PNG（light/dark × 1440/2048 图形宽度），新增认证标签未裁切，节点、关系与图例保持清楚。task/report 的图形投影与 revision 6 像素相同；原图四张 PNG 字节相同并沿用既有实际检查。卡片文字已经与源码核对，并确认存在于生成 HTML；静态 SVG 不包含卡片，不能据此宣称卡片排版或 Viewer 已经视觉验收。

SOURCE FREEZE 由负责人于 `2026-10-02T06:29:25Z` 确认；读取时刻为 `2026-10-02T06:31:02.335749+00:00`，共 55 个源码/包说明文件，结束前逐文件哈希核对无漂移。包版本为 Task System / Remote Execution / Feishu 0.1.1，Typed Decisions 0.1.0。源读取时本地 HEAD 为 `86d8fb014d97fbfe282fcea54d4d8a899a24bb97`，仍无 origin；未提交源码哈希不被冒充成该 commit blob 或已推送远端证明。运行测试和现场安装结论属于独立项目回执，架构图不关闭其验收项。

真实 browser-check / Viewer 本轮仍未运行，遵照既有不重试受阻浏览器的要求；没有整体 finalize、Git-object 来源、生产网络或模型连通通过声明。原浏览器失败回执只属于其原 HTML hash。许可证与第三方 notice 保留。
