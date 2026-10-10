import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type { ExecutionRoute, Json, TaskPolicy } from "./contracts.js";
import type { ExecutionResult } from "./remote/ports.js";

/** Deployment contract: permission and model belong to the official provider profile. */
export interface OfficialBackend {
  backend: string;
  codexHome: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  /** An explicit backend grant acknowledges its native tools, not DSH toolFilter. */
  permissionContract: "codex-native";
}
export function verifyOfficialProfile(
  backend: OfficialBackend,
  workspacePath?: string,
): void {
  if (!isAbsolute(backend.codexHome))
    throw new Error("isolated absolute CODEX_HOME required");
  const config = readFileSync(join(backend.codexHome, "config.toml"), "utf8");
  // Keep the profile deliberately minimal: no alternate providers, MCP, plugins or project overrides.
  const allowed = new Set([
    "model",
    "model_reasoning_effort",
    "sandbox_mode",
    "approval_policy",
    "cli_auth_credentials_store",
  ]);
  const values = new Map<string, string>();
  for (const line of config.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^([a-z_]+)\s*=\s*"([^"\n]*)"\s*$/.exec(line);
    if (!match || !allowed.has(match[1]!) || values.has(match[1]!))
      throw new Error("unsupported isolated Codex config");
    values.set(match[1]!, match[2]!);
  }
  if (
    values.get("model") !== backend.model ||
    values.get("model_reasoning_effort") !== backend.reasoningEffort ||
    values.get("sandbox_mode") !== "read-only" ||
    values.get("approval_policy") !== "never" ||
    values.get("cli_auth_credentials_store") !== "file"
  )
    throw new Error(
      "official Codex profile does not match exact model/effort/read-only contract",
    );
  if (workspacePath && existsSync(join(workspacePath, ".codex")))
    throw new Error(
      "workspace Codex configuration overrides are not supported",
    );
}
export function authorizeOfficialBackend(
  route: ExecutionRoute,
  policy: TaskPolicy | undefined,
  backends: readonly OfficialBackend[],
): OfficialBackend {
  const backend = backends.find(
    (b) =>
      b.backend === route.backend &&
      b.provider === route.provider &&
      b.model === route.model &&
      b.reasoningEffort === route.reasoningEffort,
  );
  if (!backend || !policy?.allowedBackends?.includes(backend.backend))
    throw new Error(
      "official backend route or inherited permission grant denied",
    );
  return backend;
}
/** No agentOptions, toolFilter, depthLimit or continuation is claimed for Codex. */
export async function executeOfficialSubagent(input: {
  subagents: SubagentRuntime;
  parent: Agent;
  route: ExecutionRoute;
  policy?: TaskPolicy;
  backends: readonly OfficialBackend[];
  workspacePath?: string;
  prompt: string;
  signal: AbortSignal;
  onPublished?: (id: string) => void | Promise<void>;
}): Promise<ExecutionResult> {
  const backend = authorizeOfficialBackend(
    input.route,
    input.policy,
    input.backends,
  );
  verifyOfficialProfile(backend, input.workspacePath);
  input.signal.throwIfAborted();
  const provider = input.subagents.getProvider(backend.backend);
  if (
    !provider ||
    provider.capabilities.agentOptions ||
    provider.capabilities.toolFilter ||
    provider.capabilities.depthLimit
  )
    throw new Error("expected official one-shot Codex capability contract");
  const run = await input.subagents.start(backend.backend, {
    parent: input.parent,
    signal: input.signal,
    prompt: [{ type: "text", text: input.prompt }],
  });
  let result;
  try {
    await input.onPublished?.(run.id);
    result = await run.result;
  } finally {
    // Result is never delivered to the journal/worker until all child effects quiesce.
    await run.dispose();
  }
  input.signal.throwIfAborted();
  const body = result.output
    .filter((block: ContentBlock) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  const completed = result.stopReason === "completed" && body.trim().length > 0;
  return {
    outcome: completed
      ? "success"
      : result.stopReason === "error"
        ? "failure"
        : "unknown",
    summary: completed
      ? "Official Codex execution completed; awaiting user/director review"
      : `Official Codex stopped: ${result.stopReason}`,
    report: {
      title: "Official Codex execution evidence",
      body: body || "No final assistant text was returned.",
      data: {
        officialSubagentId: run.id,
        backend: backend.backend,
        stopReason: result.stopReason,
        model: backend.model,
        reasoningEffort: backend.reasoningEffort,
        permissionContract: backend.permissionContract,
        progressSupported: false,
        continuationSupported: false,
        acceptance: "pending_user",
      } as Json,
    },
  };
}
