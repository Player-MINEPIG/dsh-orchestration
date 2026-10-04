# 0.2 installation boundary

There are two core tarballs: `@dsh-task/typed-decisions` and
`@dsh-task/task-system`. The optional `@dsh-task/feishu-channel` tarball is
separate. The dashboard remains a private workspace consumer of the same ledger.

| 0.1 entrypoint | 0.2 entrypoint |
|---|---|
| `@dsh-task/task-system/plugin` | unchanged |
| `@dsh-task/remote-execution` | `@dsh-task/task-system/remote` |
| `@dsh-task/remote-execution/api` | `@dsh-task/task-system/remote/api` |
| task-policy helpers from `@dsh-task/typed-decisions/core` | `@dsh-task/task-system/task-policy` |
| Feishu task integration through the concrete task service | public `@dsh-task/task-system/channels` structural port |

For a stopped development host, replace the installed task/decision tarballs
together. Remove the old remote-execution bundle, then mount the suite's
`/remote` export using `packages/task-system/remote.patch.yml`, keeping its
existing `task-remote-execution` entry ID and explicit settings. Set exactly the
same ledger, remote recovery database, node ID, grants, workspace paths,
authentication mode and existing key environment references as before.

Removing an installed bundle does not remove its database. The remote wire
version, recovery schema and Task/Run/Attempt/Report lifecycle did not change;
keep the original databases and do not generate replacement node identities.
The task suite is independently useful without typed decisions. Planning mounts
only when the `typedDecisions` service is present. Feishu and its SDK remain
absent from both core dependency graphs.

`tests/dsh/upgrade-acceptance.mjs` preserves the historical 0.1.0→0.1.1
four-package acceptance runner and requires the preserved 0.1 source checkout
and tarballs. Current install/boot/remove verification uses `npm run
test:distribution`. Its receipts describe the current package boundary.
