import { stewardRead, stewardSend, stewardResolve, stewardGateRead, stewardGateArm, stewardGateDecide, stewardGateAmend, stewardGateContinue, stewardGateAcceptContinue, stewardGateIndependent } from "./steward-contracts.js";
import { stewardMemoryRead, stewardMemoryConfigure } from "./steward-memory.js";
import { ProtocolError } from "./remote/protocol.js";
import { ExpectedExecutionMs } from "./execution-expectation.js";
import { CentralTaskControl } from "./central-control.js";
import { deploymentPolicy } from "./deployment.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { ProjectNativeOperation } from "./project-session-native.js";
import {executorAlertFingerprint} from "./executor-alerts.js";
import { executorPanelSnapshot, type ExecutorPanelRecord } from "./executor-panel.js";
import { ExecutionModelChoice, ExecutionModelsError, sameExecutionModel } from "./execution-models.js";
import { randomUUID } from "node:crypto";
import {readConnectionSettings,saveConnectionSettings,SaveConnectionInput} from "./connection-settings.js";
import { SaveWorkflow, StartWorkflow, RetryWorkflowStep, CancelWorkflow, ConfigureWorkflowTask, AdoptWorkflow } from "./workflow-contracts.js";
import { scheduledPlanInput, scheduledPlanControl } from "./scheduled-plans.js";
import { SessionDispatchIndex, sessionDispatchOperations, sessionTaskSnapshot, sortSessionTasks } from "./session-task-monitor.js";
import type { SessionJobRegistry } from "./session-codex-jobs.js";
import type {} from "./local-codex.js";
import { readDecisionPreferences, saveDecisionPreference } from "./decision-preferences.js";
import {
  DecisionSettings,
  SaveDecisionInput,
  SaveDecisionResult,
  readDecisionSettings,
  saveDecisionSettings,
} from "./decision-settings.js";
import {
  StartupSettings,
  SaveStartupInput,
  SaveStartupResult,
  readStartupSettings,
  saveStartupSettings,
  StartupSettingsError,
  CheckConnectionInput,
  CheckConnectionResult,
  checkStartupConnection,
} from "./startup-settings.js";
/** Optional official Web settings companion. No tasks, database or credentials are owned here. */
import { Context } from "@deepseek-ai/cordis";
import {
  TypertRemoteService,
  RemoteError,
  type InvocationDescriptor,
} from "@deepseek-ai/dsh-typert-protocol";
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    "task/startup": { readonly reason: string };
    "task/project": { readonly reason: string };
    "task/steward": { readonly reason: string; readonly detail: string; readonly admission?: "stored" | "in-flight" | "not-admitted"; readonly actionOutcome?: "not-applied" | "may-have-applied" };
  }
}
import { z } from "zod";
import { resolve, join, basename } from "node:path";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { TaskError } from "./ledger.js";
import type { TaskSystemService } from "./dsh-plugin.js";
import type { RemoteExecutionService } from "./remote/index.js";

const ExecutorIdentity = z.object({
  schedulerId: z.string(),
  executorId: z.string(),
  nodeId: z.string(),
});
const QueueSnapshot = z.object({
  sampledAt: z.string(),
  nodeId: z.string(),
  items: z.array(
    z.object({
      taskId: z.string(),
      runId: z.string(),
      title: z.string(),
      state: z.string(),
      sessionId: z.string().nullable(),
      workspaceId: z.string().nullable(),
      projectTitle: z.string().nullable().optional(),
      executionDirectory: z.string().nullable().optional(),
    }),
  ),
  truncated: z.boolean(),
});
export const WorkspaceCatalog = z.object({
  scope: z.object({
    entryId: z.string(),
    nodeId: z.string(),
    schedulerId: z.string(),
  }),
  source: z.enum(["official", "task"]),
  items: z.array(
    z.object({
      workspaceId: z.string(),
      title: z.string(),
      path: z.string(),
      available: z.boolean(),
    }),
  ),
});
export const workspaceCatalogDescriptor: InvocationDescriptor = {
  id: "@dsh-task/task-system#taskPluginSettings/workspaces",
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method: "workspaces",
  invocation: { kind: "direct" },
  parameters: [],
  result: {
    mode: "strict",
    typeSymbol: "@dsh-task/task-system#WorkspaceCatalog",
    create: () => WorkspaceCatalog,
  },
};
export const ExecutionPresetCatalog = z.object({
  items:z.array(z.object({id:z.string(),label:z.string(),description:z.string(),available:z.boolean(),diagnostic:z.string().nullable()})),
});
export const executionPresetsDescriptor: InvocationDescriptor = {
  id:"@dsh-task/task-system#taskPluginSettings/executionPresets",service:"taskPluginSettings",namespace:"taskPluginSettings",method:"executionPresets",invocation:{kind:"direct"},parameters:[],
  result:{mode:"strict",typeSymbol:"@dsh-task/task-system#ExecutionPresetCatalog",create:()=>ExecutionPresetCatalog},
};
interface OfficialWorkspaceMetadata {
  // rc.2 entities expose title/path; sparse descriptors can omit them.
  path?: string;
  title?: string;
  name?: string;
  status?(): Promise<"ok" | "missing-dir">;
}
interface WorkspaceRegistryPort {
  list(): readonly OfficialWorkspaceMetadata[];
  resolveByPath?(path: string): Promise<OfficialWorkspaceMetadata | undefined>;
}
function workspaceTitle(...values: unknown[]): string {
  for (const value of values)
    if (typeof value === "string" && value.trim()) return value.trim();
  return "未命名";
}
const ReadonlySettings = z.object({
  schedulerId: z.string(),
  defaultWorkspaceId: z.string().nullable(),
  sessionDecisionEnabled: z.boolean(),
  planningDecisionEnabled: z.boolean(),
  nodeId: z.string(),
  role: z.enum(["planner", "executor", "both"]),
  databasePath: z.string(),
  profilePatch: z.string().nullable(),
  homePatch: z.string().nullable(),
  commandLineConfigOverride: z.boolean(),
  keepAlive: z.boolean(),
  maintenanceIntervalMs: z.number(),
  leaseTtlMs: z.number(),
  executionTools: z.array(z.string()),
  executionToolsMode: z.enum(["preset", "allowlist"]).optional(),
  remote: z
    .object({
      role: z.enum(["planner", "executor", "both"]),
      nodeId: z.string(),
      endpoint: z.string().nullable(),
      pollIntervalMs: z.number(),
      concurrency: z.number(),
      polling: z.boolean(),
      paused: z.boolean(),
      authMode: z.string(),
      executorIdentity: ExecutorIdentity.nullable(),
      taskSessionsEnabled: z.boolean(),
    })
    .nullable(),
});
export const settingsDescriptor: InvocationDescriptor = {
  id: "@dsh-task/task-system#taskPluginSettings/describe",
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method: "describe",
  invocation: { kind: "direct" },
  parameters: [],
  result: {
    mode: "strict",
    typeSymbol: "@dsh-task/task-system#ReadonlySettings",
    create: () => ReadonlySettings,
  },
};

export const queueDescriptor: InvocationDescriptor = {
  id: "@dsh-task/task-system#taskPluginSettings/queue",
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method: "queue",
  invocation: { kind: "direct" },
  parameters: [],
  result: {
    mode: "strict",
    typeSymbol: "@dsh-task/task-system#QueueSnapshot",
    create: () => QueueSnapshot,
  },
};
export const executorIdentityDescriptor: InvocationDescriptor = {
  id: "@dsh-task/task-system#taskPluginSettings/executorIdentity",
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method: "executorIdentity",
  invocation: { kind: "direct" },
  parameters: [],
  result: {
    mode: "strict",
    typeSymbol: "@dsh-task/task-system#ExecutorIdentity",
    create: () => ExecutorIdentity,
  },
};

export const startupDescriptor: InvocationDescriptor = {
  id: "@dsh-task/task-system#taskPluginSettings/startup",
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method: "startup",
  invocation: { kind: "direct" },
  parameters: [],
  result: {
    mode: "strict",
    typeSymbol: "@dsh-task/task-system#StartupSettings",
    create: () => StartupSettings,
  },
};
export const saveStartupDescriptor: InvocationDescriptor = {
  id: "@dsh-task/task-system#taskPluginSettings/saveStartup",
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method: "saveStartup",
  invocation: { kind: "direct" },
  parameters: [
    {
      name: "input",
      wire: "input",
      source: "json",
      codec: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#SaveStartupInput",
        create: () => SaveStartupInput,
      },
    },
  ],
  result: {
    mode: "strict",
    typeSymbol: "@dsh-task/task-system#SaveStartupResult",
    create: () => SaveStartupResult,
  },
};
export const checkConnectionDescriptor: InvocationDescriptor = {
  id: "@dsh-task/task-system#taskPluginSettings/checkConnection",
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method: "checkConnection",
  invocation: { kind: "direct" },
  parameters: [
    {
      name: "input",
      wire: "input",
      source: "json",
      codec: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#CheckConnectionInput",
        create: () => CheckConnectionInput,
      },
    },
  ],
  result: {
    mode: "strict",
    typeSymbol: "@dsh-task/task-system#CheckConnectionResult",
    create: () => CheckConnectionResult,
  },
};

export const decisionSettingsDescriptor: InvocationDescriptor = {
  id: "@dsh-task/task-system#taskPluginSettings/decisionSettings",
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method: "decisionSettings",
  invocation: { kind: "direct" },
  parameters: [],
  result: {
    mode: "strict",
    typeSymbol: "@dsh-task/task-system#DecisionSettings",
    create: () => DecisionSettings,
  },
};
export const saveDecisionSettingsDescriptor: InvocationDescriptor = {
  id: "@dsh-task/task-system#taskPluginSettings/saveDecisionSettings",
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method: "saveDecisionSettings",
  invocation: { kind: "direct" },
  parameters: [
    {
      name: "input",
      wire: "input",
      source: "json",
      codec: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#SaveDecisionInput",
        create: () => SaveDecisionInput,
      },
    },
  ],
  result: {
    mode: "strict",
    typeSymbol: "@dsh-task/task-system#SaveDecisionResult",
    create: () => SaveDecisionResult,
  },
};
const SetDecisionPresetInput = z
  .object({
    expected: z.string().min(1),
    consumer: z.enum(["task-planning"]),
    id: z.string().max(256),
  })
  .strict();
export const decisionPresetDescriptors: InvocationDescriptor[] = [
  "decisionConsole",
  "setDecisionPreset",
].map((method) => ({
  id: `@dsh-task/task-system#taskPluginSettings/${method}`,
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method,
  invocation: { kind: "direct" },
  parameters:
    method === "setDecisionPreset"
      ? [
          {
            name: "input",
            wire: "input",
            source: "json",
            codec: {
              mode: "strict",
              typeSymbol: "@dsh-task/task-system#SetDecisionPresetInput",
              create: () => SetDecisionPresetInput,
            },
          },
        ]
      : [],
  result: {
    mode: "strict",
    typeSymbol: `@dsh-task/task-system#${method}Result`,
    create: () => z.json(),
  },
}));
/** Higher CLI insertions and overrides both outrank profile form writes. */
export function hasTaskConfigOverride(patches: readonly unknown[]): boolean {
  return patches.some((value) => {
    if (!value || typeof value !== "object") return false;
    const patch = value as {
      id?: string;
      name?: string;
      config?: unknown;
      insert?: unknown[];
    };
    return (
      ((patch.id === "task-system" ||
        patch.name === "@dsh-task/task-system/plugin") &&
        Object.hasOwn(patch, "config")) ||
      (Array.isArray(patch.insert) && hasTaskConfigOverride(patch.insert))
    );
  });
}

const projectInputs = {
  stewardSnapshot: stewardRead,
  stewardSend,
  stewardReconcile: stewardRead,
  stewardResolve,
  stewardMemoryRead,
  stewardMemoryConfigure,
  stewardGateRead, stewardGateArm, stewardGateDecide, stewardGateAmend, stewardGateContinue, stewardGateAcceptContinue, stewardGateIndependent,
  nodeModelSettings:z.object({nodeId:z.string().min(1).max(128)}).strict(),
  refreshNodeModels:z.object({nodeId:z.string().min(1).max(128)}).strict(),
  saveNodeModelDefault:z.object({nodeId:z.string().min(1).max(128),expectedRevision:z.number().int().nonnegative(),expectedCatalogRevision:z.string().min(1),choice:ExecutionModelChoice}).strict(),
  connectionSettings:null,
  saveConnectionSettings:SaveConnectionInput,
  workflowView:z.object({workflowRunId:z.string().min(1).max(200).nullable()}).strict(),
  setTaskPresentation:z.object({commandId:z.string().min(1).max(200),taskId:z.string().min(1).max(200),visibility:z.enum(["primary","execution"])}).strict(),
  getProjectReportPresentation:z.object({reportId:z.string().min(1).max(200),contentVersion:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  readProjectReport:z.object({commandId:z.string().min(1).max(200),reportId:z.string().min(1).max(200),contentVersion:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  configureWorkflowTask: ConfigureWorkflowTask,
  adoptWorkflow: AdoptWorkflow,
  createProjectTask: z.object({commandId:z.string().min(1).max(200),projectId:z.string().min(1),title:z.string().trim().min(1).max(500),description:z.string().trim().min(1).max(20000),routeId:z.string().min(1),start:z.boolean(),expectedExecutionMs:ExpectedExecutionMs.optional()}).strict(),
  runProjectTask: z.object({commandId:z.string().min(1).max(200),taskId:z.string().min(1),expectedExecutionMs:ExpectedExecutionMs.optional()}).strict(),
  workflowSnapshot: null,
  workflowPage: null,
  saveWorkflow: SaveWorkflow,
  startWorkflow: StartWorkflow,
  retryWorkflowStep: RetryWorkflowStep,
  cancelWorkflow: CancelWorkflow,
  sessionTasks: z.object({ sessionId: z.string().min(1).max(200) }).strict(),
  scheduleOptions:null,
  createScheduledPlan:scheduledPlanInput,
  controlScheduledPlan:scheduledPlanControl,
  projectExecutionSettings: z.object({projectId:z.string().min(1).max(200)}).strict(),
  saveProjectExecutionSettings: z.object({commandId:z.string().min(1).max(200).optional(),projectId:z.string().min(1).max(200),expectedRevision:z.number().int().nonnegative(),allowedNodeIds:z.array(z.string().min(1).max(200)).max(128).nullable(),executionBindings:z.record(z.string().min(1).max(200),z.string().min(1).max(200)).refine(value=>Object.keys(value).length<=128),coordinatorWorkspace:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("registered"),nodeId:z.string().min(1),workspaceId:z.string().min(1),catalogRevision:z.string().min(1).max(200).optional()}).strict(),
    z.object({kind:z.literal("directory"),nodeId:z.string().min(1),path:z.string().min(1).max(4096)}).strict(),
  ]).optional()}).strict(),
  setExecutorAlertDisposition:z.object({recordId:z.string().min(1).max(300),fingerprint:z.string().min(1).max(200),acknowledged:z.boolean()}).strict(),
  executorWorkspaceGrants: null,
  setExecutorWorkspaceGrant: z.object({registryId:z.string().min(1).max(256),enabled:z.boolean(),expectedRevision:z.number().int().nonnegative()}).strict(),
  projectSettings: null,
  executionDirectorySettings: null,
  saveExecutionDirectorySettings: z.object({root: z.string().min(1).max(4096), expectedRevision: z.number().int().nonnegative()}).strict(),
  setReportRetryLimit:z.object({commandId:z.string().min(1).max(200),taskId:z.string().min(1),expectedRevision:z.number().int().positive(),maxRetries:z.number().int().min(0).max(5)}).strict(),
  projectSnapshot: z.object({view:z.enum(["planner","executor"]).optional()}).strict(),
  projectPage: null,
  saveProjectSettings: z
    .object({
      root: z.string().min(1).max(4096),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  createProject: z
    .object({
      commandId: z.string().min(1).max(200),
      title: z.string().min(1).max(500),
      goal: z.string().min(1).max(20000),
      workspace: z.discriminatedUnion("kind", [
        z.object({kind:z.literal("registered"),nodeId:z.string().min(1),workspaceId:z.string().min(1)}).strict(),
        z.object({kind:z.literal("directory"),nodeId:z.string().min(1),path:z.string().min(1).max(4096)}).strict(),
      ]).optional(),
      selection: z.object({provider:z.string().min(1),model:z.string().min(1),reasoningEffort:z.string().min(1).optional()}).strict().optional(),
    })
    .strict(),
  createTemporaryTask: z
    .object({
      commandId: z.string().min(1).max(200),
      title: z.string().min(1).max(500),
      description: z.string().min(1).max(20000),
    })
    .strict(),
  conversationModels: null,
  selectConversationModel: z
    .object({
      projectId: z.string().min(1).optional(),
      taskId: z.string().min(1).optional(),
      expectedRevision: z.number().int().min(0),
      selection: z
        .object({
          provider: z.string().min(1),
          model: z.string().min(1),
          reasoningEffort: z.string().min(1).optional(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  sendExecutorMessage: z
    .object({
      projectId: z.string().min(1).optional(),
      taskId: z.string().min(1),
      nodeId: z.string().min(1),
      sessionId: z.string().min(1),
      commandId: z.string().min(1).max(128),
      text: z.string().min(1).max(8000),
    })
    .strict(),
  taskConversation: z.object({ taskId: z.string().min(1) }).strict(),
  sendTaskMessage: z
    .object({
      taskId: z.string().min(1),
      commandId: z.string().min(1).max(200),
      text: z.string().min(1).max(20000),
    })
    .strict(),
  projectConversation: z.object({ projectId: z.string().min(1), generation: z.number().int().nonnegative().optional() }).strict(),
  projectNativeConversation: z.object({ commandId:z.string().min(1).max(200),projectId:z.string().min(1).max(200),generation:z.number().int().nonnegative().optional(),operation:ProjectNativeOperation }).strict(),
  sendProjectMessage: z
    .object({
      projectId: z.string().min(1),
      commandId: z.string().min(1).max(200),
      text: z.string().min(1).max(20000),
    })
    .strict(),
  handoffProject: z.object({ projectId: z.string().min(1),commandId:z.string().min(1).max(200).optional() }).strict(),
  actOnProjectTask: z
    .object({
      commandId: z.string().min(1).max(200),
      taskId: z.string().min(1),
      expectedVersion: z.string().min(1).max(200),
      runId: z.string().min(1).nullable(),
      confirmationRevision: z.number().int().positive().default(1),
      retryPrompt: z.string().max(20000).optional(),
      returnMessageId: z.string().min(1).max(200).optional(),
      action: z.enum([
        "complete-materials",
        "complete",
        "handle",
        "restore",
        "cancel",
        "approve",
        "accept",
        "reject",
        "confirm-stopped",
        "status",
        "retry", "repair", "check", "retry-return",
      ]),
    })
    .strict(),
  reviewProjectTask: z
    .object({
      commandId: z.string().min(1).max(200),
      taskId: z.string().min(1),
    })
    .strict(),
};
export const projectDescriptors: InvocationDescriptor[] = Object.entries(
  projectInputs,
).map(([method, input]) => ({
  id: `@dsh-task/task-system#taskPluginSettings/${method}`,
  service: "taskPluginSettings",
  namespace: "taskPluginSettings",
  method,
  invocation: { kind: "direct" },
  parameters: input
    ? [
        {
          name: "input",
          wire: "input",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: `@dsh-task/task-system#${method}Input`,
            create: () => input,
          },
        },
      ]
    : [],
  result: {
    mode: "strict",
    typeSymbol: `@dsh-task/task-system#${method}Result`,
    create: () => (["projectPage", "workflowPage"].includes(method) ? z.string() : z.json()),
  },
}));

export class TaskPluginSettings extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, "taskPluginSettings");
  }
  private stewardService() {
    const task = this.ctx.get("taskSystem");
    if (!task?.steward || deploymentPolicy(task.config).centralMode !== "host")
      throw new RemoteError("task/project", "Steward conversation requires a local planner", { reason: "PLANNER_REQUIRED" });
    return task.steward;
  }
  private async stewardOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof TaskError || error instanceof ProtocolError) throw new RemoteError("task/steward", "Steward operation rejected", { reason: error.code, detail: error.message.slice(0,2000) });
      throw error;
    }
  }
  private async stewardHumanOperation<T>(commandId: string, kind: "simple" | "continue" | "accept-continue" | "independent", operation: () => T | Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof TaskError || error instanceof ProtocolError) throw new RemoteError("task/steward", "Steward action rejected", {
        reason: error.code, detail: error.message.slice(0,2000), actionOutcome: this.stewardService().humanActionApplied(commandId,kind) ? "may-have-applied" : "not-applied",
      });
      throw error;
    }
  }
  async stewardSnapshot(input: unknown) { return this.stewardOperation(() => this.stewardService().snapshot(stewardRead.parse(input))); }
  async stewardSend(input: unknown) {
    return this.stewardOperation(async () => {
      const service = this.stewardService(), request = stewardSend.parse(input);
      try { return await service.send(request); }
      catch (error) {
        if (error instanceof TaskError || error instanceof ProtocolError) throw new RemoteError("task/steward", "Steward send rejected", {
          reason: error.code, detail: error.message.slice(0,2000), admission: service.commandStatus(request.conversationId, request.commandId),
        });
        throw error;
      }
    });
  }
  async stewardReconcile(input: unknown) { return this.stewardOperation(() => this.stewardService().reconcile(stewardRead.parse(input))); }
  async stewardResolve(input: unknown) { return this.stewardOperation(() => this.stewardService().resolve(stewardResolve.parse(input))); }
  async stewardMemoryRead(input: unknown) { return this.stewardOperation(() => this.stewardService().memoryConfiguration(stewardMemoryRead.parse(input))); }
  async stewardMemoryConfigure(input: unknown) { return this.stewardOperation(() => this.stewardService().configureMemory(stewardMemoryConfigure.parse(input))); }
  async stewardGateRead(input: unknown) { return this.stewardOperation(() => this.stewardService().gateRead(stewardGateRead.parse(input))); }
  async stewardGateArm(input: unknown) { const request=stewardGateArm.parse(input);return this.stewardHumanOperation(request.commandId,"simple",()=>this.stewardService().gateArm(request)); }
  async stewardGateDecide(input: unknown) { const request=stewardGateDecide.parse(input);return this.stewardHumanOperation(request.commandId,"simple",()=>this.stewardService().gateDecide(request)); }
  async stewardGateAmend(input: unknown) { const request=stewardGateAmend.parse(input);return this.stewardHumanOperation(request.commandId,"simple",()=>this.stewardService().gateAmend(request)); }
  async stewardGateContinue(input: unknown) { const request=stewardGateContinue.parse(input);return this.stewardHumanOperation(request.commandId,"continue",()=>this.stewardService().gateContinue(request)); }
  async stewardGateAcceptContinue(input: unknown) { const request=stewardGateAcceptContinue.parse(input);return this.stewardHumanOperation(request.commandId,"accept-continue",()=>this.stewardService().gateAcceptContinue(request)); }
  async stewardGateIndependent(input: unknown) { const request=stewardGateIndependent.parse(input);return this.stewardHumanOperation(request.commandId,"independent",()=>this.stewardService().gateIndependent(request)); }
  private workflowService() {
    const service = this.ctx.get("taskSystem");
    if (!service || deploymentPolicy(service.config).centralMode === "remote") throw new RemoteError("task/project", "Workflow center requires a planner", {reason:"PLANNER_REQUIRED"});
    return service.workflows;
  }
  async configureWorkflowTask(input:unknown) { return this.projectOperation(()=>this.workflowService().configureTask(projectInputs.configureWorkflowTask.parse(input))); }
  async adoptWorkflow(input:unknown) { return this.projectOperation(()=>this.workflowService().adopt(projectInputs.adoptWorkflow.parse(input))); }
  async createProjectTask(input:unknown) { return this.projectOperation(()=>this.projects().createDirectTask(projectInputs.createProjectTask.parse(input))); }
  async runProjectTask(input:unknown) { return this.projectOperation(()=>this.projects().runDirectTask(projectInputs.runProjectTask.parse(input))); }
  async workflowView(input:unknown) {
    const {workflowRunId}=projectInputs.workflowView.parse(input);
    return this.projectOperation(()=>{
      const service=this.workflowService(),snapshot=service.snapshot();
      const runs=workflowRunId&&!snapshot.runs.some(run=>run.workflowRunId===workflowRunId||run.runId===workflowRunId)?[...snapshot.runs,service.getRunView(workflowRunId)]:snapshot.runs;
      return {...snapshot,nodes:snapshot.nodes.map(node=>({...node,displayName:node.nodeId===this.ctx.get("taskSystem")?.config.nodeId?this.ctx.get("taskSystem")?.config.nodeDisplayName?.trim()||node.nodeId:node.nodeId})),runs:runs.map(run=>{
        if(workflowRunId&&(run.workflowRunId===workflowRunId||run.runId===workflowRunId))return run;
        return {...run,input:{},dispatches:[],steps:run.steps.map(({output,summary,...step})=>({...step,...(typeof summary==="string"?{summary:summary.slice(0,400)}:{})}))};
      })};
    });
  }
  async workflowSnapshot() { return this.projectOperation(() => {
    const snapshot=this.workflowService().snapshot(),task=this.ctx.get("taskSystem");
    return {...snapshot,nodes:snapshot.nodes.map(node=>({...node,displayName:node.nodeId===task?.config.nodeId?task.config.nodeDisplayName?.trim()||node.nodeId:node.nodeId}))};
  }); }
  async saveWorkflow(input: unknown) { return this.projectOperation(() => this.workflowService().save(input)); }
  async startWorkflow(input: unknown) { return this.projectOperation(() => this.workflowService().start(input)); }
  async retryWorkflowStep(input: unknown) { return this.projectOperation(() => this.workflowService().retry(input)); }
  async cancelWorkflow(input: unknown) { return this.projectOperation(() => this.workflowService().cancel(input)); }
  async workflowPage() { return readFileSync(new URL("./workflow-page.html", import.meta.url), "utf8"); }
  private projects() {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if ((task && deploymentPolicy(task.config).centralMode) === "remote")
      throw new RemoteError(
        "task/project",
        "Project center requires a planner",
        {
          reason: "PLANNER_REQUIRED",
        },
      );
    if (!task?.projects)
      throw new RemoteError("task/project", "Project service is unavailable", {
        reason: "PROJECT_UNAVAILABLE",
      });
    return task.projects;
  }
  private async projectOperation<T>(
    operation: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TaskError || error instanceof ProtocolError)
        throw new RemoteError("task/project", "Project operation rejected", {
          reason: error.code,
          ...(["WORKFLOW_SCOPE","WORKFLOW_UNBOUND","CLARIFICATION"].includes(error.code) ? {detail:error.message} : {}),
        });
      throw error;
    }
  }
  async projectSettings() {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    return task?.projects && deploymentPolicy(task.config).centralMode === "host"
      ? { enabled: true, ...task.projects.settings() }
      : { enabled: false };
  }
  async projectExecutionSettings(input:unknown) {
    const value=projectInputs.projectExecutionSettings.parse(input), portal=this.ctx.get("taskSystem")?.sessionPortal;
    return this.projectOperation(()=>portal ? portal.executionSettings(value.projectId) : this.projects().executionSettings(value.projectId));
  }
  async saveProjectExecutionSettings(input:unknown) {
    const value=projectInputs.saveProjectExecutionSettings.parse(input), portal=this.ctx.get("taskSystem")?.sessionPortal;
    if(portal && value.commandId && (!value.coordinatorWorkspace || value.coordinatorWorkspace.kind==="registered" && value.coordinatorWorkspace.catalogRevision))
      return this.projectOperation(()=>portal.saveExecutionSettings(value));
    return this.projectOperation(()=>{
      const projects=this.projects(), current=projects.placementProject(value.projectId);
      if(projects.nativeSession(current.session))throw new TaskError("CONFLICT","Refresh project settings to use the native owner's registered workspace catalog");
      return projects.saveExecutionSettings(value);
    });
  }
  private executorGrantService() {
    const task=this.ctx.get("taskSystem"),remote=this.ctx.get("remoteExecution");
    if(!task || !deploymentPolicy(task.config).executionEnabled || !remote)throw new RemoteError("task/project","This host has no executor workspace grant service",{reason:"EXECUTOR_REQUIRED"});
    return remote;
  }
  async setExecutorAlertDisposition(input:unknown) {
    const value=projectInputs.setExecutorAlertDisposition.parse(input),task=this.ctx.get("taskSystem"),remote=this.ctx.get("remoteExecution");
    if(!task || !deploymentPolicy(task.config).executionEnabled)throw new RemoteError("task/project","Executor unavailable",{reason:"EXECUTOR_REQUIRED"});
    const snapshot=this.localExecutorSnapshot(task);
    const alert=[...snapshot.runs.map(row=>row.alert),...snapshot.viewContext.unresolvedClaims.map(row=>row.alert)].find(alert=>alert?.recordId===value.recordId);
    if(!alert)throw new RemoteError("task/project","Alert changed; refresh the panel",{reason:"ALERT_CHANGED"});
    try{
      if(value.recordId.startsWith("local:")) {
        if(value.fingerprint!==alert.fingerprint || value.acknowledged&&!alert.canAcknowledge)throw new RemoteError("task/project","Local alert changed or execution is active",{reason:value.fingerprint!==alert.fingerprint?"ALERT_CHANGED":"ALERT_STILL_ACTIVE"});
        task.ledger.executorAlerts.set(value.recordId,value.fingerprint,value.acknowledged);
        return task.ledger.executorAlerts.alert(value.recordId,value.fingerprint,alert.canAcknowledge);
      }
      if(!remote)throw new RemoteError("task/project","Remote recovery unavailable",{reason:"RECOVERY_UNAVAILABLE"});
      return remote.setExecutorAlertDisposition(value,alert);
    }
    catch(error){if(error instanceof RemoteError)throw error;if(error instanceof Error && "code" in error)throw new RemoteError("task/project",error.message,{reason:String(error.code)});throw error;}
  }
  async executorWorkspaceGrants() {
    const task=this.ctx.get("taskSystem"),remote=this.ctx.get("remoteExecution");
    if(!task || !deploymentPolicy(task.config).executionEnabled || !remote)return {enabled:false,nodeId:task?.config.nodeId??null,revision:0,items:[]};
    return {enabled:true,...await remote.workspaceGrantCatalog()};
  }
  async setExecutorWorkspaceGrant(input:unknown) {
    const value=projectInputs.setExecutorWorkspaceGrant.parse(input);
    try {return {enabled:true,...await this.executorGrantService().setLocalWorkspaceGrant(value)};}
    catch(error) {if(error instanceof Error&&'code' in error&&typeof error.code==='string')throw new RemoteError("task/project","Workspace grant change rejected",{reason:error.code});throw error;}
  }
  async scheduleOptions() { return this.projectOperation(()=>this.projects().scheduleOptions()); }
  async createScheduledPlan(input:unknown) { return this.projectOperation(()=>this.projects().createScheduledPlan(projectInputs.createScheduledPlan.parse(input))); }
  async controlScheduledPlan(input:unknown) { return this.projectOperation(()=>this.projects().controlScheduledPlan(projectInputs.controlScheduledPlan.parse(input))); }
  async createTemporaryTask(input: unknown) {
    return this.projectOperation(() =>
      this.projects().createTemporary(
        projectInputs.createTemporaryTask.parse(input),
      ),
    );
  }
  private localExecutorSnapshot(task: TaskSystemService) {
    const remote = this.ctx.get("remoteExecution") as RemoteExecutionService | undefined;
    const observed = remote?.executorPanel();
    const data = task.ledger.snapshot(), nodeId = task.config.nodeId;
    const ownRuns = data.runs.filter(run=>run.route?.nodeId===nodeId && !run.observationOnly && !run.historyOnly)
      .sort((a,b)=>Number(["queued","running"].includes(b.state))-Number(["queued","running"].includes(a.state)) || b.updatedAt.localeCompare(a.updatedAt));
    const records: ExecutorPanelRecord[] = ownRuns.slice(0,200).map(run=>{
      const ownerTask = data.tasks.find(task=>task.taskId===run.taskId);
      const attempt = data.attempts?.find(attempt=>attempt.attemptId===run.currentAttemptId);
      const report = data.reports.findLast(report=>report.runId===run.runId && report.kind==="result");
      return {taskId:run.taskId,runId:run.runId,title:ownerTask?.title ?? run.intentSnapshot?.title ?? run.taskId,
        description:ownerTask?.description ?? run.intentSnapshot?.description ?? "",state:run.state,source:"local-ledger",nodeId,time:run.updatedAt,
        sessionIds:[...new Set([...(run.sessionIds??[]),...(attempt?.sessionId?[attempt.sessionId]:[])])],
        executionDriver:run.route?.backend || run.route?.execution ? "external" : "dsh",parentTaskId:ownerTask?.parentTaskId,parentRunId:run.parentRunId,projectId:run.projectContext?.project?.projectId,
        projectTitle:run.projectContext?.project?.title,model:run.route?.model,workspaceId:run.route?.workspaceId,
        report:report?.body,outcome:run.outcome,attemptId:attempt?.attemptId,authorityDisposition:ownerTask ? {schedulerId:task.ledger.schedulerIdentity(),runId:run.runId,taskId:run.taskId,taskState:ownerTask.state,runState:run.state,attemptId:attempt?.attemptId??null,attemptState:attempt?.state??null,currentAttemptId:run.currentAttemptId??null,cancellationRequested:run.cancellationRequested===true}:undefined};
    });
    for (const entry of task.results?.pending() ?? []) {
      const row = records.find(row=>row.runId===entry.ref.runId);
      if(row) {row.state="result";row.report=entry.settlement.report?.body ?? entry.settlement.summary;row.detail=entry.reasonCode;row.sessionIds=[...new Set([...row.sessionIds,entry.sessionId])];}
    }
    const snapshot=executorPanelSnapshot(nodeId,[...records.map(row=>{
      const recordId=`local:${row.runId}:${row.attemptId??"none"}`,fingerprint=executorAlertFingerprint({recordId,state:row.state,outcome:row.outcome??null,disposition:row.authorityDisposition??null});
      return {...row,alert:task.ledger.executorAlerts.alert(recordId,fingerprint,["failed","blocked","partial"].includes(row.state) && !["leased","running"].includes(row.authorityDisposition?.attemptState??""))};
    }),...(observed?.records??[])]);
    return {...snapshot,viewCapabilities:{planner:true,executor:true},
      viewContext:{role:"executor",scope:"local",nodeId,displayName:task.config.nodeDisplayName?.trim()||nodeId,observedAt:snapshot.sampledAt,queueObservedAt:observed?.queueObservedAt??null,
        pollState:observed?.pollState??"never",connection:observed?.connection??null,heartbeat:observed?.heartbeat??null,
        unresolvedClaims:observed?.unresolvedClaims??[],truncated:ownRuns.length>200 || observed?.truncated===true}};
  }
  async projectSnapshot(input?: unknown) {
    const requested = projectInputs.projectSnapshot.parse(input ?? {}).view;
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if(!task) throw new RemoteError("task/project","Task service unavailable",{reason:"PROJECT_UNAVAILABLE"});
    const view = requested ?? (task.config.centralMode === undefined && task.config.role === "executor" ? "executor" : "planner");
    if (view === "executor") return this.localExecutorSnapshot(task);
    if (deploymentPolicy(task.config).centralMode === "remote") {
      const remote = this.ctx.get("remoteExecution") as RemoteExecutionService | undefined;
      if (!remote?.coordinatorLedger || remote.settingsSnapshot().paused) throw new RemoteError("task/project", "Central task center is offline; local activity remains available", {reason:"CENTRAL_UNAVAILABLE"});
      try {
        const value = await remote.coordinatorLedger.projectSnapshot(task.config.nodeId);
        if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.tasks) || !Array.isArray(value.runs) || !Array.isArray(value.projects)) throw new Error("Invalid central projection");
        const snapshot = value as unknown as ReturnType<ProjectRuntime["snapshotForNode"]>;
        return {...snapshot, viewCapabilities:{planner:true,executor:true},viewContext:{role:"planner",scope:"central",nodeId:task.config.nodeId}};
      } catch { throw new RemoteError("task/project", "Central task center is offline; local activity remains available", {reason:"CENTRAL_UNAVAILABLE"}); }
    }
    return this.projectOperation(()=>({...this.projects().snapshot(),viewCapabilities:{planner:true,executor:true}}));
  }

  private sessionDispatchIndex = new SessionDispatchIndex();
  async sessionTasks(input: unknown) {
    const { sessionId } = projectInputs.sessionTasks.parse(input);
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    const persistence = this.ctx.get("sessionPersistence");
    if (!task || !persistence) throw new RemoteError("task/project", "Session task monitor unavailable", { reason: "PROJECT_UNAVAILABLE" });
    const operations = sessionDispatchOperations(task.ledger, sessionId);
    const history = await this.sessionDispatchIndex.readHistory(persistence, sessionId);
    const roots = [...new Set([...operations.taskIds, ...history.ids])];
    const localAssigned = this.localExecutorSnapshot(task);
    const assigned = localAssigned?.runs.filter(run=>run.sessionIds.includes(sessionId)) ?? [];
    for (const run of assigned) if(!roots.includes(run.taskId)) roots.push(run.taskId);
    const baseSnapshot = deploymentPolicy(task.config).centralMode === "remote" && (assigned.length || task.config.centralMode === undefined && task.config.role === "executor") ? localAssigned : roots.length ? await this.projectSnapshot() : {tasks:[],runs:[]};
    const snapshot = deploymentPolicy(task.config).executionEnabled && assigned.length && localAssigned ? {
      ...localAssigned,tasks:[...new Map([...baseSnapshot.tasks,...localAssigned.tasks].map(row=>[row.id,row])).values()],
      runs:[...new Map([...baseSnapshot.runs,...localAssigned.runs].map(row=>[row.id,row])).values()],
    } : baseSnapshot;
    const view = sessionTaskSnapshot(snapshot, roots, sessionId, operations.pending, history.codexJobs,
      this.ctx.get("jobs") as SessionJobRegistry | undefined);
    const local = this.ctx.get("localCodex")?.store.rows(sessionId) ?? [];
    const tasks = sortSessionTasks([...view.tasks, ...local]);
    const counts: Record<string, number> = { ...view.counts, all: tasks.length };
    for (const item of local) counts[item.status] = (counts[item.status] ?? 0) + 1;
    return { ...view, tasks, counts, directCount: view.directCount + local.length, localCodexCount: local.length, ...("viewContext" in snapshot ? {viewContext:snapshot.viewContext} : {}) };
  }
  async projectPage() {
    return readFileSync(
      new URL("./project-page.html", import.meta.url),
      "utf8",
    );
  }
  async executionDirectorySettings() {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if (!task) throw new Error("Task service unavailable");
    return {enabled: deploymentPolicy(task.config).executionEnabled, nodeId: task.config.nodeId, fallback:null, ...task.executionDirectories.settings()};
  }

  async saveExecutionDirectorySettings(input: unknown) {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if (!task || !deploymentPolicy(task.config).executionEnabled) throw new Error("Executor required");
    return this.projectOperation(() => task.executionDirectories.save(projectInputs.saveExecutionDirectorySettings.parse(input)));
  }
  async saveProjectSettings(input: unknown) {
    return this.projectOperation(() =>
      this.projects().saveSettings(
        projectInputs.saveProjectSettings.parse(input),
      ),
    );
  }
  async createProject(input: unknown) {
    return this.projectOperation(() =>
      this.projects().create(projectInputs.createProject.parse(input)),
    );
  }
  async conversationModels() {
    return this.projectOperation(() => this.projects().modelCatalog());
  }
  async selectConversationModel(input: unknown) {
    return this.projectOperation(() =>
      this.projects().selectModel(
        projectInputs.selectConversationModel.parse(input),
      ),
    );
  }
  async taskConversation(input: unknown) {
    return this.projectOperation(() =>
      this.projects().taskConversation(
        projectInputs.taskConversation.parse(input).taskId,
      ),
    );
  }
  async sendExecutorMessage(input: unknown) {
    const value=projectInputs.sendExecutorMessage.parse(input), portal=this.ctx.get("taskSystem")?.sessionPortal;
    return this.projectOperation(()=>portal ? portal.sendExecutorMessage(value) : this.projects().sendExecutorMessage(value));
  }
  async sendTaskMessage(input: unknown) {
    return this.projectOperation(() =>
      this.projects().sendTask(projectInputs.sendTaskMessage.parse(input)),
    );
  }
  async projectConversation(input: unknown) {
    const value=projectInputs.projectConversation.parse(input), portal=this.ctx.get("taskSystem")?.sessionPortal;
    return this.projectOperation(()=>portal ? portal.conversation(value.projectId,value.generation) : this.projects().conversation(value.projectId));
  }
  async projectNativeConversation(input: unknown) {
    const value=projectInputs.projectNativeConversation.parse(input), portal=this.ctx.get("taskSystem")?.sessionPortal;
    if(!portal)throw new RemoteError("task/project","Project session hosting is unavailable",{reason:"PROJECT_UNAVAILABLE"});
    return this.projectOperation(()=>portal.nativeConversation(value));
  }
  async sendProjectMessage(input: unknown) {
    const value=projectInputs.sendProjectMessage.parse(input);
    return this.projectOperation(()=>{
      const projects=this.projects(), project=projects.placementProject(value.projectId);
      if(projects.nativeSession(project.session))
        throw new TaskError("CONFLICT","Project session location changed; refresh the project conversation before sending");
      return projects.send(value);
    });
  }
  async handoffProject(input: unknown) {
    const value=projectInputs.handoffProject.parse(input), portal=this.ctx.get("taskSystem")?.sessionPortal;
    return this.projectOperation(()=>portal ? portal.handoff(value.projectId,value.commandId) : this.projects().handoff(value.projectId));
  }
  async setTaskPresentation(input:unknown){return this.projectOperation(()=>this.projects().setTaskPresentation(projectInputs.setTaskPresentation.parse(input)));}
  async getProjectReportPresentation(input:unknown){return this.projectOperation(()=>this.projects().reportPresentation(projectInputs.getProjectReportPresentation.parse(input)));}
  async readProjectReport(input:unknown){return this.projectOperation(()=>this.projects().readReport(projectInputs.readProjectReport.parse(input)));}
  async setReportRetryLimit(input:unknown){return this.projectOperation(()=>this.projects().setReportRetryLimit(projectInputs.setReportRetryLimit.parse(input)));}
  async actOnProjectTask(input: unknown) {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if (task && deploymentPolicy(task.config).centralMode === "remote") {
      const remote = this.ctx.get("remoteExecution") as RemoteExecutionService | undefined;
      if (!remote?.coordinatorLedger?.projectCollaborate || remote.settingsSnapshot().paused) throw new RemoteError("task/project","Central task controls unavailable",{reason:"CENTRAL_UNAVAILABLE"});
      const parsed = projectInputs.actOnProjectTask.parse(input), {commandId, ...control} = parsed;
      return this.projectOperation(()=>remote.coordinatorLedger!.projectCollaborate(task.config.nodeId,commandId,{action:"control",control:CentralTaskControl.parse(control)}));
    }
    return this.projectOperation(
      async () =>
        await this.projects().actOnTask(
          projectInputs.actOnProjectTask.parse(input),
        ),
    );
  }
  async reviewProjectTask(input: unknown) {
    return this.projectOperation(() =>
      this.projects().review(projectInputs.reviewProjectTask.parse(input)),
    );
  }
  async decisionConsole() {
    return readDecisionPreferences(this.ctx);
  }
  async setDecisionPreset(value: unknown) {
    const input = SetDecisionPresetInput.parse(value);
    try {
      return await saveDecisionPreference(this.ctx, input);
    } catch (error) {
      const reason =
        error instanceof Error && error.message.startsWith("DECISION_")
          ? error.message
          : "DECISION_SAVE_REJECTED";
      throw new RemoteError(
        "task/startup",
        "Decision preset selection rejected",
        { reason },
      );
    }
  }
  async decisionSettings() {
    return await readDecisionSettings(this.ctx);
  }
  async saveDecisionSettings(input: unknown) {
    return await saveDecisionSettings(this.ctx, input);
  }
  async executionPresets() {
    const registry = this.ctx.get("agentPresets");
    if (!registry) throw new RemoteError("task/startup", "DSH agent preset registry is unavailable", {reason:"STARTUP_PRESET_UNAVAILABLE"});
    const items = z.array(z.object({id:z.string(),name:z.string().optional(),description:z.string().optional(),broken:z.string().optional()})).parse(await registry.list());
    return ExecutionPresetCatalog.parse({items:items.map(item=>({id:item.id,label:item.name ?? item.id,description:(item.description ?? "").slice(0,1000),available:!item.broken,diagnostic:item.broken?.slice(0,500) ?? null}))});
  }
  async startup() {
    return readStartupSettings(this.ctx);
  }
  async workspaces() {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if (!task) throw new Error("Task plugin is not loaded");
    const row = readStartupSettings(this.ctx).task;
    if (!row) throw new Error("Task startup scope is unavailable");
    // Public registry metadata only: never project sessionIds or read session content.
    const registry = this.ctx.get("workspaceRegistry") as
      | WorkspaceRegistryPort
      | undefined;
    const official = registry?.list();
    const byPath = new Map<string, OfficialWorkspaceMetadata>();
    for (const item of official ?? [])
      if (typeof item.path === "string" && item.path.trim())
        byPath.set(resolve(item.path), item);
    const nodeId = task.config.nodeId;
    let node: ReturnType<TaskSystemService["ledger"]["getNode"]> | undefined;
    try {
      node = task.ledger.getNode(nodeId);
    } catch (error) {
      if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
    }
    const items = await Promise.all(
      task.ledger.registeredWorkspaces(nodeId).map(async (item) => {
        let directory = byPath.get(resolve(item.path));
        let status: "ok" | "missing-dir" = "ok";
        if (!directory && registry?.resolveByPath) {
          try {
            directory = await registry.resolveByPath(item.path);
          } catch (error) {
            if (
              !["ENOENT", "ENOTDIR"].includes(
                (error as { code?: string }).code ?? "",
              )
            )
              throw error;
            status = "missing-dir";
          }
        }
        if (directory?.status) status = await directory.status();
        return {
          workspaceId: item.workspaceId,
          title: workspaceTitle(
            directory?.title,
            directory?.name,
            item.label,
            basename(item.path),
          ),
          path: item.path,
          available:
            item.state === "ready" &&
            !!node?.enabled &&
            !!node.workspaceIds.includes(item.workspaceId) &&
            status === "ok",
        };
      }),
    );
    return WorkspaceCatalog.parse({
      scope: {
        entryId: row.entryId,
        nodeId,
        schedulerId: task.ledger.schedulerIdentity(),
      },
      source: official ? "official" : "task",
      items,
    });
  }
  private modelAuthority(nodeId:string) {
    const task=this.ctx.get("taskSystem") as TaskSystemService|undefined;
    if(!task || deploymentPolicy(task.config).centralMode === "remote")throw new TaskError("FORBIDDEN","Scheduler settings required");
    const node=task.ledger.getNode(nodeId);
    if(!node.enabled || nodeId===task.config.nodeId)throw new TaskError("EXECUTOR_REQUIRED","Connect the executor before setting its default model");
    return task.ledger;
  }
  async nodeModelSettings(input:unknown){return this.projectOperation(()=>{const value=projectInputs.nodeModelSettings.parse(input);return this.modelAuthority(value.nodeId).executionModels.view(value.nodeId);});}
  async refreshNodeModels(input:unknown){return this.projectOperation(async()=>{const value=projectInputs.refreshNodeModels.parse(input);return await this.modelAuthority(value.nodeId).refreshNodeModels(value.nodeId);});}
  async saveNodeModelDefault(input:unknown) {
    return this.projectOperation(async()=>{
      const value=projectInputs.saveNodeModelDefault.parse(input);
      const authority=this.modelAuthority(value.nodeId),schedulerId=authority.schedulerIdentity();
      try {
        let view=authority.executionModels.view(value.nodeId);
        if(view.policy.revision!==value.expectedRevision)throw new TaskError("EXECUTION_MODEL_POLICY_CONFLICT","EXECUTION_MODEL_POLICY_CONFLICT");
        const confirmsChoice=()=>!!view.catalog.positiveSnapshot && view.catalog.positiveSnapshot.expiresAt>Date.now() && view.catalog.positiveSnapshot.models.some(choice=>sameExecutionModel(choice,value.choice));
        if(!confirmsChoice())view=await authority.refreshNodeModels(value.nodeId);
        if(this.modelAuthority(value.nodeId)!==authority || authority.schedulerIdentity()!==schedulerId)throw new TaskError("EXECUTION_MODEL_AUTHORITY_CHANGED","EXECUTION_MODEL_AUTHORITY_CHANGED");
        const snapshot=view.catalog.positiveSnapshot;
        if(!snapshot || snapshot.expiresAt<=Date.now())throw new TaskError("EXECUTION_CATALOG_STALE","EXECUTION_CATALOG_STALE");
        if(!confirmsChoice())throw new TaskError(snapshot.complete?"EXECUTION_MODEL_UNAVAILABLE":"EXECUTION_CATALOG_UNCONFIRMED","Selected model and effort could not be confirmed");
        return authority.executionModels.setDefault(`settings-default:${randomUUID()}`,{...value,expectedCatalogRevision:snapshot.revision});
      }catch(error){if(error instanceof ExecutionModelsError)throw new TaskError(error.code,error.message);throw error;}
    });
  }
  async connectionSettings(){return await readConnectionSettings(this.ctx);}
  async saveConnectionSettings(input:unknown){try{return await saveConnectionSettings(this.ctx,input);}catch(error){if(error instanceof StartupSettingsError)throw new RemoteError("task/startup",error.message,{reason:error.code});throw error;}}
  async saveStartup(input: unknown) {
    try {
      return await saveStartupSettings(this.ctx, input);
    } catch (error) {
      if (error instanceof StartupSettingsError)
        throw new RemoteError("task/startup", error.message, {
          reason: error.code,
        });
      throw error;
    }
  }
  async checkConnection(input: unknown) {
    return await checkStartupConnection(this.ctx, input);
  }
  async executorIdentity() {
    const remote = this.ctx.get("remoteExecution") as
      | RemoteExecutionService
      | undefined;
    if (!remote)
      throw new Error(
        "Configure an authenticated scheduler connection before querying the executor ID",
      );
    return ExecutorIdentity.parse(await remote.executorIdentity());
  }
  async queue() {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if (!task) throw new Error("Task plugin is not loaded");
    const remote = this.ctx.get("remoteExecution") as
      | RemoteExecutionService
      | undefined;
    const remoteQueue = remote?.queueSnapshot();
    const snapshot = task.ledger.snapshot();
    const tasks = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
    const runs = snapshot.runs.filter(
      (run) =>
        run.route?.nodeId === task.config.nodeId &&
        ["queued", "running", "blocked", "uncertain"].includes(run.state) &&
        !run.historyOnly &&
        !run.observationOnly,
    );
    const items = [
      ...(remoteQueue?.items ?? []),
      ...runs.map((run) => ({
        taskId: run.taskId,
        runId: run.runId,
        title: tasks.get(run.taskId)?.title ?? run.taskId,
        state: run.state,
        sessionId:
          (snapshot.attempts ?? []).find(
            (attempt) => attempt.attemptId === run.currentAttemptId,
          )?.sessionId ?? null,
        workspaceId: run.route?.workspaceId ?? null,
      })),
    ];
    return QueueSnapshot.parse({
      sampledAt: new Date().toISOString(),
      nodeId: task.config.nodeId,
      truncated: items.length > 100 || remoteQueue?.truncated === true,
      items: items.slice(0, 100),
    });
  }
  async describe() {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if (!task) throw new Error("Task plugin is not loaded");
    const editor = this.ctx.get("configEditor") as
      | { documentPath?: string }
      | undefined;
    const remote = this.ctx.get("remoteExecution") as
      | RemoteExecutionService
      | undefined;
    const config = task.config;
    const profile = this.ctx.get("profileContext") as
      | {
          home: string;
          overlays: { id?: string; name?: string; config?: unknown }[];
        }
      | undefined;
    const homePatch = profile
      ? join(profile.home, "cordis.patch.yml")
      : undefined;
    const commandLineConfigOverride = hasTaskConfigOverride(
      profile?.overlays ?? [],
    );
    // Construct the allowlist explicitly. Never serialize a Config or Loader row.
    return ReadonlySettings.parse({
      schedulerId: task.ledger.schedulerIdentity(),
      defaultWorkspaceId: config.defaultWorkspaceId ?? null,
      sessionDecisionEnabled: config.sessionDecisionEnabled ?? false,
      planningDecisionEnabled: config.planningDecisionEnabled ?? true,
      nodeId: config.nodeId,
      role: config.role,
      centralMode: config.centralMode,
      executionEnabled: config.executionEnabled,
      databasePath: resolve(config.databasePath),
      profilePatch: editor?.documentPath ?? null,
      homePatch: homePatch && existsSync(homePatch) ? homePatch : null,
      commandLineConfigOverride,
      keepAlive: config.keepAlive,
      maintenanceIntervalMs: config.maintenanceIntervalMs,
      leaseTtlMs: config.leaseTtlMs,
      executionTools: [...(config.executionTools ?? [])],
      executionToolsMode:
        config.executionTools == null ? "preset" : "allowlist",
      remote: remote?.settingsSnapshot() ?? null,
    });
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    taskPluginSettings: TaskPluginSettings;
  }
}

export function apply(ctx: Context): void {
  // This package root is also a library. In headless profiles no Web dependency
  // or settings service is required, and the task-system row remains independent.
  ctx.inject(["taskSystem", "typert"], (host) => {
    const registry = host.get("typert") as unknown as {
      register(contribution: unknown): () => void;
    };
    host.effect(
      () =>
        registry.register({
          package: "@dsh-task/task-system",
          face: "host",
          schemas: [],
          model: { services: [], events: [], objects: [] },
          invocations: [
            ...projectDescriptors,
            settingsDescriptor,
            queueDescriptor,
            workspaceCatalogDescriptor,
            executorIdentityDescriptor,
            startupDescriptor,
            executionPresetsDescriptor,
            saveStartupDescriptor,
            checkConnectionDescriptor,
            ...decisionPresetDescriptors,
            decisionSettingsDescriptor,
            saveDecisionSettingsDescriptor,
          ],
        }),
      "task settings read-only descriptor",
    );
    new TaskPluginSettings(host);
  });
}
