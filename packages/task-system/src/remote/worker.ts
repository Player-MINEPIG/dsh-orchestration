import { acquireWorkspaceExecution } from "../workspace-execution-lock.js";
import { randomUUID } from "node:crypto";
import { SessionMessages } from "./session-messages.js";
import { chooseExecutionSession } from "../execution-session.js";
import {
  byteLimit,
  canonical,
  canonicalData,
  digest,
  insist,
  isRecord,
  validatePreDispatchFailure,
  validateResultValidationFailure,
} from "./protocol.js";
import { resolvedClaimContext } from "./context.js";
import { authorizedWorkspace } from "./policy.js";
import { executionWorkspace } from "./project-workspace.js";
import { bindCollaboration } from "./collaboration.js";
import { validateRetryWitness } from "./retry.js";
import type {
  TaskSessionChoice,
  TaskSessionContext,
  Claim,
  ExecutionProvider,
  ExecutionResult,
  LedgerPort,
  LeaseRef,
  WorkerPolicy,
} from "./ports.js";
import type { DispatchRecord, RecoveryStore } from "./store.js";

export interface WorkerOptions {
  deliverTaskReturns?: boolean;
  ledger: LedgerPort;
  provider: ExecutionProvider;
  store: RecoveryStore;
  policy: WorkerPolicy;
  ttlMs?: number;
  maxResultBytes?: number;
  now?: () => number;
  taskSessions?: boolean;
  prepare?: () => Promise<void>;
  observeDispositions?: () => Promise<void>;
  prepareForWork?: (
    runs: readonly import("./ports.js").Run[],
  ) => Promise<boolean>;
  projectRoot?: () => string | null | undefined;
  modelAdmission?: (
    route: import("./ports.js").Route,
  ) => "MODEL_UNAVAILABLE" | "BACKEND_UNAVAILABLE" | undefined;
  chooseSession?: (
    claim: Claim,
    context: TaskSessionContext,
    signal: AbortSignal,
    refresh: () => Promise<TaskSessionContext>,
  ) => Promise<TaskSessionChoice>;
}
export class ExecutorWorker {
  private options: WorkerOptions;
  private messages: SessionMessages;
  private active = true;
  private configurationPaused = false;
  private executing = 0;
  private concurrencyBudget?: number;
  get activeExecutions(): number {
    return this.executing + this.messages.activeCount;
  }
  private runs = new Map<
    string,
    { abort: AbortController; done: Promise<DispatchRecord> }
  >();
  private pollingTimer?: ReturnType<typeof setInterval>;
  private polling?: Promise<unknown>;
  lastPollFailed = false;
  queueObservedAt: string | null = null;
  private observedQueue: import("./ports.js").Run[] = [];
  private projectRuns = new Map<
    string,
    { key: string; parentRunId?: string }
  >();
  private projectKey(run: import("./ports.js").Run): string | undefined {
    const context = run.projectContext;
    return context
      ? digest([context.schedulerId, context.project?.projectId ?? null])
      : undefined;
  }
  private canEnterProject(
    run: import("./ports.js").Run,
    held = this.projectRuns,
  ): boolean {
    const key = this.projectKey(run);
    if (!key || ![...held.values()].some((value) => value.key === key))
      return true;
    // Only a currently owned parent may reenter this project's lock. Each child
    // gets a distinct workspace/session; unrelated root work remains serialized.
    return !!run.parentRunId && held.get(run.parentRunId)?.key === key;
  }
  isExecuting(runId:string) {return this.runs.has(runId);}
  queueSnapshot() {
    return this.observedQueue.map((run) => ({ ...run }));
  }
  constructor(options: WorkerOptions) {
    this.options = {
      ...options,
      maxResultBytes: byteLimit(options.maxResultBytes, 60000),
    };
    this.messages = new SessionMessages(this.options);
    insist(options.policy.role !== "planner", "EXECUTOR_ROLE_REQUIRED", 403);
    const ttl = options.ttlMs ?? 60000;
    insist(
      Number.isSafeInteger(ttl) && ttl >= 1000 && ttl <= 300000,
      "INVALID_TTL",
    );
  }
  async beginConfigurationEdit(): Promise<() => void> {
    insist(
      !this.configurationPaused &&
        this.runs.size === 0 &&
        !this.messages.activeCount,
      "CONFIGURATION_BUSY",
      409,
    );
    this.configurationPaused = true;
    try {
      await this.polling;
      insist(
        this.active && this.runs.size === 0 && !this.messages.activeCount,
        "CONFIGURATION_BUSY",
        409,
      );
      return () => {
        this.configurationPaused = false;
      };
    } catch (error) {
      this.configurationPaused = false;
      throw error;
    }
  }
  execute(runId: string, commandId: string): Promise<DispatchRecord> {
    insist(this.active, "DRAINING", 503);
    insist(!this.configurationPaused, "CONFIGURATION_BUSY", 409);
    insist(!this.runs.has(runId), "RUN_ALREADY_ACTIVE", 409);
    const abort = new AbortController();
    const done = this.executeOwned(runId, commandId, abort).finally(() => {
      this.runs.delete(runId);
      this.projectRuns.delete(runId);
    });
    this.runs.set(runId, { abort, done });
    return done;
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  /** One bounded discovery/dispatch pass; caller supplies or configures its cadence. */
  async pollOnce(
    concurrency = 1,
    options: { waitForCompletion?: boolean } = {},
  ): Promise<PromiseSettledResult<DispatchRecord>[]> {
    insist(this.active, "DRAINING", 503);
    if (this.configurationPaused) return [];
    insist(
      Number.isSafeInteger(concurrency) &&
        concurrency >= 1 &&
        concurrency <= 16,
      "INVALID_CONCURRENCY",
    );
    this.concurrencyBudget = concurrency;
    // Delivery can fail after execution has already finished. Retry the durable
    // result on ordinary polling as well as startup, using the same command ID.
    for (const record of this.options.store.dispatches()) {
      if (record.state === "result" && !this.runs.has(record.lease.runId))
        await this.deliver(record);
    }
    await this.reconcileUncertain();
    await this.options.observeDispositions?.().catch(()=>{});
    if (this.configurationPaused || !this.active) return [];
    await this.messages
      .poll(
        Math.max(0, concurrency - this.runs.size),
        () => !this.configurationPaused && this.active,
      )
      .catch(() => {});
    if (this.configurationPaused || !this.active) return [];
    const pending = await this.options.ledger.pendingRuns(
      this.options.policy.nodeId,
    );
    this.observedQueue = pending.slice(0, 128);
    this.queueObservedAt = new Date(this.now()).toISOString();
    if (
      pending.length &&
      this.options.prepareForWork &&
      !(await this.options.prepareForWork(pending))
    )
      return [];
    if (this.configurationPaused || !this.active) return [];
    const { policy, provider } = this.options;
    const denied = new Set<string>();
    for (const run of pending) {
      const route = run.route;
      if (
        !route ||
        route.nodeId !== policy.nodeId ||
        run.state !== "queued" ||
        run.historyOnly ||
        run.observationOnly ||
        run.currentAttemptId
      )
        continue;
      let code: import("../execution-models.js").AdmissionReport["code"] =
        !route.requiredCapabilities.every(
          (cap) =>
            policy.capabilities.includes(cap) &&
            provider.capabilities.includes(cap),
        )
          ? "CAPABILITY_REQUIRED"
          : route.workspaceId &&
              !policy.workspaces.some(
                (workspace) =>
                  workspace.nodeId === policy.nodeId &&
                  workspace.workspaceId === route.workspaceId,
              )
            ? "WORKSPACE_BINDING_REQUIRED"
            : !route.workspaceId &&
                run.projectContext &&
                !this.options.projectRoot?.()
              ? "EXECUTION_ROOT_REQUIRED"
              : !provider.supports(route)
                ? this.options.modelAdmission
                  ? (this.options.modelAdmission(route) ?? "READY")
                  : route.backend
                    ? "BACKEND_UNAVAILABLE"
                    : "MODEL_UNAVAILABLE"
                : "READY";
      if (code !== "READY") denied.add(run.runId);
      if (
        this.options.ledger.reportAdmission &&
        run.updatedAt &&
        (code !== "READY" || run.dispatchIssue?.source === "executor")
      ) {
        try {
          await this.options.ledger.reportAdmission(
            `admission:${digest([run.runId, run.updatedAt, route, code])}`,
            {
              runId: run.runId,
              nodeId: policy.nodeId,
              expectedUpdatedAt: run.updatedAt,
              routeDigest: digest(route),
              code,
            },
          );
          if (code === "READY") {
            const current = await this.options.ledger.getRun?.(run.runId);
            if (
              !current ||
              current.state !== "queued" ||
              current.dispatchIssue ||
              digest(current.route) !== digest(route)
            )
              denied.add(run.runId);
          }
        } catch {
          denied.add(run.runId);
        }
      }
    }
    const plannedProjects = new Map(this.projectRuns);
    const candidates = pending
      .filter((run) => {
        const route = run.route;
        return (
          !denied.has(run.runId) &&
          !run.historyOnly &&
          !run.observationOnly &&
          (!run.retry || Date.parse(run.retry.notBefore) <= this.now()) &&
          run.state === "queued" &&
          route?.nodeId === policy.nodeId &&
          provider.supports(route) &&
          route.requiredCapabilities.every(
            (cap) =>
              policy.capabilities.includes(cap) &&
              provider.capabilities.includes(cap),
          ) &&
          (policy.workspaces.some(
            (workspace) =>
              workspace.nodeId === policy.nodeId &&
              workspace.workspaceId === route.workspaceId,
          ) ||
            (!!run.projectContext &&
              !route.workspaceId &&
              !!this.options.projectRoot?.())) &&
          !this.runs.has(run.runId)
        );
      })
      .filter((run) => {
        if (!this.canEnterProject(run, plannedProjects)) return false;
        const key = this.projectKey(run);
        if (key)
          plannedProjects.set(run.runId, { key, parentRunId: run.parentRunId });
        return true;
      })
      .slice(
        0,
        Math.max(0, concurrency - this.runs.size - this.messages.activeCount),
      );
    const executions = candidates.map((run) =>
      this.execute(
        run.runId,
        `claim-${digest([this.options.policy.nodeId, run.runId, run.retry?.count ?? 0])}`,
      ),
    );
    const completion = Promise.allSettled(executions);
    if (options.waitForCompletion === false) {
      // `runs` owns every promise through cancellation and dispose. Discovery
      // may continue while a parent awaits descendants; execution is not detached.
      void completion.then((results) => {
        if (results.some((result) => result.status === "rejected"))
          this.lastPollFailed = true;
      });
      return [];
    }
    return await completion;
  }

  startPolling(
    intervalMs: number | (() => number),
    concurrency: number | (() => number) = 1,
  ): void {
    insist(this.active && !this.pollingTimer, "POLLING_ALREADY_STARTED", 409);
    const readInterval = () =>
      typeof intervalMs === "function" ? intervalMs() : intervalMs;
    const readConcurrency = () =>
      typeof concurrency === "function" ? concurrency() : concurrency;
    const initialInterval = readInterval(),
      initialConcurrency = readConcurrency();
    insist(
      Number.isSafeInteger(initialInterval) &&
        (initialInterval >= 100 ||
          (initialInterval === 0 && typeof intervalMs === "function")) &&
        initialInterval <= 3600000,
      "INVALID_POLL_INTERVAL",
    );
    insist(
      Number.isSafeInteger(initialConcurrency) &&
        initialConcurrency >= 1 &&
        initialConcurrency <= 16,
      "INVALID_CONCURRENCY",
    );
    let lastPoll = 0;
    let recovered = false;
    const tick = (): void => {
      const cadence = readInterval();
      if (
        !cadence ||
        this.now() - lastPoll < cadence ||
        this.polling ||
        !this.active ||
        this.configurationPaused
      )
        return;
      lastPoll = this.now();
      this.polling = (async () => {
        if (!recovered) {
          await this.recoverResults();
          recovered = true;
        }
        if (!this.active) return [];
        return await this.pollOnce(readConcurrency(), {
          waitForCompletion: false,
        });
      })()
        .then(
          (results) => {
            this.lastPollFailed = results.some(
              (result) => result.status === "rejected",
            );
          },
          () => {
            this.lastPollFailed = true;
          },
        )
        .finally(() => {
          this.polling = undefined;
        });
    };
    this.pollingTimer = setInterval(
      tick,
      typeof intervalMs === "function" ? 100 : intervalMs,
    );
    tick();
  }
  private async executeOwned(
    runId: string,
    commandId: string,
    abort: AbortController,
  ): Promise<DispatchRecord> {
    const { ledger, provider, store, policy } = this.options;
    await this.options.prepare?.();
    const pending = await ledger.getRun?.(runId);
    if (pending?.projectContext) {
      insist(this.canEnterProject(pending), "PROJECT_WORKSPACE_BUSY", 409);
      this.projectRuns.set(runId, {
        key: this.projectKey(pending)!,
        parentRunId: pending.parentRunId,
      });
    }
    const claim = (
      await ledger.claim(commandId, {
        runId,
        nodeId: policy.nodeId,
        ttlMs: this.options.ttlMs ?? 60000,
        ...(pending?.projectContext
          ? { projectContextVersion: 1 as const }
          : {}),
      })
    ).value;
    this.observedQueue = this.observedQueue.filter(
      (run) => run.runId !== runId,
    );
    insist(
      !claim.run.historyOnly && !claim.run.observationOnly,
      "OBSERVE_ONLY",
      403,
    );
    claim.executionContext = resolvedClaimContext(claim);
    const project = claim.run.projectContext;
    const existing = store.dispatch(claim.attempt.attemptId);
    if (existing)
      return existing.state === "result"
        ? await this.deliver(existing)
        : existing.state === "retry_pending"
          ? await this.requestRetry(existing)
          : existing;
    let workspacePath = await authorizedWorkspace(
      claim,
      policy,
      provider,
      this.options.projectRoot?.(),
    );
    insist(
      Date.parse(claim.attempt.leaseExpiresAt) > this.now(),
      "LEASE_EXPIRED",
      409,
    );
    const executionId = store.executionId(claim.attempt.attemptId);
    const lease: LeaseRef = {
      runId,
      attemptId: claim.attempt.attemptId,
      nodeId: policy.nodeId,
      fence: claim.attempt.fence,
      executionId,
    };
    let sessionId =
      claim.run.retry?.sessionId ??
      `task-${digest([runId, claim.attempt.attemptId]).slice(0, 40)}`;
    if (claim.run.retry)
      insist(
        claim.attempt.sessionId === sessionId &&
          Date.parse(claim.run.retry.notBefore) <= this.now(),
        "INVALID_RETRY_CONTINUATION",
        409,
      );
    const record: DispatchRecord = {
      attemptId: claim.attempt.attemptId,
      state: "dispatching",
      claim,
      lease,
      sessionId,
    };
    // Both local and remote work cross this commit; no fast path around the fence.
    insist(store.createDispatch(record), "DISPATCH_ALREADY_EXISTS", 409);
    let renewal: Promise<void> | undefined;
    let renewalError = false;
    let selectingSession = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let expiresAt = Date.parse(claim.attempt.leaseExpiresAt);
    let progressReply: { requestId: string; summary: string } | undefined;
    const armExpiry = (): void => {
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = setTimeout(
        () => {
          renewalError = true;
          abort.abort(new Error("Lease expired"));
        },
        Math.max(1, expiresAt - this.now()),
      );
    };
    const scheduleRenewal = (): void => {
      timer = setTimeout(
        () => {
          renewal = (async () => {
            try {
              const receipt = await ledger.renew(
                `renew-${digest([executionId, expiresAt])}`,
                { ...lease, ttlMs: this.options.ttlMs ?? 60000 },
              );
              expiresAt = Date.parse(receipt.value.leaseExpiresAt);
              insist(expiresAt > this.now(), "LEASE_EXPIRED", 409);
              if (!abort.signal.aborted) {
                armExpiry();
                const request = receipt.value.progressRequest;
                if (request && !request.summary) {
                  try {
                    if (progressReply?.requestId !== request.requestId)
                      progressReply = {
                        requestId: request.requestId,
                        summary: (
                          provider.status?.(lease) ??
                          "执行端仍在执行该任务；当前执行器未提供更细的步骤状态。"
                        ).slice(0, 1000),
                      };
                    const reported = await ledger.renew(
                      `progress-${digest([executionId, request.requestId])}`,
                      {
                        ...lease,
                        ttlMs: this.options.ttlMs ?? 60000,
                        progress: progressReply,
                      },
                    );
                    expiresAt = Math.max(
                      expiresAt,
                      Date.parse(reported.value.leaseExpiresAt),
                    );
                    if (!abort.signal.aborted) armExpiry();
                  } catch {
                    /* Status delivery failure must not revoke a successfully renewed lease. */
                  }
                }
                if (!abort.signal.aborted) scheduleRenewal();
              }
            } catch {
              renewalError = true;
              abort.abort(
                new Error("Lease renewal failed; execution authority lost"),
              );
            }
          })();
        },
        Math.max(1, Math.floor((expiresAt - this.now()) / 3)),
      );
    };
    try {
      try {
        // Bind one execution owner before session creation or provider effects.
        // Another recovery store cannot reuse this owner's idempotency identity.
        claim.attempt = (
          await ledger.markRunning(`running-${executionId}`, lease)
        ).value;
        armExpiry();
        scheduleRenewal();
        let resumeSession = Boolean(claim.run.retry);
        let availableOperations: readonly string[] | undefined;
        if (project && claim.run.retry) {
          insist(
            ledger.sessionContext,
            "TASK_SESSION_CONNECTION_UPGRADE_REQUIRED",
            503,
          );
          const context = await ledger.sessionContext(lease);
          availableOperations = context.availableOperations;
          insist(
            context.schedulerId === project.schedulerId,
            "PROJECT_SCHEDULER_IDENTITY_MISMATCH",
            403,
          );
        }
        if (
          !claim.run.route?.execution &&
          (this.options.taskSessions || project) &&
          !claim.run.retry
        ) {
          selectingSession = true;
          insist(
            ledger.sessionContext && ledger.selectTaskSession,
            "TASK_SESSION_CONNECTION_UPGRADE_REQUIRED",
            503,
          );
          const refresh = async () => await ledger.sessionContext!(lease);
          const context = await refresh();
          availableOperations = context.availableOperations;
          insist(
            !project || project.schedulerId === context.schedulerId,
            "PROJECT_SCHEDULER_IDENTITY_MISMATCH",
            403,
          );
          const choice = this.options.chooseSession
            ? await this.options.chooseSession(
                claim,
                context,
                abort.signal,
                refresh,
              )
            : await chooseExecutionSession({
                claim,
                context,
                managedWorkspaceAvailable: !!this.options.projectRoot?.(),
                workspaces: policy.workspaces.map((workspace) => ({
                  ...workspace,
                  description: workspace.workspaceId,
                  eligible: true,
                })),
                signal: abort.signal,
                refresh,
              });
          const selected = (
            await ledger.selectTaskSession(`select-${executionId}`, {
              ...lease,
              ...choice,
            })
          ).value;
          insist(
            selected.schedulerId === context.schedulerId &&
              selected.nodeId === policy.nodeId &&
              selected.taskId === claim.task.taskId,
            "TASK_SESSION_IDENTITY_MISMATCH",
            403,
          );
          sessionId = selected.sessionId;
          resumeSession = selected.resume;
          claim.run = (await ledger.getRun(runId))!;
          claim.attempt = (await ledger.getAttempt(lease.attemptId))!;
          workspacePath = await authorizedWorkspace(
            claim,
            policy,
            provider,
            this.options.projectRoot?.(),
          );
          record.sessionId = sessionId;
          selectingSession = false;
        }
        store.saveDispatch(record);
        if (!claim.run.route?.execution)
          await ledger.bindSession(`session-${executionId}`, {
            ...lease,
            sessionId,
          });
        if (!claim.run.route?.execution)
          workspacePath = await executionWorkspace({
            parent: workspacePath,
            projectRoot: this.options.projectRoot?.(),
            claim,
            sessionId,
            resume: resumeSession,
            store,
          });
        record.workspacePath = workspacePath;
        store.saveDispatch(record);
        insist(
          this.active && !abort.signal.aborted && expiresAt > this.now(),
          "DISPATCH_CANCELLED",
          409,
        );
        const collaboration = bindCollaboration(
          ledger,
          lease,
          claim.task.taskId,
          abort.signal,
          availableOperations,
        );
        const delegate = collaboration.delegate;
        const boundedCollaboration = {
          ...collaboration,
          delegate: (id: string, input: Parameters<typeof delegate>[1]) => {
            const target = input.route?.nodeId ?? claim.run.route?.nodeId;
            if (
              target === policy.nodeId &&
              this.concurrencyBudget !== undefined &&
              this.runs.size + this.messages.activeCount >=
                this.concurrencyBudget
            )
              throw new Error(
                `RECURSIVE_CAPACITY_EXHAUSTED: executor concurrency ${this.concurrencyBudget} is occupied; no child was created. Increase the executor budget or delegate to another eligible node; waiting here cannot create capacity.`,
              );
            return delegate(id, input);
          },
        };
        const releaseWorkspace = await acquireWorkspaceExecution(
          workspacePath,
          abort.signal,
        );
        this.executing++;
        let result: ExecutionResult;
        try {
          result = await provider.execute({
            claim,
            sessionId,
            resumeSession,
            workspacePath,
            signal: abort.signal,
            collaboration: boundedCollaboration,
          });
        } finally {
          releaseWorkspace();
          this.executing--;
        }
        validateResult(result, this.options.maxResultBytes!);
        if (renewalError || abort.signal.aborted || expiresAt <= this.now()) {
          record.state = "uncertain";
          record.detail =
            "Provider returned after cancellation or lease loss; finalization authority not assumed";
          record.result = result;
        } else {
          record.result = result;
          if (result.retryWitness && ledger.retryBeforeEffects) {
            validateRetryWitness(result.retryWitness, sessionId);
            record.state = "retry_pending";
          } else record.state = "result";
        }
      } catch {
        record.state = "uncertain";
        record.detail = selectingSession
          ? "Task session negotiation was not accepted. Verify scheduler connection and explicit executorIdentity, sessionContext, selectTaskSession grants; no default-session fallback was executed."
          : "Execution or receipt failed after durable dispatch intent; no automatic replay";
      }
      store.saveDispatch(record);
      if (record.state === "uncertain" && ledger.acknowledgeCancellation) {
        try {
          if ((await ledger.getRun(runId))?.cancellationRequested) {
            record.state = "cancellation";
            record.detail =
              "Provider quiesced after coordinator cancellation; prior side effects may remain";
            store.saveDispatch(record);
            return await this.confirmCancellation(record);
          }
        } catch {
          /* Retain uncertainty when authoritative cancellation cannot be read. */
        }
      }
      return record.state === "result"
        ? await this.deliver(record, (renewedExpiry) => {
            expiresAt = renewedExpiry;
            if (!abort.signal.aborted) armExpiry();
          })
        : record.state === "retry_pending"
          ? await this.requestRetry(record)
          : record;
    } finally {
      if (timer) clearTimeout(timer);
      if (expiryTimer) clearTimeout(expiryTimer);
      abort.abort();
      this.projectRuns.delete(runId);
      if (renewal) await renewal;
      if (renewalError && record.state === "retry_pending") {
        record.state = "uncertain";
        record.detail = "Lease authority lost while result completed";
        store.saveDispatch(record);
      }
    }
  }
  /** Retry only the durable coordinator transition; never directly replay a provider. */
  async requestRetry(record: DispatchRecord): Promise<DispatchRecord> {
    insist(
      record.state === "retry_pending" && record.result?.retryWitness,
      "NO_DURABLE_RETRY_WITNESS",
      409,
    );
    const retry = this.options.ledger.retryBeforeEffects;
    insist(retry, "SAFE_RETRY_UNSUPPORTED", 503);
    validateResult(record.result, this.options.maxResultBytes!);
    validateRetryWitness(record.result.retryWitness, record.sessionId);
    try {
      const receipt = await retry.call(
        this.options.ledger,
        `retry-${record.lease.executionId ?? record.attemptId}`,
        {
          ...record.lease,
          witness: record.result.retryWitness,
          ...(record.result.retryAllowed !== undefined
            ? { allowRetry: record.result.retryAllowed }
            : {}),
        },
      );
      insist(
        ["queued", "failed"].includes(receipt.value.state),
        "INVALID_RETRY_RECEIPT",
      );
      record.receipt = receipt;
      record.state =
        receipt.value.state === "queued" ? "retry_scheduled" : "acknowledged";
      this.options.store.saveDispatch(record);
    } catch {
      /* Ambiguity retains the same witness and transition identity. */
    }
    return record;
  }
  /** Retry only a durably recorded result using its stable settlement identity. */
  async deliver(
    record: DispatchRecord,
    renewed?: (expiresAt: number) => void,
  ): Promise<DispatchRecord> {
    insist(
      record.state === "result" && record.result,
      "NO_DURABLE_RESULT",
      409,
    );
    const { ledger, store } = this.options;
    try {
      const receipt = await ledger.renew(`result-renew-${randomUUID()}`, {
        ...record.lease,
        ttlMs: this.options.ttlMs ?? 60000,
      });
      record.claim.attempt = receipt.value;
      renewed?.(Date.parse(receipt.value.leaseExpiresAt));
      store.saveDispatch(record);
    } catch {
      // The exact result may already have committed before its acknowledgment was lost.
    }
    try {
      record.receipt = await ledger.submit(
        `result-${record.lease.executionId ?? record.attemptId}`,
        { ...record.lease, ...record.result },
      );
      record.state = "acknowledged";
      store.saveDispatch(record);
    } catch {
      try {
        const run = await ledger.getRun(record.lease.runId);
        const attempt = await ledger.getAttempt(record.attemptId);
        const sameOwner =
          run &&
          attempt &&
          run.currentAttemptId === record.attemptId &&
          attempt.runId === record.lease.runId &&
          attempt.nodeId === record.lease.nodeId &&
          attempt.fence === record.lease.fence &&
          attempt.executionId === record.lease.executionId;
        const settled =
          sameOwner &&
          attempt.state === "settled" &&
          ["succeeded", "partial", "failed"].includes(run.state);
        if (
          run &&
          attempt &&
          !settled &&
          (!sameOwner ||
            !["leased", "running"].includes(attempt.state) ||
            !["queued", "running"].includes(run.state) ||
            run.cancellationRequested ||
            Date.parse(attempt.leaseExpiresAt) <= this.now())
        ) {
          record.state = "uncertain";
          record.detail =
            "Result retained for reconciliation; coordinator no longer confirms this execution's live lease";
          store.saveDispatch(record);
        }
      } catch {
        // An unreadable coordinator cannot prove whether the result committed.
      }
    }
    return record;
  }
  private async reconcileUncertain(): Promise<void> {
    const { ledger, store } = this.options;
    if (!ledger.getRun || !ledger.getAttempt) return;
    for (const record of store
      .dispatches()
      .filter(
        (row) => row.state === "uncertain" && !this.runs.has(row.lease.runId),
      )) {
      try {
        const run = await ledger.getRun(record.lease.runId),
          attempt = await ledger.getAttempt(record.attemptId);
        if (
          !run ||
          !attempt ||
          !["cancelled", "failed"].includes(run.state) ||
          run.currentAttemptId !== record.attemptId ||
          attempt.runId !== run.runId ||
          attempt.nodeId !== record.lease.nodeId ||
          attempt.fence !== record.lease.fence ||
          attempt.executionId !== record.lease.executionId
        )
          continue;
        record.state = run.state === "cancelled" ? "cancelled" : "acknowledged";
        record.reconciliation = {
          runState: run.state as "cancelled" | "failed",
          observedAt: new Date(this.now()).toISOString(),
        };
        store.saveDispatch(record);
      } catch {
        /* Keep unknown work reserved until authoritative identity and final state are readable. */
      }
    }
  }
  async recoverResults(): Promise<DispatchRecord[]> {
    insist(this.runs.size === 0, "RECOVERY_REQUIRES_IDLE", 409);
    const records = this.options.store.recoverDispatches();
    for (const record of records) {
      if (record.state === "result") await this.deliver(record);
      else if (record.state === "cancellation")
        await this.confirmCancellation(record);
      else if (record.state === "retry_pending")
        await this.requestRetry(record);
    }
    await this.reconcileUncertain();
    return this.options.store.dispatches();
  }
  private async confirmCancellation(
    record: DispatchRecord,
  ): Promise<DispatchRecord> {
    const acknowledge = this.options.ledger.acknowledgeCancellation;
    if (!acknowledge) return record;
    try {
      record.receipt = await acknowledge.call(
        this.options.ledger,
        `cancelled-${record.lease.executionId ?? record.attemptId}`,
        record.lease,
      );
      record.state = "cancelled";
      this.options.store.saveDispatch(record);
    } catch {
      /* Retry only this durable acknowledgment after recovery. */
    }
    return record;
  }
  async cancel(
    runId: string,
    reason = "Cancellation requested",
  ): Promise<void> {
    const active = this.runs.get(runId);
    insist(active, "RUN_NOT_OWNED", 403);
    active.abort.abort(new Error(reason));
    await active.done;
  }
  async dispose(): Promise<void> {
    this.active = false;
    await this.messages.dispose();
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    for (const active of this.runs.values())
      active.abort.abort(new Error("Plugin unloading"));
    await Promise.allSettled(
      [...this.runs.values()].map((active) => active.done),
    );
    if (this.polling) await this.polling;
  }
}
function validateResult(result: ExecutionResult, maxBytes: number): void {
  insist(isRecord(result), "INVALID_EXECUTION_RESULT");
  if (result.resultValidationFailure !== undefined) {
    validateResultValidationFailure(result.resultValidationFailure);
    insist(
      result.outcome === "failure" &&
        !result.report &&
        !result.preDispatchFailure &&
        !result.retryWitness,
      "INVALID_RESULT_VALIDATION_FAILURE",
    );
  }
  if (result.preDispatchFailure !== undefined) {
    validatePreDispatchFailure(result.preDispatchFailure);
    insist(
      result.outcome === "blocked" &&
        result.report === undefined &&
        result.retryWitness === undefined &&
        !Object.hasOwn(result, "notifications"),
      "INVALID_PRE_DISPATCH_FAILURE",
    );
  }
  if (result.retryAllowed !== undefined)
    insist(
      typeof result.retryAllowed === "boolean" &&
        result.retryWitness !== undefined,
      "INVALID_RETRY_ALLOWANCE",
    );
  if (result.retryWitness !== undefined) {
    insist(result.outcome === "unknown", "RETRY_REQUIRES_UNKNOWN_OUTCOME");
    validateRetryWitness(result.retryWitness);
  }
  insist(
    Buffer.byteLength(canonical(result)) <= maxBytes,
    "EXECUTION_RESULT_LIMIT",
  );
  insist(
    result &&
      ["success", "partial", "failure", "blocked", "unknown"].includes(
        result.outcome,
      ) &&
      typeof result.summary === "string" &&
      result.summary.length > 0 &&
      Buffer.byteLength(result.summary) <= 5000,
    "INVALID_EXECUTION_RESULT",
  );
  if (result.report)
    insist(
      typeof result.report.title === "string" &&
        result.report.title.length > 0 &&
        Buffer.byteLength(result.report.title) <= 500 &&
        typeof result.report.body === "string" &&
        result.report.body.length > 0 &&
        Buffer.byteLength(result.report.body) <= 1_000_000,
      "INVALID_EXECUTION_REPORT",
    );
  if (result.report?.data !== undefined) canonicalData(result.report.data);
  if (result.report?.schemaId !== undefined)
    insist(
      typeof result.report.schemaId === "string" &&
        result.report.schemaId.length > 0 &&
        Buffer.byteLength(result.report.schemaId) <= 200,
      "INVALID_REPORT_SCHEMA",
    );
}
