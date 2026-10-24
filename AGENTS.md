# Development execution

本仓库的具体开发执行使用 **GPT-6.1-Sol，High 推理强度**，包括代码修改、问题修复、测试验证和部署操作。负责规划或协调的其他模型应把这些执行工作交给该模型，并核对结果。

这项约定只指定开发本系统的执行模型。系统内任务、工作流节点、定时计划及全局默认的运行模型属于独立配置，按用户对相应运行任务的要求设置。

# Development baseline

主 checkout 默认保持在 `dev`，仅以快进方式同步到已核实的 `origin/dev`。开发前阅读 [开发与发布流程](docs/DEVELOPMENT.md)，fetch 并核对 `origin/dev`、`origin/main` 和已部署版本。保全 WIP 后，从最新已核实的 `origin/dev` 创建新的 `codex/` 分支和独立工作树。

功能通过 PR 进入 `dev`，日常门禁只跑 Linux；普通功能 PR 不逐次涨版本。正式发布准备时用 npm 原生命令更新相关包版本及锁文件，并先合入候选。发布前在 `dev` 对固定候选 SHA 手动运行完整 Linux/macOS CI，使用其保留的同一 tarball 完成真机验收，并取得用户明确确认。通过受信 `main` 的发布工作流校验记录后，将 `main` 快进到该候选并原子创建版本 tag；不得用 PR 合并、重打包或伪造验收替代。`dev` 可继续推进，但被测候选和包 checksum 不得变化，且候选必须仍包含当前 `main`。验收只填写简短摘要、详细记录和用户确认；完整记录先保存到 Actions artifact，tag 仅保留摘要及 CI 链接。详见流程中的输入、版本准备、权限失败处理与门禁要求。

交付后核对完整 CI、验收记录和最终 refs，再仅快进主 checkout 到已核实的 `origin/dev`，报告分支、HEAD、tag、验收证据和 WIP 位置。纯开发交付不得声称已发布；没有真实验收与用户确认时保留在 `dev`。
