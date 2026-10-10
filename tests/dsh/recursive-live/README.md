# Real VPS → MBP → official Codex test

These scripts use real DSH AgentLoop (`deepseek-official/deepseek-flash/low`) and the official `ctx.subagents` Codex provider (`gpt-6-luna/low`). They never mount ScriptedModel. Execution verification is separate from human/director acceptance.

## Configuration

Run from the repository root with Node >=24 on MBP (tested Node 26.5.1). Install the pinned root lockfile and build first. The small coordinator also ran on VPS Node 22.23.1 with experimental SQLite; that is observed compatibility, not the supported package engine.

- `DSH_RECURSIVE_RUNTIME`: fresh isolated local runtime; all local test databases, session JSONL and evidence stay there.
- `DSH_RECURSIVE_CODEX_HOME`: absolute isolated Codex profile. Set explicitly for integration runs. `prepare.mjs` creates `<runtime>/codex-home` unless set; worker defaults to `.runtime/recursive/codex-home` only for compatibility with the original test.
- `DSH_RECURSIVE_ENDPOINT`: signed command endpoint through SSH tunnel. Snapshot defaults to `/snapshot` at the same origin. `DSH_RECURSIVE_SNAPSHOT_ENDPOINT` may override it only on that origin; other ports/hosts are rejected.
- `DSH_RECURSIVE_CREDENTIALS`, `DSH_RECURSIVE_YAML_MODULE`: existing DeepSeek credential reference and YAML parser, read only into an in-memory launch snapshot. No credential file is copied.
- `DSH_RECURSIVE_AUTH_REFERENCE`: existing official Codex auth, referenced by symlink only during preparation. The generated outer macOS sandbox denies writes to both target and symlink.
- Coordinator: `DSH_RECURSIVE_RUNTIME` = approved VPS test root, `DSH_RECURSIVE_PORT` = loopback coordinator port. Worker evidence records runtime, workspace, authority/executor, endpoints and profile.
- Dashboard: `DSH_RECURSIVE_SNAPSHOT` = persisted worker snapshot, `DSH_RECURSIVE_DASHBOARD_PORT` = loopback port.

The original successful authority is `/root/dsh-orchestration-tests/recursive-delegation-20261011`, coordinator 43171, local tunnel 43172 and dashboard 43173. Preserve it as evidence. For another run choose a separately authorized fresh VPS directory and distinct ports. Never point these scripts at production databases or default DSH directories.

## Prepare and deploy

Set `DSH_RECURSIVE_RUNTIME`, `DSH_RECURSIVE_CODEX_HOME`, `DSH_RECURSIVE_ENDPOINT` explicitly, then:

```sh
npm ci --ignore-scripts
npm run build
node tests/dsh/recursive-live/prepare.mjs
```

Preparation refuses existing test keys/databases/profile files. It creates Ed25519 test keys, a strict read-only Codex config, auth symlink and a small coordinator bundle. The bundle contains only built code, coordinator, **public** key, workspace declaration and three small dependency declarations; private key and Codex auth never enter it.

Copy the contents of `<runtime>/coordinator-bundle` into the separately approved VPS test root (reuse an isolated runtime's `node_modules` when appropriate, or run `npm install --ignore-scripts` there). From that directory start:

```sh
DSH_RECURSIVE_PORT=43571 node tests/dsh/recursive-live/coordinator.mjs
```

Coordinator defaults its root to the current directory. Use a fresh ledger; seed command IDs are intentionally stable and are not a reset mechanism. Open the matching tunnel, for example:

```sh
ssh -N -L 43672:127.0.0.1:43571 aliyun-vps
```

On MBP, with the explicit environment still set and endpoint `http://127.0.0.1:43672/commands`:

```sh
/usr/bin/sandbox-exec -f "$DSH_RECURSIVE_RUNTIME/readonly-test.sb" /opt/homebrew/bin/node tests/dsh/recursive-live/worker.mjs
DSH_RECURSIVE_SNAPSHOT="$DSH_RECURSIVE_RUNTIME/evidence/vps-snapshot.json" DSH_RECURSIVE_DASHBOARD_PORT=43673 node tests/dsh/recursive-live/dashboard.mjs
```

`prepare.mjs` does not contact the VPS. Copying/deploying requires the intended destination's authorization. The dashboard reads a persisted test snapshot, not a continuous remote subscription.

## Evidence and limits

Expected isolated result: 9 runs, all quiescent; three official successes still `pending_user`; four DSH partial deliveries, one ordinary DSH success, one cancellation; a real `ordinary-analysis.txt`. The worker intentionally loses one result ACK after the authority committed it, remounts its recovery store and verifies recovery without another provider call. Missing conditions fail after evidence is persisted.

`execution.json` contains selected actual wire proof: ephemeral product thread ID, model and effort returned by `thread/start`, and `turn/completed`. It does not capture authentication or full wire payloads. `vps-snapshot.json` contains exact task/run/attempt/fence/execution/session identities. The product thread ID is different from official wrapper subagent ID and the inert DSH carrier session.

Cancellation in the successful real run happened before provider invocation; it demonstrates central cancellation/acknowledgment, not interruption of an active real Codex process. Fixture tests separately verify child disposal before result delivery and cancellation suppressing commitment. Live rejection/rework is not claimed; ledger fixtures preserve earlier reports and parent-run provenance across rework.

Current official backend is one-shot and returns text analysis. `allowedBackends` explicitly grants Codex's native read-only filesystem / network-disabled sandbox; it does not translate DSH's individual `allowedTools` or `fileBoundary`, and the native shell tool remains available inside that sandbox. No live progress, continuation, DSH toolFilter, depthLimit or agentOptions is claimed.

The old five-line profile is insufficient and now rejected. Preparation uses `officialProfileConfig`: `project_root_markers = []`, with `plugins`, `apps`, `remote_plugin`, and `hooks` disabled. The app-server transport checks **the same process** with public `config/read`, thread-scoped `experimentalFeature/list`, and `mcpServerStatus/list` before releasing `thread/start` to the official provider. Exact model/effort, read-only / network-disabled sandbox, all four runtime flags, no active project config layer and a complete empty MCP inventory are required. Unsupported APIs, managed overrides, unexpected MCP servers (even with failed handshakes or no tools), and incomplete inventory fail closed before inference, with official cleanup still awaited. Desktop `CODEX_*` IPC/originator environment entries are removed except explicit deployment entries. Audit logs contain selected identity/permission fields only.

To verify a prepared profile without model inference or tool calls, run `tests/dsh/official-permission-probe.mjs` with explicit `DSH_RECURSIVE_CODEX_HOME`, `DSH_RECURSIVE_WORKSPACE`, and optional `DSH_RECURSIVE_PROBE_EVIDENCE` under the same read-only auth protection as the worker. Compatibility was verified on package-local Codex `0.162.0-alpha.17.2`; hosts with incompatible metadata APIs are rejected. The earlier execution evidence did not prove MCP isolation.
