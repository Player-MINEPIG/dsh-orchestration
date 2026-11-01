# Demand reads for the task center

The ledger remains authoritative. The task UI reads named products instead of exporting the complete ledger and then filtering it in JavaScript. Complete ledger/project exports and explicit model-tool history reads remain available independently.

## Ownership and products

- `ledger-read-index.ts` maintains private entity facts and durable check-in candidates in the authority database. SQL-only triggers record writes, including writes made by an older package. Task/Run/Attempt parent and state columns are repaired from authoritative JSON; legacy null columns remain visible.
- `demand-read-views.ts` owns task display rows. ProjectRuntime supplies the existing presentation rules. Scope, filters, counts, ordering and `LIMIT/OFFSET` run in SQL before selected display JSON is decoded. Board facets are computed once per board request.
- Project, registration and workflow headers support their own list/history products. Selected Task, Run, Report, project and workflow details read their exact records. Workflow maintenance selects indexed runnable headers before loading execution/output JSON.
- Local executor reads combine ledger, recovery and queue headers in a disposable SQL product. Durable recovery records retain ownership priority. Source revisions and tombstones update only changed headers; claims have independent pages. Report/context/configuration bodies are not mirrored. Error detail/message fields remain exact because existing local alert fingerprints depend on them; public display summaries may still be clipped.
- Session task pages merge authorized task headers, local Codex headers and shell-job receipts before filtering/counting/paging. Rank probes select a final union page without downloading its preceding pages. On a host that both plans and executes, local assignments override matching central Task IDs before union counts and pages are selected.

`demand-reads.ts` defines the products; `demand-read-inputs.ts` validates their boundaries. Browser state owns query/page/selection intent, not another status classifier. Task, execution, report, graph and workflow histories expose explicit further pages.

## Consistency and authorization

Dirty reconciliation and a read share a SQLite transaction. A turn processes a bounded source/display batch. If more work remains, it commits derivative progress and returns `READ_MODEL_UPDATING`; the next request advances rather than repeating a rolled-back batch. Normal restart retains current display rows and unfinished invalidations. Time-derived presentation uses the ledger clock.

Authenticated remote peers select their own node scope at the gateway. Assignment seeds descend first; ancestors are then added for context without granting sibling visibility. Exact detail lookups use the same scope and public field whitelists. Node workflow steps exclude private output, execution configuration, session IDs and retry internals. Artifact visibility is constrained by authorized Task IDs before project filtering.

The `demandRead` operation accepts explicit permission or the existing public `projectSnapshot` read permission. It does not grant mutations or broader fields. New clients talking to an older central service report an upgrade requirement; they do not fall back to full snapshots. Legacy snapshot callers remain compatible and can still incur full-export cost until upgraded.

## Lifecycle and maintenance

Host panel visibility, iframe unload and browser-tab visibility jointly control UI reads. Hidden/unmounted panels stop timers; resuming refreshes immediately. Epochs and request tokens prevent late responses from reviving hidden views or leaving a report permanently loading. Graph expansion retains loaded ranges without a native `details.toggle`/render request loop.

With no frontend, existing maintenance continues. Queued/due/active/dirty SQL candidates drive check-ins, message delivery, deadlines, lease recovery, schedules, result recovery and workflow cancellation. Receipt loss, uncertain effects and unacknowledged cancellation remain recovery conditions, not reasons to replay work.

The DSH persistence SDK has a separate boundary: `SessionHandle.read(offset, length)` may still decode the complete stored JSONL file internally. The session dispatch index feeds appended live-session events without repeatedly reading historical persistence. A cold non-live session or cross-process replacement can require the SDK's initial scan. This change does not claim physical pagination of the host's native session-history storage.

## Migration and rollback boundary

First writable open creates rebuildable facts/headers and canonical indexes. Only then does it atomically migrate the action/responsibility fingerprint algorithm to v2. Only receipts that match the old current evidence are remapped; already stale receipts remain stale. Large Run project contexts are hashed at projection time rather than copied into facts. Report reading versions retain their existing algorithm.

Before activation, preserve the previous exact package and a consistent database backup, and measure first-open/readiness on a copy. Initial metadata construction and display warm-up are distinct from warm page/maintenance behavior. Preserve independent package hotfixes and launch overlays.

Older binaries can write the authoritative tables because derivative triggers use only SQL. They do not understand the v2 attention/responsibility fingerprints. A package rollback can therefore show those receipts as unresolved; do not restore an old whole database after new business work merely to hide that difference. Sustained old-version receipt writes require a separately verified compatibility migration. This implementation does not automatically reverse business data or receipt migrations.

## Repeatable verification

The Linux suites register these focused tests in `tests/ci/suites.json`:

- `demand-ledger-read-index.test.mjs`: canonical legacy columns, valid/stale receipt migration, partial progress/restart, due times, continuation preservation and cold-source maintenance bounds.
- `demand-products.test.mjs`: real SQL pages/facets/details, node scope, historical attention groups, scoped artifacts, imported receipt headers, large cold messages and workflow outputs, query plans and idle workflow maintenance.
- `executor-demand-reads.test.mjs`: multi-source ownership, pagination, claims, result details, deletion/restart, session selection and added cold dispatch/ledger history.
- `session-demand-reads.test.mjs`: final-union pages/counts/filters, rank probes, local-only records, live append indexing and identity/reset races.
- `demand-read-lifecycle.test.mjs` and page suites: real backend responses, visible/hidden/unmounted reads, report version caching and graph range/toggle behavior.

Use `npm run build`, `npm run build:fixtures`, and the relevant `npm run test:core`, `test:ui`, `test:native`, and `test:browser` commands from the development/CI workflow. Performance assertions count authoritative payload reads/decoded bytes and inspect query plans instead of imposing fragile millisecond thresholds. Final acceptance also exercises a real browser and the deployed service with no UI, hidden UI and visible UI.
