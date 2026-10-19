# DSH Feishu channel

`@dsh-task/feishu-channel` is a native Cordis service mounted in a DSH host. It provides Feishu text input, text/card output, durable incoming-event handling and optional task controls/report delivery. It has no daemon, HTTP listener, process supervisor, credential setup or automatic model selection. The bundle is **disabled by default**.

The pinned transport is the official `@larksuiteoapi/node-sdk@1.74.0`. It uses `WSClient`, `EventDispatcher` and `Client.im.message.create/reply`. The lower-level dispatcher is intentional: its handler awaits durable acceptance before the SDK acknowledges the event, while the package controls retries and replay itself. Plugin activation waits for the SDK `onReady` handshake, rather than treating `WSClient.start()` as a successful connection.

## Enable in a DSH profile

Install the package in a host with Node 24+, Cordis 4.0.4 and Schemastery 3.18.4. Merge its `dsh.bundle.yml` through the normal DSH bundle loader. Populate configuration with existing environment-variable references and explicitly allowed provider IDs:

```yaml
enabled: true
databasePath: /private/host-state/feishu-channel.sqlite
appIdEnv: DSH_FEISHU_APP_ID
appSecretEnv: DSH_FEISHU_APP_SECRET
domain: feishu
allowedChatIds: [oc_your_chat]
allowedUserIds: [ou_your_operator, ou_your_chat_user]
operatorUserIds: [ou_your_operator]
taskIntegration: true
callbacksEnabled: false
narrativeEnabled: true
```

`appIdEnv` and `appSecretEnv` name variables already supplied by the host; they are not credentials. Empty allowlists fail closed when enabled. IDs come from authenticated provider event fields. An operator must also be an allowed sender. A title, mention, quoted prompt or purported role in message text never changes the sender's authority. Use one mounted owner per database and one active channel deployment for the configured app; SDK long connections distribute events among app connections rather than broadcasting them.

The operator configures the existing Feishu self-built app to receive `im.message.receive_v1` by long connection and grants the app its intended message read/send permissions in Feishu. No app, secret, scope grant or live message is created by installing or testing this package. `domain: lark` selects the official Lark API domain; the operator must verify long-connection availability for that app/region. No custom API host is accepted.

## Native DSH conversation and planner

Ordinary natural-language messages can run directly through the supplied `@dsh-task/feishu-channel/dsh-chat` plugin. A custom consumer is not required. This entrypoint uses the host's real `ctx.agents.create/resume`, scoped tools, AgentLoop and persisted sessions. It is opt-in; the channel bundle does not import it automatically.

The host must already load its provider adapter and the pinned DSH `0.2.1-rc.2` services: `@deepseek-ai/dsh-llm`, `dsh-session`, `dsh-session-projection`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-session-persistence-jsonl` (or the host's persistence provider), and `dsh-agent-loop`. Use the full `@deepseek-ai/` package prefix for each. The ordinary chat entrypoint works without task-system. The plain channel entrypoint does not load these optional DSH peers.

After enabling the channel as above, explicitly merge [`dsh-chat.patch.example.yml`](./dsh-chat.patch.example.yml), replacing `YOUR_EXISTING_PROVIDER` and `YOUR_EXISTING_MODEL` with the host's existing route. Set `reasoningEffort` only when supported by that route. Equivalent native Loader entry:

```yaml
- id: feishu-chat
  name: '@dsh-task/feishu-channel/dsh-chat'
  config:
    enabled: true
    databasePath: /private/host-state/feishu-chat.sqlite
    provider: YOUR_EXISTING_PROVIDER
    model: YOUR_EXISTING_MODEL
    reasoningEffort: ''
    allowedTools: []
    taskIntegration: false
    plannerTools: []
    timeoutMs: 110000
```

With that configuration, two ordinary Feishu messages receive two separate native turns and replies in the same persisted conversation. Bindings include authenticated chat ID, thread ID (or no thread), and sender ID, so different senders or threads cannot inherit each other's conversation history. The incoming message ID supplies a stable invocation ID; the exact native message ID and owning session are journaled before driving the agent. The channel's transactional response path correlates each reply with the exact original provider message and commits the reply together with inbox settlement.

To enable natural-language task planning, load task-system with a planner-capable role, set `taskIntegration: true` in both the channel and chat configurations, retain the channel's explicit `operatorUserIds`, and list only intended planner tools:

```yaml
# In the feishu-chat configuration:
taskIntegration: true
plannerTools: [task_query, task_history, task_create, task_dispatch, task_repair_dispatch, task_report, task_cancel]
```

Only authenticated senders in the channel's operator list receive these tools. Every invocation is also guarded at execution time, including malicious model calls to hidden tools. Sender claims in message text cannot enable them. `task_plan` can be added for proposal-only review; task-system remains optional. `allowedTools` is a separate explicit host-tool allowlist and rejects all `task_*` names. Keep it empty for a conversation/planner-only profile; adding shell, file, network or composite tools delegates those capabilities to the allowed senders and must be an intentional host policy. The chat planner cannot call task execution/settlement tools or provision physical workspaces. Task command/request IDs must use the current incoming invocation's namespace, supplied to the agent through its host prompt.

The plugin checks the exact input's admitted turn, its persisted completed boundary and its own final text before returning a reply. Agent idle is only a drain condition and never establishes task success; actual task outcomes remain in TaskLedger. It rejects foreign queued/steering input and never attributes an unrelated turn's answer to the current request.

Native chat owns a separate SQLite ownership journal with full-sync WAL. Completed sessions resume across unload/restart; admitted requests interrupted by timeout, cancellation or host loss become uncertain. Their conversation is held, including later messages, rather than replaying a prompt that may already have caused effects. The trusted in-process `ctx.feishuChat.inspect()` exposes request/session identities. After inspecting actual effects, an operator can use `ctx.feishuChat.reconcile(invocationId, { reason: 'Evidence and disposition' })`; this retires the interrupted session, records the evidence and opens a fresh binding for a new incoming request. It never retries the old input, changes TaskLedger outcomes or reconciles provider delivery uncertainty. Use the separate channel/core delivery reconciliation APIs for that. These APIs are not model tools or chat commands.

Use one mounted owner per chat journal. Default limits are 100,000 request records, 10,000 conversation bindings and 8,000 reply characters. The journal retains request deduplication records and stops at its limit; perform deliberate offline archival/rotation with retained identity evidence rather than deleting unresolved requests. `timeoutMs` must be shorter than the channel's `consumerTimeoutMs` so the native consumer cancels its owned handle first. Unload detaches the consumer, cancels/drains its owned handles and closes its journal; the host and unrelated agents continue running. Native sessions retain private chat/tool content under the host persistence policy.

## Custom ordinary-chat consumers

The task-system package is an optional peer and is not imported at runtime. Hosts that want a different conversation policy can register one custom consumer instead of the supplied native chat plugin. For example, this complete Cordis plugin provides an offline echo consumer without a task database or model:

```ts
import type { Context } from '@deepseek-ai/cordis';
import '@dsh-task/feishu-channel';

export const name = 'my-feishu-chat';
export const inject = ['feishuChannel'];
export function apply(ctx: Context) {
  const detach = ctx.feishuChannel.consume(async (message, context) => {
    context.signal.throwIfAborted();
    // Replace with the host's configured DSH agent/chat handler.
    // context.invocationId is stable; senderId is transport-authenticated.
    return { text: `Received your message: ${message.text}` };
  });
  ctx.effect(() => detach);
}
```

With `taskIntegration: false`, ordinary messages still work through that consumer. Without a consumer, messages remain durably queued after their receipt is sent; the plugin does not invent a chat agent. Registering a consumer later drains them. Consumers must respect the abort signal and treat message text as untrusted content. They should bind any native DSH agent/session through their own configured host policy, retain the stable invocation ID and avoid arbitrary task execution. The channel provides sender, chat, message, reply-parent, thread and creation-time correlation. Processing preserves arrival order; it does not reorder history based on sender claims or automatically replay interrupted consumers.

A trusted host plugin can independently queue output:

```ts
ctx.feishuChannel.send({
  deliveryId: 'my-feature:stable-operation-id',
  chatId: 'oc_your_chat',
  category: 'narrative',
  body: { text: 'A useful update' },
});
```

Choose a stable delivery ID for each intended effect. Reusing an ID with changed content is rejected. `replyTo` optionally identifies the exact provider message to reply to. The adapter never silently changes a failed reply into a new message.

## Task integration

When enabled, the plugin optionally injects the actual `ctx.taskSystem` service. No task service means task commands receive a control failure; ordinary chat stays available. Only configured operator IDs may use task commands, including reads:

- `/task help` and `/task list`
- `/task create <title>` creates a logical task; it does not create a project directory or execute workload
- `/task status <taskId>` renders authoritative task/run state
- `/task report <taskId> [reportId]` renders the latest or exact immutable report
- `/task approve <taskId> <revision>` and `/task reject <taskId> <revision>` record an explicit operator decision for that exact task-confirmation revision
- `/task dismiss <taskId> <admissionRevision>` and `/task restore <taskId> <admissionRevision>` reversibly change whether the task appears in ordinary task views
- `/task continue <taskId> <blockedRunId>` calls the core's atomic `continueRun`, creating a correlated new run for the exact current blocked run
- `/task cancel <taskId> <runId>` requests cancellation of the exact latest live run and drains a locally owned native execution when present

Unknown outcomes cannot be continued. Old/reordered controls cannot operate a newer run. Historical reports retain their own run identity; they do not show controls for a replacement run. Cancellation requested and execution stopped remain separate states. The executor/native owner must acknowledge actual stop in the task core.

Set `requireConfirmation: true` on the task-system plugin to require confirmation for new task intent and each queued run plan. Confirmation cards show the current revision and work even before a run exists. Approval of a task before queueing does not preapprove a later plan: changing task intent or queueing a new run invalidates the old confirmation revision. Commands require an exact positive revision and derive the audit actor from the authenticated Feishu open ID. Ordinary chat, an assistant reply, a task report and model tool output cannot grant approval. Only explicit configured-operator commands or the corresponding bound card buttons call the trusted `setTaskConfirmation` API. Repeated/stale decisions are rejected without replay; core rules also prevent changing confirmation while execution remains active or uncertain.

Admission has its own revision, shown on status cards. Dismissing a task removes it from `/task list` and suppresses automatic task-report pushes; it does not cancel running work, change its outcome, or delete reports. Explicit `/task status` and `/task report` remain available to operators. Restore requires the current admission revision and makes the task visible again. Existing unsent report deliveries remain pending while dismissed and may proceed after restoration. Admission revision and confirmation revision are separate; changing visibility does not approve work. The optional native chat adapter accepts `task_curate` only when explicitly listed in its operator `plannerTools`; direct commands preserve the transport-derived operator identity. No task-approval tool is exposed to the model.

Task settlement can enqueue notifications in the core's existing transactional outbox:

```ts
notifications: [{
  destination: 'feishu:chat:oc_your_chat',
  kind: 'report', // task-state, result, feishu.task-state and feishu.report also supported
  payload: null,
}]
```

The delivery worker claims with `claimDelivery`, renders from authoritative task/report records, sends, then commits `finishDelivery`. Payload text cannot forge task state. Provider receipts include the exact message ID. Notification send success never establishes workload completion, and failed delivery never changes the recorded workload outcome. Destinations outside configured chats are left unclaimed for operator correction. Ordinary/control conversation messages use the channel's own outbox; task notifications use the task core's outbox.

Trusted task packs can install schema-specific report renderers with `ctx.feishuChannel.registerTaskReportRenderer(schemaId, ({ task, run, report }) => ({ card }))`. The callback receives the authoritative stored report and its exact run, including `report.data` and `report.schemaId`; notification payloads cannot select a schema or provide replacement data. The callback must semantically revalidate the report and any evidence it relies on before returning text or a card. It must be side-effect free. Output has the configured payload-size limit and a bounded rendering deadline. The returned generation-safe disposer unregisters only its own registration, including across Cordis service tracing.

The `legacy-report` and `legacy-report-error` delivery kinds require a stored structured report plus a registered schema renderer. If that renderer is unloaded or absent, delivery stays pending without a provider attempt; loading the task pack resumes it. Invalid schema data, failed evidence revalidation or oversized output fail before sending. These kinds never silently downgrade to a generic card. The optional legacy task pack registers its validated Agent Daily, Game Daily, node-summary and failure-receipt renderers through this API. A provider timeout still becomes uncertain, and reinstalling a renderer cannot replay that unknown send. Ordinary report kinds can use registered schema renderers while retaining the generic authoritative task/report card when no specialized renderer was requested.

Task cards always include explicit slash commands. `callbacksEnabled: true` additionally subscribes to `card.action.trigger` and renders v2 buttons. Enable only after that app's callback subscription works over its authenticated long connection. An action must match its random persisted correlation token, authenticated operator, allowed chat, exact sent provider message, task, applicable run and expiry. Confirmation buttons additionally bind the exact confirmation revision; before queueing they bind the task, and for a queued plan they bind its run. Repeated clicks are consumed once. Stale/unknown/cross-chat/cross-message controls are rejected. A crash between sending a card and binding its provider receipt may leave buttons unavailable; the explicit slash commands remain usable. There is no unsigned HTTP callback endpoint or model-text approval shortcut.

Set `lifecycleDestinations: ['feishu:chat:oc_your_chat']` on the task-system plugin to opt into task creation and terminal run updates. The core records one durable `lifecycle.created` message anchor per task and destination. Each `lifecycle.terminal` delivery identifies its exact run and depends on that creation delivery. It replies to the creation message only after its sent Feishu receipt contains the provider message ID. A pending, failed or uncertain creation keeps terminal updates pending; there is no new-message fallback. A verified operator reconciliation can supply a missing creation receipt, after which waiting updates can proceed. Later runs reuse the same anchor across host restarts. Terminal cards show the authoritative run state, including blocked or uncertain; delivery failures do not change execution outcomes. These lifecycle pushes follow task visibility, while explicit history remains available.

## Alert controls and delivery

The same authenticated operator policy applies to alert reads and state changes. Alerts have independent identities, revisions and recurrence cycles; acknowledging or resolving an alert never settles or cancels task execution.

- `/alert list` shows open and acknowledged alerts; `/alert list all` also includes resolved history
- `/alert show <alertId>` renders the current alert and its current revision
- `/alert ack <alertId> <revision>` acknowledges an open alert
- `/alert resolve <alertId> <revision>` resolves an open or acknowledged alert
- `/alert ack-many <alertId>@<revision> ...` and `/alert resolve-many <alertId>@<revision> ...` apply one atomic change to 1–20 explicitly named, unique alerts

For example, `/alert ack-many alert-a@3 alert-b@8` acknowledges exactly those two revisions. A missing/stale/ineligible alert or duplicate ID rejects the whole bulk command without partial changes. The authenticated sender ID supplies the audit actor; an identity written in message text is ignored. Old commands cannot resolve a newly reopened alert cycle because their revision is stale. Alert cards contain these explicit commands rather than a second callback target format.

Set `alertDestinations: ['feishu:chat:oc_your_chat']` on the task-system plugin to opt into automatic alert delivery separately from task-report destinations. Alerts can exist without a task. The channel accepts core `kind: 'alert'` deliveries only with a durable `alertId` and renders the current alert through `ledger.getAlert`; notification payloads cannot supply an alert status or impersonate another alert. The core coalesces older pending alert intents; a lost provider response still leaves the affected send uncertain and does not cause automatic replay. Alert state, delivery state and task outcome remain independent. Task-linked alert pushes wait while their task is dismissed; standalone system alerts remain independent of task visibility, and alert history stays available.

## Runtime tool approval and connectivity checks

Runtime tool approval is independent of task confirmation. The native runtime captures an exact live tool call as an `ApprovalRequest`, including its execution, session, agent, call ID, arguments digest, safe action description, current lease and short expiry. No model approval-response tool is exposed.

- `/approval list` lists pending runtime requests
- `/approval show <requestId>` shows the full captured safe action description and exact call identity
- `/approval once <requestId> <revision>` allows that one live call when its trusted descriptor permits remote review
- `/approval deny <requestId> <revision>` denies that one pending call

These reads and decisions require a configured operator in an allowed chat. Review the concrete action before deciding. A revision mismatch, expired request, ended execution, stale lease or already decided request rejects the action. `allowRemoteOnce: false` requests show only denial controls and require review in the host approval UI to allow them. An operator identity in text, ordinary chat or a model response grants nothing. Recording `allowed-once` does not claim the native tool executed or the task completed, and never creates an always-allow rule.

Set `approvalDestinations: ['feishu:chat:oc_your_chat']` on the task-system plugin to deliver these requests through its durable outbox, separately from task reports and alerts. Only first-class `approvalId` and matching `taskId` fields identify an approval delivery; its content is read through `ledger.getApproval`, never from notification payloads. Mandatory runtime controls remain visible when a task is dismissed. With callbacks enabled, opaque stored tokens bind the operator policy, allowed chat, exact sent provider message, request revision and immutable complete call identity. Buttons expire no later than the request and cannot be used twice or redirected to another call. Lost provider responses remain uncertain across restart; no request is automatically resent.

`/diagnostic <seconds>` queues one harmless connectivity reply to the same chat after an integer delay of 1–3600 seconds. It requires a configured operator but works without task integration or an ordinary chat consumer. The reply is durable and keyed by the incoming message identity, so duplicate input cannot schedule another copy. It sends on an online host tick at or after its due time and survives a restart before sending. No diagnostic is scheduled on startup. This checks message delivery only, without running a workload or granting permission.

## Persistence and failure semantics

- SQLite WAL with `synchronous=FULL` commits the incoming record **and mandatory acceptance receipt** before the provider handler returns. No model or task execution runs in that handler
- Message IDs deduplicate messages; provider event IDs deduplicate callbacks. Reusing an identity with different content fails. Callback action tokens also deduplicate different events for the same button
- Receipt/control messages are mandatory and remain enabled when `narrativeEnabled: false`. They state acceptance/handling/cancellation accurately and do not claim task completion
- Queued work survives restart. Work interrupted during a consumer/action or a provider send becomes `uncertain` and is not automatically replayed
- Outgoing calls use a deterministic 32-character provider UUID derived from the delivery ID. This is a duplicate-reduction mechanism, **not an exactly-once guarantee**
- A returned provider rejection is a known failure. An explicit provider rate-limit rejection can retry within `maxSendAttempts`. Timeout, lost response, missing provider message ID and generic transport errors become `uncertain`
- There is no automatic retry or fallback after unknown effects. `inspect()` exposes durable states. The trusted host/operator `reconcileDelivery(id, { outcome: 'sent' | 'not-sent', reason, messageId? })` resolves uncertain channel deliveries using actual evidence. Confirmed sends require a message ID. A not-sent reconciliation does not resend; a new explicitly authorized request needs a new delivery ID. Task notifications use the core's operator-only `ledger.reconcileDelivery(commandId, { deliveryId, status: 'sent' | 'failed', reason, receipt? })`. Neither reconciliation API is exposed as an untrusted chat command
- Store bounds apply to inbox, outbox, actions and per-record payload size. Terminal receipts and expired actions are pruned; unresolved entries are retained. Full storage rejects acceptance so the provider can retry instead of receiving a false success
- Event age rejection and retention are coordinated: retention must exceed the accepted event-age window plus five minutes of clock skew, so pruning cannot turn an old duplicate into new work
- Host unload stops the owned timer/socket, aborts consumer/send waits, settles uncertainty and closes only this plugin's database. It does not stop the DSH host or unrelated agents

Defaults: 10,000 inbox records; 30,000 channel deliveries; 60,000 action bindings; 64 KiB per record; one-day incoming event age; seven-day completed-entry retention; 10-second send/connection deadline; 120-second consumer deadline; five known-failure send attempts. The package performs no raw credential/event/request logging. `inspect()` includes private chat content and is a trusted in-process diagnostic API, not a public endpoint.

## Supported scope and verification

Implemented input is authenticated text and optional card actions. Implemented output is text and v2 task/report, alert and runtime-approval cards. Incoming media, uploads, Feishu attachment delivery, streaming, reaction handling, Bitable and report-file sharing are not implemented. Runtime permission controls cover only the exact live once/deny flow described above; host-only actions still require the host approval UI. Stored artifact IDs on report cards explicitly say they have not been uploaded. Enable or implement additional behavior through an audited host consumer/provider rather than assuming old monitor features exist here.

The native-chat tests additionally use the actual pinned DSH Loader, AgentLoop, tools and JSONL persistence, with only the model and Feishu transport stubbed. They cover distinct requests, history across restart, interrupted-request holds, operator reconciliation, sender/thread isolation, malicious non-operator task calls, causal task operation IDs, native timeout, foreign input and owned-only disposal. No live model, credential or Feishu message is used.

Run `npm run build -w @dsh-task/feishu-channel` and `npm run test -w @dsh-task/feishu-channel` from the project root. Tests load the real Cordis service and real task-system through the DSH loader, exercise the official SDK dispatcher and REST method shapes with mocked transport, and cover persisted receipts, duplicate IDs, restart/uncertainty, access checks, continuation/cancellation, stale callbacks, outbox mapping and disposal. They do not authenticate to Feishu or send live messages. Production app permissions, network/proxy reachability, callback provisioning and recipient visibility remain operator acceptance checks.

Source references: [official SDK](https://github.com/larksuite/node-sdk), [channel reference](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md). The installed pinned SDK implementation was also inspected to verify dispatcher ACK and WebSocket startup behavior.

Native API reference inspected at DSH commit [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core): agent registry factory/setup/owned handles, inbox claim and turn events, session flush, scoped tool restrictions/guards and system-prompt sections. Runtime acceptance uses the installed `0.2.1-rc.2` packages.
