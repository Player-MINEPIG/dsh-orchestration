import { independentRemoteControls, remoteListenerEnabled, remoteExecutorPaused } from "./remote/controls.js";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-config-editor";
import {
  composeEntries,
  loadProfileDirectory,
  readProfilePatches,
} from "@deepseek-ai/dsh-app-boot";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument, isSeq } from "yaml";
import { z } from "zod";
import { digest, EXECUTOR_OPERATIONS } from "./remote/protocol.js";
import { readNetworkPairings, removeNetworkPairings } from "./network-pairings.js";
import {
  validateNetworkEndpoint,
  validateTrustedNetwork,
} from "./remote/trusted-network.js";
import { validateNetworkTarget } from "./remote/network-client.js";
import { StartupSettingsError } from "./startup-settings.js";
import type { TaskSystemService } from "./dsh-plugin.js";
import type { RemoteExecutionService } from "./remote/index.js";

export const connectionOperations = EXECUTOR_OPERATIONS;
const role = z.enum(["planner", "executor", "both"]);
const names = z.array(z.string().trim().min(1).max(256)).max(128);
const peer = z
  .object({
    address: z.string().trim().min(1),
    nodeId: z.string().trim().default(""),
    nickname: z.string().trim().min(1).max(100),
    role:role.optional(),
    executionEnabled:z.boolean().optional(),
    audience:z.string().optional(),
    operations:z.array(z.enum(connectionOperations)).optional(),
    workspaces:names.optional(),
    capabilities:names.optional(),
  })
  .strict();
const target = z
  .object({
    address: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    localAddress: z.string().min(1),
    allowHttp: z.literal(true),
  })
  .strict();
export const ConnectionValues = z
  .object({
    nodeId: z.string().min(1),
    authMode: z.enum(["ed25519", "trusted-network"]),
    listenerEnabled: z.boolean(),
    listenAddress: z.string(),
    listenPort: z.number().int().min(1).max(65535).nullable(),
    routePath: z.string().regex(/^\/[A-Za-z0-9/_-]+$/),
    serviceAudience: z.string(),
    peers: z.array(peer).max(1024),
    outbound: z
      .object({
        endpoint: z.string().min(1),
        audience: z.string().min(1),
        target: target.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const ConnectionSnapshot = z
  .object({
    exists: z.boolean(),
    writable: z.boolean(),
    revision: z.string(),
    paused: z.boolean(),
    values: ConnectionValues,
    peersStatus:z.array(z.object({address:z.string(),nodeId:z.string().nullable(),nickname:z.string(),state:z.string(),sampledAt:z.number().nullable(),registered:z.boolean(),models:z.number()})),
    executionNodes: z.array(
      z.object({
        nodeId: z.string(),
        enabled: z.boolean(),
        models: z.number().int().nonnegative(),
        workspaces: names,
        capabilities: names,
      }),
    ),
  })
  .strict();
export const SaveConnectionInput = z
  .object({ expected: z.string(), value: ConnectionValues })
  .strict();
type Raw = Record<string, unknown>;
const raw = z.record(z.string(), z.unknown());
const asRaw = (value: unknown): Raw =>
  raw.safeParse(value).success ? raw.parse(value) : {};
const plugin = "@dsh-task/task-system/remote";
function reject(code: string, message: string): never {
  throw new StartupSettingsError(code, message);
}
function selected(ctx: Context) {
  const rows =
    ctx
      .get("configEditor")
      ?.entries()
      .filter((entry) => entry.options.name === plugin) ?? [];
  if (rows.length > 1)
    reject("STARTUP_AMBIGUOUS", "Multiple remote entries are present");
  return rows[0];
}
function publicEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}
function projection(ctx: Context, config: Raw, exists: boolean) {
  const task = ctx.get("taskSystem") as TaskSystemService | undefined;
  const network = asRaw(config.trustedNetwork),
    listen = asRaw(network.listen),
    coordinator = asRaw(config.coordinator);
  const mode = config.authMode === "ed25519" ? "ed25519" : "trusted-network";
  return ConnectionValues.parse({
    nodeId:
      config.nodeId ??
      (exists ? "unconfigured" : (task?.config.nodeId ?? "unconfigured")),
    authMode: exists ? (config.authMode ?? "ed25519") : mode,
    listenerEnabled: remoteListenerEnabled(config),
    listenAddress: listen.address ?? "",
    listenPort: listen.port ?? null,
    routePath: config.routePath ?? "/dsh-task/v1/commands",
    serviceAudience: config.audience ?? (exists ? "task-coordinator" : ""),
    peers: (Array.isArray(network.peers)?network.peers.map(asRaw):[]).map(peer=>({address:peer.address,nodeId:peer.nodeId ?? "",nickname:peer.nickname || peer.nodeId || peer.address,executionEnabled:typeof peer.executionEnabled === "boolean" ? peer.executionEnabled : ["executor","both"].includes(String(peer.role))})),
    outbound: publicEndpoint(coordinator.endpoint)
      ? {
          endpoint: publicEndpoint(coordinator.endpoint),
          audience: coordinator.audience,
          target: coordinator.trustedNetwork ?? null,
        }
      : null,
  });
}
async function patchText(ctx: Context) {
  const profile = ctx.get("profileContext");
  if (!profile)
    reject("STARTUP_READ_ONLY", "No persistent profile is available");
  try {
    return await readFile(profile.patchPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "[]\n";
    throw error;
  }
}
export async function readConnectionSettings(ctx: Context) {
  const entry = selected(ctx),
    config = asRaw(entry?.options.config),
    taskIdentity = (ctx.get("taskSystem") as TaskSystemService|undefined)?.config.nodeId;
  const task = ctx.get("taskSystem") as TaskSystemService | undefined;
  const values=projection(ctx,config,!!entry),pairings=readNetworkPairings(resolve(String(config.statePath ?? join(dirname(task?.config.databasePath ?? ".dsh-task/tasks.sqlite"),"remote-execution.sqlite"))));
  const statuses=task?.ledger.nodeStatuses() ?? [];
  return ConnectionSnapshot.parse({
    exists: !!entry,
    writable: !!ctx.get("configEditor"),
    revision: digest({ entry: entry?.options.id ?? null, config, taskIdentity }),
    paused: entry ? remoteExecutorPaused(config) : true,
    values:{...values,peers:values.peers.map(peer=>({...peer,nodeId:peer.nodeId || pairings.get(peer.address) || ""}))},
    peersStatus:values.peers.map(peer=>{const nodeId=peer.nodeId || pairings.get(peer.address) || null,status=statuses.find(row=>row.nodeId===nodeId);return {address:peer.address,nodeId,nickname:peer.nickname,state:status?.source==="authenticated-peer" ? status.state : (nodeId?(status?"waiting":"unregistered"):"unpaired"),sampledAt:status?.source==="authenticated-peer" && status.observedAt ? Date.parse(status.observedAt) : null,registered:!!status,models:nodeId && status?task!.ledger.getNode(nodeId).models.length:0};}),
    executionNodes: (
      task?.ledger
        .nodeStatuses()
        .map((status) => task.ledger.getNode(status.nodeId)) ?? []
    ).map((node) => ({
      nodeId: node.nodeId,
      enabled: node.enabled,
      models: node.models.length,
      workspaces: node.workspaceIds,
      capabilities: node.capabilities,
    })),
  });
}
function nextConfig(
  current: Raw,
  value: z.infer<typeof ConnectionValues>,
  creating: boolean,
): Raw {
  const next = { ...current, ...independentRemoteControls(current) };
  if (
    !creating &&
    ((current.nodeId ?? "unconfigured") !== value.nodeId ||
      (current.authMode ?? "ed25519") !== value.authMode)
  )
    reject(
      "STARTUP_AUTH_MODE_FIXED",
      "Existing identity and authentication mode cannot be changed here",
    );
  const network = asRaw(current.trustedNetwork);
  const previous = Array.isArray(network.peers) ? network.peers.map(asRaw) : [];
  const paired=readNetworkPairings(resolve(String(current.statePath ?? ".dsh-task/remote-execution.sqlite")));
  for(const row of value.peers) {
    const original=previous.find(peer=>peer.address===row.address || (peer.nodeId && peer.nodeId===row.nodeId));
    const bound=original?.nodeId || (original ? paired.get(String(original.address)) : undefined);
    if(row.nodeId && row.nodeId!==bound)reject("STARTUP_IDENTITY_FIXED","The device identity must come from its authenticated handshake");
  }
  if (value.authMode === "ed25519") {
    if (value.peers.length || value.listenAddress || value.listenPort !== null)
      reject(
        "STARTUP_AUTH_MODE_FIXED",
        "Signed mode shares the existing DSH listener; network peers are configured through the existing signed identity flow",
      );
  } else {
    const changed = value.listenAddress !== (asRaw(network.listen).address ?? "") || value.listenPort !== (asRaw(network.listen).port ?? null) || !isDeepStrictEqual(value.peers.map(peer=>({address:peer.address,nickname:peer.nickname,executionEnabled:peer.executionEnabled ?? false})),previous.map(peer=>({address:peer.address,nickname:peer.nickname || peer.nodeId || peer.address,executionEnabled:typeof peer.executionEnabled === "boolean" ? peer.executionEnabled : ["executor","both"].includes(String(peer.role))})));
    if (value.listenerEnabled || changed) {
      if (!value.listenAddress || value.listenPort === null)
        reject(
          "STARTUP_LISTENER_REQUIRED",
          "Specify the exact local listen address and port",
        );
      const listen = validateNetworkEndpoint({
        address: value.listenAddress,
        port: value.listenPort,
      });
      for (const row of value.peers)
        validateNetworkEndpoint({ address: row.address, port: listen.port });
      if (
        new Set(value.peers.filter(row=>row.nodeId).map((row) => row.nodeId)).size !== value.peers.filter(row=>row.nodeId).length ||
        new Set(value.peers.map((row) => row.address)).size !==
          value.peers.length
      )
        reject(
          "STARTUP_PEER_DUPLICATE",
          "Peer node IDs and source addresses must be unique",
        );
      const oldAddresses = Array.isArray(network.allowedAddresses)
        ? network.allowedAddresses.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      const newAddresses = value.peers.map((row) => row.address);
      const oldPeerAddresses = previous.map((row) => row.address);
      const allowedAddresses = [
        ...new Set([
          ...oldAddresses.filter(
            (address) => !oldPeerAddresses.includes(address),
          ),
          ...newAddresses,
        ]),
      ];
      const policy = {
        ...network,
        listen,
        allowHttp: true as const,
        allowedAddresses,
        peers: value.peers.map(row=>{
          const original=previous.find(peer=>peer.address===row.address || (peer.nodeId && peer.nodeId===row.nodeId));
          return {...original,address:row.address,nodeId:String(original?.nodeId || (original ? paired.get(String(original.address)) : "") || ""),nickname:row.nickname,executionEnabled:row.executionEnabled ?? (original ? typeof original.executionEnabled === "boolean" ? original.executionEnabled : ["executor","both"].includes(String(original.role)) : false),audience:value.serviceAudience,operations:Array.isArray(original?.operations)?original.operations:[...connectionOperations],workspaces:Array.isArray(original?.workspaces)?original.workspaces:[],capabilities:Array.isArray(original?.capabilities)?original.capabilities:[]};
        }),
      };
      if (value.listenerEnabled)
        validateTrustedNetwork(policy);
      Object.assign(next, { trustedNetwork: policy });
    }
  }
  Object.assign(next, {
    exposeHttp: value.listenerEnabled,
    routePath: value.routePath,
    audience: value.serviceAudience,
  });
  const oldCoordinator = asRaw(current.coordinator);
  const oldProjection = publicEndpoint(oldCoordinator.endpoint)
    ? {
        endpoint: publicEndpoint(oldCoordinator.endpoint),
        audience: oldCoordinator.audience,
        target: oldCoordinator.trustedNetwork ?? null,
      }
    : null;
  if (!isDeepStrictEqual(oldProjection, value.outbound)) {
    if (value.outbound === null)
      reject(
        "STARTUP_CONNECTION_REQUIRED",
        "An existing outbound connection cannot be silently removed",
      );
    const endpoint = new URL(value.outbound.endpoint);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      reject(
        "STARTUP_ENDPOINT_SECRET",
        "Protocol addresses cannot contain credentials, queries or fragments",
      );
    const coordinator = asRaw(current.coordinator);
    if (value.authMode !== "trusted-network")
      reject(
        "STARTUP_AUTH_MODE_FIXED",
        "Create signing references through the existing secure identity flow",
      );
    if (!value.outbound.target)
      reject(
        "STARTUP_CONNECTION_REQUIRED",
        "Specify exact remote and local source addresses for this connection",
      );
    validateNetworkTarget(value.outbound.endpoint, value.outbound.target);
    Object.assign(next, {
      coordinator: {
        ...coordinator,
        endpoint: value.outbound.endpoint,
        audience: value.outbound.audience,
        authMode: value.authMode,
        trustedNetwork: value.outbound.target,
        nativeRoutes: coordinator.nativeRoutes ?? [],
      },
    });
  }
  return next;
}
export async function saveConnectionSettings(ctx: Context, input: unknown) {
  const request = SaveConnectionInput.parse(input),
    before = await readConnectionSettings(ctx);
  if (request.expected !== before.revision)
    reject(
      "STARTUP_CONFLICT",
      "Connection settings changed; reload before saving",
    );
  const task = ctx.get("taskSystem") as TaskSystemService | undefined;
  if (!task) reject("STARTUP_UNAVAILABLE", "Task service is unavailable");
  const entry = selected(ctx),
    host = ctx.get("configEditor");
  if (!host)
    reject(
      "STARTUP_READ_ONLY",
      "Persistent configuration editing is unavailable",
    );
  const releases: Array<() => void> = [];
  try {
    releases.push(task.beginConfigurationEdit());
    const remote = ctx.get("remoteExecution") as
      | RemoteExecutionService
      | undefined;
    if (remote) releases.push(await remote.beginConfigurationEdit());
    if (entry) {
      const original = structuredClone(asRaw(entry.options.config));
      const value = nextConfig(original, request.value, false);
      const unbound=before.values.peers.filter(peer=>!request.value.peers.some(row=>row.address===peer.address));
      const removed=before.values.peers.filter(peer=>!request.value.peers.some(row=>row.address===peer.address || (row.nodeId && row.nodeId===peer.nodeId)));
      await host.edit(entry, (current) => {
        if (digest(current) !== digest(original))
          reject("STARTUP_CONFLICT", "Connection changed before saving");
        return value;
      });
      removeNetworkPairings(resolve(String(original.statePath ?? join(dirname(task.config.databasePath),"remote-execution.sqlite"))),unbound.map(peer=>peer.address));
      for(const peer of removed)if(peer.nodeId)task.ledger.deactivatePairedExecutor(`remove-peer:${digest([request.expected,peer.nodeId])}`,peer.nodeId);
    } else {
      const profile = ctx.get("profileContext");
      if (!profile)
        reject("STARTUP_READ_ONLY", "No persistent profile is available");
      if (request.value.nodeId !== task.config.nodeId)
        reject(
          "STARTUP_IDENTITY_FIXED",
          "Use this Task service's existing node identity",
        );
      const config = nextConfig(
        {
          paused: true,
          exposeHttp: false,
          role:task.config.role,
          nodeId: task.config.nodeId,
          authMode: request.value.authMode,
          statePath: resolve(
            dirname(task.config.databasePath),
            "remote-execution.sqlite",
          ),
          pollIntervalMs: 0,
          concurrency: 1,
          taskSessionsEnabled: true,
        },
        request.value,
        true,
      );
      config.paused = true;
      config.exposeHttp = false;
      const { reconcileProfilePatches } = (await import(
        pathToFileURL(
          createRequire(profile.installAnchor).resolve(
            "@deepseek-ai/dsh-app-boot",
          ),
        ).href
      )) as typeof import("@deepseek-ai/dsh-app-boot");
      const install = async () =>
        withFileLock(join(profile.dir, "package.json"), async () => {
          if (
            selected(ctx) ||
            (await readConnectionSettings(ctx)).revision !== request.expected
          )
            reject(
              "STARTUP_CONFLICT",
              "A connection entry or profile change appeared before creation",
            );
          const beforeText = await patchText(ctx),
            beforePatches = readProfilePatches("dsh", profile),
            document = parseDocument(beforeText, {
              customTags: [
                {
                  tag: "tag:yaml.org,2002:js",
                  resolve: (value: string) => value,
                },
              ],
            });
          if (document.errors[0]) throw document.errors[0];
          if (!isSeq(document.contents))
            throw new Error("Profile patch must be a sequence");
          const id = "task-remote-execution";
          if (
            composeEntries([beforePatches]).some(
              (row) => row.id === id || row.name === plugin,
            )
          )
            reject(
              "STARTUP_CONFLICT",
              "A remote entry already exists in another layer",
            );
          document.contents.flow = false;
          document.add(
            document.createNode({ insert: [{ id, name: plugin, config }] }),
          );
          const after = String(document),
            loaded = loadProfileDirectory(
              "dsh",
              profile.dir,
              profile.installAnchor,
            );
          const nextPatches = readProfilePatches("dsh", profile, {
            ...loaded,
            patches: [
              ...loaded.patches,
              { insert: [{ id, name: plugin, config }] },
            ],
          });
          const effective = composeEntries([nextPatches]).find(
            (row) => row.id === id,
          );
          if (!isDeepStrictEqual(effective?.config, config))
            reject(
              "STARTUP_OVERRIDE",
              "Another configuration layer owns the remote entry",
            );
          await writeFileAtomic(profile.patchPath, after, { mode: 0o600 });
          try {
            await reconcileProfilePatches(ctx.root, nextPatches, "dsh", [id]);
          } catch (error) {
            if ((await patchText(ctx)) === after) {
              await writeFileAtomic(profile.patchPath, beforeText, {
                mode: 0o600,
              });
              await reconcileProfilePatches(ctx.root, beforePatches, "dsh");
            }
            throw error;
          }
        });
      const hmr = ctx.get("hmr");
      await (hmr ? hmr.runExclusive(install) : install());
    }
    return await readConnectionSettings(ctx);
  } finally {
    for (const release of releases.reverse()) release();
  }
}
