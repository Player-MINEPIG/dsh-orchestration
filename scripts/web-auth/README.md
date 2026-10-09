# Tailscale identity login for DSH Web

This standalone VPS service sits between Tailscale Serve and DSH Web. It does not change the task plugin or disable DSH authentication. Browser cookies and launch links are unnecessary at this entry point.

## Trust and configuration

The service binds only to `127.0.0.1`. Serve must be the only network-facing route to it. It checks the configured HTTPS Host, same-origin browser markers, Serve's `Tailscale-User-Login`, and the actual client (last `X-Forwarded-For` hop) against `tailscale whois`. Both the login and numeric user ID must match; tagged and unauthorized nodes are rejected. Identity checks are cached for ten seconds. Tailscale network policy continues to apply.

Example configuration (store on the VPS, outside Git):

```json
{
  "port": 3084,
  "hostSettings": true,
  "publicOrigin": "https://your-vps.your-tailnet.ts.net:10000",
  "upstream": "http://127.0.0.1:3082",
  "allowedLogin": "your-account@example.com",
  "allowedUserId": 123,
  "tailscaleBinary": "/usr/bin/tailscale",
  "launchLog": "/path/to/dsh-web-service.log"
}
```

Run with `node tailscale-dsh-proxy.mjs /path/to/config.json`. The process needs read access to the DSH startup log and access to the local Tailscale daemon for `whois`. It never logs requests, launch tokens, or cookies. DSH's launch URL is read privately from the server startup log and exchanged for a native signed cookie, retained only in proxy memory. Native cookies are not sent to browsers. Keep the current startup URL in the configured log when rotating logs; if unavailable, restart DSH to print a new one. Missing/invalid identity or authentication data fails closed.

The bridge is coupled to DSH's `?token=` exchange, `dsh-auth-` cookie prefix and HTTP 303 response (validated against DSH 0.2.0-rc.2). Revalidate those contracts when upgrading DSH itself. HTTP and WebSocket use the same identity check. Safe reads and WebSocket handshakes can renew rejected credentials once; writes are never replayed. Service downtime returns 503 and does not ask users for a DSH token. Restarted proxies reacquire credentials from the log. DSH restart normally leaves its signed cookie valid; credential rotation is also supported.

## Installation and rollback

Use a systemd service ordered after `tailscaled.service` and the existing DSH Web service, with `Restart=on-failure`, `NoNewPrivileges=true`, an empty capability set, read-only filesystem and AF_INET/AF_INET6/AF_UNIX only. Do not make the proxy port public.

Before changing the root handler, save `tailscale serve status --json`. Add a temporary `--set-path=/__dsh_auth_validation` handler on the existing private HTTPS port, then verify it from the actual owner's Tailscale device without cookies. A loopback request carrying simulated identity headers is only a backend check, not end-to-end acceptance. Remove the temporary handler after the root switch. Change only the existing HTTPS handler:

```sh
tailscale serve --bg --https=10000 http://127.0.0.1:3084
```

Rollback that handler to its original upstream (e.g. `http://127.0.0.1:3082`), then stop the proxy service. Other Serve ports must remain untouched. No task records, model settings, or execution-side settings are changed.

## Verification

```sh
node --test tests/management/web-auth-proxy.test.mjs
```

The suite covers clean-URL/no-cookie login, incorrect and missing identities, spoofed forwarding chains, hostile Host/Origin, identity-service failure, token rollover, bidirectional upgrade transport, non-replayed writes and large startup logs. Deployment acceptance additionally checks real DSH HTTP and WebSocket handshakes through Serve, a DSH restart and a proxy restart, and a direct upstream request without credentials still returning 401.

## Host settings through this entry

With `hostSettings: true`, the owner-authenticated proxy adapts the pinned DSH
0.2.0-rc.2 settings client to read and edit the VPS Host document. Upstream DSH
otherwise selects memory-only settings whenever the browser hostname is not
loopback, leaving the native Models page unavailable. Only the settings mirror's
persistence selection changes; connection loopback classification, Tailscale
identity checks, native DSH authentication and RPC authorization remain intact.
The adapter bypasses asset validators, requests uncompressed JavaScript, updates
its length and disables caching. An unexpected settings client returns 502 so a
DSH upgrade requires revalidation. Set `hostSettings: false` to remove this
adaptation; no upstream package files are modified.
