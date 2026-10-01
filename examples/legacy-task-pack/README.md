# Configurable legacy task pack

This is executable migration support for the original daily/game outcomes, not a declaration that any summary-shaped JSON is equivalent. It ships as Task System subpaths `@dsh-task/task-system/task-pack` and `@dsh-task/task-system/task-pack/plugin`, without a fifth dependency-only plugin. The maintained source is this directory.

All executable algorithms and distributed fixtures are newly written. The unlicensed original repository is reference-only; no executable source, user sessions, private accounts, credentials or production paths are copied. Configured source IDs, physical roots, node identities/aliases, automations, dates, timezone and account-measurement scope are operator data.

## Implemented paths

- Explicit Codex/Hermes JSON/SQLite/JSONL readers, turn-level ACK remainder, continued sessions, human/service/collector/subagent filters, read-only private SQLite/WAL copies and exact/partial/unavailable accounting
- Explicit AUTO-MAS inventory/config/log/metric adapters and editable HSR/OneDragon/MAA rules; required/optional work, cleanup false positives, suspected cascades, no-run sentinels, scheduler start without end, declared encodings and IANA/DST behavior
- Deterministic node/root builders, candidate partition and duplicate checks, runtime-owned IDs/counts/shares and scoped account-reset deltas
- Agent/Game normalization and semantic validators; report-wide attention remains supported; configured intentionally skipped sources are distinguished from genuine gaps
- Root evidence gate re-reads current accepted child reports and refuses omitted successful candidates or invented source completeness
- Optional disabled-by-default provider quota snapshots and host midnight lifecycle; exact-decimal persisted balance-boundary movement with first-day/tolerance uncertainty, never gross/per-task spend
- Trusted native semantic gates, explicit failure receipts, root finalized artifact identity/hash/byte checks, immutable replay and bounded/symlink-safe delivery reads
- Optional Feishu schema-keyed renderer registration validates authoritative stored data and artifact provenance; arbitrary model notification cards are not trusted

Original root and node/game result contracts differ: only Agent Daily root requires a finalized artifact-set equivalent. Node/game validated structured payloads can cross the signed executor/authority boundary without remote artifact upload. The full legacy payload lives under `report.data.payload` inside an explicit `legacy_task_pack_result.v1` envelope; execution identity and root bounded builder inputs are separate metadata. `report.schemaId` selects the domain validator. The payload's original schema is not silently expanded with binding fields.

## Native host setup

Mount the packaged plugin after Task System. Configure its reviewed `sourceRegistry` entries as `{id,root,manifest}`; roots and manifest files are fixed operator inputs. A manifest selects reader formats and explicit files under its root. The current run's immutable configured `input.sourceIds`, `windowStart`, `windowEnd` and optional `timeZone` authorize the selected subset and report window. Model arguments cannot supply source paths, SQL, commands, account credentials, artifact roots or aliases.

Use `createLegacyTemplates(config)` and `ledger.updateTemplate` to install pinned root/node/game/ad-hoc definitions. Their `resultValidator` IDs are enforced by the core ledger for every settlement; removing the provider fails closed. `expectedNodeIds` and `quietWindowMs` define root aggregation requirements; `nodeAliases` explicitly maps authenticated worker IDs to compatibility domain labels. No fixed machine names are necessary. `accountMeasurementNodeId` selects the single eligible account-measurement source.

Explicitly include `legacy_sources_read` and `legacy_report_prepare` in the owning executor's allowed `executionTools`. A planner-only profile must not expose source/artifact workload tools. The native source tool returns full bounded evidence and an attempt/execution-bound receipt. Node/game preparation consumes that receipt, so a model cannot replace the captured reader results with fabricated source JSON. Source-provider unload aborts/drains reads and discards receipts. Oversize evidence fails explicitly instead of returning a truncated success; the configurable bound is at most 16 MiB.

The native sequence is:

1. `legacy_sources_read` with configured source IDs
2. `legacy_report_prepare`: node input supplies `sourceReceiptId`, `sourceId` and bounded semantic candidates; game input supplies the receipt and source ID; root input supplies its bounded builder input after node settlement
3. Pass the returned structured report directly to `task_settle`, including its data/schema/artifact IDs. Use the host's lossless tool/PTC values instead of copying the final JSON through an assistant answer

Preparation does not settle execution. Task System owns quiescent finalization and the transactional result/outbox commit. `settleLegacyReport` is an external already-quiescent helper, not a model preparation tool. Root preparation occurs on the authority host so its artifacts are local to that ledger; remote node/game preparation needs no local coordinator task row.

Feishu is optional. When present, the pack mounts renderer callbacks with lifecycle effects; `legacy-report` and `legacy-report-error` deliveries wait for their renderer rather than silently using a generic card. Delivery acceptance, execution outcome, domain business status, source completeness and artifact integrity remain separate. A successful game inspection can correctly report failed automation.

## Run without credentials

From the repository root:

```sh
node examples/legacy-task-pack/readers/run.mjs --root examples/legacy-task-pack/readers/fixtures --config manifest.json
node --test tests/legacy/readers.test.mjs tests/legacy/reporting.test.mjs tests/legacy/configured-sources.test.mjs
```

The manifest and every test input are synthetic. The source runner writes only its structured result to stdout, never starts a model, reruns game automation or sends a message.

Optional reference-only differential checks are separate:

```sh
DSH_LEGACY_REFERENCE_ROOT=/explicit/read-only/Plugins-checkout node --test tests/legacy/differential-reference.test.mjs
```

Without that environment variable the three reference tests are skipped. They were separately executed against the pinned source during development; the distributed pack never imports original source. They compare selected valid/invalid synthetic verdicts, not every original log/parser behavior.

## Remaining proof

See `REMAINING-PARITY.md`, `readers/README.md` and root `docs/PARITY.md` for the finite source-backed checklist. Passing fixture/native tests is not live cross-hardware/Feishu/provider/Windows acceptance. The old post-August-fix automatic root report remains a historical unknown. Provider quota snapshot scheduling, transport health/alerts and historical mixed-output compatibility now have executable owners and fixture acceptance. Active tool approval, lifecycle replies, delayed diagnostics and durable native result recovery now have implementation/fixture acceptance. Reviewed completed-tool continuation and native prepared-source proof also passed their joined actual-DSH/signed fixtures. Live deployment retains separate gates; do not infer full parity from generic schemas or test counts.

## Ad-hoc human work review (FR-C10)

`daily_work_summary` is another configurable task type in this pack, with its own
`daily_work_summary.v1` schema. It is deliberately different from root Agent Daily:
shares use **included user turns**, not deduplicated root tasks. It consumes the same
configured Codex/Hermes reader receipt. In `legacy_report_prepare`, select this kind
and supply `sourceReceiptId`, `sourceId`, and bounded semantic `turns`, `groups` and
`attention`. The builder owns source references, session/new/continued counts,
completion counts, sorted themes and percentages. A completed turn requires final
evidence; actual blocked/failed source status cannot be relabeled completed.

Each group has `group_id`, `title`, integer `importance`, `turn_refs` and two to five
concrete `accomplishments`. Every source turn belongs to exactly one group; all
semantic turn rows have an exact `source_ref` and conservative `status`. Attention
has a title/detail and only unresolved turn references. Language defaults to `zh`;
`en` is explicit. Reports lead with outcomes, use compact session/turn suffixes,
omit empty attention, retain all-active/top-level Codex and local Hermes token
supplements, and explicitly state shares are not time spent. Raw source message
text and paths are not included in the rendered report. Native preparation still
only prepares; `task_settle` and its trusted pinned validator own final acceptance.

Standalone host code can use `createDailyWorkInput`, `buildDailyWorkSummary`,
`validateDailyWorkSummary` and `renderDailyWorkSummary` from the packaged task-pack
export. `tests/legacy/ad-hoc.test.mjs` supplies credential-free source/ledger fixtures.
The original source is Shared Assets pinned commit `774e495...`,
`skills/promoted/codex-daily-work-summary/SKILL.md` and
`references/report-contract.md`; the implementation is new MIT code.

## Provider snapshots and historical output

The main task-pack export also supplies quota APIs and `parseLegacyAgentOutput`.
See `quota/README.md` for the disabled-by-default host lifecycle and explicit
transient credentials, and `compatibility/README.md` for bounded historical parsing.
A configured source manifest may contain `quota: {databasePath, format: 'native'}`
or explicit `format: 'hermes'`; the read-only snapshot reader uses the same source
root and pinned task window. It never invokes providers or reads credentials.
Historical parsed stdout cannot settle a new execution; registered verified report
artifacts retain precedence over an explicitly enabled historical fallback.

## On-demand automation diagnostics (FR-G02)

`automation_diagnostics` is a separate read-only task type for the original
26-hour lookback diagnosis. It does not substitute calendar-day Game Daily or
control automation. A source manifest may contain `diagnostics` with explicit
`historyRoot`/`historyFiles`, `logs`, `scriptConfigFile`, `queueConfigFile`, source
timezone/encoding and optional `processInventoryFile`. Every path remains under the
configured export root. The process file is an explicit host-exported array of
names; this module performs no live process enumeration or installed-app discovery.
The native reader derives device identity from its authenticated scope and fixes
`collectedAt` to the pinned task windowEnd. Lookback defaults to 26 hours.

Use the same source receipt and source ID with `legacy_report_prepare` kind
`automation_diagnostics`. Its closed validator derives status/age fields from
retained source evidence and deterministic bounded text. Exceeding source/output
bounds is explicit partial quality or failure; no silent loss of full evidence.
Reports carry `authoritativeExecution:false`: observed history/process names never
prove that a game task was newly executed or failed. The current inspection task's
ledger outcome is separate. All diagnostic text is filtered/redacted before
clipping, and raw private installation paths from configuration are never followed.

Standalone exports are `readAutomationDiagnostics`, `validateAutomationDiagnostics`,
`renderAutomationDiagnostics` and `redactDiagnosticsText`; an explicit-root on-demand
CLI is `diagnostics/run.mjs`. See its README and nine synthetic tests, plus the real
configured-source/ledger gate fixture. No original producer code is bundled.

## Prepared-source proof and restart

The native host calls `validateResultContract` in a trusted `executor-preflight`
phase after the owned agent is idle and its session is flushed, while its scope is
still live. Node/game/ad-hoc/diagnostic validators require a private prepared-envelope
hash from this plugin, bound to the full canonical envelope, kind, task, run,
attempt and execution owner. A model cannot create that membership by writing a
valid-looking report or reusing another attempt's reader receipt. Root reports use
the authoritative current-node/artifact gate instead.

After successful preflight and owner disposal, the native host can persist the
exact ready terminal result in its independent durable journal. The coordinator
and journal replay use `phase:authority`: all deterministic schema/semantic/root/
artifact checks still run, but they never require a remote or restarted process's
in-memory capture map. Missing validators hold recovery until their provider is
mounted. A crash before a trusted ready receipt remains uncertainty, not inferred
success; ready replay never repeats a reader/model/tool execution. This phase is
host-only metadata, never a field accepted from model report JSON.
