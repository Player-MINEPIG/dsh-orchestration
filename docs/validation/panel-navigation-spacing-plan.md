# 面板间距与来源返回
目标：全局统一段落到按钮/卡片的间距；跨项目、任务、计划、执行详情跳转后返回实际来源，恢复筛选、详情与滚动。
阶段：完成实现、47 项测试、两端原面板验收与合并前审查。独立 worktree / codex/panel-navigation-spacing，基于 codex/project-runtime @ 80b57ab。
决定：只保存前端视图与阅读位置，不回滚账本，不重放业务操作。全局入口仍直接导航，返回箭头与详情关闭使用来源历史；无来源时保留上级回退。
验收：针对多层跨页、详情往返、筛选及滚动保留的测试；两端原面板 Tailscale 验收。仅隔离测试服务，默认 DSH/PV/Hermes 不动。验收后合并并更新 HTML 报告。
流程：project-collaboration / systematic-debugging / code-review-and-quality。

证据：panel-navigation-spacing-evidence.json；HTML 报告含实测间距、来源返回路径与截图。仅隔离 UI 服务变更，没有业务任务修改或模型调用。
