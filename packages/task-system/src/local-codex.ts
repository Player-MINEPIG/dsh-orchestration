import type { SessionTaskHeader, SessionTaskHeaderSource } from "./session-demand-reads.js";
import { ExecutionModelChoice } from "./execution-models.js";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-jobs";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-subprocess";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    codex: "codex";
  }
}

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
    : { sandbox: "workspace-write", approval: "on-request", reviewer: "auto_review", label: "Codex 自动审批 · 工作区写入沙箱" };
}
export function localCodexReasoningEffort(requested: string | undefined, fallback: string) {
  const value = requested ?? fallback;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) throw new Error("Invalid Codex reasoningEffort; use an effort name supported by the configured model");
  return value;
}
export interface LocalCodexTask {
  id: string; sessionId: string; requestId: string; title: string; description: string;
  cwd: string; model: string; reasoningEffort: string; parentMode: Mode;
  status: "queued" | "running" | "review" | "done" | "error" | "cancelled" | "unknown";
  createdAt: string; updatedAt: string; returnedAt?: string; jobId?: string; report?: string; threadId?: string;
  cliPath: string; exitCode?: number | null;
  requestedModel?:ExecutionModelChoice;
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

export function localCodexRow(task:LocalCodexTask) {
  return {id:task.id,title:task.title,description:task.description,status:task.status,direct:true,
    stateLabel:({queued:"等待开始",running:"执行中",review:"待确认",done:"已完成",error:"需处理",cancelled:"已取消",unknown:"状态待核实"})[task.status],
    owner:"local-codex" as const,source:"local-codex",node:"本机 · Codex Desktop",model:task.model,reasoningEffort:task.reasoningEffort,
    parentMode:task.parentMode,permission:localCodexPermission(task.parentMode),time:task.createdAt,
    returnedAt:task.returnedAt??(["review","done","error","cancelled"].includes(task.status)?task.updatedAt:undefined),
    report:task.report,permissionLabel:localCodexPermission(task.parentMode).label,jobId:task.jobId,threadId:task.threadId,cwd:task.cwd,acceptance:task.acceptance};
}

/** Separate local-only storage: no task/run admission, outbox, scheduler or coordinator calls. */
export class LocalCodexStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS session_codex_tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, request_id))");
    this.prepareHeaders();
    this.db.function("local_codex_contains",{deterministic:true},(value,needle)=>String(value??"").toLowerCase().includes(String(needle??"").toLowerCase())?1:0);
    for (const row of this.db.prepare("SELECT id,session_id FROM session_codex_headers WHERE status IN ('queued','running')").all()) {
      const task = this.get(String(row.session_id),String(row.id));
      if(task)this.save({...task,status:"unknown",report:"服务已重启，先前执行状态待核实；未自动重跑。"});
    }
  }
  save(task: LocalCodexTask) {
    task.updatedAt = new Date().toISOString();
    if (["review", "error", "cancelled"].includes(task.status)) task.returnedAt ??= task.updatedAt;
    this.db.prepare("INSERT INTO session_codex_tasks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(task.id, task.sessionId, task.requestId, JSON.stringify(task));
  }
  private prepareHeaders() {
    this.db.exec("CREATE TABLE IF NOT EXISTS session_codex_header_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,version INTEGER NOT NULL)");
    if(!this.db.prepare("SELECT 1 FROM session_codex_header_meta WHERE singleton=1 AND version=2").get())this.db.exec("DROP TRIGGER IF EXISTS session_codex_header_insert; DROP TRIGGER IF EXISTS session_codex_header_update; DROP TRIGGER IF EXISTS session_codex_header_delete");
    const returned="COALESCE(json_extract(NEW.data,'$.returnedAt'),CASE WHEN json_extract(NEW.data,'$.status') IN ('review','done','error','cancelled') THEN json_extract(NEW.data,'$.updatedAt') END)";
    const label="CASE json_extract(NEW.data,'$.status') WHEN 'queued' THEN '等待开始' WHEN 'running' THEN '执行中' WHEN 'review' THEN '待确认' WHEN 'done' THEN '已完成' WHEN 'error' THEN '需处理' WHEN 'cancelled' THEN '已取消' ELSE '状态待核实' END";
    const select=`NEW.id,NEW.session_id,json_extract(NEW.data,'$.status'),COALESCE(unixepoch(${returned},'subsec')*1000,0),COALESCE(unixepoch(json_extract(NEW.data,'$.createdAt'),'subsec')*1000,0),json_extract(NEW.data,'$.title')||' 本机 · Codex Desktop '||NEW.id||' '||${label},json_object('id',NEW.id,'title',json_extract(NEW.data,'$.title'),'status',json_extract(NEW.data,'$.status'),'direct',json('true'),'owner','local-codex','source','local-codex','node','本机 · Codex Desktop','model',json_extract(NEW.data,'$.model'),'reasoningEffort',json_extract(NEW.data,'$.reasoningEffort'),'time',json_extract(NEW.data,'$.createdAt'),'returnedAt',${returned},'stateLabel',${label},'detailVersion','2:'||COALESCE((SELECT revision+1 FROM session_codex_header_meta WHERE singleton=1),1))`;
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_codex_headers(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,returned_sort REAL NOT NULL,time_sort REAL NOT NULL,search_text TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_codex_header_order ON session_codex_headers(session_id,returned_sort DESC,time_sort DESC,id);
      CREATE INDEX IF NOT EXISTS session_codex_header_status ON session_codex_headers(session_id,status,returned_sort DESC,time_sort DESC,id);
      CREATE TABLE IF NOT EXISTS session_codex_header_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,version INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS session_codex_header_insert AFTER INSERT ON session_codex_tasks BEGIN INSERT OR REPLACE INTO session_codex_headers SELECT ${select}; UPDATE session_codex_header_meta SET revision=revision+1 WHERE singleton=1; END;
      CREATE TRIGGER IF NOT EXISTS session_codex_header_update AFTER UPDATE ON session_codex_tasks BEGIN DELETE FROM session_codex_headers WHERE id=OLD.id; INSERT OR REPLACE INTO session_codex_headers SELECT ${select}; UPDATE session_codex_header_meta SET revision=revision+1 WHERE singleton=1; END;
      CREATE TRIGGER IF NOT EXISTS session_codex_header_delete AFTER DELETE ON session_codex_tasks BEGIN DELETE FROM session_codex_headers WHERE id=OLD.id; UPDATE session_codex_header_meta SET revision=revision+1 WHERE singleton=1; END;`);
    if(!this.db.prepare("SELECT 1 FROM session_codex_header_meta WHERE singleton=1 AND version=2").get()) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("DELETE FROM session_codex_headers");
        this.db.exec(`INSERT INTO session_codex_headers SELECT ${select.replaceAll('NEW.','source.')} FROM session_codex_tasks source`);
        this.db.exec("INSERT OR REPLACE INTO session_codex_header_meta VALUES(1,1,2); COMMIT");
      } catch(error) {this.db.exec("ROLLBACK");throw error;}
    }
  }
  get(sessionId:string,taskId:string):LocalCodexTask|undefined {
    const row=this.db.prepare("SELECT data FROM session_codex_tasks WHERE session_id=? AND id=?").get(sessionId,taskId);
    return row?JSON.parse(String(row.data)):undefined;
  }
  byRequest(sessionId:string,requestId:string):LocalCodexTask|undefined {
    const row=this.db.prepare("SELECT data FROM session_codex_tasks WHERE session_id=? AND request_id=?").get(sessionId,requestId);
    return row?JSON.parse(String(row.data)):undefined;
  }
  headerSource(sessionId:string):SessionTaskHeaderSource {
    return {readHeaders:query=>{
      const status=query.status&&query.status!=="all"?query.status:null,search=query.search||"";
      const where="session_id=? AND (? IS NULL OR status=?) AND (?='' OR local_codex_contains(search_text,?)=1)",args=[sessionId,status,status,search,search];
      const counts:Record<string,number>={all:0};
      for(const row of this.db.prepare("SELECT status,COUNT(*) n FROM session_codex_headers WHERE session_id=? GROUP BY status").all(sessionId)){counts[String(row.status)]=Number(row.n);counts.all=(counts.all??0)+Number(row.n);}
      const total=Number(this.db.prepare(`SELECT COUNT(*) n FROM session_codex_headers WHERE ${where}`).get(...args)?.n??0);
      const items:SessionTaskHeader[]=this.db.prepare(`SELECT data FROM session_codex_headers WHERE ${where} ORDER BY returned_sort DESC,time_sort DESC,id LIMIT ? OFFSET ?`).all(...args,query.limit,query.offset).map(row=>JSON.parse(String(row.data)));
      const hash=createHash("sha256");
      for(const row of this.db.prepare("SELECT id,data FROM session_codex_headers WHERE session_id=? ORDER BY id").iterate(sessionId))hash.update(JSON.stringify(row));
      const revision=hash.digest("hex");
      return {items,total,counts,directCount:counts.all??0,unavailableTasks:0,revision,sampledAt:new Date().toISOString()};
    }};
  }
  detail(sessionId:string,taskId:string) {
    const task=this.get(sessionId,taskId);
    return task?localCodexRow(task):undefined;
  }
  list(sessionId: string): LocalCodexTask[] {
    return this.db.prepare("SELECT data FROM session_codex_tasks WHERE session_id=? ORDER BY rowid").all(sessionId).map(row => JSON.parse(String(row.data)));
  }
  accept(sessionId: string, taskId: string, evidence: string) {
    if (!evidence.trim() || evidence.length > 8000) throw new Error("Provide bounded verification evidence before accepting the task");
    const task = this.get(sessionId,taskId);
    if (!task) throw new Error("Local task not found in this parent session");
    if (task.status === "done" && task.acceptance?.evidence === evidence) return task;
    if (task.status !== "review") throw new Error("Only a returned result awaiting review can be accepted");
    task.returnedAt ??= task.updatedAt; // Preserve the pre-acceptance result time for older records.
    task.status = "done";
    task.acceptance = { sessionId, evidence, acceptedAt: new Date().toISOString() };
    this.save(task);
    return task;
  }
  rows(sessionId: string) { return this.list(sessionId).map(localCodexRow); }
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
  delegate(agent: Agent, input: { requestId: string; title: string; prompt: string; executionModel?:ExecutionModelChoice; reasoningEffort?: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!input.requestId.trim() || input.requestId.length > 200 || !input.title.trim() || input.title.length > 240 || !input.prompt.trim() || input.prompt.length > 100000) throw new Error("Provide a commandId, title and bounded full task description");
    if (this.closing) throw new Error("Local Codex service is stopping");
    if (this.ctx.get("taskSystem")?.native?.scopeFor(agent)) throw new Error("Local Codex delegation is for local user sessions, not scheduler-owned executions");
    const cwd = agent.session.header.cwd;
    if (!cwd || !isAbsolute(cwd)) throw new Error("Select a workspace before delegating to Codex");
    const policy = agent.ctx.get("sandboxPolicy")?.resolve({ session: agent.session });
    if (!policy) throw new Error("Parent sandbox policy is unavailable; Codex was not started");
    localCodexPermission(policy.mode);
    const requested=input.executionModel?ExecutionModelChoice.parse(input.executionModel):undefined;
    if(requested && (requested.provider!=="openai" || (requested.backend!==undefined && requested.backend!=="codex") || (requested.kind!==undefined && requested.kind!=="official-codex") || requested.resume))throw new Error("Local Codex requires provider=openai and backend=codex without resume");
    if(requested && input.reasoningEffort!==undefined)throw new Error("Use executionModel only; reasoningEffort is a legacy alias");
    if(requested && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(requested.model))throw new Error("Invalid Codex model");
    const prior = this.store.byRequest(String(agent.id),input.requestId);
    if (prior) {
      if ((JSON.stringify(requested ?? null)!==JSON.stringify(prior.requestedModel ?? null)) || prior.title !== input.title || prior.description !== input.prompt || prior.cwd !== cwd || (input.reasoningEffort !== undefined && prior.reasoningEffort !== input.reasoningEffort)) throw new Error("requestId already used with different instructions or reasoningEffort");
      return this.receipt(prior);
    }
    if (this.active.size >= this.config.maxConcurrent) throw new Error("Local Codex capacity reached; wait for an existing job before retrying");
    const task: LocalCodexTask = {
      id: `local-codex-${randomUUID()}`, sessionId: String(agent.id), requestId: input.requestId,
      title: input.title, description: input.prompt, cwd, model: requested?.model ?? this.config.model, reasoningEffort: localCodexReasoningEffort(requested?.reasoningEffort ?? input.reasoningEffort, this.config.reasoningEffort),...(requested?{requestedModel:requested}:{}),
      parentMode: policy.mode, cliPath: findDesktopCodex(this.config.cliPath), status: "queued",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const controller = new AbortController();
    this.store.save(task);
    try {
      task.jobId = this.ctx.jobs.start({ kind: "codex", label: task.title, owner: agent.id, run: () => {
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
    return { taskId: task.id, requested:task.requestedModel ?? null,resolved:{provider:"openai",model:task.model,reasoningEffort:task.reasoningEffort,backend:"codex"}, jobId: task.jobId, status: task.status, model: task.model, reasoningEffort: task.reasoningEffort,
      parentMode: task.parentMode, permission: localCodexPermission(task.parentMode),
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
