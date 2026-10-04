import {
  canonical as wireCanonical,
  canonicalData,
  canonicalSchema,
} from "./remote/protocol.js";
import { NATIVE_PROVIDER_UNAVAILABLE_SUMMARY } from "./contracts.js";
import { validateCriteria } from "./workbench-contracts.js";
import type { Criterion, VersionRef } from "./workbench-contracts.js";
import type { ObservationCandidate, CapturedText } from "./observation.js";
import { Ajv } from "ajv";
import { CronExpressionParser } from "cron-parser";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  statSync,
  openSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
  Artifact,
  Alert,
  ApprovalRequest,
  Attempt,
  Claim,
  Delivery,
  Event,
  ExecutionRoute,
  ExecutionContext,
  TaskPriority,
  Json,
  LeaseRef,
  NodeCapability,
  NodeStatus,
  Outcome,
  Receipt,
  Report,
  Role,
  Run,
  Schedule,
  SafeRetryWitness,
  Settlement,
  Snapshot,
  Source,
  Task,
  TaskPolicy,
  Template,
  Workspace,
} from "./contracts.js";

export class TaskError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}
const fail = (code: string, message: string): never => {
  throw new TaskError(code, message);
};
export function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value))
    return fail("INVALID", "Non-finite number");
  if (["string", "number", "boolean"].includes(typeof value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value) {
    const o = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(o[k]))
        .join(",") +
      "}"
    );
  }
  return fail("INVALID", "Value must be JSON");
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function id(value: string, label = "id"): string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !value.match(/^[\w][\w:./@-]*$/)
  )
    fail("INVALID", `Invalid ${label}`);
  return value;
}
function text(value: string, label: string, max = 1_000_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("INVALID", `Invalid ${label}`);
  return value;
}
function optionalText(value: unknown, label: string, max = 1_000_000): string {
  if (typeof value !== "string" || value.length > max)
    return fail("INVALID", `Invalid ${label}`);
  return value;
}
function taskTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128)
    return fail("INVALID", "Task tags must be an array of at most 128 strings");
  return value.map((tag) => text(tag, "task tag", 200));
}
function finite(value: number, min: number, max: number, label: string) {
  if (!Number.isFinite(value) || value < min || value > max)
    fail("INVALID", `Invalid ${label}`);
  return value;
}
const schemaValidator = new Ajv({
  strict: true,
  allErrors: true,
  validateFormats: false,
});
function validateSchema(schema: Json, value: Json, label: string) {
  try {
    const validate = schemaValidator.compile(schema as object);
    if (!validate(value))
      fail(
        "SCHEMA_VALIDATION",
        label + ": " + schemaValidator.errorsText(validate.errors),
      );
  } catch (e) {
    if (e instanceof TaskError) throw e;
    fail("INVALID_SCHEMA", label + ": invalid or unsupported JSON schema");
  }
}
const TERMINAL = new Set<Run["state"]>([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "uncertain",
  "blocked",
]);
export interface LedgerOptions {
  role?: Role;
  nodeId?: string;
  now?: () => number;
  readOnly?: boolean;
  requireConfirmation?: boolean;
  reportDestinations?: string[];
  alertDestinations?: string[];
  approvalDestinations?: string[];
  lifecycleDestinations?: string[];
  heartbeatTtlMs?: number;
  requireFreshHeartbeat?: boolean;
  safeRetry?: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    resumableTools?: string[];
  };
}
export interface ResultValidationContext {
  /** Set only by trusted host preflight, never deserialized from a model result. */
  phase?: "executor-preflight" | "authority";
  task: Task;
  run: Run;
  attempt: Attempt;
  submission: Settlement;
  executionContext?: ExecutionContext;
}
export type ResultValidator = (context: ResultValidationContext) => {
  valid: boolean;
};
export interface TaskInput {
  taskId?: string;
  title: string;
  description?: string;
  goal?: string;
  acceptanceCriteria?: Criterion[];
  priorityOverride?: TaskPriority;
  targetAt?: string;
  kind?: Task["kind"];
  parentTaskId?: string;
  parentRunId?: string;
  workspaceId?: string;
  tags?: string[];
  policy?: TaskPolicy;
  requiresConfirmation?: boolean;
  userImmediacy?: number;
  importance?: number;
  urgency?: number;
}
export interface RunInput {
  runId?: string;
  taskId: string;
  parentRunId?: string;
  route?: ExecutionRoute;
  configuration?: Json;
  sessionIds?: string[];
  occurrenceId?: string;
  contextNotes?: Run["contextNotes"];
}
export interface ReportInput {
  reportId?: string;
  taskId: string;
  runId?: string;
  attemptId?: string;
  sessionId?: string;
  previousReportId?: string;
  title: string;
  body: string;
  data?: Json;
  schemaId?: string;
  createdAt?: string;
  artifactIds?: string[];
  kind?: Report["kind"];
}

/** One authority owns this transactional ledger. Never execute an external effect inside a transaction. */
export class TaskLedger {
  readonly role: Role;
  readonly nodeId: string;
  private readonly clock: () => number;
  private readonly db: DatabaseSync;
  private closed = false;
  private validatorGeneration = 0;
  private readonly resultValidators = new Map<
    string,
    { generation: number; validate: ResultValidator }
  >();
  static open(path: string, options: LedgerOptions = {}) {
    return new TaskLedger(path, options);
  }
  constructor(
    path: string,
    private readonly options: LedgerOptions = {},
  ) {
    this.role = options.role ?? "both";
    this.nodeId = options.nodeId ?? "local";
    this.clock = options.now ?? Date.now;
    if (options.safeRetry) {
      const tools = options.safeRetry.resumableTools;
      if (
        tools !== undefined &&
        (!Array.isArray(tools) ||
          tools.length > 32 ||
          new Set(tools).size !== tools.length)
      )
        fail("INVALID", "Invalid resumable tools");
      for (const tool of tools ?? []) id(tool, "resumable tool");
      finite(options.safeRetry.maxRetries, 0, 5, "safe retries");
      if (!Number.isInteger(options.safeRetry.maxRetries))
        fail("INVALID", "Retry count must be integer");
      finite(options.safeRetry.baseDelayMs, 100, 3600000, "retry delay");
      finite(
        options.safeRetry.maxDelayMs,
        options.safeRetry.baseDelayMs,
        3600000,
        "maximum retry delay",
      );
    }
    if (
      options.alertDestinations !== undefined &&
      (!Array.isArray(options.alertDestinations) ||
        options.alertDestinations.length > 32)
    )
      fail("INVALID", "Invalid alert destinations");
    if (
      options.approvalDestinations !== undefined &&
      (!Array.isArray(options.approvalDestinations) ||
        options.approvalDestinations.length > 32)
    )
      fail("INVALID", "Invalid approval destinations");
    if (
      options.lifecycleDestinations !== undefined &&
      (!Array.isArray(options.lifecycleDestinations) ||
        options.lifecycleDestinations.length > 32)
    )
      fail("INVALID", "Invalid lifecycle destinations");
    for (const destination of options.lifecycleDestinations ?? [])
      text(destination, "lifecycle destination", 500);
    for (const destination of options.approvalDestinations ?? [])
      text(destination, "approval destination", 500);
    for (const destination of options.alertDestinations ?? [])
      text(destination, "alert destination", 500);
    if (
      options.reportDestinations !== undefined &&
      (!Array.isArray(options.reportDestinations) ||
        options.reportDestinations.length > 32)
    )
      fail("INVALID", "Invalid report destinations");
    for (const destination of options.reportDestinations ?? [])
      text(destination, "report destination", 500);
    if (path !== ":memory:" && !options.readOnly) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if (!options.readOnly) {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
      INSERT INTO schema_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_meta);
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,parent TEXT,state TEXT,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS entity_parent ON entities(kind,parent);
      CREATE INDEX IF NOT EXISTS entity_state ON entities(kind,state);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,task_id TEXT,run_id TEXT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resources(resource TEXT PRIMARY KEY,attempt_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_context_sessions(run_id TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(run_id,session_id));
    `);
    }
    const schema = this.db.prepare("SELECT version FROM schema_meta").get() as
      | { version: number }
      | undefined;
    if (schema?.version !== 1) {
      this.db.close();
      fail("SCHEMA", "Unsupported ledger schema");
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.resultValidators.clear();
      this.db.close();
    }
  }
  /** Trusted host code only. Validators must be deterministic, synchronous and free of effects.
   * Configuration selects a registered ID; it cannot load code or grant permissions.
   */
  registerResultValidator(
    validatorId: string,
    validate: ResultValidator,
  ): () => void {
    id(validatorId, "validator ID");
    if (this.closed || this.options.readOnly)
      fail("FORBIDDEN", "Ledger cannot register validators");
    if (typeof validate !== "function")
      fail("INVALID", "Validator must be a function");
    const generation = ++this.validatorGeneration;
    this.resultValidators.set(validatorId, { generation, validate });
    return () => {
      if (this.resultValidators.get(validatorId)?.generation === generation)
        this.resultValidators.delete(validatorId);
    };
  }
  /** Trusted in-process management adapter only; never expose the connection remotely. */
  managementDatabase() {
    return this.db;
  }
  assertManagementWritable() {
    this.planner();
    if (this.options.readOnly) fail("READ_ONLY", "Read-only ledger");
  }
  managementNow() {
    return this.now();
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private get<T>(kind: string, key: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM entities WHERE kind=? AND id=?")
      .get(kind, key) as { data: string } | undefined;
    return row ? this.projectEntity<T>(kind, JSON.parse(row.data)) : undefined;
  }
  private need<T>(kind: string, key: string): T {
    return this.get<T>(kind, id(key)) ?? fail("NOT_FOUND", `${kind} not found`);
  }
  private put(
    kind: string,
    key: string,
    data: unknown,
    parent: string | null = null,
    state: string | null = null,
  ) {
    this.db
      .prepare(
        "INSERT INTO entities(kind,id,parent,state,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent=excluded.parent,state=excluded.state,data=excluded.data",
      )
      .run(kind, key, parent, state, canonical(data));
  }
  private list<T>(kind: string, parent?: string): T[] {
    const rows = (
      parent === undefined
        ? this.db
            .prepare("SELECT data FROM entities WHERE kind=? ORDER BY rowid")
            .all(kind)
        : this.db
            .prepare(
              "SELECT data FROM entities WHERE kind=? AND parent=? ORDER BY rowid",
            )
            .all(kind, parent)
    ) as { data: string }[];
    return rows.map((x) => this.projectEntity<T>(kind, JSON.parse(x.data)));
  }
  private projectEntity<T>(kind: string, value: any): T {
    if (kind === "task") value.priority = this.priorityFor(value);
    if (kind === "run") {
      const sessions = this.list<Attempt>("attempt", value.runId).flatMap(
        (a) => (a.sessionId ? [a.sessionId] : []),
      );
      const table = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='run_context_sessions'",
        )
        .get();
      const inherited = table
        ? (
            this.db
              .prepare(
                "SELECT session_id FROM run_context_sessions WHERE run_id=? ORDER BY session_id",
              )
              .all(value.runId) as { session_id: string }[]
          ).map((x) => x.session_id)
        : [];
      value.sessionIds = [
        ...new Set([...(value.sessionIds ?? []), ...sessions, ...inherited]),
      ];
      const occurrence = this.list<{ occurrenceId: string; runId?: string }>(
        "occurrence",
      ).find((x) => x.runId === value.runId);
      if (occurrence) value.occurrenceId = occurrence.occurrenceId;
    }
    return value as T;
  }
  private priorityFor(task: Task): TaskPriority {
    if (task.priorityOverride) return task.priorityOverride;
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_backlog_tasks'",
        )
        .get()
    )
      return "normal";
    const rows = this.db
      .prepare(
        "SELECT b.priority FROM wb_backlogs b JOIN wb_backlog_tasks bt USING(backlog_id) WHERE bt.task_id=?",
      )
      .all(task.taskId) as { priority: TaskPriority }[];
    const order: TaskPriority[] = ["low", "normal", "high", "urgent"];
    return rows.length
      ? rows.reduce(
          (a, b) =>
            order.indexOf(a) > order.indexOf(b.priority) ? a : b.priority,
          "low" as TaskPriority,
        )
      : "normal";
  }
  effectivePriority(taskId: string): TaskPriority {
    return this.getTask(taskId).priority!;
  }
  private criteria(value: unknown): Criterion[] {
    return validateCriteria(value, (ref: VersionRef) => {
      if (ref.type === "task") {
        const task = this.getTask(ref.id);
        if (ref.revision !== undefined && ref.revision !== task.intentRevision)
          fail("CONFLICT", "Task criterion intent revision differs");
      } else if (ref.type === "report") this.need<Report>("report", ref.id);
      else if (ref.type === "artifact" || ref.type === "milestone") {
        const table =
          ref.type === "artifact" ? "wb_artifacts" : "wb_milestones";
        const column = ref.type === "artifact" ? "artifact_id" : "milestone_id";
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table) ||
          !this.db
            .prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`)
            .get(ref.id)
        )
          fail("NOT_FOUND", "Criterion target not found");
      }
    });
  }
  private planner() {
    if (this.role === "executor")
      fail("FORBIDDEN", "Executor role cannot manage task intent");
  }
  private event(type: string, detail: Json, taskId?: string, runId?: string) {
    const e: Event = {
      eventId: randomUUID(),
      type,
      at: this.now(),
      detail,
      ...(taskId ? { taskId } : {}),
      ...(runId ? { runId } : {}),
    };
    this.db
      .prepare("INSERT INTO events(id,task_id,run_id,data) VALUES(?,?,?,?)")
      .run(e.eventId, taskId ?? null, runId ?? null, canonical(e));
    return e;
  }
  private command<T>(
    commandId: string,
    operation: string,
    input: unknown,
    fn: () => T,
  ): Receipt<T> {
    id(commandId, "commandId");
    if (canonical(input).length > 2_000_000)
      fail("TOO_LARGE", "Command exceeds size limit");
    if (this.options.readOnly) fail("READ_ONLY", "Read-only ledger");
    const digest = hash({ operation, input });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT digest,receipt FROM commands WHERE id=?")
        .get(commandId) as { digest: string; receipt: string } | undefined;
      if (old) {
        if (old.digest !== digest)
          fail("CONFLICT", "Idempotency key reused with a different command");
        this.db.exec("COMMIT");
        return JSON.parse(old.receipt) as Receipt<T>;
      }
      const result: Receipt<T> = {
        commandId,
        acceptedAt: this.now(),
        value: fn(),
      };
      this.db
        .prepare("INSERT INTO commands VALUES(?,?,?)")
        .run(commandId, digest, canonical(result));
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private saveTask(task: Task) {
    const { priority, ...stored } = task;
    this.put(
      "task",
      task.taskId,
      stored,
      task.parentTaskId ?? null,
      task.state,
    );
  }
  private saveRun(run: Run) {
    const { sessionIds, occurrenceId, ...stored } = run;
    this.put(
      "run",
      run.runId,
      run.intentSnapshot && !run.historyOnly ? stored : run,
      run.taskId,
      run.state,
    );
  }
  private saveAttempt(attempt: Attempt) {
    this.put(
      "attempt",
      attempt.attemptId,
      attempt,
      attempt.runId,
      attempt.state,
    );
  }
  private approvalLive(record: ApprovalRequest) {
    if (record.expiresAt <= this.clock()) return false;
    try {
      const { attempt } = this.owned(record);
      return (
        attempt.sessionId === record.sessionId &&
        attempt.executionId === record.executionId
      );
    } catch {
      return false;
    }
  }
  getApproval(requestId: string): ApprovalRequest {
    const record = this.need<ApprovalRequest>("approval", requestId);
    return record.state === "pending" && !this.approvalLive(record)
      ? { ...record, state: "expired" }
      : record;
  }
  approvals() {
    return this.list<ApprovalRequest>("approval").map((r) =>
      this.getApproval(r.requestId),
    );
  }
  offerApproval(
    commandId: string,
    input: LeaseRef & {
      requestId: string;
      sessionId: string;
      agentId: string;
      callId: string;
      toolName: string;
      argumentsDigest: string;
      description: string;
      expiresAt: number;
      allowRemoteOnce: boolean;
    },
  ) {
    return this.command(commandId, "offerApproval", input, () => {
      const { run, attempt } = this.owned(input),
        task = this.getTask(run.taskId);
      if (
        attempt.state !== "running" ||
        !attempt.executionId ||
        attempt.sessionId !== input.sessionId
      )
        fail(
          "FORBIDDEN",
          "Approval requires the exact live native execution session",
        );
      for (const field of [
        "requestId",
        "sessionId",
        "agentId",
        "callId",
        "toolName",
      ] as const)
        id(input[field], field);
      if (
        !/^[a-f0-9]{64}$/.test(input.argumentsDigest) ||
        typeof input.allowRemoteOnce !== "boolean"
      )
        fail("INVALID", "Invalid approval descriptor");
      text(input.description, "safe approval description", 4000);
      finite(
        input.expiresAt,
        this.clock() + 1,
        this.clock() + 300000,
        "approval expiry",
      );
      if (
        task.policy?.allowedTools &&
        !task.policy.allowedTools.includes(input.toolName)
      )
        fail("FORBIDDEN", "Task policy does not permit this tool");
      const prior = this.get<ApprovalRequest>("approval", input.requestId);
      if (prior) fail("CONFLICT", "A live approval identity cannot be reused");
      const request: ApprovalRequest = {
        requestId: input.requestId,
        taskId: task.taskId,
        runId: run.runId,
        attemptId: attempt.attemptId,
        nodeId: attempt.nodeId,
        fence: attempt.fence,
        executionId: attempt.executionId!,
        sessionId: input.sessionId,
        agentId: input.agentId,
        callId: input.callId,
        toolName: input.toolName,
        argumentsDigest: input.argumentsDigest,
        description: input.description,
        allowRemoteOnce: input.allowRemoteOnce,
        expiresAt: input.expiresAt,
        createdAt: this.now(),
        state: "pending",
        revision: 1,
      };
      this.put(
        "approval",
        request.requestId,
        request,
        task.taskId,
        request.state,
      );
      this.event(
        "approval.offered",
        {
          requestId: request.requestId,
          callId: request.callId,
          toolName: request.toolName,
          argumentsDigest: request.argumentsDigest,
        },
        task.taskId,
        run.runId,
      );
      for (const destination of this.options.approvalDestinations ?? []) {
        text(destination, "approval destination", 500);
        const delivery: Delivery = {
          deliveryId: randomUUID(),
          taskId: task.taskId,
          approvalId: request.requestId,
          destination,
          kind: "approval",
          payload: { requestId: request.requestId, revision: request.revision },
          state: "pending",
          attempts: 0,
          nextAttemptAt: this.now(),
        };
        this.put(
          "delivery",
          delivery.deliveryId,
          delivery,
          task.taskId,
          delivery.state,
        );
      }
      return request;
    });
  }
  private approvalRef(
    input: LeaseRef & { requestId: string },
    requireLive = true,
  ) {
    const record = this.need<ApprovalRequest>("approval", input.requestId);
    if (
      record.runId !== input.runId ||
      record.attemptId !== input.attemptId ||
      record.nodeId !== input.nodeId ||
      record.fence !== input.fence ||
      record.executionId !== input.executionId
    )
      fail("FORBIDDEN", "Approval belongs to another execution");
    if (requireLive) this.owned(input);
    return record;
  }
  approvalStatus(input: LeaseRef & { requestId: string }) {
    this.approvalRef(input);
    return this.getApproval(input.requestId);
  }
  cancelApproval(
    commandId: string,
    input: LeaseRef & { requestId: string; reason: string },
  ) {
    return this.command(commandId, "cancelApproval", input, () => {
      const record = this.approvalRef(input, false);
      text(input.reason, "approval cancellation", 1000);
      if (record.state !== "pending") return record;
      record.state = "cancelled";
      record.revision++;
      record.reason = input.reason;
      record.decidedAt = this.now();
      record.actor = `executor:${input.nodeId}`;
      this.put(
        "approval",
        record.requestId,
        record,
        record.taskId,
        record.state,
      );
      this.event(
        "approval.cancelled",
        { requestId: record.requestId, reason: input.reason },
        record.taskId,
        record.runId,
      );
      return record;
    });
  }
  /** Human/host operator adapter only. No peer operation or model tool calls this. */
  respondApproval(
    commandId: string,
    input: {
      requestId: string;
      expectedRevision: number;
      decision: "allowed-once" | "denied";
      actor: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "respondApproval", input, () => {
      const record = this.getApproval(input.requestId);
      if (record.state !== "pending" || !this.approvalLive(record))
        fail("EXPIRED", "Approval is not a live pending request");
      if (record.revision !== input.expectedRevision)
        fail("CONFLICT", "Approval revision changed");
      if (!["allowed-once", "denied"].includes(input.decision))
        fail("INVALID", "Only once or deny decisions are supported");
      if (input.decision === "allowed-once" && !record.allowRemoteOnce)
        fail("FORBIDDEN", "This request requires the host approval UI");
      record.state = input.decision;
      record.revision++;
      record.actor = text(input.actor, "authenticated approval actor", 200);
      record.decidedAt = this.now();
      this.put(
        "approval",
        record.requestId,
        record,
        record.taskId,
        record.state,
      );
      this.event(
        "approval.decided",
        {
          requestId: record.requestId,
          decision: record.state,
          actor: record.actor,
          callId: record.callId,
          argumentsDigest: record.argumentsDigest,
        },
        record.taskId,
        record.runId,
      );
      return record;
    });
  }

  getAlert(alertId: string) {
    return this.need<Alert>("alert", alertId);
  }
  alerts(options: { includeResolved?: boolean } = {}) {
    return this.list<Alert>("alert").filter(
      (a) => options.includeResolved || a.status !== "resolved",
    );
  }
  private lifecycleDelivery(task: Task, run?: Run) {
    if (task.admissionState === "dismissed") return;
    for (const destination of this.options.lifecycleDestinations ?? []) {
      text(destination, "lifecycle destination", 500);
      const anchorKey = hash([task.taskId, destination]);
      let anchor = this.get<{ deliveryId: string }>(
        "lifecycle-anchor",
        anchorKey,
      );
      if (!anchor) {
        const created: Delivery = {
          deliveryId: randomUUID(),
          taskId: task.taskId,
          destination,
          kind: "lifecycle.created",
          payload: { taskId: task.taskId },
          state: "pending",
          attempts: 0,
          nextAttemptAt: this.now(),
        };
        this.put(
          "delivery",
          created.deliveryId,
          created,
          task.taskId,
          created.state,
        );
        anchor = { deliveryId: created.deliveryId };
        this.put("lifecycle-anchor", anchorKey, anchor, task.taskId);
      }
      if (
        run &&
        [
          "succeeded",
          "partial",
          "failed",
          "cancelled",
          "blocked",
          "uncertain",
        ].includes(run.state)
      ) {
        const terminalKey = hash([
          task.taskId,
          run.runId,
          destination,
          run.state,
          run.updatedAt,
        ]);
        if (this.get("lifecycle-terminal", terminalKey)) continue;
        const terminal: Delivery = {
          deliveryId: randomUUID(),
          taskId: task.taskId,
          runId: run.runId,
          destination,
          kind: "lifecycle.terminal",
          payload: { runId: run.runId },
          dependsOnDeliveryId: anchor.deliveryId,
          replyToDeliveryId: anchor.deliveryId,
          state: "pending",
          attempts: 0,
          nextAttemptAt: this.now(),
        };
        this.put(
          "delivery",
          terminal.deliveryId,
          terminal,
          task.taskId,
          terminal.state,
        );
        this.put(
          "lifecycle-terminal",
          terminalKey,
          { deliveryId: terminal.deliveryId },
          task.taskId,
        );
      }
    }
  }

  private alertDelivery(alert: Alert) {
    if (
      alert.taskId &&
      this.getTask(alert.taskId).admissionState === "dismissed"
    )
      return;
    for (const destination of this.options.alertDestinations ?? []) {
      text(destination, "alert destination", 500);
      for (const prior of this.list<Delivery>("delivery").filter(
        (d) =>
          d.alertId === alert.alertId &&
          d.destination === destination &&
          d.state === "pending",
      )) {
        prior.state = "failed";
        prior.receipt = {
          provider: "task-system",
          error: "superseded-alert-revision",
          retryable: false,
        };
        this.put(
          "delivery",
          prior.deliveryId,
          prior,
          prior.taskId ?? null,
          prior.state,
        );
      }
      const delivery: Delivery = {
        deliveryId: randomUUID(),
        alertId: alert.alertId,
        ...(alert.taskId ? { taskId: alert.taskId } : {}),
        destination,
        kind: "alert",
        payload: {
          alertId: alert.alertId,
          revision: alert.revision,
          cycle: alert.cycle,
        },
        state: "pending",
        attempts: 0,
        nextAttemptAt: this.now(),
      };
      this.put(
        "delivery",
        delivery.deliveryId,
        delivery,
        delivery.taskId ?? null,
        delivery.state,
      );
    }
  }
  raiseAlert(
    commandId: string,
    input: {
      dedupeKey: string;
      title: string;
      body: string;
      severity: Alert["severity"];
      taskId?: string;
      nodeId?: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "raiseAlert", input, () => {
      text(input.dedupeKey, "dedupe key", 500);
      text(input.title, "alert title", 500);
      text(input.body, "alert body", 8000);
      if (!["info", "warning", "critical"].includes(input.severity))
        fail("INVALID", "Invalid alert severity");
      if (input.taskId) this.getTask(input.taskId);
      if (input.nodeId) this.getNode(input.nodeId);
      const alertId = `alert:${hash(input.dedupeKey).slice(0, 40)}`,
        old = this.get<Alert>("alert", alertId),
        now = this.now();
      if (old && (old.taskId !== input.taskId || old.nodeId !== input.nodeId))
        fail("CONFLICT", "Alert dedupe identity cannot be rebound");
      const reopened = old?.status === "resolved";
      const changed =
        !old ||
        reopened ||
        old.title !== input.title ||
        old.body !== input.body ||
        old.severity !== input.severity;
      const alert: Alert = {
        ...(old ?? {}),
        alertId,
        dedupeKey: input.dedupeKey,
        title: input.title,
        body: input.body,
        severity: input.severity,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        status: reopened ? "open" : (old?.status ?? "open"),
        revision: (old?.revision ?? 0) + (changed ? 1 : 0),
        cycle: (old?.cycle ?? 0) + (!old || reopened ? 1 : 0),
        occurrences: (old?.occurrences ?? 0) + 1,
        createdAt: old?.createdAt ?? now,
        openedAt: !old || reopened ? now : old.openedAt,
        lastSeenAt: now,
        updatedAt: now,
      };
      if (reopened) {
        delete alert.acknowledgedAt;
        delete alert.resolvedAt;
        delete alert.actor;
        delete alert.reason;
      }
      this.put("alert", alertId, alert, input.taskId ?? null, alert.status);
      if (changed)
        this.event(
          reopened ? "alert.reopened" : "alert.updated",
          { alertId, revision: alert.revision, status: alert.status },
          input.taskId,
        );
      const rank = { info: 0, warning: 1, critical: 2 };
      if (!old || reopened || rank[input.severity] > rank[old.severity])
        this.alertDelivery(alert);
      return alert;
    });
  }
  private changeAlert(
    input: {
      alertId: string;
      state: Alert["status"];
      expectedRevision: number;
    },
    actor: string,
    reason: string,
  ) {
    const alert = this.getAlert(input.alertId);
    if (input.expectedRevision !== alert.revision)
      fail("CONFLICT", "Alert revision changed");
    if (!["open", "acknowledged", "resolved"].includes(input.state))
      fail("INVALID", "Invalid alert state");
    if (alert.status === input.state) return alert;
    if (alert.status === "resolved" && input.state === "acknowledged")
      fail("CONFLICT", "Resolved alert cannot be acknowledged");
    if (input.state === "open") {
      alert.cycle++;
      alert.openedAt = this.now();
      delete alert.resolvedAt;
      delete alert.acknowledgedAt;
    }
    alert.status = input.state;
    alert.revision++;
    alert.updatedAt = this.now();
    alert.actor = actor;
    alert.reason = reason;
    if (input.state === "acknowledged") alert.acknowledgedAt = this.now();
    if (input.state === "resolved") alert.resolvedAt = this.now();
    this.put("alert", alert.alertId, alert, alert.taskId ?? null, alert.status);
    this.event(
      "alert.state_changed",
      {
        alertId: alert.alertId,
        state: alert.status,
        revision: alert.revision,
        actor,
        reason,
      },
      alert.taskId,
    );
    if (input.state !== "acknowledged") this.alertDelivery(alert);
    return alert;
  }
  setAlertState(
    commandId: string,
    input: {
      alertId: string;
      state: Alert["status"];
      expectedRevision: number;
      actor: string;
      reason: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "setAlertState", input, () =>
      this.changeAlert(
        input,
        text(input.actor, "alert actor", 200),
        text(input.reason, "alert reason", 1000),
      ),
    );
  }
  setAlertsState(
    commandId: string,
    input: {
      changes: {
        alertId: string;
        state: Alert["status"];
        expectedRevision: number;
      }[];
      actor: string;
      reason: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "setAlertsState", input, () => {
      if (
        !Array.isArray(input.changes) ||
        !input.changes.length ||
        input.changes.length > 100 ||
        new Set(input.changes.map((c) => c.alertId)).size !==
          input.changes.length
      )
        fail("INVALID", "Bulk alert changes must name 1–100 unique alerts");
      const actor = text(input.actor, "alert actor", 200),
        reason = text(input.reason, "alert reason", 1000);
      return input.changes.map((change) =>
        this.changeAlert(change, actor, reason),
      );
    });
  }
  recordNodeHeartbeat(
    commandId: string,
    input: {
      nodeId: string;
      runtimeReady: boolean;
      activeExecutions: number;
      providerStatus?: Json;
      sampledAt?: number;
      source?: "authenticated-peer" | "host-local";
    },
  ) {
    if (this.role === "executor" && input.nodeId !== this.nodeId)
      fail("FORBIDDEN", "Executor may report only its own health");
    return this.command(commandId, "recordNodeHeartbeat", input, () => {
      this.getNode(input.nodeId);
      if (
        typeof input.runtimeReady !== "boolean" ||
        !Number.isSafeInteger(input.activeExecutions) ||
        input.activeExecutions < 0 ||
        input.activeExecutions > 128
      )
        fail("INVALID", "Invalid heartbeat");
      if (
        input.source !== undefined &&
        !["authenticated-peer", "host-local"].includes(input.source)
      )
        fail("INVALID", "Invalid heartbeat source");
      if (
        input.providerStatus !== undefined &&
        Buffer.byteLength(canonical(input.providerStatus)) > 16000
      )
        fail("TOO_LARGE", "Provider observations exceed bound");
      const sampledAt = input.sampledAt ?? this.clock();
      finite(
        sampledAt,
        this.clock() - 60000,
        this.clock() + 5000,
        "heartbeat sample time",
      );
      const previous = this.get<{ sampledAt: number; runtimeReady: boolean }>(
        "heartbeat",
        input.nodeId,
      );
      if (previous && previous.sampledAt >= sampledAt)
        return this.nodeStatuses().find((n) => n.nodeId === input.nodeId)!;
      this.put("heartbeat", input.nodeId, {
        nodeId: input.nodeId,
        runtimeReady: input.runtimeReady,
        activeExecutions: input.activeExecutions,
        ...(input.providerStatus !== undefined
          ? { providerStatus: input.providerStatus }
          : {}),
        sampledAt,
        observedAt: this.now(),
        source: input.source ?? "authenticated-peer",
      });
      if (!previous || previous.runtimeReady !== input.runtimeReady)
        this.event("node.readiness_observed", {
          nodeId: input.nodeId,
          runtimeReady: input.runtimeReady,
          source: input.source ?? "authenticated-peer",
        });
      return this.nodeStatuses().find((n) => n.nodeId === input.nodeId)!;
    });
  }
  nodeStatuses(at = this.clock()): NodeStatus[] {
    const ttl = finite(
      this.options.heartbeatTtlMs ?? 60000,
      100,
      3600000,
      "heartbeat TTL",
    );
    return this.list<NodeCapability>("node").map((node) => {
      const h = this.get<{
        observedAt: string;
        runtimeReady: boolean;
        activeExecutions: number;
        providerStatus?: Json;
        source: "authenticated-peer" | "host-local";
      }>("heartbeat", node.nodeId);
      const activeClaims = this.list<Run>("run").filter(
        (r) =>
          !(r.historyOnly || r.observationOnly) &&
          r.route?.nodeId === node.nodeId &&
          ["running", "uncertain"].includes(r.state),
      ).length;
      return {
        nodeId: node.nodeId,
        enabled: node.enabled,
        state: !node.enabled
          ? "disabled"
          : !h
            ? "unknown"
            : Date.parse(h.observedAt) + ttl <= at
              ? "stale"
              : h.runtimeReady
                ? "online"
                : "unavailable",
        activeClaims,
        ...(node.maxConcurrent !== undefined
          ? {
              maxConcurrent: node.maxConcurrent,
              availableSlots: Math.max(0, node.maxConcurrent - activeClaims),
            }
          : {}),
        ...(h
          ? {
              observedAt: h.observedAt,
              expiresAt: new Date(Date.parse(h.observedAt) + ttl).toISOString(),
              runtimeReady: h.runtimeReady,
              activeExecutions: h.activeExecutions,
              ...(h.providerStatus !== undefined
                ? { providerStatus: h.providerStatus }
                : {}),
              source: h.source,
            }
          : { source: "unobserved" as const }),
      };
    });
  }
  reconcileNodeHealth(commandId: string) {
    // Host-only maintenance; every transition has its own durable operation.
    this.planner();
    const changed: Alert[] = [];
    for (const node of this.nodeStatuses()) {
      const dedupeKey = `node-health:${node.nodeId}`,
        alertId = `alert:${hash(dedupeKey).slice(0, 40)}`,
        old = this.get<Alert>("alert", alertId);
      if (["stale", "unavailable"].includes(node.state)) {
        if (
          !old ||
          old.status === "resolved" ||
          old.body !== `Authenticated runtime state: ${node.state}`
        )
          changed.push(
            this.raiseAlert(`${commandId}:${hash(node.nodeId).slice(0, 16)}`, {
              dedupeKey,
              nodeId: node.nodeId,
              title: `Executor needs attention: ${node.nodeId}`,
              body: `Authenticated runtime state: ${node.state}`,
              severity: "warning",
            }).value,
          );
      } else if (node.state === "online" && old && old.status !== "resolved")
        changed.push(
          this.setAlertState(`${commandId}:${hash(node.nodeId).slice(0, 16)}`, {
            alertId,
            state: "resolved",
            expectedRevision: old.revision,
            actor: "host-health-monitor",
            reason: "A fresh authenticated heartbeat reports runtime ready",
          }).value,
        );
    }
    return changed;
  }

  getTask(taskId: string) {
    return this.need<Task>("task", taskId);
  }
  getRun(runId: string) {
    return this.need<Run>("run", runId);
  }
  getAttempt(attemptId: string) {
    return this.need<Attempt>("attempt", attemptId);
  }
  getWorkspace(workspaceId: string) {
    return this.need<Workspace>("workspace", workspaceId);
  }
  getNode(nodeId: string) {
    return this.need<NodeCapability>("node", nodeId);
  }
  getTemplate(templateId: string, version: number) {
    return this.need<Template>("template", `${templateId}@${version}`);
  }
  getSchedule(scheduleId: string) {
    return this.need<Schedule>("schedule", scheduleId);
  }
  private newTask(input: TaskInput): Task {
    const key = id(input.taskId ?? randomUUID());
    if (this.get("task", key)) fail("CONFLICT", "Task ID already exists");
    const parent = input.parentTaskId
      ? this.getTask(input.parentTaskId)
      : undefined;
    const parentRunId = this.inferParentRun(
      input.parentTaskId,
      input.parentRunId,
    );
    if (parentRunId) this.checkExecutionBudget(parentRunId);
    if (input.workspaceId) this.getWorkspace(input.workspaceId);
    if (
      input.policy !== undefined &&
      (input.policy === null ||
        typeof input.policy !== "object" ||
        Array.isArray(input.policy))
    )
      fail("INVALID", "Task policy must be an object");
    const policy: TaskPolicy = {
      maxDepth: 8,
      maxChildren: 8,
      maxDescendants: 32,
      ...(parent?.policy ?? {}),
      ...(input.policy ?? {}),
    };
    for (const field of [
      "allowedNodeIds",
      "allowedWorkspaceIds",
      "allowedTools",
    ] as const) {
      const parentValues = parent?.policy?.[field];
      const values = policy[field];
      if (
        values !== undefined &&
        (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
      )
        fail("INVALID", "Invalid task scope");
      if (parentValues && values?.some((v) => !parentValues.includes(v)))
        fail("FORBIDDEN", "Child task cannot broaden parent scope");
    }
    if (policy.maxRuntimeMs !== undefined) {
      finite(policy.maxRuntimeMs, 100, 86_400_000, "runtime budget");
      if (
        parent?.policy?.maxRuntimeMs !== undefined &&
        policy.maxRuntimeMs > parent.policy.maxRuntimeMs
      )
        fail("FORBIDDEN", "Child runtime budget expanded");
    }
    if (policy.requiredResources !== undefined) {
      if (
        !Array.isArray(policy.requiredResources) ||
        policy.requiredResources.length > 64
      )
        fail("INVALID", "Invalid required resources");
      for (const resource of policy.requiredResources) id(resource, "resource");
      if (
        parent?.policy?.requiredResources?.some(
          (resource) => !policy.requiredResources!.includes(resource),
        )
      )
        fail("FORBIDDEN", "Child cannot omit inherited resource holds");
    }
    if (policy.maxDepth !== undefined)
      finite(policy.maxDepth, 0, 100, "delegation depth");
    for (const field of ["maxChildren", "maxDescendants"] as const) {
      const value = finite(policy[field]!, 0, 10000, field);
      if (!Number.isInteger(value))
        fail("INVALID", "Delegation count must be an integer");
      if (
        parent?.policy?.[field] !== undefined &&
        value > parent.policy[field]!
      )
        fail("FORBIDDEN", "Child delegation budget expanded");
    }
    if (policy.maxSafeRetries !== undefined) {
      finite(policy.maxSafeRetries, 0, 5, "task safe retry limit");
      if (!Number.isInteger(policy.maxSafeRetries))
        fail("INVALID", "Retry count must be integer");
      if (
        parent?.policy?.maxSafeRetries !== undefined &&
        policy.maxSafeRetries > parent.policy.maxSafeRetries
      )
        fail("FORBIDDEN", "Child retry budget expanded");
    }
    if (policy.settlementQuietMs !== undefined)
      finite(policy.settlementQuietMs, 0, 300000, "settlement quiet window");
    if (
      parent &&
      !parentRunId &&
      this.list<Task>("task").filter(
        (t) => t.parentTaskId === parent.taskId && !t.parentRunId,
      ).length >= (parent.policy?.maxChildren ?? 8)
    )
      fail("DELEGATION_LIMIT", "Parent child budget exhausted");
    let depth = 0;
    let ancestor = parent;
    while (ancestor) {
      depth++;
      if (depth > 100) fail("INVALID", "Task ancestry too deep");
      if (
        !parentRunId &&
        this.descendants(ancestor.taskId).filter((t) => !t.parentRunId)
          .length >= (ancestor.policy?.maxDescendants ?? 32)
      )
        fail("DELEGATION_LIMIT", "Ancestor descendant budget exhausted");
      if (
        ancestor.policy?.maxDepth !== undefined &&
        depth > ancestor.policy.maxDepth
      )
        fail("FORBIDDEN", "Delegation depth exceeded");
      ancestor = ancestor.parentTaskId
        ? this.getTask(ancestor.parentTaskId)
        : undefined;
    }
    const kind = input.kind ?? "ad_hoc";
    if (!["ad_hoc", "scheduled", "observed"].includes(kind))
      fail("INVALID", "Unknown task kind");
    if (
      input.requiresConfirmation !== undefined &&
      typeof input.requiresConfirmation !== "boolean"
    )
      fail("INVALID", "requiresConfirmation must be boolean");
    const required =
      kind !== "observed" &&
      Boolean(
        this.options.requireConfirmation ||
          parent?.confirmation?.required ||
          input.requiresConfirmation,
      );
    const priority = (value: number | undefined, fallback: number) => {
      const v = finite(value ?? fallback, 0, 100, "task priority");
      if (!Number.isInteger(v))
        fail("INVALID", "Task priority must be an integer");
      return v;
    };
    const task: Task = {
      taskId: key,
      title: text(input.title, "title", 500),
      description: optionalText(
        input.description === undefined ? "" : input.description,
        "description",
      ),
      kind,
      state: kind === "observed" ? "waiting" : required ? "waiting" : "ready",
      createdAt: this.now(),
      updatedAt: this.now(),
      tags: taskTags(input.tags === undefined ? [] : input.tags),
      revision: 1,
      intentRevision: 1,
      acceptanceCriteria: this.criteria(input.acceptanceCriteria ?? []),
      ...(input.goal !== undefined
        ? { goal: input.goal === "" ? "" : text(input.goal, "goal", 10000) }
        : {}),
      ...(input.priorityOverride !== undefined
        ? { priorityOverride: this.validatePriority(input.priorityOverride) }
        : {}),
      ...(input.targetAt !== undefined
        ? { targetAt: this.validateTargetAt(input.targetAt) }
        : {}),
      ...(input.userImmediacy !== undefined
        ? { userImmediacy: priority(input.userImmediacy, 50) }
        : {}),
      ...(input.importance !== undefined
        ? { importance: priority(input.importance, 50) }
        : {}),
      ...(input.urgency !== undefined
        ? { urgency: priority(input.urgency, 40) }
        : {}),
      confirmation: {
        required,
        state: required ? "pending" : "not_required",
        revision: 1,
      },
      ...(Object.keys(policy).length ? { policy } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(parentRunId ? { parentRunId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    };
    this.saveTask(task);
    this.event("task.created", { kind }, key);
    this.lifecycleDelivery(task);
    return this.getTask(task.taskId);
  }
  private validatePriority(value: TaskPriority): TaskPriority {
    if (!["low", "normal", "high", "urgent"].includes(value))
      fail("INVALID", "Invalid priority");
    return value;
  }
  private validateTargetAt(value: string): string {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      fail("INVALID", "Invalid targetAt timestamp");
    return new Date(value).toISOString();
  }
  createTask(commandId: string, input: TaskInput) {
    this.planner();
    return this.command(commandId, "createTask", input, () =>
      this.newTask(input),
    );
  }
  updateTask(
    commandId: string,
    input: {
      taskId: string;
      title?: string;
      description?: string;
      tags?: string[];
      state?: "candidate" | "ready" | "waiting" | "archived";
      expectedRevision?: number;
      goal?: string;
      acceptanceCriteria?: Criterion[];
      priorityOverride?: TaskPriority | null;
      targetAt?: string | null;
      userImmediacy?: number;
      importance?: number;
      urgency?: number;
    },
  ) {
    this.planner();
    return this.command(commandId, "updateTask", input, () => {
      const t = this.getTask(input.taskId);
      if (
        (t.revision !== undefined || input.expectedRevision !== undefined) &&
        input.expectedRevision !== (t.revision ?? 1)
      )
        fail("CONFLICT", "Task revision changed");
      const intentChanged =
        (input.goal !== undefined && input.goal !== (t.goal ?? "")) ||
        (input.acceptanceCriteria !== undefined &&
          canonical(input.acceptanceCriteria) !==
            canonical(t.acceptanceCriteria ?? [])) ||
        (input.title !== undefined && input.title !== t.title) ||
        (input.description !== undefined &&
          input.description !== t.description);
      if (
        intentChanged &&
        this.list<Run>("run", t.taskId).some(
          (r) =>
            !(r.historyOnly || r.observationOnly) &&
            (r.state === "running" || r.state === "uncertain"),
        )
      )
        fail(
          "CONFLICT",
          "Cancel or reconcile active execution before changing task intent",
        );
      if (input.title !== undefined) t.title = text(input.title, "title", 500);
      if (input.description !== undefined)
        t.description = optionalText(input.description, "description");
      if (input.goal !== undefined)
        t.goal = input.goal === "" ? "" : text(input.goal, "goal", 10000);
      if (input.acceptanceCriteria !== undefined)
        t.acceptanceCriteria = this.criteria(input.acceptanceCriteria);
      if (input.priorityOverride === null) delete t.priorityOverride;
      else if (input.priorityOverride !== undefined)
        t.priorityOverride = this.validatePriority(input.priorityOverride);
      if (input.targetAt === null) delete t.targetAt;
      else if (input.targetAt !== undefined)
        t.targetAt = this.validateTargetAt(input.targetAt);
      if (
        input.state &&
        !["candidate", "ready", "waiting", "archived"].includes(input.state)
      )
        fail("INVALID", "Invalid management task state");
      if (input.tags !== undefined) t.tags = taskTags(input.tags);
      if (input.state) t.state = input.state;
      for (const field of ["userImmediacy", "importance", "urgency"] as const) {
        if (input[field] !== undefined) {
          const value = finite(input[field], 0, 100, "task priority");
          if (!Number.isInteger(value))
            fail("INVALID", "Task priority must be an integer");
          t[field] = value;
        }
      }
      if (intentChanged) {
        this.invalidateConfirmation(t);
        t.intentRevision = (t.intentRevision ?? 1) + 1;
        if (["completed", "failed"].includes(t.state))
          t.state = this.confirmationAllows(t) ? "ready" : "waiting";
      }
      t.revision = (t.revision ?? 1) + 1;
      t.updatedAt = this.now();
      this.saveTask(t);
      this.event("task.updated", { fields: Object.keys(input) }, t.taskId);
      return this.getTask(t.taskId);
    });
  }
  private confirmationAllows(task: Task) {
    return (
      !(this.options.requireConfirmation || task.confirmation?.required) ||
      task.confirmation?.state === "approved"
    );
  }
  /** Reversible task/non-task curation, separate from execution lifecycle. */
  setTaskAdmission(
    commandId: string,
    input: {
      taskId: string;
      state: "admitted" | "dismissed";
      expectedRevision: number;
      actor: string;
      reason: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "setTaskAdmission", input, () => {
      const task = this.getTask(input.taskId);
      if (task.admissionRevision === undefined)
        fail(
          "LEGACY_ONLY",
          "Admission curation applies only to legacy records; use task state for new work",
        );
      if (!["admitted", "dismissed"].includes(input.state))
        fail("INVALID", "Invalid admission state");
      if ((task.admissionRevision ?? 1) !== input.expectedRevision)
        fail("CONFLICT", "Admission revision changed");
      text(input.actor, "curation actor", 200);
      text(input.reason, "curation reason", 1000);
      task.admissionState = input.state;
      task.admissionRevision = (task.admissionRevision ?? 1) + 1;
      task.updatedAt = this.now();
      this.saveTask(task);
      this.event(
        "task.admission",
        {
          state: input.state,
          revision: task.admissionRevision,
          actor: input.actor,
          reason: input.reason,
        },
        task.taskId,
      );
      return task;
    });
  }
  private invalidateConfirmation(task: Task) {
    if (!(this.options.requireConfirmation || task.confirmation?.required))
      return;
    task.confirmation = {
      required: true,
      state: "pending",
      revision: (task.confirmation?.revision ?? 0) + 1,
    };
    task.state = "waiting";
  }
  /** Trusted operator/channel adapter only; never expose as a model approval tool. */
  setTaskConfirmation(
    commandId: string,
    input: {
      taskId: string;
      expectedRevision: number;
      approved: boolean;
      actor: string;
      reason: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "setTaskConfirmation", input, () => {
      const task = this.getTask(input.taskId);
      const prior = task.confirmation ?? {
        required: Boolean(this.options.requireConfirmation),
        state: "pending" as const,
        revision: 1,
      };
      if (!(prior.required || this.options.requireConfirmation))
        fail("CONFLICT", "Task does not require confirmation");
      if (input.expectedRevision !== prior.revision)
        fail("CONFLICT", "Confirmation revision changed");
      if (typeof input.approved !== "boolean")
        fail("INVALID", "Approval must be boolean");
      if (
        this.list<Run>("run", task.taskId).some(
          (r) =>
            !(r.historyOnly || r.observationOnly) &&
            (r.state === "running" || r.state === "uncertain"),
        )
      )
        fail(
          "CONFLICT",
          "Reconcile or cancel active execution before changing confirmation",
        );
      task.confirmation = {
        required: true,
        state: input.approved ? "approved" : "rejected",
        revision: prior.revision + 1,
        actor: text(input.actor, "operator identity", 200),
        reason: text(input.reason, "confirmation reason", 1000),
        decidedAt: this.now(),
      };
      if (
        !["cancelled", "archived", "completed", "failed"].includes(task.state)
      )
        task.state = input.approved ? "ready" : "waiting";
      task.updatedAt = this.now();
      this.saveTask(task);
      this.event(
        "task.confirmation",
        {
          approved: input.approved,
          actor: input.actor,
          revision: task.confirmation.revision,
        },
        task.taskId,
      );
      return task;
    });
  }
  private pinConfiguration(value?: Json): Json {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || Array.isArray(value))
      fail("INVALID", "Run configuration must be an object");
    const config = value as Record<string, Json>;
    const allowed = new Set([
      "template",
      "templateRef",
      "input",
      "reporting",
      "notifyUserOnTerminal",
      "trigger",
      "decisionId",
      "continuationOf",
    ]);
    if (Object.keys(config).some((k) => !allowed.has(k)))
      fail("INVALID", "Unsupported Run configuration field");
    let template: Template | undefined;
    if (config.template) {
      template = config.template as unknown as Template;
      this.validateTemplate(template);
      const key = `${template.templateId}@${template.version}`;
      const existing = this.get<Template>("template", key);
      if (existing && canonical(existing) !== canonical(template))
        fail("CONFLICT", "Template version content differs");
      if (!existing) this.put("template", key, template, template.templateId);
    }
    if (config.templateRef) {
      const ref = config.templateRef as { templateId: string; version: number };
      const pinned = this.getTemplate(ref.templateId, ref.version);
      if (template && canonical(pinned) !== canonical(template))
        fail("CONFLICT", "Template and reference differ");
      template = pinned;
    }
    const result: Record<string, Json> = {};
    if (template) {
      result.templateRef = {
        templateId: template.templateId,
        version: template.version,
      };
      result.input = config.input ?? template.defaults ?? null;
      validateSchema(template.inputSchema, result.input, "Template input");
    } else if (config.input !== undefined) result.input = config.input;
    for (const key of ["reporting", "notifyUserOnTerminal", "trigger"] as const)
      if (config[key] !== undefined) result[key] = config[key];
    if (config.reporting !== undefined && typeof config.reporting !== "string")
      fail("INVALID", "Invalid reporting setting");
    if (
      config.notifyUserOnTerminal !== undefined &&
      typeof config.notifyUserOnTerminal !== "boolean"
    )
      fail("INVALID", "Invalid terminal notification setting");
    if (result.input !== undefined) canonicalData(result.input);
    if (result.trigger !== undefined) canonicalData(result.trigger);
    // Old command provenance stays in events, not in the execution configuration.
    return result;
  }
  executionContext(runId: string): ExecutionContext {
    const run = this.getRun(runId);
    const config = run.configuration as {
      template?: Template;
      templateRef?: { templateId: string; version: number };
    } | null;
    const template = config?.templateRef
      ? this.getTemplate(
          config.templateRef.templateId,
          config.templateRef.version,
        )
      : config?.template;
    // Apply the same content budgets to already-persisted templates too; the
    // consumer must not be the first place an over-bound legacy value fails.
    if (template) {
      canonicalSchema(template.inputSchema);
      canonicalSchema(template.resultContract);
      canonicalData(template.defaults);
    }
    if (config && "input" in config) canonicalData(config.input);
    if (config && "trigger" in config) canonicalData(config.trigger);
    const reports = (run.contextNotes ?? []).map((note) => {
      if (typeof note !== "string") return note;
      const report = this.need<Report>("report", note);
      if (report.taskId !== run.taskId)
        fail("FORBIDDEN", "Context report belongs to another task");
      return {
        reportId: report.reportId,
        body: report.body,
        actor: (report.data as { actor?: string })?.actor ?? "unknown",
      };
    });
    const context = { ...(template ? { template } : {}), reports };
    if (Buffer.byteLength(canonical(context)) > 1_000_000)
      fail("TOO_LARGE", "Resolved execution context exceeds 1 MB");
    return context;
  }
  private newRun(input: RunInput): Run {
    const task = this.getTask(input.taskId);
    const parentRunId = this.inferParentRun(
      task.parentTaskId,
      input.parentRunId,
    );
    if (parentRunId) this.checkExecutionBudget(parentRunId, task.taskId);
    if (task.kind === "observed")
      fail("OBSERVE_ONLY", "Observed work cannot be dispatched");
    if (["candidate", "cancelled", "archived"].includes(task.state))
      fail("CLOSED", "Explicitly reopen task before execution");
    if (
      this.list<Run>("run", task.taskId).some(
        (r) => r.state === "uncertain" && !(r.historyOnly || r.observationOnly),
      )
    )
      fail(
        "UNRESOLVED_EFFECTS",
        "Reconcile uncertain prior execution before another run",
      );
    if (input.route) {
      this.validateRoute(input.route);
      const node = this.getNode(input.route.nodeId);
      let ancestorRunId = parentRunId;
      while (ancestorRunId) {
        const ancestorRun = this.getRun(ancestorRunId);
        if (
          (node.maxConcurrent ?? 1) <= 1 &&
          ancestorRun.route?.nodeId === node.nodeId &&
          ["running", "uncertain"].includes(ancestorRun.state)
        )
          fail(
            "DELEGATION_DEADLOCK",
            "Active ancestor occupies this single-slot executor",
          );
        ancestorRunId = ancestorRun.parentRunId;
      }
      if (
        task.policy?.allowedNodeIds &&
        !task.policy.allowedNodeIds.includes(input.route.nodeId)
      )
        fail("FORBIDDEN", "Task policy excludes node");
      if (
        task.policy?.allowedWorkspaceIds &&
        (!input.route.workspaceId ||
          !task.policy.allowedWorkspaceIds.includes(input.route.workspaceId))
      )
        fail("FORBIDDEN", "Task policy excludes workspace");
    }
    const configuration = this.pinConfiguration(input.configuration);
    const key = id(input.runId ?? randomUUID());
    if (this.get("run", key)) fail("CONFLICT", "Run ID already exists");
    const notes = this.list<{
      reportId: string;
      actor: string;
      consumedByRunId?: string;
    }>("note", task.taskId).filter((n) => !n.consumedByRunId);
    const contextNotes = [
      ...new Set([
        ...(input.contextNotes ?? []).map((note) =>
          typeof note === "string" ? note : note.reportId,
        ),
        ...notes.map((n) => n.reportId),
      ]),
    ];
    if (contextNotes.length > 128)
      fail("TOO_LARGE", "Run note context exceeds 128 reports");
    for (const reportId of contextNotes) {
      const source = this.need<Report>("report", reportId);
      if (source.taskId !== task.taskId)
        fail("FORBIDDEN", "Context report belongs to another task");
    }
    // Old callers may supply note snapshots; verify them before retaining only the immutable ID.
    for (const note of input.contextNotes ?? [])
      if (typeof note !== "string") {
        const source = this.need<Report>("report", note.reportId);
        if (
          source.body !== note.body ||
          (source.data as { actor?: string })?.actor !== note.actor
        )
          fail("FORBIDDEN", "Run note context differs from source history");
      }
    const contextSessionIds = [...new Set(input.sessionIds ?? [])];
    if (contextSessionIds.length > 128)
      fail("TOO_LARGE", "Too many context sessions");
    for (const sessionId of contextSessionIds) {
      id(sessionId, "context sessionId");
      if (
        !this.list<Attempt>("attempt").some(
          (a) => a.taskId === task.taskId && a.sessionId === sessionId,
        )
      )
        fail(
          "FORBIDDEN",
          "Context session has no attempt provenance for this task",
        );
    }
    const run: Run = {
      runId: key,
      taskId: task.taskId,
      ...(parentRunId ? { parentRunId } : {}),
      state: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
      sessionIds: contextSessionIds,
      historyOnly: false,
      configuration,
      intentSnapshot: {
        title: task.title,
        description: task.description,
        ...(task.goal !== undefined ? { goal: task.goal } : {}),
        acceptanceCriteria: task.acceptanceCriteria ?? [],
        ...(task.intentRevision !== undefined
          ? { intentRevision: task.intentRevision }
          : {}),
      },
      ...(this.options.safeRetry
        ? {
            retryPolicy: {
              ...this.options.safeRetry,
              maxRetries: Math.min(
                this.options.safeRetry.maxRetries,
                task.policy?.maxSafeRetries ??
                  this.options.safeRetry.maxRetries,
              ),
            },
          }
        : {}),
      ...(contextNotes.length ? { contextNotes } : {}),
      ...(input.route ? { route: input.route } : {}),
      ...(input.occurrenceId ? { occurrenceId: input.occurrenceId } : {}),
    };
    this.saveRun(run);
    for (const sessionId of contextSessionIds)
      this.db
        .prepare("INSERT INTO run_context_sessions VALUES(?,?)")
        .run(run.runId, sessionId);
    this.executionContext(run.runId);
    for (const note of notes)
      this.put(
        "note",
        note.reportId,
        { ...note, consumedByRunId: run.runId },
        task.taskId,
        "consumed",
      );
    this.invalidateConfirmation(task);
    task.state = this.confirmationAllows(task) ? "ready" : "waiting";
    task.updatedAt = this.now();
    this.saveTask(task);
    this.event(
      "run.queued",
      { configuration: run.configuration },
      task.taskId,
      key,
    );
    return run;
  }
  createRun(commandId: string, input: RunInput) {
    this.planner();
    return this.command(commandId, "createRun", input, () =>
      this.newRun(input),
    );
  }
  registerNode(commandId: string, node: NodeCapability) {
    if (
      this.role === "executor" &&
      (node.nodeId !== this.nodeId ||
        !Array.isArray(node.roles) ||
        node.roles.some((r) => r !== "executor"))
    )
      fail(
        "FORBIDDEN",
        "Executor bootstrap is limited to its own executor identity",
      );
    return this.command(commandId, "registerNode", node, () => {
      id(node.nodeId);
      if (node.maxConcurrent !== undefined) {
        finite(node.maxConcurrent, 1, 128, "node capacity");
        if (!Number.isInteger(node.maxConcurrent))
          fail("INVALID", "Node capacity must be integer");
      }
      if (
        !Array.isArray(node.roles) ||
        !node.roles.length ||
        node.roles.some((r) => !["planner", "executor", "both"].includes(r)) ||
        !Array.isArray(node.capabilities) ||
        node.capabilities.some((c) => typeof c !== "string") ||
        !Array.isArray(node.models) ||
        !Array.isArray(node.workspaceIds) ||
        typeof node.enabled !== "boolean"
      )
        fail("INVALID", "Invalid node capability declaration");
      for (const m of node.models) {
        text(m.provider, "provider", 100);
        text(m.model, "model", 200);
      }
      this.put("node", node.nodeId, node);
      return node;
    });
  }
  registerWorkspace(commandId: string, workspace: Workspace) {
    if (this.role === "executor" && workspace.nodeId !== this.nodeId)
      fail(
        "FORBIDDEN",
        "Executor can register only its own authorized workspace",
      );
    return this.command(commandId, "registerWorkspace", workspace, () => {
      id(workspace.workspaceId);
      id(workspace.nodeId);
      text(workspace.path, "workspace path", 4000);
      const prior = this.get<Workspace>("workspace", workspace.workspaceId);
      if (
        prior &&
        (prior.nodeId !== workspace.nodeId || prior.path !== workspace.path)
      )
        fail("CONFLICT", "Workspace identity cannot be rebound");
      this.put("workspace", workspace.workspaceId, workspace);
      return workspace;
    });
  }
  validateRoute(route: ExecutionRoute) {
    const node = this.getNode(route.nodeId);
    if (!node.enabled) fail("FORBIDDEN", "Node disabled");
    if (
      this.options.requireFreshHeartbeat &&
      this.nodeStatuses().find((n) => n.nodeId === node.nodeId)?.state !==
        "online"
    )
      fail(
        "NODE_UNAVAILABLE",
        "Fresh authenticated runtime readiness is required",
      );
    if (!node.roles.some((r) => r === "executor" || r === "both"))
      fail("FORBIDDEN", "Node is not an executor");
    for (const cap of route.requiredCapabilities)
      if (!node.capabilities.includes(cap))
        fail("UNSUPPORTED", "Node lacks required capability");
    const m =
      node.models.find(
        (x) => x.provider === route.provider && x.model === route.model,
      ) ?? fail("UNSUPPORTED", "Provider/model not advertised");
    if (
      route.reasoningEffort !== undefined &&
      !m.reasoningEfforts.includes(route.reasoningEffort)
    )
      fail("UNSUPPORTED", "Reasoning effort not supported");
    if (route.workspaceId) {
      const w = this.getWorkspace(route.workspaceId);
      if (
        w.state !== "ready" ||
        w.nodeId !== node.nodeId ||
        !node.workspaceIds.includes(w.workspaceId)
      )
        fail("FORBIDDEN", "Workspace unavailable to executor");
    }
  }
  claim(
    commandId: string,
    input: {
      runId: string;
      nodeId: string;
      ttlMs: number;
      resources?: string[];
      /** Trusted gateway bound; never accepted from peer payload. */
      maxClaimBytes?: number;
    },
  ) {
    return this.command(commandId, "claim", input, () => {
      finite(input.ttlMs, 100, 3_600_000, "lease TTL");
      if (
        (this.role === "planner" && input.nodeId === this.nodeId) ||
        (this.role === "executor" && input.nodeId !== this.nodeId)
      )
        fail("FORBIDDEN", "Role cannot execute on this node");
      const run = this.getRun(input.runId);
      if (run.state !== "queued") fail("CONFLICT", "Run is not queued");
      if (run.retry && Date.parse(run.retry.notBefore) > this.clock())
        fail("NOT_DUE", "Safe retry delay has not elapsed");
      if (!run.route || run.route.nodeId !== input.nodeId)
        fail("FORBIDDEN", "Assignment belongs to another node");
      this.validateRoute(run.route!);
      const node = this.getNode(input.nodeId);
      if (
        node.maxConcurrent !== undefined &&
        this.list<Run>("run").filter(
          (r) =>
            r.route?.nodeId === input.nodeId &&
            !(r.historyOnly || r.observationOnly) &&
            ["running", "uncertain"].includes(r.state),
        ).length >= node.maxConcurrent
      )
        fail("BUSY", "Executor capacity occupied");
      const task = this.getTask(run.taskId);
      if (task.kind === "observed" || run.historyOnly || run.observationOnly)
        fail("OBSERVE_ONLY", "Historical observed work cannot be dispatched");
      if (["candidate", "archived"].includes(task.state))
        fail("CLOSED", "Archived task cannot execute queued work");
      if (!this.confirmationAllows(task))
        fail(
          "CONFIRMATION_REQUIRED",
          "Explicit operator confirmation is required before execution",
        );
      if (task.state === "cancelled" || run.cancellationRequested)
        fail("CANCELLED", "Cancellation prevents assignment");
      const fence =
        Math.max(
          0,
          ...this.list<Attempt>("attempt", run.runId).map((x) => x.fence),
        ) + 1;
      const attempt: Attempt = {
        attemptId: randomUUID(),
        taskId: task.taskId,
        runId: run.runId,
        nodeId: input.nodeId,
        fence,
        leaseExpiresAt: new Date(this.clock() + input.ttlMs).toISOString(),
        state: "leased",
        ...(run.retry ? { sessionId: run.retry.sessionId } : {}),
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      for (const resource of new Set([
        ...(task.policy?.requiredResources ?? []),
        ...(input.resources ?? []),
      ])) {
        id(resource);
        if (
          this.db
            .prepare("SELECT attempt_id FROM resources WHERE resource=?")
            .get(resource)
        )
          fail("BUSY", "Resource already leased");
        this.db
          .prepare("INSERT INTO resources VALUES(?,?)")
          .run(resource, attempt.attemptId);
      }
      this.saveAttempt(attempt);
      run.currentAttemptId = attempt.attemptId;
      run.executionStartedAt ??= attempt.createdAt;
      run.state = "running";
      run.updatedAt = this.now();
      this.saveRun(run);
      task.state = "running";
      task.updatedAt = this.now();
      this.saveTask(task);
      this.event(
        "attempt.claimed",
        { attemptId: attempt.attemptId, nodeId: input.nodeId, fence },
        task.taskId,
        run.runId,
      );
      const claim = {
        attempt,
        run,
        task,
        executionContext: this.executionContext(run.runId),
      };
      // Validate before this command commits its Attempt. The same codec is
      // used by gateway receipts and client/worker journals; reserve the real
      // ledger receipt -> remote receipt -> outbound storage wrapper layers.
      wireCanonical({ receipt: { result: { value: claim } } });
      if (input.maxClaimBytes !== undefined) {
        finite(input.maxClaimBytes, 1024, 16 * 1024 * 1024, "claim byte bound");
        if (
          !Number.isInteger(input.maxClaimBytes) ||
          Buffer.byteLength(canonical(claim)) > input.maxClaimBytes
        )
          fail("TOO_LARGE", "Claim exceeds configured transport bound");
      }
      return claim;
    });
  }
  private owned(ref: LeaseRef, allowCancelled = false, recovered = false) {
    if (
      (this.role === "planner" && ref.nodeId === this.nodeId) ||
      (this.role === "executor" && ref.nodeId !== this.nodeId)
    )
      fail("FORBIDDEN", "Role cannot execute on this node");
    const run = this.getRun(ref.runId);
    const a = this.getAttempt(ref.attemptId);
    if (
      a.runId !== run.runId ||
      run.currentAttemptId !== a.attemptId ||
      a.nodeId !== ref.nodeId ||
      a.fence !== ref.fence
    )
      fail("STALE_ASSIGNMENT", "Wrong node, attempt or fencing token");
    if (!recovered && Date.parse(a.leaseExpiresAt) <= this.clock())
      fail("LEASE_EXPIRED", "Lease expired");
    if (a.executionId && a.executionId !== ref.executionId)
      fail("EXECUTION_OWNER", "Attempt belongs to another execution instance");
    if (
      recovered
        ? !["leased", "running", "uncertain", "expired"].includes(a.state) ||
          !["running", "uncertain"].includes(run.state)
        : !["leased", "running"].includes(a.state) || TERMINAL.has(run.state)
    )
      fail("TERMINAL", "Attempt no longer writable");
    if (run.cancellationRequested && !allowCancelled)
      fail("CANCELLED", "Cancellation requested");
    return { run, attempt: a };
  }
  private executionScope(taskId: string, rootRunId: string) {
    if (this.getRun(rootRunId).taskId !== taskId)
      fail("FORBIDDEN", "Execution scope belongs to another task");
    const allTasks = this.list<Task>("task"),
      allRuns = this.list<Run>("run").filter(
        (r) => !(r.historyOnly || r.observationOnly),
      ),
      runIds = new Set([rootRunId]),
      taskIds = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of allTasks)
        if (
          !taskIds.has(task.taskId) &&
          task.taskId !== taskId &&
          ((task.parentRunId && runIds.has(task.parentRunId)) ||
            (!task.parentRunId &&
              task.parentTaskId &&
              (task.parentTaskId === taskId || taskIds.has(task.parentTaskId))))
        ) {
          taskIds.add(task.taskId);
          changed = true;
        }
      for (const run of allRuns)
        if (
          !runIds.has(run.runId) &&
          ((run.parentRunId && runIds.has(run.parentRunId)) ||
            (!run.parentRunId &&
              taskIds.has(run.taskId) &&
              !allTasks.find((t) => t.taskId === run.taskId)?.parentRunId))
        ) {
          runIds.add(run.runId);
          taskIds.add(run.taskId);
          changed = true;
        }
    }
    const tasks = allTasks.filter((t) => taskIds.has(t.taskId)),
      runs = allRuns.filter(
        (r) => r.runId !== rootRunId && runIds.has(r.runId),
      );
    return { tasks, runs, taskIds, runIds };
  }
  private inferParentRun(parentTaskId?: string, explicit?: string) {
    if (explicit) {
      const run = this.getRun(explicit);
      if (
        !parentTaskId ||
        (run.taskId !== parentTaskId &&
          !this.descendants(run.taskId).some((t) => t.taskId === parentTaskId))
      )
        fail("FORBIDDEN", "Parent execution does not own this task tree");
      if (TERMINAL.has(run.state))
        fail("TERMINAL", "Parent execution has ended");
      return explicit;
    }
    if (!parentTaskId) return undefined;
    const active = this.list<Run>("run", parentTaskId).filter(
      (r) =>
        !(r.historyOnly || r.observationOnly) &&
        ["queued", "running"].includes(r.state),
    );
    if (active.length > 1)
      fail(
        "AMBIGUOUS_PARENT_RUN",
        "Name the exact parent execution when several are active",
      );
    return active[0]?.runId;
  }
  private checkExecutionBudget(
    parentRunId: string,
    representedTaskId?: string,
  ) {
    let current: Run | undefined = this.getRun(parentRunId),
      first = true;
    while (current) {
      const policy = this.getTask(current.taskId).policy,
        scope = this.executionScope(current.taskId, current.runId);
      const placeholderTasks = scope.tasks.filter(
        (t) =>
          t.kind !== "observed" &&
          !scope.runs.some((r) => r.taskId === t.taskId),
      );
      const represented =
        representedTaskId &&
        placeholderTasks.some((t) => t.taskId === representedTaskId);
      if (
        scope.runs.length + placeholderTasks.length >=
          (policy?.maxDescendants ?? 32) &&
        !represented
      )
        fail("DELEGATION_LIMIT", "Execution descendant budget exhausted");
      if (first) {
        const directRuns = scope.runs.filter(
            (r) => r.parentRunId === current!.runId,
          ),
          directTasks = placeholderTasks.filter(
            (t) => t.parentRunId === current!.runId,
          );
        if (
          directRuns.length + directTasks.length >=
            (policy?.maxChildren ?? 8) &&
          !(
            representedTaskId &&
            directTasks.some((t) => t.taskId === representedTaskId)
          )
        )
          fail("DELEGATION_LIMIT", "Execution child budget exhausted");
      }
      first = false;
      current = current.parentRunId
        ? this.getRun(current.parentRunId)
        : undefined;
    }
  }

  private descendants(taskId: string): Task[] {
    const tasks = this.list<Task>("task"),
      ids = new Set<string>([taskId]);
    let changed = true;
    while (changed) {
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
    return tasks.filter(
      (task) => task.taskId !== taskId && ids.has(task.taskId),
    );
  }
  private scoped(ref: LeaseRef, taskId?: string) {
    const owned = this.owned(ref);
    const target = taskId ?? owned.run.taskId;
    if (
      target !== owned.run.taskId &&
      !this.descendants(owned.run.taskId).some((task) => task.taskId === target)
    )
      fail("FORBIDDEN", "Target is outside the owned task tree");
    return { ...owned, task: this.getTask(target) };
  }
  delegateTask(
    commandId: string,
    input: LeaseRef & {
      title: string;
      description?: string;
      route?: ExecutionRoute;
      policy?: TaskPolicy;
      configuration?: Json;
    },
  ) {
    return this.command(commandId, "delegateTask", input, () => {
      const { run: parentRun } = this.owned(input);
      const task = this.newTask({
        title: input.title,
        description: input.description,
        parentTaskId: parentRun.taskId,
        parentRunId: parentRun.runId,
        policy: input.policy,
        workspaceId: (input.route ?? parentRun.route)?.workspaceId,
      });
      const run = this.newRun({
        taskId: task.taskId,
        parentRunId: parentRun.runId,
        route: input.route ?? parentRun.route,
        configuration: input.configuration,
      });
      this.event(
        "task.delegated",
        {
          parentTaskId: parentRun.taskId,
          parentRunId: parentRun.runId,
          nodeId: input.nodeId,
        },
        task.taskId,
        run.runId,
      );
      return { task, run };
    });
  }
  scopedHistory(input: LeaseRef & { taskId?: string }) {
    return this.history(this.scoped(input, input.taskId).task.taskId);
  }
  scopedAllSettled(input: LeaseRef & { taskId?: string; quietMs?: number }) {
    const { task } = this.scoped(input, input.taskId);
    return this.allSettled(
      task.taskId,
      input.quietMs ?? task.policy?.settlementQuietMs ?? 1000,
      task.taskId === this.getRun(input.runId).taskId ? input.runId : undefined,
    );
  }
  private note(taskId: string, body: string, actor: string) {
    this.getTask(taskId);
    text(body, "queued note", 8000);
    text(actor, "note actor", 200);
    if (
      this.list<{ consumedByRunId?: string }>("note", taskId).filter(
        (n) => !n.consumedByRunId,
      ).length >= 64
    )
      fail("TOO_LARGE", "Pending note queue is full");
    const report = this.report({
      taskId,
      title: "Queued task note",
      body,
      kind: "note",
      data: { actor, semantics: "queue_only" },
    });
    this.put(
      "note",
      report.reportId,
      { reportId: report.reportId, actor },
      taskId,
      "pending",
    );
    this.event(
      "task.note_queued",
      { reportId: report.reportId, actor, semantics: "queue_only" },
      taskId,
    );
    return report;
  }
  queueTaskNote(
    commandId: string,
    input: { taskId: string; body: string; actor: string },
  ) {
    this.planner();
    return this.command(commandId, "queueTaskNote", input, () =>
      this.note(input.taskId, input.body, input.actor),
    );
  }
  queueScopedNote(
    commandId: string,
    input: LeaseRef & { taskId?: string; body: string },
  ) {
    return this.command(commandId, "queueScopedNote", input, () =>
      this.note(
        this.scoped(input, input.taskId).task.taskId,
        input.body,
        input.nodeId,
      ),
    );
  }
  appendScopedReport(
    commandId: string,
    input: LeaseRef & {
      taskId?: string;
      title: string;
      body: string;
      data?: Json;
      schemaId?: string;
      artifactIds?: string[];
    },
  ) {
    return this.command(commandId, "appendScopedReport", input, () => {
      const { task, run, attempt } = this.scoped(input, input.taskId);
      return this.report({
        taskId: task.taskId,
        title: input.title,
        body: input.body,
        ...(input.data !== undefined ? { data: input.data } : {}),
        ...(input.schemaId ? { schemaId: input.schemaId } : {}),
        artifactIds: input.artifactIds,
        kind: "progress",
        ...(task.taskId === run.taskId
          ? {
              runId: run.runId,
              attemptId: attempt.attemptId,
              sessionId: attempt.sessionId,
            }
          : {}),
      });
    });
  }
  /** Trusted native host witness only; never a model action or text heuristic.
   * Legacy method name retained: reviewed completed-tool continuation is explicit opt-in. */
  retryBeforeEffects(
    commandId: string,
    input: LeaseRef & { witness: SafeRetryWitness; allowRetry?: boolean },
  ) {
    return this.command(commandId, "retryBeforeEffects", input, () => {
      const { run, attempt } = this.owned(input),
        w = input.witness;
      if (
        input.allowRetry !== undefined &&
        typeof input.allowRetry !== "boolean"
      )
        fail("INVALID", "allowRetry must be boolean");
      const completed = w?.kind === "dsh-owned-completed-tools-v1";
      const keys = [
        ...(completed ? ["toolResultCount", "completedTools"] : []),
        "kind",
        "sessionId",
        "fromSeq",
        "toSeq",
        "terminalSeq",
        "turn",
        "code",
        "toolCallCount",
        "toolDispatchCount",
        "complete",
        "quiescent",
        "persisted",
        "disposed",
      ];
      if (
        !w ||
        typeof w !== "object" ||
        Object.keys(w).some((k) => !keys.includes(k)) ||
        keys.some((k) => !(k in w)) ||
        (!completed && w.kind !== "dsh-owned-zero-tools-v1") ||
        w.sessionId !== attempt.sessionId ||
        !["RATE_LIMIT", "SERVER", "TRANSPORT", "TIMEOUT"].includes(w.code) ||
        (!completed && (w.toolCallCount !== 0 || w.toolDispatchCount !== 0)) ||
        w.complete !== true ||
        w.quiescent !== true ||
        w.persisted !== true ||
        w.disposed !== true
      )
        fail(
          "RETRY_WITNESS",
          "Incomplete or mismatched native recovery witness",
        );
      for (const n of [w.fromSeq, w.toSeq, w.terminalSeq, w.turn])
        if (!Number.isSafeInteger(n) || n < 0)
          fail("RETRY_WITNESS", "Invalid witness sequence");
      if (w.fromSeq > w.terminalSeq || w.terminalSeq >= w.toSeq)
        fail("RETRY_WITNESS", "Witness sequence is not coherent");
      const task = this.getTask(run.taskId),
        policy = run.retryPolicy ?? {
          maxRetries: 0,
          baseDelayMs: 30000,
          maxDelayMs: 60000,
        };
      if (w.kind === "dsh-owned-completed-tools-v1") {
        if (
          !Number.isInteger(w.toolCallCount) ||
          w.toolCallCount < 1 ||
          w.toolCallCount > 32 ||
          w.toolDispatchCount !== w.toolCallCount ||
          w.toolResultCount !== w.toolCallCount ||
          !Array.isArray(w.completedTools) ||
          w.completedTools.length !== w.toolCallCount
        )
          fail("RETRY_WITNESS", "Tool completion evidence is not closed");
        for (const tool of w.completedTools) {
          if (
            !tool ||
            typeof tool !== "object" ||
            Object.keys(tool).length !== 2 ||
            typeof tool.name !== "string" ||
            typeof tool.argumentsDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(tool.argumentsDigest) ||
            !(policy.resumableTools ?? []).includes(tool.name)
          )
            fail("RETRY_WITNESS", "Completed tool is not explicitly resumable");
          if (
            task.policy?.allowedTools &&
            !task.policy.allowedTools.includes(tool.name)
          )
            fail("RETRY_WITNESS", "Task policy excludes completed tool");
        }
      }
      const completedTools = [
        ...new Map(
          [
            ...(run.retry?.completedTools ?? []),
            ...(w.kind === "dsh-owned-completed-tools-v1"
              ? w.completedTools
              : []),
          ].map((tool) => [tool.name + ":" + tool.argumentsDigest, tool]),
        ).values(),
      ];
      if (completedTools.length > 160)
        fail("RETRY_WITNESS", "Completed tool replay guard exceeds bound");
      const count = run.retry?.count ?? 0;
      run.executionStartedAt ??= attempt.createdAt;
      const delay = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * Math.pow(2, count),
      );
      const exhausted =
        input.allowRetry === false ||
        count >= policy.maxRetries ||
        (task.policy?.maxRuntimeMs !== undefined &&
          this.clock() + delay - Date.parse(run.executionStartedAt) >=
            task.policy.maxRuntimeMs);
      attempt.state = "settled";
      attempt.retryEvidence = structuredClone(w);
      attempt.updatedAt = this.now();
      this.saveAttempt(attempt);
      this.db
        .prepare("DELETE FROM resources WHERE attempt_id=?")
        .run(attempt.attemptId);
      if (exhausted) {
        run.state = "failed";

        run.updatedAt = this.now();
        this.saveRun(run);
        this.projectTaskState(task, run);
        this.lifecycleDelivery(task, run);
        this.event(
          "run.safe_retry_exhausted",
          {
            attemptId: attempt.attemptId,
            code: w.code,
            count,
            validation: "not-submitted",
            recoveryWitness: w as unknown as Json,
          },
          task.taskId,
          run.runId,
        );
        const config = run.configuration as {
          reporting?: string;
          notifyUserOnTerminal?: boolean;
        } | null;
        if (
          config?.reporting !== "none" &&
          task.admissionState !== "dismissed" &&
          (!task.parentTaskId || config?.notifyUserOnTerminal === true)
        )
          for (const destination of this.options.reportDestinations ?? []) {
            const d: Delivery = {
              deliveryId: randomUUID(),
              taskId: task.taskId,
              runId: run.runId,
              destination,
              kind: "task-state",
              payload: {
                runId: run.runId,
                reasonCode: w.code,
                validation: "not-submitted",
              },
              state: "pending",
              attempts: 0,
              nextAttemptAt: this.now(),
            };
            this.put("delivery", d.deliveryId, d, task.taskId, d.state);
          }
      } else {
        run.retry = {
          count: count + 1,
          notBefore: new Date(this.clock() + delay).toISOString(),
          sessionId: w.sessionId,
          previousAttemptId: attempt.attemptId,
          reasonCode: w.code,
          ...(completedTools.length ? { completedTools } : {}),
        };
        run.state = "queued";
        run.updatedAt = this.now();
        delete run.currentAttemptId;
        this.saveRun(run);
        this.projectTaskState(task, run);
        this.event(
          "run.safe_retry_scheduled",
          {
            attemptId: attempt.attemptId,
            retry: run.retry as unknown as Json,
            recoveryWitness: w as unknown as Json,
          },
          task.taskId,
          run.runId,
        );
      }
      return run;
    });
  }

  renew(commandId: string, input: LeaseRef & { ttlMs: number }) {
    return this.command(commandId, "renew", input, () => {
      finite(input.ttlMs, 100, 3_600_000, "lease TTL");
      const { attempt } = this.owned(input);
      attempt.leaseExpiresAt = new Date(
        this.clock() + input.ttlMs,
      ).toISOString();
      attempt.updatedAt = this.now();
      this.saveAttempt(attempt);
      return attempt;
    });
  }
  markRunning(commandId: string, ref: LeaseRef) {
    return this.command(commandId, "markRunning", ref, () => {
      if (!ref.executionId) fail("INVALID", "executionId is required to start");
      id(ref.executionId ?? "", "executionId");
      const { attempt } = this.owned(ref);
      attempt.executionId = ref.executionId;
      attempt.state = "running";
      attempt.updatedAt = this.now();
      this.saveAttempt(attempt);
      return attempt;
    });
  }
  bindSession(commandId: string, input: LeaseRef & { sessionId: string }) {
    return this.command(commandId, "bindSession", input, () => {
      const { run, attempt } = this.owned(input);
      id(input.sessionId, "sessionId");
      if (attempt.sessionId && attempt.sessionId !== input.sessionId)
        fail("CONFLICT", "Attempt already bound to another session");
      attempt.sessionId = input.sessionId;
      attempt.updatedAt = this.now();
      this.saveAttempt(attempt);

      this.event(
        "session.linked",
        { sessionId: input.sessionId, attemptId: attempt.attemptId },
        run.taskId,
        run.runId,
      );
      return attempt;
    });
  }
  private report(input: ReportInput): Report {
    if (input.data !== undefined) canonicalData(input.data);
    this.getTask(input.taskId);
    if (input.runId && this.getRun(input.runId).taskId !== input.taskId)
      fail("FORBIDDEN", "Report run belongs to another task");
    if (input.attemptId) {
      const a = this.getAttempt(input.attemptId);
      if (a.taskId !== input.taskId || (input.runId && a.runId !== input.runId))
        fail("FORBIDDEN", "Report attempt belongs to another task");
    }
    const reportId = id(input.reportId ?? randomUUID());
    if (this.get("report", reportId)) fail("CONFLICT", "Report ID exists");
    let revision = 1;
    if (input.previousReportId) {
      const prev = this.need<Report>("report", input.previousReportId);
      if (prev.taskId !== input.taskId)
        fail("FORBIDDEN", "Revision crosses tasks");
      revision = prev.revision + 1;
    }
    const artifacts = input.artifactIds ?? [];
    for (const key of artifacts) {
      const a = this.need<Artifact>("artifact", key);
      if (a.taskId !== input.taskId || !a.finalized)
        fail("INVALID", "Artifact must be finalized and owned by task");
      if (!a.uri || !a.sha256 || a.bytes === undefined)
        fail("INTEGRITY", "Finalized artifact lacks byte evidence");
      try {
        const stat = statSync(a.uri!);
        if (
          !stat.isFile() ||
          stat.size !== a.bytes ||
          stat.size > 16 * 1024 * 1024
        )
          fail("INTEGRITY", "Artifact size mismatch");
        const bytes = readFileSync(a.uri!);
        if (createHash("sha256").update(bytes).digest("hex") !== a.sha256)
          fail("INTEGRITY", "Artifact digest mismatch");
      } catch (e) {
        if (e instanceof TaskError) throw e;
        fail("INTEGRITY", "Artifact bytes unavailable");
      }
    }
    const report: Report = {
      reportId,
      taskId: input.taskId,
      title: text(input.title, "report title", 500),
      body: text(input.body, "report body"),
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.schemaId
        ? { schemaId: text(input.schemaId, "report schema", 200) }
        : {}),
      revision,
      kind: input.kind ?? "progress",
      createdAt: input.createdAt ?? this.now(),
      recordedAt: this.now(),
      artifactIds: artifacts,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.previousReportId
        ? { previousReportId: input.previousReportId }
        : {}),
    };
    if (!Number.isFinite(Date.parse(report.createdAt)))
      fail("INVALID", "Invalid report timestamp");
    this.put("report", report.reportId, report, report.taskId);
    this.event(
      "report.appended",
      { reportId, revision, kind: report.kind },
      report.taskId,
      report.runId,
    );
    return report;
  }
  appendReport(commandId: string, input: ReportInput) {
    return this.command(commandId, "appendReport", input, () =>
      this.report(input),
    );
  }
  registerArtifact(commandId: string, input: Omit<Artifact, "createdAt">) {
    return this.command(commandId, "registerArtifact", input, () => {
      this.getTask(input.taskId);
      id(input.artifactId);
      if (this.get("artifact", input.artifactId))
        fail("CONFLICT", "Artifact versions are immutable");
      if (input.sha256 && !/^[a-f0-9]{64}$/.test(input.sha256))
        fail("INVALID", "Invalid artifact digest");
      if (input.bytes !== undefined)
        finite(input.bytes, 0, 1e12, "artifact bytes");
      const a: Artifact = { ...input, createdAt: this.now() };
      this.put("artifact", a.artifactId, a, a.taskId);
      return a;
    });
  }
  submit(commandId: string, input: Settlement) {
    return this.command(commandId, "submit", input, () =>
      this.completeSettlement(input),
    );
  }
  /** Trusted local terminal journal only. This is deliberately not a peer/model operation. */
  recoverSettlement(
    commandId: string,
    input: Settlement & {
      recovery: {
        readyAt: string;
        sessionId: string;
        quiescent: true;
        sessionPersisted: true;
      };
    },
  ) {
    const { recovery, ...settlement } = input;
    // Same operation digest as the original submission: a lost ACK returns the
    // already committed receipt rather than inventing another effect identity.
    return this.command(commandId, "submit", settlement, () => {
      const { attempt } = this.owned(settlement, false, true);
      const readyAt = Date.parse(recovery?.readyAt);
      if (
        !recovery ||
        recovery.quiescent !== true ||
        recovery.sessionPersisted !== true ||
        recovery.sessionId !== attempt.sessionId ||
        !Number.isFinite(readyAt) ||
        readyAt < Date.parse(attempt.createdAt) ||
        readyAt > Date.parse(attempt.leaseExpiresAt) ||
        readyAt > this.clock() + 5000 ||
        this.clock() - readyAt > 86400000
      )
        fail(
          "RECOVERY_PROOF",
          "Terminal journal proof is missing, mismatched, or outside its recovery window",
        );
      const run = this.completeSettlement(settlement, true);
      this.event(
        "run.terminal_receipt_recovered",
        {
          attemptId: attempt.attemptId,
          readyAt: recovery.readyAt,
          sessionId: recovery.sessionId,
        },
        run.taskId,
        run.runId,
      );
      return run;
    });
  }
  /** Pure contract preflight for a trusted host, including a foreign coordinator claim.
   * This does not authorize a lease or commit results; submit enforces both separately.
   */
  validateResultContract(context: ResultValidationContext): void {
    const { run, submission: input } = context;
    if (input.preDispatchFailure !== undefined) {
      this.validatePreDispatchFailure(run, context.attempt, input);
      return;
    }
    const config = run.configuration as {
      template?: Template;
      templateRef?: { templateId: string; version: number };
    } | null;
    let template: Template | undefined;
    if (config?.templateRef) {
      template =
        context.phase === "executor-preflight"
          ? context.executionContext?.template
          : this.getTemplate(
              config.templateRef.templateId,
              config.templateRef.version,
            );
      if (
        !template ||
        template.templateId !== config.templateRef.templateId ||
        template.version !== config.templateRef.version
      )
        fail(
          "CONTEXT_MISSING",
          "Pinned template context missing or mismatched",
        );
    } else template = config?.template;
    if (template && !(input.outcome === "unknown" && !input.report)) {
      const contract = template.resultContract;
      if (
        contract &&
        typeof contract === "object" &&
        !Array.isArray(contract) &&
        Object.keys(contract).length
      )
        validateSchema(
          contract,
          {
            outcome: input.outcome,
            summary: input.summary,
            ...(input.report
              ? { report: input.report as unknown as Json }
              : {}),
          },
          "Result",
        );
      if (template.resultValidator) {
        const validator = this.resultValidators.get(template.resultValidator);
        if (!validator)
          fail(
            "VALIDATOR_UNAVAILABLE",
            "Required semantic validator is not mounted",
          );
        let valid = false;
        try {
          const verdict = validator!.validate(
            structuredClone({
              ...context,
              phase: context.phase ?? "authority",
            }),
          );
          if (
            verdict &&
            typeof (verdict as unknown as { then?: unknown }).then ===
              "function"
          ) {
            // A mistaken async extension must neither pass nor leave an
            // unhandled rejection after the transaction rejects it.
            void Promise.resolve(verdict).catch(() => undefined);
            fail(
              "RESULT_VALIDATION",
              "Semantic validators must be synchronous",
            );
          }
          valid = verdict?.valid === true;
        } catch {
          fail("RESULT_VALIDATION", "Semantic result validation failed");
        }
        if (!valid)
          fail(
            "RESULT_VALIDATION",
            "Semantic result validation rejected the result",
          );
      }
    }
  }
  private validatePreDispatchFailure(
    run: Run,
    attempt: Attempt,
    input: Settlement,
  ) {
    const failure = input.preDispatchFailure;
    if (
      !failure ||
      typeof failure !== "object" ||
      Array.isArray(failure) ||
      Object.keys(failure).sort().join(",") !== "code,kind,model,provider" ||
      failure.kind !== "native-provider-unavailable-v1" ||
      failure.code !== "NO_ADAPTER" ||
      input.outcome !== "blocked" ||
      input.report !== undefined ||
      input.notifications !== undefined ||
      input.summary !== NATIVE_PROVIDER_UNAVAILABLE_SUMMARY ||
      run.retry ||
      !input.executionId ||
      attempt.executionId !== input.executionId ||
      failure.provider !== run.route?.provider ||
      failure.model !== run.route?.model
    )
      fail("INVALID", "Invalid native pre-dispatch failure attestation");
    // The trusted native adapter asserts only the new attempt did not dispatch.
    // A prior report from this attempt contradicts that boundary; never downgrade it.
    if (
      this.list<Report>("report", run.taskId).some(
        (r) => r.attemptId === attempt.attemptId,
      )
    )
      fail("CONFLICT", "Attempt already has report evidence");
  }
  private projectTaskState(task: Task, fallback: Run) {
    const runs = this.list<Run>("run", task.taskId).filter(
      (r) => !(r.historyOnly || r.observationOnly),
    );
    const latest = runs.at(-1) ?? fallback;
    task.state =
      latest.state === "succeeded" &&
      (!latest.intentSnapshot?.intentRevision ||
        latest.intentSnapshot.intentRevision === task.intentRevision)
        ? "completed"
        : latest.state === "failed"
          ? "failed"
          : "waiting";
    if (runs.some((r) => r.state === "running")) task.state = "running";
    else if (runs.some((r) => r.state === "uncertain")) task.state = "waiting";
    else if (
      runs.some((r) => r.state === "queued") ||
      this.list<Schedule>("schedule", task.taskId).some((s) => s.enabled)
    )
      task.state = "ready";
    task.updatedAt = this.now();
    this.saveTask(task);
  }
  private completeSettlement(input: Settlement, recovered = false) {
    const { run, attempt } = this.owned(input, false, recovered);
    if (
      !["success", "partial", "failure", "blocked", "unknown"].includes(
        input.outcome,
      )
    )
      fail("INVALID", "Invalid outcome");
    text(input.summary, "summary", 5000);
    const taskPolicy = this.getTask(run.taskId).policy;
    if (
      ["success", "partial"].includes(input.outcome) &&
      !this.allSettled(
        run.taskId,
        taskPolicy?.settlementQuietMs ?? 1000,
        run.runId,
      ).settled
    )
      fail(
        "CHILDREN_PENDING",
        "Descendants have not settled through the quiet window",
      );
    this.validateResultContract({
      task: this.getTask(run.taskId),
      run,
      attempt,
      submission: input,
      phase: "authority",
      executionContext: this.executionContext(run.runId),
    });
    if (input.preDispatchFailure) {
      this.event(
        "run.pre_dispatch_failed",
        {
          origin: "native-adapter",
          phase: "before-agent-start",
          code: input.preDispatchFailure.code,
          provider: input.preDispatchFailure.provider,
          model: input.preDispatchFailure.model,
          attemptId: attempt.attemptId,
          nodeId: attempt.nodeId,
          summary: NATIVE_PROVIDER_UNAVAILABLE_SUMMARY,
        },
        run.taskId,
        run.runId,
      );
    }
    const report = input.report
      ? this.report({
          ...input.report,
          taskId: run.taskId,
          runId: run.runId,
          attemptId: attempt.attemptId,
          sessionId: attempt.sessionId,
          kind: "result",
        })
      : undefined;

    if (input.outcome === "partial") run.reviewStatus = "pending_user";
    run.state = (
      {
        success: "succeeded",
        partial: "partial",
        failure: "failed",
        blocked: "blocked",
        unknown: "uncertain",
      } as const
    )[input.outcome];
    run.updatedAt = this.now();
    this.saveRun(run);
    attempt.state = input.outcome === "unknown" ? "uncertain" : "settled";
    attempt.updatedAt = this.now();
    this.saveAttempt(attempt);
    if (input.outcome !== "unknown")
      this.db
        .prepare("DELETE FROM resources WHERE attempt_id=?")
        .run(attempt.attemptId);
    const task = this.getTask(run.taskId);
    this.projectTaskState(task, run);
    const notifications = [...(input.notifications ?? [])];
    const narrative = (run.configuration as { reporting?: string } | null)
      ?.reporting;
    const childNotification =
      (run.configuration as { notifyUserOnTerminal?: boolean } | null)
        ?.notifyUserOnTerminal === true;
    if (
      narrative !== "none" &&
      task.admissionState !== "dismissed" &&
      (!task.parentTaskId || childNotification)
    ) {
      for (const destination of this.options.reportDestinations ?? []) {
        if (!notifications.some((n) => n.destination === destination))
          notifications.push({
            destination,
            kind: report ? "report" : "task-state",
            payload: {
              runId: run.runId,
              reporting: narrative === "escalate" ? "escalate" : "summary",
            },
          });
      }
    }
    for (const n of notifications) {
      text(n.destination, "destination", 500);
      const delivery: Delivery = {
        deliveryId: randomUUID(),
        taskId: task.taskId,
        runId: run.runId,
        ...(report ? { reportId: report.reportId } : {}),
        destination: n.destination,
        kind: n.kind,
        payload: n.payload,
        state: "pending",
        attempts: 0,
        nextAttemptAt: this.now(),
      };
      this.put(
        "delivery",
        delivery.deliveryId,
        delivery,
        task.taskId,
        delivery.state,
      );
    }
    this.lifecycleDelivery(task, run);
    this.event(
      "run.settled",
      {
        outcome: input.outcome,
        summary: input.summary,
        attemptId: attempt.attemptId,
      },
      task.taskId,
      run.runId,
    );
    return run;
  }
  cancel(
    commandId: string,
    input: { taskId: string; runId?: string; reason: string },
  ) {
    this.planner();
    return this.command(commandId, "cancel", input, () => {
      const task = this.getTask(input.taskId);
      if (task.kind === "observed")
        fail(
          "OBSERVE_ONLY",
          "Cannot cancel an execution only observed by this ledger",
        );
      const runs = input.runId
        ? [this.getRun(input.runId)]
        : this.list<Run>("run", task.taskId).filter(
            (r) => !(r.historyOnly || r.observationOnly),
          );
      let changed = false;
      for (const run of runs) {
        if (run.historyOnly || run.observationOnly)
          fail("OBSERVE_ONLY", "Cannot cancel historical observed execution");
        if (run.taskId !== task.taskId)
          fail("FORBIDDEN", "Run belongs to different task");
        if (TERMINAL.has(run.state)) continue;
        changed = true;
        run.cancellationRequested = true;
        if (!run.currentAttemptId) run.state = "cancelled";
        run.updatedAt = this.now();
        this.saveRun(run);
        if (!run.currentAttemptId) this.lifecycleDelivery(task, run);
      }
      if (input.runId && !changed) return task;
      if (!input.runId) {
        task.state = "cancelled";
        for (const schedule of this.list<Schedule>("schedule", task.taskId)) {
          schedule.enabled = false;
          this.put("schedule", schedule.scheduleId, schedule, task.taskId);
        }
      } else {
        const others = this.list<Run>("run", task.taskId).filter(
          (r) =>
            r.runId !== input.runId &&
            !(r.historyOnly || r.observationOnly) &&
            !TERMINAL.has(r.state) &&
            !r.cancellationRequested,
        );
        task.state = others.some((r) => r.state === "running")
          ? "running"
          : others.some((r) => r.state === "queued")
            ? "ready"
            : "waiting";
      }
      task.updatedAt = this.now();
      this.saveTask(task);
      this.event(
        input.runId
          ? "run.cancellation_requested"
          : "task.cancellation_requested",
        { reason: text(input.reason, "reason", 1000) },
        task.taskId,
        input.runId,
      );
      return task;
    });
  }
  acknowledgeCancellation(commandId: string, ref: LeaseRef) {
    return this.command(commandId, "acknowledgeCancellation", ref, () => {
      if (
        (this.role === "planner" && ref.nodeId === this.nodeId) ||
        (this.role === "executor" && ref.nodeId !== this.nodeId)
      )
        fail("FORBIDDEN", "Role cannot acknowledge execution on this node");
      const run = this.getRun(ref.runId);
      const a = this.getAttempt(ref.attemptId);
      if (a.executionId && a.executionId !== ref.executionId)
        fail(
          "EXECUTION_OWNER",
          "Attempt belongs to another execution instance",
        );
      if (
        !run.cancellationRequested ||
        a.runId !== run.runId ||
        run.currentAttemptId !== a.attemptId ||
        a.nodeId !== ref.nodeId ||
        a.fence !== ref.fence
      )
        fail("FORBIDDEN", "Cancellation acknowledgment mismatch");
      if (a.state === "settled") fail("TERMINAL", "Attempt already settled");
      run.state = "cancelled";
      run.updatedAt = this.now();
      this.saveRun(run);
      a.state = "cancelled";
      a.updatedAt = this.now();
      this.saveAttempt(a);
      this.db
        .prepare("DELETE FROM resources WHERE attempt_id=?")
        .run(a.attemptId);
      this.lifecycleDelivery(this.getTask(run.taskId), run);
      this.event(
        "run.cancellation_confirmed",
        { attemptId: a.attemptId },
        run.taskId,
        run.runId,
      );
      return run;
    });
  }
  resolveUncertain(
    commandId: string,
    input: { runId: string; outcome: "cancelled" | "failed"; reason: string },
  ) {
    this.planner();
    return this.command(commandId, "resolveUncertain", input, () => {
      const run = this.getRun(input.runId);
      if (run.historyOnly || run.observationOnly)
        fail(
          "OBSERVE_ONLY",
          "Historical evidence is reviewed through new reports, not execution reconciliation",
        );
      if (run.state !== "uncertain") fail("CONFLICT", "Run is not uncertain");
      if (!["cancelled", "failed"].includes(input.outcome))
        fail("INVALID", "Invalid reconciliation");
      run.state = input.outcome;
      run.updatedAt = this.now();
      this.saveRun(run);
      if (run.currentAttemptId)
        this.db
          .prepare("DELETE FROM resources WHERE attempt_id=?")
          .run(run.currentAttemptId);
      this.lifecycleDelivery(this.getTask(run.taskId), run);
      this.event(
        "run.reconciled",
        { reason: text(input.reason, "reason", 1000), outcome: input.outcome },
        run.taskId,
        run.runId,
      );
      return run;
    });
  }
  recoveryNeeded() {
    return (
      this.list<Attempt>("attempt").some(
        (a) =>
          ["leased", "running"].includes(a.state) &&
          Date.parse(a.leaseExpiresAt) <= this.clock(),
      ) ||
      this.list<Delivery>("delivery").some(
        (d) =>
          d.state === "sending" &&
          Date.parse(d.leaseExpiresAt ?? "") <= this.clock(),
      )
    );
  }
  recoverExpired(commandId: string) {
    return this.command(commandId, "recoverExpired", {}, () => {
      const expired: Attempt[] = [];
      for (const a of this.list<Attempt>("attempt")) {
        if (
          !["leased", "running"].includes(a.state) ||
          Date.parse(a.leaseExpiresAt) > this.clock()
        )
          continue;
        a.state = "uncertain";
        a.updatedAt = this.now();
        this.saveAttempt(a);
        const run = this.getRun(a.runId);
        if (run.currentAttemptId === a.attemptId && !TERMINAL.has(run.state)) {
          run.state = "uncertain";

          run.updatedAt = this.now();
          this.saveRun(run);
          const t = this.getTask(run.taskId);
          t.state = "waiting";
          t.updatedAt = this.now();
          this.saveTask(t);
          this.event(
            "attempt.expired",
            { attemptId: a.attemptId, policy: "reconcile-before-retry" },
            t.taskId,
            run.runId,
          );
        }
        expired.push(a);
      }
      for (const d of this.list<Delivery>("delivery")) {
        if (
          d.state === "sending" &&
          Date.parse(d.leaseExpiresAt ?? "") <= this.clock()
        ) {
          d.state = "uncertain";
          this.put("delivery", d.deliveryId, d, d.taskId, d.state);
        }
      }
      return { expired };
    });
  }
  /** Reassignment requires a new, explicitly authorized run; never automatically replay an uncertain effect. */
  captureObservation(commandId: string, input: CapturedText) {
    return this.command(commandId, "captureObservation", input, () => {
      const candidateId = hash({
        sourceId: input.sourceId,
        sourceRevision: input.sourceRevision,
      });
      const old = this.get<ObservationCandidate>("candidate", candidateId);
      if (old) {
        if (
          old.body !== input.body ||
          old.sessionId !== input.sessionId ||
          old.cwd !== input.cwd
        )
          fail("CONFLICT", "Observed source revision changed");
        return old;
      }
      const candidate: ObservationCandidate = {
        candidateId,
        sourceId: text(input.sourceId, "source", 500),
        sourceRevision: text(input.sourceRevision, "revision", 100),
        sessionId: id(input.sessionId),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        title: text(input.title, "title", 500),
        body: text(input.body, "observed text", 8000),
        observedAt: input.observedAt,
        truncated: input.truncated,
        state: "pending",
      };
      this.put("candidate", candidateId, candidate);
      return candidate;
    });
  }
  observationCandidates(state?: ObservationCandidate["state"]) {
    return this.list<ObservationCandidate>("candidate").filter(
      (c) => !state || c.state === state,
    );
  }
  admitObservation(
    commandId: string,
    input: {
      candidateId: string;
      action: "ignore" | "create" | "attach";
      taskId?: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "admitObservation", input, () => {
      const c = this.need<ObservationCandidate>("candidate", input.candidateId);
      if (c.state !== "pending")
        fail("CONFLICT", "Observation already decided");
      if (input.action === "ignore") {
        c.state = "ignored";
        this.put("candidate", c.candidateId, c);
        this.event("observation.ignored", { candidateId: c.candidateId });
        return c;
      }
      if (!["create", "attach"].includes(input.action))
        fail("INVALID", "Invalid observation action");
      const task =
        input.action === "attach"
          ? this.getTask(
              input.taskId ?? fail("INVALID", "Attachment task required"),
            )
          : this.newTask({ title: c.title, kind: "observed" });
      const report = this.report({
        taskId: task.taskId,
        sessionId: c.sessionId,
        title: c.title,
        body: c.body,
        createdAt: c.observedAt,
        kind: "observation",
      });
      c.state = "admitted";
      c.taskId = task.taskId;
      c.reportId = report.reportId;
      this.put("candidate", c.candidateId, c);
      this.event(
        "observation.admitted",
        { candidateId: c.candidateId },
        task.taskId,
      );
      return c;
    });
  }
  recordObservationGap(
    commandId: string,
    input: { sessionId: string; dropped: number; asOfSeq: number },
  ) {
    return this.command(commandId, "recordObservationGap", input, () => {
      this.event("observation.catchup_gap", input);
      return input;
    });
  }
  observe(
    commandId: string,
    input: {
      sourceId: string;
      sourceRevision: string;
      taskId?: string;
      title: string;
      body: string;
      sessionId?: string;
      observedAt?: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "observe", input, () => {
      const bindingKey = hash({
        sourceId: input.sourceId,
        sourceRevision: input.sourceRevision,
      });
      const prior = this.get<{
        digest: string;
        taskId: string;
        reportId: string;
      }>("observation", bindingKey);
      const digest = hash(input);
      if (prior) {
        if (prior.digest !== digest)
          fail("CONFLICT", "Observation revision content changed");
        return prior;
      }
      const task = input.taskId
        ? this.getTask(input.taskId)
        : this.newTask({ title: input.title, kind: "observed" });
      const report = this.report({
        taskId: task.taskId,
        title: input.title,
        body: input.body,
        sessionId: input.sessionId,
        createdAt: input.observedAt,
        kind: "observation",
      });
      const binding = {
        digest,
        taskId: task.taskId,
        reportId: report.reportId,
      };
      this.put("observation", bindingKey, binding, task.taskId);
      return binding;
    });
  }
  reviewRun(
    commandId: string,
    input: { runId: string; decision: "accepted" | "rejected"; reason: string },
  ) {
    this.planner();
    return this.command(commandId, "reviewRun", input, () => {
      const run = this.getRun(input.runId);
      if (run.reviewStatus !== "pending_user")
        fail("CONFLICT", "Run is not awaiting review");
      if (!["accepted", "rejected"].includes(input.decision))
        fail("INVALID", "Invalid review");
      run.reviewStatus = input.decision;
      run.updatedAt = this.now();
      this.saveRun(run);
      this.event(
        "run.reviewed",
        {
          decision: input.decision,
          reason: text(input.reason, "review reason", 1000),
          originalState: run.state,
        },
        run.taskId,
        run.runId,
      );
      return run;
    });
  }
  continueRun(commandId: string, input: { taskId: string; runId: string }) {
    this.planner();
    return this.command(commandId, "continueRun", input, () => {
      const task = this.getTask(input.taskId);
      const prior = this.getRun(input.runId);
      const runs = this.list<Run>("run", task.taskId);
      if (
        prior.taskId !== task.taskId ||
        prior.state !== "blocked" ||
        runs.at(-1)?.runId !== prior.runId ||
        runs.some((r) => r.runId !== prior.runId && !TERMINAL.has(r.state))
      )
        fail("CONFLICT", "Only the current blocked run can be continued");
      const run = this.newRun({
        taskId: task.taskId,
        route: prior.route,
        sessionIds: prior.sessionIds,
        contextNotes: prior.contextNotes,
        configuration: {
          ...(prior.configuration &&
          typeof prior.configuration === "object" &&
          !Array.isArray(prior.configuration)
            ? prior.configuration
            : {}),
          continuationOf: prior.runId,
        },
      });
      this.event(
        "run.continued",
        { previousRunId: prior.runId },
        task.taskId,
        run.runId,
      );
      return run;
    });
  }
  decisionCatalog() {
    return {
      tasks: this.list<Task>("task").filter(
        (t) => t.admissionState !== "dismissed",
      ),
      nodes: this.list<NodeCapability>("node"),
      workspaces: this.list<Workspace>("workspace"),
    };
  }
  commandReceipt<T = Json>(commandId: string): Receipt<T> | undefined {
    const row = this.db
      .prepare("SELECT receipt FROM commands WHERE id=?")
      .get(commandId) as { receipt: string } | undefined;
    return row ? JSON.parse(row.receipt) : undefined;
  }
  getDecision(decisionId: string) {
    return this.get<{
      decisionId: string;
      inputDigest: string;
      receipt: Json;
      proposal: Json;
      stateHash: string;
      validUntil: number;
      input: Json;
    }>("decision", decisionId);
  }
  recordDecision(
    commandId: string,
    input: {
      decisionId: string;
      inputDigest: string;
      receipt: Json;
      proposal: Json;
      stateHash: string;
      validUntil: number;
      input: Json;
    },
  ) {
    this.planner();
    return this.command(commandId, "recordDecision", input, () => {
      id(input.decisionId);
      if (this.get("decision", input.decisionId))
        fail("CONFLICT", "Decision receipt is immutable");
      this.put("decision", input.decisionId, input);
      this.event("decision.recorded", {
        decisionId: input.decisionId,
        stateHash: input.stateHash,
      });
      return input;
    });
  }
  applyDecision(
    commandId: string,
    input: {
      decisionId: string;
      currentStateHash: string;
      title: string;
      description: string;
      attachTaskId?: string;
      persistence: "ignore" | "create" | "attach";
      route?: ExecutionRoute;
      reporting: "none" | "summary" | "escalate";
    },
  ) {
    this.planner();
    return this.command(commandId, "applyDecision", input, () => {
      const decision =
        this.getDecision(input.decisionId) ??
        fail("NOT_FOUND", "Decision not found");
      if (
        decision.stateHash !== input.currentStateHash ||
        decision.validUntil <= this.clock()
      )
        fail("STALE_DECISION", "Decision catalog expired or changed");
      const proposal = decision.proposal as Record<string, Json>;
      if (
        proposal.kind !== "proposal" ||
        proposal.persistence !== input.persistence
      )
        fail("CONFLICT", "Applied decision does not match recorded proposal");
      const expectedExecutor = proposal.executor as { id?: string } | null;
      const expectedRoute = proposal.modelRoute as {
        provider?: string;
        model?: string;
        reasoningEffort?: string;
      } | null;
      const expectedWorkspace = proposal.workspace as {
        action?: string;
        workspaceRef?: string;
      } | null;
      const expectedReporting = proposal.reporting as {
        narrative?: string;
      } | null;
      if (expectedReporting?.narrative !== input.reporting)
        fail("CONFLICT", "Reporting decision changed");
      if (input.route) {
        if (
          input.route.nodeId !== expectedExecutor?.id ||
          input.route.provider !== expectedRoute?.provider ||
          input.route.model !== expectedRoute?.model ||
          input.route.reasoningEffort !== expectedRoute?.reasoningEffort ||
          input.route.workspaceId !== expectedWorkspace?.workspaceRef ||
          expectedWorkspace?.action === "create"
        )
          fail("CONFLICT", "Execution route differs from recorded decision");
      } else if (expectedExecutor || expectedRoute)
        fail("CONFLICT", "Recorded execution route omitted");
      if (input.persistence === "ignore") {
        if (input.route) fail("INVALID", "Ignored work cannot execute");
        return { ignored: true };
      }
      const task =
        input.persistence === "attach"
          ? this.getTask(
              input.attachTaskId ?? fail("INVALID", "Missing attachment task"),
            )
          : this.newTask({
              title: input.title,
              description: input.description,
              workspaceId: input.route?.workspaceId,
            });
      if (
        input.persistence === "attach" &&
        proposal.attachTaskId !== task.taskId
      )
        fail("CONFLICT", "Attachment differs from decision");
      if (task.kind === "observed" && input.route) {
        const originalInput = decision.input as Record<string, Json>;
        if (originalInput.observationCandidateId)
          fail(
            "OBSERVE_ONLY",
            "Observation admission cannot authorize execution",
          );
        task.kind = "ad_hoc";
        task.state = "ready";
        task.updatedAt = this.now();
        this.saveTask(task);
        this.event(
          "task.explicit_continuation",
          { decisionId: input.decisionId, priorKind: "observed" },
          task.taskId,
        );
      }
      const report = this.report({
        taskId: task.taskId,
        title: "Task request",
        body: input.description || input.title,
        kind: "progress",
      });
      const run = input.route
        ? this.newRun({
            taskId: task.taskId,
            route: input.route,
            configuration: {
              decisionId: input.decisionId,
              reporting: input.reporting,
            },
          })
        : undefined;
      this.event(
        "decision.applied",
        {
          decisionId: input.decisionId,
          reporting: input.reporting,
          protocolReceiptRequired: true,
        },
        task.taskId,
        run?.runId,
      );
      return {
        taskId: task.taskId,
        reportId: report.reportId,
        ...(run ? { runId: run.runId } : {}),
      };
    });
  }
  private validateTemplate(template: Template) {
    id(template.templateId);
    finite(template.version, 1, 1e6, "template version");
    text(template.name, "template name", 500);
    if (template.resultValidator !== undefined)
      id(template.resultValidator, "validator ID");
    canonicalData(template.defaults);
    try {
      canonicalSchema(template.inputSchema);
      canonicalSchema(template.resultContract);
      schemaValidator.compile(template.inputSchema as object);
      schemaValidator.compile(template.resultContract as object);
    } catch {
      fail(
        "INVALID_SCHEMA",
        "Template schemas must be valid bounded local JSON schemas",
      );
    }
    if (!Number.isInteger(template.version))
      fail("INVALID", "Template version must be an integer");
  }
  updateTemplate(commandId: string, template: Template) {
    this.planner();
    return this.command(commandId, "updateTemplate", template, () => {
      this.validateTemplate(template);
      const key = `${template.templateId}@${template.version}`;
      if (this.get("template", key))
        fail("CONFLICT", "Template versions are immutable");
      this.put("template", key, template, template.templateId);
      return template;
    });
  }
  private validateSchedule(schedule: Schedule) {
    id(schedule.scheduleId);
    if (typeof schedule.enabled !== "boolean")
      fail("INVALID", "Schedule enabled must be boolean");
    const task = this.getTask(schedule.taskId);
    if (task.kind === "observed")
      fail("OBSERVE_ONLY", "Observed tasks cannot be scheduled");
    const template = this.getTemplate(
      schedule.templateId,
      schedule.templateVersion,
    );
    validateSchema(template.inputSchema, schedule.input, "Schedule input");
    if (schedule.route) this.validateRoute(schedule.route);
    if (Boolean(schedule.cron) === (schedule.intervalMs !== undefined))
      fail("INVALID", "Choose cron or intervalMs");
    if (schedule.intervalMs !== undefined)
      finite(schedule.intervalMs, 1000, 366 * 86400_000, "schedule interval");
    if (!Number.isFinite(Date.parse(schedule.nextDueAt)))
      fail("INVALID", "Invalid due date");
    if (schedule.cron) {
      try {
        CronExpressionParser.parse(schedule.cron, {
          tz: schedule.timeZone ?? "UTC",
          currentDate: schedule.nextDueAt,
        });
      } catch {
        fail("INVALID", "Invalid cron/time zone");
      }
    }
    if (
      !["skip", "queue"].includes(schedule.overlap) ||
      !["once", "skip", "all"].includes(schedule.misfire ?? "once")
    )
      fail("INVALID", "Invalid overlap/misfire policy");
    return task;
  }
  createSchedule(commandId: string, schedule: Schedule) {
    this.planner();
    return this.command(commandId, "createSchedule", schedule, () => {
      const task = this.validateSchedule(schedule);
      if (this.get("schedule", schedule.scheduleId))
        fail("CONFLICT", "Schedule exists");
      const saved = {
        ...schedule,
        revision: 1,
        misfire: schedule.misfire ?? "once",
      };
      this.put("schedule", saved.scheduleId, saved, task.taskId);
      task.kind = "scheduled";
      this.saveTask(task);
      return saved;
    });
  }
  updateSchedule(
    commandId: string,
    input: {
      scheduleId: string;
      expectedRevision: number;
      changes: Partial<
        Omit<Schedule, "scheduleId" | "taskId" | "revision" | "retiredAt">
      >;
    },
  ) {
    this.planner();
    return this.command(commandId, "updateSchedule", input, () => {
      const prior = this.getSchedule(input.scheduleId);
      if (prior.retiredAt || prior.revision !== input.expectedRevision)
        fail("CONFLICT", "Stale or retired schedule");
      const allowed = [
        "templateId",
        "templateVersion",
        "enabled",
        "intervalMs",
        "cron",
        "timeZone",
        "nextDueAt",
        "overlap",
        "misfire",
        "input",
        "route",
      ];
      if (Object.keys(input.changes).some((k) => !allowed.includes(k)))
        fail("INVALID", "Invalid schedule field");
      const next = {
        ...prior,
        ...input.changes,
        revision: input.expectedRevision + 1,
      };
      if (input.changes.cron !== undefined) delete next.intervalMs;
      if (input.changes.intervalMs !== undefined) {
        delete next.cron;
        delete next.timeZone;
      }
      this.validateSchedule(next);
      this.put("schedule", next.scheduleId, next, next.taskId);
      this.event(
        "schedule.updated",
        { previous: prior as unknown as Json, next: next as unknown as Json },
        next.taskId,
      );
      return next;
    });
  }
  retireSchedule(commandId: string, input: { scheduleId: string }) {
    this.planner();
    return this.command(commandId, "retireSchedule", input, () => {
      const s = this.getSchedule(input.scheduleId);
      s.enabled = false;
      s.retiredAt = this.now();
      this.put("schedule", s.scheduleId, s, s.taskId);
      this.event("schedule.retired", { scheduleId: s.scheduleId }, s.taskId);
      return s;
    });
  }
  setScheduleEnabled(
    commandId: string,
    input: { scheduleId: string; enabled: boolean },
  ) {
    this.planner();
    return this.command(commandId, "setScheduleEnabled", input, () => {
      const s = this.getSchedule(input.scheduleId);
      if (typeof input.enabled !== "boolean")
        fail("INVALID", "Schedule enabled must be boolean");
      if (s.retiredAt) fail("CONFLICT", "Schedule retired");
      s.enabled = input.enabled;
      this.put("schedule", s.scheduleId, s, s.taskId);
      return s;
    });
  }
  fireSchedule(
    commandId: string,
    input: { scheduleId: string; occurrenceAt: string; route?: ExecutionRoute },
  ) {
    this.planner();
    return this.command(commandId, "fireSchedule", input, () => {
      const s = this.getSchedule(input.scheduleId);
      if (!s.enabled) fail("DISABLED", "Schedule disabled");
      if (!Number.isFinite(Date.parse(input.occurrenceAt)))
        fail("INVALID", "Invalid occurrence date");
      const key = hash({
        scheduleId: s.scheduleId,
        occurrenceAt: input.occurrenceAt,
      });
      const old = this.get<{
        occurrenceId: string;
        runId?: string;
        status: string;
      }>("occurrence", key);
      if (old) return old;
      if (input.occurrenceAt !== s.nextDueAt)
        fail(
          "STALE_SCHEDULE",
          "Occurrence does not match current scheduled slot",
        );
      if (Date.parse(input.occurrenceAt) > this.clock())
        fail("NOT_DUE", "Occurrence not due");
      const nextSlot = s.cron
        ? CronExpressionParser.parse(s.cron, {
            tz: s.timeZone ?? "UTC",
            currentDate: s.nextDueAt,
          })
            .next()
            .toISOString()!
        : new Date(Date.parse(s.nextDueAt) + (s.intervalMs ?? 0)).toISOString();
      const missed = Date.parse(nextSlot) <= this.clock();
      const skipMisfire = missed && s.misfire === "skip";
      const active = this.list<Run>("run", s.taskId).some(
        (r) => !TERMINAL.has(r.state),
      );
      let run: Run | undefined;
      const template = this.getTemplate(s.templateId, s.templateVersion);
      if (!skipMisfire && !(active && s.overlap === "skip"))
        run = this.newRun({
          taskId: s.taskId,
          route: input.route ?? s.route,
          occurrenceId: key,
          configuration: {
            templateRef: {
              templateId: template.templateId,
              version: template.version,
            },
            input: s.input,
            trigger: {
              scheduledFor: input.occurrenceAt,
              observedAt: this.now(),
              ...(missed ? { coalescedUntil: this.now() } : {}),
            },
          },
        });
      const occurrence = {
        occurrenceId: key,
        ...(run ? { runId: run.runId } : {}),
        status: run
          ? "admitted"
          : skipMisfire
            ? "skipped-misfire"
            : "skipped-overlap",
      };
      this.put("occurrence", key, occurrence, s.scheduleId);
      s.nextDueAt =
        missed && (s.misfire ?? "once") !== "all"
          ? s.cron
            ? CronExpressionParser.parse(s.cron, {
                tz: s.timeZone ?? "UTC",
                currentDate: this.now(),
              })
                .next()
                .toISOString()!
            : new Date(
                Date.parse(s.nextDueAt) +
                  (Math.floor(
                    (this.clock() - Date.parse(s.nextDueAt)) /
                      (s.intervalMs ?? 1),
                  ) +
                    1) *
                    (s.intervalMs ?? 1),
              ).toISOString()
          : nextSlot;
      this.put("schedule", s.scheduleId, s, s.taskId);
      this.event("schedule.occurrence", occurrence, s.taskId, run?.runId);
      return occurrence;
    });
  }
  pendingRuns(nodeId: string) {
    id(nodeId);
    const tasks = new Map(this.list<Task>("task").map((t) => [t.taskId, t]));
    return this.list<Run>("run")
      .filter(
        (r) =>
          r.state === "queued" &&
          (!r.retry || Date.parse(r.retry.notBefore) <= this.clock()) &&
          r.route?.nodeId === nodeId &&
          !(r.historyOnly || r.observationOnly) &&
          tasks.get(r.taskId)?.kind !== "observed" &&
          !["candidate", "cancelled", "archived"].includes(
            tasks.get(r.taskId)!.state,
          ) &&
          !r.cancellationRequested &&
          this.confirmationAllows(tasks.get(r.taskId)!),
      )
      .sort((a, b) => {
        const left = tasks.get(a.taskId)!,
          right = tasks.get(b.taskId)!;
        return (
          ["low", "normal", "high", "urgent"].indexOf(
            right.priority ?? "normal",
          ) -
            ["low", "normal", "high", "urgent"].indexOf(
              left.priority ?? "normal",
            ) ||
          left.createdAt.localeCompare(right.createdAt) ||
          a.createdAt.localeCompare(b.createdAt)
        );
      });
  }
  scheduleDue() {
    return this.list<Schedule>("schedule").filter(
      (s) =>
        s.enabled &&
        !s.retiredAt &&
        !["cancelled", "archived"].includes(this.getTask(s.taskId).state) &&
        Date.parse(s.nextDueAt) <= this.clock(),
    );
  }
  claimDelivery(
    commandId: string,
    input: { deliveryId: string; ttlMs: number },
  ) {
    return this.command(commandId, "claimDelivery", input, () => {
      finite(input.ttlMs, 100, 300_000, "delivery lease");
      const d = this.need<Delivery>("delivery", input.deliveryId);
      if (d.state === "sent") fail("TERMINAL", "Already sent");
      if (
        d.state === "sending" &&
        Date.parse(d.leaseExpiresAt ?? "") > this.clock()
      )
        fail("BUSY", "Delivery claimed");
      if (d.state === "sending") {
        d.state = "uncertain";
        this.put("delivery", d.deliveryId, d, d.taskId, d.state);
        fail("UNCERTAIN", "Prior send requires reconciliation");
      }
      if (d.state === "uncertain")
        fail("UNCERTAIN", "Unknown delivery must be reconciled");
      if (Date.parse(d.nextAttemptAt) > this.clock())
        fail("NOT_DUE", "Delivery retry not due");
      d.state = "sending";
      d.claimToken = randomUUID();
      d.leaseExpiresAt = new Date(this.clock() + input.ttlMs).toISOString();
      d.attempts++;
      this.put("delivery", d.deliveryId, d, d.taskId, d.state);
      return d;
    });
  }
  finishDelivery(
    commandId: string,
    input: {
      deliveryId: string;
      claimToken: string;
      status: "sent" | "failed" | "uncertain";
      receipt?: Json;
      retryAfterMs?: number;
    },
  ) {
    return this.command(commandId, "finishDelivery", input, () => {
      const d = this.need<Delivery>("delivery", input.deliveryId);
      if (d.state !== "sending" || d.claimToken !== input.claimToken)
        fail("STALE_ASSIGNMENT", "Delivery claim mismatch");
      d.state = input.status;
      d.receipt = input.receipt;
      d.nextAttemptAt = new Date(
        this.clock() +
          finite(input.retryAfterMs ?? 1000, 0, 86_400_000, "retry delay"),
      ).toISOString();
      delete d.claimToken;
      delete d.leaseExpiresAt;
      this.put("delivery", d.deliveryId, d, d.taskId, d.state);
      this.event(
        "delivery." + input.status,
        { deliveryId: d.deliveryId },
        d.taskId,
      );
      return d;
    });
  }
  reconcileDelivery(
    commandId: string,
    input: {
      deliveryId: string;
      status: "sent" | "failed";
      reason: string;
      receipt?: Json;
    },
  ) {
    this.planner();
    return this.command(commandId, "reconcileDelivery", input, () => {
      const d = this.need<Delivery>("delivery", input.deliveryId);
      if (d.state !== "uncertain")
        fail("CONFLICT", "Only uncertain delivery needs reconciliation");
      if (!["sent", "failed"].includes(input.status))
        fail("INVALID", "Invalid reconciled status");
      text(input.reason, "reconciliation reason", 1000);
      d.state = input.status;
      d.receipt = input.receipt;
      d.nextAttemptAt = this.now();
      delete d.claimToken;
      delete d.leaseExpiresAt;
      this.put("delivery", d.deliveryId, d, d.taskId, d.state);
      this.event(
        "delivery.reconciled",
        { deliveryId: d.deliveryId, status: d.state, reason: input.reason },
        d.taskId,
      );
      return d;
    });
  }
  deliveries() {
    return this.list<Delivery>("delivery");
  }
  history(taskId: string) {
    return {
      task: this.getTask(taskId),
      runs: this.list<Run>("run", taskId),
      reports: this.list<Report>("report", taskId),
      artifacts: this.list<Artifact>("artifact", taskId),
      events: (
        this.db
          .prepare("SELECT data FROM events WHERE task_id=? ORDER BY seq")
          .all(taskId) as { data: string }[]
      ).map((x) => JSON.parse(x.data) as Event),
    };
  }
  allSettled(taskId: string, quietMs = 1000, rootRunId?: string) {
    finite(quietMs, 0, 300000, "quiet window");
    this.getTask(taskId);
    const scope = rootRunId
      ? this.executionScope(taskId, rootRunId)
      : undefined;
    const tasks = scope?.tasks ?? this.descendants(taskId),
      ids = new Set(tasks.map((t) => t.taskId));
    const runs =
      scope?.runs ?? this.list<Run>("run").filter((r) => ids.has(r.taskId));
    const pending = runs.filter(
      (r) =>
        !(r.historyOnly || r.observationOnly) &&
        (!TERMINAL.has(r.state) || r.state === "uncertain"),
    );
    const unstarted = tasks.filter(
      (t) =>
        t.kind !== "observed" &&
        !runs.some((r) => r.taskId === t.taskId) &&
        !["completed", "failed", "cancelled", "archived"].includes(t.state),
    );
    const latest = Math.max(
      0,
      ...runs.map((r) => Date.parse(r.updatedAt)),
      ...tasks.map((t) => Date.parse(t.updatedAt)),
    );
    return {
      settled:
        pending.length === 0 &&
        unstarted.length === 0 &&
        this.clock() - latest >= quietMs,
      pendingRunIds: pending.map((r) => r.runId),
      pendingTaskIds: unstarted.map((t) => t.taskId),
      taskIds: [...ids],
      quietUntil: new Date(latest + quietMs).toISOString(),
    };
  }
  snapshot(): Snapshot {
    return {
      schemaVersion: "1",
      generatedAt: this.now(),
      source: this.get<Source>("meta", "source") ?? {
        kind: "task-system",
        label: "Task ledger",
        observedAt: this.now(),
        staleAfterMs: 60_000,
      },
      tasks: this.list<Task>("task"),
      runs: this.list<Run>("run"),
      attempts: this.list<Attempt>("attempt"),
      reports: this.list<Report>("report"),
      artifacts: this.list<Artifact>("artifact"),
      templates: this.list<Template>("template"),
      events: (
        this.db.prepare("SELECT data FROM events ORDER BY seq").all() as {
          data: string;
        }[]
      ).map((x) => JSON.parse(x.data) as Event),
      workspaces: this.list<Workspace>("workspace"),
      alerts: this.alerts({ includeResolved: true }),
      approvals: this.approvals(),
      nodeStatuses: this.nodeStatuses(),
      schedules: this.list<Schedule>("schedule"),
    };
  }
  /** Normal management/report view. The raw snapshot remains a complete export. */
  querySnapshot(options: { includeDismissed?: boolean } = {}): Snapshot {
    const snapshot = this.snapshot();
    if (options.includeDismissed) return snapshot;
    const tasks = snapshot.tasks.filter(
      (task) => task.admissionState !== "dismissed",
    );
    const ids = new Set(tasks.map((task) => task.taskId));
    return {
      ...snapshot,
      tasks,
      runs: snapshot.runs.filter((run) => ids.has(run.taskId)),
      reports: snapshot.reports.filter((report) => ids.has(report.taskId)),
      artifacts: snapshot.artifacts.filter((artifact) =>
        ids.has(artifact.taskId),
      ),
      events: snapshot.events.filter(
        (event) => !event.taskId || ids.has(event.taskId),
      ),
      schedules: snapshot.schedules?.filter((schedule) =>
        ids.has(schedule.taskId),
      ),
    };
  }
  /** Operator-only explicit imports. Not exposed as a model tool or a peer endpoint. */
  importSnapshot(commandId: string, input: Snapshot) {
    this.planner();
    return this.command(commandId, "importSnapshot", input, () => {
      if (
        input.schemaVersion !== "1" ||
        input.source.kind !== "explicit-import"
      )
        fail("INVALID", "Only explicit versioned imports accepted");
      if (!Number.isFinite(Date.parse(input.source.observedAt)))
        fail("INVALID", "Invalid source timestamp");
      for (const task of input.tasks) {
        id(task.taskId);
        text(task.title, "title", 500);
        const old = this.get<Task>("task", task.taskId);
        if (old && old.kind !== "observed")
          fail("CONFLICT", "Import cannot overwrite managed tasks");
        this.saveTask({
          ...task,
          kind: "observed",
          ...(old
            ? {
                admissionState: old.admissionState ?? "admitted",
                admissionRevision: old.admissionRevision ?? 1,
              }
            : {}),
        });
      }
      for (const run of input.runs) {
        this.getTask(run.taskId);
        const historicalRun = { ...run, historyOnly: true };
        if (
          this.get("run", run.runId) &&
          hash(this.get("run", run.runId)) !== hash(historicalRun)
        )
          fail("CONFLICT", "Imported run version changed");
        this.saveRun(historicalRun);
      }
      for (const report of input.reports) {
        const old = this.get<Report>("report", report.reportId);
        if (old) {
          if (hash(old) !== hash(report))
            fail("CONFLICT", "Imported report immutable");
          continue;
        }
        this.getTask(report.taskId);
        this.put("report", report.reportId, report, report.taskId);
      }
      for (const artifact of input.artifacts) {
        const old = this.get<Artifact>("artifact", artifact.artifactId);
        if (old && hash(old) !== hash(artifact))
          fail("CONFLICT", "Imported artifact immutable");
        this.put("artifact", artifact.artifactId, artifact, artifact.taskId);
      }
      for (const e of input.events) {
        if (!this.db.prepare("SELECT id FROM events WHERE id=?").get(e.eventId))
          this.db
            .prepare(
              "INSERT INTO events(id,task_id,run_id,data) VALUES(?,?,?,?)",
            )
            .run(e.eventId, e.taskId ?? null, e.runId ?? null, canonical(e));
      }
      this.put("meta", "source", input.source);
      return { tasks: input.tasks.length, reports: input.reports.length };
    });
  }
}
