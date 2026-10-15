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
    consumer: z.enum(["task-planning", "task-session"]),
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
  sessionTasks: z.object({ sessionId: z.string().min(1).max(200) }).strict(),
  scheduleOptions:null,
  createScheduledPlan:scheduledPlanInput,
  controlScheduledPlan:scheduledPlanControl,
  projectSettings: null,
  executionDirectorySettings: null,
  saveExecutionDirectorySettings: z.object({root: z.string().min(1).max(4096), expectedRevision: z.number().int().nonnegative()}).strict(),
  setReportRetryLimit:z.object({commandId:z.string().min(1).max(200),taskId:z.string().min(1),expectedRevision:z.number().int().positive(),maxRetries:z.number().int().min(0).max(5)}).strict(),
  projectSnapshot: null,
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
  projectConversation: z.object({ projectId: z.string().min(1) }).strict(),
  sendProjectMessage: z
    .object({
      projectId: z.string().min(1),
      commandId: z.string().min(1).max(200),
      text: z.string().min(1).max(20000),
    })
    .strict(),
  handoffProject: z.object({ projectId: z.string().min(1) }).strict(),
  actOnProjectTask: z
    .object({
      commandId: z.string().min(1).max(200),
      taskId: z.string().min(1),
      expectedVersion: z.string().min(1).max(200),
      runId: z.string().min(1).nullable(),
      confirmationRevision: z.number().int().positive(),
      retryPrompt: z.string().max(20000).optional(),
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
        "retry",
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
    create: () => (method === "projectPage" ? z.string() : z.json()),
  },
}));

export class TaskPluginSettings extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, "taskPluginSettings");
  }
  private projects() {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if (task?.config.role === "executor")
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
      if (error instanceof TaskError)
        throw new RemoteError("task/project", "Project operation rejected", {
          reason: error.code,
        });
      throw error;
    }
  }
  async projectSettings() {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    return task?.projects && task.config.role !== "executor"
      ? { enabled: true, ...task.projects.settings() }
      : { enabled: false };
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
  async projectSnapshot() {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if(task?.config.role === "executor") {
      const remote = this.ctx.get("remoteExecution") as RemoteExecutionService | undefined;
      if(!remote?.coordinatorLedger) throw new RemoteError("task/project", "Coordinator unavailable", {reason:"COORDINATOR_UNAVAILABLE"});
      return this.projectOperation(async () => {
        const result = await remote.coordinatorLedger!.projectSnapshot();
        const view = result as unknown as {viewContext?:Record<string,unknown>};
        return {...view,viewContext:{...view.viewContext,coordinatorUrl:remote.coordinatorPanelUrl()}};
      });
    }
    return this.projectOperation(() => this.projects().snapshot());
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
    // No remote request for a new session with no confirmed dispatches.
    const snapshot = roots.length ? await this.projectSnapshot() : { tasks: [], runs: [] };
    const view = sessionTaskSnapshot(snapshot, roots, sessionId, operations.pending, history.codexJobs,
      this.ctx.get("jobs") as SessionJobRegistry | undefined);
    const local = this.ctx.get("localCodex")?.store.rows(sessionId) ?? [];
    const tasks = sortSessionTasks([...view.tasks, ...local]);
    const counts: Record<string, number> = { ...view.counts, all: tasks.length };
    for (const item of local) counts[item.status] = (counts[item.status] ?? 0) + 1;
    return { ...view, tasks, counts, directCount: view.directCount + local.length, localCodexCount: local.length };
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
    const fallback = task.config.defaultWorkspaceId
      ? task.ledger.registeredWorkspaces(task.config.nodeId).find(item => item.workspaceId === task.config.defaultWorkspaceId)?.path ?? null : null;
    return {enabled: task.config.role !== "planner", nodeId: task.config.nodeId, fallback, ...task.executionDirectories.settings()};
  }
  async saveExecutionDirectorySettings(input: unknown) {
    const task = this.ctx.get("taskSystem") as TaskSystemService | undefined;
    if (!task || task.config.role === "planner") throw new Error("Executor required");
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
    return this.projectOperation(() =>
      this.projects().sendExecutorMessage(
        projectInputs.sendExecutorMessage.parse(input),
      ),
    );
  }
  async sendTaskMessage(input: unknown) {
    return this.projectOperation(() =>
      this.projects().sendTask(projectInputs.sendTaskMessage.parse(input)),
    );
  }
  async projectConversation(input: unknown) {
    return this.projectOperation(() =>
      this.projects().conversation(
        projectInputs.projectConversation.parse(input).projectId,
      ),
    );
  }
  async sendProjectMessage(input: unknown) {
    return this.projectOperation(() =>
      this.projects().send(projectInputs.sendProjectMessage.parse(input)),
    );
  }
  async handoffProject(input: unknown) {
    return this.projectOperation(() =>
      this.projects().handoff(
        projectInputs.handoffProject.parse(input).projectId,
      ),
    );
  }
  async setReportRetryLimit(input:unknown){return this.projectOperation(()=>this.projects().setReportRetryLimit(projectInputs.setReportRetryLimit.parse(input)));}
  async actOnProjectTask(input: unknown) {
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
