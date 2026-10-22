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
    source: "local" | "configuration";
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
    const path = grant?.path ?? entry.path;
    return {
      registryId: entry.id,
      workspaceId:
        configuration?.workspaceId ??
        grant?.workspaceId ??
        `wg-${digest([input.store?.instanceId ?? "uninitialized", input.nodeId, entry.id, entry.path]).slice(0, 48)}`,
      nodeId: input.nodeId,
      label: entry.title || grant?.label || entry.id,
      path,
      enabled: !!configuration || !!grant?.enabled,
      source: configuration ? "configuration" : "local",
      state:
        grant && !grant.enabled && !configuration
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
  if (!input.selection.enabled) {
    insist(previous, "WORKSPACE_GRANT_NOT_FOUND", 404);
    return { ...previous, enabled: false };
  }
  insist(selected, "WORKSPACE_REGISTRY_ENTRY_REQUIRED", 404);
  const path = physicalWorkspace(selected.path);
  return {
    registryId: selected.id,
    workspaceId: `wg-${digest([input.store.instanceId, input.nodeId, selected.id, path]).slice(0, 48)}`,
    nodeId: input.nodeId,
    label: selected.title || selected.id,
    path,
    enabled: true,
  };
}
export function executorWorkspaceSnapshot(
  nodeId: string,
  store: RecoveryStore | undefined,
  configured: readonly WorkspaceBinding[],
  registry: LocalWorkspaceRegistry | undefined,
): ExecutorWorkspaceMetadata[] {
  const items: ExecutorWorkspaceMetadata[] = configured
    .filter((binding) => binding.nodeId === nodeId)
    .map((binding) => ({
      workspaceId: binding.workspaceId,
      nodeId,
      label: binding.workspaceId,
      path: binding.path,
      state: configurationAvailable(binding) ? "ready" : "unavailable",
    }));
  for (const grant of store?.workspaceGrantState().grants ?? [])
    if (grant.nodeId === nodeId)
      items.push({
        workspaceId: grant.workspaceId,
        nodeId,
        label: grant.label,
        path: grant.path,
        state: !grant.enabled
          ? "revoked"
          : grantAvailable(grant, registry)
            ? "ready"
            : "unavailable",
      });
  insist(items.length <= 64, "WORKSPACE_CATALOG_LIMIT", 409);
  return items;
}
