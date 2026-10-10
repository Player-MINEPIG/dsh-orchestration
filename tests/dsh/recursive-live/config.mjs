import { resolve, join } from "node:path";
export function liveConfiguration(env = process.env) {
  const root = resolve(env.DSH_RECURSIVE_RUNTIME || ".runtime/recursive-live");
  const endpoint = new URL(
    env.DSH_RECURSIVE_ENDPOINT || "http://127.0.0.1:43172/commands",
  );
  const snapshotEndpoint = new URL(
    env.DSH_RECURSIVE_SNAPSHOT_ENDPOINT || "/snapshot",
    endpoint,
  );
  if (snapshotEndpoint.origin !== endpoint.origin)
    throw new Error(
      "Snapshot endpoint must use the same authority origin as commands",
    );
  return {
    root,
    workspace: join(root, "workspace"),
    endpoint,
    snapshotEndpoint,
    codexHome: resolve(
      env.DSH_RECURSIVE_CODEX_HOME || ".runtime/recursive/codex-home",
    ),
  };
}
