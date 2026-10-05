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
} from "./startup-settings.js";
/** Optional official Web settings companion. No tasks, database or credentials are owned here. */
import { Context } from "@deepseek-ai/cordis";
import {
  TypertRemoteService,
  type InvocationDescriptor,
} from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { resolve, join, basename } from "node:path";
import { existsSync } from "node:fs";
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

export class TaskPluginSettings extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, "taskPluginSettings");
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
    return await saveStartupSettings(this.ctx, input);
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
      executionTools: [...config.executionTools],
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
            settingsDescriptor,
            queueDescriptor,
            workspaceCatalogDescriptor,
            executorIdentityDescriptor,
            startupDescriptor,
            saveStartupDescriptor,
            decisionSettingsDescriptor,
            saveDecisionSettingsDescriptor,
          ],
        }),
      "task settings read-only descriptor",
    );
    new TaskPluginSettings(host);
  });
}
