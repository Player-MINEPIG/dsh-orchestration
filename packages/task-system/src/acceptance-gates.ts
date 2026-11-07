import { z } from "zod";

const Key = z.string().min(1).max(200).regex(/^[\w][\w:./@-]*$/);
export const AcceptanceStep = z.object({
  workflowId: Key,
  definitionRevision: z.number().int().positive(),
  stepId: Key,
}).strict();
export type AcceptanceStep = z.infer<typeof AcceptanceStep>;
export const ArmAcceptanceGate = z.object({
  gateId: Key,
  projectId: Key,
  workstreamTaskId: Key,
  upstreamTaskIds: z.array(Key).max(64).default([]),
  upstreamSteps: z.array(AcceptanceStep).max(64).default([]),
  downstreamTaskIds: z.array(Key).max(64).default([]),
  downstreamSteps: z.array(AcceptanceStep).max(64).default([]),
  instructionRef: z.string().trim().min(1).max(2000),
}).strict().refine(value => value.upstreamTaskIds.length + value.upstreamSteps.length > 0, "Select repair Tasks or workflow steps");
export type ArmAcceptanceGate = z.infer<typeof ArmAcceptanceGate>;
export const DecideAcceptanceGate = z.object({
  gateId: Key,
  expectedRevision: z.number().int().positive(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["accept", "request-repair"]),
  humanDecisionRef: z.string().trim().min(1).max(2000),
}).strict();
export type DecideAcceptanceGate = z.infer<typeof DecideAcceptanceGate>;
export const AmendAcceptanceGate = z.object({
  gateId: Key,
  expectedRevision: z.number().int().positive(),
  instructionRef: z.string().trim().min(1).max(2000),
  upstreamTaskIds: z.array(Key).max(64),
  newRepairTasks: z.array(z.object({taskId: Key, title: z.string().trim().min(1).max(500), description: z.string().max(100000).optional()}).strict()).max(16).default([]),
  repairEdits: z.array(z.object({taskId: Key, title: z.string().trim().min(1).max(500).optional(), description: z.string().max(100000).optional(), goal: z.string().max(10000).optional()}).strict()).max(64).default([]),
}).strict();
export const CreateAcceptanceIndependentTask = z.object({
  projectId: Key, backlogId: Key, taskId: Key,
  title: z.string().trim().min(1).max(500), description: z.string().max(100000).optional(),
  expectedGates: z.array(z.object({gateId: Key, revision: z.number().int().positive()}).strict()).max(128),
  instructionRef: z.string().trim().min(1).max(2000),
}).strict();
export const AcceptancePlanningIntent = z.object({
  projectId: Key.optional(), taskId: Key.optional(), title: z.string(), description: z.string(),
}).passthrough();
export type AcceptanceOperation = {gateId: string; operation: "downstream"; invocationId: string; requestDigest: string; expectedRevision: number; candidateDigest: string};
export type AcceptanceInvocation = AcceptanceOperation & {gateRevision: number; candidateDigest: string; admittedAt: string};
export type AcceptanceMember = {gateId: string; operation: "upstream" | "downstream"};
export type AcceptanceGate = ArmAcceptanceGate & {
  revision: number;
  createdAt: string;
  acceptance: null | {candidateDigest: string; humanDecisionRef: string; at: string};
  lastDecision: null | {decision: DecideAcceptanceGate["decision"]; humanDecisionRef: string; at: string};
};
export type AcceptanceCandidate = {
  digest: string;
  ready: boolean;
  taskIds: string[];
  runs: {runId: string; taskId: string; state: string}[];
  reports: {reportId: string; revision: number; title: string; body: string}[];
  runCount: number;
  reportCount: number;
};
export type AcceptanceGateView = AcceptanceGate & {
  state: "repairing" | "awaiting-acceptance" | "released";
  candidate: AcceptanceCandidate;
  invocations: AcceptanceInvocation[];
  invocationCount: number;
  downstreamRuns: {runId: string; taskId: string; state: string; attemptId: string | null}[];
  downstreamRunCount: number;
};
