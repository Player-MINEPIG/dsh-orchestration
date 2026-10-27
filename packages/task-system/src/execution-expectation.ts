import { z } from "zod";

export const ExpectedExecutionMs = z.number().int().min(1).max(30 * 86_400_000);
export type ExecutionExpectation =
  | { phase: "pending_start"; expectedExecutionMs: number }
  | { phase: "started"; expectedExecutionMs: number; startedAt: string };

export type ExecutionExpectationView =
  | { phase: "not_set" }
  | { phase: "pending_start"; expectedExecutionMs: number }
  | { phase: "running" | "due" | "queued" | "processed" | "withdrawn" | "needs_action"; expectedExecutionMs: number; startedAt: string; dueAt: string; messageId?: string; reason?: string };

export const executionCheckId = (runId: string) => `task-execution-check:${runId}`;
export const executionDueAt = (expectation: Extract<ExecutionExpectation,{phase:"started"}>) => new Date(Date.parse(expectation.startedAt) + expectation.expectedExecutionMs).toISOString();
