# 项目登记：现有任务面板与 `/project`

登记数据进入现有中央 TaskLedger，项目和分组投影到 Workbench，供插件原有「项目与任务」面板使用。登记本身不创建执行 Attempt、不启动模型或远端 session。源项目的完成声明与中央复核独立。

## 激活当前会话协作

标准插件 bundle 会加载项目命令。执行 `/project` 或 `/project start 项目标题` 后，插件把当前节点、会话、工作目录绑定到中央现有 TaskLedger；收到中央确认后才激活。后续正常描述工作即可，由 agent 按随包发布的 skill 查询现状、选择真实执行路线、派发任务、同步进度并提交待复核。

```text
/project
/project start 我的项目
/project status
/project leave
/project attach <projectId>
```

绑定保存于本机任务数据库，项目与业务任务保存在中央原数据库。恢复同一会话、原节点和原目录时，官方 systemPrompt.section 接口再次加载 skill，不需要重新激活。`leave` 暂停注入；再次 `/project` 恢复原项目。`attach` 用于同一节点、同一工作目录下已登记的协作项目，不接受任意中央项目或历史补录项目。

协作工具为 `project_status`、`project_nodes`、`project_dispatch`、`project_progress`、`project_finish`。插件注入身份，模型不能指定任意 projectId；写入使用稳定 requestId，重试保留同一请求内容。`project_finish` 只提交待复核，不能代替人工验收。未激活的会话不注入 skill，受管执行任务继续使用既有 task 协作工具。

远端协作复用任务执行端已有 coordinator 配置及认证通道，中央必须为该节点显式授权 `projectCollaborate`。同一节点的多个进程需使用同一远端 recovery store，保持发送序号一致。中央不可用或暂停时不回落为本地第二个调度中心。执行路线由认证心跳公布，CLI 路径、凭据和宿主配置不进入模型查询结果。

## 历史补录与显式快照

下列原有命令独立保留，不会替代当前会话协作。

宿主加载 `@dsh-task/task-system/project-registration/plugin`，配置授权 `namespaces`。交互宿主已有官方 `@deepseek-ai/dsh-commands` 时会自动发现 `/project`，无需向模型发送命令。

默认文件是当前会话工作目录的 `.dsh/project-registration.json`，格式为 `dsh.project-registration/v1`。也可指定绝对路径，路径含空格时用双引号。命令只读取指定文件，不扫描会话、Git、媒体或其他目录。

```text
/project preview
/project register
/project sync
/project submit
/project history "历史项目.json"
/project status
/project help
```

- `preview` 校验并显示项目、来源、版本和各类证据计数，零写入。
- `register` 发送 `mode: live, revision: 1, previousRevision: 0` 的完整快照。
- `sync` 发送当前 `live` 快照并重试待发送队列；更新需要新版本及新幂等键。如果默认文件已移走，仍可重试队列。
- `submit` 发送 `mode: final` 且项目状态为 `completed` 或 `archived` 的最终快照，成功后该来源项目封存。
- `history` 首次登记 `mode: history` 历史快照并封存，不伪造原始时间或执行链。
- `status` 显示当前协作绑定、待确认/被拒绝操作，以及历史快照的本机发送状态；不声明这些就是中央最新实时状态。

首个登记之后，完整快照必须连续递增 `revision`，`previousRevision` 指向前一个版本，保留既有身份，已入账报告及终态 Run 不能重写。旧快照重放只返回原回执，不倒退中央投影。人工复核通过中央登记元数据操作，来源不会覆盖它。

历史项目需由 agent 或其他程序先把资料整理成协议快照；命令不自动推断项目内容。准备好的协议文件可由命令、agent 工具、通用 CLI 或 HTTP 发送，均经过同一 intake/outbox。

## 历史快照的远端 intake 配置

执行端使用显式 `endpoint`、`outboxPath`、`tokenEnv`；令牌只从宿主指定环境变量读取。离线时保存到 outbox，用户看到「中央尚未确认」，恢复后 `/project sync` 重试。收到匹配版本和摘要的中央回执才标记 acknowledged。

HTTPS 默认允许。Tailscale 等受信网络的明文 HTTP 必须显式配置：

```json
{
  "namespaces": ["mbp/local"],
  "endpoint": "http://100.123.230.75:43872/v1/registrations",
  "outboxPath": "/isolated-test/profile/registration-outbox",
  "tokenEnv": "DSH_REGISTRATION_TOKEN",
  "trustedNetwork": {
    "address": "100.123.230.75",
    "port": 43872,
    "localAddress": "100.111.163.32",
    "allowHttp": true
  }
}
```

这些地址是测试配置示例，部署时由宿主指定。客户端绑定本机地址、核对目标和源 socket 后才发送令牌和正文，不使用 DNS、代理或重定向。中央另行验证来源 IP 与 bearer 授权的 namespace。

通用 CLI 复用同一客户端：

```sh
node scripts/registration/cli.mjs validate --packet /path/project.json
node scripts/registration/cli.mjs enqueue --packet /path/project.json --outbox /path/outbox
node scripts/registration/cli.mjs flush --outbox /path/outbox --endpoint http://100.123.230.75:43872/v1/registrations --token-env DSH_REGISTRATION_TOKEN --trusted-network /path/network-target.json
```

`network-target.json` 仅包含上例 `trustedNetwork` 对象。文件上报不复制引用的媒体，产物引用保持可用性未知。`serve` 子命令是旧的仅回环测试辅助服务；正式 trusted-network 监听由宿主管理，并提供来源地址授权。
