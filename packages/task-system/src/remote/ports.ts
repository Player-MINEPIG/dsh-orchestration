import type { Json, Role, PreDispatchFailure } from './protocol.js'
import type { Claim as CoreClaim, Run as CoreRun } from '../contracts.js'

export interface ExecutorIdentity { schedulerId: string; executorId: string; nodeId: string }
export interface TaskSession { schedulerId: string; taskId: string; nodeId: string; workspaceId?: string; sessionId: string; createdAt: string }
export interface TaskSessionContext { schedulerId: string; taskSessionId?: string; sessions: TaskSession[] }
export interface TaskSessionChoice { expectedTaskSessionId?: string | null; workspaceId?: string; session: { mode: 'new' } | { mode: 'reuse'; sessionId: string }; decision?: Json }
export interface SelectedTaskSession extends TaskSession { resume: boolean }
export interface Receipt<T = unknown> { commandId: string; acceptedAt: string; value: T }
export interface Route { nodeId: string; provider: string; model: string; reasoningEffort?: string; workspaceId?: string; requiredCapabilities: string[] }
export interface TaskPolicy { allowedNodeIds?: string[]; allowedWorkspaceIds?: string[]; allowedTools?: string[]; maxRuntimeMs?: number; maxDepth?: number; requiredResources?: string[]; maxChildren?: number; maxDescendants?: number; settlementQuietMs?: number }
export interface Task { taskId: string; title: string; description: string; workspaceId?: string; policy?: TaskPolicy }
export interface Run { runId: string; taskId: string; state: string; route?: Route; configuration: Json; cancellationRequested?: boolean; historyOnly?: boolean; observationOnly?: boolean; intentSnapshot?: CoreRun['intentSnapshot']; contextNotes?: CoreRun['contextNotes']; executionStartedAt?: string; retryPolicy?: { maxRetries: number; baseDelayMs: number; maxDelayMs: number; resumableTools?: string[] }; retry?: { count: number; notBefore: string; sessionId: string; previousAttemptId: string; reasonCode: string; completedTools?: CompletedToolFingerprint[] } }
export interface Attempt { attemptId: string; taskId: string; runId: string; nodeId: string; fence: number; leaseExpiresAt: string; state: string; sessionId?: string; executionId?: string }
export interface Claim { attempt: Attempt; run: Run; task: Task; executionContext?: CoreClaim['executionContext'] }
export interface LeaseRef { runId: string; attemptId: string; nodeId: string; fence: number; executionId?: string }
export interface Settlement extends LeaseRef { preDispatchFailure?: PreDispatchFailure; outcome: 'success' | 'partial' | 'failure' | 'blocked' | 'unknown'; summary: string; report?: { title: string; body: string; artifactIds?: string[]; data?: Json; schemaId?: string } }
export interface ObservationInput { workspaceId: string; sessionId: string; sourceRevision: string; title: string; body: string; observedAt: string; truncated: boolean }
/** Structural compatibility with the core's bounded native observation fold. */
export interface CapturedText { seq: number; sessionId: string; sourceId: string; sourceRevision: string; title: string; body: string; observedAt: string; truncated: boolean; cwd?: string }
export interface ObservationCandidate { candidateId: string; sourceId: string; sourceRevision: string; sessionId: string; title: string; body: string; observedAt: string; truncated: boolean; state: 'pending' | 'ignored' | 'admitted'; taskId?: string; reportId?: string; cwd?: string }
export interface DelegationInput { title: string; description?: string; route?: Route; policy?: TaskPolicy; configuration?: Json }
export interface TaskHistory { task: Task; runs: Run[]; reports: unknown[]; artifacts: unknown[]; events: unknown[] }
export interface SettlementView { settled: boolean; pendingRunIds: string[]; pendingTaskIds: string[]; taskIds: string[]; quietUntil: string }
export interface TaskNoteInput { targetTaskId?: string; body: string }
export interface TaskReportInput { targetTaskId?: string; title: string; body: string; data?: Json; schemaId?: string; artifactIds?: string[] }
export interface CompletedToolFingerprint { name: string; argumentsDigest: string }
interface RetryWitnessFacts { sessionId: string; fromSeq: number; toSeq: number; terminalSeq: number; turn: number; code: 'RATE_LIMIT' | 'SERVER' | 'TRANSPORT' | 'TIMEOUT'; complete: true; quiescent: true; persisted: true; disposed: true }
export type SafeRetryWitness = RetryWitnessFacts & (
  { kind: 'dsh-owned-zero-tools-v1'; toolCallCount: 0; toolDispatchCount: 0 }
  | { kind: 'dsh-owned-completed-tools-v1'; toolCallCount: number; toolDispatchCount: number; toolResultCount: number; completedTools: CompletedToolFingerprint[] }
)
export interface HeartbeatInput { nodeId: string; sampledAt: number; runtimeReady: boolean; activeExecutions: number; providerStatus?: Json }
/** Observations are reported by a peer and never change its configured grants. */
export interface NodeStatus { nodeId: string; enabled: boolean; state: 'unknown' | 'online' | 'unavailable' | 'stale' | 'disabled'; observedAt?: string; expiresAt?: string; runtimeReady?: boolean; activeExecutions?: number; activeClaims: number; maxConcurrent?: number; availableSlots?: number; providerStatus?: Json; source: 'authenticated-peer' | 'host-local' | 'unobserved' }
export interface ApprovalOffer { requestId: string; sessionId: string; agentId: string; callId: string; toolName: string; argumentsDigest: string; description: string; expiresAt: number; allowRemoteOnce: boolean }
export interface ApprovalRequest extends ApprovalOffer, LeaseRef { taskId: string; executionId: string; createdAt: string; revision: number; state: 'pending' | 'allowed-once' | 'denied' | 'expired' | 'cancelled'; decidedAt?: string; actor?: string; reason?: string }
export interface ExecutionCollaboration {
  delegate(commandId: string,input: DelegationInput): Promise<Receipt<{ task: Task; run: Run }>>
  history(targetTaskId?: string): Promise<TaskHistory>
  wait(targetTaskId?: string,quietMs?: number): Promise<SettlementView>
  note(commandId: string,input: TaskNoteInput): Promise<Receipt<unknown>>
  report(commandId: string,input: TaskReportInput): Promise<Receipt<unknown>>
  offerApproval(commandId: string,input: ApprovalOffer): Promise<Receipt<ApprovalRequest>>
  approvalStatus(requestId: string): Promise<ApprovalRequest>
  cancelApproval(commandId: string,input: { requestId: string; reason: string }): Promise<Receipt<ApprovalRequest>>
}
type MaybePromise<T> = T | Promise<T>
/** An adapter must preserve the ledger's transaction, idempotency, lease and fencing guarantees. */
export interface LedgerPort {
  schedulerIdentity?(): string
  sessionContext?(input: LeaseRef): MaybePromise<TaskSessionContext>
  selectTaskSession?(commandId: string,input: LeaseRef & TaskSessionChoice): MaybePromise<Receipt<SelectedTaskSession>>
  /** maxClaimBytes is a host transport budget, never a peer-supplied command field. */
  claim(commandId: string, input: { runId: string; nodeId: string; ttlMs: number; maxClaimBytes?: number }): MaybePromise<Receipt<Claim>>
  renew(commandId: string, input: LeaseRef & { ttlMs: number }): MaybePromise<Receipt<Attempt>>
  submit(commandId: string, input: Settlement): MaybePromise<Receipt<Run>>
  cancel(commandId: string, input: { taskId: string; runId?: string; reason: string }): MaybePromise<Receipt<Task>>
  bindSession(commandId: string, input: LeaseRef & { sessionId: string }): MaybePromise<Receipt<Attempt>>
  markRunning(commandId: string, input: LeaseRef): MaybePromise<Receipt<Attempt>>
  acknowledgeCancellation?(commandId: string, input: LeaseRef): MaybePromise<Receipt<Run>>
  /** Compatibility name: includes explicit coordinator-approved completed-tool continuation. */
  retryBeforeEffects?(commandId: string,input: LeaseRef & { witness: SafeRetryWitness; allowRetry?: boolean }): MaybePromise<Receipt<Run>>
  getRun(runId: string): MaybePromise<Run | undefined>
  getAttempt(attemptId: string): MaybePromise<Attempt | undefined>
  pendingRuns(nodeId: string): MaybePromise<Run[]>
  captureObservation?(commandId: string, input: CapturedText): MaybePromise<Receipt<ObservationCandidate>>
  commandReceipt?(commandId: string): MaybePromise<Receipt | undefined>
  offerApproval?(commandId: string,input: LeaseRef & ApprovalOffer,options?: { signal?: AbortSignal }): MaybePromise<Receipt<ApprovalRequest>>
  approvalStatus?(input: LeaseRef & { requestId: string },options?: { signal?: AbortSignal }): MaybePromise<ApprovalRequest>
  cancelApproval?(commandId: string,input: LeaseRef & { requestId: string; reason: string },options?: { signal?: AbortSignal }): MaybePromise<Receipt<ApprovalRequest>>
  recordNodeHeartbeat?(commandId: string,input: HeartbeatInput): MaybePromise<Receipt<unknown>>
  nodeStatuses?(now?: number): MaybePromise<NodeStatus[]>
  delegateTask?(commandId: string,input: LeaseRef & DelegationInput,options?: { signal?: AbortSignal }): MaybePromise<Receipt<{ task: Task; run: Run }>>
  scopedHistory?(input: LeaseRef & { taskId?: string },options?: { signal?: AbortSignal }): MaybePromise<TaskHistory>
  scopedAllSettled?(input: LeaseRef & { taskId?: string; quietMs?: number },options?: { signal?: AbortSignal }): MaybePromise<SettlementView>
  queueScopedNote?(commandId: string,input: LeaseRef & { taskId?: string; body: string },options?: { signal?: AbortSignal }): MaybePromise<Receipt<unknown>>
  appendScopedReport?(commandId: string,input: LeaseRef & { taskId?: string } & Omit<TaskReportInput,'targetTaskId'>,options?: { signal?: AbortSignal }): MaybePromise<Receipt<unknown>>
}
export interface ExecutionRequest { claim: Claim; sessionId: string; resumeSession?: boolean; workspacePath: string; signal: AbortSignal; collaboration?: ExecutionCollaboration }
export type ExecutionResult = Pick<Settlement, 'outcome' | 'summary' | 'report' | 'preDispatchFailure'> & { retryWitness?: SafeRetryWitness; retryAllowed?: boolean }
/** Host-owned implementation. Must enforce declared capabilities and await abort quiescence. */
export interface ExecutionProvider {
  readonly id: string
  readonly capabilities: readonly string[]
  /** Must enforce the exact configured provider/model/effort tuple; backend id is diagnostic. */
  supports(route: Route): boolean
  execute(request: ExecutionRequest): Promise<ExecutionResult>
}
export interface WorkspaceBinding { workspaceId: string; nodeId: string; path: string; allowedRoot: string }
export interface WorkerPolicy { role: Role; nodeId: string; capabilities: readonly string[]; workspaces: readonly WorkspaceBinding[] }
