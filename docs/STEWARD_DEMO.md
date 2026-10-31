# Run the isolated steward demo

The existing task plugin now provides one canonical chat backed by separate personal and per-project native DSH sessions. A single window routes each turn without a compulsory steward model hop. It uses the real Loader, AgentLoop, session persistence, SQLite task authority and local native executor. The default demo uses explicitly labeled offline model responses; a separate live mode can reuse an existing supported provider configuration in process memory.

## Start a local demo

Use Node 24 in this branch worktree:

```sh
npm ci --ignore-scripts
npm run build
npm run build:fixtures
node tests/dsh/steward-demo.mjs
```

Open the loopback URL printed by the process. Its random token belongs only to the isolated fixture. The default state directory is `.runtime/steward-demo`; `DSH_STEWARD_DEMO_ROOT` selects another absolute directory and `DSH_STEWARD_DEMO_PORT` selects a port. Stop with Ctrl-C and run the same command to retain the isolated history. Restart never automatically resends an accepted canonical command.

The page serves the production `StewardPanel`. Installed hosts use authenticated `taskPluginSettings` RPC. The standalone demo calls the same task service through a loopback HTTP adapter, so it does not establish the full official WebHost shell or remote-machine support. Its **本机任务链验证** action exercises real PM `task_dispatch` → ledger admission → local claim → native worker `task_submit_result`; its business content is an offline script.

To mount optional memory controls, obtain the exact public plugin source revisions below under `.runtime/steward-plugins/{manager,assembler}`, with their declared dependencies available, then run:

```sh
DSH_STEWARD_DEMO_MEMORY=1 DSH_STEWARD_DEMO_ROOT="$PWD/.runtime/steward-demo-memory" DSH_STEWARD_DEMO_PORT=56005 node tests/dsh/steward-demo.mjs
```

Mounting does not authorize delegation. In **当前对话的记忆与人格来源**, read the current scope, select a preset, and explicitly enable it. Creating missing default resource rules and inheriting a selection across generations require separate checkboxes. Existing deny rules, conditions, disabled selections and user presets are preserved. An uncertain partial configuration keeps its original command for retry; explicitly restoring native persona ownership does not erase already saved rules or presets. Unavailable optional services do not silently switch ownership.

## Try the conversation

1. Chat personally, send separate A and B markers, and return to personal chat. **自动判断** uses an explicit address or a bounded classifier over current text, authorized project names and previous scope. Ambiguity asks for selection; classification grants no access.
2. Reply to an old A message. It returns to A's current authorized generation. A conflicting explicit target is rejected.
3. Choose **引用到…**, retain one contiguous original excerpt, and explicitly select B. The host validates source access, message revision and exact text, and records an immutable sharing receipt. Only that excerpt crosses scopes; ordinary replies do not share history.
4. Reload or browse older messages. The server pages at most 100 rows, the panel retains at most 300, and parent previews/state refresh/old unresolved attention are separately bounded. A stale quote rejected before admission leaves an editable draft. A lost acknowledgement retains the exact original request until reconciliation or explicit retry; it never automatically resends.
5. Run the local task-chain action and inspect its report. Set a phase gate for an existing workstream and declared repair tasks. A background A notification can open its exact candidate while the next chat target remains B. **通过验收，继续等待** records acceptance only; **验收并继续此请求** also submits the reviewed continuation with a stable receipt. Ordinary chat cannot impersonate a human decision. Repair revisions invalidate the prior candidate; historical admitted effects are disclosed, not canceled. Explicit independent work has its own trusted action.
6. Ask an actual scoped agent to use `steward_recall` for earlier history or project/task/report/decision/gate records. History cards include a versioned `lookup` for the complete message and `replyToLookup` for an accessible parent in the same scope. Pass the pointer fields except `tool` to the named tool, then follow `next`. Results are historical data, not new authorization. Task workers cannot borrow current or historical steward/PM native sessions, and executor tool views and recall/resource binding independently reject owned task execution.
7. In the offline demo, click **长消息续读验证**. It seeds a personal message containing Chinese text, emoji, NUL and a unique tail, then runs an actual native tool chain from search to full-message pages. The receipt at `recall-evidence.json` records page offsets, versions and exact reconstruction. The business response is scripted; this does not measure a real model's retrieval judgment or long-term memory.

Message-page `offset`, `nextOffset` and `totalBytes` count UTF-8 bytes. Each page contains at most 2000 body bytes and ends at a complete character. Use the returned `next` rather than counting JavaScript string characters. A stale version returns `CONFLICT`; refresh the history card. Unknown IDs, inaccessible scopes and offsets inside a UTF-8 character or outside the body are rejected. Quote fields contain only the complete, already authorized excerpt, at most 2000 JavaScript characters; they provide no source-message read pointer.

Canonical message bodies are immutable through supported APIs. State changes and human resolution atomically increment the persisted message revision, which locks reads without hashing or loading complete bodies during history search. Search still scans at most 100 rows and matches only bounded previews, at most 1600 Unicode code points. SQLite text previews can stop early at NUL; `truncated` still reflects the complete byte length and `lookup` reads the full body. This is bounded keyword browsing, not full-text or semantic search.

This iteration adopts the small-card/read-pointer pattern from the [official research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). It adds no dependency on that repository and does not implement its Ticket, Subscription or outbox system. Project authority record pages retain their existing canonical-JSON character offsets; message byte cursors do not apply to them.

Phase gates protect formal plans, task creation, workflows and confirmed local managed-PM continuations. They do not prove that an unrestricted external agent cannot plan in free text or mutate arbitrary external systems. Remote owner adapters are not implemented for the new memory/gate configuration path. New gate setup currently uses explicit IDs rather than an automatic natural-language phase parser.

## Live provider mode

```sh
DSH_STEWARD_DEMO_MODE=live DSH_STEWARD_DEMO_ROOT="$PWD/.runtime/steward-demo-live" DSH_STEWARD_DEMO_PORT=56015 node tests/dsh/steward-demo.mjs
```

The current supported bridge reads existing Web profile/Magpie settings without invoking production `SettingsStore.read` or plugin `apply`. Credentials stay in process memory; cache/status live only under the isolated root. It neither changes the global running model nor mounts production task state. If configuration or adapter support is missing, the page reports the actual reason. Live prompts incur provider usage; the demo limits output to 512 tokens and 120 model requests per process. The deterministic task-chain button is disabled in live mode.

Live mode mounts the pinned optional plugins without delegation and official `token-meter`/`compaction-basic` from the isolated official 0.2.1-rc.2 runtime with automatic compaction enabled. A separate actual-native test forces a 4096-token-window surface replacement and verifies unique persona plus scoped recall of an early value no longer in the native surface. This is a tested lifecycle path, not a claim of unlimited context or perfect recall.

The bounded configured-provider smoke used Magpie 0.4.1 with `aws-vps-magpie` / `claude/claude-opus-5-5` / medium. Its successful second run made 10 requests (2 classifications, 8 native steps) across personal/A/B/personal/old-A reply/actual scoped recall. Each native request contained one persona and no foreign-scope markers. An earlier one-request failure remains recorded with an unclassified cause: total 11 requests, not an all-run zero-error claim. This short synthetic sample does not establish long-term personality, semantic retrieval accuracy or business-task quality.

## Evidence and verification

`demo.json` in each isolated root records its current URL. The evidence link exposes offline captured requests or safe live hashes/stats, current request observations and ledger tasks. `local-execution.json` records the last deterministic task chain. The final local receipt is `.runtime/steward-validation.json`; evidence artifacts and tokens are intentionally outside Git.

Pinned optional sources:

- Memory Manager 1.0.0: `d8fe9cfea344f972d34fd9a7e8eb2fd28acf8831`.
- Request Assembler 1.1.3: `374ab6107e4c98ce99fc69eeefcf3714314a73b7`.

The legacy sibling Manager 0.1 lacks the current resource API. Optional fixtures report explicit skips when pinned sources are absent. Manager owns policy, sources own content/revision/authorization, and Assembler owns native preset assembly. The task plugin adds only the scoped source and trusted configuration bridge; it does not duplicate their stores or composer. A global Manager whitelist does not override the source's actual-session authorization.

Applicable local commands include:

```sh
npm run test:core
DSH_OFFICIAL_ROOT="$PWD/.runtime/official-dsh-0.2.1-rc.2" npm run test:native
TZ=UTC npm run test:ui
npm run test:official
npm run test:browser
DSH_CI_RESULTS_DIR="$PWD/.runtime/steward-current-packages" npm run test:distribution
```

Use a fresh results directory for newly changed package bytes; never overwrite a prior tested tarball receipt. Local macOS results do not establish Linux PR CI. Native request observation proves the official model-call boundary snapshot, not network delivery or model comprehension. Canonical pagination bounds returned/processed records; underlying JSONL persistence can still scan files. Project continuation carries bounded authority references and truncation markers, preserves original Task IDs, and retrieves full records by scoped pages instead of dumping all reports.

No `dev` merge, production preflight/deployment, version bump or release belongs to this isolated demo. Delivery follows a draft feature PR to `dev` and its required checks, without merging it.
