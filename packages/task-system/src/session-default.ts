import type { Json } from "./contracts.js";

export interface TaskSessionWorkspace {
  workspaceId: string;
  nodeId: string;
  description: string;
  eligible: boolean;
}
export interface TaskSessionCandidate {
  sessionId: string;
  taskId: string;
  nodeId: string;
  workspaceId: string;
  description: string;
  eligible: boolean;
}
/** All candidates and their eligibility come from the execution owner. */
export interface TaskSessionSnapshot {
  taskId: string;
  nodeId: string;
  /** Effective explicit run/task workspace, otherwise the configured default. */
  defaultWorkspaceId: string;
  taskSessionId?: string;
  context: Json;
  validUntil: number;
  workspaces: TaskSessionWorkspace[];
  sessions: TaskSessionCandidate[];
}
export interface TaskSessionSelection {
  source: "default" | "decision";
  session: { mode: "new" } | { mode: "reuse"; sessionId: string };
  workspaceId: string;
  reason?: string;
}
export class TaskSessionConfigurationError extends Error {
  readonly code = "TASK_SESSION_CONFIG";
  constructor(message: string) {
    super(message);
    this.name = "TaskSessionConfigurationError";
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Does not import the optional decision package or perform execution effects. */
export function taskSessionCatalog(snapshot: TaskSessionSnapshot) {
  if (
    !identifier(snapshot.taskId) ||
    !identifier(snapshot.nodeId) ||
    !identifier(snapshot.defaultWorkspaceId) ||
    !Array.isArray(snapshot.workspaces) ||
    !Array.isArray(snapshot.sessions)
  )
    throw new TaskSessionConfigurationError(
      "Task session selection requires a task, node and configured workspace catalog",
    );
  for (const [rows, key] of [
    [snapshot.workspaces, "workspaceId"],
    [snapshot.sessions, "sessionId"],
  ] as const) {
    const used = new Set<string>();
    for (const row of rows) {
      const value = (row as unknown as Record<string, unknown>)[key];
      if (!identifier(value) || used.has(value))
        throw new TaskSessionConfigurationError(
          "Task session catalog identifiers must be unique and nonempty",
        );
      used.add(value);
    }
  }
  const workspaces = snapshot.workspaces.filter(
    (workspace) =>
      workspace.eligible === true && workspace.nodeId === snapshot.nodeId,
  );
  const defaultWorkspace = workspaces.find(
    (workspace) => workspace.workspaceId === snapshot.defaultWorkspaceId,
  );
  if (!defaultWorkspace)
    throw new TaskSessionConfigurationError(
      "The configured default workspace is unavailable or not eligible on this node",
    );
  const sessions = snapshot.sessions.filter(
    (session) =>
      session.eligible === true &&
      session.taskId === snapshot.taskId &&
      session.nodeId === snapshot.nodeId &&
      workspaces.some(
        (workspace) => workspace.workspaceId === session.workspaceId,
      ),
  );
  return { workspaces, sessions, defaultWorkspace };
}

/** Reuse this Task's bound session; only a missing compatible binding needs a new one. */
export function defaultTaskSessionSelection(
  snapshot: TaskSessionSnapshot,
  reason = "decision-unavailable",
): TaskSessionSelection {
  const { sessions } = taskSessionCatalog(snapshot);
  const existing = sessions.find(
    (session) =>
      session.sessionId === snapshot.taskSessionId &&
      session.workspaceId === snapshot.defaultWorkspaceId,
  );
  if (snapshot.taskSessionId && !existing)
    throw new TaskSessionConfigurationError(
      "The Task's bound session is unavailable or incompatible with its effective workspace",
    );
  return {
    source: "default",
    session: existing
      ? { mode: "reuse", sessionId: existing.sessionId }
      : { mode: "new" },
    workspaceId: snapshot.defaultWorkspaceId,
    reason,
  };
}
