# DSH / Codex activity reports

Optional plugin: `@dsh-task/task-system/activity/plugin`.

This report uses DSH's `sessionPersistence` service (`list`, `open(id, 'read')`,
paged `read`, `close`) and the configured local Codex executable's stdio App
Server (`initialize`, `thread/list`, `thread/turns/list`). It never resumes a
Codex thread, starts a model turn, or reads SQLite directly. Hermes is not a
source. Task-injected DSH turns and child-agent sessions are excluded.

Configure `codexExecutable` as an absolute executable path on nodes that use
Codex. An empty path means that node has only a DSH source. Configure
`expectedNodeIds` on the authority. `maxSourceBytes` defaults to 2 MiB.

Tasks pin `windowStart`, `windowEnd`, and `timeZone`. A schedule can provide
`calendarWindow: { timeZone: 'Asia/Shanghai', dayOffset: -1 }` to resolve the
previous calendar day separately for every occurrence, including catch-up.
Use offset `0` for a current-day game report. Calendar boundaries respect DST.

An owned attempt calls `activity_sources_read`, summarizes each returned
`sourceRef` exactly once, and calls `activity_report_prepare`. Node tasks use
`kind: 'node'`; the authority uses `kind: 'daily'` after delegated node tasks
settle. Preparation returns the outcome and exact report for `task_settle`.
The validator checks the immutable window, node identity, attempt-bound
evidence receipt, derived report text, and accepted child results.

The Codex paginated history API currently requires its experimental API
capability. Compatibility is verified against the installed executable;
API errors become explicit source gaps. Historical per-day tokens/costs are
unavailable through this interface and are not reported as zero. Item summary
timestamps cannot establish within-turn daily activity, so later final answers
are not attributed to earlier days. Summaries use turn boundary evidence;
turn completion alone does not prove the user's business goal was achieved.

Source errors, missing nodes, and truncated evidence produce partial reports.
Conversation turns and managed task executions are separate counts. Reporting
tasks and their delegated collectors are excluded from business execution counts.

Game collectors can remain independently deployed scripts. An operator-owned
source manifest may contain `gameCollector` with absolute `executable`, `cwd`,
fixed `args`, and `timeoutMs`. Only `{date}`, `{timeZone}`, `{windowStart}`, and
`{windowEnd}` in argv are substituted. The process uses no shell; stdout must
be one bounded `game_daily_report.v1` JSON matching the assigned node and full
calendar day. Timeouts, cancellation, invalid JSON, and oversize output fail
collection instead of producing truncated success.
