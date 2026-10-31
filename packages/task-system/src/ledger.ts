import { CheckinRefs } from "./remote/ports.js";
import { TaskCheckins } from "./task-checkins.js";
import { ArmAcceptanceGate, DecideAcceptanceGate, AmendAcceptanceGate, CreateAcceptanceIndependentTask, AcceptancePlanningIntent, type AcceptanceGate, type AcceptanceGateView, type AcceptanceOperation, type AcceptanceInvocation, type AcceptanceMember, type AcceptanceStep } from "./acceptance-gates.js";
import { ExpectedExecutionMs } from "./execution-expectation.js";
import { ReturnFailure, rateLimited, returnRetryAt } from "./task-return-failure.js";
import { taskRead, type TaskReadOptions } from "./task-reads.js";
import { nodeRead, type NodeReadOptions } from "./node-reads.js";
import { ExecutorAlertStore } from "./executor-alerts.js";
import { ProjectExecutionSettingsStore } from "./project-execution-settings.js";
import { z } from "zod";
import type { WorkflowRunView } from "./workflow-contracts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { ExecutionModels, ExecutionModelChoice, sameExecutionModel } from "./execution-models.js";
import type { CompleteExecutionModels } from "./execution-models.js";
import { pairedExecutorModels } from "./paired-executors.js";
import { ProgramCatalog, ProgramRoute, ScriptExecution } from "./workflow-programs.js";
import type {
  TaskSession,
  TaskSessionContext,
  TaskSessionChoice,
  SelectedTaskSession,
  SessionMessageQuery,
} from "./remote/ports.js";
import {
  canonical as wireCanonical,
  canonicalData,
  canonicalSchema,
  validateResultValidationFailure,
} from "./remote/protocol.js";
import { NATIVE_PROVIDER_UNAVAILABLE_SUMMARY } from "./contracts.js";
import { TRANSIENT_RECEIPT_TTL_MS } from "./receipt-retention.js";
import { scheduleInput } from "./schedule-window.js";
import { runSessionTitle, scheduledTimeZone } from "./task-session-title.js";
import { projectContext } from "./project-context.js";
import { validateCriteria } from "./workbench-contracts.js";
import type { Criterion, VersionRef } from "./workbench-contracts.js";
import { mappedId, validateRegistration } from "./project-registration/protocol.js";
import { Workbench } from "./workbench.js";
import { projectRegistrationToWorkbench } from "./project-registration/workbench.js";
import { intakeRegistration, manageRegistration, type RegistrationRecord } from "./project-registration/intake.js";
import type { ObservationCandidate, CapturedText } from "./observation.js";
import { delegationDisplay, type DelegationDisplayInput } from "./delegation-presentation.js";
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
  ExecutorWorkspaceAnnouncement,
  ExecutorWorkspaceCatalog,
  DispatchOrigin,
  Artifact,
  Alert,
  ApprovalRequest,
  Attempt,
  Claim,
  Delivery,
  Event,
  ExecutionRoute,
  ExecutionContext,
  ProjectExecutionContext,
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

function withExecutionModel(base:ExecutionRoute,choice:ExecutionModelChoice):ExecutionRoute {
  const {provider:_provider,model:_model,reasoningEffort:_effort,backend:_backend,...scope}=base;
  return {...scope,provider:choice.provider,model:choice.model,...(choice.reasoningEffort?{reasoningEffort:choice.reasoningEffort}:{}),...(choice.backend?{backend:choice.backend}:{})};
}
const ExecutorWorkspaceSnapshot = z.object({
  nodeId: z.string().min(1).max(200),
  sampledAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  workspaces: z.array(z.object({
    workspaceId: z.string().min(1).max(200), nodeId: z.string().min(1).max(200),
    label: z.string().max(500), path: z.string().min(1).max(4000),
    state: z.enum(["ready", "unavailable", "revoked"]),
  }).strict()).max(64),
}).strict();
type ExecutorWorkspaceAuthority = {workspaceIds: string[]; grantIds: string[]};
export class TaskError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly validationIssues?: string[],
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
  checkinIntervalMs?: number;
  delegationDefaultDisplay?: "task" | "step";
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
  errors?: string[];
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
export interface DispatcherSession {nodeId:string;sessionId:string;taskId:string;runId:string;projectId:string;cwd:string}
export interface RunInput {
  expectedExecutionMs?: number;
  runId?: string;
  taskId: string;
  parentRunId?: string;
  route?: ExecutionRoute;
  configuration?: Json;
  executionModel?: Run["executionModel"];
  sessionIds?: string[];
  occurrenceId?: string;
  contextNotes?: Run["contextNotes"];
}
export interface ReportInput {
  workflowOutputs?: Report["workflowOutputs"];
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
  workflowRunAdmission?: (run: Run, invocation: {workflowId: string; input: Json}) => void;
  workflowExecutionPreflight?: (workflowId: string) => void;
  workflowTaskConfiguration?: (input: unknown) => import('./workflow-contracts.js').WorkflowTaskBinding;
  workflowOptions?: () => {id: string; title: string; projectId: string}[];
  workflowTaskBound?: (taskId: string) => boolean;
  private hasWorkflowBinding(taskId: string): boolean {
    if (this.workflowTaskBound) return this.workflowTaskBound(taskId);
    const exists=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_task_bindings'").get();
    return !!exists && !!this.db.prepare('SELECT 1 FROM workflow_task_bindings WHERE task_id=?').get(taskId);
  }
  isWorkflowInvocation(run: Run): boolean {
    const config = run.configuration;
    return !!config && typeof config === 'object' && !Array.isArray(config) && !!config.workflowInvocation;
  }
  updateWorkflowRoot(runId: string, state: Run['state']) {
    this.assertManagementWritable();
    const run = this.getRun(runId);
    if (!this.isWorkflowInvocation(run) || run.currentAttemptId || run.route) fail('FORBIDDEN', 'Not a workflow root');
    run.state = state;
    run.updatedAt = this.now();
    this.saveRun(run);
    const task = this.getTask(run.taskId);
    if (!["cancelled", "archived"].includes(task.state)) this.projectTaskState(task, run);
  }
  prepareWorkflowRun(input: RunInput): Run {
    this.assertManagementWritable();
    if (!this.db.isTransaction) fail('FORBIDDEN', 'Workflow admission requires a transaction');
    return this.newRun(input);
  }
  configureWorkflowSchedules(taskId: string, workflowId: string, input: Json) {
    this.assertManagementWritable();
    if (!this.db.isTransaction) fail('FORBIDDEN', 'Workflow configuration requires a transaction');
    for (const schedule of this.list<Schedule>('schedule',taskId)) {
      if (!schedule.execution || schedule.retiredAt) continue;
      if (schedule.execution.workflowId === workflowId && canonical(schedule.input) === canonical(input)) continue;
      schedule.execution={kind:'workflow',workflowId}; schedule.input=structuredClone(input);
      schedule.revision=(schedule.revision ?? 1)+1;
      this.validateSchedule(schedule);
      this.put('schedule',schedule.scheduleId,schedule,taskId);
    }
  }
  prepareWorkflowTask(input: TaskInput): Task {
    this.assertManagementWritable();
    if (!this.db.isTransaction) fail('FORBIDDEN', 'Workflow Task preparation requires a transaction');
    return this.newTask(input);
  }
  adoptWorkflowSchedule(taskId: string, input: {scheduleId: string; workflowId: string; input: Json; cron: string; timeZone: string; nextDueAt: string; enabled: boolean; dayOffset: -1 | 0}): Schedule {
    this.assertManagementWritable();
    if (!this.db.isTransaction) fail('FORBIDDEN', 'Workflow adoption requires a transaction');
    const prior = this.list<Schedule>('schedule', taskId).filter(schedule => !schedule.retiredAt);
    if (prior.length > 1) fail('CONFLICT', 'Task has several active schedules; select one before adoption');
    const templateId = 'panel-workflow-task';
    if (!this.get('template', `${templateId}@1`)) this.put('template', `${templateId}@1`, {templateId,version:1,name:'Workflow invocation',description:'Project workflow',inputSchema:{},defaults:{},resultContract:{}});
    const schedule: Schedule = {...(prior[0] ?? {scheduleId:input.scheduleId,taskId,overlap:'skip',misfire:'once'}),
      templateId,templateVersion:1,execution:{kind:'workflow',workflowId:input.workflowId},input:input.input,
      enabled:input.enabled,cron:input.cron,timeZone:input.timeZone,nextDueAt:input.nextDueAt,
      calendarWindow:{timeZone:input.timeZone,dayOffset:input.dayOffset},revision:(prior[0]?.revision ?? 0)+1};
    delete schedule.route;
    delete schedule.intervalMs;
    this.validateSchedule(schedule);
    this.put('schedule',schedule.scheduleId,schedule,taskId);
    this.event('schedule.workflow_adopted',{scheduleId:schedule.scheduleId,workflowId:input.workflowId},taskId);
    return schedule;
  }
  workflowAtomic<T>(fn: () => T): T {
    this.assertManagementWritable();
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  projectSnapshot?: (nodeId: string) => Json;
  projectCollaborate?: (nodeId: string, commandId: string, input: import("./project-collaboration/types.js").ProjectCollaborationInput) => Json | Promise<Json>;
  readonly role: Role;
  readonly nodeId: string;
  private readonly clock: () => number;
  private readonly dispatchOrigins = new AsyncLocalStorage<DispatchOrigin>();
  private readonly acceptanceOperations = new AsyncLocalStorage<AcceptanceOperation>();
  private readonly acceptanceIndependentOperations = new AsyncLocalStorage<string>();
  private readonly acceptanceSteps = new AsyncLocalStorage<AcceptanceStep>();
  private readonly acceptanceHumans = new AsyncLocalStorage<
    {action: "arm"; reference: string} |
    {action: "amend"; reference: string; gateId: string; expectedRevision: number} |
    {action: "independent"; reference: string; projectId: string} |
    {action: "decide"; reference: string; gateId: string; expectedRevision: number; candidateDigest: string}
  >();
  /** Trusted interactive host only. Never derive this proof from model tool arguments or injected messages. */
  withAcceptanceHumanAction<T>(proof: NonNullable<ReturnType<typeof this.acceptanceHumans.getStore>>, operation: () => T): T {
    return this.acceptanceHumans.run(structuredClone(proof), operation);
  }
  /** Host admission only. A grant is not native delivery; caller retains its existing durable send receipt. */
  withAcceptanceOperation<T>(binding: AcceptanceOperation, operation: () => T): T {
    this.planner();
    id(binding.invocationId, "invocation ID");
    if (!/^[a-f0-9]{64}$/.test(binding.requestDigest) || !/^[a-f0-9]{64}$/.test(binding.candidateDigest) || !Number.isInteger(binding.expectedRevision) || binding.expectedRevision < 1) fail("INVALID", "Bind invocation to the complete host request and displayed candidate");
    if (binding.operation !== "downstream") fail("INVALID", "Unknown acceptance operation");
    const grant = this.command(`acceptance-invocation:${hash(binding.invocationId)}`, "acceptance.invoke", binding, () => {
      const gate = this.acceptanceGateView(binding.gateId);
      if (gate.state !== "released") fail("ACCEPTANCE_REQUIRED", "Human acceptance is required before starting the downstream operation");
      if (gate.revision !== binding.expectedRevision || gate.candidate.digest !== binding.candidateDigest) fail("CONFLICT", "The displayed accepted result changed before invocation admission");
      const invocation: AcceptanceInvocation = {...binding, gateRevision: gate.revision, candidateDigest: gate.candidate.digest, admittedAt: this.now()};
      this.put("acceptanceInvocation", hash(binding.invocationId), invocation, gate.gateId);
      this.event("acceptance.operation_admitted", {gateId: gate.gateId, invocationId: binding.invocationId, candidateDigest: invocation.candidateDigest, gateRevision: gate.revision}, gate.workstreamTaskId);
      return invocation;
    }).value;
    const gate = this.acceptanceGateView(binding.gateId);
    if (gate.state !== "released") fail("ACCEPTANCE_REQUIRED", "Human acceptance is required before continuing the downstream operation");
    if (gate.revision !== grant.gateRevision || gate.candidate.digest !== grant.candidateDigest) fail("CONFLICT", "This invocation belongs to an earlier acceptance; use a new invocation after the current result is accepted");
    return this.acceptanceOperations.run(structuredClone(binding), operation);
  }
  /** Host-selected existing independent operation; a model-supplied parent is insufficient. */
  withAcceptanceIndependentTask<T>(taskId: string, operation: () => T): T {
    if (!this.list<{taskId: string}>("acceptanceIndependent").some(member => member.taskId === taskId)) fail("FORBIDDEN", "Select a durable independent operation that predates this gate");
    return this.acceptanceIndependentOperations.run(taskId, operation);
  }
  createAcceptanceIndependentTask(commandId: string, input: unknown) {
    this.planner();
    const command = CreateAcceptanceIndependentTask.parse(input), proof = this.acceptanceHumans.getStore();
    if (proof?.action !== "independent" || proof.reference !== command.instructionRef || this.projectSettingsId(proof.projectId) !== this.projectSettingsId(command.projectId)) fail("FORBIDDEN", "A new independent workstream requires a trusted explicit human action");
    return this.command(commandId, "acceptance.independent", command, () => {
      const projectId = this.projectSettingsId(command.projectId);
      const gates = this.acceptanceGates().filter(gate => gate.projectId === projectId);
      if (new Set(command.expectedGates.map(gate => gate.gateId)).size !== command.expectedGates.length || gates.length !== command.expectedGates.length || gates.some(gate => !command.expectedGates.some(expected => expected.gateId === gate.gateId && expected.revision === gate.revision))) fail("CONFLICT", "Project gates changed; inspect current gates before creating independent work");
      const wb = new Workbench(this), backlog = wb.getBacklog(command.backlogId);
      if (this.projectSettingsId(backlog.projectId) !== projectId) fail("FORBIDDEN", "Select a backlog in the independent work's Project");
      if (this.get("task", command.taskId)) fail("CONFLICT", "Independent Task ID already exists");
      const task = this.acceptanceOperations.exit(() => this.acceptanceIndependentOperations.exit(() => this.dispatchOrigins.run({kind: "system", nodeId: this.nodeId}, () => this.newTask({taskId: command.taskId, title: command.title, ...(command.description !== undefined ? {description: command.description} : {})}))));
      this.put("acceptanceIndependentProject", task.taskId, {projectId, taskId: task.taskId, instructionRef: command.instructionRef});
      for (const gate of gates) this.put("acceptanceIndependent", hash([gate.gateId, task.taskId]), {gateId: gate.gateId, taskId: task.taskId});
      this.acceptanceIndependentOperations.run(task.taskId, () => wb.linkDispatcherTask(command.backlogId, task.taskId));
      this.event("acceptance.independent_created", {taskId: task.taskId, projectId, instructionRef: command.instructionRef}, task.taskId);
      return this.getTask(task.taskId);
    });
  }
  private acceptanceIndependentAllows(gateId: string, taskId: string): boolean {
    const bound = this.acceptanceIndependentOperations.getStore();
    return !!bound && !!this.get("acceptanceIndependent", hash([gateId, bound])) && (bound === taskId || this.descendants(bound).some(task => task.taskId === taskId));
  }
  private acceptanceGates(): AcceptanceGate[] { return this.list<AcceptanceGate>("acceptanceGate"); }
  acceptanceInvocationRecord(invocationId: string): AcceptanceInvocation | undefined { return this.get<AcceptanceInvocation>("acceptanceInvocation", hash(invocationId)); }
  acceptanceIndependentReference(taskId: string): {projectId: string; taskId: string; instructionRef: string} | undefined { return this.get<{projectId: string; taskId: string; instructionRef: string}>("acceptanceIndependentProject", taskId); }
  private acceptanceTaskMember(taskId: string): AcceptanceMember | undefined { return this.get<AcceptanceMember>("acceptanceMember", taskId); }
  private acceptanceTaskGate(taskId: string): AcceptanceGate | undefined {
    const pinned = this.get<{gateId: string}>("acceptanceScope", taskId);
    if (pinned) return this.need<AcceptanceGate>("acceptanceGate", pinned.gateId);
    let task: Task | undefined = this.getTask(taskId);
    const roots = new Map(this.acceptanceGates().map(gate => [gate.workstreamTaskId, gate]));
    const seen = new Set<string>();
    while (task && !seen.has(task.taskId)) {
      seen.add(task.taskId);
      const gate = roots.get(task.taskId);
      if (gate) return gate;
      task = task.parentTaskId ? this.getTask(task.parentTaskId) : undefined;
    }
    return undefined;
  }
  private acceptanceCandidate(gate: AcceptanceGate) {
    const members = this.list<AcceptanceMember & {taskId: string}>("acceptanceMember").filter(member => member.gateId === gate.gateId && member.operation === "upstream");
    const currentStepTasks = gate.upstreamSteps.flatMap(step => {
      const member = members.filter(item => {
        const source = this.get<AcceptanceStep>("acceptanceStep", item.taskId);
        return source && canonical(source) === canonical(step);
      }).at(-1);
      return member ? [member.taskId] : [];
    });
    const taskIds = [...new Set([...gate.upstreamTaskIds, ...currentStepTasks])].sort();
    const allRuns = this.list<Run>("run"), allReports = this.list<Report>("report");
    const runs = taskIds.flatMap(taskId => allRuns.filter(run => run.taskId === taskId && !run.historyOnly && !run.observationOnly));
    const latest = taskIds.map(taskId => runs.filter(run => run.taskId === taskId).at(-1));
    const reports = allReports.filter(report => taskIds.includes(report.taskId) && report.kind === "result");
    const stepReady = gate.upstreamSteps.every(step => members.some(member => {
      const source = this.get<AcceptanceStep>("acceptanceStep", member.taskId);
      return source?.workflowId === step.workflowId && source.definitionRevision === step.definitionRevision && source.stepId === step.stepId;
    }));
    const pending = allRuns.some(run => members.some(member => member.taskId === run.taskId) && !run.historyOnly && !run.observationOnly && ["queued", "running", "uncertain"].includes(run.state));
    const ready = !pending && stepReady && taskIds.length > 0 && latest.every(run => run && ["succeeded", "partial"].includes(run.state) && run.intentSnapshot?.intentRevision === this.getTask(run.taskId).intentRevision && reports.some(report => report.runId === run.runId));
    const tasks = taskIds.map(taskId => {
      const task = this.getTask(taskId);
      return {taskId, intentRevision: task.intentRevision, title: task.title, description: task.description, goal: task.goal, acceptanceCriteria: task.acceptanceCriteria};
    });
    const evidence = {gateId: gate.gateId, taskIds, tasks, runs: runs.map(run => ({runId: run.runId, taskId: run.taskId, state: run.state, configuration: run.configuration})), reports, artifacts: this.list<Artifact>("artifact").filter(artifact => reports.some(report => report.artifactIds.includes(artifact.artifactId)))};
    return {digest: hash(evidence), ready, taskIds, runCount: runs.length, reportCount: reports.length, runs: runs.slice(-64).map(run => ({runId: run.runId, taskId: run.taskId, state: run.state})), reports: reports.slice(-16).map(report => ({reportId: report.reportId, revision: report.revision, title: report.title, body: report.body.slice(0, 12000)}))};
  }
  acceptanceGateView(gateId: string): AcceptanceGateView {
    const gate = this.need<AcceptanceGate>("acceptanceGate", gateId), candidate = this.acceptanceCandidate(gate);
    const invocations = this.list<AcceptanceInvocation>("acceptanceInvocation", gateId);
    const downstreamIds = new Set(this.list<AcceptanceMember & {taskId: string}>("acceptanceMember").filter(member => member.gateId === gateId && member.operation === "downstream").map(member => member.taskId));
    const downstreamRuns = this.list<Run>("run").filter(run => downstreamIds.has(run.taskId)).map(run => ({runId: run.runId, taskId: run.taskId, state: run.state, attemptId: run.currentAttemptId ?? null}));
    return {...gate, candidate, invocationCount: invocations.length, invocations: invocations.slice(-32), downstreamRunCount: downstreamRuns.length, downstreamRuns: downstreamRuns.slice(-64), state: gate.acceptance?.candidateDigest === candidate.digest && candidate.ready ? "released" : candidate.ready ? "awaiting-acceptance" : "repairing"};
  }
  acceptanceGateViews(projectId?: string): AcceptanceGateView[] {
    return this.acceptanceGates().filter(gate => !projectId || gate.projectId === this.projectSettingsId(projectId)).map(gate => this.acceptanceGateView(gate.gateId));
  }
  acceptanceGateSummaries(projectId: string, limit = 8) {
    projectId = this.projectSettingsId(projectId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) fail("INVALID", "Gate summary limit must be between 1 and 16");
    const total = Number(this.db.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind='acceptanceGate' AND json_extract(data,'$.projectId')=?").get(projectId)?.count ?? 0);
    const rows = this.db.prepare("SELECT id FROM entities WHERE kind='acceptanceGate' AND json_extract(data,'$.projectId')=? ORDER BY rowid DESC LIMIT ?").all(projectId, limit);
    const gates = rows.map(row => {
      const view = this.acceptanceGateView(String(row.id));
      return {gateId: view.gateId, revision: view.revision, state: view.state,
        upstream: {taskIds: view.upstreamTaskIds.slice(0, 8), taskCount: view.upstreamTaskIds.length, steps: view.upstreamSteps.slice(0, 8), stepCount: view.upstreamSteps.length},
        downstream: {taskIds: view.downstreamTaskIds.slice(0, 8), taskCount: view.downstreamTaskIds.length, steps: view.downstreamSteps.slice(0, 8), stepCount: view.downstreamSteps.length},
        candidate: {digest: view.candidate.digest, ready: view.candidate.ready, runIds: view.candidate.runs.slice(-8).map(run => run.runId), runCount: view.candidate.runCount, reportRefs: view.candidate.reports.slice(-8).map(report => ({reportId: report.reportId, revision: report.revision})), reportCount: view.candidate.reportCount},
        granted: {invocationCount: view.invocationCount, downstreamRunCount: view.downstreamRunCount, runRefs: view.downstreamRuns.slice(-4)}};
    });
    return {projectId, total, truncated: total > gates.length, gates};
  }
  armAcceptanceGate(commandId: string, input: unknown) {
    this.planner();
    const command = ArmAcceptanceGate.parse(input), proof = this.acceptanceHumans.getStore();
    if (proof?.action !== "arm" || proof.reference !== command.instructionRef) fail("FORBIDDEN", "Arming requires a trusted interactive human action");
    return this.command(commandId, "acceptance.arm", command, () => {
      if (this.get("acceptanceGate", command.gateId)) fail("CONFLICT", "Acceptance gate already exists");
      const root = this.getTask(command.workstreamTaskId);
      const projectId = this.projectForTask(root.taskId) ?? fail("AMBIGUOUS_PROJECT", "Select an existing workstream in the authority Project");
      if (projectId !== this.projectSettingsId(command.projectId)) fail("AMBIGUOUS_PROJECT", "Select an existing workstream in the authority Project");
      if (this.acceptanceTaskGate(root.taskId) || this.descendants(root.taskId).some(task => this.acceptanceTaskGate(task.taskId))) fail("CONFLICT", "Workstream already has an acceptance gate");
      const covered = [root, ...this.descendants(root.taskId)], ids = new Set(covered.map(task => task.taskId));
      if (command.upstreamTaskIds.some(taskId => command.downstreamTaskIds.includes(taskId))) fail("INVALID", "A Task cannot be both repair and downstream work");
      for (const taskId of [...command.upstreamTaskIds, ...command.downstreamTaskIds]) if (!ids.has(taskId)) fail("FORBIDDEN", "Gate members must belong to the selected workstream");
      for (const step of [...command.upstreamSteps, ...command.downstreamSteps]) {
        const row = this.db.prepare("SELECT data FROM workflow_definitions WHERE id=?").get(step.workflowId);
        const definition = row ? JSON.parse(String(row.data)) as {revision: number; projectId: string; steps: {stepId: string}[]} : undefined;
        if (!definition || definition.projectId !== command.projectId || definition.revision !== step.definitionRevision || !definition.steps.some(item => item.stepId === step.stepId)) fail("CONFLICT", "Select a current workflow definition step in this Project");
        if (command.upstreamSteps.some(up => command.downstreamSteps.some(down => canonical(up) === canonical(down)))) fail("INVALID", "A workflow step cannot have two operations");
      }
      const stepMembers: {taskId: string; operation: AcceptanceMember["operation"]; step: AcceptanceStep}[] = [];
      if (command.upstreamSteps.length || command.downstreamSteps.length) for (const row of this.db.prepare("SELECT data FROM workflow_runs ORDER BY rowid").all()) {
        const flow = JSON.parse(String(row.data)) as WorkflowRunView;
        if (flow.taskId !== root.taskId || this.projectSettingsId(flow.projectId ?? "") !== projectId) continue;
        for (const [operation, steps] of [["upstream", command.upstreamSteps], ["downstream", command.downstreamSteps]] as const) for (const step of steps) {
          if (flow.workflowId !== step.workflowId || flow.definitionRevision !== step.definitionRevision) continue;
          for (const dispatch of flow.dispatches.filter(dispatch => dispatch.stepId === step.stepId)) {
            if (!ids.has(dispatch.taskId) || this.getRun(dispatch.runId).taskId !== dispatch.taskId) fail("CONFLICT", "Workflow dispatch no longer belongs to this workstream");
            if ((operation === "upstream" ? command.downstreamTaskIds : command.upstreamTaskIds).includes(dispatch.taskId)) fail("INVALID", "Task and workflow operation memberships disagree");
            stepMembers.push({taskId: dispatch.taskId, operation, step});
          }
        }
      }
      const upstreamIds = new Set([...command.upstreamTaskIds, ...stepMembers.filter(member => member.operation === "upstream").map(member => member.taskId)]);
      const downstream = this.list<Run>("run").filter(run => ids.has(run.taskId) && !upstreamIds.has(run.taskId) && (run.currentAttemptId || run.state !== "queued") && !(run.taskId === root.taskId && !run.route && !run.currentAttemptId && this.isWorkflowInvocation(run) && this.acceptanceWorkflowContainer(root.taskId, run.configuration, command)));
      if (downstream.length) fail("ACCEPTANCE_ALREADY_GRANTED", `Downstream execution was already admitted: ${downstream.map(run => `${run.runId}:${run.state}:${run.currentAttemptId ?? "invocation"}`).join(", ")}`);
      const gate: AcceptanceGate = {...command, projectId, revision: 1, createdAt: this.now(), acceptance: null, lastDecision: null};
      this.put("acceptanceGate", gate.gateId, gate, root.taskId);
      for (const task of covered) this.put("acceptanceScope", task.taskId, {gateId: gate.gateId, projectId}, root.taskId);
      for (const task of this.list<Task>("task")) if (!ids.has(task.taskId) && this.projectForTask(task.taskId) === projectId) this.put("acceptanceIndependent", hash([gate.gateId, task.taskId]), {gateId: gate.gateId, taskId: task.taskId});
      for (const [operation, taskIds] of [["upstream", command.upstreamTaskIds], ["downstream", command.downstreamTaskIds]] as const)
        for (const taskId of taskIds) this.put("acceptanceMember", taskId, {gateId: gate.gateId, operation, taskId}, root.taskId);
      for (const {taskId, operation, step} of stepMembers) {
        this.put("acceptanceMember", taskId, {gateId: gate.gateId, operation, taskId}, root.taskId);
        this.put("acceptanceStep", taskId, step, root.taskId);
      }
      this.event("acceptance.armed", {gateId: gate.gateId}, root.taskId);
      return this.acceptanceGateView(gate.gateId);
    });
  }
  decideAcceptanceGate(commandId: string, input: unknown) {
    this.planner();
    const command = DecideAcceptanceGate.parse(input), proof = this.acceptanceHumans.getStore();
    if (proof?.action !== "decide" || proof.reference !== command.humanDecisionRef || proof.gateId !== command.gateId || proof.expectedRevision !== command.expectedRevision || proof.candidateDigest !== command.candidateDigest) fail("FORBIDDEN", "Acceptance requires a trusted human action bound to the displayed candidate");
    return this.command(commandId, "acceptance.decide", command, () => {
      const gate = this.need<AcceptanceGate>("acceptanceGate", command.gateId), candidate = this.acceptanceCandidate(gate);
      if (gate.revision !== command.expectedRevision || candidate.digest !== command.candidateDigest) fail("CONFLICT", "Repair evidence or gate revision changed; inspect the current result");
      if (!candidate.ready) fail("ACCEPTANCE_NOT_READY", "Repair has no complete current result to accept");
      gate.revision++;
      gate.lastDecision = {decision: command.decision, humanDecisionRef: command.humanDecisionRef, at: this.now()};
      gate.acceptance = command.decision === "accept" ? {candidateDigest: candidate.digest, humanDecisionRef: command.humanDecisionRef, at: this.now()} : null;
      this.put("acceptanceGate", gate.gateId, gate, gate.workstreamTaskId);
      this.event("acceptance.decided", {gateId: gate.gateId, decision: command.decision, candidateDigest: candidate.digest}, gate.workstreamTaskId);
      return this.acceptanceGateView(gate.gateId);
    });
  }
  amendAcceptanceGate(commandId: string, input: unknown) {
    this.planner();
    const command = AmendAcceptanceGate.parse(input), proof = this.acceptanceHumans.getStore();
    if (proof?.action !== "amend" || proof.reference !== command.instructionRef || proof.gateId !== command.gateId || proof.expectedRevision !== command.expectedRevision) fail("FORBIDDEN", "Repair amendments require a trusted interactive action bound to the gate revision");
    return this.command(commandId, "acceptance.amend", command, () => {
      const gate = this.need<AcceptanceGate>("acceptanceGate", command.gateId);
      if (gate.revision !== command.expectedRevision) fail("CONFLICT", "Acceptance gate changed");
      const next = new Set(command.upstreamTaskIds), added = new Set(command.newRepairTasks.map(task => task.taskId));
      if (next.size !== command.upstreamTaskIds.length || [...added].some(taskId => !next.has(taskId)) || next.size + gate.upstreamSteps.length === 0) fail("INVALID", "Select unique repair members and include every new repair Task");
      for (const taskId of gate.upstreamTaskIds.filter(taskId => !next.has(taskId))) {
        if (this.list<Run>("run", taskId).some(run => ["queued", "running", "uncertain"].includes(run.state))) fail("ACCEPTANCE_ACTIVE_REPAIR", "Finish or explicitly stop existing repair before removing its membership");
      }
      for (const taskId of next) {
        if (added.has(taskId)) continue;
        if (!gate.upstreamTaskIds.includes(taskId)) fail("FORBIDDEN", "Amendments may retain declared repair Tasks or explicitly create new repair Tasks");
      }
      for (const edit of command.repairEdits) {
        if (!next.has(edit.taskId) || added.has(edit.taskId)) fail("FORBIDDEN", "Intent edits require a retained repair member");
        if (this.list<Run>("run", edit.taskId).some(run => ["queued", "running", "uncertain"].includes(run.state))) fail("ACCEPTANCE_ACTIVE_REPAIR", "Repair intent cannot change during execution");
        const task = this.getTask(edit.taskId), {taskId: _taskId, ...intent} = edit;
        Object.assign(task, intent, {intentRevision: (task.intentRevision ?? 1) + 1, revision: (task.revision ?? 1) + 1, updatedAt: this.now()});
        this.saveTask(task);
      }
      for (const taskId of gate.upstreamTaskIds.filter(taskId => !next.has(taskId))) this.db.prepare("DELETE FROM entities WHERE kind='acceptanceMember' AND id=?").run(taskId);
      gate.upstreamTaskIds = [...next];
      gate.revision++;
      gate.acceptance = null;
      gate.instructionRef = command.instructionRef;
      this.put("acceptanceGate", gate.gateId, gate, gate.workstreamTaskId);
      for (const task of command.newRepairTasks) {
        if (this.get("task", task.taskId)) fail("CONFLICT", "New repair Task ID already exists");
        this.put("acceptanceMember", task.taskId, {gateId: gate.gateId, operation: "upstream", taskId: task.taskId}, gate.workstreamTaskId);
        this.newTask({...task, parentTaskId: gate.workstreamTaskId});
      }
      this.event("acceptance.amended", {gateId: gate.gateId, revision: gate.revision, instructionRef: command.instructionRef}, gate.workstreamTaskId);
      return this.acceptanceGateView(gate.gateId);
    });
  }
  private acceptanceWorkflowContainer(taskId: string, configuration: Json | undefined, gate: Pick<AcceptanceGate, "workstreamTaskId" | "upstreamSteps" | "downstreamSteps">): boolean {
    if (taskId !== gate.workstreamTaskId || !configuration || typeof configuration !== "object" || Array.isArray(configuration)) return false;
    const invocation = configuration.workflowInvocation;
    if (!invocation || typeof invocation !== "object" || Array.isArray(invocation) || typeof invocation.workflowId !== "string" || !this.hasWorkflowBinding(taskId)) return false;
    const row = this.db.prepare("SELECT data FROM workflow_task_bindings WHERE task_id=?").get(taskId);
    return !!row && JSON.parse(String(row.data)).workflowId === invocation.workflowId && [...gate.upstreamSteps, ...gate.downstreamSteps].some(step => step.workflowId === invocation.workflowId);
  }
  private assertAcceptanceTask(taskId: string, action: "plan" | "run" | "claim") {
    const gate = this.acceptanceTaskGate(taskId);
    if (!gate) return;
    const member = this.acceptanceTaskMember(taskId);
    if (member?.operation === "upstream" && action !== "plan") return;
    if (member?.operation === "downstream" && this.acceptanceGateView(gate.gateId).state === "released") return;
    fail("ACCEPTANCE_REQUIRED", `${action} is blocked by acceptance gate ${gate.gateId}; only declared repair members may continue`);
  }
  assertAcceptanceWorkflowRetry(taskId: string) { this.assertAcceptanceTask(taskId, "run"); }
  assertAcceptancePlanning(input: {projectId?: string; taskId?: string; title: string; description: string}, proposal?: Json) {
    const originProject = this.dispatchProjectId();
    const taskProject = input.taskId ? this.projectForTask(input.taskId) : undefined;
    const declaredProject = input.projectId ? this.projectSettingsId(input.projectId) : undefined;
    const projectId = originProject ?? taskProject ?? declaredProject;
    if (projectId && declaredProject && projectId !== declaredProject) fail("AMBIGUOUS_PROJECT", "Planning input differs from its host-owned Project");
    if (input.taskId && this.acceptanceTaskGate(input.taskId)) {
      this.assertAcceptanceTask(input.taskId, "run");
      const task = this.getTask(input.taskId), member = this.acceptanceTaskMember(input.taskId);
      if (member?.operation === "upstream") {
        if (input.title !== task.title || input.description !== task.description) fail("ACCEPTANCE_REQUIRED", "Repair planning must preserve the declared Task intent; use a trusted amendment to change scope");
        if (proposal && typeof proposal === "object" && !Array.isArray(proposal) && proposal.kind === "proposal" && (proposal.persistence !== "attach" || proposal.attachTaskId !== task.taskId)) fail("ACCEPTANCE_REQUIRED", "Repair proposals must attach to the existing declared Task");
      }
      return;
    }
    if (projectId) this.assertAcceptanceProjectPlan(projectId, input.taskId);
  }
  /** Called inside the existing plan transaction, including direct Workbench callers. */
  assertAcceptanceProjectPlan(projectId: string, taskId?: string, workflowId?: string) {
    taskId ??= this.acceptanceIndependentOperations.getStore();
    const gates = this.acceptanceGates().filter(gate => gate.projectId === this.projectSettingsId(projectId));
    for (const gate of gates) {
      if (taskId) {
        if (this.acceptanceTaskGate(taskId)?.gateId === gate.gateId) { this.assertAcceptanceTask(taskId, "plan"); continue; }
        if (this.acceptanceIndependentAllows(gate.gateId, taskId)) continue;
      }
      if (workflowId && ![...gate.upstreamSteps, ...gate.downstreamSteps].some(step => step.workflowId === workflowId)) {
        const bound = this.acceptanceIndependentOperations.getStore();
        const row = bound && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_task_bindings'").get() ? this.db.prepare("SELECT data FROM workflow_task_bindings WHERE task_id=?").get(bound) : undefined;
        if (bound && this.acceptanceIndependentAllows(gate.gateId, bound) && row && JSON.parse(String(row.data)).workflowId === workflowId) continue;
      }
      const invocation = this.acceptanceOperations.getStore();
      if (invocation?.gateId === gate.gateId && this.acceptanceGateView(gate.gateId).state === "released") continue;
      fail("ACCEPTANCE_REQUIRED", `Unclassified plan mutation is blocked by acceptance gate ${gate.gateId}`);
    }
  }
  private acceptanceNewTask(taskId: string, parentTaskId?: string): AcceptanceMember | undefined {
    const step = this.acceptanceSteps.getStore();
    const parentProjectId = parentTaskId ? this.projectForTask(parentTaskId) : undefined;
    const parentGate = parentTaskId ? this.acceptanceTaskGate(parentTaskId) : undefined;
    const gate = parentGate;
    if (gate) {
      const invocation = this.acceptanceOperations.getStore();
      const inherited = parentTaskId ? this.acceptanceTaskMember(parentTaskId) : undefined;
      const amendment = this.acceptanceHumans.getStore();
      const upstream = (step && gate.upstreamSteps.some(member => canonical(member) === canonical(step))) || (amendment?.action === "amend" && amendment.gateId === gate.gateId && this.acceptanceTaskMember(taskId)?.operation === "upstream");
      const downstream = (step && gate.downstreamSteps.some(member => canonical(member) === canonical(step))) || inherited?.operation === "downstream" || invocation?.gateId === gate.gateId;
      if (!upstream && (!downstream || this.acceptanceGateView(gate.gateId).state !== "released")) fail("ACCEPTANCE_REQUIRED", `New Task is not a declared repair member; acceptance gate ${gate.gateId} blocks decomposition`);
      const member = {gateId: gate.gateId, operation: upstream ? "upstream" : "downstream", taskId} satisfies AcceptanceMember & {taskId: string};
      this.put("acceptanceScope", taskId, {gateId: gate.gateId, projectId: gate.projectId}, gate.workstreamTaskId);
      this.put("acceptanceMember", taskId, member, gate.workstreamTaskId);
      if (step) this.put("acceptanceStep", taskId, step, gate.workstreamTaskId);
      return member;
    }
    const projectId = this.dispatchProjectId() ?? parentProjectId;
    if (projectId) for (const active of this.acceptanceGates().filter(item => item.projectId === projectId)) {
      if (!parentTaskId || !this.acceptanceIndependentAllows(active.gateId, parentTaskId)) fail("ACCEPTANCE_REQUIRED", `New project Tasks require a trusted bound operation while gate ${active.gateId} is active`);
      this.put("acceptanceIndependent", hash([active.gateId, taskId]), {gateId: active.gateId, taskId});
    }
    return undefined;
  }
  withDispatchOrigin<T>(origin: DispatchOrigin, operation: () => T): T {
    return this.dispatchOrigins.run(structuredClone(origin), operation);
  }
  dispatcherForSession(nodeId:string,sessionId:string): DispatcherSession | undefined {
    const binding=this.get<DispatcherSession>("dispatcherSession",hash([nodeId,sessionId]));
    if(!binding)return;
    const run=this.getRun(binding.runId);
    return run.coordinatorSession?.sessionId===sessionId && run.state==="running" ? binding : undefined;
  }
  bindDispatcher(commandId:string,input:Omit<DispatcherSession,"runId"> & {backlogId?:string}) {
    this.planner();
    return this.command(commandId,"bindDispatcher",input,()=>{
      const task=this.getTask(input.taskId),origin=task.dispatchOrigin;
      if(origin?.kind!=="session" || origin.nodeId!==input.nodeId || origin.sessionId!==input.sessionId)fail("FORBIDDEN","Only the session that created this draft can coordinate it");
      if(this.dispatcherForSession(input.nodeId,input.sessionId))fail("CONFLICT","This session already coordinates an active task");
      if(this.list<Run>("run",task.taskId).length || !["ready","waiting"].includes(task.state))fail("CONFLICT","Dispatcher registration requires a new unexecuted draft");
      new Workbench(this).linkDispatcherTask(input.backlogId ?? `pr:${input.projectId}`,task.taskId);
      const run=this.newRun({taskId:input.taskId}, {coordinatorSession:{nodeId:input.nodeId,sessionId:input.sessionId}});
      run.coordinatorSession={nodeId:input.nodeId,sessionId:input.sessionId};run.state="running";
      run.dispatchOrigin={kind:"system",nodeId:input.nodeId};
      this.saveRun(run);this.projectTaskState(task,run);
      const binding={...input,runId:run.runId};
      this.put("dispatcherSession",hash([input.nodeId,input.sessionId]),binding,input.taskId);
      this.event("task.dispatcher_bound",{sessionId:input.sessionId,nodeId:input.nodeId,projectId:input.projectId},input.taskId,run.runId);
      return binding;
    });
  }
  submitDispatcherResult(commandId:string,input:{nodeId:string;sessionId:string;outcome:Outcome;summary:string;report?:{title:string;body:string;data?:Json;artifactIds?:string[]}}) {
    this.planner();
    return this.command(commandId,"submitDispatcherResult",input,()=>{
      const binding=this.dispatcherForSession(input.nodeId,input.sessionId);
      if(!binding)fail("FORBIDDEN","Current session has no active coordinator task");
      const own=binding!,run=this.getRun(own.runId),task=this.getTask(own.taskId);
      if(!["success","partial","failure","blocked","unknown"].includes(input.outcome))fail("INVALID","Invalid outcome");
      text(input.summary,"summary",5000);
      if(!this.allSettled(task.taskId,task.policy?.settlementQuietMs ?? 1000,run.runId).settled)fail("CHILDREN_PENDING","Read and settle child results before submitting the parent result");
      const report=input.report ?? fail("RESULT_VALIDATION","Coordinator completion requires a final report");
      this.report({...report,taskId:task.taskId,runId:run.runId,sessionId:own.sessionId,kind:"result"});
      run.resultSummary=input.summary;run.state=({success:"succeeded",partial:"partial",failure:"failed",blocked:"blocked",unknown:"uncertain"} as const)[input.outcome];run.updatedAt=this.now();
      this.saveRun(run);this.projectTaskState(task,run);this.lifecycleDelivery(task,run);
      this.event("run.settled",{outcome:input.outcome,summary:input.summary,coordinatorSession:own.sessionId},task.taskId,run.runId);
      return run;
    });
  }
  taskCheckin(input: import("./task-checkins.js").CheckinCommand) { return this.checkins.command(input, this.dispatchOrigins.getStore()); }
  readonly checkins: TaskCheckins;
  readonly projectExecutionSettings: ProjectExecutionSettingsStore;
  readonly executorAlerts: ExecutorAlertStore;
  private readonly db: DatabaseSync;
  readonly executionModels: ExecutionModels;
  executionDirectoryReady?:()=>boolean;
  localExecutionCatalog?:()=>Promise<import("./execution-models.js").ExecutionCatalogResult>;
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
    this.executorAlerts = new ExecutorAlertStore(this.db,{readOnly:options.readOnly});
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.executionModels = new ExecutionModels(this.db,{now:this.clock,readOnly:options.readOnly});
    this.projectExecutionSettings = new ProjectExecutionSettingsStore(this.db, {readOnly: options.readOnly});
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
    if (!options.readOnly) {
      // Keep commands' three-column layout compatible with the prior release.
      this.db.exec("CREATE TABLE IF NOT EXISTS transient_command_expiry(id TEXT PRIMARY KEY,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS command_expiry ON transient_command_expiry(expires)");
    }
    this.checkins = new TaskCheckins(this, options.checkinIntervalMs);
    this.receiptExpirySupported = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transient_command_expiry'").get();
    if (!options.readOnly)
      this.db
        .prepare(
          "INSERT OR IGNORE INTO entities(kind,id,data) VALUES('authority','scheduler',?)",
        )
        .run(JSON.stringify({ schedulerId: `scheduler-${randomUUID()}` }));
    const schema = this.db.prepare("SELECT version FROM schema_meta").get() as
      | { version: number }
      | undefined;
    if (schema?.version !== 1) {
      this.db.close();
      fail("SCHEMA", "Unsupported ledger schema");
    }
  }
  private configurationPaused = false;
  private receiptExpirySupported = false;
  configurationBlockers() {
    return (
      this.db
        .prepare(
          "SELECT data FROM entities WHERE kind='run' AND state IN ('running','uncertain') LIMIT 100",
        )
        .all() as { data: string }[]
    )
      .map((row) => JSON.parse(row.data) as Run)
      .filter((run) => !run.historyOnly && !run.observationOnly)
      .map((run) => ({
        runId: run.runId,
        title: this.getTask(run.taskId).title,
        state: run.state,
      }));
  }
  beginConfigurationEdit(): () => void {
    if (
      this.configurationPaused ||
      this.list<Run>("run").some(
        (run) =>
          !run.historyOnly &&
          !run.observationOnly &&
          ["running", "uncertain"].includes(run.state),
      )
    )
      fail("CONFIGURATION_BUSY", "Execution or recovery is active");
    this.configurationPaused = true;
    return () => {
      this.configurationPaused = false;
    };
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
  managementCommand<T>(commandId: string, operation: string, input: unknown, fn: () => T): T {
    this.assertManagementWritable();
    return this.command(commandId, `workflow.${operation}`, input, fn).value;
  }
  workflowAdmission(commandId: string, input: {task?: TaskInput; run: RunInput; script?: ScriptExecution; step?: AcceptanceStep}, link: (task: Task, run: Run) => void) {
    this.assertManagementWritable();
    const admit = () => this.command(commandId, "workflow.admit", input, () => {
      const task = input.task ? this.newTask(input.task) : this.getTask(input.run.taskId);
      const run = this.newRun({...input.run, taskId:task.taskId});
      if (input.script) {
        run.workflowScript = ScriptExecution.parse(input.script);
        this.saveRun(run);
      }
      link(task, run);
      return {taskId:task.taskId,runId:run.runId};
    }).value;
    return input.step ? this.acceptanceSteps.run(structuredClone(input.step), admit) : admit();
  }
  registeredNodes(): NodeCapability[] { return this.list<NodeCapability>("node"); }
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
      if(value.state === "queued" && !value.route?.workspaceId && !value.projectContext && value.route && !value.historyOnly && !value.observationOnly) {
        const issue={kind:"needs_action",code:"TEMPORARY_CONTEXT_REQUIRED",message:"Repair this unclaimed request to attach its temporary task context.",action:"repair_context"};
        value.dispatchIssue={...issue,revision:hash(issue)};
      }
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
    transient = false,
    existingWorkflowTransaction = false,
  ): Receipt<T> {
    id(commandId, "commandId");
    if (canonical(input).length > 2_000_000)
      fail("TOO_LARGE", "Command exceeds size limit");
    if (this.options.readOnly) fail("READ_ONLY", "Read-only ledger");
    const digest = hash({ operation, input });
    if (existingWorkflowTransaction && !this.db.isTransaction)
      fail("FORBIDDEN", "Workflow report publication requires a transaction");
    if (!existingWorkflowTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.clock();
      this.db.prepare("DELETE FROM commands WHERE id IN (SELECT id FROM transient_command_expiry WHERE expires <= ?)").run(now);
      this.db.prepare("DELETE FROM transient_command_expiry WHERE expires <= ?").run(now);
      const old = this.db
        .prepare("SELECT digest,receipt FROM commands WHERE id=?")
        .get(commandId) as { digest: string; receipt: string } | undefined;
      if (old) {
        if (old.digest !== digest)
          fail("CONFLICT", "Idempotency key reused with a different command");
        if (!existingWorkflowTransaction) this.db.exec("COMMIT");
        return JSON.parse(old.receipt) as Receipt<T>;
      }
      const result: Receipt<T> = {
        commandId,
        acceptedAt: this.now(),
        value: fn(),
      };
      this.db
        .prepare("INSERT INTO commands(id,digest,receipt) VALUES(?,?,?)")
        .run(commandId, digest, canonical(result));
      if (transient)
        this.db.prepare("INSERT INTO transient_command_expiry(id,expires) VALUES(?,?)").run(commandId, now + TRANSIENT_RECEIPT_TTL_MS);
      if (!existingWorkflowTransaction) this.db.exec("COMMIT");
      return result;
    } catch (e) {
      if (!existingWorkflowTransaction) this.db.exec("ROLLBACK");
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
    if (TERMINAL.has(run.state) && run.dispatchOrigin?.kind === "session") this.queueTaskReturn(run);
  }
  private queueTaskReturn(run: Run) {
    const origin = run.dispatchOrigin;
    if (origin?.kind !== "session") return;
    const eventId = `task-result:${hash([run.runId, run.currentAttemptId ?? null, run.state])}`;
    if (this.get("sessionMessage", eventId)) return;
    const reports = this.list<Report>("report", run.taskId).filter(report=>report.runId===run.runId && report.kind!=="note");
    const message: import("./remote/ports.js").SessionMessage = {
      messageId:eventId, taskId:run.taskId,nodeId:origin.nodeId,sessionId:origin.sessionId,
      workspaceId: origin.parentLease ? this.getRun(origin.parentLease.runId).route?.workspaceId ?? "origin-session" : "origin-session",
      completion:{eventId,origin:structuredClone(origin),runId:run.runId},
      text:`子任务已结算。请核对中央账本中的结果并继续原会话汇总。\n${JSON.stringify({taskId:run.taskId,runId:run.runId,state:run.state,reports:reports.map(report=>({reportId:report.reportId,title:report.title})),summary:run.resultSummary ?? reports.at(-1)?.body.slice(0,4000) ?? "本次没有结果报告，请查看 task_history。"})}\n此事件只交付结果，不授予或恢复任何旧执行租约；交付失败的重投不会重新执行任务。`,
      createdAt:this.now(),updatedAt:this.now(),state:"queued",
    };
    this.put("sessionMessage",eventId,message,run.taskId,message.state);
  }
  originPendingRuns(nodeId:string,sessionId:string) {
    return this.list<Run>("run").filter(run=>run.dispatchOrigin?.kind==="session" && run.dispatchOrigin.nodeId===nodeId && run.dispatchOrigin.sessionId===sessionId).flatMap(run=>{
      const messages=this.sessionMessages(run.taskId).filter(message=>message.completion?.runId===run.runId);
      const pending=!TERMINAL.has(run.state) || messages.some(message=>message.state!=="completed");
      return pending ? [{taskId:run.taskId,runId:run.runId,state:run.state,...(messages.at(-1)?{deliveryState:messages.at(-1)!.state}:{})}] : [];
    });
  }
  recordTaskReturnFailure(messageId: string, code: string, detail?: ReturnFailure) {
    const message=this.getSessionMessage(messageId);
    if((!message.completion && !message.checkIn) || message.state!=="queued")return;
    const parsed=ReturnFailure.safeParse(detail ?? {code});
    const failure=parsed.success ? parsed.data : {code:"RETURN_UNAVAILABLE" as const};
    const busy=failure.code==="CHECKIN_BUSY", limited=rateLimited(failure,this.clock());
    if(message.checkIn && !limited) this.checkins.failure(message,busy);
    if(!busy) {
      message.consecutiveDeliveryFailures ??= message.deliveryFailure ? 0 : message.deliveryAttempts ?? 0;
      message.deliveryAttempts=(message.deliveryAttempts ?? 0)+1;
      if(!limited && ++message.consecutiveDeliveryFailures>=3) message.state="failed";
    }
    message.deliveryFailure=failure;
    message.lastDeliveryError=code.slice(0,200);
    message.lastAttemptAt=this.now();
    message.nextAttemptAt=returnRetryAt(failure,this.clock());
    if(!busy) {
      const id=hash([message.nodeId,message.sessionId]),prior=this.get<{until:string}>("sessionReturnCooldown",id);
      this.put("sessionReturnCooldown",id,{until:prior && prior.until>message.nextAttemptAt ? prior.until : message.nextAttemptAt},null);
    }
    if(message.state==="failed")message.reply=["QUOTA","ACCOUNT_QUOTA"].includes(failure.code) ? `原会话额度不足（${failure.code}），连续三次未能处理回信；请修复额度后手动重试。` : "原会话连续三次未能处理回信，已停止自动问询；请修复会话后手动重试。";
    this.put("sessionMessage",messageId,message,message.taskId,message.state);
  }
  retryTaskReturn(commandId: string, messageId: string) {
    this.planner();
    return this.command(commandId,"retryTaskReturn",{messageId},()=>{
      const message=this.getSessionMessage(messageId);
      if(!message.completion && message.checkIn?.kind!=="execution-deadline")fail("INVALID","Not a task result return or execution progress check");
      if(message.state==="completed")return message;
      message.state="queued";message.consecutiveDeliveryFailures=0;delete message.reply;delete message.nextAttemptAt;message.updatedAt=this.now();
      this.put("sessionMessage",messageId,message,message.taskId,message.state);
      return message;
    });
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
    if (task.admissionState === "dismissed" || run?.dispatchOrigin?.kind === "session") return;
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
    }, true);
  }
  nodeStatuses(at = this.clock()): NodeStatus[] {
    const ttl = finite(
      this.options.heartbeatTtlMs ?? 60000,
      100,
      3600000,
      "heartbeat TTL",
    );
    const claims = new Map(
      this.db
        .prepare(
          `
      SELECT json_extract(data,'$.route.nodeId') AS node_id,COUNT(*) AS count
      FROM entities WHERE kind='run' AND state IN ('running','uncertain')
        AND json_extract(data,'$.route.nodeId') IS NOT NULL
        AND COALESCE(json_extract(data,'$.historyOnly'),0)=0
        AND COALESCE(json_extract(data,'$.observationOnly'),0)=0
      GROUP BY json_extract(data,'$.route.nodeId')
    `,
        )
        .all()
        .map((row) => [String(row.node_id), Number(row.count)]),
    );
    return this.list<NodeCapability>("node").map((node) => {
      const h = this.get<{
        observedAt: string;
        runtimeReady: boolean;
        activeExecutions: number;
        providerStatus?: Json;
        source: "authenticated-peer" | "host-local";
      }>("heartbeat", node.nodeId);
      const activeClaims = claims.get(node.nodeId) ?? 0;
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

  getReport(reportId: string) {
    return this.need<Report>("report", reportId);
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
  registeredWorkspaces(nodeId: string): Workspace[] {
    return this.list<Workspace>("workspace").filter(
      (workspace) => workspace.nodeId === nodeId,
    );
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
    const caller=this.dispatchOrigins.getStore();
    const coordinator=caller?.kind==="session" ? this.dispatcherForSession(caller.nodeId,caller.sessionId) : undefined;
    if(coordinator && !input.parentTaskId)input={...input,parentTaskId:coordinator.taskId,parentRunId:coordinator.runId};
    const acceptanceOperation = this.acceptanceOperations.getStore();
    if (acceptanceOperation && !input.parentTaskId) input = {...input, parentTaskId: this.need<AcceptanceGate>("acceptanceGate", acceptanceOperation.gateId).workstreamTaskId};
    const independentTaskId = this.acceptanceIndependentOperations.getStore();
    if (independentTaskId && !input.parentTaskId) input = {...input, parentTaskId: independentTaskId};
    const key = id(input.taskId ?? randomUUID());
    if (this.get("task", key)) fail("CONFLICT", "Task ID already exists");
    this.acceptanceNewTask(key, input.parentTaskId);
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
      allowedBackends: [],
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
      "allowedBackends",
    ] as const) {
      const parentValues = field === "allowedBackends" && parent ? (parent.policy?.allowedBackends ?? []) : parent?.policy?.[field];
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
    if(policy.maxResultRetries!==undefined){finite(policy.maxResultRetries,0,5,"report retry limit");if(!Number.isInteger(policy.maxResultRetries))fail("INVALID","Report retry count must be integer");if(parent&&policy.maxResultRetries>(parent.policy?.maxResultRetries??2))fail("FORBIDDEN","Child report retry budget expanded");}
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
    const origin = this.dispatchOrigins.getStore();
    if (origin) {
      task.dispatchOrigin = structuredClone(origin);
    }
    this.saveTask(task);
    this.checkins.capture(task);
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
      maxResultRetries?: number;
      urgency?: number;
    },
  ) {
    this.planner();
    return this.command(commandId, "updateTask", input, () => {
      const t = this.getTask(input.taskId);
      if (["title", "description", "goal", "acceptanceCriteria", "tags"].some(field => Object.hasOwn(input, field))) this.assertAcceptanceTask(t.taskId, "plan");
      if (
        (t.revision !== undefined || input.expectedRevision !== undefined) &&
        input.expectedRevision !== (t.revision ?? 1)
      )
        fail("CONFLICT", "Task revision changed");
      if(this.list<RegistrationRecord>("registration").some(r=>r.packet.tasks.some(x=>mappedId(r.namespace,r.projectExternalId,"task",x.externalId)===t.taskId))) fail("FORBIDDEN","Origin owns registered task facts");
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
      if(input.maxResultRetries!==undefined){finite(input.maxResultRetries,0,5,"report retry limit");if(!Number.isInteger(input.maxResultRetries))fail("INVALID","Report retry count must be integer");if(t.parentTaskId&&input.maxResultRetries>(this.getTask(t.parentTaskId).policy?.maxResultRetries??2))fail("FORBIDDEN","Child report retry budget expanded");t.policy={...t.policy,maxResultRetries:input.maxResultRetries};}
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
      expectedActionVersion?: string;
      actor: string;
      reason: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "setTaskConfirmation", input, () => {
      this.assertTaskActionVersion(input.taskId, input.expectedActionVersion);
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
      "taskRetry",
      "workflow",
      "workflowInvocation",
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
    if (config.taskRetry !== undefined) {
      const retry = config.taskRetry as {sourceRunId?: unknown; automatic?: unknown; count?: unknown};
      if (!retry || typeof retry !== "object" || Array.isArray(retry) || Object.keys(retry).sort().join(",") !== "automatic,count,sourceRunId" || typeof retry.sourceRunId !== "string" || typeof retry.automatic !== "boolean" || !Number.isInteger(retry.count) || (retry.count as number) < 0 || (retry.count as number) > 5)
        fail("INVALID", "Invalid report retry configuration");
      result.taskRetry = config.taskRetry;
    }
    if (config.workflow !== undefined) {
      const workflow = config.workflow;
      if (!workflow || typeof workflow !== "object" || Array.isArray(workflow) || typeof workflow.workflowRunId !== "string" || typeof workflow.workflowId !== "string" || typeof workflow.stepId !== "string" || !Number.isInteger(workflow.definitionRevision)) fail("INVALID", "Invalid workflow provenance");
      result.workflow = structuredClone(workflow);
    }
    if (config.workflowInvocation !== undefined) {
      const invocation = config.workflowInvocation;
      if (!invocation || typeof invocation !== 'object' || Array.isArray(invocation) || Object.keys(invocation).some(key => key !== 'workflowId') || typeof invocation.workflowId !== 'string') throw new TaskError('INVALID', 'Invalid workflow invocation');
      id(invocation.workflowId, 'workflow ID');
      result.workflowInvocation = structuredClone(invocation);
    }
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
    let timeZone: string | undefined;
    if (!scheduledTimeZone(run.configuration) && run.occurrenceId) {
      const occurrence = this.get<{ scheduleId: string }>("occurrence", run.occurrenceId);
      if (occurrence) {
        const changed = this.db.prepare("SELECT 1 FROM events WHERE json_extract(data,'$.type')='schedule.updated' AND json_extract(data,'$.detail.next.scheduleId')=? AND json_extract(data,'$.detail.previous.timeZone') IS NOT json_extract(data,'$.detail.next.timeZone') LIMIT 1").get(occurrence.scheduleId);
        if (!changed) timeZone = this.getSchedule(occurrence.scheduleId).timeZone ?? "UTC";
      }
    }
    const sessionTitle = runSessionTitle(run, { tasks: [this.getTask(run.taskId)], runs: this.list<Run>("run", run.taskId), timeZone });
    const context = { ...(template ? { template } : {}), reports, sessionTitle };
    if (Buffer.byteLength(canonical(context)) > 1_000_000)
      fail("TOO_LARGE", "Resolved execution context exceeds 1 MB");
    return context;
  }
  private projectSettingsId(projectId: string): string {
    if (projectId.startsWith("pr:") && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pr_projects'").get() && this.db.prepare("SELECT 1 FROM pr_projects WHERE id=?").get(projectId.slice(3))) return projectId.slice(3);
    return projectId;
  }
  projectForTask(taskId: string, parentRunId?: string): string | undefined {
    const projects = new Set<string>(), visited = new Set<string>();
    const add = (projectId: string | undefined) => { if (projectId) projects.add(this.projectSettingsId(projectId)); };
    const hasWorkbench = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_projects'").get();
    let task: Task | undefined = this.getTask(taskId);
    add(this.acceptanceTaskGate(taskId)?.projectId);
    if (parentRunId) add(this.getRun(parentRunId).projectContext?.project?.projectId);
    while (task && !visited.has(task.taskId)) {
      visited.add(task.taskId);
      add(this.get<{projectId: string}>("acceptanceIndependentProject", task.taskId)?.projectId);
      if (hasWorkbench) for (const row of this.db.prepare("SELECT DISTINCT p.project_id FROM wb_projects p JOIN wb_backlogs b ON b.project_id=p.project_id JOIN wb_backlog_tasks t ON t.backlog_id=b.backlog_id WHERE t.task_id=?").all(task.taskId)) add(String(row.project_id));
      if (task.parentRunId) add(this.getRun(task.parentRunId).projectContext?.project?.projectId);
      task = task.parentTaskId ? this.getTask(task.parentTaskId) : undefined;
    }
    add(this.dispatchProjectId());
    if (projects.size > 1) fail("AMBIGUOUS_PROJECT", "Task ancestry and current coordinator must belong to one project");
    return projects.values().next().value;
  }
  dispatchProjectId(): string | undefined {
    const caller = this.dispatchOrigins.getStore();
    if (caller?.kind !== "session" || caller.parentLease) return undefined;
    let managed: string | undefined;
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pr_sessions'").get()) {
      const session = this.db.prepare("SELECT s.owner,s.generation,p.session AS current_session,p.generation AS current_generation,p.state AS project_state FROM pr_sessions s JOIN pr_projects p ON p.id=s.owner WHERE s.session=?").get(caller.sessionId);
      if (session) {
        if (caller.nodeId !== this.nodeId) fail("FORBIDDEN", "A peer cannot claim a local managed project session");
        if (String(session.current_session) !== caller.sessionId || Number(session.generation) !== Number(session.current_generation) || session.project_state !== "ready") fail("STALE_PROJECT_SESSION", "This managed project session is retired or changing owner; use the current ready generation");
        managed = this.projectSettingsId(String(session.owner));
      }
    }
    const bound = this.dispatcherForSession(caller.nodeId, caller.sessionId)?.projectId;
    const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dispatcher_projects'").get()
      ? this.db.prepare("SELECT project FROM dispatcher_projects WHERE node=? AND session=?").get(caller.nodeId, caller.sessionId) : undefined;
    const scopes = new Set([managed, bound ? this.projectSettingsId(bound) : undefined, row ? this.projectSettingsId(String(row.project)) : undefined].filter((value): value is string => !!value));
    if (scopes.size > 1) fail("AMBIGUOUS_PROJECT", "Current coordinator bindings disagree");
    return scopes.values().next().value;
  }
  projectExecutionPolicy(projectId: string, nodeId?: string) {
    const settings = this.projectExecutionSettings.read(this.projectSettingsId(projectId));
    if (nodeId && settings.allowedNodeIds !== null && !settings.allowedNodeIds.includes(nodeId)) fail("PROJECT_NODE_NOT_ALLOWED", "Project settings no longer allow this executor; create a new Run on an allowed executor");
    const binding = nodeId && Object.hasOwn(settings.executionBindings, nodeId) ? settings.executionBindings[nodeId] : undefined;
    const workspaceId = binding ?? this.projectWorkspaceConstraint(settings.projectId);
    if (workspaceId && nodeId) {
      const workspace = this.getWorkspace(workspaceId), node = this.getNode(nodeId);
      if (workspace.nodeId !== nodeId || workspace.state !== "ready" || !node.workspaceIds.includes(workspaceId) || !node.enabled) fail("WORKSPACE_POLICY", "Project execution workspace is unavailable or no longer authorized for this executor");
    }
    return {...settings, ...(workspaceId ? {workspaceId} : {})};
  }
  projectWorkspaceConstraint(projectId: string): string | undefined {
    projectId = this.projectSettingsId(projectId);
    if (this.projectExecutionSettings.read(projectId).revision > 0) return undefined;
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pr_project_workspaces'").get()) return undefined;
    const row = this.db.prepare("SELECT workspace FROM pr_project_workspaces WHERE project=?").get(projectId);
    if (!row) return undefined;
    const binding = JSON.parse(String(row.workspace)) as {workspaceId:string;nodeId:string;path:string;scope?:"coordinator"};
    if (binding.scope === "coordinator") return undefined;
    const workspace = this.getWorkspace(binding.workspaceId), node = this.getNode(binding.nodeId);
    if (workspace.nodeId !== binding.nodeId || workspace.path !== binding.path || workspace.state !== "ready" || !node.enabled || !node.workspaceIds.includes(binding.workspaceId))
      fail("WORKSPACE_POLICY","The project's selected workspace is unavailable or no longer authorized");
    return binding.workspaceId;
  }
  private projectContextSnapshot(
    task: Task,
    parentRunId?: string,
    selectedProjectId?: string,
  ): ProjectExecutionContext | undefined {
    if (parentRunId) {
      const parent = this.getRun(parentRunId).projectContext;
      if (parent && (parent.project || !selectedProjectId)) return projectContext(parent);
    }
    const projectId = selectedProjectId ?? this.projectForTask(task.taskId, parentRunId);
    const p = projectId && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_projects'").get()
      ? this.db.prepare("SELECT * FROM wb_projects WHERE project_id=? OR project_id=?").get(projectId, `pr:${projectId}`)
      : undefined;
    // Ordinary independently dispatched work has authority-owned temporary scope.
    // Conversation provisioning is optional; external tools do not create pr_adhoc rows.
    return projectContext({
      version: 1,
      schedulerId: this.schedulerIdentity(),
      project: p
        ? {
            projectId: p.project_id,
            revision: p.revision,
            title: p.title,
            goal: p.goal,
            description: p.description,
            acceptanceCriteria: JSON.parse(String(p.criteria)),
          }
        : null,
    });
  }
  private newRun(
    input: RunInput,
    inherited?: {
      workspaceConstraint?: string;
      projectContext?: ProjectExecutionContext;
      projectId?: string;
      coordinatorSession?: Run["coordinatorSession"];
    },
  ): Run {
    input = structuredClone(input);
    const task = this.getTask(input.taskId);
    const caller=this.dispatchOrigins.getStore();
    const coordinator=caller?.kind==="session" ? this.dispatcherForSession(caller.nodeId,caller.sessionId) : undefined;
    if(coordinator && (task.taskId===coordinator.taskId || !this.descendants(coordinator.taskId).some(child=>child.taskId===task.taskId)))fail("FORBIDDEN","Coordinator may dispatch only its descendant tasks");
    const parentRunId = this.inferParentRun(task.parentTaskId, input.parentRunId);
    const relatedProject = this.projectForTask(task.taskId, parentRunId);
    const selectedProject = inherited?.projectId ? this.projectSettingsId(inherited.projectId) : undefined;
    if (relatedProject && selectedProject && relatedProject !== selectedProject) fail("AMBIGUOUS_PROJECT", "Recorded planning scope differs from Task project");
    const projectId = relatedProject ?? selectedProject;
    if (projectId && !this.acceptanceTaskGate(task.taskId)) for (const gate of this.acceptanceGates().filter(item => item.projectId === projectId)) {
      if (!this.get("acceptanceIndependent", hash([gate.gateId, task.taskId]))) fail("ACCEPTANCE_REQUIRED", "Unclassified Project Run cannot bypass its acceptance gate");
    }
    const acceptanceGate = this.acceptanceTaskGate(task.taskId);
    const isGatedWorkflowContainer = acceptanceGate && !input.route && this.acceptanceWorkflowContainer(task.taskId, input.configuration, acceptanceGate);
    if (!isGatedWorkflowContainer) this.assertAcceptanceTask(task.taskId, "run");
    const projectPolicy = projectId ? this.projectExecutionPolicy(projectId, input.route?.nodeId) : undefined;
    if (projectPolicy?.allowedNodeIds?.length === 0 && !inherited?.coordinatorSession) fail("PROJECT_NODE_NOT_ALLOWED", "Project settings disable new execution dispatches");
    const projectWorkspace = projectPolicy?.workspaceId;
    if (projectWorkspace && ((input.route?.workspaceId && input.route.workspaceId !== projectWorkspace) || (task.workspaceId && task.workspaceId !== projectWorkspace)))
      fail("FORBIDDEN", "Execution cannot override the selected project workspace");
    if (projectWorkspace && input.route && input.route.nodeId !== this.getWorkspace(projectWorkspace).nodeId)
      fail("FORBIDDEN", "Execution must use the selected project device");
    if (projectWorkspace && input.route) input.route.workspaceId = projectWorkspace;
    const workspaceConstraint = inherited
      ? (inherited.workspaceConstraint ?? projectWorkspace ?? task.workspaceId)
      : (projectWorkspace ?? input.route?.workspaceId ?? task.workspaceId);
    if (
      task.workspaceId &&
      input.route?.workspaceId &&
      task.workspaceId !== input.route.workspaceId
    )
      fail(
        "FORBIDDEN",
        "Explicit route cannot override the Task workspace constraint",
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
    const scopedContext = inherited?.projectContext ?? this.projectContextSnapshot(task,parentRunId,projectId);
    const project = scopedContext?.project===null && workspaceConstraint ? undefined : scopedContext;
    if (input.route) {
      const workspaceId =
        input.route.workspaceId ??
        task.workspaceId ??
        this.get<TaskSession>(
          "taskSessionDefault",
          hash([task.taskId, input.route.nodeId]),
        )?.workspaceId ??
        (!project ? this.getNode(input.route.nodeId).defaultWorkspaceId : undefined);
      if (workspaceId) input.route = { ...input.route, workspaceId };
      this.validateRoute(input.route,{admission:true,skipModel:!!input.executionModel});
      if (input.route.backend && !task.policy?.allowedBackends?.includes(input.route.backend)) fail("FORBIDDEN", "Native backend grant required");
      const node = this.getNode(input.route.nodeId);
      let ancestorRunId = parentRunId;
      let occupiedByAncestors = 0;
      while (ancestorRunId) {
        const ancestorRun = this.getRun(ancestorRunId);
        if (ancestorRun.route?.nodeId === node.nodeId &&
            ["running", "uncertain"].includes(ancestorRun.state)) occupiedByAncestors++;
        ancestorRunId = ancestorRun.parentRunId;
      }
      // Ancestors cannot release these slots while awaiting this child. Other
      // independent work may finish, so it remains ordinary capacity queueing.
      if (occupiedByAncestors >= (node.maxConcurrent ?? 1))
        fail("DELEGATION_DEADLOCK", `Active ancestor chain occupies all ${node.maxConcurrent ?? 1} executor slots; increase node capacity or delegate to another eligible node`);
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
    const invocation = configuration && typeof configuration === 'object' && !Array.isArray(configuration) && configuration.workflowInvocation;
    if (this.hasWorkflowBinding(task.taskId) && !invocation) fail('WORKFLOW_TASK','Start this Task through its configured workflow');
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
      ...(input.expectedExecutionMs !== undefined ? {executionExpectation:{phase:"pending_start" as const,expectedExecutionMs:ExpectedExecutionMs.parse(input.expectedExecutionMs)}} : {}),
      runId: key,
      taskId: task.taskId,
      ...(parentRunId ? { parentRunId, executionParentKind: this.getRun(parentRunId).coordinatorSession ? "coordinator" : "executor", ...(!this.getRun(parentRunId).coordinatorSession ? {executionParentRunId: parentRunId} : {}) } : {}),
      ...(inherited?.coordinatorSession ? {coordinatorSession: inherited.coordinatorSession} : {}),
      ...(projectPolicy ? {projectSettingsRevision: projectPolicy.revision, ...(input.route && projectPolicy.workspaceId ? {projectExecutionBinding: projectPolicy.workspaceId} : {})} : {}),
      state: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
      sessionIds: contextSessionIds,
      historyOnly: false,
      configuration,
      ...(project ? { projectContext: project } : {}),
      ...(input.executionModel ? { executionModel: input.executionModel } : {}),
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
      ...(workspaceConstraint ? { workspaceConstraint } : {}),
      ...(input.occurrenceId ? { occurrenceId: input.occurrenceId } : {}),
    };
    if (this.isWorkflowInvocation(run) && run.route) fail('FORBIDDEN', 'Workflow roots cannot have an execution route');
    const origin = this.dispatchOrigins.getStore() ?? this.get<DispatchOrigin>("pendingDispatchOrigin",task.taskId) ?? {kind:"system" as const, nodeId:this.options.nodeId ?? "system"};
    run.dispatchOrigin = structuredClone(origin);
    this.db.prepare("DELETE FROM entities WHERE kind='pendingDispatchOrigin' AND id=?").run(task.taskId);
    this.saveRun(run);
    const acceptanceMember = this.acceptanceTaskMember(task.taskId);
    if (acceptanceMember) {
      const gate = this.acceptanceGateView(acceptanceMember.gateId);
      this.put("acceptanceRun", run.runId, {...acceptanceMember, runId: run.runId, gateRevision: gate.revision, candidateDigest: gate.acceptance?.candidateDigest ?? null}, task.taskId);
    }
    if(input.executionModel)this.refreshDispatchEligibility(run.runId);
    if (this.isWorkflowInvocation(run)) {
      const admit = this.workflowRunAdmission ?? fail('UNAVAILABLE', 'Workflow runtime is unavailable');
      const config = run.configuration as {workflowInvocation: {workflowId: string}; input?: Json};
      admit(run, {workflowId: config.workflowInvocation.workflowId, input: config.input ?? null});
    }
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
    return this.getRun(run.runId);
  }
  dispatchRoutes(input:{taskId?:string;projectId?:string;route?:ExecutionRoute;nodeId?:string;executionModel?:ExecutionModelChoice;workspaceId?:string},excludedNodeId?:string): ExecutionRoute[] {
    const task=input.taskId?this.getTask(input.taskId):undefined;
    const projectId=input.projectId ?? (task?this.projectForTask(task.taskId):this.dispatchProjectId());
    const explicitWorkspace=input.route?.workspaceId ?? input.workspaceId ?? task?.workspaceId;
    const nodeId=input.route?.nodeId ?? input.nodeId ?? (explicitWorkspace?this.getWorkspace(explicitWorkspace).nodeId:undefined);
    if(nodeId && !this.getNode(nodeId).enabled)fail("FORBIDDEN","Node disabled");
    const project=projectId?this.projectExecutionPolicy(projectId,nodeId):undefined;
    const health=new Map(this.nodeStatuses().map(node=>[node.nodeId,node]));
    const candidates=this.decisionCatalog().nodes.filter(node=>node.enabled && node.nodeId!==excludedNodeId && !(this.role==="planner"&&node.nodeId===this.nodeId) && node.roles.some(role=>role==="executor"||role==="both") && (!nodeId || node.nodeId===nodeId) && (project?.allowedNodeIds==null || project.allowedNodeIds.includes(node.nodeId)) && (!task?.policy?.allowedNodeIds || task.policy.allowedNodeIds.includes(node.nodeId)));
    const routes=candidates.flatMap(node=>{
      try {
        const policy=projectId?this.projectExecutionPolicy(projectId,node.nodeId):undefined;
        if(explicitWorkspace && policy?.workspaceId && explicitWorkspace!==policy.workspaceId)fail("WORKSPACE_POLICY","Explicit workspace conflicts with the project execution binding");
        const workspaceId=explicitWorkspace ?? policy?.workspaceId;
        const route=input.route ?? {nodeId:node.nodeId,...this.selectExecutionModel(node.nodeId,input.executionModel).choice,...(workspaceId?{workspaceId}:{}),requiredCapabilities:[]};
        if(task?.policy?.allowedWorkspaceIds && (!route.workspaceId || !task.policy.allowedWorkspaceIds.includes(route.workspaceId)))fail("FORBIDDEN","Task policy excludes this workspace");
        if(route.backend && task && !task.policy?.allowedBackends?.includes(route.backend))fail("FORBIDDEN","Task policy excludes this backend");
        const catalog=this.executionModels.view(node.nodeId).catalog;
        this.validateRoute(route,{admission:true,skipModel:catalog.state!=="fresh" || !catalog.snapshot?.complete});
        return [route];
      } catch(error) {
        if(nodeId || !(error instanceof TaskError))throw error;
        return [];
      }
    });
    const slots=(id:string)=>{const status=health.get(id);return Math.max(0,(status?.maxConcurrent ?? 1)-Math.max(status?.activeClaims ?? 0,status?.activeExecutions ?? 0));};
    return routes.sort((a,b)=>Number(health.get(b.nodeId)?.state==="online")-Number(health.get(a.nodeId)?.state==="online") || slots(b.nodeId)-slots(a.nodeId) || a.nodeId.localeCompare(b.nodeId));
  }
  dispatchExistingTask(commandId: string, input: Omit<RunInput,"executionModel"> & {nodeId?:string;executionModel?:ExecutionModelChoice;retry?:boolean;expectedActionVersion?:string}, excludedNodeId?:string) {
    this.planner();
    const rejected=this.get<{digest:string;code:string;message:string}>("taskDispatchRejection",commandId);
    if(rejected) {
      if(rejected.digest!==hash(input))fail("CONFLICT","Dispatch commandId reused with different arguments");
      throw new TaskError(rejected.code,rejected.message);
    }
    try {return this.command(commandId, "dispatchExistingTask", input, () => {
      const task=this.getTask(input.taskId),runs=this.list<Run>("run",task.taskId).filter(run=>!(run.historyOnly||run.observationOnly));
      if (task.kind==="observed" || task.state==="archived" || this.hasWorkflowBinding(task.taskId)) fail("FORBIDDEN","Task does not support direct dispatch");
      if(runs.some(run=>["queued","running","uncertain"].includes(run.state))) fail("CONFLICT","Task has pending execution; inspect or repair the existing Run before dispatching");
      if(runs.length && !input.retry) fail("RETRY_REQUIRED","Task has executed before; use retry=true and its current expectedActionVersion for a new Run");
      if(input.retry) {
        text(input.expectedActionVersion ?? fail("INVALID","Explicit retry requires expectedActionVersion"),"expectedActionVersion",200);
        this.assertTaskActionVersion(task.taskId,input.expectedActionVersion);
      }
      if(["cancelled","completed","failed"].includes(task.state)) {
        if(!input.retry)fail("RETRY_REQUIRED","Closed Task requires explicit retry=true and expectedActionVersion");
        task.state="ready";task.updatedAt=this.now();delete task.manualCompletion;this.saveTask(task);
      }
      if(input.route && (input.nodeId || input.executionModel))fail("INVALID","route cannot be combined with nodeId or executionModel");
      const assignment=this.dispatchRoutes(input,excludedNodeId)[0] ?? fail("EXECUTOR_REQUIRED","No authorized executor supports this task; inspect task_nodes");
      const nodeId=assignment.nodeId;
      const selected=this.selectExecutionModel(nodeId,input.route?ExecutionModelChoice.strip().parse(input.route):input.executionModel);
      const {retry:_retry,expectedActionVersion:_version,nodeId:_node,executionModel:_model,...runInput}=input;
      const run=this.newRun({...runInput,route:assignment,executionModel:selected.executionModel});
      if(input.retry)this.event("task.explicit_retry",{previousRunId:runs.at(-1)?.runId ?? null},task.taskId,run.runId);
      return run;
    });} catch(error) {
      if(error instanceof TaskError && !this.commandReceipt(commandId) && !["UNAVAILABLE","REMOTE_OUTCOME_UNCERTAIN"].includes(error.code))this.put("taskDispatchRejection",commandId,{digest:hash(input),code:error.code,message:error.message});
      throw error;
    }
  }
  createRun(commandId: string, input: RunInput) {
    this.planner();
    return this.command(commandId, "createRun", input, () =>
      this.newRun(input),
    );
  }
  registerPairedExecutor(commandId:string,nodeId:string,providerStatus?:unknown,executionEnabled=true) {
    id(nodeId);
    const prior=this.get<NodeCapability>("node",nodeId),managed=this.get<{managed:true}>("pairedExecutor",nodeId);
    if(prior && !managed)return prior;
    const advertised=providerStatus===undefined && prior ? {models:prior.models,capabilities:prior.capabilities} : pairedExecutorModels(nodeId,providerStatus);
    const next:NodeCapability={nodeId,roles:[executionEnabled ? "executor" : "planner"],...advertised,workspaceIds:prior?.workspaceIds ?? [],enabled:true,maxConcurrent:prior?.maxConcurrent ?? 1,lastSeenAt:this.now()};
    return this.command(commandId,"registerPairedExecutor",{nodeId,providerStatus:providerStatus ?? null,executionEnabled},()=>{this.put("pairedExecutor",nodeId,{managed:true});this.put("node",nodeId,next);return next;});
  }
  deactivatePairedExecutor(commandId:string,nodeId:string) {
    const node=this.get<NodeCapability>("node",nodeId);
    if(!node)return;
    return this.command(commandId,"deactivatePairedExecutor",{nodeId},()=>{node.enabled=false;this.put("node",nodeId,node);return node;});
  }
  executorWorkspaceCatalog(nodeId: string): ExecutorWorkspaceCatalog {
    return this.get<ExecutorWorkspaceAnnouncement>("executorWorkspaceCatalog", nodeId) ?? {nodeId, sampledAt: null, workspaces: []};
  }
  /** Only the authenticated transport/host may submit this physically verified full snapshot. */
  recordExecutorWorkspaces(commandId: string, input: ExecutorWorkspaceAnnouncement) {
    this.planner();
    const parsed = ExecutorWorkspaceSnapshot.safeParse(input);
    const snapshot = parsed.success ? parsed.data : fail("INVALID", "Invalid executor workspace announcement");
    if (snapshot.workspaces.some(workspace => workspace.nodeId !== snapshot.nodeId || !/^(\/|[A-Za-z]:[\\/])/.test(workspace.path)) || new Set(snapshot.workspaces.map(workspace => workspace.workspaceId)).size !== snapshot.workspaces.length || new Set(snapshot.workspaces.filter(workspace => workspace.state === "ready").map(workspace => workspace.path)).size !== snapshot.workspaces.filter(workspace => workspace.state === "ready").length) fail("INVALID", "Executor snapshot must contain distinct workspace identities and absolute local paths for its own node");
    return this.command(commandId, "recordExecutorWorkspaces", snapshot, () => {
      const node = this.getNode(snapshot.nodeId), prior = this.executorWorkspaceCatalog(snapshot.nodeId);
      if (prior.sampledAt !== null && snapshot.sampledAt < prior.sampledAt) fail("STALE_WORKSPACE_CATALOG", "Executor workspace announcement is older than the current snapshot");
      if (prior.sampledAt === snapshot.sampledAt) {
        if (canonical(prior.workspaces) !== canonical(snapshot.workspaces)) fail("CONFLICT", "Workspace snapshot changed at the same observation time");
        return prior;
      }
      const authority = this.get<ExecutorWorkspaceAuthority>("executorWorkspaceAuthority", node.nodeId) ?? {workspaceIds: [], grantIds: []};
      const workspaceIds = new Set(authority.workspaceIds), grantIds = new Set(authority.grantIds), grants = new Set(node.workspaceIds);
      const ready = new Set(snapshot.workspaces.filter(workspace => workspace.state === "ready").map(workspace => workspace.workspaceId));
      for (const workspaceId of grantIds) if (!ready.has(workspaceId)) { grants.delete(workspaceId); grantIds.delete(workspaceId); }
      for (const workspaceId of workspaceIds) if (!ready.has(workspaceId)) {
        const workspace = this.getWorkspace(workspaceId);
        workspace.state = "failed"; this.put("workspace", workspaceId, workspace);
      }
      const registered = this.list<Workspace>("workspace");
      for (const announced of snapshot.workspaces) {
        const existing = this.get<Workspace>("workspace", announced.workspaceId);
        if (existing && (existing.nodeId !== announced.nodeId || existing.path !== announced.path)) fail("CONFLICT", "Executor workspace identity cannot be rebound to another node or directory");
        if (announced.state === "ready" && registered.some(workspace => workspace.nodeId === announced.nodeId && workspace.path === announced.path && workspace.workspaceId !== announced.workspaceId && workspace.state === "ready" && grants.has(workspace.workspaceId))) fail("CONFLICT", "Executor directory already has another workspace identity");
        if (!existing) workspaceIds.add(announced.workspaceId);
        if (!existing || workspaceIds.has(announced.workspaceId)) this.put("workspace", announced.workspaceId, {
          workspaceId: announced.workspaceId, nodeId: announced.nodeId, path: announced.path, label: announced.label,
          state: announced.state === "ready" ? "ready" : "failed", createdAt: existing?.createdAt ?? new Date(snapshot.sampledAt).toISOString(),
        } satisfies Workspace);
        const effective = this.getWorkspace(announced.workspaceId);
        if (announced.state === "ready" && effective.state === "ready" && !grants.has(announced.workspaceId)) { grants.add(announced.workspaceId); grantIds.add(announced.workspaceId); }
      }
      node.workspaceIds = [...grants];
      this.put("node", node.nodeId, node);
      this.put("executorWorkspaceAuthority", node.nodeId, {workspaceIds: [...workspaceIds], grantIds: [...grantIds]});
      this.put("executorWorkspaceCatalog", node.nodeId, snapshot);
      this.event("executor.workspaces_observed", {nodeId: node.nodeId, sampledAt: snapshot.sampledAt, count: snapshot.workspaces.length});
      return snapshot;
    });
  }
  private adoptWorkspaceGrants(nodeId: string, workspaceIds: string[], source: "workspace" | "grant") {
    const authority = this.get<ExecutorWorkspaceAuthority>("executorWorkspaceAuthority", nodeId);
    if (!authority) return;
    const adopted = new Set(workspaceIds);
    this.put("executorWorkspaceAuthority", nodeId, {workspaceIds: source === "workspace" ? authority.workspaceIds.filter(workspaceId => !adopted.has(workspaceId)) : authority.workspaceIds, grantIds: source === "grant" ? authority.grantIds.filter(workspaceId => !adopted.has(workspaceId)) : authority.grantIds});
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
      if (
        node.defaultWorkspaceId !== undefined &&
        !node.workspaceIds.includes(id(node.defaultWorkspaceId))
      )
        fail(
          "FORBIDDEN",
          "Default workspace must be in this node's configured grants",
        );
      for (const m of node.models) {
        text(m.provider, "provider", 100);
        text(m.model, "model", 200);
      }
      this.adoptWorkspaceGrants(node.nodeId, node.workspaceIds, "grant");
      this.put("node", node.nodeId, node);
      return node;
    });
  }
  setNodeCapabilities(commandId: string, nodeId: string, capabilities: string[]) {
    this.planner();
    for (const capability of capabilities) text(capability, "capability", 256);
    return this.command(commandId, "setNodeCapabilities", {nodeId, capabilities}, () => {
      const node = this.getNode(nodeId);
      node.capabilities = [...capabilities];
      this.put("node", nodeId, node);
      return node;
    });
  }
  setNodeCapacity(commandId: string, nodeId: string, maxConcurrent: number) {
    this.planner();
    finite(maxConcurrent, 1, 32, "node capacity");
    if (!Number.isInteger(maxConcurrent))
      fail("INVALID", "Node capacity must be integer");
    return this.command(
      commandId,
      "setNodeCapacity",
      { nodeId, maxConcurrent },
      () => {
        const node = this.getNode(nodeId);
        node.maxConcurrent = maxConcurrent;
        this.put("node", nodeId, node);
        return node;
      },
    );
  }
  registerCoordinatorWorkspace(workspace: Workspace) {
    this.assertManagementWritable();
    if (!this.db.isTransaction) fail("FORBIDDEN", "Coordinator workspace metadata requires the placement transaction");
    id(workspace.workspaceId);
    id(workspace.nodeId);
    text(workspace.path, "workspace path", 4000);
    const prior = this.get<Workspace>("workspace", workspace.workspaceId);
    if (prior && (prior.nodeId !== workspace.nodeId || prior.path !== workspace.path)) fail("CONFLICT", "Workspace identity cannot be rebound");
    this.put("workspace", workspace.workspaceId, workspace);
    return workspace;
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
      this.adoptWorkspaceGrants(workspace.nodeId, [workspace.workspaceId], "workspace");
      this.put("workspace", workspace.workspaceId, workspace);
      return workspace;
    });
  }
  returnUnclaimedToInbox(
    commandId: string,
    input: { taskId: string; runId: string },
  ) {
    this.planner();
    return this.command(commandId, "returnUnclaimedToInbox", input, () => {
      const run = this.getRun(input.runId),
        task = this.getTask(input.taskId);
      if (
        run.taskId !== task.taskId ||
        run.state !== "queued" ||
        run.currentAttemptId ||
        this.list<Attempt>("attempt").some((a) => a.runId === run.runId)
      )
        fail("CONFLICT", "Execution has already been claimed");
      run.state = "cancelled";
      run.updatedAt = this.now();
      this.put("run", run.runId, run);
      task.state = "inbox";
      task.updatedAt = this.now();
      this.saveTask(task);
      this.event(
        "run.unclaimed_returned",
        { reason: "executor unavailable before claim" },
        task.taskId,
        run.runId,
      );
      return task;
    });
  }
  validateRoute(route: ExecutionRoute, options:{admission?:boolean;skipModel?:boolean}={}) {
    if (this.role === "planner" && route.nodeId === this.nodeId)
      fail("FORBIDDEN", "Planner-only host cannot execute its own workload");
    const node = this.getNode(route.nodeId);
    if (!node.enabled) fail("FORBIDDEN", "Node disabled");
    if (
      !options.admission && this.options.requireFreshHeartbeat &&
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
    if (route.execution) {
      const program = ProgramRoute.parse(route.execution);
      if (route.backend || route.reasoningEffort || route.provider !== "registered-program" || route.model !== program.programId) fail("INVALID", "Program route cannot select an Agent backend or model");
      const status = this.nodeStatuses().find(entry => entry.nodeId === node.nodeId)?.providerStatus;
      const programs = status && typeof status === "object" && !Array.isArray(status) ? status.programs : undefined;
      if (!Array.isArray(programs) || !programs.some(entry => {
        const parsed = ProgramCatalog.safeParse(entry);
        return parsed.success && parsed.data.nodeId === node.nodeId && parsed.data.programId === program.programId && parsed.data.version === program.version && (!parsed.data.workspaceIds || parsed.data.workspaceIds.includes(route.workspaceId ?? ""));
      })) fail("UNSUPPORTED", "Program version not advertised by executor");
    } else if(!options.skipModel) {
    const positive=this.executionModels.view(route.nodeId).catalog.positiveSnapshot;
    const confirmed=positive && positive.expiresAt>this.clock() && positive.models.some(choice=>sameExecutionModel(choice,route));
    if(!confirmed) {
      const m=node.models.find(x=>x.provider===route.provider&&x.model===route.model) ?? fail("UNSUPPORTED","Provider/model not advertised");
      if(route.reasoningEffort!==undefined && !m.reasoningEfforts.includes(route.reasoningEffort))fail("UNSUPPORTED","Reasoning effort not supported");
    }
    }
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
  /** Native claim + receipt share command()'s BEGIN IMMEDIATE transaction. */
  recoverClaim(commandId: string, input: import("./remote/ports.js").ClaimInput): import("./remote/ports.js").ClaimRecovery {
    try {
      return { kind: "committed", receipt: this.claim(commandId, input) };
    } catch (error) {
      // A rolled-back native TaskError is definite non-admission. Never infer this
      // for arbitrary adapters/errors, or mask a conflicting durable command.
      if (error instanceof TaskError && !this.commandReceipt(commandId))
        return { kind: "rejected", code: error.code, message: error.message };
      throw error;
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
    if (this.configurationPaused)
      fail("CONFIGURATION_BUSY", "Startup configuration is changing");
    return this.command(commandId, "claim", input, () => {
      finite(input.ttlMs, 100, 3_600_000, "lease TTL");
      if (
        (this.role === "planner" && input.nodeId === this.nodeId) ||
        (this.role === "executor" && input.nodeId !== this.nodeId)
      )
        fail("FORBIDDEN", "Role cannot execute on this node");
      let run = this.getRun(input.runId);
      if (this.isWorkflowInvocation(run)) fail("FORBIDDEN", "Workflow roots cannot be claimed");
      if (run.state !== "queued") fail("CONFLICT", "Run is not queued");
      this.assertAcceptanceTask(run.taskId, "claim");
      if (run.retry && Date.parse(run.retry.notBefore) > this.clock())
        fail("NOT_DUE", "Safe retry delay has not elapsed");
      if (!run.route || run.route.nodeId !== input.nodeId)
        fail("FORBIDDEN", "Assignment belongs to another node");
      run=this.refreshDispatchEligibility(run.runId);
      if(run.dispatchIssue) fail(run.dispatchIssue.code,run.dispatchIssue.message);
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
      display?: DelegationDisplayInput;
      expectedExecutionMs?: number;
      title: string;
      description?: string;
      route?: ExecutionRoute;
      policy?: TaskPolicy;
      configuration?: Json;
    },
  ) {
    return this.command(commandId, "delegateTask", input, () => {
      const { run: parentRun, attempt: parentAttempt } = this.owned(input);
      const origin: DispatchOrigin = parentAttempt.sessionId ? {
        kind:"session", nodeId:parentAttempt.nodeId, sessionId:parentAttempt.sessionId,
        ...(parentRun.route ? {composition:{provider:parentRun.route.provider,model:parentRun.route.model,...(parentRun.route.reasoningEffort ? {reasoningEffort:parentRun.route.reasoningEffort} : {})}} : {}),
        parentLease:{runId:input.runId,attemptId:input.attemptId,nodeId:input.nodeId,fence:input.fence,...(input.executionId ? {executionId:input.executionId} : {})},
      } : {kind:"system",nodeId:input.nodeId};
      const display = delegationDisplay(input.display, this.options.delegationDefaultDisplay ?? "task");
      const inheritedRoute = parentRun.route && !this.getTask(parentRun.taskId).workspaceId && parentRun.route.workspaceId === parentRun.projectExecutionBinding
        ? {...parentRun.route, workspaceId: undefined} : parentRun.route;
      const task = this.newTask({
        title: input.title,
        description: input.description,
        parentTaskId: parentRun.taskId,
        parentRunId: parentRun.runId,
        policy: input.policy,
        workspaceId: (input.route ?? inheritedRoute)?.workspaceId,
      });
      const inherited=!parentRun.executionModel || parentRun.executionModel.origin==="explicit" ? inheritedRoute : undefined;
      const selected=this.selectExecutionModel((input.route ?? parentRun.route)!.nodeId,input.route ?? inherited);
      const route=input.route ?? withExecutionModel(inheritedRoute!,selected.choice);
      const run = this.newRun({
        taskId: task.taskId,
        parentRunId: parentRun.runId,
        route,
        executionModel:selected.executionModel,
        configuration: input.configuration,
        ...(input.expectedExecutionMs!==undefined?{expectedExecutionMs:input.expectedExecutionMs}:{}),
      });
      task.dispatchOrigin = origin;
      run.dispatchOrigin = origin;
      this.saveRun(run);
      task.delegationDisplay = display;
      this.saveTask(task);
      this.event(
        "task.delegated",
        {
          parentTaskId: parentRun.taskId,
          parentRunId: parentRun.runId,
          nodeId: input.nodeId,
          parentAttemptId: input.attemptId,
          parentExecutionId: input.executionId ?? null,
          parentFence: input.fence,
          display: { ...display },
        },
        task.taskId,
        run.runId,
      );
      return { task, run };
    });
  }
  scopedHistory(input: LeaseRef & { taskId?: string;read?:TaskReadOptions }) {
    const history=this.history(this.scoped(input,input.taskId).task.taskId);
    return taskRead({...history,tasks:[history.task]},input.read,id=>this.taskActionState(id).version,true);
  }
  scopedAllSettled(input: LeaseRef & { taskId?: string; quietMs?: number }) {
    const { task } = this.scoped(input, input.taskId);
    return this.allSettled(
      task.taskId,
      input.quietMs ?? task.policy?.settlementQuietMs ?? 1000,
      task.taskId === this.getRun(input.runId).taskId ? input.runId : undefined,
      task.taskId !== this.getRun(input.runId).taskId,
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
        input.allowRetry === false || count >= policy.maxRetries;
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

  requestExecutionStatus(
    commandId: string,
    input: { runId: string; expectedActionVersion: string },
  ) {
    this.planner();
    return this.command(commandId, "requestExecutionStatus", input, () => {
      const run = this.getRun(input.runId);
      this.assertTaskActionVersion(run.taskId, input.expectedActionVersion);
      if (
        run.state !== "running" ||
        !run.currentAttemptId ||
        run.cancellationRequested
      )
        fail("CONFLICT", "Execution is not running");
      const attempt = this.getAttempt(run.currentAttemptId!);
      if (Date.parse(attempt.leaseExpiresAt) <= this.clock())
        fail("LEASE_EXPIRED", "Executor lease expired");
      if (!attempt.progressRequest || attempt.progressRequest.summary)
        attempt.progressRequest = {
          requestId: commandId,
          requestedAt: this.now(),
        };
      this.saveAttempt(attempt);
      return attempt;
    });
  }

  renew(
    commandId: string,
    input: LeaseRef & {
      ttlMs: number;
      progress?: { requestId: string; summary: string };
    },
  ) {
    return this.command(commandId, "renew", input, () => {
      finite(input.ttlMs, 100, 3_600_000, "lease TTL");
      const { attempt } = this.owned(input);
      if (input.progress) {
        id(input.progress.requestId, "progress request");
        text(input.progress.summary, "progress summary", 1000);
        if (attempt.progressRequest?.requestId !== input.progress.requestId)
          fail("CONFLICT", "Progress request changed");
        attempt.progressRequest = {
          ...attempt.progressRequest!,
          summary: input.progress.summary,
          reportedAt: this.now(),
        };
      }
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
  markExecutionStarted(commandId: string, ref: LeaseRef) {
    return this.command(commandId,"markExecutionStarted",ref,()=>{
      const executionId=ref.executionId ?? fail("INVALID","executionId is required to start workload");
      const {run,attempt}=this.owned(ref);
      if(attempt.state!=="running" || attempt.executionId!==executionId)fail("EXECUTION_OWNER","Workload start requires its running execution owner");
      if(run.executionExpectation?.phase==="pending_start") {
        run.executionExpectation={phase:"started",expectedExecutionMs:run.executionExpectation.expectedExecutionMs,startedAt:this.now()};
        this.saveRun(run);
        this.event("run.execution_started",{attemptId:attempt.attemptId,executionId},run.taskId,run.runId);
      }
      return run;
    });
  }
  /** Nonsecret stable authority identity, scoped to this ledger rather than an endpoint. */
  executionDisposition(input:{runId:string;attemptId?:string}) {
    const run=this.getRun(input.runId),task=this.getTask(run.taskId);
    const attemptId=input.attemptId ?? run.currentAttemptId;
    const attempt=attemptId ? this.getAttempt(attemptId) : undefined;
    if(attempt && attempt.runId!==run.runId)fail("FORBIDDEN","Attempt does not belong to this Run");
    return {schedulerId:this.schedulerIdentity(),runId:run.runId,taskId:task.taskId,taskState:task.state,runState:run.state,
      attemptId:attempt?.attemptId??null,attemptState:attempt?.state??null,currentAttemptId:run.currentAttemptId??null,cancellationRequested:run.cancellationRequested===true};
  }
  schedulerIdentity(): string {
    return this.need<{ schedulerId: string }>("authority", "scheduler")
      .schedulerId;
  }
  sessionMessageTargets(taskId: string) {
    this.getTask(taskId);
    return this.list<TaskSession>("taskSession", taskId);
  }
  sessionMessages(taskId: string) {
    this.getTask(taskId);
    return this.list<import("./remote/ports.js").SessionMessage>(
      "sessionMessage",
      taskId,
    ).slice(-200);
  }
  getSessionMessage(messageId: string) {
    return this.need<import("./remote/ports.js").SessionMessage>(
      "sessionMessage",
      messageId,
    );
  }
  queueSessionMessage(
    commandId: string,
    input: { taskId: string; nodeId: string; sessionId: string; text: string },
  ) {
    this.planner();
    return this.command(commandId, "queueSessionMessage", input, () => {
      text(input.text, "session message", 8000);
      const target = this.sessionMessageTargets(input.taskId).find(
        (s) => s.nodeId === input.nodeId && s.sessionId === input.sessionId,
      );
      if (!target?.workspaceId)
        fail("FORBIDDEN", "Session is not bound to this task and node");
      const decision = this.getTask(input.taskId).manualCompletion;
      const message: import("./remote/ports.js").SessionMessage = {
        ...(decision?.materials === "pending" &&
        decision.nodeId === input.nodeId &&
        decision.sessionId === input.sessionId
          ? { supplementFor: decision.decisionId }
          : {}),
        messageId: commandId,
        taskId: input.taskId,
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        workspaceId: target!.workspaceId!,
        text: input.text,
        createdAt: this.now(),
        updatedAt: this.now(),
        state: "queued",
      };
      this.put(
        "sessionMessage",
        commandId,
        message,
        input.taskId,
        message.state,
      );
      return message;
    });
  }
  pendingSessionMessages(nodeId: string, options?: SessionMessageQuery) {
    const messages = this.list<import("./remote/ports.js").SessionMessage>(
      "sessionMessage",
    );
    if(options?.forAdmission) {
      if(!options.messageId)fail("INVALID","Admission refresh requires one exact message ID");
      const message=messages.find(m=>m.messageId===options.messageId && m.nodeId===nodeId);
      if(!message)return [];
      let admission=message.state!=="queued"?"obsolete" as const:message.checkIn?this.checkins.disposition(message):"ready" as const;
      if(admission==="ready" && ((message.nextAttemptAt ?? "")>this.now() || (this.get<{until:string}>("sessionReturnCooldown",hash([message.nodeId,message.sessionId]))?.until ?? "")>this.now()))admission="defer";
      return [{...(admission==="ready" && message.checkIn?this.checkins.prepare(message):message),admission}];
    }
    for(const message of messages)if(message.completion && message.state==="queued" && (message.consecutiveDeliveryFailures ?? (!message.deliveryFailure ? message.deliveryAttempts ?? 0 : 0))>=3) {
      message.state="failed";
      message.reply="原会话连续三次未能处理回信，已停止自动问询；请修复会话后手动重试。";
      if(!this.options.readOnly)this.put("sessionMessage",message.messageId,message,message.taskId,message.state);
    }
    const excluded = new Set(options?.excludeMessageIds);
    let start = 0;
    if (options?.afterMessageId) {
      const index = messages.findIndex(m => m.messageId === options.afterMessageId && m.nodeId === nodeId);
      if (index < 0) fail("FORBIDDEN", "Message cursor does not belong to this node");
      start = index + 1;
    }
    return messages.slice(start)
      .filter((m) => (!options?.messageId || m.messageId === options.messageId) && (!m.checkIn || this.checkins.disposition(m) === "ready") && !excluded.has(m.messageId) && (!options?.kind || (options.kind === "completion" ? Boolean(m.completion) : options.kind === "continuation" ? Boolean(m.completion || m.checkIn) : !m.completion && !m.checkIn)) && m.nodeId === nodeId && m.state === "queued" && (!m.nextAttemptAt || m.nextAttemptAt<=this.now()))
      .filter(m=>!(m.completion || m.checkIn) || (this.get<{until:string}>("sessionReturnCooldown",hash([m.nodeId,m.sessionId]))?.until ?? "")<=this.now())
      .slice(0, 4).map(message => message.checkIn ? this.checkins.prepare(message) : message);
  }
  completeSessionMessage(
    commandId: string,
    input: import("./remote/ports.js").SessionMessageResult & {
      messageId: string;
      nodeId: string;
    },
  ) {
    return this.command(commandId, "completeSessionMessage", input, () => {
      const message = this.getSessionMessage(input.messageId);
      if (message.nodeId !== input.nodeId)
        fail("FORBIDDEN", "Message node mismatch");
      if (!["completed", "failed", "uncertain"].includes(input.state))
        fail("INVALID", "Invalid message result");
      text(input.reply, "session reply", 12000);
      if((message.completion || message.checkIn) && input.state==="failed" && message.state==="queued") {
        this.recordTaskReturnFailure(message.messageId,input.reply,input.failure);
        return this.getSessionMessage(message.messageId);
      }
      if (message.state !== "queued") {
        if(message.checkIn && message.state==="completed" && message.withdrawn && input.state==="completed" && input.withdrawn)return message;
        if(message.checkIn?.kind==="execution-deadline" && message.state==="completed" && message.withdrawn && input.state==="completed" && !input.withdrawn && Array.isArray(input.checkInTasks) && input.checkInTasks.length===0) {
          delete message.withdrawn;
          message.reply=input.reply;
          message.updatedAt=this.now();
          this.put("sessionMessage",message.messageId,message,message.taskId,message.state);
          return message;
        }
        if (message.state !== input.state || message.reply !== input.reply)
          fail("CONFLICT", "Message already answered");
        return message;
      }
      if (message.checkIn && input.state === "completed") {
        if(input.withdrawn===true) {
          if(this.checkins.disposition(message)!=="obsolete")fail("CONFLICT","A live progress check cannot be withdrawn");
          message.withdrawn=true;
        }
        const refs=CheckinRefs.safeParse(input.checkInTasks);
        if(!refs.success)throw new TaskError("INVALID","Check-in acknowledgement requires its admitted task references");
        const keys=refs.data.map(ref=>canonical(ref));
        if(new Set(keys).size!==keys.length || refs.data.some(ref=>!message.checkIn!.tasks.some(original=>original.taskId===ref.taskId && original.revision===ref.revision)))fail("FORBIDDEN","Acknowledged check-in tasks are outside this event");
        this.checkins.acknowledge(message,refs.data);
      }
      Object.assign(message, {
        state: input.state,
        reply: input.reply,
        updatedAt: this.now(),
      });
      if(input.state==="completed")message.consecutiveDeliveryFailures=0;
      this.put(
        "sessionMessage",
        message.messageId,
        message,
        message.taskId,
        message.state,
      );
      const task = this.getTask(message.taskId),
        decision = task.manualCompletion;
      // Only replies admitted after the operator opened this original-session gate
      // become supplemental material. They are evidence, never a new settlement.
      if (
        input.state === "completed" &&
        decision?.materials === "pending" &&
        task.state === "completed" &&
        decision.nodeId === message.nodeId &&
        decision.sessionId === message.sessionId &&
        message.supplementFor === decision.decisionId &&
        this.list<Run>("run", task.taskId).at(-1)?.runId === decision.runId
      ) {
        const report = this.report({
          taskId: task.taskId,
          runId: decision.runId,
          attemptId: decision.attemptId,
          sessionId: message.sessionId,
          title: "补交材料（待核对）",
          body: input.reply,
          kind: "note",
          data: {
            supplemental: true,
            messageId: message.messageId,
            actor: "executor:" + message.nodeId,
          },
        });
        this.event(
          "task.materials_received",
          { reportId: report.reportId, messageId: message.messageId },
          task.taskId,
          decision.runId,
        );
      }
      return message;
    });
  }
  sessionContext(ref: LeaseRef): TaskSessionContext {
    const { run } = this.owned(ref);
    const task = this.getTask(run.taskId),
      node = this.getNode(ref.nodeId);
    const eligibleWorkspaceIds = node.workspaceIds.filter((workspaceId) => {
      const workspace = this.get<Workspace>("workspace", workspaceId);
      return (
        workspace?.state === "ready" &&
        workspace.nodeId === ref.nodeId &&
        (!task.workspaceId || task.workspaceId === workspaceId) &&
        (!run.workspaceConstraint || run.workspaceConstraint === workspaceId) &&
        (!task.policy?.allowedWorkspaceIds ||
          task.policy.allowedWorkspaceIds.includes(workspaceId))
      );
    });
    const sessions = this.list<TaskSession>("taskSession", run.taskId).filter(
      (session) => session.nodeId === ref.nodeId,
    );
    const current = this.get<TaskSession>(
      "taskSessionDefault",
      hash([run.taskId, ref.nodeId]),
    );
    return {
      schedulerId: this.schedulerIdentity(),
      ...(run.projectContext ? { projectContext: run.projectContext } : {}),
      task: {
        taskId: task.taskId,
        title: task.title,
        description: task.description,
        ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
        ...(task.policy ? { policy: task.policy } : {}),
      },
      ...(run.route?.workspaceId ? { workspaceId: run.route.workspaceId } : {}),
      ...(run.workspaceConstraint
        ? { workspaceConstraint: run.workspaceConstraint }
        : {}),
      eligibleWorkspaceIds,
      ...(current ? { taskSessionId: current.sessionId } : {}),
      sessions: [
        ...sessions
          .filter((session) => session.sessionId !== current?.sessionId)
          .slice(-127),
        ...(current ? [current] : []),
      ],
    };
  }
  /** Commits only within the current leased execution; no session history is adopted. */
  selectTaskSession(commandId: string, input: LeaseRef & TaskSessionChoice) {
    return this.command(commandId, "selectTaskSession", input, () => {
      const { run, attempt } = this.owned(input);
      const task = this.getTask(run.taskId);
      const currentSession = this.get<TaskSession>(
        "taskSessionDefault",
        hash([run.taskId, input.nodeId]),
      );
      if (
        input.expectedTaskSessionId !== undefined &&
        input.expectedTaskSessionId !== (currentSession?.sessionId ?? null)
      )
        fail("CONFLICT", "Task session catalog changed before selection");
      if (!attempt.executionId)
        fail(
          "EXECUTION_OWNER",
          "Start the exact execution before selecting a session",
        );
      if (!run.route) fail("FORBIDDEN", "A session requires an assigned route");
      if (!input.session || !["new", "reuse"].includes(input.session.mode))
        fail("INVALID", "Invalid session choice");
      const workspaceId =
        input.workspaceId ??
        run.route!.workspaceId ??
        task.workspaceId ??
        (!run.projectContext ? this.getNode(input.nodeId).defaultWorkspaceId : undefined);
      if (run.workspaceConstraint && workspaceId !== run.workspaceConstraint)
        fail(
          "FORBIDDEN",
          "Explicit Run/Schedule workspace cannot be changed by session selection",
        );
      if (task.workspaceId && workspaceId !== task.workspaceId)
        fail(
          "FORBIDDEN",
          "Explicit task workspace cannot be changed by session selection",
        );
      if (
        task.policy?.allowedWorkspaceIds &&
        (!workspaceId || !task.policy.allowedWorkspaceIds.includes(workspaceId))
      )
        fail("FORBIDDEN", "Task policy excludes workspace");
      const route = { ...run.route!, ...(workspaceId ? { workspaceId } : {}) };
      this.validateRoute(route);
      const schedulerId = this.schedulerIdentity();
      const retrySessionId = run.retry?.sessionId;
      if (
        retrySessionId &&
        (input.session.mode !== "reuse" ||
          input.session.sessionId !== retrySessionId ||
          workspaceId !== run.route!.workspaceId)
      )
        fail(
          "CONFLICT",
          "Retry must preserve its authoritative session and workspace",
        );
      let session: TaskSession;
      let resume = input.session.mode === "reuse";
      if (input.session.mode === "reuse") {
        const prior = this.get<TaskSession>(
          "taskSession",
          input.session.sessionId,
        );
        if (
          !prior ||
          prior.schedulerId !== schedulerId ||
          prior.taskId !== run.taskId ||
          prior.nodeId !== input.nodeId ||
          prior.workspaceId !== workspaceId
        )
          fail(
            "FORBIDDEN",
            "Session is not an owned Task session in this workspace",
          );
        session = prior!;
      } else {
        if (attempt.sessionId)
          fail("CONFLICT", "Active attempt session cannot be replaced");
        session = {
          schedulerId,
          taskId: run.taskId,
          nodeId: input.nodeId,
          ...(workspaceId ? { workspaceId } : {}),
          sessionId: `task-${randomUUID()}`,
          createdAt: this.now(),
        };
      }
      if (attempt.sessionId && attempt.sessionId !== session.sessionId)
        fail("CONFLICT", "Active attempt session cannot be replaced");
      const resource = `task-session:${session.sessionId}`;
      const owner = this.db
        .prepare("SELECT attempt_id FROM resources WHERE resource=?")
        .get(resource);
      if (owner && owner.attempt_id !== attempt.attemptId)
        fail("BUSY", "Task session is already owned by another attempt");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO resources(resource,attempt_id) VALUES(?,?)",
        )
        .run(resource, attempt.attemptId);
      this.put("taskSession", session.sessionId, session, run.taskId);
      this.put(
        "taskSessionDefault",
        hash([run.taskId, input.nodeId]),
        session,
        run.taskId,
      );
      attempt.sessionId = session.sessionId;
      attempt.updatedAt = this.now();
      this.saveAttempt(attempt);
      run.route = route;
      this.saveRun(run);
      this.event(
        "session.selected",
        {
          sessionId: session.sessionId,
          workspaceId: workspaceId ?? null,
          resume,
          ...(input.decision ? { decision: input.decision } : {}),
        },
        run.taskId,
        run.runId,
      );
      return { ...session, resume } as SelectedTaskSession;
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
    if (input.workflowOutputs) {
      const root = input.runId ? this.getRun(input.runId) : fail("WORKFLOW_OUTPUT", "Workflow result requires a root Run");
      if ( !this.isWorkflowInvocation(root) || !["succeeded", "partial"].includes(root.state) || input.kind !== "result" || !input.workflowOutputs.length)
        fail("WORKFLOW_OUTPUT", "Only completed workflow roots may associate final reports");
      for (const source of input.workflowOutputs) {
        const report = this.need<Report>("report", source.reportId), run = this.getRun(source.runId);
        const configuration = run.configuration;
        const flow = configuration && typeof configuration === "object" && !Array.isArray(configuration) ? configuration.workflow : null;
        if (report.taskId !== source.taskId || report.runId !== source.runId || report.kind !== "result" || run.taskId !== source.taskId || !["succeeded", "partial"].includes(run.state) || !flow || typeof flow !== "object" || Array.isArray(flow) || flow.workflowRunId !== root.runId || flow.stepId !== source.stepId)
          fail("WORKFLOW_OUTPUT", "Final report must come from a successful step of this workflow Run");
      }
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
      ...(input.workflowOutputs ? { workflowOutputs: structuredClone(input.workflowOutputs) } : {}),
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
  publishWorkflowResult(commandId: string, input: ReportInput) {
    this.assertManagementWritable();
    if (!input.workflowOutputs) fail("WORKFLOW_OUTPUT", "Workflow result requires output provenance");
    return this.command(commandId, "appendReport", input, () => this.report(input), false, true);
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
    if(input.resultValidationFailure){
      try{validateResultValidationFailure(input.resultValidationFailure);}catch{fail("INVALID","Invalid result validation failure attestation");}
      if(input.outcome!=="failure"||input.report||input.preDispatchFailure||!context.attempt.sessionId||context.attempt.sessionId!==input.resultValidationFailure.sessionId||!context.attempt.executionId)fail("INVALID","Result rejection must belong to a drained native session");
      return;
    }
    if (input.preDispatchFailure !== undefined) {
      this.validatePreDispatchFailure(run, context.attempt, input);
      return;
    }
    const config = run.configuration as {
      template?: Template;
      templateRef?: { templateId: string; version: number };
      workflow?: unknown;
    } | null;
    if (config?.workflow && ["success", "partial"].includes(input.outcome) &&
      (!input.report || input.report.data === undefined))
      fail("RESULT_VALIDATION", "Workflow step requires structured report.data for success or partial; submit reportData through task_submit_result.");
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
        let issues: string[] = [];
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
          issues = Array.isArray(verdict?.errors)?verdict.errors.filter((x):x is string=>typeof x==="string").slice(0,10).map(x=>x.slice(0,1000)):[];
        } catch {
          fail("RESULT_VALIDATION", "Semantic result validation failed");
        }
        if (!valid) throw new TaskError("RESULT_VALIDATION", "Semantic result validation rejected the result", issues);
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
    if (
      task.manualCompletion?.runId === latest.runId &&
      task.state === "completed" &&
      !runs.some((r) => ["queued", "running", "uncertain"].includes(r.state))
    )
      return;
    task.state =
      latest.state === "succeeded" &&
      (!latest.intentSnapshot?.intentRevision ||
        latest.intentSnapshot.intentRevision === task.intentRevision)
        ? ["pending_user", "rejected"].includes(latest.reviewStatus ?? "") ? "waiting" : "completed"
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
    if(input.resultValidationFailure)run.resultValidationFailure=structuredClone(input.resultValidationFailure);
    if(input.resultValidationFailure)this.event("run.result_validation_failed",{...input.resultValidationFailure,attemptId:attempt.attemptId},run.taskId,run.runId);
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
    run.resultSummary = input.summary;
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
      run.dispatchOrigin?.kind !== "session" &&
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
  /** Operator attention is separate from execution outcome; a new lifecycle invalidates it. */
  private taskActionRead: Map<string, ReturnType<TaskLedger["readTaskActionState"]>> | undefined;
  withTaskActionRead<T>(operation: () => T): T {
    const previous = this.taskActionRead;
    this.taskActionRead = previous ?? new Map();
    try {
      return operation();
    } finally {
      this.taskActionRead = previous;
    }
  }
  taskActionState(taskId: string) {
    const previous = this.taskActionRead?.get(taskId);
    if (previous) return previous;
    const state = this.readTaskActionState(taskId);
    this.taskActionRead?.set(taskId, state);
    return state;
  }
  private readTaskActionState(taskId: string) {
    const task = this.getTask(taskId),
      runs = this.list<Run>("run", taskId),
      run = runs.at(-1);
    const owned = runs.filter((r) => !(r.historyOnly || r.observationOnly));
    const active = owned.some((r) => ["queued", "running"].includes(r.state));
    const uncertain = owned.some((r) => r.state === "uncertain");
    const confirmationPending =
      !["cancelled", "archived", "completed", "failed"].includes(task.state) &&
      !this.confirmationAllows(task);
    const fingerprint = hash({
      ...(task.manualCompletion
        ? { manualCompletion: task.manualCompletion }
        : {}),
      task: [
        task.taskId,
        task.state,
        task.updatedAt,
        task.confirmation ?? null,
      ],
      runs: runs.map((r) => [
        r.runId,
        r.state,
        r.reviewStatus ?? null,
        !!r.cancellationRequested,
        r.currentAttemptId ?? null,
        r.dispatchIssue?.revision ?? null,
        r.route ?? null,
        r.executionModel ?? null,
        r.projectContext ?? null,
      ]),
      reports: this.list<Report>("report", taskId).map((r) => r.reportId),
    });
    const record = this.get("task-attention", taskId) as
      | { fingerprint: string; handled: boolean }
      | undefined;
    const handled = record?.fingerprint === fingerprint && record.handled;
    return {
      version: hash({ fingerprint, record }),
      canRepair: !!run && !["cancelled","archived"].includes(task.state) && !run.cancellationRequested && run.state === "queued" && run.dispatchIssue?.kind === "needs_action" && !run.currentAttemptId && !this.list<Attempt>("attempt").some(a=>a.runId===run.runId),
      fingerprint,
      handled: !!handled,
      confirmationPending,
      active,
      uncertain,
      canHandle:
        !active &&
        !uncertain &&
        !confirmationPending &&
        !["pending_user", "accepted"].includes(run?.reviewStatus ?? "") &&
        !["cancelled", "archived", "completed", "inbox"].includes(task.state) &&
        (task.state === "failed" ||
          ["failed", "blocked", "partial"].includes(run?.state ?? "") ||
          run?.reviewStatus === "rejected"),
      canRetry:
        !this.hasWorkflowBinding(taskId) &&
        task.kind !== "observed" &&
        !active &&
        !uncertain &&
        !confirmationPending &&
        !["pending_user", "accepted"].includes(run?.reviewStatus ?? "") &&
        !["cancelled", "archived", "inbox"].includes(task.state) &&
        (task.state !== "completed" || (!task.manualCompletion && run?.reviewStatus === "rejected")) &&
        (["failed", "blocked"].includes(run?.state ?? "") || run?.reviewStatus === "rejected") &&
        !(run?.historyOnly || run?.observationOnly),
      canCancel:
        task.kind !== "observed" &&
        !["cancelled", "archived"].includes(task.state) &&
        (task.manualCompletion?.materials === "pending" ||
          task.state !== "completed" ||
          ["pending_user", "rejected"].includes(run?.reviewStatus ?? "")),
      canReconcile:
        !(run && this.isWorkflowInvocation(run)) &&
        task.kind !== "observed" &&
        task.state !== "archived" &&
        run?.state === "uncertain" &&
        !active &&
        owned.filter((r) => r.state === "uncertain").length === 1,
    };
  }
  selectExecutionModel(nodeId:string,explicit?:ExecutionModelChoice) {
    const view=this.executionModels.view(nodeId);
    const source=explicit ?? view.policy.choice ?? {provider:"deepseek-official",model:"deepseek-flash",reasoningEffort:"high"};
    const primary={provider:source.provider,model:source.model,...(source.reasoningEffort?{reasoningEffort:source.reasoningEffort}:{}),...(source.backend?{backend:source.backend}:{})};
    let choice=primary;
    let origin:NonNullable<Run["executionModel"]>["origin"]=explicit?"explicit":"node_default";
    const proven=view.catalog.state==="fresh" && view.catalog.snapshot?.complete;
    if(!explicit && proven && !view.catalog.snapshot!.models.some(model=>sameExecutionModel(model,primary))) {
      choice={provider:"deepseek-official",model:"deepseek-flash",reasoningEffort:"high"};origin="fallback";
    }
    return {choice,proven,executionModel:{origin,policyRevision:String(view.policy.revision),...(view.catalog.snapshot?{catalogRevision:view.catalog.snapshot.revision}:{}),...(origin==="fallback"?{original:primary}:{})} satisfies NonNullable<Run["executionModel"]>};
  }
  readExecutionModels(nodeId:string,read:NodeReadOptions={},refresh=false) {
    const node=this.getNode(nodeId),view=this.executionModelView(nodeId,refresh),status=this.nodeStatuses().find(value=>value.nodeId===nodeId);
    return nodeRead([{...status,nodeId,roles:node.roles,state:status?.state,capabilities:node.capabilities,workspaceIds:node.workspaceIds,maxConcurrent:node.maxConcurrent,executionModels:view}],read);
  }
  executionModelView(nodeId:string,refresh=false) {
    this.getNode(nodeId);
    return refresh?this.executionModels.request(`view:${randomUUID()}`,{nodeId}):this.executionModels.view(nodeId);
  }
  reportAdmission(commandId:string,input:{runId:string;nodeId:string;expectedUpdatedAt:string;routeDigest:string;code:"READY"|"MODEL_UNAVAILABLE"|"CAPABILITY_REQUIRED"|"WORKSPACE_BINDING_REQUIRED"|"EXECUTION_ROOT_REQUIRED"|"BACKEND_UNAVAILABLE"}) {
    return this.command(commandId,"reportAdmission",input,()=>{
      const run=this.getRun(input.runId),task=this.getTask(run.taskId);
      if(run.state!=="queued" || run.currentAttemptId || run.cancellationRequested || ["cancelled","archived"].includes(task.state) || this.list<Attempt>("attempt").some(a=>a.runId===run.runId))fail("CONFLICT","Admission evidence applies only before any attempt");
      if(run.route?.nodeId!==input.nodeId)fail("FORBIDDEN","Admission evidence belongs to a different executor");
      if(run.updatedAt!==input.expectedUpdatedAt || hash(run.route)!==input.routeDigest)fail("CONFLICT","Execution request changed before admission evidence arrived");
      if(input.code==="READY")return run.dispatchIssue?.source==="executor"?this.setDispatchIssue(run,undefined):run;
      const messages={MODEL_UNAVAILABLE:"The assigned model is unavailable on this executor. Restore it or explicitly repair this unclaimed request with a supported executionModel.",CAPABILITY_REQUIRED:"The executor does not provide a required task capability. Restore the capability or review the assignment.",WORKSPACE_BINDING_REQUIRED:"The explicit workspace is not bound on this executor. Restore the matching workspace binding; ordinary temporary tasks do not need a workspace ID.",EXECUTION_ROOT_REQUIRED:"Configure the execution parent directory in this executor settings before continuing.",BACKEND_UNAVAILABLE:"The assigned execution backend is unavailable or not permitted by this executor. Restore the backend or explicitly repair the model selection."};
      return this.setDispatchIssue(run,{source:"executor",kind:"needs_action",code:input.code,message:messages[input.code],action:input.code==="MODEL_UNAVAILABLE"||input.code==="BACKEND_UNAVAILABLE"?"choose_execution_model":"review_assignment"});
    });
  }
  executionModelRequests(nodeId:string){this.getNode(nodeId);return this.executionModels.pending(nodeId);}
  completeExecutionModels(commandId:string,input:CompleteExecutionModels) {
    return this.command(commandId,"completeExecutionModels",input,()=>{
      const node=this.getNode(input.nodeId);
      const view=this.executionModels.complete(commandId,input);
      if(input.result.state==="success" && input.result.complete && view.catalog.snapshot?.revision===input.requestId) {
        const models=new Map<string,NodeCapability["models"][number]>();
        for(const route of view.catalog.snapshot.models){const key=JSON.stringify([route.provider,route.model]);const prior=models.get(key)??{provider:route.provider,model:route.model,reasoningEfforts:[]};if(route.reasoningEffort&&!prior.reasoningEfforts.includes(route.reasoningEffort))prior.reasoningEfforts.push(route.reasoningEffort);models.set(key,prior);}
        node.models=[...models.values()];this.put("node",node.nodeId,node);
        this.event("node.execution_catalog",{nodeId:node.nodeId,revision:view.catalog.snapshot.revision,complete:input.result.complete},undefined);
      }
      if(!view.catalog.request)for(const run of this.list<Run>("run").filter(run=>run.state==="queued"&&run.route?.nodeId===input.nodeId))this.refreshDispatchEligibility(run.runId);
      return view;
    });
  }
  async refreshNodeModels(nodeId:string,waitMs=3000) {
    this.getNode(nodeId);
    const request=this.executionModels.request(`catalog:${randomUUID()}`,{nodeId});
    if(nodeId===this.nodeId && this.localExecutionCatalog && request.catalog.request) {
      const pending=request.catalog.request;
      const result=await this.localExecutionCatalog();
      this.completeExecutionModels(`local-catalog:${pending.requestId}`,{nodeId,requestId:pending.requestId,generation:pending.generation,result});
      return this.executionModels.view(nodeId);
    }
    const requestId=request.catalog.request?.requestId,until=Date.now()+Math.min(3000,Math.max(0,waitMs));
    while(requestId && Date.now()<until && this.executionModels.view(nodeId).catalog.request?.requestId===requestId)await new Promise(resolve=>setTimeout(resolve,50));
    return this.executionModels.view(nodeId);
  }
  /** Repair only an unclaimed request; never manufacture an execution or reset its ID. */
  repairDispatch(commandId: string, input: {taskId:string;runId:string;expectedActionVersion:string;executionModel?:ExecutionModelChoice}) {
    this.planner();
    return this.command(commandId,"repairDispatch",input,()=>{
      text(input.expectedActionVersion,"expectedActionVersion",200);
      this.assertTaskActionVersion(input.taskId,input.expectedActionVersion);
      const run=this.getRun(input.runId),task=this.getTask(input.taskId);
      if(run.taskId!==task.taskId || run.state!=="queued" || run.currentAttemptId || this.list<Attempt>("attempt").some(a=>a.runId===run.runId) || run.historyOnly || run.observationOnly || run.cancellationRequested || ["cancelled","archived"].includes(task.state)) fail("CONFLICT","Only an unclaimed execution request can be repaired");
      if(this.list<Run>("run",task.taskId).filter(record=>!(record.historyOnly||record.observationOnly)).at(-1)?.runId!==run.runId)fail("CONFLICT","Repair the current task request only");
      if(run.parentRunId) {
        const parent=this.getRun(run.parentRunId);
        if(parent.taskId!==task.parentTaskId || (task.parentRunId && task.parentRunId!==parent.runId))fail("FORBIDDEN","Run parent does not match the task tree");
      }
      if(input.executionModel) {
        const originalRoute=run.route ?? fail("FORBIDDEN","Unassigned requests cannot change Agent model through repair");
        if(originalRoute.execution)fail("FORBIDDEN","Program requests cannot change Agent model through repair");
        const selected=this.selectExecutionModel(originalRoute.nodeId,ExecutionModelChoice.parse(input.executionModel));
        const route=withExecutionModel(originalRoute,selected.choice);
        if(!selected.choice.backend)delete route.backend;
        this.validateRoute(route,{admission:true,skipModel:true});
        if(route.backend&&!task.policy?.allowedBackends?.includes(route.backend))fail("FORBIDDEN","Task policy excludes that backend");
        run.route=route;run.executionModel=selected.executionModel;
      }
      if(!run.executionModel && run.route && !run.route.execution)run.executionModel={origin:"explicit",policyRevision:"legacy-pinned"};
      if(!run.projectContext) run.projectContext=this.projectContextSnapshot(task,run.parentRunId);
      run.updatedAt=this.now();
      this.saveRun(run);
      const value=this.refreshDispatchEligibility(run.runId);
      this.event("run.dispatch_repaired",{issue:value.dispatchIssue ? {...value.dispatchIssue} : null,route:value.route?{...value.route}:null,modelOrigin:value.executionModel?.origin ?? "legacy",contextDigest:hash(value.projectContext ?? null)},task.taskId,run.runId);
      return value;
    });
  }
  private setDispatchIssue(run:Run, issue:Omit<NonNullable<Run["dispatchIssue"]>,"revision"> | undefined) {
    const next=issue?{...issue,revision:hash(issue)}:undefined;
    if(canonical(run.dispatchIssue ?? null)===canonical(next ?? null)) return run;
    if(next)run.dispatchIssue=next;else delete run.dispatchIssue;
    if(this.options.readOnly)return run;
    run.updatedAt=this.now();this.saveRun(run);
    this.event(next?"run.dispatch_issue":"run.dispatch_ready",{issue:next ?? null},run.taskId,run.runId);
    return run;
  }
  refreshDispatchEligibility(runId:string):Run {
    const run=this.getRun(runId);
    if(run.state!=="queued" || run.currentAttemptId || run.historyOnly || run.observationOnly)return run;
    if(!run.route)return this.setDispatchIssue(run,{kind:"needs_action",code:"EXECUTOR_REQUIRED",message:"Select an executor before dispatching this task.",action:"review_assignment"});
    const projectId = run.projectContext?.project?.projectId ?? this.projectForTask(run.taskId, run.parentRunId);
    if (projectId) {
      try {
        const policy = this.projectExecutionPolicy(projectId, run.route.nodeId);
        if (run.projectSettingsRevision !== undefined && policy.workspaceId !== run.projectExecutionBinding)
          return this.setDispatchIssue(run, {kind:"needs_action", code:"PROJECT_WORKSPACE_CHANGED", message:"Project execution workspace changed after dispatch. Return this unclaimed Run to the inbox and create a new Run; its directory was not changed.", action:"review_assignment"});
        if (policy.workspaceId && (run.route.workspaceId !== policy.workspaceId || (run.workspaceConstraint && run.workspaceConstraint !== policy.workspaceId)))
          return this.setDispatchIssue(run, {kind:"needs_action", code:"PROJECT_WORKSPACE_CHANGED", message:"This queued Run does not match the selected project execution workspace. Create a new Run to use the new settings.", action:"review_assignment"});
      } catch (error) {
        if (!(error instanceof TaskError)) throw error;
        return this.setDispatchIssue(run, {kind:"needs_action", code:error.code, message:error.message, action:"review_assignment"});
      }
    }
    if(run.projectContext && !run.route.workspaceId && run.route.nodeId===this.nodeId && this.executionDirectoryReady?.()===false)return this.setDispatchIssue(run,{kind:"needs_action",code:"EXECUTION_ROOT_REQUIRED",message:"Configure this executor execution parent directory before starting the task.",action:"review_assignment"});
    if(!run.route.workspaceId && !run.projectContext)return this.setDispatchIssue(run,{kind:"needs_action",code:"TEMPORARY_CONTEXT_REQUIRED",message:"Repair this unclaimed request to attach its temporary task context.",action:"repair_context"});
    if(!run.executionModel && !run.route.execution && this.get("pairedExecutor",run.route.nodeId)) {
      run.executionModel={origin:"explicit",policyRevision:"legacy-pinned"};
      if(!this.options.readOnly){this.saveRun(run);this.event("run.legacy_model_pinned",{route:{...run.route}},run.taskId,run.runId);}
    }
    if(run.executionModel && !run.route.execution) {
      const view=this.executionModels.view(run.route.nodeId);
      const positive=view.catalog.positiveSnapshot;
      if(positive && positive.expiresAt>this.clock() && positive.temporaryWorkspaceReady===false && !run.route.workspaceId && run.projectContext)return this.setDispatchIssue(run,{kind:"needs_action",code:"EXECUTION_ROOT_REQUIRED",message:"Configure the execution parent directory in this executor settings, then refresh its catalog. No attempt has started.",action:"review_assignment"});
      const confirmed=!!positive && positive.expiresAt>this.clock() && positive.models.some(choice=>sameExecutionModel(choice,run.route!));
      if(!confirmed && (view.catalog.state!=="fresh" || !view.catalog.snapshot?.complete)) {
        if(!this.options.readOnly)this.executionModels.request(`run:${run.runId}:${view.catalog.snapshot?.revision ?? "none"}:${Math.floor(this.clock()/30000)}`,{nodeId:run.route.nodeId});
        if(view.catalog.reason) {
          const reason=view.catalog.reason;
          const code=reason==="TIMEOUT"?"EXECUTION_CATALOG_TIMEOUT":reason==="UNAVAILABLE"?"EXECUTION_CATALOG_UNAVAILABLE":`EXECUTION_${reason}`;
          const diagnostic=view.catalog.diagnostic;
          const detail=diagnostic?` Last refresh ${diagnostic.code}; accepted ${diagnostic.receivedPages}${diagnostic.totalPages===undefined?"":`/${diagnostic.totalPages}`} pages.`:"";
          return this.setDispatchIssue(run,{kind:diagnostic?.kind==="rejected"||reason==="CATALOG_UNSUPPORTED"?"needs_action":"waiting",code,message:`Executor model catalog refresh failed (${reason}).${detail} Refresh the catalog after restoring the executor configuration. This queued Run will resume without creating another task.`,action:"refresh_catalog"});
        }
        return this.setDispatchIssue(run,{kind:"waiting",code:"EXECUTION_CATALOG_PENDING",message:"Waiting for a fresh executor model catalog. The last known configuration has been preserved.",action:"refresh_catalog"});
      }
      const available=(route:ExecutionRoute)=>!!positive && positive.expiresAt>this.clock() && positive.models.some(choice=>sameExecutionModel(choice,route));
      if(!this.options.readOnly && view.catalog.state==="fresh" && view.catalog.snapshot?.complete && !available(run.route) && run.executionModel.origin!=="explicit" && !this.list<Attempt>("attempt").some(a=>a.runId===run.runId)) {
        const fallback={provider:"deepseek-official",model:"deepseek-flash",reasoningEffort:"high"};
        if(available({...run.route,...fallback,backend:undefined})) {
          const original={provider:run.route.provider,model:run.route.model,...(run.route.reasoningEffort?{reasoningEffort:run.route.reasoningEffort}:{}),...(run.route.backend?{backend:run.route.backend}:{})};
          run.route={...run.route,...fallback};delete run.route.backend;
          run.executionModel={...run.executionModel,origin:"fallback",catalogRevision:view.catalog.snapshot.revision,original};
          this.saveRun(run);this.event("run.model_fallback",{original,selected:fallback,catalogRevision:view.catalog.snapshot.revision},run.taskId,run.runId);
        }
      }
      if(!available(run.route))return this.setDispatchIssue(run,{kind:"needs_action",code:run.executionModel.origin==="explicit"?"EXPLICIT_EXECUTION_MODEL_UNAVAILABLE":"EXECUTION_DEFAULT_AND_FALLBACK_UNAVAILABLE",message:run.executionModel.origin==="explicit"?"The explicitly requested execution model or effort is unavailable. Select a supported model explicitly; it was not replaced.":"The executor default and deepseek-official/deepseek-flash high are unavailable. Update the node default or restore the model on the executor.",action:"choose_execution_model"});
    }
    if(run.dispatchIssue?.code==="EXECUTION_ROOT_REQUIRED" && run.route.nodeId!==this.nodeId && !run.route.workspaceId && this.executionModels.view(run.route.nodeId).catalog.positiveSnapshot?.temporaryWorkspaceReady!==true)return run;
    if(run.dispatchIssue && !["TEMPORARY_CONTEXT_REQUIRED","EXECUTOR_REQUIRED","EXECUTION_CATALOG_PENDING","EXECUTION_CATALOG_TIMEOUT","EXECUTION_CATALOG_UNAVAILABLE","EXECUTION_CATALOG_UNSUPPORTED","EXECUTION_CATALOG_FAILED","EXPLICIT_EXECUTION_MODEL_UNAVAILABLE","EXECUTION_DEFAULT_AND_FALLBACK_UNAVAILABLE","EXECUTION_ROOT_REQUIRED","PROJECT_NODE_NOT_ALLOWED","PROJECT_WORKSPACE_CHANGED","WORKSPACE_POLICY"].includes(run.dispatchIssue.code))return run;
    return this.setDispatchIssue(run,undefined);
  }
  private assertTaskActionVersion(taskId: string, expected?: string) {
    if (expected && this.taskActionState(taskId).version !== expected)
      fail("CONFLICT", "Task changed; refresh before acting");
  }
  requeueTask(
    commandId: string,
    input: { taskId: string; expectedActionVersion: string },
  ) {
    this.planner();
    return this.command(commandId, "requeueTask", input, () => {
      this.assertTaskActionVersion(input.taskId, input.expectedActionVersion);
      if (!this.taskActionState(input.taskId).canRetry)
        fail("CONFLICT", "Task is not safe to dispatch again");
      const task = this.getTask(input.taskId);
      task.state = "inbox";
      task.updatedAt = this.now();
      this.saveTask(task);
      this.event(
        "task.requeued",
        { actor: "operator:task-center" },
        task.taskId,
      );
      return task;
    });
  }
  confirmTaskCompletion(
    commandId: string,
    input: {
      taskId: string;
      expectedActionVersion: string;
      requireMaterials: boolean;
    },
  ) {
    this.planner();
    return this.command(commandId, "confirmTaskCompletion", input, () => {
      this.assertTaskActionVersion(input.taskId, input.expectedActionVersion);
      const task = this.getTask(input.taskId),
        view = this.taskActionState(input.taskId);
      if (
        this.hasWorkflowBinding(task.taskId) ||
        task.kind === "observed" ||
        view.active ||
        view.uncertain ||
        (!view.canHandle &&
          !(
            task.state === "completed" &&
            task.manualCompletion?.materials === "pending"
          ))
      )
        fail("CONFLICT", "Task is not ready for manual completion");
      const run = this.list<Run>("run", task.taskId).at(-1);
      const attempt = run?.currentAttemptId
        ? this.getAttempt(run.currentAttemptId)
        : undefined;
      const target = this.sessionMessageTargets(task.taskId).find(
        (s) =>
          s.nodeId === attempt?.nodeId &&
          s.sessionId === attempt?.sessionId &&
          s.workspaceId,
      );
      if (input.requireMaterials && !target)
        fail("NOT_FOUND", "Original executor session is unavailable");
      const decidedAt = this.now();
      task.manualCompletion = {
        decisionId: commandId,
        actor: "operator:task-center",
        decidedAt,
        runId: run?.runId,
        attemptId: attempt?.attemptId,
        nodeId: target?.nodeId,
        sessionId: target?.sessionId,
        materials: input.requireMaterials ? "pending" : "not_required",
      };
      if (input.requireMaterials && target?.workspaceId) {
        const messageId = randomUUID();
        const message: import("./remote/ports.js").SessionMessage = {
          messageId,
          supplementFor: commandId,
          taskId: task.taskId,
          nodeId: target.nodeId,
          sessionId: target.sessionId,
          workspaceId: target.workspaceId,
          state: "queued",
          createdAt: decidedAt,
          updatedAt: decidedAt,
          text:
            "用户已人工确认此任务完成，请补交原执行已有的结果摘要、材料内容或文件路径，并说明无法提供的材料。不要重跑任务、修改产物或尝试结算旧 Run；直接回复即可，回复将保留为待核对的补交材料。原执行记录：" +
            run!.runId,
        };
        this.put(
          "sessionMessage",
          messageId,
          message,
          task.taskId,
          message.state,
        );
        task.manualCompletion.requestMessageId = messageId;
      }
      task.state = "completed";
      task.updatedAt = decidedAt;
      this.saveTask(task);
      this.event(
        "task.manually_completed",
        {
          actor: task.manualCompletion.actor,
          materials: task.manualCompletion.materials,
          requestMessageId: task.manualCompletion.requestMessageId ?? null,
        },
        task.taskId,
        run?.runId,
      );
      return task;
    });
  }
  setTaskHandled(
    commandId: string,
    input: { taskId: string; expectedActionVersion: string; handled: boolean },
  ) {
    this.planner();
    return this.command(commandId, "setTaskHandled", input, () => {
      this.assertTaskActionVersion(input.taskId, input.expectedActionVersion);
      const view = this.taskActionState(input.taskId);
      if (input.handled ? !view.canHandle : !view.handled)
        fail("CONFLICT", "Task cannot change attention state");
      const record = {
        fingerprint: view.fingerprint,
        handled: input.handled,
        actor: "operator:task-center",
        decidedAt: this.now(),
      };
      this.put("task-attention", input.taskId, record, input.taskId);
      this.event(
        "task.attention_changed",
        { handled: input.handled, actor: record.actor },
        input.taskId,
      );
      return record;
    });
  }
  cancel(
    commandId: string,
    input: {
      taskId: string;
      runId?: string;
      reason: string;
      expectedActionVersion?: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "cancel", input, () => {
      this.assertTaskActionVersion(input.taskId, input.expectedActionVersion);
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
        if (TERMINAL.has(run.state) && !(this.isWorkflowInvocation(run) && run.state === "uncertain")) continue;
        changed = true;
        run.cancellationRequested = true;
        if (!run.currentAttemptId && !this.isWorkflowInvocation(run)) run.state = "cancelled";
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
    input: {
      runId: string;
      outcome: "cancelled" | "failed";
      reason: string;
      expectedActionVersion?: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "resolveUncertain", input, () => {
      const run = this.getRun(input.runId);
      if (this.isWorkflowInvocation(run)) fail("WORKFLOW_TASK", "Reconcile the underlying workflow step first");
      this.assertTaskActionVersion(run.taskId, input.expectedActionVersion);
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
      if (run.currentAttemptId) {
        const attempt = this.getAttempt(run.currentAttemptId!);
        attempt.state = input.outcome === "cancelled" ? "cancelled" : "expired";
        attempt.updatedAt = this.now();
        this.saveAttempt(attempt);
      }
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
    input: {
      runId: string;
      decision: "accepted" | "rejected";
      reason: string;
      expectedActionVersion?: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "reviewRun", input, () => {
      const run = this.getRun(input.runId);
      this.assertTaskActionVersion(run.taskId, input.expectedActionVersion);
      if (run.reviewStatus !== "pending_user" && !(run.state === "succeeded" && run.reviewStatus === undefined))
        fail("CONFLICT", "Run has no result available for review");
      if (!["accepted", "rejected"].includes(input.decision))
        fail("INVALID", "Invalid review");
      run.reviewStatus = input.decision;
      run.updatedAt = this.now();
      this.saveRun(run);
      if (run.route?.backend) this.projectTaskState(this.getTask(run.taskId), run);
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
      const run = this.newRun(
        {
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
        },
        {
          workspaceConstraint: prior.workspaceConstraint,
          projectContext: prior.projectContext,
        },
      );
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
      .prepare(this.receiptExpirySupported
        ? "SELECT receipt FROM commands WHERE id=? AND NOT EXISTS (SELECT 1 FROM transient_command_expiry WHERE id=commands.id AND expires <= ?)"
        : "SELECT receipt FROM commands WHERE id=?")
      .get(...(this.receiptExpirySupported ? [commandId, this.clock()] : [commandId])) as { receipt: string } | undefined;
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
      const planning = AcceptancePlanningIntent.safeParse(input.input);
      if (planning.success) this.assertAcceptancePlanning(planning.data, input.proposal);
      else { const projectId = this.dispatchProjectId(); if (projectId) this.assertAcceptanceProjectPlan(projectId); }
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
      deferExecution?: boolean;
      expectedActionVersion?: string;
      expectedExecutionMs?: number;
      currentStateHash: string;
      title: string;
      description: string;
      attachTaskId?: string;
      persistence: "ignore" | "create" | "attach";
      route?: ExecutionRoute;
      executionModel?: Run["executionModel"];
      reporting: "none" | "summary" | "escalate";
      workspaceId?: string;
    },
  ) {
    this.planner();
    return this.command(commandId, "applyDecision", input, () => {
      const decision =
        this.getDecision(input.decisionId) ??
        fail("NOT_FOUND", "Decision not found");
      const planning = AcceptancePlanningIntent.safeParse(decision.input);
      if (planning.success) this.assertAcceptancePlanning(planning.data, decision.proposal);
      else { const projectId = this.dispatchProjectId(); if (projectId) this.assertAcceptanceProjectPlan(projectId); }
      if (
        decision.stateHash !== input.currentStateHash ||
        decision.validUntil <= this.clock()
      )
        fail("STALE_DECISION", "Decision catalog expired or changed");
      if(input.expectedExecutionMs !== (decision.input as Record<string,Json>).expectedExecutionMs)fail("CONFLICT","Expected execution upper bound differs from the reviewed dispatch intent");
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
      if (proposal.workspace)
        fail(
          "WORKSPACE_REPLAN_REQUIRED",
          "Stored scheduler workspace recommendation requires replanning; workspace/session belong to the executor",
        );
      const originalInput = decision.input as Record<string, Json>;
      const fixedRoute = originalInput.route as unknown as
        | ExecutionRoute
        | undefined;
      const explicitWorkspaceId =
        typeof originalInput.workspaceId === "string"
          ? originalInput.workspaceId
          : fixedRoute?.workspaceId;
      if (input.workspaceId !== explicitWorkspaceId)
        fail(
          "CONFLICT",
          "Explicit Task workspace differs from the recorded input",
        );
      if (
        fixedRoute &&
        canonical(input.route) !==
          canonical({
            ...fixedRoute,
            ...(explicitWorkspaceId
              ? { workspaceId: explicitWorkspaceId }
              : {}),
          })
      )
        fail(
          "CONFLICT",
          "Explicit execution route differs from the recorded input",
        );
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
          input.route.workspaceId !== explicitWorkspaceId
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
              workspaceId: explicitWorkspaceId,
            });
      if (
        input.persistence === "attach" &&
        proposal.attachTaskId !== task.taskId
      )
        fail("CONFLICT", "Attachment differs from decision");
      const previousRoute = input.expectedActionVersion
        ? this.list<Run>("run", task.taskId).at(-1)?.route : undefined;
      // An official-backend retry may retain its last execution workspace
      // without turning that executor-owned choice into a Task constraint.
      const retainsRetryWorkspace = !task.workspaceId && !!fixedRoute?.backend &&
        previousRoute?.backend === fixedRoute.backend &&
        previousRoute?.nodeId === fixedRoute.nodeId &&
        previousRoute?.workspaceId === explicitWorkspaceId;
      if (
        input.persistence === "attach" &&
        explicitWorkspaceId &&
        task.workspaceId !== explicitWorkspaceId &&
        !retainsRetryWorkspace
      )
        fail(
          "CONFLICT",
          "Existing Task workspace must be changed explicitly before replanning",
        );
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
      if (input.expectedActionVersion) {
        this.assertTaskActionVersion(task.taskId, input.expectedActionVersion);
        if (!this.taskActionState(task.taskId).canRetry)
          fail("CONFLICT", "Task is not safe to dispatch again");
      }
      if(input.route && input.executionModel) {
        const explicit=fixedRoute ?? (originalInput.executionModel ? ExecutionModelChoice.parse(originalInput.executionModel) : undefined);
        const expected=this.selectExecutionModel(input.route.nodeId,explicit);
        if(canonical(expected.executionModel)!==canonical(input.executionModel))fail("CONFLICT","Execution model provenance differs from the recorded request");
      }
      const report = this.report({
        taskId: task.taskId,
        title: "Task request",
        body: originalInput.automaticResultRetry === true && typeof originalInput.retryPrompt === "string" ? originalInput.retryPrompt : input.description || input.title,
        kind: "progress",
        ...(input.expectedActionVersion && typeof originalInput.retryPrompt === "string"
          ? { data: { actor: originalInput.automaticResultRetry === true ? "scheduler:report-validation" : "operator:task-center", retryPrompt: originalInput.retryPrompt } } : {}),
      });
      if (input.deferExecution) {
        const origin=this.dispatchOrigins.getStore();
        if(origin)this.put("pendingDispatchOrigin",task.taskId,origin,task.taskId);
        if (
          typeof originalInput.projectId !== "string" &&
          originalInput.taskId !== task.taskId
        )
          fail(
            "FORBIDDEN",
            "Deferred project dispatch needs host-owned project scope",
          );
        if (
          this.list<Run>("run").some(
            (r) =>
              r.taskId === task.taskId &&
              ["queued", "running", "uncertain"].includes(r.state),
          )
        )
          fail("CONFLICT", "Task already has active execution");
        if (
          input.persistence === "attach" &&
          task.state !== "inbox" &&
          !input.expectedActionVersion &&
          (this.list<Run>("run").some((r) => r.taskId === task.taskId) ||
            !["ready", "waiting"].includes(task.state))
        )
          fail("CONFLICT", "Use the operator retry action for ended tasks");
        task.state = "inbox";
        task.updatedAt = this.now();
        this.saveTask(task);
      }
      const run =
        input.route && !input.deferExecution
          ? this.newRun({
              taskId: task.taskId,
              ...(input.expectedExecutionMs!==undefined?{expectedExecutionMs:input.expectedExecutionMs}:{}),
              route: input.route,
              executionModel:input.executionModel,
              configuration: {
                decisionId: input.decisionId,
                reporting: input.reporting,
              },
            }, typeof originalInput.projectId === "string" ? {projectId: originalInput.projectId} : undefined)
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
        ...(input.deferExecution ? { deferred: true } : {}),
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
    if (schedule.execution && (schedule.execution.kind !== 'workflow' || schedule.route)) fail('INVALID', 'Workflow schedules cannot use executor routes');
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
    let effectiveInput: Json = schedule.input;
    try {
      effectiveInput = scheduleInput(schedule, schedule.nextDueAt);
    } catch {
      fail("INVALID", "Invalid schedule calendar window");
    }
    validateSchema(template.inputSchema, effectiveInput, "Schedule input");
    if (schedule.route) this.validateRoute(schedule.route,{admission:true,skipModel:!!schedule.executionModel});
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
  /** Atomic preparation; the UI links the project before enabling the plan. */
  prepareScheduledPlan(commandId: string, input: {
    requestHash: string; taskId: string; scheduleId: string;
    title: string; description: string; route?: ExecutionRoute; executionModel?:Run["executionModel"];
    execution?: {kind: "workflow"; workflowId: string}; workflowInput?: Json; existingTaskId?: string; nextDueAt?: string; calendarWindow?: Schedule["calendarWindow"];
    intervalMs?: number; cron?: string; timeZone?: string;
  }) {
    this.planner();
    return this.command(commandId, "prepareScheduledPlan", input, () => {
      const task = input.existingTaskId ? this.getTask(input.existingTaskId) : this.newTask({taskId:input.taskId,title:input.title,description:input.description,kind:"scheduled",
        ...(input.execution ? {policy:{maxChildren:1000,maxDescendants:10000}} : {}),
        ...(input.route?.backend ? {policy:{allowedBackends:[input.route.backend]}} : {})});
      const templateId = input.execution ? "panel-workflow-task" : "panel-scheduled-task", version = 1;
      if (!this.get("template", `${templateId}@${version}`)) {
        const template: Template = {templateId,version,name:"Scheduled task",description:"Execute the Task intent for this scheduled occurrence",inputSchema:input.execution ? {} : {type:"object",additionalProperties:false},defaults:{},resultContract:{}};
        this.validateTemplate(template);
        this.put("template", `${templateId}@${version}`, template);
      }
      const nextDueAt = input.nextDueAt ?? (input.cron
        ? CronExpressionParser.parse(input.cron,{tz:input.timeZone??"UTC",currentDate:this.now()}).next().toISOString()!
        : new Date(this.clock()+(input.intervalMs??0)).toISOString());
      const schedule: Schedule = {scheduleId:input.scheduleId,taskId:task.taskId,templateId,templateVersion:version,
        enabled:false,revision:1,intervalMs:input.intervalMs,cron:input.cron,timeZone:input.timeZone,
        nextDueAt,overlap:"skip",misfire:"once",input:input.workflowInput ?? {},route:input.route,...(input.executionModel?{executionModel:input.executionModel}:{}),
        ...(input.execution ? {execution:input.execution} : {}), ...(input.calendarWindow ? {calendarWindow:input.calendarWindow} : {})};
      this.validateSchedule(schedule);
      this.put("schedule",schedule.scheduleId,schedule,task.taskId);
      this.event("schedule.created",{scheduleId:schedule.scheduleId},task.taskId);
      return {taskId:task.taskId,scheduleId:schedule.scheduleId,requestHash:input.requestHash};
    });
  }
  controlScheduledPlan(commandId: string, input: {scheduleId:string;expectedRevision:number;enabled:boolean}) {
    this.planner();
    return this.command(commandId,"controlScheduledPlan",input,()=>{
      const prior=this.getSchedule(input.scheduleId);
      if(prior.retiredAt || (prior.revision??1)!==input.expectedRevision) fail("CONFLICT","Schedule changed; refresh before acting");
      if(typeof input.enabled!=="boolean") fail("INVALID","Invalid enabled state");
      const task=this.getTask(prior.taskId);
      if(input.enabled && ["cancelled","archived"].includes(task.state)) fail("CONFLICT","Cancelled or archived Task cannot resume its schedule");
      const next={...prior,enabled:input.enabled,revision:(prior.revision??1)+1};
      if(input.enabled){
        this.validateSchedule(next);
        next.nextDueAt=next.cron
          ? CronExpressionParser.parse(next.cron,{tz:next.timeZone??"UTC",currentDate:this.now()}).next().toISOString()!
          : new Date(this.clock()+next.intervalMs!).toISOString();
      }
      this.put("schedule",next.scheduleId,next,next.taskId);
      this.event(input.enabled?"schedule.resumed":"schedule.paused",{scheduleId:next.scheduleId,nextDueAt:next.nextDueAt},next.taskId);
      return next;
    });
  }
  scheduleHistory(scheduleId: string) {
    this.getSchedule(scheduleId);
    return this.list<{occurrenceId:string;runId?:string;status:string;scheduledFor?:string;observedAt?:string}>("occurrence",scheduleId);
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
        "calendarWindow",
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
      s.revision = (s.revision ?? 1) + 1;
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
      const policySelection=!input.route && s.route && s.executionModel && s.executionModel.origin!=="explicit" && !s.route.execution ? this.selectExecutionModel(s.route.nodeId) : undefined;
      if (!skipMisfire && !(active && s.overlap === "skip"))
        run = this.newRun({
          taskId: s.taskId,
          route: input.route ?? (policySelection?withExecutionModel(s.route!,policySelection.choice):s.route),
          executionModel:input.route ? undefined : policySelection?.executionModel ?? s.executionModel,
          occurrenceId: key,
          configuration: {
            ...(s.execution ? {workflowInvocation:{workflowId:s.execution.workflowId}} : {}),
            templateRef: {
              templateId: template.templateId,
              version: template.version,
            },
            input: scheduleInput(s, input.occurrenceAt),
            trigger: {
              scheduledFor: input.occurrenceAt,
              timeZone: s.timeZone ?? "UTC",
              observedAt: this.now(),
              ...(missed ? { coalescedUntil: this.now() } : {}),
            },
          },
        });
      const occurrence = {
        occurrenceId: key,
        scheduleId: s.scheduleId,
        scheduledFor: input.occurrenceAt,
        observedAt: this.now(),
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
    const runs = this.db
      .prepare(`
        SELECT data FROM entities WHERE kind='run' AND state='queued'
          AND json_extract(data,'$.route.nodeId')=? ORDER BY rowid
      `)
      .all(nodeId)
      .map((row) => this.refreshDispatchEligibility(JSON.parse(String(row.data)).runId));
    if (!runs.length) return [];
    const tasks = new Map(this.list<Task>("task").map((t) => [t.taskId, t]));
    return runs
      .filter(
        (r) =>
          r.state === "queued" &&
          (!r.dispatchIssue || r.dispatchIssue.source==="executor") &&
          !this.isWorkflowInvocation(r) &&
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
      task: {...this.getTask(taskId), checkin:this.checkins.view(taskId)},
      resultReturns: this.sessionMessages(taskId).filter(message=>message.completion),
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
  resultRetryCandidates(): Run[] {
    return this.db
      .prepare(`
        SELECT candidate.data FROM entities AS candidate
        WHERE candidate.kind='run' AND candidate.state='failed'
          AND json_type(candidate.data,'$.resultValidationFailure')='object'
          AND NOT EXISTS (
            SELECT 1 FROM entities AS newer
            WHERE newer.kind='run' AND newer.parent=candidate.parent
              AND newer.rowid>candidate.rowid
          ) ORDER BY candidate.rowid
      `)
      .all()
      .map((row) => this.projectEntity<Run>("run", JSON.parse(String(row.data))));
  }
  resultRetryInfo(runId: string) {
    const run=this.getRun(runId),task=this.getTask(run.taskId),config=run.configuration;
    const retry=config&&typeof config==="object"&&!Array.isArray(config)?config.taskRetry:null;
    const count=retry&&typeof retry==="object"&&!Array.isArray(retry)&&retry.automatic===true&&typeof retry.count==="number"?retry.count:0;
    const limit=task.policy?.maxResultRetries??2;
    const latest=this.list<Run>("run",task.taskId).at(-1);
    const eligible=!!run.resultValidationFailure&&run.state==="failed"&&latest?.runId===runId&&count<limit&&!['cancelled','archived','completed'].includes(task.state)&&!this.taskActionState(task.taskId).handled;
    return {limit,count,remaining:Math.max(0,limit-count),eligible};
  }
  allSettled(taskId: string, quietMs = 1000, rootRunId?: string, includeTask = false) {
    finite(quietMs, 0, 300000, "quiet window");
    this.getTask(taskId);
    const scope = rootRunId
      ? this.executionScope(taskId, rootRunId)
      : undefined;
    const tasks = scope?.tasks ?? [...(includeTask?[this.getTask(taskId)]:[]),...this.descendants(taskId)],
      ids = new Set(tasks.map((t) => t.taskId));
    const runs =
      scope?.runs ?? this.list<Run>("run").filter((r) => ids.has(r.taskId));
    const pending = runs.filter(
      (r) =>
        !(r.historyOnly || r.observationOnly) &&
        (!TERMINAL.has(r.state) || r.state === "uncertain" || this.resultRetryInfo(r.runId).eligible),
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
      pending: [...pending.map(run=>{
        const retrying=this.resultRetryInfo(run.runId).eligible;
        return {taskId:run.taskId,runId:run.runId,phase:retrying?"result_recovery":run.state,cancellationRequested:!!run.cancellationRequested,reason:run.dispatchIssue?.message ?? (retrying?"Result validation failed; automatic result recovery is pending":run.state==="uncertain"?"Execution effects are unresolved":run.cancellationRequested?"Waiting for executor stop confirmation":run.state==="queued"?"Waiting for executor admission or capacity":"Execution is active"),code:run.dispatchIssue?.code,lastProgressAt:run.updatedAt,needsAction:run.state==="uncertain" || run.dispatchIssue?.kind==="needs_action",recoveryActions:run.state==="uncertain"?["request_execution_status","verify_stopped"]:retrying?["task_wait","task_cancel"]:run.dispatchIssue?.kind==="needs_action"?["task_repair_dispatch","task_cancel"]:["task_wait","task_cancel"]};
      }),...unstarted.map(task=>({taskId:task.taskId,phase:"unstarted",reason:"Task has no execution request",lastProgressAt:task.updatedAt,needsAction:true,recoveryActions:["task_dispatch","task_cancel"]}))],
      needsAction: pending.filter(r=>r.state==="uncertain" || r.dispatchIssue?.kind === "needs_action").map(r=>({runId:r.runId,taskId:r.taskId,issue:r.dispatchIssue ?? {kind:"needs_action" as const,code:"UNRESOLVED_EFFECTS",message:"Verify executor stop and reconcile prior execution effects before retrying",action:"review_assignment" as const}})),
      pendingTaskIds: unstarted.map((t) => t.taskId),
      taskIds: [...ids],
      quietUntil: new Date(latest + quietMs).toISOString(),
    };
  }
  registerProject(commandId: string, input: unknown, namespaces?: readonly string[]) {
    this.planner();
    // Namespace authorization is checked outside command replay as well.
    if (namespaces && !namespaces.includes((input as {namespace?:string})?.namespace ?? "")) fail("FORBIDDEN", "Source namespace not authorized");
    new Workbench(this).prepareRegistration();
    return this.command(commandId, "registerProject", input, () => {
      const value = intakeRegistration({get: this.get.bind(this), put: this.put.bind(this), now: this.now.bind(this)}, input, namespaces);
      const p = validateRegistration(input);
      const record = this.need<RegistrationRecord>("registration", mappedId(p.namespace,p.projectExternalId,"registration",p.projectExternalId));
      projectRegistrationToWorkbench(this.db,record);
      return value;
    });
  }
  manageProjectRegistration(commandId: string, input: Parameters<typeof manageRegistration>[1], actor: string) {
    this.planner();
    return this.command(commandId, "manageProjectRegistration", {input,actor}, () => manageRegistration({get:this.get.bind(this),put:this.put.bind(this),now:this.now.bind(this)},input,actor));
  }
  withdrawProjectRegistration(commandId: string, input: {registrationId:string; namespace:string; expectedRevision:number}, namespaces: readonly string[]) {
    this.planner();
    if(!namespaces.includes(input.namespace)) fail("FORBIDDEN","Source namespace not authorized");
    return this.command(commandId,"withdrawProjectRegistration",input,()=>{
      const old=this.need<RegistrationRecord>("registration",input.registrationId);
      if(old.namespace!==input.namespace) fail("FORBIDDEN","Source does not own registration");
      if(old.sourceRevision!==input.expectedRevision) fail("CONFLICT","Source revision changed");
      const value={...old,central:{...old.central,withdrawn:true,revision:old.central.revision+1}};
      this.put("registration",input.registrationId,value);return {withdrawn:true,registrationId:input.registrationId};
    });
  }
  snapshot(): Snapshot {
    return {
      schemaVersion: "1",
      projectRegistrations: this.list<RegistrationRecord>("registration"),
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
      tasks:tasks.map(task=>({...task,checkin:this.checkins.view(task.taskId),actionVersion:this.taskActionState(task.taskId).version})),
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
