import {
  buildTaskDecisionRequest,
  consumeTaskDecisionReceipt,
  digest,
  type DecisionRequest,
  type DecisionReceipt,
  type TaskDecisionSnapshot,
  type TaskDecisionProposal,
} from "@dsh-task/typed-decisions/core";
import { TaskLedger, TaskError } from "./ledger.js";
import type { ExecutionRoute, Json } from "./contracts.js";
export interface DecisionServicePort {
  evaluate(
    request: DecisionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionReceipt>;
}
export interface PlanningInput {
  requestId: string;
  title: string;
  description: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  observationCandidateId?: string;
}
/** A consumer of the independent decision plugin. All grants are operator-owned policy. */
export class TaskPlanner {
  constructor(
    private ledger: TaskLedger,
    private decisions: DecisionServicePort,
    private catalog: () => TaskDecisionSnapshot,
    private authorize: (proposal: TaskDecisionProposal) => void,
    private now: () => number = Date.now,
  ) {}
  async planObservation(
    candidateId: string,
    options: {
      signal?: AbortSignal;
      provider?: string;
      model?: string;
      reasoningEffort?: string;
    } = {},
  ) {
    const candidate = this.ledger
      .observationCandidates()
      .find((c) => c.candidateId === candidateId);
    if (!candidate || candidate.state !== "pending")
      throw new TaskError("CONFLICT", "Observation is not pending");
    return this.plan(
      {
        requestId: `observe:${candidateId}`,
        title: candidate.title,
        description: candidate.body,
        observationCandidateId: candidateId,
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      },
      { signal: options.signal },
    );
  }
  private snapshot(input: PlanningInput) {
    const base = this.catalog();
    return {
      ...base,
      ...(input.observationCandidateId
        ? { executors: [], modelRoutes: [], workspaces: [] }
        : {}),
      context: {
        catalog: base.context,
        request: {
          title: input.title,
          description: input.description,
          mode: input.observationCandidateId
            ? "observe-existing-no-dispatch"
            : "request",
        },
      },
    };
  }
  async plan(input: PlanningInput, options: { signal?: AbortSignal } = {}) {
    input = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as unknown as PlanningInput;
    const inputDigest = digest(input);
    const existing = this.ledger.getDecision(input.requestId);
    if (existing) {
      if (existing.inputDigest !== inputDigest)
        throw new TaskError("CONFLICT", "Decision request ID reused");
      return existing;
    }
    const snapshot = this.snapshot(input);
    const route = {
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort
        ? { reasoningEffort: input.reasoningEffort }
        : {}),
    };
    const request = buildTaskDecisionRequest(
      input.requestId,
      snapshot,
      route,
      this.now(),
    );
    const receipt = await this.decisions.evaluate(request, options);
    const current = this.snapshot(input);
    const proposal = consumeTaskDecisionReceipt(
      receipt,
      request,
      current,
      this.now(),
    );
    return this.ledger.recordDecision(`decision:${input.requestId}`, {
      decisionId: input.requestId,
      inputDigest,
      receipt: receipt as unknown as Json,
      proposal: proposal as unknown as Json,
      stateHash: snapshot.stateHash,
      validUntil: snapshot.validUntil,
      input: input as unknown as Json,
    }).value;
  }
  /** Call only from an authorized task-intent path, never merely on seeing a report. */
  apply(decisionId: string) {
    const existing = this.ledger.commandReceipt(`apply-decision:${decisionId}`);
    if (existing) return existing;
    const record = this.ledger.getDecision(decisionId);
    if (!record) throw new TaskError("NOT_FOUND", "Decision not found");
    const proposal = record.proposal as unknown as TaskDecisionProposal;
    if (proposal.kind !== "proposal")
      throw new TaskError("ABSTAIN", "Decision requires clarification");
    const current = this.catalog();
    if (
      current.stateHash !== record.stateHash ||
      current.validUntil <= this.now() ||
      record.validUntil <= this.now()
    )
      throw new TaskError("STALE_DECISION", "Catalog changed");
    this.authorize(proposal); // Mandatory deterministic final policy, independent of model confidence.
    const storedInput = record.input as unknown as PlanningInput;
    if (storedInput.observationCandidateId) {
      if (proposal.executor || proposal.modelRoute || proposal.workspace)
        throw new TaskError(
          "OBSERVE_ONLY",
          "Observation cannot select execution",
        );
      return this.ledger.admitObservation(`apply-decision:${decisionId}`, {
        candidateId: storedInput.observationCandidateId,
        action: proposal.persistence,
        ...(proposal.attachTaskId ? { taskId: proposal.attachTaskId } : {}),
      });
    }
    if (proposal.workspace?.action === "create")
      throw new TaskError(
        "WORKSPACE_REQUIRED",
        "Provision the authorized physical workspace and replan before execution",
      );
    let route: ExecutionRoute | undefined;
    if (proposal.executor && proposal.modelRoute) {
      route = {
        nodeId: proposal.executor.id,
        provider: proposal.modelRoute.provider,
        model: proposal.modelRoute.model,
        ...(proposal.modelRoute.reasoningEffort
          ? { reasoningEffort: proposal.modelRoute.reasoningEffort }
          : {}),
        ...(proposal.workspace
          ? { workspaceId: proposal.workspace.workspaceRef }
          : {}),
        requiredCapabilities: [],
      };
      this.ledger.validateRoute(route);
    }
    const input = record.input as unknown as PlanningInput;
    return this.ledger.applyDecision(`apply-decision:${decisionId}`, {
      decisionId,
      currentStateHash: current.stateHash,
      title: input.title,
      description: input.description,
      persistence: proposal.persistence,
      ...(proposal.attachTaskId ? { attachTaskId: proposal.attachTaskId } : {}),
      ...(route ? { route } : {}),
      reporting: proposal.reporting.narrative,
    });
  }
}

/** The catalog is derived from authoritative records, never supplied by model output. */
export function taskDecisionCatalog(
  ledger: TaskLedger,
  context: Json,
  ttlMs = 30_000,
  now = Date.now(),
): TaskDecisionSnapshot {
  const catalog = ledger.decisionCatalog();
  const executors = catalog.nodes
    .filter(
      (n) => n.enabled && n.roles.some((r) => r === "executor" || r === "both"),
    )
    .map((n) => ({ id: n.nodeId, description: n.nodeId, eligible: true }));
  const modelRoutes = catalog.nodes.flatMap((n) =>
    n.models.flatMap((model) =>
      [undefined, ...model.reasoningEfforts].map((reasoningEffort) => ({
        id: digest({
          nodeId: n.nodeId,
          ...model,
          reasoningEffort: reasoningEffort ?? null,
        }).slice(0, 32),
        description: `${n.nodeId}: ${model.provider}/${model.model}${reasoningEffort ? " " + reasoningEffort : ""}`,
        executorId: n.nodeId,
        provider: model.provider,
        model: model.model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        eligible: n.enabled && executors.some((e) => e.id === n.nodeId),
      })),
    ),
  );
  const workspaces = catalog.workspaces
    .filter((w) => w.state === "ready")
    .map((w) => ({
      id: w.workspaceId,
      description: w.label,
      executorId: w.nodeId,
      action: "reuse" as const,
      workspaceRef: w.workspaceId,
      eligible: catalog.nodes.some(
        (n) =>
          n.nodeId === w.nodeId &&
          n.enabled &&
          n.workspaceIds.includes(w.workspaceId),
      ),
    }));
  return {
    stateHash: digest(catalog),
    validUntil: now + ttlMs,
    context,
    tasks: catalog.tasks
      .filter((t) => t.state !== "archived")
      .map((t) => ({ id: t.taskId, description: t.title })),
    executors,
    modelRoutes,
    workspaces,
    mandatoryReportingReasons: [],
  };
}
