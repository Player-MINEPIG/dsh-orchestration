# Development execution

本仓库的具体开发执行使用 **GPT-6.1-Sol，High 推理强度**，包括代码修改、问题修复、测试验证和部署操作。负责规划或协调的其他模型应把这些执行工作交给该模型，并核对结果。

这项约定只指定开发本系统的执行模型。系统内任务、工作流节点、定时计划及全局默认的运行模型属于独立配置，按用户对相应运行任务的要求设置。

# Development baseline

主 checkout 保持在已集成并核实的 `main`。开发前阅读 [开发与发布流程](docs/DEVELOPMENT.md)，fetch 并核对 `origin/dev`、`origin/main` 和已部署版本。保全 WIP 后，从最新已核实的 `origin/dev` 创建新的 `codex/` 分支和独立工作树。

功能通过 PR 进入 `dev`。真机验收、记录被测 SHA 与包 checksum、取得用户明确确认后，才通过 `dev` → `main` PR 发布。被测 SHA 必须等于 PR head；验收期间冻结 `dev`，head 变化后重新验收。长期分支之间使用 merge，随后通过 `main` → `dev` PR 同步。交付后仅快进主 checkout 到已集成并核实的 `origin/main`，报告分支、HEAD、验收证据和 WIP 位置。
