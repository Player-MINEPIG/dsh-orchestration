/** Narrow startup config editing through the host's public ConfigEditor only. */
import { independentRemoteControls, remoteListenerEnabled, remoteExecutorPaused } from "./remote/controls.js";
import type { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { TaskSystemService } from "./dsh-plugin.js";
import type { RemoteExecutionService } from "./remote/index.js";
import { assertEndpoint } from "./remote/http.js";
import { validateNetworkTarget } from "./remote/network-client.js";

import { resolve } from "node:path";
import { validateTaskDatabasePath } from "./database-settings.js";

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
    databasePath: z.string().optional(),
    nodeId: z.string().optional(),
    nodeCapacities: z
      .array(
        z
          .object({
            nodeId: z.string().min(1),
            maxConcurrent: z.number().int().min(1).max(32),
          })
          .strict(),
      )
      .optional(),
    sessionDecisionEnabled: z.boolean(),
    planningDecisionEnabled: z.boolean(),
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
  task: z
    .object({
      entryId: z.string(),
      decisionAvailable: z.boolean(),
      values: TaskStartupValues,
      workspaceScope: z
        .object({ nodeId: z.string(), schedulerId: z.string() })
        .optional(),
    })
    .nullable(),
  restartBlockers: z.array(z.object({runId:z.string(), title:z.string(), state:z.string()})).optional(),
  remote: z
    .object({
      entryId: z.string(),
      loaded: z.boolean(),
      loaderDisabled: z.boolean(),
      heartbeat: z
        .object({
          state: z.enum(["disabled", "waiting", "acknowledged", "failed"]),
          intervalMs: z.number(),
          acknowledgedAt: z.string().nullable(),
        })
        .optional(),
      values: RemoteStartupValues,
    })
    .nullable(),
});
export const SaveStartupInput = z.discriminatedUnion("target", [
  z
    .object({
      target: z.literal("task"),
      expected: TaskStartupValues,
      changes: TaskStartupValues.omit({nodeId:true}).partial().strict(),
    })
    .strict(),
  z
    .object({
      target: z.literal("remote"),
      expected: RemoteStartupValues,
      changes: RemoteStartupValues.omit({role:true}).partial().strict(),
    })
    .strict(),
]);
export const SaveStartupResult = z.object({
  saved: z.literal(true),
  applies: z.enum(["live", "plugin-restart"]),
});
export const CheckConnectionInput = z
  .object({
    expected: RemoteStartupValues,
    endpoint: z.string().min(1).max(2048),
    trustedNetworkTarget: Target.nullable(),
  })
  .strict();
export const CheckConnectionResult = z
  .object({
    connected: z.boolean(),
    checkedAt: z.string(),
    endpoint: z.string().nullable(),
    paused: z.boolean(),
    code: z.string().nullable(),
    identity: z
      .object({
        nodeId: z.string(),
        schedulerId: z.string(),
        executorId: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
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
    databasePath: resolve(typeof raw.databasePath==="string" ? raw.databasePath : task?.config.databasePath ?? ".dsh-task/tasks.sqlite"),
    nodeId: task?.config.nodeId ?? (typeof raw.nodeId==="string" ? raw.nodeId : "local"),
    role:
      typeof raw.role === "string" ? raw.role : (task?.config.role ?? "both"),
    nodeCapacities: [...new Map([
      ...(Array.isArray(raw.remoteNodes) ? raw.remoteNodes : task?.config.remoteNodes ?? []).map(value=>{const node=record(value);return [String(node?.nodeId),{nodeId:String(node?.nodeId),maxConcurrent:Number(record(raw.nodeCapacityOverrides)?.[String(node?.nodeId)] ?? node?.maxConcurrent ?? 1)}] as const;}),
      ...(task?.ledger.nodeStatuses().filter(node=>node.nodeId!==task.config.nodeId).map(node=>[node.nodeId,{nodeId:node.nodeId,maxConcurrent:Number(record(raw.nodeCapacityOverrides)?.[node.nodeId] ?? task.ledger.getNode(node.nodeId).maxConcurrent ?? 1)}] as const) ?? []),
    ]).values()],
    planningDecisionEnabled:
      typeof raw.planningDecisionEnabled === "boolean"
        ? raw.planningDecisionEnabled
        : (task?.config.planningDecisionEnabled ?? true),
    sessionDecisionEnabled:
      typeof raw.sessionDecisionEnabled === "boolean"
        ? raw.sessionDecisionEnabled
        : (task?.config.sessionDecisionEnabled ?? false),
  });
}
function remoteValues(raw: Raw, remote: RemoteExecutionService | undefined, task?:TaskSystemService) {
  const current = remote?.settingsSnapshot(),
    limits = record(raw.executionLimits),
    coordinator = record(raw.coordinator),
    target = record(coordinator?.trustedNetwork);
  return RemoteStartupValues.parse({
    paused:
      remoteExecutorPaused(raw),
    role:
      task?.config.role ?? current?.role ?? raw.role ?? "executor",
    endpoint: coordinator
      ? (publicEndpoint(coordinator.endpoint) ?? current?.endpoint ?? null)
      : null,
    audience:
      typeof coordinator?.audience === "string" ? coordinator.audience : null,
    pollIntervalMs:
      typeof limits?.pollIntervalMs === "number" ? limits.pollIntervalMs : typeof raw.pollIntervalMs === "number"
        ? raw.pollIntervalMs
        : (current?.pollIntervalMs ?? 0),
    concurrency:
      typeof limits?.concurrency === "number" ? limits.concurrency : typeof raw.concurrency === "number"
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
    restartBlockers: [
      ...(task?.ledger.configurationBlockers() ?? []),
      ...(remote?.queueSnapshot().items ?? []).filter(run => ["dispatching","uncertain","result","cancellation","retry_pending","running"].includes(run.state)).map(run => ({runId:run.runId,title:run.title,state:run.state})),
    ].filter((run,index,all) => all.findIndex(other => other.runId===run.runId)===index),
    applies: "plugin-restart",
    task: a
      ? {
          entryId: a.options.id,
          decisionAvailable: !!ctx.get("decisionModels"),
          values: taskValues(a.options.config ?? {}, task),
          ...(task
            ? {
                workspaceScope: {
                  nodeId: task.config.nodeId,
                  schedulerId: task.ledger.schedulerIdentity(),
                },
              }
            : {}),
        }
      : null,
    remote: b
      ? {
          entryId: b.options.id,
          loaded: !!remote,
          loaderDisabled: b.disabled === true || b.options.disabled === true,
          values: remoteValues(b.options.config ?? {}, remote, task),
          ...(remote ? { heartbeat: remote.heartbeatSnapshot() } : {}),
        }
      : null,
  });
}
export async function checkStartupConnection(ctx: Context, value: unknown) {
  const input = CheckConnectionInput.parse(value);
  const current = readStartupSettings(ctx).remote;
  const remote = ctx.get("remoteExecution") as
    | RemoteExecutionService
    | undefined;
  const base = {
    checkedAt: new Date().toISOString(),
    endpoint: publicEndpoint(input.endpoint),
    paused: current?.values.paused ?? true,
  };
  try {
    if (!current || !remote)
      reject("COORDINATOR_REQUIRED", "Connection is not loaded");
    if (!isDeepStrictEqual(current.values, input.expected))
      reject("STARTUP_CONFLICT", "Refresh before checking this connection");
    const url = new URL(input.endpoint);
    if (url.username || url.password || url.search || url.hash)
      reject("STARTUP_ENDPOINT_SECRET", "Endpoint cannot contain credentials");
    const identity = await remote.checkConnection(
      input.endpoint,
      input.trustedNetworkTarget,
    );
    return CheckConnectionResult.parse({
      ...base,
      connected: true,
      code: null,
      identity,
    });
  } catch (error) {
    const failure = error as {
      code?: string;
      name?: string;
      cause?: { code?: string };
    };
    const code =
      failure.name === "TimeoutError" ||
      failure.name === "AbortError" ||
      failure.cause?.code === "ABORT_ERR"
        ? "CONNECTION_TIMEOUT"
        : (failure.code ?? failure.cause?.code ?? "CONNECTION_FAILED");
    return CheckConnectionResult.parse({
      ...base,
      connected: false,
      code: /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : "CONNECTION_FAILED",
      identity: null,
    });
  }
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
  if (
    input.target === "task" &&
    !ctx.get("decisionModels") &&
    (input.changes.planningDecisionEnabled === true ||
      input.changes.sessionDecisionEnabled === true)
  )
    reject(
      "STARTUP_DECISION_REQUIRED",
      "Install and enable dsh-jev-plugin before enabling decisions",
    );
  const restart = Object.keys(input.changes).some(key => !(input.target === "task" ? ["nodeCapacities", "planningDecisionEnabled", "sessionDecisionEnabled"] : ["concurrency", "pollIntervalMs"]).includes(key));
  if(input.target==="task" && input.changes.databasePath!==undefined) {
    const role=input.changes.role ?? task.config.role;
    if(role==="executor")reject("STARTUP_DATABASE_DENIED","Only a scheduler may select its task database");
    try { input.changes.databasePath=await validateTaskDatabasePath(input.changes.databasePath); } catch(error) { reject("STARTUP_DATABASE_INVALID",error instanceof Error?error.message:"Database path is invalid"); }
  }
  const releases: (() => void)[] = [];
  try {
    if (restart) {
      releases.push(task.beginConfigurationEdit());
      if (remote) releases.push(await remote.beginConfigurationEdit());
    }
    await host.edit(entry, (current) => {
      const actual =
        input.target === "task"
          ? taskValues(current, task)
          : remoteValues(current, remote, task);
      const omitRole=(value:Raw)=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=="role"));
      if (!isDeepStrictEqual(input.target==="remote"?omitRole(actual):actual, input.target==="remote"?omitRole(input.expected):input.expected))
        reject(
          "STARTUP_CONFLICT",
          "Configuration changed since this page was read; reload before saving",
        );
      if (input.target === "task") {
        const { nodeCapacities, ...selected } = input.changes;
        const next: Raw = { ...current, ...selected },
          resolved = { ...input.expected, ...input.changes };
        if(selected.databasePath!==undefined && selected.databasePath!==input.expected.databasePath)next.defaultWorkspaceId=null;
        if (nodeCapacities !== undefined) {
          if (resolved.role === "executor")
            reject(
              "STARTUP_CAPACITY_DENIED",
              "Only a scheduler may configure its registered executor capacities",
            );
          const ids = taskValues(current,task).nodeCapacities?.map(node=>node.nodeId) ?? [];
          if (
            new Set(ids).size !== ids.length ||
            nodeCapacities.length !== ids.length ||
            new Set(nodeCapacities.map((node) => node.nodeId)).size !==
              ids.length ||
            nodeCapacities.some((node) => !ids.includes(node.nodeId))
          )
            reject(
              "STARTUP_CAPACITY_DENIED",
              "Capacity edits must retain exactly the existing registered node identities",
            );
          next.nodeCapacityOverrides = { ...record(current.nodeCapacityOverrides), ...Object.fromEntries(nodeCapacities.map(node => [node.nodeId, node.maxConcurrent])) };
        }
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
        if(input.changes.role!==undefined){
          const remoteEntry=row(host,"remote"),raw=remoteEntry?.options.config;
          if(raw){
            const coordinator=record(raw.coordinator),limits=record(raw.executionLimits);
            if((resolved.role==="executor" && remoteListenerEnabled(raw)) ||
               (resolved.role==="planner" && !remoteExecutorPaused(raw) && (Number(limits?.pollIntervalMs ?? raw.pollIntervalMs ?? 0)>0 || Number(coordinator?.heartbeatIntervalMs ?? 0)>0)) ||
               (resolved.role!=="executor" && remoteListenerEnabled(raw) && raw.authMode==="trusted-network" && !raw.trustedNetwork))
              reject("STARTUP_ROLE_CONFLICT","The selected role conflicts with the current connection listener, polling or heartbeat. Pause the connection or adjust those settings first");
          }
        }
        return next;
      }
      const { endpoint, audience, trustedNetworkTarget, ...top } =
        input.changes;
      const {concurrency, pollIntervalMs, ...bootFields} = top;
      const next: Raw = { ...current, ...(restart ? independentRemoteControls(current) : {}), ...bootFields };
      if (concurrency !== undefined || pollIntervalMs !== undefined)
        next.executionLimits = { ...record(current.executionLimits), ...(concurrency === undefined ? {} : {concurrency}), ...(pollIntervalMs === undefined ? {} : {pollIntervalMs}) };
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
          if ((record(next.executionLimits)?.pollIntervalMs ?? next.pollIntervalMs ?? 0) !== 0)
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
        task.config.role === "executor"
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
      // The operator switch owns both liveness and task admission. Zero-valued
      // legacy intervals must not leave an enabled executor silently offline.
      if (
        input.changes.paused === false &&
        task.config.role !== "planner"
      ) {
        const connection = record(next.coordinator);
        if(!connection)reject("STARTUP_CONNECTION_REQUIRED","Configure the scheduler address before enabling collaboration");
        next.executionLimits = { ...record(next.executionLimits), pollIntervalMs: (record(next.executionLimits)?.pollIntervalMs ?? next.pollIntervalMs ?? input.expected.pollIntervalMs) || 1000 };
        next.coordinator = {
          ...connection,
          heartbeatIntervalMs: connection.heartbeatIntervalMs || 5000,
        };
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
    if (!restart && input.target === "task" && input.changes.nodeCapacities) {
      // ConfigEditor has updated the Loader-owned live references without replacing this service.
      task.applyLiveNodeCapacities();
    }
    return SaveStartupResult.parse({ saved: true, applies: restart ? "plugin-restart" : "live" });
  } catch (error) {
    if (error instanceof StartupSettingsError) throw error;
    const code = (error as { code?: unknown })?.code;
    if (code === "CONFIGURATION_BUSY")
      reject(
        "STARTUP_BUSY",
        "Execution or recovery is still active; finish or reconcile it before changing startup settings",
      );
    if (
      [
        "NETWORK_TARGET_DENIED",
        "INVALID_NETWORK_ENDPOINT",
        "INVALID_NETWORK_ADDRESS",
        "TRUSTED_NETWORK_OPT_IN_REQUIRED",
      ].includes(String(code))
    )
      reject(
        "STARTUP_TARGET_MISMATCH",
        "Scheduler URL must match the exact trusted-network destination address and port",
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
