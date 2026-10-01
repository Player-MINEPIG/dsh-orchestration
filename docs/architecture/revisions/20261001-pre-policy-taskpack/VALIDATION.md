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
| original | `4a26d33bbdb23ea4c45571e8b59eba69f244e9914cceb6ffa245f6ec8da7917a` | `f7e72035189ff28601ebc70df00f50b5bad4acdd929ba14eaa47c82f9b0cba3d` | `original/review-3/original.finalize.json` |
| target | `b8d584ab9fc319224b25dc94e9f15ad16c73a20c00885e70ba1f750890ffec68` | `8dac60083ed1a3a9ed8da196f777b220d238f209af8a283b378cf01e3f54d867` | `target/revision-4-deliver.json` |
| task-lifecycle | `afb55ca02fd99c8829813b3a6f6ff4236a57575745584dfe91515f27322086d5` | `f058a2368353f3a7e27776d232d3e8387cbe995824a26bc8ca409e925bb4f95d` | `task-lifecycle/revision-4-deliver.json` |
| report-lifecycle | `ca6711d209c90dd6f3235d25db032e49284bad8ad617e14e7fa54f67c0f2b13f` | `c324dda0f0eb32a7dc329e84289bfc82e026b47ce7368736c33bd6bd2ff53e56` | `report-lifecycle/revision-4-deliver.json` |

comparison.html SHA-256：`e70cbc015a2ccb938c3d6bee2909d14a22208589ac4843aca63daf9af29162f7`，2163482 bytes。

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

旧 candidate、HTML、delivery sidecar、对比文件和旧 manifest 已保存在 [revisions/20261001-pre-instance-binding](revisions/20261001-pre-instance-binding/)。最新三图各自的 `revision-4-deliver.json`、`revision-4-check.json` 是本轮有效自动检查回执。所有历史 `.finalize.json` 继续保留，只能按其 SHA-256 对应旧字节使用。

当前 source-linked drafts 的引用重新定位至被检查的工作树符号；[source-snapshot.json](source-snapshot.json) 记录读取时文件哈希，但不构成 Git 来源门通过。测试数量和生产连通结论以独立项目验证报告为准。
