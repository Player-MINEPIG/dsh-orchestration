import { NodeReadOptions,nodeRead } from "../node-reads.js";
import { TaskReadOptions, taskRead, runSummary } from "../task-reads.js";
import { CentralTaskControl, type CentralTaskControl as TaskControl } from "../central-control.js";
import { SessionCommand, SessionDispatcherAuthority } from "../session-commands.js";
import { createHash } from "node:crypto";
import { basename, isAbsolute, normalize } from "node:path";
import { canonical, TaskError, type TaskLedger } from "../ledger.js";
import { Workbench } from "../workbench.js";
import type { ExecutionRoute, Json } from "../contracts.js";
import type { TaskPlanner } from "../planning.js";
import type { CollaborationSummary, ProjectCollaborationInput } from "./types.js";
import { ExecutionModelChoice } from "../execution-models.js";
import { projectSessionAction, type ProjectSessionAction } from "../project-session-service.js";
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
export function validateCollaborationInput(value: unknown): asserts value is ProjectCollaborationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID", "Expected collaboration input");
  const p = value as Record<string, unknown>;
  if (p.action === "project-session") {
    if (Object.keys(p).some(key => !["action", "request"].includes(key)) || !projectSessionAction.safeParse(p.request).success)
      fail("INVALID", "Invalid project session operation");
    return;
  }
  if (p.action === "control") {
    if (Object.keys(p).some(key=>!["action","control"].includes(key)) || !CentralTaskControl.safeParse(p.control).success) fail("INVALID", "Invalid central task control");
    return;
  }
  const keys = ["action", "sessionId", "cwd", "projectId", "title", "goal", "summary", "route", "description", "nodeId", "executionModel", "composition", "command", "taskId", "retry", "expectedActionVersion", "configuration", "read"];
  if (Object.keys(p).some(k => !keys.includes(k)) || canonical(p).length > 64_000) fail("INVALID", "Unknown or oversized collaboration input");
  if (!["session", "activate", "status", "nodes", "dispatch", "update", "submit"].includes(String(p.action))) fail("INVALID", "Unknown collaboration action");
  for (const key of keys.filter(k => k !== "route" && k !== "executionModel" && k !== "composition" && k !== "command" && k !== "retry" && k !== "configuration" && k !== "read")) {
    const v = p[key];
    if (v !== undefined && (typeof v !== "string" || v.length > (key === "description" || key === "summary" ? 20_000 : 4096) || v.includes("\0"))) fail("INVALID", `Invalid ${key}`);
  }
  if (typeof p.sessionId !== "string" || !p.sessionId.trim() || p.sessionId.length > 200 || typeof p.cwd !== "string" || !isAbsolute(p.cwd)) fail("INVALID", "A session and absolute working directory are required");
  if(p.retry!==undefined && typeof p.retry!=="boolean")fail("INVALID","Invalid retry");
  if(p.read!==undefined && !(p.action==="nodes"?NodeReadOptions:TaskReadOptions).safeParse(p.read).success)fail("INVALID","Invalid read options");
  if (p.action === "session" && !SessionCommand.safeParse(p.command).success) fail("INVALID", "Invalid session command");
  else if (p.action !== "session" && p.command !== undefined) fail("INVALID", "Command requires session action");
  if(p.composition!==undefined) {
    const c=p.composition;
    if(!c || typeof c!=="object" || Array.isArray(c))fail("INVALID","Invalid origin composition");
    const value=c as Record<string,unknown>;
    if(Object.keys(value).some(key=>!["provider","model","reasoningEffort","tools","preset"].includes(key)))fail("INVALID","Unknown origin composition field");
    for(const key of ["provider","model"])if(typeof value[key]!=="string" || !value[key] || String(value[key]).length>200)fail("INVALID","Invalid origin model binding");
    for(const key of ["reasoningEffort","preset"])if(value[key]!==undefined && (typeof value[key]!=="string" || String(value[key]).length>200))fail("INVALID","Invalid origin composition field");
    if(value.tools!==undefined && (!Array.isArray(value.tools) || value.tools.length>512 || value.tools.some(tool=>typeof tool!=="string" || tool.length>200)))fail("INVALID","Invalid origin tools");
  }
  if(p.executionModel!==undefined && !ExecutionModelChoice.safeParse(p.executionModel).success)fail("INVALID","Invalid explicit workload model");
  if(p.route!==undefined && (p.nodeId!==undefined || p.executionModel!==undefined))fail("INVALID","Choose an explicit route or node and workload selection, not both");
  if (p.route !== undefined) {
    if (!p.route || typeof p.route !== "object" || Array.isArray(p.route)) fail("INVALID", "Invalid route");
    const route = p.route as Record<string, unknown>;
    if (Object.keys(route).some(k => !["nodeId", "provider", "model", "reasoningEffort", "workspaceId", "backend", "requiredCapabilities"].includes(k))) fail("INVALID", "Unknown route field");
    for (const key of ["nodeId", "provider", "model"]) if (typeof route[key] !== "string" || !route[key] || String(route[key]).length > 200) fail("INVALID", `Invalid route ${key}`);
    for (const key of ["reasoningEffort", "workspaceId", "backend"]) if (route[key] !== undefined && (typeof route[key] !== "string" || String(route[key]).length > 200)) fail("INVALID", `Invalid route ${key}`);
    if (!Array.isArray(route.requiredCapabilities) || route.requiredCapabilities.length > 128 || route.requiredCapabilities.some(v => typeof v !== "string" || v.length > 200)) fail("INVALID", "Invalid route capabilities");
  }
}
/** Central authority only. Local hosts retain a binding cache, never a second authority. */
export class ProjectCollaborationAuthority {
  private db;
  private wb;
  private sessions;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private ledger: TaskLedger, private options: { projectSession?: (nodeId:string,commandId:string,input:ProjectSessionAction)=>Promise<Json>; control?: (commandId:string,input:TaskControl)=>unknown | Promise<unknown>; planner?: Pick<TaskPlanner, "plan" | "apply"> | (() => Pick<TaskPlanner, "plan" | "apply"> | undefined) } = {}) {
    ledger.assertManagementWritable();
    this.db = ledger.managementDatabase();
    this.wb = new Workbench(ledger);
    this.wb.prepareRegistration();
    this.sessions = new SessionDispatcherAuthority(ledger);
    this.db.exec(`CREATE TABLE IF NOT EXISTS collaboration_bindings (binding_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner_node_id, session_id, cwd));
      CREATE TABLE IF NOT EXISTS collaboration_commands (command_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT);`);
  }
  collaborationSummaries(ownerNodeId?: string): CollaborationSummary[] {
    const rows = ownerNodeId === undefined ? this.db.prepare("SELECT data FROM collaboration_bindings ORDER BY binding_id").all() : this.db.prepare("SELECT data FROM collaboration_bindings WHERE owner_node_id=? ORDER BY binding_id").all(ownerNodeId);
    return rows.map(r => JSON.parse(String(r.data)) as CollaborationSummary);
  }
  projectCollaborate(nodeId: string, commandId: string, input: ProjectCollaborationInput): Promise<Json> {
    if (input.action === "project-session") {
      validateCollaborationInput(input);
      const node = this.ledger.nodeStatuses().find(status => status.nodeId === nodeId);
      if (nodeId !== this.ledger.nodeId && (!node || !this.ledger.getNode(nodeId).enabled))
        return Promise.reject(new TaskError("FORBIDDEN", "An enabled registered node is required"));
      if (!this.options.projectSession) return Promise.reject(new TaskError("UNAVAILABLE", "Project session service is unavailable"));
      return this.options.projectSession(nodeId, commandId, input.request);
    }
    const run = this.queue.then(() => {
      validateCollaborationInput(input);
      const execution=(input.action === "dispatch" || input.action === "session") ? this.ledger.withDispatchOrigin({kind:"session",nodeId,sessionId:input.sessionId,cwd:input.cwd,...(input.composition?{composition:input.composition}:{})},()=>this.execute(nodeId,commandId,input)) : this.execute(nodeId,commandId,input);
      return execution.catch(error=>{
        if(error instanceof TaskError && !["UNAVAILABLE","REMOTE_OUTCOME_UNCERTAIN","COLLABORATION_PENDING"].includes(error.code))this.db.prepare("UPDATE collaboration_commands SET result=? WHERE command_id=? AND result IS NULL").run(canonical({rejected:{code:error.code,message:error.message}}),`collaboration:${hash([nodeId,commandId])}`);
        throw error;
      });
    });
    this.queue = run.catch(() => {});
    return run;
  }
  private async execute(nodeId: string, commandId: string, input: Exclude<ProjectCollaborationInput, {action:"project-session"}>): Promise<Json> {
    validateCollaborationInput(input);
    if (!nodeId || !commandId || commandId.length > 200) fail("INVALID", "Missing command identity");
    const node = this.ledger.nodeStatuses().map(n => this.ledger.getNode(n.nodeId)).find(n => n.nodeId === nodeId);
    if (!node?.enabled && nodeId !== this.ledger.nodeId) fail("FORBIDDEN", "An enabled registered node is required");
    if (input.action !== "control") input = { ...input, cwd: normalize(input.cwd) };
    const key = `collaboration:${hash([nodeId, commandId])}`;
    const digest = hash(input);
    const old = this.db.prepare("SELECT digest,result FROM collaboration_commands WHERE command_id=?").get(key);
    if (old && old.digest !== digest) fail("CONFLICT", "Command ID reused with different collaboration input");
    if (old?.result) {
      const saved=JSON.parse(String(old.result));
      if(saved.rejected)throw new TaskError(saved.rejected.code,saved.rejected.message);
      return saved;
    }
    this.db.prepare("INSERT OR IGNORE INTO collaboration_commands VALUES(?,?,NULL)").run(key, digest);
    if (input.action === "control") {
      const task = this.ledger.getTask(input.control.taskId), origin = task.dispatchOrigin;
      if (origin?.kind !== "session" || origin.nodeId !== nodeId) fail("FORBIDDEN", "Device controls are restricted to this device's original tasks");
      if (!this.options.control) fail("UNAVAILABLE", "Central task controls unavailable");
      const result = json(await this.options.control!(key, input.control));
      this.db.prepare("UPDATE collaboration_commands SET result=? WHERE command_id=?").run(canonical(result), key);
      return result;
    }
    if (input.action === "session") {
      const result = {confirmed:true,result:this.sessions.execute(nodeId, key, input)};
      this.db.prepare("UPDATE collaboration_commands SET result=? WHERE command_id=?").run(canonical(result), key);
      return result;
    }
    if (this.collaborationSummaries(nodeId).some(b => b.sessionId === input.sessionId && b.cwd !== input.cwd)) fail("CONFLICT", "Session is already bound to a different working directory");
    const bindingId = hash([nodeId, input.sessionId, input.cwd]);
    let binding = this.collaborationSummaries(nodeId).find(b => b.sessionId === input.sessionId && b.cwd === input.cwd);
    if (input.action === "activate") {
      if (binding && input.projectId && input.projectId !== binding.projectId) fail("CONFLICT", "Session already belongs to another project");
      if (!binding) {
        const project = input.projectId ? this.wb.snapshot().projects.find(p => p.projectId === input.projectId && p.state !== "archived") : undefined;
        if (input.projectId && !project) fail("FORBIDDEN", "Central project is not available");
        if (project && nodeId === this.ledger.nodeId && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='pr_projects'").get()) {
          const managed = this.db.prepare("SELECT cwd FROM pr_projects WHERE id=?").get(project.projectId);
          if (managed) {
            let permitted = managed.cwd === input.cwd;
            if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='pr_project_workspaces'").get()) {
              const row = this.db.prepare("SELECT workspace FROM pr_project_workspaces WHERE project=?").get(project.projectId);
              if (row) {
                const workspace = JSON.parse(String(row.workspace));
                if (workspace.nodeId === nodeId && workspace.path === input.cwd) permitted = true;
              }
            }
            if (!permitted) fail("FORBIDDEN", "Open this project's authorized local workspace before binding");
          }
        }
        const existingBacklog = project ? this.wb.snapshot().backlogs.find(b => b.projectId === project.projectId) : undefined;
        const existing = project ? {projectId:project.projectId, backlogId:existingBacklog?.backlogId ?? `session-backlog-${hash(project.projectId)}`, ownerNodeId:nodeId, sessionId:input.sessionId, cwd:input.cwd, title:project.title, goal:project.goal, summary:"", state:"active" as const, updatedAt:this.ledger.managementNow()} : undefined;
        binding = existing ? { ...existing, sessionId: input.sessionId } : {
          projectId: `collab-${bindingId}`, backlogId: `collab-backlog-${bindingId}`, ownerNodeId: nodeId,
          sessionId: input.sessionId, cwd: input.cwd, title: input.title?.trim() || basename(input.cwd) || "Local project",
          goal: input.goal?.trim() || "待明确项目目标", summary: input.summary || "", state: "active", updatedAt: this.ledger.managementNow(),
        };
        this.db.prepare("INSERT INTO collaboration_bindings VALUES(?,?,?,?,?,?)").run(bindingId, binding.projectId, nodeId, input.sessionId, input.cwd, canonical(binding));
      }
      this.sessions.select(nodeId, input.sessionId, input.cwd, binding.projectId);
      const creation = `collab-create:${hash(binding.projectId)}`;
      if (!this.wb.snapshot().projects.some(p => p.projectId === binding!.projectId)) this.wb.manage(`${creation}:project`, "create_project", { projectId: binding.projectId, title: binding.title, goal: binding.goal, state: "active" });
      if (!this.wb.snapshot().backlogs.some(b => b.backlogId === binding!.backlogId)) this.wb.manage(`${creation}:backlog`, "create_backlog", { backlogId: binding.backlogId, projectId: binding.projectId, title: "会话协作任务", goal: binding.goal, state: "open", priority: "normal" });
    } else if (input.action !== "nodes" && !binding) fail("COLLABORATION_NOT_ACTIVE", "Activate this session's project first");
    if (binding && input.projectId && binding.projectId !== input.projectId) fail("FORBIDDEN", "Project differs from the session binding");
    let result: Json;
    if (input.action === "nodes") {
      const nodes=this.ledger.nodeStatuses().filter(status=>{const node=this.ledger.getNode(status.nodeId);return node.enabled && node.roles.some(role=>role==="executor"||role==="both");}).map(status=>{
        const node=this.ledger.getNode(status.nodeId);
        let view=this.ledger.executionModels.view(node.nodeId);
        if(view.catalog.state!=="fresh")view=this.ledger.executionModels.request(`project-nodes:${hash([key,node.nodeId])}`,{nodeId:node.nodeId});
        return {...status,nodeId:node.nodeId,roles:node.roles,capabilities:node.capabilities,catalog:view.catalog,policy:view.policy,models:view.catalog.snapshot?.models ?? [],workspaceIds:node.workspaceIds,maxConcurrent:node.maxConcurrent,state:status.state};
      });
      result = json(nodeRead({routes:this.publicRoutes(),nodes},input.read));
    } else {
      const b = binding!;
      if (input.action === "dispatch") {
        const existing=input.taskId?this.ledger.getTask(input.taskId):undefined;
        if(existing && !this.scope(b).tasks.some(task=>task.taskId===existing.taskId))fail("FORBIDDEN","Task is outside the current project");
        if(existing && (input.title || input.description))fail("INVALID","Existing task dispatch uses its stored intent; omit title/description");
        if (!existing && !input.title?.trim()) fail("INVALID", "Dispatch requires a task title");
        const title=existing?.title ?? input.title!,description=existing?.description ?? input.description ?? title;
        const planner = typeof this.options.planner === "function" ? this.options.planner() : this.options.planner;
        const candidates=this.ledger.decisionCatalog().nodes.filter(node=>node.enabled&&node.roles.some(role=>role==="executor"||role==="both"));
        const nodeId=input.route?.nodeId ?? input.nodeId ?? ((!planner || existing) && candidates.length===1?candidates[0]?.nodeId:undefined);
        const selection=nodeId?this.ledger.selectExecutionModel(nodeId,input.route ?? input.executionModel):undefined;
        const route=input.route ?? (nodeId && selection?{nodeId,provider:selection.choice.provider,model:selection.choice.model,...(selection.choice.reasoningEffort?{reasoningEffort:selection.choice.reasoningEffort}:{}),...(selection.choice.backend?{backend:selection.choice.backend}:{}),requiredCapabilities:[]}:undefined);
        if(!route && (!planner || existing))fail("EXECUTOR_REQUIRED","Choose an executor from task_nodes or configure central planning");
        if(route) {
          this.ledger.projectExecutionPolicy(b.projectId,route.nodeId);
          this.ledger.validateRoute(route,{admission:true,skipModel:true});
        }
        if(route?.backend && !this.publicRoutes().some(candidate=>["nodeId","provider","model","reasoningEffort","backend"].every(key=>candidate[key as keyof ExecutionRoute]===route[key as keyof ExecutionRoute])))fail("BACKEND_UNAVAILABLE","Requested native backend is not advertised by an available execution host");
        const task = existing ?? this.ledger.createTask(`${key}:task`, { taskId: `collab-task-${hash(key)}`, title, description, ...(route?.backend ? { policy: { allowedBackends: [route.backend] } } : {}), ...(route?.workspaceId ? { workspaceId: route.workspaceId } : {}) }).value;
        this.wb.manage(`${key}:link`, "link_backlog_task", { backlogId: b.backlogId, taskId: task.taskId });
        const needsConfirmation = task.confirmation?.required && task.confirmation.state !== "approved";
        try {
        if (planner && !input.nodeId && !existing) {
          const decision = await planner.plan({ requestId: `${key}:plan`, title, description, projectId: b.projectId, taskId: task.taskId, ...(input.route ? { route: input.route } : {}),...(input.executionModel?{executionModel:input.executionModel}:{}) });
          if (decision.routingStatus !== "ready") {
            // Planning has not applied any execution. Preserve the audit record,
            // but do not leave an unstartable task blocking project submission.
            this.ledger.cancel(`${key}:unrouted`, { taskId: task.taskId, reason: "Central planner could not select an available execution route" });
            fail("ROUTE_REQUIRED", "Central planner could not select an available execution route; the unstarted task was cancelled");
          }
          planner.apply(`${key}:plan`, { deferExecution: Boolean(needsConfirmation) });
        } else if(!needsConfirmation)this.ledger.dispatchExistingTask(`${key}:run`, { taskId: task.taskId,...(input.route?{route:input.route}:{nodeId:route?.nodeId,...(input.executionModel?{executionModel:input.executionModel}:{})}),...(input.configuration!==undefined?{configuration:input.configuration}:{}),...(input.retry?{retry:input.retry,expectedActionVersion:input.expectedActionVersion}:{}) }).value;
        } catch(error) {
          if(!existing && !this.ledger.history(task.taskId).runs.length)this.ledger.cancel(`${key}:rejected`,{taskId:task.taskId,reason:"Dispatch was rejected before execution; retain this Task for explicit retry or cancellation"});
          if(error instanceof TaskError)throw new TaskError(error.code,`${error.message}. taskId=${task.taskId}; inspect task_history and reuse this Task with a new commandId after repair`);
          throw error;
        }
        b.state = "active";
        b.updatedAt = this.ledger.managementNow();
        result = json({ confirmed: true, binding: b, projectId: b.projectId, taskId: task.taskId, pendingConfirmation: Boolean(needsConfirmation), dispatch: needsConfirmation?{taskId:task.taskId,state:task.state,pendingConfirmation:true}:runSummary(this.ledger.history(task.taskId).runs.at(-1) ?? fail("UNAVAILABLE","Accepted dispatch has no Run")) });
      } else {
        if (input.action === "submit" || input.action === "update") {
          if (input.action === "submit") {
            const scoped = this.scope(b);
            const blockers=[...scoped.runs.filter(r=>["queued","running","uncertain"].includes(r.state)).map(r=>({taskId:r.taskId,runId:r.runId,state:r.state,reason:r.dispatchIssue?.message ?? "Execution has not stopped",recoveryActions:r.state==="uncertain"?["request_execution_status","verify_stopped"]:["task_wait","task_cancel"]})),...scoped.tasks.filter(t=>!scoped.runs.some(r=>r.taskId===t.taskId)&&!["completed","failed","cancelled","archived"].includes(t.state)).map(t=>({taskId:t.taskId,state:t.state,reason:"Unstarted task has not been dispatched or cancelled",recoveryActions:["task_dispatch","task_cancel"]})),...scoped.attempts.filter(a=>!["settled","cancelled","expired"].includes(a.state)).map(a=>({taskId:a.taskId,runId:a.runId,attemptId:a.attemptId,state:a.state,reason:"Executor stop is not confirmed",recoveryActions:["task_wait"]}))];
            if(blockers.length)fail("PROJECT_NOT_QUIESCENT",JSON.stringify({message:"Resolve pending work before submission",blockers}));
          }
          b.summary = input.summary ?? b.summary;
          b.state = input.action === "submit" ? "pending_review" : "active";
          b.updatedAt = this.ledger.managementNow();
          // Update every session binding of this owned project, preserving each session identity.
          for (const sibling of this.collaborationSummaries(nodeId).filter(x => x.projectId === b.projectId)) {
            this.db.prepare("UPDATE collaboration_bindings SET data=? WHERE binding_id=?").run(canonical({ ...sibling, summary: b.summary, state: b.state, updatedAt: b.updatedAt }), hash([nodeId, sibling.sessionId, sibling.cwd]));
          }
        }
        if(input.action==="status") {
          const scoped=this.scope(b),snapshot=this.ledger.snapshot(),ids=new Set(scoped.tasks.map(task=>task.taskId));
          const read=TaskReadOptions.parse(input.read ?? {});
          if(read.taskId && !ids.has(read.taskId))fail("FORBIDDEN","Task is outside the current project");
          result=json({confirmed:true,binding:b,projectId:b.projectId,...taskRead({...snapshot,tasks:snapshot.tasks.filter(task=>ids.has(task.taskId))},read,id=>this.ledger.taskActionState(id).version)});
        } else result = json({ confirmed: true, binding: b, projectId: b.projectId });
      }
    }
    // Commit reopening and the successful receipt together. An exact replay
    // returns above without reopening a project submitted after this dispatch.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.action === "dispatch" && binding) {
        for (const sibling of this.collaborationSummaries(nodeId).filter(x => x.projectId === binding!.projectId)) {
          this.db.prepare("UPDATE collaboration_bindings SET data=? WHERE binding_id=?").run(canonical({ ...sibling, state: "active", updatedAt: binding.updatedAt }), hash([nodeId, sibling.sessionId, sibling.cwd]));
        }
      }
      this.db.prepare("UPDATE collaboration_commands SET result=? WHERE command_id=?").run(canonical(result), key);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return result;
  }
  private publicRoutes(): ExecutionRoute[] {
    const routes: ExecutionRoute[] = [];
    for (const status of this.ledger.nodeStatuses()) {
      const node=this.ledger.getNode(status.nodeId),view=this.ledger.executionModels.view(status.nodeId);
      if(!node.enabled || !node.roles.some(role=>role==="executor"||role==="both") || !view.catalog.positiveSnapshot || view.catalog.positiveSnapshot.expiresAt<=Date.now())continue;
      for(const choice of view.catalog.positiveSnapshot.models){
        const {provider,model,reasoningEffort,backend}=choice;
        const route:ExecutionRoute={nodeId:node.nodeId,provider,model,...(reasoningEffort?{reasoningEffort}:{}),...(backend?{backend}:{}),requiredCapabilities:[]};
        const workspaces=(this.ledger.snapshot().workspaces ?? []).filter(workspace=>workspace.nodeId===node.nodeId&&workspace.state==="ready"&&node.workspaceIds.includes(workspace.workspaceId));
        for(const workspace of [undefined,...workspaces]){
          const executable={...route,...(workspace?{workspaceId:workspace.workspaceId}:{})};
          try{this.ledger.validateRoute(executable,{admission:true});routes.push(executable);}catch{}
        }
      }
    }
    return routes;
  }
  private scope(binding: CollaborationSummary) {
    const wb = this.wb.snapshot(), snapshot = this.ledger.snapshot();
    const backlogIds = new Set(wb.backlogs.filter(b => b.projectId === binding.projectId).map(b => b.backlogId));
    const ids = new Set(wb.backlogTasks.filter(l => backlogIds.has(l.backlogId)).map(l => l.taskId));
    let changed = true;
    while (changed) { changed = false; for (const task of snapshot.tasks) if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.taskId)) { ids.add(task.taskId); changed = true; } }
    return {
      project: wb.projects.find(p => p.projectId === binding.projectId),
      tasks: snapshot.tasks.filter(t => ids.has(t.taskId)).map(t => ({ taskId: t.taskId, parentTaskId: t.parentTaskId, parentRunId: t.parentRunId, title: t.title, description: t.description, state: t.state, kind: t.kind, confirmation: t.confirmation, actionVersion:this.ledger.taskActionState(t.taskId).version, createdAt: t.createdAt, updatedAt: t.updatedAt })),
      runs: snapshot.runs.filter(r => ids.has(r.taskId)).map(r => ({ runId: r.runId, taskId: r.taskId, parentRunId: r.parentRunId, state: r.state, reviewStatus: r.reviewStatus, dispatchIssue:r.dispatchIssue,executionModel:r.executionModel, route: r.route && { nodeId: r.route.nodeId, provider: r.route.provider, model: r.route.model, reasoningEffort: r.route.reasoningEffort, backend: r.route.backend }, createdAt: r.createdAt, updatedAt: r.updatedAt })),
      reports: snapshot.reports.filter(r => ids.has(r.taskId)).map(r => ({ reportId: r.reportId, taskId: r.taskId, runId: r.runId, kind: r.kind, title: r.title, body: r.body, artifactIds: r.artifactIds, createdAt: r.createdAt })),
      attempts: (snapshot.attempts ?? []).filter(a => ids.has(a.taskId)).map(a => ({ attemptId: a.attemptId, runId: a.runId, taskId: a.taskId, state: a.state, nodeId: a.nodeId })),
    };
  }
}
