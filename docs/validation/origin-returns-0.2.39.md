# 0.2.39 local verification

Based on the recovered, byte-verified deployed 0.2.38 source. The task-system and Feishu channel build pass. The focused integration run passes 46/46 tests, covering public tool inventory, signed remote native execution, project/session authorization, current-workspace adoption, per-run origin isolation and restart persistence, and coordinator parent Task completion after an asynchronous result.

The ordinary coordinator test drives real DSH AgentLoop public tools with a scripted external model: project selection, parent draft creation, current-session dispatcher binding, MBP child dispatch, original-session cold return, child report read, parent final result. It confirms the MBP child inherits project context and parent Task/Run, without inheriting an AWS filesystem constraint.

A pending return is resumed after persistence and consumed once. Busy origins process the return in their next turn; acknowledgement waits for that turn to finish. Independent two-process tests cover both a persisted pending inbox and a consumed-but-interrupted result: each original payload appears once, no new Run is created, the resumed handle is released, and the continuation completes. The interrupted case adds only a continuation prompt. Three successive real deliveries leave zero abort listeners.

Workspace browser verification uses real Chrome, TaskPluginSettings RPC, ProjectRuntime, SQLite and native sessions: existing local directory and registered remote workspace selection pass, preserve files and keep the default parent setting unchanged. Expanded workspace regression has the same 95 passes and nine legacy fixture failures as its independently built baseline; no additional failures were introduced by workspace selection.

Both installed hosts have zero old public tool-name references in current persisted task/template/schedule entities. MBP has one old `executionTools` entry (`task_delegate`); deployment migrates that grant to `task_dispatch` and records the exact configuration change. AWS has none. Immutable history is preserved.

This records local/scripted external-model validation. Physical AWS–MBP deployment and smoke receipts are recorded separately after installation.
