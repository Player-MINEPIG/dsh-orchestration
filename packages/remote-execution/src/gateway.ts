import { byteLimit, canonical, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_RESPONSE_BYTES, digest, identifier, insist, isRecord, parseEnvelope, ProtocolError } from './protocol.js'
import type { Envelope, IdentityVerifier, Json, Peer, Role } from './protocol.js'
import type { ApprovalOffer, DelegationInput, LedgerPort, LeaseRef, SafeRetryWitness, Settlement, TaskReportInput } from './ports.js'
import type { CommandReceipt, RecoveryStore } from './store.js'
import { validateRetryWitness } from './retry.js'

function fields(input: Record<string, Json>, required: string[], optional: string[] = []): void {
  insist(required.every(key => Object.hasOwn(input, key)) && Object.keys(input).every(key => [...required, ...optional].includes(key)), 'PAYLOAD_FIELDS')
}
function id(input: Record<string, Json>, key: string): string { const value = input[key]; insist(identifier(value), `INVALID_${key}`); return value }
function text(input: Record<string, Json>, key: string, max: number): string { const value = input[key]; insist(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max, `INVALID_${key}`); return value }
function ttl(input: Record<string, Json>): number { const value = input.ttlMs; insist(Number.isSafeInteger(value) && Number(value) >= 1000 && Number(value) <= 300000, 'INVALID_TTL'); return Number(value) }
function lease(input: Record<string, Json>, nodeId: string): LeaseRef {
  insist(Number.isSafeInteger(input.fence) && Number(input.fence) >= 1, 'INVALID_FENCE')
  return { runId: id(input, 'runId'), attemptId: id(input, 'attemptId'), nodeId, fence: Number(input.fence),...(input.executionId !== undefined ? { executionId: id(input,'executionId') } : {}) }
}
const collaborationOps = ['delegate','taskHistory','taskWait','taskNote','taskReport','offerApproval','approvalStatus']
const ownedFields = ['runId','attemptId','fence','executionId']
function stringArray(value: unknown, label: string, max = 64): void { insist(Array.isArray(value) && value.length <= max && value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 128),label) }
function reportFields(report: Record<string,Json>): void {
  text(report,'title',500); text(report,'body',32768)
  if (report.artifactIds !== undefined) insist(Array.isArray(report.artifactIds) && report.artifactIds.length <= 32 && report.artifactIds.every(identifier),'INVALID_ARTIFACTS')
  if (report.schemaId !== undefined) text(report,'schemaId',200)
  if (report.data !== undefined) canonical(report.data)
}
function delegation(input: Record<string,Json>): void {
  text(input,'title',500)
  if (input.description !== undefined) insist(typeof input.description === 'string' && Buffer.byteLength(input.description) <= 32768,'INVALID_DESCRIPTION')
  if (input.configuration !== undefined) canonical(input.configuration)
  if (input.route !== undefined) {
    insist(isRecord(input.route),'INVALID_ROUTE')
    const route = input.route as Record<string,Json>
    fields(route,['nodeId','provider','model','requiredCapabilities'],['workspaceId','reasoningEffort'])
    id(route,'nodeId'); text(route,'provider',100); text(route,'model',200); stringArray(route.requiredCapabilities,'INVALID_CAPABILITIES')
    if (route.workspaceId !== undefined) id(route,'workspaceId')
    if (route.reasoningEffort !== undefined) text(route,'reasoningEffort',100)
  }
  if (input.policy !== undefined) {
    insist(isRecord(input.policy),'INVALID_POLICY')
    const policy = input.policy as Record<string,Json>
    fields(policy,[],['allowedNodeIds','allowedWorkspaceIds','allowedTools','requiredResources','maxRuntimeMs','maxDepth','maxChildren','maxDescendants','settlementQuietMs'])
    for (const key of ['allowedNodeIds','allowedWorkspaceIds','allowedTools','requiredResources']) if (policy[key] !== undefined) stringArray(policy[key],'INVALID_POLICY_SCOPE')
    if (policy.maxRuntimeMs !== undefined) insist(Number.isSafeInteger(policy.maxRuntimeMs) && Number(policy.maxRuntimeMs) >= 100 && Number(policy.maxRuntimeMs) <= 86400000,'INVALID_RUNTIME_BUDGET')
    if (policy.maxDepth !== undefined) insist(Number.isSafeInteger(policy.maxDepth) && Number(policy.maxDepth) >= 0 && Number(policy.maxDepth) <= 100,'INVALID_DELEGATION_DEPTH')
    for (const key of ['maxChildren','maxDescendants','settlementQuietMs']) if (policy[key] !== undefined) insist(Number.isSafeInteger(policy[key]) && Number(policy[key]) >= 0 && Number(policy[key]) <= 300000,'INVALID_DELEGATION_BOUNDS')
  }
}
export function validatePayload(envelope: Envelope): void {
  const p = envelope.payload
  switch (envelope.operation) {
    case 'claim': fields(p, ['runId','ttlMs']); id(p,'runId'); ttl(p); break
    case 'renew': fields(p,['runId','attemptId','fence','ttlMs'],['executionId']); lease(p,envelope.nodeId); ttl(p); break
    case 'cancel': fields(p,['runId','reason']); id(p,'runId'); text(p,'reason',1000); break
    case 'receipt': fields(p,['commandId']); id(p,'commandId'); break
    case 'listWork': case 'nodeStatus': fields(p,[]); break
    case 'heartbeat': {
      fields(p,['sampledAt','runtimeReady','activeExecutions'],['providerStatus'])
      insist(Number.isSafeInteger(p.sampledAt) && Number(p.sampledAt) >= 0,'INVALID_SAMPLE_TIME')
      insist(typeof p.runtimeReady === 'boolean','INVALID_RUNTIME_READY')
      insist(Number.isSafeInteger(p.activeExecutions) && Number(p.activeExecutions) >= 0 && Number(p.activeExecutions) <= 128,'INVALID_ACTIVE_EXECUTIONS')
      if (p.providerStatus !== undefined) {
        insist(isRecord(p.providerStatus),'INVALID_PROVIDER_STATUS')
        const status = p.providerStatus as Record<string,Json>
        fields(status,['state','providers'])
        const states = ['not-probed','ready','unavailable']
        insist(states.includes(String(status.state)),'INVALID_PROVIDER_STATE')
        insist(Array.isArray(status.providers) && status.providers.length <= 32,'INVALID_PROVIDER_LIST')
        const providers = new Set<string>()
        for (const entry of status.providers) {
          insist(isRecord(entry),'INVALID_PROVIDER_STATUS')
          const provider = entry as Record<string,Json>
          fields(provider,['provider','state']); const name = text(provider,'provider',100)
          insist(!providers.has(name) && states.includes(String(provider.state)),'INVALID_PROVIDER_STATE')
          providers.add(name)
        }
        insist(Buffer.byteLength(canonical(status)) <= 8192,'PROVIDER_STATUS_LIMIT')
      }
      break
    }
    case 'observe': {
      fields(p,['workspaceId','sessionId','sourceRevision','title','body','observedAt','truncated'])
      id(p,'workspaceId'); id(p,'sessionId'); text(p,'sourceRevision',100); text(p,'title',500)
      insist(typeof p.body === 'string' && p.body.trim().length > 0 && p.body.length <= 8000,'INVALID_OBSERVATION_BODY')
      const observedAt = text(p,'observedAt',40)
      insist(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observedAt) && Number.isFinite(Date.parse(observedAt)),'INVALID_OBSERVATION_TIME')
      insist(typeof p.truncated === 'boolean','INVALID_OBSERVATION_TRUNCATION')
      break
    }
    case 'getRun': fields(p,['runId']); id(p,'runId'); break
    case 'getAttempt': fields(p,['attemptId']); id(p,'attemptId'); break
    case 'bindSession': fields(p,['runId','attemptId','fence','sessionId'],['executionId']); lease(p,envelope.nodeId); id(p,'sessionId'); break
    case 'offerApproval': {
      fields(p,[...ownedFields,'requestId','sessionId','agentId','callId','toolName','argumentsDigest','description','expiresAt','allowRemoteOnce'])
      lease(p,envelope.nodeId); for (const key of ['requestId','sessionId','agentId','callId']) id(p,key)
      text(p,'toolName',200)
      insist(typeof p.argumentsDigest === 'string' && /^[a-f0-9]{64}$/.test(p.argumentsDigest),'INVALID_ARGUMENTS_DIGEST')
      insist(typeof p.description === 'string' && p.description.length > 0 && p.description.length <= 4000,'INVALID_APPROVAL_DESCRIPTION')
      insist(Number.isSafeInteger(p.expiresAt) && Number(p.expiresAt) > 0,'INVALID_APPROVAL_EXPIRY')
      insist(typeof p.allowRemoteOnce === 'boolean','INVALID_APPROVAL_ALLOWANCE')
      break
    }
    case 'approvalStatus': fields(p,[...ownedFields,'requestId']); lease(p,envelope.nodeId); id(p,'requestId'); break
    case 'cancelApproval': fields(p,[...ownedFields,'requestId','reason']); lease(p,envelope.nodeId); id(p,'requestId'); text(p,'reason',1000); break
    case 'retryBeforeEffects': fields(p,[...ownedFields,'witness'],['allowRetry']); lease(p,envelope.nodeId); validateRetryWitness(p.witness); if (p.allowRetry !== undefined) insist(typeof p.allowRetry === 'boolean','INVALID_RETRY_ALLOWANCE'); break
    case 'markRunning': fields(p,['runId','attemptId','fence','executionId']); lease(p,envelope.nodeId); break
    case 'acknowledgeCancellation': fields(p,['runId','attemptId','fence'],['executionId']); lease(p,envelope.nodeId); break
    case 'delegate': fields(p,[...ownedFields,'title'],['description','route','policy','configuration']); lease(p,envelope.nodeId); delegation(p); break
    case 'taskHistory': fields(p,ownedFields,['targetTaskId']); lease(p,envelope.nodeId); if (p.targetTaskId !== undefined) id(p,'targetTaskId'); break
    case 'taskWait': fields(p,ownedFields,['targetTaskId','quietMs']); lease(p,envelope.nodeId); if (p.targetTaskId !== undefined) id(p,'targetTaskId'); if (p.quietMs !== undefined) insist(Number.isSafeInteger(p.quietMs) && Number(p.quietMs) >= 0 && Number(p.quietMs) <= 300000,'INVALID_QUIET_WINDOW'); break
    case 'taskNote': fields(p,[...ownedFields,'body'],['targetTaskId']); lease(p,envelope.nodeId); text(p,'body',32768); if (p.targetTaskId !== undefined) id(p,'targetTaskId'); break
    case 'taskReport': fields(p,[...ownedFields,'title','body'],['targetTaskId','data','schemaId','artifactIds']); lease(p,envelope.nodeId); reportFields(p); if (p.targetTaskId !== undefined) id(p,'targetTaskId'); break
    case 'submit': {
      fields(p,['runId','attemptId','fence','outcome','summary'],['report','executionId']); lease(p,envelope.nodeId)
      insist(['success','partial','failure','blocked','unknown'].includes(String(p.outcome)), 'INVALID_OUTCOME')
      text(p,'summary',5000)
      if (p.report !== undefined) {
        insist(isRecord(p.report), 'INVALID_REPORT')
        const report = p.report as Record<string, Json>
        fields(report,['title','body'],['artifactIds','data','schemaId']); reportFields(report)
      }
    }
  }
}
export interface GatewayOptions { role: Role; nodeId: string; verifier: IdentityVerifier; ledger: LedgerPort; store: RecoveryStore; now?: () => number; maxBodyBytes?: number; maxResponseBytes?: number }
/** Coordinator entrypoint. Authenticated payloads contain no command, shell, cwd or actor override. */
export class RemoteGateway {
  private options: GatewayOptions
  private active = true
  private pending = new Set<Promise<unknown>>()
  constructor(options: GatewayOptions) {
    this.options = { ...options,maxBodyBytes: byteLimit(options.maxBodyBytes,DEFAULT_MAX_BODY_BYTES),maxResponseBytes: byteLimit(options.maxResponseBytes,DEFAULT_MAX_RESPONSE_BYTES) }
    insist(options.role !== 'executor', 'PLANNER_ROLE_REQUIRED', 403)
  }
  private bounded(receipt: CommandReceipt): CommandReceipt {
    insist(Buffer.byteLength(canonical(receipt)) <= this.options.maxResponseBytes!,'RESPONSE_LIMIT',413)
    return receipt
  }
  async handle(body: Uint8Array | string): Promise<CommandReceipt> {
    insist(this.active, 'DRAINING', 503)
    const promise = this.handleOwned(body); this.pending.add(promise)
    try { return this.bounded(await promise) } finally { this.pending.delete(promise) }
  }
  private async handleOwned(body: Uint8Array | string): Promise<CommandReceipt> {
    const { verifier, ledger, store } = this.options
    const now = (this.options.now ?? Date.now)()
    const envelope = parseEnvelope(body, this.options.maxBodyBytes)
    const peer = verifier.verify(envelope, now)
    validatePayload(envelope)
    // An authenticated exact command retry may read its receipt after the lease
    // settled or expired. Mutable lease checks apply only to new commands.
    const recorded = store.receipt(peer.nodeId,envelope.commandId)
    await this.authorize(envelope, peer, !recorded || envelope.operation === 'approvalStatus')
    const old = store.admit(envelope, now)
    if (old) return await this.reconcile(peer.nodeId,old)
    const commandId = `remote-${digest([peer.nodeId,envelope.commandId])}`
    const p = envelope.payload
    try {
      let result: unknown
      switch (envelope.operation) {
        case 'heartbeat': {
          insist(ledger.recordNodeHeartbeat,'HEARTBEAT_UNSUPPORTED',503)
          result = await ledger.recordNodeHeartbeat(commandId,{ nodeId: peer.nodeId,sampledAt: Number(p.sampledAt),runtimeReady: p.runtimeReady as boolean,activeExecutions: Number(p.activeExecutions),...(p.providerStatus !== undefined ? { providerStatus: p.providerStatus } : {}) }); break
        }
        case 'nodeStatus': {
          insist(ledger.nodeStatuses,'NODE_STATUS_UNSUPPORTED',503)
          const status = (await ledger.nodeStatuses()).find(node => node.nodeId === peer.nodeId)
          insist(status,'REGISTERED_NODE_REQUIRED',403); result = status; break
        }
        case 'claim': result = await ledger.claim(commandId, { runId: id(p,'runId'), nodeId: peer.nodeId, ttlMs: ttl(p) }); break
        case 'renew': result = await ledger.renew(commandId, { ...lease(p,peer.nodeId), ttlMs: ttl(p) }); break
        case 'submit': result = await ledger.submit(commandId, { ...lease(p,peer.nodeId), outcome: p.outcome as Settlement['outcome'], summary: String(p.summary), ...(p.report ? { report: p.report as unknown as Settlement['report'] } : {}) }); break
        case 'cancel': {
          const run = await ledger.getRun(id(p,'runId')); insist(run, 'RUN_NOT_FOUND', 404)
          result = await ledger.cancel(commandId, { taskId: run.taskId, runId: run.runId, reason: String(p.reason) }); break
        }
        case 'receipt': {
          const receipt = store.receipt(peer.nodeId,id(p,'commandId'))
          result = receipt ? await this.reconcile(peer.nodeId,receipt) : null
          break
        }
        case 'getRun': result = await ledger.getRun(id(p,'runId')); break
        case 'getAttempt': result = await ledger.getAttempt(id(p,'attemptId')); break
        case 'bindSession': result = await ledger.bindSession(commandId,{ ...lease(p,peer.nodeId),sessionId: id(p,'sessionId') }); break
        case 'offerApproval': {
          insist(ledger.offerApproval,'APPROVAL_BRIDGE_UNSUPPORTED',503)
          const { runId,attemptId,fence,executionId,...offer } = p
          result = await ledger.offerApproval(commandId,{ ...lease(p,peer.nodeId),...(offer as unknown as ApprovalOffer) }); break
        }
        case 'approvalStatus': insist(ledger.approvalStatus,'APPROVAL_BRIDGE_UNSUPPORTED',503); result = await ledger.approvalStatus({ ...lease(p,peer.nodeId),requestId: id(p,'requestId') }); break
        case 'cancelApproval': insist(ledger.cancelApproval,'APPROVAL_BRIDGE_UNSUPPORTED',503); result = await ledger.cancelApproval(commandId,{ ...lease(p,peer.nodeId),requestId: id(p,'requestId'),reason: String(p.reason) }); break
        case 'retryBeforeEffects': insist(ledger.retryBeforeEffects,'SAFE_RETRY_UNSUPPORTED',503); result = await ledger.retryBeforeEffects(commandId,{ ...lease(p,peer.nodeId),witness: p.witness as unknown as SafeRetryWitness,...(p.allowRetry !== undefined ? { allowRetry: p.allowRetry as boolean } : {}) }); break
        case 'markRunning': result = await ledger.markRunning(commandId,lease(p,peer.nodeId)); break
        case 'acknowledgeCancellation': insist(ledger.acknowledgeCancellation,'CANCELLATION_ACK_UNSUPPORTED'); result = await ledger.acknowledgeCancellation(commandId,lease(p,peer.nodeId)); break
        case 'delegate': {
          insist(ledger.delegateTask,'COLLABORATION_UNSUPPORTED',503)
          const { runId,attemptId,fence,executionId,...input } = p
          result = await ledger.delegateTask(commandId,{ ...lease(p,peer.nodeId),...(input as unknown as DelegationInput) }); break
        }
        case 'taskHistory': insist(ledger.scopedHistory,'COLLABORATION_UNSUPPORTED',503); result = await ledger.scopedHistory({ ...lease(p,peer.nodeId),...(p.targetTaskId !== undefined ? { taskId: String(p.targetTaskId) } : {}) }); break
        case 'taskWait': insist(ledger.scopedAllSettled,'COLLABORATION_UNSUPPORTED',503); result = await ledger.scopedAllSettled({ ...lease(p,peer.nodeId),...(p.targetTaskId !== undefined ? { taskId: String(p.targetTaskId) } : {}),...(p.quietMs !== undefined ? { quietMs: Number(p.quietMs) } : {}) }); break
        case 'taskNote': insist(ledger.queueScopedNote,'COLLABORATION_UNSUPPORTED',503); result = await ledger.queueScopedNote(commandId,{ ...lease(p,peer.nodeId),body: String(p.body),...(p.targetTaskId !== undefined ? { taskId: String(p.targetTaskId) } : {}) }); break
        case 'taskReport': {
          insist(ledger.appendScopedReport,'COLLABORATION_UNSUPPORTED',503)
          const { runId,attemptId,fence,executionId,targetTaskId,...report } = p
          result = await ledger.appendScopedReport(commandId,{ ...lease(p,peer.nodeId),...(report as unknown as Omit<TaskReportInput,'targetTaskId'>),...(targetTaskId !== undefined ? { taskId: String(targetTaskId) } : {}) }); break
        }
        case 'listWork': {
          const runs = await ledger.pendingRuns(peer.nodeId)
          result = runs.filter(run => !run.observationOnly && run.route?.nodeId === peer.nodeId && run.route.workspaceId && peer.workspaces.includes(run.route.workspaceId) && run.route.requiredCapabilities.every(cap => peer.capabilities.includes(cap))).slice(0,32)
          break
        }
        case 'observe': {
          insist(ledger.captureObservation,'OBSERVATION_INTAKE_UNSUPPORTED',503)
          const sessionId = id(p,'sessionId'); const workspaceId = id(p,'workspaceId')
          // Never accept a source/principal/task/run identity from the peer.
          // The tuple digest prevents delimiter ambiguity across node namespaces.
          const sourceId = `remote-dsh:${peer.nodeId}:${workspaceId}:${digest([peer.nodeId,workspaceId,sessionId])}`
          result = await ledger.captureObservation(commandId,{ seq: 0,sourceId,sessionId,sourceRevision: String(p.sourceRevision),title: String(p.title),body: String(p.body),observedAt: String(p.observedAt),truncated: p.truncated as boolean })
          break
        }
      }
      const json = JSON.parse(JSON.stringify(result)) as Json
      canonical(json)
      const receipt = this.bounded({ commandId: envelope.commandId, state: 'done', result: json })
      store.complete(peer.nodeId,envelope.commandId,json,this.options.maxResponseBytes)
      return receipt
    } catch (error) {
      // An arbitrary adapter exception is not proof that its transaction failed.
      store.uncertain(peer.nodeId,envelope.commandId)
      return { commandId: envelope.commandId, state: 'uncertain' }
    }
  }
  private async reconcile(nodeId: string, receipt: CommandReceipt): Promise<CommandReceipt> {
    if (receipt.state !== 'uncertain' || !this.options.ledger.commandReceipt) return receipt
    try {
      const durable = await this.options.ledger.commandReceipt(`remote-${digest([nodeId,receipt.commandId])}`)
      return durable ? this.options.store.resolve(nodeId,receipt.commandId,durable,this.options.maxResponseBytes) : receipt
    } catch { return receipt } // Missing or mismatched proof cannot authorize a retry.
  }
  private async authorize(e: Envelope, peer: Peer, requireLive: boolean): Promise<void> {
    if (e.operation === 'receipt' || e.operation === 'listWork') return
    if (e.operation === 'heartbeat' || e.operation === 'nodeStatus') {
      insist(this.options.ledger.nodeStatuses,'NODE_STATUS_UNSUPPORTED',503)
      const status = (await this.options.ledger.nodeStatuses()).find(node => node.nodeId === peer.nodeId)
      insist(status,'REGISTERED_NODE_REQUIRED',403)
      if (e.operation === 'heartbeat') {
        insist(this.options.ledger.recordNodeHeartbeat,'HEARTBEAT_UNSUPPORTED',503)
        if (requireLive) insist(Number(e.payload.sampledAt) >= e.issuedAt - 60000 && Number(e.payload.sampledAt) <= e.issuedAt + 5000,'STALE_HEARTBEAT_SAMPLE',401)
      }
      return
    }
    if (e.operation === 'observe') {
      insist(peer.workspaces.includes(String(e.payload.workspaceId)),'WORKSPACE_DENIED',403)
      insist(this.options.ledger.captureObservation,'OBSERVATION_INTAKE_UNSUPPORTED',503)
      return
    }
    if (e.operation === 'cancelApproval') {
      // Cleanup cannot grant an action. The core checks the request's exact old ref,
      // even when that attempt has expired or its run was subsequently rerouted.
      const attempt = await this.options.ledger.getAttempt(String(e.payload.attemptId))
      insist(attempt && attempt.nodeId === peer.nodeId && attempt.runId === e.payload.runId && attempt.fence === e.payload.fence && attempt.executionId === e.payload.executionId,'APPROVAL_OWNER_DENIED',403)
      insist(this.options.ledger.cancelApproval,'APPROVAL_BRIDGE_UNSUPPORTED',503)
      return
    }
    const inspectedAttempt = e.operation === 'getAttempt' ? await this.options.ledger.getAttempt(String(e.payload.attemptId)) : undefined
    if (e.operation === 'getAttempt') insist(inspectedAttempt?.nodeId === peer.nodeId,'ATTEMPT_DENIED',403)
    const run = await this.options.ledger.getRun(inspectedAttempt?.runId ?? String(e.payload.runId))
    insist(run?.route, 'ROUTED_RUN_REQUIRED', 404)
    if (['claim','renew','bindSession','markRunning','submit','acknowledgeCancellation','cancel','retryBeforeEffects',...collaborationOps].includes(e.operation)) insist(!run.observationOnly,'OBSERVE_ONLY',403)
    // Peer cancellation is scoped to that peer's own assigned node. Coordinator
    // operator cancellation uses the trusted ledger API, never a peer role claim.
    insist(run.route.nodeId === peer.nodeId, 'NODE_ROUTE_DENIED', 403)
    const workspace = run.route.workspaceId
    insist(workspace && peer.workspaces.includes(workspace), 'WORKSPACE_DENIED', 403)
    insist(run.route.requiredCapabilities.every(cap => peer.capabilities.includes(cap)), 'CAPABILITY_DENIED', 403)
    if (['submit','renew','bindSession','markRunning','acknowledgeCancellation','retryBeforeEffects',...collaborationOps].includes(e.operation)) {
      const attempt = await this.options.ledger.getAttempt(String(e.payload.attemptId))
      insist(attempt && attempt.nodeId === peer.nodeId && attempt.runId === run.runId && attempt.fence === e.payload.fence, 'ATTEMPT_DENIED', 403)
      if (e.operation === 'offerApproval') {
        insist(attempt.sessionId && attempt.sessionId === e.payload.sessionId,'APPROVAL_SESSION_DENIED',403)
        if (requireLive) insist(Number(e.payload.expiresAt) > (this.options.now ?? Date.now)() && Number(e.payload.expiresAt) <= (this.options.now ?? Date.now)() + 300000,'INVALID_APPROVAL_EXPIRY')
      }
      if (e.operation === 'retryBeforeEffects') { insist(attempt.sessionId,'BOUND_SESSION_REQUIRED',403); validateRetryWitness(e.payload.witness,attempt.sessionId) }
      insist(attempt.executionId === undefined || attempt.executionId === e.payload.executionId,'EXECUTION_OWNER_DENIED',403)
      if (requireLive && e.operation !== 'acknowledgeCancellation') {
        insist(['leased','running'].includes(attempt.state) && Date.parse(attempt.leaseExpiresAt) > (this.options.now ?? Date.now)(),'LEASE_EXPIRED',409)
        insist(!run.cancellationRequested,'CANCELLATION_REQUESTED',409)
      }
    }
  }
  async dispose(): Promise<void> { this.active = false; await Promise.allSettled([...this.pending]) }
}
