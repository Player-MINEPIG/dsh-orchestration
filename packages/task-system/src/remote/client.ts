import {
  ExecutionCatalogRequest,
  ExecutionModelViewPage,
  type AdmissionReport,
  type ExecutionModelsView,
  type CompleteExecutionModels,
} from "../execution-models.js";
import { randomUUID } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { assertEndpoint } from "./http.js";
import {
  byteLimit,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  digest,
  insist,
  ProtocolError,
  isRecord,
  signEnvelope,
} from "./protocol.js";
import type { AuthMode, CommandEnvelope, Json, Operation } from "./protocol.js";
import {
  trustedNetworkFetch,
  validateNetworkTarget,
} from "./network-client.js";
import type { TrustedNetworkTarget } from "./trusted-network.js";
import type { CommandReceipt, RecoveryStore } from "./store.js";
import type {
  ExecutorIdentity,
  TaskSessionContext,
  TaskSessionChoice,
  SelectedTaskSession,
  ApprovalOffer,
  ApprovalRequest,
  Attempt,
  CapturedText,
  Claim,
  DelegationInput,
  HeartbeatInput,
  NodeStatus,
  LedgerPort,
  LeaseRef,
  ObservationCandidate,
  ObservationInput,
  Receipt,
  Run,
  SafeRetryWitness,
  Settlement,
  SettlementView,
  Task,
  TaskHistory,
  TaskReportInput,
} from "./ports.js";

export interface ClientOptions {
  endpoint: string;
  audience: string;
  nodeId: string;
  authMode?: AuthMode;
  keyId?: string;
  privateKey?: KeyObject;
  trustedNetwork?: TrustedNetworkTarget;
  store: RecoveryStore;
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  now?: () => number;
  fetch?: typeof fetch;
}
/** Existing key material is injected by the host. This package never generates or saves credentials. */
export class RemoteClient {
  private options: ClientOptions;
  private busy = false;
  private configurationPaused = false;
  private queued = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();
  private active = true;
  private endpoint: URL;
  private readonly transportFetch: typeof fetch;
  private readonly authBinding: string;
  constructor(options: ClientOptions) {
    this.options = {
      ...options,
      maxBodyBytes: byteLimit(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
      maxResponseBytes: byteLimit(
        options.maxResponseBytes,
        DEFAULT_MAX_RESPONSE_BYTES,
      ),
    };
    insist(
      options.authMode === undefined ||
        options.authMode === "ed25519" ||
        options.authMode === "trusted-network",
      "AUTH_MODE_MISMATCH",
    );
    if (options.authMode === "trusted-network") {
      insist(
        options.trustedNetwork &&
          !options.keyId &&
          !options.privateKey &&
          !options.fetch &&
          !options.allowLoopbackHttp,
        "AUTH_CONFIG_CONFLICT",
      );
      const checked = validateNetworkTarget(
        options.endpoint,
        options.trustedNetwork,
      );
      this.endpoint = checked.endpoint;
      this.transportFetch = trustedNetworkFetch(checked.target);
      this.authBinding = digest({
        authMode: "trusted-network",
        version: 2,
        ...checked.target,
      });
    } else {
      insist(
        options.keyId && options.privateKey && !options.trustedNetwork,
        "SIGNING_IDENTITY_REQUIRED",
      );
      this.endpoint = assertEndpoint(
        options.endpoint,
        options.allowLoopbackHttp,
      );
      this.transportFetch = options.fetch ?? fetch;
      this.authBinding = digest({
        authMode: "ed25519",
        version: 1,
        keyId: options.keyId,
      });
    }
  }
  beginConfigurationEdit(): () => void {
    insist(
      !this.configurationPaused && !this.busy && this.queued === 0,
      "CONFIGURATION_BUSY",
      409,
    );
    this.configurationPaused = true;
    return () => {
      this.configurationPaused = false;
    };
  }
  private schedulerBinding(): string {
    return digest({
      endpoint: this.endpoint.href,
      audience: this.options.audience,
      nodeId: this.options.nodeId,
      authBinding: this.authBinding,
    });
  }
  cachedExecutorIdentity(): ExecutorIdentity | undefined {
    return this.options.store.schedulerMapping(this.schedulerBinding());
  }
  async executorIdentity(options?: {
    diagnostic?: boolean;
    signal?: AbortSignal;
  }): Promise<ExecutorIdentity> {
    const receipt = await this.send(
      "executorIdentity",
      `identity-${randomUUID()}`,
      {},
      options,
    );
    const identity = receipt.result;
    insist(
      receipt.state === "done" && isRecord(identity),
      "EXECUTOR_IDENTITY_UNAVAILABLE",
      503,
    );
    insist(
      Object.keys(identity).length === 3 &&
        identity.nodeId === this.options.nodeId &&
        typeof identity.schedulerId === "string" &&
        /^scheduler-[0-9a-f-]{36}$/.test(identity.schedulerId) &&
        typeof identity.executorId === "string" &&
        /^executor-[0-9a-f-]{36}$/.test(identity.executorId),
      "INVALID_EXECUTOR_IDENTITY",
      403,
    );
    return this.options.store.rememberScheduler(
      this.schedulerBinding(),
      identity as unknown as ExecutorIdentity,
    );
  }
  send(
    operation: Operation,
    commandId: string,
    payload: Record<string, Json>,
    options?: { signal?: AbortSignal; diagnostic?: boolean },
  ): Promise<CommandReceipt> {
    insist(!this.configurationPaused, "CONFIGURATION_BUSY", 409);
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 35000),
      ...(options?.signal ? [options.signal] : []),
    ]);
    this.queued++;
    const request = this.tail
      .then(() =>
        this.sendOwned(
          operation,
          commandId,
          payload,
          signal,
          options?.diagnostic,
        ),
      )
      .finally(() => {
        this.queued--;
      });
    this.tail = request.catch(() => undefined);
    return request;
  }
  private async sendOwned(
    operation: Operation,
    commandId: string,
    payload: Record<string, Json>,
    signal?: AbortSignal,
    diagnostic = false,
  ): Promise<CommandReceipt> {
    insist(this.active && !signal?.aborted, "TRANSPORT_ABORTED", 503);
    insist(!this.busy, "CLIENT_SEND_IN_PROGRESS", 409);
    this.busy = true;
    try {
      // Shared stores allocate unique sequences, but independent connections can
      // arrive out of order. Retry only an explicit pre-admission rejection,
      // at most twice, retaining the business command and payload unchanged.
      for (let orderingRetry = 0; ; orderingRetry++) {
        const { store, nodeId, keyId, privateKey, audience } = this.options;
        const requestHash = digest({ operation, payload });
        const authMode = this.options.authMode ?? "ed25519";
        const destination = {
          sender: nodeId,
          audience,
          endpoint: this.endpoint.href,
          authMode,
          authBinding: this.authBinding,
        };
        const now = (this.options.now ?? Date.now)();
        const existing = store.outbound(commandId, now);
        if (existing) {
          insist(
            isRecord(existing) && existing.digest === requestHash,
            "COMMAND_CONFLICT",
            409,
          );
          insist(
            (existing.authMode ?? "ed25519") === authMode &&
              (existing.authBinding === undefined
                ? authMode === "ed25519"
                : existing.authBinding === this.authBinding),
            "SAVED_AUTH_MISMATCH",
            409,
          );
          if (existing.sender !== undefined)
            insist(
              existing.sender === nodeId &&
                existing.audience === audience &&
                existing.endpoint === this.endpoint.href,
              "SAVED_DESTINATION_MISMATCH",
              409,
            );
          if (existing.state === "done")
            return existing.receipt as unknown as CommandReceipt;
          // Retrying this exact command is safe at the gateway: stored pending/uncertain
          // work is never dispatched again. It may only return its existing receipt.
        }
        const common = {
          nodeId,
          audience,
          commandId,
          nonce: randomUUID(),
          sequence: store.nextSequence(nodeId),
          issuedAt: now,
          expiresAt: now + 60000,
          operation,
          payload,
        };
        const envelope: CommandEnvelope =
          authMode === "trusted-network"
            ? { version: 2, authMode: "trusted-network", ...common }
            : signEnvelope(
                { version: 1, keyId: keyId!, ...common },
                privateKey!,
              );
        const body = JSON.stringify(envelope);
        insist(
          Buffer.byteLength(body) <= this.options.maxBodyBytes!,
          "BODY_LIMIT",
          413,
        );
        store.saveOutbound(
          commandId,
          {
            ...destination,
            digest: requestHash,
            operation,
            payload,
            state: "sending",
          },
          now,
        );
        try {
          const response = await this.transportFetch(this.endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            redirect: "error",
            credentials: "omit",
            signal: AbortSignal.any([
              this.lifetime.signal,
              AbortSignal.timeout(this.options.timeoutMs ?? 35000),
              ...(signal ? [signal] : []),
            ]),
          });
          if (!response.ok) {
            let code = "REMOTE_REJECTED";
            if ((diagnostic || response.status === 409) && response.body) {
              const reader = response.body.getReader(),
                chunks: Uint8Array[] = [];
              let bytes = 0;
              try {
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  bytes += chunk.value.length;
                  if (bytes > 4096) break;
                  chunks.push(chunk.value);
                }
                if (bytes <= 4096) {
                  const data: unknown = JSON.parse(
                    Buffer.concat(chunks).toString("utf8"),
                  );
                  if (
                    isRecord(data) &&
                    typeof data.error === "string" &&
                    /^[A-Z][A-Z0-9_]{0,99}$/.test(data.error)
                  )
                    code = data.error;
                }
              } catch {
                /* Keep the bounded, non-secret fallback code. */
              } finally {
                await reader.cancel().catch(() => undefined);
              }
            } else await response.body?.cancel().catch(() => undefined);
            insist(false, code, response.status);
          }
          const length = response.headers.get("content-length");
          if (
            length !== null &&
            (!/^\d+$/.test(length) ||
              Number(length) > this.options.maxResponseBytes!)
          ) {
            await response.body?.cancel().catch(() => undefined);
            insist(false, "RESPONSE_LIMIT");
          }
          insist(response.body, "EMPTY_RESPONSE");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.length;
              insist(bytes <= this.options.maxResponseBytes!, "RESPONSE_LIMIT");
              chunks.push(chunk.value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
          const receipt = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as unknown;
          insist(
            isRecord(receipt) &&
              receipt.commandId === commandId &&
              ["done", "pending", "uncertain"].includes(String(receipt.state)),
            "INVALID_RECEIPT",
          );
          store.saveOutbound(
            commandId,
            {
              ...destination,
              digest: requestHash,
              operation,
              payload,
              state: receipt.state as Json,
              receipt: receipt as Json,
            },
            now,
          );
          return receipt as unknown as CommandReceipt;
        } catch (error) {
          store.saveOutbound(
            commandId,
            {
              ...destination,
              digest: requestHash,
              operation,
              payload,
              state: "uncertain",
            },
            now,
          );
          if (
            error instanceof ProtocolError &&
            error.status === 409 &&
            error.code === "OUT_OF_ORDER" &&
            orderingRetry < 2
          ) {
            await new Promise((resolve) =>
              setTimeout(resolve, 25 * (orderingRetry + 1)),
            );
            insist(this.active && !signal?.aborted, "TRANSPORT_ABORTED", 503);
            continue;
          }
          if (diagnostic) throw error;
          return { commandId, state: "uncertain" };
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async retryPendingObservations(
    limit = 32,
    options?: { signal?: AbortSignal },
  ): Promise<CommandReceipt[]> {
    const results: CommandReceipt[] = [];
    for (const row of this.options.store.pendingObservations(limit)) {
      insist(
        row.data.sender === this.options.nodeId &&
          row.data.audience === this.options.audience &&
          row.data.endpoint === this.endpoint.href,
        "SAVED_DESTINATION_MISMATCH",
        409,
      );
      insist(isRecord(row.data.payload), "INVALID_SAVED_OBSERVATION");
      results.push(
        await this.send(
          "observe",
          row.commandId,
          row.data.payload as Record<string, Json>,
          options,
        ),
      );
    }
    return results;
  }
  async dispose(): Promise<void> {
    this.active = false;
    this.lifetime.abort();
    await this.tail;
  }
}

/** Complete bounded protocol adapter; all caller node IDs must match this authenticated identity. */
export class RemoteLedgerClient implements LedgerPort {
  pendingSessionMessages(
    _nodeId: string,
  ): Promise<import("./ports.js").SessionMessage[]> {
    return this.command("sessionMessages", `messages-${randomUUID()}`, {});
  }
  completeSessionMessage(
    commandId: string,
    input: import("./ports.js").SessionMessageResult & {
      messageId: string;
      nodeId: string;
    },
  ): Promise<Receipt<import("./ports.js").SessionMessage>> {
    return this.command("sessionMessageReply", commandId, {
      messageId: input.messageId,
      state: input.state,
      reply: input.reply,
    });
  }
  private client: RemoteClient;
  private nodeId: string;
  constructor(client: RemoteClient, nodeId: string) {
    this.client = client;
    this.nodeId = nodeId;
  }
  private async command<T>(
    operation: Operation,
    commandId: string,
    payload: Record<string, Json>,
    options?: { signal?: AbortSignal; diagnostic?: boolean },
  ): Promise<T> {
    const response = await this.client.send(
      operation,
      commandId,
      payload,
      options,
    );
    insist(
      response.state === "done" && response.result !== undefined,
      "REMOTE_OUTCOME_UNCERTAIN",
      503,
    );
    return response.result as unknown as T;
  }
  async executionModelView(
    nodeId: string,
    refresh = false,
    options?: { signal?: AbortSignal },
  ): Promise<ExecutionModelsView> {
    insist(nodeId === this.nodeId, "WRONG_CLIENT_NODE", 403);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(3000)])
      : AbortSignal.timeout(3000);
    for (let attempt = 0; attempt < 2; attempt++) {
      let first: ReturnType<typeof ExecutionModelViewPage.parse> | undefined;
      const models: {
        snapshot: import("../execution-models.js").ExecutionModelChoice[];
        positiveSnapshot: import("../execution-models.js").ExecutionModelChoice[];
      } = { snapshot: [], positiveSnapshot: [] };
      let changed = false;
      for (let offset = 0; offset < 2048; ) {
        const raw = await this.command<unknown>(
          "executionModelView",
          `catalog-view:${randomUUID()}`,
          {
            nodeId,
            refresh: attempt === 0 && offset === 0 && refresh === true,
            offset,
            limit: 32,
          },
          { signal },
        );
        if (
          isRecord(raw) &&
          isRecord(raw.catalogError) &&
          typeof raw.catalogError.code === "string"
        )
          throw new ProtocolError(
            raw.catalogError.code,
            raw.catalogError.code === "RESPONSE_LIMIT" ? 413 : 400,
          );
        const page = ExecutionModelViewPage.parse(raw);
        insist(
          page.offset === offset && page.view.nodeId === nodeId,
          "INVALID_EXECUTION_CATALOG_PAGE",
        );
        if (!first) first = page;
        else if (
          JSON.stringify(first.view) !== JSON.stringify(page.view) ||
          JSON.stringify(first.total) !== JSON.stringify(page.total)
        ) {
          changed = true;
          break;
        }
        offset += page.count;
        models.snapshot.push(...page.modelsPage.snapshot);
        models.positiveSnapshot.push(...page.modelsPage.positiveSnapshot);
        if (
          models.snapshot.length >= page.total.snapshot &&
          models.positiveSnapshot.length >= page.total.positiveSnapshot
        )
          break;
      }
      if (!changed && first) {
        insist(
          models.snapshot.length === first.total.snapshot &&
            models.positiveSnapshot.length === first.total.positiveSnapshot,
          "INVALID_EXECUTION_CATALOG_PAGE",
        );
        const view = first.view;
        if (view.catalog.snapshot)
          view.catalog.snapshot.models = models.snapshot;
        if (view.catalog.positiveSnapshot)
          view.catalog.positiveSnapshot.models = models.positiveSnapshot;
        return view;
      }
    }
    throw new ProtocolError("EXECUTION_CATALOG_CHANGED", 409);
  }
  async reportAdmission(
    commandId: string,
    input: AdmissionReport,
  ): Promise<Receipt<Run>> {
    insist(input.nodeId === this.nodeId, "WRONG_CLIENT_NODE", 403);
    const { nodeId: _nodeId, ...payload } = input;
    return this.command("reportAdmission", commandId, payload, {
      diagnostic: true,
    });
  }
  async executionModelRequests(
    nodeId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ExecutionCatalogRequest[]> {
    insist(nodeId === this.nodeId, "WRONG_CLIENT_NODE", 403);
    const result = await this.command<unknown>(
      "executionModelRequests",
      `catalog-poll:${randomUUID()}`,
      {},
      options,
    );
    return ExecutionCatalogRequest.array().max(1).parse(result);
  }
  async completeExecutionModels(
    commandId: string,
    input: CompleteExecutionModels,
    options?: { signal?: AbortSignal },
  ): Promise<Receipt<{ accepted: true }>> {
    insist(input.nodeId === this.nodeId, "WRONG_CLIENT_NODE", 403);
    const { nodeId: _nodeId, ...payload } = input;
    return await this.command(
      "completeExecutionModels",
      commandId,
      JSON.parse(JSON.stringify(payload)),
      options,
    );
  }
  async projectCollaborate(
    nodeId: string,
    commandId: string,
    input: import("../project-collaboration/types.js").ProjectCollaborationInput,
  ): Promise<Json> {
    insist(nodeId === this.nodeId, "WRONG_CLIENT_NODE", 403);
    let receipt: { value: Json };
    try {
      receipt = await this.command<{ value: Json }>(
        "projectCollaborate",
        commandId,
        { input: JSON.parse(JSON.stringify(input)) },
        { diagnostic: true },
      );
    } catch (error) {
      // Only this operation exposes definitive HTTP request rejections. A transport
      // failure or server failure still cannot establish whether work committed.
      if (
        error instanceof ProtocolError &&
        error.status >= 400 &&
        error.status < 500
      )
        throw error;
      throw new ProtocolError("REMOTE_OUTCOME_UNCERTAIN", 503);
    }
    const result = receipt.value;
    if (isRecord(result) && isRecord(result.collaborationError)) {
      const error = new ProtocolError(
        String(result.collaborationError.code),
        409,
      );
      error.message = `${error.code}: ${String(result.collaborationError.message)}`;
      throw error;
    }
    return result;
  }
  async projectSnapshot(_nodeId?: string): Promise<Json> {
    // Scope is derived by the gateway; never send a caller-supplied node id.
    return this.command<Json>(
      "projectSnapshot",
      `project-snapshot:${randomUUID()}`,
      {},
    );
  }
  private scoped(input: LeaseRef): Record<string, Json> {
    insist(input.nodeId === this.nodeId, "WRONG_CLIENT_NODE", 403);
    return {
      runId: input.runId,
      attemptId: input.attemptId,
      fence: input.fence,
      ...(input.executionId !== undefined
        ? { executionId: input.executionId }
        : {}),
    };
  }
  claim(
    commandId: string,
    input: {
      runId: string;
      nodeId: string;
      ttlMs: number;
      projectContextVersion?: 1;
    },
  ): Promise<Receipt<Claim>> {
    insist(input.nodeId === this.nodeId, "WRONG_CLIENT_NODE", 403);
    return this.command("claim", commandId, {
      runId: input.runId,
      ttlMs: input.ttlMs,
      ...(input.projectContextVersion
        ? { projectContextVersion: input.projectContextVersion }
        : {}),
    });
  }
  renew(
    commandId: string,
    input: LeaseRef & {
      ttlMs: number;
      progress?: { requestId: string; summary: string };
    },
  ): Promise<Receipt<Attempt>> {
    return this.command("renew", commandId, {
      ...this.scoped(input),
      ttlMs: input.ttlMs,
      ...(input.progress ? { progress: input.progress } : {}),
    });
  }
  submit(commandId: string, input: Settlement): Promise<Receipt<Run>> {
    return this.command("submit", commandId, {
      ...this.scoped(input),
      outcome: input.outcome,
      summary: input.summary,
      ...(input.report ? { report: input.report as unknown as Json } : {}),
      ...(input.resultValidationFailure
        ? {
            resultValidationFailure:
              input.resultValidationFailure as unknown as Json,
          }
        : {}),
      ...(input.preDispatchFailure
        ? { preDispatchFailure: input.preDispatchFailure as unknown as Json }
        : {}),
    });
  }
  async cancel(
    commandId: string,
    input: { taskId: string; runId?: string; reason: string },
  ): Promise<Receipt<Task>> {
    insist(input.runId, "RUN_SCOPED_CANCEL_REQUIRED");
    const run = await this.getRun(input.runId);
    insist(run?.taskId === input.taskId, "TASK_RUN_MISMATCH", 403);
    return this.command("cancel", commandId, {
      runId: input.runId,
      reason: input.reason,
    });
  }
  async sessionContext(input: LeaseRef): Promise<TaskSessionContext> {
    const context = await this.command<TaskSessionContext>(
      "sessionContext",
      `sessions-${randomUUID()}`,
      this.scoped(input),
    );
    const identity = this.client.cachedExecutorIdentity();
    insist(
      !identity || context.schedulerId === identity.schedulerId,
      "SCHEDULER_IDENTITY_CHANGED",
      403,
    );
    return context;
  }
  selectTaskSession(
    commandId: string,
    input: LeaseRef & TaskSessionChoice,
  ): Promise<Receipt<SelectedTaskSession>> {
    return this.command("selectTaskSession", commandId, {
      ...this.scoped(input),
      session: input.session as unknown as Json,
      ...(input.expectedTaskSessionId !== undefined
        ? { expectedTaskSessionId: input.expectedTaskSessionId }
        : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
    });
  }
  bindSession(
    commandId: string,
    input: LeaseRef & { sessionId: string },
  ): Promise<Receipt<Attempt>> {
    return this.command("bindSession", commandId, {
      ...this.scoped(input),
      sessionId: input.sessionId,
    });
  }
  markRunning(commandId: string, input: LeaseRef): Promise<Receipt<Attempt>> {
    return this.command("markRunning", commandId, this.scoped(input));
  }
  acknowledgeCancellation(
    commandId: string,
    input: LeaseRef,
  ): Promise<Receipt<Run>> {
    return this.command(
      "acknowledgeCancellation",
      commandId,
      this.scoped(input),
    );
  }
  retryBeforeEffects(
    commandId: string,
    input: LeaseRef & { witness: SafeRetryWitness; allowRetry?: boolean },
  ): Promise<Receipt<Run>> {
    return this.command("retryBeforeEffects", commandId, {
      ...this.scoped(input),
      witness: input.witness as unknown as Json,
      ...(input.allowRetry !== undefined
        ? { allowRetry: input.allowRetry }
        : {}),
    });
  }
  getRun(runId: string): Promise<Run | undefined> {
    return this.command("getRun", `read-${randomUUID()}`, { runId });
  }
  getAttempt(attemptId: string): Promise<Attempt | undefined> {
    return this.command("getAttempt", `read-${randomUUID()}`, { attemptId });
  }
  pendingRuns(nodeId: string): Promise<Run[]> {
    insist(nodeId === this.nodeId, "WRONG_CLIENT_NODE", 403);
    return this.command("listWork", `read-${randomUUID()}`, {});
  }
  offerApproval(
    commandId: string,
    input: LeaseRef & ApprovalOffer,
    options?: { signal?: AbortSignal },
  ): Promise<Receipt<ApprovalRequest>> {
    return this.command(
      "offerApproval",
      commandId,
      {
        ...this.scoped(input),
        requestId: input.requestId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        callId: input.callId,
        toolName: input.toolName,
        argumentsDigest: input.argumentsDigest,
        description: input.description,
        expiresAt: input.expiresAt,
        allowRemoteOnce: input.allowRemoteOnce,
      },
      options,
    );
  }
  approvalStatus(
    input: LeaseRef & { requestId: string },
    options?: { signal?: AbortSignal },
  ): Promise<ApprovalRequest> {
    return this.command(
      "approvalStatus",
      `read-${randomUUID()}`,
      { ...this.scoped(input), requestId: input.requestId },
      options,
    );
  }
  cancelApproval(
    commandId: string,
    input: LeaseRef & { requestId: string; reason: string },
    options?: { signal?: AbortSignal },
  ): Promise<Receipt<ApprovalRequest>> {
    return this.command(
      "cancelApproval",
      commandId,
      {
        ...this.scoped(input),
        requestId: input.requestId,
        reason: input.reason,
      },
      options,
    );
  }
  recordNodeHeartbeat(
    commandId: string,
    input: HeartbeatInput,
    options?: { signal?: AbortSignal },
  ): Promise<Receipt<unknown>> {
    insist(input.nodeId === this.nodeId, "WRONG_CLIENT_NODE", 403);
    return this.command(
      "heartbeat",
      commandId,
      {
        sampledAt: input.sampledAt,
        runtimeReady: input.runtimeReady,
        activeExecutions: input.activeExecutions,
        ...(input.workspaces !== undefined
          ? { workspaces: input.workspaces }
          : {}),
        ...(input.providerStatus !== undefined
          ? { providerStatus: input.providerStatus }
          : {}),
      },
      options,
    );
  }
  ownNodeStatus(options?: { signal?: AbortSignal }): Promise<NodeStatus> {
    return this.command("nodeStatus", `read-${randomUUID()}`, {}, options);
  }
  observe(
    commandId: string,
    input: ObservationInput,
    options?: { signal?: AbortSignal },
  ): Promise<Receipt<ObservationCandidate>> {
    return this.command(
      "observe",
      commandId,
      {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sourceRevision: input.sourceRevision,
        title: input.title,
        body: input.body,
        observedAt: input.observedAt,
        truncated: input.truncated,
      },
      options,
    );
  }
  captureObservation(
    commandId: string,
    input: CapturedText | ObservationInput,
    options?: { signal?: AbortSignal },
  ): Promise<Receipt<ObservationCandidate>> {
    insist("workspaceId" in input, "OBSERVATION_WORKSPACE_REQUIRED");
    return this.observe(commandId, input, options);
  }
  recoverObservations(
    limit = 32,
    options?: { signal?: AbortSignal },
  ): Promise<CommandReceipt[]> {
    return this.client.retryPendingObservations(limit, options);
  }
  delegateTask(
    commandId: string,
    input: LeaseRef & DelegationInput,
    options?: { signal?: AbortSignal },
  ): Promise<Receipt<{ task: Task; run: Run }>> {
    return this.command(
      "delegate",
      commandId,
      {
        ...this.scoped(input),
        title: input.title,
        ...(input.display ? { display: input.display as unknown as Json } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.route ? { route: input.route as unknown as Json } : {}),
        ...(input.policy ? { policy: input.policy as unknown as Json } : {}),
        ...(input.configuration !== undefined
          ? { configuration: input.configuration }
          : {}),
      },
      options,
    );
  }
  scopedHistory(
    input: LeaseRef & { taskId?: string },
    options?: { signal?: AbortSignal },
  ): Promise<TaskHistory> {
    return this.command(
      "taskHistory",
      `read-${randomUUID()}`,
      {
        ...this.scoped(input),
        ...(input.taskId !== undefined ? { targetTaskId: input.taskId } : {}),
      },
      options,
    );
  }
  scopedAllSettled(
    input: LeaseRef & { taskId?: string; quietMs?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SettlementView> {
    return this.command(
      "taskWait",
      `read-${randomUUID()}`,
      {
        ...this.scoped(input),
        ...(input.taskId !== undefined ? { targetTaskId: input.taskId } : {}),
        ...(input.quietMs !== undefined ? { quietMs: input.quietMs } : {}),
      },
      options,
    );
  }
  queueScopedNote(
    commandId: string,
    input: LeaseRef & { taskId?: string; body: string },
    options?: { signal?: AbortSignal },
  ): Promise<Receipt<unknown>> {
    return this.command(
      "taskNote",
      commandId,
      {
        ...this.scoped(input),
        body: input.body,
        ...(input.taskId !== undefined ? { targetTaskId: input.taskId } : {}),
      },
      options,
    );
  }
  appendScopedReport(
    commandId: string,
    input: LeaseRef & { taskId?: string } & Omit<
        TaskReportInput,
        "targetTaskId"
      >,
    options?: { signal?: AbortSignal },
  ): Promise<Receipt<unknown>> {
    return this.command(
      "taskReport",
      commandId,
      {
        ...this.scoped(input),
        title: input.title,
        body: input.body,
        ...(input.taskId !== undefined ? { targetTaskId: input.taskId } : {}),
        ...(input.data !== undefined ? { data: input.data } : {}),
        ...(input.schemaId !== undefined ? { schemaId: input.schemaId } : {}),
        ...(input.artifactIds !== undefined
          ? { artifactIds: input.artifactIds }
          : {}),
      },
      options,
    );
  }
}
