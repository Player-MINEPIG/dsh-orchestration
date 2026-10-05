/** Narrow startup config editing through the host's public ConfigEditor only. */
import type { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { TaskSystemService } from "./dsh-plugin.js";
import type { RemoteExecutionService } from "./remote/index.js";
import { assertEndpoint } from "./remote/http.js";
import { validateNetworkTarget } from "./remote/network-client.js";

const Role = z.enum(["planner", "executor", "both"]);
const Target = z
  .object({
    address: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    localAddress: z.string().min(1),
    allowHttp: z.literal(true),
  })
  .strict();
export const TaskStartupValues = z
  .object({
    role: Role,
    defaultWorkspaceId: z.string().min(1).nullable(),
    sessionDecisionEnabled: z.boolean(),
  })
  .strict();
export const RemoteStartupValues = z
  .object({
    role: Role,
    paused: z.boolean(),
    endpoint: z.string().nullable(),
    audience: z.string().nullable(),
    pollIntervalMs: z.number().int().min(0).max(3600000),
    concurrency: z.number().int().min(1).max(16),
    taskSessionsEnabled: z.boolean(),
    trustedNetworkTarget: Target.nullable(),
  })
  .strict();
export const StartupSettings = z.object({
  writable: z.boolean(),
  applies: z.literal("plugin-restart"),
  task: z.object({ entryId: z.string(), values: TaskStartupValues }).nullable(),
  remote: z
    .object({
      entryId: z.string(),
      loaded: z.boolean(),
      loaderDisabled: z.boolean(),
      values: RemoteStartupValues,
    })
    .nullable(),
});
export const SaveStartupInput = z.discriminatedUnion("target", [
  z
    .object({
      target: z.literal("task"),
      expected: TaskStartupValues,
      changes: TaskStartupValues.partial().strict(),
    })
    .strict(),
  z
    .object({
      target: z.literal("remote"),
      expected: RemoteStartupValues,
      changes: RemoteStartupValues.partial().strict(),
    })
    .strict(),
]);
export const SaveStartupResult = z.object({
  saved: z.literal(true),
  applies: z.literal("plugin-restart"),
});
type Raw = Record<string, unknown>;
interface Entry {
  readonly disabled?: boolean;
  options: { id: string; name: string; config?: Raw; disabled?: boolean };
}
interface ConfigEditor {
  entries(): Entry[];
  edit(
    entry: Entry,
    change: (current: Raw, inherited: Raw) => Raw,
  ): Promise<void>;
}
export class StartupSettingsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StartupSettingsError";
  }
}
function reject(code: string, message: string): never {
  throw new StartupSettingsError(code, message);
}
const record = (value: unknown): Raw | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
function editor(ctx: Context): ConfigEditor | undefined {
  return ctx.get("configEditor") as ConfigEditor | undefined;
}
function row(host: ConfigEditor, target: "task" | "remote"): Entry | undefined {
  const name =
    target === "task"
      ? "@dsh-task/task-system/plugin"
      : "@dsh-task/task-system/remote";
  const rows = host.entries().filter((entry) => entry.options.name === name);
  if (rows.length > 1)
    reject(
      "STARTUP_AMBIGUOUS",
      "Multiple task plugin entries are present; select a profile with one authoritative entry",
    );
  return rows[0];
}
function publicEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}
function taskValues(raw: Raw, task: TaskSystemService | undefined) {
  return TaskStartupValues.parse({
    role:
      typeof raw.role === "string" ? raw.role : (task?.config.role ?? "both"),
    defaultWorkspaceId:
      raw.defaultWorkspaceId === null ||
      typeof raw.defaultWorkspaceId === "string"
        ? raw.defaultWorkspaceId
        : (task?.config.defaultWorkspaceId ?? null),
    sessionDecisionEnabled:
      typeof raw.sessionDecisionEnabled === "boolean"
        ? raw.sessionDecisionEnabled
        : (task?.config.sessionDecisionEnabled ?? false),
  });
}
function remoteValues(raw: Raw, remote: RemoteExecutionService | undefined) {
  const current = remote?.settingsSnapshot(),
    coordinator = record(raw.coordinator),
    target = record(coordinator?.trustedNetwork);
  return RemoteStartupValues.parse({
    paused:
      typeof raw.paused === "boolean" ? raw.paused : (current?.paused ?? false),
    role:
      typeof raw.role === "string" ? raw.role : (current?.role ?? "executor"),
    endpoint: coordinator
      ? (publicEndpoint(coordinator.endpoint) ?? current?.endpoint ?? null)
      : null,
    audience:
      typeof coordinator?.audience === "string" ? coordinator.audience : null,
    pollIntervalMs:
      typeof raw.pollIntervalMs === "number"
        ? raw.pollIntervalMs
        : (current?.pollIntervalMs ?? 0),
    concurrency:
      typeof raw.concurrency === "number"
        ? raw.concurrency
        : (current?.concurrency ?? 1),
    taskSessionsEnabled:
      typeof raw.taskSessionsEnabled === "boolean"
        ? raw.taskSessionsEnabled
        : (current?.taskSessionsEnabled ?? false),
    trustedNetworkTarget: target
      ? {
          address: target.address,
          port: target.port,
          localAddress: target.localAddress,
          allowHttp: target.allowHttp,
        }
      : null,
  });
}
function hasOverride(patches: readonly unknown[], entry: Entry): boolean {
  return patches.some((value) => {
    const patch = record(value);
    return (
      !!patch &&
      (((patch.id === entry.options.id || patch.name === entry.options.name) &&
        Object.hasOwn(patch, "config")) ||
        (Array.isArray(patch.insert) && hasOverride(patch.insert, entry)))
    );
  });
}
export function readStartupSettings(ctx: Context) {
  const host = editor(ctx),
    task = ctx.get("taskSystem") as TaskSystemService | undefined,
    remote = ctx.get("remoteExecution") as RemoteExecutionService | undefined;
  if (!host)
    return StartupSettings.parse({
      writable: false,
      applies: "plugin-restart",
      task: null,
      remote: null,
    });
  const a = row(host, "task"),
    b = row(host, "remote");
  return StartupSettings.parse({
    writable: true,
    applies: "plugin-restart",
    task: a
      ? {
          entryId: a.options.id,
          values: taskValues(a.options.config ?? {}, task),
        }
      : null,
    remote: b
      ? {
          entryId: b.options.id,
          loaded: !!remote,
          loaderDisabled: b.disabled === true || b.options.disabled === true,
          values: remoteValues(b.options.config ?? {}, remote),
        }
      : null,
  });
}
/** No credentials, grants, arbitrary namespaces or raw replacement configs cross this boundary. */
export async function saveStartupSettings(ctx: Context, value: unknown) {
  const input = SaveStartupInput.parse(value);
  if (Object.keys(input.changes).length === 0)
    reject("STARTUP_EMPTY", "No configuration change was selected");
  const host = editor(ctx);
  if (!host)
    reject(
      "STARTUP_READ_ONLY",
      "This profile does not provide persistent configuration editing",
    );
  const entry = row(host, input.target);
  if (!entry)
    reject(
      "STARTUP_ENTRY_MISSING",
      "The selected task plugin entry is not present in this profile",
    );
  if (
    input.target === "remote" &&
    (entry.disabled === true || entry.options.disabled === true)
  )
    reject(
      "STARTUP_REMOTE_DISABLED",
      "This remote plugin is Loader-disabled. Migrate its unchanged configuration with paused=true before loading it; do not enable an unpaused connection merely to edit settings",
    );
  const profile = ctx.get("profileContext") as
    | { overlays?: unknown[] }
    | undefined;
  if (hasOverride(profile?.overlays ?? [], entry))
    reject(
      "STARTUP_OVERRIDE",
      "A command-line layer owns this configuration; move it into the profile before saving",
    );
  const task = ctx.get("taskSystem") as TaskSystemService | undefined,
    remote = ctx.get("remoteExecution") as RemoteExecutionService | undefined;
  if (!task) reject("STARTUP_UNAVAILABLE", "Task service is not available");
  const releases: (() => void)[] = [];
  try {
    releases.push(task.beginConfigurationEdit());
    if (remote) releases.push(remote.beginConfigurationEdit());
    await host.edit(entry, (current) => {
      const actual =
        input.target === "task"
          ? taskValues(current, task)
          : remoteValues(current, remote);
      if (!isDeepStrictEqual(actual, input.expected))
        reject(
          "STARTUP_CONFLICT",
          "Configuration changed since this page was read; reload before saving",
        );
      if (input.target === "task") {
        const next: Raw = { ...current, ...input.changes },
          resolved = { ...input.expected, ...input.changes };
        if (resolved.role === "planner" && next.localNode)
          reject(
            "STARTUP_ROLE_CONFLICT",
            "Remove the local executor bootstrap through the operator configuration before selecting planner-only",
          );
        if (
          resolved.role === "executor" &&
          Array.isArray(next.remoteNodes) &&
          next.remoteNodes.length
        )
          reject(
            "STARTUP_ROLE_CONFLICT",
            "This profile still owns remote node registrations and cannot become executor-only",
          );
        if (resolved.defaultWorkspaceId) {
          const workspace = task.ledger.getWorkspace(
              resolved.defaultWorkspaceId,
            ),
            node = task.ledger.getNode(task.config.nodeId);
          if (
            workspace.nodeId !== task.config.nodeId ||
            workspace.state !== "ready" ||
            !node.workspaceIds.includes(workspace.workspaceId)
          )
            reject(
              "STARTUP_WORKSPACE_DENIED",
              "Default workspace must already be registered, ready and granted to this executor",
            );
        }
        if (resolved.sessionDecisionEnabled && !resolved.defaultWorkspaceId)
          reject(
            "STARTUP_WORKSPACE_REQUIRED",
            "Choose an authorized default workspace before enabling session decisions",
          );
        return next;
      }
      const { endpoint, audience, trustedNetworkTarget, ...top } =
        input.changes;
      const next: Raw = { ...current, ...top };
      let coordinator = record(current.coordinator);
      if (
        endpoint !== undefined ||
        audience !== undefined ||
        trustedNetworkTarget !== undefined
      ) {
        if (!coordinator) {
          if (
            current.authMode !== "trusted-network" ||
            typeof current.nodeId !== "string" ||
            current.nodeId === "unconfigured" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(current.nodeId) ||
            typeof endpoint !== "string" ||
            typeof audience !== "string" ||
            !trustedNetworkTarget
          )
            reject(
              "STARTUP_CONNECTION_REQUIRED",
              "A new connection needs the existing trusted-network mode and configured node identity, plus an explicitly selected endpoint, audience and exact source/target. Signed connections require operator-provisioned signing references",
            );
          if (next.pollIntervalMs !== undefined && next.pollIntervalMs !== 0)
            reject(
              "STARTUP_ROUTES_REQUIRED",
              "New identity-only connections keep polling off until operator-approved native routes are configured",
            );
          coordinator = { authMode: "trusted-network", nativeRoutes: [] };
          next.taskSessionsEnabled = true;
        }
        if (endpoint === null || audience === null)
          reject(
            "STARTUP_CONNECTION_REQUIRED",
            "An existing scheduler connection requires an endpoint and audience",
          );
        const nextCoordinator = {
          ...coordinator,
          ...(endpoint !== undefined ? { endpoint } : {}),
          ...(audience !== undefined ? { audience } : {}),
          ...(trustedNetworkTarget !== undefined
            ? {
                trustedNetwork:
                  trustedNetworkTarget === null
                    ? null
                    : {
                        ...record(coordinator.trustedNetwork),
                        ...trustedNetworkTarget,
                      },
              }
            : {}),
        };
        if (
          typeof nextCoordinator.endpoint !== "string" ||
          typeof nextCoordinator.audience !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(nextCoordinator.audience)
        )
          reject(
            "STARTUP_CONNECTION_INVALID",
            "Scheduler endpoint and audience must be valid",
          );
        if (endpoint !== undefined) {
          const url = new URL(endpoint);
          if (url.username || url.password || url.search || url.hash)
            reject(
              "STARTUP_ENDPOINT_SECRET",
              "Scheduler endpoint must not contain credentials, query parameters or fragments",
            );
        }
        if ((coordinator.authMode ?? current.authMode) === "trusted-network") {
          if (!nextCoordinator.trustedNetwork)
            reject(
              "STARTUP_CONNECTION_INVALID",
              "Trusted-network connection needs its existing exact source and destination binding",
            );
          validateNetworkTarget(
            nextCoordinator.endpoint,
            nextCoordinator.trustedNetwork as never,
          );
        } else {
          if (trustedNetworkTarget !== undefined)
            reject(
              "STARTUP_AUTH_MODE_FIXED",
              "This page cannot change a connection authentication mode",
            );
          assertEndpoint(
            nextCoordinator.endpoint,
            current.allowLoopbackHttp === true,
          );
        }
        next.coordinator = nextCoordinator;
      }
      // Resume is the user's explicit connection action. Keep a plainly
      // unconfigured executor paused instead of stranding a failed Loader row.
      if (
        input.changes.paused === false &&
        input.expected.paused &&
        (next.role ?? input.expected.role) === "executor"
      ) {
        const connection = record(next.coordinator);
        if (
          !connection ||
          typeof next.nodeId !== "string" ||
          next.nodeId === "unconfigured"
        )
          reject(
            "STARTUP_CONNECTION_REQUIRED",
            "Configure an authenticated scheduler connection and node identity before resuming",
          );
        if (
          (connection.authMode ?? next.authMode) !== "trusted-network" &&
          (!connection.keyId || !connection.privateKeyEnv)
        )
          reject(
            "STARTUP_CONNECTION_REQUIRED",
            "Resuming a signed connection requires existing operator-provisioned signing references",
          );
      }
      if (
        input.changes.pollIntervalMs !== undefined &&
        input.changes.pollIntervalMs !== 0 &&
        input.changes.pollIntervalMs < 100
      )
        reject(
          "STARTUP_POLL_INVALID",
          "Polling interval must be zero or at least 100 milliseconds",
        );
      return next;
    });
    return SaveStartupResult.parse({ saved: true, applies: "plugin-restart" });
  } catch (error) {
    if (error instanceof StartupSettingsError) throw error;
    const code = (error as { code?: unknown })?.code;
    if (code === "CONFIGURATION_BUSY")
      reject(
        "STARTUP_BUSY",
        "Execution or recovery is still active; finish or reconcile it before changing startup settings",
      );
    if (
      error instanceof Error &&
      /overridden by a home patch or command-line overlay/.test(error.message)
    )
      reject(
        "STARTUP_OVERRIDE",
        "A higher configuration layer owns these settings; reload or move ownership before saving",
      );
    reject(
      "STARTUP_SAVE_FAILED",
      "The Host did not confirm the startup change. Reload before retrying and check the selected role, workspace and connection",
    );
  } finally {
    for (const release of releases.reverse()) release();
  }
}
