import { z } from "zod";
import type {
  Json,
  NodeCapability,
  NodeStatus,
  Workspace,
} from "./contracts.js";
import type { ProgramCatalogEntry } from "./workflow-programs.js";
export const WorkflowPosition = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();
const Id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const InputBinding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.json() }).strict(),
  z
    .object({
      kind: z.literal("workflow-input"),
      path: z.array(z.string().max(200)).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("step-output"),
      stepId: Id,
      path: z.array(z.string().max(200)).max(32),
    })
    .strict(),
]);
const StepFields = z
  .object({
    stepId: Id,
    title: z.string().min(1).max(500),
    nodeId: Id,
    stageId: Id.optional(),
    position: WorkflowPosition.optional(),
    dependsOn: z.array(Id).max(100),
    inputs: z.record(z.string().min(1).max(100), InputBinding),
    maxRetries: z.number().int().min(0).max(5),
  })
  .strict();
const BoundExecution = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("program"),
      programId: z.string().min(1).max(100),
      version: z.string().min(1).max(80),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      provider: z.string().min(1).max(100),
      model: z.string().min(1).max(200),
      reasoningEffort: z.string().max(100).optional(),
      instructions: z.string().min(1).max(40000),
      inputExposure: z.enum(["inline", "tools"]).optional(),
      allowedTools: z.array(z.string().min(1).max(200)).max(100),
    })
    .strict(),
]);

export const RunnableWorkflowStep = StepFields.extend({
  workspaceId: Id,
  execution: BoundExecution,
}).strict();
export type RunnableWorkflowStep = z.infer<typeof RunnableWorkflowStep>;
export const WorkflowStep = z.union([
  StepFields.extend({
    workspaceId: Id.optional(),
    execution: z.object({ kind: z.literal("unbound") }).strict(),
  }).strict(),
  RunnableWorkflowStep,
]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;
export const WorkflowDefinition = z
  .object({
    workflowId: Id,
    projectId: Id.optional(),
    stages: z
      .array(
        z
          .object({
            stageId: Id,
            title: z.string().min(1).max(500),
            nodeId: Id,
            position: WorkflowPosition,
          })
          .strict(),
      )
      .max(100)
      .optional(),
    calls: z
      .array(z.object({ fromStepId: Id, toStepId: Id }).strict())
      .max(10000)
      .optional(),
    resultStepIds: z.array(Id).min(1).max(100).optional(),
    revision: z.number().int().nonnegative(),
    title: z.string().min(1).max(500),
    description: z.string().max(20000),
    steps: z.array(WorkflowStep).min(1).max(100),
    schedule: z
      .object({
        enabled: z.boolean(),
        cron: z.string().min(1).max(100),
        timeZone: z.string().min(1).max(100),
        dayOffset: z.union([z.literal(-1), z.literal(0)]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
export const SaveWorkflow = z
  .object({
    commandId: z.string().min(1).max(200),
    expectedRevision: z.number().int().nonnegative(),
    definition: WorkflowDefinition,
  })
  .strict();
export const StartWorkflow = z
  .object({
    commandId: z.string().min(1).max(200),
    taskId: Id.optional(),
    workflowId: Id.optional(),
    input: z.json().optional(),
  })
  .strict();
export const ConfigureWorkflowTask = z
  .object({
    commandId: z.string().min(1).max(200),
    projectId: Id,
    taskId: Id.optional(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(20000).optional(),
    workflowId: Id,
    input: z.json(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export const AdoptWorkflow = z
  .object({
    commandId: z.string().min(1).max(200),
    workflowId: Id,
    projectId: Id,
    taskId: Id.optional(),
  })
  .strict();
export interface WorkflowTaskBinding {
  taskId: string;
  projectId: string;
  workflowId: string;
  input: Json;
  revision: number;
}
export const RetryWorkflowStep = z
  .object({
    commandId: z.string().min(1).max(200),
    workflowRunId: Id,
    stepId: Id,
  })
  .strict();
export const CancelWorkflow = z
  .object({ commandId: z.string().min(1).max(200), workflowRunId: Id })
  .strict();
export type StepState =
  | "pending"
  | "waiting_device"
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "blocked";
export interface WorkflowStepView {
  stepId: string;
  nodeId: string;
  title: string;
  kind: RunnableWorkflowStep["execution"]["kind"];
  state: StepState;
  reason?: string;
  taskId?: string;
  runId?: string;
  reportId?: string;
  output?: Json;
  summary?: string;
  sessionId?: string;
  attemptCount: number;
  retryFromRunId?: string;
}
export interface WorkflowRunView {
  workflowRunId: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  dispatches: {
    stepId: string;
    ordinal: number;
    taskId: string;
    runId: string;
    admittedAt: string;
  }[];
  workflowId: string;
  definitionRevision: number;
  title: string;
  definition: WorkflowDefinition;
  input: Json;
  createdAt: string;
  updatedAt: string;
  state:
    | "running"
    | "succeeded"
    | "partial"
    | "failed"
    | "needs_attention"
    | "cancelled";
  steps: WorkflowStepView[];
}
export interface WorkflowSnapshot {
  definitions: WorkflowDefinition[];
  taskBindings: WorkflowTaskBinding[];
  runs: WorkflowRunView[];
  nodes: NodeStatus[];
  workspaces: Workspace[];
  programs: ProgramCatalogEntry[];
  models: NodeCapability[];
}
