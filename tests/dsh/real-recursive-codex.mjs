/** Real Codex smoke. No scripted external model is ever requested here. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { observeOfficialWire } from "./recursive-live/wire-proof.mjs";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
const root = resolve(process.env.DSH_RECURSIVE_RUNTIME || ".runtime/recursive");
const backend = {
  backend: "codex-luna-low",
  provider: "codex",
  model: "gpt-6-luna",
  reasoningEffort: "low",
  permissionContract: "codex-native",
  codexHome: resolve(
    process.env.DSH_RECURSIVE_CODEX_HOME || join(root, "codex-home"),
  ),
};
mkdirSync(join(root, "workspace"), { recursive: true });
mkdirSync(join(root, "evidence"), { recursive: true });
const ctx = new Context();
await ctx.plugin(Loader, {
  baseUrl: pathToFileURL(resolve("package.json")).href,
});
await ctx.loader.root.update(
  [
    ["llm", "@deepseek-ai/dsh-llm"],
    ["sessions", "@deepseek-ai/dsh-session"],
    ["sessionProjections", "@deepseek-ai/dsh-session-projection"],
    ["systemPrompt", "@deepseek-ai/dsh-system-prompt"],
    ["tools", "@deepseek-ai/dsh-tools"],
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
      "tasks",
      pathToFileURL(resolve("packages/task-system/dist/dsh-plugin.js")).href,
      {
        nodeId: "mbp",
        role: "both",
        databasePath: join(root, "tasks.sqlite"),
        keepAlive: false,
        leaseTtlMs: 60000,
        officialBackends: [backend],
      },
    ],
  ].map(([id, name, config]) => ({ id, name, config })),
);
await ctx.loader.await();
const ledger = ctx.taskSystem.ledger;
const wireProof = [];
observeOfficialWire(ctx.subprocess, wireProof);
try {
  const at = new Date().toISOString();
  ledger.registerWorkspace("smoke-workspace-" + Date.now(), {
    workspaceId: "mbp-workspace",
    nodeId: "mbp",
    path: join(root, "workspace"),
    label: "Isolated MBP real Codex",
    state: "ready",
    createdAt: at,
  });
  ledger.registerNode("smoke-node-" + Date.now(), {
    nodeId: "mbp",
    roles: ["both"],
    capabilities: ["official-codex"],
    models: [
      { provider: "codex", model: "gpt-6-luna", reasoningEfforts: ["low"] },
    ],
    workspaceIds: ["mbp-workspace"],
    enabled: true,
    lastSeenAt: at,
  });
  const task = ledger.createTask(`real-task-${Date.now()}`, {
    title: "真实 GPT-6 Luna / low 隔离测试",
    description:
      "Return a markdown table in Chinese with three concrete risks in recursive delegation (parent run identity, inherited permissions, cancellation until quiescence), an example failure and a specific mitigation for each. Do not use tools. This is execution evidence; human review remains pending.",
    workspaceId: "mbp-workspace",
    policy: {
      allowedBackends: [backend.backend],
      allowedTools: [],
      maxRuntimeMs: 120000,
    },
  }).value;
  const run = ledger.createRun(`real-run-${task.taskId}`, {
    taskId: task.taskId,
    route: {
      nodeId: "mbp",
      backend: backend.backend,
      provider: "codex",
      model: "gpt-6-luna",
      reasoningEffort: "low",
      workspaceId: "mbp-workspace",
      requiredCapabilities: ["official-codex"],
    },
  }).value;
  const claim = ledger.claim(`real-claim-${run.runId}`, {
    runId: run.runId,
    nodeId: "mbp",
    ttlMs: 60000,
  }).value;
  const result = await ctx.taskSystem.native.execute(claim);
  const evidence = {
    wireProof,
    kind: "real-official-codex",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    taskId: task.taskId,
    runId: run.runId,
    attemptId: claim.attempt.attemptId,
    result,
    history: ledger.history(task.taskId),
  };
  writeFileSync(
    join(root, "evidence", "local-real-codex.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      state: result.run.state,
      review: result.run.reviewStatus,
      taskId: task.taskId,
      runId: run.runId,
      evidence: join(root, "evidence", "local-real-codex.json"),
    }),
  );
  if (result.run.state !== "succeeded") process.exitCode = 1;
} finally {
  writeFileSync(
    join(root, "evidence", "snapshot.json"),
    JSON.stringify(ledger.snapshot(), null, 2),
  );
  await ctx.fiber.dispose();
}
