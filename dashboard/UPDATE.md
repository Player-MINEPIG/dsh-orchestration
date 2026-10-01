# 更新同一份任务视图

## 1. 追加有来源的业务进展

仅写用户可见的简洁状态、完成项、限制和下一步，不复制原始会话、系统提示、私有笔记或凭据。先将报告正文放入本地 UTF-8 文件，然后从 project 根目录运行：

```sh
node dashboard/record-status.mjs \
  --task hermes-to-dsh-plugins \
  --report dsh-host-validation-20261001 \
  --title '宿主验证进展' \
  --body-file .runtime/status-body.txt \
  --observed-at '2026-10-01T20:30:00Z' \
  --state running
```

上例时间和报告 ID 是参数示例，实际执行必须使用真实观察时间和这条新报告的稳定唯一 ID。

此脚本只更新**已存在的 observed 任务**，通过共享核心 `importSnapshot()` 追加报告与事件。不会另建数据库，不创造 Run 或 Session，不重写旧报告。相同报告 ID 与相同内容重放无副作用；同 ID 内容不同会报错。较旧的补充报告保留进历史，不倒退最新任务状态。追加报告保留现有 `admissionState`，不会让已排除任务重新进入日常列表。真正由 DSH 管理的任务应走 Task Service 的执行与报告接口，然后相同视图自然读到它们。

## 2. 从同一 ledger 重新导出

```sh
node dashboard/export.mjs \
  --ledger .runtime/tasks.sqlite \
  --out /workspace/shared/dsh-orchestration/dashboard-site/dist
npm test --workspace @dsh-orchestration/dashboard
```

不要手改导出后的 snapshot.json，也不要把例子或测试数据写进实际 ledger。快照保留 source.observedAt，各任务保留自己的 updatedAt，导出时刻不会被伪装成新进展。

## 3. 更新现有私有 Site

使用操作员保存的现有 Site 身份与 checkout，身份文件为 `.openai/hosting.json`。实例 ID/网址位于私有运行记录，不写入通用源码。**不调用 create_site，不新建站点，不改变分享范围。**

按当前 Sites hosting 技能更新这一 checkout：先读取现有 Site 确认 owner-private，再用官方 `site-workflow.mjs` 推送精确源码并打包，最后 native `save_version_and_deploy_private` 更新同一 Site；非终态用对应 deployment ID 验证成功。使用工具返回的当前短时源码发布会话，仅放在内存/stdin，绝不嵌进前端或存到文件。若会话过期而当前指令不允许续取，停在导出完成状态并报告；不能假称已发布。此说明不授权创建长期凭据、开放公网后端或扩大分享范围。

新 URL 不需要重新发送；已有 URL 保持不变。只在有实质更新时向用户说明本次快照截至时间与新结果。
