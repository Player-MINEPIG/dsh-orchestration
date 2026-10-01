# Explicit legacy source readers

These MIT-licensed modules are independently written implementations of source formats observed in the reference collectors. They are a configurable example task pack, not additional fixed daily/game plugins. They perform no network calls, process execution, home-directory discovery, environment-file reads, authentication, or automation reruns.

The fixture directory contains invented data only. The distributed tests generate their own temporary SQLite databases and logs. No real user sessions, production logs, credentials, or original executable source are included.

## Run the synthetic export

Requires Node 24 with `node:sqlite` (the repository's normal runtime).

```sh
node examples/legacy-task-pack/readers/run.mjs \
  --root examples/legacy-task-pack/readers/fixtures \
  --config manifest.json
node --test tests/legacy/readers.test.mjs
```

The runner writes JSON to stdout. The manifest enables any combination of Codex, Hermes and game readers. All paths, including its own config file, must resolve below the explicitly supplied export root. Relative paths are resolved against that root. Each invocation should use a new scope; its byte/file budgets are cumulative.

```js
import { createSourceScope, readCodexDaily, readHermesDaily, readGameDaily,
  hsrRules } from './index.mjs';

const scope = await createSourceScope('/absolute/operator-export', {
  maxBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFiles: 128,
  maxRows: 20_000,
  maxLineBytes: 1024 * 1024,
  maxMessageChars: 6000, maxDirectories: 256,
});
const window = {
  date: '2026-09-15', timezone: 'UTC',
  start: '2026-09-15T00:00:00Z', end: '2026-09-16T00:00:00Z',
};
const codex = await readCodexDaily({ scope, window, database: 'state.sqlite',
  rolloutPaths: { 'exported-session-id': 'rollouts/session.jsonl' } });
const hermes = await readHermesDaily({ scope, window, database: 'hermes.sqlite',
  workerDatabase: 'worker-bindings.sqlite', ackDatabase: 'ack-bindings.sqlite' });
```

## Supported inputs and outcomes

### Codex

Supply either `threadsFile` or `database`. A JSON file contains `{ "threads": [...] }`; SQLite contains `threads(id,title,created_at,updated_at,source,rollout_path,tokens_used,archived)`. IDs and names are operator data, not configuration constants. `rolloutPaths` can remap exported thread IDs to scoped JSONL files instead of following historical absolute paths.

Rollout JSONL supports `response_item` message payloads containing user/assistant text blocks, explicit `internal_chat_message_metadata_passthrough.turn_id` (or `turn_id`), `phase: final_answer|commentary`, and offset timestamps. `event_msg/token_count` supports `info.last_token_usage` and `rate_limits` account snapshots. Token counters are summed from observed per-event usage; they are not account billing measurements. Legacy token fields and account reset timestamps are retained.

Output is `codex_daily_activity.v1`. Continued sessions are selected by message activity, not creation date. A pre-window request is retained as context when its turn continues in the report window. Messages at the inclusive start count; messages at or after the exclusive end never establish completion. Injected-only turns, configured collector sessions, explicitly excluded sessions, and subagents are excluded from human-work counts. Subagents can be returned separately using `includeSubagents: true`. All-session usage still includes active collector/subagent sessions as in the source contract. Missing turn IDs receive deterministic per-user-turn fallback IDs rather than merging every unidentified message into one turn.

### Hermes

Supply either `exportFile` or `database`. JSON has `sessions`, `messages`, optional `worker_bindings` keyed by session ID, and optional `ack_bindings` rows. Session rows contain `id,source,title,origin_json,started_at,ended_at,end_reason,message_count,tool_call_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens`. Messages contain `id,session_id,role,content,timestamp,finish_reason,tool_name`. SQLite uses those columns in `sessions` and `messages`.

Optional worker SQLite uses `state_meta(key,value)` with `worker_session_task:` keys. Optional ACK SQLite uses `candidate_bindings(session_id,task_id,run_id,candidate_id,updated_at)` left-joined to `outbox(candidate_id,payload_json)`; `payload_json.origin.turn_id` determines exactly which turns are registered. Export ACK rows can supply `turn_id` directly. An ACK for one turn does not erase the session's unacknowledged remainder. Unknown ACK IDs erase nothing. Each remaining turn keeps its stable `session:m<message-id>` source reference.

Output is `hermes_daily_activity.v1`. Worker bindings, service sources, worker origins/titles, collector sessions, and injected-only turns are excluded. The default profile is used unless `includeNonDefaultProfile` is explicitly enabled. Whole-session token counters are marked partial for cross-window sessions, incomplete counters, or ACK remainder; they must not be interpreted as precise per-turn daily spend. Empty successfully read exports retain observed zeroes. Missing configured binding files make data quality partial.

### Game and scheduler logs

`readGameDaily` takes `{scope,window,reportMeta,scheduler,automations}` and emits `game_daily_report.v1`. `reportMeta` supplies device ID, business date (plain date or offset instant), report timezone, source IANA timezone, and collection time. An omitted window is constructed from that calendar day, including 23/25-hour DST days. The report source offset is derived at the start of the window. Every automation supplies an ID, task rules, and explicit `runs`; a run supplies `logFile`, optional `resultFile`, optional `engineLogFile`, and optional `startedAt/endedAt/fallbackDate/sourceUtcOffset/sourceTimezone/encoding`. An explicit run offset overrides zone conversion. `general_result`, `maa_result`, or `status` is retained as the top-level reported status without overriding task evidence.

Task rules contain `taskId`, optional `label/category/enabled/required/manual`, and literal `successMarkers`, `successAllMarkers`, `failureMarkers`, `startMarkers`, `retryMarkers`, `skipWhenAllMarkers`, or `disabledMarkers`. A marker is either a string or `{all:[...],compact:true}`; compact matching ignores whitespace. No caller-provided regex, code, SQL or commands are executed. Generic success/failure recovery uses the latest timestamped terminal signal; `terminalPolicy: 'failure_precedence'` retains the original OneDragon policy and is enabled in that preset. Missing terminal evidence defaults to `uncertain`; `missingOutcome` can configure `failed`, `not_observed`, or `skipped_nonblocking` (the HSR preset uses the source contract's required-marker failure policy). Rules can make cleanup nonblocking only after a specified completed task, make optional substeps follow their completed parent, or skip optional tasks after a goal is met. Policy references must form an acyclic graph inside the same automation and are applied in dependency order. `cascadeFromTaskId` labels only later failures as suspected, never confirmed causes.

Metric rules support literal markers, an optional `afterMarker`, `last`, `count`, `maximum`, `maximum_range` or `difference` numeric aggregation, `grouped_count`, `task_count`, explicit constants, and `result` JSON field paths. `estimatedAtPath` converts a result's full-at estimate using the configured source zone. Task/metric `runKinds` and metric `runKind` isolate routine and annihilation evidence when `mergeRunKinds` combines them. No-run states have the explicit `not_observed` top-level sentinel and `not_run` hint; missing configured source files are separately recorded in `evidence.missing_sources` and warnings. A supplied empty run inventory is distinguishable from unreadable files.

Scheduler logs support timestamped AUTO-MAS start, item-count, retry and run-ID end markers. Start/end literals and expected item count are configurable. A new start cannot close an earlier incomplete run; frontend completion fallback normally requires the matching run ID. `allowUnscopedFrontendEnd: true` reads the original unscoped Accomplish marker and preserves its timestamp/source warning, but leaves authoritative end time unknown and status `verify`: an uncorrelated signal cannot prove this run completed. Start without end is `verify` with a warning. Runs overlapping the report window are eligible; a run within the observed scheduler interval is preferred separately for each merged run kind. The default chooses the earliest eligible run, while `runSelection: 'latest'` is available. Selection and source IDs remain inspectable in evidence.

`hsrRules`, `oneDragonRules` and `maaRules` return editable rule data, not separate plugins. They cover required HSR daily work versus optional training/late screenshot cleanup, OneDragon child failures/disabled apps/possible cascades, and MAA main tasks versus clue/Mall noise and configured manual reminders. Manual annihilation due dates are operator decisions; no historical one-day reminder is embedded in code.

### Explicit AUTO-MAS filesystem composition

`readAutoMasDaily` composes the raw reader with the original history/configuration shapes. Supply exactly one `historyRoot` or `historyFiles` inventory. A history root is an explicit exported directory containing `YYYY-MM-DD` subdirectories; only source dates overlapping the report window are traversed, recursively and within directory/file bounds. History JSON files pair with same-stem `.log` files unless overridden. Built-in classifiers recognize MAA result keys and application log markers; `classifiers` or an inventory entry's `kind` supports other automation types. Explicit result/log paths and optional file-mtime fallback replace original installed-app defaults.

`scriptConfigFile` supports the original `instances`/UID entries, `Info.Name/Path/RootPath`, and `SubConfigsInfo.UserData` account entries, choosing the first enabled account. `queueConfigFile` supplies the first queue's `Info.Name/TimeEnabled`. Matching rules, automation identities, accounts and queue settings remain configurable. Config contents are not reproduced in the report; only selected names and source metadata are retained.

`engineLogFiles` maps history kinds to explicit engine logs. MAA definitions merge separately selected `maa_annihilation` and `maa_routine` runs while isolating routine outcomes and metrics; the original six MAA metric fields are emitted, including drops, ranged action counts, sanity before/after/full-at time, grouped error counts, and zero automatic annihilation retries under manual policy. HSR/OneDragon metric IDs are retained. `screenshots` registers explicit scoped image files; `screenshotDirectories` can discover supported image extensions in explicitly configured export directories, using file modification times to filter to the report window unless overridden.

```js
import { readAutoMasDaily, autoMasDefinitions } from './index.mjs';
const game = await readAutoMasDaily({
  scope, window,
  reportMeta: {
    device_id: 'operator-node', business_date: window.date,
    report_timezone: 'UTC', source_timezone: 'Australia/Melbourne',
    collected_at: '2026-09-16T01:00:00Z',
  },
  historyRoot: 'exported-automas/history',
  appLog: 'exported-automas/debug/app.log',
  frontendLog: 'exported-automas/debug/frontend.log',
  scriptConfigFile: 'exported-automas/config/ScriptConfig.json',
  queueConfigFile: 'exported-automas/config/QueueConfig.json',
  engineLogFiles: { maa_routine: 'exported-maa/debug/asst.log', maa_annihilation: 'exported-maa/debug/asst.log' },
  automations: autoMasDefinitions({ manualAnnihilationDue: false }),
  screenshotDirectories: [{ path: 'exported-hsr/screenshots', automation_id: 'hsr_march7thassistant' }],
});
```

## Read boundaries and source status

- Export root confinement is checked before reads and after symlink resolution; files must be regular files. Recursive discovery never follows symlinks and is limited to explicitly configured directories. No home or installed-app path is inferred.
- Files, directories, aggregate bytes, rows, lines and copied message text have finite configured limits. Exceeding input bounds is normally an explicit source error. A run or scheduler can request `readMode: 'tail'` with `maxBytes`; only complete retained lines are decoded, the source becomes `partial`, and warnings record potentially missing earlier events. `readAutoMasDaily` also supports `historyReadMode/historyLogMaxBytes`. Clipped message text is labelled.
- SQLite input and optional WAL are copied as bounded bytes to a private temporary directory, queried there, then deleted. Source database, WAL and shared-memory files are never opened by SQLite. No custom SQLite functions or extensions are loaded. The source export must be stable while copied; concurrent mutation is not a supported snapshot guarantee.
- An unavailable primary source returns `counts: null`, unavailable token observability, and an error. A successfully read empty export returns zero counts and explicit zero usage. Incomplete secondary files or malformed JSONL yield partial data quality and measured lower-bound counts. Consumers must preserve this distinction.
- Codex/Hermes JSON and JSONL exports are strict UTF-8, as in their source collectors. Game logs/config/history JSON support UTF-8/BOM, GB18030, GBK/CP936 fallback plus explicit UTF-16LE/BE and BOM detection. Failed decodes are explicit, never silent replacement text. Naive timestamps use an explicit IANA zone or offset; short `[HH:MM:SS]` timestamps use a supplied date and roll forward across midnight. DST ambiguity defaults to `compatible` (earlier repeated time; forward across a gap), with `earlier/later/reject` policies available. No host-local timezone is inferred.
- Untimestamped marker compatibility can be enabled with `includeUntimedMarkers`, and is enabled for HSR/OneDragon presets. It applies only when the entire identified run is inside the report window; exact event timestamps stay null. A task's `timestampRequired` still demands a timestamped marker. MAA engine events are always restricted to their run's timestamp bounds.

## Format support and acceptance matrix

| Original input/outcome | Implemented explicit-source equivalent | Synthetic evidence |
|---|---|---|
| Codex `threads` SQLite + rollout JSONL | Exact reviewed columns; exported JSON equivalent; scoped rollout remapping | Continued sessions, exact half-open boundaries, injected/collector/subagent exclusion, token/reset snapshots |
| Codex stopped WAL/private-copy fallback | Bounded DB+WAL private snapshot for every SQLite read | Real uncheckpointed WAL fixture; source DB/WAL hashes and directory unchanged |
| Hermes sessions/messages + worker state | Exact reviewed columns and binding key format; exported JSON equivalent | Local/service/collector/injected partition and unavailable versus zero |
| Hermes Registry ACK join | Candidate binding/outbox join or exported rows | One-turn ACK remainder, all-turn ACK, unknown turn ACK, separate SQLite tables |
| Collector usage/context boundaries | Continued turn request retained; no future final; session usage explicitly partial where inexact | Cross-window and ACK-remainder fixtures, bounded text |
| Raw source decoding | UTF-8/BOM, GB18030, CP936/GBK; additional explicit UTF-16 support | Non-ASCII legacy bytes, BOMs, failed strict decode |
| Source/report timezone conversion | IANA conversion, half-open local-day windows, short dates/midnight rollover, explicit DST policy | Melbourne 23/25-hour days, repeated/missing local times, report-date instant conversion |
| AUTO-MAS history and original configs | Explicit dated history root/inventory, recursive bounded discovery, optional mtime fallback, ScriptConfig/QueueConfig parsing | Nested history, enabled account selection, queue name/enablement, mtime-only run |
| Game screenshot evidence | Explicit files or scoped image-directory inventory | Existing PNG evidence and missing screenshot sentinel |
| HSR required/optional/cleanup | Configurable original markers and failure/skip policy | Main success, 500-point optional skips, post-shutdown screenshot noise, preserved scalar metric IDs |
| OneDragon outcomes/cascades | All configured task labels, disabled apps, legacy failure precedence, suspected temporal cascade | Top-level Success with failed child, disabled app, failure then success, causal ownership |
| MAA main/substep/manual outcomes | Routine/annihilation run-kind merging, GUI/engine windows, parent completion and Mall completion rules | Main success despite clue/Mall noise, isolated run evidence, manual reminders |
| MAA historical measurements | Six original metric fields including ranged actions, drop objects, sanity estimate, grouped errors | Before/after sanity, parsed full-at, `1~6` action count, drop map, isolated error counts |
| Scheduler lifecycle and evidence quality | Start/count/retries/end; incomplete-run verify; identity-safe and explicit legacy frontend fallback; bounded tails | Missing end, unrelated later signal, opt-in unscoped completion, partial tail |

The reviewed collectors contain no alternate SQLite schema-fallback implementations beyond the private DB+WAL copy. Unknown schemas, encrypted databases, compressed/binary logs and arbitrary future application formats are outside the observed source contracts, not deferred compatibility work. Caller-defined rule data and explicit export conversion can extend them without new plugins.

There are no remaining known unimplemented credential-free format families from the three reviewed source readers. This is synthetic contract/behavior acceptance, not proof against undisclosed historical files. Access-dependent gates remain: stable exports from real Windows/Codex/Hermes installations, live provider/account coverage and complete multi-node collection, report artifact closure, and real delivery receipts. These readers do not create those captures, mutate their source applications, or establish the other components' end-to-end acceptance.

Two correctness fixes are deliberate: future-window messages cannot retroactively complete an earlier report, and authoritative scheduler completion requires matching run identity. The original unscoped marker can still be read by explicit configuration, but its attribution remains unconfirmed/verify. Preserving raw format support does not preserve the earlier false-attribution behavior. Exact source timestamps remain unknown when only untimed compatibility markers exist. No claim of byte-for-byte equivalence or live execution is made.

## Format provenance

Read-only reference review: Shared Assets commit `774e49583eca39ba8979d4a252913bef45a22bc8`, `codex-daily-work-summary/scripts/collect_codex_daily_activity.py`, `collect_hermes_daily_activity.py`, and their collector tests; Plugins commit `1dfacb5e5949d9f248b1feacbc36644fb351f19e`, `hermes_monitor/scripts/pc_au/auto_mas_daily_report_json.py`, producer tests and game report contract. These repositories had no license at the reviewed root, so none of their executable source is copied or imported. Format field names and factual application log markers are the compatibility interface. Every algorithm and fixture in this directory was written anew.
