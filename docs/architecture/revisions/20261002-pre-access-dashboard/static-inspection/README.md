# 静态图形检查：非官方导出，非浏览器截图

这些 PNG 来自实际生成 HTML 中的 inline SVG，只为检查节点、文字与线路。使用原始坐标、语义样式、主题颜色和字体栈；rgba 转为等价 SVG opacity。Inkscape 1.4 不能代表浏览器的完整 CSS、字体、Viewer 卡片与交互。原 HTML 未修改。

共 16 张 PNG 已逐张查看：未发现裁切、文字压住节点边框或线路穿过无关节点；任务返回、阻塞和取消线可区分；报告修订、精确重放与冲突分支可区分。黑色小图标和阴影差异属于此静态渲染的保真限制，不能据此修改正式 HTML。

original 的旧 browser-check 仍然失败；新版 browser-check 未运行，截图仍未取得，完整 Viewer 视觉检查未通过。这里的宽度是图形像素宽度，不是浏览器 viewport。

| 图 | Light 1440 | Light 2048 | Dark 1440 | Dark 2048 |
| --- | --- | --- | --- | --- |
| original | [light 1440](original/light-1440.png) | [light 2048](original/light-2048.png) | [dark 1440](original/dark-1440.png) | [dark 2048](original/dark-2048.png) |
| target | [light 1440](target/light-1440.png) | [light 2048](target/light-2048.png) | [dark 1440](target/dark-1440.png) | [dark 2048](target/dark-2048.png) |
| task-lifecycle | [light 1440](task-lifecycle/light-1440.png) | [light 2048](task-lifecycle/light-2048.png) | [dark 1440](task-lifecycle/dark-1440.png) | [dark 2048](task-lifecycle/dark-2048.png) |
| report-lifecycle | [light 1440](report-lifecycle/light-1440.png) | [light 2048](report-lifecycle/light-2048.png) | [dark 1440](report-lifecycle/dark-1440.png) | [dark 2048](report-lifecycle/dark-2048.png) |

[逐文件 SHA-256 与原 HTML 绑定](derivation-manifest.json)

复现：在仓库根目录运行 python3 docs/architecture/derive-static-inspection.py。此脚本只写本静态检查目录，不改候选 JSON 或 HTML。

## 2026-10-01 实例所有权更新

目标、任务与报告三图的 HTML 已更新；对应 12 张 PNG（两主题、两宽度）已重新渲染并逐张查看，未见标签裁切或路径遮挡。derivation-manifest.json 已绑定新版 HTML SHA-256。原图 HTML 未变，四张原图投影沿用先前的静态检查结论。当前新版浏览器门未重试；旧 browser 失败回执仅属于各自旧 hash。

## Revision 5：确认、协作与 Task Pack

三个变更图的 12 张 PNG 已再次逐张查看。目标图新增 Task Pack 与注册路径，任务图更新确认/contextNotes/最终门，报告图加入 note；两主题、两宽度未发现节点或标签裁切、无关节点遮挡。生成 HTML 未经手工修改；derivation-manifest.json 绑定本轮各 HTML SHA-256。检查仍限静态图形，不包括 Viewer 卡片、页面交互或浏览器。


## Revision 6：终态日志、运行批准与两种有限续跑

本轮 16 张 PNG 均通过 view_image 实际逐张查看。新版目标图的独立终态日志、Task Pack 注册与恢复读取走独立通道；任务图区分默认零工具重试、显式已审查闭合工具续跑、runtime once/deny、未知副作用复核、取消与终态日志提交。未发现节点/标签/图例裁切或线路穿过无关不透明节点；任务循环的返回线移至主路径上方。报告图的修订、精确重放和冲突分支仍可辨认。

深色关系标签较弱，保留真实浏览器复核项。所有宽度仍仅是图形像素；不代表 Viewer viewport、工具栏、卡片、交互或浏览器截图。derivation-manifest.json 的当前 HTML 哈希已核对；正式 HTML 未手改。旧图与旧 PNG 精确字节在 ../revisions/20261001-pre-runtime-safety/。


## Revision 7：安全错误摘要与可选 trusted-network

更新三图的 12 张 PNG 已逐张通过 view_image 查看：新增 signed+TLS / trusted-network 标签未裁切，节点、关系与图例无新遮挡。只有 target 的节点标签改变；task/report 图形像素与 revision 6 相同。原图四张 PNG 字节相同，沿用此前真实检查。

安全错误摘要和两种认证的卡片正文已按冻结源码核对，并确认写入当前 HTML。卡片不属于这些 SVG 投影，因此此项不能证明卡片布局、完整页面或浏览器已验收。原 HTML 未手工修改；当前 derivation-manifest 重新绑定 HTML 哈希。旧 revision-6 HTML、回执和图像在 ../revisions/20261002-pre-safe-error-summary/，browser/Git 来源门仍分别保留未通过状态。
