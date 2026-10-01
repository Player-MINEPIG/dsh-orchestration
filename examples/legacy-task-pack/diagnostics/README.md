# On-demand automation diagnostics (FR-G02)

This independently written task-pack module restores the legacy **rolling text diagnostics** outcome. It is an optional configurable task capability, not an additional plugin, a live monitor, or an authoritative execution adapter. Every returned report has `authoritativeExecution: false`.

## Source evidence and licensing boundary

The read-only behavioral reference is `Personal-Hermes-Plugins`, commit `1dfacb5e5949d9f248b1feacbc36644fb351f19e`, file `plugins/hermes_monitor/scripts/pc_au/auto_mas_daily_report.py`:

- `main` defaults text mode to a 26-hour rolling lookback; JSON mode separately invokes the calendar-based producer
- `configured_scripts`, `queue_status` expose configured script/user states and queue times
- `history_runs` selects recent result files by mtime, pairs their logs and retains up to 40 recent runs
- `extract_events`, `redact` select success/error/completion/resource signals, suppress noisy/credential-bearing lines, remove adjacent repeats and bound output
- `diagnostic_sections`, `render`, `render_summary` compose plain-text evidence and latest-result/retry summaries
- `task_processes` supplies related process names, explicitly warning that exited processes do not imply failure

Reference: [pinned producer](https://github.com/Player-MINEPIG/Personal-Hermes-Plugins/blob/1dfacb5e5949d9f248b1feacbc36644fb351f19e/plugins/hermes_monitor/scripts/pc_au/auto_mas_daily_report.py)

The reference repository has no LICENSE. No original implementation, deployment paths, accounts or secrets are copied or distributed. Diagnostic vocabulary, JSON keys and observable bounds are format/behavior facts. The implementation uses the independently written `readers/common.mjs` source scope and `readers/game.mjs` timestamp parser. Distributed tests contain invented temporary exports only.

## API

```js
import { createSourceScope } from '../readers/common.mjs';
import { readAutomationDiagnostics, renderAutomationDiagnostics, validateAutomationDiagnostics } from './index.mjs';

const scope = await createSourceScope('/absolute/operator-selected/export');
const report = await readAutomationDiagnostics({
  scope,
  deviceId: 'operator-selected-node',
  collectedAt: '2026-09-16T01:00:00Z',
  hours: 26,
  sourceTimezone: 'UTC',
  scriptConfigFile: 'config/ScriptConfig.json',
  queueConfigFile: 'config/QueueConfig.json',
  historyRoot: 'history',
  // Or historyFiles: [{ resultFile: 'history/run.json', logFile: 'history/run.log', script: 'Configured companion' }],
  logs: [{ id: 'app', label: 'App export', path: 'logs/app.log' }],
  // Supplied by a host adapter. Omitting this field means unknown, [] means a supplied empty snapshot.
  processInventory: ['AUTO-MAS.exe', { name: 'maa.exe' }],
  interestMarkers: ['CUSTOM COMPLETION'],
  noiseMarkers: ['CUSTOM CHATTER'],
  bounds: { maxHistoryRuns: 40, maxEventsPerLog: 12, maxOutputChars: 32_000 },
});
const summary = renderAutomationDiagnostics(report, { mode: 'summary' });
console.log(summary.text);
```

`exportRoot` and `sourceLimits` can replace `scope`. `collectedAt` requires an explicit timestamp offset. Naive log timestamps require `sourceTimezone` or `sourceUtcOffset`; the parser also supports per-log/per-history overrides, encoding and DST disambiguation. Marker overrides are bounded literal strings, never executable regular expressions. `processMarkers` optionally replaces the known companion process-name vocabulary.

The response includes `device_id`, `window`, retained diagnostic/source bounds, scripts, queues, selected history, latest reported-result hints, diagnostic log sections, process snapshot, source metadata, data-quality gaps/truncations and bounded `text`. Successfully read source records include a SHA-256 of the bounded bytes actually read, byte counts and mtime. The renderer returns `{ title, body, detail, text, truncated }`; evidence and summary modes are both plain text, and its default output bound is the report's retained bound.

`validateAutomationDiagnostics(report)` returns a validated clone and is also called by the reader. It rejects extra fields, authority escalation, inconsistent lookback/count/status/age fields, unbound history/log references, invalid byte/hash metadata, paths escaping the export scope, undisclosed source gaps, removed limitations and text that differs from deterministic rendering. This gate checks retained evidence consistency; a schema/hash value alone does not authenticate a source. TaskPack integration must bind the payload to trusted configured reader results and use the authenticated assignment's node ID rather than a model-supplied node identity.

Run without a scheduler:

```sh
node examples/legacy-task-pack/diagnostics/run.mjs ABSOLUTE_EXPORT_ROOT RELATIVE_CONFIG_FILE [text|json]
node --test tests/legacy/diagnostics.test.mjs
```

The JSON configuration uses the API fields above. Config and every evidence file stay under the explicit export root. CLI exit code 0 means configured sources were read within bounds, 2 means partial/unavailable/truncated configured evidence, and 1 means invalid configuration or setup. It never launches companion automation, settles a task, sends a message or modifies an export.

## Semantics, bounds and limitations

- The default 26-hour rolling window intentionally differs from strict calendar `GameDaily`. Result file mtime selects history; log timestamps filter individual events. A safety upper bound excludes future result/event times. Both window endpoints are inclusive
- History discovery is only inside the explicitly selected exported `historyRoot`; explicit result files can be used instead. Recent metadata is sorted before the bounded result/log reads. Result files are deduplicated. Sibling `.log` pairing applies only within the scope
- Configured installation roots and log paths are recorded only as existence flags and are never followed. The host supplies exported log paths and any rotation/dated-log mapping explicitly. Account names and raw installation paths are omitted
- Related process names come only from the supplied inventory. There is no `tasklist`, shell, process enumeration, home scan, installation discovery or network query. No matching process or an exited process is never classified as failure
- Untimed interesting lines retain `timestamped: false` and an explicit warning. They provide diagnostic context, never proof of in-window task completion. Latest result strings are reported hints, not reconstructed per-task outcomes
- Source-scope limits bound bytes, cumulative reads, file discovery, directories, lines and rows. Defaults additionally retain at most 40 histories, 12 log events, 10 history events, 700 characters per field and 32,000 output characters. Oversized logs read bounded tails; incomplete first tail lines are dropped and partial status is exposed
- Redaction removes quoted/space-bearing credential values, bearer strings, Penguin IDs, long hexadecimal/UUID IDs, email addresses and private local-path forms before text clipping. Credential-like log lines are suppressed. Only selected scalar resource fields and flat bounded statistics are emitted; credential-like statistic keys and nested statistics are omitted
- This does not claim exact legacy raw-parser or live Windows equivalence. Config-path discovery and live process enumeration are deliberately delegated to host adapters. Omitted configuration is explicitly warned about; `data_quality.complete` describes supplied sources only. The output may omit earlier evidence when configured bounds apply

Acceptance tests cover cross-calendar lookback and inclusive cutoff, future/old evidence exclusion, queue/script states, latest-result retry recovery, no-run hints, unscoped timestamps, redaction/noise/repeat suppression, marker overrides, source/text/history/event bounds, unavailable/malformed evidence, path/symlink isolation, host-supplied process distinction, on-demand CLI and byte-for-byte unchanged exports.
