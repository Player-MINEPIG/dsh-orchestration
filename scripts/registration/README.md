# 项目登记：现有任务面板与 `/project`

登记数据进入现有中央 TaskLedger，项目和分组投影到 Workbench，供插件原有「项目与任务」面板使用。登记本身不创建执行 Attempt、不启动模型或远端 session。源项目的完成声明与中央复核独立。

## 在 DSH 当前会话使用

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
- `status` 显示本机待发送与已收到中央确认的版本，不声明这些就是中央最新实时状态。

首个登记之后，完整快照必须连续递增 `revision`，`previousRevision` 指向前一个版本，保留既有身份，已入账报告及终态 Run 不能重写。旧快照重放只返回原回执，不倒退中央投影。人工复核通过中央登记元数据操作，来源不会覆盖它。

历史项目需由 agent 或其他程序先把资料整理成协议快照；命令不自动推断项目内容。准备好的协议文件可由命令、agent 工具、通用 CLI 或 HTTP 发送，均经过同一 intake/outbox。

## 执行端连接中央

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
