# Current product verification

Follow the [development and release workflow](DEVELOPMENT.md). Daily feature PRs target `dev` and require Linux Core, Native DSH, UI (UTC), Installed packages, and `PR flow`, with an up-to-date head. `PR flow` rejects PR releases to `main` and branches from other repositories.

Ordinary device deployment follows the [deployment procedure](DEVELOPMENT.md#deploy-to-devices). Reuse a suitable verified GitHub package. If a package artifact is missing, run only the build and verification needed to obtain it, subject to the available workflow. Version preparation and full release verification are not automatic deployment prerequisites. The current manual `verify` workflow runs the complete suite described below.

Pushes do not trigger CI. Manual `verify` on an exact dev head runs complete Linux/macOS core and native checks, UTC browser/UI and installed-package acceptance. Only after all pass and the candidate artifact is uploaded does the workflow write `Full CI` to that commit. `release-candidate-<SHA>-<run ID>-<attempt>` preserves `candidate.json`, successful receipts and the exact installed tarballs with SHA-256 hashes; repeated task-system packs must have identical bytes.

Manual `promote` must run trusted `main` code and reuse that successful verification artifact. It accepts a short summary, plain-text device record and actual user confirmation evidence. The controller adds candidate/package/operator metadata, uploads the detailed record and exact short tag text, and verifies that artifact before writing `Release approved` and atomically fast-forwarding main with a version tag derived from the tested package. The tag body contains only the summary and Full CI link; each promotion attempt retains its detailed artifact for 90 days. These are commit statuses bound to GitHub Actions, distinct from job names. CI cannot independently prove physical-device testing or a user's external confirmation. No workflow deploys packages or changes device configuration. See the release workflow for version preparation before full CI, text input limits, and the narrowly scoped owner fallback if GitHub denies bot pushes of workflow changes.

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

`npm run check` builds and runs every row except browser and distribution. PR checks use Linux. Manual release verification runs core and native independently on Linux and macOS, browser/UI in UTC, and installed-package acceptance on Linux. All jobs are required for a successful workflow; there is no deployment job.

UTC is the routine UI environment. Core tests still explicitly exercise IANA time zones, including Asia/Shanghai day boundaries and Australia/Melbourne daylight-saving schedules in `schedule-window.test.mjs` and `scheduled-plans.test.mjs`. This does not verify every non-UTC browser display; use a focused browser check or real-device acceptance for those cases.

To reproduce product coverage on a local OS (release verification additionally runs core/native on both Linux and macOS):

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

`node --test tests/ci/*.test.mjs` verifies PR routing, release input/receipt validation and actual local Git atomic-push behavior. These tests run in the Core job.

Logs and JSON receipts are written under `.runtime/ci-results` and uploaded even after failure. Browser fixtures include failure screenshots and per-group results. Set `DSH_BROWSER_OUTPUT` to override the browser output path, or `DSH_CI_RESULTS_DIR` for distribution receipts. Only synthetic data belongs in these artifacts.

Feishu is optional: `npm run test:feishu` and `npm run test:distribution:feishu` explicitly build and exercise it. It remains an npm workspace, so dependency installation includes its locked dependencies; default build/check/distribution do not exercise it. The former typed-decision engine is compiled only for retained historical decision fixtures, and is not installed by the current packages.
