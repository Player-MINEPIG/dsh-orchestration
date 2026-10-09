# JEV 共享模型服务替换

本轮采用方案 1：在 fork 的 JEV 插件中支持普通 DSH 模型，保持 `state + questions` 输入规范及统一输出。普通模型通过 `ctx.llm.prepareCall` 调用；服务商适配、鉴权和连接由 DSH 原生模型服务维护。

- Fork：https://github.com/Player-MINEPIG/dsh-jev-plugin，版本 0.3.1。
- 上游：https://github.com/RaulLazaro/dsh-jev-plugin，基于 `0c2dd315a7e4ba85cad638c041985941f088487c`。保留 MIT 许可及原作者版权。
- 任务插件：`@dsh-task/task-system` 0.2.2，使用 `ctx.decisionModels.ask`。
- 原 `@dsh-task/typed-decisions` 不再属于活动 workspace 或运行时依赖。源码为回滚及历史测试保留；测试夹具不安装旧服务。

## 职责与接口

模型插件负责提供商、端点、凭证引用、模型、默认配置和调用覆盖；发送请求、处理超时/取消/接口错误、解析协议返回。JEV 工具、设置页连接测试和其他插件调用共用服务。

```ts
const result = await ctx.decisionModels.ask({
  provider: 'native', // 可省略，或指定已配置的 profile ID
  model: 'deepseek-flash', // 可省略
  state: background,
  questions: {
    executor: {type: 'choice', instructions: '选择执行端',
      criteria: {local: '本机', remote: '远端'}},
  },
}, {signal})
// {provider, model, answers, usage?}；失败抛异常。
```

`nativeProvider` 在插件配置中指定 DSH provider。调用方仍负责背景、候选项、业务有效性、失败兜底、授权、调度、会话、任务状态和互联。任务侧仅保留所需的请求转换、业务校验和已有账本审计，不运行旧决策引擎。单候选由调用方直接解析，避免不必要的模型调用。

模型 HTTP 超时只限制一次调用，不能成为任务的运行预算。普通消息、补交材料、人工完成、重试、会话复用、租约和心跳继续走原任务/互联路径。迁移不修改 Task/Run/Attempt、补交 gate 或聊天 provider/model。

## 配置

Settings → JEV 编辑默认提供商和模型。普通模型使用 `provider: native`、`nativeProvider`、`model` 和可选 `reasoningEffort`；凭证仍由 DSH Models 管理。JEV/兼容接口凭证从 DSH credentials 或已有环境变量解析，配置只存引用。

可在插件标准配置编辑器中维护 `profiles`（`id/name/provider/model` 与可选端点、凭证引用、nativeProvider/effort）。任务配置 `decisionBindings` 仅保存 `task-planning`、`task-session` 对应的 profile ID；空字符串跟随插件默认。模型选择不替换调度聊天或执行聊天的模型。

`scripts/migrate-decision-config.mjs` 是纯函数：迁移旧 provider、preset、completion route 和绑定，返回 JEV 配置与任务配置差量，不读取凭证或写任务数据。旧空 rules 一直弃权，迁移时关闭相应任务模型决策开关，保持调用方确定性默认路径及原有不开付费调用的行为；原生和 JEV profiles 仍可保留。存在生效的非空 rules 时自动迁移报错，应在调用方落实这些真实业务规则后再切换。

## 安装与回滚

先保存现有 profile/package manifest、overlay、依赖锁、credential store 和 SQLite 在线备份，确认没有活跃执行、会话消息、项目轮次及租约占位。使用构建后的绝对 tarball 路径安装 `dsh-jev-plugin` 与新版 task-system，删除旧 typed-decisions bundle 及旧 completion row，应用纯配置迁移输出，然后重启原 DSH host。认证代理保持原配置。

回滚恢复备份 profile、依赖和 overlay，安装迁移前基线包后重启。数据库不需要模式迁移；不能把旧备份覆盖到重启后产生新数据的数据库。原已验证基线已单独 commit/push 到 `codex/project-runtime`（`ea4cd0d`）。

## 验证与证据

`npm run check` 覆盖共享服务、取消、超时、协议解析、调用方业务拒绝及现有任务/互联回归。`npm run test:distribution` 使用固定官方 DSH 0.2.0-rc.2，将实际 tarball 安装进隔离 profile，boot、调用服务/工具、卸载并验证状态保留。发行测试使用 ScriptedModel：原生接口实际调用，远程付费模型调用未发生。真实服务商探测与部署状态应单独报告，不能由离线测试推断成功。

最终源码回归：738 通过、5 跳过。MBP 与 VPS 已安装 JEV 0.3.1 / task-system 0.2.2，移除旧插件和临时探测行；原生 DeepSeek 探测实际成功（补丁只修复不同提供商凭证引用，原生实现未变），重启后服务、设置接口与原任务数据一致性检查通过。见 [代码验证](validation/jev-migration-20261009.json) 与 [部署证据](validation/jev-deployment-20261009.json)。TypeSafe 等外部 JEV 提供商未做真实付费调用，需按所选服务商配置凭证后测试。

## 远程浏览器设置修复

JEV 0.3.2 改用 DSH rc.2 的 `settings.section` 注册独立 JEV 设置页；task-system 0.2.3 的快捷入口同步跳转到该页。原始 `settings.plugin.item` 槽位已不存在。

VPS 的 Tailscale 身份代理启用 `hostSettings: true`，只调整官方设置镜像的持久化选择。DSH 的非 localhost 页面原本选择内存设置，导致 Models 无法读取主机配置；代理的身份、Origin、Host 校验及 DSH 原生认证保持原有行为。DSH 升级后需重新验证该兼容点。

已通过 MBP Chrome 访问实际 HTTPS 入口验证 Models、JEV 页和任务设置跳转；没有保存模型配置或再次发起付费连接测试。741 项回归通过、5 项跳过，双端配置语义与受保护任务记录保留。安装器将旧平铺配置转为 bundles + cordis.patch.yml；已使用 DSH 配置合成逻辑和原启动覆盖层核对。见 [浏览器验证记录](validation/jev-browser-settings-20261009.json)。

JEV 0.3.3 的普通模型设置改为提供商、模型、思考强度联动选择。选项直接来自 DSH `listProviders`、`listModels` 和 `resolveModelInfo`，不发送生成请求；切换提供商或模型会清空关联草稿中的旧选择，保存前不改配置。三个控件宽度为 24rem，小屏受容器宽度约束。已在实际 VPS 地址验证选项、宽度和模型切换重置；66 项针对性测试通过。见 [选择控件验证](validation/jev-model-selectors-20261009.json)。
