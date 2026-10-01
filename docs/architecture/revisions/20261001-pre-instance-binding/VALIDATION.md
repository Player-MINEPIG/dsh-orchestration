# Archify 验证记录

## 当前结果

四份独立 HTML 均完成 9/9 showcase 检查，0 error、0 warning，并通过生成字节的 strict provenance 检查。四次最新 finalize 均以退出码 1 结束：本机 Chromium 在 browser-check 阶段因 socket() Operation not permitted 无法启动检查。不得将这些 finalize 描述为整体成功。

Before / Delta / After 对比 HTML 的 compare 命令成功，28/28 检查通过，proofLevel 为 authored。这个检查不包含真实浏览器、源代码 Git 对象、部署、运行影响或迁移安全证明。

所有浏览器截图与 Viewer 视觉检查都未完成。官方 visual-check 未生成任何 PNG。Cloud Chrome 对 file: 协议和 loopback HTTP 的访问受限；没有改变这些限制，也没有把其它渲染方式冒充浏览器截图。

## 范围与来源门

历史图是移交材料的系统描述；材料 mtime 为 2026-09-07 UTC，旧文档自述当地 2026-09-08。目标和 lifecycle 图仅表达批准的设计约定。来源映射在 sources.md；带源引用的 repository-draft.json 保留待后续补充真实 origin、固定 commit 和 Git blob 校验。当前未通过 repository provenance。

对比中的共同 ID 表示 supervisor、宿主、任务管理、执行、账本、查询等逻辑职责；不声称新旧代码是同一进程或已经迁移所有旧数据。

## 版本

官方 Archify 3.0.1，commit d5a1333d7447c866a765adac7d4d062f2f02e4d2；SKILL.md 文档 frontmatter 3.0；Node v24.19.0。读取了旧 2.17 流程，但没有更改用户已安装 skill。

## 文件指纹

| 图 | Specification SHA-256 | HTML SHA-256 | 最新 receipt |
| --- | --- | --- | --- |
| original | `4a26d33bbdb23ea4c45571e8b59eba69f244e9914cceb6ffa245f6ec8da7917a` | `f7e72035189ff28601ebc70df00f50b5bad4acdd929ba14eaa47c82f9b0cba3d` | `original/review-3/original.finalize.json` |
| target | `2be1b6af7bd2a478e0d87e072b1e27dc11d1c1f320f286b2c53155c26f646477` | `ea57dcf551632b7e1ad596a2325935904ea4aba149cfb8aeeb5b6742bcfb1968` | `target/review-3/target.finalize.json` |
| task-lifecycle | `e7f8bcf892b32a7f9641fcc4cac4dbdb34c72b99436831a4932b1109b3f01d33` | `377d7267d2422dfa28df652a282f7dc79ec1b131c590cd7d2c807342348f9af1` | `task-lifecycle/task-lifecycle.finalize.json` |
| report-lifecycle | `61a4587df39be2ebee520248e87d592519e48eb301b01ff8b935f86f7946f4f4` | `9247431d1718c8a1e1b365da60aa0f57640a872fb9683bb42585f6cc6bc3bb4e` | `report-lifecycle/report-lifecycle.finalize.json` |

comparison.html SHA-256：`538c0a2941bae4e7cf24b386209ac21310168ae73ba365b63d45b80e2e977599`，2163012 bytes。

完整字节数、gate 结果与环境尝试见 [validation-manifest.json](validation-manifest.json)。

## 在可运行 Chromium 的环境补验

保持 candidate 与 HTML 字节不变，重新执行官方 finalize；随后 visual-check --summary --require-provenance 并逐张检查 captures。若 candidate 修改，使用新的 --out-dir 保留旧证据。

源代码门单独补验：核实真实仓库 origin、提交引用文件，更新带源 draft 的 meta.repository，使用 --repo-root；不得用预期远端 URL 或工作树哈希冒充 Git commit。

## SVG 备用检查的边界

官方 Viewer Runtime 文档仅提供 Viewer 导出菜单中的 dual-theme SVG；CLI --help 没有独立 SVG export 命令。当前浏览器无法打开本地 HTML，因此不能得到正式菜单导出的 SVG。环境有 Inkscape / ImageMagick，但另行提取 inline SVG 并解析 CSS 只能成为非 canonical 衍生渲染，不能称为官方 SVG 导出、浏览器截图或真实 Viewer 检查。

## 已完成的静态图形像素检查

另外从四份真实生成 HTML 中只读提取 inline SVG，按其 semantic CSS 和主题变量生成非 canonical 衍生 SVG；将 rgba fill/stroke 归一为等价的 SVG rgb + opacity，使用 Inkscape 1.4 栅格化。四图 × light/dark × 1440/2048 图形宽度，共 16 张 PNG 已逐张通过图像查看工具检查，源 HTML SHA-256 全部保持不变。

可见范围内未发现节点、标签、图例被裁切；关系未穿过无关不透明节点；任务返回与报告修订路径可区分，交叉避让保留。中文、代码名及主路径均可辨认。静态小图标颜色、阴影、背景与字体度量不保证和浏览器一致；小号低对比关系标签仍须在真实 Viewer 中复核。

此项只证明衍生 SVG 的静态构图检查，不能算官方菜单导出、浏览器截图、四个 viewport 测量或交互测试；不改变 browserEvidence=failed，也不使 finalize 整体通过。它不包含 HTML 的工具栏、卡片、页面适配、缩放/搜索/聚焦与导出功能。详情和 PNG 见 [static-inspection/README.md](static-inspection/README.md)；所有图像绑定原 HTML hash。
