# Task System

A durable task management plugin mounted inside DeepSeek Harness. One task survives session changes and contains multiple runs, reports, corrections and artifacts. Configurable task templates and schedules share the same state machine. The default plugin registers tools, keeps the DSH host alive and stores its ledger locally; it does not install a separate OS service.

Target: Node 24+, DSH 0.2.0-rc.2. Build this monorepo with `npm ci --ignore-scripts && npm run build`. Pack this directory with `npm pack`. Install the tarball with `dsh plugin --profile task-host add /absolute/path/to/tarball`. The CLI creates a base-backed profile, not the one-shot headless runner. Start `dsh --profile task-host`. Changes to installed bundle membership need a host restart.

Set `DSH_TASK_DATABASE` to the intended database path and use that **same path** for WebUI `--ledger`. The project's private demonstration uses `.runtime/tasks.sqlite`; it is ignored by Git. Each task has one authority; a remote executor must connect to that authority rather than independently accepting conflicting task state.

## Configuration and roles

`databasePath`, `nodeId`, `role` (`planner`, `executor`, `both`), lifecycle timing and tool limits are explicit native Config fields. `autoExecute` is off by default. Enable it only with registered model/node/workspace capabilities and a bounded execution tool allowlist. `maxConcurrent` limits local execution. Scheduler admission uses an explicitly configured route or leaves a run queued for later routing. The plugin owns its timers, native handles, observer and cleanup; an external supervisor may keep the DSH host alive.

Planner-only cannot execute local workloads. Executor-only cannot create or route task intent. Every remote operation also checks its authenticated node, operation and workspace scope; model-facing checks are not the only authorization boundary. Native `task_settle` derives identity from the exact owned agent. Text or idle alone never means success. Final commitment waits for the agent to drain and the session to flush.

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
