# Session task monitor

Task agreement: add a session-scoped task monitor beside Conversation and Trajectory, using the task center's categories. Develop on a new branch from the published 0.2.6 source (`ed0e8fb`), commit and push without merging; update only the local default environment. Workflow: project-collaboration and code-review-and-quality.

## Behavior

The **任务** conversation tab shows confirmed task-system dispatches originating in the selected session, their descendants, status counts, search, execution node/model, latest report and the five latest executions. Counts describe Tasks, so retries do not inflate them. Status categories come directly from the task center's public snapshot, including pending review versus accepted completion.

The read-only `taskPluginSettings/sessionTasks` endpoint derives origin IDs from successful `project_dispatch`, applied `task_plan`, `task_run` and `task_delegate` receipts in the persisted session. Durable project dispatch operations also cover acknowledged results before the conversation log is flushed. Fork-inherited events and unrelated same-project sessions are excluded. Pending dispatch ACKs and task IDs missing from the current authorized central view are reported separately.

The browser receives only filtered public task/run fields. The original node-scoped central snapshot remains the authorization boundary. No new central protocol, task mutations or background agent execution is introduced. A bounded revision cache stores dispatch metadata, not raw commands or conversation text. Polling runs every five seconds while mounted and the document is visible; overlapping requests and late responses after unmount are ignored. Existing task-center classifications and business state transitions are unchanged.

### Legacy Codex CLI calls

Version `0.2.7-session-monitor.1` also recognizes persisted `pwsh`/`bash` calls that directly invoke `codex exec` (including resume and literal PowerShell executable variables) and receive a DSH background-job receipt. Help, log inspection and foreground commands without a background receipt are excluded. This is a bounded compatibility reader, not a general shell interpreter: wrapper scripts, arbitrary variable expansion and OS jobs without DSH receipts are not reconstructed.

These entries are explicitly labeled Codex CLI and counted per invocation, including retries/resumes, separately from ledger task identity. The UI links them conceptually to their original trajectory sequence. Paired `job_output` results and host `tool-jobs` completion notices recover terminal process state. Shell completion is **handled / process ended, not accepted**, because a successful shell exit does not prove Codex success or task acceptance. Missing terminal evidence becomes **unknown** after the live registry loses the job; cancellation requests alone do not prove cancellation.

An optional, non-consuming `ctx.jobs.list(sessionId)` read refreshes live status. Matching requires session ownership, job ID, command hash and the original call/receipt time window, since IDs can be reused after a host restart. Raw command text and output files are neither cached nor sent to the panel. Historical records are read immediately when opening the panel; the next conversation revision refreshes the index. No ledger rows are synthesized or modified.

Compatibility validation: 54 focused tests pass, including legacy receipts, next-turn cache invalidation/reopening, host notices, live status changes, restarted-ID/owner isolation, and all previous session panel tests. A local historical conversation replay yields nine confirmed CLI invocations: eight shell completions and one record with a cancellation request but no terminal receipt. These are displayed as eight handled and one unknown, never as nine accepted tasks. Full private conversation evidence remains outside Git.

Installed `.1` in the local default Web profile and verified the authenticated endpoint and rendered conversation tab both show 9 total / 8 handled / 1 unknown. Status filtering and trajectory-reference details work. All six plugins remain active, the executor heartbeat is acknowledged, and queue/restart blockers are zero. Configuration files were byte-preserved; the backup is in `codex/session-codex-history-20261015` outside Git.

The same investigation found that CLI installation is not the current managed-execution blocker: the host's Desktop-bundled executable reports `codex-cli 0.162.0-alpha.17.2` and supports `exec`, `resume` and `app-server --stdio`. The local task-system deployment has no configured `officialBackends` and cannot resolve the optional `dsh-subagent-codex` provider. A regular unbound user chat also cannot use owned-only `task_delegate`; project dispatch requires `/project` activation. A subscription model provider named `codex` does not by itself launch a CLI. The existing managed backend's explicit read-only profile/transport guard is a further, separate limitation for coding work. This monitor update does not silently broaden that execution contract.

## Validation — 2026-10-15

- TypeScript and package build passed.
- 49 focused tests passed across session origin extraction/cache, durable operations, scope/descendant filtering, conversation-tab registration, refresh failure/race behavior, and existing settings and collaboration UI tests.
- Three pre-existing `project-executor-view` native Loader tests could not initialize task service on Windows. The unchanged result-journal constructor reproduces `EPERM: operation not permitted, fsync` during first-time journal creation. No unrelated journal change was made.
- Installed `0.2.7-session-monitor.0` only in PC_AU's default Web profile. Actual authenticated RPC returned the current session's empty count, the new tab rendered beside Conversation/Trajectory, all six existing plugins stayed active, and the remote heartbeat was acknowledged.
- Synthetic browser fixture verified six tasks across five statuses, search/status filtering, details retained across refresh, escaped report text, offline notice with retained data, session switching and a 390px layout without horizontal overflow. These fixtures did not create production tasks or invoke a model.
- Production configuration was backed up before install and byte-compared afterwards. VPS and MBP were not updated. The local Web process was restarted after confirming no running sessions, queued tasks or restart blockers.

Local deployment backups and screenshots are kept outside the repository in `codex/session-task-monitor-20261015`. The source remains on the feature branch; no merge or remote deployment is part of this change.

## Local Codex backend and parent acceptance — 2026-10-15

Extended agreement: reuse the Desktop-bundled executable, enable automatic review for writable parent sessions (including workspace-write), test dispatch/file changes/result collection in the existing local `test` workspace, and keep all test tasks off the scheduler. The user subsequently requested one `task_delegate` entry point, parent acceptance, and a status-colored bar on the left of each task card.

The optional local adapter is documented in [local-codex.md](../../packages/task-system/docs/local-codex.md). It is disabled in the published bundle and enabled only in this host's profile. Ordinary sessions use `task_delegate`; owned executions retain their existing authoritative ledger path. `codex_status` exposes persistent same-session results and `task_accept` records independent parent verification before moving review to done. Acceptance is owner-fenced and cannot complete a running or failed task. The panel preserves legacy shell history and adds matching status bars without relying on color alone.

Live verification used Desktop Codex `0.162.0-alpha.17.2`. The first local job created and read back a marker file. After a plugin restart, the original record remained available; in the next parent turn, the parent independently checked the exact file content and accepted it. A second job dispatched through `task_delegate`, changed the marker file, returned its result through `job_output`, and was independently checked and accepted by the parent. Both records are now done with timestamped acceptance evidence; no central dispatch or ledger task was created. An observed Codex rollout confirms `approval_policy: on-request`, `approvals_reviewer: auto_review`, `sandbox_policy.type: workspace-write` and `network_access: false` for the workspace-write parent.

The parent test encountered a pre-existing DSH Windows workspace grant error while reading through `pwsh`. Its standard sandbox diagnostic repaired the test directory's permissions, with recovery files kept beside that workspace. The Codex adapter itself had already written the test file successfully. The deployment also exposed DSH's whole-config override behavior: enabling this plugin must include its required database path. That requirement is included in the portable setup instructions.

Validation: both package builds pass; all 59 focused tests pass. A broader 88-test run passes 85 and encounters three unchanged Windows fixture limitations: a POSIX executable stub, a symlink requiring unavailable privileges, and a POSIX absolute-path assertion. These failures are in the existing official-backend/recursive fixtures, not the local adapter. The workspace's internal Feishu peer range now accepts the 0.2.7 prerelease series so npm can generate the lockfile normally; no Feishu runtime behavior changed.

Local-only release series: `.2` established the backend, `.3` unified dispatch and acceptance, and `.4` adds the requested status bars. Backups, private test-session evidence and actual permission evidence are outside Git under `codex/local-codex-backend-20261015`. No credentials, private session transcripts or machine-specific configuration are included in the source changes.

Final `.4` deployment verification: all seven relevant plugins are active, local queue is empty, and both accepted tasks remain done after another service restart. Temporary Codex profiles are removed. The rendered panel shows 2 total / 2 completed with 4px green left borders; the browser's computed border color matches the completed-state color. The final screenshot is `codex/local-codex-backend-20261015/final-task-panel.jpg` outside Git.

### Follow-up: reasoning effort and permission wording

The user reported that a real parent session could not select reasoning effort and interpreted workspace-write as lacking automatic approval. Read-only inspection of the running local task confirmed its parent mode was `danger-full-access`, model was `gpt-6.1-sol`, and effort was `high`; its actual Codex turn context showed `on-request` / `auto_review` / `workspace-write`. An auto-review model turn was also present. Automatic approval was working; the tool schema lacked the effort override and its description did not explain the separate permission dimensions.

The source fix adds an optional local `reasoningEffort` parameter, returns the selected effort and parent mode in receipts/status, and describes automatic approval separately from initial sandbox scope. Idempotent retries preserve the original effort and reject conflicting explicit values. Owned ledger delegation still uses `route.reasoningEffort`. The user explicitly prohibited restarting DSH while real work is running: this follow-up is source-only, with no installation, plugin reload, service restart or live task mutation.
