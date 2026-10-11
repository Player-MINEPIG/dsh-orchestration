import { chooseExecutionSession } from '../execution-session.js'
import { Context, Service } from '@deepseek-ai/cordis'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import { resolve } from 'node:path'
import { createPrivateKey, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_RESPONSE_BYTES, MAX_WIRE_BYTES, IdentityVerifier, insist } from './protocol.js'
import type { AuthMode, Operation, Role } from './protocol.js'
import { TrustedNetworkVerifier } from './trusted-network.js'
import type { TrustedNetworkPeer, TrustedNetworkPolicy, TrustedNetworkTarget } from './trusted-network.js'
import type { ExecutionProvider, LedgerPort, ObservationCandidate, WorkspaceBinding } from './ports.js'
import { RecoveryStore } from './store.js'
import { ExecutorWorker } from './worker.js'
import { RemoteGateway } from './gateway.js'
import { httpHandler, startTrustedNetworkCarrier } from './http.js'
import { RemoteClient, RemoteLedgerClient } from './client.js'
import { observationForwarder } from './observation.js'
import type { NativeExecutionPort } from './native-adapter.js'

export const name = 'dsh-task-remote-execution'
export const inject = ['taskSystem']
type NetworkPolicyConfig = Omit<TrustedNetworkPolicy, 'allowedAddresses' | 'peers'> & { allowedAddresses: string[]; peers: (Omit<TrustedNetworkPeer, 'operations' | 'workspaces' | 'capabilities'> & { operations: Operation[]; workspaces: string[]; capabilities: string[] })[] }
export interface Config {
  /** Keep the plugin editable without initializing any remote runtime resource. */
  paused?: boolean;
  role: Role; nodeId: string; statePath: string; exposeHttp: boolean; routePath: string;
  authMode?: AuthMode; trustedNetwork?: NetworkPolicyConfig | null;
  audience: string; peers: { keyId: string; nodeId: string; publicKey: string; audience: string; operations: Operation[]; workspaces: string[]; capabilities: string[] }[];
  capabilities: string[]; workspaces: WorkspaceBinding[]; allowLoopbackHttp: boolean; leaseTtlMs: number; maxBodyBytes: number; maxResponseBytes: number;
  pollIntervalMs: number; concurrency: number; executionLimits?: {pollIntervalMs?: number; concurrency?: number};
  /** Compatibility for old connections; new setup writes true after explicit grants. */
  taskSessionsEnabled?: boolean;
  coordinator?: { panelUrl?: string; endpoint: string; audience: string; authMode?: AuthMode; keyId?: string; privateKeyEnv?: string; trustedNetwork?: TrustedNetworkTarget | null; maxResponseBytes?: number; heartbeatIntervalMs?: number; nativeRoutes: { provider: string; models: { model: string; reasoningEfforts: string[] }[] }[] } | null;
  /** Forward only observations inside the configured local workspace binding. */
  observationForwarding?: { workspaceId: string } | null;
}
const authModeSchema = z.union([z.const('ed25519'),z.const('trusted-network')])
const operationSchema = z.union([z.const('claim'),z.const('renew'),z.const('submit'),z.const('cancel'),z.const('receipt'),z.const('bindSession'),z.const('markRunning'),z.const('getRun'),z.const('getAttempt'),z.const('acknowledgeCancellation'),z.const('listWork'),z.const('observe'),z.const('delegate'),z.const('taskHistory'),z.const('taskWait'),z.const('taskNote'),z.const('taskReport'),z.const('heartbeat'),z.const('nodeStatus'),z.const('retryBeforeEffects'),z.const('offerApproval'),z.const('approvalStatus'),z.const('cancelApproval'),z.const('executorIdentity'),z.const('sessionContext'),z.const('selectTaskSession'),z.const('sessionMessages'),z.const('sessionMessageReply'),z.const('projectSnapshot')])
const addressSchema = z.string().required()
const portSchema = z.number().step(1).min(1).max(65535).required()
const networkPolicySchema = z.object({
  listen: z.object({ address: addressSchema,port: portSchema }).required(),allowHttp: z.const(true).required(),allowedAddresses: z.array(z.string()).required(),
  peers: z.array(z.object({ address: addressSchema,nodeId: z.string().required(),role: z.union([z.const('planner'),z.const('executor'),z.const('both')]).required(),audience: z.string().required(),operations: z.array(operationSchema).required(),workspaces: z.array(z.string()).required(),capabilities: z.array(z.string()).required() })).required(),
})
const networkTargetSchema = z.object({ address: addressSchema,port: portSchema,localAddress: addressSchema,allowHttp: z.const(true).required() })
const PlainConfig: z<Config> = z.object({
  paused: z.boolean().default(false).description('Keep this plugin loaded for configuration while creating no remote store, connection, listener, polling or heartbeat. Setting false is an explicit resume/connect action.'),
  role: z.union([z.const('planner'),z.const('executor'),z.const('both')]).default('executor'),
  authMode: authModeSchema.default('ed25519'),trustedNetwork: z.union([z.const(null),networkPolicySchema]).default(null),
  nodeId: z.string().default('unconfigured'), statePath: z.string().default('.dsh-task/remote-execution.sqlite'),
  exposeHttp: z.boolean().default(false), routePath: z.string().default('/dsh-task/v1/commands'), audience: z.string().default('task-coordinator'),
  peers: z.array(z.object({ keyId: z.string().required(),nodeId: z.string().required(),publicKey: z.string().required(),audience: z.string().required(),
    operations: z.array(operationSchema).required(),workspaces: z.array(z.string()).required(),capabilities: z.array(z.string()).required(),
  })).default([]),
  capabilities: z.array(z.string()).default([]), workspaces: z.array(z.object({ workspaceId: z.string().required(),nodeId: z.string().required(),path: z.string().required(),allowedRoot: z.string().required() })).default([]),
  allowLoopbackHttp: z.boolean().default(false), leaseTtlMs: z.number().step(1).min(1000).max(300000).default(60000), maxBodyBytes: z.number().step(1).min(1024).max(MAX_WIRE_BYTES).default(DEFAULT_MAX_BODY_BYTES), maxResponseBytes: z.number().step(1).min(1024).max(MAX_WIRE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),
  pollIntervalMs: z.union([z.const(0),z.number().step(1).min(100).max(3600000)]).default(0), concurrency: z.number().step(1).min(1).max(16).default(1),
  executionLimits: z.object({pollIntervalMs:z.union([z.const(0),z.number().step(1).min(100).max(3600000)]).required(false),concurrency:z.number().step(1).min(1).max(16).required(false)}).default({}),
  taskSessionsEnabled: z.boolean().required(false),
  coordinator: z.union([z.const(null),z.object({ panelUrl: z.string(),endpoint: z.string().required(),audience: z.string().required(),authMode: authModeSchema.default('ed25519'),keyId: z.string(),privateKeyEnv: z.string(),trustedNetwork: z.union([z.const(null),networkTargetSchema]).default(null),maxResponseBytes: z.number().step(1).min(1024).max(MAX_WIRE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),heartbeatIntervalMs: z.union([z.const(0),z.number().step(1).min(1000).max(3600000)]).default(0),nativeRoutes: z.array(z.object({ provider: z.string().required(),models: z.array(z.object({ model: z.string().required(),reasoningEfforts: z.array(z.string()).default([]) })).required() })).default([]) })]).default(null),
  observationForwarding: z.union([z.const(null),z.object({ workspaceId: z.string().required() })]).default(null).description('Forward only captured observations whose immutable session cwd resolves within this configured workspace path and allowed root.'),
})
export const Config = z.object({...PlainConfig.dict, executionLimits:PlainConfig.dict!.executionLimits!.volatile()})
interface HostWebServer { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage,res: ServerResponse) => Promise<void> }): () => void }
/** An independently replaceable taskSystem service supplies only this structural ledger seam. */
export interface TaskSystemPort {
  ledger: LedgerPort; native?: NativeExecutionPort; config?: { decisionBindings?: Record<string,string>; autoAdmitObservations?: boolean; defaultWorkspaceId?: string | null; sessionDecisionEnabled?: boolean; decisionTtlMs?: number };
  subscribeObservations?(sink: (candidate: ObservationCandidate, options: { signal: AbortSignal }) => Promise<unknown> | unknown): () => void;
}
export class RemoteExecutionService extends Service {
  readonly gateway?: RemoteGateway
  private workers = new Set<ExecutorWorker>()
  private active = true
  private configurationPaused = false
  private configurationRelease?: () => void
  private config: Config
  private ledger: LedgerPort
  private store?: RecoveryStore
  private workerLedger: LedgerPort
  private client?: RemoteClient
  private observationDisposer?: () => void
  private carrierClose?: () => Promise<void>
  private carrierStartup?: Promise<void>
  private disposal?: Promise<void>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private heartbeatPending?: Promise<unknown>
  lastHeartbeatFailed = false
  private lastHeartbeatSample = 0
  private lastHeartbeatAcknowledgedAt: string | null = null
  coordinatorLedger?: RemoteLedgerClient
  nativeWorker?: ExecutorWorker
  constructor(ctx: Context, config: Config, ledger: LedgerPort, store?: RecoveryStore) {
    super(ctx,'remoteExecution');
    const limits = config.executionLimits as unknown;
    const raw = {...config};
    for (const key of ['pollIntervalMs','concurrency'] as const)
      Object.defineProperty(raw,key,{enumerable:true,get:()=> (isVolatile(limits) ? limits.get() as Config['executionLimits'] : limits as Config['executionLimits'])?.[key] ?? config[key]});
    this.config = raw; this.ledger = ledger; this.workerLedger = ledger; this.store = config.paused === true ? undefined : store
    if (config.paused === true) return
    insist(store,'RECOVERY_STORE_REQUIRED',503)
    if (config.role !== 'executor') this.gateway = new RemoteGateway({ role: config.role,nodeId: config.nodeId,verifier: config.authMode === 'trusted-network' ? new TrustedNetworkVerifier({ ...config.trustedNetwork!,audience: config.audience }) : new IdentityVerifier({ audience: config.audience,peers: config.peers }),ledger,store,maxBodyBytes: config.maxBodyBytes,maxResponseBytes: config.maxResponseBytes })
  }
  /** Read-only settings projection, deliberately excludes keys, grants and credentials. */
  coordinatorPanelUrl(): string | null {
    const value=this.config.coordinator?.panelUrl;
    if(!value)return null;
    try {const url=new URL(value);return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
  }
  settingsSnapshot() {
    let endpoint: string | null = null
    if (this.config.coordinator) {
      try {
        const url = new URL(this.config.coordinator.endpoint)
        endpoint = `${url.protocol}//${url.host}${url.pathname}`
      } catch { /* A paused draft may be incomplete; never return raw endpoint data. */ }
    }
    return {
      role: this.config.role, nodeId: this.config.nodeId,
      paused: this.config.paused === true,
      endpoint, pollIntervalMs: this.config.pollIntervalMs,
      concurrency: this.config.concurrency,
      polling: this.config.paused !== true && this.active && !!this.nativeWorker && this.config.pollIntervalMs > 0,
      authMode: this.config.authMode ?? 'ed25519',
      executorIdentity: this.client?.cachedExecutorIdentity() ?? null,
      taskSessionsEnabled: this.config.taskSessionsEnabled === true,
    }
  }
  heartbeatSnapshot() {
    return {
      state: this.config.paused === true ? 'disabled' as const : !this.heartbeatTimer ? 'disabled' as const : this.lastHeartbeatFailed ? 'failed' as const : this.lastHeartbeatAcknowledgedAt ? 'acknowledged' as const : 'waiting' as const,
      intervalMs: this.config.paused === true ? 0 : this.config.coordinator?.heartbeatIntervalMs ?? 0,
      acknowledgedAt: this.lastHeartbeatAcknowledgedAt,
    }
  }
  beginConfigurationEdit(): () => void {
    insist(!this.configurationPaused && !this.heartbeatPending && !(this.store?.dispatches() ?? []).some(record => !['acknowledged','cancelled','retry_scheduled'].includes(record.state)),'CONFIGURATION_BUSY',409)
    const releases: (() => void)[] = []
    try {
      if (this.client) releases.push(this.client.beginConfigurationEdit())
      if (this.gateway) releases.push(this.gateway.beginConfigurationEdit())
      for (const worker of this.workers) releases.push(worker.beginConfigurationEdit())
      this.configurationPaused = true
      let released = false
      const release = () => { if (released) return; released = true; this.configurationPaused = false; for (const release of releases.reverse()) release() }
      this.configurationRelease = release
      return () => { if (this.configurationRelease === release) this.configurationRelease = undefined; release() }
    } catch (error) { for (const release of releases.reverse()) release(); throw error }
  }
  queueSnapshot() {
    const dispatches = (this.store?.dispatches() ?? []).filter(record => !['acknowledged','cancelled','retry_scheduled'].includes(record.state))
    const byRun = new Map(dispatches.map(record => [record.claim.run.runId,{ taskId: record.claim.task.taskId,runId: record.claim.run.runId,title: record.claim.task.title,state: String(record.state),sessionId: record.sessionId,workspaceId: record.claim.run.route?.workspaceId ?? null,projectTitle: record.claim.run.projectContext?.project?.title ?? null,executionDirectory: record.workspacePath ?? null }]))
    for (const worker of this.workers) for (const run of worker.queueSnapshot()) if (!byRun.has(run.runId)) byRun.set(run.runId,{ taskId: run.taskId,runId: run.runId,title: run.intentSnapshot?.title ?? run.taskId,state: run.state,sessionId: '',workspaceId: run.route?.workspaceId ?? null,projectTitle: run.projectContext?.project?.title ?? null,executionDirectory: null })
    return { sampledAt: new Date().toISOString(),nodeId: this.config.nodeId,items: [...byRun.values()].slice(0,100),truncated: byRun.size > 100 }
  }
  async executorIdentity() { insist(this.config.paused !== true,'REMOTE_PAUSED',409); insist(this.client,'COORDINATOR_REQUIRED',503); return await this.client.executorIdentity() }
  /** Operator-only identity probe. It never starts workers, heartbeats or claims. */
  async checkConnection(endpoint: string, target: TrustedNetworkTarget | null) {
    const coordinator = this.config.coordinator
    insist(coordinator,'COORDINATOR_REQUIRED',503)
    if (this.config.paused !== true) {
      insist(endpoint === coordinator.endpoint && (target === null ? !coordinator.trustedNetwork : !!coordinator.trustedNetwork && ['address','port','localAddress','allowHttp'].every(key => target[key as keyof TrustedNetworkTarget] === coordinator.trustedNetwork![key as keyof TrustedNetworkTarget])),'CHECK_PAUSE_REQUIRED',409)
      insist(this.client,'COORDINATOR_REQUIRED',503)
      return await this.client.executorIdentity({ diagnostic: true })
    }
    const release = this.beginConfigurationEdit()
    let store: RecoveryStore | undefined, client: RemoteClient | undefined
    try {
      let privateKey
      if ((coordinator.authMode ?? 'ed25519') !== 'trusted-network') {
        insist(!target && coordinator.privateKeyEnv && /^[A-Za-z_][A-Za-z0-9_]*$/.test(coordinator.privateKeyEnv),'INVALID_KEY_ENV_REFERENCE')
        const existing = process.env[coordinator.privateKeyEnv]
        insist(existing,'EXISTING_SIGNING_KEY_REQUIRED')
        privateKey = createPrivateKey(existing)
      }
      // Use the existing durable sequence owner; an ephemeral store would reset replay protection.
      store = new RecoveryStore(resolve(this.config.statePath))
      client = new RemoteClient({ endpoint,audience: coordinator.audience,nodeId: this.config.nodeId,authMode: coordinator.authMode,keyId: coordinator.keyId,privateKey,trustedNetwork: target ?? undefined,store,allowLoopbackHttp: this.config.allowLoopbackHttp,timeoutMs: 5000,maxBodyBytes: this.config.maxBodyBytes,maxResponseBytes: coordinator.maxResponseBytes })
      return await client.executorIdentity({ diagnostic: true })
    } finally { await client?.dispose(); store?.close(); release() }
  }
  configureCoordinator(taskSystem: TaskSystemPort): void {
    insist(this.config.paused !== true,'REMOTE_PAUSED',409)
    const coordinator = this.config.coordinator
    if (!coordinator) { insist(!this.config.observationForwarding,'OBSERVATION_COORDINATOR_REQUIRED'); return }
    insist((coordinator.authMode ?? 'ed25519') === (this.config.authMode ?? 'ed25519'),'AUTH_MODE_MISMATCH')
    let privateKey
    if (coordinator.authMode === 'trusted-network') {
      insist(coordinator.trustedNetwork && !coordinator.keyId && !coordinator.privateKeyEnv,'AUTH_CONFIG_CONFLICT')
    } else {
      insist(coordinator.privateKeyEnv && /^[A-Za-z_][A-Za-z0-9_]*$/.test(coordinator.privateKeyEnv),'INVALID_KEY_ENV_REFERENCE')
      insist(!coordinator.trustedNetwork,'AUTH_CONFIG_CONFLICT')
      const existing = process.env[coordinator.privateKeyEnv]
      insist(existing,'EXISTING_SIGNING_KEY_REQUIRED')
      try { privateKey = createPrivateKey(existing) } catch { throw new Error('Existing signing key could not be loaded') }
      insist(privateKey.type === 'private' && privateKey.asymmetricKeyType === 'ed25519','ED25519_PRIVATE_KEY_REQUIRED')
    }
    insist(coordinator.nativeRoutes.length <= 32 && coordinator.nativeRoutes.every(route => route.provider.length > 0 && route.models.length > 0 && route.models.length <= 64),'INVALID_NATIVE_ROUTES')
    insist(this.config.role !== 'planner' || this.config.pollIntervalMs === 0,'PLANNER_CANNOT_POLL_EXECUTION',403)
    const heartbeatIntervalMs = coordinator.heartbeatIntervalMs ?? 0
    insist(Number.isSafeInteger(heartbeatIntervalMs) && (heartbeatIntervalMs === 0 || (heartbeatIntervalMs >= 1000 && heartbeatIntervalMs <= 3600000)),'INVALID_HEARTBEAT_INTERVAL')
    insist(this.config.role !== 'planner' || heartbeatIntervalMs === 0,'EXECUTOR_HEARTBEAT_REQUIRED',403)
    if (this.config.observationForwarding) {
      insist(!taskSystem.config?.autoAdmitObservations,'OBSERVATION_REQUIRES_SINGLE_AUTHORITY',403)
      insist(taskSystem.subscribeObservations,'NATIVE_OBSERVER_REQUIRED',503)
      insist(this.config.workspaces.some(binding => binding.workspaceId === this.config.observationForwarding!.workspaceId && binding.nodeId === this.config.nodeId),'OBSERVATION_WORKSPACE_BINDING_REQUIRED')
    }
    this.client = new RemoteClient({ endpoint: coordinator.endpoint,authMode: coordinator.authMode,trustedNetwork: coordinator.trustedNetwork ?? undefined,audience: coordinator.audience,keyId: coordinator.keyId,nodeId: this.config.nodeId,privateKey,store: this.store!,allowLoopbackHttp: this.config.allowLoopbackHttp,maxBodyBytes: this.config.maxBodyBytes,maxResponseBytes: coordinator.maxResponseBytes })
    const remote = this.coordinatorLedger = new RemoteLedgerClient(this.client,this.config.nodeId)
    this.workerLedger = remote
    if (this.config.role !== 'planner' && coordinator.nativeRoutes.length > 0) {
      const currentNative = (): NativeExecutionPort | undefined => (this.ctx.get('taskSystem') as TaskSystemPort | undefined)?.native
      const routes = coordinator.nativeRoutes.map(route => ({ provider: route.provider,models: route.models.map(model => ({ model: model.model,reasoningEfforts: [...model.reasoningEfforts] })) }))
      const provider: ExecutionProvider = {
        sendSessionMessage: async (...args) => { const native = currentNative(); insist(native?.sendSessionMessage, 'SESSION_MESSAGES_UNSUPPORTED', 503); return native.sendSessionMessage(...args); },
        id: 'native-dsh',capabilities: [...this.config.capabilities],
        status: ref => currentNative()?.executionStatus?.(ref) ?? '执行端正在准备原生会话。',
        supports: route => !!currentNative() && routes.some(allowed => allowed.provider === route.provider && allowed.models.some(model => model.model === route.model && (route.reasoningEffort === undefined || model.reasoningEfforts.includes(route.reasoningEffort)))),
        execute: async request => {
          const native = currentNative()
          insist(native && request.claim.run.route && provider.supports(request.claim.run.route),'NATIVE_PROVIDER_UNAVAILABLE',503)
          return await native.executeExternal(request)
        },
      }
      this.nativeWorker = this.createWorker(provider)
    } else insist(this.config.pollIntervalMs === 0,'NATIVE_ROUTES_REQUIRED_FOR_POLLING')
    if (this.config.observationForwarding) {
      const binding = this.config.workspaces.find(workspace => workspace.workspaceId === this.config.observationForwarding!.workspaceId && workspace.nodeId === this.config.nodeId)!
      this.observationDisposer = taskSystem.subscribeObservations!(observationForwarder(remote,binding))
    }
    if (heartbeatIntervalMs > 0) {
      const tick = (): void => {
        if (!this.active || this.heartbeatPending || this.configurationPaused) return
        this.heartbeatPending = this.heartbeatNow().then(() => { this.lastHeartbeatFailed = false },() => { this.lastHeartbeatFailed = true }).finally(() => { this.heartbeatPending = undefined })
      }
      this.heartbeatTimer = setInterval(tick,heartbeatIntervalMs)
      tick()
    }
  }
  /** Current local observations only; this never probes a model or changes grants. */
  async heartbeatNow(): Promise<unknown> {
    insist(this.config.paused !== true,'REMOTE_PAUSED',409)
    insist(this.active,'DRAINING',503)
    insist(this.config.role !== 'planner','EXECUTOR_HEARTBEAT_REQUIRED',403)
    insist(this.coordinatorLedger && this.config.coordinator,'COORDINATOR_REQUIRED',503)
    const native = (this.ctx.get('taskSystem') as TaskSystemPort | undefined)?.native
    const nativeActive = native?.activeCount ?? 0
    insist(Number.isSafeInteger(nativeActive) && nativeActive >= 0 && nativeActive <= 128,'INVALID_NATIVE_ACTIVE_COUNT')
    const activeExecutions = Math.max(nativeActive,[...this.workers].reduce((count,worker) => count + worker.activeExecutions,0))
    const providers = [...new Set(this.config.coordinator.nativeRoutes.map(route => route.provider))].map(provider => ({ provider,state: 'not-probed' }))
    this.lastHeartbeatSample = Math.max(Date.now(),this.lastHeartbeatSample + 1)
    const receipt = await this.coordinatorLedger.recordNodeHeartbeat(`heartbeat-${randomUUID()}`,{ nodeId: this.config.nodeId,sampledAt: this.lastHeartbeatSample,runtimeReady: typeof native?.executeExternal === 'function',activeExecutions,providerStatus: { state: 'not-probed',providers } })
    this.lastHeartbeatAcknowledgedAt = new Date().toISOString()
    return receipt
  }
  createWorker(provider: ExecutionProvider): ExecutorWorker {
    insist(this.config.paused !== true,'REMOTE_PAUSED',409)
    insist(this.active,'DRAINING',503)
    insist(!this.configurationPaused,'CONFIGURATION_BUSY',409)
    insist(this.workers.size === 0,'ONE_WORKER_OWNER_PER_STORE',409)
    const worker = new ExecutorWorker({ ledger: this.workerLedger,provider,store: this.store!,policy: { role: this.config.role,nodeId: this.config.nodeId,capabilities: this.config.capabilities,workspaces: this.config.workspaces },ttlMs: this.config.leaseTtlMs,maxResultBytes: Math.max(1024,this.config.maxBodyBytes - 4096),taskSessions: this.config.taskSessionsEnabled === true,
      ...(this.config.taskSessionsEnabled && this.client ? { prepare: async () => { await this.client!.executorIdentity() } } : {}),
      chooseSession: async (claim,context,signal,refresh) => {
        const task = this.ctx.get('taskSystem') as TaskSystemPort | undefined
        return await chooseExecutionSession({ claim,context,defaultWorkspaceId: task?.config?.defaultWorkspaceId,workspaces: this.config.workspaces.map(workspace => ({ workspaceId: workspace.workspaceId,nodeId: workspace.nodeId,description: workspace.workspaceId,eligible: true })),...(task?.config?.sessionDecisionEnabled && this.ctx.get('decisionModels') ? { decisions: this.ctx.get('decisionModels'), decisionProvider: task?.config?.decisionBindings?.['task-session'] } : {}),signal,ttlMs: task?.config?.decisionTtlMs,refresh })
      },
    })
    this.workers.add(worker)
    worker.startPolling(() => this.config.pollIntervalMs,() => this.config.concurrency)
    return worker
  }
  attachCarrier(startup: Promise<{ close(): Promise<void> }>): Promise<void> {
    insist(this.config.paused !== true,'REMOTE_PAUSED',409)
    insist(!this.carrierStartup,'CARRIER_ALREADY_ATTACHED')
    this.carrierStartup = startup.then(async carrier => {
      this.carrierClose = () => carrier.close()
      if (!this.active) await carrier.close()
    })
    return this.carrierStartup
  }
  dispose(): Promise<void> {
    return this.disposal ??= this.disposeOwned()
  }
  private async disposeOwned(): Promise<void> {
    this.active = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.observationDisposer?.()
    if (this.carrierStartup) await Promise.allSettled([this.carrierStartup])
    await this.carrierClose?.()
    await this.gateway?.dispose()
    await Promise.allSettled([...this.workers].map(worker => worker.dispose()))
    await this.heartbeatPending
    // ConfigEditor can unload this instance while holding the admission guard.
    // Workers have drained; release the client guard only for the final offline sample.
    this.configurationRelease?.()
    this.configurationRelease = undefined
    if (this.coordinatorLedger && this.config.role !== 'planner') {
      this.lastHeartbeatSample = Math.max(Date.now(),this.lastHeartbeatSample + 1)
      try {
        await this.coordinatorLedger.recordNodeHeartbeat(`offline-${randomUUID()}`,{ nodeId: this.config.nodeId,sampledAt: this.lastHeartbeatSample,runtimeReady: false,activeExecutions: 0 },{ signal: AbortSignal.timeout(5000) })
      } catch { /* Unreachable coordinators expire the previous heartbeat. */ }
    }
    await this.client?.dispose()
    this.store?.close()
  }
}
declare module '@deepseek-ai/cordis' { interface Context { remoteExecution: RemoteExecutionService } }
export async function apply(ctx: Context, config: Config): Promise<void> {
  // A live configuration fiber is not an active remote connection. This branch
  // must precede state stores, key loading, network clients, carriers and timers.
  if (config.paused === true) {
    const taskSystem = ctx.get('taskSystem') as TaskSystemPort | undefined
    insist(taskSystem?.ledger,'LEDGER_REQUIRED',503)
    const service = new RemoteExecutionService(ctx,config,taskSystem.ledger)
    ctx.effect(() => () => service.dispose(), 'paused remote configuration service')
    return
  }
  insist(config.authMode === undefined || config.authMode === 'ed25519' || config.authMode === 'trusted-network','AUTH_MODE_MISMATCH')
  if (config.authMode === 'trusted-network') {
    insist(!config.allowLoopbackHttp && config.peers.length === 0,'AUTH_CONFIG_CONFLICT')
    insist(config.role === 'executor' || config.trustedNetwork,'TRUSTED_NETWORK_POLICY_REQUIRED')
  } else insist(!config.trustedNetwork,'AUTH_CONFIG_CONFLICT')
  insist(!config.exposeHttp || config.role !== 'executor','EXECUTOR_CANNOT_EXPOSE_COORDINATOR',403)
  insist(!config.exposeHttp || (config.authMode === 'trusted-network' ? config.trustedNetwork?.peers.length : config.peers.length),'PEERS_REQUIRED')
  insist(/^\/[A-Za-z0-9/_-]+$/.test(config.routePath),'INVALID_ROUTE')
  const taskSystem = ctx.get('taskSystem') as TaskSystemPort | undefined
  insist(taskSystem?.ledger,'LEDGER_REQUIRED',503)
  const store = new RecoveryStore(resolve(config.statePath))
  store.recover()
  let service: RemoteExecutionService
  try { service = new RemoteExecutionService(ctx,config,taskSystem.ledger,store) } catch (error) { store.close(); throw error }
  ctx.effect(() => () => service.dispose(), 'remote execution drain and close')
  try { service.configureCoordinator(taskSystem) } catch (error) { await service.dispose(); throw error }
  if (config.exposeHttp && config.authMode === 'trusted-network') {
    try {
      await service.attachCarrier(startTrustedNetworkCarrier(service.gateway!,{ ...config.trustedNetwork!,routePath: config.routePath,maxBodyBytes: config.maxBodyBytes,maxResponseBytes: config.maxResponseBytes }))
    } catch (error) { await service.dispose(); throw error }
  } else if (config.exposeHttp) {
    insist(config.peers.length > 0,'PEERS_REQUIRED')
    ctx.inject(['webServer'], host => {
      const webServer = host.get('webServer') as HostWebServer | undefined
      insist(webServer && service.gateway,'HTTP_CARRIER_REQUIRED',503)
      host.effect(() => webServer.register({ kind: 'exact',path: config.routePath,handler: httpHandler(service.gateway!,{ allowLoopbackHttp: config.allowLoopbackHttp,maxBodyBytes: config.maxBodyBytes,maxResponseBytes: config.maxResponseBytes }) }), 'remote execution host route')
    })
  }
}
export * from './api.js'
