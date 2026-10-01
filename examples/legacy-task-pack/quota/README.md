# Optional provider quota snapshots

New MIT code implements the original observable contracts. This module is off by
default, uses no model, creates no daemon or external automation, and is separate
from the TaskSystem task ledger. Collector helpers do not discover environment
variables, credential files, current accounts, browser sessions, or machine
identities. The separately enabled native plugin can read only the existing
environment-variable names explicitly configured by the operator.

## Supported contracts

- DeepSeek: fixed `GET https://api.deepseek.com/user/balance`, explicit bearer key,
  exact decimal `balance.total`, `balance.granted`, and `balance.topped_up`, per
  supplied currency. Numeric JSON money is rejected instead of rounding it.
- Alibaba: fixed BSS `QueryAccountBalance`, version `2017-12-14`, RPC HMAC-SHA1
  signature, explicit transient credentials, and exact decimal `account.available`,
  `account.cash`, and `account.credit`. Explicitly enabled ECS IMDSv2 can obtain a
  token and a single validated RAM role at `http://100.100.100.200/latest/`.
- Every completed read is recorded in private SQLite and a date-partitioned JSON
  snapshot. Only supported metrics and sanitized status fields persist. Raw bodies,
  request URLs, auth headers, role names, and credentials never persist.
- Calendar midnight defaults to `Asia/Shanghai`, but accepts a configured IANA zone
  including DST transitions. The host owns time and lifecycle. The default startup
  catch-up window is 20 minutes; missed older boundaries are not fabricated.
- Successful providers are read once per boundary, including after restarts. Known
  transient failures have at most three attempts, with 30 seconds after the first
  failed read completes and another 60 seconds after the next completes. Provider
  success requires **all configured providers**; success produces empty output.
  Exhaustion produces sanitized `quota_collection_failure.v1`, once per persisted
  failure through `onFailure`. No message is sent by this module.
- A recorded pending read after a host crash remains pending/unknown and is surfaced
  as a failure. It is never silently replayed. Auth, invalid configuration, response
  format errors, and cancellation do not retry. Transport/timeouts and HTTP 408,
  429, and 5xx retry within the explicit finite budget.
- Summaries use existing exact-decimal boundary arithmetic: nearest samples within
  the configured tolerance, `exact` within two minutes at both boundaries, missing
  boundaries unavailable, and `end - start` net movement. They never infer task cost
  or gross spend. The wrapper includes all supported metrics/currencies rather than
  only the original primary CNY/USD metrics.

`quota_snapshot.v1` JSON keeps original metric names and adds `boundary_at`,
`completed_at`, and `attempt`. It deliberately omits raw provider `payload` to keep
untrusted provider fields and secrets out of records. The metric store uses its own
`quota_collections` / `quota_metrics` tables and is not a byte-compatible copy of the
old database. Existing legacy SQLite files remain export-reader inputs, not a
database to migrate in place.

## Host integration

Import from the public `@dsh-task/task-system/task-pack/quota` package subpath,
or this directory's `index.mjs` in a source checkout.
The installable native plugin is
`@dsh-task/task-system/task-pack/quota/plugin`; it imports the existing
`@deepseek-ai/cordis` and `@deepseek-ai/schemastery` peer packages. Mounting it does
not require custom host code. Its `Config`/`apply` exports integrate with the native
loader and inject the already configured `taskSystem` service.

An inert DSH patch can install the optional module without opening storage,
reading credential variables, starting a timer, or accessing any provider:

```yaml
- insert:
    - id: provider-quota-monitor
      name: '@dsh-task/task-system/task-pack/quota/plugin'
      config:
        enabled: false
```

For an explicitly authorized live host, configure an existing private directory
and existing credential-variable **names**, never credential values:

```yaml
- insert:
    - id: provider-quota-monitor
      name: '@dsh-task/task-system/task-pack/quota/plugin'
      config:
        enabled: true
        storePath: /var/lib/example-host/quota
        timezone: Asia/Shanghai
        providers: [deepseek, aliyun]
        deepseekApiKeyEnv: EXISTING_DEEPSEEK_KEY_NAME
        alibabaAccessKeyIdEnv: EXISTING_ALIBABA_ID_NAME
        alibabaAccessKeySecretEnv: EXISTING_ALIBABA_SECRET_NAME
        alibabaSecurityTokenEnv: EXISTING_ALIBABA_TOKEN_NAME
        ecsMetadata: false
```

`storePath` is an absolute dedicated directory containing
`quota_snapshots.sqlite` and the JSON archive. Omit `alibabaSecurityTokenEnv` for
explicit long-lived access-key credentials without a session token. For explicitly
approved ECS-role use, set `ecsMetadata: true` and omit every Alibaba credential
variable field. Mixed metadata/key modes are rejected instead of falling back.
The module never creates or saves credentials. It reads the named variables only
when that provider is due, and never logs their values or includes them in metrics,
alerts, diagnostics, or model-visible configuration.

Native `planner` and `both` roles raise failure-only durable TaskSystem alerts with
`quota:<provider>:<UTC boundary>` dedupe keys. A verified successful snapshot can
resolve an existing alert for that exact provider/boundary. Successful collection
does not create an alert. The module never calls model or messaging APIs. TaskSystem
may route its alert records through separately authorized, preconfigured delivery
destinations. An `executor` host must explicitly set `localOnly: true`; otherwise
enabled mounting is rejected before storage or credential access. Local-only
monitoring keeps metric snapshots and sanitized local failure state without
creating or resolving authority alerts. Later explicit planner mounting can report
an existing failed boundary.

The read-only host service `ctx.quotaMonitor` exposes `enabled`, `localOnly`,
`lastFailure`, `lastError`, and `tick()`. No model tool is registered. Its lifecycle
effect cancels timers and aborts/drains reads before closing metric storage, while
`taskSystem.addDrain` ensures this occurs before the authority ledger closes.

For custom host integrations, the same lower-level API remains available.
The operator chooses a dedicated absolute private directory outside the plugin
tree, providers, timezone, and an explicit in-memory credential callback:

```js
import { openQuotaStore, createQuotaProviders, mountQuotaMonitor } from './quota/index.mjs';

// Run only inside an explicitly enabled host lifecycle effect.
ctx.effect(() => {
  const store = openQuotaStore({ directory: host.config.quotaDirectory,
    timezone: host.config.quotaTimezone });
  const providers = createQuotaProviders({ enabled: true,
    providers: host.config.quotaProviders,
    credentials: provider => host.explicitQuotaCredentials(provider),
    ecsMetadata: false });
  const monitor = mountQuotaMonitor({ enabled: true, store, providers,
    timezone: host.config.quotaTimezone,
    onFailure: event => host.recordLocalDiagnostic(event) });
  return async () => { await monitor.dispose(); store.close(); };
});
```

The host can invoke `createQuotaMonitor(...).tick()` through its existing scheduler
instead of mounting a timer. No model tool or task settlement is registered.
Do not log values passed to the credential callback or injected transport.
`createQuotaProviders` requires explicit provider selection and credentials; it
does not silently use ECS metadata. Enable `ecsMetadata` only as explicit host
setup, then return `undefined` for the Alibaba credential callback to select it.
Metadata uses fixed direct requests with no proxies or redirects. The module never
changes firewall, VPN, network, or access policy settings.

For an agent's existing configured-source registry, use the separate read-only API:

```js
const summary = await readQuotaSnapshots({ scope, databasePath: 'quota_snapshots.sqlite',
  window: { start: task.windowStart, end: task.windowEnd }, format: 'native' });
```

`scope` is the existing `createSourceScope(operatorExportRoot)` object, and the path
comes from the operator's manifest. This API uses a bounded private SQLite copy
with `query_only`, does not modify or create the source DB, and reads only successful
metrics. Choose `format: 'hermes'` explicitly for original `collections`/`metrics`
exports. Its `quota_summary.v1` result includes `quota_changes`, `data_quality`, and
file evidence. A missing database reports unavailable; invalid formats, path escapes,
incompatible schemas, and row limits fail closed. Supply stable DB/WAL exports,
consistent with the existing source reader contract. `openQuotaStore` is a writer
API and must not be used to read historical source exports.

Read timeouts default to 12 seconds (maximum 60), response bytes to 256 KiB (maximum
1 MiB), and each whole provider attempt to 60 seconds. Concurrency is one tick at a
time, including overlapping host invocations. Disposal aborts the current attempt
and removes future timers. Retry count, delay, catch-up window, and polling interval
are bounded configuration. SQLite and snapshots are mode 0600 in 0700 directories;
pre-existing insecure or symlinked destinations are rejected without chmod repair.
Per-call summary extraction defaults to a maximum of 20,000 metric rows and fails
closed if exceeded; the host owns archival/retention and can raise it to 100,000.

## Offline validation and real setup boundary

```sh
node examples/legacy-task-pack/quota/demo.mjs
node --test tests/legacy/quota.test.mjs
```

The demo and every test inject synthetic HTTP responses and, for native plugin
tests, synthetic environment lookup callbacks. No real account requests,
credentials, metadata, firewall changes, messages, or external schedules were used
to validate this implementation. Live deployment still needs host mounting,
credential provisioning/permissions, native plugin enablement, network reachability, and operator-selected
storage/retention. That setup is intentionally not performed by this task pack.

## Source contract provenance

Original repository: `hermes-plugins`, commit
`1dfacb5e5949d9f248b1feacbc36644fb351f19e`. Source files were read to identify
formats/behavior; no original implementation was copied or vendored.

| Source | SHA-256 | Contracts |
|---|---|---|
| `plugins/hermes_monitor/hermes_monitor_plugin/quota_monitor.py` | `d42b157552f562b9609ffe66272569ed3606875ccad466adbb8eeea691a60435` | Provider endpoints/signature, metric names, persistence, boundary semantics; FR-Q01–Q04 |
| `plugins/hermes_monitor/scripts/collect_provider_quotas.py` | `03423f6d2fd0e207fb46b6150d97c09c7a758808aabd8018e2adf474bc7ac61d` | No-model collector, failure delays, all-provider success and silence; FR-Q07 |

The fixed endpoints above are verified against that exact source pin. No claim of
live endpoint/account compatibility is made beyond the synthetic wire-contract
tests. The original README's midnight no-agent behavior is implemented by the host
lifecycle instead of installing its Hermes cron or systemd firewall unit.
