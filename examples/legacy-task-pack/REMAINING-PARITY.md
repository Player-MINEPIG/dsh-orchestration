# Legacy outcome parity: current task-pack evidence

The user explicitly replaced mandatory Bitable/Datasette views, placed platform
maintenance in the agent host, declined mandatory product Codex/self-maintenance
plugins, and requested configurable daily/game task types. They did not remove
collector, accounting, validation, diagnostics or report-delivery outcomes.

Source pins: Plugins `1dfacb5e5949d9f248b1feacbc36644fb351f19e` and Shared Assets
`774e49583eca39ba8979d4a252913bef45a22bc8`. All shipped algorithms and fixtures are
new independent MIT code. The reference repositories had no root LICENSE; their
source is neither bundled nor copied. Original source may be explicitly supplied
for the separate optional validator comparison only.

## Previously missing outcomes now executable

| Outcome / original source functions | Maintained equivalent | Offline acceptance |
|---|---|---|
| Agent Daily partition, duplicates, counts, shares: `agent_daily_builder.py._validate_builder_input/build_agent_daily_report` | `reporting.mjs` deterministic root builder; retained semantic input is rebuilt by trusted settlement callback | Omitted/invented/repeated/cyclic candidates and derived-field tamper are rejected |
| Node evidence/account scope: Shared `build_agent_daily_node_report.py.build_node_report/_codex_account`; Plugins node validator | Evidence-closed node builder/validator and configured account-measurement node | Window/source refs, missing turns, unavailable usage and reset comparability |
| Codex/Hermes user work and ACK remainder: `scan_rollout/read_thread_rows/session_turns/read_task_client_bindings` | `readers/daily.mjs` exact reviewed export/SQLite/JSONL formats | Continued sessions, exclusions, ACK joins, real private DB+WAL read, unchanged source bytes |
| HSR/OneDragon/MAA result, history/config/log/timezone/metrics: `auto_mas_daily_report_json.py` | Editable rule data and `readers/game.mjs/composition.mjs/presets.mjs` | Encodings/DST, routine+annihilation merge, six MAA metric fields, required/optional/no-run/causal/scheduler distinctions |
| Semantic presentation: Agent/Game normalizer/validator/renderers | Trusted authoritative payload renderers | Exact schema/evidence/status validation, report-wide attention and configured policy gaps |
| Finalized root artifact: `report_artifacts.py`, root `artifact_set` submission | `prepareLegacyReport` + immutable bounded artifact + semantic callback + core byte verification | Missing/wrong-root/tampered/oversized/symlink/replay overwrite fail; only root mandates local artifact |
| Specialized report delivery: `send_agent_daily_report.py` artifact-first sender/invalid card/dedupe | Stored report schema renderer, explicit error receipt/card and channel outbox | Authoritative report versus forged notification payload, missing provider pending, tamper and independent delivery outcome |
| Historical mixed stdout/diff: `agent_daily_report.py._extract_report_object` | `compatibility/index.mjs` explicit bounded historical parser | Strict/mixed/fenced/all-added diff, ambiguity and path allowlist; authoritativeExecution:false |
| Provider snapshots, private persistence/midnight retries: `quota_monitor.py`, `collect_provider_quotas.py` | Optional off-by-default quota providers/store/monitor/native host effect | Fixed request/signature/IMDS mode, exact decimals, privacy, success dedupe, failure-only finite retry, unload drainage |
| Quota net movement and old snapshot input: `_nearest_metric/summarize_day` | Scoped read-only native/legacy snapshot reader and exact-decimal boundary summary | Boundary tolerance/missing-first-day unavailable; source bytes unchanged; never gross/per-task spend |
| On-demand automation lookback/process diagnostics: `auto_mas_daily_report.py.task_processes/diagnostic_sections/render` | `diagnostics/index.mjs` + configured-source automation_diagnostics task kind | Nine bounded/redacted/provenance fixtures plus real ledger gate |
| Ad-hoc human daily summary with turn-share denominator: promoted `codex-daily-work-summary` skill/report-contract | `daily_work_summary` task kind in `ad-hoc.mjs` | Real reader closure, conservative completion, partition/shares, continued sessions, compact evidence and real ledger semantic gate |

`legacy_sources_read` authorizes only configured source IDs from the immutable
current task input. The full bounded source bundle is retained behind an
attempt/execution-bound receipt. Native node/game/ad-hoc preparation consumes that
receipt; model arguments cannot choose paths/SQL/commands or substitute source JSON.
`legacy_report_prepare` never commits execution. Native `task_settle` owns final
quiescence and the pinned semantic validator; schema-shaped success cannot skip
those checks. Root preparation runs on its artifact authority host.

The source reader README contains its finite format matrix. It no longer leaves
known credential-free Codex/Hermes/AUTO-MAS input families as an operator-supplied
old-source placeholder. Synthetic format acceptance is not proof against every
undisclosed historical file or real installation.

## Remaining gates

Root `docs/PARITY.md` is the authoritative finite 64-outcome implementation matrix.
Completed adapters now include active tool approval, dedicated lifecycle
created→terminal replies, bounded delayed connectivity diagnostics, native ready
result journaling and automation lookback/process diagnostics. Reviewed completed-tool continuation and the joined native prepared-source
proof/restart fixtures have also passed. There are no known remaining local
implementation gaps in the reviewed required scope. This offline/native acceptance
is separate from real-account/device/model-quality gates. Configuration alone never removes a source outcome.

Live gates remain real stable exports/Windows logs, full configured multi-node
root report artifact closure, live provider credentials and real Feishu receipts.
The old post-August-fix automatic root run remains a historical unknown. Offline
native tests use real DSH services but scripted model/network boundaries.

The three optional original-validator comparisons were separately run against the
pinned source with zero skips. When the reference environment variable is absent,
they are skipped and must not be counted as passes. They compare only the selected
synthetic validator corpus, not all original builders/parsers or live outcomes.
