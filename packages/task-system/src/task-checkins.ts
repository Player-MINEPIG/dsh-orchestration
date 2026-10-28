import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Task, Run, Attempt, DispatchOrigin, Event } from "./contracts.js";
import type { SessionMessage, CheckinRef } from "./remote/ports.js";
import { TaskError, type TaskLedger } from "./ledger.js";
import {executionCheckId,executionDueAt,type ExecutionExpectationView} from "./execution-expectation.js";

const identifier = z.string().min(1).max(200);
const instant = z.iso.datetime({ offset: true });
export const CheckinCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), taskId: identifier }).strict(),
  z
    .object({
      action: z.literal("responsibility"),
      commandId: identifier,
      taskId: identifier,
      expectedVersion: identifier,
      state: z.enum(["coordinator", "needs_user", "resolved"]),
      summary: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("request"),
      commandId: identifier,
      taskId: identifier,
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      commandId: identifier,
      taskId: identifier,
      observation: z.enum([
        "working",
        "waiting_children",
        "waiting_external",
        "blocked",
      ]),
      summary: z.string().min(1).max(2000),
      plan: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("scheduled"),
            nextCheckAt: instant.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("paused"),
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export type CheckinCommand = z.infer<typeof CheckinCommand>;
type SessionOrigin = Extract<DispatchOrigin, { kind: "session" }>;
export interface ResponsibilityReceipt {
  state: "coordinator" | "needs_user" | "resolved";
  summary: string;
  at: string;
  nodeId: string;
  sessionId: string;
  fingerprint: string;
  revision: number;
}
type Plan =
  | { kind: "scheduled"; nextCheckAt: string }
  | { kind: "paused"; reason: string };
export interface CheckinRecord {
  taskId: string;
  revision: number;
  plan: Plan;
  observation?: {
    kind: "working" | "waiting_children" | "waiting_external" | "blocked";
    summary: string;
    at: string;
  };
  pendingMessageId?: string;
  requested?: boolean;
  checksWithoutUpdate: number;
  deliveryFailures: number;
  attention?: "no_update" | "delivery_unavailable";
}
export type CheckinCategory =
  | "closed"
  | "not_admitted"
  | "needs_owner"
  | "protected_execution"
  | "approval"
  | "waiting_user"
  | "active_execution"
  | "result_pending"
  | "return_unavailable"
  | "waiting_children"
  | "waiting_execution"
  | "coordinating"
  | "ready";
export interface CheckinView {
  execution: ExecutionExpectationView;
  phase:
    | "untracked"
    | "scheduled"
    | "paused"
    | "queued"
    | "deferred"
    | "needs_action"
    | "needs_owner"
    | "closed";
  category: CheckinCategory;
  reason: string;
  canRequest: boolean;
  revision: number;
  nextCheckAt: string | null;
  observation: CheckinRecord["observation"] | null;
  checksWithoutUpdate: number;
  deliveryFailures: number;
  pendingMessageId: string | null;
  parentTaskId?: string;
  responsibilityVersion: string;
  approvalRequired: boolean;
  responsibility: Omit<
    ResponsibilityReceipt,
    "fingerprint" | "revision"
  > | null;
}
const reasons: Record<CheckinCategory, string> = {
  closed: "任务已结束或结果已验收，无需自动检查",
  not_admitted: "观察事项或计划容器尚未成为负责会话的任务",
  needs_owner: "未记录负责会话，不能自动选择替代会话",
  protected_execution: "负责会话属于受管执行租约，请通过原执行或人工核实处理",
  approval: "等待用户确认，不会通过检查授予执行权限",
  waiting_user: "负责会话明确等待你的决定，暂停自动检查",
  active_execution: "实际执行租约仍有效，检查暂缓",
  result_pending: "已有结果回信等待负责会话处理，检查暂缓",
  return_unavailable: "原会话连续三次未能处理结果回信，已停止自动检查；请先重试回信",
  waiting_children: "正在等待已派发的子任务，完成事件会返回；正常等待期间不重复检查",
  waiting_execution: "任务尚未开始执行，预计执行上界尚未计时",
  coordinating: "统筹任务等待结果事件，不使用周期问询；可手动检查",
  ready: "到期后请负责会话核对任务并更新进度",
};

/** A check changes follow-up metadata, never the Task/Run business outcome. */
export class TaskCheckins {
  private readonly db;
  readonly intervalMs: number;
  constructor(
    private readonly ledger: TaskLedger,
    intervalMs = 300_000,
  ) {
    this.db = ledger.managementDatabase();
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < 1000 ||
      intervalMs > 86_400_000
    )
      throw new TaskError("INVALID", "Invalid task check-in interval");
    this.intervalMs = intervalMs;
  }
  private now() {
    return this.ledger.managementNow();
  }
  private read<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM entities WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private rows<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM entities WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((row) => JSON.parse(String(row.data)));
  }
  private write(
    kind: string,
    id: string,
    value: unknown,
    parent: string,
    state: string | null = null,
  ) {
    this.db
      .prepare(
        "INSERT INTO entities(kind,id,parent,state,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent=excluded.parent,state=excluded.state,data=excluded.data",
      )
      .run(kind, id, parent, state, JSON.stringify(value));
  }
  private audit(type: string, taskId: string, detail: Event["detail"]) {
    const event: Event = {
      eventId: randomUUID(),
      type,
      taskId,
      at: this.now(),
      detail,
    };
    this.db
      .prepare("INSERT INTO events(id,task_id,data) VALUES(?,?,?)")
      .run(event.eventId, taskId, JSON.stringify(event));
  }
  private record(taskId: string) {
    return this.read<CheckinRecord>("taskCheckin", taskId);
  }
  private owner(task: Task) {
    return task.dispatchOrigin?.kind === "session"
      ? task.dispatchOrigin
      : undefined;
  }
  private latestRun(taskId:string) {
    return this.rows<Run>("run").findLast(run=>run.taskId===taskId && !run.historyOnly && !run.observationOnly);
  }
  private executionOpen(run:Run) {
    const task=this.ledger.getTask(run.taskId);
    return ["queued","running"].includes(run.state) && this.latestRun(run.taskId)?.runId===run.runId && !["cancelled","archived","completed"].includes(task.state) && !task.manualCompletion;
  }
  private executionDeferred(run:Run) {
    let task:Task|undefined=this.ledger.getTask(run.taskId);
    const seen=new Set<string>();
    while(task && !seen.has(task.taskId)) {
      seen.add(task.taskId);
      const record=this.record(task.taskId),receipt=this.responsibilityState(task.taskId).receipt;
      if(record?.plan.kind==="paused" || receipt?.state==="needs_user" || receipt?.state==="resolved" || this.approvalRequired(task.taskId))return true;
      task=task.parentTaskId?this.ledger.getTask(task.parentTaskId):undefined;
    }
    return false;
  }
  private executionPrompt(run:Run) {
    const expectation=run.executionExpectation;
    if(expectation?.phase!=="started")throw new TaskError("CONFLICT","Execution progress has not started");
    return `任务超过派发时设置的预计执行上界。请核对中央 task_query/task_history/task_wait 的当前进度、已有报告及正在等待的子任务，记录下一步或说明需要人工处理。此问询不授予取消、重跑、新建Run或扩大权限的授权；不要因超出预计时间就终止真实工作。同一Run的这次到期只提醒一次，完成事件仍照常返回。\n${JSON.stringify({taskId:run.taskId,runId:run.runId,expectedExecutionMs:expectation.expectedExecutionMs,startedAt:expectation.startedAt,dueAt:executionDueAt(expectation)})}`;
  }
  private enqueueExecutions() {
    for(const run of this.rows<Run>("run")) {
      const expectation=run.executionExpectation;
      if(expectation?.phase!=="started" || executionDueAt(expectation)>this.now() || !this.executionOpen(run))continue;
      const messageId=executionCheckId(run.runId);
      if(this.read<SessionMessage>("sessionMessage",messageId))continue;
      const origin=run.dispatchOrigin;
      if(origin?.kind!=="session")continue;
      const protectedOrigin=!!origin.parentLease;
      const message:SessionMessage={messageId,taskId:run.taskId,nodeId:origin.nodeId,sessionId:origin.sessionId,workspaceId:"origin-session",checkIn:{kind:"execution-deadline",eventId:messageId,origin:structuredClone(origin),runId:run.runId,tasks:[],automatic:true},text:this.executionPrompt(run),state:protectedOrigin?"failed":"queued",createdAt:this.now(),updatedAt:this.now(),...(protectedOrigin?{reply:"原调度会话属于受管执行租约，不能通过超时问询恢复旧租约；请人工核实原执行。"}:{})};
      this.write("sessionMessage",messageId,message,run.taskId,message.state);
      this.audit("task.execution_check_queued",run.taskId,{runId:run.runId,messageId});
    }
  }
  executionView(taskId:string):ExecutionExpectationView {
    const run=this.latestRun(taskId),expectation=run?.executionExpectation;
    if(!run || !expectation)return {phase:"not_set"};
    if(expectation.phase==="pending_start")return expectation;
    const dueAt=executionDueAt(expectation),message=this.read<SessionMessage>("sessionMessage",executionCheckId(run.runId));
    const scopeUnavailable=run.dispatchOrigin?.kind!=="session";
    const withdrawn=message?.withdrawn || !this.executionOpen(run);
    return {phase:message?.state==="completed"?"processed":withdrawn?"withdrawn":scopeUnavailable?"needs_action":message?.state==="failed"?"needs_action":message?.state==="queued"?"queued":dueAt<=this.now()?"due":"running",expectedExecutionMs:expectation.expectedExecutionMs,startedAt:expectation.startedAt,dueAt,...(message?{messageId:message.messageId,...(!withdrawn && message.reply?{reason:message.reply}:{})}:{}),...(!withdrawn && scopeUnavailable?{reason:"未记录可安全接收问询的原调度会话，不能自动选择替代会话"}:{})};
  }
  private responsibilityState(taskId: string) {
    const receipt = this.read<ResponsibilityReceipt>(
      "taskResponsibility",
      taskId,
    );
    const scope = this.responsibilityScope(taskId);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          tasks: [...this.responsibilityTaskIds(taskId)].map((id) => [
            id,
            this.ledger.taskActionState(id).fingerprint,
          ]),
          scope: scope.map((run) => [
            run.runId,
            this.ledger.taskActionState(run.taskId).fingerprint,
          ]),
          returns: this.ledger
            .sessionMessages(taskId)
            .filter((m) => m.completion || (m.checkIn?.kind==="execution-deadline" && (m.state!=="queued" || (m.deliveryAttempts??0)>0)))
            .map((m) => m.checkIn?.kind==="execution-deadline" ? [m.messageId,m.deliveryAttempts??0,m.state,!!m.withdrawn] : [m.messageId, m.deliveryAttempts ?? 0]),
          attention: this.record(taskId)?.attention ?? null,
        }),
      )
      .digest("hex");
    return {
      fingerprint,
      receipt: receipt?.fingerprint === fingerprint ? receipt : undefined,
      version: createHash("sha256")
        .update(JSON.stringify({ fingerprint, receipt }))
        .digest("hex"),
    };
  }
  private responsibilityTaskIds(taskId: string) {
    const tasks = this.rows<Task>("task"),
      ids = new Set([taskId]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const task of tasks)
        if (
          task.parentTaskId &&
          ids.has(task.parentTaskId) &&
          !ids.has(task.taskId)
        ) {
          ids.add(task.taskId);
          changed = true;
        }
    }
    return ids;
  }
  private responsibilityScope(taskId: string) {
    const ids = this.responsibilityTaskIds(taskId);
    const runs = this.rows<Run>("run").filter(
      (run) => !run.historyOnly && !run.observationOnly,
    );
    const scope = new Set(
      runs.filter((run) => ids.has(run.taskId)).map((run) => run.runId),
    );
    for (let changed = true; changed; ) {
      changed = false;
      for (const run of runs)
        if (
          run.parentRunId &&
          scope.has(run.parentRunId) &&
          !scope.has(run.runId)
        ) {
          scope.add(run.runId);
          changed = true;
        }
    }
    return runs.filter((run) => scope.has(run.runId));
  }
  private approvalRequired(taskId: string) {
    return (
      [...this.responsibilityTaskIds(taskId)].some(
        (id) => this.ledger.taskActionState(id).confirmationPending,
      ) ||
      this.responsibilityScope(taskId).some(
        (run) =>
          run.reviewStatus === "pending_user" ||
          this.ledger.taskActionState(run.taskId).confirmationPending,
      )
    );
  }
  communicationState(taskId: string) {
    const task = this.ledger.getTask(taskId), scope = this.responsibilityScope(taskId);
    const latest = this.latestRun(taskId);
    const active = scope.some(run => ["queued", "running"].includes(run.state));
    const uncertain = scope.some(run => run.state === "uncertain");
    const materialsPending = [...this.responsibilityTaskIds(taskId)].some(id => this.ledger.getTask(id).manualCompletion?.materials === "pending");
    const settledCancellation = task.state === "cancelled" && !active && !uncertain && !materialsPending && !this.approvalRequired(taskId);
    const relevant = new Set(scope.filter(run => run.runId === latest?.runId || ["queued", "running", "uncertain"].includes(run.state) || run.reviewStatus === "pending_user").map(run => run.runId));
    const messages = this.ledger.sessionMessages(taskId);
    const latestReturns = new Map<string, SessionMessage>();
    for (const message of messages) {
      const check = message.checkIn;
      if (message.completion && relevant.has(message.completion.runId)) latestReturns.set(message.completion.runId, message);
      else if (check?.kind === "execution-deadline" && !message.withdrawn && scope.some(run => run.runId === check.runId && this.executionOpen(run))) latestReturns.set(check.runId, message);
    }
    const failure = settledCancellation ? undefined : [...latestReturns.values()].findLast(message => message.state === "failed");
    const failedCheck = messages.findLast(message => message.checkIn && message.checkIn.kind !== "execution-deadline" && message.state === "failed");
    const latestReturn = latest ? latestReturns.get(latest.runId) : undefined;
    const recoveredCheck = latestReturn?.completion && latestReturn.state === "completed" && failedCheck && latestReturn.createdAt >= failedCheck.createdAt && !scope.some(run => run.runId !== latest?.runId && ["queued", "running", "uncertain"].includes(run.state));
    return {settledCancellation, active, uncertain, materialsPending, failure, deliveryBlocked: !settledCancellation && !recoveredCheck && (this.record(taskId)?.deliveryFailures ?? 0) >= 3};
  }
  private effectiveAttention(record: CheckinRecord | undefined) {
    return record?.attention === "delivery_unavailable" && !this.communicationState(record.taskId).deliveryBlocked ? undefined : record?.attention;
  }
  private category(task: Task): CheckinCategory {
    const runs = this.rows<Run>("run").filter(
      (run) => !run.historyOnly && !run.observationOnly,
    );
    const own = runs.filter((run) => run.taskId === task.taskId),
      latest = own.at(-1);
    if (
      ["cancelled", "archived"].includes(task.state) ||
      latest?.reviewStatus === "accepted" ||
      latest?.state === "cancelled" ||
      task.manualCompletion
    )
      return "closed";
    if (
      (task.state === "completed" && latest?.reviewStatus !== "rejected") ||
      (latest?.state === "succeeded" &&
        !["rejected", "pending_user"].includes(latest.reviewStatus ?? ""))
    )
      return "closed";
    if (
      task.parentTaskId ||
      task.kind === "observed" ||
      task.kind === "scheduled" ||
      task.state === "candidate" ||
      task.admissionState === "dismissed"
    )
      return "not_admitted";
    const owner = this.owner(task);
    if (!owner) return "needs_owner";
    if (owner.parentLease) return "protected_execution";
    if(this.communicationState(task.taskId).failure)return "return_unavailable";
    if (
      task.confirmation?.state === "pending" ||
      latest?.reviewStatus === "pending_user"
    )
      return "approval";
    if (this.responsibilityState(task.taskId).receipt?.state === "resolved")
      return "closed";
    if (this.responsibilityState(task.taskId).receipt?.state === "needs_user")
      return "waiting_user";
    const scope = new Set(latest ? [latest.runId] : []);
    for (let changed = true; changed; ) {
      changed = false;
      for (const run of runs)
        if (
          run.parentRunId &&
          scope.has(run.parentRunId) &&
          !scope.has(run.runId)
        ) {
          scope.add(run.runId);
          changed = true;
        }
    }
    const now = Date.parse(this.now());
    const children=runs.filter(run=>run.runId!==latest?.runId && scope.has(run.runId) && this.latestRun(run.taskId)?.runId===run.runId);
    const childFault=children.some(run=>["uncertain","failed","blocked","partial"].includes(run.state) && run.reviewStatus!=="accepted");
    if(!childFault && children.some(run=>["queued","running"].includes(run.state)))return "waiting_children";
    if(!childFault && latest?.coordinatorSession)return "coordinating";
    if(latest?.state==="queued" && latest.dispatchIssue?.kind!=="needs_action")return "waiting_execution";
    if (
      !childFault && this.rows<Attempt>("attempt").some(
        (attempt) =>
          scope.has(attempt.runId) &&
          ["leased", "running"].includes(attempt.state) &&
          Date.parse(attempt.leaseExpiresAt) > now &&
          runs.some(
            (run) =>
              run.runId === attempt.runId &&
              run.currentAttemptId === attempt.attemptId &&
              run.state === "running",
          ),
      )
    )
      return "active_execution";
    if (
      this.rows<SessionMessage>("sessionMessage").some(
        (message) =>
          message.state === "queued" &&
          message.completion?.origin.kind === "session" &&
          message.nodeId === owner.nodeId &&
          message.sessionId === owner.sessionId,
      )
    )
      return "result_pending";
    return "ready";
  }
  capture(task: Task) {
    if (
      task.parentTaskId ||
      this.record(task.taskId) ||
      !this.owner(task) ||
      this.owner(task)?.parentLease ||
      task.kind === "observed" ||
      task.kind === "scheduled"
    )
      return;
    this.write(
      "taskCheckin",
      task.taskId,
      {
        taskId: task.taskId,
        revision: 0,
        plan: {
          kind: "scheduled",
          nextCheckAt: new Date(
            Date.parse(this.now()) + this.intervalMs,
          ).toISOString(),
        },
        checksWithoutUpdate: 0,
        deliveryFailures: 0,
      } satisfies CheckinRecord,
      task.taskId,
    );
  }
  view(taskId: string): CheckinView {
    const task = this.ledger.getTask(taskId),
      record = this.record(taskId),
      category = this.category(task);
    const responsibility = this.responsibilityState(taskId);
    const attention = this.effectiveAttention(record);
    const eligible = ![
      "closed",
      "not_admitted",
      "needs_owner",
      "protected_execution",
      "return_unavailable",
    ].includes(category);
    const phase =
      category === "closed" || category === "not_admitted"
        ? "closed"
        : category === "needs_owner"
          ? "needs_owner"
          : category === "protected_execution" ||
              category === "return_unavailable" ||
              attention
            ? "needs_action"
            : record?.pendingMessageId || record?.requested
              ? "queued"
              : record?.plan.kind === "paused"
                ? "paused"
                : !record
                  ? "untracked"
                  : category !== "ready"
                    ? "deferred"
                    : "scheduled";
    const reason = category === "closed"
      ? reasons.closed
      : task.parentTaskId
      ? "子任务由父任务跟进，请检查父任务"
      : attention === "no_update"
        ? "连续三次检查未记录进度，已停止自动检查；可人工检查恢复"
        : attention === "delivery_unavailable"
          ? "负责会话连续三次无法处理检查，请修复会话后人工检查"
          : record?.plan.kind === "paused"
            ? record.plan.reason
            : reasons[category];
    return {
      execution:this.executionView(taskId),
      phase,
      category,
      reason,
      canRequest: eligible,
      revision: record?.revision ?? 0,
      nextCheckAt:
        category !== "closed" && record?.plan.kind === "scheduled" ? record.plan.nextCheckAt : null,
      observation: record?.observation ?? null,
      checksWithoutUpdate: record?.checksWithoutUpdate ?? 0,
      deliveryFailures: record?.deliveryFailures ?? 0,
      pendingMessageId: record?.pendingMessageId ?? null,
      responsibilityVersion: responsibility.version,
      approvalRequired: this.approvalRequired(taskId),
      responsibility: responsibility.receipt
        ? {
            state: responsibility.receipt.state,
            summary: responsibility.receipt.summary,
            at: responsibility.receipt.at,
            nodeId: responsibility.receipt.nodeId,
            sessionId: responsibility.receipt.sessionId,
          }
        : null,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    };
  }
  command(raw: CheckinCommand, actor: DispatchOrigin | undefined): CheckinView {
    const input = CheckinCommand.parse(raw),
      task = this.ledger.getTask(input.taskId),
      owner = this.owner(task);
    if (
      actor?.kind !== "session" ||
      !owner ||
      owner.parentLease ||
      actor.nodeId !== owner.nodeId ||
      actor.sessionId !== owner.sessionId ||
      actor.cwd !== owner.cwd
    )
      throw new TaskError(
        "FORBIDDEN",
        "Only the recorded responsible session can manage this check-in",
      );
    if (input.action === "status") return this.view(input.taskId);
    if (input.action === "responsibility")
      return this.ledger.managementCommand(
        input.commandId,
        "task_checkin.responsibility",
        { input, actor },
        () => {
          const current = this.responsibilityState(input.taskId);
          if (input.expectedVersion !== current.version)
            throw new TaskError(
              "CONFLICT",
              "Task evidence or responsibility changed; read status before updating",
            );
          if (input.state === "resolved" && this.approvalRequired(task.taskId))
            throw new TaskError(
              "FORBIDDEN",
              "Responsible sessions cannot resolve user approval or result review",
            );
          if (
            input.state === "resolved" &&
            this.responsibilityScope(task.taskId).some((run) =>
              ["queued", "running", "uncertain"].includes(run.state),
            )
          )
            throw new TaskError(
              "CONFLICT",
              "Execution or its child effects are still active or uncertain; verify stopped before resolving responsibility",
            );
          const receipt: ResponsibilityReceipt = {
            state: input.state,
            summary: input.summary,
            at: this.now(),
            nodeId: actor.nodeId,
            sessionId: actor.sessionId,
            fingerprint: current.fingerprint,
            revision: (current.receipt?.revision ?? 0) + 1,
          };
          this.write(
            "taskResponsibility",
            task.taskId,
            receipt,
            task.taskId,
            input.state,
          );
          this.audit("task.responsibility_updated", task.taskId, {
            state: receipt.state,
            summary: receipt.summary,
            nodeId: receipt.nodeId,
            sessionId: receipt.sessionId,
          });
          return this.view(task.taskId);
        },
      );
    if (input.action === "request")
      return this.request(input.commandId, input.taskId);
    return this.ledger.managementCommand(
      input.commandId,
      "task_checkin.update",
      { input, actor },
      () => {
        if (["closed", "not_admitted"].includes(this.category(task)))
          throw new TaskError("TERMINAL", "Task is not open for check-ins");
        this.capture(task);
        const record = this.record(task.taskId);
        if (!record)
          throw new TaskError(
            "FORBIDDEN",
            "Task does not have an eligible responsibility scope",
          );
        const next =
          input.plan.kind === "scheduled"
            ? Date.parse(
                input.plan.nextCheckAt ??
                  new Date(
                    Date.parse(this.now()) + this.intervalMs,
                  ).toISOString(),
              )
            : undefined;
        if (
          next !== undefined &&
          (next <= Date.parse(this.now()) ||
            next > Date.parse(this.now()) + 30 * 86_400_000)
        )
          throw new TaskError(
            "INVALID",
            "Next check must be in the future and within 30 days",
          );
        record.revision++;
        record.plan =
          input.plan.kind === "paused"
            ? input.plan
            : { kind: "scheduled", nextCheckAt: new Date(next!).toISOString() };
        record.observation = {
          kind: input.observation,
          summary: input.summary,
          at: this.now(),
        };
        record.checksWithoutUpdate = 0;
        record.deliveryFailures = 0;
        delete record.attention;
        delete record.requested;
        this.write("taskCheckin", task.taskId, record, task.taskId);
        this.audit("task.checkin_updated", task.taskId, {
          observation: input.observation,
          summary: input.summary,
          plan: record.plan,
        });
        return this.view(task.taskId);
      },
    );
  }
  request(commandId: string, taskId: string): CheckinView {
    return this.ledger.managementCommand(
      commandId,
      "task_checkin.request",
      { taskId },
      () => {
        const task = this.ledger.getTask(taskId),
          view = this.view(taskId);
        if (!view.canRequest) return view;
        this.capture(task);
        const record = this.record(taskId);
        if (!record)
          throw new TaskError(
            "FORBIDDEN",
            "Task does not have an eligible responsibility scope",
          );
        if (!record.pendingMessageId) {
          record.checksWithoutUpdate = 0;
          record.deliveryFailures = 0;
          delete record.attention;
          record.requested = true;
          this.write("taskCheckin", taskId, record, taskId);
          if (["ready", "approval", "waiting_user", "waiting_children", "coordinating", "waiting_execution"].includes(this.category(task)))
            this.enqueue([record], false);
        }
        return this.view(taskId);
      },
    );
  }
  private enqueue(records: CheckinRecord[], automatic: boolean) {
    const first = records[0]!;
    const owner = this.owner(this.ledger.getTask(first.taskId))!;
    const pending = this.rows<SessionMessage>("sessionMessage").find(
      (message) =>
        message.checkIn &&
        message.state === "queued" &&
        message.nodeId === owner.nodeId &&
        message.sessionId === owner.sessionId,
    );
    if (pending) return;
    const messageId = `task-checkin:${randomUUID()}`;
    const message: SessionMessage = {
      messageId,
      taskId: first.taskId,
      nodeId: owner.nodeId,
      sessionId: owner.sessionId,
      workspaceId: "origin-session",
      checkIn: {
        eventId: messageId,
        origin: owner,
        tasks: records.map((record) => ({
          taskId: record.taskId,
          revision: record.revision,
        })),
        automatic,
      },
      text: this.prompt(records),
      state: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.write("sessionMessage", messageId, message, first.taskId, "queued");
    for (const record of records) {
      record.pendingMessageId = messageId;
      delete record.requested;
      this.write("taskCheckin", record.taskId, record, record.taskId);
    }
  }
  private prompt(records: CheckinRecord[]) {
    return `任务进度检查。你是这些任务已记录的负责会话，可自行完成或按既有授权派发子任务。请先用 task_checkin(action=status) 核对当前检查计划，再读取 task_history/task_query/task_wait 的当前记录和已有报告，核对实际进度。不要把回信ACK、空闲或工具文字当成任务完成，也不要重复已完成的外部操作。在聊天中接手处理时，请先用 task_checkin(action=status) 读取 responsibilityVersion，再用 action=responsibility、expectedVersion、state=coordinator、summary 明确由你跟进。只有需要用户决定、授权或你无法修复的阻碍时才用 needs_user，summary 写清具体卡点和所需决定；你已核实本轮异常处理完毕时用 resolved 并说明处理结果，这只关闭本轮跟进，不替代正式提交或人工验收。新执行、报告或审核变化会使声明失效。若工作已完成，请用现有 task_submit_result 等正式工具收尾；草稿可按现有项目和 creator 权限先 task_bind_dispatcher。若仍需继续、等待子任务/外部条件或人工处理，请用 task_checkin(action=update,taskId,commandId,observation,summary,plan) 记录进度和下一次检查时间，或暂停并说明原因。若现有工具/权限不允许收尾，明确记录限制，不能扩大权限。此检查不授予审批、执行租约或重跑结果不确定操作的权限。若当前任务已结束，不再执行。\n${JSON.stringify(records.map((record) => ({ taskId: record.taskId, title: this.ledger.getTask(record.taskId).title, category: this.category(this.ledger.getTask(record.taskId)), previousObservation: record.observation ?? null })))}\n如果原会话能力中没有 task_checkin，使用已有正式任务工具完成可做的工作，并说明无法设置检查时间；不要自行安装或扩大工具权限。`;
  }
  tick() {
    this.ledger.workflowAtomic(() => {
      this.enqueueExecutions();
      for (const message of this.rows<SessionMessage>("sessionMessage")) {
        if (
          message.checkIn &&
          message.state === "queued" &&
          this.disposition(message) === "obsolete"
        ) {
          this.acknowledge(message, []);
          message.state = "completed";
          message.withdrawn=true;
          message.reply =
            "Check-in superseded or tasks closed before admission";
          message.updatedAt = this.now();
          this.write(
            "sessionMessage",
            message.messageId,
            message,
            message.taskId,
            message.state,
          );
        }
      }
      const groups = new Map<string, CheckinRecord[]>();
      for (const record of this.rows<CheckinRecord>("taskCheckin")) {
        const task = this.ledger.getTask(record.taskId),
          category = this.category(task);
        if (["closed", "not_admitted"].includes(category)) {
          this.cancelPending(record);
          continue;
        }
        if (
          record.pendingMessageId ||
          this.effectiveAttention(record) ||
          (!record.requested &&
            (record.plan.kind === "paused" ||
              record.plan.nextCheckAt > this.now())) ||
          (category !== "ready" &&
            !(
              record.requested &&
              ["approval", "waiting_user"].includes(category)
            ))
        )
          continue;
        const owner = this.owner(task)!;
        const key = JSON.stringify([
          owner.nodeId,
          owner.sessionId,
          owner.cwd,
          !!record.requested,
        ]);
        const group = groups.get(key) ?? [];
        if (group.length < 8) group.push(record);
        groups.set(key, group);
      }
      for (const records of [...groups.values()].slice(0, 4))
        this.enqueue(records, !records[0]!.requested);
    });
  }
  private cancelPending(record: CheckinRecord) {
    if (!record.pendingMessageId) return;
    const message = this.read<SessionMessage>(
      "sessionMessage",
      record.pendingMessageId,
    );
    delete record.pendingMessageId;
    this.write("taskCheckin", record.taskId, record, record.taskId);
    if (
      message?.state === "queued" &&
      message.checkIn?.tasks.every((ref) =>
        ["closed", "not_admitted"].includes(
          this.category(this.ledger.getTask(ref.taskId)),
        ),
      )
    ) {
      message.state = "completed";
      message.reply = "Tasks closed before check-in admission";
      message.updatedAt = this.now();
      this.write(
        "sessionMessage",
        message.messageId,
        message,
        message.taskId,
        message.state,
      );
    }
  }
  disposition(message: SessionMessage): "ready" | "defer" | "obsolete" {
    if(message.checkIn?.kind==="execution-deadline") {
      const run=this.read<Run>("run",message.checkIn.runId);
      if(!run || run.taskId!==message.taskId || run.dispatchOrigin?.kind!=="session" || run.dispatchOrigin.nodeId!==message.nodeId || run.dispatchOrigin.sessionId!==message.sessionId || run.executionExpectation?.phase!=="started" || executionDueAt(run.executionExpectation)>this.now() || !this.executionOpen(run))return "obsolete";
      return this.executionDeferred(run)?"defer":"ready";
    }
    let deferred = false;
    for (const ref of message.checkIn?.tasks ?? []) {
      const record = this.record(ref.taskId);
      if (
        !record ||
        record.pendingMessageId !== message.messageId ||
        record.revision !== ref.revision
      )
        continue;
      const category = this.category(this.ledger.getTask(ref.taskId));
      if (
        [
          "closed",
          "not_admitted",
          "needs_owner",
          "protected_execution",
        ].includes(category)
      )
        continue;
      if (
        category === "ready" ||
        (!message.checkIn?.automatic && ["approval", "waiting_user","waiting_children","coordinating","waiting_execution"].includes(category))
      )
        return "ready";
      deferred = true;
    }
    return deferred ? "defer" : "obsolete";
  }
  prepare(message: SessionMessage): SessionMessage {
    if(message.checkIn?.kind==="execution-deadline")return {...message,text:this.executionPrompt(this.ledger.getRun(message.checkIn.runId))};
    const records = (message.checkIn?.tasks ?? []).flatMap((ref) => {
      const record = this.record(ref.taskId);
      if (
        !record ||
        record.pendingMessageId !== message.messageId ||
        record.revision !== ref.revision
      )
        return [];
      const category = this.category(this.ledger.getTask(ref.taskId));
      return category === "ready" ||
        (!message.checkIn?.automatic && ["approval", "waiting_user","waiting_children","coordinating","waiting_execution"].includes(category))
        ? [record]
        : [];
    });
    return message.checkIn
      ? {
          ...message,
          checkIn: {
            ...message.checkIn,
            tasks: records.map((record) => ({
              taskId: record.taskId,
              revision: record.revision,
            })),
          },
          text: this.prompt(records),
        }
      : message;
  }
  acknowledge(message: SessionMessage, admitted: CheckinRef[]) {
    if(message.checkIn?.kind==="execution-deadline")return;
    const asked = new Set(admitted.map((ref) => JSON.stringify(ref)));
    for (const ref of message.checkIn?.tasks ?? []) {
      const record = this.record(ref.taskId);
      if (!record || record.pendingMessageId !== message.messageId) continue;
      delete record.pendingMessageId;
      record.deliveryFailures = 0;
      if (
        asked.has(JSON.stringify(ref)) &&
        record.revision === ref.revision &&
        this.category(this.ledger.getTask(ref.taskId)) === "ready"
      ) {
        if (message.checkIn?.automatic && ++record.checksWithoutUpdate >= 3)
          record.attention = "no_update";
        if (record.plan.kind === "scheduled")
          record.plan.nextCheckAt = new Date(
            Date.parse(this.now()) + this.intervalMs,
          ).toISOString();
      }
      this.write("taskCheckin", record.taskId, record, record.taskId);
    }
  }
  failure(message: SessionMessage, busy: boolean) {
    if(message.checkIn?.kind==="execution-deadline")return;
    if (busy) return;
    for (const ref of message.checkIn?.tasks ?? []) {
      const record = this.record(ref.taskId);
      if (
        !record ||
        record.pendingMessageId !== message.messageId ||
        record.revision !== ref.revision
      )
        continue;
      if (++record.deliveryFailures >= 3) {
        record.attention = "delivery_unavailable";
        message.state = "failed";
      }
      this.write("taskCheckin", record.taskId, record, record.taskId);
    }
    if (message.state === "failed")
      for (const ref of message.checkIn?.tasks ?? []) {
        const record = this.record(ref.taskId);
        if (record?.pendingMessageId === message.messageId) {
          delete record.pendingMessageId;
          this.write("taskCheckin", record.taskId, record, record.taskId);
        }
      }
  }
}
