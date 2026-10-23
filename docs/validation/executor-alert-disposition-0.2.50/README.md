# Executor reminders and polling selection

The executor preserves local execution outcomes independently of the scheduler's current Task state. A cancelled Task can retain a blocked historical Run. The bounded authenticated `executionDisposition` read exposes only the assigned execution's Task/Run/Attempt states and scheduler identity. Current-authority observations can remove a verified cancellation from active warnings without rewriting its original result or command receipt.

Local reminder confirmation is separate metadata, bound to a stable claim command or execution Attempt and its state fingerprint. Confirmation can be withdrawn, survives restart, and does not hide a new Attempt or claim command. Active execution, uncertain execution and pending result delivery cannot be confirmed away. Original-authority historical records stay distinct from the current connection. Native-only execution supports the same confirmation contract.

This release also includes the integrated polling-selection fix: incremental rendering retains unchanged text nodes and selection while other task content updates. Executor Task, Run and claim rows have stable DOM keys. Confirmation dialogs keep the existing polling protection.

Validation uses synthetic records and isolated real DSH/SQLite services, authenticated Gateway reads, official Remote-to-Typert contracts and real Chrome. The 25 targeted checks pass. The browser flows cover error-filter confirmation, processed history, withdrawal, restart persistence and active/pending-result restrictions. The existing Chrome selection script passes against the merged renderer.

```sh
npm run build -w @dsh-task/task-system
DSH_OFFICIAL_ROOT=/absolute/path/to/installed/dsh node --test \
  packages/task-system/test/executor-alerts.test.mjs \
  packages/task-system/test/local-executor-panel.test.mjs \
  tests/settings/task-panel-rpc.test.mjs \
  packages/task-system/test/remote/claim-recovery.test.mjs
DSH_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node scripts/validation/task-center-selection-browser.mjs
```

`tests/settings/executor-alert-browser.mjs` serves the isolated real DSH/Typert browser fixture on loopback. Production observations and screenshots remain local and are excluded from this repository. No production reminder is confirmed automatically; no task is rerun for validation. DMC is outside this change.
