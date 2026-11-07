# Current installation boundary

The core installable packages are `dsh-jev-plugin` and `@dsh-task/task-system`. The task suite works without the optional model service. `@dsh-task/feishu-channel` is a separate optional adapter; the dashboard consumes the same ledger.

| Historical entrypoint | Current entrypoint |
|---|---|
| `@dsh-task/task-system/plugin` | unchanged |
| `@dsh-task/remote-execution` | `@dsh-task/task-system/remote` |
| `@dsh-task/remote-execution/api` | `@dsh-task/task-system/remote/api` |
| Task policy helpers | `@dsh-task/task-system/task-policy` |
| Replaced decision service | `dsh-jev-plugin`, through `ctx.decisionModels.ask` |
| Channel integration | `@dsh-task/task-system/channels` |

Follow [ordinary deployment](DEVELOPMENT.md#deploy-to-devices) to install exact verified GitHub packages while preserving the existing ledger, recovery database, node identities, permissions, workspaces and model configuration. Replacing or removing a bundle does not authorize deleting its data. Existing JEV replacements are described in [JEV migration](JEV-MIGRATION.zh-CN.md).

Current package install/boot/remove acceptance is `npm run test:distribution`. Old validation receipts under `docs/validation`, `docs/architecture` and `tests/dsh/results` are historical evidence, not current installation instructions.
