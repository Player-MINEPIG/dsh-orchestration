import { escapeHtml, safeUri, newestFirst, STATE_LABELS } from "./model.js";
export { escapeHtml, safeUri, newestFirst };
export const labels = {
  ...STATE_LABELS,
  candidate: "候选",
  partial: "部分完成",
  open: "待处理",
  draft: "草稿",
  active: "进行中",
  paused: "暂停",
  leased: "已领取",
  settled: "已结算",
  expired: "租约过期",
};
export const priorities = ["low", "normal", "high", "urgent"];
export const priorityLabels = {
  low: "低",
  normal: "普通",
  high: "高",
  urgent: "紧急",
};
export function validateManagementSnapshot(data) {
  if (
    data?.schemaVersion !== "management.v1" ||
    !data.database?.databaseId ||
    !data.database?.label ||
    !data.database?.path
  )
    throw new Error("管理数据或数据库身份不完整");
  for (const key of [
    "domains",
    "projects",
    "backlogs",
    "domainProjects",
    "backlogTasks",
    "projectWorkspaces",
    "artifactRelations",
    "tasks",
    "runs",
    "attempts",
    "reports",
    "artifacts",
    "events",
  ])
    if (!Array.isArray(data[key])) throw new Error(`缺少 ${key} 数据`);
  return data;
}
export function taskPriority(task, data) {
  if (priorities.includes(task.priorityOverride))
    return { value: task.priorityOverride, source: "任务明确指定" };
  const ids = new Set(
    data.backlogTasks
      .filter((x) => x.taskId === task.taskId)
      .map((x) => x.backlogId),
  );
  const linked = data.backlogs.filter((x) => ids.has(x.backlogId));
  const value = linked.reduce(
    (best, item) =>
      priorities.indexOf(item.priority) > priorities.indexOf(best)
        ? item.priority
        : best,
    linked.length ? "low" : "normal",
  );
  return { value, source: linked.length ? "关联需求中的最高优先级" : "默认" };
}
export function projectTasks(data, projectId) {
  const backlogs = new Set(
    data.backlogs
      .filter((x) => x.projectId === projectId)
      .map((x) => x.backlogId),
  );
  const ids = new Set(
    data.backlogTasks
      .filter((x) => backlogs.has(x.backlogId))
      .map((x) => x.taskId),
  );
  return data.tasks.filter((x) => ids.has(x.taskId));
}
export function runDetails(data, run) {
  const attempts = newestFirst(
    data.attempts.filter((x) => x.runId === run.runId),
  );
  const reports = newestFirst(
    data.reports.filter((x) => x.runId === run.runId),
  );
  const events = newestFirst(
    data.events.filter((x) => x.runId === run.runId),
    "at",
  );
  const sessionIds = run.sessionIds || [];
  // This is a bounded, authoritative pre-start fact, not an inference from missing reports.
  // A reserved internal session ID can exist even though agent/native session creation never happened.
  const preDispatchFailure =
    run.state === "blocked"
      ? events.find((event) => {
          const detail = event.detail;
          return (
            event.type === "run.pre_dispatch_failed" &&
            event.taskId === run.taskId &&
            detail?.origin === "native-adapter" &&
            detail.phase === "before-agent-start" &&
            detail.code === "NO_ADAPTER" &&
            detail.provider === run.route?.provider &&
            detail.model === run.route?.model &&
            typeof detail.summary === "string" &&
            Boolean(detail.summary.trim()) &&
            attempts.some(
              (attempt) =>
                attempt.attemptId === detail.attemptId &&
                attempt.taskId === run.taskId &&
                attempt.nodeId === detail.nodeId &&
                (!run.currentAttemptId ||
                  attempt.attemptId === run.currentAttemptId),
            )
          );
        })
      : undefined;
  const failureReports = reports.filter((x) => x.kind === "result");
  const diagnostic = events.find(
    (x) =>
      x.detail?.reason ||
      x.detail?.reasonCode ||
      x.detail?.message ||
      x.detail?.summary,
  );
  return {
    attempts,
    reports,
    events,
    sessionIds,
    preDispatchFailure,
    executionStartMessage: preDispatchFailure ? "模型调用与工作尚未开始" : null,
    sessionLabel: preDispatchFailure
      ? "预留 Session 引用（不代表 native session 已创建）"
      : "Session 引用（从 Attempt / 上下文派生）",
    plannedNode: run.route?.nodeId || "未记录",
    actualNodes: [...new Set(attempts.map((x) => x.nodeId).filter(Boolean))],
    failure: ["failed", "blocked", "uncertain", "partial"].includes(run.state)
      ? preDispatchFailure?.detail.summary ||
        failureReports[0]?.body ||
        diagnostic?.detail?.reason ||
        diagnostic?.detail?.message ||
        diagnostic?.detail?.summary ||
        diagnostic?.detail?.reasonCode ||
        "尚无明确失败原因；请查看执行事件与报告"
      : null,
  };
}
export function parseManagementRoute(hash) {
  const [view, id] = hash.replace(/^#/, "").split("/");
  try {
    return ["project", "task"].includes(view) && id
      ? { view, id: decodeURIComponent(id) }
      : { view: "projects" };
  } catch {
    return { view: "projects" };
  }
}
/** Deliberately exclude authority/policy and derived state from content commands. */
export function commandFromForm(kind, values, record) {
  const data = { title: values.title.trim() };
  if (!data.title) throw new Error("请填写名称");
  if (kind === "domain") {
    data.summary = values.summary || "";
    data.state = values.state || "active";
    data.position = Number(values.position || 0);
  } else {
    data.goal = values.goal || "";
    if (kind !== "backlog") data.description = values.description || "";
    if (values.acceptanceCriteria?.trim()) {
      try {
        data.acceptanceCriteria = JSON.parse(values.acceptanceCriteria);
      } catch {
        throw new Error("验收条件需要有效 JSON 数组");
      }
      if (!Array.isArray(data.acceptanceCriteria))
        throw new Error("验收条件需要 JSON 数组");
    } else data.acceptanceCriteria = [];
    if (kind === "project") {
      data.state = values.state || "draft";
      data.nextStep = values.nextStep || "";
    }
    if (kind === "backlog") {
      data.priority = values.priority || "normal";
      if (!record || values.state) data.state = values.state || "open";
      if (!record) data.projectId = values.projectId;
    }
    if (kind === "task") {
      if (values.priorityOverride)
        data.priorityOverride = values.priorityOverride;
      else if (record) data.priorityOverride = null;
      if (record && values.state) data.state = values.state;
    }
  }
  if (record) {
    data[kind + "Id"] = record[kind + "Id"];
    data.expectedRevision = record.revision;
  }
  return { operation: `${record ? "update" : "create"}_${kind}`, data };
}
