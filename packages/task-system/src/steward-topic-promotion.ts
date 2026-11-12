import { SessionId } from "@deepseek-ai/dsh-session";
import { initializeTaskSessionTitle } from "./session-titles.js";
import type { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import type { TaskSystemService } from "./dsh-plugin.js";
import { canonical, TaskError } from "./ledger.js";
import { stewardBinding, stewardScope, stewardSelection } from "./steward-contracts.js";
import { StewardTopics } from "./steward-topics.js";

const key = z.string().min(1).max(160);
const scope = stewardScope.options[1].extend({ topicId: key });
const topic = z.strictObject({ conversationId: key, scope });
const base = { commandId: key, topic, expectedRevision: z.number().int().nonnegative() };
export const topicProjectOptionsInput = z.strictObject({ topic });
export const topicProjectConfigureInput = z.discriminatedUnion("mode", [
  z.strictObject({ ...base, mode: z.literal("create"), title: z.string().trim().min(1).max(100), goal: z.string().trim().min(1).max(20000), selection: stewardSelection.optional(), taskIds: z.array(key).max(50).default([]) }),
  z.strictObject({ ...base, mode: z.literal("link"), projectId: key, taskIds: z.array(key).max(50).default([]) }),
]);
export const topicTaskCreateInput = z.strictObject({ ...base, title: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(20000) });
export const topicTaskBindInput = z.strictObject({ ...base, taskId: key });
const binding = stewardBinding.options[1];
type Binding = z.infer<typeof binding>;
type Topic = z.infer<typeof topic>;

/** Associations reuse official project/task operations; native logs and old attempts never move. */
export class StewardTopicPromotion {
  private readonly db;
  private readonly jobs = new Map<string, Promise<unknown>>();
  constructor(private readonly task: TaskSystemService, private readonly ctx: Context, private readonly topics: StewardTopics,
    private readonly source: (topic: Topic) => Binding, private readonly ensureSource: (topic: Topic) => Promise<unknown>) {
    this.db = task.ledger.managementDatabase();
    this.db.exec("CREATE TABLE IF NOT EXISTS steward_topic_operations(command TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT,checkpoint TEXT); CREATE TABLE IF NOT EXISTS steward_topic_operation_claims(topic TEXT PRIMARY KEY,command TEXT NOT NULL)");
    const columns=this.db.prepare("PRAGMA table_info(steward_topic_operations)").all();
    if (!columns.some(column=>column.name==="checkpoint")) this.db.exec("ALTER TABLE steward_topic_operations ADD COLUMN checkpoint TEXT");
  }
  get active():boolean { return this.jobs.size>0; }
  async drain() { await Promise.allSettled([...this.jobs.values()]); }
  private projects() {
    this.task.assertConversationAdmission();
    if (!this.task.projects) throw new TaskError("UNAVAILABLE", "Project authority is unavailable");
    return this.task.projects;
  }
  private taskAllowed(taskId: string, projectId: string | null) {
    const task = this.task.ledger.getTask(taskId);
    const owner = this.task.ledger.projectForTask(taskId);
    const foreignHistory=this.db.prepare("SELECT 1 FROM entities WHERE kind='run' AND parent=? AND json_extract(data,'$.projectContext.project.projectId') IS NOT NULL AND json_extract(data,'$.projectContext.project.projectId') IS NOT ? LIMIT 1").get(taskId,projectId);
    if (foreignHistory) throw new TaskError("FORBIDDEN", "Task execution history belongs to another project and cannot be moved into this topic");
    if (owner && owner !== projectId) throw new TaskError("FORBIDDEN", "Task already belongs to another project; its authority cannot be moved");
    return task;
  }
  private checkRequest(request: {commandId:string;topic:Topic;expectedRevision:number}) {
    const current = this.topics.get(request.topic.conversationId, request.topic.scope.topicId);
    if (!this.db.prepare("SELECT 1 FROM steward_topic_operations WHERE command=?").get(request.commandId) && current.revision !== request.expectedRevision)
      throw new TaskError("CONFLICT", "Topic changed; refresh before updating it");
  }
  private async operation<T>(commandId: string, input: {topic:Topic;expectedRevision:number}, work: (resume: boolean) => Promise<T>): Promise<T> {
    const encoded = canonical(input), previous = this.db.prepare("SELECT input,result FROM steward_topic_operations WHERE command=?").get(commandId);
    if (previous && previous.input !== encoded) throw new TaskError("CONFLICT", "Topic operation retry changed its contents");
    if (previous?.result) return JSON.parse(String(previous.result));
    const active = this.jobs.get(commandId);
    if (active) { await active; return this.operation(commandId, input, work); }
    const topicKey = canonical(input.topic);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claim = this.db.prepare("SELECT command FROM steward_topic_operation_claims WHERE topic=?").get(topicKey);
      if (claim && claim.command !== commandId) throw new TaskError("BUSY", "This topic has an unfinished update; resume that operation before starting another");
      if (!previous && this.topics.get(input.topic.conversationId,input.topic.scope.topicId).revision !== input.expectedRevision)
        throw new TaskError("CONFLICT", "Topic changed before the operation was admitted");
      this.db.prepare("INSERT OR IGNORE INTO steward_topic_operations(command,input,result) VALUES(?,?,NULL)").run(commandId, encoded);
      this.db.prepare("INSERT OR IGNORE INTO steward_topic_operation_claims VALUES(?,?)").run(topicKey,commandId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    const job = work(!!previous).then(result => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE steward_topic_operations SET result=? WHERE command=? AND input=?").run(canonical(result), commandId, encoded);
        this.db.prepare("DELETE FROM steward_topic_operation_claims WHERE topic=? AND command=?").run(topicKey,commandId);
        this.db.exec("COMMIT");
      } catch(error) { this.db.exec("ROLLBACK"); throw error; }
      return result;
    }).finally(() => this.jobs.delete(commandId));
    this.jobs.set(commandId, job);
    return job;
  }
  async options(input: unknown) {
    const request = topicProjectOptionsInput.parse(input), projects = this.projects();
    const value = this.topics.get(request.topic.conversationId, request.topic.scope.topicId);
    const pending=this.db.prepare("SELECT o.input,o.checkpoint FROM steward_topic_operation_claims c JOIN steward_topic_operations o ON o.command=c.command WHERE c.topic=?").get(canonical(request.topic));
    const pendingProject=typeof pending?.checkpoint === "string" ? pending.checkpoint : null;
    return { topic: value, projects: projects.chatProjects().slice(0, 100).map(project => ({ projectId: project.projectId, title: project.title })),
      tasks: value.taskIds.map(taskId => { const task = this.taskAllowed(taskId, value.projectId ?? pendingProject); return { taskId, title: task.title, state: task.state }; }),
      source: { scope: request.topic.scope, binding: this.source(request.topic) },
      pendingOperation: (() => { if (!pending) return null;
        const input:unknown=JSON.parse(String(pending.input));
        if (topicProjectConfigureInput.safeParse(input).success) return {method:"topicProjectConfigure",input};
        if (topicTaskCreateInput.safeParse(input).success) return {method:"topicTaskCreate",input};
        return {method:"topicTaskBind",input:topicTaskBindInput.parse(input)}; })() };
  }
  async configure(input: unknown) {
    const request = topicProjectConfigureInput.parse(input), projects = this.projects();
    this.checkRequest(request);
    const initial = this.topics.get(request.topic.conversationId,request.topic.scope.topicId);
    if (request.mode === "link" && !projects.chatProjects().some(project=>project.projectId===request.projectId))
      throw new TaskError("FORBIDDEN", "Project is not available to this conversation");
    if (request.mode === "create" && initial.projectId && !this.db.prepare("SELECT 1 FROM steward_topic_operations WHERE command=?").get(request.commandId)) throw new TaskError("CONFLICT", "Topic is already linked to a project");
    if (request.mode === "link" && initial.projectId && initial.projectId !== request.projectId) throw new TaskError("CONFLICT", "Topic already belongs to another project");
    if (request.taskIds.some(taskId=>!initial.taskIds.includes(taskId))) throw new TaskError("FORBIDDEN", "Task is not attached to this topic");
    const checkpoint=this.db.prepare("SELECT checkpoint FROM steward_topic_operations WHERE command=?").get(request.commandId)?.checkpoint;
    const resumedProject = typeof checkpoint === "string" ? checkpoint : null;
    for (const taskId of request.taskIds) this.taskAllowed(taskId,initial.projectId ?? resumedProject);
    return this.operation(request.commandId, request, async resume => {
      let value = this.topics.get(request.topic.conversationId, request.topic.scope.topicId);
      if (!resume && value.revision !== request.expectedRevision) throw new TaskError("CONFLICT", "Topic changed; refresh before upgrading");
      if (request.taskIds.some(taskId => !value.taskIds.includes(taskId))) throw new TaskError("FORBIDDEN", "Only this topic's explicitly attached tasks can be included");
      for (const taskId of request.taskIds) this.taskAllowed(taskId, value.projectId ?? resumedProject);
      const original = this.source(request.topic);
      await this.ensureSource(request.topic);
      let projectId: string;
      if (request.mode === "create") {
        const workspace = projects.workspaceOptions().workspaces.find(item => item.nodeId === original.nodeId && item.path === original.cwd);
        if (!workspace) throw new TaskError("UNAVAILABLE", "The topic's registered native workspace is unavailable");
        projectId = (await projects.create({ commandId: `topic-project:${value.id}`, title: request.title, goal: request.goal,
          workspace: { kind: "registered", nodeId: workspace.nodeId, workspaceId: workspace.workspaceId }, ...(request.selection ? {selection:request.selection} : {}) })).projectId;
      } else {
        if (!projects.chatProjects().some(project => project.projectId === request.projectId)) throw new TaskError("FORBIDDEN", "Project is not available to this conversation");
        projectId = request.projectId;
      }
      this.db.prepare("UPDATE steward_topic_operations SET checkpoint=? WHERE command=?").run(projectId,request.commandId);
      value = this.topics.get(request.topic.conversationId, request.topic.scope.topicId);
      if (value.projectId && value.projectId !== projectId) throw new TaskError("CONFLICT", "Topic has already been linked to a different project");
      const project = projects.placementProject(projectId);
      if (request.mode === "create") {
        const workspace = this.ctx.get("workspaceRegistry")?.list().find(item => item.path === original.cwd);
        if (!workspace) throw new TaskError("UNAVAILABLE", "Promoted native workspace is unavailable");
        await workspace.setTitle(project.title);
        const controller = this.ctx.get("sessionController");
        if (controller) {
          const resolved = await controller.resolveAgent(SessionId(project.session));
          if (!("agent" in resolved)) throw new TaskError("UNAVAILABLE", "Promoted coordinator could not be opened");
          const agent=resolved.agent;
          initializeTaskSessionTitle(agent.session, `管家 · ${project.title}`);
          const sessions=this.ctx.get("sessions");
          if (!sessions || !await sessions.flush(agent.session)) throw new TaskError("UNAVAILABLE", "Promoted coordinator title is not durable");
        }
      }
      for (const taskId of request.taskIds) { this.taskAllowed(taskId, projectId); projects.linkTask(project.session, taskId); }
      if (value.projectId !== projectId) value = this.topics.update({ conversationId: value.conversationId, topicId: value.id, expectedRevision: value.revision, projectId });
      return { topic: value, projectId, physicalWorkspaceMoved: false, sameWorkspace: project.cwd === original.cwd,
        sourceSessionId: original.sessionId, projectSessionId: project.session };
    });
  }
  async createTask(input: unknown) {
    const request = topicTaskCreateInput.parse(input), projects = this.projects();
    this.checkRequest(request);
    const initial=this.topics.get(request.topic.conversationId,request.topic.scope.topicId);
    if (initial.projectId && !this.db.prepare("SELECT 1 FROM steward_topic_operations WHERE command=?").get(request.commandId))
      throw new TaskError("CONFLICT", "This topic is linked to a project; ask its project coordinator to create and dispatch new work");
    return this.operation(request.commandId, request, async resume => {
      let value = this.topics.get(request.topic.conversationId, request.topic.scope.topicId);
      if (!resume && value.revision !== request.expectedRevision) throw new TaskError("CONFLICT", "Topic changed; refresh before creating a task");
      const created = await projects.createTemporary({ commandId: `topic-task:${request.commandId}`, title: request.title, description: request.description });
      value = this.topics.get(request.topic.conversationId, request.topic.scope.topicId);
      if (!value.taskIds.includes(created.taskId)) value = this.topics.update({ conversationId: value.conversationId, topicId: value.id, expectedRevision: value.revision, taskId: created.taskId });
      if (value.projectId) projects.linkTask(projects.placementProject(value.projectId).session, created.taskId);
      return { topic: value, ...created };
    });
  }
  async bindTask(input: unknown) {
    const request = topicTaskBindInput.parse(input), projects = this.projects();
    this.checkRequest(request);
    const initial=this.topics.get(request.topic.conversationId,request.topic.scope.topicId); this.taskAllowed(request.taskId,initial.projectId);
    return this.operation(request.commandId, request, async resume => {
      let value = this.topics.get(request.topic.conversationId, request.topic.scope.topicId);
      if (!resume && value.revision !== request.expectedRevision) throw new TaskError("CONFLICT", "Topic changed; refresh before attaching a task");
      this.taskAllowed(request.taskId, value.projectId);
      if (!value.taskIds.includes(request.taskId)) value = this.topics.update({ conversationId: value.conversationId, topicId: value.id, expectedRevision: value.revision, taskId: request.taskId });
      if (value.projectId) projects.linkTask(projects.placementProject(value.projectId).session, request.taskId);
      return { topic: value, taskId: request.taskId };
    });
  }
}
