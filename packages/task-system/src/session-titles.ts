import type { Context } from "@deepseek-ai/cordis";
import {
  Session,
  SessionId,
  SessionSeq,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { normalizeSessionTitle } from "@deepseek-ai/dsh-session-title";
import {
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-session-projection-cache";
import type { Snapshot } from "./contracts.js";
import type { DispatchRecord } from "./remote/store.js";

export { runSessionTitle, taskSessionTitle } from "./task-session-title.js";
import { runSessionTitle, taskSessionTitle } from "./task-session-title.js";

/** Safe in unpublished creation setup; any previous title event records naming intent. */
export function initializeTaskSessionTitle(session: Session, title: string) {
  for (let seq = 0; ; seq++) {
    const event = session.eventAt(SessionSeq(seq));
    if (!event) break;
    if (event.type === "session/title") return;
  }
  const normalized = normalizeSessionTitle(title, 80) || "任务";
  // V4 permits a title without human message references only as a pinned user title.
  return session.append("session/title", {
    title: normalized,
    messageSeqs: [],
    source: { kind: "user" },
  });
}

export interface TaskSessionTitleCandidate {
  sessionId: string;
  taskId: string;
  runId: string;
  title: string;
}

/** Execution ownership comes from Attempts and admitted dispatches, never Run.sessionIds. */
export function taskSessionTitleCandidates(input: {
  nodeId: string;
  snapshot: Snapshot;
  dispatches?: readonly DispatchRecord[];
  authoritativeTitles?: ReadonlyMap<string, string>;
}): TaskSessionTitleCandidate[] {
  const candidates: TaskSessionTitleCandidate[] = [];
  for (const attempt of input.snapshot.attempts ?? []) {
    if (
      attempt.nodeId !== input.nodeId ||
      !attempt.sessionId ||
      !attempt.executionId
    )
      continue;
    const run = input.snapshot.runs.find(
      (run) => run.runId === attempt.runId && run.taskId === attempt.taskId,
    );
    if (
      !run?.route ||
      run.route.execution ||
      run.historyOnly ||
      run.observationOnly
    )
      continue;
    candidates.push({
      sessionId: attempt.sessionId,
      taskId: run.taskId,
      runId: run.runId,
      title:
        input.authoritativeTitles?.get(run.runId) ??
        runSessionTitle(run, input.snapshot),
    });
  }
  for (const record of [...(input.dispatches ?? [])].sort((a, b) =>
    (a.claim.run.createdAt ?? "").localeCompare(b.claim.run.createdAt ?? ""),
  )) {
    const { claim } = record;
    if (
      claim.attempt.nodeId !== input.nodeId ||
      !claim.attempt.executionId ||
      !record.sessionId ||
      claim.run.route?.execution ||
      claim.run.historyOnly ||
      claim.run.observationOnly
    )
      continue;
    candidates.push({
      sessionId: record.sessionId,
      taskId: claim.task.taskId,
      runId: claim.run.runId,
      title:
        input.authoritativeTitles?.get(claim.run.runId) ??
        claim.executionContext?.sessionTitle ??
        taskSessionTitle({
          title: claim.run.intentSnapshot?.title ?? claim.task.title,
          configuration: claim.run.configuration,
        }),
    });
  }
  const unique = new Map<string, TaskSessionTitleCandidate>();
  const conflicting = new Set<string>();
  for (const candidate of candidates) {
    const previous = unique.get(candidate.sessionId);
    if (previous && previous.taskId !== candidate.taskId)
      conflicting.add(candidate.sessionId);
    if (!previous) unique.set(candidate.sessionId, candidate);
  }
  return [...unique.values()].filter(
    (candidate) => !conflicting.has(candidate.sessionId),
  );
}

export type TaskSessionTitleReceipt = TaskSessionTitleCandidate & {
  status: "named" | "existing-title" | "live" | "owned" | "missing";
};

/** Repair only cold sessions, under official exclusive ownership, without activating an Agent. */
export async function backfillTaskSessionTitles(
  ctx: Context,
  candidates: readonly TaskSessionTitleCandidate[],
): Promise<TaskSessionTitleReceipt[]> {
  const receipts: TaskSessionTitleReceipt[] = [];
  for (const candidate of candidates) {
    const id = SessionId(candidate.sessionId);
    if (ctx.sessions.get(id)) {
      receipts.push({ ...candidate, status: "live" });
      continue;
    }
    let handle;
    try {
      handle = await ctx.sessionPersistence.open(id, "write");
    } catch (error) {
      if (error instanceof SessionAlreadyOwnedError) {
        receipts.push({ ...candidate, status: "owned" });
        continue;
      }
      if (error instanceof SessionPersistenceNotFoundError) {
        receipts.push({ ...candidate, status: "missing" });
        continue;
      }
      throw error;
    }
    try {
      const read = await handle.read();
      if (ctx.sessions.get(id)) {
        receipts.push({ ...candidate, status: "live" });
        continue;
      }
      if (read.events.some((event) => event.type === "session/title")) {
        receipts.push({ ...candidate, status: "existing-title" });
        continue;
      }
      const replay = Session.fromRestore(
        id,
        read.events,
        handle.header,
        handle.inheritedEventCount,
        read.eventState,
        ctx.sessions.messageProjections,
      );
      const event = initializeTaskSessionTitle(replay, candidate.title);
      if (!event) {
        receipts.push({ ...candidate, status: "existing-title" });
        continue;
      }
      const tail: SessionEvent[] = [];
      for (let seq = read.events.length; ; seq++) {
        const appended = replay.eventAt(SessionSeq(seq));
        if (!appended) break;
        tail.push(appended);
      }
      await handle.append(tail);
      await handle.flush();
      await ctx.get("sessionProjectionCache")?.write(replay);
      receipts.push({ ...candidate, status: "named" });
    } finally {
      await handle.close();
    }
  }
  return receipts;
}
