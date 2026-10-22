import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, sep, normalize } from "node:path";
import { z } from "zod";
import { digest, insist, type ExecutorWorkspaceMetadata } from "./protocol.js";
import type { RecoveryStore, LocalWorkspaceGrant } from "./store.js";
import type { WorkspaceBinding } from "./ports.js";
export interface LocalWorkspaceRegistry {
  list(): { id: string; title?: string; path: string }[];
}
export interface WorkspaceGrantCatalog {
  nodeId: string;
  revision: number;
  items: (ExecutorWorkspaceMetadata & {
    registryId: string;
    enabled: boolean;
    source: "local" | "configuration" | "registry";
    available: boolean;
  })[];
}
export const SetLocalWorkspaceGrant = z
  .object({
    registryId: z.string().min(1).max(200),
    enabled: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type SetLocalWorkspaceGrant = z.infer<typeof SetLocalWorkspaceGrant>;
export function physicalWorkspace(path: string) {
  insist(
    isAbsolute(path) && normalize(path) === path,
    "WORKSPACE_GRANT_PATH_INVALID",
    403,
  );
  let current = parse(path).root;
  for (const part of [
    "",
    ...relative(current, path).split(sep).filter(Boolean),
  ]) {
    current = join(current, part);
    const stat = lstatSync(current);
    insist(
      !stat.isSymbolicLink() && stat.isDirectory(),
      "WORKSPACE_GRANT_PATH_INVALID",
      403,
    );
  }
  insist(realpathSync(path) === path, "WORKSPACE_GRANT_PATH_CHANGED", 403);
  return path;
}
function available(path: string) {
  try {
    physicalWorkspace(path);
    return true;
  } catch {
    return false;
  }
}
function grantAvailable(
  grant: LocalWorkspaceGrant,
  registry: LocalWorkspaceRegistry | undefined,
) {
  return (
    !!registry
      ?.list()
      .some(
        (entry) => entry.id === grant.registryId && entry.path === grant.path,
      ) && available(grant.path)
  );
}
function configurationAvailable(binding: WorkspaceBinding) {
  try {
    const path = realpathSync(binding.path);
    const local = relative(realpathSync(binding.allowedRoot), path);
    return (
      lstatSync(path).isDirectory() &&
      local !== ".." &&
      !local.startsWith(`..${sep}`) &&
      !isAbsolute(local)
    );
  } catch {
    return false;
  }
}
export function localWorkspaceBindings(
  nodeId: string,
  store: RecoveryStore | undefined,
  registry: LocalWorkspaceRegistry | undefined,
): WorkspaceBinding[] {
  return (store?.workspaceGrantState().grants ?? [])
    .filter(
      (grant) =>
        grant.enabled &&
        grant.nodeId === nodeId &&
        grantAvailable(grant, registry),
    )
    .map((grant) => ({
      workspaceId: grant.workspaceId,
      nodeId,
      path: grant.path,
      allowedRoot: grant.path,
    }));
}
export function workspaceGrantCatalog(input: {
  nodeId: string;
  store?: RecoveryStore;
  registry?: LocalWorkspaceRegistry;
  configured: readonly WorkspaceBinding[];
  includeRegistered?: boolean;
}): WorkspaceGrantCatalog {
  const state = input.store?.workspaceGrantState() ?? {
      revision: 0,
      grants: [],
    },
    entries = input.registry?.list() ?? [];
  const items: WorkspaceGrantCatalog["items"] = entries.map((entry) => {
    const grant = state.grants.find(
        (grant) => grant.registryId === entry.id && grant.path === entry.path,
      ),
      configuration = input.configured.find(
        (binding) =>
          binding.nodeId === input.nodeId && binding.path === entry.path,
      );
    const disabled = grant ? !grant.enabled : state.grants.some(saved => (saved.registryId === entry.id || saved.path === entry.path) && !saved.enabled);
    const path = entry.path;
    return {
      registryId: entry.id,
      workspaceId:
        configuration?.workspaceId ??
        grant?.workspaceId ??
        `wg-${digest([input.store?.instanceId ?? "uninitialized", input.nodeId, entry.id, entry.path]).slice(0, 48)}`,
      nodeId: input.nodeId,
      label: entry.title || grant?.label || entry.id,
      path,
      available: configuration ? configurationAvailable(configuration) : available(path),
      enabled: !!configuration || !!grant?.enabled || !!input.includeRegistered && !disabled,
      source: configuration ? "configuration" : grant ? "local" : input.includeRegistered ? "registry" : "local",
      state:
        disabled && !configuration
          ? "revoked"
          : (
                configuration
                  ? configurationAvailable(configuration)
                  : available(path)
              )
            ? "ready"
            : "unavailable",
    };
  });
  for (const grant of state.grants)
    if (!items.some((item) => item.workspaceId === grant.workspaceId))
      items.push({
        ...grant,
        registryId: entries.some((entry) => entry.id === grant.registryId)
          ? ""
          : grant.registryId,
        source: "local",
        available: false,
        state: grant.enabled ? "unavailable" : "revoked",
      });
  for (const binding of input.configured)
    if (
      binding.nodeId === input.nodeId &&
      !items.some((item) => item.workspaceId === binding.workspaceId)
    )
      items.push({
        registryId: "",
        workspaceId: binding.workspaceId,
        nodeId: binding.nodeId,
        label: binding.workspaceId,
        path: binding.path,
        enabled: true,
        source: "configuration",
        available: configurationAvailable(binding),
        state: configurationAvailable(binding) ? "ready" : "unavailable",
      });
  return { nodeId: input.nodeId, revision: state.revision, items };
}
export function selectedWorkspaceGrant(input: {
  nodeId: string;
  store: RecoveryStore;
  registry: LocalWorkspaceRegistry | undefined;
  selection: SetLocalWorkspaceGrant;
}): LocalWorkspaceGrant {
  const selected = input.registry
    ?.list()
    .find((entry) => entry.id === input.selection.registryId);
  const grants = input.store.workspaceGrantState().grants;
  const previous =
    grants.find(
      (grant) =>
        grant.registryId === input.selection.registryId &&
        grant.path === selected?.path,
    ) ??
    grants.find(
      (grant) =>
        grant.registryId === input.selection.registryId && grant.enabled,
    ) ??
    grants.find((grant) => grant.registryId === input.selection.registryId);
  if (!input.selection.enabled && previous) return { ...previous, enabled: false };
  insist(selected, "WORKSPACE_REGISTRY_ENTRY_REQUIRED", 404);
  const path = input.selection.enabled ? physicalWorkspace(selected.path) : selected.path;
  return {
    registryId: selected.id,
    workspaceId: `wg-${digest([input.store.instanceId, input.nodeId, selected.id, path]).slice(0, 48)}`,
    nodeId: input.nodeId,
    label: selected.title || selected.id,
    path,
    enabled: input.selection.enabled,
  };
}
export function executorWorkspaceSnapshot(
  nodeId: string,
  store: RecoveryStore | undefined,
  configured: readonly WorkspaceBinding[],
  registry: LocalWorkspaceRegistry | undefined,
  includeRegistered = false,
): ExecutorWorkspaceMetadata[] {
  const items = workspaceGrantCatalog({nodeId,store,configured,registry,includeRegistered}).items
    .filter(item => item.enabled || item.state === "revoked")
    .map(({workspaceId,nodeId,label,path,state}) => ({workspaceId,nodeId,label,path,state}));
  insist(items.length <= 64, "WORKSPACE_CATALOG_LIMIT", 409);
  return items;
}
