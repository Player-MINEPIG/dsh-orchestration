import { ProtocolError } from "./remote/protocol.js";
import { z } from "zod";
import type { Task, Run, Receipt } from "./contracts.js";

export const TaskReadOptions = z
  .object({
    details: z.boolean().optional(),
    section: z.enum(["reports", "events", "runs", "artifacts"]).optional(),
    taskId: z.string().min(1).max(200).optional(),
    state: z.string().min(1).max(100).optional(),
    reportId: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .regex(/^\d{1,9}$/)
      .optional(),
  })
  .strict();
export type TaskReadOptions = z.infer<typeof TaskReadOptions>;
const report = z.object({
  reportId: z.string(),
  taskId: z.string(),
  runId: z.string().optional(),
  kind: z.string(),
  title: z.string(),
  body: z.string().optional(),
  data: z.unknown().optional(),
  artifactIds: z.array(z.string()).optional(),
  createdAt: z.string(),
});
const event = z.object({
  eventId: z.string(),
  type: z.string(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  at: z.string().optional(),
  detail: z.unknown().optional(),
});
const artifact = z.object({
  artifactId: z.string(),
  taskId: z.string(),
  runId: z.string().optional(),
  name: z.string().optional(),
  mediaType: z.string().optional(),
  state: z.string().optional(),
  createdAt: z.string().optional(),
});

export function runSummary(run: Run, details = false) {
  const {
    runId,
    taskId,
    parentRunId,
    state,
    reviewStatus,
    resultSummary,
    createdAt,
    updatedAt,
    cancellationRequested,
    dispatchIssue,
    executionModel,
    projectContext,
    projectExecutionBinding,
  } = run;
  const route = run.route && {
    nodeId: run.route.nodeId,
    provider: run.route.provider,
    model: run.route.model,
    reasoningEffort: run.route.reasoningEffort,
    backend: run.route.backend,
  };
  return {
    executionExpectation:run.executionExpectation ?? {phase:"not_set"},
    runId,
    taskId,
    parentRunId,
    state,
    reviewStatus,
    resultSummary,
    createdAt,
    updatedAt,
    cancellationRequested,
    dispatchIssue,
    executionModel,
    projectContext: details
      ? projectContext
      : projectContext && {
          version: projectContext.version,
          schedulerId: projectContext.schedulerId,
          project: projectContext.project && {
            projectId: projectContext.project.projectId,
            revision: projectContext.project.revision,
          },
        },
    projectExecutionBinding,
    route,
    requested:
      executionModel?.origin === "explicit"
        ? route
        : (executionModel?.original ?? null),
    resolved: route,
    recoveryActions:
      state === "uncertain"
        ? ["request_execution_status", "verify_stopped"]
        : state === "queued"
          ? [
              "task_cancel",
              ...(dispatchIssue?.kind === "needs_action"
                ? ["task_repair_dispatch"]
                : []),
            ]
          : [],
  };
}

export function taskRead(
  data: {
    tasks: readonly Task[];
    runs: readonly Run[];
    reports: readonly unknown[];
    events?: readonly unknown[];
    artifacts?: readonly unknown[];
  },
  raw: TaskReadOptions = {},
  actionVersion?: (taskId: string) => string,
  history = false,
) {
  const options = TaskReadOptions.parse(raw),
    offset = Number(options.cursor ?? 0);
  const project = (limit: number) => {
    if (history && options.taskId && options.taskId !== data.tasks[0]?.taskId)
      throw new Error("History target differs from the authorized Task");
    const candidates = data.tasks.filter(
      (task) =>
        (!options.taskId || task.taskId === options.taskId) &&
        (!options.state || task.state === options.state),
    );
    const selected = history
        ? candidates
        : candidates.slice(offset, offset + limit),
      ids = new Set(selected.map((task) => task.taskId));
    const tasks = selected.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      state: task.state,
      parentTaskId: task.parentTaskId,
      parentRunId: task.parentRunId,
      confirmation: task.confirmation,
      checkin: task.checkin,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(actionVersion ? { actionVersion: actionVersion(task.taskId) } : {}),
      ...(options.details
        ? { description: task.description, goal: task.goal }
        : {}),
    }));
    const allRuns = data.runs.filter((run) => ids.has(run.taskId));
    const allReports = data.reports
      .map((value) => report.parse(value))
      .filter(
        (value) =>
          ids.has(value.taskId) &&
          (!options.reportId || value.reportId === options.reportId),
      );
    const section = options.section ?? "reports";
    const events =
      history && options.details && section === "events"
        ? (data.events ?? [])
            .map((value) => event.parse(value))
            .filter((value) => !value.taskId || ids.has(value.taskId))
        : [];
    const artifacts =
      history && options.details && section === "artifacts"
        ? (data.artifacts ?? [])
            .map((value) => artifact.parse(value))
            .filter((value) => ids.has(value.taskId))
        : [];
    const runs =
      history && options.details && section === "runs"
        ? allRuns.slice(offset, offset + limit)
        : [...new Map(allRuns.map((run) => [run.taskId, run])).values()];
    const summaryMode =
      history && !options.details && !options.section && !options.reportId;
    const reports = history
      ? summaryMode
        ? allReports.slice(-1)
        : section === "reports"
          ? allReports.slice(offset, offset + limit)
          : []
      : [...new Map(allReports.map((value) => [value.taskId, value])).values()];
    const total = summaryMode
      ? reports.length
      : history
        ? section === "events"
          ? events.length
          : section === "artifacts"
            ? artifacts.length
            : section === "runs"
              ? allRuns.length
              : allReports.length
        : candidates.length;
    return {
      tasks,
      ...(history ? { task: tasks[0] } : {}),
      runs: runs.map((run) => runSummary(run, options.details)),
      reports: reports.map(({ body, data: bodyData, ...metadata }) => ({
        ...metadata,
        ...(options.details ? { body, data: bodyData } : {}),
      })),
      ...(options.details
        ? {
            events: events
              .slice(offset, offset + limit)
              .map(({ detail, ...metadata }) => ({
                ...metadata,
                detail: diagnosticDetail(detail),
              })),
            artifacts: artifacts.slice(offset, offset + limit),
          }
        : {}),
      page: {
        limit,
        nextCursor: offset + limit < total ? String(offset + limit) : null,
        total,
        ...(history ? { section } : {}),
      },
    };
  };
  let limit = options.limit ?? 25,
    result = project(limit);
  while (Buffer.byteLength(JSON.stringify(result)) > 96 * 1024 && limit > 1) {
    limit = Math.max(1, Math.floor(limit / 2));
    result = project(limit);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 96 * 1024) {
    const error = new ProtocolError("READ_TOO_LARGE", 413);
    error.message =
      "A single requested detail exceeds the read budget; use details=false for metadata and retrieve its authorized artifact separately";
    throw error;
  }
  return result;
}
const diagnostic = z.object({
  code: z.string().optional(),
  reason: z.string().optional(),
  issue: z
    .object({
      kind: z.string(),
      code: z.string(),
      message: z.string(),
      action: z.string(),
      revision: z.string().optional(),
    })
    .nullable()
    .optional(),
  attemptId: z.string().optional(),
  previousRunId: z.string().nullable().optional(),
});
function diagnosticDetail(value: unknown) {
  const result = diagnostic.safeParse(value);
  return result.success ? result.data : {};
}

export function delegationSummary(receipt: Receipt<{ task: Task; run: Run }>) {
  const { task, run } = receipt.value;
  return {
    ...receipt,
    value: {
      task: {
        taskId: task.taskId,
        title: task.title,
        state: task.state,
        parentTaskId: task.parentTaskId,
        parentRunId: task.parentRunId,
        confirmation: task.confirmation,
      checkin: task.checkin,
      },
      run: runSummary(run),
    },
  };
}
