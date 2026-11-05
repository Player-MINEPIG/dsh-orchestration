import { z } from "zod";
import { stewardPermission } from "./steward-turn-permission.js";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import { projectSessionReference } from "./project-session-protocol.js";
import { ArmAcceptanceGate, AmendAcceptanceGate } from "./acceptance-gates.js";

const key = z.string().min(1).max(160);
export const stewardScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal") }),
  z.strictObject({ kind: z.literal("workbench") }),
  z.strictObject({ kind: z.literal("project"), projectId: key }),
]);
export type StewardScope = z.infer<typeof stewardScope>;
export const stewardSourceSession = z.strictObject({ conversationId: key, scope: stewardScope });
export const stewardQuoteInput = z.strictObject({
  messageId: key, expectedRevision: z.number().int().nonnegative(),
  excerpt: z.string().min(1).max(2000).refine(text => text.trim().length > 0),
});
export const stewardSelection = z.strictObject({ provider: key, model: z.string().min(1).max(500), reasoningEffort: key.optional() });
const fileRef = z.strictObject({ attachmentId: z.string().min(1).max(200).transform(AttachmentId), name: z.string().min(1).max(500), bytes: z.number().int().nonnegative() });
const imageRef = fileRef.omit({ name: true }).extend({ name: z.string().max(500).optional(), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), width: z.number().int().positive(), height: z.number().int().positive(), originalDimensions: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).optional() });
export const stewardContent = z.array(z.discriminatedUnion("type", [z.strictObject({ type: z.literal("text"), text: z.string() }), z.strictObject({ type: z.literal("image"), attachment: imageRef }), z.strictObject({ type: z.literal("file"), attachment: fileRef })])).max(100);
export const stewardUpload = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("start"), conversationId: key, commandId: key, bytes: z.number().int().nonnegative().max(8388608), name: z.string().min(1).max(500), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).optional() }),
  z.strictObject({ kind: z.literal("part"), conversationId: key, uploadId: key, index: z.number().int().nonnegative(), data: z.string().min(4).max(32768) }),
  z.strictObject({ kind: z.literal("finish"), conversationId: key, uploadId: key }),
  z.strictObject({ kind: z.literal("abort"), conversationId: key, uploadId: key }),
]);
export const stewardUploadRead = z.strictObject({ conversationId: key, uploadId: key, offset: z.number().int().nonnegative().default(0) });
export const stewardAttachmentRead = z.strictObject({ conversationId: key, messageId: key, attachmentId: z.string().min(1).max(200), offset: z.number().int().nonnegative().default(0) });
export const stewardSend = z.strictObject({
  conversationId: key, commandId: key, text: z.string().trim().max(16000),
  uploads: z.array(key).max(32).optional(), selection: stewardSelection.optional(), permissionPreset: key.optional(),
  target: stewardScope.optional(), replyTo: key.optional(), contextAnchor: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("canonical"), messageId: key, throughSeq: z.number().int().nonnegative() }), z.strictObject({ kind: z.literal("predecessor"), commandId: key })]).optional(),
  routingMode: z.literal("auto").optional(),
  quote: stewardQuoteInput.optional(),
}).superRefine((value, ctx) => {
  if (!value.text && !value.uploads?.length) ctx.addIssue({ code: "custom", path: ["text"], message: "A message requires text or an attachment" });
  if (value.quote && value.replyTo)
    ctx.addIssue({ code: "custom", path: ["quote"], message: "A quotation cannot be combined with a reply" });
});
export const stewardRead = z.strictObject({
  conversationId: key, afterSeq: z.number().int().nonnegative().optional(),
  beforeSeq: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  knownIds: z.array(key).max(300).default([]),
  commandId: key.optional(),
}).superRefine((value, ctx) => {
  if (value.afterSeq !== undefined && value.beforeSeq !== undefined)
    ctx.addIssue({ code: "custom", message: "Choose either older history or new messages" });
});
export const stewardResolve = z.strictObject({
  conversationId: key, messageId: key, commandId: key,
  expectedRevision: z.number().int().nonnegative(),
  expectedState: z.enum(["accepted", "admitted", "needs-reconciliation"]),
  confirm: z.literal(true),
});
const gateKey = ArmAcceptanceGate.shape.gateId;
export const stewardGateRead = z.strictObject({ conversationId: key, projectId: key, gateId: gateKey.optional(), beforeRowId: z.number().int().positive().optional() });
const { instructionRef: _armReference, ...armFields } = ArmAcceptanceGate.shape;
const { instructionRef: _amendReference, ...amendFields } = AmendAcceptanceGate.shape;
export const stewardGateArm = z.strictObject({ conversationId: key, commandId: key,
  gate: z.strictObject(armFields), instruction: z.string().trim().min(1).max(1500) });
export const stewardGateDecide = z.strictObject({ conversationId: key, commandId: key, gateId: key,
  expectedRevision: z.number().int().positive(), candidateDigest: z.string().min(1).max(200),
  decision: z.enum(["accept", "request-repair"]), comment: z.string().max(1500).default("") });
export const stewardGateAmend = z.strictObject({ conversationId: key, commandId: key,
  change: z.strictObject(amendFields), comment: z.string().trim().min(1).max(1500) });
export const stewardGateContinue = z.strictObject({ conversationId: key, commandId: key, gateId: key,
  expectedRevision: z.number().int().positive(), candidateDigest: z.string().min(1).max(200), text: z.string().trim().min(1).max(16000) });
export const stewardGateAcceptContinue = stewardGateContinue.extend({ commandId: key.max(140), comment: z.string().max(1000).default("") });
export const stewardGateIndependent = z.strictObject({ conversationId: key, commandId: key.max(140), projectId: key, backlogId: key,
  title: z.string().trim().min(1).max(500), description: z.string().max(8000).default(""), gateSnapshotDigest: z.string().min(1).max(200) });
export const stewardBinding = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal"), nodeId: key, sessionId: key,
    generation: z.literal(1), cwd: z.string().min(1) }),
  z.strictObject({ kind: z.literal("workbench"), nodeId: key, sessionId: key,
    generation: z.literal(1), cwd: z.string().min(1) }),
  ...projectSessionReference.options,
]);
export type StewardBinding = z.infer<typeof stewardBinding>;
export const stewardQuote = z.strictObject({
  messageId: key, revision: z.number().int().nonnegative(), scope: stewardScope,
  source: stewardBinding, sourceContentHash: z.string().length(64),
  excerpt: z.string().min(1).max(2000), excerptHash: z.string().length(64), authorizedAt: z.string(),
});
export type StewardQuote = z.infer<typeof stewardQuote>;
export const stewardState = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("accepted") }),
  z.strictObject({ kind: z.literal("queued"), requestId: key }),
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
  role: z.enum(["user", "assistant", "notification"]), text: z.string(), content: stewardContent.optional(), selection: stewardSelection.optional(), permission: stewardPermission.optional(), commandId: key.nullable().default(null),
  creationContext: z.strictObject({ instructionId: key, messageIds: z.array(key).min(1).max(11) }).optional(),
  scope: stewardScope, route: z.strictObject({ reason: z.enum(["unassigned", "clarification", "unavailable", "timeout", "provider", "invalid-output", "continuation"]), notice: z.string().max(500), anchorMessageId: key.optional(), responseMessageId: key.optional() }).optional(), replyTo: key.nullable(), createdAt: z.string(),
  source: stewardBinding, nativeSeq: z.number().int().nonnegative().nullable(),
  provenance: z.strictObject({ kind: z.literal("ledger"), eventId: key, eventType: key, taskId: key, runId: key.nullable() }).nullable().default(null),
  state: stewardState, manifest: stewardManifest,
  revision: z.number().int().nonnegative().default(0),
  quote: stewardQuote.nullable().default(null),
  gate: z.strictObject({ gateId: key, revision: z.number().int().positive(), candidateDigest: z.string(), state: z.enum(["repairing", "awaiting-acceptance", "released"]) }).nullable().default(null),
  resolution: z.strictObject({ commandId: key, at: z.string(), priorState: z.enum(["accepted", "admitted", "needs-reconciliation"]) }).nullable().default(null),
});
export type StewardMessage = z.infer<typeof stewardMessage>;
export const stewardMessageUpdate = stewardMessage.pick({ id: true, revision: true, state: true, resolution: true });
export type StewardMessageUpdate = z.infer<typeof stewardMessageUpdate>;
export const stewardAttention = stewardMessage.pick({ id: true, seq: true, scope: true, state: true, revision: true }).extend({ preview: z.string().max(160) });
export type StewardManifest = z.infer<typeof stewardManifest>;
export type StewardSend = z.infer<typeof stewardSend>;
export const stewardSourceStatus = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unchecked") }),
  z.strictObject({ kind: z.literal("ready"), observedAt: z.string() }),
  z.strictObject({ kind: z.literal("catching-up"), observedAt: z.string() }),
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
  media?: { imageLimits: import("@deepseek-ai/dsh-attachment").ImageAttachmentLimits; maxFileBytes: number; chunkBytes: number };
  persona: typeof STEWARD_PERSONA;
  messages: StewardMessage[];
  updates: StewardMessageUpdate[];
  attention: { items: z.infer<typeof stewardAttention>[]; hasMore: boolean };
  references: { id: string; scope: StewardScope; preview: string }[];
  commandMessage: StewardMessage | null;
  page: { firstStoredSeq: number | null; lastStoredSeq: number; firstSeq: number | null; lastSeq: number | null; hasOlder: boolean; hasNewer: boolean; limit: number };
  projects: { projectId: string; title: string; bindingToken: string }[];
  topicActivity: {
    activeDays: number; cutoffAt: string; observedAt: string;
    items: { scope: StewardScope; title: string; lastActiveAt: string }[]; hasMore: boolean;
    latestMessage: { id: string; scope: StewardScope; createdAt: string } | null;
  };
  lastSeq: number;
  limitations: string[];
  sources: { source: StewardBinding; status: z.infer<typeof stewardSourceStatus> }[];
  routing: { auto: boolean; anchorMessageId?: string };
  context: { mode: string; sourceRegistered: boolean; assemblerVersion: string | null; diagnostic: string | null };
  requests: StewardRequestObservation[];
  requestObservation: { kind: "active" | "unavailable"; reason: string | null };
}

