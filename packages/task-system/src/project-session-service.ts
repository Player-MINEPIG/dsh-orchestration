import type { Workspace } from "@deepseek-ai/dsh-workspace";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { TaskSystemService } from "./dsh-plugin.js";
import { canonical, TaskError } from "./ledger.js";
import { ProjectNativeOperation, ProjectNativeOwner, projectNativeOperationWrites } from "./project-session-native.js";
import { ProjectSessionCarrier, ProjectSessionOwnerCarrier, ProjectHostCatalog, type ProjectOwnerRequest, type ProjectSessionExchange } from "./project-session-carrier.js";
import { ProjectSessionOwner } from "./project-session-owner.js";
import { ProjectSessions, type ProjectSessionMove } from "./project-sessions.js";
import { nativeProjectSession, projectSessionDecision, projectSessionReference, sameProjectSession, type ProjectSessionReference } from "./project-session-protocol.js";

const id = z.string().min(1).max(200);
const selection = z.object({ kind: z.literal("registered"), nodeId: id, workspaceId: id, catalogRevision: id }).strict();
export const projectSessionSettings = z.object({
  commandId: id, projectId: id, expectedRevision: z.number().int().nonnegative(),
  allowedNodeIds: z.array(id).nullable(), executionBindings: z.record(id, id), coordinatorWorkspace: selection.optional(),
}).strict();
const nativeInput = z.object({ commandId: id.optional(), projectId: id, generation: z.number().int().nonnegative().optional(), operation: ProjectNativeOperation }).strict();
const executorInput = z.object({ projectId: id.optional(), taskId: id, nodeId: id, sessionId: id, commandId: id, text: z.string().min(1).max(20000) }).strict();
const application = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("execution-settings"), projectId: id }).strict(),
  z.object({ kind: z.literal("save-execution-settings"), input: projectSessionSettings }).strict(),
  z.object({ kind: z.literal("conversation"), projectId: id, generation: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal("native-conversation"), input: nativeInput }).strict(),
  z.object({ kind: z.literal("send-executor-message"), input: executorInput }).strict(),
  z.object({ kind: z.literal("handoff"), projectId: id, commandId: id.optional() }).strict(),
  z.object({ kind: z.literal("authorize-owner"), binding: projectSessionReference, access: z.enum(["read", "write", "freeze"]) }).strict(),
]);
export const projectSessionAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exchange"), input: z.unknown() }).strict(),
  z.object({ kind: z.literal("decision"), operationId: id }).strict(),
  z.object({ kind: z.literal("application"), input: application }).strict(),
]);
export type ProjectSessionAction = z.infer<typeof projectSessionAction>;
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export class ProjectSessionService {
  readonly owner: ProjectSessionOwner;
  readonly carrier: ProjectSessionCarrier;
  readonly ownerCarrier: ProjectSessionOwnerCarrier;
  readonly placements: ProjectSessions;
  private readonly native: ProjectNativeOwner;
  private readonly db;
  private started = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly task: TaskSystemService, private ctx: Context) {
    this.db = task.ledger.managementDatabase();
    this.db.exec("CREATE TABLE IF NOT EXISTS project_session_settings_receipts(command TEXT PRIMARY KEY,digest TEXT NOT NULL)");
    this.owner = new ProjectSessionOwner(task.ledger, ctx, task.config.nodeId, {
      native: {
        create: request => {
          const controller = ctx.get("sessionController");
          if (!controller) throw new TaskError("UNAVAILABLE", "Native session controller is unavailable on this host");
          const workspace = ctx.get("workspaceRegistry")?.list().find((item: Workspace) => {
            try { return realpathSync(item.path) === request.cwd; } catch { return false; }
          });
          if (!workspace) throw new TaskError("WORKSPACE_POLICY", "Prepared workspace is no longer registered");
          return controller.create({ sessionId: request.sessionId, workspaceId: workspace.id });
        },
        resolveAgent: sessionId => {
          const controller = ctx.get("sessionController");
          if (!controller) throw new TaskError("UNAVAILABLE", "Native session controller is unavailable on this host");
          return controller.resolveAgent(sessionId);
        },
      },
      workspace: async input => {
        const catalog = this.catalog(), workspace = catalog.workspaces.find(item => item.workspaceId === input.workspaceId);
        if (!catalog.available || catalog.revision !== input.workspaceRevision || !workspace) throw new TaskError("WORKSPACE_POLICY", "Owner workspace catalog changed; refresh and select again");
        return { cwd: workspace.path, workspaceId: workspace.workspaceId, workspaceRevision: catalog.revision };
      },
      authorize: (binding, access) => this.authorizeOwner(binding, access),
      verifyDecision: async decision => {
        const actual = await this.central({ kind: "decision", operationId: decision.operationId }, `decision-${randomUUID()}`);
        if (canonical(actual) !== canonical(decision)) throw new TaskError("FORBIDDEN", "Central placement decision is unavailable or changed");
      },
      activate: async (agent, binding) => { await task.sessionCollaboration.activate(agent, undefined, binding.projectId); },
      restoreManaged: async binding => {
        if (!task.projects || binding.nodeId !== task.config.nodeId) throw new TaskError("UNAVAILABLE", "Managed session belongs to the central host");
        return task.projects.restoreManagedPlacement(binding);
      },
    });
    const service = this;
    this.native = new ProjectNativeOwner({ get ctx() { return service.ctx; }, authorizeBinding: (binding, access) => this.owner.admit(binding, access), withAgent: (binding, operation) => this.owner.withAgent(binding, operation) });
    this.ownerCarrier = new ProjectSessionOwnerCarrier(task.ledger, input => this.central({ kind: "exchange", input }, `exchange-${randomUUID()}`), () => this.catalog(), (request, callId) => this.ownerExecute(request, callId));
    this.carrier = new ProjectSessionCarrier(task.ledger, task.config.nodeId, (request, callId) => this.ownerCarrier.perform(request, callId), nodeId => this.authorizePeer(nodeId));
    this.placements = new ProjectSessions(task.ledger, {
      owner: (nodeId, command) => this.carrier.request(nodeId, command.kind === "status" ? `status-${randomUUID()}` : `placement-${digest(command)}`, { kind: "lifecycle", command }),
      checkCurrent: request => this.projects().checkPlacement(request), commit: (request, next) => this.projects().commitPlacement(request, next),
    });
  }
  bindContext(ctx: Context) { this.ctx = ctx; this.owner.bindContext(ctx); }
  private projects() {
    if (!this.task.projects) throw new TaskError("UNAVAILABLE", "Central project authority is unavailable");
    return this.task.projects;
  }
  private authorizePeer(nodeId: string) {
    if (nodeId === this.task.config.nodeId) return;
    if (!this.task.ledger.getNode(nodeId).enabled) throw new TaskError("FORBIDDEN", "Project session peer is disabled");
  }
  private scope(nodeId: string, projectId: string) {
    this.authorizePeer(nodeId);
    if (nodeId === this.task.config.nodeId) return;
    if (!this.projects().snapshotForNode(nodeId).projects.some(project => project.id === projectId)) throw new TaskError("FORBIDDEN", "Project is outside this peer's scope");
  }
  private async central(request: ProjectSessionAction, commandId: string): Promise<unknown> {
    if (this.task.config.centralMode === "host") return this.centralAction(this.task.config.nodeId, commandId, request);
    const remote = this.ctx.get("remoteExecution");
    if (!remote?.coordinatorLedger || remote.settingsSnapshot().paused) throw new TaskError("UNAVAILABLE", "Central project connection is unavailable");
    return remote.coordinatorLedger.projectCollaborate(this.task.config.nodeId, `project-portal-${randomUUID()}`, { action: "project-session", request });
  }
  catalog(): ProjectHostCatalog {
    const registry = this.ctx.get("workspaceRegistry"), workspaces: ProjectHostCatalog["workspaces"] = [];
    const available = !!registry && !!this.ctx.get("sessionController") && !!this.ctx.get("agents") && !!this.ctx.get("sessionPersistence");
    if (registry) for (const workspace of registry.list()) {
      try {
        if (!isAbsolute(workspace.path) || lstatSync(workspace.path).isSymbolicLink() || !lstatSync(workspace.path).isDirectory()) continue;
        const path = realpathSync(workspace.path);
        const row = { workspaceId: String(workspace.id), path, label: (workspace.title || path).slice(0, 500) };
        if (row.path.length > 4096 || row.workspaceId.length > 200 || Buffer.byteLength(JSON.stringify([...workspaces, row])) > 48 * 1024 || workspaces.length >= 64) continue;
        workspaces.push(row);
      } catch {}
    }
    workspaces.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
    return { revision: digest({ available, workspaces }), available, workspaces };
  }
  async start() {
    if (this.started) return;
    this.started = true;
    if (this.task.config.centralMode === "host") this.carrier.publish(this.task.config.nodeId, this.catalog());
    else this.ownerCarrier.start();
    await this.owner.recover();
    this.timer = setInterval(() => {
      if (this.task.config.centralMode === "host") {
        this.carrier.publish(this.task.config.nodeId, this.catalog());
        for (const operation of this.placements.outstanding()) void this.placements.move(operation.request).catch(() => {});
      }
    }, 2000);
  }
  async close() { if (this.timer) clearInterval(this.timer); this.native.dispose(); this.owner.dispose(); await this.ownerCarrier.dispose(); }
  async ownerExecute(request: ProjectOwnerRequest, callId: string): Promise<unknown> {
    if (request.kind === "lifecycle") return this.owner.handle(request.command);
    return this.native.invoke(request.binding, request.operation, callId);
  }
  private reference(projectId: string, generation?: number): ProjectSessionReference {
    const project = this.projects().placementProject(projectId);
    const row = generation === undefined ? { session: project.session, generation: project.generation } : this.db.prepare("SELECT session,generation FROM pr_sessions WHERE owner=? AND generation=?").get(projectId, generation);
    if (!row) throw new TaskError("NOT_FOUND", "Project session generation does not exist");
    return this.projects().nativeSession(String(row.session)) ?? { kind: "managed", projectId, generation: Number(row.generation), nodeId: this.task.config.nodeId, sessionId: String(row.session), cwd: project.cwd };
  }
  private async authorizeOwner(binding: ProjectSessionReference, access: "read" | "write" | "freeze") {
    if (this.task.config.centralMode !== "host") { await this.central({ kind: "application", input: { kind: "authorize-owner", binding, access } }, `authorize-${randomUUID()}`); return; }
    const actual = this.reference(binding.projectId, binding.generation);
    if (!sameProjectSession(actual, binding)) throw new TaskError("FORBIDDEN", "Session does not match the central generation binding");
    if (access !== "read" && !sameProjectSession(this.reference(binding.projectId), binding)) throw new TaskError("CONFLICT", "Project has a newer primary session generation");
  }
  async executionSettings(projectId: string): Promise<unknown> {
    if (this.task.config.centralMode !== "host") return this.central({ kind: "application", input: { kind: "execution-settings", projectId } }, `settings-${randomUUID()}`);
    this.carrier.publish(this.task.config.nodeId, this.catalog());
    const original = this.projects().executionSettings(projectId), binding = this.reference(projectId);
    const catalogs = this.carrier.catalogs();
    return { ...original, coordinatorSession: binding, ...(binding.kind === "native" ? { coordinatorWorkspace: { kind: "registered", nodeId: binding.nodeId, workspaceId: binding.workspaceId, path: binding.cwd, catalogRevision: binding.workspaceRevision, scope: "coordinator" } } : {}),
      coordinatorOptions: { nodeId: this.task.config.nodeId, roots: [], nodes: catalogs.map(row => ({ nodeId: row.nodeId, label: row.nodeId, catalogRevision: row.revision, state: row.available && Date.now() - row.observedAt < 15000 ? "ready" : "offline" })), workspaces: catalogs.flatMap(row => row.workspaces.map(workspace => ({ ...workspace, nodeId: row.nodeId, catalogRevision: row.revision, state: row.available && Date.now() - row.observedAt < 15000 ? "ready" : "offline" }))) } };
  }
  async saveExecutionSettings(input: unknown): Promise<unknown> {
    const request = projectSessionSettings.parse(input);
    if (this.task.config.centralMode !== "host") return this.central({ kind: "application", input: { kind: "save-execution-settings", input: request } }, request.commandId);
    const hash = digest(request), policy = this.db.prepare("SELECT digest FROM project_session_settings_receipts WHERE command=?").get(request.commandId);
    if (policy) {
      if (policy.digest !== hash) throw new TaskError("CONFLICT", "Settings retry changed its contents");
      return this.executionSettings(request.projectId);
    }
    const previous = this.placements.status(request.commandId);
    if (previous) {
      const saved = previous.request, selected = request.coordinatorWorkspace;
      if (saved.projectId !== request.projectId || saved.expectedRevision !== request.expectedRevision || canonical(saved.allowedNodeIds) !== canonical(request.allowedNodeIds) || canonical(saved.executionBindings) !== canonical(request.executionBindings) || !selected || saved.selection.nodeId !== selected.nodeId || saved.selection.workspaceId !== selected.workspaceId || saved.selection.workspaceRevision !== selected.catalogRevision)
        throw new TaskError("CONFLICT", "Settings retry changed its immutable placement request");
      const result = await this.placements.move(saved);
      if (result.state === "aborted") throw new TaskError("CONFLICT", "Location change was aborted; refresh before starting another change");
      return this.executionSettings(request.projectId);
    }
    const old = this.reference(request.projectId), selected = request.coordinatorWorkspace;
    const catalog = selected ? this.carrier.catalogs().find(row => row.nodeId === selected.nodeId) : undefined;
    const workspace = catalog?.workspaces.find(item => item.workspaceId === selected?.workspaceId);
    if (selected && (!catalog?.available || catalog.revision !== selected.catalogRevision || Date.now() - catalog.observedAt >= 15000 || !workspace)) throw new TaskError("WORKSPACE_POLICY", "Selected owner workspace is unavailable or changed");
    if (!selected || old.kind === "native" && old.nodeId === selected.nodeId && old.workspaceId === selected.workspaceId && old.cwd === workspace?.path) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.projects().saveExecutionPolicy(request);
        this.db.prepare("INSERT INTO project_session_settings_receipts VALUES(?,?)").run(request.commandId, hash);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      return this.executionSettings(request.projectId);
    }
    const move: ProjectSessionMove = { operationId: request.commandId, projectId: request.projectId, expectedRevision: request.expectedRevision, old, sessionId: `project-session-${randomUUID()}`, selection: { nodeId: selected.nodeId, workspaceId: selected.workspaceId, workspaceRevision: selected.catalogRevision }, allowedNodeIds: request.allowedNodeIds, executionBindings: request.executionBindings };
    await this.placements.move(move);
    return this.executionSettings(request.projectId);
  }
  async conversation(projectId: string, generation?: number): Promise<unknown> {
    if (this.task.config.centralMode !== "host") return this.central({ kind: "application", input: { kind: "conversation", projectId, generation } }, `conversation-${randomUUID()}`);
    const binding = this.reference(projectId, generation), project = this.projects().placementProject(projectId);
    if (binding.kind === "managed") {
      const header = await this.ctx.sessionPersistence.stat(SessionId(binding.sessionId));
      return this.projects().legacyConversation(projectId, binding.sessionId, binding.generation, header?.header.cwd ?? binding.cwd);
    }
    const row = this.db.prepare("SELECT operation FROM pr_session_locations WHERE session=?").get(binding.sessionId);
    const placement = row ? this.placements.status(String(row.operation)) : undefined;
    const state = placement?.state === "complete" ? "active" : "activating";
    const catalog = this.carrier.catalogs().find(item => item.nodeId === binding.nodeId);
    return { ...this.projects().executorConversationMetadata(projectId), projectId, taskId: null, sessionId: binding.sessionId, generation: binding.generation, workspace: binding.cwd, turns: [], nativeSession: { binding, available: !!catalog?.available && Date.now() - catalog.observedAt < 15000, state }, historical: binding.sessionId !== project.session,
      sessions: this.db.prepare("SELECT session,generation,summary,created FROM pr_sessions WHERE owner=? ORDER BY generation DESC LIMIT 100").all(projectId) };
  }
  async nativeConversation(input: unknown): Promise<unknown> {
    const request = nativeInput.parse(input), callId = request.commandId ?? (!projectNativeOperationWrites(request.operation) ? `native-${randomUUID()}` : undefined);
    if (!callId) throw new TaskError("INVALID", "A stable native command ID is required");
    if (this.task.config.centralMode !== "host") return this.central({ kind: "application", input: { kind: "native-conversation", input: { ...request, commandId: callId } } }, callId);
    const prior = this.carrier.lookup(callId);
    if (prior) {
      if (prior.request.kind !== "native" || prior.request.binding.projectId !== request.projectId || request.generation !== undefined && prior.request.binding.generation !== request.generation || canonical(prior.request.operation) !== canonical(request.operation))
        throw new TaskError("CONFLICT", "Native command retry changed its original binding or contents");
      return this.carrier.request(prior.nodeId, callId, prior.request);
    }
    const binding = nativeProjectSession.parse(this.reference(request.projectId, request.generation));
    if (projectNativeOperationWrites(request.operation) && !sameProjectSession(binding, this.reference(request.projectId))) throw new TaskError("CONFLICT", "Historical project generations are read-only");
    return this.carrier.request(binding.nodeId, callId, { kind: "native", binding, operation: request.operation });
  }
  async sendExecutorMessage(input: unknown): Promise<unknown> {
    const request = executorInput.parse(input);
    if (this.task.config.centralMode !== "host") return this.central({ kind: "application", input: { kind: "send-executor-message", input: request } }, request.commandId);
    return this.projects().sendExecutorMessage(request);
  }
  async handoff(projectId: string, commandId = `handoff-${randomUUID()}`): Promise<unknown> {
    if (this.task.config.centralMode !== "host") return this.central({ kind: "application", input: { kind: "handoff", projectId, commandId } }, commandId);
    const previous = this.placements.status(commandId);
    if (previous) {
      if (previous.request.projectId !== projectId) throw new TaskError("CONFLICT", "Handoff retry belongs to another project");
      const result = await this.placements.move(previous.request);
      if (result.state === "aborted") throw new TaskError("CONFLICT", "Handoff was aborted; refresh before starting another change");
      return this.conversation(projectId);
    }
    const binding = this.reference(projectId);
    if (binding.kind === "managed") return this.projects().handoff(projectId);
    const settings = this.task.ledger.projectExecutionSettings.read(projectId);
    await this.placements.move({ operationId: commandId, projectId, expectedRevision: settings.revision, old: binding, sessionId: `project-session-${randomUUID()}`, selection: { nodeId: binding.nodeId, workspaceId: binding.workspaceId, workspaceRevision: binding.workspaceRevision }, allowedNodeIds: settings.allowedNodeIds, executionBindings: settings.executionBindings });
    return this.conversation(projectId);
  }
  async centralAction(nodeId: string, commandId: string, input: unknown): Promise<unknown> {
    if (this.task.config.centralMode !== "host") throw new TaskError("FORBIDDEN", "Only the central host owns project session authority");
    this.authorizePeer(nodeId);
    const request = projectSessionAction.parse(input);
    if (request.kind === "exchange") return this.carrier.exchange(nodeId, request.input);
    if (request.kind === "decision") {
      const decision = this.placements.decision(request.operationId);
      if (!decision || nodeId !== decision.old.nodeId && nodeId !== decision.next?.nodeId) throw new TaskError("FORBIDDEN", "Placement decision belongs to another owner");
      return projectSessionDecision.parse(decision);
    }
    const operation = request.input;
    const projectId = operation.kind === "authorize-owner" ? operation.binding.projectId : "input" in operation ? operation.input.projectId : operation.projectId;
    if (projectId) this.scope(nodeId, projectId);
    switch (operation.kind) {
      case "execution-settings": return this.executionSettings(operation.projectId);
      case "save-execution-settings": return this.saveExecutionSettings(operation.input);
      case "conversation": return this.conversation(operation.projectId, operation.generation);
      case "native-conversation": return this.nativeConversation(operation.input);
      case "send-executor-message": {
        if (nodeId !== this.task.config.nodeId) {
          const visible = this.projects().snapshotForNode(nodeId).tasks.some(task => task.id === operation.input.taskId);
          const target = this.task.ledger.sessionMessageTargets(operation.input.taskId).some(item => item.nodeId === operation.input.nodeId && item.sessionId === operation.input.sessionId);
          if (!visible || !target) throw new TaskError("FORBIDDEN", "Executor conversation is outside this peer's task/session scope");
        }
        return this.sendExecutorMessage(operation.input);
      }
      case "handoff": return this.handoff(operation.projectId, operation.commandId);
      case "authorize-owner":
        if (nodeId !== operation.binding.nodeId) throw new TaskError("FORBIDDEN", "Owner authorization belongs to another node");
        await this.authorizeOwner(operation.binding, operation.access); return { authorized: true };
    }
  }
}
