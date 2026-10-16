import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import type { TaskLedger } from "./ledger.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { sessionCodexJobs, type CodexJobRecord, codexJobRows, type SessionJobRegistry } from "./session-codex-jobs.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Returned results first; acceptance and refreshes must not move a result. */
export function sortSessionTasks<T extends { returnedAt?: string | null; time?: string | null }>(tasks: readonly T[]): T[] {
  const timestamp = (value?: string | null) => value ? Date.parse(value) || 0 : 0;
  return [...tasks].sort((a, b) => timestamp(b.returnedAt) - timestamp(a.returnedAt) || timestamp(b.time) - timestamp(a.time));
}

/** Only successful dispatch receipts count; queries and inherited fork history do not. */
export function dispatchedTaskIds(events: readonly SessionEvent[]): string[] {
  const calls = new Map<string, string>();
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "tool/call") {
      const { name, callId, arguments: args } = event.data;
      if (!["project_dispatch", "task_plan", "task_run", "task_delegate"].includes(name)) continue;
      if (name === "task_plan") {
        try { if (JSON.parse(args).action !== "apply") continue; } catch { continue; }
      }
      calls.set(callId, name);
    } else if (event.type === "tool/result") {
      const { message } = event.data;
      if (message.isError || event.data.error || !calls.has(message.toolCallId)) continue;
      calls.delete(message.toolCallId);
      for (const part of message.content) {
        if (part.type !== "text") continue;
        try {
          const receipt = JSON.parse(part.text);
          const value = record(receipt?.value) ?? record(receipt);
          if (value?.localOnly === true) continue; // Local records are read from their separate session store.
          const taskId = value?.taskId ?? record(value?.task)?.taskId ?? record(value?.run)?.taskId;
          if (typeof taskId === "string" && taskId) ids.add(taskId);
        } catch { /* Tool errors or non-JSON output are not dispatch receipts. */ }
      }
    }
  }
  return [...ids];
}

/** Cache dispatch metadata, never raw commands or conversation text; bound retained sessions. */
export class SessionDispatchIndex {
  private cache = new Map<string, { revision: unknown; identity: symbol; ids: string[]; codexJobs: CodexJobRecord[] }>();
  async read(persistence: SessionPersistence, sessionId: string) {
    return (await this.readHistory(persistence, sessionId)).ids;
  }
  async readHistory(persistence: SessionPersistence, sessionId: string) {
    const id = SessionId(sessionId), stat = await persistence.stat(id);
    if (!stat) return { ids: [], codexJobs: [] };
    const prior = this.cache.get(sessionId);
    if (prior?.identity === persistence.identity && prior.revision === stat.revision) return prior;
    const handle = await persistence.open(id, "read");
    try {
      const { events } = await handle.read(handle.inheritedEventCount);
      const ids = dispatchedTaskIds(events);
      const entry = { revision: stat.revision, identity: persistence.identity, ids, codexJobs: sessionCodexJobs(events) };
      this.cache.delete(sessionId);
      this.cache.set(sessionId, entry);
      if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
      return entry;
    } finally { await handle.close(); }
  }
}

/** Durable dispatch operations cover ACKs not yet flushed into the conversation. */
export function sessionDispatchOperations(ledger: TaskLedger, sessionId: string) {
  const db = ledger.managementDatabase();
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_session_operations'").get())
    return { taskIds: [] as string[], pending: 0 };
  const taskIds = new Set<string>();
  let pending = 0;
  for (const row of db.prepare("SELECT data FROM project_session_operations WHERE session_id=?").all(sessionId)) {
    const op = JSON.parse(String(row.data));
    if (op.input?.action !== "dispatch") continue;
    if (op.state === "pending") pending++;
    if (op.state === "acknowledged" && typeof op.result?.taskId === "string") taskIds.add(op.result.taskId);
  }
  return { taskIds: [...taskIds], pending };
}

/** Reuse the task center's public rows and classification, scoped before returning to the browser. */
export function sessionTaskSnapshot(snapshot: unknown, roots: readonly string[], sessionId: string, pending = 0, codexJobs: readonly CodexJobRecord[] = [], registry?: SessionJobRegistry) {
  const candidate = record(snapshot);
  if (!candidate || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.runs)) throw new Error("Invalid task snapshot");
  const view = snapshot as ReturnType<ProjectRuntime["snapshot"]>;
  const direct = new Set(roots), ids = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of view.tasks) if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
      ids.add(task.id); changed = true;
    }
  }
  const ledgerTasks = view.tasks.filter(task => ids.has(task.id)).map(task => ({
    id: task.id, title: task.title, description: task.description, status: task.status,
    stateLabel: task.stateLabel, parentTaskId: task.parentTaskId, direct: direct.has(task.id),
    node: task.node, model: task.model, time: task.time,
    returnedAt: task.returnedAt ?? (["review", "done", "accepted", "error", "cancelled"].includes(task.status) ? task.time : undefined),
    report: task.report,
    runId: task.runId, runState: task.runState, reviewStatus: task.reviewStatus,
  }));
  const tasks = [...ledgerTasks, ...codexJobRows(codexJobs, sessionId, registry)];
  const visible = new Set(tasks.map(task => task.id));
  const counts: Record<string, number> = { all: tasks.length };
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return {
    sessionId, tasks, counts, directCount: tasks.filter(task => task.direct).length,
    externalDispatchCount: codexJobs.length,
    pendingDispatches: pending, unavailableTasks: roots.filter(id => !visible.has(id)).length,
    sampledAt: view.sampledAt ?? view.viewContext?.observedAt ?? new Date().toISOString(),
    runs: view.runs.filter(run => visible.has(run.taskId)).map(run => ({
      id: run.id, taskId: run.taskId, state: run.state, reviewStatus: run.reviewStatus,
      createdAt: run.createdAt, node: run.node, model: run.model,
    })),
  };
}
