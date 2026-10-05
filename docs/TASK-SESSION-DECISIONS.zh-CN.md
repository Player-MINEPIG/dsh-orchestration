# Task Session / Workspace 决策合同

## 依赖与配置

`@dsh-task/typed-decisions` 保持独立；任务系统是消费者，决策包不依赖任务账本、调度器或执行器。

任务运行配置只新增：

- `defaultWorkspaceId: string | null`：未指定 Run / Task 工作区时使用的已登记工作区
- `sessionDecisionEnabled: boolean`：默认 `false`，开启后使用已有 `typedDecisions` 服务的 provider / model 配置

Run / Task 显式工作区先于配置默认值，调用者把有效值写入快照的 `defaultWorkspaceId`。缺少合法工作区是配置错误，不猜路径。超时与重试沿用决策插件已有配置。

## 输入与输出

执行器提供 `TaskSessionSnapshot`：Task、节点、有效默认工作区、已有 Task 绑定，以及有限的授权工作区和 Session 候选。Session 只来自权威绑定，且必须属于同一 Task 和节点；历史观察消息不能自行成为可复用 Session。

决策请求含两个 `choice` 问题：

- `session`：`new` 或有限的 `reuse-0`、`reuse-1` 等候选键
- `workspace`：快照中的合法工作区 ID

普通 LLM 输出严格 JSON，例如：

```json
{"answers":{"session":{"type":"choice","choice":"new"},"workspace":{"type":"choice","choice":"project"}}}
```

Jev / 兼容 API 的 `answers` 使用相同的 typed choice 结构。传输层模型版本、用量、Jev 概率字段由已有适配器验证并归一到 `DecisionReceipt`；普通 LLM 不生成虚假的校准概率或 API 用量。任务消费者只依赖同一份 receipt 和有限候选，不依赖具体供应商。

结果：

```ts
{
  source: "decision" | "default",
  session: { mode: "new" } | { mode: "reuse", sessionId: string },
  workspaceId: string,
  reason?: string,
  receipt?: DecisionReceipt
}
```

结果只是选择建议。执行器必须在已租赁的权威操作中再次校验并提交绑定，再创建或恢复 DSH Agent。决策不能授予工具权限、跨节点复用 Session、生成任意路径或创建工作区。

## 默认与失败行为

未启用、缺少决策服务、provider 失败、已有引擎超时、弃答、JSON / schema 校验失败、过期或候选变化时，使用默认选择：

1. 没有 Task Session 绑定：在有效默认工作区新建一次
2. 已有兼容绑定：复用同一 Task Session
3. 已有绑定不可用或与有效工作区不一致：明确配置 / 策略错误，不悄悄创建第二个默认 Session

有效决策可以选择新 Session、同 Task 的可复用 Session，以及候选工作区。复用 Session 必须留在原工作区。调用者取消或卸载中止会传播取消，不把取消转换成默认执行。

## 调用入口

`session-default.ts` 无决策插件运行时依赖，导出 `defaultTaskSessionSelection(snapshot, reason?)`。

启用且存在服务时才动态加载 `session-policy.ts`，调用：

```ts
resolveTaskSessionDecision(snapshot, {
  requestId,
  decisions,
  signal,
  currentSnapshot: () => readCurrentAuthoritativeSnapshot(),
})
```

`currentSnapshot` 在响应后重新读取权威状态；原始有效期不会因重新读取而延长。底层 `buildTaskSessionDecisionRequest` / `consumeTaskSessionDecisionReceipt` 也单独导出，供需要自行持久化 receipt 的调用者使用。

## 协议依据

仓库既有 Jev 适配器采用官方 `POST https://api.typesafe.ai/v1/systemone` 协议；本轮复核 [TypeSafe API](https://docs.typesafe.ai/api) 与 [模型说明](https://docs.typesafe.ai/models) 后复用，未引入另一套供应商协议。
