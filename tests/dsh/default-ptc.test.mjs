import { ExecutionModelInventory } from "../../packages/task-system/dist/executor-models.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TaskLedger } from "../../packages/task-system/dist/ledger.js";
import {
  RemoteGateway,
  RemoteClient,
  RemoteLedgerClient,
  RecoveryStore,
  ExecutorWorker,
  TrustedNetworkVerifier,
  nativeExecutionAdapter,
  httpHandler,
} from "../../packages/task-system/dist/remote/api.js";
import { ScriptedModel } from "./scripted-model.mjs";

const runtime = process.env.DSH_OFFICIAL_ROOT;

test(
  "official rc2 PTC preset executes inherited host tools and task settlement",
  { skip: !runtime, timeout: 30000 },
  async () => {
    const req = createRequire(join(runtime, "package.json"));
    const url = (name) => pathToFileURL(req.resolve(name)).href;
    const { load } = await import(url("js-yaml"));
    const { entryListSchema } = await import(
      url("@deepseek-ai/cordis-plugin-include")
    );
    const patch = load(
      readFileSync(
        req.resolve("@deepseek-ai/dsh-web-app/presets/ptc.patch.yml"),
        "utf8",
      ),
      { schema: entryListSchema },
    );
    const preset = patch[0].insert[0];
    const mapRows = (rows) =>
      rows.map((row) => ({
        ...row,
        name: row.name === "cordis:group" ? row.name : url(row.name),
        ...(row.group ? { config: mapRows(row.config) } : {}),
      }));
    preset.name = url(preset.name);
    preset.config.plugins = mapRows(preset.config.plugins);
    const { Context } = await import(url("@deepseek-ai/cordis"));
    const { Loader, ModuleLoader } = await import(
      url("@deepseek-ai/cordis-plugin-loader")
    );
    const dir = mkdtempSync(join(tmpdir(), "dsh-official-ptc-"));
    const stage = join(dir, "task-package");
    mkdirSync(stage);
    cpSync(resolve("packages/task-system/dist"), join(stage, "dist"), {
      recursive: true,
    });
    cpSync(
      resolve("packages/task-system/package.json"),
      join(stage, "package.json"),
    );
    const stageModules = join(stage, "node_modules");
    mkdirSync(stageModules);
    for (const name of readdirSync(join(runtime, "node_modules")))
      symlinkSync(
        join(runtime, "node_modules", name),
        join(stageModules, name),
        "dir",
      );
    for (const name of ["cron-parser", "ajv", "markdown-it", "zod", "yaml"]) {
      if (!existsSync(join(stageModules, name)))
        symlinkSync(
          resolve("node_modules", name),
          join(stageModules, name),
          "dir",
        );
    }
    const ctx = new Context();
    await ctx.plugin(Loader, {
      baseUrl: pathToFileURL(join(runtime, "package.json")).href,
    });
    ctx.loader.internal = ModuleLoader.fromInternal();
    ctx.loader.builtins.group = await import(
      url("@deepseek-ai/cordis-plugin-group")
    );
    const adapter = new ScriptedModel([]);
    adapter.listModels=async()=>[{provider:"test-offline",id:"script",name:"Scripted fixture"}];
    await ctx.loader.root.update(
      [
        ["llm", "@deepseek-ai/dsh-llm"],
        ["sessions", "@deepseek-ai/dsh-session"],
        ["projections", "@deepseek-ai/dsh-session-projection"],
        ["prompt", "@deepseek-ai/dsh-system-prompt"],
        ["tools", "@deepseek-ai/dsh-tools"],
        ["agents", "@deepseek-ai/dsh-agent"],
        [
          "persistence",
          "@deepseek-ai/dsh-session-persistence-jsonl",
          { root: join(dir, "sessions"), compression: "none" },
        ],
        ["loop", "@deepseek-ai/dsh-agent-loop", { agents: [] }],
      ].map(([id, name, config]) => ({ id, name: url(name), config })),
    );
    await ctx.loader.create({
      id: "task",
      name: pathToFileURL(join(stage, "dist/dsh-plugin.js")).href,
      config: {
        nodeId: "local",
        databasePath: join(dir, "task.sqlite"),
        keepAlive: false,
        schedulerEnabled: false,
      },
    });
    await ctx.loader.await();
    assert.ok(
      ctx.taskSystem,
      JSON.stringify(
        ctx.logger.buffer.map((entry) =>
          entry.args.map((value) =>
            value instanceof Error ? value.message : value,
          ),
        ),
      ),
    );
    ctx.llm.registerAdapter(["test-offline"], adapter);
    const h = {
      ctx,
      dir,
      adapter,
      ledger: ctx.taskSystem.ledger,
      async dispose() {
        await ctx.fiber.dispose();
        rmSync(dir, { recursive: true, force: true });
      },
    };
    try {
      const services = [
        ["fs", "@deepseek-ai/dsh-fs-local", { cwd: h.dir }],
        [
          "working-directory",
          "@deepseek-ai/dsh-working-directory",
          { defaultDirectory: h.dir },
        ],
        ["sandbox", "@deepseek-ai/dsh-sandbox-local"],
        [
          "sandbox-policy",
          "@deepseek-ai/dsh-sandbox-policy",
          { mode: "danger-full-access", workspaceRoot: h.dir },
        ],
        ["subprocess", "@deepseek-ai/dsh-subprocess-local"],
        ["ptc-runtime", "@deepseek-ai/dsh-ptc-runtime-node"],
        [
          "presets",
          "@deepseek-ai/dsh-agent-preset-registry",
          { default: "standard" },
        ],
        [
          "model-selection-settings",
          "@deepseek-ai/dsh-tool-subagent/model-selection-settings",
        ],
        ...[
          "dsh-shell-env",
          "dsh-bash-sandbox",
          "dsh-jobs-local",
          "dsh-skill",
          "dsh-commands",
          "dsh-goal",
          "dsh-user-questions",
          "dsh-web",
          "dsh-token-meter",
          "dsh-subagent",
        ].map((name) => [name, "@deepseek-ai/" + name]),
      ];
      for (const [id, name, config] of services)
        await h.ctx.loader.create({ id, name: url(name), config });
      await h.ctx.loader.create(preset);
      await h.ctx.loader.await();
      assert.equal((await h.ctx.agentPresets.resolve("ptc")).broken, undefined);
      h.ledger.registerNode("fixture-node", {
        nodeId: "local",
        roles: ["both"],
        capabilities: [],
        models: [
          { provider: "test-offline", model: "script", reasoningEfforts: [] },
        ],
        workspaceIds: ["root"],
        enabled: true,
      });
      h.ledger.registerWorkspace("fixture-workspace", {
        workspaceId: "root",
        nodeId: "local",
        path: dir,
        label: "Fixture",
        state: "ready",
        createdAt: new Date().toISOString(),
      });
      let serial = 0;
      const execute = async (code, policy) => {
        const id = `fixture-${serial++}`;
        const task = h.ledger.createTask(`${id}-task`, {
          title: "Isolated PTC fixture",
          workspaceId: "root",
          ...(policy ? { policy } : {}),
        }).value;
        const run = h.ledger.createRun(`${id}-run`, {
          taskId: task.taskId,
          route: {
            nodeId: "local",
            workspaceId: "root",
            provider: "test-offline",
            model: "script",
            requiredCapabilities: [],
          },
        }).value;
        const claim = h.ledger.claim(`${id}-claim`, {
          runId: run.runId,
          nodeId: "local",
          ttlMs: 10000,
        }).value;
        h.adapter.script.push({
          name: "run_code",
          args: { description: "Run the isolated fixture", code },
        });
        const result = await h.ctx.taskSystem.native.execute(claim);
        assert.equal(result.run.state, "succeeded", JSON.stringify(result));
        assert.deepEqual(
          h.adapter.requests.at(-1).tools.map((tool) => tool.name),
          ["run_code"],
        );
        const session = await h.ctx.sessionPersistence.open(
          result.sessionId,
          "read",
        );
        try {
          assert.equal(session.header.agentPreset, "ptc");
        } finally {
          await session.close();
        }
        return result;
      };
      await execute(`
      await tools.write({file_path:"ptc.txt",content:"real PTC file"});
      const read = await tools.read({file_path:"ptc.txt"});
      if (!JSON.stringify(read).includes("real PTC file")) throw new Error("read verification failed");
      await tools.task_submit_result({outcome:"success",summary:"PTC wrote and read the file"});
    `);
      assert.equal(readFileSync(join(dir, "ptc.txt"), "utf8"), "real PTC file");
      await execute(
        `
      if ("write" in tools || "bash" in tools) throw new Error("task policy widened");
      await tools.read({file_path:"ptc.txt"});
      await tools.task_submit_result({outcome:"success",summary:"Task policy retained"});
    `,
        { allowedTools: ["read"] },
      );
      const removeGuard = h.ctx.tools.guard((exec) =>
        exec.name === "write"
          ? "Explicit host policy denies writes"
          : undefined,
      );
      await execute(`
      let denied = false;
      try { await tools.write({file_path:"denied.txt",content:"must not exist"}); }
      catch (error) { denied = true; }
      if (!denied) throw new Error("host guard bypassed");
      await tools.read({file_path:"ptc.txt"});
      await tools.task_submit_result({outcome:"success",summary:"Host guard retained"});
    `);
      removeGuard();
      assert.equal(existsSync(join(dir, "denied.txt")), false);
      h.ctx.taskSystem.config.executionTools = ["read"];
      await execute(`
      if ("write" in tools || "bash" in tools) throw new Error("host executionTools widened");
      await tools.read({file_path:"ptc.txt"});
      await tools.task_submit_result({outcome:"success",summary:"Host tool list retained"});
    `);
      h.ctx.taskSystem.config.executionTools = null;
      const planner = TaskLedger.open(join(dir, "planner.sqlite"), {
        role: "planner",
        nodeId: "planner",
      });
      const stores = ["gateway", "client", "worker"].map(
        (name) => new RecoveryStore(join(dir, `${name}.sqlite`)),
      );
      let handler;
      const server = createServer((req, res) => {
        void handler(req, res);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = server.address().port;
      const network = {
        listen: { address: "127.0.0.1", port },
        allowHttp: true,
        allowedAddresses: ["127.0.0.1"],
        peers: [
          {
            address: "127.0.0.1",
            nodeId: "",
            role: "executor",
            audience: "planner",
            operations: [],
            workspaces: [],
            capabilities: [],
          },
        ],
      };
      const gateway = new RemoteGateway({
        role: "planner",
        nodeId: "planner",
        ledger: planner,
        store: stores[0],
        verifier: new TrustedNetworkVerifier({
          ...network,
          audience: "planner",
          pairings: stores[0],
        }),
      });
      handler = httpHandler(gateway, { trustedNetwork: network });
      const client = new RemoteClient({
        endpoint: `http://127.0.0.1:${port}/commands`,
        nodeId: "local",
        audience: "planner",
        authMode: "trusted-network",
        trustedNetwork: {
          address: "127.0.0.1",
          port,
          localAddress: "127.0.0.1",
          allowHttp: true,
        },
        store: stores[1],
      });
      let worker;
      try {
        await client.executorIdentity();
        assert.equal(stores[0].networkPairings()[0].nodeId, "local");
        const remote = new RemoteLedgerClient(client, "local");
        await client.send(
          "heartbeat",
          "actual-catalog",
          {
            sampledAt: Date.now(),
            runtimeReady: true,
            activeExecutions: 0,
            providerStatus: {
              state: "ready",
              providers: [{ provider: "test-offline", state: "ready" }],
            },
          },
          { diagnostic: true },
        );
        assert.deepEqual(planner.getNode("local").models, [], "heartbeat does not publish model directories");
        planner.executionModels.request("ptc-catalog-request",{nodeId:"local"});
        const [inquiry]=await remote.executionModelRequests("local");
        const inventory=new ExecutionModelInventory({llm:()=>ctx.llm,nativeReady:()=>!!ctx.taskSystem.native,officialBackends:()=>[],officialAvailable:()=>false});
        const result=await inventory.collect();
        assert.equal(result.state,"success");
        await remote.completeExecutionModels("ptc-directory-publication",{nodeId:"local",requestId:inquiry.requestId,generation:inquiry.generation,result});
        assert.deepEqual(planner.getNode("local").models, [
          { provider: "test-offline", model: "script", reasoningEfforts: [] },
        ]);
        planner.registerWorkspace("remote-workspace", {
          workspaceId: "root",
          nodeId: "local",
          path: dir,
          label: "Fixture",
          state: "ready",
          createdAt: new Date().toISOString(),
        });
        planner.registerNode("grant-workspace", {
          ...planner.getNode("local"),
          workspaceIds: ["root"],
        });
        const task = planner.createTask("remote-task", {
          title: "Authenticated real PTC task",
          workspaceId: "root",
        }).value;
        const run = planner.createRun("remote-run", {
          taskId: task.taskId,
          route: {
            nodeId: "local",
            workspaceId: "root",
            provider: "test-offline",
            model: "script",
            requiredCapabilities: [],
          },
        }).value;
        h.adapter.script.push({
          name: "run_code",
          args: {
            description: "Settle the authenticated isolated task",
            code: 'await tools.task_submit_result({outcome:"success",summary:"Authenticated paired executor ran real PTC"});',
          },
        });
        worker = new ExecutorWorker({
          ledger: remote,
          provider: nativeExecutionAdapter(h.ctx.taskSystem.native, {
            provider: "test-offline",
            models: [{ model: "script", reasoningEfforts: [] }],
            capabilities: [],
          }),
          store: stores[2],
          policy: {
            role: "executor",
            nodeId: "local",
            capabilities: [],
            workspaces: [
              {
                workspaceId: "root",
                nodeId: "local",
                path: dir,
                allowedRoot: dir,
              },
            ],
          },
        });
        const results = await worker.pollOnce(1);
        assert.equal(
          results[0].value.state,
          "acknowledged",
          JSON.stringify(results),
        );
        assert.equal(planner.getRun(run.runId).state, "succeeded");
        assert.deepEqual(
          h.adapter.requests.at(-1).tools.map((tool) => tool.name),
          ["run_code"],
        );
      } finally {
        await worker?.dispose();
        await client.dispose();
        await new Promise((resolve) => server.close(resolve));
        stores.forEach((store) => store.close());
        planner.close();
      }
    } finally {
      await h.dispose();
    }
  },
);
