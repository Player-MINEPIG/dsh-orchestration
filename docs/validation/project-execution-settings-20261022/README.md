# Project execution settings — 2026-10-22

Baseline: main/origin/main `3315b77`; installed task plugin 0.2.43 on AWS and MBP. New package: 0.2.44. Development branch: `codex/project-execution-settings`; managed worktree: `/Users/pmp/.codex/worktrees/project-execution-settings/dsh-orchestration`. Main had no new WIP. Earlier user WIP remains stash commit `2b6330cecdba7eab3a1aab82f081686e2df85f3e`.

The project detail settings edit the managed coordinator workspace, allowed executors and each executor's workspace. `null` adds no project node restriction; `[]` prevents new execution. The coordinator workspace remains in its existing authoritative record. Changing it uses the existing safe session handoff to a new generation with a real immutable cwd; active turns/dispatcher bindings reject relocation. Old session headers and workspace groups stay at their original directory. Files and external plugin sessions are not moved.

Executor directories are explicitly granted on their owning device from its official local registry. The scheduler receives only bounded authorized metadata over authenticated heartbeats. Static peer workspace allowlists still apply. IDs bind the physical path; revocation and re-enrollment preserve old identities and invalidate their queued requests. The project does not grant arbitrary remote paths. Per-node policy applies in planning, dispatch and claim for managed project coordinators, ordinary bound dispatcher sessions and executor descendants. New Runs pin settings/directory constraints; changed or revoked unclaimed requests need attention without silently changing their route or creating another Run/Attempt. Existing leased/running work keeps its admitted context.

## Verification

- Task-system build passed.
- `targeted-tests.log`: **44/44 passed**: native runtime coordinator handoff/history/WB projection/legacy binding/BUSY/CAS; actual Typert browser Remote → host Gateway read/save and zero-argument grant catalog; project policy; grant/CAS/revocation; selected/recursive cwd; heartbeat boundaries.
- Real trusted HTTP transport with managed peer pairing → workspace announcement → project setting → coordinator child claim → native DSH execution passed. The native execution session header.cwd equals the owner-authorized repository. The true recursive executor child retains `.dsh/delegated` isolation. Only the fixture model is scripted; no production workload was created.
- Chrome exercised the real isolated runtime page, saved coordinator generation 1→2, restricted nodes to MBP, selected the MBP grant, and reloaded the saved settings. Screenshots show the readback, explicit empty allowlist and saved next generation.
- Independent bounded review found two UI issues (old system-settings action collision and legacy execution directory shown as coordinator directory); both were fixed before final checks.
- Known baseline: the old native-provider mocked heartbeat fixture fails `PROVIDER_ROUTE_DENIED` with the original `3315b77` remote/index implementation too (`known-baseline-health.log`). Its model-inventory logic was not changed; the final relevant run excluded that named fixture. Policy worker also reproduced 2 existing ledger delegation and 5 existing planning catalog failures on the baseline; no unrelated model/catalog changes were made.

Run the relevant checks:

```sh
npm run build -w @dsh-task/task-system
DSH_OFFICIAL_ROOT=/path/to/installed/@deepseek-ai/dsh node --test --test-skip-pattern='actual Cordis opt-in heartbeat' tests/settings/project-execution-settings.test.mjs tests/settings/task-panel-rpc.test.mjs tests/dsh/project-settings-execution.test.mjs packages/task-system/test/project-execution-settings.test.mjs packages/task-system/test/remote/workspace-grants.test.mjs packages/task-system/test/remote/project-workspace.test.mjs packages/task-system/test/remote/health.test.mjs
```

## Scope

DMC code, configuration, package and business state are outside this change. No PTC-index or claim-uncertain repair and no default model changes. Production acceptance is read-only: do not change the formal project's settings, grant its real repositories, or create/re-dispatch tasks. Deployment receipt will record task-only atomic replacement, preserved current profile references for other plugins, DMC file checks and HTTP/RPC health.

## Deployment and read-only acceptance

Source release commit: `a13cc57c48b97e2edfda67c5b60576fbc9df6411`. Archive SHA256: `7c084b4116d47e4314698828221b43bffe0218a8250d9458e7934f6bcba5e5b5` (325 files). Both hosts installed exactly this archive. AWS gateway was activated first, followed by MBP; HTTP health passed on both. Only the task package directory and its current profile archive reference were replaced, without recalculating dependencies. The source tree after this release differs only by delivery documentation; no second package installation is needed.

The actual AWS project settings page loaded through the new RPC. The formal dsh-tavern project remains settings revision 0 / coordinator generation 1 / its original cwd. It shows the executor's genuine configured `prod-mbp` directory as selectable. No production project setting was saved. The MBP owner settings page loaded its official registry: seven native directories are explicitly ungranted, and the one configuration-owned task workspace remains authorized. No directory was registered/granted on the user's behalf.

Both installations match all 325 archive file hashes. Current DMC 0.1.7 on AWS has the same 47 file/link hashes before and after; MBP has no DMC package. Original configuration/credential hashes, model-default policies and directory settings are unchanged. MBP task business rows are unchanged. AWS task business identity counts are unchanged, but one existing Run.updatedAt changed during restart/background maintenance; the minimal changed-path evidence is recorded in `release-receipt.json`. No new Task/Run/Attempt/Report was created by acceptance. Do not describe the entire AWS business database as byte-unchanged.

The per-host backups are `~/.dsh/releases/project-execution-settings-0.2.44/backup`. Rollback must restore only the task directory and task profile reference; unrelated live profile declarations and DMC must not be replaced. Raw production screenshots and the isolated browser receipt are local supplementary evidence under `/private/tmp/dsh-project-execution-settings`; private native-registry names are not copied into this repository.
