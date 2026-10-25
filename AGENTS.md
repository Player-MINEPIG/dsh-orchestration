# Development execution

本仓库的具体开发执行使用 **GPT-6.1-Sol，High 推理强度**，包括代码修改、问题修复、测试验证和部署操作。负责规划或协调的其他模型应把这些执行工作交给该模型，并核对结果。

这项约定只指定开发本系统的执行模型。系统内任务、工作流节点、定时计划及全局默认的运行模型属于独立配置，按用户对相应运行任务的要求设置。

# Development baseline

主 checkout 默认保持在 `dev`，仅以快进方式同步到已核实的 `origin/dev`。开发前阅读 [开发与发布流程](docs/DEVELOPMENT.md)，fetch 并核对 `origin/dev`、`origin/main` 和已部署版本。保全 WIP 后，从最新已核实的 `origin/dev` 创建新的 `codex/` 分支和独立工作树。

功能通过 PR 进入 `dev`，日常门禁只跑 Linux；普通功能和普通部署不自动涨版本。“从 GitHub 部署”或“更新机器”默认属于普通部署，不能推定为准备正式发布。

更新通过适用门禁并合入 `dev` 后，默认自动尝试部署到 `aws-vps`、`MBP`、`PC_AU`，或用户指定的目标，无须再问是否部署。用户明确“本次不部署”时，本次也不做生产预检。按 [普通部署流程](docs/DEVELOPMENT.md#deploy-to-devices) 复用已验证的确切 GitHub 包，先检查各节点真实活动，空闲节点独立推进，忙碌节点跳过或延后并报告。不得中断、取消或强制重启真实工作，不无限等待或自行创建定时重试。

只有用户明确要求正式发布时，才执行版本准备 PR、完整 Linux/macOS 发布验证、真机发布验收与确认，以及 `main` 和版本 tag 的提升。使用 npm 原生命令更新相关包版本及锁文件。固定候选和同一 tarball 完成验收后，取得用户对该候选及 tag 的明确确认，再由受信 `main` 发布工作流校验记录并原子快进和创建 tag。不得用 PR 合并、重打包或伪造验收替代。完整要求见 [正式发布流程](docs/DEVELOPMENT.md#prepare-versions-once-per-release)。

交付时核对本次适用的检查和最终 refs，仅快进主 checkout 到已核实的 `origin/dev`，报告分支、HEAD、WIP 位置及实际部署结果。普通部署和纯开发交付均不得声称已正式发布。
