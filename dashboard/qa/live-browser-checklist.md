# Live dashboard browser acceptance

Record exact source revision, browser/version, viewport, operating system, test time, ledger producer and data cutoff. Save desktop/mobile screenshots of the dashboard, task history, stale state and authentication-recovery screen. Screenshots must not include tokens, cookies or developer-tool request headers. DOM tests are not visual acceptance.

Run local layout checks first through `node dashboard/server.mjs --ledger <existing-path> --port 4317` on the authorized test computer. Run owner login/routing checks only on the separately approved live hostname. Do not forward the unauthenticated local preview to a public hostname.

| Flow | Required observation |
| --- | --- |
| Desktop 1440×900 and 1024×768 | Navigation, task cards, cutoff and counts readable; no overlapping controls or clipped long IDs |
| Mobile 390×844 and 360×800, portrait/landscape | No page-wide horizontal overflow; navigation, filters, checkboxes and buttons usable by touch; report text wraps |
| 200% desktop zoom, keyboard | Visible focus; Tab/Shift+Tab/Enter work; search focus/caret survive a refresh; labels remain visible |
| Search/filter/repeated refresh | Search, state filter and dismissed toggle compose; rapid repeated taps do not duplicate requests or reset route |
| Task/history/navigation | All reports and distinct runs/sessions retained; unknown values stay unknown; Back/Forward and deep links return correctly |
| Native execution diagnostics | A real `uncertain` / `outcome=unknown` / `validation=not-submitted` Run with zero reports still shows its own `run.settled` event summary (for example MISSING_CREDENTIAL / NO_ADAPTER); no fabricated report, inferred failure or cross-run error |
| Dismissed tasks | Hidden in normal list/counts, visible via explicit toggle or deep link with label; appending a report does not readmit |
| Real producer update | Append an authorized report through the actual Task System; next poll updates report content without advancing original observed time artificially |
| Offline/503 then recovery | Last successful records remain, cutoff remains visible, status says disconnected/non-live; recovery shows newer data |
| JWT expiry while offline | At verified expiry, task/report content and counts are hidden, last-read time remains, and reload/login action is usable |
| 401/403/login redirect/HTML | No stale private report remains in page; no endless polling/login loop; top-level reload returns through owner login |
| Background/restore | Return from a suspended tab or browser history after expiry; contents are hidden before resuming reads |
| Authorization | Owner allowed; unsigned requests and unauthorized account denied on UI/assets/API; no CORS wildcard or publicly reachable command port |
| Base path | If mounted below `/`, relative assets, API path, reload and deep links all work |

For failure simulation, use browser DevTools request blocking/offline mode or a disposable test origin. Never revoke production credentials or change account policies merely to simulate an error. Mark each case PASS/FAIL/NOT RUN with evidence and limitations. A desktop responsive viewport is useful layout evidence, but does not establish actual phone browser, touch, mobile-network or owner-authentication acceptance.
