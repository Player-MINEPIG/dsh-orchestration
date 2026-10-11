# Original plugin-panel acceptance host

`host.mjs` starts a fresh official DSH profile with the real base/web bundles and this task plugin. It preserves the original sidebar entry, `settings-client.js` iframe, authenticated Remote RPC, and `project-page.html`. It does not serve a replacement dashboard or a mock parent bridge.

Run with the same Node version supported by the application:

```sh
node tests/dsh/runtime-live/host.mjs /absolute/test-state/ui-host.json
```

The config JSON requires:

- `runtimeRoot`: existing official rc.2 installation containing `package.json` and `node_modules`, used read-only.
- `testRoot`: dedicated test directory containing all host/database state.
- `stateDir`: fresh isolated directory below `testRoot`.
- `bindAddress`, `allowedAddresses`: exact Tailscale IPv4 addresses; no wildcard/public bind.
- `port`, `innerPort`: distinct unused ports. Browser URL uses `bindAddress:port` directly through Tailscale. The internal port is loopback only; there is no SSH forwarding.
- `taskConfig`: normal task plugin config with explicit test `databasePath`, `nodeId`, planner/executor role, `schedulerEnabled:false`, `autoExecute:false`. The planner may read the same test authority ledger as a separate coordinator process. Do not use this UI host as a second automatic scheduler.
- `remoteConfig` (executor): normal remote plugin config with a dedicated recovery state path, the real coordinator endpoint, and a peer granted `projectSnapshot`. Configure no worker polling/native execution routes when the separate acceptance worker already owns execution. Use the explicit coordinator panel URL setting for the optional full-panel link.
- Optional `taskPackage`: this checkout's built `packages/task-system`, default resolved relative to the launcher.
- Optional `extraPatches`: additional isolated official Loader patches (for example the real registration command plugin). Credentials belong to private test config or environment; keep them out of committed fixtures and screenshots.

The official WebServer supports loopback or wildcard bind. This launcher keeps it on loopback and provides a small exact-address carrier on Tailscale. HTTP and WebSocket traffic retain original Host/Origin/cookies and therefore keep official browser trust and persistent signed-cookie authentication. Requests from other source addresses, a different Host, or forwarded-header claims are denied before forwarding. This carrier adds no task data service and opens no SSH tunnel.

When ready, `stateDir/ready.json` contains the clean browser URL and the path to `browser-login.json`. The latter is mode 0600 and contains the official launch-token URL rewritten to the Tailscale authority; open it privately to establish the real browser session. Never print or include that URL in reports. `host.log` removes printed launch-token values. Test source state and cookies live only in the isolated `stateDir/home`.

Acceptance should use both actual browser surfaces: planner to inspect project registration and recursive Task→Run→Attempt→Session evidence; executor to view central scoped progress, fold small execution steps, inspect completion versus review, and verify stale/disconnected states. Invoke reporting slash commands in the isolated official DSH session. No model call is made merely by starting this launcher; real execution and command acceptance must be documented separately.
