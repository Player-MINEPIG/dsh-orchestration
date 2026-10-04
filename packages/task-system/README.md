# DSH Task and Remote Execution Suite

`@dsh-task/task-system` 0.2.0 is one installable package containing the durable
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

Target: Node 24+, DSH 0.2.0-rc.2. Build this monorepo with `npm ci --ignore-scripts && npm run build`. Pack this directory with `npm pack`. Install the tarball with `dsh plugin --profile task-host add /absolute/path/to/tarball`. The CLI creates a base-backed profile, not the one-shot headless runner. Start `dsh --profile task-host`. Changes to installed bundle membership need a host restart.

Set `DSH_TASK_DATABASE` to the intended database path and use that **same path** for WebUI `--ledger`. The project's private demonstration uses `.runtime/tasks.sqlite`; it is ignored by Git. Each task has one authority; a remote executor must connect to that authority rather than independently accepting conflicting task state.

## Configuration and roles

`databasePath`, `nodeId`, `role` (`planner`, `executor`, `both`), lifecycle timing and tool limits are explicit native Config fields. `autoExecute` is off by default. Enable it only with registered model/node/workspace capabilities and a bounded execution tool allowlist. `maxConcurrent` limits local execution. Scheduler admission uses an explicitly configured route or leaves a run queued for later routing. The plugin owns its timers, native handles, observer and cleanup; an external supervisor may keep the DSH host alive.

Planner-only cannot execute local workloads. Executor-only cannot create or route task intent. Every remote operation also checks its authenticated node, operation and workspace scope; model-facing checks are not the only authorization boundary. Native `task_settle` derives identity from the exact owned agent. Text or idle alone never means success. Final commitment waits for the agent to drain and the session to flush.

When an owned native session ends without `task_settle`, the outcome remains `unknown` / `not-submitted`. A terminal public DSH error contributes only its fixed safe code (for example `NO_ADAPTER` or `MISSING_CREDENTIAL`) to the returned summary; unknown codes become `RUNTIME_ERROR`. Raw messages, causes and credentials are never copied into that summary. This diagnostic does not manufacture a result report or prove that prior effects did not occur.

Default workload tools are empty. Known file tools require canonical authorized paths; cwd alone is not an OS sandbox. Shell/custom tools require an explicit broader trusted configuration. Workspace roots must be owned by the operator and protected from hostile local mutation; portable path checks do not defeat a separate process racing filesystem changes.

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

Install the independent typed-decisions bundle to enable `task_plan`. `@dsh-task/task-system/planning` exports `TaskPlanner` and `taskDecisionCatalog`. Requests cover persistence/attachment, executor, provider/model/effort, actual workspace and narrative reporting. Accepted decision receipts persist in the task ledger before effects. A stale catalog, invalid candidate or failed policy check prevents application. A proposed new workspace requires authorized physical provisioning and a fresh plan; the model does not grant directory access.

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
