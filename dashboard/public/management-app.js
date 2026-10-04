import {
  escapeHtml as e,
  safeUri,
  newestFirst,
  labels,
  priorityLabels,
  priorities,
  taskPriority,
  projectTasks,
  runDetails,
  parseManagementRoute,
  commandFromForm,
} from "./management-model.js";
import { managementRequest } from "./management-client.js";
const config = window.DSH_DASHBOARD_CONFIG || {};
const api = new URL(
  (config.apiBase || "./api").replace(/\/$/, "") + "/",
  location.href.split("#")[0],
);
const main = document.querySelector("#management-main"),
  dialog = document.querySelector("#management-dialog"),
  form = document.querySelector("#management-form");
let data = null,
  loading = false,
  mutating = false,
  formContext = null,
  pendingCommand = null,
  expiresAt = null,
  expiryTimer = null,
  serial = 0,
  expired = false;
const time = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未记录";
const link = (kind, id) => `#${kind}/${encodeURIComponent(id)}`;
const state = (value) =>
  `<span class="status state-${e(value)}">${e(labels[value] || value || "未知")}</span>`;
const priority = (task) => {
  const p = taskPriority(task, data);
  return `<span class="priority-pill priority-${p.value}" title="${e(p.source)}">${priorityLabels[p.value]} · ${e(p.source)}</span>`;
};
const empty = (text) => `<div class="management-empty">${e(text)}</div>`;
const button = (text, attributes, primary = false) =>
  data?.permissions?.canManage
    ? `<button type="button" ${attributes}${primary ? ' class="primary-button"' : ""}>${e(text)}</button>`
    : "";
const edit = (kind, id) =>
  button("编辑", `data-edit="${kind}" data-id="${e(id)}"`);
const create = (kind, label, projectId) =>
  button(
    label,
    `data-create="${kind}"${projectId ? ` data-project-id="${e(projectId)}"` : ""}`,
  );
function notice(text, kind = "error") {
  const target = document.querySelector("#management-notice");
  target.className = text ? `management-notice ${kind}` : "";
  target.textContent = text;
}
function title(eyebrow, name, description, actions = "") {
  return `<div class="management-page-title"><div><div class="eyebrow">${e(eyebrow)}</div><h1>${e(name)}</h1><p>${e(description)}</p></div><div class="management-actions">${actions}</div></div>`;
}
function criteria(items = []) {
  return items.length
    ? `<ul class="management-criteria">${items.map((c) => `<li>${e(c.description)}<br><span class="hint">${e({ pending: "待检查", met: "条件已满足", unmet: "条件未满足", unknown: "未知" }[c.observedStatus] || "待检查")} · ${e(c.kind)}${c.targetRef ? ` · ${e(c.targetRef.type)} ${e(c.targetRef.id)}${c.targetRef.revision ? ` @${e(c.targetRef.revision)}` : ""}` : ""}</span>${c.requiredEvidence ? `<br><span class="hint">所需证据：${e(c.requiredEvidence)}</span>` : ""}</li>`).join("")}</ul>`
    : '<p class="hint">尚未定义条件；空条件不会自动完成</p>';
}
function taskCard(task) {
  return `<article class="management-card management-task"><div><a class="management-card-title" href="${link("task", task.taskId)}">${e(task.title)}</a><p>${e(task.goal || task.description || "尚未填写目标")}</p><div class="management-meta"><span>${e(task.taskId)}</span><span>${data.runs.filter((x) => x.taskId === task.taskId).length} 次 Run</span>${priority(task)}</div></div>${state(task.state)}</article>`;
}
function projectCard(project) {
  const backlogs = data.backlogs.filter(
    (x) => x.projectId === project.projectId,
  );
  return `<article class="management-card"><div class="management-card-top"><h3><a href="${link("project", project.projectId)}">${e(project.title)}</a></h3>${state(project.state)}</div><p>${e(project.goal || project.description || "尚未填写项目目标")}</p><div class="management-meta"><span>${backlogs.length} 项需求</span><span>${projectTasks(data, project.projectId).length} 个去重任务</span></div></article>`;
}
function projectsPage() {
  const grouped = new Set(data.domainProjects.map((x) => x.projectId));
  const blocks = [...data.domains]
    .sort(
      (a, b) => a.position - b.position || a.domainId.localeCompare(b.domainId),
    )
    .map((domain) => {
      const ids = new Set(
        data.domainProjects
          .filter((x) => x.domainId === domain.domainId)
          .map((x) => x.projectId),
      );
      const projects = data.projects.filter((x) => ids.has(x.projectId));
      return `<section class="management-section"><div class="management-section-heading"><h2>${e(domain.title)} ${domain.state === "archived" ? state(domain.state) : ""}</h2><div class="management-actions">${edit("domain", domain.domainId)}${button("关联项目", `data-link="domain_project" data-domain-id="${e(domain.domainId)}"`)}</div></div>${domain.summary ? `<p class="management-subtitle">${e(domain.summary)}</p>` : ""}${projects.length ? `<div class="management-projects">${projects.map(projectCard).join("")}</div>` : empty("此领域还没有关联项目")}</section>`;
    })
    .join("");
  const ungrouped = data.projects.filter((x) => !grouped.has(x.projectId));
  return (
    title(
      "WORKBENCH",
      "项目、需求与持续工作",
      "领域用于组织展示；需求待办表达要解决什么，任务记录实际推进工作。",
      create("domain", "新建领域") +
        create("project", "新建项目") +
        create("task", "新建任务"),
    ) +
    blocks +
    (ungrouped.length
      ? `<section class="management-section"><h2>未分组项目</h2><div class="management-projects">${ungrouped.map(projectCard).join("")}</div></section>`
      : "") +
    (!data.projects.length
      ? empty("尚无项目。新建项目后，可以添加需求待办并关联任务。")
      : "") +
    `<section class="management-section"><div class="management-section-heading"><h2>跨项目任务</h2><span class="hint">${data.tasks.length} 个任务，按 taskId 去重</span></div><div class="management-task-list">${newestFirst(data.tasks, "updatedAt").map(taskCard).join("") || empty("当前数据库没有任务")}</div></section>`
  );
}
function backlogCard(backlog) {
  const ids = new Set(
      data.backlogTasks
        .filter((x) => x.backlogId === backlog.backlogId)
        .map((x) => x.taskId),
    ),
    tasks = data.tasks.filter((x) => ids.has(x.taskId));
  return `<article class="management-record"><div class="management-card-top"><div><h3>${e(backlog.title)}</h3><div class="management-meta">${state(backlog.state)}<span class="priority-pill priority-${e(backlog.priority)}">${e(priorityLabels[backlog.priority])}</span></div></div><div class="management-actions">${edit("backlog", backlog.backlogId)}${button("关联任务", `data-link="backlog_task" data-backlog-id="${e(backlog.backlogId)}"`)}</div></div><p>${e(backlog.goal)}</p><details><summary>需求自身的完成条件</summary>${criteria(backlog.acceptanceCriteria)}<p class="hint">条件观察与人工认可分开；任务成功不会自动表示人工验收。</p></details><div class="management-task-list">${tasks.map((task) => `<div>${taskCard(task)}${button("解除此需求关联", `class="management-link-button" data-unlink="backlog_task" data-backlog-id="${e(backlog.backlogId)}" data-task-id="${e(task.taskId)}"`)}</div>`).join("") || '<p class="hint">尚未关联推进这项需求的任务</p>'}</div></article>`;
}
function projectPage(id) {
  const project = data.projects.find((x) => x.projectId === id);
  if (!project) return empty("未找到这个项目");
  const backlogs = data.backlogs.filter((x) => x.projectId === id),
    domains = data.domainProjects
      .filter((x) => x.projectId === id)
      .map((x) => data.domains.find((y) => y.domainId === x.domainId))
      .filter(Boolean);
  const bindings = data.projectWorkspaces.filter((x) => x.projectId === id);
  const artifacts = data.artifactRelations
    .filter((x) => x.kind === "project" && x.targetId === id)
    .map((x) => data.artifacts.find((a) => a.artifactId === x.artifactId))
    .filter(Boolean);
  return (
    `<a class="back-link" href="#projects">← 项目与需求</a>` +
    title(
      "PROJECT",
      project.title,
      project.goal || project.description,
      edit("project", id) +
        create("backlog", "添加需求待办", id) +
        create("task", "新建任务"),
    ) +
    `<div class="management-columns"><div><section class="management-section"><div class="management-section-heading"><h2>需求待办</h2><span class="hint">${backlogs.length} 项 · 每项有自己的完成依据</span></div>${backlogs.map(backlogCard).join("") || empty("添加第一项需求，说明要解决的问题与完成条件")}</section><section><h2>项目材料</h2>${artifactCards(artifacts)}</section></div><aside><section class="management-record"><h3>项目背景</h3><p>${e(project.description || "尚未填写")}</p>${state(project.state)}<div class="management-meta">修订 ${e(project.revision)}</div><p>下一步：${e(project.nextStep || "未记录")}</p><details><summary>项目条件</summary>${criteria(project.acceptanceCriteria)}</details></section><section class="management-record"><h3>展示领域</h3>${domains.map((d) => `<p>${e(d.title)} ${button("解除关联", `class="management-link-button" data-unlink="domain_project" data-domain-id="${e(d.domainId)}" data-project-id="${e(id)}"`)}</p>`).join("") || '<p class="hint">未分组</p>'}${button("关联领域", `data-link="domain_project" data-project-id="${e(id)}"`)}</section><section class="management-record"><h3>工作区绑定</h3>${
      bindings
        .map((b) => {
          const w = data.workspaces.find(
            (x) => x.workspaceId === b.workspaceId,
          );
          return `<p>${e(w?.label || b.workspaceId)}<br>${e(b.nodeId)}${b.isDefault ? " · 默认" : ""}<br>${e(w?.path || "路径未记录")}</p>`;
        })
        .join("") || '<p class="hint">尚无工作区绑定</p>'
    }<p class="hint">项目关联不会创建目录或授予执行权限。</p></section></aside></div>`
  );
}
function reportCard(report) {
  return `<article class="management-record" id="report-${e(report.reportId)}"><div class="management-card-top"><h3>${e(report.title)}</h3><span class="report-label">${e(report.kind)} · v${e(report.revision)}</span></div><p>${e(report.body)}</p><div class="management-meta"><span>${e(report.reportId)}</span><span>Run ${e(report.runId || "无")}</span><span>Attempt ${e(report.attemptId || "无")}</span><span>Session ${e(report.sessionId || "未记录")}</span><span>${e(time(report.createdAt))}</span></div>${report.previousReportId ? `<p class="hint">前一报告版本：${e(report.previousReportId)}</p>` : ""}${report.data !== undefined ? `<details><summary>结构化结果</summary><pre>${e(JSON.stringify(report.data, null, 2))}</pre></details>` : ""}</article>`;
}
function runCard(run) {
  const details = runDetails(data, run);
  return `<article class="management-record"><div class="management-card-top"><h3>${e(run.runId)}</h3>${state(run.state)}</div><div class="run-grid"><div>计划派往<strong>${e(details.plannedNode)}</strong></div><div>实际取得执行权<strong>${e(details.actualNodes.join(" · ") || "尚无 Attempt，未知")}</strong></div><div>模型（计划）<strong>${e(run.route?.model || "未记录")}</strong></div><div>${e(details.sessionLabel)}<strong>${e(details.sessionIds.join(" · ") || "未记录")}</strong></div></div>${run.templateRef ? `<p class="hint">固定模板 ${e(run.templateRef.templateId)} · v${e(run.templateRef.version)}</p>` : ""}${run.reviewStatus ? `<p class="hint">人工判断记录：${e({ pending_user: "等待用户", accepted: "已接受", rejected: "未接受" }[run.reviewStatus] || run.reviewStatus)}</p>` : ""}${run.historyOnly ? '<p class="hint">仅历史记录 · 不可再次派活</p>' : ""}${details.failure ? `<div class="management-run-failure"><strong>${e(details.executionStartMessage || "结果与失败说明")}</strong><br>${e(details.failure)}</div>` : ""}<h4>Attempt · 实际执行归属</h4>${details.attempts.map((a) => `<div class="management-attempt"><strong>${e(a.attemptId)}</strong> ${state(a.state)}<br>节点 ${e(a.nodeId)} · fence ${e(a.fence)}<br>Execution ${e(a.executionId || "未记录")}<br>${details.preDispatchFailure?.detail.attemptId === a.attemptId ? "预留 Session 引用（未证明 native session 创建）" : "Session 引用"} ${e(a.sessionId || "未记录")}<br>租约截至 ${e(time(a.leaseExpiresAt))}</div>`).join("") || '<p class="hint">尚无实际执行权记录；计划节点不能作为实际执行证明。</p>'}${run.intentSnapshot ? `<details><summary>本次执行固定的意图快照</summary><pre>${e(JSON.stringify(run.intentSnapshot, null, 2))}</pre></details>` : ""}<details><summary>执行事件（${details.events.length}）</summary>${
    details.events
      .map(
        (event) =>
          `<div class="management-attempt"><strong>${e(event.type)}</strong> · ${e(time(event.at))}<p>${e(
            Object.values(event.detail || {})
              .filter(Boolean)
              .join(" · "),
          )}</p></div>`,
      )
      .join("") || '<p class="hint">无事件</p>'
  }</details></article>`;
}
function artifactCards(artifacts) {
  return artifacts.length
    ? artifacts
        .map((a) => {
          const uri = safeUri(a.uri || a.contentRef?.url),
            relations = data.artifactRelations.filter(
              (x) => x.artifactId === a.artifactId,
            );
          return `<article class="management-record"><h3>${uri ? `<a class="management-link" href="${e(uri)}" target="_blank" rel="noopener noreferrer">${e(a.name)} ↗</a>` : e(a.name)}</h3><p class="hint">${e(a.artifactId)}${a.materialId ? ` · 材料 ${e(a.materialId)}` : ""}<br>${e(a.versionStatus === "live" ? "Live reference · 内容可变化" : a.versionStatus === "pinned" ? "固定原生版本" : "已登记附件")} · ${e(a.availability === "unknown" ? "可用性未核实" : a.finalized ? "本地附件已定稿" : "尚未定稿")}</p>${a.contentRef ? `<pre>${e(JSON.stringify(a.contentRef, null, 2))}</pre>` : ""}${!uri && a.uri ? `<p>${e(a.uri)}</p>` : ""}${relations.length ? `<details><summary>来源、版本与过程关系</summary>${relations.map((r) => `<p>${e(r.kind)} · ${e(r.targetId)} · ${e(r.action || "引用")}<br>${e(r.context || "")}</p>`).join("")}</details>` : ""}</article>`;
        })
        .join("")
    : empty("尚无登记材料；不会自动下载、复制或计算文件哈希");
}
function taskPage(id) {
  const task = data.tasks.find((x) => x.taskId === id);
  if (!task) return empty("未找到这个任务");
  const runs = newestFirst(data.runs.filter((x) => x.taskId === id)),
    reports = newestFirst(data.reports.filter((x) => x.taskId === id));
  const artifactIds = new Set(
    data.artifactRelations
      .filter((x) => x.kind === "task" && x.targetId === id)
      .map((x) => x.artifactId),
  );
  const artifacts = data.artifacts.filter(
    (x) => x.taskId === id || artifactIds.has(x.artifactId),
  );
  const linked = data.backlogTasks
    .filter((x) => x.taskId === id)
    .map((x) => data.backlogs.find((b) => b.backlogId === x.backlogId))
    .filter(Boolean);
  return (
    `<a class="back-link" href="#projects">← 项目与需求</a>` +
    title(
      "TASK",
      task.title,
      task.goal || task.description,
      edit("task", id) +
        button("关联需求", `data-link="backlog_task" data-task-id="${e(id)}"`),
    ) +
    `<div class="management-columns"><div><section class="management-section"><h2>Run → Attempt</h2><p class="management-subtitle">计划路由与实际执行所有权分别呈现，失败不伪装为成功。</p>${runs.map(runCard).join("") || empty("尚无执行；内容管理不会自动派活")}</section><section class="management-section"><h2>报告与反思</h2>${reports.map(reportCard).join("") || empty("尚无报告")}</section><section><h2>材料与版本</h2>${artifactCards(artifacts)}</section></div><aside><section class="management-record"><h3>任务意图</h3><p>${e(task.description)}</p>${state(task.state)}<div class="management-meta">${priority(task)}</div><p class="hint">${e(task.taskId)}<br>内容修订 ${e(task.revision || 1)} · 意图修订 ${e(task.intentRevision || 1)}<br>最后更新 ${e(time(task.updatedAt))}</p>${criteria(task.acceptanceCriteria)}</section><section class="management-record"><h3>推进的需求</h3>${linked.map((b) => `<p><a class="management-link" href="${link("project", b.projectId)}">${e(b.title)}</a><br><span class="hint">${e(data.projects.find((p) => p.projectId === b.projectId)?.title || b.projectId)}</span></p>`).join("") || '<p class="hint">尚未关联需求</p>'}<p class="hint">同一 Task 可以推进多项需求，执行历史保持同一身份。</p></section></aside></div>`
  );
}
function render() {
  if (!data) return;
  const route = parseManagementRoute(location.hash);
  main.innerHTML =
    route.view === "project"
      ? projectPage(route.id)
      : route.view === "task"
        ? taskPage(route.id)
        : projectsPage();
  document.querySelector("#database-label").textContent = data.database.label;
  document.querySelector("#database-identity").textContent =
    `SQLite · ${data.database.databaseId} · ${data.database.path}`;
  document.querySelector("#management-access").textContent = data.permissions
    .canManage
    ? "已启用管理 · 沿用宿主授权范围；此入口未建立自然人身份识别"
    : "只读权限 · 管理按钮已停用";
  document.querySelector("#management-freshness").textContent =
    `读取于 ${time(data.generatedAt)}`;
}
function expire() {
  expired = true;
  data = null;
  serial++;
  clearTimeout(expiryTimer);
  dialog.close();
  form.reset();
  document.querySelector("#form-fields").innerHTML = "";
  document.querySelector("#database-label").textContent = "数据库身份已隐藏";
  document.querySelector("#database-identity").textContent = "";
  document.querySelector("#management-freshness").textContent = "";
  formContext = null;
  pendingCommand = null;
  main.innerHTML = empty("访问已到期，记录已隐藏。请刷新页面重新验证。");
  notice("访问已到期，请刷新页面重新验证");
}
function setExpiry(value) {
  clearTimeout(expiryTimer);
  expiresAt = Number.isFinite(value) ? value : null;
  if (expiresAt !== null) {
    if (expiresAt <= Date.now()) return expire();
    expiryTimer = setTimeout(
      () => {
        if (expiresAt <= Date.now()) expire();
        else setExpiry(expiresAt);
      },
      Math.min(2147483647, expiresAt - Date.now()),
    );
  }
}
async function refresh() {
  if (expired) return;
  if (loading || mutating) return;
  loading = true;
  const request = ++serial;
  document.querySelector("#management-refresh").disabled = true;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 10000);
  try {
    const result = await managementRequest(new URL("workbench", api), {
      origin: location.origin,
      signal: controller.signal,
      requireSessionExpiry: Boolean(config.requireSessionExpiry),
    });
    if (request !== serial) return;
    data = result.snapshot;
    setExpiry(result.expiresAt);
    if (!expired) render();
  } catch (error) {
    if (request !== serial) return;
    if (error.kind === "authentication" || error.kind === "authorization") {
      expire();
    } else {
      notice(error.message);
      if (!data)
        main.innerHTML = empty(
          "暂时无法读取管理数据。这不代表当前库没有任务。",
        );
    }
  } finally {
    clearTimeout(timer);
    loading = false;
    document.querySelector("#management-refresh").disabled = false;
  }
}
const field = (name, label, value = "", type = "text", hint = "") =>
  `<label class="form-field">${e(label)}${type === "textarea" ? `<textarea name="${name}"${name === "title" ? " required" : ""}>${e(value)}</textarea>` : `<input name="${name}" type="${type}" value="${e(value)}"${name === "title" ? ' required maxlength="500"' : ""}>`}${hint ? `<small>${e(hint)}</small>` : ""}</label>`;
const select = (name, label, items, value) =>
  `<label class="form-field">${e(label)}<select name="${name}"${["state", "priorityOverride"].includes(name) ? "" : " required"}>${items.map(([id, title]) => `<option value="${e(id)}"${id === value ? " selected" : ""}>${e(title)}</option>`).join("")}</select></label>`;
const editableCriteria = (items) =>
  (items || []).map(
    ({ criterionId, description, kind, targetRef, requiredEvidence }) => ({
      criterionId,
      description,
      kind,
      ...(targetRef ? { targetRef } : {}),
      requiredEvidence,
    }),
  );
function openForm(kind, id, projectId) {
  if (mutating || !data.permissions.canManage) return;
  const collection = {
      domain: "domains",
      project: "projects",
      backlog: "backlogs",
      task: "tasks",
    }[kind],
    record = id ? data[collection].find((x) => x[kind + "Id"] === id) : null;
  if (id && !record) return;
  formContext = { kind, record };
  pendingCommand = null;
  document.querySelector("#form-title").textContent =
    `${record ? "编辑" : "新建"}${{ domain: "领域", project: "项目", backlog: "需求待办", task: "任务" }[kind]}`;
  let html = field("title", "名称", record?.title);
  if (kind === "domain")
    html +=
      field("summary", "说明", record?.summary, "textarea") +
      field("position", "显示顺序", record?.position ?? 0, "number") +
      select(
        "state",
        "状态",
        ["active", "archived"].map((x) => [x, labels[x]]),
        record?.state || "active",
      );
  else {
    if (kind === "backlog" && !record) {
      if (!data.projects.length) {
        notice("请先创建项目");
        return;
      }
      html += select(
        "projectId",
        "所属项目",
        data.projects.map((x) => [x.projectId, x.title]),
        projectId || data.projects[0].projectId,
      );
    }
    html += field("goal", "目标 / 要解决的问题", record?.goal, "textarea");
    if (kind !== "backlog")
      html += field(
        "description",
        "背景与范围",
        record?.description,
        "textarea",
      );
    if (kind === "task") {
      html += select(
        "priorityOverride",
        "任务优先级",
        [
          ["", "跟随关联需求（无关联为普通）"],
          ...priorities.map((x) => [x, priorityLabels[x]]),
        ],
        record?.priorityOverride || "",
      );
      if (record)
        html += select(
          "state",
          "管理状态",
          [
            ["", "保持当前状态"],
            ...["candidate", "ready", "waiting", "archived"].map((x) => [
              x,
              labels[x],
            ]),
          ],
          "",
        );
    } else {
      html += select(
        "state",
        "管理状态",
        (kind === "project"
          ? ["draft", "active", "paused", "archived"]
          : [
              ...(record?.state === "completed" ? [""] : []),
              "open",
              "paused",
              "cancelled",
              "archived",
            ]
        ).map((x) => [x, x ? labels[x] : "保持当前状态（条件派生）"]),
        record?.state === "completed"
          ? ""
          : record?.state || (kind === "project" ? "draft" : "open"),
      );
      if (kind === "backlog")
        html += select(
          "priority",
          "需求优先级",
          priorities.map((x) => [x, priorityLabels[x]]),
          record?.priority || "normal",
        );
      if (kind === "project")
        html += field("nextStep", "下一步", record?.nextStep);
    }
    html += field(
      "acceptanceCriteria",
      "完成条件（JSON 数组）",
      JSON.stringify(editableCriteria(record?.acceptanceCriteria), null, 2),
      "textarea",
      '例如 [{"description":"核实实际结果","kind":"manual_check"}]。条件检查是只读观察，保存条件不表示人工认可。',
    );
  }
  document.querySelector("#form-fields").innerHTML = html;
  document.querySelector("#form-error").textContent = "";
  document.querySelector("#form-save").disabled = false;
  dialog.showModal();
  form.querySelector("input,select")?.focus();
}
function openLink(kind, context) {
  if (mutating || !data.permissions.canManage) return;
  formContext = { linkKind: kind };
  pendingCommand = null;
  const a = kind === "domain_project" ? "domain" : "backlog",
    b = kind === "domain_project" ? "project" : "task";
  const left = data[a === "domain" ? "domains" : "backlogs"],
    right = data[b === "project" ? "projects" : "tasks"];
  if (!left.length || !right.length) {
    notice("请先创建两端记录，再建立关联");
    return;
  }
  document.querySelector("#form-title").textContent =
    kind === "domain_project" ? "关联领域与项目" : "关联需求与任务";
  document.querySelector("#form-fields").innerHTML =
    select(
      a + "Id",
      a === "domain" ? "领域" : "需求待办",
      left.map((x) => [x[a + "Id"], x.title]),
      context[a + "Id"] || left[0][a + "Id"],
    ) +
    select(
      b + "Id",
      b === "project" ? "项目" : "任务",
      right.map((x) => [x[b + "Id"], x.title]),
      context[b + "Id"] || right[0][b + "Id"],
    );
  document.querySelector("#form-error").textContent = "";
  document.querySelector("#form-save").disabled = false;
  dialog.showModal();
}
async function save(command) {
  if (mutating) return false;
  mutating = true;
  document.querySelector("#form-save").disabled = true;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 15000);
  try {
    const result = await managementRequest(new URL("manage", api), {
      origin: location.origin,
      command,
      signal: controller.signal,
      requireSessionExpiry: Boolean(config.requireSessionExpiry),
    });
    setExpiry(result.expiresAt);
    if (expired) return false;
    notice("已保存到当前数据库", "success");
    return true;
  } catch (error) {
    if (error.kind === "authentication") {
      expire();
      return false;
    }
    document.querySelector("#form-error").textContent = error.message;
    if (!dialog.open) notice(error.message);
    return false;
  } finally {
    clearTimeout(timer);
    mutating = false;
    document.querySelector("#form-save").disabled = false;
  }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (mutating || !formContext) return;
  const values = Object.fromEntries(new FormData(form));
  try {
    const next = formContext.linkKind
      ? { operation: "link_" + formContext.linkKind, data: values }
      : commandFromForm(formContext.kind, values, formContext.record);
    const fingerprint = JSON.stringify(next);
    if (!pendingCommand || pendingCommand.fingerprint !== fingerprint)
      pendingCommand = {
        fingerprint,
        command: { commandId: crypto.randomUUID(), ...next },
      };
    if (await save(pendingCommand.command)) {
      dialog.close();
      formContext = null;
      pendingCommand = null;
      await refresh();
    }
  } catch (error) {
    document.querySelector("#form-error").textContent = error.message;
  }
});
document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.matches("#management-refresh")) {
    if (expired) location.reload();
    else await refresh();
    return;
  }
  if (target.hasAttribute("data-close")) {
    if (!mutating) {
      dialog.close();
      formContext = null;
      pendingCommand = null;
    }
    return;
  }
  if (target.dataset.create)
    openForm(target.dataset.create, null, target.dataset.projectId);
  if (target.dataset.edit) openForm(target.dataset.edit, target.dataset.id);
  if (target.dataset.link)
    openLink(target.dataset.link, {
      domainId: target.dataset.domainId,
      projectId: target.dataset.projectId,
      backlogId: target.dataset.backlogId,
      taskId: target.dataset.taskId,
    });
  if (target.dataset.unlink && !mutating) {
    const payload =
      target.dataset.unlink === "domain_project"
        ? {
            domainId: target.dataset.domainId,
            projectId: target.dataset.projectId,
          }
        : {
            backlogId: target.dataset.backlogId,
            taskId: target.dataset.taskId,
          };
    target.disabled = true;
    const ok = await save({
      commandId: crypto.randomUUID(),
      operation: "unlink_" + target.dataset.unlink,
      data: payload,
    });
    if (ok) await refresh();
    else target.disabled = false;
  }
});
dialog.addEventListener("cancel", (event) => {
  if (mutating) event.preventDefault();
  else {
    formContext = null;
    pendingCommand = null;
  }
});
window.addEventListener("hashchange", () => {
  if (dialog.open && !mutating) {
    dialog.close();
    formContext = null;
    pendingCommand = null;
  }
  render();
  window.scrollTo(0, 0);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (expiresAt !== null && expiresAt <= Date.now()) expire();
    else if (!dialog.open) refresh();
  }
});
window.addEventListener("pageshow", () => {
  if (expiresAt !== null && expiresAt <= Date.now()) expire();
});
refresh();
setInterval(
  () => {
    if (!document.hidden && !dialog.open && !expired) refresh();
  },
  Math.max(5000, Number(config.refreshIntervalMs) || 15000),
);
