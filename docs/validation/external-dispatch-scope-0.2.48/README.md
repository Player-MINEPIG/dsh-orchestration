# External coordinator project scope, 0.2.48

The new PR23 request in session `dmc-22f2a9a1-ed58-4072-bd5b-f4a4859c1b84` successfully selected dsh-tavern, created parent Task `8f91c26a-eebb-47f3-8056-fb6e7a0277f5` and registered coordination Run `4ee88031-c21b-40c9-a70f-f12f56288f70`. At 2026-10-22 16:49:11Z, the formal MBP dispatch failed with `Decision belongs to another project`.

`ledger-proof.json` shows the decision and both external bindings agree on the project. The final guard only read the built-in `pr_sessions` table, which correctly has no entry for this externally owned session. No child Task, child Run, Attempt or apply receipt was created. This request never reached MBP execution. The parent later submitted a blocked result. Separately, the existing DMC stage rejected `dmc_submit_result` with `此阶段已有持久结果`; that business lifecycle error is not changed here.

The patch uses the ledger's existing trusted caller project resolution in the final guard, while retaining managed project/temporary-conversation current-turn checks. Explicit `task_plan` now captures the same host caller origin as `task_dispatch`. External sessions keep the ordinary immediate dispatch path and do not enter the built-in managed project queue. Cross-project, unbound and foreign attachment checks remain enforced.

The initial build dependency link lacked several development packages. It was replaced with the existing verified development dependency tree before the final complete build and package. No dependency installation or production dependency recalculation occurred.

Verification: `npm run build -w @dsh-task/task-system` passed. `node --test tests/dsh/external-dispatch-scope.test.mjs` passed 3/3 against real DSH tools and isolated databases. Inline dispatch and plan-then-dispatch both create one child with the correct project, parent Task and parent Run. A built-in project turn accepts its current request ID and rejects incorrect or completed-turn authorization. The model in this fixture is scripted; no external model or production workload runs.

The same new cases against installed 0.2.47 artifacts reproduce inline `Decision belongs to another project` and explicit-plan `Catalog changed`; its built-in turn case passes. An exploratory run of the older project-runtime/planning-scope suites encountered existing fixture/expectation failures and was stopped. Two selected failures also reproduce against 0.2.47 (`baseline-related.log`); the older suites are not reported as passing.

Production validation is package/health and read-only state only. The blocked parent Run is not reopened, no task is redispatched, and DMC files/configuration/business records are not manually changed. The old canceled task `6b47d5be-0825-4919-b5d0-c6fbd83bcd21` is separate. A new authorized business round should create a fresh parent; this deployment does not claim PR review completion.

The main checkout was clean at baseline `12237e3`. Existing WIP remains preserved at stash commit `2b6330cecdba7eab3a1aab82f081686e2df85f3e`. Raw private session evidence remains outside Git under `/private/tmp/dsh-new-task-check-20261023`; only bounded selected evidence is included here.

Both AWS and MBP run 0.2.48 from the same 325-file archive. `release.json` records package verification, healthy activation, unchanged DMC and configuration, backups and the read-only target state. The parent remains blocked with no child or Attempt. No production business retry was performed.
