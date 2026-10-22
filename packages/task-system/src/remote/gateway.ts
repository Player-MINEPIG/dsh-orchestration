import {
  AdmissionReport,
  CompleteExecutionModels,
} from "../execution-models.js";
import { ProgramCatalog, ProgramRoute } from "../workflow-programs.js";
import { validateCollaborationInput } from "../project-collaboration/authority.js";
import { TaskError } from "../ledger.js";
import {
  executorWorkspaces,
  byteLimit,
  canonical,
  canonicalData,
  canonicalSchema,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  digest,
  identifier,
  insist,
  isRecord,
  parseCommandEnvelope,
  ProtocolError,
  validatePreDispatchFailure,
  validateResultValidationFailure,
} from "./protocol.js";
import type {
  CommandEnvelope,
  RequestVerifier,
  Json,
  AuthorizedPeer,
  Role,
  TransportIdentity,
} from "./protocol.js";
import type {
  TaskSessionChoice,
  ApprovalOffer,
  DelegationInput,
  LedgerPort,
  LeaseRef,
  SafeRetryWitness,
  Settlement,
  TaskReportInput,
} from "./ports.js";
import type { CommandReceipt, RecoveryStore } from "./store.js";
import { validateRetryWitness } from "./retry.js";

function fields(
  input: Record<string, Json>,
  required: string[],
  optional: string[] = [],
): void {
  insist(
    required.every((key) => Object.hasOwn(input, key)) &&
      Object.keys(input).every((key) =>
        [...required, ...optional].includes(key),
      ),
    "PAYLOAD_FIELDS",
  );
}
function id(input: Record<string, Json>, key: string): string {
  const value = input[key];
  insist(identifier(value), `INVALID_${key}`);
  return value;
}
function text(input: Record<string, Json>, key: string, max: number): string {
  const value = input[key];
  insist(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= max,
    `INVALID_${key}`,
  );
  return value;
}
function ttl(input: Record<string, Json>): number {
  const value = input.ttlMs;
  insist(
    Number.isSafeInteger(value) &&
      Number(value) >= 1000 &&
      Number(value) <= 300000,
    "INVALID_TTL",
  );
  return Number(value);
}
function lease(input: Record<string, Json>, nodeId: string): LeaseRef {
  insist(
    Number.isSafeInteger(input.fence) && Number(input.fence) >= 1,
    "INVALID_FENCE",
  );
  return {
    runId: id(input, "runId"),
    attemptId: id(input, "attemptId"),
    nodeId,
    fence: Number(input.fence),
    ...(input.executionId !== undefined
      ? { executionId: id(input, "executionId") }
      : {}),
  };
}
const collaborationOps = [
  "delegate",
  "taskHistory",
  "taskWait",
  "taskNote",
  "taskReport",
  "offerApproval",
  "approvalStatus",
];
const ownedFields = ["runId", "attemptId", "fence", "executionId"];
function stringArray(value: unknown, label: string, max = 64): void {
  insist(
    Array.isArray(value) &&
      value.length <= max &&
      value.every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 128,
      ),
    label,
  );
}
function reportFields(report: Record<string, Json>): void {
  text(report, "title", 500);
  text(report, "body", 1_000_000);
  if (report.artifactIds !== undefined)
    insist(
      Array.isArray(report.artifactIds) &&
        report.artifactIds.length <= 32 &&
        report.artifactIds.every(identifier),
      "INVALID_ARTIFACTS",
    );
  if (report.schemaId !== undefined) text(report, "schemaId", 200);
  if (report.data !== undefined) canonicalData(report.data);
}
function delegation(input: Record<string, Json>): void {
  if (input.display !== undefined) {
    insist(isRecord(input.display), "INVALID_DISPLAY");
    fields(input.display, [], ["requested", "complexity"]);
    insist(
      [undefined, "task", "step"].includes(input.display.requested as string),
      "INVALID_DISPLAY",
    );
    insist(
      [undefined, "small", "independent"].includes(
        input.display.complexity as string,
      ),
      "INVALID_DISPLAY",
    );
  }
  text(input, "title", 500);
  if (input.description !== undefined)
    insist(
      typeof input.description === "string" &&
        Buffer.byteLength(input.description) <= 32768,
      "INVALID_DESCRIPTION",
    );
  if (input.configuration !== undefined) {
    canonical(input.configuration);
    if (isRecord(input.configuration)) {
      const config = input.configuration;
      if (config.input !== undefined) canonicalData(config.input);
      if (config.trigger !== undefined) canonicalData(config.trigger);
      if (config.template !== undefined) {
        insist(isRecord(config.template), "INVALID_TEMPLATE_SNAPSHOT");
        canonicalSchema(config.template.inputSchema);
        canonicalSchema(config.template.resultContract);
        canonicalData(config.template.defaults);
      }
    }
  }
  if (input.route !== undefined) {
    insist(isRecord(input.route), "INVALID_ROUTE");
    const route = input.route as Record<string, Json>;
    fields(
      route,
      ["nodeId", "provider", "model", "requiredCapabilities"],
      ["workspaceId", "reasoningEffort", "backend", "execution"],
    );
    if (route.execution !== undefined)
      insist(
        ProgramRoute.safeParse(route.execution).success,
        "INVALID_PROGRAM_ROUTE",
      );
    if (route.backend !== undefined) text(route, "backend", 100);
    id(route, "nodeId");
    text(route, "provider", 100);
    text(route, "model", 200);
    stringArray(route.requiredCapabilities, "INVALID_CAPABILITIES");
    if (route.workspaceId !== undefined) id(route, "workspaceId");
    if (route.reasoningEffort !== undefined)
      text(route, "reasoningEffort", 100);
  }
  if (input.policy !== undefined) {
    insist(isRecord(input.policy), "INVALID_POLICY");
    const policy = input.policy as Record<string, Json>;
    fields(
      policy,
      [],
      [
        "allowedNodeIds",
        "allowedWorkspaceIds",
        "allowedTools",
        "allowedBackends",
        "requiredResources",
        "maxRuntimeMs",
        "maxDepth",
        "maxChildren",
        "maxDescendants",
        "settlementQuietMs",
      ],
    );
    for (const key of [
      "allowedNodeIds",
      "allowedWorkspaceIds",
      "allowedTools",
      "allowedBackends",
      "requiredResources",
    ])
      if (policy[key] !== undefined)
        stringArray(policy[key], "INVALID_POLICY_SCOPE");
    if (policy.maxRuntimeMs !== undefined)
      insist(
        Number.isSafeInteger(policy.maxRuntimeMs) &&
          Number(policy.maxRuntimeMs) >= 100 &&
          Number(policy.maxRuntimeMs) <= 86400000,
        "INVALID_RUNTIME_BUDGET",
      );
    if (policy.maxDepth !== undefined)
      insist(
        Number.isSafeInteger(policy.maxDepth) &&
          Number(policy.maxDepth) >= 0 &&
          Number(policy.maxDepth) <= 100,
        "INVALID_DELEGATION_DEPTH",
      );
    for (const key of ["maxChildren", "maxDescendants", "settlementQuietMs"])
      if (policy[key] !== undefined)
        insist(
          Number.isSafeInteger(policy[key]) &&
            Number(policy[key]) >= 0 &&
            Number(policy[key]) <= 300000,
          "INVALID_DELEGATION_BOUNDS",
        );
  }
}
export function validatePayload(envelope: CommandEnvelope): void {
  const p = envelope.payload;
  switch (envelope.operation) {
    case "projectCollaborate":
      fields(p, ["input"]);
      try {
        validateCollaborationInput(p.input);
      } catch (error) {
        if (error instanceof TaskError)
          throw new ProtocolError(error.code, 400);
        throw error;
      }
      break;
    case "projectSnapshot":
      fields(p, []);
      break;
    case "claim":
      fields(p, ["runId", "ttlMs"], ["projectContextVersion"]);
      id(p, "runId");
      ttl(p);
      if (p.projectContextVersion !== undefined)
        insist(
          p.projectContextVersion === 1,
          "PROJECT_CONTEXT_VERSION_UNSUPPORTED",
        );
      break;
    case "renew":
      fields(
        p,
        ["runId", "attemptId", "fence", "ttlMs"],
        ["executionId", "progress"],
      );
      if (p.progress !== undefined) {
        const progress = p.progress as Record<string, Json>;
        insist(
          !!progress &&
            typeof progress === "object" &&
            !Array.isArray(progress),
          "INVALID_PROGRESS",
        );
        fields(progress, ["requestId", "summary"]);
        id(progress, "requestId");
        text(progress, "summary", 1000);
      }
      lease(p, envelope.nodeId);
      ttl(p);
      break;
    case "cancel":
      fields(p, ["runId", "reason"]);
      id(p, "runId");
      text(p, "reason", 1000);
      break;
    case "receipt":
      fields(p, ["commandId"]);
      id(p, "commandId");
      break;
    case "listWork":
    case "nodeStatus":
    case "executorIdentity":
      fields(p, []);
      break;
    case "executionModelView":
      fields(p, [], ["nodeId", "refresh", "offset", "limit"]);
      insist(
        p.nodeId === undefined || p.nodeId === envelope.nodeId,
        "EXECUTION_CATALOG_NODE_DENIED",
        403,
      );
      insist(
        p.refresh === undefined || typeof p.refresh === "boolean",
        "INVALID_REFRESH",
      );
      insist(
        p.offset === undefined ||
          (Number.isSafeInteger(p.offset) &&
            Number(p.offset) >= 0 &&
            Number(p.offset) <= 2048),
        "INVALID_OFFSET",
      );
      insist(
        p.limit === undefined ||
          (Number.isSafeInteger(p.limit) &&
            Number(p.limit) >= 1 &&
            Number(p.limit) <= 32),
        "INVALID_LIMIT",
      );
      break;
    case "reportAdmission":
      fields(p, ["runId", "expectedUpdatedAt", "routeDigest", "code"]);
      try {
        AdmissionReport.parse({ ...p, nodeId: envelope.nodeId });
      } catch {
        throw new ProtocolError("INVALID_ADMISSION_REPORT");
      }
      break;
    case "executionModelRequests":
      fields(p, []);
      break;
    case "completeExecutionModels":
      fields(p, ["requestId", "generation", "result"], ["page"]);
      try {
        CompleteExecutionModels.parse({ ...p, nodeId: envelope.nodeId });
      } catch {
        throw new ProtocolError("INVALID_EXECUTION_CATALOG");
      }
      break;
    case "heartbeat": {
      fields(
        p,
        ["sampledAt", "runtimeReady", "activeExecutions"],
        ["providerStatus", "workspaces"],
      );
      insist(
        Number.isSafeInteger(p.sampledAt) && Number(p.sampledAt) >= 0,
        "INVALID_SAMPLE_TIME",
      );
      insist(typeof p.runtimeReady === "boolean", "INVALID_RUNTIME_READY");
      insist(
        Number.isSafeInteger(p.activeExecutions) &&
          Number(p.activeExecutions) >= 0 &&
          Number(p.activeExecutions) <= 128,
        "INVALID_ACTIVE_EXECUTIONS",
      );
      if (p.workspaces !== undefined)
        executorWorkspaces(p.workspaces, envelope.nodeId);
      if (p.providerStatus !== undefined) {
        insist(isRecord(p.providerStatus), "INVALID_PROVIDER_STATUS");
        const status = p.providerStatus as Record<string, Json>;
        fields(status, ["state", "providers"], ["executionRoutes", "programs"]);
        if (status.programs !== undefined) {
          insist(
            Array.isArray(status.programs) && status.programs.length <= 32,
            "INVALID_PROGRAM_CATALOG",
          );
          for (const program of status.programs) {
            const parsed = ProgramCatalog.safeParse(program);
            insist(
              parsed.success && parsed.data.nodeId === envelope.nodeId,
              "INVALID_PROGRAM_CATALOG",
            );
          }
        }
        const states = ["not-probed", "ready", "unavailable"];
        insist(states.includes(String(status.state)), "INVALID_PROVIDER_STATE");
        insist(
          Array.isArray(status.providers) && status.providers.length <= 32,
          "INVALID_PROVIDER_LIST",
        );
        if (status.executionRoutes !== undefined) {
          insist(
            Array.isArray(status.executionRoutes) &&
              status.executionRoutes.length <= 128,
            "INVALID_EXECUTION_ROUTES",
          );
          for (const route of status.executionRoutes)
            validateCollaborationInput({
              action: "nodes",
              sessionId: "heartbeat",
              cwd: "/",
              route,
            });
        }
        const providers = new Set<string>();
        for (const entry of status.providers) {
          insist(isRecord(entry), "INVALID_PROVIDER_STATUS");
          const provider = entry as Record<string, Json>;
          fields(provider, ["provider", "state"]);
          const name = text(provider, "provider", 100);
          insist(
            !providers.has(name) && states.includes(String(provider.state)),
            "INVALID_PROVIDER_STATE",
          );
          providers.add(name);
        }
        insist(
          Buffer.byteLength(canonicalData(status)) <= 8192,
          "PROVIDER_STATUS_LIMIT",
        );
      }
      break;
    }
    case "observe": {
      fields(p, [
        "workspaceId",
        "sessionId",
        "sourceRevision",
        "title",
        "body",
        "observedAt",
        "truncated",
      ]);
      id(p, "workspaceId");
      id(p, "sessionId");
      text(p, "sourceRevision", 100);
      text(p, "title", 500);
      insist(
        typeof p.body === "string" &&
          p.body.trim().length > 0 &&
          p.body.length <= 8000,
        "INVALID_OBSERVATION_BODY",
      );
      const observedAt = text(p, "observedAt", 40);
      insist(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
          observedAt,
        ) && Number.isFinite(Date.parse(observedAt)),
        "INVALID_OBSERVATION_TIME",
      );
      insist(
        typeof p.truncated === "boolean",
        "INVALID_OBSERVATION_TRUNCATION",
      );
      break;
    }
    case "sessionMessages":
      fields(p, []);
      break;
    case "sessionMessageReply":
      fields(p, ["messageId", "state", "reply"]);
      id(p, "messageId");
      insist(
        ["completed", "failed", "uncertain"].includes(String(p.state)),
        "INVALID_MESSAGE_STATE",
      );
      text(p, "reply", 48000);
      break;
    case "getRun":
      fields(p, ["runId"]);
      id(p, "runId");
      break;
    case "getAttempt":
      fields(p, ["attemptId"]);
      id(p, "attemptId");
      break;
    case "sessionContext":
      fields(p, ownedFields);
      lease(p, envelope.nodeId);
      break;
    case "selectTaskSession": {
      fields(
        p,
        [...ownedFields, "session"],
        ["workspaceId", "decision", "expectedTaskSessionId"],
      );
      lease(p, envelope.nodeId);
      if (p.workspaceId !== undefined) id(p, "workspaceId");
      if (
        p.expectedTaskSessionId !== undefined &&
        p.expectedTaskSessionId !== null
      )
        id(p, "expectedTaskSessionId");
      insist(isRecord(p.session), "INVALID_SESSION_SELECTION");
      const selected = p.session as Record<string, Json>;
      if (selected.mode === "new") fields(selected, ["mode"]);
      else {
        fields(selected, ["mode", "sessionId"]);
        insist(selected.mode === "reuse", "INVALID_SESSION_SELECTION");
        id(selected, "sessionId");
      }
      if (p.decision !== undefined) canonicalData(p.decision);
      break;
    }
    case "bindSession":
      fields(p, ["runId", "attemptId", "fence", "sessionId"], ["executionId"]);
      lease(p, envelope.nodeId);
      id(p, "sessionId");
      break;
    case "offerApproval": {
      fields(p, [
        ...ownedFields,
        "requestId",
        "sessionId",
        "agentId",
        "callId",
        "toolName",
        "argumentsDigest",
        "description",
        "expiresAt",
        "allowRemoteOnce",
      ]);
      lease(p, envelope.nodeId);
      for (const key of ["requestId", "sessionId", "agentId", "callId"])
        id(p, key);
      text(p, "toolName", 200);
      insist(
        typeof p.argumentsDigest === "string" &&
          /^[a-f0-9]{64}$/.test(p.argumentsDigest),
        "INVALID_ARGUMENTS_DIGEST",
      );
      insist(
        typeof p.description === "string" &&
          p.description.length > 0 &&
          p.description.length <= 4000,
        "INVALID_APPROVAL_DESCRIPTION",
      );
      insist(
        Number.isSafeInteger(p.expiresAt) && Number(p.expiresAt) > 0,
        "INVALID_APPROVAL_EXPIRY",
      );
      insist(
        typeof p.allowRemoteOnce === "boolean",
        "INVALID_APPROVAL_ALLOWANCE",
      );
      break;
    }
    case "approvalStatus":
      fields(p, [...ownedFields, "requestId"]);
      lease(p, envelope.nodeId);
      id(p, "requestId");
      break;
    case "cancelApproval":
      fields(p, [...ownedFields, "requestId", "reason"]);
      lease(p, envelope.nodeId);
      id(p, "requestId");
      text(p, "reason", 1000);
      break;
    case "retryBeforeEffects":
      fields(p, [...ownedFields, "witness"], ["allowRetry"]);
      lease(p, envelope.nodeId);
      validateRetryWitness(p.witness);
      if (p.allowRetry !== undefined)
        insist(typeof p.allowRetry === "boolean", "INVALID_RETRY_ALLOWANCE");
      break;
    case "markRunning":
      fields(p, ["runId", "attemptId", "fence", "executionId"]);
      lease(p, envelope.nodeId);
      break;
    case "acknowledgeCancellation":
      fields(p, ["runId", "attemptId", "fence"], ["executionId"]);
      lease(p, envelope.nodeId);
      break;
    case "delegate":
      fields(
        p,
        [...ownedFields, "title"],
        ["description", "route", "policy", "configuration", "display"],
      );
      lease(p, envelope.nodeId);
      delegation(p);
      break;
    case "taskHistory":
      fields(p, ownedFields, ["targetTaskId"]);
      lease(p, envelope.nodeId);
      if (p.targetTaskId !== undefined) id(p, "targetTaskId");
      break;
    case "taskWait":
      fields(p, ownedFields, ["targetTaskId", "quietMs"]);
      lease(p, envelope.nodeId);
      if (p.targetTaskId !== undefined) id(p, "targetTaskId");
      if (p.quietMs !== undefined)
        insist(
          Number.isSafeInteger(p.quietMs) &&
            Number(p.quietMs) >= 0 &&
            Number(p.quietMs) <= 300000,
          "INVALID_QUIET_WINDOW",
        );
      break;
    case "taskNote":
      fields(p, [...ownedFields, "body"], ["targetTaskId"]);
      lease(p, envelope.nodeId);
      text(p, "body", 32768);
      if (p.targetTaskId !== undefined) id(p, "targetTaskId");
      break;
    case "taskReport":
      fields(
        p,
        [...ownedFields, "title", "body"],
        ["targetTaskId", "data", "schemaId", "artifactIds"],
      );
      lease(p, envelope.nodeId);
      reportFields(p);
      if (p.targetTaskId !== undefined) id(p, "targetTaskId");
      break;
    case "submit": {
      fields(
        p,
        ["runId", "attemptId", "fence", "outcome", "summary"],
        [
          "report",
          "executionId",
          "preDispatchFailure",
          "resultValidationFailure",
        ],
      );
      lease(p, envelope.nodeId);
      insist(
        ["success", "partial", "failure", "blocked", "unknown"].includes(
          String(p.outcome),
        ),
        "INVALID_OUTCOME",
      );
      text(p, "summary", 5000);
      if (p.resultValidationFailure !== undefined) {
        validateResultValidationFailure(p.resultValidationFailure);
        insist(
          p.outcome === "failure" &&
            p.report === undefined &&
            p.preDispatchFailure === undefined,
          "INVALID_RESULT_VALIDATION_FAILURE",
        );
      }
      if (p.preDispatchFailure !== undefined) {
        validatePreDispatchFailure(p.preDispatchFailure);
        insist(
          p.outcome === "blocked" && p.report === undefined,
          "INVALID_PRE_DISPATCH_FAILURE",
        );
      }
      if (p.report !== undefined) {
        insist(isRecord(p.report), "INVALID_REPORT");
        const report = p.report as Record<string, Json>;
        fields(report, ["title", "body"], ["artifactIds", "data", "schemaId"]);
        reportFields(report);
      }
    }
  }
}
export interface GatewayOptions {
  role: Role;
  nodeId: string;
  verifier: RequestVerifier;
  ledger: LedgerPort;
  store: RecoveryStore;
  now?: () => number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
}
/** Coordinator entrypoint. Authenticated payloads contain no command, shell, cwd or actor override. */
export class RemoteGateway {
  private options: GatewayOptions;
  private active = true;
  private configurationPaused = false;
  private pending = new Set<Promise<unknown>>();
  get authMode(): RequestVerifier["authMode"] {
    return this.options.verifier.authMode;
  }
  constructor(options: GatewayOptions) {
    this.options = {
      ...options,
      maxBodyBytes: byteLimit(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
      maxResponseBytes: byteLimit(
        options.maxResponseBytes,
        DEFAULT_MAX_RESPONSE_BYTES,
      ),
    };
    insist(options.role !== "executor", "PLANNER_ROLE_REQUIRED", 403);
  }
  beginConfigurationEdit(): () => void {
    insist(
      !this.configurationPaused && this.pending.size === 0,
      "CONFIGURATION_BUSY",
      409,
    );
    this.configurationPaused = true;
    return () => {
      this.configurationPaused = false;
    };
  }
  private bounded(receipt: CommandReceipt): CommandReceipt {
    insist(
      Buffer.byteLength(canonical(receipt)) <= this.options.maxResponseBytes!,
      "RESPONSE_LIMIT",
      413,
    );
    return receipt;
  }
  async handle(
    body: Uint8Array | string,
    transport?: TransportIdentity,
  ): Promise<CommandReceipt> {
    insist(this.active, "DRAINING", 503);
    insist(!this.configurationPaused, "CONFIGURATION_BUSY", 409);
    const promise = this.handleOwned(body, transport);
    this.pending.add(promise);
    try {
      return this.bounded(await promise);
    } finally {
      this.pending.delete(promise);
    }
  }
  private async handleOwned(
    body: Uint8Array | string,
    transport?: TransportIdentity,
  ): Promise<CommandReceipt> {
    const { verifier, ledger, store } = this.options;
    const now = (this.options.now ?? Date.now)();
    const envelope = parseCommandEnvelope(
      body,
      verifier.authMode,
      this.options.maxBodyBytes,
    );
    const peer = verifier.verify(envelope, now, transport);
    validatePayload(envelope);
    if (peer.managedAccess)
      insist(peer.nodeId !== this.options.nodeId, "NODE_ID_COLLISION", 403);
    if (peer.managedAccess && envelope.operation === "heartbeat") {
      insist(
        Number(envelope.payload.sampledAt) >= envelope.issuedAt - 60000 &&
          Number(envelope.payload.sampledAt) <= envelope.issuedAt + 5000,
        "STALE_HEARTBEAT_SAMPLE",
        401,
      );
    }
    // An authenticated exact command retry may read its receipt after the lease
    // settled or expired. Mutable lease checks apply only to new commands.
    const recorded = store.receipt(peer.nodeId, envelope.commandId, now);
    await this.authorize(
      envelope,
      peer,
      !recorded || envelope.operation === "approvalStatus",
    );
    const old = store.admit(envelope, now);
    if (
      old &&
      !(
        envelope.operation === "projectCollaborate" && old.state === "uncertain"
      )
    )
      return await this.reconcile(peer.nodeId, old, envelope.operation);
    const commandId = `remote-${digest([peer.nodeId, envelope.commandId])}`;
    const p = envelope.payload;
    try {
      verifier.admitIdentity?.(envelope, peer);
      if (
        peer.managedAccess &&
        ["heartbeat", "executorIdentity"].includes(envelope.operation)
      )
        await ledger.registerPairedExecutor?.(
          `pair:${digest([peer.nodeId, envelope.commandId])}`,
          peer.nodeId,
          undefined,
        );
      let result: unknown;
      switch (envelope.operation) {
        case "executionModelView": {
          insist(
            ledger.executionModelView,
            "EXECUTION_CATALOG_UNSUPPORTED",
            503,
          );
          const view = await ledger.executionModelView(
            peer.nodeId,
            p.refresh === true,
          );
          const offset = Number(p.offset ?? 0),
            limit = Number(p.limit ?? 32);
          const snapshot = view.catalog.snapshot?.models ?? [],
            positive = view.catalog.positiveSnapshot?.models ?? [];
          const page = {
            view: {
              ...view,
              catalog: {
                ...view.catalog,
                ...(view.catalog.snapshot
                  ? { snapshot: { ...view.catalog.snapshot, models: [] } }
                  : {}),
                ...(view.catalog.positiveSnapshot
                  ? {
                      positiveSnapshot: {
                        ...view.catalog.positiveSnapshot,
                        models: [],
                      },
                    }
                  : {}),
              },
            },
            offset,
            count: Math.max(
              1,
              Math.min(
                limit,
                Math.max(snapshot.length, positive.length) - offset,
              ),
            ),
            modelsPage: {
              snapshot: snapshot.slice(offset, offset + limit),
              positiveSnapshot: positive.slice(offset, offset + limit),
            },
            total: {
              snapshot: snapshot.length,
              positiveSnapshot: positive.length,
            },
          };
          while (
            Buffer.byteLength(
              canonical({
                commandId: envelope.commandId,
                state: "done",
                result: page,
              }),
            ) > this.options.maxResponseBytes!
          ) {
            insist(page.count > 1, "RESPONSE_LIMIT", 413);
            page.count = Math.max(1, Math.floor(page.count / 2));
            page.modelsPage.snapshot = snapshot.slice(
              offset,
              offset + page.count,
            );
            page.modelsPage.positiveSnapshot = positive.slice(
              offset,
              offset + page.count,
            );
          }
          result = page;
          break;
        }
        case "reportAdmission":
          insist(ledger.reportAdmission, "ADMISSION_REPORT_UNSUPPORTED", 503);
          result = await ledger.reportAdmission(
            commandId,
            AdmissionReport.parse({ ...p, nodeId: peer.nodeId }),
          );
          break;
        case "executionModelRequests":
          insist(
            ledger.executionModelRequests,
            "EXECUTION_CATALOG_UNSUPPORTED",
            503,
          );
          result = await ledger.executionModelRequests(peer.nodeId);
          break;
        case "completeExecutionModels": {
          insist(
            ledger.completeExecutionModels,
            "EXECUTION_CATALOG_UNSUPPORTED",
            503,
          );
          const input = CompleteExecutionModels.parse({
            ...p,
            nodeId: peer.nodeId,
          });
          const saved = await ledger.completeExecutionModels(commandId, input);
          result = {
            commandId: saved.commandId,
            acceptedAt: saved.acceptedAt,
            value: { accepted: true },
          };
          break;
        }
        case "projectCollaborate":
          insist(
            ledger.projectCollaborate,
            "PROJECT_COLLABORATION_UNSUPPORTED",
            503,
          );
          result = await ledger.projectCollaborate(
            peer.nodeId,
            commandId,
            p.input as unknown as import("../project-collaboration/types.js").ProjectCollaborationInput,
          );
          break;
        case "projectSnapshot":
          insist(ledger.projectSnapshot, "PROJECT_SNAPSHOT_UNSUPPORTED", 503);
          result = await ledger.projectSnapshot(peer.nodeId);
          break;
        case "sessionMessages": {
          insist(
            ledger.pendingSessionMessages,
            "SESSION_MESSAGES_UNSUPPORTED",
            503,
          );
          let bytes = 0;
          result = (await ledger.pendingSessionMessages(peer.nodeId)).filter(
            (m) => {
              if (
                !(peer.managedAccess || peer.workspaces.includes(m.workspaceId))
              )
                return false;
              const size = Buffer.byteLength(JSON.stringify(m));
              if (bytes + size > this.options.maxResponseBytes! - 2048)
                return false;
              bytes += size;
              return true;
            },
          );
          break;
        }
        case "sessionMessageReply":
          insist(
            ledger.completeSessionMessage,
            "SESSION_MESSAGES_UNSUPPORTED",
            503,
          );
          result = await ledger.completeSessionMessage(commandId, {
            nodeId: peer.nodeId,
            messageId: String(p.messageId),
            state: p.state as "completed" | "failed" | "uncertain",
            reply: String(p.reply),
          });
          break;
        case "executorIdentity":
          insist(
            ledger.schedulerIdentity,
            "SCHEDULER_IDENTITY_UNSUPPORTED",
            503,
          );
          result = store.executorIdentity(
            ledger.schedulerIdentity(),
            peer.nodeId,
          );
          break;
        case "sessionContext": {
          insist(ledger.sessionContext, "TASK_SESSIONS_UNSUPPORTED", 503);
          const context = await ledger.sessionContext(lease(p, peer.nodeId));
          const ownedRun = await ledger.getRun(id(p, "runId"));
          insist(ownedRun, "RUN_NOT_FOUND", 404);
          const current = context.sessions.find(
            (session) => session.sessionId === context.taskSessionId,
          );
          insist(
            !current ||
              (current.workspaceId
                ? peer.managedAccess ||
                  peer.workspaces.includes(current.workspaceId)
                : !!context.projectContext &&
                  !context.workspaceId &&
                  !context.workspaceConstraint),
            "TASK_SESSION_WORKSPACE_DENIED",
            403,
          );
          result = {
            ...context,
            availableOperations: [...peer.operations],
            ...(context.eligibleWorkspaceIds
              ? {
                  eligibleWorkspaceIds: context.eligibleWorkspaceIds.filter(
                    (workspaceId) =>
                      peer.managedAccess ||
                      peer.workspaces.includes(workspaceId),
                  ),
                }
              : {}),
            sessions: context.sessions.filter(
              (session) =>
                session.schedulerId === context.schedulerId &&
                session.taskId === ownedRun.taskId &&
                session.nodeId === peer.nodeId &&
                (session.workspaceId
                  ? peer.managedAccess ||
                    peer.workspaces.includes(session.workspaceId)
                  : !!context.projectContext &&
                    !context.workspaceId &&
                    !context.workspaceConstraint),
            ),
          };
          break;
        }
        case "selectTaskSession":
          insist(ledger.selectTaskSession, "TASK_SESSIONS_UNSUPPORTED", 503);
          result = await ledger.selectTaskSession(commandId, {
            ...lease(p, peer.nodeId),
            session: p.session as unknown as TaskSessionChoice["session"],
            ...(p.expectedTaskSessionId !== undefined
              ? {
                  expectedTaskSessionId: p.expectedTaskSessionId as
                    | string
                    | null,
                }
              : {}),
            ...(p.workspaceId ? { workspaceId: String(p.workspaceId) } : {}),
            ...(p.decision ? { decision: p.decision } : {}),
          });
          break;
        case "heartbeat": {
          insist(ledger.recordNodeHeartbeat, "HEARTBEAT_UNSUPPORTED", 503);
          if (p.workspaces !== undefined) {
            insist(
              ledger.recordExecutorWorkspaces,
              "WORKSPACE_CATALOG_UNSUPPORTED",
              503,
            );
            await ledger.recordExecutorWorkspaces(`${commandId}:workspaces`, {
              nodeId: peer.nodeId,
              sampledAt: Number(p.sampledAt),
              workspaces: executorWorkspaces(p.workspaces, peer.nodeId),
            });
          }
          result = await ledger.recordNodeHeartbeat(commandId, {
            nodeId: peer.nodeId,
            sampledAt: Number(p.sampledAt),
            runtimeReady: p.runtimeReady as boolean,
            activeExecutions: Number(p.activeExecutions),
            ...(p.providerStatus !== undefined
              ? { providerStatus: p.providerStatus }
              : {}),
          });
          break;
        }
        case "nodeStatus": {
          insist(ledger.nodeStatuses, "NODE_STATUS_UNSUPPORTED", 503);
          const status = (await ledger.nodeStatuses()).find(
            (node) => node.nodeId === peer.nodeId,
          );
          insist(status, "REGISTERED_NODE_REQUIRED", 403);
          result = status;
          break;
        }
        // Leave room for receipt/envelope metadata; the ledger rejects an oversized
        // claim before committing its lease. Payload validation forbids peer overrides.
        case "claim":
          result = await ledger.claim(commandId, {
            runId: id(p, "runId"),
            nodeId: peer.nodeId,
            ttlMs: ttl(p),
            maxClaimBytes: Math.max(
              1024,
              this.options.maxResponseBytes! - 4096,
            ),
          });
          break;
        case "renew":
          result = await ledger.renew(commandId, {
            ...lease(p, peer.nodeId),
            ttlMs: ttl(p),
            ...(p.progress
              ? {
                  progress: p.progress as {
                    requestId: string;
                    summary: string;
                  },
                }
              : {}),
          });
          break;
        case "submit":
          result = await ledger.submit(commandId, {
            ...lease(p, peer.nodeId),
            outcome: p.outcome as Settlement["outcome"],
            summary: String(p.summary),
            ...(p.report
              ? { report: p.report as unknown as Settlement["report"] }
              : {}),
            ...(p.resultValidationFailure
              ? {
                  resultValidationFailure:
                    p.resultValidationFailure as unknown as Settlement["resultValidationFailure"],
                }
              : {}),
            ...(p.preDispatchFailure
              ? {
                  preDispatchFailure:
                    p.preDispatchFailure as unknown as Settlement["preDispatchFailure"],
                }
              : {}),
          });
          break;
        case "cancel": {
          const run = await ledger.getRun(id(p, "runId"));
          insist(run, "RUN_NOT_FOUND", 404);
          result = await ledger.cancel(commandId, {
            taskId: run.taskId,
            runId: run.runId,
            reason: String(p.reason),
          });
          break;
        }
        case "receipt": {
          const receipt = store.receipt(peer.nodeId, id(p, "commandId"));
          result = receipt ? await this.reconcile(peer.nodeId, receipt) : null;
          break;
        }
        case "getRun":
          result = await ledger.getRun(id(p, "runId"));
          break;
        case "getAttempt":
          result = await ledger.getAttempt(id(p, "attemptId"));
          break;
        case "bindSession":
          result = await ledger.bindSession(commandId, {
            ...lease(p, peer.nodeId),
            sessionId: id(p, "sessionId"),
          });
          break;
        case "offerApproval": {
          insist(ledger.offerApproval, "APPROVAL_BRIDGE_UNSUPPORTED", 503);
          const { runId, attemptId, fence, executionId, ...offer } = p;
          result = await ledger.offerApproval(commandId, {
            ...lease(p, peer.nodeId),
            ...(offer as unknown as ApprovalOffer),
          });
          break;
        }
        case "approvalStatus":
          insist(ledger.approvalStatus, "APPROVAL_BRIDGE_UNSUPPORTED", 503);
          result = await ledger.approvalStatus({
            ...lease(p, peer.nodeId),
            requestId: id(p, "requestId"),
          });
          break;
        case "cancelApproval":
          insist(ledger.cancelApproval, "APPROVAL_BRIDGE_UNSUPPORTED", 503);
          result = await ledger.cancelApproval(commandId, {
            ...lease(p, peer.nodeId),
            requestId: id(p, "requestId"),
            reason: String(p.reason),
          });
          break;
        case "retryBeforeEffects":
          insist(ledger.retryBeforeEffects, "SAFE_RETRY_UNSUPPORTED", 503);
          result = await ledger.retryBeforeEffects(commandId, {
            ...lease(p, peer.nodeId),
            witness: p.witness as unknown as SafeRetryWitness,
            ...(p.allowRetry !== undefined
              ? { allowRetry: p.allowRetry as boolean }
              : {}),
          });
          break;
        case "markRunning":
          result = await ledger.markRunning(commandId, lease(p, peer.nodeId));
          break;
        case "acknowledgeCancellation":
          insist(
            ledger.acknowledgeCancellation,
            "CANCELLATION_ACK_UNSUPPORTED",
          );
          result = await ledger.acknowledgeCancellation(
            commandId,
            lease(p, peer.nodeId),
          );
          break;
        case "delegate": {
          insist(ledger.delegateTask, "COLLABORATION_UNSUPPORTED", 503);
          const { runId, attemptId, fence, executionId, ...input } = p;
          result = await ledger.delegateTask(commandId, {
            ...lease(p, peer.nodeId),
            ...(input as unknown as DelegationInput),
          });
          break;
        }
        case "taskHistory":
          insist(ledger.scopedHistory, "COLLABORATION_UNSUPPORTED", 503);
          result = await ledger.scopedHistory({
            ...lease(p, peer.nodeId),
            ...(p.targetTaskId !== undefined
              ? { taskId: String(p.targetTaskId) }
              : {}),
          });
          break;
        case "taskWait":
          insist(ledger.scopedAllSettled, "COLLABORATION_UNSUPPORTED", 503);
          result = await ledger.scopedAllSettled({
            ...lease(p, peer.nodeId),
            ...(p.targetTaskId !== undefined
              ? { taskId: String(p.targetTaskId) }
              : {}),
            ...(p.quietMs !== undefined ? { quietMs: Number(p.quietMs) } : {}),
          });
          break;
        case "taskNote":
          insist(ledger.queueScopedNote, "COLLABORATION_UNSUPPORTED", 503);
          result = await ledger.queueScopedNote(commandId, {
            ...lease(p, peer.nodeId),
            body: String(p.body),
            ...(p.targetTaskId !== undefined
              ? { taskId: String(p.targetTaskId) }
              : {}),
          });
          break;
        case "taskReport": {
          insist(ledger.appendScopedReport, "COLLABORATION_UNSUPPORTED", 503);
          const {
            runId,
            attemptId,
            fence,
            executionId,
            targetTaskId,
            ...report
          } = p;
          result = await ledger.appendScopedReport(commandId, {
            ...lease(p, peer.nodeId),
            ...(report as unknown as Omit<TaskReportInput, "targetTaskId">),
            ...(targetTaskId !== undefined
              ? { taskId: String(targetTaskId) }
              : {}),
          });
          break;
        }
        case "listWork": {
          const runs = await ledger.pendingRuns(peer.nodeId);
          if (!peer.managedAccess && ledger.reportAdmission)
            for (const run of runs) {
              if (run.route?.nodeId !== peer.nodeId || !run.updatedAt) continue;
              const code =
                run.route.workspaceId &&
                !peer.workspaces.includes(run.route.workspaceId)
                  ? "WORKSPACE_BINDING_REQUIRED"
                  : !run.route.requiredCapabilities.every((cap) =>
                        peer.capabilities.includes(cap),
                      )
                    ? "CAPABILITY_REQUIRED"
                    : undefined;
              if (code)
                await ledger.reportAdmission(
                  `gateway-admission:${digest([peer.nodeId, run.runId, run.updatedAt, code])}`,
                  {
                    runId: run.runId,
                    nodeId: peer.nodeId,
                    expectedUpdatedAt: run.updatedAt,
                    routeDigest: digest(run.route),
                    code,
                  },
                );
            }
          result = runs
            .filter(
              (run) =>
                !run.historyOnly &&
                !run.observationOnly &&
                run.route?.nodeId === peer.nodeId &&
                (run.route.workspaceId
                  ? peer.managedAccess ||
                    peer.workspaces.includes(run.route.workspaceId)
                  : !!run.projectContext && !run.workspaceConstraint) &&
                (peer.managedAccess ||
                  run.route.requiredCapabilities.every((cap) =>
                    peer.capabilities.includes(cap),
                  )),
            )
            .slice(0, 32);
          break;
        }
        case "observe": {
          insist(
            ledger.captureObservation,
            "OBSERVATION_INTAKE_UNSUPPORTED",
            503,
          );
          const sessionId = id(p, "sessionId");
          const workspaceId = id(p, "workspaceId");
          // Never accept a source/principal/task/run identity from the peer.
          // The tuple digest prevents delimiter ambiguity across node namespaces.
          const sourceId = `remote-dsh:${peer.nodeId}:${workspaceId}:${digest([peer.nodeId, workspaceId, sessionId])}`;
          result = await ledger.captureObservation(commandId, {
            seq: 0,
            sourceId,
            sessionId,
            sourceRevision: String(p.sourceRevision),
            title: String(p.title),
            body: String(p.body),
            observedAt: String(p.observedAt),
            truncated: p.truncated as boolean,
          });
          break;
        }
      }
      if (envelope.operation === "projectCollaborate") {
        const durable = {
          commandId,
          acceptedAt: new Date().toISOString(),
          value: result,
        };
        if (old?.state === "uncertain")
          return store.resolve(
            peer.nodeId,
            envelope.commandId,
            durable,
            this.options.maxResponseBytes,
          );
        result = durable;
      }
      const json = JSON.parse(JSON.stringify(result)) as Json;
      canonical(json);
      const receipt = this.bounded({
        commandId: envelope.commandId,
        state: "done",
        result: json,
      });
      store.complete(
        peer.nodeId,
        envelope.commandId,
        json,
        this.options.maxResponseBytes,
      );
      return receipt;
    } catch (error) {
      if (
        envelope.operation === "executionModelView" &&
        error instanceof ProtocolError
      ) {
        const result = { catalogError: { code: error.code } };
        store.complete(
          peer.nodeId,
          envelope.commandId,
          result,
          this.options.maxResponseBytes,
        );
        return { commandId: envelope.commandId, state: "done", result };
      }
      if (
        envelope.operation === "projectCollaborate" &&
        (error instanceof TaskError || error instanceof ProtocolError)
      ) {
        const durable = {
          commandId,
          acceptedAt: new Date().toISOString(),
          value: {
            collaborationError: { code: error.code, message: error.message },
          },
        };
        if (old?.state === "uncertain")
          return store.resolve(
            peer.nodeId,
            envelope.commandId,
            durable,
            this.options.maxResponseBytes,
          );
        const result = JSON.parse(JSON.stringify(durable)) as Json;
        store.complete(
          peer.nodeId,
          envelope.commandId,
          result,
          this.options.maxResponseBytes,
        );
        return { commandId: envelope.commandId, state: "done", result };
      }
      // An arbitrary adapter exception is not proof that its transaction failed.
      store.uncertain(peer.nodeId, envelope.commandId);
      return { commandId: envelope.commandId, state: "uncertain" };
    }
  }
  private async reconcile(
    nodeId: string,
    receipt: CommandReceipt,
    operation?: import("./protocol.js").Operation,
  ): Promise<CommandReceipt> {
    if (receipt.state !== "uncertain" || !this.options.ledger.commandReceipt)
      return receipt;
    try {
      const durable = await this.options.ledger.commandReceipt(
        `remote-${digest([nodeId, receipt.commandId])}`,
      );
      return durable
        ? this.options.store.resolve(
            nodeId,
            receipt.commandId,
            operation === "completeExecutionModels"
              ? { ...durable, value: { accepted: true } }
              : durable,
            this.options.maxResponseBytes,
          )
        : receipt;
    } catch {
      return receipt;
    } // Missing or mismatched proof cannot authorize a retry.
  }
  private async authorize(
    e: CommandEnvelope,
    peer: AuthorizedPeer,
    requireLive: boolean,
  ): Promise<void> {
    if (e.operation === "sessionMessages") return;
    if (e.operation === "sessionMessageReply") {
      insist(
        this.options.ledger.getSessionMessage,
        "SESSION_MESSAGES_UNSUPPORTED",
        503,
      );
      const m = await this.options.ledger.getSessionMessage(
        String(e.payload.messageId),
      );
      insist(
        m.nodeId === peer.nodeId &&
          (peer.managedAccess || peer.workspaces.includes(m.workspaceId)),
        "SESSION_MESSAGE_DENIED",
        403,
      );
      return;
    }
    if (e.operation === "receipt" || e.operation === "listWork") return;
    if (
      e.operation === "heartbeat" ||
      e.operation === "nodeStatus" ||
      e.operation === "executorIdentity" ||
      e.operation === "projectSnapshot" ||
      e.operation === "projectCollaborate" ||
      e.operation === "executionModelView" ||
      e.operation === "reportAdmission" ||
      e.operation === "executionModelRequests" ||
      e.operation === "completeExecutionModels"
    ) {
      insist(this.options.ledger.nodeStatuses, "NODE_STATUS_UNSUPPORTED", 503);
      if (e.operation === "heartbeat" && e.payload.workspaces !== undefined) {
        const workspaces = executorWorkspaces(
          e.payload.workspaces,
          peer.nodeId,
        );
        insist(
          peer.managedAccess ||
            workspaces.every((workspace) =>
              peer.workspaces.includes(workspace.workspaceId),
            ),
          "WORKSPACE_CATALOG_DENIED",
          403,
        );
        insist(
          this.options.ledger.recordExecutorWorkspaces,
          "WORKSPACE_CATALOG_UNSUPPORTED",
          503,
        );
      }
      const status = (await this.options.ledger.nodeStatuses()).find(
        (node) => node.nodeId === peer.nodeId,
      );
      if (
        !status &&
        peer.managedAccess &&
        ["heartbeat", "executorIdentity"].includes(e.operation)
      )
        return;
      insist(status, "REGISTERED_NODE_REQUIRED", 403);
      if (e.operation === "reportAdmission") {
        const run = await this.options.ledger.getRun?.(String(e.payload.runId));
        insist(run?.route?.nodeId === peer.nodeId, "ASSIGNMENT_DENIED", 403);
      }
      if (e.operation === "heartbeat") {
        insist(
          this.options.ledger.recordNodeHeartbeat,
          "HEARTBEAT_UNSUPPORTED",
          503,
        );
        if (requireLive)
          insist(
            Number(e.payload.sampledAt) >= e.issuedAt - 60000 &&
              Number(e.payload.sampledAt) <= e.issuedAt + 5000,
            "STALE_HEARTBEAT_SAMPLE",
            401,
          );
      }
      return;
    }
    if (e.operation === "observe") {
      const ownedWorkspace = peer.managedAccess
        ? await this.options.ledger.getWorkspace?.(
            String(e.payload.workspaceId),
          )
        : null;
      insist(
        peer.managedAccess
          ? ownedWorkspace?.nodeId === peer.nodeId
          : peer.workspaces.includes(String(e.payload.workspaceId)),
        "WORKSPACE_DENIED",
        403,
      );
      insist(
        this.options.ledger.captureObservation,
        "OBSERVATION_INTAKE_UNSUPPORTED",
        503,
      );
      return;
    }
    if (e.operation === "cancelApproval") {
      // Cleanup cannot grant an action. The core checks the request's exact old ref,
      // even when that attempt has expired or its run was subsequently rerouted.
      const attempt = await this.options.ledger.getAttempt(
        String(e.payload.attemptId),
      );
      insist(
        attempt &&
          attempt.nodeId === peer.nodeId &&
          attempt.runId === e.payload.runId &&
          attempt.fence === e.payload.fence &&
          attempt.executionId === e.payload.executionId,
        "APPROVAL_OWNER_DENIED",
        403,
      );
      insist(
        this.options.ledger.cancelApproval,
        "APPROVAL_BRIDGE_UNSUPPORTED",
        503,
      );
      return;
    }
    if (
      e.operation === "selectTaskSession" &&
      e.payload.workspaceId !== undefined
    )
      insist(
        peer.managedAccess ||
          peer.workspaces.includes(String(e.payload.workspaceId)),
        "WORKSPACE_DENIED",
        403,
      );
    const inspectedAttempt =
      e.operation === "getAttempt"
        ? await this.options.ledger.getAttempt(String(e.payload.attemptId))
        : undefined;
    if (e.operation === "getAttempt")
      insist(inspectedAttempt?.nodeId === peer.nodeId, "ATTEMPT_DENIED", 403);
    const run = await this.options.ledger.getRun(
      inspectedAttempt?.runId ?? String(e.payload.runId),
    );
    insist(run?.route, "ROUTED_RUN_REQUIRED", 404);
    if (e.operation === "claim" && run.projectContext)
      insist(
        e.payload.projectContextVersion === 1,
        "PROJECT_CONTEXT_UPGRADE_REQUIRED",
        409,
      );
    if (
      [
        "claim",
        "renew",
        "bindSession",
        "markRunning",
        "submit",
        "acknowledgeCancellation",
        "cancel",
        "retryBeforeEffects",
        ...collaborationOps,
      ].includes(e.operation)
    )
      insist(!run.historyOnly && !run.observationOnly, "OBSERVE_ONLY", 403);
    // Peer cancellation is scoped to that peer's own assigned node. Coordinator
    // operator cancellation uses the trusted ledger API, never a peer role claim.
    insist(run.route.nodeId === peer.nodeId, "NODE_ROUTE_DENIED", 403);
    const workspace = run.route.workspaceId;
    insist(
      workspace
        ? peer.managedAccess || peer.workspaces.includes(workspace)
        : !!run.projectContext && !run.workspaceConstraint,
      "WORKSPACE_DENIED",
      403,
    );
    insist(
      peer.managedAccess ||
        run.route.requiredCapabilities.every((cap) =>
          peer.capabilities.includes(cap),
        ),
      "CAPABILITY_DENIED",
      403,
    );
    if (
      [
        "sessionContext",
        "selectTaskSession",
        "submit",
        "renew",
        "bindSession",
        "markRunning",
        "acknowledgeCancellation",
        "retryBeforeEffects",
        ...collaborationOps,
      ].includes(e.operation)
    ) {
      const attempt = await this.options.ledger.getAttempt(
        String(e.payload.attemptId),
      );
      insist(
        attempt &&
          attempt.nodeId === peer.nodeId &&
          attempt.runId === run.runId &&
          attempt.fence === e.payload.fence,
        "ATTEMPT_DENIED",
        403,
      );
      if (e.operation === "offerApproval") {
        insist(
          attempt.sessionId && attempt.sessionId === e.payload.sessionId,
          "APPROVAL_SESSION_DENIED",
          403,
        );
        if (requireLive)
          insist(
            Number(e.payload.expiresAt) > (this.options.now ?? Date.now)() &&
              Number(e.payload.expiresAt) <=
                (this.options.now ?? Date.now)() + 300000,
            "INVALID_APPROVAL_EXPIRY",
          );
      }
      if (e.operation === "retryBeforeEffects") {
        insist(attempt.sessionId, "BOUND_SESSION_REQUIRED", 403);
        validateRetryWitness(e.payload.witness, attempt.sessionId);
      }
      insist(
        attempt.executionId === undefined ||
          attempt.executionId === e.payload.executionId,
        "EXECUTION_OWNER_DENIED",
        403,
      );
      if (requireLive && e.operation !== "acknowledgeCancellation") {
        insist(
          ["leased", "running"].includes(attempt.state) &&
            Date.parse(attempt.leaseExpiresAt) >
              (this.options.now ?? Date.now)(),
          "LEASE_EXPIRED",
          409,
        );
        insist(!run.cancellationRequested, "CANCELLATION_REQUESTED", 409);
      }
    }
  }
  async dispose(): Promise<void> {
    this.active = false;
    await Promise.allSettled([...this.pending]);
  }
}
