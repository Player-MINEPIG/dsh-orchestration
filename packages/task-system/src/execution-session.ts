/** Host-only selection glue. Session identity is committed by the leased authority. */
import {
  defaultTaskSessionSelection,
  type TaskSessionSnapshot,
} from "./session-default.js";
import type { TaskSessionDecisionService } from "./session-policy.js";
import type {
  Claim,
  TaskSessionChoice,
  TaskSessionContext,
} from "./remote/ports.js";

export async function chooseExecutionSession(input: {
  claim: {
    task: Claim["task"];
    run: Pick<
      Claim["run"],
      "runId" | "route" | "retry" | "workspaceConstraint"
    >;
    attempt: Pick<Claim["attempt"], "attemptId" | "nodeId">;
  };
  context: TaskSessionContext;
  defaultWorkspaceId?: string | null;
  workspaces: {
    workspaceId: string;
    nodeId: string;
    description: string;
    eligible: boolean;
  }[];
  decisions?: TaskSessionDecisionService;
  decisionProvider?: string;
  signal?: AbortSignal;
  ttlMs?: number;
  refresh?: () => TaskSessionContext | Promise<TaskSessionContext>;
}): Promise<TaskSessionChoice> {
  const { claim } = input;
  let context = input.context;
  const workspaceId =
    claim.run.route?.workspaceId ??
    claim.task.workspaceId ??
    input.defaultWorkspaceId ??
    undefined;
  if (claim.run.retry)
    return {
      ...(workspaceId ? { workspaceId } : {}),
      session: { mode: "reuse", sessionId: claim.run.retry.sessionId },
    };
  // Older text-only profiles have no workspace grant. Preserve that mode without
  // inventing a directory or offering a decision that could grant filesystem access.
  if (!workspaceId) {
    if (input.decisions)
      throw new Error(
        "TASK_SESSION_CONFIG: configure a registered default workspace before enabling session decisions",
      );
    const current = context.sessions.find(
      (session) => session.sessionId === context.taskSessionId,
    );
    if (
      context.taskSessionId &&
      (!current || current.workspaceId !== undefined)
    )
      throw new Error(
        "TASK_SESSION_CONFIG: existing Task session belongs to another workspace",
      );
    return {
      expectedTaskSessionId: context.taskSessionId ?? null,
      session: current
        ? { mode: "reuse", sessionId: current.sessionId }
        : { mode: "new" },
    };
  }
  const buildSnapshot = (): TaskSessionSnapshot => {
    const task = context.task ?? claim.task;
    return {
      taskId: claim.task.taskId,
      nodeId: claim.attempt.nodeId,
      defaultWorkspaceId: context.workspaceId ?? workspaceId,
      ...(context.taskSessionId
        ? { taskSessionId: context.taskSessionId }
        : {}),
      context: {
        title: task.title,
        description: task.description,
        runId: claim.run.runId,
        schedulerId: context.schedulerId,
        ...(context.projectContext
          ? {
              projectContext:
                context.projectContext as unknown as import("./remote/protocol.js").Json,
            }
          : {}),
      },
      validUntil: Date.now() + (input.ttlMs ?? 30000),
      workspaces: input.workspaces.map((workspace) => ({
        ...workspace,
        eligible:
          workspace.eligible &&
          (!(context.workspaceConstraint ?? claim.run.workspaceConstraint) ||
            workspace.workspaceId ===
              (context.workspaceConstraint ?? claim.run.workspaceConstraint)) &&
          (!context.eligibleWorkspaceIds ||
            context.eligibleWorkspaceIds.includes(workspace.workspaceId)) &&
          (!task.workspaceId || task.workspaceId === workspace.workspaceId) &&
          (!task.policy?.allowedWorkspaceIds ||
            task.policy.allowedWorkspaceIds.includes(workspace.workspaceId)),
      })),
      sessions: context.sessions
        .filter((session) => session.workspaceId !== undefined)
        .map((session) => ({
          sessionId: session.sessionId,
          taskId: session.taskId,
          nodeId: session.nodeId,
          workspaceId: session.workspaceId!,
          description: `Existing session for Task ${session.taskId}`,
          eligible: session.schedulerId === context.schedulerId,
        })),
    };
  };
  const snapshot = buildSnapshot();
  // An authority-owned binding is already a decision. Validate its identity,
  // workspace and current grants, rather than asking a model to choose again.
  const selection = snapshot.taskSessionId
    ? defaultTaskSessionSelection(snapshot, "existing-task-binding")
    : input.decisions
    ? await (
        await import("./session-policy.js")
      ).resolveTaskSessionDecision(snapshot, {
        decisions: input.decisions,
    route: input.decisionProvider ? {provider:input.decisionProvider} : {},
        requestId: `task-session-${claim.attempt.attemptId}`,
        signal: input.signal,
        ...(input.refresh
          ? {
              currentSnapshot: async () => {
                context = await input.refresh!();
                return buildSnapshot();
              },
            }
          : {}),
      })
    : defaultTaskSessionSelection(snapshot, "decision-disabled");
  input.signal?.throwIfAborted();
  return {
    expectedTaskSessionId: context.taskSessionId ?? null,
    workspaceId: selection.workspaceId,
    session: selection.session,
    ...("receipt" in selection && selection.receipt
      ? { decision: JSON.parse(JSON.stringify(selection.receipt)) }
      : {}),
  };
}
