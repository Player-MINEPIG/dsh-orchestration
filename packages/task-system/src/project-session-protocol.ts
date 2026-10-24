import { z } from "zod";

const identity = {
  projectId: z.string().min(1).max(200), generation: z.number().int().nonnegative(),
  nodeId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), cwd: z.string().min(1).max(4096),
};
export const nativeProjectSession = z.object({
  kind: z.literal("native"), ...identity,
  workspaceId: z.string().min(1).max(200), workspaceRevision: z.string().min(1).max(200),
}).strict();
export const projectSessionReference = z.discriminatedUnion("kind", [
  nativeProjectSession,
  z.object({ kind: z.literal("managed"), ...identity }).strict(),
]);
export type NativeProjectSession = z.infer<typeof nativeProjectSession>;
export type ProjectSessionReference = z.infer<typeof projectSessionReference>;

const decisionIdentity = {
  operationId: z.string().min(1).max(200), projectId: z.string().min(1).max(200), old: projectSessionReference,
};
export const projectSessionDecision = z.discriminatedUnion("outcome", [
  z.object({ ...decisionIdentity, outcome: z.literal("commit"), next: nativeProjectSession }).strict(),
  z.object({ ...decisionIdentity, outcome: z.literal("abort"), next: nativeProjectSession.nullable() }).strict(),
]);
export type ProjectSessionDecision = z.infer<typeof projectSessionDecision>;
export type ProjectSessionCommit = Extract<ProjectSessionDecision, { outcome: "commit" }>;

export const projectSessionPrepare = z.object({
  kind: z.literal("prepare"), operationId: z.string().min(1).max(200), projectId: z.string().min(1).max(200),
  generation: z.number().int().positive(), sessionId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200), workspaceRevision: z.string().min(1).max(200),
}).strict();
export type ProjectSessionPrepare = z.infer<typeof projectSessionPrepare>;
export const projectSessionCommand = z.discriminatedUnion("kind", [
  projectSessionPrepare,
  z.object({ kind: z.literal("freeze"), operationId: z.string().min(1).max(200), binding: projectSessionReference }).strict(),
  z.object({ kind: z.literal("activate"), operationId: z.string().min(1).max(200), binding: nativeProjectSession, decision: projectSessionDecision }).strict(),
  z.object({ kind: z.literal("release"), operationId: z.string().min(1).max(200), binding: projectSessionReference, decision: projectSessionDecision }).strict(),
  z.object({ kind: z.literal("status"), operationId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200) }).strict(),
]);
export type ProjectSessionCommand = z.infer<typeof projectSessionCommand>;

export const projectSessionEvidence = z.object({
  kind: z.enum(["prepared", "frozen", "active", "released"]),
  operationId: z.string().min(1).max(200), binding: projectSessionReference, evidenceId: z.string().min(1).max(200),
}).strict();
export type ProjectSessionEvidence = z.infer<typeof projectSessionEvidence>;
export const projectSessionStatus = z.discriminatedUnion("kind", [
  projectSessionEvidence,
  z.object({ kind: z.literal("missing") }).strict(),
  z.object({ kind: z.literal("pending"), operationId: z.string(), binding: projectSessionReference }).strict(),
]);
export type ProjectSessionStatus = z.infer<typeof projectSessionStatus>;

export function sameProjectSession(left: ProjectSessionReference, right: ProjectSessionReference): boolean {
  return left.kind === right.kind && left.projectId === right.projectId && left.generation === right.generation &&
    left.nodeId === right.nodeId && left.sessionId === right.sessionId && left.cwd === right.cwd &&
    (left.kind !== "native" || right.kind === "native" && left.workspaceId === right.workspaceId && left.workspaceRevision === right.workspaceRevision);
}
