# 本机项目工作区修复 0.2.42

基线为已部署 0.2.41 的 `48dc0bb`，保留该版本的回退修复。本轮只发布任务插件。

新建项目从调度端官方 `workspaceRegistry.list()` 读取本机注册项，同时保留本机已有 task 工作区授权。目录采用前重新解析注册 ID、检查真实目录；注册 ID 使用 `registry:` 命名空间，注销后不会因旧 ledger 副本而重新出现。远端 executor heartbeat 目录不再出现在新建选项中。

新 binding 明确记录 `scope: coordinator`，只表示统筹会话的 cwd，不生成 executor workspace 约束或伪造 self Node。历史无 scope binding 保持原先执行端与 workspace grant 校验。任务执行端在派发时确定。

11 项针对性回归和 Chrome 真实页面通过：纯 planner、真实官方 registry/storage、无 self Node/无 heartbeat workspace；父目录外已有仓库采用原 cwd、文件不变且无嵌套项目目录；默认父目录 fallback；注销注册与读取失败；历史远端 grant 撤销；本机项目公开调度父任务并派发 MBP 子任务，不传递本机绝对路径。页面显示“工作区”，空列表、失败和刷新状态分开反馈。

```sh
npm run build -w @dsh-task/task-system
DSH_OFFICIAL_ROOT=/path/to/installed/dsh node --test packages/task-system/test/project-workspace-selection.test.mjs tests/dsh/task-return-coordinator.test.mjs
DSH_OFFICIAL_ROOT=/path/to/installed/dsh PLAYWRIGHT_MODULE_PATH=/path/to/playwright node tests/settings/project-workspace-selection.browser.mjs
```

DMC 代码、配置、安装包不变，也未运行 DMC 业务测试。部署回执记录任务包文件、配置与业务数据、DMC 全包字节、服务健康和主机本机工作区列表验证。
