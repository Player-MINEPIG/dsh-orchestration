import type {
  DecisionReceipt,
  DecisionRequest,
  Json,
} from "@dsh-task/typed-decisions/core";
import {
  digest,
  json,
  keys,
  object,
  stableStringify,
  validateAnswer,
  validateRequest,
} from "@dsh-task/typed-decisions/validation";
import {
  defaultTaskSessionSelection,
  taskSessionCatalog,
  type TaskSessionSelection,
  type TaskSessionSnapshot,
} from "./session-default.js";

export interface TaskSessionDecisionService {
  presetFor?(consumer: string): string | undefined;
  evaluate(
    request: DecisionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<DecisionReceipt>;
}
export type TaskSessionDecisionRoute = Pick<
  DecisionRequest,
  "provider" | "model" | "reasoningEffort" | "preset"
>;
export type TaskSessionDecisionResult = TaskSessionSelection & {
  receipt?: DecisionReceipt;
};

/** Dynamically load this consumer only when the optional decision service is used. */
export function buildTaskSessionDecisionRequest(
  requestId: string,
  snapshot: TaskSessionSnapshot,
  route: TaskSessionDecisionRoute = {},
  now = Date.now(),
): DecisionRequest {
  json(snapshot, "task session snapshot");
  if (!Number.isFinite(snapshot.validUntil) || snapshot.validUntil <= now)
    throw new Error("Task session decision snapshot expired");
  const { workspaces, sessions } = taskSessionCatalog(snapshot);
  const context = {
    taskId: snapshot.taskId,
    nodeId: snapshot.nodeId,
    defaultWorkspaceId: snapshot.defaultWorkspaceId,
    taskSessionId: snapshot.taskSessionId ?? null,
    state: snapshot.context,
    workspaces,
    sessions,
  } as unknown as Json;
  const request: DecisionRequest = {
    requestId,
    stateHash: digest(context),
    context,
    questions: [
      {
        questionId: "session",
        questionVersion: "1",
        type: "choice",
        instructions:
          "Choose a new session or an eligible existing session for this Task. Reuse must match the selected workspace. This choice grants no tools or permissions.",
        candidates: {
          new: "Create a new session for this Task",
          ...Object.fromEntries(
            sessions.map((session, index) => [
              `reuse-${index}`,
              session.description,
            ]),
          ),
        },
      },
      {
        questionId: "workspace",
        questionVersion: "1",
        type: "choice",
        instructions:
          "Choose an eligible configured workspace. Prefer the default unless the Task needs another permitted workspace. A reused session must remain in its existing workspace. Do not invent paths or create workspaces.",
        candidates: Object.fromEntries(
          workspaces.map((workspace) => [
            workspace.workspaceId,
            workspace.description,
          ]),
        ),
      },
    ],
    ...route,
  };
  validateRequest(request);
  return request;
}

/** Data only: execution still commits through the owner's leased authority check. */
export function consumeTaskSessionDecisionReceipt(
  receipt: DecisionReceipt,
  request: DecisionRequest,
  snapshot: TaskSessionSnapshot,
  now = Date.now(),
): TaskSessionSelection {
  const fallback = (reason: string) =>
    defaultTaskSessionSelection(snapshot, reason);
  // A missing legal default is a configuration error, never model-repairable.
  defaultTaskSessionSelection(snapshot);
  if (!Number.isFinite(snapshot.validUntil) || snapshot.validUntil <= now)
    return fallback("stale-decision");
  try {
    const rebuilt = buildTaskSessionDecisionRequest(
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
    if (stableStringify(request) !== stableStringify(rebuilt))
      return fallback("stale-decision");
    if (
      receipt.requestId !== request.requestId ||
      receipt.requestDigest !== digest(request) ||
      receipt.stateHash !== request.stateHash ||
      receipt.schemaVersion !== 1 ||
      receipt.status !== "answered" ||
      receipt.error
    )
      return fallback("unusable-decision");
    object(receipt.answers, "session answers");
    keys(
      receipt.answers,
      ["session", "workspace"],
      ["session", "workspace"],
      "session answers",
    );
    for (const question of request.questions) {
      validateAnswer(receipt.answers[question.questionId], question, true);
      if (
        receipt.questionVersions[question.questionId] !==
        question.questionVersion
      )
        return fallback("invalid-decision");
    }
    const sessionAnswer = receipt.answers.session;
    const workspaceAnswer = receipt.answers.workspace;
    if (sessionAnswer?.type !== "choice" || workspaceAnswer?.type !== "choice")
      return fallback("unusable-decision");
    const { sessions } = taskSessionCatalog(snapshot);
    const session = sessions.find(
      (_, index) => `reuse-${index}` === sessionAnswer.choice,
    );
    if (session && session.workspaceId !== workspaceAnswer.choice)
      return fallback("incompatible-session-workspace");
    return {
      source: "decision",
      session: session
        ? { mode: "reuse", sessionId: session.sessionId }
        : { mode: "new" },
      workspaceId: workspaceAnswer.choice,
    };
  } catch {
    return fallback("invalid-decision");
  }
}

/** Provider failures use the default; caller cancellation still cancels execution. */
export async function resolveTaskSessionDecision(
  snapshot: TaskSessionSnapshot,
  options: {
    requestId: string;
    decisions?: TaskSessionDecisionService;
    route?: TaskSessionDecisionRoute;
    signal?: AbortSignal;
    currentSnapshot?: () => TaskSessionSnapshot | Promise<TaskSessionSnapshot>;
    now?: () => number;
  },
): Promise<TaskSessionDecisionResult> {
  options.signal?.throwIfAborted();
  defaultTaskSessionSelection(snapshot);
  if (!options.decisions) return defaultTaskSessionSelection(snapshot);
  const now = options.now ?? Date.now;
  const initial = structuredClone(snapshot);
  let request: DecisionRequest;
  let receipt: DecisionReceipt;
  try {
    request = buildTaskSessionDecisionRequest(
      options.requestId,
      initial,
      options.route && Object.values(options.route).some(v => v !== undefined)
        ? options.route
        : options.decisions.presetFor?.("task-session") ? { preset: options.decisions.presetFor("task-session") } : {},
      now(),
    );
    receipt = await options.decisions.evaluate(request, {
      signal: options.signal,
    });
  } catch {
    options.signal?.throwIfAborted();
    const current = (await options.currentSnapshot?.()) ?? initial;
    options.signal?.throwIfAborted();
    return defaultTaskSessionSelection(current, "decision-failed");
  }
  options.signal?.throwIfAborted();
  const current = (await options.currentSnapshot?.()) ?? initial;
  options.signal?.throwIfAborted();
  return {
    ...consumeTaskSessionDecisionReceipt(
      receipt,
      request,
      {
        ...current,
        validUntil: Math.min(initial.validUntil, current.validUntil),
      },
      now(),
    ),
    receipt,
  };
}
