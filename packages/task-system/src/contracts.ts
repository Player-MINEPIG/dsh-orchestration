import type { Criterion } from "./workbench-contracts.js";
/** Shared, versioned contract used by plugins and the read-only dashboard. */
export const SCHEMA_VERSION = "1" as const;
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskState =
  | "candidate"
  | "inbox"
  | "ready"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "archived";
export type RunState =
  | "queued"
  | "running"
  | "blocked"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "uncertain";
export type Role = "planner" | "executor" | "both";
export interface TaskPolicy {
  allowedNodeIds?: string[];
  allowedWorkspaceIds?: string[];
  allowedTools?: string[];
  requiredResources?: string[];
  maxRuntimeMs?: number;
  maxDepth?: number;
  maxChildren?: number;
  maxDescendants?: number;
  settlementQuietMs?: number;
  maxSafeRetries?: number;
}
export type Outcome = "success" | "partial" | "failure" | "blocked" | "unknown";
export interface Source {
  kind: "explicit-import" | "task-system";
  label: string;
  observedAt: string;
  staleAfterMs: number;
}
export interface Task {
  taskId: string;
  title: string;
  description: string;
  goal?: string;
  acceptanceCriteria?: Criterion[];
  revision?: number;
  intentRevision?: number;
  /** Derived. Explicit override wins, otherwise the highest linked Backlog. */
  priority?: TaskPriority;
  priorityOverride?: TaskPriority;
  targetAt?: string;
  state: TaskState;
  kind: "ad_hoc" | "scheduled" | "observed";
  createdAt: string;
  updatedAt: string;
  parentTaskId?: string;
  parentRunId?: string;
  workspaceId?: string;
  tags: string[];
  /** Legacy imported/compatibility data only; new tasks use state=candidate. */
  admissionState?: "admitted" | "dismissed";
  admissionRevision?: number;
  policy?: TaskPolicy;
  userImmediacy?: number;
  importance?: number;
  urgency?: number;
  confirmation?: {
    required: boolean;
    state: "not_required" | "pending" | "approved" | "rejected";
    revision: number;
    actor?: string;
    reason?: string;
    decidedAt?: string;
  };
  source?: {
    observedAt: string;
    importedAt: string;
    originalCreatedAt?: string;
    label: string;
  };
}
export interface ExecutionRoute {
  nodeId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  workspaceId?: string;
  requiredCapabilities: string[];
}
export interface Run {
  runId: string;
  taskId: string;
  parentRunId?: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  /** Read-only derived from Attempt and explicit context session relations. */
  sessionIds: string[];
  intentSnapshot?: {
    title: string;
    description: string;
    goal?: string;
    acceptanceCriteria: Criterion[];
    intentRevision?: number;
  };
  /** Legacy historical fields, never written for new runs. */
  outcome?: Outcome;
  reviewStatus?: "pending_user" | "accepted" | "rejected";
  validation?: "valid" | "not-submitted";
  route?: ExecutionRoute;
  /** Explicit user Task/Run/Schedule workspace; derived executor defaults do not set this. */
  workspaceConstraint?: string;
  occurrenceId?: string;
  configuration: Json;
  currentAttemptId?: string;
  cancellationRequested?: boolean;
  /** Historical observation may never become dispatchable when its task is continued. */
  historyOnly?: boolean;
  /** Legacy import compatibility. New runs use historyOnly. */
  observationOnly?: boolean;
  contextNotes?: string[] | { reportId: string; body: string; actor: string }[];
  executionStartedAt?: string;
  retryPolicy?: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    resumableTools?: string[];
  };
  retry?: {
    count: number;
    notBefore: string;
    sessionId: string;
    previousAttemptId: string;
    reasonCode: string;
    completedTools?: CompletedToolFingerprint[];
  };
}
export interface Attempt {
  attemptId: string;
  taskId: string;
  runId: string;
  nodeId: string;
  fence: number;
  leaseExpiresAt: string;
  state:
    | "leased"
    | "running"
    | "settled"
    | "cancelled"
    | "expired"
    | "uncertain";
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  /** First execution instance to atomically start this attempt. */
  executionId?: string;
  retryEvidence?: SafeRetryWitness;
}
export interface CompletedToolFingerprint {
  name: string;
  /** SHA256 of canonical tool name and validated arguments; never raw arguments. */
  argumentsDigest: string;
}
interface RetryWitnessFacts {
  sessionId: string;
  fromSeq: number;
  toSeq: number;
  terminalSeq: number;
  turn: number;
  code: "RATE_LIMIT" | "SERVER" | "TRANSPORT" | "TIMEOUT";
  complete: true;
  quiescent: true;
  persisted: true;
  disposed: true;
}
export type SafeRetryWitness = RetryWitnessFacts &
  (
    | {
        kind: "dsh-owned-zero-tools-v1";
        toolCallCount: 0;
        toolDispatchCount: 0;
      }
    | {
        kind: "dsh-owned-completed-tools-v1";
        toolCallCount: number;
        toolDispatchCount: number;
        toolResultCount: number;
        completedTools: CompletedToolFingerprint[];
      }
  );
export interface Report {
  reportId: string;
  taskId: string;
  runId?: string;
  attemptId?: string;
  sessionId?: string;
  revision: number;
  previousReportId?: string;
  title: string;
  body: string;
  data?: Json;
  schemaId?: string;
  createdAt: string;
  recordedAt: string;
  artifactIds: string[];
  kind: "progress" | "result" | "review" | "observation" | "note";
}
export interface Artifact {
  artifactId: string;
  taskId: string;
  reportId?: string;
  name: string;
  mediaType: string;
  uri?: string;
  sha256?: string;
  bytes?: number;
  createdAt: string;
  finalized: boolean;
}
export interface Event {
  eventId: string;
  taskId?: string;
  runId?: string;
  type: string;
  at: string;
  detail: Json;
}
export interface Template {
  templateId: string;
  version: number;
  name: string;
  description: string;
  inputSchema: Json;
  defaults: Json;
  resultContract: Json;
  /** Operator-registered synchronous semantic validator, pinned with this revision. */
  resultValidator?: string;
}
export interface Schedule {
  scheduleId: string;
  taskId: string;
  templateId: string;
  templateVersion: number;
  enabled: boolean;
  intervalMs?: number;
  cron?: string;
  timeZone?: string;
  nextDueAt: string;
  overlap: "skip" | "queue";
  misfire?: "once" | "skip" | "all";
  revision?: number;
  retiredAt?: string;
  input: Json;
  route?: ExecutionRoute;
}
export interface Workspace {
  workspaceId: string;
  nodeId: string;
  path: string;
  label: string;
  state: "ready" | "planned" | "failed";
  createdAt: string;
}
export interface NodeCapability {
  nodeId: string;
  /** Operator-selected registered workspace used when a route does not specify one. */
  defaultWorkspaceId?: string;
  roles: Role[];
  capabilities: string[];
  models: { provider: string; model: string; reasoningEfforts: string[] }[];
  workspaceIds: string[];
  enabled: boolean;
  maxConcurrent?: number;
  lastSeenAt: string;
}
export interface Delivery {
  deliveryId: string;
  taskId?: string;
  runId?: string;
  dependsOnDeliveryId?: string;
  replyToDeliveryId?: string;
  alertId?: string;
  approvalId?: string;
  reportId?: string;
  destination: string;
  kind: string;
  payload: Json;
  state: "pending" | "sending" | "sent" | "uncertain" | "failed";
  attempts: number;
  nextAttemptAt: string;
  receipt?: Json;
  claimToken?: string;
  leaseExpiresAt?: string;
}
export interface Alert {
  alertId: string;
  dedupeKey: string;
  status: "open" | "acknowledged" | "resolved";
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  taskId?: string;
  nodeId?: string;
  revision: number;
  cycle: number;
  occurrences: number;
  createdAt: string;
  openedAt: string;
  lastSeenAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  actor?: string;
  reason?: string;
}
export interface ApprovalRequest extends LeaseRef {
  requestId: string;
  taskId: string;
  executionId: string;
  sessionId: string;
  agentId: string;
  callId: string;
  toolName: string;
  argumentsDigest: string;
  description: string;
  allowRemoteOnce: boolean;
  createdAt: string;
  expiresAt: number;
  revision: number;
  state: "pending" | "allowed-once" | "denied" | "expired" | "cancelled";
  decidedAt?: string;
  actor?: string;
  reason?: string;
}
export interface NodeStatus {
  nodeId: string;
  enabled: boolean;
  state: "unknown" | "online" | "unavailable" | "stale" | "disabled";
  observedAt?: string;
  expiresAt?: string;
  runtimeReady?: boolean;
  activeExecutions?: number;
  activeClaims: number;
  maxConcurrent?: number;
  availableSlots?: number;
  providerStatus?: Json;
  source: "authenticated-peer" | "host-local" | "unobserved";
}
export interface Snapshot {
  schemaVersion: "1";
  generatedAt: string;
  source: Source;
  tasks: Task[];
  runs: Run[];
  attempts?: Attempt[];
  reports: Report[];
  artifacts: Artifact[];
  templates: Template[];
  events: Event[];
  workspaces?: Workspace[];
  schedules?: Schedule[];
  alerts?: Alert[];
  nodeStatuses?: NodeStatus[];
  approvals?: ApprovalRequest[];
}
export interface ExecutionContext {
  template?: Template;
  reports: { reportId: string; body: string; actor: string }[];
}
export interface Claim {
  /** Resolved authority-owned transport context, not another persisted Run copy. */
  executionContext?: ExecutionContext;
  attempt: Attempt;
  run: Run;
  task: Task;
}
export interface LeaseRef {
  runId: string;
  attemptId: string;
  nodeId: string;
  fence: number;
  /** Required to start execution and for every write after ownership is bound. */
  executionId?: string;
}
export const NATIVE_PROVIDER_UNAVAILABLE_SUMMARY =
  "Native execution blocked before dispatch: NO_ADAPTER. No adapter is registered for the configured provider; no model request or workload was started.";
export interface NativePreDispatchFailure {
  kind: "native-provider-unavailable-v1";
  code: "NO_ADAPTER";
  provider: string;
  model: string;
}
export interface Settlement extends LeaseRef {
  /** Trusted native host attestation only. Never exposed in the model settlement tool. */
  preDispatchFailure?: NativePreDispatchFailure;
  outcome: Outcome;
  summary: string;
  report?: {
    title: string;
    body: string;
    data?: Json;
    schemaId?: string;
    artifactIds?: string[];
  };
  notifications?: { destination: string; kind: string; payload: Json }[];
}
export interface Receipt<T = Json> {
  commandId: string;
  acceptedAt: string;
  value: T;
}
