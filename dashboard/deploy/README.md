# Private live origin handoff

This directory prepares a private live deployment. It creates no Cloudflare resources, credentials, firewall rules, DNS routes, service users or public listeners. Hosting changes need their own authorized rollout. The existing Site remains an independently timestamped snapshot until updated through its existing workflow.

## Runtime and source of truth

- Node.js 24 or newer; use the root lockfile (`npm ci`) and build (`npm run build`) from the approved source revision.
- The dashboard reads the **same existing absolute SQLite path** as the VPS Task System process. The plugin default `.dsh-task/tasks.sqlite` and the operator demo `.runtime/tasks.sqlite` are different paths. Do not guess, initialize a second database, or periodically copy a live SQLite file without its WAL. Select the actual service databasePath after inspecting its configuration.
- A freshly started VPS ledger is not automatically connected to cloud or desktop task executors. Only connected producers or explicit observed reports appear. A successful poll is not evidence of a new execution report. Preserve observed timestamps, source labels and stale indicators.
- The VPS operator needs read permission to that database and its SQLite WAL/SHM files. Keep database ownership and writer policy with the Task System operator. The frontend has no mutation endpoint.

## Foreground preparation

Copy `live.env.example` to an operator-local file outside version control. Populate it with the verified Access team origin, application audience, single owner email, dashboard HTTPS origin and ledger path. These are configuration values, not credentials. Do not place a Tunnel token, API key, password or cookie in the file.

```sh
sh dashboard/deploy/run-live.sh /absolute/operator/path/live.env --check
sh dashboard/deploy/run-live.sh /absolute/operator/path/live.env
```

`--check` opens the existing ledger read-only and validates configuration without binding a port or testing Cloudflare. The live origin always listens on `127.0.0.1:4317` (or a configured unprivileged port). It refuses command-service port 18440. No `--host` or public-bind setting exists. A service supervisor may run the same command as the existing approved service account once the installation location/account are known; no service is installed by this handoff.

Without a signed owner Access token every path, including `/`, `config.js`, `/api/health`, and `/api/snapshot`, returns 401 and `Cache-Control: no-store`. A plain loopback curl returning 401 is the expected deny check, not a health failure. Keep the separate `server.mjs` local preview command for local browser QA on the user's authorized computer; never tunnel that unauthenticated preview entrypoint.

## Proposed authorized routing

Use one dedicated hostname with one Access application covering **all paths** and one owner-only allow policy. Reject broad email-domain, Everyone, Bypass and service-token rules. Map that hostname through the approved Tunnel to `http://127.0.0.1:4317`; preserve the public Host header or explicitly set the origin HTTP Host header to the verified public hostname. Keep the tunnel fallback route at 404. Do not route the remote-executor command endpoint or port 18440 through this hostname. The UI and API share the same origin and base path; no CORS exception is needed.

Cloudflare account/zone, hostname, team domain, application AUD, owner login identity, Tunnel identity/credential management, and Hangzhou hosting/ICP requirements must be verified before routing. This file assumes no domain, account, or regulatory outcome. Any new persistent grant or security/network configuration requires the operator's specific authorization; this source change supplies neither.

## Authentication behavior

`access.mjs` uses pinned `jose` with one cached remote JWKS resolver derived solely from the configured HTTPS `*.cloudflareaccess.com` team origin. It validates RS256 signatures, exact issuer/application audience, required expiration/issuance/not-before claims, nonempty subject, `type=app`, and the owner email. No email header alone grants access. Invalid tokens, key-fetch failures, mismatched Host and missing configuration fail closed. Public-key fetches have a 5-second timeout and never use token-supplied URLs. Expiration has no grace period.

Only the verified expiration time is returned to the frontend; the JWT, cookie and identity are never persisted or logged. The browser requests same-origin JSON with no-store and manual redirect handling. 401/403, login redirects and HTML responses hide cached task content and stop automatic retries until a top-level login reload. Network/503 failures retain a clearly labeled stale view only until the verified session deadline. Expiry is rechecked after tab restore; local device time should be accurate. Expiration is not immediate central revocation: a disconnected tab can retain its last authorized view until that verified deadline. Use appropriately bounded Access sessions.

The origin and all errors emit no-store; no service worker or localStorage cache exists. Do not add a CDN cache rule for this hostname. No wildcard CORS headers, token query parameters, or embedded credentials are required.

## Rollout and rollback

1. Verify the exact source revision and `npm ci`, build, dashboard tests. Read the existing ledger configuration and back it up through the Task System's supported procedure if making unrelated runtime changes.
2. Fill config and run `--check`; start the loopback origin. Confirm a token-free HTTP request is denied, with no task data in its body.
3. After separate authorization, configure the owner-only Access application before enabling the Tunnel hostname. Keep ports 4317 and 18440 closed to public inbound connections.
4. Complete `../qa/live-browser-checklist.md` on desktop/mobile and the actual owner session. Verify an unauthorized account and unsigned direct-origin request cannot obtain data. Do not save token values in screenshots or receipts.
5. Test a real appended report from the same Task System producer; verify it arrives with the original observed time on the next poll. A test fixture proves UI mechanics, not real executor integration.
6. Rollback routing by removing only the newly approved hostname mapping or stopping the new dashboard process. Leave the task writer/ledger and existing private snapshot Site intact. Do not delete or recreate task history.

Official references: [Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [application token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [jose](https://github.com/panva/jose).
