/** Optional official Web settings companion. No tasks, database or credentials are owned here. */
import { Context } from "@deepseek-ai/cordis";
import {
  TypertRemoteService,
  type InvocationDescriptor,
} from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import type { TaskSystemService } from "./dsh-plugin.js";
import type { RemoteExecutionService } from "./remote/index.js";

const ReadonlySettings = z.object({
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
      authMode: z.string(),
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
          invocations: [settingsDescriptor],
        }),
      "task settings read-only descriptor",
    );
    new TaskPluginSettings(host);
  });
}
