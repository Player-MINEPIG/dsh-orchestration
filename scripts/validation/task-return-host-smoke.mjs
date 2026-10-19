import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { createServer } from "node:http";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { hostname } from "node:os";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string" },
    dir: { type: "string" },
    port: { type: "string", default: "0" },
    endpoint: { type: "string" },
    "key-file": { type: "string" },
    marker: { type: "string", default: "DSH-PHYSICAL-RETURN-SMOKE" },
    "delay-ms": { type: "string", default: "4000" },
    "expected-version": { type: "string", default: "0.2.40" },
    "task-package": { type: "string" },
    "runtime-entry": { type: "string" },
    "real-coordinator": { type: "boolean", default: false },
    "provider-config": { type: "string" },
    "credentials-file": { type: "string" },
    "env-file": { type: "string" },
    "real-provider": { type: "string", default: "magpie" },
    "real-model": { type: "string", default: "deepseek/deepseek-flash" },
    "allow-same-host": { type: "boolean", default: false },
  },
});
const mode = positionals[0];
assert.ok(
  ["coordinator", "executor"].includes(mode),
  "Choose coordinator or executor",
);
assert.ok(values.profile && values.dir, "--profile and --dir are required");
const dir = resolve(values.dir);
mkdirSync(dir, { recursive: true, mode: 0o700 });
assert.equal(
  existsSync(join(dir, "task.sqlite")),
  false,
  "Use a fresh isolated run directory",
);
const profile = resolve(values.profile),
  profileRequire = createRequire(profile);
const require = values["runtime-entry"]
  ? createRequire(realpathSync(values["runtime-entry"]))
  : profileRequire;
if (values["runtime-entry"]) {
  let resolvingCore = false;
  registerHooks({
    resolve(specifier, context, next) {
      if (!resolvingCore && specifier.startsWith("@deepseek-ai/")) {
        let target;
        try {
          resolvingCore = true;
          target = require.resolve(specifier);
        } catch (error) {
          if (error.code !== "MODULE_NOT_FOUND") throw error;
        } finally {
          resolvingCore = false;
        }
        if (target) return next(target, context);
      }
      return next(specifier, context);
    },
  });
}
const load = (specifier) => import(pathToFileURL(require.resolve(specifier)));
const [
  { Context },
  { Loader },
  { LlmAdapter, createUserMessage, ToolCallId },
  { SessionId },
] = await Promise.all([
  load("@deepseek-ai/cordis"),
  load("@deepseek-ai/cordis-plugin-loader"),
  load("@deepseek-ai/dsh-llm"),
  load("@deepseek-ai/dsh-session"),
]);
const taskEntry = values["task-package"]
  ? join(resolve(values["task-package"]), "dist/dsh-plugin.js")
  : profileRequire.resolve("@dsh-task/task-system/plugin");
const taskRoot = dirname(dirname(taskEntry)),
  taskInfo = JSON.parse(readFileSync(join(taskRoot, "package.json"), "utf8"));
assert.equal(
  taskInfo.version,
  values["expected-version"],
  "Installed package must match the release being verified",
);
const remote = await import(
  pathToFileURL(join(taskRoot, "dist/remote/api.js"))
);
const write = (name, value) =>
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [];
class ScriptedModel extends LlmAdapter {
  constructor(script) {
    super();
    this.script = [...script];
    this.requests = [];
  }
  async listModels(provider) {
    return [
      {
        provider,
        id: "script",
        name: "Explicit external LLM test replacement",
      },
    ];
  }
  async *stream(options) {
    this.requests.push(options);
    let entry = this.script.shift();
    if (typeof entry === "function") entry = await entry(options);
    if (entry && typeof entry === "object") {
      const call = {
        type: "tool-call",
        id: `smoke-${this.requests.length}`,
        name: entry.name,
        arguments: JSON.stringify(entry.args),
      };
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: call.id,
        name: call.name,
        argumentsDelta: call.arguments,
      };
      yield { type: "block-end", index: 0, block: call };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    } else {
      const text = entry ?? "Scripted smoke complete";
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
}
async function harness(role, nodeId, script = []) {
  const ctx = new Context();
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(profile).href });
  await ctx.loader.root.update(
    [
      ["llm", "@deepseek-ai/dsh-llm"],
      ["sessions", "@deepseek-ai/dsh-session"],
      ["sessionProjections", "@deepseek-ai/dsh-session-projection"],
      ["systemPrompt", "@deepseek-ai/dsh-system-prompt"],
      ["tools", "@deepseek-ai/dsh-tools"],
      ["agents", "@deepseek-ai/dsh-agent"],
      [
        "persistence",
        "@deepseek-ai/dsh-session-persistence-jsonl",
        { root: join(dir, "sessions"), compression: "none" },
      ],
      ["agentLoop", "@deepseek-ai/dsh-agent-loop", { agents: [] }],
      [
        "task",
        pathToFileURL(taskEntry).href,
        {
          role,
          nodeId,
          databasePath: join(dir, "task.sqlite"),
          keepAlive: false,
          leaseTtlMs: 15000,
          autoExecute: false,
          planningDecisionEnabled: false,
          sessionDecisionEnabled: false,
          executionTools: [],
          projectAgentOptions: { provider: "smoke-script", model: "script" },
        },
      ],
    ].map(([id, name, config]) => ({
      id,
      name: name.startsWith("@deepseek-ai/")
        ? pathToFileURL(require.resolve(name)).href
        : name,
      config,
    })),
  );
  await ctx.loader.await();
  assert.ok(ctx.taskSystem, "Installed task-system must mount");
  const adapter = new ScriptedModel(script);
  ctx.llm.registerAdapter(["smoke-script"], adapter);
  ctx.on("session/event", (_session, event) => {
    if (
      event.type === "tool/result" &&
      (event.data.message.isError || event.data.error)
    )
      errors.push({
        kind: "tool-error",
        name: event.data.message.name ?? "unknown",
      });
  });
  return {
    ctx,
    adapter,
    ledger: ctx.taskSystem.ledger,
    async dispose() {
      await ctx.fiber.dispose();
    },
  };
}
let calls = 0;
async function call(h, agent, name, args) {
  const result = await h.ctx.tools.execute({
    name,
    arguments: args,
    agent,
    callId: ToolCallId("smoke-call-" + ++calls),
    signal: new AbortController().signal,
  });
  assert.equal(result.isError, false, JSON.stringify(result.error));
  return result.value;
}
async function events(h, id) {
  const stored = await h.ctx.sessionPersistence.open(SessionId(id), "read");
  try {
    return (await stored.read()).events;
  } finally {
    await stored.close();
  }
}
function catalog(ledger, nodeId) {
  const request = ledger.executionModels.request("catalog-" + ++calls, {
    nodeId,
  }).catalog.request;
  ledger.completeExecutionModels("catalog-result-" + ++calls, {
    nodeId,
    requestId: request.requestId,
    generation: request.generation,
    result: {
      state: "success",
      complete: true,
      observedAt: Date.now(),
      temporaryWorkspaceReady: true,
      models: [{ provider: "smoke-script", model: "script" }],
    },
  });
}
function findEntry(value, id) {
  if (!value || typeof value !== "object") return;
  if (value.id === id) return value;
  for (const child of Object.values(value)) {
    const found = findEntry(child, id);
    if (found) return found;
  }
}
function findCredential(value, ref) {
  if (!value || typeof value !== "object") return;
  const direct = value[ref];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct.value === "string") return direct.value;
  if (value.ref === ref && typeof value.value === "string") return value.value;
  for (const child of Object.values(value)) {
    const found = findCredential(child, ref);
    if (found) return found;
  }
}
async function realProvider(h) {
  const yaml = await import(pathToFileURL(require.resolve("yaml"))),
    file =
      values["provider-config"] ?? join(dirname(profile), "cordis.patch.yml");
  const data = yaml.parse(readFileSync(file, "utf8"), { logLevel: "silent" }),
    entry = findEntry(data, "llm-pi-ai"),
    provider = values["real-provider"],
    model = values["real-model"];
  assert.ok(
    entry?.name && entry.config?.providers?.[provider],
    "Existing provider configuration unavailable",
  );
  const configured = entry.config.providers[provider],
    selected = configured.models.find((row) => row.id === model);
  assert.ok(
    selected,
    "Explicit small model must exist in the configured catalog",
  );
  const ref = configured.apiKeyEnv;
  assert.ok(
    typeof ref === "string" && ref,
    "Provider must name its existing credential reference",
  );
  const dshRoot = resolve(dirname(profile), "../.."),
    credentialFile =
      values["credentials-file"] ?? join(dshRoot, ".credentials.yaml"),
    envFile = values["env-file"] ?? join(dshRoot, ".env");
  let key = process.env[ref];
  if (!key && existsSync(credentialFile))
    key = findCredential(
      yaml.parse(readFileSync(credentialFile, "utf8"), { logLevel: "silent" }),
      ref,
    );
  if (!key && existsSync(envFile))
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const found = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
      );
      if (found?.[1] === ref) {
        key = found[2].trim();
        if (
          (key.startsWith('"') && key.endsWith('"')) ||
          (key.startsWith("'") && key.endsWith("'"))
        )
          key = key.slice(1, -1);
        break;
      }
    }
  assert.ok(
    typeof key === "string" && key.length > 0,
    "Existing credential unavailable in fixture memory",
  );
  const { createLaunchEnvironmentSnapshot } = await load(
    "@deepseek-ai/dsh-launch-environment",
  );
  h.ctx.provide(
    "launchEnvironment",
    createLaunchEnvironmentSnapshot([
      { source: "process", values: { [ref]: key } },
    ]),
  );
  await h.ctx.loader.create({
    id: "smoke-real-provider",
    name: pathToFileURL(require.resolve(entry.name)).href,
    config: {
      providers: { [provider]: { ...configured, models: [selected] } },
    },
  });
  await h.ctx.loader.await();
  const effort =
    selected.reasoningEfforts === false ||
    selected.reasoningEfforts?.off !== undefined
      ? "off"
      : selected.reasoningEfforts?.low !== undefined
        ? "low"
        : undefined;
  return {
    provider,
    model,
    ...(effort ? { reasoningEffort: effort } : {}),
    maxTokens: 1536,
  };
}
const base = {
  mode,
  host: hostname(),
  pid: process.pid,
  installedVersion: taskInfo.version,
  installedPackage: realpathSync(taskRoot),
  profile,
  runtimeEntry: values["runtime-entry"] ?? null,
  physicalHosts: !values["allow-same-host"],
  modelBoundary: values["real-coordinator"]
    ? "real small-model coordinator; scripted external child LLM; real installed DSH native and signed transport"
    : "scripted external LLM; real installed DSH Loader, AgentLoop, tools, signed transport and ledgers",
  marker: values.marker,
};

async function coordinator() {
  let h, server, store, parent;
  const started = Date.now(),
    observations = [];
  try {
    h = await harness("planner", "smoke-aws");
    const { ctx, ledger, adapter } = h;
    let naturalSteps = 0;
    const natural = values["real-coordinator"];
    const allowed = [
      "task_nodes",
      "project_list",
      "project_bind_session",
      "task_create",
      "task_bind_dispatcher",
      "task_dispatch",
      "task_query",
      "task_history",
      "task_wait",
      "task_submit_result",
    ];
    const mountNatural = (agentCtx) => {
      agentCtx.tools.restrict({ allow: allowed });
      agentCtx.on("agent/pre-step", async (_payload, next) => {
        if (++naturalSteps > 14)
          throw new Error("Natural-language smoke exceeded its 14-step budget");
        return next();
      });
    };
    if (natural)
      ctx.taskSystem.registerOriginContinuation({
        id: "physical-smoke-coordinator",
        capture: (agent) =>
          String(agent.id) === "aws-original-coordinator"
            ? { fixture: true }
            : undefined,
        resume: (agentCtx) => mountNatural(agentCtx),
      });
    const coordinatorOptions = natural
      ? await realProvider(h)
      : { provider: "smoke-script", model: "script" };
    for (const old of [
      "task_run",
      "task_delegate",
      "task_children",
      "task_settle",
      "project_dispatch",
    ])
      assert.equal(
        ctx.tools.get(old),
        undefined,
        old + " must not be registered",
      );
    const projectRoot = join(dir, "projects"),
      existing = join(projectRoot, "aws-existing-project");
    mkdirSync(existing, { recursive: true });
    ctx.taskSystem.projects.saveSettings({
      root: projectRoot,
      expectedRevision: 0,
    });
    const project = await ctx.taskSystem.projects.create({
      commandId: "smoke-project",
      title: "Isolated physical return smoke",
      goal: "One AWS coordinator and one delayed MBP native child",
      workspace: { kind: "directory", nodeId: "smoke-aws", path: existing },
    });
    ledger.registerNode("smoke-mbp", {
      nodeId: "smoke-mbp",
      roles: ["executor"],
      enabled: true,
      capabilities: [],
      models: [{ provider: "smoke-script", model: "script" }],
      workspaceIds: [],
      maxConcurrent: 1,
    });
    catalog(ledger, "smoke-mbp");
    const keys = generateKeyPairSync("ed25519");
    writeFileSync(
      join(dir, "worker-private.pem"),
      keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    const operations = [
      "executorIdentity",
      "claim",
      "renew",
      "submit",
      "receipt",
      "bindSession",
      "markRunning",
      "getRun",
      "getAttempt",
      "listWork",
      "taskWait",
      "sessionContext",
      "selectTaskSession",
      "reportAdmission",
      "heartbeat",
      "nodeStatus",
    ];
    store = new remote.RecoveryStore(join(dir, "gateway.sqlite"));
    const gateway = new remote.RemoteGateway({
      role: "planner",
      nodeId: "smoke-aws",
      ledger,
      store,
      verifier: new remote.IdentityVerifier({
        audience: "smoke-aws",
        peers: [
          {
            keyId: "smoke-key",
            nodeId: "smoke-mbp",
            publicKey: keys.publicKey,
            audience: "smoke-aws",
            operations,
            workspaces: [],
            capabilities: [],
          },
        ],
      }),
    });
    const handler = remote.httpHandler(gateway, { allowLoopbackHttp: true });
    let state = { ...base, phase: "preparing" };
    server = createServer((req, res) => {
      if (req.url === "/status" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(state));
      } else if (req.url === "/commands") {
        void handler(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(values.port), "127.0.0.1", resolve);
    });
    parent = await ctx.agents.create({
      sessionId: SessionId("aws-original-coordinator"),
      meta: { cwd: existing },
      agentOptions: coordinatorOptions,
      signal: AbortSignal.timeout(120000),
      ...(natural ? { setup: (agentCtx) => mountNatural(agentCtx) } : {}),
    });
    let parentTaskId;
    if (!natural)
      adapter.script.push(
        { name: "project_list", args: {} },
        {
          name: "project_bind_session",
          args: { projectId: project.projectId },
        },
        {
          name: "task_create",
          args: {
            commandId: "parent-draft",
            title: "Physical-host smoke parent",
            policy: { settlementQuietMs: 0 },
          },
        },
        () => {
          parentTaskId = ledger
            .snapshot()
            .tasks.find(
              (task) => task.title === "Physical-host smoke parent",
            ).taskId;
          return {
            name: "task_bind_dispatcher",
            args: { commandId: "bind-parent", taskId: parentTaskId },
          };
        },
        {
          name: "task_dispatch",
          args: {
            commandId: "mbp-child",
            title: "Physical MBP native child",
            description:
              "Calculate 17+29 and submit a signed result report with the fixture marker.",
            nodeId: "smoke-mbp",
            executionModel: { provider: "smoke-script", model: "script" },
          },
        },
        "Pending: waiting for the delayed physical MBP child.",
      );
    parent.agent.followup(
      createUserMessage({
        source: { kind: "user" },
        content: [
          {
            type: "text",
            text: natural
              ? `这是一次隔离、只读的双机验收。请先查看已有项目，选中当前目录下名为“Isolated physical return smoke”的项目。为我建立一个父任务，登记你这个原会话为该父任务的协调者，然后正式派发恰好一个子任务给执行端 smoke-mbp：计算17+29并提交包含验收标记 ${values.marker} 的结果报告。执行端使用其公开目录里唯一可用的模型，不使用你的会话模型。你已获授权只更改这个隔离验收项目的任务元数据，不读写生产文件、不发送第三方消息、不启动本地Codex。派发成功不等于完成，请先结束本轮说明等待，不要轮询或等待工具。之后收到子任务结果事件时，读取该子任务真实报告并核对结果，再正式提交当前父任务的最终报告，报告须含标记和计算结果。不得重复派发、重跑或把状态说明当作最终结果。`
              : "Use the existing isolated project, create the parent task, bind this session as coordinator, and formally dispatch one MBP child.",
          },
        ],
      }),
    );
    await parent.agent.whenIdle();
    await ctx.sessions.flush(parent.agent.session);
    if (!natural) assert.deepEqual(errors, []);
    const binding = ledger.dispatcherForSession(
      "smoke-aws",
      String(parent.agent.id),
    );
    assert.ok(
      binding,
      "Natural-language caller must bind a real coordinator parent",
    );
    parentTaskId = binding.taskId;
    const initialEvents = await events(h, "aws-original-coordinator");
    const successfulCallIds = new Set(
      initialEvents
        .filter(
          (event) =>
            event.type === "tool/result" && !event.data.message.isError,
        )
        .map((event) => event.data.message.toolCallId),
    );
    const initialCalls = initialEvents
      .filter(
        (event) =>
          event.type === "tool/call" &&
          successfulCallIds.has(event.data.callId),
      )
      .map((event) => event.data.name);
    for (const required of [
      "project_list",
      "project_bind_session",
      "task_create",
      "task_bind_dispatcher",
      "task_dispatch",
    ])
      assert.ok(
        initialCalls.includes(required),
        required + " must be called through the public interface",
      );
    assert.equal(
      initialCalls.filter((name) => name === "task_dispatch").length,
      1,
    );
    const child = ledger
        .snapshot()
        .tasks.find((task) => task.parentTaskId === parentTaskId),
      childRun = ledger.history(child.taskId).runs[0];
    assert.equal(childRun.route.nodeId, "smoke-mbp");
    assert.equal(childRun.route.workspaceId, undefined);
    assert.equal(childRun.workspaceConstraint, undefined);
    assert.equal(childRun.parentRunId, binding.runId);
    assert.equal(childRun.dispatchOrigin.sessionId, "aws-original-coordinator");
    const firstWait = await call(h, parent.agent, "task_wait", {
      taskId: parentTaskId,
      timeoutMs: 0,
      quietMs: 0,
    });
    assert.equal(firstWait.settled, false);
    assert.ok(firstWait.pendingRunIds.includes(childRun.runId));
    observations.push({
      phase: "before-executor",
      elapsedMs: Date.now() - started,
      state: childRun.state,
      parentSettled: firstWait.settled,
      pendingChild: true,
    });
    await parent.dispose();
    parent = undefined;
    assert.equal(ctx.agents.get("aws-original-coordinator"), undefined);
    state = {
      ...base,
      phase: "awaiting-executor",
      port: server.address().port,
      projectId: project.projectId,
      parentTaskId,
      parentRunId: binding.runId,
      childTaskId: child.taskId,
      childRunId: childRun.runId,
      sessionId: "aws-original-coordinator",
      coldOrigin: true,
      naturalLanguageCoordinator: natural,
      coordinatorOptions: natural ? coordinatorOptions : undefined,
      initialPublicCalls: initialCalls,
      correctedInitialToolErrors: errors.length,
      attemptedInitialPublicCalls: initialEvents
        .filter((event) => event.type === "tool/call")
        .map((event) => event.data.name),
    };
    write("ready.json", state);
    let sawRunning = false,
      preparedReturn = false;
    while (Date.now() - started < 120000 && !existsSync(join(dir, "stop"))) {
      const current = ledger.getRun(childRun.runId);
      if (current.state === "running" && !sawRunning) {
        const pending = await call(h, undefined, "task_wait", {
          taskId: parentTaskId,
          timeoutMs: 0,
          quietMs: 0,
        });
        assert.equal(pending.settled, false);
        assert.ok(pending.pendingRunIds.includes(childRun.runId));
        observations.push({
          phase: "physical-worker-running",
          elapsedMs: Date.now() - started,
          state: current.state,
          parentSettled: false,
          pendingChild: true,
        });
        sawRunning = true;
        state = { ...state, phase: "worker-running" };
      }
      if (current.state === "succeeded" && !preparedReturn) {
        assert.ok(sawRunning, "Delay must expose a running pending state");
        const report = ledger
          .history(child.taskId)
          .reports.findLast((report) => report.kind === "result");
        assert.ok(report?.body.includes(values.marker));
        const remoteProof = JSON.parse(report.body);
        assert.equal(remoteProof.sum, 46);
        if (!values["allow-same-host"])
          assert.notEqual(
            remoteProof.host,
            hostname(),
            "The child must execute on the other physical host",
          );
        if (!natural)
          adapter.script.push(
            { name: "task_history", args: { taskId: child.taskId } },
            (options) => {
              const result = options.messages.findLast(
                (message) => message.role === "tool",
              );
              assert.ok(JSON.stringify(result).includes(values.marker));
              return {
                name: "task_submit_result",
                args: {
                  outcome: "success",
                  summary: "Physical child verified and parent completed",
                  reportTitle: "Physical-host smoke final report",
                  reportBody: JSON.stringify({
                    marker: values.marker,
                    childHost: remoteProof.host,
                    childRunId: childRun.runId,
                    sum: remoteProof.sum,
                    verified: true,
                  }),
                },
              };
            },
          );
        observations.push({
          phase: "child-result-before-cold-return",
          elapsedMs: Date.now() - started,
          returnState: ledger
            .pendingSessionMessages("smoke-aws")
            .find((message) => message.completion)?.state,
        });
        preparedReturn = true;
        state = { ...state, phase: "cold-return" };
      }
      if (preparedReturn) ctx.taskSystem.tick();
      const parentRun = ledger.getRun(binding.runId),
        returned = ledger.history(child.taskId).resultReturns[0];
      if (parentRun.state === "succeeded" && returned?.state === "completed") {
        const log = await events(h, "aws-original-coordinator");
        const resultEvents = log.filter(
          (event) =>
            event.type === "user/message" &&
            event.data.source.kind === "dsh-task-result",
        );
        assert.equal(resultEvents.length, 1);
        assert.equal(ledger.snapshot().tasks.length, 2);
        assert.equal(ledger.snapshot().runs.length, 2);
        assert.equal(ledger.snapshot().attempts.length, 1);
        assert.equal(ledger.getTask(parentTaskId).state, "completed");
        if (!natural) assert.deepEqual(errors, []);
        const completed = {
          ...state,
          publicCalls: log
            .filter((event) => event.type === "tool/call")
            .map((event) => event.data.name),
          coordinatorSteps: naturalSteps,
          naturalLanguageCoordinator: natural,
          status: "passed",
          phase: "complete",
          observations,
          parentState: parentRun.state,
          childState: current.state,
          returnState: returned.state,
          resultEvents: resultEvents.length,
          taskCount: ledger.snapshot().tasks.length,
          runCount: 2,
          attemptCount: 1,
          parentReport: ledger
            .history(parentTaskId)
            .reports.findLast((report) => report.kind === "result"),
          childReport: ledger
            .history(child.taskId)
            .reports.findLast((report) => report.kind === "result"),
          elapsedMs: Date.now() - started,
        };
        state = completed;
        write("result.json", completed);
        process.stdout.write(
          JSON.stringify({
            status: "passed",
            mode,
            host: hostname(),
            evidence: join(dir, "result.json"),
          }) + "\n",
        );
        return;
      }
      await sleep(100);
    }
    throw new Error("Physical smoke deadline or stop requested");
  } catch (error) {
    const failed = {
      ...base,
      status: "failed",
      errorCode: error.code ?? error.name,
      error: values["real-coordinator"]
        ? "Real coordinator smoke failed; no credential or vendor response bodies are exported"
        : String(error.message).slice(0, 1000),
      observations,
    };
    write("result.json", failed);
    throw error;
  } finally {
    if (parent) await parent.dispose();
    if (server)
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    await h?.dispose();
    store?.close();
  }
}

async function executor() {
  assert.ok(
    values.endpoint && values["key-file"],
    "Executor requires --endpoint and --key-file",
  );
  let h, client, worker, clientStore, workerStore;
  const start = Date.now();
  try {
    const root = join(dir, "mbp-execution-root");
    mkdirSync(root, { recursive: true });
    let execution;
    h = await harness("executor", "smoke-mbp", [
      async () => {
        const record = workerStore
          .dispatches()
          .find((record) => record.claim?.run?.runId);
        assert.ok(record?.sessionId);
        const agent = h.ctx.agents.get(SessionId(record.sessionId));
        assert.ok(agent);
        const cwd = agent.session.header.cwd;
        assert.ok(
          !relative(root, cwd).startsWith(".."),
          "Child cwd stays in the isolated MBP execution root",
        );
        assert.notEqual(cwd, root);
        execution = {
          host: hostname(),
          cwd,
          sessionId: record.sessionId,
          runId: record.claim.run.runId,
          attemptId: record.attemptId,
          marker: values.marker,
          sum: 17 + 29,
          delayMs: Number(values["delay-ms"]),
          modelBoundary: base.modelBoundary,
        };
        await sleep(Number(values["delay-ms"]));
        return {
          name: "task_submit_result",
          args: {
            outcome: "success",
            summary: "Physical MBP computed 17+29=46",
            reportTitle: "Physical MBP native evidence",
            reportBody: JSON.stringify(execution),
          },
        };
      },
    ]);
    h.ctx.taskSystem.executionDirectories.save({ root, expectedRevision: 0 });
    clientStore = new remote.RecoveryStore(join(dir, "client.sqlite"));
    workerStore = new remote.RecoveryStore(join(dir, "worker.sqlite"));
    client = new remote.RemoteClient({
      endpoint: values.endpoint,
      audience: "smoke-aws",
      nodeId: "smoke-mbp",
      keyId: "smoke-key",
      privateKey: createPrivateKey(readFileSync(values["key-file"])),
      store: clientStore,
      allowLoopbackHttp: true,
      timeoutMs: 15000,
    });
    await client.executorIdentity();
    const ledger = new remote.RemoteLedgerClient(client, "smoke-mbp");
    const provider = remote.nativeExecutionAdapter(h.ctx.taskSystem.native, {
      provider: "smoke-script",
      models: [{ model: "script", reasoningEfforts: [] }],
      capabilities: [],
    });
    worker = new remote.ExecutorWorker({
      ledger,
      provider,
      store: workerStore,
      projectRoot: () => root,
      ttlMs: 15000,
      policy: {
        role: "executor",
        nodeId: "smoke-mbp",
        capabilities: [],
        workspaces: [],
      },
    });
    let result;
    while (Date.now() - start < 90000) {
      const rows = await worker.pollOnce(1);
      if (rows.length) {
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "fulfilled");
        result = rows[0].value;
        break;
      }
      await sleep(200);
    }
    assert.ok(result, "Signed gateway must offer the child Run");
    assert.equal(result.state, "acknowledged");
    assert.equal(result.result.outcome, "success");
    assert.ok(execution);
    assert.deepEqual(errors, []);
    assert.equal(
      h.ledger.snapshot().tasks.length,
      0,
      "Executor does not create authority tasks",
    );
    const log = await events(h, execution.sessionId);
    assert.ok(
      log.some(
        (event) =>
          event.type === "tool/call" &&
          event.data.name === "task_submit_result",
      ),
    );
    const output = {
      ...base,
      status: "passed",
      execution,
      dispatch: {
        attemptId: result.attemptId,
        state: result.state,
        runId: result.claim.run.runId,
        workspacePath: result.workspacePath,
      },
      nativeModelRequests: h.adapter.requests.length,
      localAuthorityTaskCount: 0,
      elapsedMs: Date.now() - start,
    };
    write("result.json", output);
    process.stdout.write(
      JSON.stringify({
        status: "passed",
        mode,
        host: hostname(),
        evidence: join(dir, "result.json"),
      }) + "\n",
    );
  } catch (error) {
    write("result.json", {
      ...base,
      status: "failed",
      errorCode: error.code ?? error.name,
      error: values["real-coordinator"]
        ? "Real coordinator smoke failed; no credential or vendor response bodies are exported"
        : String(error.message).slice(0, 1000),
    });
    throw error;
  } finally {
    await worker?.dispose();
    await client?.dispose();
    clientStore?.close();
    workerStore?.close();
    await h?.dispose();
  }
}
try {
  await (mode === "coordinator" ? coordinator() : executor());
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      status: "failed",
      mode,
      errorCode: error.code ?? error.name,
      error: values["real-coordinator"]
        ? "Real coordinator smoke failed; no credential or vendor response bodies are exported"
        : String(error.message).slice(0, 1000),
      evidence: join(dir, "result.json"),
    }) + "\n",
  );
  process.exitCode = 1;
}
