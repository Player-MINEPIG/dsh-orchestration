import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolve } from 'node:path'
import { createPrivateKey, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_RESPONSE_BYTES, MAX_WIRE_BYTES, IdentityVerifier, insist } from './protocol.js'
import type { Operation, Peer, Role } from './protocol.js'
import type { ExecutionProvider, LedgerPort, ObservationCandidate, WorkspaceBinding } from './ports.js'
import { RecoveryStore } from './store.js'
import { ExecutorWorker } from './worker.js'
import { RemoteGateway } from './gateway.js'
import { httpHandler } from './http.js'
import { RemoteClient, RemoteLedgerClient } from './client.js'
import { observationForwarder } from './observation.js'
import type { NativeExecutionPort } from './native-adapter.js'

export const name = 'dsh-task-remote-execution'
export const inject = ['taskSystem']
export interface Config {
  role: Role; nodeId: string; statePath: string; exposeHttp: boolean; routePath: string;
  audience: string; peers: { keyId: string; nodeId: string; publicKey: string; audience: string; operations: Operation[]; workspaces: string[]; capabilities: string[] }[];
  capabilities: string[]; workspaces: WorkspaceBinding[]; allowLoopbackHttp: boolean; leaseTtlMs: number; maxBodyBytes: number; maxResponseBytes: number;
  pollIntervalMs: number; concurrency: number;
  coordinator?: { endpoint: string; audience: string; keyId: string; privateKeyEnv: string; maxResponseBytes?: number; heartbeatIntervalMs?: number; nativeRoutes: { provider: string; models: { model: string; reasoningEfforts: string[] }[] }[] } | null;
  /** Forward only observations inside the configured local workspace binding. */
  observationForwarding?: { workspaceId: string } | null;
}
export const Config: z<Config> = z.object({
  role: z.union([z.const('planner'),z.const('executor'),z.const('both')]).default('executor'),
  nodeId: z.string().default('unconfigured'), statePath: z.string().default('.dsh-task/remote-execution.sqlite'),
  exposeHttp: z.boolean().default(false), routePath: z.string().default('/dsh-task/v1/commands'), audience: z.string().default('task-coordinator'),
  peers: z.array(z.object({ keyId: z.string().required(),nodeId: z.string().required(),publicKey: z.string().required(),audience: z.string().required(),
    operations: z.array(z.union([z.const('claim'),z.const('renew'),z.const('submit'),z.const('cancel'),z.const('receipt'),z.const('bindSession'),z.const('markRunning'),z.const('getRun'),z.const('getAttempt'),z.const('acknowledgeCancellation'),z.const('listWork'),z.const('observe'),z.const('delegate'),z.const('taskHistory'),z.const('taskWait'),z.const('taskNote'),z.const('taskReport'),z.const('heartbeat'),z.const('nodeStatus'),z.const('retryBeforeEffects'),z.const('offerApproval'),z.const('approvalStatus'),z.const('cancelApproval')])).required(),workspaces: z.array(z.string()).required(),capabilities: z.array(z.string()).required(),
  })).default([]),
  capabilities: z.array(z.string()).default([]), workspaces: z.array(z.object({ workspaceId: z.string().required(),nodeId: z.string().required(),path: z.string().required(),allowedRoot: z.string().required() })).default([]),
  allowLoopbackHttp: z.boolean().default(false), leaseTtlMs: z.number().step(1).min(1000).max(300000).default(60000), maxBodyBytes: z.number().step(1).min(1024).max(MAX_WIRE_BYTES).default(DEFAULT_MAX_BODY_BYTES), maxResponseBytes: z.number().step(1).min(1024).max(MAX_WIRE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),
  pollIntervalMs: z.union([z.const(0),z.number().step(1).min(100).max(3600000)]).default(0), concurrency: z.number().step(1).min(1).max(16).default(1),
  coordinator: z.union([z.const(null),z.object({ endpoint: z.string().required(),audience: z.string().required(),keyId: z.string().required(),privateKeyEnv: z.string().required(),maxResponseBytes: z.number().step(1).min(1024).max(MAX_WIRE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),heartbeatIntervalMs: z.union([z.const(0),z.number().step(1).min(1000).max(3600000)]).default(0),nativeRoutes: z.array(z.object({ provider: z.string().required(),models: z.array(z.object({ model: z.string().required(),reasoningEfforts: z.array(z.string()).default([]) })).required() })).default([]) })]).default(null),
  observationForwarding: z.union([z.const(null),z.object({ workspaceId: z.string().required() })]).default(null).description('Forward only captured observations whose immutable session cwd resolves within this configured workspace path and allowed root.'),
})
interface HostWebServer { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage,res: ServerResponse) => Promise<void> }): () => void }
/** An independently replaceable taskSystem service supplies only this structural ledger seam. */
export interface TaskSystemPort {
  ledger: LedgerPort; native?: NativeExecutionPort; config?: { autoAdmitObservations?: boolean };
  subscribeObservations?(sink: (candidate: ObservationCandidate, options: { signal: AbortSignal }) => Promise<unknown> | unknown): () => void;
}
export class RemoteExecutionService extends Service {
  readonly gateway?: RemoteGateway
  private workers = new Set<ExecutorWorker>()
  private active = true
  private config: Config
  private ledger: LedgerPort
  private store: RecoveryStore
  private workerLedger: LedgerPort
  private client?: RemoteClient
  private observationDisposer?: () => void
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private heartbeatPending?: Promise<unknown>
  lastHeartbeatFailed = false
  private lastHeartbeatSample = 0
  coordinatorLedger?: RemoteLedgerClient
  nativeWorker?: ExecutorWorker
  constructor(ctx: Context, config: Config, ledger: LedgerPort, store: RecoveryStore) {
    super(ctx,'remoteExecution'); this.config = config; this.ledger = ledger; this.workerLedger = ledger; this.store = store
    if (config.role !== 'executor') this.gateway = new RemoteGateway({ role: config.role,nodeId: config.nodeId,verifier: new IdentityVerifier({ audience: config.audience,peers: config.peers }),ledger,store,maxBodyBytes: config.maxBodyBytes,maxResponseBytes: config.maxResponseBytes })
  }
  configureCoordinator(taskSystem: TaskSystemPort): void {
    const coordinator = this.config.coordinator
    if (!coordinator) { insist(!this.config.observationForwarding,'OBSERVATION_COORDINATOR_REQUIRED'); return }
    insist(/^[A-Za-z_][A-Za-z0-9_]*$/.test(coordinator.privateKeyEnv),'INVALID_KEY_ENV_REFERENCE')
    const existing = process.env[coordinator.privateKeyEnv]
    insist(existing,'EXISTING_SIGNING_KEY_REQUIRED')
    let privateKey
    try { privateKey = createPrivateKey(existing) } catch { throw new Error('Existing signing key could not be loaded') }
    insist(privateKey.type === 'private' && privateKey.asymmetricKeyType === 'ed25519','ED25519_PRIVATE_KEY_REQUIRED')
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
    this.client = new RemoteClient({ endpoint: coordinator.endpoint,audience: coordinator.audience,keyId: coordinator.keyId,nodeId: this.config.nodeId,privateKey,store: this.store,allowLoopbackHttp: this.config.allowLoopbackHttp,maxBodyBytes: this.config.maxBodyBytes,maxResponseBytes: coordinator.maxResponseBytes })
    const remote = this.coordinatorLedger = new RemoteLedgerClient(this.client,this.config.nodeId)
    this.workerLedger = remote
    if (this.config.role !== 'planner' && coordinator.nativeRoutes.length > 0) {
      const currentNative = (): NativeExecutionPort | undefined => (this.ctx.get('taskSystem') as TaskSystemPort | undefined)?.native
      const routes = coordinator.nativeRoutes.map(route => ({ provider: route.provider,models: route.models.map(model => ({ model: model.model,reasoningEfforts: [...model.reasoningEfforts] })) }))
      const provider: ExecutionProvider = {
        id: 'native-dsh',capabilities: [...this.config.capabilities],
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
        if (!this.active || this.heartbeatPending) return
        this.heartbeatPending = this.heartbeatNow().then(() => { this.lastHeartbeatFailed = false },() => { this.lastHeartbeatFailed = true }).finally(() => { this.heartbeatPending = undefined })
      }
      this.heartbeatTimer = setInterval(tick,heartbeatIntervalMs)
      tick()
    }
  }
  /** Current local observations only; this never probes a model or changes grants. */
  async heartbeatNow(): Promise<unknown> {
    insist(this.active,'DRAINING',503)
    insist(this.config.role !== 'planner','EXECUTOR_HEARTBEAT_REQUIRED',403)
    insist(this.coordinatorLedger && this.config.coordinator,'COORDINATOR_REQUIRED',503)
    const native = (this.ctx.get('taskSystem') as TaskSystemPort | undefined)?.native
    const nativeActive = native?.activeCount ?? 0
    insist(Number.isSafeInteger(nativeActive) && nativeActive >= 0 && nativeActive <= 128,'INVALID_NATIVE_ACTIVE_COUNT')
    const activeExecutions = Math.max(nativeActive,[...this.workers].reduce((count,worker) => count + worker.activeExecutions,0))
    const providers = [...new Set(this.config.coordinator.nativeRoutes.map(route => route.provider))].map(provider => ({ provider,state: 'not-probed' }))
    this.lastHeartbeatSample = Math.max(Date.now(),this.lastHeartbeatSample + 1)
    return await this.coordinatorLedger.recordNodeHeartbeat(`heartbeat-${randomUUID()}`,{ nodeId: this.config.nodeId,sampledAt: this.lastHeartbeatSample,runtimeReady: typeof native?.executeExternal === 'function',activeExecutions,providerStatus: { state: 'not-probed',providers } })
  }
  createWorker(provider: ExecutionProvider): ExecutorWorker {
    insist(this.active,'DRAINING',503)
    insist(this.workers.size === 0,'ONE_WORKER_OWNER_PER_STORE',409)
    const worker = new ExecutorWorker({ ledger: this.workerLedger,provider,store: this.store,policy: { role: this.config.role,nodeId: this.config.nodeId,capabilities: this.config.capabilities,workspaces: this.config.workspaces },ttlMs: this.config.leaseTtlMs,maxResultBytes: Math.max(1024,this.config.maxBodyBytes - 4096) })
    this.workers.add(worker)
    if (this.config.pollIntervalMs > 0) worker.startPolling(this.config.pollIntervalMs,this.config.concurrency)
    return worker
  }
  async dispose(): Promise<void> {
    this.active = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.observationDisposer?.()
    const clientDrain = this.client?.dispose()
    await this.gateway?.dispose()
    await Promise.allSettled([...this.workers].map(worker => worker.dispose()))
    await clientDrain
    await this.heartbeatPending
    this.store.close()
  }
}
declare module '@deepseek-ai/cordis' { interface Context { remoteExecution: RemoteExecutionService } }
export function apply(ctx: Context, config: Config): void {
  insist(!config.exposeHttp || config.role !== 'executor','EXECUTOR_CANNOT_EXPOSE_COORDINATOR',403)
  insist(!config.exposeHttp || config.peers.length > 0,'PEERS_REQUIRED')
  insist(/^\/[A-Za-z0-9/_-]+$/.test(config.routePath),'INVALID_ROUTE')
  const taskSystem = ctx.get('taskSystem') as TaskSystemPort | undefined
  insist(taskSystem?.ledger,'LEDGER_REQUIRED',503)
  const store = new RecoveryStore(resolve(config.statePath))
  store.recover()
  let service: RemoteExecutionService
  try { service = new RemoteExecutionService(ctx,config,taskSystem.ledger,store) } catch (error) { store.close(); throw error }
  ctx.effect(() => () => service.dispose(), 'remote execution drain and close')
  service.configureCoordinator(taskSystem)
  if (config.exposeHttp) {
    insist(config.peers.length > 0,'PEERS_REQUIRED')
    ctx.inject(['webServer'], host => {
      const webServer = host.get('webServer') as HostWebServer | undefined
      insist(webServer && service.gateway,'HTTP_CARRIER_REQUIRED',503)
      host.effect(() => webServer.register({ kind: 'exact',path: config.routePath,handler: httpHandler(service.gateway!,{ allowLoopbackHttp: config.allowLoopbackHttp,maxBodyBytes: config.maxBodyBytes,maxResponseBytes: config.maxResponseBytes }) }), 'remote execution host route')
    })
  }
}
export * from './api.js'
