# DSH Task and Remote Execution Suite

`@dsh-task/task-system` 0.2.12 is one installable package containing the durable
task ledger, native execution and authenticated multi-device coordination.
The core works without decision or channel plugins. Remote coordination is
mounted only when explicitly configured through `@dsh-task/task-system/remote`;
its wire protocol and lifecycle behavior are unchanged.

```sh
dsh plugin --profile <profile> add <task-system-tarball>
# Apply packages/task-system/remote.patch.yml to enable the remote service,
# then supply the existing node/workspace grants and authentication settings.
```

Public entrypoints: `/plugin` (task host), `/remote` (remote host), `/remote/api`
(protocol/worker API), `/contracts`, `/planning` and `/task-policy`. Task-specific
finite proposals live here and consume the independent typed-decision contract.
See [remote configuration](docs/remote-execution.md) and the
[package migration](../../docs/PACKAGE-MIGRATION.md).

The optional Feishu adapter is a separate package. No channel SDK is required
by this suite, and installing the suite never opens a Feishu connection.


A durable task management plugin mounted inside DeepSeek Harness. One task survives session changes and contains multiple runs, reports, corrections and artifacts. Configurable task templates and schedules share the same state machine. The default plugin registers tools, keeps the DSH host alive and stores its ledger locally; it does not install a separate OS service.

Target: Node 24+, DSH 0.2.1-rc.2. Build this monorepo with `npm ci --ignore-scripts && npm run build`. Pack this directory with `npm pack`. Install the tarball with `dsh plugin --profile task-host add /absolute/path/to/tarball`. The CLI creates a base-backed profile, not the one-shot headless runner. Start `dsh --profile task-host`. Changes to installed bundle membership need a host restart.

Set `DSH_TASK_DATABASE` to the intended database path and use that **same path** for WebUI `--ledger`. The project's private demonstration uses `.runtime/tasks.sqlite`; it is ignored by Git. Each task has one authority; a remote executor must connect to that authority rather than independently accepting conflicting task state.

## Native DSH plugin settings GUI

Use the official Web profile (`dsh web`). In the same profile, open **Plugins → Installed → @dsh-task/task-system → task-system → Configure**. The package now includes an optional browser companion with six explicitly live settings plus read-only deployment and remote-polling details. The separate VPS task dashboard remains separate. New bundle installations explicitly start with schedule admission and local auto-execution disabled. See [settings scope, profile overrides and verification limits](docs/settings-ui.zh-CN.md).

## Device workflows

The Workflow panel shows device connections and the program/Agent steps inside each device. Definitions are versioned, runs retain their inputs and outputs, and offline routes wait for recovery. Programs use the existing execution protocol without creating an Agent session. See the [workflow guide](docs/workflows.zh-CN.md).

## Configuration and roles

For local Desktop Codex delegation through `codex_delegate`, session monitoring and parent acceptance, see [Local Codex delegation](docs/local-codex.md).

`databasePath`, `nodeId`, `role` (`planner`, `executor`, `both`), lifecycle timing and tool limits are explicit native Config fields. `autoExecute` is off by default. Enable it only with registered model/node/workspace capabilities and the intended DSH Agent preset permissions. `maxConcurrent` limits local execution. Scheduler admission uses an explicitly configured route or leaves a run queued for later routing. The plugin owns its timers, native handles, observer and cleanup; an external supervisor may keep the DSH host alive.

Planner-only cannot execute local workloads. Executor-only cannot create or route task intent. Every remote operation also checks its authenticated node, operation and workspace scope; model-facing checks are not the only authorization boundary. Native `task_settle` derives identity from the exact owned agent. Text or idle alone never means success. Final commitment waits for the agent to drain and the session to flush.

When an owned native session ends without `task_settle`, the outcome remains `unknown` / `not-submitted`. A terminal public DSH error contributes only its fixed safe code (for example `NO_ADAPTER` or `MISSING_CREDENTIAL`) to the returned summary; unknown codes become `RUNTIME_ERROR`. Raw messages, causes and credentials are never copied into that summary. This diagnostic does not manufacture a result report or prove that prior effects did not occur.

By default (`executionTools` absent or null), native execution mounts the DSH default Agent preset (normally `standard`) and follows its tools, sandbox and approval rules. A resumed session retains its recorded preset. An explicit `executionTools` array selects the legacy restricted mode: known file tools require canonical authorized paths and shell/custom tools require an explicit broader trusted configuration. Task `allowedTools` still narrows the preset, and task settlement remains bound to the owning agent and lease. Cwd alone is not an OS sandbox. Workspace roots must be owned by the operator and protected from hostile local mutation; portable path checks do not defeat a separate process racing filesystem changes.

## Durable APIs

Import `TaskLedger` from `@dsh-task/task-system`. `TaskLedger.open(path, options)` exposes stable command IDs and transactional receipts. Repeating the same command returns its receipt; reusing its ID with another payload is a conflict. Use `close()` when its owner unloads. `readOnly:true` is appropriate for a separate trusted query consumer.

- `createTask`, `updateTask`, `createRun`, `claim`, `markRunning`, `bindSession`, `renew`, `submit`
- `cancel` requests cancellation; `acknowledgeCancellation` records actual quiescence. Resources remain held until then
- Expired attempts become uncertain and are never automatically replayed. `resolveUncertain` records an operator reconciliation before releasing held resources
- `appendReport` adds a new report or an explicit revision link. Similar text from another session is still another report
- `ArtifactStore` stores immutable bytes and verifies digest/length. Final result references are revalidated against those bytes
- `updateTemplate` creates immutable template versions; `createSchedule`, `setScheduleEnabled`, `fireSchedule` and `scheduleDue` manage recurrence. Both interval and cron/time-zone schedules are supported
- `WorkspaceManager` creates/reuses physical directories under configured roots; it does not grant new permissions or create remote GitHub repositories
- `history`, `allSettled`, `snapshot`, `pendingRuns` and `decisionCatalog` supply shared views

Partial semantic results are terminal runs with `reviewStatus: pending_user`. Review changes review metadata, not the original result. Delivery status is independent: a sent failure notification is still a failed task.

Before effects, `markRunning` requires an `executionId` and atomically binds that attempt to one execution instance. Every later lease write must carry the same identity. A remote recovery store retains its instance identity across restart; native invocations use fresh identities. A losing duplicate cannot start effects or overwrite the winning result.

Templates may pin `resultValidator` to an operator-registered synchronous semantic validator. Trusted host extensions call `ledger.registerResultValidator(id, callback)` and dispose the returned registration on unload. The callback receives cloned task/run/attempt/submission context and returns `{valid:true}` only after checking domain invariants. It must perform no I/O or effects. A missing, asynchronous or rejecting validator fails closed before report/result/outbox commit. Configuration can select an ID; a model cannot install validator code. This complements JSON Schema for cross-field counts, causal evidence and root-artifact requirements.

## Observation and task memory

Observation is opt-in and host-mounted. Only bounded visible assistant text after human input is collected; task-owned sessions, inherited subagent history, reasoning, system/developer content and raw tool streams are excluded. Redaction is a bounded safeguard, not a guarantee to recognize every secret. Review candidates before admission; `ignore`, `create` and `attach` never dispatch already-observed work. Bounded resume catch-up records omitted-entry gaps explicitly.

The append-only task/report history is the durable memory. Query/search/summary views are derived from it and must not replace source reports. No general persona or relationship-memory product is included.

## Optional typed decisions

`task_plan` remains available without the independent `dsh-jev-plugin` bundle. `planningDecisionEnabled` defaults to true for compatibility; when disabled or the service is absent, planning makes no model call, preserves an explicit complete route, or leaves the task pending routing. `@dsh-task/task-system/planning` exports `TaskPlanner` and `taskDecisionCatalog`.

Scheduler model requests retain task admission, executor, provider/model/effort and reporting choices, but never ask for a workspace or session. Those choices belong to the executor under its independent `sessionDecisionEnabled` setting. Explicit Task/Run/Schedule workspace constraints remain binding; derived defaults do not become user constraints. Old unapplied scheduler workspace recommendations require replanning instead of changing stored history. Receipts persist before effects, and current-catalog, capability and workspace checks remain mandatory.

For an ad hoc user message, no execution model or node is required in the input.
Planner/both conversations receive an orchestration prompt that prefers dispatch
to an eligible executor. `task_nodes` exposes each visible node's roles,
capabilities, supported provider/model/effort tuples and sampled runtime health.
Use `task_dispatch` with a stable `commandId`, `title`, and complete instructions
in `description`; omit `route` to let planning choose an eligible executor.
To review a plan first, call `task_plan` with a stable `requestId`, `title`, and
`description`. This tool only proposes. Dispatch that proposal with
`task_dispatch({commandId: requestId, requestId})`.
An existing draft uses `task_dispatch({commandId, taskId, nodeId})`.
`task_create` creates a draft without execution. `task_repair_dispatch` repairs
the same unclaimed Run using `runId` and `expectedActionVersion`.
`task_wait({taskId, timeoutMs: 0})` inspects current settlement without waiting.
Owned agents use the same `task_dispatch` tool to create and dispatch a child
through their authoritative fenced lease. Ordinary local Desktop Codex work uses
`codex_delegate`, which retains the parent workspace and permissions.
The old `task_run`, `task_delegate`, `task_children`, and `project_dispatch`
public tools are removed. Active `/project` sessions dispatch through
`task_dispatch` with their host-bound project identity.
The top-level `provider`, `model` and `reasoningEffort` parameters of `task_plan`
override the decision call, not the workload route. Normally leave them unset.
Without a usable decision service, routing stays pending. Brief conversation
can still be answered locally. Owned workload agents do not receive the
conversation's dispatch preference.

Channel tool restrictions still apply. Feishu planner operators must enable
task integration and include `task_nodes`, `task_dispatch`, optional `task_plan`, and the desired task
query tools in `plannerTools`; installing the task package does not grant
channel planning authority.

## Private WebUI and migration

The WebUI consumes `snapshot()` and has no second task database. Explicit imports retain their real observation time; static published exports identify their snapshot time and do not pretend to poll live agents. `readLegacyHermes` opens a selected legacy database read-only and produces a reviewable import snapshot. It preserves task/run/submission identities and unknown provenance; running legacy work is not resumed automatically. See the root migration guide.

No live Feishu/Jev/ordinary-model or cross-hardware acceptance is implied by local tests. See the exact validation records and remaining deployment checks.

## Task decision policy

`buildTaskDecisionRequest()` builds finite proposals for persistence, task
attachment, executor, the complete provider/model/effort tuple, actual workspace
reuse/create and optional narrative reporting. Its snapshot accepts only
caller-supplied eligible catalogs, explicit requested IDs, a state hash and an
expiry. Model/effort is selected as one tuple; the model cannot combine separately
valid but unsupported fields. Explicit unavailable candidates fail before
evaluation, rather than falling back.

`consumeTaskDecisionReceipt()` checks complete request identity, catalog contents,
question versions, expiry, current eligibility, cross-executor consistency and
explicit choices. A changed catalog is rejected even if someone accidentally
reuses its state hash. An ignored task cannot dispatch. It returns a pure
`TaskDecisionProposal` carrying `requiresAuthorizationCheck: true`, or abstains.

The caller must perform deterministic authorization, role, identity, capability,
budget and workspace checks both before constructing candidates and immediately
before committing any effect. These helpers do not write the ledger, grant
permissions, create directories or dispatch work. Workspace references are
opaque catalog IDs resolved by the real workspace manager. Every outcome keeps
`protocolReceiptRequired: true`; mandatory failure/approval/budget reporting
forces escalation even if the model chose no extra narrative.

Project and temporary conversations expose the host provider/model catalog and retain a per-conversation model selection across handoff and restart. Switching applies to the next message without changing the execution route or session. Uncertain executions remain reserved until an operator verifies that the executor has stopped; the conversation provides confirmation and retry controls. Confirmation finalizes the Run and Attempt together, and the executor reconciles its local recovery journal against that same authoritative execution identity without replaying work.

Operator retry reuses a still-valid prior executor/model route and the authority-owned Task session. Readiness, capacity, workspace grants and Task policy are rechecked without asking a model to select the same route/session again. An idle root Agent already opened in DSH WebUI may service the leased attempt through temporary scoped guards and model routing; the original Agent lifecycle is retained and its normal conversation settings return afterward. Running, queued-input or maintenance-owned sessions block before this attempt sends a prompt. Manual continuation uses persisted history and requests verification before repeating an external action; uncertain previous executions still require reconciliation.

Decision calls use `ctx.decisionModels.ask`. The task suite prepares context and questions, validates business answers and owns audit, fallback and execution. `decisionBindings` maps `task-planning` and `task-session` to optional JEV profile IDs; an empty value follows the model-service default. Provider and model configuration is edited in Plugins → Jev. See [migration](../../docs/JEV-MIGRATION.zh-CN.md).

### Executor project directories

In Task settings, choose **项目父目录 → 选择目录** on each executor. The picker uses the official DSH host directory service: an in-page browser for remote/headless hosts, or the host's native chooser when DSH provides it. Confirming a directory stages a draft; **保存设置** persists it without restarting execution. The scheduler uses the same picker for its planning parent.

Unconstrained new projects receive a directory below that executor's selected parent, grouped by scheduler and project identity, and are registered as DSH workspaces. Task sessions attach to that workspace. Independent tasks have separate directories; delegated tasks and Git worktrees retain their existing isolation. Existing projects and sessions retain durable directory bindings when the parent changes. Explicit workspace constraints continue to use their authorized route directory. If no parent has been selected, the existing authorized workspace remains the fallback. No directory contents are synchronized between devices.
