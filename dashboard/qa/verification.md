# Dashboard verification, 2026-10-01

## Current source-only curation patch

- 17/17 Node tests passed, including dismissed/default list/search/count behavior, appended-report non-readmission, opt-in history, restoration compatibility, API/export field preservation, and real status-append script coverage
- 12/12 synthetic DOM interaction checks passed using `qa/curation-dom-smoke.mjs`: default hidden state, refreshed report retention, checkbox opt-in, labels, search, detail deep links, report/run/schedule scope, and unchanged source timestamps
- No private ledger mutation, static export, or publication was performed for this patch; the existing published snapshot remains unchanged
- Browser/mobile visual verification remains unavailable; DOM interaction results do not establish layout quality

## Earlier deployment validation

- 13/13 Node model, status-append and HTTP tests (`node --test dashboard/tests/*.test.mjs`)
- 12/12 additional linkedom DOM smoke checks against the real three-task ledger projection: filter, search, task detail routes, retained reports, truthful historical render progress, completed task semantics, unknown run/session handling, artifact count, configuration empty state and back navigation
- Real ledger import: 3 authorized tasks, no fabricated runs, 10 reports, 5 artifacts, 2 workspace records; original creation unknown remains distinct from import creation time
- Private Site source push and exact-commit deployment succeeded
- Native access query: custom owner-only policy, one owner, zero external visitors, no allowed groups
- Remote CDP browser reached the deployed Site's ChatGPT sign-in gate, confirming that it is not a publicly accessible dashboard

## Not passed / not performed

- Browser desktop/mobile layout, screenshots, touch, focus and 200% zoom checks are **not verified**
- Cloud browser loopback preview returned ERR_BLOCKED_BY_CLIENT
- System Chromium headless launch could not create its required socket; bundled Playwright browser binaries and other offline renderers are absent
- No supported user-facing local forwarding or managed preview service is available in this environment
- Deployed UI is behind owner sign-in; no credentials, tokens or access bypass were used for QA

CSS contains responsive 820 / 650 / 420 px breakpoints, 16 px mobile report text and touch-sized controls. These are implementation facts, not evidence of visual acceptance.

## Scope

This first delivery is an explicitly timestamped private **snapshot**, generated from the same TaskLedger and frontend as the local live mode. It is not automatic observation of every executor and does not imply that an active task has just checked in. Neither a successful deployment nor DOM tests establishes browser visual quality. The local read-only server and authenticated-host handler remain available for a later actual host deployment.
