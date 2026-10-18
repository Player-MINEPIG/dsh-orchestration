# 看板反馈部署回执

2026-10-18 已部署到 aliyun-vps，用户入口返回 HTTPS 200。代码为 `68ef21e47b522fe2b00c758897865f12d5daa002`，部署前已推送到 `origin/codex/dashboard-feedback`。包版本仍为 `@dsh-task/task-system@0.2.24`，本次包由提交与 SHA-256 区分。

包 SHA-256 为 `9f2f25d53e88c012989c812a6d352686cd61a13068f1eb56164a5c3232501b5f`。线上安装的283个文件全部匹配。实际运行服务返回的项目页与工作流页也分别匹配构建产物哈希。完整字段见[机器回执](dashboard-feedback-20261018.json)。

## 切换与保全

UTC 06:27:48.056 停止原服务，06:27:49.696 激活候选profile，06:27:49.754 请求启动。墨尔本时间为17:27。上述时间不代表页面就绪耗时。服务新PID为1412890，状态active/running，自动重启次数0；验收时启动后的warning及error日志计数0。

切换前19个会话均未运行，本机队列和任务Run/Attempt租约为空，项目会话轮次为空。远程dispatch/outbound为空，13个程序dispatch均acknowledged。本地Codex默认未启用，无启用覆盖、状态数据库或Codex进程。官方插件管理器先在私有profile副本安装，全部核对通过后才切换生产profile并重启现有服务。

只替换任务插件。DSH runtime保持0.2.1-rc.2，认证代理、模型、设备容量、执行目录、个人插件和其他插件内容不变。没有部署MBP或PC_AU。

上线后62个Task、99个Run、91个Attempt、92份Report和4个Schedule保留。七类实体、十张计划/项目/目录表与备份前逐行哈希一致。38个原会话文件逐字节一致。新增阅读与呈现表均0行，验收没有代用户阅读报告、验收结果或提升子任务。

## 接口验收

实际 `workflowView` 默认历史摘要省略output；选中非latest历史保留完整output。该历史的三个步骤均匹配指定Task、Run和Report，未回退任务最新结果。报告快照含内容版本和阅读字段。没有用真实任务发起有副作用执行。

初始插件加载缓慢在部署前已出现。偶发断连仍未定位，本次有限减载不构成断连根因修复。生产浏览器自然加载后无失败插件提示。主列表有2个根交付，需处理1、已完成1、待确认0；已完成未读筛选通过。日报卡保留9份未读与17项历史派发提示，普通子任务未平铺。真实条目不足5条，线上未额外验证翻页。只读验收未打开报告，最终阅读与呈现表仍为0行。截图归档在执行记录中。

## 备份与回滚

备份目录为 `/opt/dsh-production/releases/dashboard-feedback-68ef21e/backup`。目录保留当前profile、38个会话文件、四个SQLite一致备份、停服后的数据库副本及systemd定义。回滚脚本为同发布目录的 `rollback.py`，原始profile另存 `/root/.dsh/profiles/web.dashboard-68ef21e-before`。

回滚先确认会话、任务和Codex空闲，再运行：

```sh
python3 /opt/dsh-production/releases/dashboard-feedback-68ef21e/rollback.py --confirmed-idle
```

脚本恢复旧profile并重启原服务，保留当前数据库。新建的阅读/呈现表可被旧代码忽略。不要把历史备份覆盖到已产生新数据的数据库。
