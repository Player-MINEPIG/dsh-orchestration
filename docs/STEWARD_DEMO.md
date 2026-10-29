# Run the isolated steward demo

This branch adds one canonical chat in the existing task plugin. Personal chat and each project PM keep separate native DSH sessions. The demo uses the real Loader, AgentLoop, session persistence, tools and SQLite task authority on one machine. Its model responses and routing classifications are offline scripts. They prove transport and state behavior, not live model understanding or business task quality.

Use Node 24 and the branch worktree. Install the locked dependencies and build:

```sh
npm ci --ignore-scripts
npm run build
npm run build:fixtures
node tests/dsh/steward-demo.mjs
```

Open the loopback URL printed by the process. Its random access token belongs only to this local fixture. The process creates isolated state in `.runtime/steward-demo`; `DSH_STEWARD_DEMO_ROOT` selects another absolute directory, and `DSH_STEWARD_DEMO_PORT` selects a port. No production credentials or personal DSH profile are loaded.

The page serves the same `StewardPanel` embedded in the plugin settings client. In the installed host it uses the `taskPluginSettings` RPC surface. This standalone fixture calls that surface's underlying real task service through a local HTTP adapter; it does not demonstrate the full official host shell, real provider credentials or remote machines.

1. Send a personal message using **闲聊**, then choose A 项目 and B 项目 and send distinct markers.
2. Return to 闲聊. Reply to an older A message; its source scope determines the destination.
3. Reload. The server restores the canonical history from SQLite and the panel restores any uncertain original request from local storage.
4. Select **自动判断**. Leading `A 项目：` or `@B 项目` addresses route directly. Other text uses a bounded auxiliary classifier request containing only current text, authorized project names/IDs and previous scope. The offline demo recognizes `闲聊`, `散心`, `聊点别的` and a single exact project title; ambiguous text asks you to choose. A configured live provider's semantic accuracy remains unverified.
5. Click **本机任务链验证**. The real project PM calls `task_dispatch`, the host admits a Run, the same local node claims it, and a native worker calls `task_submit_result`. The report explicitly identifies its content as an offline fixture. Project notifications retain their task origin and do not select that project in the UI.

The evidence link returns actual captured provider requests and ledger tasks. `.runtime/steward-demo/demo.json` records the current entry URL; `local-execution.json` records the last local task result. Stop with Ctrl-C and run the same command to reuse the isolated state. Restart does not automatically replay an accepted canonical message.

The local verification receipt is `.runtime/steward-validation.json`; it records the source commit, exact logs and synthetic execution receipt. Browser captures from this run are `/private/tmp/steward-ui-conversation.jpg` and `/private/tmp/steward-ui-clarification.jpg`. These runtime artifacts are intentionally outside Git.

## Verify the source change

```sh
node --test packages/task-system/test/steward-conversations.test.mjs packages/task-system/test/steward-routing.test.mjs tests/dsh/steward-conversation.test.mjs
npm run test:core
TZ=UTC npm run test:ui
npm run test:native
npm run test:official
```

These are local checks. They do not establish Linux CI, a release, deployment, user acceptance or real model quality. The native tests inspect complete captured requests for personal/A/B history isolation, exact replay, restart, session rotation, old replies and runtime-context injection. The task-chain test runs a local coordinator and native executor with real tool admission and reports.

## Current boundaries

- Replying inherits the original scope. A conflicting explicit destination is rejected. Explicit cross-project quotation/sharing is not implemented; no project history is automatically copied into another project.
- Durable phase acceptance such as “修完等我验收再拆分” is not implemented by this increment. Existing task approval/review and native turn state are separate concepts; prompt text alone does not enforce that phase gate.
- The stable persona section supplies a consistent identity/version and current scope. This fixture does not validate long-term personality quality or semantic memory recall.
- Message state **本轮已回复** means the native turn completed, not that a dispatched task succeeded or the user accepted its result. Task notifications carry their ledger event and task provenance separately.
- A context manifest records selected persona/resources and native scope. It does not by itself prove what a remote provider received. Actual request capture in this fixture is separate evidence.
- Automatic routing cannot grant project access. The host revalidates the selected project. Oversized metadata, malformed classifier output and unavailable targets require explicit selection instead of a PM send.
- Remote PM relocation needs an owner-side context/persona adapter. Optional memory-manager/request-assembler support must be established by the separate compatibility fixture; source presence alone is not integration evidence.
- The canonical log currently returns its complete history. Long-log pagination and bounded frontend rendering remain outstanding.

No production deployment, `dev` merge or pull request is part of this demo.

## Optional memory integration evidence

The interactive demo uses the official native persona section. A separate actual native fixture exercises Memory Manager **1.0.0** at `d8fe9cfea344f972d34fd9a7e8eb2fd28acf8831` and Request Assembler **1.1.3** at `374ab6107e4c98ce99fc69eeefcf3714314a73b7`. The legacy sibling Manager checkout at 0.1 lacks this integration API.

`tests/dsh/steward-memory-native.test.mjs` loads those exact optional sources from `.runtime/steward-plugins/{manager,assembler}` into an isolated official native host. The fixture configures Manager entries for `dsh-steward` and `steward.project.<actualProjectId>` through adapter `dsh-task.steward`, with `before_model_request` retrieval using `memory.read_content` and `memory.to_text`. Each source checks the actual native session binding; a global whitelist does not grant cross-project content access. The Assembler preset explicitly orders native system, selected Manager resources, history and current input, and is applied to each actual native session.

After configuring both plugins, a trusted Host calls `ctx.taskSystem.steward.memory.delegateToManager()`. Merely installing the plugins or registering a resource does not transfer context ownership. This increment has no end-user opt-in/settings control. Delegation persists across restart; optional unload or invalid rules cannot silently restore a second persona injector. New native generations still need their own Assembler preset. Do not overwrite a user's existing preset to enable this fixture.

Run the optional fixture only after obtaining the pinned sources and their declared dependencies. Without them the test reports an explicit skip. Its captured full native requests distinguish configured resource inclusion, rule exclusion and missing preset behavior; it does not establish long-term semantic memory recall.
