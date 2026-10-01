# Historical report output compatibility

`parseLegacyAgentOutput` is an independent MIT parser for FR-R03. It accepts strict
`agent_daily_report.v1` JSON and validates it using the current pure report
validator. Set `allowLegacyFallback: true` explicitly for legacy mixed stdout or
complete all-added JSON unified diffs. This is an import/read path only: no task is
created, run settled, file written, or artifact finalized.

Supported synthetic examples:

```js
import { parseLegacyAgentOutput } from './compatibility/index.mjs';

const strict = parseLegacyAgentOutput(reportJson, { sourceId: 'operator-export-1' });
const noisy = parseLegacyAgentOutput(stdoutText, {
  sourceId: 'operator-export-2', allowLegacyFallback: true,
  allowedPatchPaths: ['report.json', '/tmp/report.json'],
});
```

Supported patch headers are standard `diff --git` / `---` / `+++` headers and the
legacy `a/path → b/path` review header. A complete all-added hunk must start at
`-0,0 +1,N`. Historical inaccurate line counts remain a provenance warning when the
reconstructed JSON is complete and valid. Context/deletion hunks, renames, partial
files, second hunks, traversal, and unknown patch paths fail closed. Every named
path requires an exact operator allowlist match; paths are only recorded and are
never opened or trusted as artifact provenance.

Mixed output may include fenced JSON, tool noise, or equivalent repeated reports.
Each candidate retains its UTF-16 start/end offsets, format, and optional patch
path. The result records SHA-256 of original source bytes, candidate canonical JSON,
and normalized report JSON. Equivalent copies are labeled `equivalent_copies`;
inconsistent candidates are rejected instead of silently selecting the last one.
Malformed JSON, prose-only guesses, and invalid report schemas stay invalid. Source
bytes default to at most 4 MiB, depth 128, and report candidates 32, all with bounded
configurable maxima.

Every result contains `authoritativeExecution: false`. Parsed historical text does
not establish a new execution result or authoritative report artifact. A verified
registered artifact must retain precedence; only an explicit historical fallback
should call this parser when an artifact is unavailable. It does not verify identity,
artifact signatures, task/run ownership, or completion. TaskSystem's owned current
attempt and artifact validation remain separate.

Run `node --test tests/legacy/compatibility.test.mjs` for runnable synthetic strict,
mixed, standard diff, legacy-arrow diff, malformed, ambiguous, and bounded fixtures.
The fixtures contain no private historical logs or account information.

Source contract: `hermes-plugins` commit
`1dfacb5e5949d9f248b1feacbc36644fb351f19e`,
`plugins/hermes_monitor/hermes_monitor_plugin/agent_daily_report.py`,
`_extract_report_object` and `validate_and_prepare_agent_report`.
SHA-256: `3ca5de652b0d67ac733fdba2f733c75e3c4a93b5af80585768fd539a1694142f`.
No original source was copied or vendored. Broader output formats, game/node report
stdout, incomplete patch application, arbitrary artifact file reads, and live output
capture are outside this explicit compatibility reader.
