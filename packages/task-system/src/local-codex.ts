import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-jobs";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-subprocess";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

export const name = "task-local-codex";
export const inject = ["taskSystem", "tools", "jobs", "subprocess", "sandboxPolicy"];
export interface Config { enabled: boolean; databasePath: string; cliPath?: string; model: string; reasoningEffort: string; maxConcurrent: number }
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false), databasePath: z.string().required(),
  cliPath: z.string().required(false), model: z.string().default("gpt-6.1-sol"),
  reasoningEffort: z.string().default("high"), maxConcurrent: z.number().min(1).max(8).step(1).default(2),
});
type Mode = "read-only" | "workspace-write" | "danger-full-access";
export function localCodexPermission(mode: Mode) {
  if (!["read-only", "workspace-write", "danger-full-access"].includes(mode)) throw new Error("Unknown parent permission mode");
  return mode === "read-only"
    ? { sandbox: "read-only", approval: "never", reviewer: "user", label: "只读（继承父会话）" }
    : { sandbox: "workspace-write", approval: "on-request", reviewer: "auto_review", label: "工作区写入 · Codex 自动审批" };
}
export interface LocalCodexTask {
  id: string; sessionId: string; requestId: string; title: string; description: string;
  cwd: string; model: string; reasoningEffort: string; parentMode: Mode;
  status: "queued" | "running" | "review" | "done" | "error" | "cancelled" | "unknown";
  createdAt: string; updatedAt: string; jobId?: string; report?: string; threadId?: string;
  cliPath: string; exitCode?: number | null;
  acceptance?: { sessionId: string; evidence: string; acceptedAt: string };
}
export function findDesktopCodex(configured?: string) {
  if (configured) {
    if (!isAbsolute(configured) || !statSync(configured).isFile()) throw new Error("Configured Desktop codex executable is unavailable");
    return realpathSync(configured);
  }
  if (process.platform !== "win32") throw new Error("Set local Codex cliPath to the Desktop-bundled executable on this host");
  const root = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
  const candidates = existsSync(root) ? readdirSync(root).map(dir => join(root, dir, "codex.exe")).filter(existsSync) : [];
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!candidates[0]) throw new Error("Codex Desktop executable not found; configure cliPath. No CLI was installed automatically.");
  return realpathSync(candidates[0]);
}

export function localCodexProfile(task: Pick<LocalCodexTask, "model" | "reasoningEffort" | "parentMode">) {
  const permission = localCodexPermission(task.parentMode);
  return `model = ${JSON.stringify(task.model)}\nmodel_reasoning_effort = ${JSON.stringify(task.reasoningEffort)}\nsandbox_mode = ${JSON.stringify(permission.sandbox)}\napproval_policy = ${JSON.stringify(permission.approval)}\napprovals_reviewer = ${JSON.stringify(permission.reviewer)}\ncli_auth_credentials_store = "file"\nproject_root_markers = []\n[windows]\nsandbox = "unelevated"\n[features]\nplugins = false\napps = false\nremote_plugin = false\nhooks = false\n`;
}

/** Separate local-only storage: no task/run admission, outbox, scheduler or coordinator calls. */
export class LocalCodexStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS session_codex_tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, request_id))");
    for (const row of this.db.prepare("SELECT data FROM session_codex_tasks").all()) {
      const task = JSON.parse(String(row.data)) as LocalCodexTask;
      if (["queued", "running"].includes(task.status)) this.save({ ...task, status: "unknown", report: "服务已重启，先前执行状态待核实；未自动重跑。" });
    }
  }
  save(task: LocalCodexTask) {
    task.updatedAt = new Date().toISOString();
    this.db.prepare("INSERT INTO session_codex_tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(task.id, task.sessionId, task.requestId, JSON.stringify(task));
  }
  list(sessionId: string): LocalCodexTask[] {
    return this.db.prepare("SELECT data FROM session_codex_tasks WHERE session_id=? ORDER BY rowid").all(sessionId).map(row => JSON.parse(String(row.data)));
  }
  accept(sessionId: string, taskId: string, evidence: string) {
    if (!evidence.trim() || evidence.length > 8000) throw new Error("Provide bounded verification evidence before accepting the task");
    const task = this.list(sessionId).find(task => task.id === taskId);
    if (!task) throw new Error("Local task not found in this parent session");
    if (task.status === "done" && task.acceptance?.evidence === evidence) return task;
    if (task.status !== "review") throw new Error("Only a returned result awaiting review can be accepted");
    task.status = "done";
    task.acceptance = { sessionId, evidence, acceptedAt: new Date().toISOString() };
    this.save(task);
    return task;
  }
  rows(sessionId: string) {
    return this.list(sessionId).map(task => ({
      id: task.id, title: task.title, description: task.description, status: task.status, direct: true,
      stateLabel: ({ queued: "等待开始", running: "执行中", review: "待确认", done: "已完成", error: "需处理", cancelled: "已取消", unknown: "状态待核实" })[task.status],
      source: "local-codex", node: "本机 · Codex Desktop", model: task.model,
      time: task.createdAt, report: task.report, permissionLabel: localCodexPermission(task.parentMode).label,
      jobId: task.jobId, threadId: task.threadId, cwd: task.cwd,
      acceptance: task.acceptance,
    }));
  }
}

/** Bounded JSONL fold: process exit alone is never a successful task result. */
export class CodexOutput {
  buffer = ""; decoder = new StringDecoder("utf8"); report = ""; threadId?: string;
  completed = false; error = "";
  push(chunk: Buffer) { this.buffer += this.decoder.write(chunk); this.drain(); }
  finish() { this.buffer += this.decoder.end(); this.drain(true); }
  private drain(final = false) {
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) { const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1); this.line(line); }
    if (this.buffer.length > 4 * 1024 * 1024) throw new Error("Codex output line exceeds limit");
    if (final && this.buffer.trim()) { this.line(this.buffer); this.buffer = ""; }
  }
  private line(line: string) {
    if (line.length > 4 * 1024 * 1024) throw new Error("Codex output line exceeds limit");
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "thread.started") this.threadId = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message") this.report = String(event.item.text).slice(0, 64000);
    if (event.type === "turn.completed") this.completed = true;
    if (event.type === "turn.failed" || event.type === "error") this.error = String(event.error?.message ?? event.message ?? "Codex execution failed").slice(0, 4000);
  }
}

declare module "@deepseek-ai/cordis" { interface Context { localCodex: LocalCodexService } }
export class LocalCodexService extends Service {
  readonly store: LocalCodexStore;
  private active = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  private closing = false;
  constructor(ctx: Context, readonly config: Config) {
    super(ctx, "localCodex");
    this.store = new LocalCodexStore(resolve(config.databasePath));
    ctx.effect(() => async () => {
      this.closing = true;
      for (const item of this.active.values()) item.controller.abort("Local Codex plugin stopped");
      await Promise.allSettled([...this.active.values()].map(item => item.done));
      this.store.db.close();
    });
  }
  delegate(agent: Agent, input: { requestId: string; title: string; prompt: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!input.requestId.trim() || input.requestId.length > 200 || !input.title.trim() || input.title.length > 240 || !input.prompt.trim() || input.prompt.length > 100000) throw new Error("Provide a commandId, title and bounded full task description");
    if (this.closing) throw new Error("Local Codex service is stopping");
    if (this.ctx.get("taskSystem")?.native?.scopeFor(agent)) throw new Error("Local Codex delegation is for local user sessions, not scheduler-owned executions");
    const cwd = agent.session.header.cwd;
    if (!cwd || !isAbsolute(cwd)) throw new Error("Select a workspace before delegating to Codex");
    const policy = agent.ctx.get("sandboxPolicy")?.resolve({ session: agent.session });
    if (!policy) throw new Error("Parent sandbox policy is unavailable; Codex was not started");
    localCodexPermission(policy.mode);
    const prior = this.store.list(String(agent.id)).find(task => task.requestId === input.requestId);
    if (prior) {
      if (prior.title !== input.title || prior.description !== input.prompt || prior.cwd !== cwd) throw new Error("requestId already used with different instructions");
      return this.receipt(prior);
    }
    if (this.active.size >= this.config.maxConcurrent) throw new Error("Local Codex capacity reached; wait for an existing job before retrying");
    const task: LocalCodexTask = {
      id: `local-codex-${randomUUID()}`, sessionId: String(agent.id), requestId: input.requestId,
      title: input.title, description: input.prompt, cwd, model: this.config.model, reasoningEffort: this.config.reasoningEffort,
      parentMode: policy.mode, cliPath: findDesktopCodex(this.config.cliPath), status: "queued",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const controller = new AbortController();
    this.store.save(task);
    try {
      task.jobId = this.ctx.jobs.start({ kind: "subagent", label: task.title, owner: agent.id, run: () => {
        const done = Promise.resolve().then(() => this.execute(task, controller.signal));
        this.active.set(task.id, { controller, done });
        void done.then(() => this.active.delete(task.id), () => this.active.delete(task.id));
        return { cancel: reason => controller.abort(reason), done };
      } });
      this.store.save(task);
      return this.receipt(task);
    } catch (error) { task.status = "error"; task.report = String(error); this.store.save(task); throw error; }
  }
  private receipt(task: LocalCodexTask) {
    return { taskId: task.id, jobId: task.jobId, status: task.status, permission: localCodexPermission(task.parentMode),
      localOnly: true, message: "已记录到当前会话任务面板。用 codex_status 查看持久结果，用 job_output 等待回传；核查文件或测试后，用 task_accept 提交验收依据并标记已完成。不要重复派发。" };
  }
  private async execute(task: LocalCodexTask, signal: AbortSignal) {
    const root = resolve(dirname(this.config.databasePath), "codex-profiles");
    const profile = join(root, task.id);
    let child: ReturnType<Context["subprocess"]["spawn"]> | undefined;
    let quiescent = true;
    try {
      signal.throwIfAborted();
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      // Only authentication is reused. Native plugins/MCP/hooks cannot widen the parent's sandbox.
      const auth = join(homedir(), ".codex", "auth.json");
      if (!existsSync(auth)) throw new Error("Desktop file authentication is unavailable; sign in to Codex Desktop first");
      copyFileSync(auth, join(profile, "auth.json"));
      chmodSync(join(profile, "auth.json"), 0o600);
      writeFileSync(join(profile, "config.toml"), localCodexProfile(task));
      const permission = localCodexPermission(task.parentMode);
      const argv = [task.cliPath, "exec", "--json", "--skip-git-repo-check", "-C", task.cwd, "--sandbox", permission.sandbox,
        "-c", `approval_policy=${JSON.stringify(permission.approval)}`, "-c", `approvals_reviewer=${JSON.stringify(permission.reviewer)}`, "-"];
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).filter(key => /^CODEX_/i.test(key)).map(key => [key, undefined]));
      env.CODEX_HOME = profile;
      task.status = "running"; this.store.save(task);
      child = this.ctx.subprocess.spawn({ argv, cwd: task.cwd, env, signal, graceMs: 5000,
        stdio: { stdin: { data: task.description }, stdout: "pipe", stderr: { maxBytes: 8192 } } });
      quiescent = false;
      const output = new CodexOutput();
      let parseError: unknown;
      child.stdout!.on("data", (chunk: Buffer) => { try { output.push(chunk); } catch (error) { parseError = error; child!.terminate(); } });
      const outcome = await child.done;
      if (!await child.waitForExit(AbortSignal.timeout(10000))) throw new Error("Codex process cleanup could not be confirmed");
      quiescent = true;
      if (parseError) throw parseError;
      output.finish(); task.exitCode = outcome.exitCode; task.threadId = output.threadId;
      task.status = signal.aborted ? "cancelled" : outcome.exitCode === 0 && output.completed && output.report && !output.error ? "review" : "error";
      task.report = output.report || output.error || child.collected.stderr?.readFrom(0).text.slice(-4000) || "Codex did not return a final result";
      if (task.status === "error" && output.error) task.report = `${output.error}\n${output.report}`;
      this.store.save(task);
      return { status: task.status === "cancelled" ? "killed" as const : task.status === "review" ? "completed" as const : "failed" as const,
        result: JSON.stringify({ taskId: task.id, status: task.status, report: task.report }) };
    } catch (error) {
      child?.terminate();
      if (child) quiescent = await child.waitForExit(AbortSignal.timeout(10000)).catch(() => false);
      task.status = signal.aborted ? "cancelled" : "error"; task.report = error instanceof Error ? error.message : String(error);
      this.store.save(task);
      return { status: signal.aborted ? "killed" as const : "failed" as const, result: JSON.stringify({ taskId: task.id, status: task.status, report: task.report }) };
    } finally {
      // The unique generated profile is inside the configured local data directory.
      if (quiescent && dirname(profile) === root && /^local-codex-[0-9a-f-]{36}$/.test(task.id)) {
        try { rmSync(profile, { recursive: true, force: true }); }
        catch { this.ctx.logger.warn("Could not remove local Codex profile %s", profile); }
      }
    }
  }
}
export function apply(ctx: Context, config: Config) {
  if (!config.enabled) return;
  const service = new LocalCodexService(ctx, config);
  const output = { schema: { type: "json" as const }, render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }] };
  ctx.tools.register(defineTool({ name: "task_accept", description: "Accept a successfully returned local delegated task after the parent independently verifies files, tests or other evidence. Only the original parent session can accept; not for running, failed or scheduler tasks. Record what you actually checked, not only the child's success claim. This changes pending review to completed in the session monitor.",
    parameters: { taskId: { type: "string", required: true }, evidence: { type: "string", required: true } }, output,
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error("A local parent session is required");
      exec.signal.throwIfAborted();
      const task = service.store.accept(String(exec.agent.id), args.taskId, args.evidence);
      return JSON.parse(JSON.stringify({ taskId: task.id, status: task.status, acceptance: task.acceptance, localOnly: true }));
    } }));
  ctx.tools.register(defineTool({ name: "codex_status", description: "Read this local session's persistent Codex task results. Does not consume job output or contact the scheduler. A review status requires independent parent verification followed by task_accept to mark completed.",
    parameters: { taskId: { type: "string" } }, output,
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error("A local parent session is required");
      return JSON.parse(JSON.stringify(service.store.rows(String(exec.agent.id)).filter(task => !args.taskId || task.id === args.taskId)));
    } }));
}
