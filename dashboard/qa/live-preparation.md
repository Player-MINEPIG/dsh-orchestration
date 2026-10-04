# Private live preparation verification

Prepared on 2026-10-02 against source baseline `803ffe9e85ea81458e9b78f09b9dbde52b889df5` and its unchanged task runtime. Source changes are confined to the dashboard plus the root lockfile's pinned `jose@6.2.12` dependency.

Passed locally:

- Full project `npm run check`: 443 tests passed, zero failures/skips (includes the 32 dashboard tests).
- Dashboard tests: 32/32, covering valid signed owner JWT, mismatched owner/issuer/audience/Host, missing or invalid time claims, signature/algorithm rejection, unavailable keys, same-origin reads, login redirects, slow response expiring during parsing, endpoint authorization, safe projection, immutable task history and run-specific diagnostics.
- Curation DOM checks: 12/12. Authentication/connection/diagnostic DOM checks: 21/21. These are interaction checks only.
- Shell/JavaScript syntax and `git diff --check` passed.
- Existing operator ledger was opened read-only and projected through current code: schema version 1, 3 tasks, 12 reports, 0 recorded runs. Its existing observation cutoff remained unchanged. No task, report, Run or source timestamp was invented or changed for QA.

Independent source review found one response-body expiry boundary; it was corrected with a post-parse expiry check and a focused regression case. Expiry is also checked immediately before assigning new data to the UI.

Not run here: desktop/mobile visual rendering, physical phone/touch, real Access owner login, unauthorized account login, actual Cloudflare JWKS retrieval, Tunnel connectivity, VPS service supervision, public-domain routing, or live producer ingestion. The browser checklist documents those remaining checks. No network/account/security resource was provisioned. Existing private Site publishing was not changed by this work.

The endpoint reads current ledger contents every poll. Whether those contents reflect current execution depends on the Task System's actual producers. UI poll time and original observation time remain separate.
