import { z } from "zod";
import { projectSessionReference } from "./project-session-protocol.js";

const key = z.string().min(1).max(160);
export const stewardScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal") }),
  z.strictObject({ kind: z.literal("project"), projectId: key }),
]);
export type StewardScope = z.infer<typeof stewardScope>;
export const stewardSend = z.strictObject({
  conversationId: key, commandId: key, text: z.string().trim().min(1).max(16000),
  target: stewardScope.optional(), replyTo: key.optional(),
  routingMode: z.literal("auto").optional(),
});
export const stewardRead = z.strictObject({
  conversationId: key, afterSeq: z.number().int().nonnegative().optional(),
});
export const stewardResolve = z.strictObject({
  conversationId: key, messageId: key, commandId: key,
  expectedRevision: z.number().int().nonnegative(),
  expectedState: z.enum(["accepted", "admitted", "needs-reconciliation"]),
  confirm: z.literal(true),
});
export const stewardBinding = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal"), nodeId: key, sessionId: key,
    generation: z.literal(1), cwd: z.string().min(1) }),
  ...projectSessionReference.options,
]);
export type StewardBinding = z.infer<typeof stewardBinding>;
export const stewardState = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("accepted") }),
  z.strictObject({ kind: z.literal("admitted"), requestId: key }),
  z.strictObject({ kind: z.literal("completed") }),
  z.strictObject({ kind: z.literal("needs-reconciliation"), reason: z.string() }),
  z.strictObject({ kind: z.literal("rejected"), reason: z.string() }),
  z.strictObject({ kind: z.literal("stopped"), reason: z.string() }),
  z.strictObject({ kind: z.literal("released"), reason: z.string() }),
]);
export const stewardPersona = z.strictObject({ id: key, version: key });
export const STEWARD_PERSONA = {
  id: "dsh-steward", version: "1",
} satisfies z.infer<typeof stewardPersona>;
export const STEWARD_PERSONA_TEXT = "You are the user's consistent steward. Speak plainly and warmly. Distinguish observed task progress from assumptions. A queued message is not a completed task. Follow the current session's project authority and permissions. Use only this scope's supplied history; do not imply access to other conversations.";
export const stewardManifest = z.strictObject({
  persona: stewardPersona, scope: stewardScope,
  history: z.literal("scope-native-session"),
  evidence: z.literal("selection-only"),
  resources: z.array(z.strictObject({ id: key, version: key })),
});
export const stewardMessage = z.strictObject({
  id: key, seq: z.number().int().positive(), conversationId: key,
  role: z.enum(["user", "assistant", "notification"]), text: z.string(), commandId: key.nullable().default(null),
  scope: stewardScope, replyTo: key.nullable(), createdAt: z.string(),
  source: stewardBinding, nativeSeq: z.number().int().nonnegative().nullable(),
  provenance: z.strictObject({ kind: z.literal("ledger"), eventId: key, eventType: key, taskId: key, runId: key.nullable() }).nullable().default(null),
  state: stewardState, manifest: stewardManifest,
  revision: z.number().int().nonnegative().default(0),
  resolution: z.strictObject({ commandId: key, at: z.string(), priorState: z.enum(["accepted", "admitted", "needs-reconciliation"]) }).nullable().default(null),
});
export type StewardMessage = z.infer<typeof stewardMessage>;
export type StewardManifest = z.infer<typeof stewardManifest>;
export type StewardSend = z.infer<typeof stewardSend>;
export const stewardSourceStatus = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unchecked") }),
  z.strictObject({ kind: z.literal("ready"), observedAt: z.string() }),
  z.strictObject({ kind: z.literal("unavailable"), observedAt: z.string(), reason: z.string() }),
]);
export const stewardRequestObservation = z.strictObject({
  id: key, conversationId: key, source: stewardBinding,
  stepSeq: z.number().int().nonnegative(), observedAt: z.string(),
  requestHash: z.string(), messageHash: z.string(),
  selectedResources: z.array(z.strictObject({ id: key, version: key })),
  personaObserved: z.boolean(), assemblerObserved: z.boolean(), assemblyHash: z.string().nullable(),
});
export type StewardRequestObservation = z.infer<typeof stewardRequestObservation>;
export interface StewardSnapshot {
  authorityId: string;
  conversationId: string;
  currentScope: StewardScope;
  persona: typeof STEWARD_PERSONA;
  messages: StewardMessage[];
  projects: { projectId: string; title: string }[];
  lastSeq: number;
  limitations: string[];
  sources: { source: StewardBinding; status: z.infer<typeof stewardSourceStatus> }[];
  routing: { auto: boolean };
  context: { mode: string; sourceRegistered: boolean; assemblerVersion: string | null; diagnostic: string | null };
  requests: StewardRequestObservation[];
  requestObservation: { kind: "active" | "unavailable"; reason: string | null };
}

