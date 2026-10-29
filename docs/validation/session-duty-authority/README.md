# Central authority and session duties

Ordinary sessions can coordinate central project tasks from their own device, workspace, tools and skills. The central service owns project metadata, task intent, Runs, reports, scheduling, workflow state and durable receipts. A local session binding supplies provenance; it never grants an execution lease or filesystem access.

## Configuration and migration

`centralMode` selects `host` or `remote`. `executionEnabled` independently controls native providers, local program workers, remote claims, execution model advertisement and execution heartbeats. `remote` with execution disabled still connects, registers its authenticated identity, dispatches project work and consumes origin returns.

When both new fields are absent, legacy parsing preserves the previous role semantics, including the historical omitted-role default. Explicit `planner` disables execution, `executor` connects remotely and permits execution, and `both` permits execution. Once either new field is present, legacy `role` does not enable execution; set `executionEnabled: true` explicitly when desired. When centralMode is omitted, an existing executor keeps its remote authority even if execution is switched off. The UI writes the new fields and has no device-role selector. Internal role values remain at existing ledger/protocol compatibility boundaries.

A legacy outbound coordinator declaration selects remote authority before creating task services. A legacy declaration that also exposes its own coordinator listener is ambiguous and fails closed. An explicitly hosted central service cannot also select another coordinator. Missing, paused or unreachable remote authority keeps bindings/requests pending and never mounts a local ProjectRuntime or planner.

Trusted-network peer execution permission is a separate explicit bit. Old peer grants retain their effective execution permission; newly added peers default to session collaboration only. Identity pairing works without a worker or execution heartbeat. Workspace authorization, exact addresses, signatures, capabilities, node identity, lease fences and native tool checks remain in force.

## Central project and task flow

`project_start` or `/project start` registers central Workbench metadata for the actual ordinary session cwd. `project_bind_session` or `/project attach` selects an existing central project. Authorized `projectCollaborate` peers can select central projects; this service permission is the current project access boundary, not a new per-project ACL. Every subsequent task command checks the persisted project/session binding, and task reads reject another project. The central server never opens the remote cwd. A project's default workspace sets the location of newly created PM sessions. Existing ordinary sessions can register with that project from their own directories, while keeping their actual node, session and cwd binding. Changing the PM workspace does not move or revoke those bindings. Managed PM placement and execution workspace grants keep their own checks.

`task_create` creates a scoped draft. `task_bind_dispatcher` creates its coordination Run without an Attempt. `task_dispatch` derives child ancestry from the bound dispatcher and preserves the original node/session/cwd and composition. Query/history/wait read central state. A final parent result requires settled children and a report. Durable command receipts preserve exact retry behavior after lost acknowledgments or partial outer receipt persistence.

The task page offers Central task center and Local activity independently of execution capability. Cold central failures still offer local navigation. Authenticated remote UI controls are limited to cancel/status for tasks originally created by the same node, with the existing Run/action version checks. Other central management operations remain on the central host.

## Return delivery and privacy

Origin-return polling has its own lifecycle and requires neither an execution worker nor free execution capacity. Return and ordinary-message selection happens before the bounded queue limit, so retained plain messages cannot starve results. Host and remote return continuations participate in configuration-edit admission. Restart recovery uses the original session and recorded composition; it does not move a running session or restore an old execution lease.

Return delivery uses the persisted origin node rather than a synthetic workspace grant. Project query/history omit raw execution configuration, project context and artifact paths. History keeps task, Run, report, artifact metadata, event metadata and origin-scoped delivery status.

## Preserved scope

The central host continues admitting durable schedules and ticking fixed-program/agent workflows without requiring a local coordinating conversation to be online. Unprojected tasks remain supported on the central service. Existing source registration and the legacy daily readers for Codex/Hermes time windows, including unregistered sessions, remain intact. Offline source collection must retain waiting/missing semantics; this change adds no collector and verifies no live daily configuration.

Authority-host finalized artifact preparation and remote artifact-transfer restrictions remain unchanged. A remote local path is not a central artifact. There is no repository/skill/material synchronization, session migration, second authority, automatic leader promotion, DMC change, daily deployment migration or public website export in this change. Stable business IDs, existing tables and history are retained. dsh-context Fleet is a future monitoring UI reference only.

## Verification and release impact

The installed `@dsh-task/task-system` package changes. Its version remains 0.2.51 for ordinary feature development. This is a development delivery, with no production installation, main promotion or tag.

See [verification.md](verification.md) for commands and results, and [decisions.tsv](decisions.tsv) for the decision trail. The isolated native tests script the external model. Loader, AgentLoop, native execution, SQLite persistence, signed/trusted-network HTTP, result returns and central task controls are real. They are not AWS/MBP production acceptance.

Before a release, run complete Linux/macOS CI on the fixed candidate, install its preserved tarballs on the intended devices, verify scheduling-only remote sessions and enabled executors across actual AWS/MBP connections, confirm existing schedules/workflows and private data boundaries, and obtain the user's explicit candidate/tag confirmation. Linux PR checks and real-device acceptance are separate from this local macOS evidence.
