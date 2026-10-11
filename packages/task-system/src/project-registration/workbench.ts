import type { DatabaseSync } from "node:sqlite";
import { TaskError } from "../ledger.js";
import { mappedId } from "./protocol.js";
import type { RegistrationRecord } from "./intake.js";

/** Project one accepted source snapshot into the existing management schema.
 * Caller owns the ledger transaction and must initialize Workbench schema first.
 * Always pass the CURRENT stored record, including when an old receipt is replayed.
 * No runtime/session/dispatch records are created: imported facts are observation only.
 */
export function projectRegistrationToWorkbench(
  db: DatabaseSync,
  record: RegistrationRecord,
): void {
  const p = record.packet;
  const map = (kind: string, external: string) =>
    mappedId(p.namespace, p.projectExternalId, kind, external);
  const projectId = record.projectId;
  // Completed source work awaits central review; the source completion stays exact in the registration.
  const state = p.project.state === "completed" ? "paused" : p.project.state;
  const description = `来源：${p.origin.harness} · ${p.namespace} · ${p.projectExternalId}\n来源状态：${p.project.state}；中央复核独立记录。`;
  db.prepare(
    `INSERT INTO wb_projects(project_id,revision,title,goal,description,state,next_step,criteria,created_at,updated_at,started_at,target_at)
    VALUES(?,?,?,?,?,?,?,'[]',?,?,NULL,NULL)
    ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,goal=excluded.goal,
    description=excluded.description,state=excluded.state,next_step=excluded.next_step,updated_at=excluded.updated_at`,
  ).run(
    projectId,
    p.revision,
    p.project.title,
    p.project.goal,
    description,
    state,
    p.project.nextStep,
    p.project.createdAt ?? record.importedAt,
    p.project.updatedAt ?? record.updatedAt,
  );
  // This reference is archived in the task ledger and grants no local filesystem or execution authority.
  db.prepare(
    `INSERT INTO wb_project_workspaces(project_id,workspace_id,node_id,is_default,revision)
    VALUES(?,?,?,1,?) ON CONFLICT(project_id,workspace_id) DO UPDATE SET revision=excluded.revision`,
  ).run(
    projectId,
    map("workspace", p.projectExternalId),
    p.origin.nodeId,
    p.revision,
  );
  for (const [stage, title] of [
    ["next", "来源任务 · 下一步"],
    ["backlog", "来源任务 · 待办"],
    ["supporting", "来源任务 · 支持材料"],
  ] as const) {
    const backlogId = map("backlog", stage);
    db.prepare(
      `INSERT INTO wb_backlogs(backlog_id,revision,project_id,title,goal,state,priority,criteria,target_at)
      VALUES(?,?,?,?,?,'open','normal','[]',NULL)
      ON CONFLICT(backlog_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,goal=excluded.goal`,
    ).run(
      backlogId,
      p.revision,
      projectId,
      title,
      "来源快照的任务分组，不代表中央已派发或验收",
    );
    db.prepare("DELETE FROM wb_backlog_tasks WHERE backlog_id=?").run(
      backlogId,
    );
    for (const t of p.tasks.filter((t) => t.stage === stage))
      db.prepare(
        "INSERT INTO wb_backlog_tasks(backlog_id,task_id) VALUES(?,?)",
      ).run(backlogId, map("task", t.externalId));
  }
  for (const m of p.project.milestones) {
    const milestoneId = map("milestone", m.externalId);
    db.prepare(
      `INSERT INTO wb_milestones(milestone_id,revision,project_id,title,goal,state,criteria,completion_mode,target_at)
      VALUES(?,?,?,?,?,?,'[]','all',NULL)
      ON CONFLICT(milestone_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,state=excluded.state`,
    ).run(
      milestoneId,
      p.revision,
      projectId,
      m.title,
      "来源里程碑；验收以中央复核为准",
      m.state,
    );
    db.prepare("DELETE FROM wb_milestone_tasks WHERE milestone_id=?").run(
      milestoneId,
    );
    for (const t of p.tasks.filter((t) => t.milestoneId === m.externalId))
      db.prepare(
        "INSERT INTO wb_milestone_tasks(milestone_id,task_id) VALUES(?,?)",
      ).run(milestoneId, map("task", t.externalId));
  }
  for (const a of p.artifacts) {
    // Unpinned references deliberately retain unknown byte availability; no fabricated immutable version.
    const artifactId = map("artifact", a.externalId);
    db.prepare(
      `INSERT OR IGNORE INTO wb_artifacts(artifact_id,name,media_type,task_id,ref_kind,ref_id,bytes,created_at)
      VALUES(?,?,?,?,'live',?,?,?)`,
    ).run(
      artifactId,
      a.name,
      a.mediaType,
      map("task", a.taskId),
      a.uri,
      a.bytes ?? null,
      a.createdAt ?? record.importedAt,
    );
    db.prepare(
      `INSERT OR IGNORE INTO wb_artifact_relations(relation_id,artifact_id,project_id,action,context,recorded_at)
      VALUES(?,?,?,'referenced',?,?)`,
    ).run(
      map("artifact-project", a.externalId),
      artifactId,
      projectId,
      "来源引用；未复制文件，中央未验证可用性",
      record.importedAt,
    );
  }
}

/** Guard only source-owned workbench facts. Central classification and review remain independent. */
export function assertRegistrationProjectionWritable(
  db: DatabaseSync,
  operation: string,
  data: Record<string, unknown>,
) {
  const projectOwned = (projectId: unknown) =>
    typeof projectId === "string" &&
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM entities WHERE kind='registration' AND json_extract(data,'$.projectId')=? LIMIT 1",
        )
        .get(projectId),
    );
  const relatedProject = (table: string, key: string, value: unknown) =>
    typeof value === "string"
      ? (
          db
            .prepare(`SELECT project_id FROM ${table} WHERE ${key}=?`)
            .get(value) as { project_id: string } | undefined
        )?.project_id
      : undefined;
  let projectId: unknown;
  if (
    [
      "update_project",
      "link_project_workspace",
      "unlink_project_workspace",
    ].includes(operation)
  )
    projectId = data.projectId;
  if (
    ["update_backlog", "link_backlog_task", "unlink_backlog_task"].includes(
      operation,
    )
  )
    projectId = relatedProject("wb_backlogs", "backlog_id", data.backlogId);
  if (
    [
      "update_milestone",
      "link_milestone_task",
      "unlink_milestone_task",
      "link_milestone_backlog",
      "unlink_milestone_backlog",
    ].includes(operation)
  )
    projectId = relatedProject(
      "wb_milestones",
      "milestone_id",
      data.milestoneId,
    );
  if (projectOwned(projectId))
    throw new TaskError(
      "FORBIDDEN",
      "Origin owns registered project facts and links; use registration central metadata for review",
    );
}
