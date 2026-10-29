import { assertRegistrationProjectionWritable } from "./project-registration/workbench.js";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Receipt, Report, Task } from "./contracts.js";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import {
  validateCriteria,
  validateVersionRef,
  type ArtifactRelation,
  type Backlog,
  type ConditionStatus,
  type ContentRef,
  type Criterion,
  type CriterionCheck,
  type CriterionView,
  type Domain,
  type Milestone,
  type Priority,
  type Project,
  type RegisteredArtifact,
  type Skill,
  type VersionRef,
  type WorkbenchSnapshot,
} from "./workbench-contracts.js";

type Data = Record<string, unknown>;
type Row = Record<string, string | number | null>;
type OwnerType = "project" | "backlog" | "milestone";
export interface WorkbenchOptions {
  /** Trusted interactive management host only. Never populate from request data or a claimed actor. */
  allowManualChecks?: boolean;
}
function fail(code: string, message: string): never {
  throw new TaskError(code, message);
}
function object(value: unknown): Data {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("INVALID", "Expected a plain object");
  return value as Data;
}
function fields(data: Data, allowed: string[]) {
  const unknown = Object.keys(data).find((key) => !allowed.includes(key));
  if (unknown) fail("INVALID", `Unexpected field: ${unknown}`);
}
function id(value: unknown, label = "id"): string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[\w][\w:./@-]*$/.test(value)
  )
    return fail("INVALID", `Invalid ${label}`);
  return value;
}
function text(
  value: unknown,
  label: string,
  required = false,
  max = 20_000,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    return fail("INVALID", `Invalid ${label}`);
  return value;
}
function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  if (!choices.includes(value as T)) return fail("INVALID", `Invalid ${label}`);
  return value as T;
}
function integer(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    return fail("INVALID", `Invalid ${label}`);
  return value;
}
function timestamp(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return fail("INVALID", `${label} must be a UTC timestamp`);
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19))
    return fail("INVALID", `Invalid ${label} calendar date`);
  return normalized;
}
const schema = `
CREATE TABLE IF NOT EXISTS wb_schema(version INTEGER NOT NULL CHECK(version=1));
INSERT INTO wb_schema SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM wb_schema);
CREATE TABLE IF NOT EXISTS wb_domains(
 domain_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1), title TEXT NOT NULL,
 summary TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','archived')), position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wb_projects(
 project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1), title TEXT NOT NULL, goal TEXT NOT NULL,
 description TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','active','paused','archived')), next_step TEXT NOT NULL,
 criteria TEXT NOT NULL CHECK(json_valid(criteria)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, target_at TEXT);
CREATE TABLE IF NOT EXISTS wb_backlogs(
 backlog_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1), project_id TEXT NOT NULL REFERENCES wb_projects(project_id),
 title TEXT NOT NULL, goal TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','paused','cancelled','archived')),
 priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')), criteria TEXT NOT NULL CHECK(json_valid(criteria)), target_at TEXT);
CREATE INDEX IF NOT EXISTS wb_backlog_project ON wb_backlogs(project_id);
CREATE TABLE IF NOT EXISTS wb_skills(
 skill_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1), title TEXT NOT NULL, summary TEXT NOT NULL,
 ability_statement TEXT NOT NULL, practice_notes TEXT NOT NULL, method_notes TEXT NOT NULL, limitations TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('draft','active','archived')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wb_milestones(
 milestone_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1), project_id TEXT NOT NULL REFERENCES wb_projects(project_id),
 title TEXT NOT NULL, goal TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('planned','active','cancelled','archived')),
 criteria TEXT NOT NULL CHECK(json_valid(criteria)), completion_mode TEXT NOT NULL CHECK(completion_mode IN ('all','any')), target_at TEXT);
CREATE TABLE IF NOT EXISTS wb_domain_projects(
 domain_id TEXT NOT NULL REFERENCES wb_domains(domain_id), project_id TEXT NOT NULL REFERENCES wb_projects(project_id), PRIMARY KEY(domain_id,project_id));
CREATE TABLE IF NOT EXISTS wb_backlog_tasks(
 backlog_id TEXT NOT NULL REFERENCES wb_backlogs(backlog_id), task_id TEXT NOT NULL, task_kind TEXT NOT NULL DEFAULT 'task' CHECK(task_kind='task'),
 PRIMARY KEY(backlog_id,task_id), FOREIGN KEY(task_kind,task_id) REFERENCES entities(kind,id));
CREATE INDEX IF NOT EXISTS wb_backlog_task_lookup ON wb_backlog_tasks(task_id);
CREATE TABLE IF NOT EXISTS wb_project_workspaces(
 project_id TEXT NOT NULL REFERENCES wb_projects(project_id), workspace_id TEXT NOT NULL, node_id TEXT NOT NULL,
 workspace_kind TEXT NOT NULL DEFAULT 'workspace' CHECK(workspace_kind='workspace'), is_default INTEGER NOT NULL CHECK(is_default IN (0,1)), revision INTEGER NOT NULL CHECK(revision>=1),
 PRIMARY KEY(project_id,workspace_id), FOREIGN KEY(workspace_kind,workspace_id) REFERENCES entities(kind,id));
CREATE UNIQUE INDEX IF NOT EXISTS wb_one_default_workspace ON wb_project_workspaces(project_id,node_id) WHERE is_default=1;
CREATE TABLE IF NOT EXISTS wb_milestone_backlogs(
 milestone_id TEXT NOT NULL REFERENCES wb_milestones(milestone_id), backlog_id TEXT NOT NULL REFERENCES wb_backlogs(backlog_id), PRIMARY KEY(milestone_id,backlog_id));
CREATE TABLE IF NOT EXISTS wb_milestone_tasks(
 milestone_id TEXT NOT NULL REFERENCES wb_milestones(milestone_id), task_id TEXT NOT NULL, task_kind TEXT NOT NULL DEFAULT 'task' CHECK(task_kind='task'),
 PRIMARY KEY(milestone_id,task_id), FOREIGN KEY(task_kind,task_id) REFERENCES entities(kind,id));
CREATE TABLE IF NOT EXISTS wb_skill_projects(
 skill_id TEXT NOT NULL REFERENCES wb_skills(skill_id), project_id TEXT NOT NULL REFERENCES wb_projects(project_id), context TEXT NOT NULL, PRIMARY KEY(skill_id,project_id));
CREATE TABLE IF NOT EXISTS wb_skill_reports(
 skill_id TEXT NOT NULL REFERENCES wb_skills(skill_id), report_id TEXT NOT NULL, context TEXT NOT NULL,
 report_kind TEXT NOT NULL DEFAULT 'report' CHECK(report_kind='report'), PRIMARY KEY(skill_id,report_id), FOREIGN KEY(report_kind,report_id) REFERENCES entities(kind,id));
CREATE TABLE IF NOT EXISTS wb_artifacts(
 artifact_id TEXT PRIMARY KEY, name TEXT NOT NULL, material_id TEXT, media_type TEXT,
 task_id TEXT, report_id TEXT, task_kind TEXT NOT NULL DEFAULT 'task' CHECK(task_kind='task'), report_kind TEXT NOT NULL DEFAULT 'report' CHECK(report_kind='report'),
 ref_kind TEXT NOT NULL CHECK(ref_kind IN ('native','git','object','live')), ref_provider TEXT, ref_id TEXT, ref_version TEXT, ref_path TEXT,
 bytes INTEGER CHECK(bytes>=0), sha256 TEXT, created_at TEXT NOT NULL,
 FOREIGN KEY(task_kind,task_id) REFERENCES entities(kind,id), FOREIGN KEY(report_kind,report_id) REFERENCES entities(kind,id));
CREATE TABLE IF NOT EXISTS wb_artifact_relations(
 relation_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES wb_artifacts(artifact_id),
 project_id TEXT REFERENCES wb_projects(project_id), task_id TEXT, report_id TEXT, skill_id TEXT REFERENCES wb_skills(skill_id), predecessor_id TEXT REFERENCES wb_artifacts(artifact_id),
 task_kind TEXT NOT NULL DEFAULT 'task' CHECK(task_kind='task'), report_kind TEXT NOT NULL DEFAULT 'report' CHECK(report_kind='report'),
 run_kind TEXT NOT NULL DEFAULT 'run' CHECK(run_kind='run'), attempt_kind TEXT NOT NULL DEFAULT 'attempt' CHECK(attempt_kind='attempt'),
 action TEXT CHECK(action IN ('produced','modified','derived','referenced','explained','validated','reflected')), context TEXT NOT NULL,
 run_id TEXT, attempt_id TEXT, recorded_at TEXT NOT NULL,
 CHECK((project_id IS NOT NULL)+(task_id IS NOT NULL)+(report_id IS NOT NULL)+(skill_id IS NOT NULL)+(predecessor_id IS NOT NULL)=1),
 CHECK(artifact_id<>predecessor_id), FOREIGN KEY(task_kind,task_id) REFERENCES entities(kind,id), FOREIGN KEY(report_kind,report_id) REFERENCES entities(kind,id),
 FOREIGN KEY(run_kind,run_id) REFERENCES entities(kind,id), FOREIGN KEY(attempt_kind,attempt_id) REFERENCES entities(kind,id));
CREATE UNIQUE INDEX IF NOT EXISTS wb_artifact_project_unique ON wb_artifact_relations(artifact_id,project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wb_artifact_skill_unique ON wb_artifact_relations(artifact_id,skill_id) WHERE skill_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wb_artifact_predecessor_unique ON wb_artifact_relations(artifact_id,predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS wb_criterion_checks(
 check_id TEXT PRIMARY KEY, project_id TEXT REFERENCES wb_projects(project_id), backlog_id TEXT REFERENCES wb_backlogs(backlog_id), milestone_id TEXT REFERENCES wb_milestones(milestone_id),
 owner_revision INTEGER NOT NULL CHECK(owner_revision>=1), criterion_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('met','unmet','unknown')),
 note TEXT NOT NULL, checked_at TEXT NOT NULL, source_role TEXT NOT NULL, source_node_id TEXT NOT NULL,
 CHECK((project_id IS NOT NULL)+(backlog_id IS NOT NULL)+(milestone_id IS NOT NULL)=1));
CREATE TABLE IF NOT EXISTS wb_check_evidence(
 check_id TEXT NOT NULL REFERENCES wb_criterion_checks(check_id), position INTEGER NOT NULL,
 ref_type TEXT NOT NULL CHECK(ref_type IN ('task','artifact','milestone','report','project','backlog','skill')), ref_id TEXT NOT NULL, ref_revision INTEGER,
 PRIMARY KEY(check_id,position));
`;

/** Private management service sharing the authority ledger transaction and identity boundary. */
export class Workbench {
  private readonly db: DatabaseSync;
  constructor(
    private readonly ledger: TaskLedger,
    private readonly options: WorkbenchOptions = {},
  ) {
    this.db = ledger.managementDatabase();
  }
  private ready(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_schema'",
        )
        .get(),
    );
  }
  private ensureSchema() {
    if (!this.ready()) this.db.exec(schema);
    const row = this.db.prepare("SELECT version FROM wb_schema").get() as
      | Row
      | undefined;
    if (row?.version !== 1) fail("SCHEMA", "Unsupported workbench schema");
  }
  /** Schema only; intake owns its authoritative transaction and source revisions. */
  prepareRegistration() {
    this.ledger.assertManagementWritable();
    this.ensureSchema();
  }
  private rows(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private need(table: string, column: string, key: unknown): Row {
    const row = this.one(`SELECT * FROM ${table} WHERE ${column}=?`, id(key));
    return row ?? fail("NOT_FOUND", `${column} not found`);
  }
  private exists(table: string, column: string, key: string) {
    if (this.one(`SELECT 1 FROM ${table} WHERE ${column}=?`, key))
      fail("CONFLICT", `${column} already exists`);
  }
  private revision(row: Row, value: unknown): number {
    const expected = integer(value, "expectedRevision", 1);
    if (row.revision !== expected)
      fail("CONFLICT", "Content revision changed; reload before saving");
    return expected + 1;
  }
  private entity<T>(kind: string, key: string): T {
    const row = this.one(
      "SELECT data FROM entities WHERE kind=? AND id=?",
      kind,
      id(key),
    );
    if (!row) return fail("NOT_FOUND", `${kind} not found`);
    return JSON.parse(String(row.data)) as T;
  }
  private target(ref: VersionRef) {
    if (ref.type === "task") {
      const task = this.ledger.getTask(ref.id);
      if (
        ref.revision !== undefined &&
        ref.revision !== (task.intentRevision ?? 1)
      )
        fail("CONFLICT", "Target task intent revision changed");
    } else if (ref.type === "report") {
      this.entity<Report>("report", ref.id);
    } else if (ref.type === "artifact") {
      if (!this.one("SELECT 1 FROM wb_artifacts WHERE artifact_id=?", ref.id))
        this.entity("artifact", ref.id);
    } else {
      const config = {
        project: ["wb_projects", "project_id"],
        backlog: ["wb_backlogs", "backlog_id"],
        milestone: ["wb_milestones", "milestone_id"],
        skill: ["wb_skills", "skill_id"],
      }[ref.type]!;
      const row = this.need(config[0]!, config[1]!, ref.id);
      if (ref.revision !== undefined && ref.revision !== row.revision)
        fail("CONFLICT", "Target content revision changed");
    }
  }
  private criteria(value: unknown): Criterion[] {
    return validateCriteria(value, (ref) => this.target(ref));
  }
  effectivePriority(taskId: string): Priority {
    return this.ledger.effectivePriority(taskId);
  }

  linkDispatcherTask(backlogId:string,taskId:string) {
    this.ledger.assertManagementWritable();
    if(!this.db.isTransaction)fail("FORBIDDEN","Dispatcher linking requires the ledger transaction");
    return this.relation("link_backlog_task",{backlogId,taskId});
  }
  manage(
    commandId: string,
    operation: string,
    input: unknown,
  ): Receipt<unknown> {
    this.ledger.assertManagementWritable();
    id(commandId, "commandId");
    const data = object(input);
    const encoded = canonical({
      operation: `workbench.${operation}`,
      input: data,
    });
    if (encoded.length > 256_000)
      fail("TOO_LARGE", "Management command exceeds 256 KB");
    const digest = createHash("sha256").update(encoded).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.one(
        "SELECT digest,receipt FROM commands WHERE id=?",
        commandId,
      );
      if (old) {
        if (old.digest !== digest)
          fail("CONFLICT", "Idempotency key reused with a different command");
        this.db.exec("COMMIT");
        return JSON.parse(String(old.receipt)) as Receipt<unknown>;
      }
      this.ensureSchema();
      const value = this.apply(operation, data);
      const receipt: Receipt<unknown> = {
        commandId,
        acceptedAt: this.ledger.managementNow(),
        value,
      };
      this.db
        .prepare("INSERT INTO commands(id,digest,receipt) VALUES(?,?,?)")
        .run(commandId, digest, canonical(receipt));
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      )
        fail("CONFLICT", "This record or association already exists");
      throw error;
    }
  }
  private apply(operation: string, data: Data): unknown {
    assertRegistrationProjectionWritable(this.db, operation, data);
    switch (operation) {
      case "create_domain":
      case "update_domain":
        return this.domain(data, operation === "update_domain");
      case "create_project":
      case "update_project":
        return this.project(data, operation === "update_project");
      case "create_backlog":
      case "update_backlog":
        return this.backlog(data, operation === "update_backlog");
      case "create_skill":
      case "update_skill":
        return this.skill(data, operation === "update_skill");
      case "create_milestone":
      case "update_milestone":
        return this.milestone(data, operation === "update_milestone");
      case "link_project_workspace":
      case "unlink_project_workspace":
        return this.workspace(data, operation.startsWith("unlink"));
      case "link_domain_project":
      case "unlink_domain_project":
      case "link_backlog_task":
      case "unlink_backlog_task":
      case "link_milestone_backlog":
      case "unlink_milestone_backlog":
      case "link_milestone_task":
      case "unlink_milestone_task":
      case "link_skill_project":
      case "unlink_skill_project":
      case "link_skill_report":
      case "unlink_skill_report":
        return this.relation(operation, data);
      case "register_artifact":
        return this.registerArtifact(data);
      case "link_artifact":
        return this.artifactRelation(data);
      case "check_criterion":
        return this.checkCriterion(data);
      default:
        return fail("INVALID", "Unknown management operation");
    }
  }
  private domain(data: Data, update: boolean): Domain {
    fields(data, [
      "domainId",
      "expectedRevision",
      "title",
      "summary",
      "state",
      "position",
    ]);
    if (!update && data.expectedRevision !== undefined)
      fail("INVALID", "New content has no expectedRevision");
    const key = id(
      data.domainId ?? (update ? undefined : randomUUID()),
      "domainId",
    );
    const old = update ? this.need("wb_domains", "domain_id", key) : undefined;
    if (!old) this.exists("wb_domains", "domain_id", key);
    const revision = old ? this.revision(old, data.expectedRevision) : 1;
    const title = text(data.title ?? old?.title, "title", true, 500);
    const summary = text(data.summary ?? old?.summary ?? "", "summary");
    const state = choice(
      data.state ?? old?.state ?? "active",
      ["active", "archived"],
      "state",
    );
    const position = integer(
      data.position ?? old?.position ?? 0,
      "position",
      -2_147_483_648,
    );
    this.db
      .prepare(
        "INSERT INTO wb_domains VALUES(?,?,?,?,?,?) ON CONFLICT(domain_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,summary=excluded.summary,state=excluded.state,position=excluded.position",
      )
      .run(key, revision, title, summary, state, position);
    return this.getDomain(key);
  }
  private project(data: Data, update: boolean): Project {
    fields(data, [
      "projectId",
      "expectedRevision",
      "title",
      "goal",
      "description",
      "state",
      "nextStep",
      "acceptanceCriteria",
      "startedAt",
      "targetAt",
    ]);
    if (!update && data.expectedRevision !== undefined)
      fail("INVALID", "New content has no expectedRevision");
    const key = id(
      data.projectId ?? (update ? undefined : randomUUID()),
      "projectId",
    );
    this.ledger.assertAcceptanceProjectPlan(key);
    const old = update
      ? this.need("wb_projects", "project_id", key)
      : undefined;
    if (!old) this.exists("wb_projects", "project_id", key);
    const revision = old ? this.revision(old, data.expectedRevision) : 1;
    const title = text(data.title ?? old?.title, "title", true, 500);
    const goal = text(data.goal ?? old?.goal ?? "", "goal");
    const description = text(
      data.description ?? old?.description ?? "",
      "description",
    );
    const state = choice(
      data.state ?? old?.state ?? "draft",
      ["draft", "active", "paused", "archived"],
      "state",
    );
    if (state === "active" && !goal.trim())
      fail("INVALID", "An active project needs a goal");
    const next = text(data.nextStep ?? old?.next_step ?? "", "nextStep");
    const criteria =
      data.acceptanceCriteria === undefined && old
        ? String(old.criteria)
        : canonical(this.criteria(data.acceptanceCriteria ?? []));
    const started = timestamp(
      data.startedAt === undefined ? old?.started_at : data.startedAt,
      "startedAt",
    );
    const target = timestamp(
      data.targetAt === undefined ? old?.target_at : data.targetAt,
      "targetAt",
    );
    const now = this.ledger.managementNow();
    this.db
      .prepare(
        "INSERT INTO wb_projects VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,goal=excluded.goal,description=excluded.description,state=excluded.state,next_step=excluded.next_step,criteria=excluded.criteria,updated_at=excluded.updated_at,started_at=excluded.started_at,target_at=excluded.target_at",
      )
      .run(
        key,
        revision,
        title,
        goal,
        description,
        state,
        next,
        criteria,
        old?.created_at ?? now,
        now,
        started,
        target,
      );
    return this.getProject(key);
  }
  private backlog(data: Data, update: boolean): Backlog {
    fields(data, [
      "backlogId",
      "expectedRevision",
      "projectId",
      "title",
      "goal",
      "state",
      "priority",
      "acceptanceCriteria",
      "targetAt",
    ]);
    if (!update && data.expectedRevision !== undefined)
      fail("INVALID", "New content has no expectedRevision");
    const key = id(
      data.backlogId ?? (update ? undefined : randomUUID()),
      "backlogId",
    );
    const old = update
      ? this.need("wb_backlogs", "backlog_id", key)
      : undefined;
    if (!old) this.exists("wb_backlogs", "backlog_id", key);
    const revision = old ? this.revision(old, data.expectedRevision) : 1;
    const projectId = id(data.projectId ?? old?.project_id, "projectId");
    this.ledger.assertAcceptanceProjectPlan(projectId);
    this.need("wb_projects", "project_id", projectId);
    if (old && projectId !== old.project_id)
      fail("INVALID", "Backlog project cannot be reassigned");
    const title = text(data.title ?? old?.title, "title", true, 500);
    const goal = text(data.goal ?? old?.goal ?? "", "goal");
    const requestedState = choice(
      data.state ?? old?.state ?? "open",
      ["open", "paused", "completed", "cancelled", "archived"],
      "state",
    );
    const priority = choice(
      data.priority ?? old?.priority ?? "normal",
      ["low", "normal", "high", "urgent"],
      "priority",
    );
    const criteria =
      data.acceptanceCriteria === undefined && old
        ? String(old.criteria)
        : canonical(this.criteria(data.acceptanceCriteria ?? []));
    const target = timestamp(
      data.targetAt === undefined ? old?.target_at : data.targetAt,
      "targetAt",
    );
    this.db
      .prepare(
        "INSERT INTO wb_backlogs VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(backlog_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,goal=excluded.goal,state=excluded.state,priority=excluded.priority,criteria=excluded.criteria,target_at=excluded.target_at",
      )
      .run(
        key,
        revision,
        projectId,
        title,
        goal,
        requestedState === "completed" ? "open" : requestedState,
        priority,
        criteria,
        target,
      );
    const value = this.getBacklog(key);
    if (requestedState === "completed" && value.conditionStatus !== "met")
      fail(
        "CONDITION_UNMET",
        "Backlog completion requires its current non-empty criteria to be met",
      );
    return value;
  }
  private skill(data: Data, update: boolean): Skill {
    fields(data, [
      "skillId",
      "expectedRevision",
      "title",
      "summary",
      "abilityStatement",
      "practiceNotes",
      "methodNotes",
      "limitations",
      "state",
    ]);
    if (!update && data.expectedRevision !== undefined)
      fail("INVALID", "New content has no expectedRevision");
    const key = id(
      data.skillId ?? (update ? undefined : randomUUID()),
      "skillId",
    );
    const old = update ? this.need("wb_skills", "skill_id", key) : undefined;
    if (!old) this.exists("wb_skills", "skill_id", key);
    const revision = old ? this.revision(old, data.expectedRevision) : 1;
    const values = [
      text(data.title ?? old?.title, "title", true, 500),
      text(data.summary ?? old?.summary ?? "", "summary"),
      text(
        data.abilityStatement ?? old?.ability_statement ?? "",
        "abilityStatement",
      ),
      text(data.practiceNotes ?? old?.practice_notes ?? "", "practiceNotes"),
      text(data.methodNotes ?? old?.method_notes ?? "", "methodNotes"),
      text(data.limitations ?? old?.limitations ?? "", "limitations"),
    ];
    const state = choice(
      data.state ?? old?.state ?? "draft",
      ["draft", "active", "archived"],
      "state",
    );
    const now = this.ledger.managementNow();
    this.db
      .prepare(
        "INSERT INTO wb_skills VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(skill_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,summary=excluded.summary,ability_statement=excluded.ability_statement,practice_notes=excluded.practice_notes,method_notes=excluded.method_notes,limitations=excluded.limitations,state=excluded.state,updated_at=excluded.updated_at",
      )
      .run(key, revision, ...values, state, old?.created_at ?? now, now);
    return this.getSkill(key);
  }
  private milestone(data: Data, update: boolean): Milestone {
    fields(data, [
      "milestoneId",
      "expectedRevision",
      "projectId",
      "title",
      "goal",
      "state",
      "conditions",
      "completionMode",
      "targetAt",
    ]);
    if (!update && data.expectedRevision !== undefined)
      fail("INVALID", "New content has no expectedRevision");
    const key = id(
      data.milestoneId ?? (update ? undefined : randomUUID()),
      "milestoneId",
    );
    const old = update
      ? this.need("wb_milestones", "milestone_id", key)
      : undefined;
    if (!old) this.exists("wb_milestones", "milestone_id", key);
    const revision = old ? this.revision(old, data.expectedRevision) : 1;
    const projectId = id(data.projectId ?? old?.project_id, "projectId");
    this.ledger.assertAcceptanceProjectPlan(projectId);
    this.need("wb_projects", "project_id", projectId);
    if (old && projectId !== old.project_id)
      fail("INVALID", "Milestone project cannot be reassigned");
    const title = text(data.title ?? old?.title, "title", true, 500);
    const goal = text(data.goal ?? old?.goal ?? "", "goal");
    const state = choice(
      data.state ?? old?.state ?? "planned",
      ["planned", "active", "cancelled", "archived"],
      "state",
    );
    const criteria =
      data.conditions === undefined && old
        ? (JSON.parse(String(old.criteria)) as Criterion[])
        : this.criteria(data.conditions ?? []);
    if (state === "active" && !criteria.length)
      fail("INVALID", "An active milestone requires conditions");
    if (
      criteria.some(
        (c) => c.targetRef?.type === "milestone" && c.targetRef.id === key,
      )
    )
      fail("INVALID", "A milestone cannot depend on itself");
    const mode = choice(
      data.completionMode ?? old?.completion_mode ?? "all",
      ["all", "any"],
      "completionMode",
    );
    const target = timestamp(
      data.targetAt === undefined ? old?.target_at : data.targetAt,
      "targetAt",
    );
    this.db
      .prepare(
        "INSERT INTO wb_milestones VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(milestone_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,goal=excluded.goal,state=excluded.state,criteria=excluded.criteria,completion_mode=excluded.completion_mode,target_at=excluded.target_at",
      )
      .run(
        key,
        revision,
        projectId,
        title,
        goal,
        state,
        canonical(criteria),
        mode,
        target,
      );
    this.checkMilestoneCycles();
    return this.getMilestone(key);
  }
  private relation(operation: string, data: Data) {
    const remove = operation.startsWith("unlink_");
    const kind = operation.replace(/^(?:un)?link_/, "");
    const specs: Record<
      string,
      [string, string, string, string, string, string, string]
    > = {
      domain_project: [
        "wb_domain_projects",
        "domainId",
        "domain_id",
        "wb_domains",
        "projectId",
        "project_id",
        "wb_projects",
      ],
      backlog_task: [
        "wb_backlog_tasks",
        "backlogId",
        "backlog_id",
        "wb_backlogs",
        "taskId",
        "task_id",
        "task",
      ],
      milestone_backlog: [
        "wb_milestone_backlogs",
        "milestoneId",
        "milestone_id",
        "wb_milestones",
        "backlogId",
        "backlog_id",
        "wb_backlogs",
      ],
      milestone_task: [
        "wb_milestone_tasks",
        "milestoneId",
        "milestone_id",
        "wb_milestones",
        "taskId",
        "task_id",
        "task",
      ],
      skill_project: [
        "wb_skill_projects",
        "skillId",
        "skill_id",
        "wb_skills",
        "projectId",
        "project_id",
        "wb_projects",
      ],
      skill_report: [
        "wb_skill_reports",
        "skillId",
        "skill_id",
        "wb_skills",
        "reportId",
        "report_id",
        "report",
      ],
    };
    const [
      table,
      leftName,
      leftColumn,
      leftTable,
      rightName,
      rightColumn,
      rightTable,
    ] = specs[kind] ?? fail("INVALID", "Unknown relation");
    const hasContext = kind === "skill_project" || kind === "skill_report";
    fields(data, [
      leftName,
      rightName,
      ...(hasContext && !remove ? ["context"] : []),
    ]);
    const left = id(data[leftName], leftName),
      right = id(data[rightName], rightName);
    const leftRow = this.need(leftTable, leftColumn, left);
    const rightRow = rightTable.startsWith("wb_")
      ? this.need(rightTable, rightColumn, right)
      : this.entity<Data>(rightTable, right);
    if (kind === "backlog_task" || kind === "milestone_task") this.ledger.assertAcceptanceProjectPlan(String(leftRow.project_id), right);
    if (
      kind === "milestone_backlog" &&
      leftRow.project_id !== rightRow.project_id
    )
      fail(
        "INVALID",
        "Milestone backlog scope must belong to the same project",
      );
    if (remove) {
      this.db
        .prepare(
          `DELETE FROM ${table} WHERE ${leftColumn}=? AND ${rightColumn}=?`,
        )
        .run(left, right);
      return { [leftName]: left, [rightName]: right, linked: false };
    }
    const context = hasContext
      ? text(data.context ?? "", "context")
      : undefined;
    const old = this.one(
      `SELECT * FROM ${table} WHERE ${leftColumn}=? AND ${rightColumn}=?`,
      left,
      right,
    );
    if (old && hasContext && old.context !== context)
      fail(
        "CONFLICT",
        "Existing evidence context differs; unlink and explicitly relink",
      );
    if (!old)
      this.db
        .prepare(
          `INSERT INTO ${table}(${leftColumn},${rightColumn}${hasContext ? ",context" : ""}) VALUES(?,?${hasContext ? ",?" : ""})`,
        )
        .run(left, right, ...(context === undefined ? [] : [context]));
    return {
      [leftName]: left,
      [rightName]: right,
      ...(hasContext ? { context } : {}),
    };
  }
  private workspace(data: Data, remove: boolean) {
    fields(data, [
      "projectId",
      "workspaceId",
      "expectedRevision",
      ...(remove ? [] : ["isDefault"]),
    ]);
    const projectId = id(data.projectId, "projectId"),
      workspaceId = id(data.workspaceId, "workspaceId");
    this.need("wb_projects", "project_id", projectId);
    const workspace = this.ledger.getWorkspace(workspaceId);
    const old = this.one(
      "SELECT * FROM wb_project_workspaces WHERE project_id=? AND workspace_id=?",
      projectId,
      workspaceId,
    );
    if (remove) {
      if (!old) fail("NOT_FOUND", "Project workspace binding not found");
      this.revision(old, data.expectedRevision);
      this.db
        .prepare(
          "DELETE FROM wb_project_workspaces WHERE project_id=? AND workspace_id=?",
        )
        .run(projectId, workspaceId);
      return { projectId, workspaceId, linked: false };
    }
    if (workspace.state !== "ready")
      fail("INVALID", "Only provisioned ready workspaces can be bound");
    const isDefault = data.isDefault ?? (old ? old.is_default === 1 : false);
    if (typeof isDefault !== "boolean")
      fail("INVALID", "isDefault must be boolean");
    const revision = old ? this.revision(old, data.expectedRevision) : 1;
    if (!old && data.expectedRevision !== undefined)
      fail("INVALID", "New relation has no expectedRevision");
    if (
      isDefault &&
      this.one(
        "SELECT 1 FROM wb_project_workspaces WHERE project_id=? AND node_id=? AND is_default=1 AND workspace_id<>?",
        projectId,
        workspace.nodeId,
        workspaceId,
      )
    )
      fail(
        "CONFLICT",
        "This project already has a default workspace on this node",
      );
    this.db
      .prepare(
        "INSERT INTO wb_project_workspaces(project_id,workspace_id,node_id,is_default,revision) VALUES(?,?,?,?,?) ON CONFLICT(project_id,workspace_id) DO UPDATE SET is_default=excluded.is_default,revision=excluded.revision",
      )
      .run(
        projectId,
        workspaceId,
        workspace.nodeId,
        isDefault ? 1 : 0,
        revision,
      );
    return {
      projectId,
      workspaceId,
      nodeId: workspace.nodeId,
      isDefault,
      revision,
    };
  }
  private contentRef(value: unknown): ContentRef {
    const data = object(value);
    const kind = choice(
      data.kind,
      ["native", "git", "object", "live"],
      "contentRef.kind",
    );
    if (kind === "native") {
      fields(data, ["kind", "provider", "fileId", "version"]);
      return {
        kind,
        provider: text(data.provider, "provider", true, 100),
        fileId: text(data.fileId, "fileId", true, 2000),
        version: text(data.version, "version", true, 500),
      };
    }
    if (kind === "object") {
      fields(data, ["kind", "provider", "objectId", "version"]);
      return {
        kind,
        provider: text(data.provider, "provider", true, 100),
        objectId: text(data.objectId, "objectId", true, 2000),
        version: text(data.version, "version", true, 500),
      };
    }
    if (kind === "git") {
      fields(data, ["kind", "repository", "commit", "path"]);
      const commit = text(data.commit, "commit", true, 64);
      if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commit))
        fail("INVALID", "Git contentRef requires a full commit ID");
      const path = text(data.path, "path", true, 4000);
      if (path.startsWith("/") || path.split("/").includes(".."))
        fail("INVALID", "Git path must be repository-relative");
      return {
        kind,
        repository: text(data.repository, "repository", true, 2000),
        commit,
        path,
      };
    }
    fields(data, ["kind", "url"]);
    const url = text(data.url, "url", true, 4000);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail("INVALID", "Invalid live URL");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      fail(
        "INVALID",
        "Live reference must be an HTTP(S) URL without credentials",
      );
    return { kind, url };
  }
  private registerArtifact(data: Data): RegisteredArtifact {
    fields(data, [
      "artifactId",
      "name",
      "materialId",
      "mediaType",
      "taskId",
      "reportId",
      "contentRef",
      "bytes",
      "sha256",
    ]);
    const key = id(data.artifactId ?? randomUUID(), "artifactId");
    this.exists("wb_artifacts", "artifact_id", key);
    if (this.one("SELECT 1 FROM entities WHERE kind='artifact' AND id=?", key))
      fail("CONFLICT", "Artifact ID already belongs to a legacy attachment");
    const name = text(data.name, "name", true, 500);
    const materialId =
      data.materialId === undefined ? null : id(data.materialId, "materialId");
    const mediaType =
      data.mediaType === undefined
        ? null
        : text(data.mediaType, "mediaType", true, 200);
    let taskId = data.taskId === undefined ? null : id(data.taskId, "taskId");
    if (taskId) this.ledger.getTask(taskId);
    const reportId =
      data.reportId === undefined ? null : id(data.reportId, "reportId");
    if (reportId) {
      const report = this.entity<Report>("report", reportId);
      if (taskId && report.taskId !== taskId)
        fail("INVALID", "Artifact report belongs to a different task");
      taskId = report.taskId;
    }
    const ref = this.contentRef(data.contentRef);
    const bytes =
      data.bytes === undefined ? null : integer(data.bytes, "bytes");
    const sha256 =
      data.sha256 === undefined ? null : text(data.sha256, "sha256", true, 64);
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256))
      fail("INVALID", "sha256 must be a declared lowercase SHA256 digest");
    const provider =
      ref.kind === "native" || ref.kind === "object"
        ? ref.provider
        : ref.kind === "git"
          ? ref.repository
          : null;
    const refId =
      ref.kind === "native"
        ? ref.fileId
        : ref.kind === "object"
          ? ref.objectId
          : ref.kind === "live"
            ? ref.url
            : null;
    const version =
      ref.kind === "native" || ref.kind === "object"
        ? ref.version
        : ref.kind === "git"
          ? ref.commit
          : null;
    this.db
      .prepare(
        "INSERT INTO wb_artifacts(artifact_id,name,material_id,media_type,task_id,report_id,ref_kind,ref_provider,ref_id,ref_version,ref_path,bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        key,
        name,
        materialId,
        mediaType,
        taskId,
        reportId,
        ref.kind,
        provider,
        refId,
        version,
        ref.kind === "git" ? ref.path : null,
        bytes,
        sha256,
        this.ledger.managementNow(),
      );
    return this.getArtifact(key);
  }
  private artifactRelation(data: Data): ArtifactRelation {
    fields(data, [
      "relationId",
      "artifactId",
      "kind",
      "targetId",
      "action",
      "context",
      "runId",
      "attemptId",
    ]);
    const relationId = id(data.relationId ?? randomUUID(), "relationId");
    this.exists("wb_artifact_relations", "relation_id", relationId);
    const artifactId = id(data.artifactId, "artifactId");
    this.need("wb_artifacts", "artifact_id", artifactId);
    const kind = choice(
      data.kind,
      ["project", "task", "report", "skill", "predecessor"],
      "kind",
    );
    const targetId = id(data.targetId, "targetId");
    const context = text(data.context ?? "", "context");
    const action =
      data.action === undefined
        ? null
        : choice(
            data.action,
            [
              "produced",
              "modified",
              "derived",
              "referenced",
              "explained",
              "validated",
              "reflected",
            ],
            "action",
          );
    let sourceTask: string | undefined;
    if (kind === "task") sourceTask = this.ledger.getTask(targetId).taskId;
    else if (kind === "report")
      sourceTask = this.entity<Report>("report", targetId).taskId;
    else if (kind === "project")
      this.need("wb_projects", "project_id", targetId);
    else if (kind === "skill") this.need("wb_skills", "skill_id", targetId);
    else {
      this.need("wb_artifacts", "artifact_id", targetId);
      if (targetId === artifactId)
        fail("INVALID", "Artifact cannot derive from itself");
      if (
        this.one(
          "WITH RECURSIVE ancestors(id) AS (SELECT predecessor_id FROM wb_artifact_relations WHERE artifact_id=? AND predecessor_id IS NOT NULL UNION SELECT r.predecessor_id FROM wb_artifact_relations r JOIN ancestors a ON r.artifact_id=a.id WHERE r.predecessor_id IS NOT NULL) SELECT 1 FROM ancestors WHERE id=?",
          targetId,
          artifactId,
        )
      )
        fail("INVALID", "Artifact predecessor relations must be acyclic");
    }
    if (
      (kind === "task" || kind === "report" || kind === "predecessor") &&
      !action
    )
      fail("INVALID", "Provenance relation requires an action");
    const runId = data.runId === undefined ? null : id(data.runId, "runId");
    const attemptId =
      data.attemptId === undefined ? null : id(data.attemptId, "attemptId");
    if ((runId || attemptId) && !sourceTask)
      fail("INVALID", "Execution provenance requires a task or report source");
    if (runId && this.ledger.getRun(runId).taskId !== sourceTask)
      fail("INVALID", "Run belongs to a different provenance task");
    if (attemptId) {
      const attempt = this.ledger.getAttempt(attemptId);
      if (!runId || attempt.runId !== runId || attempt.taskId !== sourceTask)
        fail("INVALID", "Attempt requires its matching run and task");
    }
    if (kind === "report") {
      const report = this.entity<Report>("report", targetId);
      if (
        (runId && report.runId !== runId) ||
        (attemptId && report.attemptId !== attemptId)
      )
        fail("INVALID", "Execution provenance must match its report");
    }
    this.db
      .prepare(
        "INSERT INTO wb_artifact_relations(relation_id,artifact_id,project_id,task_id,report_id,skill_id,predecessor_id,action,context,run_id,attempt_id,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        relationId,
        artifactId,
        kind === "project" ? targetId : null,
        kind === "task" ? targetId : null,
        kind === "report" ? targetId : null,
        kind === "skill" ? targetId : null,
        kind === "predecessor" ? targetId : null,
        action,
        context,
        runId,
        attemptId,
        this.ledger.managementNow(),
      );
    return this.artifactRelationView(
      this.need("wb_artifact_relations", "relation_id", relationId),
    );
  }
  private checkMilestoneCycles() {
    const edges = new Map<string, string[]>();
    for (const row of this.rows(
      "SELECT milestone_id,criteria FROM wb_milestones",
    )) {
      const targets = (JSON.parse(String(row.criteria)) as Criterion[])
        .filter((c) => c.targetRef?.type === "milestone")
        .map((c) => c.targetRef!.id);
      edges.set(String(row.milestone_id), targets);
    }
    const active = new Set<string>(),
      visited = new Set<string>();
    const visit = (key: string) => {
      if (active.has(key))
        fail("INVALID", "Milestone dependencies must be acyclic");
      if (visited.has(key)) return;
      active.add(key);
      for (const target of edges.get(key) ?? []) visit(target);
      active.delete(key);
      visited.add(key);
    };
    for (const key of edges.keys()) visit(key);
  }
  private owner(ownerType: OwnerType, ownerId: string): Row {
    return this.need(
      `wb_${ownerType === "milestone" ? "milestones" : ownerType === "backlog" ? "backlogs" : "projects"}`,
      `${ownerType}_id`,
      ownerId,
    );
  }
  private checkCriterion(data: Data): CriterionCheck {
    fields(data, [
      "ownerType",
      "ownerId",
      "expectedRevision",
      "criterionId",
      "observedStatus",
      "evidenceRefs",
      "note",
    ]);
    const ownerType = choice(
      data.ownerType,
      ["project", "backlog", "milestone"],
      "ownerType",
    );
    const ownerId = id(data.ownerId, "ownerId");
    const row = this.owner(ownerType, ownerId);
    this.revision(row, data.expectedRevision);
    const criterionId = id(data.criterionId, "criterionId");
    const criterion =
      (JSON.parse(String(row.criteria)) as Criterion[]).find(
        (c) => c.criterionId === criterionId,
      ) ?? fail("NOT_FOUND", "Criterion not found in this content revision");
    if (criterion.kind !== "manual_check")
      fail(
        "INVALID",
        "Machine criteria are observed from their actual evidence, not supplied checks",
      );
    if (!this.options.allowManualChecks)
      fail(
        "FORBIDDEN",
        "Manual checks require the trusted interactive management context",
      );
    const status = choice(
      data.observedStatus,
      ["met", "unmet", "unknown"],
      "observedStatus",
    );
    const note = text(data.note ?? "", "note");
    const refs = data.evidenceRefs ?? [];
    if (!Array.isArray(refs) || refs.length > 64)
      fail("INVALID", "At most 64 evidence references are allowed");
    const evidence = refs.map((raw) => {
      const ref = validateVersionRef(raw);
      this.target(ref);
      return ref;
    });
    if (
      criterion.requiredEvidence.trim() &&
      status === "met" &&
      !evidence.length &&
      !note.trim()
    )
      fail(
        "INVALID",
        "This condition requires evidence or an explicit check note",
      );
    const checkId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO wb_criterion_checks(check_id,project_id,backlog_id,milestone_id,owner_revision,criterion_id,status,note,checked_at,source_role,source_node_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        checkId,
        ownerType === "project" ? ownerId : null,
        ownerType === "backlog" ? ownerId : null,
        ownerType === "milestone" ? ownerId : null,
        Number(row.revision),
        criterionId,
        status,
        note,
        this.ledger.managementNow(),
        this.ledger.role,
        this.ledger.nodeId,
      );
    evidence.forEach((ref, position) =>
      this.db
        .prepare("INSERT INTO wb_check_evidence VALUES(?,?,?,?,?)")
        .run(checkId, position, ref.type, ref.id, ref.revision ?? null),
    );
    return this.checkView(
      this.need("wb_criterion_checks", "check_id", checkId),
    );
  }
  private checkView(row: Row): CriterionCheck {
    const ownerType: OwnerType =
      row.project_id !== null
        ? "project"
        : row.backlog_id !== null
          ? "backlog"
          : "milestone";
    return {
      checkId: String(row.check_id),
      ownerType,
      ownerId: String(row[`${ownerType}_id`]),
      ownerRevision: Number(row.owner_revision),
      criterionId: String(row.criterion_id),
      observedStatus: row.status as CriterionCheck["observedStatus"],
      evidenceRefs: this.rows(
        "SELECT * FROM wb_check_evidence WHERE check_id=? ORDER BY position",
        String(row.check_id),
      ).map((e) => ({
        type: e.ref_type as VersionRef["type"],
        id: String(e.ref_id),
        ...(e.ref_revision === null
          ? {}
          : { revision: Number(e.ref_revision) }),
      })),
      note: String(row.note),
      checkedAt: String(row.checked_at),
      source: {
        kind: "management-check",
        role: String(row.source_role),
        nodeId: String(row.source_node_id),
      },
    };
  }
  private criterionView(
    criterion: Criterion,
    ownerType: OwnerType,
    ownerId: string,
    revision: number,
  ): CriterionView {
    const base: CriterionView = {
      ...criterion,
      observedStatus: "pending",
      evidenceRefs: [],
    };
    if (criterion.kind === "manual_check") {
      const row = this.one(
        `SELECT * FROM wb_criterion_checks WHERE ${ownerType}_id=? AND owner_revision=? AND criterion_id=? ORDER BY rowid DESC LIMIT 1`,
        ownerId,
        revision,
        criterion.criterionId,
      );
      if (!row) return base;
      const check = this.checkView(row);
      return {
        ...base,
        observedStatus: check.observedStatus,
        evidenceRefs: check.evidenceRefs,
        checkedAt: check.checkedAt,
        source: check.source,
      };
    }
    const ref = criterion.targetRef;
    if (!ref) return { ...base, observedStatus: "unknown" };
    if (criterion.kind === "task_completion") {
      let task: Task;
      try {
        task = this.ledger.getTask(ref.id);
      } catch {
        return { ...base, observedStatus: "unknown" };
      }
      if (ref.revision !== (task.intentRevision ?? 1))
        return { ...base, observedStatus: "unknown" };
      return {
        ...base,
        observedStatus:
          task.state === "completed"
            ? "met"
            : ["failed", "cancelled"].includes(task.state)
              ? "unmet"
              : "pending",
        evidenceRefs: [ref],
      };
    }
    // Execution success is not a personal acceptance. No natural-person identity/approval registry is invented here.
    return { ...base, observedStatus: "unknown" };
  }
  private criteriaViews(row: Row, ownerType: OwnerType): CriterionView[] {
    return (JSON.parse(String(row.criteria)) as Criterion[]).map((c) =>
      this.criterionView(
        c,
        ownerType,
        String(row[`${ownerType}_id`]),
        Number(row.revision),
      ),
    );
  }
  private conditionStatus(
    criteria: CriterionView[],
    mode: "all" | "any" = "all",
  ): ConditionStatus {
    if (!criteria.length) return "pending";
    const statuses = criteria.map((c) => c.observedStatus);
    if (mode === "any" && statuses.includes("met")) return "met";
    if (mode === "all" && statuses.every((s) => s === "met")) return "met";
    if (mode === "all" && statuses.includes("unmet")) return "unmet";
    if (statuses.includes("unknown")) return "unknown";
    if (statuses.includes("pending")) return "pending";
    return "unmet";
  }
  getDomain(domainId: string): Domain {
    const row = this.need("wb_domains", "domain_id", domainId);
    return {
      domainId,
      revision: Number(row.revision),
      title: String(row.title),
      summary: String(row.summary),
      state: row.state as Domain["state"],
      position: Number(row.position),
    };
  }
  getProject(projectId: string): Project {
    const row = this.need("wb_projects", "project_id", projectId);
    return {
      projectId,
      revision: Number(row.revision),
      title: String(row.title),
      goal: String(row.goal),
      description: String(row.description),
      state: row.state as Project["state"],
      nextStep: String(row.next_step),
      acceptanceCriteria: this.criteriaViews(row, "project"),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.started_at === null ? {} : { startedAt: String(row.started_at) }),
      ...(row.target_at === null ? {} : { targetAt: String(row.target_at) }),
    };
  }
  getBacklog(backlogId: string): Backlog {
    const row = this.need("wb_backlogs", "backlog_id", backlogId);
    const acceptanceCriteria = this.criteriaViews(row, "backlog");
    const conditionStatus = this.conditionStatus(acceptanceCriteria);
    return {
      backlogId,
      revision: Number(row.revision),
      projectId: String(row.project_id),
      title: String(row.title),
      goal: String(row.goal),
      state:
        row.state === "open" && conditionStatus === "met"
          ? "completed"
          : (row.state as Backlog["state"]),
      priority: row.priority as Priority,
      acceptanceCriteria,
      conditionStatus,
      ...(row.target_at === null ? {} : { targetAt: String(row.target_at) }),
    };
  }
  getSkill(skillId: string): Skill {
    const row = this.need("wb_skills", "skill_id", skillId);
    return {
      skillId,
      revision: Number(row.revision),
      title: String(row.title),
      summary: String(row.summary),
      abilityStatement: String(row.ability_statement),
      practiceNotes: String(row.practice_notes),
      methodNotes: String(row.method_notes),
      limitations: String(row.limitations),
      state: row.state as Skill["state"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  getMilestone(milestoneId: string): Milestone {
    const row = this.need("wb_milestones", "milestone_id", milestoneId);
    const conditions = this.criteriaViews(row, "milestone");
    const completionMode = row.completion_mode as "all" | "any";
    const conditionStatus = this.conditionStatus(conditions, completionMode);
    return {
      milestoneId,
      revision: Number(row.revision),
      projectId: String(row.project_id),
      title: String(row.title),
      goal: String(row.goal),
      state:
        row.state === "active" && conditionStatus === "met"
          ? "awaiting_review"
          : (row.state as Milestone["state"]),
      conditions,
      completionMode,
      conditionStatus,
      ...(row.target_at === null ? {} : { targetAt: String(row.target_at) }),
    };
  }
  getArtifact(artifactId: string): RegisteredArtifact {
    const row = this.need("wb_artifacts", "artifact_id", artifactId);
    let contentRef: ContentRef;
    if (row.ref_kind === "native")
      contentRef = {
        kind: "native",
        provider: String(row.ref_provider),
        fileId: String(row.ref_id),
        version: String(row.ref_version),
      };
    else if (row.ref_kind === "object")
      contentRef = {
        kind: "object",
        provider: String(row.ref_provider),
        objectId: String(row.ref_id),
        version: String(row.ref_version),
      };
    else if (row.ref_kind === "git")
      contentRef = {
        kind: "git",
        repository: String(row.ref_provider),
        commit: String(row.ref_version),
        path: String(row.ref_path),
      };
    else contentRef = { kind: "live", url: String(row.ref_id) };
    return {
      artifactId,
      name: String(row.name),
      contentRef,
      availability: "unknown",
      versionStatus: contentRef.kind === "live" ? "live" : "pinned",
      createdAt: String(row.created_at),
      ...(row.material_id === null
        ? {}
        : { materialId: String(row.material_id) }),
      ...(row.media_type === null ? {} : { mediaType: String(row.media_type) }),
      ...(row.task_id === null ? {} : { taskId: String(row.task_id) }),
      ...(row.report_id === null ? {} : { reportId: String(row.report_id) }),
      ...(row.bytes === null ? {} : { bytes: Number(row.bytes) }),
      ...(row.sha256 === null ? {} : { sha256: String(row.sha256) }),
    };
  }
  private artifactRelationView(row: Row): ArtifactRelation {
    const kind = (
      ["project", "task", "report", "skill", "predecessor"] as const
    ).find((type) => row[`${type}_id`] !== null)!;
    return {
      relationId: String(row.relation_id),
      artifactId: String(row.artifact_id),
      kind,
      targetId: String(row[`${kind}_id`]),
      context: String(row.context),
      recordedAt: String(row.recorded_at),
      ...(row.action === null
        ? {}
        : { action: row.action as ArtifactRelation["action"] }),
      ...(row.run_id === null ? {} : { runId: String(row.run_id) }),
      ...(row.attempt_id === null ? {} : { attemptId: String(row.attempt_id) }),
    };
  }
  snapshot(): WorkbenchSnapshot {
    const result: WorkbenchSnapshot = {
      schemaVersion: "1",
      generatedAt: this.ledger.managementNow(),
      domains: [],
      projects: [],
      backlogs: [],
      skills: [],
      milestones: [],
      domainProjects: [],
      backlogTasks: [],
      projectWorkspaces: [],
      milestoneBacklogs: [],
      milestoneTasks: [],
      skillProjects: [],
      skillReports: [],
      artifacts: [],
      artifactRelations: [],
      criterionChecks: [],
    };
    if (!this.ready()) return result;
    const version = this.one("SELECT version FROM wb_schema");
    if (version?.version !== 1) fail("SCHEMA", "Unsupported workbench schema");
    result.domains = this.rows(
      "SELECT domain_id FROM wb_domains ORDER BY position,domain_id",
    ).map((row) => this.getDomain(String(row.domain_id)));
    result.projects = this.rows(
      "SELECT project_id FROM wb_projects ORDER BY project_id",
    ).map((row) => this.getProject(String(row.project_id)));
    result.backlogs = this.rows(
      "SELECT backlog_id FROM wb_backlogs ORDER BY backlog_id",
    ).map((row) => this.getBacklog(String(row.backlog_id)));
    result.skills = this.rows(
      "SELECT skill_id FROM wb_skills ORDER BY skill_id",
    ).map((row) => this.getSkill(String(row.skill_id)));
    result.milestones = this.rows(
      "SELECT milestone_id FROM wb_milestones ORDER BY milestone_id",
    ).map((row) => this.getMilestone(String(row.milestone_id)));
    result.domainProjects = this.rows(
      "SELECT * FROM wb_domain_projects ORDER BY domain_id,project_id",
    ).map((row) => ({
      domainId: String(row.domain_id),
      projectId: String(row.project_id),
    }));
    result.backlogTasks = this.rows(
      "SELECT * FROM wb_backlog_tasks ORDER BY backlog_id,task_id",
    ).map((row) => ({
      backlogId: String(row.backlog_id),
      taskId: String(row.task_id),
    }));
    result.projectWorkspaces = this.rows(
      "SELECT * FROM wb_project_workspaces ORDER BY project_id,workspace_id",
    ).map((row) => ({
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      nodeId: String(row.node_id),
      isDefault: row.is_default === 1,
      revision: Number(row.revision),
    }));
    result.milestoneBacklogs = this.rows(
      "SELECT * FROM wb_milestone_backlogs ORDER BY milestone_id,backlog_id",
    ).map((row) => ({
      milestoneId: String(row.milestone_id),
      backlogId: String(row.backlog_id),
    }));
    result.milestoneTasks = this.rows(
      "SELECT * FROM wb_milestone_tasks ORDER BY milestone_id,task_id",
    ).map((row) => ({
      milestoneId: String(row.milestone_id),
      taskId: String(row.task_id),
    }));
    result.skillProjects = this.rows(
      "SELECT * FROM wb_skill_projects ORDER BY skill_id,project_id",
    ).map((row) => ({
      skillId: String(row.skill_id),
      projectId: String(row.project_id),
      context: String(row.context),
    }));
    result.skillReports = this.rows(
      "SELECT * FROM wb_skill_reports ORDER BY skill_id,report_id",
    ).map((row) => ({
      skillId: String(row.skill_id),
      reportId: String(row.report_id),
      context: String(row.context),
    }));
    result.artifacts = this.rows(
      "SELECT artifact_id FROM wb_artifacts ORDER BY artifact_id",
    ).map((row) => this.getArtifact(String(row.artifact_id)));
    result.artifactRelations = this.rows(
      "SELECT * FROM wb_artifact_relations ORDER BY rowid",
    ).map((row) => this.artifactRelationView(row));
    result.criterionChecks = this.rows(
      "SELECT * FROM wb_criterion_checks ORDER BY rowid",
    ).map((row) => this.checkView(row));
    return result;
  }
}
