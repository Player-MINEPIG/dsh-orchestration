import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { SessionId } from "@deepseek-ai/dsh-session";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixture } from "./fixtures/registration.mjs";
import { ScriptedModel } from "../../../tests/dsh/scripted-model.mjs";
import { Workbench } from "../dist/workbench.js";
import { TaskLedger } from "../dist/ledger.js";
import {
  createRegistrationServer,
  bearerNamespaceAuthorizer,
} from "../dist/project-registration/http.js";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
async function harness(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "registration-command-")),
    ctx = new Context();
  await ctx.plugin(Loader, {
    baseUrl: pathToFileURL(resolve(repoRoot, "package.json")).href,
  });
  await ctx.loader.root.update([
    { id: "llm", name: "@deepseek-ai/dsh-llm" },
    { id: "sessions", name: "@deepseek-ai/dsh-session" },
    { id: "projection", name: "@deepseek-ai/dsh-session-projection" },
    { id: "prompt", name: "@deepseek-ai/dsh-system-prompt" },
    { id: "tools", name: "@deepseek-ai/dsh-tools" },
    { id: "agents", name: "@deepseek-ai/dsh-agent" },
    {
      id: "agent-loop",
      name: "@deepseek-ai/dsh-agent-loop",
      config: { agents: [] },
    },
    { id: "commands", name: "@deepseek-ai/dsh-commands" },
    {
      id: "task",
      name: pathToFileURL(
        resolve(repoRoot, "packages/task-system/dist/dsh-plugin.js"),
      ).href,
      config: {
        databasePath: join(dir, "central.sqlite"),
        role: "planner",
        keepAlive: false,
        schedulerEnabled: false,
        autoExecute: false,
      },
    },
    {
      id: "registration",
      name: pathToFileURL(
        resolve(
          repoRoot,
          "packages/task-system/dist/project-registration/plugin.js",
        ),
      ).href,
      config: { namespaces: ["fixture/local"], ...config },
    },
  ]);
  await ctx.loader.await();
  const model = new ScriptedModel([]);
  ctx.llm.registerAdapter(["command-test"], model);
  const handle = await ctx.agents.create({
    sessionId: SessionId("local-project-command"),
    meta: { cwd: dir },
    agentOptions: { provider: "command-test", model: "unused" },
  });
  mkdirSync(join(dir, ".dsh"));
  return {
    ctx,
    dir,
    model,
    handle,
    packet: join(dir, ".dsh/project-registration.json"),
    invoke: async (line) => {
      const result = await ctx.commands.execute(
        handle.agent,
        line,
        [],
        new AbortController().signal,
      );
      assert.ok(result, "official registry resolves project command");
      return result.result;
    },
    close: async () => {
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("official DSH slash registry reads current workspace, previews/registers/syncs/submits/history without model turns", async () => {
  const h = await harness();
  try {
    assert.ok(
      h.ctx.commands.list(h.handle.agent).some((c) => c.name === "project"),
    );
    const p = fixture();
    writeFileSync(h.packet, JSON.stringify(p));
    assert.equal((await h.invoke("/project preview")).kind, "success");
    assert.equal(
      h.ctx.taskSystem.ledger.snapshot().projectRegistrations.length,
      0,
    );
    assert.equal((await h.invoke("/project register")).kind, "success");
    const p2 = { ...p, revision: 2, previousRevision: 1, idempotencyKey: "r2" };
    writeFileSync(h.packet, JSON.stringify(p2));
    assert.equal((await h.invoke("/project sync")).kind, "success");
    const p3 = {
      ...p2,
      revision: 3,
      previousRevision: 2,
      idempotencyKey: "r3",
      mode: "final",
      project: { ...p.project, state: "completed" },
    };
    writeFileSync(h.packet, JSON.stringify(p3));
    assert.equal((await h.invoke("/project submit")).kind, "success");
    const historical = {
      ...p,
      projectExternalId: "old-local",
      mode: "history",
      project: { ...p.project, state: "completed" },
    };
    const file = join(h.dir, "historical project.json");
    writeFileSync(file, JSON.stringify(historical));
    assert.equal(
      (await h.invoke("/project history " + JSON.stringify(file))).kind,
      "success",
    );
    assert.equal(
      new Workbench(h.ctx.taskSystem.ledger).snapshot().projects.length,
      2,
    );
    assert.equal(h.model.requests.length, 0);
    const events = h.handle.agent.session.snapshotEvents();
    assert.equal(events.filter((e) => e.type === "command/run").length, 5);
    assert.equal(events.filter((e) => e.type === "command/done").length, 5);
    assert.equal(
      events.filter((e) => e.type === "turn/start" || e.type === "user/message")
        .length,
      0,
    );
    assert.equal((await h.invoke("/project status extra")).kind, "error");
  } finally {
    await h.close();
  }
});
test("official command reports durable pending then trusted-network sync acknowledges identical packet over bound direct socket", async () => {
  const central = TaskLedger.open(":memory:"),
    token = "fixture-test-only-registration-token";
  const server = createRegistrationServer({
    ledger: central,
    authorize: bearerNamespaceAuthorizer(token, ["fixture/local"]),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const outbox = mkdtempSync(join(tmpdir(), "command-outbox-"));
  process.env.DSH_COMMAND_TEST_TOKEN = token;
  const h = await harness({
    outboxPath: outbox,
    endpoint: `http://127.0.0.1:${port}/v1/registrations`,
    tokenEnv: "DSH_COMMAND_TEST_TOKEN",
    trustedNetwork: {
      address: "127.0.0.1",
      localAddress: "127.0.0.1",
      port,
      allowHttp: true,
    },
  });
  try {
    await new Promise((r) => server.close(r));
    writeFileSync(h.packet, JSON.stringify(fixture()));
    const pending = await h.invoke("/project register");
    assert.equal(pending.kind, "success");
    assert.match(pending.text, /中央尚未确认/);
    const status = JSON.parse((await h.invoke("/project status")).text);
    assert.equal(status.pending.length, 1);
    assert.equal(status.acknowledged.length, 0);
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const sent = await h.invoke("/project sync");
    assert.equal(sent.kind, "success");
    assert.match(sent.text, /中央已确认/);
    assert.equal(central.snapshot().projectRegistrations.length, 1);
    assert.equal(
      h.ctx.taskSystem.ledger.snapshot().projectRegistrations.length,
      0,
    );
    const done = JSON.parse((await h.invoke("/project status")).text);
    assert.equal(done.pending.length, 0);
    assert.equal(done.acknowledged.length, 1);
    assert.equal(h.model.requests.length, 0);
  } finally {
    delete process.env.DSH_COMMAND_TEST_TOKEN;
    await h.close();
    if (server.listening) await new Promise((r) => server.close(r));
    central.close();
    rmSync(outbox, { recursive: true, force: true });
  }
});
