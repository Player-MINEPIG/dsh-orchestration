# Migration from a Hermes task registry

The target preserves task outcomes and evidence, while replacing the old host coupling. Do not import a live database file while another process writes it. Obtain an operator-authorized SQLite backup/snapshot first, keep the original, and use a separate destination ledger.

1. Call `readLegacyHermes(sourceDatabasePath, {namespace, observedAt})` to produce `{snapshot,warnings}` without changing the source
2. Review task identities, parent relationships, run status, every result submission, artifacts and missing-provenance warnings
3. Import with `targetLedger.importSnapshot(stableCommandId, snapshot)`. Repeating the same import is idempotent; changed historical run/report content conflicts rather than silently overwriting
4. Revalidate artifact bytes separately. Imported references are not automatically finalized artifacts
5. Recreate reviewed templates/schedules with new explicit configuration. Rebind approved nodes/workspaces and add existing credentials through the host’s authorized setup process
6. Compare task counts/history and source IDs before enabling new workload execution. Imported work is observe-only and is never automatically redispatched

A source task ID remains in its imported provenance tag; destination IDs are stable namespace-derived aliases. Existing result submissions remain separate reports. Missing task rows get explicitly unknown placeholders; overwritten old payload revisions cannot be recovered or invented. Previously running work becomes uncertain historical evidence. Multi-session grouping of ambiguous old task IDs requires an explicit reviewed mapping, not a text-similarity merge.

Upgraded `serve_runtime_session_id` and `serve_stored_session_id` values are retained. Original task configuration, run result/usage fields, submissions, inline artifact payloads and event payloads also remain inspectable as inert source records, including malformed JSON strings. The importer never evaluates them or activates their old permissions. Treat the resulting ledger as private: historical report/configuration content can contain sensitive user-authored material.

The new task model treats continuing the same objective as another run under the same task. Legacy child-task continuations are preserved during import rather than guessed into merged history. A user can review and link them later.

Daily and game-daily reports are examples of user-defined templates. Their data-source selection, normalization, presentation and validation belong to configurable extensions. Bitable/Datasette are replaceable views; no automatic deployment of those old services is required. WinSW/systemd/launchd supervise the agent host, not a separate plugin daemon. Codex delegation can be expressed through host skills/AGENTS.md; plugin self-maintenance is out of scope.

The supplied local evidence confirmed the source commits already reviewed and added design/history context. The August root-report fix has deployment evidence but no independent record of the next automatic full root run passing; it is retained as a regression scenario rather than labeled a live pass.

For large histories, respect both the reader's explicit row limit (50,000 per selected table by default) and the core's 2,000,000-character canonical command limit. Split a reviewed snapshot into stable batches: tasks first, then their runs, reports, artifacts and events, preserving the same source metadata and deterministic command IDs. Do not truncate an oversized individual record or mark an incomplete import complete. Inspect returned warnings and reconcile source/destination counts before enabling execution.
