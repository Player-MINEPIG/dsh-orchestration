# Native claim recovery 0.2.46

The gateway now retries an uncertain claim under the **same command ID** only when its ledger explicitly provides atomic claim recovery. Native `TaskLedger` commits the Attempt and exact command receipt in one SQLite transaction. A committed receipt restores its original Attempt/lease; a rolled-back native `TaskError` produces a bounded, visible `pending + claimRejected` receipt. BUSY remains retryable. Unknown adapters and unknown external execution outcomes retain uncertainty. Expired recovered leases cannot start a provider.

Build passed. Seven new tests cover pre-commit rollback (exact command trigger and asserted injected error), post-commit lost response plus gateway restart, concurrent same-ID retry, known BUSY then capacity recovery, generic adapter uncertainty, expired lease, and client diagnostics. The 34 existing remote/client-ordering tests passed. Independent review passed after fixing original-endpoint visibility for queue-matched claims.

```sh
npm run build --workspace=@dsh-task/task-system
node --test packages/task-system/test/remote/claim-recovery.test.mjs
node --test packages/task-system/test/remote/remote.test.mjs packages/task-system/test/remote/client-ordering.test.mjs
```

MBP then AWS received the same 0.2.46 archive (325 files), with task-directory atomic replacement and only the task archive reference changed in the latest profile. Both restarted healthy. Configuration, credentials and model defaults were retained. AWS DMC 0.1.8's 47 package files remained identical; MBP had no DMC installation. No DMC code, configuration or package was changed.

## Exact target outcomes

- AWS Run `74cf25c0-4fa3-4d0c-8ac9-af1a83e3c70e` recovered its original claim `claim-ee64c2f93c94a3dc4fe7c789955f48a3f2f7593e40656d7333e5db458780bf94`. It produced exactly one Attempt, `676d3169-68a4-4d64-b93a-6188aa031ab0`, and real MBP session `task-de37a0b7-d681-4c1a-8649-e575310ca147`. The executor returned a `blocked` result because its existing tool scope could not read the PR/repository. Central result report and MBP acknowledgement are durable; the original session return event completed. The route/model were unchanged. The model attempted non-claim dispatch/query calls which reported uncertainty, but no child Task/Run was created. Those separate operations were not repaired.
- Original authority `100.123.230.75:18441` still has Run `7ba34673-e5c3-4edb-8d85-2c6de4581987`, already cancelled on 2026-10-12; Task `daily-agent-dsh-codex` is archived. Original-authority authenticated `getRun` confirms the cancellation and absent current Attempt. The old claim remains `uncertain`; it was neither fabricated as done nor used to resurrect the cancelled task. The local panel retains its original endpoint and explains that the current connection cannot recover that authority record. There is no safe separate close API, so no new close protocol or third-host upgrade was introduced.

An initial historical investigation used incorrectly prefixed Run IDs. Its missing-Run conclusion was withdrawn; the persisted evidence below uses the actual pure UUID from the outbound payload.

See [release.json](release.json) for exact IDs, receipt/return states, archive hash and rollback directories, and [old-authority-authenticated-read.json](old-authority-authenticated-read.json) for the corrected read-only RPC. Raw local evidence and probe scripts remain under `/private/tmp/dsh-claim-recovery-evidence`; production databases were not exported. The earlier WIP remains in stash commit `2b6330cecdba7eab3a1aab82f081686e2df85f3e`.
