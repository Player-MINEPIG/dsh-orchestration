import {
  mkdirSync,
  realpathSync,
  lstatSync,
  existsSync,
  writeFileSync,
  readFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
} from "node:fs";
import { resolve, relative, isAbsolute, join, dirname, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TaskLedger, TaskError } from "./ledger.js";
import type { Workspace, Artifact } from "./contracts.js";
const deny = (message: string): never => {
  throw new TaskError("WORKSPACE_POLICY", message);
};
const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return (
    r === "" || (!r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r))
  );
};
export interface WorkspaceRoot {
  id: string;
  path: string;
  allowCreate: boolean;
}
/** Configured roots must be operator-owned, not writable by hostile local users. */
export class WorkspaceManager {
  private roots: Map<string, WorkspaceRoot>;
  constructor(
    private ledger: TaskLedger,
    private nodeId: string,
    roots: WorkspaceRoot[],
  ) {
    this.roots = new Map(
      roots.map((r) => [r.id, { ...r, path: realpathSync(r.path) }]),
    );
  }
  provision(
    commandId: string,
    input: {
      workspaceId: string;
      rootId: string;
      relativePath: string;
      label: string;
      mode: "create" | "reuse";
    },
  ): Workspace {
    const root = this.roots.get(input.rootId) ?? deny("Unknown permitted root");
    if (
      !input.relativePath ||
      isAbsolute(input.relativePath) ||
      input.relativePath
        .split(/[\\/]/)
        .some((x) => x === ".." || x === "." || !x)
    )
      deny("Path must be a non-empty clean relative path");
    const target = resolve(root.path, input.relativePath);
    if (!inside(root.path, target)) deny("Path escapes allowed root");
    if (input.mode === "create" && !root.allowCreate)
      deny("Root permits reuse only");
    if (!["create", "reuse"].includes(input.mode))
      deny("Unknown provisioning mode");
    const key = createHash("sha256").update(commandId).digest("hex");
    const marker = join(target, ".dsh-task-workspace");
    // Persist intended node/path before any external effect. The same command may
    // reconcile its own marker after a crash, but never adopt unrelated contents.
    const planned: Workspace = {
      workspaceId: input.workspaceId,
      nodeId: this.nodeId,
      path: target,
      label: input.label,
      state: "planned",
      createdAt: new Date().toISOString(),
    };
    let prior: Workspace | undefined;
    try {
      prior = this.ledger.getWorkspace(input.workspaceId);
    } catch (e) {
      if (!(e instanceof TaskError) || e.code !== "NOT_FOUND") throw e;
    }
    if (prior && (prior.nodeId !== this.nodeId || prior.path !== target))
      deny("Workspace identity already belongs elsewhere");
    if (!prior) this.ledger.registerWorkspace(`${commandId}:plan`, planned);
    let walk = root.path;
    const segments = input.relativePath.split(/[\\/]/);
    for (let index = 0; index < segments.length; index++) {
      walk = join(walk, segments[index]!);
      const last = index === segments.length - 1;
      if (existsSync(walk)) {
        const stat = lstatSync(walk);
        if (stat.isSymbolicLink() || !stat.isDirectory())
          deny("Symlink or non-directory in workspace path");
        if (
          last &&
          input.mode === "create" &&
          (!existsSync(marker) || readFileSync(marker, "utf8") !== key)
        )
          deny("Existing directory is not owned by this creation request");
      } else {
        if (input.mode === "reuse") deny("Workspace does not exist");
        mkdirSync(walk);
        if (last) writeFileSync(marker, key, { flag: "wx", mode: 0o600 });
      }
      const actual = realpathSync(walk);
      if (!inside(root.path, actual)) deny("Resolved directory escapes root");
    }
    const ready: Workspace = {
      ...planned,
      createdAt: prior?.createdAt ?? planned.createdAt,
      state: "ready",
    };
    return this.ledger.registerWorkspace(`${commandId}:ready`, ready).value;
  }
}

/** Immutable content-addressed artifact bytes, separate from mutable views. */
export class ArtifactStore {
  private root: string;
  constructor(
    private ledger: TaskLedger,
    root: string,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
  }
  put(
    commandId: string,
    input: {
      taskId: string;
      name: string;
      mediaType: string;
      bytes: Uint8Array;
      maxBytes?: number;
    },
  ): Artifact {
    this.ledger.getTask(input.taskId);
    if (input.bytes.byteLength > (input.maxBytes ?? 16 * 1024 * 1024))
      throw new TaskError("TOO_LARGE", "Artifact exceeds limit");
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const path = join(this.root, digest);
    if (!existsSync(path)) {
      const staging = join(this.root, `.tmp-${randomUUID()}`);
      const file = openSync(staging, "wx", 0o600);
      try {
        writeFileSync(file, input.bytes);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      try {
        renameSync(staging, path);
        // POSIX directory fsync commits the new name before the ledger can
        // reference it. Windows directory handles need a native implementation;
        // file fsync still completes there, and NTFS crash durability needs live QA.
        if (process.platform !== "win32") {
          const directory = openSync(this.root, "r");
          try {
            fsyncSync(directory);
          } finally {
            closeSync(directory);
          }
        }
      } finally {
        if (existsSync(staging)) unlinkSync(staging);
      }
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== input.bytes.byteLength)
      throw new TaskError(
        "INTEGRITY",
        "Stored artifact is not the expected regular file",
      );
    const actual = readFileSync(path);
    if (
      actual.byteLength !== input.bytes.byteLength ||
      createHash("sha256").update(actual).digest("hex") !== digest
    )
      throw new TaskError("INTEGRITY", "Stored artifact mismatch");
    const artifactId = createHash("sha256").update(commandId).digest("hex");
    return this.ledger.registerArtifact(commandId, {
      artifactId,
      taskId: input.taskId,
      name: input.name,
      mediaType: input.mediaType,
      uri: path,
      sha256: digest,
      bytes: actual.byteLength,
      finalized: true,
    }).value;
  }
}
