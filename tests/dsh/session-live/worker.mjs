/** Real DSH model and real official Codex; no scripted model is mounted. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPrivateKey } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import {
  RemoteClient,
  RemoteLedgerClient,
  RecoveryStore,
  ExecutorWorker,
} from "../../../packages/task-system/dist/remote/api.js";
import { observeOfficialWire } from "../recursive-live/wire-proof.mjs";
import { liveConfiguration } from "../recursive-live/config.mjs";
const { root, workspace, endpoint, snapshotEndpoint, codexHome } =
  liveConfiguration();
mkdirSync(workspace, { recursive: true });
mkdirSync(join(root, "evidence"), { recursive: true });
const backend = {
  backend: "codex-luna-low",
  provider: "codex",
  model: "gpt-6-luna",
  reasoningEffort: "low",
  permissionContract: "codex-native",
  codexHome,
  cliPath:process.env.DSH_TEST_CODEX_CLI,
};
const ctx = new Context();
await ctx.plugin(Loader, {
  baseUrl: pathToFileURL(resolve("package.json")).href,
});
// Resolve the existing credential reference read-only into this process's immutable launch snapshot.
const yaml = await import(
  process.env.DSH_RECURSIVE_YAML_MODULE ||
    "/Users/pmp/.local/lib/deepseek-harness/0.2.0-rc.2/node_modules/yaml/dist/index.js"
);
const refs = yaml.parse(
  readFileSync(
    process.env.DSH_RECURSIVE_CREDENTIALS ||
      "/Users/pmp/.dsh/.credentials.yaml",
    "utf8",
  ),
).refs;
if (typeof refs?.DEEPSEEK_API_KEY !== "string" || !refs.DEEPSEEK_API_KEY)
  throw new Error("Missing read-only DeepSeek credential reference");
ctx.provide(
  "launchEnvironment",
  createLaunchEnvironmentSnapshot([
    { source: "process", values: { DEEPSEEK_API_KEY: refs.DEEPSEEK_API_KEY } },
  ]),
);
await ctx.loader.root.update(
  [
    ["llm", "@deepseek-ai/dsh-llm"],
    ["deepseek", "@deepseek-ai/dsh-llm-deepseek-api-key", { maxTokens: 8000 }],
    ["sessions", "@deepseek-ai/dsh-session"],
    ["projections", "@deepseek-ai/dsh-session-projection"],
    ["prompt", "@deepseek-ai/dsh-system-prompt"],
    ["tools", "@deepseek-ai/dsh-tools"],
    ["fs", "@deepseek-ai/dsh-fs-local", { cwd: workspace }],
    ["files", "@deepseek-ai/dsh-tool-fs"],
    ["agents", "@deepseek-ai/dsh-agent"],
    ["subagents", "@deepseek-ai/dsh-subagent"],
    ["subprocess", "@deepseek-ai/dsh-subprocess-local"],
    [
      "persistence",
      "@deepseek-ai/dsh-session-persistence-jsonl",
      { root: join(root, "sessions"), compression: "none" },
    ],
    ["loop", "@deepseek-ai/dsh-agent-loop", { agents: [] }],
    [
      "task",
      pathToFileURL(resolve("packages/task-system/dist/dsh-plugin.js")).href,
      {
        role: "executor",
        nodeId: "mbp",
        databasePath: join(root, "local-task-service.sqlite"),
        keepAlive: false,
        leaseTtlMs: 180000,
        executionTools: ["task_dispatch", "task_note", "write", "read"],
        officialBackends: [backend],
      },
    ],
  ].map(([id, name, config]) => ({ id, name, config })),
);
await ctx.loader.await();
const proof = [];
observeOfficialWire(ctx.subprocess, proof);
const stores = ["client", "worker"].map(
  (name) => new RecoveryStore(join(root, name === "client" ? "conversation-remote.sqlite" : name + ".sqlite")),
);
let loseResultAck = false,
  actualCalls = 0;
const client = new RemoteClient({
 endpoint:endpoint.href,authMode:"trusted-network",nodeId:"mbp",audience:"vps",store:stores[0],
 trustedNetwork:{address:endpoint.hostname,port:Number(endpoint.port),localAddress:process.env.DSH_TEST_MBP_IP||"100.111.163.32",allowHttp:true},
});
const remote = new RemoteLedgerClient(client,"mbp");
await remote.recordNodeHeartbeat(`session-live-heartbeat:${Date.now()}`, {nodeId:'mbp',sampledAt:Date.now(),runtimeReady:true,activeExecutions:0,providerStatus:{state:'not-probed',providers:[{provider:'codex',state:'not-probed'}],executionRoutes:[{nodeId:'mbp',provider:backend.provider,model:backend.model,reasoningEffort:backend.reasoningEffort,backend:backend.backend,requiredCapabilities:['official-codex']}]}});
const submit=remote.submit.bind(remote);
remote.submit=async (...args)=>{const result=await submit(...args);if(loseResultAck){loseResultAck=false;throw new Error("Deliberate lost ACK after actual VPS commit");}return result;};
const native = ctx.taskSystem.native;
const provider = {
  id: "real-native-dsh-and-official-codex",
  capabilities: ["native-dsh", "official-codex"],
  supports: (r) =>
    r.nodeId === "mbp" &&
    ((!r.backend &&
      r.provider === "deepseek-official" &&
      r.model === "deepseek-flash" &&
      r.reasoningEffort === "low") ||
      (r.backend === backend.backend &&
        r.provider === "codex" &&
        r.model === "gpt-6-luna" &&
        r.reasoningEffort === "low")),
  execute: async (request) => {
    actualCalls++;
    return await native.executeExternal(request);
  },
};
const options = {
  ledger: remote,
  provider,
  store: stores[1],
  ttlMs: 180000,
  policy: {
    role: "executor",
    nodeId: "mbp",
    capabilities: provider.capabilities,
    workspaces: [
      {
        workspaceId: "mbp-workspace",
        nodeId: "mbp",
        path: workspace,
        allowedRoot: workspace,
      },
    ],
  },
};
const worker = new ExecutorWorker(options),
  passes = new Set(),
  dispatches = [];
let stopping = false;
async function poll() {
  if (stopping || passes.size) return;
  const promise = worker
    .pollOnce(8, {waitForCompletion:false})
    .then((results) =>
      dispatches.push(
        ...results.map((r) =>
          r.status === "fulfilled"
            ? {
                attemptId: r.value.attemptId,
                state: r.value.state,
                outcome: r.value.result?.outcome,
              }
            : { state: "rejected", code:r.reason?.code, message:r.reason?.message },
        ),
      ),
    )
    .catch((error) =>
      dispatches.push({
        state: "poll-error",
        code: error.code || "RUNTIME_ERROR",
      }),
    )
    .finally(() => { passes.delete(promise); if(dispatches.length) console.log(JSON.stringify({dispatches})); });
  passes.add(promise);
}
console.log("Official loader ready; polling Tailscale coordinator");
const heartbeatTimer=setInterval(()=>void remote.recordNodeHeartbeat(`session-live-heartbeat:${Date.now()}`, {nodeId:'mbp',sampledAt:Date.now(),runtimeReady:true,activeExecutions:0,providerStatus:{state:'not-probed',providers:[{provider:'codex',state:'not-probed'}],executionRoutes:[{nodeId:'mbp',provider:backend.provider,model:backend.model,reasoningEffort:backend.reasoningEffort,backend:backend.backend,requiredCapabilities:['official-codex']}]}}).catch(()=>{}),10000);
const timer = setInterval(() => void poll(), 1000);
await poll();
const deadline=Date.now()+1200000;
try {while(!existsSync(join(root,'worker.stop')) && Date.now()<deadline)await new Promise(r=>setTimeout(r,1000));}
finally {stopping=true;clearInterval(timer);clearInterval(heartbeatTimer);await Promise.allSettled([...passes]);await worker.dispose();writeFileSync(join(root,'evidence','worker.json'),JSON.stringify({actualCalls,proof,dispatches},null,2));for(const store of stores)store.close();await ctx.fiber.dispose();}
