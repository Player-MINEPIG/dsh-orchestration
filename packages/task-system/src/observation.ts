import type { SessionEvent } from "@deepseek-ai/dsh-session";
export interface ObservationCandidate {
  candidateId: string;
  sourceId: string;
  sourceRevision: string;
  sessionId: string;
  cwd?: string;
  title: string;
  body: string;
  observedAt: string;
  state: "pending" | "ignored" | "admitted";
  truncated: boolean;
  taskId?: string;
  reportId?: string;
}
export interface CapturedText {
  seq: number;
  sessionId: string;
  cwd?: string;
  sourceId: string;
  sourceRevision: string;
  title: string;
  body: string;
  observedAt: string;
  truncated: boolean;
}
export interface ObservationFold {
  sessionId: string;
  cwd?: string;
  inheritedCut: number;
  excluded: boolean;
  humanSeen: boolean;
  messages: CapturedText[];
  dropped: number;
  lastSeq: number;
}
export function initialObservationState(
  sessionId: string,
  inheritedCut: number,
  excluded = false,
  cwd?: string,
): ObservationFold {
  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    inheritedCut,
    excluded,
    humanSeen: false,
    messages: [],
    dropped: 0,
    lastSeq: -1,
  };
}
const redact = (s: string) =>
  s.replace(
    /\b(?:sk|token|secret|password)[-_:= ]+[A-Za-z0-9_./+-]{12,}\b/gi,
    "[redacted]",
  );
/** Explicit text only: never persist streams, reasoning, tool payloads, system or developer messages. */
export function foldObservation(
  state: ObservationFold,
  event: SessionEvent,
  maxMessages = 64,
  maxText = 8000,
): ObservationFold {
  if (event.seq < state.inheritedCut || event.seq <= state.lastSeq)
    return state;
  if (state.excluded) return { ...state, lastSeq: event.seq };
  if (event.type === "user/message") {
    if (
      event.data.source.kind === "dsh-task" ||
      event.data.source.kind === "dsh-direct-message"
    )
      return { ...state, excluded: true, lastSeq: event.seq, messages: [] };
    if (event.data.source.kind !== "user")
      return { ...state, lastSeq: event.seq };
    return { ...state, humanSeen: true, lastSeq: event.seq };
  }
  if (event.type !== "assistant/message" || !state.humanSeen)
    return { ...state, lastSeq: event.seq };
  const content = event.data.message.content
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n");
  if (!content.trim()) return { ...state, lastSeq: event.seq };
  const body = redact(content.slice(0, maxText));
  const captured: CapturedText = {
    seq: event.seq,
    sessionId: state.sessionId,
    ...(state.cwd ? { cwd: state.cwd } : {}),
    sourceId: `dsh-session:${state.sessionId}`,
    sourceRevision: String(event.seq),
    title: body.split("\n")[0]!.slice(0, 180) || "Observed local work",
    body,
    observedAt: new Date(event.time).toISOString(),
    truncated: content.length > maxText,
  };
  const all = [...state.messages, captured];
  const dropped = Math.max(0, all.length - maxMessages);
  return {
    ...state,
    lastSeq: event.seq,
    messages: all.slice(-maxMessages),
    dropped: state.dropped + dropped,
  };
}
