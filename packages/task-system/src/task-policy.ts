import type {
  ChoiceQuestion,
  DecisionReceipt,
  DecisionRequest,
  Json,
} from "./decision-types.js";
import {
  digest,
  fail,
  id,
  json,
  keys,
  object,
  stableStringify,
  text,
  validateAnswer,
  validateRequest,
} from "./decision-validation.js";

export interface TaskCandidate {
  id: string;
  description: string;
}
export interface ExecutorCandidate extends TaskCandidate {
  eligible: boolean;
}
export interface ModelRouteCandidate extends TaskCandidate {
  executorId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  eligible: boolean;
}
export interface WorkspaceCandidate extends TaskCandidate {
  executorId: string;
  action: "reuse" | "create";
  /** Opaque identifier, resolved/authorized by the executor's workspace manager. */
  workspaceRef: string;
  eligible: boolean;
}
export interface TaskDecisionSnapshot {
  /** Scheduler-host requests leave workspace/session choices to the executor. */
  workspaceSelection?: "executor";
  rankExecutors?: boolean;
  stateHash: string;
  validUntil: number;
  context: Json;
  tasks: TaskCandidate[];
  executors: ExecutorCandidate[];
  modelRoutes: ModelRouteCandidate[];
  workspaces: WorkspaceCandidate[];
  explicit?: {
    executorId?: string;
    modelRouteId?: string;
    workspaceId?: string;
  };
  mandatoryReportingReasons: string[];
}
export interface TaskDecisionProposal {
  kind: "proposal";
  persistence: "ignore" | "create" | "attach";
  attachTaskId: string | null;
  executor: ExecutorCandidate | null;
  modelRoute: ModelRouteCandidate | null;
  workspace: WorkspaceCandidate | null;
  fallbackRoutes?: ModelRouteCandidate[];
  reporting: {
    protocolReceiptRequired: true;
    narrative: "none" | "summary" | "escalate";
    mandatoryReasons: string[];
  };
  stateHash: string;
  /** Consumer must recheck authorization, budget, capabilities, state and workspace immediately before commit. */
  requiresAuthorizationCheck: true;
}
export type TaskPolicyResult =
  | TaskDecisionProposal
  | { kind: "abstain"; reason: string; protocolReceiptRequired: true };
const version = "1";
const ids = [
  "persist",
  "attach",
  "executor",
  "modelEffort",
  "workspace",
  "reporting",
] as const;
function candidateMap(candidates: TaskCandidate[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const candidate of candidates) {
    id(candidate.id, "candidate id");
    text(candidate.description, "candidate description");
    if (candidate.id === "none" || Object.hasOwn(result, candidate.id))
      fail("candidate IDs must be unique and cannot be none");
    result[candidate.id] = candidate.description;
  }
  return result;
}
function filtered(snapshot: TaskDecisionSnapshot) {
  json(snapshot, "task snapshot");
  text(snapshot.stateHash, "stateHash");
  if (!Number.isFinite(snapshot.validUntil)) fail("validUntil must be finite");
  for (const reason of snapshot.mandatoryReportingReasons)
    text(reason, "mandatoryReportingReasons");
  candidateMap(snapshot.tasks);
  candidateMap(snapshot.executors);
  candidateMap(snapshot.modelRoutes);
  candidateMap(snapshot.workspaces);
  for (const route of snapshot.modelRoutes) {
    text(route.provider, "route provider");
    text(route.model, "route model");
    if (route.reasoningEffort !== undefined)
      text(route.reasoningEffort, "route reasoningEffort");
  }
  for (const workspace of snapshot.workspaces) {
    if (!["reuse", "create"].includes(workspace.action))
      fail("invalid workspace action");
    text(workspace.workspaceRef, "workspaceRef");
  }
  const executors = snapshot.executors.filter(
    (e) =>
      e.eligible === true &&
      (!snapshot.explicit?.executorId || e.id === snapshot.explicit.executorId),
  );
  const routes = snapshot.modelRoutes.filter(
    (r) =>
      r.eligible === true &&
      executors.some((e) => e.id === r.executorId) &&
      (!snapshot.explicit?.modelRouteId ||
        r.id === snapshot.explicit.modelRouteId),
  );
  const workspaces = snapshot.workspaces.filter(
    (w) =>
      w.eligible === true &&
      executors.some((e) => e.id === w.executorId) &&
      (!snapshot.explicit?.workspaceId ||
        w.id === snapshot.explicit.workspaceId),
  );
  if (snapshot.explicit?.executorId && !executors.length)
    fail("explicit executor is unavailable or ineligible");
  if (snapshot.explicit?.modelRouteId && !routes.length)
    fail("explicit model/effort route is unavailable or ineligible");
  if (snapshot.explicit?.workspaceId && !workspaces.length)
    fail("explicit workspace is unavailable or ineligible");
  return { executors, routes, workspaces };
}
function question(
  questionId: string,
  instructions: string,
  candidates: Record<string, string>,
): ChoiceQuestion {
  return {
    questionId,
    questionVersion: version,
    type: "choice",
    instructions,
    candidates,
  };
}
/** Catalog eligibility and explicit choices are supplied by deterministic caller policy, never model output. */
export function buildTaskDecisionRequest(
  requestId: string,
  snapshot: TaskDecisionSnapshot,
  route: Pick<DecisionRequest, "provider" | "model" | "reasoningEffort" | "preset"> = {},
  now = Date.now(),
): DecisionRequest {
  if (snapshot.validUntil <= now) fail("task decision snapshot expired");
  const { executors, routes, workspaces } = filtered(snapshot);
  const request: DecisionRequest = {
    requestId,
    stateHash: snapshot.stateHash,
    context: {
      state: snapshot.context,
      catalog: {
        tasks: snapshot.tasks,
        executors,
        modelRoutes: routes,
        workspaces,
      } as unknown as Json,
    },
    questions: [
      question(
        "persist",
        "Choose create for a new authorized request to execute work on an executor, including one-off tasks and short result reports: dispatch requires a durable task. Attach only if the same stable task is present. Choose ignore only for conversation or lookups that need no executor work; when ignoring, executor and modelEffort must both be none.",
        {
          ignore: "Conversation only; no task or execution",
          create: "Create a durable task, including one-off execution",
          ...(snapshot.tasks.length
            ? { attach: "Attach to an existing stable task" }
            : {}),
        },
      ),
      question(
        "attach",
        "Which existing stable task is this about? Choose none when there is no match.",
        { none: "No matching task", ...candidateMap(snapshot.tasks) },
      ),
      question(
        "executor",
        "For an authorized execution request, select the first suitable eligible executor. Prefer matching capability, then online idle machines. Registered offline machines remain eligible: recommend them and wait in inbox. Choose none only for conversation or no suitable registered executor. Ignored conversation must choose none.",
        { none: "No execution", ...candidateMap(executors) },
      ),
      question(
        "modelEffort",
        "Select an eligible provider/model/reasoning tuple for the chosen executor, or none if not executing. Never invent another combination.",
        { none: "No model execution", ...candidateMap(routes) },
      ),
      ...(snapshot.rankExecutors
        ? Array.from(
            { length: Math.min(8, Math.max(0, executors.length - 1)) },
            (_, i) =>
              question(
                `fallbackRoute${i + 1}`,
                `Recommend fallback number ${i + 1}, an eligible model/effort route on a DIFFERENT suitable executor. Preserve capability match; prefer online idle hosts and inexpensive effort for simple work. Do not repeat the primary executor or a prior fallback. Choose none for no further suitable executor; all later fallbacks must then be none. Offline registered hosts remain valid recommendations and wait in inbox.`,
                { none: "No more suitable executors", ...candidateMap(routes) },
              ),
          )
        : []),
      ...(snapshot.workspaceSelection === "executor"
        ? []
        : [
            question(
              "workspace",
              "Select an eligible actual-workspace reuse/create proposal for the chosen executor, or none. This does not create a directory.",
              { none: "No workspace change", ...candidateMap(workspaces) },
            ),
          ]),
      question(
        "reporting",
        "Choose optional narrative reporting. Protocol completion and mandatory error/approval/budget reports always happen independently.",
        {
          none: "No extra narrative",
          summary: "Send a narrative summary",
          escalate: "Request planner attention",
        },
      ),
    ],
    ...route,
  };
  validateRequest(request);
  return request;
}
/** Returns data only. The consumer owns ledger commit, final authority checks and all effects. */
export function consumeTaskDecisionReceipt(
  receipt: DecisionReceipt,
  request: DecisionRequest,
  snapshot: TaskDecisionSnapshot,
  now = Date.now(),
): TaskPolicyResult {
  const abstain = (reason: string): TaskPolicyResult => ({
    kind: "abstain",
    reason,
    protocolReceiptRequired: true,
  });
  if (
    snapshot.validUntil <= now ||
    receipt.stateHash !== snapshot.stateHash ||
    request.stateHash !== snapshot.stateHash
  )
    return abstain("stale-snapshot");
  if (
    receipt.requestId !== request.requestId ||
    receipt.requestDigest !== digest(request) ||
    receipt.error ||
    receipt.status !== "answered"
  )
    return abstain("unusable-receipt");
  try {
    const rebuilt = buildTaskDecisionRequest(
      request.requestId,
      snapshot,
      {
        ...(request.preset ? { preset: request.preset } : {}),
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.reasoningEffort
          ? { reasoningEffort: request.reasoningEffort }
          : {}),
      },
      now,
    );
    // Bind the complete evidence/catalog/question set, not only a user-supplied hash string.
    if (stableStringify(request) !== stableStringify(rebuilt))
      return abstain("request-snapshot-mismatch");
    object(receipt.answers, "answers");
    const answerIds = request.questions.map((q) => q.questionId);
    keys(receipt.answers, answerIds, answerIds, "task answers");
    const values: Record<string, string> = {};
    for (const q of request.questions) {
      const answer = receipt.answers[q.questionId];
      validateAnswer(answer, q, true);
      if (
        receipt.questionVersions[q.questionId] !== q.questionVersion ||
        q.type !== "choice" ||
        answer?.type !== "choice" ||
        !Object.hasOwn(q.candidates, answer.choice)
      )
        return abstain("invalid-task-answer");
      values[q.questionId] = answer.choice;
    }
    const { executors, routes, workspaces } = filtered(snapshot);
    const executor = executors.find((e) => e.id === values.executor) ?? null;
    const modelRoute = routes.find((r) => r.id === values.modelEffort) ?? null;
    const workspace =
      snapshot.workspaceSelection === "executor"
        ? null
        : (workspaces.find((w) => w.id === values.workspace) ?? null);
    if (
      (values.executor !== "none" && !executor) ||
      (values.modelEffort !== "none" && !modelRoute) ||
      (snapshot.workspaceSelection !== "executor" &&
        values.workspace !== "none" &&
        !workspace)
    )
      return abstain("candidate-no-longer-eligible");
    if (
      (modelRoute && modelRoute.executorId !== executor?.id) ||
      (workspace && workspace.executorId !== executor?.id) ||
      (executor && !modelRoute)
    )
      return abstain("incompatible-executor-model-workspace");
    if (
      snapshot.explicit?.executorId &&
      executor?.id !== snapshot.explicit.executorId
    )
      return abstain("explicit-executor-not-preserved");
    if (
      snapshot.explicit?.modelRouteId &&
      modelRoute?.id !== snapshot.explicit.modelRouteId
    )
      return abstain("explicit-model-route-not-preserved");
    if (
      snapshot.workspaceSelection !== "executor" &&
      snapshot.explicit?.workspaceId &&
      workspace?.id !== snapshot.explicit.workspaceId
    )
      return abstain("explicit-workspace-not-preserved");
    if (values.persist === "attach" && values.attach === "none")
      return abstain("attach-without-task");
    if (values.persist !== "attach" && values.attach !== "none")
      return abstain("unexpected-task-attachment");
    if (values.persist === "ignore" && (executor || modelRoute || workspace))
      return abstain("ignored-task-cannot-dispatch");
    const fallbackRoutes: ModelRouteCandidate[] = [];
    const seen = new Set(executor ? [executor.id] : []);
    let ended = false;
    for (const q of request.questions.filter((q) =>
      q.questionId.startsWith("fallbackRoute"),
    )) {
      const value = values[q.questionId];
      if (value === "none") {
        ended = true;
        continue;
      }
      const route = routes.find((r) => r.id === value);
      if (
        ended ||
        !executor ||
        !route ||
        seen.has(route.executorId) ||
        values.persist === "ignore"
      )
        return abstain("invalid-fallback-order");
      seen.add(route.executorId);
      fallbackRoutes.push(structuredClone(route));
    }
    return {
      kind: "proposal",
      ...(snapshot.rankExecutors ? { fallbackRoutes } : {}),
      persistence: values.persist as TaskDecisionProposal["persistence"],
      attachTaskId: values.attach === "none" ? null : values.attach!,
      executor: executor ? structuredClone(executor) : null,
      modelRoute: modelRoute ? structuredClone(modelRoute) : null,
      workspace: workspace ? structuredClone(workspace) : null,
      reporting: {
        protocolReceiptRequired: true,
        narrative: snapshot.mandatoryReportingReasons.length
          ? "escalate"
          : (values.reporting as "none" | "summary" | "escalate"),
        mandatoryReasons: [...snapshot.mandatoryReportingReasons],
      },
      stateHash: snapshot.stateHash,
      requiresAuthorizationCheck: true,
    };
  } catch {
    return abstain("invalid-task-policy-input");
  }
}
