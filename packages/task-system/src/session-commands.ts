import { CheckinCommand } from "./task-checkins.js";
import { z } from "zod";
import { ExecutionModelChoice } from "./execution-models.js";
import { TaskReadOptions, taskRead, runSummary } from "./task-reads.js";
import { TaskError, type TaskLedger } from "./ledger.js";
import { Workbench } from "./workbench.js";
import type { ProjectSessionInput } from "./project-collaboration/types.js";
import type { Json } from "./contracts.js";

const Policy = z.object({allowedNodeIds:z.array(z.string()).optional(),allowedWorkspaceIds:z.array(z.string()).optional(),allowedTools:z.array(z.string()).optional(),allowedBackends:z.array(z.string()).optional(),maxDepth:z.number().int().nonnegative().optional(),maxChildren:z.number().int().nonnegative().optional(),maxDescendants:z.number().int().nonnegative().optional(),settlementQuietMs:z.number().int().min(0).max(30000).optional()}).strict();
const text = z.string().min(1).max(200);
export const SessionCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("projects") }).strict(),
  z.object({ kind: z.literal("checkin"), input: CheckinCommand }).strict(),
  z.object({ kind: z.literal("create"), title: z.string().min(1).max(1000), description: z.string().max(20000).optional(), goal: z.string().max(5000).optional(), requiresConfirmation: z.boolean().optional(), policy: Policy.optional() }).strict(),
  z.object({ kind: z.literal("bind"), taskId: text }).strict(),
  z.object({ kind: z.literal("query"), read:TaskReadOptions.optional() }).strict(),
  z.object({ kind: z.literal("history"), taskId: text, read:TaskReadOptions.optional() }).strict(),
  z.object({kind:z.literal("cancel"),taskId:text,runId:text.optional(),reason:z.string().min(1).max(1000),expectedActionVersion:text.optional()}).strict(),
  z.object({kind:z.literal("repair"),taskId:text,runId:text,expectedActionVersion:text,executionModel:ExecutionModelChoice.optional()}).strict(),
  z.object({ kind: z.literal("wait"), taskId: text, quietMs: z.number().int().min(0).max(30000) }).strict(),
  z.object({ kind: z.literal("result"), outcome: z.enum(["success", "partial", "failure", "blocked", "unknown"]), summary: z.string().min(1).max(5000), report: z.object({ title: z.string().min(1).max(1000), body: z.string().max(20000), data: z.json().optional(), artifactIds: z.array(text).max(32).optional() }).strict().optional() }).strict(),
  z.object({ kind: z.literal("retryReturn"), messageId: text }).strict(),
]);
export type SessionCommand = z.infer<typeof SessionCommand>;
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));

/** Commands are evaluated only by the central ledger with an authenticated node. */
export class SessionDispatcherAuthority {
  private db;
  private wb;
  constructor(private ledger: TaskLedger) {
    this.db = ledger.managementDatabase();
    this.wb = new Workbench(ledger);
    this.db.exec("CREATE TABLE IF NOT EXISTS dispatcher_projects(node TEXT NOT NULL,session TEXT NOT NULL,project TEXT NOT NULL,cwd TEXT NOT NULL,PRIMARY KEY(node,session))");
  }
  select(nodeId: string, sessionId: string, cwd: string, projectId: string) {
    const active = this.ledger.dispatcherForSession(nodeId, sessionId);
    if (active && active.projectId !== projectId) throw new TaskError("CONFLICT", "Finish the current coordinated task before changing projects");
    this.db.prepare("INSERT INTO dispatcher_projects VALUES(?,?,?,?) ON CONFLICT(node,session) DO UPDATE SET project=excluded.project,cwd=excluded.cwd").run(nodeId, sessionId, projectId, cwd);
  }
  execute(nodeId: string, commandId: string, input: ProjectSessionInput): Json {
    const command = SessionCommand.parse(input.command);
    if (command.kind === "checkin") return json(this.ledger.taskCheckin(command.input.action === "status" ? command.input : {...command.input, commandId}));
    if (command.kind === "result" && this.ledger.commandReceipt(commandId)) {
      const {kind: _kind, ...result} = command;
      return json(this.ledger.submitDispatcherResult(commandId, {nodeId,sessionId:input.sessionId,...result}));
    }
    if (command.kind === "projects") return json(this.wb.snapshot().projects.filter(project => project.state !== "archived").map(project => ({ ...project, id: project.projectId })));
    const selected = this.db.prepare("SELECT project,cwd FROM dispatcher_projects WHERE node=? AND session=?").get(nodeId, input.sessionId);
    if (!selected || selected.cwd !== input.cwd) throw new TaskError("FORBIDDEN", "Bind this session to a central project first");
    const projectId = String(selected.project);
    if (input.projectId && input.projectId !== projectId) throw new TaskError("FORBIDDEN", "Project differs from session binding");
    const wb = this.wb.snapshot();
    const backlogs = wb.backlogs.filter(backlog => backlog.projectId === projectId);
    const taskIds = new Set(wb.backlogTasks.filter(link => backlogs.some(backlog => backlog.backlogId === link.backlogId)).map(link => link.taskId));
    const snapshot = this.ledger.querySnapshot();
    for (let changed = true; changed;) {
      changed = false;
      for (const task of snapshot.tasks) if (task.parentTaskId && taskIds.has(task.parentTaskId) && !taskIds.has(task.taskId)) { taskIds.add(task.taskId); changed = true; }
    }
    if ("taskId" in command && !taskIds.has(command.taskId)) throw new TaskError("FORBIDDEN", "Task is outside the current project");
    switch (command.kind) {
      case "create": {
        this.ledger.assertAcceptanceProjectPlan(projectId);
        const {kind: _kind, ...intent} = command;
        const receipt = this.ledger.createTask(commandId, intent);
        const backlog = backlogs[0];
        if (!backlog) throw new TaskError("NOT_FOUND", "Project backlog unavailable");
        this.wb.manage(`${commandId}:link`, "link_backlog_task", {backlogId: backlog.backlogId, taskId: receipt.value.taskId});
        return json(receipt);
      }
      case "bind": {
        const backlog = backlogs.find(backlog => wb.backlogTasks.some(link => link.backlogId === backlog.backlogId && link.taskId === command.taskId));
        if (!backlog) throw new TaskError("FORBIDDEN", "Draft is outside the selected project");
        return json(this.ledger.bindDispatcher(commandId, {nodeId, sessionId: input.sessionId, cwd: input.cwd, projectId, taskId: command.taskId, backlogId: backlog.backlogId}));
      }
      case "query": {
        if(command.read?.taskId && !taskIds.has(command.read.taskId))throw new TaskError("FORBIDDEN","Task is outside the current project");
        return json(taskRead({...snapshot,tasks:snapshot.tasks.filter(task=>taskIds.has(task.taskId))},command.read,id=>this.ledger.taskActionState(id).version));
      }
      case "history": {
        if(command.read?.taskId && command.read.taskId!==command.taskId)throw new TaskError("INVALID","History target differs from the authorized Task");
        const history=this.ledger.history(command.taskId);
        return json(taskRead({...history,tasks:[history.task]},command.read,id=>this.ledger.taskActionState(id).version,true));
      }
      case "cancel": {
        const {kind:_kind,...request}=command;
        const receipt=this.ledger.cancel(commandId,request);
        return json({commandId:receipt.commandId,acceptedAt:receipt.acceptedAt,taskId:receipt.value.taskId,state:receipt.value.state,runs:this.ledger.history(command.taskId).runs.map(run=>({runId:run.runId,state:run.state,cancellationRequested:!!run.cancellationRequested}))});
      }
      case "repair": {
        const {kind:_kind,...request}=command;
        const receipt=this.ledger.repairDispatch(commandId,request);
        return json({...receipt,value:runSummary(receipt.value)});
      }
      case "wait": {
        const dispatcher = this.ledger.dispatcherForSession(nodeId, input.sessionId);
        const rootRunId = dispatcher?.projectId === projectId && dispatcher.cwd === input.cwd && dispatcher.taskId === command.taskId
          ? dispatcher.runId
          : undefined;
        return json(this.ledger.allSettled(command.taskId, command.quietMs, rootRunId, !rootRunId));
      }
      case "result": {
        const active = this.ledger.dispatcherForSession(nodeId, input.sessionId);
        if (!active || active.projectId !== projectId || active.cwd !== input.cwd) throw new TaskError("FORBIDDEN", "Session has no active dispatcher in this project");
        const {kind: _kind, ...result} = command;
        return json(this.ledger.submitDispatcherResult(commandId, {nodeId, sessionId: input.sessionId, ...result}));
      }
      case "retryReturn": {
        const message=this.ledger.getSessionMessage(command.messageId);
        const origin = message.completion?.origin ?? (message.checkIn?.kind==="execution-deadline"?message.checkIn.origin:undefined);
        if (origin?.kind !== "session" || origin.nodeId !== nodeId || origin.sessionId !== input.sessionId || origin.cwd !== input.cwd) throw new TaskError("FORBIDDEN", "Only the original session can retry this result");
        return json(this.ledger.retryTaskReturn(commandId, command.messageId));
      }
    }
  }
}
