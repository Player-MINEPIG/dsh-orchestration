# Architecture snapshots

These source-grounded diagrams preserve the 0.1.x four-package snapshot. The current 0.2 installation boundary is described in [PLUGIN-BOUNDARIES.zh-CN.md](../PLUGIN-BOUNDARIES.zh-CN.md); the implementation and diagrams retained here remain historical evidence.

# 架构、任务与报告历史

这里的图比较历史移交材料中的系统描述与已批准的重构设计。历史材料 mtime 为 2026-09-07 UTC，旧文档自述当地 2026-09-08。配套 sources.md 保留源码映射，但本轮图未通过 Git 对象来源门。图不代表当前生产部署、代码验证或所有外部系统已连通。

四份独立 HTML 的 deterministic 9/9 检查通过；原版真实浏览器门因环境限制失败；本轮新版遵照要求未重试，尚无浏览器截图或 Viewer 验收；revision 8 已逐张检查目标图 4 张静态 SVG 衍生 PNG；全部 16 张图形像素不变，其余 12 张沿用既有检查。详见 [验证记录](VALIDATION.md)。

- [交互式 Before / Delta / After 比较](comparison.html)
- [历史系统描述](original/original.html) · [JSON](original/candidate.json)
- [DSH 目标架构](target/target.html) · [JSON](target/candidate.json)
- [任务与运行生命周期](task-lifecycle/task-lifecycle.html) · [JSON](task-lifecycle/candidate.json)
- [报告与修订生命周期](report-lifecycle/report-lifecycle.html) · [JSON](report-lifecycle/candidate.json)
- [逐项源码与状态边界](sources.md)
- [静态图形衍生 PNG 与检查说明](static-inspection/README.md)

## 主要变化

1. 外部 supervisor 保活 DSH host；Task System、Remote Execution、Typed Decisions 和 Feishu 渠道挂载于宿主。插件不成为 OS daemon，不承担平台自维护。
2. Task System 配置与管理一个权威 TaskLedger。task_id 跨 session、run、report、revision 和 artifact 保持稳定；最新视图只是查询投影。
3. 日报、游戏日报以及新任务类型都通过版本化 Template/Schedule 配置；工作区表示实际目录。
4. 私有 dashboard 消费同一 query 或明确导入的任务快照，展示 source、observedAt 与 stale；不维护第二本权威账本。
5. attempt 在执行副作用前原子绑定 executionId；续租、session 绑定、submit 和取消 ACK 校验同一实例。remote 恢复日志持久化非秘密 instance UUID，同节点不同日志不能重复执行同一 claim。
6. native decision bridge 提供可选单次模型提案；task_plan 仅提案，task_dispatch 由确定性授权 apply。Feishu native chat 已实现，外部连通仍待验证；session 观察按工作区配置转发，收录不能派发。
7. native 静止并 flush/dispose、预检后先写独立 FULL/WAL 终态日志；精确恢复仍经核心重新检查。普通迟到结果不能逆转终态，未知副作用须核实。
8. confirmation revision 与绑定具体调用/参数摘要的 native once/deny 批准分开，均不由模型授权。admitted/dismissed 独立管理收录。
9. note 原子进入 nextRun.contextNotes；协作绑定有效 lease 与自有子树。parentRunId 将每轮后代预算和 quiet window 与旧周期分开。
10. 维护中 Task Pack 提供显式 readers、可信语义校验、native prepare/artifact、executor preflight 和 renderer；日报/游戏/ad-hoc/diagnostics/quota 是扩展配置。
11. 有限续跑区分默认零工具与显式 reviewed closed-tools；成功结果闭合、同 session、flush/dispose 与防重复 guard 必须齐全。默认 retry=0、resumableTools=[]。
12. Alerts / heartbeat 记录来源与 freshness；provider not-probed 不代表真实模型可用。创建锚点与各 run 终态回复使用独立投递回执，外部访问默认不开启。

13. 无 task_settle 的 native 摘要只保留固定公开错误码或 RUNTIME_ERROR，仍为 unknown / uncertain，不复制原始错误。
14. 默认 signed+TLS 与显式 trusted-network HTTP 是两种认证模式；后者绑定实际来源 IP 与固定 peer 权限，依赖运营方可信网络，同机进程共享身份。

15. 可选 Access 实时 dashboard 已准备代码：固定 owner 的 RS256 JWT、loopback 只读已有账本、同源/no-store、登录过期清除页面数据与断线非实时提示。尚未部署，旧私有 Site 快照独立保留。

## Archify 版本与门禁

本次使用官方 Archify `3.0.1`，源码固定于 `d5a1333d7447c866a765adac7d4d062f2f02e4d2`。package.json 为 3.0.1；SKILL.md frontmatter 为 3.0。用户原本的 2.17 SKILL.md 仅作为历史工作流证据读取，没有安装、覆盖或升级用户现有 skill。

相对 2.17 的主要变化：

- 用一次 `finalize` 串联 showcase validate、deliver、严格 provenance check 与真实 browser-check；不再把 deterministic deliver 等同浏览器验收
- 新 lifecycle 使用 schema v2，各 lane 独立一行、共享 column 网格，转换必须显式书写
- 所有图类型支持提交固定的 repository evidence；引用校验依据 commit blob，不能把工作树改动伪装成该提交
- Viewer 阅读布局更新，旧 guided/story views 与一般 share-card 导出已移除；旧独立 HTML 保持其内嵌 viewer
- 新增语言 UI 可使用 translations；中文仍内建。3.0.1 在最终 delivery receipt 中包含有界更新提示，不自动安装
- 浏览器门包含四个桌面尺寸与深浅色端点检查；截图与人眼式图像检查独立报告

## 复现

在仓库根目录执行；将下列 ARCHIFY_BIN 替换为官方 3.0.1 checkout 中的绝对路径。需要 Node.js ≥18 与 Chrome/Chromium，初次生成环境使用 Node v24.19.0 与系统 Chromium。

```bash
ARCHIFY_BIN=/absolute/path/to/archify/archify/bin/archify.mjs
node "$ARCHIFY_BIN" finalize architecture docs/architecture/original/candidate.json docs/architecture/original/original.html --quality showcase --json
node "$ARCHIFY_BIN" finalize architecture docs/architecture/target/candidate.json docs/architecture/target/target.html --quality showcase --json
node "$ARCHIFY_BIN" finalize lifecycle docs/architecture/task-lifecycle/candidate.json docs/architecture/task-lifecycle/task-lifecycle.html --quality showcase --json
node "$ARCHIFY_BIN" finalize lifecycle docs/architecture/report-lifecycle/candidate.json docs/architecture/report-lifecycle/report-lifecycle.html --quality showcase --json
```

若候选 JSON 有变化，旧 HTML 已有浏览器证据时给新的 finalize 增加 `--out-dir docs/architecture/<diagram>/review-N`。不得手改最终 HTML，也不得覆盖不属于本轮字节版本的证据。

当前 JSON 按 system-description 范围生成。repository-draft.json 保留逐节点源码引用，但尚未满足真实 origin / 固定 commit / blob 验证，不能运行或宣称源代码来源门通过。

正式状态以 validation-manifest.json 指向的最新 receipt 与 VALIDATION.md 为准；失败或未执行的 gate 不算通过。

本轮更新说明与精确旧字节见 [VALIDATION.md](VALIDATION.md#本轮变更与精确旧字节)。执行实例更新使用官方 `deliver` → `check --require-provenance --json`，跳过仍被环境阻止且已明确要求不重试的浏览器步骤。复现中的完整 finalize 命令用于将来具备可运行 Chromium 的环境；本轮没有整体 finalize 成功声明。

最近一次图形更新为 revision 8；target 使用 revision-8-deliver.json / revision-8-check.json，未改的 task/report lifecycle 仍使用 revision-7 回执。62 文件冻结读取快照、可选 Access 只读 dashboard 与旧字节索引见 [验证记录](VALIDATION.md#可选-access-实时只读-dashboardrevision-8)。
