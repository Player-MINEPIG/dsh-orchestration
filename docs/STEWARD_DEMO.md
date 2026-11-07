# Run the isolated steward demo

The existing task plugin now provides one canonical chat backed by separate personal, steward-workbench and per-project native DSH sessions. A single window routes each turn without a compulsory steward model hop. It uses the real Loader, AgentLoop, session persistence, SQLite task authority and local native executor. The default demo uses explicitly labeled offline model responses; a separate live mode can reuse an existing supported provider configuration in process memory.

## Use the official DSH conversation interface

Task execution has its own node model default, separate from the steward composer and native global default. A host that also executes locally can set it under **任务设置 → 本机执行节点 → 默认执行模型** using the same catalog validation and revision check as remote executors. Unset node policies use the documented DeepSeek Flash fallback; a listed model does not prove its provider credentials work. An authentication failure leaves the real Run outcome intact for reconciliation; changing the default does not rerun it. Responsible-session check-ins compare the native pending/last-used model, preserving a newer explicit selection and the original capability mask.

A current project PM or temporary-task coordinator can use **task_execution_status**: `inspect` reads the authorized Run/attempt, formal reports and bounded durable native evidence without messaging or activating its executor; `reconcile` requires the returned evidence/action versions and records the real coordinator actor. Reconciliation covers a complete local AUTH/401 turn with no assistant output or tool calls, or an exact durable interrupted/terminal invocation whose stopped owner and complete journal prove no current execution remains. Terminal-journal reconciliation also covers calls that ran tools: it requires the exact task/attempt/fence, persisted terminal turn, settled child accounts and no current parent/child activity. The interruption case closes that invocation while explicitly preserving its business result as unproven; a later ordinary reply never proves the old work succeeded. Active, stale, remote or insufficient evidence remains unknown. Native read-only permission permits inspection and denies settlement. Managed temporary directories intentionally have no registered workspace ID; direct-chat rejection now explains this distinction and points to evidence inspection. Automatic check-ins retain their captured capabilities and receive prompts and schemas matching those capabilities. Clicking **让调度检查** issues a separate auditable check limited to the current task and Run; it can inspect and reconcile evidence, but cannot dispatch or retry. A click behind an already queued automatic check is retained once and runs afterward. Native and PTC presentations are preserved, and the temporary tool surface is removed before an ordinary next turn. A separate explicit user retry authorization is still required to rerun work.

Installed hosts open **管家** in the official DSH shell. Its cross-session chat uses the official `conversation.content` factory, message rendering and composer. Canonical history supplies display events only; personal, workbench and project inference sessions receive their own scoped inputs. The other tabs come from the host's installed `conversation.view` registrations and render against the actual browsed source session. New plugin tabs appear without a steward-specific integration or whitelist.

The composer footer's **自动选择** control sets only the next message's topic, then returns to automatic routing. The header's separate topic control changes only the source session used by plugin pages. It follows the latest canonical message by default; manual browsing stays fixed until **回到最新话题**. The picker lists topics active within `stewardActiveDays` (default 30, configurable 1–365 days), retaining an already selected topic outside that window. Steward-derived local sessions use a **管家** title prefix and remain registered in the native workspace. DSH0.2.1-rc.2 hides noncurrent blank sessions until their first real turn; its public pin/roster APIs do not override that rule. Immediate permanent sidebar visibility for a never-started PM remains an unresolved host limitation.

**管家工作区** is a third, persistent native session and workspace with its own directory. It holds unassigned requirements, planning, research notes and temporary files; “temporary” describes project assignment, not deletion on close. Personal chat keeps its original restricted tools. The workbench reuses native read/write/edit/image tools only within its own canonical directory, plus exact admitted attachment reads. Shell and arbitrary project-management tools are unavailable there; native sandbox, approvals and the selected one-request permission still intersect these limits. Explicit project work continues through the existing PM/DO, with the stated goal and selected material rather than the full workbench history. Workbench recall/memory cannot read another project's authority records.

Sending status begins immediately when the browser submits an original request, including the pre-admission routing interval. It is not evidence of a worker running or server acceptance. Low-confidence routing, an unconfigured router, timeout, provider failure or invalid output remain in the independent routing layer with a durable, visible receipt; they are not delivered to any PM or executing workbench. Explicit inaccessible projects still fail authorization. Only this classifier's own deadline is labeled timeout. The auxiliary classifier continues to use `projectAgentOptions`; the native per-message model selector controls the actual recipient's execution. No raw provider errors, tokens or prompts are exposed in these receipts. An old not-admitted request is never retried automatically.

DSH 0.2.1-rc.2 does not expose its complete header as a reusable factory. A small header composes the real plugin tab roster and the source session's recorded preset; native plugin bodies remain unchanged. The source store/injection registration descriptors are forwarded through public slots APIs with a compatibility guard. Remote-owner plugin pages fail visibly rather than treating a foreign session ID as local authority. Native pages for an empty source follow DSH's own blank-session behavior until a conversation turn exists.

Routing, reply, explicit quotation, queue receipts and acceptance gates remain backed by the task service. Reply, quote and original-session navigation are icon actions beside copy for both message roles. Native Tasks and Memory Manager pages manage their own content; project workflow and gate management remain available in the existing project interface. The browser freezes each original command before the native composer yields its first paint. An uncertain acknowledgment stays in a local recovery card with the same command ID. A display acknowledgment does not establish server admission, model delivery or task completion. Reload never resends it automatically.

Automatic routing freezes the **latest visible topic** at submission, using the same latest-message scope as the browsing header. Manual browsing does not change the next-send destination. A separate tool-free router reads a sourced topic card and bounded related originals to judge the request semantically; **开始/继续 have no direct-routing rule**. If unrelated, it retrieves at most four authorized indexed candidates and asks the model to select. Uncertain, failed, or over-budget decisions remain durable router receipts, with zero PM/workbench admission. New unassigned work requires explicit confirmation before entering the steward workbench. Explicit target and canonical reply retain priority. Final admission rechecks the selected source generation.

Creating a project registers its PM session and workspace; a progress question can legitimately produce only a read-only ledger query. Once the independent router confirms the recipient, the original PM decides whether and what to start from its existing task ledger and permissions. Historical canonical messages keep their original scope and are never replayed by this change.

**话题总览** opens as a responsive two-to-four-column overlay below the steward toolbar, covering the tabs, conversation and composer while keeping host navigation available. Cards show a title and a display-only summary capped at 100 Unicode graphemes (including an ellipsis) and five lines. The bottom **上次聊到：** preview uses at most two lines from the latest canonical user/assistant message in that scope, with that message’s own time on a separate line; notifications and card refreshes do not replace it. Attachment-only messages use a factual placeholder, while a scope without discussion says **尚未开始讨论** and shows no time. The full summary remains in details, or in the full fact that already contains it, without changing stored summaries or routing budgets. A separate dialog contains details. Its numbered citations are deduplicated across the card, and the collapsed reference directory renders six entries per page. Exact IDs, revisions and byte coordinates appear only under technical details. Source text is read on demand from the existing canonical message or current project goal and checked against the reference revision; conflicting revisions require explicit refresh, not a claimed permanent historical snapshot. Cards retain derived summaries/fact text, and canonical history itself projects native conversations, so this is not a claim that the system stores no copies. No additional original-text archive is introduced.

Viewing the overview never activates the native source or calls a model. **应用到管家** selects the next message topic without sending or replacing its draft, quote, model, or one-shot permission. Generated facts remain marked as model-organized material: source validation proves provenance, not every inference. Project delivery, discussion continuity and execution context are distinct domain concepts. The current card identity is a routing range, not an implemented independent Topic identity; this UI iteration does not merge or migrate their data lifecycles.

Router questions retain the complete original request and frozen attachments/model/permission separately from execution history. Explicit question replies or a semantically related answer to the unique pending question can continue it; a new topic is not forced into an old question. Multiple pending questions require explicit association. A confirmed executor receives the original request plus its human clarification, without candidate histories. Original command IDs are retained for retries. Upload receipts held by pending router requests are protected from staged-upload cleanup and transfer to canonical ownership in the existing acceptance transaction.

Budgets: latest-topic card/original context 10 KiB; at most four candidate cards / 8 KiB total; the complete auxiliary system/message envelope 32 KiB; total routing deadline 30 seconds and at most three auxiliary calls, including optional maintenance. One real incoming request can maintain one oldest uncovered delta of at most 16 messages / 8 KiB. Existing sourced constraints remain unless later user evidence explicitly supersedes them. Install, startup and overview do not backfill history or trigger paid summarization. Missing/old/oversized coverage is shown explicitly; the complete user request is preserved and clarified rather than silently truncated.

Sending/routing and unresolved-receipt recovery render at the assistant-response position in the native chat flow. A session-level display-only business node reuses native user content, `TextShimmer` and the thinking icon, without an accepted user event or an agent Turn. The pinned rc2 input `groupTree`/`source.rpcId` convention suppresses only the duplicate optimistic display; actual submission retirement and attachment URL lifetime still require the native canonical/inbox evidence. A materialized business node retains its key and becomes hidden when finished, as the public Definition lifecycle requires. Earlier user copy/reply/quote/source actions follow hover/focus reveal; touch layouts keep them accessible and the latest user actions remain visible.

The native composer accepts text, images (PNG, JPEG, WebP and GIF) and generic files up to 8 MiB each. Native image batch limits and the actual selected model’s image capability are checked before admission. Generic files remain native read-only file references; personal and managed steward turns may use the native `read` tool only for exact admitted attachment paths in their authorized source. UTF-8 text is readable; binary document conversion is not added. Remote rich-content routes fail before acceptance, retaining the original request for recovery. Attachment-only automatic routing asks for a topic when it cannot infer one.

The bottom-right native model picker defaults to **跟随目标会话**. An explicit model and reasoning choice stays in the composer and is frozen with each submitted command. It controls the actual recipient’s turn and native last-used model, without changing the global default or unrelated sessions. Uploaded bytes use the official AttachmentStore; conversation-bound receipts and canonical content survive queueing, retry and reload. The native history window holds at most 300 canonical messages. Older/latest navigation replaces only the display journal; the native editor, selection and pending submissions stay mounted. Synthetic display turns expose no execution durations, counters or global Stop control.

The bottom-left native permission picker applies to **one new request**. **本次权限：跟随目标** keeps the actual recipient’s standing policy. An explicit choice is captured with the original command and resets for the next message; retry/reload keeps the original choice. Its native sandbox/approval bundle is frozen before queueing, revalidated when execution begins, and applied before native prompt assembly. The standing baseline is captured at that execution boundary and restored after the actual turn ends, with a native durability acknowledgment before later work is released. Later explicit native permission changes win the per-field compare-and-swap. Read-only also denies orchestration writes, including project creation, dispatch, session-message send and observation mutations. It grants no new workspace, node or task authority.

DSH0.2.1-rc.2 exposes durable permission setters rather than a temporary request policy. The adapter therefore records its finite native transition plan and restore baseline durably. A final native preset-intent event also advances the log beyond the approval knob, because rc2’s approval getter begins at `session.seq - 1`. Interrupted application/restoration and missing or false durability acknowledgments retain the marker and block or reconcile later execution. A legacy source without initialized native permission facts rejects an override rather than inventing an unset-state restoration.

Explicit requests to create a project use the scoped `steward_create_project` tool and the existing `projects.create` pipeline. New creation work belongs to **管家工作区**, separate from casual chat; automatic routing asks for confirmation before assigning genuinely new work there. A user can supply a complete name and goal, complete them in contiguous clarification replies, or explicitly delegate drafting them inside that same unfinished creation intent. Later explicit fields narrow earlier delegation; the complete bounded user requirement chain is preserved in the created goal. A precise reply uses its actual creation anchor and cannot revive a cancelled or superseded request. An old personal creation clarification can carry only those related canonical source references into the workbench when the user actively retries; old personal messages retain their original scope. Casual mentions, capability questions, quotes, cancellations and truncated field prefixes do not authorize creation. The configured project root and existing grants remain authoritative. Stable command identity makes duplicate tool results and retries converge. Only a trusted canonical steward origin gives the resulting PM session its **管家** prefix; ordinary project creation keeps its normal naming. The new project appears immediately in the recent-topic picker, and its permission default does not inherit the parent’s temporary request override.


`tests/ci/browser-native-steward.mjs` and `tests/ci/browser-native-steward-media.mjs` start an isolated official WebHost with a scripted model and verifies these interactions. The standalone fixture below retains its small test composer for historical fixture coverage.

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
3. Choose **引用**, retain one contiguous original excerpt, and send your next message. Automatic routing remains available; the quote source does not determine the destination. The host validates source access, message revision and exact text, and records an immutable sharing receipt. Only that excerpt crosses scopes; ordinary replies do not share history.
4. Reload or browse older messages. The server pages at most 100 rows, the panel retains at most 300, and parent previews/state refresh/old unresolved attention are separately bounded. A stale quote rejected before admission keeps the exact local request available for recovery. A lost acknowledgement retains the exact original request until reconciliation or explicit retry; it never automatically resends.
5. Run the local task-chain action and inspect its report. Set a phase gate for an existing workstream and declared repair tasks. A background A notification can open its exact candidate while the next chat target remains B. **通过验收，继续等待** records acceptance only; **验收并继续此请求** also submits the reviewed continuation with a stable receipt. Ordinary chat cannot impersonate a human decision. Repair revisions invalidate the prior candidate; historical admitted effects are disclosed, not canceled. Explicit independent work has its own trusted action.
6. Ask an actual scoped agent to use `steward_recall` for earlier history or project/task/report/decision/gate records. History cards include a versioned `lookup` for the complete message and `replyToLookup` for an accessible parent in the same scope. Pass the pointer fields except `tool` to the named tool, then follow `next`. Results are historical data, not new authorization. Task workers cannot borrow current or historical steward/PM native sessions, and executor tool views and recall/resource binding independently reject owned task execution.
7. In the offline demo, click **长消息续读验证**. It seeds a personal message containing Chinese text, emoji, NUL and a unique tail, then runs an actual native tool chain from search to full-message pages. The receipt at `recall-evidence.json` records page offsets, versions and exact reconstruction. The business response is scripted; this does not measure a real model's retrieval judgment or long-term memory.

Message-page `offset`, `nextOffset` and `totalBytes` count UTF-8 bytes. Each page contains at most 2000 body bytes and ends at a complete character. Use the returned `next` rather than counting JavaScript string characters. A stale version returns `CONFLICT`; refresh the history card. Unknown IDs, inaccessible scopes and offsets inside a UTF-8 character or outside the body are rejected. Quote fields contain only the complete, already authorized excerpt, at most 2000 JavaScript characters; they provide no source-message read pointer.

Canonical message bodies are immutable through supported APIs. State changes and human resolution atomically increment the persisted message revision, which locks reads without hashing or loading complete bodies during history search. Search still scans at most 100 rows and matches only bounded previews, at most 1600 Unicode code points. SQLite text previews can stop early at NUL; `truncated` still reflects the complete byte length and `lookup` reads the full body. This is bounded keyword browsing, not full-text or semantic search.

This iteration adopts the small-card/read-pointer pattern from the [official research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype). It adds no dependency on that repository and does not implement its Ticket, Subscription or outbox system. Project authority record pages retain their existing canonical-JSON character offsets; message byte cursors do not apply to them.

Phase gates protect formal plans, task creation, workflows and confirmed local managed-PM continuations. They do not prove that an unrestricted external agent cannot plan in free text or mutate arbitrary external systems. Remote owner adapters are not implemented for the new memory/gate configuration path. New gate setup currently uses explicit IDs rather than an automatic natural-language phase parser.

## Concurrent feedback and existing task routing

Submitting a message keeps its exact request under its own command ID in browser storage until the server acknowledgement is known. The composer immediately accepts the next draft. Slow routing and late responses do not clear that draft or change its target. Browser storage is a local recovery record, not proof that the Host has saved a message. Reconciliation and explicit retries retain the original command ID. Old single-request browser records migrate on load. A reply or quote whose source is outside the current page must be loaded before restoring it for editing; the exact original request remains available for reconciliation or retry.

The managed project PM uses its existing `pr_turns` table as a durable FIFO. It saves later messages while that same session is responding and admits one turn at a time. Other projects proceed independently. This queue applies to managed PM sessions; personal and externally hosted native sessions retain their existing admission rules. An unresolved native admission blocks only that session until its original evidence is reconciled or the user explicitly ends the wait at an idle point. A routed message enters its target queue when the target is known. Earlier unresolved classification does not reserve a place ahead of later messages with explicit targets.

Startup adds the `native_admission` column to existing `pr_turns` tables once. Historical rows default to `unknown`; new queued rows start as `not-started`. The Host changes a row to `running` before native resume, records `started` before followup, and records `confirmed` after completion. A known failure before native admission can be rejected. Interrupted admitted work is not automatically replayed, and queued rows survive restart. Old project generations do not migrate pending input into a new session.

Project planning and worker selection remain in the existing DO/PM path. `task_session_message` provides `targets`, `send`, and `status` over the existing task-bound session-message queue. It sends ordinary feedback to an authorized original worker session without creating a new Task or Run. The Host verifies the task, project, node, session and workspace binding; an ID alone grants no access. The existing acceptance gate also guards tool sends conservatively, so some repair/upstream messages can remain blocked, including some released-gate cases. Read operations and the user's existing explicit direct-message UI retain their prior behavior. Temporary ad-hoc planning sessions do not receive this extra tool. This is a small connection to the existing PM and worker queue, not a second dispatcher or task classifier.

The offline demo returns ordinary message admission independently of native completion. Shared demo recall/task fixtures remain exclusive and reject while real native or managed PM activity is present. This fixture exclusion does not serialize ordinary messages to independent projects.

To repeat the controlled 20-message correctness stress check after building:

```sh
DSH_BURST_ROUNDS=5 node tests/dsh/steward-burst-integration.mjs
```

The check uses actual Settings HTTP, SQLite authority and native DSH sessions with scripted providers. Each round holds one PM response and one classifier while nineteen direct messages are saved, verifies independent projects finish, then releases the held work. Its receipt under `.runtime/steward-burst-integration` records request IDs, target/session matches, queue/order checks and observation times. These controlled holds do not measure paid-provider quality, production capacity or real model throughput.

The browser comparison requires a preserved baseline checkout and its built dependencies:

```sh
DSH_BURST_BASELINE_ROOT=/path/to/preserved-candidate DSH_BROWSER_CHANNEL=chrome node tests/dsh/steward-burst-baseline.mjs
DSH_BURST_ONLY_AUTHORITY=1 DSH_BURST_OUTPUT=.runtime/steward-burst-authority DSH_BROWSER_CHANNEL=chrome node tests/dsh/steward-burst-baseline.mjs
DSH_BURST_ONLY_DEMO_GUARD=1 DSH_BURST_OUTPUT=.runtime/steward-demo-guard DSH_BROWSER_CHANNEL=chrome node tests/dsh/steward-burst-baseline.mjs
```

The comparison alternates five baseline/current rounds and separately tests lost acknowledgements, multiple browser recovery records, legacy-record migration and draft preservation. The focused modes exercise two actual authorities with different pagination ranges and an actual native PM held through a test-only preload. Existing demos and their data directories can remain running independently.

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

### 托管 PM 重试已结束任务

已绑定的项目或临时任务 PM 在用户明确要求重新执行时，可使用原有 `task_dispatch`：传同一 `taskId`、`retry: true`、`task_query` 返回的当前 `expectedActionVersion` 和稳定 `commandId`。不重新提交标题、正文或配置，不创建重复 Task。宿主复用任务中心的正式重试、版本检查和持久派发队列，保留先前失败 Run。

省略 `executionModel` 时，托管 PM 重试冻结所选节点当前默认模型；显式选择只作用于这次执行，不改节点或全局默认。旧任务中心调用未指定新路由选项时仍保留原重试行为。只读请求、定时检查及结果通知不能自行授权重跑；执行中或结果未知的运行必须先据证核实。
