/** Host-only selection glue. Session identity is committed by the leased authority. */
import {
  defaultTaskSessionSelection,
  type TaskSessionSnapshot,
} from "./session-default.js";
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
      | "route"
      | "retry"
      | "workspaceConstraint"
      | "configuration"
      | "projectContext"
    >;
    attempt: Pick<Claim["attempt"], "nodeId">;
  };
  context: TaskSessionContext;
  defaultWorkspaceId?: string | null;
  managedWorkspaceAvailable?: boolean;
  workspaces: {
    workspaceId: string;
    nodeId: string;
    eligible: boolean;
  }[];
  signal?: AbortSignal;
}): Promise<TaskSessionChoice> {
  input.signal?.throwIfAborted();
  const { claim, context } = input;
  const workspaceId =
    claim.run.route?.workspaceId ??
    claim.task.workspaceId ??
    (!claim.run.projectContext ? input.defaultWorkspaceId : undefined) ??
    undefined;
  if (claim.run.retry)
    return {
      ...(workspaceId ? { workspaceId } : {}),
      session: { mode: "reuse", sessionId: claim.run.retry.sessionId },
    };
  const config =
    claim.run.configuration &&
    typeof claim.run.configuration === "object" &&
    !Array.isArray(claim.run.configuration)
      ? (claim.run.configuration as Record<string, unknown>)
      : {};
  const independentScheduleRun =
    claim.task.kind === "scheduled" &&
    !config.taskRetry &&
    !config.continuationOf;
  if (claim.run.projectContext && !workspaceId) {
    if (!input.managedWorkspaceAvailable)
      throw new Error(
        "TASK_EXECUTION_ROOT_REQUIRED: select this device's execution parent directory",
      );
    if (
      claim.run.workspaceConstraint ||
      claim.task.workspaceId ||
      claim.task.policy?.allowedWorkspaceIds
    )
      throw new Error(
        "TASK_WORKSPACE_DENIED: managed directories cannot replace an explicit workspace grant",
      );
    const existing = context.sessions.find(
      (session) =>
        session.sessionId === context.taskSessionId &&
        session.taskId === claim.task.taskId &&
        session.nodeId === claim.attempt.nodeId &&
        session.schedulerId === context.schedulerId &&
        session.workspaceId === undefined,
    );
    return {
      expectedTaskSessionId: context.taskSessionId ?? null,
      session:
        existing && !independentScheduleRun
          ? { mode: "reuse", sessionId: existing.sessionId }
          : { mode: "new" },
    };
  }
  if (!workspaceId) {
    const current = context.sessions.find(
      (session) =>
        session.sessionId === context.taskSessionId &&
        session.taskId === claim.task.taskId &&
        session.nodeId === claim.attempt.nodeId &&
        session.schedulerId === context.schedulerId,
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
      session:
        current && !independentScheduleRun
          ? { mode: "reuse", sessionId: current.sessionId }
          : { mode: "new" },
    };
  }
  const task = context.task ?? claim.task;
  const snapshot: TaskSessionSnapshot = {
    taskId: claim.task.taskId,
    nodeId: claim.attempt.nodeId,
    defaultWorkspaceId: context.workspaceId ?? workspaceId,
    ...(context.taskSessionId ? { taskSessionId: context.taskSessionId } : {}),
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
    sessions: context.sessions.flatMap((session) =>
      session.workspaceId === undefined
        ? []
        : [
            {
              sessionId: session.sessionId,
              taskId: session.taskId,
              nodeId: session.nodeId,
              workspaceId: session.workspaceId,
              eligible: session.schedulerId === context.schedulerId,
            },
          ],
    ),
  };
  const selection = defaultTaskSessionSelection(
    independentScheduleRun
      ? { ...snapshot, taskSessionId: undefined }
      : snapshot,
  );
  input.signal?.throwIfAborted();
  return {
    expectedTaskSessionId: context.taskSessionId ?? null,
    workspaceId: selection.workspaceId,
    session: selection.session,
  };
}
