import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-projection";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  initialObservationState,
  foldObservation,
  type ObservationFold,
} from "./observation.js";
import type { TaskLedger } from "./ledger.js";
import type { ObservationCandidate } from "./observation.js";

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    dshTaskObservation: ObservationFold;
  }
}

const capturedSchema = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string(),
  sourceId: z.string(),
  sourceRevision: z.string(),
  title: z.string(),
  body: z.string(),
  observedAt: z.string(),
  truncated: z.boolean(),
  cwd: z.string().optional(),
});
const stateSchema = z.object({
  sessionId: z.string(),
  inheritedCut: z.number().int().nonnegative(),
  excluded: z.boolean(),
  humanSeen: z.boolean(),
  messages: z.array(capturedSchema),
  dropped: z.number().int().nonnegative(),
  lastSeq: z.number().int().min(-1),
  cwd: z.string().optional(),
});

/** Register a bounded, host-only native projection. Observation never dispatches. */
export function mountObservation(
  ctx: Context,
  ledger: TaskLedger,
  bounds: { maxMessages: number; maxText: number },
  publish?: (candidate: ObservationCandidate) => void,
): void {
  const observed = new Map<string, number>();
  const captured = new Map(
    ledger
      .observationCandidates()
      .map(
        (candidate) =>
          [
            JSON.stringify([candidate.sourceId, candidate.sourceRevision]),
            candidate,
          ] as const,
      ),
  );
  ctx.sessionProjections.register({
    key: "dshTaskObservation",
    // Cache validity includes retention bounds, so a config edit cannot restore
    // an older projection with a larger text/history retention limit.
    stateVersion: 20_000_000 + bounds.maxMessages * 10_000 + bounds.maxText,
    stateSchema,
    init: (header, inheritedCut) =>
      initialObservationState(
        header.id,
        inheritedCut,
        header.origin === "subagent",
        header.cwd,
      ),
    apply: (state, event) =>
      foldObservation(state, event, bounds.maxMessages, bounds.maxText),
  });
  const capture = (session: Session) => {
    const state = ctx.sessionProjections.stateOf(session, "dshTaskObservation");
    if (!state || state.excluded) return;
    const prior = observed.get(session.id);
    const key = createHash("sha256").update(session.id).digest("hex");
    if (prior === undefined && state.dropped > 0) {
      ledger.recordObservationGap(`observation-gap:${key}:${state.lastSeq}`, {
        sessionId: session.id,
        dropped: state.dropped,
        asOfSeq: state.lastSeq,
      });
    }
    for (const message of state.messages) {
      if (prior !== undefined && message.seq <= prior) continue;
      const revision = JSON.stringify([
        message.sourceId,
        message.sourceRevision,
      ]);
      // A projection schema/bounds upgrade must not rewrite durable historical
      // text or change a previous receipt hash. Older records without verified
      // cwd remain local-only, even when a session is later resumed.
      const candidate =
        captured.get(revision) ??
        ledger.captureObservation(`observation:${key}:${message.seq}`, message)
          .value;
      captured.set(revision, candidate);
      // The durable local candidate exists before an optional network sink is
      // notified. A failed or detached sink can replay it after restart.
      publish?.(candidate);
    }
    observed.set(session.id, state.lastSeq);
  };
  // The registry reconstructs persisted/replayed seeds through its supported
  // fold API. No deprecated eventAt/snapshotEvents raw-log access is used.
  ctx.on("session/created", capture);
  ctx.on("session/event", (session) => capture(session));
  ctx.on("session/disposed", (session) => {
    observed.delete(session.id);
  });
  for (const session of ctx.sessions.list()) capture(session);
}
