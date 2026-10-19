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
import { observeOfficialWire } from "./wire-proof.mjs";
import { liveConfiguration } from "./config.mjs";
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
        leaseTtlMs: 60000,
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
  (name) => new RecoveryStore(join(root, name + ".sqlite")),
);
let loseResultAck = true,
  actualCalls = 0;
const client = new RemoteClient({
  endpoint: endpoint.href,
  allowLoopbackHttp: true,
  nodeId: "mbp",
  keyId: "mbp-key",
  audience: "vps",
  privateKey: createPrivateKey(
    readFileSync(join(root, "mbp-private.pem"), "utf8"),
  ),
  store: stores[0],
  fetch: async (url, options) => {
    const message = JSON.parse(options.body),
      response = await fetch(url, options);
    if (message.operation === "submit" && loseResultAck && response.ok) {
      loseResultAck = false;
      await response.text();
      throw new Error("Deliberate lost ACK after actual VPS commit");
    }
    return response;
  },
});
const remote = new RemoteLedgerClient(client, "mbp");
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
  ttlMs: 60000,
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
  if (stopping) return;
  const promise = worker
    .pollOnce(8)
    .then((results) =>
      dispatches.push(
        ...results.map((r) =>
          r.status === "fulfilled"
            ? {
                attemptId: r.value.attemptId,
                state: r.value.state,
                outcome: r.value.result?.outcome,
              }
            : { state: "rejected" },
        ),
      ),
    )
    .catch((error) =>
      dispatches.push({
        state: "poll-error",
        code: error.code || "RUNTIME_ERROR",
      }),
    )
    .finally(() => passes.delete(promise));
  passes.add(promise);
}
const timer = setInterval(() => void poll(), 1000);
await poll();
const deadline = Date.now() + 240000;
try {
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const snapshot = await (await fetch(snapshotEndpoint)).json();
    writeFileSync(
      join(root, "evidence", "vps-snapshot.json"),
      JSON.stringify(snapshot, null, 2),
    );
    if (
      snapshot.runs.length >= 8 &&
      snapshot.runs.every(
        (r) => !["running", "queued", "blocked"].includes(r.state),
      )
    )
      break;
  }
  stopping = true;
  clearInterval(timer);
  await worker.dispose();
  await Promise.allSettled([...passes]);
  // Recreate the worker over its durable store and reconcile the intentionally lost result ACK.
  const recoveryWorker = new ExecutorWorker(options);
  const before = actualCalls;
  await recoveryWorker.recoverResults();
  await recoveryWorker.dispose();
  const finalSnapshot = await (await fetch(snapshotEndpoint)).json();
  const verification = {
    expectedNineRuns: finalSnapshot.runs.length === 9,
    allQuiescent: finalSnapshot.runs.every(
      (r) => !["running", "queued", "blocked"].includes(r.state),
    ),
    threeOfficialPending:
      finalSnapshot.runs.filter(
        (r) =>
          r.route?.backend === backend.backend &&
          r.state === "succeeded" &&
          r.outcome === "success" &&
          r.reviewStatus === "pending_user",
      ).length === 3,
    cancellationRecorded: finalSnapshot.runs.some(
      (r) => r.state === "cancelled",
    ),
    ordinaryArtifact: existsSync(join(workspace, "ordinary-analysis.txt")),
    lostAckRecovered: !loseResultAck && actualCalls === before,
  };
  const evidence = {
    verification,
    kind: "real-vps-mbp-dsh-codex",
    runtimeRoot: root,
    workspace,
    authorityNode: "vps",
    executorNode: "mbp",
    commandsEndpoint: endpoint.href,
    snapshotEndpoint: snapshotEndpoint.href,
    codexHome: backend.codexHome,
    dshModel: "deepseek-flash",
    codexModel: "gpt-6-luna",
    codexEffort: "low",
    actualProviderCalls: actualCalls,
    recoveryReplayedProvider: actualCalls !== before,
    deliberateLostResultAck: !loseResultAck,
    dispatches,
    wireProof: proof,
  };
  writeFileSync(
    join(root, "evidence", "execution.json"),
    JSON.stringify(evidence, null, 2),
  );
  writeFileSync(
    join(root, "evidence", "vps-snapshot.json"),
    JSON.stringify(finalSnapshot, null, 2),
  );
  if (Object.values(verification).some((ok) => !ok))
    throw new Error(
      "Live run did not satisfy execution verification; inspect persisted evidence (human acceptance remains pending)",
    );
  console.log(
    JSON.stringify({
      providerCalls: actualCalls,
      lostAck: !loseResultAck,
      recoveryReplayed: actualCalls !== before,
      evidence: join(root, "evidence"),
    }),
  );
} finally {
  clearInterval(timer);
  await worker.dispose();
  await ctx.fiber.dispose();
  for (const store of stores) store.close();
}
