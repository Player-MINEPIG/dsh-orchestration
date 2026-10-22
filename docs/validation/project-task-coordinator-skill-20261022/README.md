# Project task coordinator skill acceptance — 2026-10-22

Source baseline: `main` / `origin/main` at `fe0e9c007227bdc59e28e3af78c52e8fb52ae198`, fetched before development. Development branch: `codex/project-task-coordinator-skill`. Existing main checkout was clean; prior WIP remains in stash commit `2b6330cecdba7eab3a1aab82f081686e2df85f3e`.

Only the new `.dsh/skills/project-task-coordinator/SKILL.md` and these validation records are delivered. No task plugin package, DMC file/configuration, model default, business state, gateway receipt or service process was changed. Task package remains 0.2.42. AWS DMC package was read-only inspected and reported 0.1.7; no DMC test or install ran.

## Native discovery and loading

The filesystem provider discovers `.dsh/skills` at a project root and `~/.dsh/skills` at user scope. Only the summary is advertised; the `skill` tool loads the body on demand:

```json
{"name":"skill","arguments":{"name":"project-task-coordinator"}}
```

The skill was atomically installed at:

- AWS: `/home/ubuntu/.dsh/skills/project-task-coordinator/SKILL.md`
- MBP: `/Users/pmp/.dsh/skills/project-task-coordinator/SKILL.md`

Both exact file SHA-256 values: `5bc46d7578ee445e169770a97175ef181dda4466a12bf7ead9836b2fedaaa813`.

`aws-load.json` and `mbp-load.json` record a successful load using each machine's installed native `dsh-skill`, `dsh-skill-filesystem`, `dsh-tools` and `dsh-tool-skill`. Discovery is `filesystem` / `user-dsh`, model/user invocable, and tool output contains the canonical `<skill_content>` wrapper and complete instructions. `verify-native.mjs` is the small reproducible read-only probe:

```sh
DSH_CLI="$(command -v dsh)" node verify-native.mjs
```

It uses an isolated Context, no agent, and minimal unused host interfaces; registry, filesystem provider, tool runtime and loader are actual installed modules. It loads no task/DMC plugins or business DB and calls no model. This proves native discovery and tool reading, not live agent compliance or task execution. No restart or task-package update was required; an already running agent sees catalog changes on a subsequent eligible step, subject to its existing skill-tool permissions.

Skill-creator `quick_validate.py` passed (PyYAML installed only under `/private/tmp/dsh-skill-validator-deps`). Manual schema review corrected required `task_wait.taskId` and confirmed draft creation/binding precede formal dispatch.

## Turn and business boundaries

Read-only review of current DMC `src/agent-tools.js` shows analysis submission and revision call `concludeTurn`; task submission does likewise. Native ToolRuntime marks a WeakSet and PTC propagates the flag to its outer call; it does not abort the active program. The skill therefore requires preparing submissions before concluding, allows sequential awaited submissions inside a supported PTC program, and reports any unfinished business or parent settlement separately when that path is unavailable. It does not promise DMC business lifecycle changes or automatic extra turns.

## Example user prompt

在项目对应工作区的普通会话中输入：

> 请先通过 skill 工具加载 project-task-coordinator，然后遵循它处理本次委托：在已有 dsh-tavern 项目下创建父整理任务，把当前会话注册为调度会话；把【具体分析目标与验收标准】交给 MBP，目标仓库路径是 /Users/pmp/AI/deepseek-harness/dsh-tavern。保留这些目标约束，先查准确项目和节点 ID。等正式子报告返回后核验证据并提交父报告；如有绑定、路由或权限阻碍，报告真实调用和状态，不改目标、不创建临时任务代替。
