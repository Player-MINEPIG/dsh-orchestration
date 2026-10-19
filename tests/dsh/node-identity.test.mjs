import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";

async function host(profileDir, databasePath, extra = {}) {
  const ctx = new Context();
  ctx.provide("profileContext", { dir: profileDir });
  await ctx.plugin(Loader, {
    baseUrl: pathToFileURL(resolve("package.json")).href,
  });
  await ctx.loader.root.update([
    { id: "llm", name: "@deepseek-ai/dsh-llm" },
    { id: "sessions", name: "@deepseek-ai/dsh-session" },
    { id: "prompt", name: "@deepseek-ai/dsh-system-prompt" },
    { id: "tools", name: "@deepseek-ai/dsh-tools" },
    {
      id: "task",
      name: pathToFileURL(resolve("packages/task-system/dist/dsh-plugin.js"))
        .href,
      config: {
        databasePath,
        role: "both",
        localNode: {
          models: [],
          capabilities: [],
          workspaceIds: [],
          enabled: true,
        },
        keepAlive: false,
        schedulerEnabled: false,
        ...extra,
      },
    },
  ]);
  await ctx.loader.await();
  assert.ok(ctx.taskSystem);
  return ctx;
}

test("resolved service, ledger and bootstrap use the same persistent profile identity", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-node-profile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profile = join(dir, "profile");
  const first = await host(profile, join(dir, "first.sqlite"));
  let nodeId;
  try {
    nodeId = first.taskSystem.config.nodeId;
    assert.match(nodeId, /^node-/);
    assert.equal(first.taskSystem.ledger.nodeId, nodeId);
    assert.equal(first.taskSystem.ledger.getNode(nodeId).nodeId, nodeId);
  } finally {
    await first.fiber.dispose();
  }
  const second = await host(profile, join(dir, "second.sqlite"));
  try {
    assert.equal(second.taskSystem.config.nodeId, nodeId);
  } finally {
    await second.fiber.dispose();
  }
  const independent = await host(
    join(dir, "other-profile"),
    join(dir, "other.sqlite"),
  );
  try {
    assert.notEqual(independent.taskSystem.config.nodeId, nodeId);
  } finally {
    await independent.fiber.dispose();
  }
});

test("upgrade with omitted nodeId persists the existing local identity", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-node-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "tasks.sqlite");
  const old = await host(dir, database, { nodeId: "local" });
  await old.fiber.dispose();
  const upgraded = await host(dir, database);
  try {
    assert.equal(upgraded.taskSystem.config.nodeId, "local");
    assert.equal(upgraded.taskSystem.ledger.nodeId, "local");
    assert.equal(
      existsSync(join(dir, "task-system", "device-identity.json")),
      true,
    );
  } finally {
    await upgraded.fiber.dispose();
  }
});

test("live capacity overrides reach dynamically paired ledger nodes without raw remoteNodes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-node-capacity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = await host(dir, join(dir, "tasks.sqlite"), {
    nodeId: "planner",
    nodeCapacityOverrides: { dynamic: 7, planner: 9 },
  });
  try {
    const service = ctx.taskSystem;
    service.ledger.registerNode("dynamic-node", {
      nodeId: "dynamic",
      roles: ["executor"],
      capabilities: [],
      models: [],
      workspaceIds: [],
      enabled: true,
      maxConcurrent: 2,
    });
    assert.deepEqual(service.config.remoteNodes, []);
    const plannerCapacity = service.ledger.getNode("planner").maxConcurrent;
    service.applyLiveNodeCapacities();
    assert.equal(service.ledger.getNode("dynamic").maxConcurrent, 7);
    assert.equal(
      service.ledger.getNode("planner").maxConcurrent,
      plannerCapacity,
    );
    assert.deepEqual(service.config.remoteNodes, []);
  } finally {
    await ctx.fiber.dispose();
  }
});
