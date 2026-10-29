import { z } from "zod";
import type { TaskSystemService } from "./dsh-plugin.js";
import type { StewardBinding } from "./steward-contracts.js";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
export const STEWARD_CHECKPOINT_MAX_CHARACTERS = 24000;

const decisionInput = z.object({ projectId: z.string().optional(), taskId: z.string().optional(),
  title: z.string().optional(), description: z.string().optional() }).passthrough();
const membership = `WITH RECURSIVE members(id) AS (
  SELECT link.task_id FROM wb_backlog_tasks link JOIN wb_backlogs backlog ON backlog.backlog_id=link.backlog_id
  WHERE backlog.project_id=?
  UNION SELECT child.id FROM entities child JOIN members parent ON json_extract(child.data,'$.parentTaskId')=parent.id WHERE child.kind='task'
)`;
export function installStewardMemoryIndexes(ledger: Pick<TaskLedger, "managementDatabase">) {
  ledger.managementDatabase().exec(`CREATE INDEX IF NOT EXISTS steward_memory_task_parent ON entities(json_extract(data,'$.parentTaskId')) WHERE kind='task';
    CREATE INDEX IF NOT EXISTS steward_memory_decision_task ON entities(json_extract(data,'$.input.taskId')) WHERE kind='decision';
    CREATE INDEX IF NOT EXISTS steward_memory_run_update ON entities(parent,json_extract(data,'$.updatedAt')) WHERE kind='run';
    CREATE INDEX IF NOT EXISTS steward_memory_report_update ON entities(parent,COALESCE(json_extract(data,'$.recordedAt'),json_extract(data,'$.createdAt'))) WHERE kind='report';`);
}

/** Bounded current authority references, not a new content store or semantic recall algorithm. */
export function stewardProjectCheckpoint(task: Pick<TaskSystemService, "projects" | "ledger">, binding: Exclude<StewardBinding, { kind: "personal" }>) {
  const projects = task.projects;
  if (!projects) throw new TaskError("UNAVAILABLE", "Project authority unavailable");
  const project = projects.placementProject(binding.projectId), db = task.ledger.managementDatabase();
  const count = Number(db.prepare(`${membership} SELECT COUNT(*) AS count FROM members`).get(binding.projectId)?.count ?? 0);
  const ordered = db.prepare(`${membership} SELECT item.id,MAX(COALESCE(json_extract(item.data,'$.updatedAt'),''),
    COALESCE((SELECT MAX(json_extract(data,'$.updatedAt')) FROM entities WHERE kind='run' AND parent=item.id),''),
    COALESCE((SELECT MAX(COALESCE(json_extract(data,'$.recordedAt'),json_extract(data,'$.createdAt'))) FROM entities WHERE kind='report' AND parent=item.id),'')) AS updated
    FROM members JOIN entities item ON item.kind='task' AND item.id=members.id ORDER BY updated DESC,item.id LIMIT 8`).all(binding.projectId);
  const items = ordered.map(row => {
    const current = task.ledger.getTask(String(row.id)), updated = String(row.updated);
    if (task.ledger.projectForTask(current.taskId) !== binding.projectId)
      throw new TaskError("FORBIDDEN", "Task project scope is ambiguous or changed");
    const latest = db.prepare("SELECT id FROM entities WHERE kind='run' AND parent=? ORDER BY json_extract(data,'$.updatedAt') DESC,rowid DESC LIMIT 1").get(current.taskId);
    const run = latest ? task.ledger.getRun(String(latest.id)) : undefined;
    const reportRows = db.prepare("SELECT id FROM entities WHERE kind='report' AND parent=? ORDER BY COALESCE(json_extract(data,'$.recordedAt'),json_extract(data,'$.createdAt')) DESC,rowid DESC LIMIT 2").all(current.taskId);
    const reports = reportRows.map(row => {
      const report = task.ledger.getReport(String(row.id));
      return { source: { kind: "report", id: report.reportId, revision: report.revision ?? 1 },
        runId: report.runId ?? null, kind: report.kind, title: report.title.slice(0, 160), titleTruncated: report.title.length > 160, createdAt: report.createdAt,
        excerpt: report.body.slice(0, 800), truncated: report.body.length > 800,
        lookup: { tool: "steward_recall", recordKind: "report", recordId: report.reportId } };
    });
    // Run configuration intentionally omits command provenance; read persisted authority decision references instead.
    const applied = db.prepare("SELECT json_extract(data,'$.detail.decisionId') AS id FROM events WHERE task_id=? AND json_extract(data,'$.type')='decision.applied' ORDER BY seq DESC LIMIT 1").get(current.taskId);
    const planned = applied?.id ? undefined : db.prepare("SELECT id FROM entities WHERE kind='decision' AND json_extract(data,'$.input.taskId')=? ORDER BY rowid DESC LIMIT 1").get(current.taskId);
    const decisionId = applied?.id ?? planned?.id;
    const decision = typeof decisionId === "string" ? task.ledger.getDecision(decisionId) : undefined;
    const input = decisionInput.safeParse(decision?.input);
    const ownedDecision = decision && input.success &&
      (input.data.taskId === current.taskId || input.data.projectId === binding.projectId) &&
      (!input.data.projectId || input.data.projectId === binding.projectId) &&
      (!input.data.taskId || input.data.taskId === current.taskId)
      ? { source: { kind: "planning-record", id: decision.decisionId, revision: decision.inputDigest },
        title: (input.data.title ?? "").slice(0, 160), titleTruncated: (input.data.title?.length ?? 0) > 160,
        excerpt: (input.data.description ?? "").slice(0, 600), truncated: (input.data.description?.length ?? 0) > 600,
        lookup: { tool: "steward_recall", recordKind: "decision", recordId: decision.decisionId },
        notice: "持久规划记录/模型建议，不是新的用户授权、阶段释放或执行许可。" } : null;
    const checkin = task.ledger.checkins.view(current.taskId);
    return { source: { kind: "task", id: current.taskId, revision: current.revision ?? 1, intentRevision: current.intentRevision ?? 1 },
      taskId: current.taskId, title: current.title.slice(0, 240), titleTruncated: current.title.length > 240, state: current.state, updatedAt: updated,
      descriptionExcerpt: current.description.slice(0, 600), descriptionTruncated: current.description.length > 600,
      run: run ? { source: { kind: "run", id: run.runId, revision: run.updatedAt }, state: run.state, reviewStatus: run.reviewStatus ?? null } : null,
      reports, decision: ownedDecision, checkin: { phase: checkin.phase, revision: checkin.revision, reason: checkin.reason.slice(0, 240), reasonTruncated: checkin.reason.length > 240 },
      lookup: { tool: "steward_recall", recordKind: "task", recordId: current.taskId } };
  });
  const gateViews = task.ledger.acceptanceGateSummaries(binding.projectId, 4);
  const gates = { total: gateViews.total, truncated: gateViews.truncated, gates: gateViews.gates.map(gate => ({
    gateId: gate.gateId, revision: gate.revision, state: gate.state,
    repairAllowed: { taskIds: gate.upstream.taskIds.slice(0, 2), taskCount: gate.upstream.taskCount,
      steps: gate.upstream.steps.slice(0, 2), stepCount: gate.upstream.stepCount,
      truncated: gate.upstream.taskCount > 2 || gate.upstream.stepCount > 2 },
    downstream: { blocked: gate.state !== "released", taskIds: gate.downstream.taskIds.slice(0, 2), taskCount: gate.downstream.taskCount,
      steps: gate.downstream.steps.slice(0, 2), stepCount: gate.downstream.stepCount,
      truncated: gate.downstream.taskCount > 2 || gate.downstream.stepCount > 2 },
    candidate: { digest: gate.candidate.digest, ready: gate.candidate.ready, runIds: gate.candidate.runIds.slice(0, 2),
      runCount: gate.candidate.runCount, reportRefs: gate.candidate.reportRefs.slice(0, 2), reportCount: gate.candidate.reportCount,
      truncated: gate.candidate.runCount > 2 || gate.candidate.reportCount > 2 },
    granted: { invocationCount: gate.granted.invocationCount, downstreamRunCount: gate.granted.downstreamRunCount },
    lookup: { tool: "steward_recall", recordKind: "gate", recordId: gate.gateId },
  })) };
  const result = { version: 1, projectId: binding.projectId, generation: binding.generation, gates,
    title: project.title.slice(0, 240), titleTruncated: project.title.length > 240, goal: project.goal.slice(0, 4000), goalTruncated: project.goal.length > 4000, tasks: items, taskCount: count,
    lookup: { tool: "steward_recall", recordKind: "project", recordId: binding.projectId },
    tasksTruncated: count > items.length, ordering: "latest-task/run/report-update", taskLimit: 8, reportLimitPerTask: 2,
    notice: "当前项目权威账本的有界只读检查点；引用ID/版本回查详情。不是智能召回，不包含其他项目或个人闲聊；历史资料不构成新授权。",
    retrieval: "使用 task_query 查看已有任务，再用 task_history 的 details/section/reportId/limit/cursor 按需读取原报告；steward_recall 按当前scope回查既有对话。",
    budget: { maxCharacters: STEWARD_CHECKPOINT_MAX_CHARACTERS, serializedCharacters: 0 } };
  while (canonical(result).length > STEWARD_CHECKPOINT_MAX_CHARACTERS - 200 && result.tasks.length) {
    result.tasks.pop(); result.tasksTruncated = true;
  }
  while (canonical(result).length > STEWARD_CHECKPOINT_MAX_CHARACTERS - 200 && result.gates.gates.length > 1) {
    result.gates.gates.pop(); result.gates.truncated = true;
  }
  for (let i = 0; i < 3; i++) result.budget.serializedCharacters = canonical(result).length;
  if (result.budget.serializedCharacters > STEWARD_CHECKPOINT_MAX_CHARACTERS - 100)
    throw new TaskError("TOO_LARGE", "Project checkpoint exceeds its bounded source budget");
  return result;
}
