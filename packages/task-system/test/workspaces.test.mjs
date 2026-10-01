import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger, WorkspaceManager, ArtifactStore } from "../dist/index.js";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-workspace-"));
  const root = join(dir, "allowed");
  mkdirSync(root);
  const ledger = TaskLedger.open(join(dir, "db"));
  const manager = new WorkspaceManager(ledger, "worker", [
    { id: "main", path: root, allowCreate: true },
  ]);
  return {
    dir,
    root,
    ledger,
    manager,
    close() {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("physical project creation and replay preserve identity; reuse never overwrites existing content", () => {
  const f = setup();
  try {
    const request = {
      workspaceId: "project",
      rootId: "main",
      relativePath: "new-project",
      label: "New project",
      mode: "create",
    };
    const a = f.manager.provision("create", request);
    assert.equal(a.state, "ready");
    assert.equal(a.path, join(f.root, "new-project"));
    assert.deepEqual(f.manager.provision("create", request), a);
    assert.throws(
      () =>
        f.manager.provision("different", { ...request, workspaceId: "second" }),
      (e) => e.code === "WORKSPACE_POLICY",
    );
    const reuse = f.manager.provision("reuse", {
      ...request,
      workspaceId: "reused",
      mode: "reuse",
    });
    assert.equal(reuse.path, a.path);
  } finally {
    f.close();
  }
});
test("workspace policy rejects traversal, symlinks and denied roots", () => {
  const f = setup();
  try {
    for (const relativePath of ["../escape", "/absolute", "a/../b"])
      assert.throws(
        () =>
          f.manager.provision("bad-" + relativePath.length, {
            workspaceId: "bad",
            rootId: "main",
            relativePath,
            label: "bad",
            mode: "create",
          }),
        (e) => e.code === "WORKSPACE_POLICY",
      );
    mkdirSync(join(f.dir, "outside"));
    symlinkSync(join(f.dir, "outside"), join(f.root, "link"));
    assert.throws(
      () =>
        f.manager.provision("link", {
          workspaceId: "link",
          rootId: "main",
          relativePath: "link/child",
          label: "bad",
          mode: "create",
        }),
      (e) => e.code === "WORKSPACE_POLICY",
    );
  } finally {
    f.close();
  }
});
test("artifact bytes have immutable digest and idempotent registration; equal bytes keep distinct artifact identities", () => {
  const f = setup();
  try {
    const task = f.ledger.createTask("task", { title: "Artifact work" }).value;
    const store = new ArtifactStore(f.ledger, join(f.dir, "artifacts"));
    const input = {
      taskId: task.taskId,
      name: "report.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("hello"),
    };
    const a = store.put("artifact-a", input);
    assert.deepEqual(store.put("artifact-a", input), a);
    const b = store.put("artifact-b", input);
    assert.notEqual(a.artifactId, b.artifactId);
    assert.equal(a.sha256, b.sha256);
    assert.equal(readFileSync(a.uri, "utf8"), "hello");
    assert.throws(
      () =>
        store.put("artifact-a", { ...input, bytes: Buffer.from("different") }),
      (e) => e.code === "CONFLICT",
    );
  } finally {
    f.close();
  }
});
