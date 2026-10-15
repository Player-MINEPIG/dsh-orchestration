# Local Codex delegation

The optional `task-local-codex` plugin runs `codex exec --json` as a DSH background job. It reuses the executable distributed with Codex Desktop, without installing a separate CLI or controlling Desktop chat threads. It is a local execution adapter, not the distributed scheduler backend.

## Requirements and configuration

- DSH 0.2.0-rc.2 with the task-system bundle, jobs/controller, subprocess and sandbox-policy services. Task-system must expose workload tools (`executor` or `both` role).
- Codex Desktop installed and signed in with file credentials at the current user's `~/.codex/auth.json`. Keyring-only authentication is currently unsupported and fails explicitly.
- Windows automatically discovers `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`. Other systems require `cliPath`; those hosts have not yet been validated. No username, machine-specific executable path or private service is embedded in the adapter.
- The adapter is disabled by default. Enable it only on hosts that should execute local tasks. The override must include `databasePath`, because DSH replaces the entry's config object.

Example `cordis.patch.yml` entry (replace the data path with an absolute path on the host):

```yaml
- id: task-local-codex
  config:
    enabled: true
    databasePath: /absolute/path/to/session-codex.sqlite
    # cliPath: /absolute/path/to/Desktop/bundled/codex
    model: gpt-6.1-sol
    reasoningEffort: high
    maxConcurrent: 2
```

Each execution gets an isolated temporary Codex home. Only authentication is copied from the user's Codex home; user plugins, MCP servers and hooks are not inherited. The temporary profile is removed after confirmed process exit. The parent workspace remains the working directory. Model access depends on the signed-in account; configure an available model if necessary.

## Tool lifecycle

In an ordinary session, call `task_delegate` with a stable `commandId`, a `title` and the full task prompt in `description`; `backend: "codex"` is optional. The same ID and identical instructions return the existing task instead of running it twice. Local delegation rejects ledger-only `route`, `policy`, `configuration` and `display` options. Existing owned-task delegation still uses its authoritative ledger, and cannot bypass it by selecting this backend.

Use `job_output` to collect the background result, `codex_status` to read persistent local results, and the standard DSH job cancellation tool to stop running work. A successful exit alone does not establish success: a completed Codex turn and final report are also required. The session's **任务** tab shows the result as **待确认**.

After independently checking the files, tests or other acceptance criteria, the original parent session can call `task_accept({taskId, evidence})`. The verification evidence is persisted and displayed in the task details, and the task becomes **已完成**. Other sessions cannot accept it; running, failed, cancelled and unknown tasks cannot be accepted. Repeating the same acceptance is idempotent. This records the parent's verification; it is not an automated proof that the evidence is correct.

## Permissions and persistence

| Parent DSH mode at dispatch | Codex sandbox | Approval policy | Reviewer |
| --- | --- | --- | --- |
| read-only | read-only | never | user |
| workspace-write | workspace-write | on-request | auto_review |
| danger-full-access | workspace-write | on-request | auto_review |

Unknown parent modes fail closed. Writable parents use Codex's automatic approval reviewer, including workspace-write parents. The child starts with workspace-write rather than unrestricted access; escalations are decided by Codex auto-review. This maps DSH's three permission modes, not arbitrary extra restrictions added by third-party parent plugins. Windows uses Codex's unelevated sandbox. No dangerous-bypass flag is used.

Tasks, reports and acceptance records live in a separate SQLite database, scoped to the original parent session. They never enter the scheduler ledger, dispatch outbox or central task protocol. Reopening the panel or starting a new parent turn retains them. On restart, unfinished tasks become **状态待核实** and are not automatically relaunched. Completed results and acceptance survive restart. CLI profile/thread data is temporary, so this adapter does not support child continuation/resume.

The monitor still reads older confirmed shell-based `codex exec` jobs. Such historical process completions remain distinct from verifiable local adapter results and cannot be accepted through `task_accept`.
