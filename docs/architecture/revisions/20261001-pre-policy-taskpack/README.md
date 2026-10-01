# 架构、任务与报告历史

这里的图比较历史移交材料中的系统描述与已批准的重构设计。历史材料 mtime 为 2026-09-07 UTC，旧文档自述当地 2026-09-08。配套 sources.md 保留源码映射，但本轮图未通过 Git 对象来源门。图不代表当前生产部署、代码验证或所有外部系统已连通。

四份独立 HTML 的 deterministic 9/9 检查通过；原版真实浏览器门因环境限制失败；本轮新版遵照要求未重试，尚无浏览器截图或 Viewer 验收；另已检查 16 张明确标记的静态 SVG 衍生 PNG。详见 [验证记录](VALIDATION.md)。

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
6. native decision bridge 提供可选单次模型提案；task_plan 由确定性授权 apply。Feishu native chat 已实现，外部连通仍待验证；session 观察按工作区配置转发，收录不能派发。
7. 执行成功、报告追加与外部送达分别记录。取消、过期 lease 和未知副作用均不能被迟到报告逆转。

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
