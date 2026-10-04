# DSH Orchestration

Configurable task management mounted inside DeepSeek Harness. A stable task keeps multiple runs, sessions, reports, revisions and artifacts. User-defined templates and schedules use the same ledger and lifecycle. Planner, executor and combined roles compose through explicit permissions and authenticated peer protocols.

This monorepo targets **DeepSeek Harness 0.2.0-rc.2** and **Node 24+**. The TLS fixture test also uses the system OpenSSL executable. All plugins attach to a DSH host; an external supervisor may keep that host alive. The plugins do not install their own OS services or manage platform updates.

## Core plugins and optional adapter

| Package | Independent use inside DSH |
|---|---|
| [Task and Remote Execution Suite](packages/task-system/README.md) | Durable task configuration, history, execution, observation, scheduling and optional authenticated remote peers; useful without decisions or channels |
| [Typed Decisions](packages/typed-decisions/README.md) | Bounded choice/classification/scoring for any consumer; rules, ordinary native DSH models, Jev and compatible typed APIs |
| [Optional Feishu adapter](packages/feishu-channel/README.md) | Separate optional channel SDK and authorized chat/message delivery; replaceable through public consumer/delivery contracts |
| [WebUI](dashboard/README.md) | Portable read-only consumer of the same TaskLedger, with timestamped private snapshot export |

There are two core installation packages: `@dsh-task/typed-decisions` and `@dsh-task/task-system`. Remote coordination ships inside the task suite and is explicitly mounted through its `/remote` export. Feishu is an optional adapter. See the [boundary and upstream reuse assessment](docs/PLUGIN-BOUNDARIES.zh-CN.md) and [0.2 package migration](docs/PACKAGE-MIGRATION.md).

Role profiles, protocol types, task templates and the WebUI are not presented as extra dependency-only runtime plugins. Plugin independence means useful installation and lifecycle within a host, not a separate daemon.

## Build and verify

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm run test:distribution
```

`check` runs core/provider/protocol/WebUI tests and actual DSH Loader/AgentLoop integration. Distribution tests install tarballs into isolated profiles using the pinned official DSH CLI, boot them, remove them and verify retained-state behavior. The tests use disposable credentials and fixtures. Live Feishu/Jev/model calls and production machines are not needed or exercised.

For a runnable offline native example, see [the DSH integration guide](docs/dsh-integration.md) and `tests/dsh/demo-local.mjs`. It uses a deterministic model fixture, visibly labeled as such.

Pack each built plugin directory with `npm pack` and install the tarball using `dsh plugin --profile <profile> add <tarball>`. The native task profile is base-backed and persistent; the shipped headless runner is a different, one-shot composition. Follow package setup for real model adapters, existing credentials, node scopes and optional channels.

The optional trusted-network mode supports an explicit exact-IP snapshot and scoped peer permissions without separate signing keys. It is disabled by default; see the remote plugin configuration and security model.

## One ledger and explicit evidence

Point both `DSH_TASK_DATABASE` and the WebUI `--ledger` setting at the intended database. The private development instance uses `.runtime/tasks.sqlite`, excluded from Git and package artifacts. Static exports carry their observation cutoff and stale status; they do not claim to synchronize all internal agents automatically.

Observed work is captured before admission and never dispatched merely because it was observed. A separately authorized new request can continue an existing objective while retaining its prior evidence. Task results, report validity, partial-review status, finalized artifacts and message delivery remain distinct.

Cancelling a run does not cancel other runs of the same task. Cancellation resources remain held until actual quiescence is acknowledged. Uncertain effects require reconciliation; restart never blindly resends a workload. Similar reports remain separate records, while exact operation replay returns the original receipt.

## Configure and extend

[Example task types](examples/README.md) show daily review, game-daily and a third unrelated workflow using one template/schema contract. Define source adapters, normalization, validation and presentation through reviewed host code; task configuration selects capabilities but does not grant credentials or executable permissions.

[Workspace provisioning](packages/task-system/README.md) creates actual directories under explicit roots. Typed decisions can recommend reuse or creation, but physical provisioning and final execution policy remain deterministic host responsibilities. [Host delegation](examples/host-delegation.AGENTS.md) illustrates optional local specialist/Codex delegation without a dedicated backend or self-maintenance plugin.

## Review material

- [中文评阅入口](docs/RELEASE-REVIEW.zh-CN.md)
- [Current 0.2.0 validation](docs/validation/0.2.0-checks.json)
- [Security boundaries](docs/SECURITY.md)
- [Migration](docs/MIGRATION.md)
- [Requirement correspondence](docs/PARITY.md)
- [Architecture comparison and validation limits](docs/architecture/README.md)
- [DSH runtime integration and verification](docs/dsh-integration.md)
- [Open-source and awesome-list preparation](docs/AWESOME-CHECKLIST.md)

The deliverable is private. Public repository visibility, npm publishing and awesome-list submission are separate actions. Real-browser visual checks, live integrations, remote GitHub CI and OS deployment are reported separately from local code tests; a passing local suite does not imply those checks passed.
