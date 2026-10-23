import type { ExecutorAlert, ExecutionDisposition } from "./executor-alerts.js";
/** Read-only public facts collected on this executor; never a scheduler mirror. */
export interface ExecutorPanelRecord {
  taskId: string;
  runId: string;
  title: string;
  description: string;
  state: string;
  source: "local-queue" | "local-recovery" | "local-ledger";
  nodeId: string;
  time: string;
  sessionIds: string[];
  parentTaskId?: string;
  parentRunId?: string;
  projectId?: string;
  projectTitle?: string;
  model?: string;
  workspaceId?: string;
  executionDirectory?: string;
  report?: string;
  detail?: string;
  outcome?: string;
  attemptId?: string;
  authorityDisposition?: ExecutionDisposition;
  dispositionObservedAt?: string;
  alert?: ExecutorAlert;
  authorityEndpoint?: string;
  authorityNotice?: string;
}

function presentation(row: ExecutorPanelRecord) {
  if(row.alert?.acknowledged && row.alert.canAcknowledge)return {status:"handled",stateLabel:"本机提醒已确认"};
  if((row.authorityDisposition?.taskState==="cancelled" || row.authorityDisposition?.runState==="cancelled") && ["acknowledged","cancelled","failed","blocked","partial","succeeded"].includes(row.state))return {status:"cancelled",stateLabel:"调度端任务已取消 · 本机已结束"};
  switch (row.state) {
    case "queued": return { status: "queued", stateLabel: "最近观察到等待领取" };
    case "claim_rejected": return { status: "error", stateLabel: "尚未领取 · 调度端拒绝" };
    case "claim_pending": return { status: "error", stateLabel: "领取待确认" };
    case "claim_uncertain": return { status: "error", stateLabel: "领取未确认" };
    case "dispatching": return { status: "running", stateLabel: "已领取 · 本机处理中" };
    case "running": return { status: "running", stateLabel: "本机执行中" };
    case "result": return { status: "review", stateLabel: "结果待回传" };
    case "acknowledged": return { status: ["failure", "blocked", "unknown", "partial"].includes(row.outcome ?? "") ? "error" : "done", stateLabel: "结果已回传" };
    case "retry_pending": return { status: "review", stateLabel: "重试回执待确认" };
    case "retry_scheduled": return { status: "done", stateLabel: "重试已登记" };
    case "cancellation": return { status: "cancelling", stateLabel: "本机取消中" };
    case "cancelled": return { status: "cancelled", stateLabel: "本机已取消" };
    case "succeeded": return { status: "done", stateLabel: "本机执行成功" };
    case "failed": case "blocked": case "partial": return { status: "error", stateLabel: "本机执行需处理" };
    default: return { status: "error", stateLabel: "本机状态待核实" };
  }
}

export function executorPanelSnapshot(nodeId: string, records: readonly ExecutorPanelRecord[]) {
  const byRun = new Map<string, ExecutorPanelRecord>();
  // Sources are ordered by ownership: a durable local dispatch supersedes queue observations.
  for (const row of records) if (row.nodeId === nodeId) byRun.set(row.runId, row);
  const runs = [...byRun.values()].map(row => ({
    id: row.runId, taskId: row.taskId, alert:row.alert??null, authorityEndpoint:row.authorityEndpoint??null,authorityNotice:row.authorityNotice??null,authorityDisposition:row.authorityDisposition??null, dispositionObservedAt:row.dispositionObservedAt??null, parentTaskId: row.parentTaskId ?? null,
    parentRunId: row.parentRunId ?? null, state: row.state, ...presentation(row),
    node: row.nodeId, model: row.model ?? null, createdAt: row.time,
    sessionIds: row.sessionIds, workspaceId: row.workspaceId ?? null,
    executionDirectory: row.executionDirectory ?? null, source: row.source,
    settlementSummary: row.report?.slice(0, 8000) ?? null, detail: row.detail?.slice(0, 500) ?? null,
  }));
  const latest = new Map<string, ExecutorPanelRecord>();
  for (const row of byRun.values()) if (!latest.has(row.taskId) || row.time >= latest.get(row.taskId)!.time) latest.set(row.taskId, row);
  const tasks = [...latest.values()].map(row => ({
    id: row.taskId, alert:row.alert??null,authorityEndpoint:row.authorityEndpoint??null,authorityNotice:row.authorityNotice??null,authorityDisposition:row.authorityDisposition??null,dispositionObservedAt:row.dispositionObservedAt??null,title: row.title.slice(0, 500), description: row.description.slice(0, 8000),
    parentTaskId: row.parentTaskId ?? null, parentRunId: row.parentRunId ?? null,
    project: row.projectId ?? "unassigned", projectTitle: row.projectTitle ?? null,
    ...presentation(row), node: row.nodeId, model: row.model ?? null,
    time: row.time, runId: row.runId, runState: row.state, reviewStatus: null,
    sessionIds: [...new Set([...byRun.values()].filter(run => run.taskId === row.taskId).flatMap(run => run.sessionIds))],
    report: row.report?.slice(0, 8000) ?? "尚无本机结果记录", detail: row.detail?.slice(0, 500) ?? null,
    source: row.source, workspaceId: row.workspaceId ?? null, executionDirectory: row.executionDirectory ?? null,
    returnedAt: ["acknowledged", "succeeded", "failed", "blocked", "partial"].includes(row.state) ? row.time : null,
  }));
  return { projects: [], tasks, runs, reports: [], attempts: [], artifacts: [], schedules: [], nodes: [], settings: { root: null, revision: 0 }, sampledAt: new Date().toISOString() };
}
