import { readFileSync, existsSync, realpathSync } from "node:fs";
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
  /** Execution-host selected absolute CLI executable. Never supplied in a task route. */
  cliPath?: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  /** An explicit backend grant acknowledges its native tools, not DSH toolFilter. */
  permissionContract: "codex-native";
}
export interface OfficialRuntimeEvidence {
  cliVersion: string | null;
  cliSource: "host-configured" | "official-provider-package";
  verifiedModel?: string;
  verifiedReasoningEffort?: string;
  productThreadId?: string;
}
const runtimeEvidence = new Map<string, OfficialRuntimeEvidence>();
export function recordOfficialRuntime(
  home: string,
  evidence: OfficialRuntimeEvidence,
): void {
  runtimeEvidence.set(realpathSync(home), evidence);
}
export function officialRuntimeEvidence(
  home: string,
): OfficialRuntimeEvidence | undefined {
  return runtimeEvidence.get(realpathSync(home));
}
/** Deployment defaults; effective configuration is also checked in the live app-server. */
export function officialProfileConfig(
  backend: Pick<OfficialBackend, "model" | "reasoningEffort">,
): string {
  return `model = ${JSON.stringify(backend.model)}\nmodel_reasoning_effort = ${JSON.stringify(backend.reasoningEffort)}\nsandbox_mode = "read-only"\napproval_policy = "never"\ncli_auth_credentials_store = "file"\nproject_root_markers = []\n[features]\nplugins = false\napps = false\nremote_plugin = false\nhooks = false\n`;
}
export function verifyOfficialProfile(
  backend: OfficialBackend,
  workspacePath?: string,
): void {
  if (backend.cliPath !== undefined && !isAbsolute(backend.cliPath))
    throw new Error("host Codex CLI path must be absolute");
  if (!isAbsolute(backend.codexHome))
    throw new Error("isolated absolute CODEX_HOME required");
  const config = readFileSync(join(backend.codexHome, "config.toml"), "utf8");
  // This deliberately narrow format is not evidence that managed layers are absent.
  // The transport guard checks the effective configuration and loaded thread before any turn.
  const normalized = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .join("\n");
  if (normalized(config) !== normalized(officialProfileConfig(backend)))
    throw new Error(
      "official Codex profile does not match exact model/effort/runtime isolation contract",
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
// Codex's SQLite state is shared by every app-server using this profile.
// One executor process must not overlap their initialization or teardown.
const profiles = new Map<string, { tail: Promise<void>; blocked: boolean }>();
async function acquireProfile(home: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const key = realpathSync(home);
  const state = profiles.get(key) ?? {
    tail: Promise.resolve(),
    blocked: false,
  };
  const prior = state.tail;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => held);
  state.tail = tail;
  profiles.set(key, state);
  void tail.then(() => {
    if (state.tail === tail && !state.blocked) profiles.delete(key);
  });
  let onAbort!: () => void;
  try {
    await Promise.race([
      prior,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    signal.throwIfAborted();
    if (state.blocked)
      throw new Error(
        "official profile teardown did not confirm quiescence; restart the executor after reconciliation",
      );
    return {
      release,
      block: () => {
        state.blocked = true;
      },
    };
  } catch (error) {
    release();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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
  const slot = await acquireProfile(backend.codexHome, input.signal);
  try {
    // Recheck after queueing: a waiting task must not launch a changed profile.
    verifyOfficialProfile(backend, input.workspacePath);
    runtimeEvidence.delete(realpathSync(backend.codexHome));
    let run;
    try {
      run = await input.subagents.start(backend.backend, {
        parent: input.parent,
        signal: input.signal,
        prompt: [{ type: "text", text: input.prompt }],
      });
    } catch (error) {
      // rc.2 emits AggregateError only when unpublished-start cleanup also fails.
      if (error instanceof AggregateError) {
        slot.block();
        throw error;
      }
      input.signal.throwIfAborted();
      // The official provider has joined the unpublished child before rejecting.
      // No workload turn was published; this startup failure can close the valid lease without replay.
      return {
        outcome: "failure",
        summary:
          "Official Codex startup failed after child cleanup; no execution was published",
        report: {
          title: "Official Codex startup failure",
          body: "No official execution was published. The provider completed startup cleanup; no result or human acceptance is claimed.",
          data: {
            backend: backend.backend,
            ...(officialRuntimeEvidence(backend.codexHome) ?? {}),
            phase: "startup",
          },
        },
      };
    }
    let result;
    try {
      await input.onPublished?.(run.id);
      result = await run.result;
    } finally {
      // Result is never delivered to the journal/worker until all child effects quiesce.
      try {
        await run.dispose();
      } catch (error) {
        slot.block();
        throw error;
      }
    }
    input.signal.throwIfAborted();
    const body = result.output
      .filter((block: ContentBlock) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("\n");
    const completed =
      result.stopReason === "completed" && body.trim().length > 0;
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
          ...(officialRuntimeEvidence(backend.codexHome) ?? {}),
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
  } finally {
    slot.release();
  }
}
