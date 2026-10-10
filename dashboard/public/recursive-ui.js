import { escapeHtml as e, newestFirst, STATE_LABELS } from "./model.js";
const link = (id) => `#task/${encodeURIComponent(id)}/overview`;
export const executionLabel = (run) =>
  run.reviewStatus === "accepted"
    ? "已验收"
    : run.reviewStatus === "rejected"
      ? "返修中"
      : run.state === "succeeded"
        ? run.outcome === "partial"
          ? "部分交付 / 已派发 · 待验收"
          : "执行完成 · 待验收"
        : STATE_LABELS[run.state] || run.state;
/** Follow exact parent runs; old snapshots with no run provenance are labelled explicitly. */
export function recursiveForest(data, rootTaskId) {
  const tasks = new Map(data.tasks.map((t) => [t.taskId, t])),
    runs = data.runs || [],
    runMap = new Map(runs.map((r) => [r.runId, r]));
  const seenRuns = new Set(),
    seenTasks = new Set();
  const visit = (
    task,
    path = new Set(),
    selected = runs.filter((r) => r.taskId === task.taskId),
  ) => {
    seenTasks.add(task.taskId);
    selected.forEach((r) => seenRuns.add(r.runId));
    if (path.has(task.taskId))
      return { task, cycle: true, runs: [], unbound: [] };
    const next = new Set([...path, task.taskId]);
    const childTasks = data.tasks.filter((t) => t.parentTaskId === task.taskId);
    const own = newestFirst(selected);
    const entries = own.map((run) => {
      // Execution provenance comes from each child Run, even when task creation differs.
      const groups = new Map();
      for (const childRun of runs.filter((r) => r.parentRunId === run.runId)) {
        const child = tasks.get(childRun.taskId);
        if (!child) continue;
        const group = groups.get(child.taskId) || { task: child, runs: [] };
        group.runs.push(childRun);
        groups.set(child.taskId, group);
      }
      const children = [...groups.values()].map((g) =>
        visit(g.task, next, g.runs),
      );
      for (const child of childTasks)
        if (
          !runs.some((r) => r.taskId === child.taskId) &&
          child.parentRunId === run.runId
        )
          children.push(visit(child, next, []));
      return { run, children };
    });
    const unbound = [];
    for (const child of childTasks) {
      const missing = runs.filter(
        (r) =>
          r.taskId === child.taskId &&
          (!r.parentRunId || !runMap.has(r.parentRunId)),
      );
      const empty =
        !runs.some((r) => r.taskId === child.taskId) &&
        !own.some((r) => r.runId === child.parentRunId);
      if (missing.length || empty) unbound.push(visit(child, next, missing));
    }
    return { task, runs: entries, unbound };
  };
  if (rootTaskId)
    return tasks.has(rootTaskId) ? [visit(tasks.get(rootTaskId))] : [];
  const roots = data.tasks.filter(
    (t) => !t.parentTaskId || !tasks.has(t.parentTaskId),
  );
  const forest = roots.map((t) =>
    visit(
      t,
      new Set(),
      runs.filter(
        (r) =>
          r.taskId === t.taskId &&
          (!r.parentRunId || !runMap.has(r.parentRunId)),
      ),
    ),
  );
  // Preserve detached/cyclic execution history, including additional runs of an already seen task.
  for (const task of data.tasks) {
    const remaining = runs.filter(
      (r) => r.taskId === task.taskId && !seenRuns.has(r.runId),
    );
    if (remaining.length || !seenTasks.has(task.taskId))
      forest.push(visit(task, new Set(), remaining));
  }
  return forest;
}
export function recursivePanel(data, { rootTaskId } = {}) {
  const reports = data.reports || [],
    attempts = data.attempts || [];
  const record = (node) => {
    const task = node.task,
      step = task.delegationDisplay?.mode === "step";
    return `<details class="delegation-task" ${step ? "" : "open"} data-task-id="${e(task.taskId)}" data-delegation-key="task:${e(task.taskId)}:${e(node.runs.map((x) => x.run.runId).join(","))}"><summary><span>${step ? "执行步骤" : "独立任务"}</span> <a href="${link(task.taskId)}">${e(task.title)}</a> <small>${e(STATE_LABELS[task.state] || task.state)}</small></summary><p class="hint">${e(task.taskId)} · ${e(task.delegationDisplay?.reason || "既有任务记录")} ${task.parentRunId ? `· 任务创建时父 Run ${e(task.parentRunId)}` : ""}</p>${node.cycle ? '<p role="alert">循环父任务关系，请核实原始记录。</p>' : ""}${node.runs
      .map(({ run, children }) => {
        const route = run.route || {},
          proof = reports.filter((r) => r.runId === run.runId),
          invocations = attempts.filter((a) => a.runId === run.runId);
        return `<section class="delegation-run" data-run-id="${e(run.runId)}"><h3>${e(executionLabel(run))}</h3><p>${e(route.nodeId || "节点未记录")} → ${e(route.backend || "DSH AgentLoop")} · ${e(route.provider || "提供商未记录")} / ${e(route.model || "模型未记录")} / ${e(route.reasoningEffort || "effort 未记录")}</p>${route.backend ? '<p class="hint">官方 Codex 当前仅只读执行；不提供实时进度或会话续跑。</p>' : ""}<p class="hint">Run ${e(run.runId)}${run.parentRunId ? ` · 父运行 ${e(run.parentRunId)}` : ""}${run.cancellationRequested ? (run.state === "cancelled" ? " · 已确认静止" : " · 取消请求已发出，等待静止") : ""}</p><details data-delegation-key="proof:${e(run.runId)}"><summary>执行身份、结果与返修历史 · ${invocations.length} 次 Attempt / ${proof.length} 份报告</summary>${invocations.map((a) => `<p class="hint">${e(a.attemptId)} · ${e(a.state)} · 节点 ${e(a.nodeId)} · fence ${e(a.fence ?? "未记录")} · execution ${e(a.executionId || "未记录")} · Session ${e(a.sessionId || "未记录")}</p>`).join("")}${proof.map((r) => `<article><h4>${e(r.title)} · revision ${e(r.revision)}</h4><p class="report-body">${e(r.body)}</p>${r.previousReportId ? `<small>前版 ${e(r.previousReportId)}</small>` : ""}${r.data?.officialSubagentId ? `<p class="hint">官方子执行 ${e(r.data.officialSubagentId)} · ${e(r.data.stopReason || "已发布，暂无进度")}</p>` : ""}</article>`).join("")}</details>${children.map(record).join("")}</section>`;
      })
      .join(
        "",
      )}${node.unbound.length ? '<p class="hint">以下子记录缺少可匹配的父 Run，不能推断执行身份。</p>' + node.unbound.map(record).join("") : ""}</details>`;
  };
  return `<section class="panel recursive-panel"><h2>递归委派与验收</h2><p class="hint">按实际父 Run 展示谁派给谁。执行完成后仍待用户 / 导演验收。折叠步骤保留全部账本证据。</p>${recursiveForest(data, rootTaskId).map(record).join("") || "<p>尚无任务记录。</p>"}</section>`;
}
