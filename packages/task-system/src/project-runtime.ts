import { nativeProjectSession, type NativeProjectSession } from "./project-session-protocol.js";
import type { ProjectSessionMove } from "./project-sessions.js";
import { temporaryTaskDirectory,temporaryTaskMetadata } from "./remote/project-workspace.js";
import type { TaskSystemService } from "./dsh-plugin.js";
import type {} from "@deepseek-ai/dsh-session-persistence-jsonl";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  foldSurface,
  deriveEventMessage,
  foldRequestHeader,
} from "@deepseek-ai/dsh-session";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  writeFileSync,
  existsSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { TaskLedger, TaskError, canonical } from "./ledger.js";
import { Workbench } from "./workbench.js";
import { WorkspaceManager } from "./workspaces.js";
import { ScheduledPlans } from "./scheduled-plans.js";
import type { TaskPlanner, PlanningInput } from "./planning.js";
import type { ExecutionRoute, Json, Role, Report } from "./contracts.js";

const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const reportHtmlPresentation = (report: Report) => {
  const data=report.data;
  if(!data||typeof data!=="object"||Array.isArray(data))return null;
  const presentation=data.presentation;
  return presentation&&typeof presentation==="object"&&!Array.isArray(presentation)&&presentation.mediaType==="text/html"&&typeof presentation.body==="string"&&presentation.body.length<=2_000_000?{mediaType:"text/html" as const,body:presentation.body}:null;
};
const reportReadingVersion = (report: Report) => {const presentation=reportHtmlPresentation(report);return digest({title:report.title,body:report.body,revision:report.revision,artifactIds:report.artifactIds,...(presentation?{presentation}:{})});};
const now = () => new Date().toISOString();
const text = (v: unknown, limit: number) => {
  if (typeof v !== "string" || !v.trim() || v.length > limit)
    throw new TaskError("INVALID", "Invalid text length");
  return v.trim();
};
const TOOLS = [
  "task_nodes",
  "task_plan",
  "task_dispatch",
  "task_query",
  "task_history",
  "task_wait",
];
interface ProjectRow {
  taskId?: string;
  id: string;
  command: string;
  digest: string;
  root: string;
  cwd: string;
  title: string;
  goal: string;
  session: string;
  generation: number;
  state: string;
}
interface TurnRow {
  command: string;
  digest: string;
  owner: string;
  session: string;
  text: string;
  state: string;
  error: string | null;
  created: string;
}
export type ProjectWorkspaceSelection =
  | { kind: "registered"; nodeId: string; workspaceId: string }
  | { kind: "directory"; nodeId: string; path: string };
type ProjectWorkspaceBinding = { workspaceId: string; nodeId: string; path: string; scope?: "coordinator" };
interface ProjectCreateInput { commandId: string; title: string; goal: string; selection?: ProjectAgentOptions; workspace?: ProjectWorkspaceSelection }

export interface ProjectAgentOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

/** Authenticated owner operations. Model tools never select a directory or project ID. */
export class ProjectRuntime {
  collaboration?: import("./project-collaboration/authority.js").ProjectCollaborationAuthority;
  private readonly db;
  private readonly workbench: Workbench;
  private readonly jobs = new Map<
    string,
    { done: Promise<void>; abort: AbortController }
  >();
  private accepting = true;
  private readonly placementHandles = new Set<Awaited<ReturnType<Context["agents"]["resume"]>>>();
  private readonly resultRetries = new Map<string,Promise<unknown>>();
  planner?: TaskPlanner;
  private readonly temporaryCreations = new Map<
    string,
    { digest: string; done: Promise<{ taskId: string; dispatchState: string }> }
  >();
  private readonly adhocCreations = new Map<string, Promise<ProjectRow>>();
  private readonly creations = new Map<
    string,
    { digest: string; done: Promise<{ projectId: string }> }
  >();
  constructor(
    private ctx: Context,
    readonly ledger: TaskLedger,
    private nodeId: string,
    private role: Role,
    private agentOptions: ProjectAgentOptions | null = null,
  ) {
    this.db = ledger.managementDatabase();
    this.workbench = new Workbench(ledger);
    ledger.projectSnapshot = (nodeId) => this.snapshotForNode(nodeId) as unknown as import("./contracts.js").Json;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS pr_settings(id INTEGER PRIMARY KEY CHECK(id=1),root TEXT,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_project_workspaces(project TEXT PRIMARY KEY,workspace TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_session_locations(session TEXT PRIMARY KEY,project TEXT NOT NULL,generation INTEGER NOT NULL,binding TEXT NOT NULL,operation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_task_presentation(task TEXT PRIMARY KEY,visibility TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_report_reads(report TEXT NOT NULL,version TEXT NOT NULL,read_at TEXT NOT NULL,PRIMARY KEY(report,version));
      CREATE TABLE IF NOT EXISTS pr_task_routes(task TEXT PRIMARY KEY,route TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_models(owner TEXT PRIMARY KEY,selection TEXT,revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO pr_settings VALUES(1,NULL,0);
      CREATE TABLE IF NOT EXISTS pr_projects(id TEXT PRIMARY KEY,command TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,root TEXT NOT NULL,cwd TEXT NOT NULL,title TEXT NOT NULL,goal TEXT NOT NULL,session TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_adhoc(id TEXT PRIMARY KEY,task TEXT UNIQUE NOT NULL,root TEXT NOT NULL,cwd TEXT NOT NULL,session TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_sessions(session TEXT PRIMARY KEY,owner TEXT NOT NULL,generation INTEGER NOT NULL,summary TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_turns(command TEXT PRIMARY KEY,digest TEXT NOT NULL,owner TEXT NOT NULL,session TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,error TEXT,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_dispatch(task TEXT PRIMARY KEY,decision TEXT NOT NULL,candidates TEXT NOT NULL,state TEXT NOT NULL,run TEXT,generation INTEGER NOT NULL,attempted TEXT NOT NULL,updated TEXT NOT NULL);`);
    // Existing project sessions keep their IDs; the column now names the
    // conversation owner, which can be a real project or a temporary task.
    for (const table of ["pr_sessions", "pr_turns"]) {
      if (
        this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((c) => c.name === "project")
      )
        this.db.exec(`ALTER TABLE ${table} RENAME COLUMN project TO owner`);
    }
    this.db
      .prepare(
        "UPDATE pr_turns SET state='interrupted',error='HOST_RESTART' WHERE state IN ('queued','running')",
      )
      .run();
    this.db
      .prepare("UPDATE pr_projects SET state='ready' WHERE state='handoff'")
      .run();
    // Reconcile a committed dispatch whose project link was interrupted by exit.
    for (const row of this.db
      .prepare("SELECT data FROM entities WHERE kind='decision'")
      .all()) {
      const record = JSON.parse(String(row.data)) as {
        decisionId: string;
        input?: PlanningInput;
      };
      if (!record.input?.projectId && !record.input?.taskId) continue;
      const p = this.db
        .prepare("SELECT id FROM pr_projects WHERE id=?")
        .get(record.input.projectId ?? "");
      const applied = this.ledger.commandReceipt(
        `apply-decision:${record.decisionId}`,
      )?.value as { taskId?: string; deferred?: boolean } | undefined;
      if (p && applied?.taskId)
        this.workbench.manage(
          `pr:${record.input.projectId}:task:${applied.taskId}`,
          "link_backlog_task",
          { backlogId: `pr:${record.input.projectId}`, taskId: applied.taskId },
        );
      if (
        (p || record.input?.taskId === applied?.taskId) &&
        applied?.taskId &&
        applied.deferred
      )
        this.enqueueDecision(record.decisionId, applied.taskId);
    }
  }
  private authorize() {
    this.ledger.assertManagementWritable();
    if (!this.accepting || this.role === "executor")
      throw new TaskError(
        "FORBIDDEN",
        "Project scheduling requires an active planner",
      );
  }
  settings() {
    return this.db
      .prepare("SELECT root,revision FROM pr_settings WHERE id=1")
      .get() as { root: string | null; revision: number };
  }
  saveSettings(input: { root: string; expectedRevision: number }) {
    this.authorize();
    if (!isAbsolute(text(input.root, 4096)))
      throw new TaskError("INVALID", "Project root must be absolute");
    if (this.settings().revision !== input.expectedRevision)
      throw new TaskError("CONFLICT", "Project settings changed");
    mkdirSync(input.root, { recursive: true });
    const root = realpathSync(input.root);
    const result = this.db
      .prepare(
        "UPDATE pr_settings SET root=?,revision=revision+1 WHERE id=1 AND revision=?",
      )
      .run(root, input.expectedRevision);
    if (!result.changes)
      throw new TaskError("CONFLICT", "Project settings changed");
    return this.settings();
  }
  workspaceOptions() {
    const roots = [...new Set([this.settings().root, ...(this.ctx.get("taskSystem")?.config.workspaceRoots ?? []).map(root => root.path)].filter((path): path is string => !!path))];
    const workspaces: { workspaceId: string; nodeId: string; path: string; label: string }[] = [];
    let error: string | null = null;
    const registry = this.ctx.get("workspaceRegistry") as unknown as
      { list(): readonly { id: string; path: string; title?: string }[] } | undefined;
    if (registry) {
      try {
        for (const item of registry.list()) {
          try {
            const path = this.existingDirectory(item.path, [item.path]);
            workspaces.push({ workspaceId: `registry:${item.id}`, nodeId: this.nodeId, path, label: item.title?.trim() || path });
          } catch (failure) {
            if (!(failure instanceof TaskError) || failure.code !== "WORKSPACE_POLICY") throw failure;
          }
        }
      } catch {
        workspaces.length = 0;
        error = "本机工作区读取失败，请刷新重试；若仍失败，请检查 DSH 工作区服务。";
      }
    }
    // Legacy task grants remain valid local authorization, independent of remote heartbeat inventory.
    const node = this.ledger.decisionCatalog().nodes.find(node => node.nodeId === this.nodeId);
    for (const item of this.ledger.registeredWorkspaces(this.nodeId)) {
      if (item.workspaceId.startsWith("registry:") || item.state !== "ready" || !node?.enabled || !node.workspaceIds.includes(item.workspaceId) || workspaces.some(workspace => workspace.path === item.path)) continue;
      try {
        const path = this.existingDirectory(item.path, [item.path]);
        workspaces.push({ workspaceId: item.workspaceId, nodeId: this.nodeId, path, label: item.label?.trim() || path });
      } catch (failure) {
        if (!(failure instanceof TaskError) || failure.code !== "WORKSPACE_POLICY") throw failure;
      }
    }
    if (!registry && !workspaces.length) error = "本机工作区服务尚未加载，请启用 DSH 工作区服务后刷新，或选择已有目录。";
    return { nodeId: this.nodeId, roots, workspaces, error };
  }
  projectWorkspace(projectId: string): ProjectWorkspaceBinding | undefined {
    const row = this.db.prepare("SELECT workspace FROM pr_project_workspaces WHERE project=?").get(projectId);
    return row ? JSON.parse(String(row.workspace)) as ProjectWorkspaceBinding : undefined;
  }
  private selectedWorkspace(selection: ProjectWorkspaceSelection, projectId: string): ProjectWorkspaceBinding {
    if (selection.nodeId !== this.nodeId) throw new TaskError("WORKSPACE_POLICY", "Project workspace must belong to this scheduler");
    if (selection.kind === "registered") {
      const workspace = this.workspaceOptions().workspaces.find(workspace => workspace.workspaceId === selection.workspaceId);
      if (!workspace) throw new TaskError("WORKSPACE_POLICY", "Local workspace is unavailable or its registration/grant changed; refresh and select again");
      return {workspaceId:workspace.workspaceId,nodeId:this.nodeId,path:workspace.path,scope:"coordinator"};
    }
    const path = this.existingDirectory(selection.path, this.workspaceOptions().roots);
    return {workspaceId:`pr:${projectId}:selected`,nodeId:this.nodeId,path,scope:"coordinator"};
  }
  executionSettings(projectId: string) {
    this.authorize();
    const p=this.project(projectId), settings=this.ledger.projectExecutionSettings.read(projectId), old=this.projectWorkspace(projectId);
    // Pre-settings bindings described an execution workspace. They are not the coordinator's cwd.
    const legacy=old && old.scope!=="coordinator" ? old : undefined;
    const executionBindings=settings.revision===0 && legacy ? {[legacy.nodeId]:legacy.workspaceId,...settings.executionBindings} : settings.executionBindings;
    const nodes=this.ledger.decisionCatalog().nodes.filter(node=>node.roles.some(role=>role==="executor"||role==="both"));
    return {...settings,executionBindings,coordinatorWorkspace:old?.scope==="coordinator" ? old : {workspaceId:`pr:${p.id}:planner`,nodeId:this.nodeId,path:p.cwd,scope:"coordinator" as const},
      coordinatorSession:{sessionId:p.session,generation:p.generation},coordinatorOptions:this.workspaceOptions(),
      executors:nodes.map(node=>({...this.ledger.executorWorkspaceCatalog(node.nodeId),enabled:node.enabled,state:this.ledger.nodeStatuses().find(status=>status.nodeId===node.nodeId)?.state ?? "unknown"})),
      effect:"新执行使用保存的限制；已领取继续原上下文，尚未领取且设置失效的请求需人工处理，不自动换目录。"};
  }
  nativeSession(sessionId: string): NativeProjectSession | undefined {
    const row = this.db.prepare("SELECT binding FROM pr_session_locations WHERE session=?").get(sessionId);
    return row ? nativeProjectSession.parse(JSON.parse(String(row.binding))) : undefined;
  }
  placementProject(projectId: string) { this.authorize(); return { ...this.project(projectId) }; }
  checkPlacement(input: ProjectSessionMove) {
    this.authorize();
    const project = this.project(input.projectId);
    if (project.session !== input.old.sessionId || project.generation !== input.old.generation || this.ledger.projectExecutionSettings.read(project.id).revision !== input.expectedRevision)
      throw new TaskError("CONFLICT", "Project settings changed; reload before saving");
    if (project.state !== "ready") throw new TaskError("BUSY", "Project is changing its session");
    this.validateExecutionBindings(input.allowedNodeIds, input.executionBindings);
    if (this.ledger.dispatcherForSession(input.old.nodeId, input.old.sessionId) || this.db.prepare("SELECT command FROM pr_turns WHERE session=? AND state IN ('queued','running')").get(input.old.sessionId))
      throw new TaskError("BUSY", "Wait for the original session's managed turn or dispatcher to settle");
  }
  commitPlacement(input: ProjectSessionMove, next: NativeProjectSession) {
    this.checkPlacement(input);
    const workspaceId = `pr:${input.projectId}:coordinator:${digest({ nodeId: next.nodeId, workspaceId: next.workspaceId, cwd: next.cwd }).slice(0, 24)}`;
    const binding = { workspaceId, nodeId: next.nodeId, path: next.cwd, scope: "coordinator" };
    this.ledger.registerCoordinatorWorkspace({ workspaceId, nodeId: next.nodeId, path: next.cwd, label: this.project(input.projectId).title, state: "ready", createdAt: now() });
    this.ledger.projectExecutionSettings.save({ projectId: input.projectId, expectedRevision: input.expectedRevision, allowedNodeIds: input.allowedNodeIds, executionBindings: input.executionBindings });
    this.db.prepare("INSERT INTO pr_project_workspaces VALUES(?,?) ON CONFLICT(project) DO UPDATE SET workspace=excluded.workspace").run(input.projectId, canonical(binding));
    this.db.prepare("INSERT INTO pr_session_locations VALUES(?,?,?,?,?)").run(next.sessionId, input.projectId, next.generation, canonical(next), input.operationId);
    this.db.prepare("INSERT INTO pr_sessions VALUES(?,?,?,?,?)").run(next.sessionId, input.projectId, next.generation, `Continues generation ${input.old.generation} on ${next.nodeId}`, now());
    this.db.prepare("UPDATE pr_projects SET root=?,cwd=?,session=?,generation=?,state='ready' WHERE id=? AND session=? AND generation=?").run(next.cwd, next.cwd, next.sessionId, next.generation, input.projectId, input.old.sessionId, input.old.generation);
    this.db.prepare("UPDATE wb_project_workspaces SET is_default=0,revision=revision+1 WHERE project_id=? AND is_default=1").run(input.projectId);
    this.db.prepare("INSERT INTO wb_project_workspaces(project_id,workspace_id,node_id,is_default,revision) VALUES(?,?,?,1,1) ON CONFLICT(project_id,workspace_id) DO UPDATE SET is_default=1,revision=revision+1").run(input.projectId, workspaceId, next.nodeId);
  }
  async restoreManagedPlacement(binding: Extract<import("./project-session-protocol.js").ProjectSessionReference, { kind: "managed" }>) {
    const project = this.project(binding.projectId);
    if (this.nativeSession(binding.sessionId) || binding.nodeId !== this.nodeId) throw new TaskError("FORBIDDEN", "Managed placement belongs to another runtime");
    const persistence = this.ctx.get("sessionPersistence");
    if (!persistence) throw new TaskError("UNAVAILABLE", "Session persistence unavailable");
    const read = await persistence.open(SessionId(binding.sessionId), "read");
    let recorded;
    try { recorded = foldRequestHeader((await read.read()).events); }
    finally { await read.close(); }
    const handle = await this.agents().resume({ resumeSessionId: SessionId(binding.sessionId),
      agentOptions: recorded ? { provider: recorded.config.provider, model: recorded.config.model, ...(recorded.config.reasoningEffort ? { reasoningEffort: recorded.config.reasoningEffort } : {}) } : this.options(project.id),
      setup: (agentCtx, agent) => {
        agentCtx.tools.restrict({ allow: TOOLS });
        agentCtx.tools.guard(exec => exec.agent === agent && TOOLS.includes(exec.name) ? undefined : "Project dispatch tools only");
      },
    });
    this.placementHandles.add(handle);
    return handle.agent;
  }
  saveExecutionPolicy(input: { projectId: string; expectedRevision: number; allowedNodeIds: string[] | null; executionBindings: Record<string, string> }) {
    this.authorize();
    if (this.project(input.projectId).state !== "ready") throw new TaskError("BUSY", "Project is changing its session");
    this.validateExecutionBindings(input.allowedNodeIds, input.executionBindings);
    return this.ledger.projectExecutionSettings.save({projectId:input.projectId,expectedRevision:input.expectedRevision,allowedNodeIds:input.allowedNodeIds,executionBindings:input.executionBindings});
  }
  legacyConversation(projectId: string, sessionId: string, generation: number, cwd: string) {
    return this.readConversation({ ...this.project(projectId), session: sessionId, generation, cwd });
  }
  private validateExecutionBindings(allowedNodeIds:string[]|null,executionBindings:Record<string,string>) {
    const nodes=this.ledger.decisionCatalog().nodes;
    for(const nodeId of allowedNodeIds ?? []) if(!nodes.some(node=>node.nodeId===nodeId&&node.roles.some(role=>role==="executor"||role==="both")))throw new TaskError("FORBIDDEN","Unknown executor in project policy");
    for(const [nodeId,workspaceId] of Object.entries(executionBindings)) {
      const node=nodes.find(node=>node.nodeId===nodeId),workspace=this.ledger.executorWorkspaceCatalog(nodeId).workspaces.find(workspace=>workspace.workspaceId===workspaceId);
      if(!node?.enabled || !node.workspaceIds.includes(workspaceId) || workspace?.state!=="ready")throw new TaskError("WORKSPACE_POLICY","Executor workspace is unavailable or its grant changed; refresh and select again");
    }
  }
  async saveExecutionSettings(input: {projectId:string;expectedRevision:number;allowedNodeIds:string[]|null;executionBindings:Record<string,string>;coordinatorWorkspace?:ProjectWorkspaceSelection}) {
    this.authorize();
    const p=this.project(input.projectId);
    if(this.nativeSession(p.session))throw new TaskError("CONFLICT","Refresh project settings and use the owner workspace catalog for this native session");
    if(p.state!=="ready")throw new TaskError("BUSY","Project is changing its coordinator session");
    if(this.ledger.projectExecutionSettings.read(p.id).revision!==input.expectedRevision)throw new TaskError("CONFLICT","Project settings changed; reload before saving");
    this.validateExecutionBindings(input.allowedNodeIds,input.executionBindings);
    const selected=input.coordinatorWorkspace ? this.selectedWorkspace(input.coordinatorWorkspace,p.id) : undefined;
    const cwd=selected?.path ?? p.cwd,moving=cwd!==p.cwd;
    // A path-specific coordinator identity keeps historical workspace entities immutable.
    const binding:ProjectWorkspaceBinding={workspaceId:`pr:${p.id}:coordinator:${digest({nodeId:this.nodeId,cwd}).slice(0,24)}`,nodeId:this.nodeId,path:cwd,scope:"coordinator"};
    if(moving)this.lockCoordinator(p);
    try {
      const next=moving ? await this.prepareCoordinatorGeneration(p,cwd) : undefined;
      this.authorize();
      this.validateExecutionBindings(input.allowedNodeIds,input.executionBindings);
      if(input.coordinatorWorkspace && this.selectedWorkspace(input.coordinatorWorkspace,p.id).path!==cwd)throw new TaskError("WORKSPACE_POLICY","Coordinator registration changed while preparing the session");
      // Metadata creates no executor grant. Its immutable identity is safe even if the settings CAS later loses.
      if(!this.ledger.registeredWorkspaces(this.nodeId).some(workspace=>workspace.workspaceId===binding.workspaceId))
        this.ledger.registerWorkspace(`project-coordinator-workspace:${digest(binding)}`,{...binding,label:p.title,state:"ready",createdAt:now()});
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.ledger.projectExecutionSettings.save({projectId:p.id,expectedRevision:input.expectedRevision,allowedNodeIds:input.allowedNodeIds,executionBindings:input.executionBindings});
        this.db.prepare("INSERT INTO pr_project_workspaces(project,workspace) VALUES(?,?) ON CONFLICT(project) DO UPDATE SET workspace=excluded.workspace").run(p.id,canonical(binding));
        // Workbench consumers share the coordinator authority; keep old links as non-default history.
        this.db.prepare("UPDATE wb_project_workspaces SET is_default=0,revision=revision+1 WHERE project_id=? AND is_default=1 AND workspace_id<>?").run(p.id,binding.workspaceId);
        this.db.prepare("INSERT INTO wb_project_workspaces(project_id,workspace_id,node_id,is_default,revision) VALUES(?,?,?,1,1) ON CONFLICT(project_id,workspace_id) DO UPDATE SET is_default=1,revision=revision+1").run(p.id,binding.workspaceId,this.nodeId);
        if(next) {
          this.db.prepare("INSERT INTO pr_sessions VALUES(?,?,?,?,?)").run(next.sessionId,p.id,next.generation,next.summary,now());
          this.db.prepare("UPDATE pr_projects SET root=?,cwd=?,session=?,generation=?,state='ready' WHERE id=? AND session=?").run(cwd,cwd,next.sessionId,next.generation,p.id,p.session);
        }
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");if(error instanceof Error&&'code' in error&&error.code==='CONFLICT')throw new TaskError("CONFLICT","Project settings changed; reload before saving");throw error;}
      let workspaceNotice:string|undefined;
      if(next)try{await this.syncWorkspacesFor(this.project(p.id));}catch{workspaceNotice="设置与新会话已保存；工作区侧栏同步失败，可刷新后重试。";}
      return {...this.executionSettings(p.id),coordinatorSessionChanged:!!next,...(workspaceNotice?{workspaceNotice}:{})};
    } finally {
      if(moving)this.db.prepare("UPDATE pr_projects SET state='ready' WHERE id=? AND state='handoff'").run(p.id);
    }
  }
  private lockCoordinator(p:ProjectRow) {
    const live=this.ctx.get("agents")?.get(SessionId(p.session));
    if(this.db.prepare("SELECT command FROM pr_turns WHERE owner=? AND state IN ('running','queued')").get(p.id) || live && (live.status!=="idle" || live.inbox.nextTurn.length || live.inbox.nextStep.length) || this.ledger.dispatcherForSession(this.nodeId,p.session))
      throw new TaskError("BUSY","Wait for the managed coordinator turn/dispatcher task to settle before changing its workspace");
    if(p.state!=="ready" || !this.db.prepare("UPDATE pr_projects SET state='handoff' WHERE id=? AND state='ready'").run(p.id).changes)throw new TaskError("BUSY","Project is changing its session");
  }
  private async prepareCoordinatorGeneration(p:ProjectRow,cwd:string) {
    const history=await this.conversation(p.id),tasks=this.snapshot().tasks.filter(task=>p.taskId?task.id===p.taskId:task.project===p.id);
    const summary=`项目目标：${p.goal}\n原统筹会话：${p.session}\n未完成任务（沿用原任务，不要重复创建）：${JSON.stringify(tasks.filter(task=>!["done","accepted"].includes(task.status)))}\n已完成或已验收任务的报告引用：${JSON.stringify(tasks.filter(task=>["done","accepted"].includes(task.status)).map(task=>({taskId:task.id,run:task.run,reportId:task.reportId})))}\n近期对话：${JSON.stringify(history.messages.slice(-16)).slice(-24000)}`;
    const sessionId=`project-${randomUUID()}`,generation=p.generation+1;
    const handle=await this.agents().create({sessionId:SessionId(sessionId),meta:{cwd},agentOptions:this.options(p.id)});
    try {await (this.ctx.get("sessions") as Context["sessions"]).flush(handle.agent.session);} finally {await handle.dispose();}
    return {sessionId,generation,summary};
  }
  private existingDirectory(path: string, roots: string[]) {
    if (!isAbsolute(path) || path.split(/[\\/]/).some(part => part === "..")) throw new TaskError("WORKSPACE_POLICY", "Expected an absolute existing directory within a controlled root");
    const root = roots.find(root => {const rel = relative(root,path);return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);});
    if (!root) throw new TaskError("WORKSPACE_POLICY", "Directory is outside controlled roots");
    let current = root;
    try {
      if (realpathSync(root) !== join(root)) throw new TaskError("WORKSPACE_POLICY", "Controlled root must retain its canonical physical directory");
      for (const part of ["", ...relative(root,path).split(sep).filter(Boolean)]) {
        current = join(current,part);
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TaskError("WORKSPACE_POLICY", "Symlink or non-directory in selected workspace");
      }
      const actual = realpathSync(path), rel = relative(realpathSync(root),actual);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new TaskError("WORKSPACE_POLICY", "Resolved directory escapes controlled root");
      return actual;
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskError("WORKSPACE_POLICY", "Selected directory does not exist or is unavailable");
    }
  }
  private project(id: string): ProjectRow {
    const row = this.db
      .prepare("SELECT * FROM pr_projects WHERE id=?")
      .get(id) as unknown as ProjectRow | undefined;
    if (!row) throw new TaskError("NOT_FOUND", "Project runtime not found");
    return row;
  }
  private modelSelection(owner: string) {
    const row = this.db
      .prepare("SELECT selection,revision FROM pr_models WHERE owner=?")
      .get(owner) as { selection: string | null; revision: number } | undefined;
    return {
      selection: row?.selection
        ? (JSON.parse(row.selection) as ProjectAgentOptions)
        : null,
      revision: row?.revision ?? 0,
    };
  }
  async modelCatalog() {
    this.authorize();
    const llm = this.ctx.get("llm");
    if (!llm) throw new TaskError("CONFIGURATION", "Model service unavailable");
    const providers = await Promise.all(
      llm.listProviders().map(async (provider) => ({
        id: provider.id,
        name: provider.name,
        models: await Promise.all(
          (await llm.listModels(provider.id)).map(async (model) => {
            const info = await llm.resolveModelInfo(provider.id, model.id);
            return {
              id: model.id,
              name: model.name,
              reasoningEfforts:
                info?.reasoning?.efforts?.map((e) => e.id) ?? [],
            };
          }),
        ),
      })),
    );
    return { providers, defaultSelection: this.agentOptions };
  }
  async selectModel(input: {
    projectId?: string;
    taskId?: string;
    expectedRevision: number;
    selection: ProjectAgentOptions | null;
  }) {
    this.authorize();
    if (!!input.projectId === !!input.taskId)
      throw new TaskError("INVALID", "Select one conversation owner");
    const p = input.taskId
      ? this.adhoc(input.taskId)
      : this.project(input.projectId!);
    if (
      this.db
        .prepare(
          "SELECT command FROM pr_turns WHERE owner=? AND state IN ('queued','running')",
        )
        .get(p.id)
    )
      throw new TaskError("BUSY", "Conversation is responding");
    if (this.modelSelection(p.id).revision !== input.expectedRevision)
      throw new TaskError("CONFLICT", "Conversation model changed");
    if (input.selection) {
      const catalog = await this.modelCatalog(),
        provider = catalog.providers.find(
          (row) => row.id === input.selection!.provider,
        ),
        model = provider?.models.find(
          (row) => row.id === input.selection!.model,
        );
      if (
        !model ||
        (input.selection.reasoningEffort &&
          !model.reasoningEfforts.includes(
            ReasoningEffortId(input.selection.reasoningEffort),
          ))
      )
        throw new TaskError(
          "INVALID",
          "Conversation model or effort is unavailable",
        );
    }
    this.authorize();
    // Recheck after model metadata reads; an accepted turn retains its chosen model.
    if (
      this.db
        .prepare(
          "SELECT command FROM pr_turns WHERE owner=? AND state IN ('queued','running')",
        )
        .get(p.id)
    )
      throw new TaskError("BUSY", "Conversation is responding");
    if (this.modelSelection(p.id).revision !== input.expectedRevision)
      throw new TaskError("CONFLICT", "Conversation model changed");
    this.db
      .prepare(
        "INSERT INTO pr_models VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET selection=excluded.selection,revision=excluded.revision",
      )
      .run(
        p.id,
        input.selection ? canonical(input.selection) : null,
        input.expectedRevision + 1,
      );
    return this.modelSelection(p.id);
  }
  private options(owner?: string) {
    const selected =
      (owner ? this.modelSelection(owner).selection : null) ??
      this.agentOptions;
    if (!selected?.provider || !selected.model)
      throw new TaskError(
        "CONFIGURATION",
        "Project conversation model is not configured",
      );
    const { reasoningEffort, ...options } = selected;
    return {
      ...options,
      ...(reasoningEffort
        ? { reasoningEffort: ReasoningEffortId(reasoningEffort) }
        : {}),
    };
  }
  private agents() {
    if (
      !this.ctx.get("agents") ||
      !this.ctx.get("sessions") ||
      !this.ctx.get("sessionPersistence")
    )
      throw new TaskError(
        "CONFIGURATION",
        "Native session services are unavailable",
      );
    return this.ctx.get("agents") as Context["agents"];
  }
  private exclusiveFile(path: string, contents: string) {
    if (!existsSync(path))
      writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
    else if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || readFileSync(path, "utf8") !== contents)
      throw new TaskError("CONFLICT", "Project context file already differs");
  }
  create(input: ProjectCreateInput) {
    this.authorize();
    const key = text(input.commandId, 200),
      hash = digest(input),
      existing = this.creations.get(key);
    if (existing) {
      if (existing.digest !== hash)
        throw new TaskError("CONFLICT", "Project command reused");
      return existing.done;
    }
    const done = this.createOwned(input).finally(() =>
      this.creations.delete(key),
    );
    this.creations.set(key, { digest: hash, done });
    return done;
  }
  private async createOwned(input: ProjectCreateInput) {
    this.authorize();
    this.agents();
    const command = text(input.commandId, 200),
      title = text(input.title, 500),
      goal = text(input.goal, 20000);
    const hash = digest({ title, goal, ...(input.selection ? {selection: input.selection} : {}), ...(input.workspace ? {workspace:input.workspace} : {}) });
    let p = this.db
      .prepare("SELECT * FROM pr_projects WHERE command=?")
      .get(command) as unknown as ProjectRow | undefined;
    if (p && p.digest !== hash)
      throw new TaskError("CONFLICT", "Project command reused");
    if (!p) {
      const selected = input.selection ?? this.agentOptions;
      if (!selected?.provider || !selected.model)
        throw new TaskError("PROJECT_MODEL_REQUIRED", "Select a project conversation model");
      if (input.selection) {
        const catalog = await this.modelCatalog();
        const model = catalog.providers.find(row => row.id === selected.provider)?.models.find(row => row.id === selected.model);
        if (!model || (selected.reasoningEffort && !model.reasoningEfforts.includes(ReasoningEffortId(selected.reasoningEffort))))
          throw new TaskError("PROJECT_MODEL_UNAVAILABLE", "Selected project model or effort is unavailable");
      }
      this.authorize();
      const id = randomUUID(), binding = input.workspace ? this.selectedWorkspace(input.workspace, id) : undefined;
      const root = binding?.nodeId === this.nodeId ? binding.path : this.settings().root;
      if (!root)
        throw new TaskError("PROJECT_ROOT_REQUIRED", "Set the project root first");
      const session = `project-${randomUUID()}`,
        cwd = binding?.nodeId === this.nodeId ? binding.path : join(root, `project-${id}`);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT INTO pr_projects VALUES(?,?,?,?,?,?,?,?,1,?)")
          .run(id, command, hash, root, cwd, title, goal, session, "creating");
        if (binding) this.db.prepare("INSERT INTO pr_project_workspaces VALUES(?,?)").run(id, canonical(binding));
        if (input.selection) this.db.prepare("INSERT INTO pr_models VALUES(?,?,?)").run(id, canonical(input.selection), 1);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      p = this.project(id);
    }
    this.options(p.id);
    if (p.state === "ready") {
      await this.syncWorkspaces();
      return { projectId: p.id };
    }
    this.workbench.manage(`pr:${p.id}:project`, "create_project", {
      projectId: p.id,
      title,
      goal,
      description: goal,
      state: "active",
      nextStep: "向统筹端描述下一项工作",
    });
    this.workbench.manage(`pr:${p.id}:backlog`, "create_backlog", {
      backlogId: `pr:${p.id}`,
      projectId: p.id,
      title: "项目任务",
      goal,
    });
    const binding = this.projectWorkspace(p.id);
    let workspace;
    if (binding?.nodeId === this.nodeId) {
      this.existingDirectory(binding.path, [p.root]);
      if (input.workspace?.kind === "registered" && this.selectedWorkspace(input.workspace,p.id).path !== binding.path)
        throw new TaskError("WORKSPACE_POLICY", "Local workspace path changed; refresh and select again");
      workspace = this.ledger.snapshot().workspaces?.find(workspace => workspace.workspaceId === binding.workspaceId)
        ?? this.ledger.registerWorkspace(`pr:${p.id}:directory`, {...binding,label:title,state:"ready",createdAt:now()}).value;
      if (binding.scope !== "coordinator") {
        const node = this.ledger.decisionCatalog().nodes.find(node => node.nodeId === this.nodeId);
        if (node && !node.workspaceIds.includes(workspace.workspaceId)) this.ledger.registerNode(`pr:${p.id}:grant`, {...node,workspaceIds:[...node.workspaceIds,workspace.workspaceId]});
      }
    } else {
      const manager = new WorkspaceManager(this.ledger, this.nodeId, [{id:"project-root",path:p.root,allowCreate:true}]);
      workspace = manager.provision(`pr:${p.id}:directory`, {workspaceId:`pr:${p.id}:planner`,rootId:"project-root",relativePath:`project-${p.id}`,label:title,mode:"create"});
    }
    this.workbench.manage(`pr:${p.id}:workspace`, "link_project_workspace", {projectId:p.id,workspaceId:binding?.workspaceId ?? workspace.workspaceId,isDefault:true});
    const metadata = binding?.nodeId === this.nodeId ? join(p.cwd,".dsh-projects",p.id) : p.cwd;
    if (metadata !== p.cwd) {
      for (const part of [join(p.cwd,".dsh-projects"),metadata]) {
        if (!existsSync(part)) mkdirSync(part,{mode:0o700});
        this.existingDirectory(part,[p.cwd]);
      }
    }
    this.exclusiveFile(
      join(metadata, "PROJECT.md"),
      `# ${title}\n\n${goal}\n\nProject ID: ${p.id}\n`,
    );
    this.exclusiveFile(
      join(metadata, "TOOLS.md"),
      `# 统筹工具\n\n${TOOLS.join(", ")}\n\n优先将工作派发给合适的闲置执行端。没有在线执行端时持久排队，等待上线。此目录用于项目上下文；执行端使用其已授权的本地工作区。纯调度端不得执行工作负载。\n`,
    );
    if (
      !(await (
        this.ctx.get("sessionPersistence") as Context["sessionPersistence"]
      ).stat(SessionId(p.session)))
    ) {
      const handle = await this.agents().create({
        sessionId: SessionId(p.session),
        meta: { cwd: p.cwd },
        agentOptions: this.options(p.id),
      });
      try {
        await (this.ctx.get("sessions") as Context["sessions"]).flush(
          handle.agent.session,
        );
      } finally {
        await handle.dispose();
      }
    }
    this.db
      .prepare("INSERT OR IGNORE INTO pr_sessions VALUES(?,?,?,?,?)")
      .run(p.session, p.id, 1, "", now());
    this.db
      .prepare("UPDATE pr_projects SET state='ready' WHERE id=?")
      .run(p.id);
    await this.syncWorkspaces();
    return { projectId: p.id };
  }
  /** Register project grouping in DSH, independently of executor workspace grants. */
  async syncWorkspaces() {
    const registry = this.ctx.get("workspaceRegistry") as unknown as
      | {
          create(
            path: string,
            title?: string,
          ): Promise<{ attachSession(session: SessionId): Promise<void> }>;
        }
      | undefined;
    if (!registry) return;
    for (const row of this.db
      .prepare("SELECT * FROM pr_projects WHERE state='ready'")
      .all() as unknown as ProjectRow[]) {
      if (!existsSync(row.cwd)) continue;
      await this.syncWorkspacesFor(row);
    }
  }
  private async syncWorkspacesFor(row: ProjectRow) {
    const registry = this.ctx.get("workspaceRegistry") as unknown as
      | {
          create(
            path: string,
            title?: string,
          ): Promise<{ attachSession(session: SessionId): Promise<void> }>;
        }
      | undefined;
    if (!registry) return;
    const persistence = this.ctx.get("sessionPersistence");
    for (const session of this.db.prepare("SELECT session FROM pr_sessions WHERE owner=? ORDER BY generation").all(row.id)) {
      const sessionId = SessionId(String(session.session));
      if (this.nativeSession(String(sessionId))?.nodeId !== undefined) continue;
      const stored = await persistence?.stat(sessionId);
      const cwd = stored?.header.cwd;
      if (!cwd || !existsSync(cwd)) continue;
      const workspace = await registry.create(cwd, row.title);
      await workspace.attachSession(sessionId);
    }
  }
  createTemporary(input: {
    commandId: string;
    title: string;
    description: string;
  }) {
    this.authorize();
    const key = text(input.commandId, 200),
      hash = digest(input),
      existing = this.temporaryCreations.get(key);
    if (existing) {
      if (existing.digest !== hash)
        throw new TaskError("CONFLICT", "Temporary command reused");
      return existing.done;
    }
    const done = this.createTemporaryOwned(input).finally(() =>
      this.temporaryCreations.delete(key),
    );
    this.temporaryCreations.set(key, { digest: hash, done });
    return done;
  }
  private async createTemporaryOwned(input: {
    commandId: string;
    title: string;
    description: string;
  }) {
    this.agents();
    this.options();
    if (!this.settings().root || !this.planner)
      throw new TaskError(
        "CONFIGURATION",
        "Configure project root and planner first",
      );
    const command = text(input.commandId, 200),
      title = text(input.title, 500),
      description = text(input.description, 20000);
    const task = this.ledger.createTask(`temporary-task:${command}`, {
      title,
      description,
    }).value;
    await this.prepareTaskConversation(task.taskId);
    const requestId = `temporary-plan:${command}`;
    if (this.ledger.commandReceipt(`apply-decision:${requestId}`)) {
      this.enqueueDecision(requestId, task.taskId);
      return { taskId: task.taskId, dispatchState: "queued" };
    }
    // Creation remains visible if routing needs clarification or a provider fails.
    // Replaying the creation command always refers to this same Task.
    try {
      const existing = this.ledger.getDecision(requestId);
      const decision = await this.planner.plan(
        (existing?.input as unknown as PlanningInput) ?? {
          requestId,
          taskId: task.taskId,
          title,
          description,
        },
      );
      this.authorize();
      if (decision.routingStatus !== "ready")
        return { taskId: task.taskId, dispatchState: "needs-planning" };
      this.planner.apply(requestId, { deferExecution: true });
      this.enqueueDecision(requestId, task.taskId);
      return { taskId: task.taskId, dispatchState: "queued" };
    } catch {
      return { taskId: task.taskId, dispatchState: "needs-planning" };
    }
  }
  private taskProject(taskId: string) {
    const wb = this.workbench.snapshot();
    const link = wb.backlogTasks.find((t) => t.taskId === taskId);
    return wb.backlogs.find((b) => b.backlogId === link?.backlogId)?.projectId;
  }
  private adhoc(taskId: string): ProjectRow {
    const task = this.ledger.getTask(taskId);
    if (this.taskProject(taskId))
      throw new TaskError("FORBIDDEN", "Use the task's project conversation");
    const row = this.db
      .prepare("SELECT * FROM pr_adhoc WHERE task=?")
      .get(taskId) as unknown as ProjectRow | undefined;
    if (!row)
      throw new TaskError(
        "NOT_FOUND",
        "Temporary task conversation not prepared",
      );
    return {
      ...row,
      taskId,
      title: task.title,
      goal: task.description || task.title,
    };
  }
  async prepareTaskConversation(taskId: string) {
    this.authorize();
    const projectId = this.taskProject(taskId);
    if (projectId) return this.conversation(projectId);
    let job = this.adhocCreations.get(taskId);
    if (!job) {
      job = this.createAdhoc(taskId).finally(() =>
        this.adhocCreations.delete(taskId),
      );
      this.adhocCreations.set(taskId, job);
    }
    return this.readConversation(await job);
  }
  private async createAdhoc(taskId: string) {
    this.agents();
    this.options();
    const task = this.ledger.getTask(taskId);
    if (this.taskProject(taskId))
      throw new TaskError("FORBIDDEN", "Use the task's project conversation");
    if (!this.db.prepare("SELECT id FROM pr_adhoc WHERE task=?").get(taskId)) {
      const root = this.settings().root;
      if (!root)
        throw new TaskError("CONFIGURATION", "Set the project root first");
      // A planner context directory, never registered as a user project or executor workspace.
      const id = `adhoc:${taskId}`,
        cwd = join(root,"temporary-tasks");
      this.db
        .prepare("INSERT INTO pr_adhoc VALUES(?,?,?,?,?,1,'creating')")
        .run(id, taskId, root, cwd, `adhoc-${randomUUID()}`);
    }
    const p = this.adhoc(taskId);
    if (p.state === "ready") return p;
    const shared=p.cwd===join(p.root,"temporary-tasks");
    const metadata=shared ? await temporaryTaskMetadata(await temporaryTaskDirectory(p.root),this.ledger.schedulerIdentity(),taskId,"planner") : p.cwd;
    mkdirSync(metadata, { recursive: true, mode: 0o700 });
    this.exclusiveFile(
      join(metadata, "TOOLS.md"),
      `# 临时任务规划\n\nTask ID: ${taskId}\n${TOOLS.join(", ")}\n仅保留轻量调度上下文。沿用原任务 ID，不创建同名任务。纯调度端不得执行工作负载。\n`,
    );
    if (
      !(await (
        this.ctx.get("sessionPersistence") as Context["sessionPersistence"]
      ).stat(SessionId(p.session)))
    ) {
      const handle = await this.agents().create({
        sessionId: SessionId(p.session),
        meta: { cwd: p.cwd },
        agentOptions: this.options(),
      });
      try {
        await (this.ctx.get("sessions") as Context["sessions"]).flush(
          handle.agent.session,
        );
      } finally {
        await handle.dispose();
      }
    }
    this.db
      .prepare("INSERT OR IGNORE INTO pr_sessions VALUES(?,?,?,?,?)")
      .run(p.session, p.id, 1, "", now());
    if(shared) {
      const registry=this.ctx.get("workspaceRegistry");
      if(registry){const workspace=await registry.create(p.cwd,"temporary-tasks");await workspace.attachSession(SessionId(p.session));}
    }
    this.db
      .prepare("UPDATE pr_adhoc SET state='ready' WHERE task=?")
      .run(taskId);
    return this.adhoc(taskId);
  }
  taskForSession(session: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT a.task FROM pr_sessions s JOIN pr_adhoc a ON a.id=s.owner WHERE s.session=?",
        )
        .get(session) as { task: string } | undefined
    )?.task;
  }
  async taskConversation(taskId: string) {
    return this.prepareTaskConversation(taskId);
  }
  sendTask(input: { taskId: string; commandId: string; text: string }) {
    this.authorize();
    this.agents();
    return this.sendOwned(
      this.adhoc(input.taskId),
      input.commandId,
      input.text,
    );
  }
  projectForSession(session: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT s.owner FROM pr_sessions s JOIN pr_projects p ON p.id=s.owner WHERE s.session=?",
        )
        .get(session) as { owner: string } | undefined
    )?.owner;
  }
  /** Final deterministic ownership check before dispatch, including attach decisions. */
  assertDecisionScope(session: string, requestId: string) {
    const managedProjectId = this.projectForSession(session);
    const projectId = managedProjectId ?? this.ledger.dispatchProjectId();
    const input = this.ledger.getDecision(requestId)?.input as unknown as
      | PlanningInput
      | undefined;
    if (projectId !== input?.projectId && (projectId || input?.projectId))
      throw new TaskError("FORBIDDEN", "Decision belongs to another project");
    const taskId = this.taskForSession(session);
    if (taskId !== input?.taskId && (taskId || (!projectId && input?.taskId)))
      throw new TaskError(
        "FORBIDDEN",
        "Decision belongs to another temporary task",
      );
    if (managedProjectId || taskId) {
      const turn = this.db
        .prepare(
          "SELECT command FROM pr_turns WHERE session=? AND state='running'",
        )
        .get(session) as { command: string } | undefined;
      if (!turn || requestId !== `project-message:${turn.command}`)
        throw new TaskError("FORBIDDEN", "Use the current message request ID");
    }
    if (projectId || taskId) {
      const proposal = this.ledger.getDecision(requestId)?.proposal as
        | { attachTaskId?: string }
        | undefined;
      if (
        proposal?.attachTaskId &&
        !(taskId
          ? proposal.attachTaskId === taskId
          : managedProjectId
            ? this.projectTaskIds(managedProjectId).includes(proposal.attachTaskId)
            : this.ledger.projectForTask(proposal.attachTaskId) === projectId)
      )
        throw new TaskError(
          "FORBIDDEN",
          "Cannot attach a task from another project",
        );
    }
  }
  assertProposalScope(
    session: string,
    input: {
      requestId: string;
      route?: unknown;
      workspaceId?: unknown;
      provider?: unknown;
      model?: unknown;
      reasoningEffort?: unknown;
    },
  ) {
    if (!this.projectForSession(session) && !this.taskForSession(session))
      return;
    const turn = this.db
      .prepare(
        "SELECT command FROM pr_turns WHERE session=? AND state='running'",
      )
      .get(session) as { command: string } | undefined;
    if (!turn || input.requestId !== `project-message:${turn.command}`)
      throw new TaskError("FORBIDDEN", "Use the current message request ID");
    if (
      input.route ||
      input.workspaceId ||
      input.provider ||
      input.model ||
      input.reasoningEffort
    )
      throw new TaskError(
        "FORBIDDEN",
        "Project dispatch uses the configured decision catalog",
      );
  }
  linkTask(session: string, taskId: string) {
    const id = this.projectForSession(session);
    if (id)
      this.workbench.manage(`pr:${id}:task:${taskId}`, "link_backlog_task", {
        backlogId: `pr:${id}`,
        taskId,
      });
  }
  enqueueDecision(decisionId: string, taskId: string) {
    this.authorize();
    const record = this.ledger.getDecision(decisionId);
    const input = record?.input as unknown as PlanningInput | undefined;
    const proposal = record?.proposal as unknown as {
      modelRoute?: {
        executorId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
      };
      fallbackRoutes?: {
        executorId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
      }[];
    };
    const applied = this.ledger.commandReceipt(`apply-decision:${decisionId}`)
      ?.value as { taskId?: string; deferred?: boolean } | undefined;
    if (
      (!input?.projectId && input?.taskId !== taskId) ||
      applied?.taskId !== taskId ||
      !applied.deferred
    )
      return;
    const prior = this.db
      .prepare("SELECT decision FROM pr_dispatch WHERE task=?")
      .get(taskId) as { decision: string } | undefined;
    if (prior && prior.decision !== decisionId) {
      const order = (id: string) =>
        Number(
          this.db
            .prepare(
              "SELECT rowid FROM entities WHERE kind='decision' AND id=?",
            )
            .get(id)?.rowid ?? 0,
        );
      // Replanning pending work replaces its recommendation, but startup
      // reconciliation of an older receipt must never restore an older route.
      if (order(decisionId) <= order(prior.decision)) return;
    }
    const candidates = [
      ...(proposal.modelRoute ? [proposal.modelRoute] : []),
      ...(proposal.fallbackRoutes ?? []),
    ].map((r) => ({
      nodeId: r.executorId,
      provider: r.provider,
      model: r.model,
      ...(r.reasoningEffort ? { reasoningEffort: r.reasoningEffort } : {}),
      requiredCapabilities: [],
      ...(input.route && r === proposal.modelRoute ? input.route : {}),
      ...(input.workspaceId ? {workspaceId:input.workspaceId} : {}),
    }));
    this.db
      .prepare(
        `INSERT INTO pr_dispatch VALUES(?,?,?,'inbox',NULL,0,'[]',?)
         ON CONFLICT(task) DO UPDATE SET decision=excluded.decision,candidates=excluded.candidates,state='inbox',run=NULL,attempted='[]',updated=excluded.updated
         WHERE pr_dispatch.decision<>excluded.decision`,
      )
      .run(taskId, decisionId, canonical(candidates), now());
    this.tick();
  }
  /** Persisted inbox admission; only pre-claim unavailability may move to the next candidate. */
  tick() {
    if (!this.accepting) return;
    if(this.planner)for(const run of this.ledger.resultRetryCandidates()){
      if(!run.resultValidationFailure||this.resultRetries.has(run.runId))continue;
      const info=this.ledger.resultRetryInfo(run.runId);
      if(!info.eligible)continue;
      const view=this.ledger.taskActionState(run.taskId);
      if(!view.canRetry)continue;
      const feedback=`报告校验失败，自动重试 ${info.count+1}/${info.limit}。沿用原任务会话和已有成果，结合原上下文判断需要修正报告还是补做任务。无需重复提供已有成果。\n校验错误：${run.resultValidationFailure.code}\n${run.resultValidationFailure.issues.map(x=>'- '+x).join('\n')}`;
      const job=this.retryTask({commandId:`auto-result:${run.runId}`,taskId:run.taskId,expectedVersion:view.version,retryPrompt:feedback,automaticResultRetry:true}).catch(()=>undefined).finally(()=>this.resultRetries.delete(run.runId));
      this.resultRetries.set(run.runId,job);
    }
    // Task requeue is the durable source of truth. Repair the dispatch view even
    // if the host stopped between the operator command and queue admission.
    for (const pending of this.db
      .prepare(
        "SELECT task FROM pr_dispatch WHERE state<>'inbox' AND task IN (SELECT id FROM entities WHERE kind='task' AND state='inbox')",
      )
      .all()) {
      if (
        !this.ledger
          .snapshot()
          .runs.some(
            (r) =>
              r.taskId === pending.task &&
              ["queued", "running", "uncertain"].includes(r.state),
          )
      )
        this.db
          .prepare(
            "UPDATE pr_dispatch SET state='inbox',run=NULL,attempted='[]',updated=? WHERE task=?",
          )
          .run(now(), String(pending.task));
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM pr_dispatch WHERE state IN ('inbox','assigned') ORDER BY rowid",
      )
      .all() as unknown as {
      task: string;
      decision: string;
      candidates: string;
      state: string;
      run: string | null;
      generation: number;
      attempted: string;
      updated: string;
    }[];
    for (const row of rows) {
      let data = this.ledger.snapshot();
      const task = data.tasks.find((t) => t.taskId === row.task);
      if (!task) continue;
      if (row.state === "assigned" && row.run) {
        const run = this.ledger.getRun(row.run);
        const config = run.configuration;
        if (config && typeof config === "object" && !Array.isArray(config) && config.workflowInvocation) continue;
        if (run.state === "queued") {
          const health = this.ledger
            .nodeStatuses()
            .find((n) => n.nodeId === run.route?.nodeId);
          if (
            health?.state !== "online" &&
            Date.now() - Date.parse(row.updated) > 15000 &&
            !run.currentAttemptId &&
            !(data.attempts ?? []).some((a) => a.runId === run.runId)
          ) {
            try {
              this.ledger.returnUnclaimedToInbox(`pr:unclaimed:${run.runId}`, {
                taskId: row.task,
                runId: run.runId,
              });
            } catch {
              continue;
            }
            this.db
              .prepare(
                "UPDATE pr_dispatch SET state='inbox',run=NULL,updated=? WHERE task=?",
              )
              .run(now(), row.task);
          } else continue;
        } else if (run.state === "cancelled" && task.state === "inbox") {
          this.db
            .prepare(
              "UPDATE pr_dispatch SET state='inbox',run=NULL,updated=? WHERE task=?",
            )
            .run(now(), row.task);
        } else {
          this.db
            .prepare("UPDATE pr_dispatch SET state=?,updated=? WHERE task=?")
            .run(
              run.state === "running" ? "executing" : "settled",
              now(),
              row.task,
            );
          continue;
        }
        data = this.ledger.snapshot();
      }
      const active = data.runs.find(
        (r) =>
          r.taskId === row.task &&
          ["queued", "running", "uncertain"].includes(r.state),
      );
      if (active) {
        this.db
          .prepare(
            "UPDATE pr_dispatch SET state='assigned',run=?,updated=? WHERE task=?",
          )
          .run(active.runId, now(), row.task);
        continue;
      }
      if (
        ["cancelled", "archived", "completed", "failed"].includes(
          this.ledger.getTask(row.task).state,
        )
      ) {
        this.db
          .prepare("UPDATE pr_dispatch SET state='stopped' WHERE task=?")
          .run(row.task);
        continue;
      }
      const checks: { nodeId: string; reason: string }[] = [];
      for (const route of JSON.parse(row.candidates) as ExecutionRoute[]) {
        try {
          this.ledger.validateRoute(route);
        } catch {
          checks.push({ nodeId: route.nodeId, reason: "ineligible" });
          continue;
        }
        const health = this.ledger
          .nodeStatuses()
          .find((n) => n.nodeId === route.nodeId);
        if (health?.state !== "online") {
          checks.push({ nodeId: route.nodeId, reason: "offline" });
          continue;
        }
        const reservations = data.runs.filter(
          (r) =>
            r.route?.nodeId === route.nodeId &&
            r.state === "queued" &&
            !r.historyOnly &&
            !r.observationOnly,
        ).length;
        if (
          (health.availableSlots ?? 1) - reservations <= 0 ||
          (health.activeExecutions ?? health.activeClaims) >=
            (health.maxConcurrent ?? 1)
        ) {
          checks.push({ nodeId: route.nodeId, reason: "busy" });
          continue;
        }
        try {
          // Reserve the idempotency generation before creating the Run. A host
          // crash between ledger commit and dispatch bookkeeping must not reuse
          // the old command after an unclaimed Run returns to the inbox.
          const { generation } = this.db
            .prepare(
              "UPDATE pr_dispatch SET generation=generation+1 WHERE task=? RETURNING generation",
            )
            .get(row.task) as { generation: number };
          const decisionInput = this.ledger.getDecision(row.decision)?.input as unknown as PlanningInput | undefined;
          const applied = this.ledger.commandReceipt(`apply-decision:${row.decision}`)?.value as { reportId?: string } | undefined;
          // Bind feedback to every Run created for this dispatch, including an
          // unclaimed Run returned to the queue; never consume it globally.
          const contextNotes = decisionInput?.retryPrompt && applied?.reportId ? [applied.reportId] : [];
          const previous=decisionInput?.retrySourceRunId?this.ledger.getRun(decisionInput.retrySourceRunId):undefined;
          const priorConfig=previous?.configuration&&typeof previous.configuration==="object"&&!Array.isArray(previous.configuration)?previous.configuration:{};
          const retryConfig=previous?{...priorConfig,taskRetry:{sourceRunId:previous.runId,automatic:!!decisionInput?.automaticResultRetry,count:decisionInput?.automaticResultRetry?this.ledger.resultRetryInfo(previous.runId).count+1:0}}:{};
          const run = this.ledger.createRun(
            `pr:dispatch:${row.task}:${generation}`,
            {
              taskId: row.task,
              route,
              configuration: { ...retryConfig, decisionId: row.decision, reporting: "summary" },
              ...(previous?.parentRunId?{parentRunId:previous.parentRunId}:{}),
              ...(contextNotes.length ? { contextNotes } : {}),
            },
          ).value;
          checks.push({ nodeId: route.nodeId, reason: "assigned" });
          this.db
            .prepare(
              "UPDATE pr_dispatch SET state='assigned',run=?,generation=?,attempted=?,updated=? WHERE task=?",
            )
            .run(run.runId, generation, canonical(checks), now(), row.task);
          break;
        } catch {
          checks.push({ nodeId: route.nodeId, reason: "rejected" });
        }
      }
      const current = this.db
        .prepare("SELECT state FROM pr_dispatch WHERE task=?")
        .get(row.task) as { state: string };
      if (current.state === "inbox" && canonical(checks) !== row.attempted)
        this.db
          .prepare("UPDATE pr_dispatch SET attempted=?,updated=? WHERE task=?")
          .run(canonical(checks), now(), row.task);
    }
  }
  private projectTaskIds(id: string) {
    const wb = this.workbench.snapshot();
    const backlogs = new Set(
      wb.backlogs.filter((b) => b.projectId === id).map((b) => b.backlogId),
    );
    return wb.backlogTasks
      .filter((t) => backlogs.has(t.backlogId))
      .map((t) => t.taskId);
  }
  send(input: { projectId: string; commandId: string; text: string }) {
    this.authorize();
    this.agents();
    return this.sendOwned(
      this.project(input.projectId),
      input.commandId,
      input.text,
    );
  }
  private sendOwned(p: ProjectRow, commandId: string, contents: string) {
    if (this.nativeSession(p.session)) throw new TaskError("FORBIDDEN", "Use the native owner conversation for this project session");
    const message = text(contents, 20000),
      command = text(commandId, 200);
    const agentOptions = this.options(p.id);
    if (p.state !== "ready")
      throw new TaskError("CONFLICT", "Project is not ready");
    const hash = digest(
      p.taskId
        ? { taskId: p.taskId, text: message }
        : { projectId: p.id, text: message },
    );
    const existing = this.db
      .prepare("SELECT * FROM pr_turns WHERE command=?")
      .get(command) as unknown as TurnRow | undefined;
    if (existing) {
      if (existing.digest !== hash)
        throw new TaskError("CONFLICT", "Message command reused");
      return { commandId: command, state: existing.state };
    }
    if (
      this.db
        .prepare(
          "SELECT command FROM pr_turns WHERE owner=? AND state IN ('queued','running')",
        )
        .get(p.id)
    )
      throw new TaskError("BUSY", "Project conversation is responding");
    this.db
      .prepare("INSERT INTO pr_turns VALUES(?,?,?,?,?,?,NULL,?)")
      .run(command, hash, p.id, p.session, message, "queued", now());
    const abort = new AbortController();
    const done = this.respond(p, command, message, abort.signal, agentOptions)
      .catch(() => {
        this.db
          .prepare(
            "UPDATE pr_turns SET state='failed',error='CONVERSATION_FAILED' WHERE command=?",
          )
          .run(command);
      })
      .finally(() => this.jobs.delete(command));
    this.jobs.set(command, { done, abort });
    return { commandId: command, state: "queued" };
  }
  private async respond(
    p: ProjectRow,
    command: string,
    message: string,
    signal: AbortSignal,
    agentOptions: ReturnType<ProjectRuntime["options"]>,
  ) {
    let terminalError = false;
    let handle: Awaited<ReturnType<Context["agents"]["resume"]>> | undefined;
    const timeout = AbortSignal.timeout(120000),
      combined = AbortSignal.any([signal, timeout]);
    try {
      this.db
        .prepare("UPDATE pr_turns SET state='running' WHERE command=?")
        .run(command);
      const summary = (
        this.db
          .prepare("SELECT summary FROM pr_sessions WHERE session=?")
          .get(p.session) as { summary: string }
      ).summary;
      const related = this.snapshot()
        .tasks.filter((t) =>
          p.taskId ? t.id === p.taskId : t.project === p.id,
        )
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          stateLabel: t.stateLabel,
          manualCompletion: t.manualCompletion,
          materialsStatus: t.materialsStatus,
          run: t.run,
          report: t.report,
          runId: t.runId,
          canRetry: t.canRetry,
          canReconcile: t.canReconcile,
          retryDisabledReason: t.retryDisabledReason,
        }));
      handle = await this.agents().resume({
        resumeSessionId: SessionId(p.session),
        agentOptions,
        signal: combined,
        setup: (agentCtx, agent) => {
          agentCtx.on("agent/error", () => {
            terminalError = true;
          });
          let steps = 0;
          agentCtx.on("agent/pre-step", async (_payload, next) => {
            if (++steps > 12)
              throw new TaskError("LIMIT", "Project turn step limit");
            return await next();
          });
          agentCtx.tools.restrict({ allow: TOOLS });
          agentCtx.tools.guard((exec) =>
            exec.agent === agent && TOOLS.includes(exec.name)
              ? undefined
              : "Project dispatch tools only",
          );
          agentCtx.systemPrompt.section({
            name: "project-runtime",
            order: 99,
            interpolate: false,
            text: () =>
              `${p.taskId ? `你负责临时任务 ${p.taskId} 的规划。所有执行规划必须沿用此 Task ID，不创建新任务；结果不确定时先核实；只有明确授权重新执行后才使用重试，不得把补问结果当成重跑授权。` : ""}你负责「${p.title}」的统筹。目标：${p.goal}\n${summary}\n已有任务：${JSON.stringify(related)}\n工作区：${p.cwd}，仅存项目上下文。你可以调用 ${TOOLS.join(", ")} 调度其他执行端。用户授权创建的任务优先交给适合的在线闲置执行端；没有在线执行端时，选择注册的合适执行端排队等待上线。纯调度端不得接单或自行完成工作负载。执行端自己选择其授权工作区，不要把调度端目录设为执行约束。不要指定 route/provider/model/effort，让 task_plan 的决策服务选择。任务先登记，再按推荐的执行端顺序尝试。都不在线、忙碌或不可接单时保留 inbox，宿主会在执行端上线后自动派发。已经开始或结果不确定的任务不重复派发；先检查相关任务状态。仅当用户明确要重新执行时，才指引用户使用“核实并确认已停止”和“重新执行”。没有 result 报告仅表示调度账本未收到完成证据，不得断言执行端没有完成。若用户要求不重跑、只通信、询问现状或补传回执，不得 task_plan/task_dispatch，也不得把重新派发描述为唯一取回结果的方法。当前这些统筹工具只能读取调度账本和规划任务，没有向执行端会话发送普通消息或从已停止会话补取回执的工具；不得谎称已发消息或编造报告。此时可以如实解释已有记录，并指引用户在输入框的“对话对象”中选择执行端原会话直接发送消息；普通聊天不代表正式完成回执。只有用户明确授权执行规划时，才使用 requestId="project-message:${command}"，可先 task_plan 提案，再 task_dispatch（commandId 和 requestId 使用同一 ID）登记 Task 和持久候选顺序；只有执行端能接单时才创建 Run。不要重复派发。只调用一次 task_dispatch。提交后简短回复已排队或派发，完成与否必须依据真实报告或账本中用户的人工确认；补交内容会更新执行报告展示，不改写历史 Run 结果。若为普通交流或澄清可直接回复。`,
          });
        },
      });
      const cancel = () =>
        handle?.agent.cancel({ kind: "hook", reason: "Project turn stopped" });
      combined.addEventListener("abort", cancel, { once: true });
      handle.agent.followup(
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: message }],
        }),
      );
      try {
        await handle.agent.whenIdle();
      } finally {
        combined.removeEventListener("abort", cancel);
      }
      combined.throwIfAborted();
      if (terminalError)
        throw new TaskError(
          "CONVERSATION_FAILED",
          "Native conversation failed",
        );
      await (this.ctx.get("sessions") as Context["sessions"]).flush(
        handle.agent.session,
      );
      this.db
        .prepare(
          "UPDATE pr_turns SET state='completed',error=NULL WHERE command=?",
        )
        .run(command);
    } catch (error) {
      this.db
        .prepare("UPDATE pr_turns SET state='failed',error=? WHERE command=?")
        .run(
          signal.aborted
            ? "HOST_STOPPED"
            : timeout.aborted
              ? "TIMEOUT"
              : "CONVERSATION_FAILED",
          command,
        );
    } finally {
      if (handle) {
        try {
          await (this.ctx.get("sessions") as Context["sessions"]).flush(
            handle.agent.session,
          );
        } finally {
          await handle.dispose();
        }
      }
    }
  }
  async conversation(projectId: string) {
    return this.readConversation(this.project(projectId));
  }
  sendExecutorMessage(input: {
    projectId?: string;
    taskId: string;
    nodeId: string;
    sessionId: string;
    commandId: string;
    text: string;
  }) {
    this.authorize();
    if (
      input.projectId &&
      !this.projectTaskIds(input.projectId).includes(input.taskId)
    )
      throw new TaskError("FORBIDDEN", "Task does not belong to this project");
    return this.ledger.queueSessionMessage(input.commandId, {
      taskId: input.taskId,
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      text: input.text,
    });
  }
  private executorConversationFor(p: ProjectRow) {
    const messages: { id: string; role: string; text: string; time?: string; executor: string; sessionId: string; state: string }[] = [];
    const tasks = p.taskId ? [p.taskId] : this.projectTaskIds(p.id);
    const executorTargets = tasks.flatMap((taskId) =>
      this.ledger
        .sessionMessageTargets(taskId)
        .map((s) => ({ ...s, title: this.ledger.getTask(taskId).title })),
    );
    for (const taskId of tasks)
      for (const m of this.ledger.sessionMessages(taskId)) {
        messages.push({
          id: `direct:${m.messageId}`,
          role: "user",
          text: m.text,
          time: m.createdAt,
          executor: m.nodeId,
          sessionId: m.sessionId,
          state: m.state,
        });
        if (m.reply)
          messages.push({
            id: `direct-reply:${m.messageId}`,
            role: "assistant",
            text: m.reply,
            time: m.updatedAt,
            executor: m.nodeId,
            sessionId: m.sessionId,
            state: m.state,
          });
      }
    return { messages, executorTargets };
  }
  executorConversationMetadata(projectId: string) {
    this.authorize();
    const original = this.executorConversationFor(this.project(projectId));
    const result = { messages: original.messages.slice(-200), executorTargets: original.executorTargets.slice(-64), messagesTruncated: original.messages.length > 200, executorTargetsTruncated: original.executorTargets.length > 64 };
    while (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024) {
      if (result.messages.length) { result.messages.shift(); result.messagesTruncated = true; }
      else if (result.executorTargets.length) { result.executorTargets.shift(); result.executorTargetsTruncated = true; }
      else break;
    }
    return result;
  }
  private async readConversation(p: ProjectRow) {
    const handle = await (
      this.ctx.get("sessionPersistence") as Context["sessionPersistence"]
    ).open(SessionId(p.session), "read");
    let messages: {
      role: string;
      text: string;
      id: string;
      time?: string;
      executor?: string;
      sessionId?: string;
      state?: string;
    }[] = [];
    try {
      const { events } = await handle.read();
      const projection = foldSurface(events);
      messages = projection.nodes
        .flatMap((seq) => {
          const event = events[seq];
          const message =
            event && deriveEventMessage(event, projection.projectedMessages);
          if (
            !message ||
            String(message.source.kind) === "runtime-context" ||
            !["user", "assistant"].includes(message.role)
          )
            return [];
          const body = message.content
            .filter((c) => c.type === "text")
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("\n");
          return body
            ? [
                {
                  role: message.role,
                  text: body,
                  id: message.id,
                  time: new Date(event!.time).toISOString(),
                },
              ]
            : [];
        })
        .slice(-200);
    } finally {
      await handle.close();
    }
    const { executorTargets, messages: directMessages } = this.executorConversationFor(p);
    messages.push(...directMessages);
    messages.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    return {
      executorTargets,
      projectId: p.taskId ? null : p.id,
      taskId: p.taskId ?? null,
      conversationModel: {
        ...this.modelSelection(p.id),
        effective: this.modelSelection(p.id).selection ?? this.agentOptions,
      },
      workspace: p.cwd,
      sessionId: p.session,
      generation: p.generation,
      messages,
      sessions: this.db
        .prepare(
          "SELECT session,generation,summary,created FROM pr_sessions WHERE owner=? ORDER BY generation DESC",
        )
        .all(p.id),
      turns: this.db
        .prepare(
          "SELECT command,state,error,text FROM pr_turns WHERE session=? ORDER BY rowid DESC LIMIT 20",
        )
        .all(p.session),
    };
  }
  async handoff(projectId: string) {
    this.authorize();const p=this.project(projectId);this.lockCoordinator(p);
    try {
      const next=await this.prepareCoordinatorGeneration(p,p.cwd);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT INTO pr_sessions VALUES(?,?,?,?,?)").run(next.sessionId,p.id,next.generation,next.summary,now());
        this.db.prepare("UPDATE pr_projects SET session=?,generation=?,state='ready' WHERE id=? AND session=?").run(next.sessionId,next.generation,p.id,p.session);
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
      await this.syncWorkspacesFor(this.project(p.id));
      return {sessionId:next.sessionId,generation:next.generation};
    }finally {this.db.prepare("UPDATE pr_projects SET state='ready' WHERE id=? AND state='handoff'").run(p.id);}
  }
  review(input: { commandId: string; taskId: string }) {
    this.authorize();
    const run = this.ledger
      .snapshot()
      .runs.filter((r) => r.taskId === input.taskId)
      .at(-1);
    if (!run) throw new TaskError("NOT_FOUND", "Task has no run");
    return this.ledger.reviewRun(input.commandId, {
      runId: run.runId,
      decision: "accepted",
      reason: "在任务中心审核通过",
    });
  }
  actOnTask(input: {
    commandId: string;
    taskId: string;
    expectedVersion: string;
    runId: string | null;
    confirmationRevision: number;
    retryPrompt?: string;
    returnMessageId?: string;
    action:
      | "complete-materials"
      | "complete"
      | "handle"
      | "restore"
      | "cancel"
      | "approve"
      | "accept"
      | "reject"
      | "confirm-stopped"
      | "status"
      | "retry"
      | "repair"
      | "retry-return"
      | "check";
  }) {
    this.authorize();
    const view = this.ledger.taskActionState(input.taskId),
      task = this.ledger.getTask(input.taskId);
    if(input.action==="retry-return") {
      if(view.version!==input.expectedVersion)throw new TaskError("CONFLICT","Task changed; refresh before retrying its return");
      if(!input.returnMessageId)throw new TaskError("INVALID","Return retry requires the original message ID");
      const message=this.ledger.getSessionMessage(input.returnMessageId);
      if(message.taskId!==task.taskId || !message.completion)throw new TaskError("FORBIDDEN","Return does not belong to this Task");
      return this.ledger.retryTaskReturn(input.commandId,message.messageId);
    }
    if (input.action === "check") {
      if (view.version !== input.expectedVersion) throw new TaskError("CONFLICT", "Task changed; refresh before checking");
      return this.ledger.checkins.request(input.commandId,input.taskId);
    }
    if (input.action === "retry") return this.retryTask(input);
    if (input.action === "repair") {
      if(!input.runId)throw new TaskError("INVALID","Repair requires the current Run ID");
      return this.ledger.repairDispatch(input.commandId,{taskId:input.taskId,runId:input.runId,expectedActionVersion:input.expectedVersion});
    }
    const common = {
      taskId: input.taskId,
      expectedActionVersion: input.expectedVersion,
    };
    if (input.action === "complete" || input.action === "complete-materials")
      return this.ledger.confirmTaskCompletion(input.commandId, {
        ...common,
        requireMaterials: input.action === "complete-materials",
      });
    // Let each ledger command perform its own transactional version check and idempotency.
    if (input.action === "handle" || input.action === "restore")
      return this.ledger.setTaskHandled(input.commandId, {
        ...common,
        handled: input.action === "handle",
      });
    if (input.action === "cancel") {
      if (!view.canCancel && !this.ledger.commandReceipt(input.commandId))
        throw new TaskError("CONFLICT", "Task cannot be cancelled");
      return this.ledger.cancel(input.commandId, {
        ...common,
        reason: "用户在任务中心取消任务",
      });
    }
    if (input.action === "approve") {
      if (
        !view.confirmationPending &&
        !this.ledger.commandReceipt(input.commandId)
      )
        throw new TaskError(
          "CONFLICT",
          "Task is not awaiting execution approval",
        );
      return this.ledger.setTaskConfirmation(input.commandId, {
        ...common,
        expectedRevision: input.confirmationRevision,
        approved: true,
        actor: "operator:task-center",
        reason: "用户在任务中心批准执行",
      });
    }
    const run = input.runId ? this.ledger.getRun(input.runId) : null;
    if (run && run.taskId !== input.taskId)
      throw new TaskError("FORBIDDEN", "Run belongs to another task");
    if (
      run &&
      !this.ledger.commandReceipt(input.commandId) &&
      this.ledger
        .snapshot()
        .runs.filter((r) => r.taskId === input.taskId)
        .at(-1)?.runId !== run.runId
    )
      throw new TaskError("CONFLICT", "Task changed; refresh before acting");
    if (!run) throw new TaskError("NOT_FOUND", "Task has no run");
    if (input.action === "status")
      return this.ledger.requestExecutionStatus(input.commandId, {
        runId: run.runId,
        expectedActionVersion: input.expectedVersion,
      });
    if (input.action === "confirm-stopped") {
      if (!view.canReconcile && !this.ledger.commandReceipt(input.commandId))
        throw new TaskError(
          "CONFLICT",
          "Execution does not await stop verification",
        );
      return this.ledger.resolveUncertain(input.commandId, {
        runId: run.runId,
        outcome: task.state === "cancelled" ? "cancelled" : "failed",
        reason: "用户已核实执行端停止，确认此运行已经结束",
        expectedActionVersion: input.expectedVersion,
      });
    }
    return this.ledger.reviewRun(input.commandId, {
      runId: run.runId,
      decision: input.action === "accept" ? "accepted" : "rejected",
      reason: "用户在任务中心审核结果",
      expectedActionVersion: input.expectedVersion,
    });
  }
  setTaskPresentation(input:{commandId:string;taskId:string;visibility:"primary"|"execution"}) {
    this.authorize();
    return this.ledger.managementCommand(input.commandId,"task-presentation",input,()=>{
      this.ledger.getTask(input.taskId);
      if(!["primary","execution"].includes(input.visibility))throw new TaskError("INVALID","Unknown task presentation");
      this.db.prepare("INSERT INTO pr_task_presentation(task,visibility) VALUES(?,?) ON CONFLICT(task) DO UPDATE SET visibility=excluded.visibility").run(input.taskId,input.visibility);
      return {taskId:input.taskId,visibility:input.visibility};
    });
  }
  reportPresentation(input:{reportId:string;contentVersion:string}) {
    if(this.role==="executor")throw new TaskError("FORBIDDEN","Report preview unavailable");
    const report=this.ledger.getReport(input.reportId);
    if(report.kind!=="result")throw new TaskError("NOT_FOUND","Result report not found");
    if(reportReadingVersion(report)!==input.contentVersion)throw new TaskError("CONFLICT","Report changed; refresh before reading");
    return {reportId:report.reportId,taskId:report.taskId,runId:report.runId??null,contentVersion:input.contentVersion,presentation:reportHtmlPresentation(report)};
  }
  readReport(input:{commandId:string;reportId:string;contentVersion:string}) {
    this.authorize();
    return this.ledger.managementCommand(input.commandId,"report-read",input,()=>{
      const report=this.ledger.getReport(input.reportId);
      if(!report||report.kind!=="result")throw new TaskError("NOT_FOUND","Result report not found");
      if(reportReadingVersion(report)!==input.contentVersion)throw new TaskError("CONFLICT","Report changed; read the current version before marking it read");
      this.db.prepare("INSERT OR IGNORE INTO pr_report_reads(report,version,read_at) VALUES(?,?,?)").run(report.reportId,input.contentVersion,now());
      return {reportId:report.reportId,contentVersion:input.contentVersion};
    });
  }
  setReportRetryLimit(input:{commandId:string;taskId:string;expectedRevision:number;maxRetries:number}) {
    this.authorize();
    return this.ledger.updateTask(input.commandId,{taskId:input.taskId,expectedRevision:input.expectedRevision,maxResultRetries:input.maxRetries});
  }
  private async retryTask(input: {
    commandId: string;
    taskId: string;
    expectedVersion: string;
    retryPrompt?: string;
    automaticResultRetry?: boolean;
  }) {
    const retryPrompt = input.retryPrompt === undefined || input.retryPrompt === "" ? "" : text(input.retryPrompt, 20000);
    const requestId = `task-retry:${text(input.commandId, 200)}`;
    const prior = this.ledger.commandReceipt(`apply-decision:${requestId}`);
    if (prior) {
      const record = this.ledger.getDecision(requestId)
        ?.input as unknown as PlanningInput;
      if (
        record.taskId !== input.taskId ||
        record.expectedActionVersion !== input.expectedVersion ||
        (record.retryPrompt ?? "") !== retryPrompt
      )
        throw new TaskError("CONFLICT", "Retry command reused");
      this.enqueueDecision(requestId, input.taskId);
      return prior;
    }
    const view = this.ledger.taskActionState(input.taskId);
    if (view.version !== input.expectedVersion)
      throw new TaskError("CONFLICT", "Task changed; refresh before acting");
    if (!view.canRetry)
      throw new TaskError("CONFLICT", "Task is not safe to dispatch again");
    if (!this.planner)
      throw new TaskError("CONFIGURATION", "Task planner unavailable");
    const task = this.ledger.getTask(input.taskId),
      projectId = this.taskProject(input.taskId);
    // Operator retry keeps the last execution choice while it remains legal.
    // Queue admission still checks live readiness, capacity and Task policy.
    const previous = this.ledger
      .snapshot()
      .runs.filter((r) => r.taskId === input.taskId)
      .at(-1);
    let route = previous?.route && { ...previous.route };
    // DSH session selection resolves its own workspace. Official backends use
    // an explicit workspace grant and do not create a DSH task-session binding.
    // Retain that original grant so their retry remains claimable by the worker.
    if (route && !task.workspaceId && !route.backend) delete route.workspaceId;
    if (route) {
      try {
        this.ledger.validateRoute(route);
      } catch {
        route = undefined;
      }
    }
    if(input.automaticResultRetry && !route) throw new TaskError("CONFIGURATION", "Original execution route is unavailable for automatic retry");
    await this.planner.plan({
      requestId,
      taskId: input.taskId,
      expectedActionVersion: input.expectedVersion,
      ...(route ? { route } : {}),
      ...(projectId ? { projectId } : {}),
      title: task.title,
      description: retryPrompt ? `${task.description}\n\n本次返工补充提示词：\n${retryPrompt}` : task.description,
      ...(retryPrompt ? { retryPrompt } : {}),
      ...(previous ? {retrySourceRunId:previous.runId,automaticResultRetry:!!input.automaticResultRetry}:{}),
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
    });
    this.authorize();
    const receipt = this.planner.apply(requestId, { deferExecution: true });
    this.enqueueDecision(requestId, input.taskId);
    return receipt;
  }
  snapshot() {
    const wb = this.workbench.snapshot(),
      data = this.ledger.snapshot();
    const presentation=new Map(this.db.prepare("SELECT task,visibility FROM pr_task_presentation").all().map(row=>[String(row.task),String(row.visibility)]));
    const readReports=new Map(this.db.prepare("SELECT report,version,read_at FROM pr_report_reads").all().map(row=>[JSON.stringify([row.report,row.version]),String(row.read_at)]));
    const reading=(report:Report)=>{const contentVersion=reportReadingVersion(report),readAt=readReports.get(JSON.stringify([report.reportId,contentVersion]))??null;return {contentVersion,readAt,unread:report.kind==="result"&&!readAt};};
    const reportReadings=new Map(data.reports.map(report=>[report.reportId,reading(report)]));
    const unreadByTask=new Map<string,number>();
    for(const report of data.reports)if(reportReadings.get(report.reportId)?.unread)unreadByTask.set(report.taskId,(unreadByTask.get(report.taskId)??0)+1);
    const projectCollaborations = this.collaboration?.collaborationSummaries() ?? [];
    const runtimes = new Map(
      (
        this.db
          .prepare("SELECT * FROM pr_projects")
          .all() as unknown as ProjectRow[]
      ).map((p) => [p.id, p]),
    );
    const taskProjects = new Map(
      wb.backlogTasks.map((link) => [
        link.taskId,
        wb.backlogs.find((b) => b.backlogId === link.backlogId)?.projectId,
      ]),
    );
    for (const t of data.tasks) {
      let parent = t.parentTaskId;
      const seen = new Set<string>();
      while (!taskProjects.get(t.taskId) && parent && !seen.has(parent)) {
        seen.add(parent);
        if (taskProjects.get(parent)) taskProjects.set(t.taskId, taskProjects.get(parent));
        parent = data.tasks.find(x => x.taskId === parent)?.parentTaskId;
      }
    }
    const projects = wb.projects.map((p) => {
      const collaboration = projectCollaborations.find(c => c.projectId === p.projectId);
      const binding = this.projectWorkspace(p.projectId);
      const runtime = runtimes.get(p.projectId),
        workspace = wb.projectWorkspaces.find(
          (w) => w.projectId === p.projectId && w.isDefault,
        );
      return {
        id: p.projectId,
        title: p.title,
        description: p.description,
        goal: p.goal,
        next: p.nextStep || "继续项目工作",
        stage:
          runtime?.state === "ready"
            ? "正在推进"
            : runtime
              ? "准备工作区"
              : collaboration ? "会话协作" : "历史项目",
        workspaceNodeId: binding?.nodeId ?? this.nodeId,
        coordinatorWorkspace: runtime?.cwd ?? null,
        workspace:
          binding?.path || runtime?.cwd || collaboration?.cwd ||
          (data.workspaces ?? []).find(
            (w) => w.workspaceId === workspace?.workspaceId,
          )?.path ||
          "未绑定",
        session: runtime?.generation || 0,
        sessionId: runtime?.session || null,
        context: 0,
        phase: p.state,
        messages: [],
        canChat: runtime?.state === "ready",
        canConfigure: !!runtime,
        executionSettings: runtime ? this.ledger.projectExecutionSettings.read(p.projectId) : null,
      };
    });
    const dispatches = new Map(
      (
        this.db.prepare("SELECT * FROM pr_dispatch").all() as unknown as {
          task: string;
          candidates: string;
          state: string;
          attempted: string;
        }[]
      ).map((r) => [r.task, r]),
    );
    const workflowSnapshot=(this.ctx.get("taskSystem") as TaskSystemService | undefined)?.workflows.snapshot();
    const workflowDefinitionView=(definition:NonNullable<typeof workflowSnapshot>["definitions"][number])=>({workflowId:definition.workflowId,projectId:definition.projectId??null,title:definition.title,description:definition.description,revision:definition.revision,resultStepIds:definition.resultStepIds??null,stages:definition.stages??[],calls:definition.calls??[],steps:definition.steps.map(step=>({stepId:step.stepId,stageId:step.stageId??null,nodeId:step.nodeId,title:step.title,position:step.position??null,dependsOn:step.dependsOn,kind:step.execution.kind}))});
    const workflowBindings=workflowSnapshot?.taskBindings??[];
    const tasks = data.tasks.map((t) => {
      const dispatch = dispatches.get(t.taskId);
      const runs = data.runs.filter((r) => r.taskId === t.taskId),
        run = runs.at(-1);
      const supplementaryReports = data.reports.filter(
        (r) =>
          r.taskId === t.taskId &&
          !!run &&
          r.runId === run.runId &&
          r.kind === "note" &&
          r.data &&
          typeof r.data === "object" &&
          !Array.isArray(r.data) &&
          r.data.supplemental === true,
      );
      const resultReports = data.reports.filter(
        (r) =>
          r.taskId === t.taskId &&
          !!run &&
          r.runId === run.runId &&
          r.kind === "result",
      );
      // A supplement updates the report view, not the historical execution outcome.
      const report = supplementaryReports.at(-1) ?? resultReports.at(-1);
      const reportHistory = [...resultReports, ...supplementaryReports].filter(
        (r) => r.reportId !== report?.reportId,
      );

      const attention = this.ledger.taskActionState(t.taskId);
      const resultReturn=this.ledger.sessionMessages(t.taskId).findLast(m=>m.completion && m.state==="failed");
      const cancelled = t.state === "cancelled";
      const manual = t.state === "completed" ? t.manualCompletion : undefined;
      const materialRequest = manual?.requestMessageId
        ? (this.ledger
            .sessionMessages(t.taskId)
            .filter((m) => m.supplementFor === manual.decisionId)
            .at(-1) ?? this.ledger.getSessionMessage(manual.requestMessageId))
        : undefined;
      const materialsStatus = !manual
        ? null
        : manual.materials !== "pending"
          ? "closed"
          : supplementaryReports.length
            ? "received"
            : materialRequest?.state === "failed"
              ? "failed"
              : materialRequest?.state === "uncertain"
                ? "uncertain"
                : "requested";
      const materialsLabel = {
        received: "已收到材料，待核对",
        requested: "已请求补交，等待回复",
        failed: "补交请求失败",
        uncertain: "补交回复未确认",
        closed: "已完成人工确认",
      }[materialsStatus ?? "closed"];

      const workflowRun=workflowSnapshot?.runs.find(flow=>flow.runId===run?.runId);
      const status = resultReturn
        ? "error"
        : manual
        ? "done"
        : cancelled
          ? attention.uncertain
            ? "error"
            : attention.active
              ? "cancelling"
              : "cancelled"
          : t.state === "archived"
            ? "archived"
            : run?.dispatchIssue?.kind === "needs_action"
              ? "error"
            : workflowRun?.state === "needs_attention"
              ? "error"
            : t.state === "inbox" && dispatch?.state === "inbox"
              ? "queued"
              : attention.confirmationPending ||
                  run?.reviewStatus === "pending_user"
                ? "review"
                : run?.reviewStatus === "accepted"
                  ? "accepted"
                  : attention.handled
                  ? "handled"
                  : run?.reviewStatus === "rejected"
                    ? "error"
                    : run?.state === "succeeded" || t.state === "completed"
                      ? "done"
                      : ["failed", "partial", "uncertain", "blocked"].includes(
                            run?.state || "",
                          ) || t.state === "failed"
                        ? "error"
                        : run?.state === "running"
                          ? "running"
                          : run?.state === "cancelled"
                            ? "cancelled"
                            : !run && t.state === "ready" ? "draft" : "queued";
      return {
        id: t.taskId,
        showInCoordinator:presentation.get(t.taskId)==="primary"||presentation.get(t.taskId)!=="execution"&&!t.parentTaskId&&!(run?.configuration&&typeof run.configuration==="object"&&!Array.isArray(run.configuration)&&run.configuration.workflow),
        kind: t.kind,
        parentTaskId: t.parentTaskId ?? null,
        parentRunId: t.parentRunId ?? null,
        delegationDisplay: t.delegationDisplay?.mode ?? "task",
        observationOnly: t.kind === "observed" || !!run?.observationOnly,
        project: taskProjects.get(t.taskId) || "unassigned",
        title: t.title,
        description: t.description,
        status,
        checkin:{...this.ledger.checkins.view(t.taskId),returnDelivery:resultReturn ? {messageId:resultReturn.messageId,state:resultReturn.state,reason:resultReturn.reply ?? "原会话回信需处理",nextAttemptAt:resultReturn.nextAttemptAt ?? null} : null},
        actionVersion: attention.version,
        dispatchIssue: run?.dispatchIssue ?? null,
        canRepair: attention.canRepair,
        runId: run?.runId ?? null,
        revision:t.revision??1,
        workflowBinding:(()=>{const binding=workflowBindings.find(binding=>binding.taskId===t.taskId);return binding?{taskId:binding.taskId,projectId:binding.projectId,workflowId:binding.workflowId,revision:binding.revision}:null;})(),
        canRunDirect:!!this.db.prepare("SELECT task FROM pr_task_routes WHERE task=?").get(t.taskId),
        unreadResultCount:unreadByTask.get(t.taskId)??0,
        maxResultRetries:t.policy?.maxResultRetries??2,
        resultRetry:run?this.ledger.resultRetryInfo(run.runId):null,
        executionStartedAt: run?.executionStartedAt ?? null,
        executionEndedAt:
          run && !["queued", "running"].includes(run.state)
            ? run.updatedAt
            : null,
        canRequestStatus:
          !workflowBindings.some(binding=>binding.taskId===t.taskId) && run?.state === "running" && !run.cancellationRequested,
        progressRequest:
          data.attempts?.find((a) => a.attemptId === run?.currentAttemptId)
            ?.progressRequest ?? null,
        confirmationRevision: t.confirmation?.revision ?? 1,
        canHandle: attention.canHandle && !attention.handled,
        canConfirm:
          t.kind !== "observed" &&
          (attention.canHandle ||
            attention.canCancel ||
            manual?.materials === "pending"),
        canComplete:
          t.kind !== "observed" &&
          (attention.canHandle || manual?.materials === "pending"),
        canRequestMaterials:
          attention.canHandle &&
          !!data.attempts?.find(
            (a) =>
              a.attemptId === run?.currentAttemptId &&
              this.ledger
                .sessionMessageTargets(t.taskId)
                .some(
                  (s) =>
                    s.nodeId === a.nodeId &&
                    s.sessionId === a.sessionId &&
                    s.workspaceId,
                ),
          ),
        manualCompletion: manual ?? null,
        supplementaryReports,
        materialsStatus,
        materialsLabel: manual ? materialsLabel : null,
        reportHistory,
        reportSource: supplementaryReports.some(
          (r) => r.reportId === report?.reportId,
        )
          ? "supplement"
          : "execution",
        reportUpdatedAt: report?.recordedAt ?? null,
        canCancel: attention.canCancel,
        canRetry: attention.canRetry,
        retryDisabledReason: attention.canRetry
          ? null
          : attention.uncertain
            ? "执行结果不确定，请先核实执行端"
            : attention.active
              ? "已有等待接收或正在执行的记录，请勿重复执行"
              : attention.confirmationPending ||
                  run?.reviewStatus === "pending_user"
                ? "请先批准执行或审核结果"
                : run?.state === "partial"
                  ? "部分完成，请先明确剩余工作"
                  : t.state === "inbox"
                    ? "已在等待执行端接收，无需重复提交"
                    : "仅已结束且失败、受阻或审核未通过的任务可重新执行",
        conversationKind: taskProjects.get(t.taskId) ? "project" : "temporary",
        canRestore: attention.handled && run?.reviewStatus !== "accepted",
        canReconcile: attention.canReconcile,
        confirmationPending: attention.confirmationPending,
        stateLabel: resultReturn
          ? "需处理 · 原会话未回信"
          : manual
          ? manual.materials === "pending"
            ? `已完成 · ${materialsLabel}`
            : "已完成 · 人工确认"
          : cancelled && attention.uncertain
            ? "取消待核实"
            : attention.confirmationPending
              ? "待批准执行"
              : run?.reviewStatus === "pending_user" && !cancelled
                ? "待审核结果"
                : run?.reviewStatus === "accepted" && !cancelled && t.state !== "archived"
                  ? "已验收"
                  : t.state === "inbox" && dispatch?.state === "inbox"
                  ? "等待执行端接收"
                  : run?.dispatchIssue?.kind === "needs_action"
                    ? "需处理"
                    : run?.dispatchIssue?.kind === "waiting"
                      ? "等待执行端目录"
                    : run?.state === "queued"
                    ? "待领取"
                    : null,
        runStatus:
          run?.state === "cancelled"
            ? "cancelled"
            : run?.state === "succeeded"
              ? "done"
              : run?.state === "running"
                ? "running"
                : [
                      "failed",
                      "cancelled",
                      "partial",
                      "uncertain",
                      "blocked",
                    ].includes(run?.state || "")
                  ? "error"
                  : "queued",
        resultStatus: report
          ? manual
            ? materialsStatus === "received"
              ? "review"
              : "done"
            : run?.reviewStatus === "pending_user" && !cancelled
              ? "review"
              : run?.reviewStatus === "accepted"
                ? "accepted"
                : run?.state === "succeeded"
                  ? "done"
                  : "error"
          : "queued",
        runState: run?.state ?? null,
        node: run?.route?.nodeId || (run?.observationOnly ? "来源执行（仅观察）" : "待选择执行端"),
        model: run?.route?.model || (run?.observationOnly ? "来源未声明" : "待选择"),
        effort: run?.route?.reasoningEffort || "默认",
        report:
          report?.body ||
          (() => {
            const settled = data.events.findLast(
              (event) =>
                event.runId === run?.runId && event.type === "run.settled",
            );
            const detail = settled?.detail;
            const summary =
              detail && typeof detail === "object" && !Array.isArray(detail)
                ? detail.summary
                : undefined;
            return typeof summary === "string"
              ? `执行回执：${summary}`
              : "尚未收到执行报告";
          })(),
        reportId: report?.reportId || null,
        artifact: report?.title || "等待执行报告",
        time: t.updatedAt,
        returnedAt: run && !["queued", "running"].includes(run.state) ? data.events.findLast(event => event.runId === run.runId && event.type === "run.settled")?.at ?? null : null,
        run: run?.runId || "待创建",
        nativeState: t.state,
        dispatchState: dispatch?.state ?? null,
        recommendation: dispatch ? JSON.parse(dispatch.candidates) : [],
        candidateChecks: dispatch ? JSON.parse(dispatch.attempted) : [],
        reviewStatus: run?.reviewStatus || null,
      };
    });
    const taskById=new Map(data.tasks.map(task=>[task.taskId,task])),runById=new Map(data.runs.map(run=>[run.runId,run]));
    const projectedTasks=new Map(tasks.map(task=>[task.id,task]));
    const attentionByRoot=new Map<string,{taskId:string;runId:string|null;parentRunId:string|null;parentCreatedAt:string|null;state:string;node:string;summary:string}[]>();
    for(const run of data.runs){
      const task=projectedTasks.get(run.taskId);
      if(!task||task.showInCoordinator||!task.parentTaskId||run.reviewStatus==="accepted")continue;
      if(run.reviewStatus!=="pending_user"&&run.reviewStatus!=="rejected"&&!(run.runId===task.runId&&task.status==="error"))continue;
      // A newer successful Run does not resolve an older Run's source gap.
      if(run.runId===task.runId&&task.status==="handled")continue;
      let ancestor=taskById.get(task.parentTaskId);const seen=new Set<string>();
      while(ancestor?.parentTaskId&&!seen.has(ancestor.taskId)){seen.add(ancestor.taskId);ancestor=taskById.get(ancestor.parentTaskId);}
      if(!ancestor)continue;
      const parentRunId=run.parentRunId??task.parentRunId,parent=parentRunId?runById.get(parentRunId):undefined,rows=attentionByRoot.get(ancestor.taskId)??[];
      rows.push({taskId:task.id,runId:run.runId,parentRunId:parentRunId??null,parentCreatedAt:parent?.createdAt??null,state:run.state,node:run.route?.nodeId??task.node,summary:run.reviewStatus==="rejected"?"审核未通过":run.state==="partial"?"部分完成 · 详见本次报告":run.state==="failed"?"执行失败":run.state==="uncertain"?"结果待核实":run.state==="blocked"?"执行受阻":"结果需核对"});
      attentionByRoot.set(ancestor.taskId,rows);
    }
    // Explicit public views only. Never expose Run.configuration or provider credentials.
    return {
      settings: this.settings(),
      workflowDefinitions:(workflowSnapshot?.definitions??[]).map(workflowDefinitionView),
      workflowRuns:(workflowSnapshot?.runs??[]).map(flow=>({workflowRunId:flow.workflowRunId,workflowId:flow.workflowId,projectId:flow.projectId??null,taskId:flow.taskId??null,runId:flow.runId??null,definitionRevision:flow.definitionRevision,title:flow.title,createdAt:flow.createdAt,state:flow.state,definition:workflowDefinitionView(flow.definition),dispatches:flow.dispatches??[],steps:flow.steps.map(step=>({stepId:step.stepId,nodeId:step.nodeId,title:step.title,kind:step.kind,state:step.state,reason:step.reason??null,taskId:step.taskId??null,runId:step.runId??null,reportId:step.reportId??null,summary:step.summary??null,attemptCount:step.attemptCount}))})),
      viewContext: {role:"planner",scope:"all",nodeId:this.nodeId,observedAt:data.generatedAt},
      projectCollaborations,
      projectRegistrations: (data.projectRegistrations ?? []).map(r => ({
        registrationId:r.registrationId,projectId:r.projectId,namespace:r.namespace,mode:r.mode,
        sourceRevision:r.sourceRevision,observedAt:r.observedAt,staleAfterMs:r.staleAfterMs,
        origin:{harness:r.origin.harness},central:r.central,
        unknownOriginalTimes:r.packet.project.createdAt===null,
        sourceAcceptance:r.packet.outcomes.map(o=>({title:o.title,acceptance:o.acceptance})),
        artifactAvailability:r.packet.artifacts.map(a=>({uri:a.uri,availability:a.availability})),
      })),
      attempts: (data.attempts ?? []).map(a=>({attemptId:a.attemptId,taskId:a.taskId,runId:a.runId,nodeId:a.nodeId,fence:a.fence,state:a.state,sessionId:a.sessionId,executionId:a.executionId})),
      projects,
      tasks:tasks.map(task=>({...task,childAttention:attentionByRoot.get(task.id)??[]})),
      nodes: this.ledger.nodeStatuses().map((n) => ({
        nodeId: n.nodeId,
        state: n.state,
        availableSlots: n.availableSlots ?? null,
      })),
      runs: data.runs.map((r) => {
        // Only this Run's current attempt result carries executor diagnostics.
        // Notes, older attempts and historical source reports cannot claim a live runtime.
        const candidate = !r.observationOnly && r.route?.backend
          ? data.reports.findLast(report => report.runId === r.runId && report.attemptId === r.currentAttemptId && report.kind === "result")?.data
          : undefined;
        const evidence = candidate && typeof candidate === "object" && !Array.isArray(candidate) && candidate.backend === r.route?.backend ? candidate : {};
        const diagnostic = (key: string) => typeof evidence[key] === "string" && evidence[key].length <= 256 ? evidence[key] : null;
        return {
        retryPrompt: (r.contextNotes ?? []).flatMap(note => {
          const report = data.reports.find(report => report.reportId === (typeof note === "string" ? note : note.reportId));
          const metadata = report?.data;
          return metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.actor === "operator:task-center" && typeof metadata.retryPrompt === "string" ? [metadata.retryPrompt] : [];
        }).at(-1) ?? null,
        inputSnapshot: r.intentSnapshot ? {
          title:r.intentSnapshot.title,description:r.intentSnapshot.description,goal:r.intentSnapshot.goal??null,
          project:r.projectContext?.project??null,
          criteria:r.intentSnapshot.acceptanceCriteria,
          notes:(r.contextNotes??[]).flatMap(note=>{const report=data.reports.find(x=>x.reportId===(typeof note==='string'?note:note.reportId));return report?[{id:report.reportId,title:report.title,body:report.body}]:[]}),
        } : null,
        settlementSummary: (() => {const d=data.events.findLast(e=>e.runId===r.runId&&e.type==="run.settled")?.detail;return d&&typeof d==="object"&&!Array.isArray(d)&&typeof d.summary==="string"?d.summary:null;})(),
        diagnosticReport: (() => {const d=data.reports.findLast(x=>x.runId===r.runId&&["note","progress"].includes(x.kind)&&x.schemaId==="execution-diagnostic.v1");return d?{id:d.reportId,title:d.title,body:d.body}:null;})(),
        executionStartedAt:r.executionStartedAt??null,
        executionEndedAt:["queued","running"].includes(r.state)?null:r.updatedAt,
        runtimeVersion: diagnostic("cliVersion"),
        runtimeSource: diagnostic("cliSource"),
        actualModel: diagnostic("verifiedModel"),
        actualReasoningEffort: diagnostic("verifiedReasoningEffort"),
        productThreadId: diagnostic("productThreadId"),
        id: r.runId,
        occurrenceId: r.occurrenceId ?? null,
        createdAt: r.createdAt,
        parentRunId:r.parentRunId ?? null,
        parentTaskId:data.tasks.find(t=>t.taskId===r.taskId)?.parentTaskId ?? null,
        outcome:r.outcome ?? null,
        observationOnly:!!r.observationOnly,
        executionDriver:(r.configuration&&typeof r.configuration==="object"&&!Array.isArray(r.configuration)&&r.configuration.workflowInvocation?"workflow":r.observationOnly ? "source" : r.route?.backend ? "official-codex" : "dsh"),
        reasoningEffort:r.route?.reasoningEffort ?? null,
        sessionIds:r.sessionIds,
        taskId: r.taskId,
        state: r.state,
        node: r.route?.nodeId || null,
        model: r.route?.model || null,
        reviewStatus: r.reviewStatus ?? null,
      }; }),
      reports: data.reports.map((r) => ({
        id: r.reportId,
        ...reportReadings.get(r.reportId),
        hasHtmlPresentation:!!reportHtmlPresentation(r),
        kind: r.kind,
        taskId: r.taskId,
        runId: r.runId,
        title: r.title,
        body: r.body,
        workflowOutputs: r.workflowOutputs ?? [],
      })),
      artifacts: wb.artifacts.map((a) => ({ id: a.artifactId, ...a })),
      milestones: wb.milestones,
      schedules: (data.schedules ?? []).map((s) => ({
        scheduleId:s.scheduleId,taskId:s.taskId,title:data.tasks.find(t=>t.taskId===s.taskId)?.title??s.scheduleId,
        project:taskProjects.get(s.taskId)??"unassigned",enabled:s.enabled,revision:s.revision??1,retiredAt:s.retiredAt??null,
        intervalMs:s.intervalMs??null,cron:s.cron??null,timeZone:s.timeZone??null,nextDueAt:s.nextDueAt,
        overlap:s.overlap,misfire:s.misfire??"once",node:s.route?.nodeId??null,model:s.route?.model??null,
        blocked:["cancelled","archived"].includes(data.tasks.find(t=>t.taskId===s.taskId)?.state??""),
        occurrences:this.ledger.scheduleHistory(s.scheduleId),
      })),
      scheduleRuntime:{enabled:!!(this.ctx.get("taskSystem") as {config?:{schedulerEnabled?:boolean;keepAlive?:boolean}}|undefined)?.config?.schedulerEnabled,
        ticking:!!(this.ctx.get("taskSystem") as {config?:{keepAlive?:boolean}}|undefined)?.config?.keepAlive},
      workspaceOptions: this.workspaceOptions(),
      sampledAt: now(),
    };
  }
  createDirectTask(input:{commandId:string;projectId:string;title:string;description:string;routeId:string;start:boolean}) {
    this.authorize();
    const created=this.ledger.managementCommand(input.commandId,"project-agent-task",input,()=>{
      const project=this.workbench.snapshot().projects.find(p=>p.projectId===input.projectId&&p.state!=="archived");
      if(!project)throw new TaskError("NOT_FOUND","Project unavailable");
      const selected=new ScheduledPlans(this.ledger).options().routes.find(r=>r.id===input.routeId);
      if(!selected)throw new TaskError("CONFLICT","Execution route changed; refresh before creating a task");
      const task=this.ledger.prepareWorkflowTask({title:input.title,description:input.description,tags:["project-task"],...(selected.route.backend?{policy:{allowedBackends:[selected.route.backend]}}:{})});
      const backlogId=`direct-backlog:${input.projectId}`;
      this.db.prepare("INSERT OR IGNORE INTO wb_backlogs(backlog_id,revision,project_id,title,goal,state,priority,criteria) VALUES(?,1,?,'项目任务',?,'open','normal','[]')").run(backlogId,input.projectId,project.goal);
      this.db.prepare("INSERT INTO wb_backlog_tasks(backlog_id,task_id) VALUES(?,?)").run(backlogId,task.taskId);
      this.db.prepare("INSERT INTO pr_task_routes VALUES(?,?)").run(task.taskId,canonical(selected.route));
      return {taskId:task.taskId};
    });
    const run=input.start?this.runDirectTask({commandId:`project-task-start:${input.commandId}`,taskId:created.taskId}):null;
    return {taskId:created.taskId,...(run?{runId:run.runId}:{})};
  }
  runDirectTask(input:{commandId:string;taskId:string}) {
    this.authorize();
    const row=this.db.prepare("SELECT route FROM pr_task_routes WHERE task=?").get(input.taskId);
    if(!row)throw new TaskError("NOT_FOUND","Task execution settings unavailable");
    const route=JSON.parse(String(row.route)) as import("./contracts.js").ExecutionRoute;
    this.ledger.validateRoute(route);
    return this.ledger.createRun(input.commandId,{taskId:input.taskId,route}).value;
  }
  scheduleOptions() { this.authorize(); return new ScheduledPlans(this.ledger).options(); }
  createScheduledPlan(input:unknown) { this.authorize(); return new ScheduledPlans(this.ledger).create(input); }
  controlScheduledPlan(input:unknown) { this.authorize(); return new ScheduledPlans(this.ledger).control(input); }
  /** Central authority projection: authenticated peer selects its own node scope. */
  snapshotForNode(nodeId: string) {
    const all = this.snapshot(), raw = this.ledger.snapshot(), wb = this.workbench.snapshot();
    const projectIds = new Set(wb.projectWorkspaces.filter(w=>w.nodeId===nodeId).map(w=>w.projectId));
    for (const c of all.projectCollaborations) if (c.ownerNodeId === nodeId) projectIds.add(c.projectId);
    const ownedProjects = new Set(all.projectCollaborations.filter(c => c.ownerNodeId === nodeId).map(c => c.projectId));
    const workspaceIds = new Set((raw.workspaces ?? []).filter(w=>w.nodeId===nodeId).map(w=>w.workspaceId));
    const ids = new Set<string>();
    for (const t of all.tasks) if (ownedProjects.has(t.project)) ids.add(t.id);
    for(const s of raw.schedules??[]) if(s.route?.nodeId===nodeId) ids.add(s.taskId);
    for(const r of raw.runs) if(r.route?.nodeId===nodeId) ids.add(r.taskId);
    for(const a of raw.attempts ?? []) if(a.nodeId===nodeId) ids.add(a.taskId);
    for(const t of raw.tasks) if(t.workspaceId && workspaceIds.has(t.workspaceId)) ids.add(t.taskId);
    let changed=true;
    while(changed){changed=false;for(const t of raw.tasks)if(t.parentTaskId&&ids.has(t.parentTaskId)&&!ids.has(t.taskId)){ids.add(t.taskId);changed=true;}}
    // Ancestors supply context, without granting visibility into unrelated sibling branches.
    for(const taskId of [...ids]){let t=raw.tasks.find(t=>t.taskId===taskId);const seen=new Set<string>();while(t?.parentTaskId&&!seen.has(t.parentTaskId)){seen.add(t.parentTaskId);ids.add(t.parentTaskId);t=raw.tasks.find(x=>x.taskId===t!.parentTaskId);}}
    const tasks=all.tasks.filter(t=>ids.has(t.id)).map(t=>({...t,childAttention:t.childAttention.filter(row=>ids.has(row.taskId)),canHandle:false,canConfirm:false,canComplete:false,canRequestMaterials:false,canCancel:t.canCancel && raw.tasks.some(task=>task.taskId===t.id && task.dispatchOrigin?.kind==="session" && task.dispatchOrigin.nodeId===nodeId),canRetry:false,canRestore:false,canReconcile:false,canRequestStatus:t.canRequestStatus && raw.tasks.some(task=>task.taskId===t.id && task.dispatchOrigin?.kind==="session" && task.dispatchOrigin.nodeId===nodeId)}));
    for(const t of tasks)if(t.project!=="unassigned")projectIds.add(t.project);
    const runs=all.runs.filter(r=>ids.has(r.taskId)),runIds=new Set(runs.map(r=>r.id));
    return {...all,workspaceOptions:{nodeId,roots:[],workspaces:[]},settings:{enabled:false},projects:all.projects.filter(p=>projectIds.has(p.id)).map(p=>({...p,canChat:!!p.sessionId && !!this.nativeSession(p.sessionId),sessionId:p.sessionId && this.nativeSession(p.sessionId) ? p.sessionId : null})),tasks,runs,
      attempts:all.attempts.filter(a=>runIds.has(a.runId)),reports:all.reports.filter(r=>ids.has(r.taskId)),
      artifacts:all.artifacts.filter(a=>a.taskId&&ids.has(a.taskId)),milestones:all.milestones.filter(m=>projectIds.has(m.projectId)),schedules:all.schedules.filter(s=>ids.has(s.taskId)),
      projectCollaborations:all.projectCollaborations.filter(c=>c.ownerNodeId===nodeId),
      projectRegistrations:all.projectRegistrations.filter(r=>projectIds.has(r.projectId)),
      workflowDefinitions:all.workflowDefinitions.filter(flow=>flow.projectId&&projectIds.has(flow.projectId)),
      workflowRuns:all.workflowRuns.filter(flow=>flow.taskId&&ids.has(flow.taskId)).map(flow=>({...flow,steps:flow.steps.filter(step=>step.nodeId===nodeId||step.taskId&&ids.has(step.taskId))})),
      nodes:all.nodes.filter(n=>n.nodeId===nodeId||runs.some(r=>r.node===n.nodeId)),
      viewContext:{role:"executor",scope:"node",nodeId,observedAt:all.sampledAt},
    };
  }
  async close() {
    await Promise.allSettled([...this.placementHandles].map(handle => handle.dispose()));
    this.placementHandles.clear();
    this.accepting = false;
    await Promise.allSettled(this.resultRetries.values());
    await Promise.allSettled([...this.creations.values()].map((j) => j.done));
    for (const job of this.jobs.values()) job.abort.abort();
    await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
  }
}
