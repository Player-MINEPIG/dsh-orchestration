import test from "node:test";
import assert from "node:assert/strict";
import { TaskLedger } from "../dist/ledger.js";
import { TaskPluginSettings } from "../dist/settings.js";

test("official workspace metadata is joined only to this executor's existing registered/granted workspaces", async (t) => {
  const ledger = TaskLedger.open(":memory:");
  t.after(() => ledger.close());
  const now = new Date().toISOString();
  for (const [workspaceId, nodeId, path] of [
    ["one", "local", "/projects/one"],
    ["two", "local", "/projects/two"],
    ["missing", "local", "/projects/missing"],
    ["other", "remote", "/remote/project"],
  ])
    ledger.registerWorkspace("w-" + workspaceId, {
      workspaceId,
      nodeId,
      path,
      label: "Ledger name",
      state: "ready",
      createdAt: now,
    });
  ledger.registerNode("node", {
    nodeId: "local",
    roles: ["executor"],
    models: [],
    capabilities: [],
    workspaceIds: ["one", "two", "missing"],
    enabled: true,
    lastSeenAt: now,
  });
  const raw = {
    role: "executor",
    defaultWorkspaceId: "one",
    planningDecisionEnabled: true,
    sessionDecisionEnabled: false,
    nodeId: "local",
  };
  const task = { ledger, config: raw };
  const records = ["one", "two", "missing"].map((id) => ({
    path: "/projects/" + id,
    title: "Project",
    status: async () => (id === "missing" ? "missing-dir" : "ok"),
    get sessionIds() {
      throw Error("session membership must not be read");
    },
  }));
  let registry = { list: () => records };
  const ctx = {
    get: (key) =>
      ({
        taskSystem: task,
        configEditor: {
          entries: () => [
            {
              options: {
                id: "task-system",
                name: "@dsh-task/task-system/plugin",
                config: raw,
              },
            },
          ],
        },
        workspaceRegistry: registry,
      })[key],
  };
  ledger.snapshot = () => {
    throw Error("full ledger/task/session snapshot must not be read");
  };
  const read = () => TaskPluginSettings.prototype.workspaces.call({ ctx });
  const view = await read();
  assert.equal(view.source, "official");
  assert.equal(view.scope.nodeId, "local");
  assert.deepEqual(
    view.items.map((item) => item.workspaceId),
    ["one", "two", "missing"],
  );
  assert.deepEqual(
    view.items.map((item) => item.title),
    ["Project", "Project", "Project"],
  );
  assert.equal(view.items[2].available, false);
  assert.ok(!JSON.stringify(view).includes("remote/project"));
  assert.ok(!JSON.stringify(view).includes("sessionIds"));
  registry = {
    list() {
      throw Error("registry temporarily unavailable");
    },
  };
  await assert.rejects(read(), /temporarily unavailable/);
  registry = undefined;
  const fallback = await read();
  assert.equal(fallback.source, "task");
  assert.equal(fallback.items[0].title, "Ledger name");
});

test("missing labels, name-only descriptors and missing paths retain Task identity with readable titles", async (t) => {
  const ledger = TaskLedger.open(":memory:");
  t.after(() => ledger.close());
  const paths = {
    one: "/projects/one",
    two: "/projects/two",
    sparse: "/projects/sparse",
    missing: "/projects/missing",
    root: "/",
  };
  const now = new Date().toISOString();
  for (const [workspaceId, path] of Object.entries(paths))
    ledger.registerWorkspace(`register-${workspaceId}`, {
      workspaceId,
      path,
      nodeId: "local",
      state: "ready",
      createdAt: now,
    });
  ledger.registerNode("node", {
    nodeId: "local",
    roles: ["executor"],
    models: [],
    capabilities: [],
    workspaceIds: Object.keys(paths),
    enabled: true,
    lastSeenAt: now,
  });
  const config = { nodeId: "local", role: "executor" };
  const entries = [
    {
      options: {
        id: "task-system",
        name: "@dsh-task/task-system/plugin",
        config,
      },
    },
  ];
  let resolves = 0;
  const registry = {
    list: () => [
      {
        path: paths.one,
        name: "Same name",
        get id() {
          throw Error("Do not substitute official IDs");
        },
      },
      { path: paths.two, title: "Same name" },
      { name: "Descriptor without a path" },
      { path: paths.root, title: "   " },
    ],
    resolveByPath: async (path) => {
      resolves++;
      if (path === paths.missing)
        throw Object.assign(Error("Missing directory"), { code: "ENOENT" });
      if (path === paths.sparse)
        return { name: "Resolved public name", status: async () => "ok" };
    },
  };
  const before = ledger.registeredWorkspaces("local");
  const ctx = {
    get: (key) =>
      ({
        taskSystem: { config, ledger },
        configEditor: { entries: () => entries },
        workspaceRegistry: registry,
      })[key],
  };
  const view = await TaskPluginSettings.prototype.workspaces.call({ ctx });
  const items = new Map(view.items.map((item) => [item.workspaceId, item]));
  assert.equal(items.get("one").title, "Same name");
  assert.equal(items.get("two").title, "Same name");
  assert.notEqual(items.get("one").path, items.get("two").path);
  assert.equal(items.get("sparse").title, "Resolved public name");
  assert.equal(items.get("missing").title, "missing");
  assert.equal(items.get("missing").available, false);
  assert.equal(items.get("root").title, "未命名");
  assert.equal(resolves, 2);
  assert.deepEqual(ledger.registeredWorkspaces("local"), before);
  const fallback = await TaskPluginSettings.prototype.workspaces.call({
    ctx: {
      get: (key) => (key === "workspaceRegistry" ? undefined : ctx.get(key)),
    },
  });
  assert.equal(
    fallback.items.find((item) => item.workspaceId === "one").title,
    "one",
  );
  assert.equal(
    fallback.items.find((item) => item.workspaceId === "root").title,
    "未命名",
  );
});
