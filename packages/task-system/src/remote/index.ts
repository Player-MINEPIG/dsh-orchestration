import {
  workspaceGrantCatalog,
  selectedWorkspaceGrant,
  executorWorkspaceSnapshot,
  SetLocalWorkspaceGrant,
  type LocalWorkspaceRegistry,
  type WorkspaceGrantCatalog,
} from "./workspace-grants.js";
export type {
  WorkspaceGrantCatalog,
  SetLocalWorkspaceGrant,
} from "./workspace-grants.js";
import type { ExecutorPanelRecord } from "../executor-panel.js";
import { independentRemoteControls } from "./controls.js";
import { ExecutionModelInventory } from "../executor-models.js";
import type { OfficialBackend } from "../official-execution.js";
import { ExecutorModelControl } from "./model-control.js";
import type { ProgramRegistry } from "../workflow-programs.js";
import { chooseExecutionSession } from "../execution-session.js";
import { Context, Service } from "@deepseek-ai/cordis";
import { isVolatile } from "@deepseek-ai/cosmokit";
import z from "@deepseek-ai/schemastery";
import { resolve } from "node:path";
import { createPrivateKey, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_WIRE_BYTES,
  IdentityVerifier,
  ProtocolError,
  insist,
} from "./protocol.js";
import type { AuthMode, Operation, Role } from "./protocol.js";
import { TrustedNetworkVerifier } from "./trusted-network.js";
import type {
  TrustedNetworkPeer,
  TrustedNetworkPolicy,
  TrustedNetworkTarget,
} from "./trusted-network.js";
import type {
  ExecutionProvider,
  LedgerPort,
  ObservationCandidate,
  WorkspaceBinding,
} from "./ports.js";
import { RecoveryStore } from "./store.js";
import { ExecutorWorker } from "./worker.js";
import { RemoteGateway } from "./gateway.js";
import { httpHandler, startTrustedNetworkCarrier } from "./http.js";
import { RemoteClient, RemoteLedgerClient } from "./client.js";
import { observationForwarder } from "./observation.js";
import type { NativeExecutionPort } from "./native-adapter.js";

export const name = "dsh-task-remote-execution";
export const inject = ["taskSystem"];
type NetworkPolicyConfig = Omit<
  TrustedNetworkPolicy,
  "allowedAddresses" | "peers"
> & {
  allowedAddresses: string[];
  peers: (Omit<
    TrustedNetworkPeer,
    "operations" | "workspaces" | "capabilities"
  > & {
    operations: Operation[];
    workspaces: string[];
    capabilities: string[];
  })[];
};
export interface Config {
  /** Pause executor connections, polling and heartbeat; listener control is independent. */
  paused?: boolean;
  pauseScope?: "executor";
  role: Role;
  nodeId: string;
  statePath: string;
  exposeHttp: boolean;
  routePath: string;
  authMode?: AuthMode;
  trustedNetwork?: NetworkPolicyConfig | null;
  audience: string;
  peers: {
    keyId: string;
    nodeId: string;
    publicKey: string;
    audience: string;
    operations: Operation[];
    workspaces: string[];
    capabilities: string[];
  }[];
  capabilities: string[];
  workspaces: WorkspaceBinding[];
  allowLoopbackHttp: boolean;
  leaseTtlMs: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  pollIntervalMs: number;
  concurrency: number;
  executionLimits?: { pollIntervalMs?: number; concurrency?: number };
  /** Compatibility for old connections; new setup writes true after explicit grants. */
  taskSessionsEnabled?: boolean;
  coordinator?: {
    panelUrl?: string;
    endpoint: string;
    audience: string;
    authMode?: AuthMode;
    keyId?: string;
    privateKeyEnv?: string;
    trustedNetwork?: TrustedNetworkTarget | null;
    maxResponseBytes?: number;
    heartbeatIntervalMs?: number;
    nativeRoutes: {
      provider: string;
      models: { model: string; reasoningEfforts: string[] }[];
    }[];
  } | null;
  /** Forward only observations inside the configured local workspace binding. */
  observationForwarding?: { workspaceId: string } | null;
}
const authModeSchema = z.union([
  z.const("ed25519"),
  z.const("trusted-network"),
]);
const operationSchema = z.union([
  z.const("claim"),
  z.const("renew"),
  z.const("submit"),
  z.const("cancel"),
  z.const("receipt"),
  z.const("bindSession"),
  z.const("markRunning"),
  z.const("getRun"),
  z.const("getAttempt"),
  z.const("acknowledgeCancellation"),
  z.const("listWork"),
  z.const("observe"),
  z.const("delegate"),
  z.const("taskHistory"),
  z.const("taskWait"),
  z.const("taskNote"),
  z.const("taskReport"),
  z.const("heartbeat"),
  z.const("nodeStatus"),
  z.const("retryBeforeEffects"),
  z.const("offerApproval"),
  z.const("approvalStatus"),
  z.const("cancelApproval"),
  z.const("executorIdentity"),
  z.const("sessionContext"),
  z.const("selectTaskSession"),
  z.const("sessionMessages"),
  z.const("sessionMessageReply"),
  z.const("projectSnapshot"),
  z.const("projectCollaborate"),
  z.const("executionModelView"),
  z.const("reportAdmission"),
  z.const("executionModelRequests"),
  z.const("completeExecutionModels"),
]);
const addressSchema = z.string().required();
const portSchema = z.number().step(1).min(1).max(65535).required();
const networkPolicySchema = z.object({
  listen: z.object({ address: addressSchema, port: portSchema }).required(),
  allowHttp: z.const(true).required(),
  allowedAddresses: z.array(z.string()).required(),
  peers: z
    .array(
      z.object({
        address: addressSchema,
        nodeId: z.string().default(""),
        nickname: z.string(),
        role: z
          .union([z.const("planner"), z.const("executor"), z.const("both")])
          .required(),
        audience: z.string().required(),
        operations: z.array(operationSchema).required(),
        workspaces: z.array(z.string()).required(),
        capabilities: z.array(z.string()).required(),
      }),
    )
    .required(),
});
const networkTargetSchema = z.object({
  address: addressSchema,
  port: portSchema,
  localAddress: addressSchema,
  allowHttp: z.const(true).required(),
});
const PlainConfig: z<Config> = z.object({
  paused: z
    .boolean()
    .default(false)
    .description(
      "Pause executor connections, task polling and heartbeat. The scheduler listener is controlled independently.",
    ),
  pauseScope: z.const("executor").required(false),
  role: z
    .union([z.const("planner"), z.const("executor"), z.const("both")])
    .default("executor"),
  authMode: authModeSchema.default("ed25519"),
  trustedNetwork: z.union([z.const(null), networkPolicySchema]).default(null),
  nodeId: z.string().default("unconfigured"),
  statePath: z.string().default(".dsh-task/remote-execution.sqlite"),
  exposeHttp: z.boolean().default(false),
  routePath: z.string().default("/dsh-task/v1/commands"),
  audience: z.string().default("task-coordinator"),
  peers: z
    .array(
      z.object({
        keyId: z.string().required(),
        nodeId: z.string().required(),
        publicKey: z.string().required(),
        audience: z.string().required(),
        operations: z.array(operationSchema).required(),
        workspaces: z.array(z.string()).required(),
        capabilities: z.array(z.string()).required(),
      }),
    )
    .default([]),
  capabilities: z.array(z.string()).default([]),
  workspaces: z
    .array(
      z.object({
        workspaceId: z.string().required(),
        nodeId: z.string().required(),
        path: z.string().required(),
        allowedRoot: z.string().required(),
      }),
    )
    .default([]),
  allowLoopbackHttp: z.boolean().default(false),
  leaseTtlMs: z.number().step(1).min(1000).max(300000).default(60000),
  maxBodyBytes: z
    .number()
    .step(1)
    .min(1024)
    .max(MAX_WIRE_BYTES)
    .default(DEFAULT_MAX_BODY_BYTES),
  maxResponseBytes: z
    .number()
    .step(1)
    .min(1024)
    .max(MAX_WIRE_BYTES)
    .default(DEFAULT_MAX_RESPONSE_BYTES),
  pollIntervalMs: z
    .union([z.const(0), z.number().step(1).min(100).max(3600000)])
    .default(0),
  concurrency: z.number().step(1).min(1).max(16).default(1),
  executionLimits: z
    .object({
      pollIntervalMs: z
        .union([z.const(0), z.number().step(1).min(100).max(3600000)])
        .required(false),
      concurrency: z.number().step(1).min(1).max(16).required(false),
    })
    .default({}),
  taskSessionsEnabled: z.boolean().required(false),
  coordinator: z
    .union([
      z.const(null),
      z.object({
        panelUrl: z.string(),
        endpoint: z.string().required(),
        audience: z.string().required(),
        authMode: authModeSchema.default("ed25519"),
        keyId: z.string(),
        privateKeyEnv: z.string(),
        trustedNetwork: z
          .union([z.const(null), networkTargetSchema])
          .default(null),
        maxResponseBytes: z
          .number()
          .step(1)
          .min(1024)
          .max(MAX_WIRE_BYTES)
          .default(DEFAULT_MAX_RESPONSE_BYTES),
        heartbeatIntervalMs: z
          .union([z.const(0), z.number().step(1).min(1000).max(3600000)])
          .default(0),
        nativeRoutes: z
          .array(
            z.object({
              provider: z.string().required(),
              models: z
                .array(
                  z.object({
                    model: z.string().required(),
                    reasoningEfforts: z.array(z.string()).default([]),
                  }),
                )
                .required(),
            }),
          )
          .default([]),
      }),
    ])
    .default(null),
  observationForwarding: z
    .union([z.const(null), z.object({ workspaceId: z.string().required() })])
    .default(null)
    .description(
      "Forward only captured observations whose immutable session cwd resolves within this configured workspace path and allowed root.",
    ),
});
export const Config = z.object({
  ...PlainConfig.dict,
  executionLimits: PlainConfig.dict!.executionLimits!.volatile(),
});
interface HostWebServer {
  register(route: {
    kind: "exact";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }): () => void;
}
/** An independently replaceable taskSystem service supplies only this structural ledger seam. */
export interface TaskSystemPort {
  programs?: ProgramRegistry;
  executionDirectories?: { validatedRoot(): string | null };
  ledger: LedgerPort;
  native?: NativeExecutionPort;
  config?: {
    localNode?: {
      models: { provider: string; model: string; reasoningEfforts: string[] }[];
    } | null;
    role?: "planner" | "executor" | "both";
    officialBackends?: OfficialBackend[];
    decisionBindings?: Record<string, string>;
    autoAdmitObservations?: boolean;
    defaultWorkspaceId?: string | null;
    sessionDecisionEnabled?: boolean;
    decisionTtlMs?: number;
  };
  subscribeObservations?(
    sink: (
      candidate: ObservationCandidate,
      options: { signal: AbortSignal },
    ) => Promise<unknown> | unknown,
  ): () => void;
}
export class RemoteExecutionService extends Service {
  readonly gateway?: RemoteGateway;
  private workers = new Set<ExecutorWorker>();
  private active = true;
  private configurationPaused = false;
  private configurationRelease?: () => void;
  private config: Config;
  private ledger: LedgerPort;
  private store?: RecoveryStore;
  private workerLedger: LedgerPort;
  private client?: RemoteClient;
  private observationDisposer?: () => void;
  private carrierClose?: () => Promise<void>;
  private carrierStartup?: Promise<void>;
  private disposal?: Promise<void>;
  private modelControl?: ExecutorModelControl;
  private readonly modelInventory: ExecutionModelInventory;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatPending?: Promise<unknown>;
  lastHeartbeatFailed = false;
  private lastHeartbeatSample = 0;
  private lastHeartbeatAcknowledgedAt: string | null = null;
  coordinatorLedger?: RemoteLedgerClient;
  nativeWorker?: ExecutorWorker;
  constructor(
    ctx: Context,
    config: Config,
    ledger: LedgerPort,
    store?: RecoveryStore,
  ) {
    super(ctx, "remoteExecution");
    const currentTask = () =>
      this.ctx.get("taskSystem") as TaskSystemPort | undefined;
    this.modelInventory = new ExecutionModelInventory({
      llm: () => this.ctx.get("llm"),
      nativeReady: () => !!currentTask()?.native,
      officialBackends: () => currentTask()?.config?.officialBackends ?? [],
      officialAvailable: (backend) =>
        !!this.ctx.get("subagents")?.getProvider(backend),
      temporaryWorkspaceReady: () => {
        try {
          return !!currentTask()?.executionDirectories?.validatedRoot();
        } catch {
          return false;
        }
      },
    });
    config = {
      ...config,
      ...independentRemoteControls(config),
      paused: config.paused,
    };
    const limits = config.executionLimits as unknown;
    const raw = { ...config };
    for (const key of ["pollIntervalMs", "concurrency"] as const)
      Object.defineProperty(raw, key, {
        enumerable: true,
        get: () =>
          (isVolatile(limits)
            ? (limits.get() as Config["executionLimits"])
            : (limits as Config["executionLimits"]))?.[key] ?? config[key],
      });
    this.config = raw;
    this.ledger = ledger;
    this.workerLedger = ledger;
    this.store =
      config.paused === true && !config.exposeHttp ? undefined : store;
    if (config.paused === true && !config.exposeHttp) return;
    insist(store, "RECOVERY_STORE_REQUIRED", 503);
    if (config.exposeHttp && config.role !== "executor")
      this.gateway = new RemoteGateway({
        role: config.role,
        nodeId: config.nodeId,
        verifier:
          config.authMode === "trusted-network"
            ? new TrustedNetworkVerifier({
                ...config.trustedNetwork!,
                audience: config.audience,
                pairings: store,
              })
            : new IdentityVerifier({
                audience: config.audience,
                peers: config.peers,
              }),
        ledger,
        store,
        maxBodyBytes: config.maxBodyBytes,
        maxResponseBytes: config.maxResponseBytes,
      });
  }
  private workspaceGrantStore() {
    return this.store ??= new RecoveryStore(resolve(this.config.statePath));
  }
  async workspaceGrantCatalog(): Promise<WorkspaceGrantCatalog> {
    insist(this.config.role !== "planner", "EXECUTOR_ROLE_REQUIRED", 403);
    return workspaceGrantCatalog({
      nodeId: this.config.nodeId,
      store: this.workspaceGrantStore(),
      registry: this.ctx.get("workspaceRegistry") as unknown as
        | LocalWorkspaceRegistry
        | undefined,
      configured: this.config.workspaces,
      includeRegistered: this.registryWorkspacesEnabled(),
    });
  }
  async setLocalWorkspaceGrant(input: unknown) {
    const selection = SetLocalWorkspaceGrant.parse(input);
    insist(this.config.role !== "planner", "EXECUTOR_ROLE_REQUIRED", 403);
    insist(
      !this.ctx.get("taskSystem")?.native?.activeCount,
      "CONFIGURATION_BUSY",
      409,
    );
    const release = await this.beginConfigurationEdit();
    try {
      insist(
        !this.ctx.get("taskSystem")?.native?.activeCount,
        "CONFIGURATION_BUSY",
        409,
      );
      const store = this.workspaceGrantStore();
      const grant = selectedWorkspaceGrant({
        nodeId: this.config.nodeId,
        store,
        registry: this.ctx.get("workspaceRegistry") as unknown as
          | LocalWorkspaceRegistry
          | undefined,
        selection,
      });
      insist(
        !this.config.workspaces.some(
          (binding) =>
            binding.nodeId === this.config.nodeId &&
            binding.path === grant.path,
        ),
        "WORKSPACE_GRANT_CONFIGURED",
        409,
      );
      insist(
        this.config.workspaces.length +
          store
            .workspaceGrantState()
            .grants.filter((saved) => saved.workspaceId !== grant.workspaceId)
            .length <
          64,
        "WORKSPACE_CATALOG_LIMIT",
        409,
      );
      store.setWorkspaceGrant(grant, selection.expectedRevision);
    } finally {
      release();
    }
    let publication: "acknowledged" | "pending" | "not-connected" =
      "not-connected";
    if (this.coordinatorLedger && !this.config.paused) {
      try {
        await this.heartbeatNow();
        publication = "acknowledged";
      } catch {
        publication = "pending";
      }
    }
    return { ...(await this.workspaceGrantCatalog()), publication };
  }
  private registryWorkspacesEnabled() {
    return this.config.coordinator?.authMode === "trusted-network" && !!this.config.coordinator.trustedNetwork;
  }
  private workspaceBindings(): WorkspaceBinding[] {
    return workspaceGrantCatalog({nodeId:this.config.nodeId,store:this.store,configured:this.config.workspaces,
      registry:this.ctx.get("workspaceRegistry") as unknown as LocalWorkspaceRegistry | undefined,
      includeRegistered:this.registryWorkspacesEnabled()}).items
      .filter(item=>item.enabled && item.state==="ready")
      .map(item=>this.config.workspaces.find(binding=>binding.workspaceId===item.workspaceId && binding.path===item.path)
        ?? {workspaceId:item.workspaceId,nodeId:item.nodeId,path:item.path,allowedRoot:item.path});
  }
  /** Read-only settings projection, deliberately excludes keys, grants and credentials. */
  coordinatorPanelUrl(): string | null {
    const value = this.config.coordinator?.panelUrl;
    if (!value) return null;
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
        ? url.href
        : null;
    } catch {
      return null;
    }
  }
  settingsSnapshot() {
    let endpoint: string | null = null;
    if (this.config.coordinator) {
      try {
        const url = new URL(this.config.coordinator.endpoint);
        endpoint = `${url.protocol}//${url.host}${url.pathname}`;
      } catch {
        /* A paused draft may be incomplete; never return raw endpoint data. */
      }
    }
    return {
      role: this.config.role,
      nodeId: this.config.nodeId,
      paused: this.config.paused === true,
      coordinatorConfigured: Boolean(this.config.coordinator),
      endpoint,
      pollIntervalMs: this.config.pollIntervalMs,
      concurrency: this.config.concurrency,
      polling:
        this.config.paused !== true &&
        this.active &&
        !!this.nativeWorker &&
        this.config.pollIntervalMs > 0,
      authMode: this.config.authMode ?? "ed25519",
      executorIdentity: this.client?.cachedExecutorIdentity() ?? null,
      taskSessionsEnabled: this.config.taskSessionsEnabled === true,
    };
  }
  heartbeatSnapshot() {
    return {
      state:
        this.config.paused === true
          ? ("disabled" as const)
          : !this.heartbeatTimer
            ? ("disabled" as const)
            : this.lastHeartbeatFailed
              ? ("failed" as const)
              : this.lastHeartbeatAcknowledgedAt
                ? ("acknowledged" as const)
                : ("waiting" as const),
      intervalMs:
        this.config.paused === true
          ? 0
          : (this.config.coordinator?.heartbeatIntervalMs ?? 0),
      acknowledgedAt: this.lastHeartbeatAcknowledgedAt,
    };
  }
  async beginConfigurationEdit(): Promise<() => void> {
    insist(
      this.active &&
        !this.configurationPaused &&
        !(this.store?.dispatches() ?? []).some(
          (record) =>
            !["acknowledged", "cancelled", "retry_scheduled"].includes(
              record.state,
            ),
        ),
      "CONFIGURATION_BUSY",
      409,
    );
    this.configurationPaused = true;
    const releases: (() => void)[] = [];
    try {
      if (this.modelControl)
        releases.push(await this.modelControl.beginConfigurationEdit());
      for (const worker of this.workers)
        releases.push(await worker.beginConfigurationEdit());
      await this.heartbeatPending?.catch(() => {});
      insist(
        this.active &&
          !(this.store?.dispatches() ?? []).some(
            (record) =>
              !["acknowledged", "cancelled", "retry_scheduled"].includes(
                record.state,
              ),
          ),
        "CONFIGURATION_BUSY",
        409,
      );
      if (this.client) releases.push(this.client.beginConfigurationEdit());
      if (this.gateway) releases.push(this.gateway.beginConfigurationEdit());
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        for (const release of releases.reverse()) release();
        this.configurationPaused = false;
      };
      this.configurationRelease = release;
      return () => {
        if (this.configurationRelease === release)
          this.configurationRelease = undefined;
        release();
      };
    } catch (error) {
      for (const release of releases.reverse()) release();
      this.configurationPaused = false;
      throw error;
    }
  }
  queueSnapshot() {
    const dispatches = (this.store?.dispatches() ?? []).filter(
      (record) =>
        !["acknowledged", "cancelled", "retry_scheduled"].includes(
          record.state,
        ),
    );
    const byRun = new Map(
      dispatches.map((record) => [
        record.claim.run.runId,
        {
          taskId: record.claim.task.taskId,
          runId: record.claim.run.runId,
          title: record.claim.task.title,
          state: String(record.state),
          sessionId: record.sessionId,
          workspaceId: record.claim.run.route?.workspaceId ?? null,
          projectTitle: record.claim.run.projectContext?.project?.title ?? null,
          executionDirectory: record.workspacePath ?? null,
        },
      ]),
    );
    for (const worker of this.workers)
      for (const run of worker.queueSnapshot())
        if (!byRun.has(run.runId))
          byRun.set(run.runId, {
            taskId: run.taskId,
            runId: run.runId,
            title: run.intentSnapshot?.title ?? run.taskId,
            state: run.state,
            sessionId: "",
            workspaceId: run.route?.workspaceId ?? null,
            projectTitle: run.projectContext?.project?.title ?? null,
            executionDirectory: null,
          });
    return {
      sampledAt: new Date().toISOString(),
      nodeId: this.config.nodeId,
      items: [...byRun.values()].slice(0, 100),
      truncated: byRun.size > 100,
    };
  }
  /** Local recovery and last observed work only; this method performs no RPC. */
  executorPanel() {
    const settings = this.settingsSnapshot();
    const claims = this.store?.panelClaims() ?? [];
    const claimByRun = new Map(claims.map(row => [row.runId, row.state]));
    const dispatches = this.store?.panelDispatches() ?? [];
    const records: ExecutorPanelRecord[] = [];
    for (const worker of this.workers) for (const run of worker.queueSnapshot()) {
      records.push({taskId:run.taskId,runId:run.runId,title:run.intentSnapshot?.title ?? run.taskId,
        description:run.intentSnapshot?.description ?? "",state:claimByRun.has(run.runId) ? claimByRun.get(run.runId)==="uncertain" ? "claim_uncertain" : "claim_pending" : run.state,
        source:"local-queue",nodeId:this.config.nodeId,time:worker.queueObservedAt ?? run.updatedAt ?? "",sessionIds:[],
        parentTaskId:dispatches.find(row=>row.claim.task.taskId===run.taskId)?.claim.task.parentTaskId,parentRunId:run.parentRunId,projectId:run.projectContext?.project?.projectId,projectTitle:run.projectContext?.project?.title,
        model:run.route?.model,workspaceId:run.route?.workspaceId});
    }
    // Reverse so the newest attempt for each Run wins in the public projection.
    for (const row of dispatches.slice(0,200).reverse()) records.push({
      taskId:row.claim.task.taskId,runId:row.claim.run.runId,title:row.claim.task.title,description:row.claim.task.description,
      state:row.state,source:"local-recovery",nodeId:this.config.nodeId,time:row.receipt?.acceptedAt ?? row.claim.run.updatedAt ?? "",
      sessionIds:row.sessionId ? [row.sessionId] : [],parentTaskId:row.claim.task.parentTaskId,parentRunId:row.claim.run.parentRunId,
      projectId:row.claim.run.projectContext?.project?.projectId,projectTitle:row.claim.run.projectContext?.project?.title,
      model:row.claim.run.route?.model,workspaceId:row.claim.run.route?.workspaceId,executionDirectory:row.workspacePath,
      report:row.result?.report?.body ?? row.result?.summary,detail:row.detail,outcome:row.result?.outcome,attemptId:row.attemptId,
    });
    const observed = [...this.workers].map(worker=>worker.queueObservedAt).filter((at): at is string=>!!at).sort().at(-1) ?? null;
    return {records,unresolvedClaims:claims.filter(claim=>!records.some(row=>row.runId===claim.runId)).slice(0,200),truncated:dispatches.length>200 || claims.length>200 || [...this.workers].some(worker=>worker.queueSnapshot().length>=128),
      queueObservedAt:observed,pollState:settings.paused ? "paused" : [...this.workers].some(worker=>worker.lastPollFailed) ? "failed" : observed ? "ready" : "never",
      connection:settings,heartbeat:this.heartbeatSnapshot()};
  }
  async executorIdentity() {
    insist(this.config.paused !== true, "REMOTE_PAUSED", 409);
    insist(this.client, "COORDINATOR_REQUIRED", 503);
    return await this.client.executorIdentity();
  }
  /** Operator-only identity probe. It never starts workers, heartbeats or claims. */
  async checkConnection(endpoint: string, target: TrustedNetworkTarget | null) {
    const coordinator = this.config.coordinator;
    insist(coordinator, "COORDINATOR_REQUIRED", 503);
    if (this.config.paused !== true) {
      insist(
        endpoint === coordinator.endpoint &&
          (target === null
            ? !coordinator.trustedNetwork
            : !!coordinator.trustedNetwork &&
              ["address", "port", "localAddress", "allowHttp"].every(
                (key) =>
                  target[key as keyof TrustedNetworkTarget] ===
                  coordinator.trustedNetwork![
                    key as keyof TrustedNetworkTarget
                  ],
              )),
        "CHECK_PAUSE_REQUIRED",
        409,
      );
      insist(this.client, "COORDINATOR_REQUIRED", 503);
      return await this.client.executorIdentity({ diagnostic: true });
    }
    const release = await this.beginConfigurationEdit();
    let store: RecoveryStore | undefined, client: RemoteClient | undefined;
    try {
      let privateKey;
      if ((coordinator.authMode ?? "ed25519") !== "trusted-network") {
        insist(
          !target &&
            coordinator.privateKeyEnv &&
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(coordinator.privateKeyEnv),
          "INVALID_KEY_ENV_REFERENCE",
        );
        const existing = process.env[coordinator.privateKeyEnv];
        insist(existing, "EXISTING_SIGNING_KEY_REQUIRED");
        privateKey = createPrivateKey(existing);
      }
      // Use the existing durable sequence owner; an ephemeral store would reset replay protection.
      store = new RecoveryStore(resolve(this.config.statePath));
      client = new RemoteClient({
        endpoint,
        audience: coordinator.audience,
        nodeId: this.config.nodeId,
        authMode: coordinator.authMode,
        keyId: coordinator.keyId,
        privateKey,
        trustedNetwork: target ?? undefined,
        store,
        allowLoopbackHttp: this.config.allowLoopbackHttp,
        timeoutMs: 5000,
        maxBodyBytes: this.config.maxBodyBytes,
        maxResponseBytes: coordinator.maxResponseBytes,
      });
      return await client.executorIdentity({ diagnostic: true });
    } finally {
      await client?.dispose();
      store?.close();
      release();
    }
  }
  async configureCoordinator(taskSystem: TaskSystemPort): Promise<void> {
    insist(this.config.paused !== true, "REMOTE_PAUSED", 409);
    const coordinator = this.config.coordinator;
    if (!coordinator) {
      insist(
        !this.config.observationForwarding,
        "OBSERVATION_COORDINATOR_REQUIRED",
      );
      return;
    }
    insist(
      (coordinator.authMode ?? "ed25519") ===
        (this.config.authMode ?? "ed25519"),
      "AUTH_MODE_MISMATCH",
    );
    let privateKey;
    if (coordinator.authMode === "trusted-network") {
      insist(
        coordinator.trustedNetwork &&
          !coordinator.keyId &&
          !coordinator.privateKeyEnv,
        "AUTH_CONFIG_CONFLICT",
      );
    } else {
      insist(
        coordinator.privateKeyEnv &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(coordinator.privateKeyEnv),
        "INVALID_KEY_ENV_REFERENCE",
      );
      insist(!coordinator.trustedNetwork, "AUTH_CONFIG_CONFLICT");
      const existing = process.env[coordinator.privateKeyEnv];
      insist(existing, "EXISTING_SIGNING_KEY_REQUIRED");
      try {
        privateKey = createPrivateKey(existing);
      } catch {
        throw new Error("Existing signing key could not be loaded");
      }
      insist(
        privateKey.type === "private" &&
          privateKey.asymmetricKeyType === "ed25519",
        "ED25519_PRIVATE_KEY_REQUIRED",
      );
    }
    insist(
      coordinator.nativeRoutes.length <= 32 &&
        coordinator.nativeRoutes.every(
          (route) =>
            route.provider.length > 0 &&
            route.models.length > 0 &&
            route.models.length <= 64,
        ),
      "INVALID_NATIVE_ROUTES",
    );
    insist(
      this.config.role !== "planner" || this.config.pollIntervalMs === 0,
      "PLANNER_CANNOT_POLL_EXECUTION",
      403,
    );
    const heartbeatIntervalMs = coordinator.heartbeatIntervalMs ?? 0;
    insist(
      Number.isSafeInteger(heartbeatIntervalMs) &&
        (heartbeatIntervalMs === 0 ||
          (heartbeatIntervalMs >= 1000 && heartbeatIntervalMs <= 3600000)),
      "INVALID_HEARTBEAT_INTERVAL",
    );
    insist(
      this.config.role !== "planner" || heartbeatIntervalMs === 0,
      "EXECUTOR_HEARTBEAT_REQUIRED",
      403,
    );
    if (this.config.observationForwarding) {
      insist(
        !taskSystem.config?.autoAdmitObservations,
        "OBSERVATION_REQUIRES_SINGLE_AUTHORITY",
        403,
      );
      insist(taskSystem.subscribeObservations, "NATIVE_OBSERVER_REQUIRED", 503);
      insist(
        this.config.workspaces.some(
          (binding) =>
            binding.workspaceId ===
              this.config.observationForwarding!.workspaceId &&
            binding.nodeId === this.config.nodeId,
        ),
        "OBSERVATION_WORKSPACE_BINDING_REQUIRED",
      );
    }
    this.client = new RemoteClient({
      endpoint: coordinator.endpoint,
      authMode: coordinator.authMode,
      trustedNetwork: coordinator.trustedNetwork ?? undefined,
      audience: coordinator.audience,
      keyId: coordinator.keyId,
      nodeId: this.config.nodeId,
      privateKey,
      store: this.store!,
      allowLoopbackHttp: this.config.allowLoopbackHttp,
      maxBodyBytes: this.config.maxBodyBytes,
      maxResponseBytes: coordinator.maxResponseBytes,
    });
    const remote = (this.coordinatorLedger = new RemoteLedgerClient(
      this.client,
      this.config.nodeId,
    ));
    this.workerLedger = remote;
    if (this.config.role !== "planner") {
      const currentTaskSystem = () =>
        this.ctx.get("taskSystem") as TaskSystemPort | undefined;
      const currentNative = (): NativeExecutionPort | undefined =>
        currentTaskSystem()?.native;

      const provider: ExecutionProvider = {
        sendTaskReturn: async (message,signal) => {
          const native=currentNative();
          insist(native?.sendTaskReturn,"TASK_RETURNS_UNSUPPORTED",503);
          return native.sendTaskReturn(message,signal);
        },
        sendSessionMessage: async (...args) => {
          const native = currentNative();
          insist(
            native?.sendSessionMessage,
            "SESSION_MESSAGES_UNSUPPORTED",
            503,
          );
          return native.sendSessionMessage(...args);
        },
        id: "native-dsh",
        capabilities: [...this.config.capabilities],
        status: (ref) =>
          currentNative()?.executionStatus?.(ref) ?? "执行端正在准备原生会话。",
        supports: (route) => {
          if (!currentNative()) return false;
          if (route.backend)
            return (
              this.modelInventory
                .lastSuccess()
                ?.models.some(
                  (choice) =>
                    choice.backend === route.backend &&
                    choice.provider === route.provider &&
                    choice.model === route.model &&
                    choice.reasoningEffort === route.reasoningEffort,
                ) === true &&
              !!this.ctx.get("subagents")?.getProvider(route.backend) &&
              (currentTaskSystem()?.config?.officialBackends ?? []).some(
                (backend) =>
                  backend.backend === route.backend &&
                  backend.provider === route.provider &&
                  backend.model === route.model &&
                  backend.reasoningEffort === route.reasoningEffort,
              )
            );
          const snapshot = this.modelInventory.lastSuccess();
          return snapshot
            ? snapshot.models.some(
                (allowed) =>
                  !allowed.backend &&
                  allowed.provider === route.provider &&
                  allowed.model === route.model &&
                  allowed.reasoningEffort === route.reasoningEffort,
              )
            : false;
        },
        execute: async (request) => {
          const native = currentNative();
          insist(
            native &&
              request.claim.run.route &&
              provider.supports(request.claim.run.route),
            "NATIVE_PROVIDER_UNAVAILABLE",
            503,
          );
          return await native.executeExternal(request);
        },
      };
      this.nativeWorker = this.createWorker(provider);
      this.modelControl = new ExecutorModelControl({
        store: this.store!,
        nodeId: this.config.nodeId,
        client: this.client,
        remote,
        ownsClient: false,
        inventory: this.modelInventory,
      });
      this.modelControl.start();
    } else
      insist(
        this.config.pollIntervalMs === 0,
        "NATIVE_ROUTES_REQUIRED_FOR_POLLING",
      );
    if (this.config.observationForwarding) {
      const binding = this.config.workspaces.find(
        (workspace) =>
          workspace.workspaceId ===
            this.config.observationForwarding!.workspaceId &&
          workspace.nodeId === this.config.nodeId,
      )!;
      this.observationDisposer = taskSystem.subscribeObservations!(
        observationForwarder(remote, binding),
      );
    }
    if (heartbeatIntervalMs > 0) {
      const tick = (): void => {
        if (!this.active || this.heartbeatPending || this.configurationPaused)
          return;
        void this.heartbeatNow().catch(() => {});
      };
      this.heartbeatTimer = setInterval(tick, heartbeatIntervalMs);
      tick();
    }
  }
  /** Current local observations only; this never probes a model or changes grants. */
  heartbeatNow(): Promise<unknown> {
    // Every caller shares the same bounded in-flight request; configuration admission wins before another tick can enter.
    if (this.config.paused === true)
      return Promise.reject(new ProtocolError("REMOTE_PAUSED", 409));
    if (!this.active) return Promise.reject(new ProtocolError("DRAINING", 503));
    if (this.configurationPaused)
      return Promise.reject(new ProtocolError("CONFIGURATION_BUSY", 409));
    if (this.heartbeatPending) return this.heartbeatPending;
    const pending = this.sendHeartbeat()
      .then(
        (value) => {
          this.lastHeartbeatFailed = false;
          return value;
        },
        (error) => {
          this.lastHeartbeatFailed = true;
          throw error;
        },
      )
      .finally(() => {
        if (this.heartbeatPending === pending)
          this.heartbeatPending = undefined;
      });
    this.heartbeatPending = pending;
    return pending;
  }
  private async sendHeartbeat(): Promise<unknown> {
    insist(this.config.paused !== true, "REMOTE_PAUSED", 409);
    insist(this.active, "DRAINING", 503);
    insist(this.config.role !== "planner", "EXECUTOR_HEARTBEAT_REQUIRED", 403);
    insist(
      this.coordinatorLedger && this.config.coordinator,
      "COORDINATOR_REQUIRED",
      503,
    );
    const taskSystem = this.ctx.get("taskSystem") as TaskSystemPort | undefined;
    const native = taskSystem?.native;
    const nativeActive = native?.activeCount ?? 0;
    insist(
      Number.isSafeInteger(nativeActive) &&
        nativeActive >= 0 &&
        nativeActive <= 128,
      "INVALID_NATIVE_ACTIVE_COUNT",
    );
    const activeExecutions = Math.max(
      nativeActive,
      [...this.workers].reduce(
        (count, worker) => count + worker.activeExecutions,
        0,
      ),
    );
    const providerStatus = {
      state: "not-probed",
      providers: [],
      programs: taskSystem?.programs?.catalog() ?? [],
    };
    this.lastHeartbeatSample = Math.max(
      Date.now(),
      this.lastHeartbeatSample + 1,
    );
    const receipt = await this.coordinatorLedger.recordNodeHeartbeat(
      `heartbeat-${randomUUID()}`,
      {
        nodeId: this.config.nodeId,
        sampledAt: this.lastHeartbeatSample,
        runtimeReady:
          typeof native?.executeExternal === "function" ||
          !!taskSystem?.programs?.catalog().length,
        activeExecutions,
        providerStatus,
        workspaces: executorWorkspaceSnapshot(
          this.config.nodeId,
          this.store,
          this.config.workspaces,
          this.ctx.get("workspaceRegistry") as unknown as
            | LocalWorkspaceRegistry
            | undefined,
          this.registryWorkspacesEnabled(),
        ),
      },
    );
    this.lastHeartbeatAcknowledgedAt = new Date().toISOString();
    return receipt;
  }
  createWorker(provider: ExecutionProvider): ExecutorWorker {
    insist(this.config.paused !== true, "REMOTE_PAUSED", 409);
    insist(this.active, "DRAINING", 503);
    insist(!this.configurationPaused, "CONFIGURATION_BUSY", 409);
    insist(this.workers.size === 0, "ONE_WORKER_OWNER_PER_STORE", 409);
    const programs = (this.ctx.get("taskSystem") as TaskSystemPort | undefined)
      ?.programs;
    if (programs) provider = programs.provider(provider);
    const service = this;
    const worker = new ExecutorWorker({
      modelAdmission: (route) =>
        route.backend
          ? "BACKEND_UNAVAILABLE"
          : this.modelInventory.lastSuccess()?.complete
            ? "MODEL_UNAVAILABLE"
            : undefined,
      prepareForWork: async (runs) => {
        if (
          !runs.some(
            (run) =>
              run.route?.nodeId === this.config.nodeId && !run.route.execution,
          )
        )
          return true;
        const prior = this.modelInventory.lastSuccess();
        if (prior && Date.now() - prior.observedAt < 60000) return true;
        const result = await this.modelInventory.collect();
        return result.state === "success";
      },
      projectRoot: () => {
        try {
          return this.ctx
            .get("taskSystem")
            ?.executionDirectories?.validatedRoot();
        } catch {
          return null;
        }
      },
      ledger: this.workerLedger,
      provider,
      store: this.store!,
      policy: {
        role: this.config.role,
        nodeId: this.config.nodeId,
        capabilities: this.config.capabilities,
        get workspaces() {
          return service.workspaceBindings();
        },
      },
      ttlMs: this.config.leaseTtlMs,
      maxResultBytes: Math.max(1024, this.config.maxBodyBytes - 4096),
      taskSessions: this.config.taskSessionsEnabled === true,
      ...(this.config.taskSessionsEnabled && this.client
        ? {
            prepare: async () => {
              await this.client!.executorIdentity();
            },
          }
        : {}),
      chooseSession: async (claim, context, signal, refresh) => {
        const task = this.ctx.get("taskSystem") as TaskSystemPort | undefined;
        return await chooseExecutionSession({
          claim,
          context,
          defaultWorkspaceId: task?.config?.defaultWorkspaceId,
          managedWorkspaceAvailable: !!this.ctx
            .get("taskSystem")
            ?.executionDirectories?.settings().root,
          workspaces: this.workspaceBindings().map((workspace) => ({
            workspaceId: workspace.workspaceId,
            nodeId: workspace.nodeId,
            description: workspace.workspaceId,
            eligible: true,
          })),
          ...(task?.config?.sessionDecisionEnabled &&
          this.ctx.get("decisionModels")
            ? {
                decisions: this.ctx.get("decisionModels"),
                decisionProvider:
                  task?.config?.decisionBindings?.["task-session"],
              }
            : {}),
          signal,
          ttlMs: task?.config?.decisionTtlMs,
          refresh,
        });
      },
    });
    this.workers.add(worker);
    worker.startPolling(
      () => this.config.pollIntervalMs,
      () => this.config.concurrency,
    );
    return worker;
  }
  attachCarrier(startup: Promise<{ close(): Promise<void> }>): Promise<void> {
    insist(
      this.config.paused !== true || this.config.exposeHttp,
      "REMOTE_PAUSED",
      409,
    );
    insist(!this.carrierStartup, "CARRIER_ALREADY_ATTACHED");
    this.carrierStartup = startup.then(async (carrier) => {
      this.carrierClose = () => carrier.close();
      if (!this.active) await carrier.close();
    });
    return this.carrierStartup;
  }
  dispose(): Promise<void> {
    return (this.disposal ??= this.disposeOwned());
  }
  private async disposeOwned(): Promise<void> {
    this.active = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.modelControl?.dispose();
    this.observationDisposer?.();
    if (this.carrierStartup) await Promise.allSettled([this.carrierStartup]);
    await this.carrierClose?.();
    await this.gateway?.dispose();
    await Promise.allSettled(
      [...this.workers].map((worker) => worker.dispose()),
    );
    await this.heartbeatPending?.catch(() => {});
    // ConfigEditor can unload this instance while holding the admission guard.
    // Workers have drained; release the client guard only for the final offline sample.
    this.configurationRelease?.();
    this.configurationRelease = undefined;
    if (this.coordinatorLedger && this.config.role !== "planner") {
      this.lastHeartbeatSample = Math.max(
        Date.now(),
        this.lastHeartbeatSample + 1,
      );
      try {
        await this.coordinatorLedger.recordNodeHeartbeat(
          `offline-${randomUUID()}`,
          {
            nodeId: this.config.nodeId,
            sampledAt: this.lastHeartbeatSample,
            runtimeReady: false,
            activeExecutions: 0,
          },
          { signal: AbortSignal.timeout(5000) },
        );
      } catch {
        /* Unreachable coordinators expire the previous heartbeat. */
      }
    }
    await this.client?.dispose();
    this.store?.close();
  }
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    remoteExecution: RemoteExecutionService;
  }
}
export async function apply(ctx: Context, config: Config): Promise<void> {
  config = { ...config, ...independentRemoteControls(config) };
  const hostRole = (ctx.get("taskSystem") as TaskSystemPort | undefined)?.config
    ?.role;
  if (hostRole) config = { ...config, role: hostRole };
  if (config.trustedNetwork)
    config = {
      ...config,
      trustedNetwork: {
        ...config.trustedNetwork,
        peers: config.trustedNetwork.peers.map((peer) => ({
          ...peer,
          audience: config.audience,
        })),
      },
    };
  // Keep fully disabled configurations resource-free. Pausing the executor alone does not stop the scheduler listener.
  if (config.paused === true && !config.exposeHttp) {
    const taskSystem = ctx.get("taskSystem") as TaskSystemPort | undefined;
    insist(taskSystem?.ledger, "LEDGER_REQUIRED", 503);
    const service = new RemoteExecutionService(ctx, config, taskSystem.ledger);
    ctx.effect(
      () => () => service.dispose(),
      "paused remote configuration service",
    );
    return;
  }
  insist(
    config.authMode === undefined ||
      config.authMode === "ed25519" ||
      config.authMode === "trusted-network",
    "AUTH_MODE_MISMATCH",
  );
  if (config.authMode === "trusted-network") {
    insist(
      !config.allowLoopbackHttp && config.peers.length === 0,
      "AUTH_CONFIG_CONFLICT",
    );
    insist(
      !config.exposeHttp || config.trustedNetwork,
      "TRUSTED_NETWORK_POLICY_REQUIRED",
    );
  } else insist(!config.trustedNetwork, "AUTH_CONFIG_CONFLICT");
  insist(
    !config.exposeHttp || config.role !== "executor",
    "EXECUTOR_CANNOT_EXPOSE_COORDINATOR",
    403,
  );
  insist(
    !config.exposeHttp ||
      config.authMode === "trusted-network" ||
      config.peers.length,
    "PEERS_REQUIRED",
  );
  insist(/^\/[A-Za-z0-9/_-]+$/.test(config.routePath), "INVALID_ROUTE");
  const taskSystem = ctx.get("taskSystem") as TaskSystemPort | undefined;
  insist(taskSystem?.ledger, "LEDGER_REQUIRED", 503);
  const store = new RecoveryStore(resolve(config.statePath));
  store.recover();
  if (config.authMode === "trusted-network" && config.trustedNetwork) {
    store.retainNetworkPeers(
      config.trustedNetwork.peers.map((peer) => peer.address),
    );
    for (const peer of config.trustedNetwork.peers)
      if (peer.nodeId) store.bindNetworkPeer(peer.address, peer.nodeId);
  }
  let service: RemoteExecutionService;
  try {
    service = new RemoteExecutionService(ctx, config, taskSystem.ledger, store);
  } catch (error) {
    store.close();
    throw error;
  }
  ctx.effect(() => () => service.dispose(), "remote execution drain and close");
  try {
    if (config.paused !== true && config.role !== "planner")
      await service.configureCoordinator(taskSystem);
  } catch (error) {
    await service.dispose();
    throw error;
  }
  if (config.exposeHttp && config.authMode === "trusted-network") {
    try {
      await service.attachCarrier(
        startTrustedNetworkCarrier(service.gateway!, {
          ...config.trustedNetwork!,
          routePath: config.routePath,
          maxBodyBytes: config.maxBodyBytes,
          maxResponseBytes: config.maxResponseBytes,
        }),
      );
    } catch (error) {
      await service.dispose();
      throw error;
    }
  } else if (config.exposeHttp) {
    insist(config.peers.length > 0, "PEERS_REQUIRED");
    ctx.inject(["webServer"], (host) => {
      const webServer = host.get("webServer") as HostWebServer | undefined;
      insist(webServer && service.gateway, "HTTP_CARRIER_REQUIRED", 503);
      host.effect(
        () =>
          webServer.register({
            kind: "exact",
            path: config.routePath,
            handler: httpHandler(service.gateway!, {
              allowLoopbackHttp: config.allowLoopbackHttp,
              maxBodyBytes: config.maxBodyBytes,
              maxResponseBytes: config.maxResponseBytes,
            }),
          }),
        "remote execution host route",
      );
    });
  }
}
export * from "./api.js";
