# Current product verification

Follow the [development and release workflow](DEVELOPMENT.md) for branch routing and real-device acceptance. Both `dev` and `main` require the product checks below and the `PR flow` check, with an up-to-date head. `PR flow` permits same-repository feature PRs to `dev`, `main` → `dev` synchronization, and `dev` → `main` promotion. It rejects direct feature PRs to `main` and a fork's branch named `dev`.

The real-device acceptance record and explicit user confirmation are a manual release requirement. CI does not verify that a device was tested or that the user approved its results.

CI runs for pull requests targeting `dev` or `main`. Pushes do not start workflows, so a feature push does not repeat the same product checks alongside its PR. The product workflow also retains `workflow_dispatch` for an explicitly requested manual run. Browser, official-runtime, and installed-package coverage remains required on PRs.

The Ubuntu UI job uses the runner's [preinstalled Google Chrome](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) through Playwright's [Chrome channel](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge). It verifies the executable and saves its version to `browser-version.txt` in the job artifacts. CI does not download Chromium or run `apt` for browser dependencies. Chrome follows the runner image version, so it is not the same pinned binary as Playwright's bundled Chromium. All browser scenarios run in UTC and fail if Chrome is missing or incompatible.

Local commands below use bundled Chromium by default. To use an installed Google Chrome locally, set `DSH_BROWSER_CHANNEL=chrome` for `npm run test:browser`; skip the browser-install command in that case. npm dependency installation remains necessary, and `setup-node` already caches npm downloads. Official DSH runtime and installed-package checks retain their existing installation steps.

Node 24 and OpenSSL are required. Start with `npm ci --ignore-scripts`.

| Entry | Required behavior |
|---|---|
| `npm run test:core` | Durable tasks, runs and reports; project/workflow/schedule state; registration; exact authority, claims, recovery, workspace grants and authenticated transport |
| `npm run test:native` | Real Loader, AgentLoop, native presets and tools; executor model policy; project context, task returns and cancellation boundaries |
| `npm run test:ui` | Settings codecs/CAS and permissions; planner/executor views; task and workflow pages; local reminder metadata |
| `npm run test:official` | Pinned official PTC, permission/profile, workspace registry and Remote/Typert contracts |
| `npm run test:browser` | Real React settings, isolated service-backed reminder confirmation/withdrawal, and unchanged text selection during polling |
| `npm run test:distribution` | Core package tarball install, persistent three-role boot, offline native use, uninstall and retained ledger/recovery data |
| `npm run test:jev`, `test:dashboard`, `test:task-pack`, `test:management` | Current model service and shipped consumers/task-pack exports |

`npm run check` builds and runs every row except browser and distribution. GitHub runs core and native checks independently on Linux and macOS, browser/UI checks in UTC, and installed-package acceptance on Linux. All jobs are required for a successful workflow; there is no deployment job.

UTC is the routine UI environment. Core tests still explicitly exercise IANA time zones, including Asia/Shanghai day boundaries and Australia/Melbourne daylight-saving schedules in `schedule-window.test.mjs` and `scheduled-plans.test.mjs`. This does not verify every non-UTC browser display; use a focused browser check or real-device acceptance for those cases.

To reproduce the entire workflow locally:

```sh
npm ci --ignore-scripts
npm run check
npx playwright install --with-deps chromium
TZ=UTC npm run test:ui
TZ=UTC npm run test:browser
npm run test:distribution
```

For an optional non-UTC UI/browser check, run `TZ=Australia/Melbourne npm run test:ui` and `TZ=Australia/Melbourne npm run test:browser` after the same preparation.

For a focused suite, first run `npm run build && npm run build:fixtures`. The official entry prepares its pinned runtime automatically. `npm run setup:runtime` prepares it explicitly. `DSH_CI_RUNTIME_ROOT` selects an isolated installation directory; the default is `.runtime/official-dsh-0.2.1-rc.2`. It contains both the official CLI and web application presets/services. Tests do not use a personal DSH profile or CLI path.

`tests/ci/suites.json` assigns every `.test.mjs` in the task package, its remote tests, `tests/dsh` and `tests/settings` exactly once. The runner rejects missing, duplicate and removed entries, so new tests cannot be silently omitted. It limits concurrent test files to four. Fixtures publish and refresh synthetic model catalogs through the actual catalog protocol, configure explicit execution roots/presets, and retain the production permission and admission checks.

Eight old settings tests that manually emulated React hook indices were replaced by real browser actions against the current staged-save and local-workspace-grant UI. Pure codec, CAS, identity and permission tests remain. String-backed task-page tests use a renderer stand-in for presentation assertions; the mandatory browser suite separately verifies DOM identity and native selection. Old automatic-default-workspace and heartbeat-model-list fixtures are migrated to managed execution directories and the model catalog/default policy. Historical persisted-run compatibility is tested explicitly where still supported. The old `test:settings:official` name now aliases the current official suite.

Logs and JSON receipts are written under `.runtime/ci-results` and uploaded even after failure. Browser fixtures include failure screenshots and per-group results. Set `DSH_BROWSER_OUTPUT` to override the browser output path, or `DSH_CI_RESULTS_DIR` for distribution receipts. Only synthetic data belongs in these artifacts.

Feishu is optional: `npm run test:feishu` and `npm run test:distribution:feishu` explicitly build and exercise it. It remains an npm workspace, so dependency installation includes its locked dependencies; default build/check/distribution do not exercise it. The former typed-decision engine is compiled only for retained historical decision fixtures, and is not installed by the current packages.
