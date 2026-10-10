/** Real CLI configuration/thread probe. Never sends turn/start or calls a tool. */
import { Context } from "@deepseek-ai/cordis";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { writeFileSync } from "node:fs";
import { installOfficialPermissionGuard } from "../../packages/task-system/dist/index.js";
const home = process.env.DSH_RECURSIVE_CODEX_HOME,
  cwd = process.env.DSH_RECURSIVE_WORKSPACE;
if (!home || !cwd)
  throw new Error("Explicit isolated CODEX_HOME and workspace are required");
const backend = {
  backend: "codex-luna-low",
  provider: "codex",
  model: "gpt-6-luna",
  reasoningEffort: "low",
  permissionContract: "codex-native",
  codexHome: resolve(home),
};
const require = createRequire(import.meta.url);
const bin = join(
  dirname(require.resolve("@openai/codex/package.json")),
  "bin/codex.js",
);
const ctx = new Context();
await ctx.plugin(LocalSubprocessRuntime);
const audits = [];
const restore = installOfficialPermissionGuard(
  ctx.subprocess,
  [backend],
  (audit) => audits.push(audit),
);
let child;
try {
  child = ctx.subprocess.spawn({
    argv: [process.execPath, bin, "app-server", "--stdio"],
    cwd: resolve(cwd),
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    graceMs: 1000,
    env: { CODEX_HOME: backend.codexHome },
  });
  const pending = new Map();
  let id = 0;
  const warnings = [];
  child.stderr.on("data", (chunk) => {
    if (/unreal-mcp|MCP server/.test(String(chunk)))
      warnings.push("MCP startup warning observed");
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line),
      entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error
        ? entry.reject(new Error("Permission audit rejected thread"))
        : entry.resolve(message.result);
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      child.stdin.write(JSON.stringify({ method, params, id: key }) + "\n");
    });
  const timeout = setTimeout(() => {
    for (const entry of pending.values())
      entry.reject(new Error("Probe deadline"));
    child.terminate();
  }, 45000);
  try {
    await call("initialize", {
      clientInfo: { name: "dsh-permission-metadata-probe", version: "1" },
      capabilities: { experimentalApi: false },
    });
    child.stdin.write('{"method":"initialized"}\n');
    const thread = await call("thread/start", {
      cwd: resolve(cwd),
      model: backend.model,
      ephemeral: true,
      approvalPolicy: "never",
    });
    const evidence = {
      kind: "official-metadata-only-no-inference",
      cliVersion: require("@openai/codex/package.json").version,
      audits,
      sandbox: thread.sandbox,
      warnings,
      modelCalls: 0,
      toolCalls: 0,
    };
    if (audits.length !== 1 || warnings.length)
      throw new Error("Unexpected permission probe evidence");
    if (process.env.DSH_RECURSIVE_PROBE_EVIDENCE)
      writeFileSync(
        resolve(process.env.DSH_RECURSIVE_PROBE_EVIDENCE),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    console.log(JSON.stringify(evidence));
  } finally {
    clearTimeout(timeout);
  }
} finally {
  if (child) {
    child.stdin.end();
    child.terminate();
    await child.waitForExit();
    await child.done;
  }
  restore();
  await ctx.fiber.dispose();
}
