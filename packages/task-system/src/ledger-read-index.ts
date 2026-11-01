import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonical, TaskError } from "./ledger.js";
import type { Task, Run, Report, Attempt, Schedule, Delivery, DispatchOrigin, Event } from "./contracts.js";
import type { SessionMessage } from "./remote/ports.js";
import type { CheckinRecord, ResponsibilityReceipt } from "./task-checkins.js";

const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const millis = (value: string | undefined): number | null => {
  const at = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const compactOrigin = (origin: DispatchOrigin | undefined): DispatchOrigin | undefined => {
  if (!origin || origin.kind === "system") return origin ? {kind:origin.kind,nodeId:origin.nodeId} : undefined;
  return {kind:origin.kind,nodeId:origin.nodeId,sessionId:origin.sessionId,cwd:origin.cwd,parentLease:origin.parentLease,
    ...(origin.composition ? {composition:{provider:origin.composition.provider,model:origin.composition.model,
      reasoningEffort:origin.composition.reasoningEffort,preset:origin.composition.preset}} : {})};
};
export type CompactTask = Omit<Task, "description" | "goal" | "acceptanceCriteria" | "checkin"> & {detailComponentDigest:string};
export type CompactRun = Omit<Run, "configuration" | "intentSnapshot" | "contextNotes" | "projectContext" | "sessionIds" | "workflowScript" | "resultSummary" | "retryPolicy"> & {
  actionComponentDigest: string;
  detailComponentDigest: string;
  hasProjectContext: boolean;
  hasResultValidationFailure: boolean;
  automaticResultRetryCount: number;
  workflow: boolean;
  workflowInvocation: boolean;
  projectId: string | null;
  projectTitle: string | null;
  resultSummaryPreview: string;
};
export type CompactReport = Omit<Report, "body" | "data" | "workflowOutputs" | "artifactIds"> & {
  contentVersion: string;
  bodyPreview: string;
  supplemental: boolean;
  hasHtmlPresentation: boolean;
};
export type CompactMessage = Omit<SessionMessage, "text">;
export type CompactAttempt = Omit<Attempt, "retryEvidence">;
export type FactMap = {
  task: CompactTask; run: CompactRun; report: CompactReport; attempt: CompactAttempt;
  sessionMessage: CompactMessage; taskCheckin: CheckinRecord; taskResponsibility: ResponsibilityReceipt;
  "task-attention": {fingerprint: string; handled: boolean};
  schedule: Omit<Schedule, "input">; delivery: Omit<Delivery, "payload">;
  workspace: {workspaceId: string; nodeId: string; path: string; state: string};
  event: Pick<Event, "eventId" | "taskId" | "runId" | "type" | "at"> & {summary?: string};
};
export type FactKind = keyof FactMap;
export type IndexedFact<T> = T & {sourceSeq:number};
const factKinds = ["task", "run", "report", "attempt", "sessionMessage", "taskCheckin", "taskResponsibility", "task-attention", "schedule", "delivery", "workspace"] as const;
const kindsSql = factKinds.map(kind => `'${kind}'`).join(",");
export const reportContentVersion = (report: Report): string => {
  const data = report.data;
  const presentation = data && typeof data === "object" && !Array.isArray(data) ? data.presentation : undefined;
  const html = presentation && typeof presentation === "object" && !Array.isArray(presentation) &&
    presentation.mediaType === "text/html" && typeof presentation.body === "string" && presentation.body.length <= 2_000_000
    ? {mediaType: "text/html", body: presentation.body} : null;
  return digest({title: report.title, body: report.body, revision: report.revision, artifactIds: report.artifactIds, ...(html ? {presentation: html} : {})});
};

/** Rebuildable metadata in the authority database. No business command reads its payload here. */
export class DemandReadIndex {
  private reconciling = false;
  private projector: ((taskId: string) => void) | undefined;
  constructor(private readonly db: DatabaseSync, private readonly now: () => number, private readonly readOnly = false) {
    if (readOnly) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS demand_read_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO demand_read_meta VALUES(1,1,0);
      CREATE TABLE IF NOT EXISTS demand_change_retention(id INTEGER PRIMARY KEY CHECK(id=1),floor INTEGER NOT NULL);
      INSERT OR IGNORE INTO demand_change_retention VALUES(1,-1);
      CREATE TABLE IF NOT EXISTS demand_fact_changes(kind TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS demand_fact_change_revision ON demand_fact_changes(generation,kind,id);
      CREATE TABLE IF NOT EXISTS demand_source_dirty(kind TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS demand_task_dirty(task_id TEXT PRIMARY KEY,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS demand_checkin_candidates(task_id TEXT PRIMARY KEY,wake_at REAL);
      CREATE INDEX IF NOT EXISTS demand_checkin_wake ON demand_checkin_candidates(wake_at,task_id);
      CREATE TABLE IF NOT EXISTS demand_entity_facts(kind TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,parent TEXT,state TEXT,task_id TEXT,run_id TEXT,node_id TEXT,due_at REAL,lease_at REAL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS demand_fact_parent ON demand_entity_facts(kind,parent,seq);
      CREATE INDEX IF NOT EXISTS demand_fact_task ON demand_entity_facts(kind,task_id,seq);
      CREATE INDEX IF NOT EXISTS demand_fact_run ON demand_entity_facts(kind,run_id,seq);
      CREATE INDEX IF NOT EXISTS demand_fact_due ON demand_entity_facts(kind,state,due_at,id);
      CREATE INDEX IF NOT EXISTS demand_fact_lease ON demand_entity_facts(kind,state,lease_at,id);
      CREATE INDEX IF NOT EXISTS demand_fact_node ON demand_entity_facts(kind,node_id,state,seq);
`);
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const row = operation === "DELETE" ? "OLD" : "NEW";
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS demand_entity_${operation.toLowerCase()} AFTER ${operation} ON entities
        WHEN ${row}.kind IN (${kindsSql}) BEGIN
          UPDATE demand_read_meta SET revision=revision+1 WHERE id=1;
          INSERT INTO demand_source_dirty(kind,id,generation) VALUES(${row}.kind,${row}.id,(SELECT revision FROM demand_read_meta WHERE id=1))
            ON CONFLICT(kind,id) DO UPDATE SET generation=excluded.generation;
        END;`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS demand_event_${operation.toLowerCase()} AFTER ${operation} ON events BEGIN
          UPDATE demand_read_meta SET revision=revision+1 WHERE id=1;
          INSERT INTO demand_source_dirty(kind,id,generation) VALUES('event',${row}.id,(SELECT revision FROM demand_read_meta WHERE id=1))
            ON CONFLICT(kind,id) DO UPDATE SET generation=excluded.generation;
        END;`);
    }
    for (const operation of ["INSERT","UPDATE","DELETE"] as const) {
      const row=operation==='DELETE'?'OLD':'NEW';
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS demand_context_${operation} AFTER ${operation} ON run_context_sessions BEGIN
        UPDATE demand_read_meta SET revision=revision+1 WHERE id=1;
        INSERT INTO demand_fact_changes VALUES('session',${row}.run_id,(SELECT revision FROM demand_read_meta WHERE id=1)) ON CONFLICT(kind,id) DO UPDATE SET generation=excluded.generation;
      END;`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS demand_executor_alert_${operation} AFTER ${operation} ON executor_alert_dispositions BEGIN
        UPDATE demand_read_meta SET revision=revision+1 WHERE id=1;
        INSERT INTO demand_fact_changes VALUES('executor-alert',${row}.record,(SELECT revision FROM demand_read_meta WHERE id=1)) ON CONFLICT(kind,id) DO UPDATE SET generation=excluded.generation;
      END;`);
    }
    this.db.exec(`INSERT OR IGNORE INTO demand_source_dirty(kind,id,generation)
      SELECT kind,id,0 FROM entities WHERE kind IN (${kindsSql}) AND NOT EXISTS (SELECT 1 FROM ledger_index_migrations WHERE name='demand-facts-v1');
      INSERT OR IGNORE INTO demand_source_dirty(kind,id,generation)
      SELECT 'event',id,0 FROM events WHERE NOT EXISTS (SELECT 1 FROM ledger_index_migrations WHERE name='demand-facts-v1');
      INSERT OR IGNORE INTO ledger_index_migrations(name) VALUES('demand-facts-v1');`);
    this.reconcileFacts(Number.MAX_SAFE_INTEGER);
  }
  bindProjector(projector: (taskId: string) => void) {
    this.projector = projector;
  }
  get revision(): string {
    return String(this.db.prepare("SELECT revision FROM demand_read_meta WHERE id=1").get()?.revision ?? 0);
  }
  invalidate(taskId: string) {
    this.db.prepare("INSERT INTO demand_task_dirty VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET generation=excluded.generation")
      .run(taskId, Number(this.revision));
    this.db.prepare("INSERT INTO demand_checkin_candidates VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET wake_at=excluded.wake_at").run(taskId,this.now());
  }
  facts<K extends FactKind>(kind: K, parent?: string): IndexedFact<FactMap[K]>[] {
    this.ensureFacts();
    const rows = parent === undefined
      ? this.db.prepare("SELECT data FROM demand_entity_facts WHERE kind=? ORDER BY seq").all(kind)
      : this.db.prepare("SELECT data FROM demand_entity_facts WHERE kind=? AND parent=? ORDER BY seq").all(kind, parent);
    return rows.map(row => JSON.parse(String(row.data)));
  }
  fact<K extends FactKind>(kind: K, id: string): IndexedFact<FactMap[K]> | undefined {
    this.ensureFacts();
    const row = this.db.prepare("SELECT data FROM demand_entity_facts WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  taskIds(root: string): string[] {
    this.ensureFacts();
    return this.db.prepare(`WITH RECURSIVE descendants(id) AS (SELECT ? UNION SELECT f.id FROM demand_entity_facts f JOIN descendants d ON f.parent=d.id WHERE f.kind='task') SELECT id FROM descendants ORDER BY id`)
      .all(root).map(row => String(row.id));
  }
  runScope(taskId: string): CompactRun[] {
    this.ensureFacts();
    return this.db.prepare(`WITH RECURSIVE tasks(id) AS (SELECT ? UNION SELECT f.id FROM demand_entity_facts f JOIN tasks t ON f.parent=t.id WHERE f.kind='task'),
      runs(id) AS (SELECT f.id FROM demand_entity_facts f JOIN tasks t ON f.task_id=t.id WHERE f.kind='run' AND COALESCE(json_extract(f.data,'$.historyOnly'),0)=0 AND COALESCE(json_extract(f.data,'$.observationOnly'),0)=0
        UNION SELECT f.id FROM demand_entity_facts f JOIN runs r ON json_extract(f.data,'$.parentRunId')=r.id WHERE f.kind='run' AND COALESCE(json_extract(f.data,'$.historyOnly'),0)=0 AND COALESCE(json_extract(f.data,'$.observationOnly'),0)=0)
      SELECT f.data FROM demand_entity_facts f JOIN runs r ON f.id=r.id WHERE f.kind='run' ORDER BY f.seq`)
      .all(taskId).map(row => JSON.parse(String(row.data)));
  }
  acknowledgeChanges(revision:number) {if(!this.readOnly){
    this.db.prepare("UPDATE demand_change_retention SET floor=MAX(floor,?) WHERE id=1").run(revision);
    this.db.prepare("DELETE FROM demand_fact_changes WHERE generation<=?").run(revision);
  }}
  changesSince(revision: number): {kind:string;id:string;generation:number}[] {
    this.ensureFacts();
    const floor=Number(this.db.prepare("SELECT floor FROM demand_change_retention WHERE id=1").get()?.floor??-1);
    if(revision<floor)return [{kind:'rebuild',id:'',generation:floor}];
    return this.db.prepare("SELECT kind,id,generation FROM demand_fact_changes WHERE generation>? ORDER BY generation,kind,id")
      .all(revision).map(row=>({kind:String(row.kind),id:String(row.id),generation:Number(row.generation)}));
  }
  snapshotFacts() {
    return {tasks:this.facts("task"),runs:this.facts("run"),reports:this.facts("report"),attempts:this.facts("attempt"),
      messages:this.facts("sessionMessage"),schedules:this.facts("schedule"),deliveries:this.facts("delivery"),events:this.facts("event"),workspaces:this.facts("workspace")};
  }
  private compact(kind: FactKind, value: unknown): unknown {
    if (kind === "task") {
      const task = value as Task;
      return {taskId:task.taskId,title:task.title,state:task.state,kind:task.kind,createdAt:task.createdAt,updatedAt:task.updatedAt,
        revision:task.revision,intentRevision:task.intentRevision,priorityOverride:task.priorityOverride,priority:task.priority,
        manualCompletion:task.manualCompletion,targetAt:task.targetAt,delegationDisplay:task.delegationDisplay,
        parentTaskId:task.parentTaskId,parentRunId:task.parentRunId,workspaceId:task.workspaceId,tags:task.tags,
        admissionState:task.admissionState,admissionRevision:task.admissionRevision,
        policy:task.policy ? {maxResultRetries:task.policy.maxResultRetries,maxSafeRetries:task.policy.maxSafeRetries} : undefined,
        userImmediacy:task.userImmediacy,importance:task.importance,urgency:task.urgency,confirmation:task.confirmation,
        dispatchOrigin:compactOrigin(task.dispatchOrigin),detailComponentDigest:digest({description:task.description,goal:task.goal??null,criteria:task.acceptanceCriteria??[]})} satisfies CompactTask;
    }
    if (kind === "run") {
      const run = value as Run;
      const configuration = run.configuration;
      const workflow = !!configuration && typeof configuration === "object" && !Array.isArray(configuration) && !!configuration.workflow;
      const issue = run.state === "queued" && !run.route?.workspaceId && !run.projectContext && run.route && !run.historyOnly && !run.observationOnly
        ? {kind:"needs_action",code:"TEMPORARY_CONTEXT_REQUIRED",message:"Repair this unclaimed request to attach its temporary task context.",action:"repair_context"} as const : undefined;
      const dispatchIssue = issue ? {...issue,revision:digest(issue)} : run.dispatchIssue;
      const component = [run.runId,run.state,run.reviewStatus ?? null,!!run.cancellationRequested,run.currentAttemptId ?? null,
        dispatchIssue?.revision ?? null,run.route ?? null,run.executionModel ?? null,run.projectContext ?? null];
      return {runId:run.runId,taskId:run.taskId,parentRunId:run.parentRunId,state:run.state,createdAt:run.createdAt,updatedAt:run.updatedAt,
        executionExpectation:run.executionExpectation,coordinatorSession:run.coordinatorSession,
        dispatchOrigin:compactOrigin(run.dispatchOrigin),dispatchIssue,executionModel:run.executionModel,
        executionParentKind:run.executionParentKind,executionParentRunId:run.executionParentRunId,
        projectSettingsRevision:run.projectSettingsRevision,projectExecutionBinding:run.projectExecutionBinding,
        outcome:run.outcome,reviewStatus:run.reviewStatus,validation:run.validation,route:run.route,workspaceConstraint:run.workspaceConstraint,
        occurrenceId:run.occurrenceId,currentAttemptId:run.currentAttemptId,cancellationRequested:run.cancellationRequested,
        historyOnly:run.historyOnly,observationOnly:run.observationOnly,executionStartedAt:run.executionStartedAt,
        ...(run.retry ? {retry:{count:run.retry.count,notBefore:run.retry.notBefore,sessionId:run.retry.sessionId,
          previousAttemptId:run.retry.previousAttemptId,reasonCode:run.retry.reasonCode}} : {}),
        actionComponentDigest:digest(component),detailComponentDigest:digest({intent:run.intentSnapshot??null,project:run.projectContext??null,notes:run.contextNotes??[]}),hasProjectContext:!!run.projectContext,workflow,
        workflowInvocation:!!configuration && typeof configuration==='object' && !Array.isArray(configuration) && !!configuration.workflowInvocation,
        hasResultValidationFailure:!!run.resultValidationFailure,
        automaticResultRetryCount:configuration && typeof configuration==='object' && !Array.isArray(configuration) &&
          configuration.taskRetry && typeof configuration.taskRetry==='object' && !Array.isArray(configuration.taskRetry) &&
          configuration.taskRetry.automatic===true && typeof configuration.taskRetry.count==='number' ? configuration.taskRetry.count : 0,
        projectId:run.projectContext?.project?.projectId ?? null,projectTitle:run.projectContext?.project?.title ?? null,
        resultSummaryPreview:run.resultSummary?.slice(0,2000) ?? ""} satisfies CompactRun;
    }
    if (kind === "report") {
      const report = value as Report;
      const small = {reportId:report.reportId,taskId:report.taskId,runId:report.runId,attemptId:report.attemptId,sessionId:report.sessionId,
        revision:report.revision,previousReportId:report.previousReportId,title:report.title,schemaId:report.schemaId,
        createdAt:report.createdAt,recordedAt:report.recordedAt,kind:report.kind};
      const data = report.data;
      const presentation = data && typeof data === "object" && !Array.isArray(data) ? data.presentation : undefined;
      return {...small, contentVersion:reportContentVersion(report), bodyPreview:report.body.slice(0,300), supplemental: !!data && typeof data === "object" && !Array.isArray(data) && data.supplemental === true,
        hasHtmlPresentation: !!presentation && typeof presentation === "object" && !Array.isArray(presentation) && presentation.mediaType === "text/html" && typeof presentation.body === "string" && presentation.body.length <= 2_000_000} satisfies CompactReport;
    }
    if (kind === "attempt") {
      const a = value as Attempt;
      return {attemptId:a.attemptId,taskId:a.taskId,runId:a.runId,nodeId:a.nodeId,fence:a.fence,leaseExpiresAt:a.leaseExpiresAt,state:a.state,
        createdAt:a.createdAt,updatedAt:a.updatedAt,sessionId:a.sessionId,executionId:a.executionId,progressRequest:a.progressRequest};
    }
    if (kind === "sessionMessage") {
      const m = value as SessionMessage;
      return {messageId:m.messageId,taskId:m.taskId,nodeId:m.nodeId,sessionId:m.sessionId,workspaceId:m.workspaceId,
        createdAt:m.createdAt,updatedAt:m.updatedAt,state:m.state,withdrawn:m.withdrawn,deliveryAttempts:m.deliveryAttempts,
        consecutiveDeliveryFailures:m.consecutiveDeliveryFailures,deliveryFailure:m.deliveryFailure,lastDeliveryError:m.lastDeliveryError,
        lastAttemptAt:m.lastAttemptAt,nextAttemptAt:m.nextAttemptAt,supplementFor:m.supplementFor,reply:m.reply?.slice(0,2000),
        ...(m.completion ? {completion:{eventId:m.completion.eventId,runId:m.completion.runId,origin:compactOrigin(m.completion.origin)}} : {}),
        ...(m.checkIn ? {checkIn:{...m.checkIn,origin:compactOrigin(m.checkIn.origin)}} : {})};
    }
    if (kind === "schedule") {
      const a = value as Schedule;
      return {scheduleId:a.scheduleId,taskId:a.taskId,templateId:a.templateId,templateVersion:a.templateVersion,enabled:a.enabled,
        intervalMs:a.intervalMs,cron:a.cron,timeZone:a.timeZone,nextDueAt:a.nextDueAt,overlap:a.overlap,misfire:a.misfire,
        revision:a.revision,retiredAt:a.retiredAt,calendarWindow:a.calendarWindow,route:a.route,execution:a.execution,executionModel:a.executionModel};
    }
    if (kind === "delivery") {
      const a = value as Delivery;
      return {deliveryId:a.deliveryId,taskId:a.taskId,runId:a.runId,reportId:a.reportId,destination:a.destination,kind:a.kind,
        state:a.state,attempts:a.attempts,nextAttemptAt:a.nextAttemptAt,claimToken:a.claimToken,leaseExpiresAt:a.leaseExpiresAt};
    }
    if (kind === "event") {
      const event = value as Event;
      const detail = event.detail;
      return {eventId:event.eventId, taskId:event.taskId, runId:event.runId, type:event.type, at:event.at,
        ...(event.type === "run.settled" && detail && typeof detail === "object" && !Array.isArray(detail) && typeof detail.summary === "string" ? {summary:detail.summary.slice(0,2000)} : {})};
    }
    return value;
  }
  reconcileFacts(budget = 256): boolean {
    if (this.reconciling) return true;
    if (this.readOnly) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='demand_source_dirty'").get())
        throw new TaskError("MIGRATION_REQUIRED", "Open this ledger writable once to prepare demand reads");
      if (this.db.prepare("SELECT 1 FROM demand_source_dirty LIMIT 1").get())
        throw new TaskError("READ_MODEL_UPDATING", "The writable ledger must reconcile changed task metadata before this read");
      return true;
    }
    if (!this.db.prepare("SELECT 1 FROM demand_source_dirty LIMIT 1").get()) return true;
    this.reconciling = true;
    const ownTransaction = !this.db.isTransaction;
    try {
      if (ownTransaction) this.db.exec("BEGIN IMMEDIATE");
      const dirty = this.db.prepare("SELECT kind,id,generation FROM demand_source_dirty ORDER BY generation,kind,id LIMIT ?").all(budget);
      const affected = new Set<string>();
      for (const row of dirty) {
        const kind = String(row.kind) as FactKind, id = String(row.id);
        const old = this.db.prepare("SELECT task_id,run_id,data FROM demand_entity_facts WHERE kind=? AND id=?").get(kind,id);
        if (old?.task_id) affected.add(String(old.task_id));
        const source = kind === "event"
          ? this.db.prepare("SELECT seq,data FROM events WHERE id=?").get(id)
          : this.db.prepare("SELECT rowid AS seq,data FROM entities WHERE kind=? AND id=?").get(kind,id);
        if (!source) {
          this.db.prepare("DELETE FROM demand_entity_facts WHERE kind=? AND id=?").run(kind,id);
        } else {
          const raw = JSON.parse(String(source.data));
          const small = {...this.compact(kind,raw) as object,sourceSeq:Number(source.seq)};
          const task = kind === "task-attention" || kind === "taskResponsibility" ? id : raw.taskId ?? null;
          const run = kind === "run" ? raw.runId : raw.runId ?? null;
          const parent = kind === "task" ? raw.parentTaskId ?? null : kind === "attempt" ? raw.runId : raw.taskId ?? null;
          const node = kind==='run' || kind==='schedule' ? raw.route?.nodeId ?? null : raw.nodeId ?? raw.dispatchOrigin?.nodeId ?? null;
          const due = kind === "taskCheckin" ? raw.requested ? this.now() : raw.plan?.kind === "scheduled" ? millis(raw.plan.nextCheckAt) : null
            : kind === "run" ? raw.executionExpectation?.phase === "started" ? Date.parse(raw.executionExpectation.startedAt) + raw.executionExpectation.expectedExecutionMs : millis(raw.retry?.notBefore)
            : millis(raw.nextDueAt ?? raw.nextAttemptAt);
          this.db.prepare(`INSERT INTO demand_entity_facts VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET
            seq=excluded.seq,parent=excluded.parent,state=excluded.state,task_id=excluded.task_id,run_id=excluded.run_id,node_id=excluded.node_id,due_at=excluded.due_at,lease_at=excluded.lease_at,data=excluded.data`)
            .run(kind,id,Number(source.seq),parent,raw.state ?? null,task,run,node,due,millis(raw.leaseExpiresAt),canonical(small));
          if (task) affected.add(String(task));
          if (kind === "sessionMessage") {
            for (const ref of raw.checkIn?.tasks ?? []) affected.add(String(ref.taskId));
            for (const taskRow of this.db.prepare(`SELECT id FROM demand_entity_facts WHERE kind='task' AND json_extract(data,'$.dispatchOrigin.nodeId')=? AND json_extract(data,'$.dispatchOrigin.sessionId')=?`).all(raw.nodeId,raw.sessionId)) affected.add(String(taskRow.id));
          }
        }
        if (old) {
          const previous = JSON.parse(String(old.data));
          if (kind === "task" && previous.parentTaskId) affected.add(previous.parentTaskId);
          if (kind === "run" && previous.parentRunId) {
            const parent = this.db.prepare("SELECT task_id FROM demand_entity_facts WHERE kind='run' AND id=?").get(previous.parentRunId);
            if (parent?.task_id) affected.add(String(parent.task_id));
          }
          if (kind === "sessionMessage") {
            for (const ref of previous.checkIn?.tasks ?? []) affected.add(String(ref.taskId));
            for (const taskRow of this.db.prepare(`SELECT id FROM demand_entity_facts WHERE kind='task' AND json_extract(data,'$.dispatchOrigin.nodeId')=? AND json_extract(data,'$.dispatchOrigin.sessionId')=?`).all(previous.nodeId,previous.sessionId)) affected.add(String(taskRow.id));
          }
        }
        this.db.prepare("INSERT INTO demand_fact_changes VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET generation=excluded.generation").run(kind,id,Number(row.generation));
        this.db.prepare("DELETE FROM demand_source_dirty WHERE kind=? AND id=? AND generation=?").run(kind,id,Number(row.generation));
      }
      for (const task of [...affected]) {
        for (const descendant of this.db.prepare(`WITH RECURSIVE descendants(id) AS (SELECT ? UNION SELECT f.id FROM demand_entity_facts f JOIN descendants d ON f.parent=d.id WHERE f.kind='task') SELECT id FROM descendants`).all(task)) this.invalidate(String(descendant.id));
        const ancestors = this.db.prepare(`WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT f.parent FROM demand_entity_facts f JOIN ancestors a ON f.id=a.id WHERE f.kind='task' AND f.parent IS NOT NULL) SELECT id FROM ancestors`).all(task);
        for (const ancestor of ancestors) this.invalidate(String(ancestor.id));
        const runOwners = this.db.prepare(`WITH RECURSIVE parents(id) AS (SELECT json_extract(data,'$.parentRunId') FROM demand_entity_facts WHERE kind='run' AND task_id=? UNION SELECT json_extract(f.data,'$.parentRunId') FROM demand_entity_facts f JOIN parents p ON f.id=p.id WHERE f.kind='run') SELECT DISTINCT task_id FROM demand_entity_facts WHERE kind='run' AND id IN (SELECT id FROM parents)`).all(task);
        for (const owner of runOwners) if (owner.task_id) {
          this.invalidate(String(owner.task_id));
          for (const ancestor of this.db.prepare(`WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT f.parent FROM demand_entity_facts f JOIN ancestors a ON f.id=a.id WHERE f.kind='task' AND f.parent IS NOT NULL) SELECT id FROM ancestors`).all(String(owner.task_id))) this.invalidate(String(ancestor.id));
        }
      }
      const complete = !this.db.prepare("SELECT 1 FROM demand_source_dirty LIMIT 1").get();
      if (ownTransaction) this.db.exec("COMMIT");
      return complete;
    } catch (error) {
      if (ownTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    } finally { this.reconciling = false; }
  }
  ensureFacts() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='demand_entity_facts'").get())
      throw new TaskError("MIGRATION_REQUIRED", "Open this ledger writable once to prepare demand reads");
    if (!this.reconcileFacts()) throw new TaskError("READ_MODEL_UPDATING", "Task read metadata is updating; retry shortly");
  }
  withFacts<T>(read:()=>T):T {
    const ownTransaction=!this.db.isTransaction;
    if(ownTransaction)this.db.exec(this.readOnly?"BEGIN":"BEGIN IMMEDIATE");
    try {
      if(!this.reconcileFacts()) {
        if(ownTransaction)this.db.exec("COMMIT");
        throw new TaskError("READ_MODEL_UPDATING","Task metadata is updating; retry shortly");
      }
      const result=read();
      if(ownTransaction)this.db.exec("COMMIT");
      return result;
    } catch(error) {if(ownTransaction&&this.db.isTransaction)this.db.exec("ROLLBACK");throw error;}
  }
  withCurrent<T>(read: () => T): T {
    const ownTransaction = !this.db.isTransaction;
    if (ownTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const sourceComplete = this.reconcileFacts();
      const dirty = sourceComplete ? this.db.prepare("SELECT task_id,generation FROM demand_task_dirty ORDER BY generation,task_id LIMIT 128").all() : [];
      if (this.projector) for (const row of dirty) {
        this.projector(String(row.task_id));
        this.db.prepare("DELETE FROM demand_task_dirty WHERE task_id=? AND generation=?").run(String(row.task_id),Number(row.generation));
      }
      const incomplete = !sourceComplete || !!this.db.prepare("SELECT 1 FROM demand_task_dirty LIMIT 1").get();
      if (incomplete) {
        if (ownTransaction) this.db.exec("COMMIT");
        throw new TaskError("READ_MODEL_UPDATING", "Task display is updating; retry shortly");
      }
      const result = read();
      if (ownTransaction) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (ownTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
