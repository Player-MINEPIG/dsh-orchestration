/** Host-only selection glue. Session identity is committed by the leased authority. */
import {
  defaultTaskSessionSelection,
  type TaskSessionSnapshot,
} from "./session-default.js";
import {
  resolveManagedTaskSessionDecision,
  type TaskSessionDecisionService,
} from "./session-policy.js";
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
      | "runId"
      | "route"
      | "retry"
      | "workspaceConstraint"
      | "configuration"
      | "projectContext"
    >;
    attempt: Pick<Claim["attempt"], "attemptId" | "nodeId">;
  };
  context: TaskSessionContext;
  defaultWorkspaceId?: string | null;
  managedWorkspaceAvailable?: boolean;
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
  // Each scheduled occurrence has a new evidence window. Explicit redispatch and
  // transport recovery continue the existing session, retaining previous results.
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
    const managedSnapshot = () => ({
      taskId: claim.task.taskId,
      nodeId: claim.attempt.nodeId,
      schedulerId: context.schedulerId,
      ...(context.taskSessionId
        ? { taskSessionId: context.taskSessionId }
        : {}),
      validUntil: Date.now() + (input.ttlMs ?? 30000),
      sessions: independentScheduleRun
        ? []
        : context.sessions.filter(
            (session) =>
              session.taskId === claim.task.taskId &&
              session.nodeId === claim.attempt.nodeId &&
              session.schedulerId === context.schedulerId &&
              session.workspaceId === undefined,
          ),
      context: {
        title: claim.task.title,
        ...(claim.task.description
          ? { description: claim.task.description }
          : {}),
        runId: claim.run.runId,
      },
    });
    const selection = await resolveManagedTaskSessionDecision(
      managedSnapshot(),
      {
        decisions: input.decisions,
        provider: input.decisionProvider,
        requestId: `task-session-${claim.attempt.attemptId}`,
        signal: input.signal,
        ...(input.refresh
          ? {
              currentSnapshot: async () => {
                context = await input.refresh!();
                return managedSnapshot();
              },
            }
          : {}),
      },
    );
    return {
      expectedTaskSessionId: context.taskSessionId ?? null,
      session: selection.session,
      ...(selection.decision ? { decision: selection.decision } : {}),
    };
  }
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
      session:
        current && !independentScheduleRun
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
  const selection = independentScheduleRun
    ? defaultTaskSessionSelection(
        { ...snapshot, taskSessionId: undefined },
        "independent-scheduled-run",
      )
    : snapshot.taskSessionId
      ? defaultTaskSessionSelection(snapshot, "existing-task-binding")
      : input.decisions
        ? await (
            await import("./session-policy.js")
          ).resolveTaskSessionDecision(snapshot, {
            decisions: input.decisions,
            route: input.decisionProvider
              ? { provider: input.decisionProvider }
              : {},
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
