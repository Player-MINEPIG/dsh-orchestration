import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalRequestEvent,
  ApprovalOutcome,
} from "@deepseek-ai/dsh-user-approval/types";
import type {} from "@deepseek-ai/dsh-user-approval";
import type { ApprovalRequest, LeaseRef } from "./contracts.js";
import type { NativeExecutionProvider } from "./dsh-plugin.js";

export const name = "dsh-task-native-approval-bridge";
export const inject = ["taskSystem", "approval", "sessions", "agents", "tools"];
export interface Config {
  enabled?: boolean;
  reviewableTools?: { toolName: string; argumentKeys: string[] }[];
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPending?: number;
  maxArgumentBytes?: number;
}
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  reviewableTools: z
    .array(
      z.object({
        toolName: z.string().required(),
        argumentKeys: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  timeoutMs: z.number().min(100).max(300000).step(1).default(120000),
  pollIntervalMs: z.number().min(20).max(5000).step(1).default(250),
  maxPending: z.number().min(1).max(64).step(1).default(16),
  maxArgumentBytes: z.number().min(100).max(32768).step(1).default(8192),
});
type Scope = NonNullable<ReturnType<NativeExecutionProvider["scopeFor"]>>;
interface CallEvidence {
  toolName: string;
  sessionId: string;
  callId: string;
  executionId: string;
  descriptor?: { argumentsDigest: string; description: string };
}
const sensitive =
  /(?:password|passwd|secret|authorization|cookie|private[_ -]?key|api[_ -]?key|access[_ -]?token|bearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,})/i;
const display = (value: string): string =>
  value.replace(
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
function describe(
  toolName: string,
  args: unknown,
  keys: string[],
  maxBytes: number,
): CallEvidence["descriptor"] {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const values = Object.entries(args);
  if (
    values.some(
      ([key, value]) =>
        !keys.includes(key) ||
        sensitive.test(key) ||
        (value !== null &&
          !["string", "number", "boolean"].includes(typeof value)),
    )
  )
    return undefined;
  const serialized = JSON.stringify(args);
  if (
    !serialized ||
    Buffer.byteLength(serialized) > maxBytes ||
    sensitive.test(serialized)
  )
    return undefined;
  const description = `Tool: ${display(toolName)}\nExact validated arguments: ${display(serialized)}`;
  if (description.length > 3500) return undefined;
  return {
    argumentsDigest: createHash("sha256").update(serialized).digest("hex"),
    description,
  };
}
function same(ref: LeaseRef, other?: LeaseRef): boolean {
  return Boolean(
    other &&
      ref.runId === other.runId &&
      ref.attemptId === other.attemptId &&
      ref.nodeId === other.nodeId &&
      ref.fence === other.fence &&
      ref.executionId === other.executionId,
  );
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Public DSH answerer. Its IDs name live closures, never replayable grants. */
export function apply(ctx: Context, input: Config): void {
  const config = Config(input) as Required<Config>;
  if (!config.enabled) return;
  const reviewable = new Map(
    config.reviewableTools.map((rule) => [rule.toolName, rule.argumentKeys]),
  );
  if (reviewable.size !== config.reviewableTools.length)
    throw new Error("Duplicate reviewable approval tool");
  const lifecycle = new AbortController();
  const calls = new Map<string, CallEvidence>();
  const jobs = new Set<Promise<ApprovalOutcome>>();
  const key = (sessionId: string, callId: string) =>
    JSON.stringify([sessionId, callId]);
  const scopeOf = (agent: ApprovalRequestEvent["agent"]) =>
    ctx.taskSystem.native?.scopeFor(agent);

  ctx.on("session/event", (session, event) => {
    if (event.type !== "tool/call" && event.type !== "tool/result") return;
    const id = key(
      session.id,
      event.type === "tool/call"
        ? event.data.callId
        : event.data.message.toolCallId,
    );
    if (event.type === "tool/result") {
      calls.delete(id);
      return;
    }
    if (!reviewable.has(event.data.name) || calls.size >= 128) return;
    const agent = ctx.agents.get(session.id);
    const scope = agent && scopeOf(agent);
    if (!scope?.ref.executionId) return;
    calls.set(id, {
      toolName: event.data.name,
      sessionId: session.id,
      callId: event.data.callId,
      executionId: scope.ref.executionId,
    });
  });
  ctx.on("session/disposed", (session) => {
    for (const [id, call] of calls)
      if (call.sessionId === session.id) calls.delete(id);
  });
  // Observe validated runtime arguments without granting or weakening any guard.
  ctx.tools.guard((exec) => {
    if (!exec.agent) return undefined;
    const scope = scopeOf(exec.agent);
    const evidence = calls.get(key(exec.agent.id, exec.callId));
    const keys = reviewable.get(exec.name);
    if (
      scope &&
      evidence &&
      keys &&
      evidence.executionId === scope.ref.executionId &&
      evidence.toolName === exec.name
    )
      evidence.descriptor = describe(
        exec.name,
        exec.arguments,
        keys,
        config.maxArgumentBytes,
      );
    return undefined;
  });

  const answer = async (
    request: ApprovalRequestEvent,
    scope: Scope,
    evidence: CallEvidence,
  ): Promise<ApprovalOutcome> => {
    const agent = request.agent;
    const ref = { ...scope.ref };
    const requestId = `native-approval:${randomUUID()}`;
    const signal = AbortSignal.any([
      lifecycle.signal,
      ...(request.signal ? [request.signal] : []),
    ]);
    const expiresAt = Date.now() + config.timeoutMs;
    const descriptor = evidence.descriptor!;
    const offer = {
      requestId,
      sessionId: evidence.sessionId,
      agentId: agent.id,
      callId: evidence.callId,
      toolName: evidence.toolName,
      ...descriptor,
      expiresAt,
      allowRemoteOnce: true,
    };
    const remote = scope.collaboration;
    const status = async (): Promise<ApprovalRequest> =>
      scope.external
        ? await remote!.approvalStatus!(requestId)
        : ctx.taskSystem.ledger.approvalStatus({ ...ref, requestId });
    const live = () =>
      !signal.aborted &&
      Date.now() < expiresAt &&
      same(ref, scopeOf(agent)?.ref);
    let offered = false;
    let decided = false;
    try {
      if (!live()) return "cancelled";
      if (scope.external) await remote!.offerApproval!(requestId, offer);
      else ctx.taskSystem.ledger.offerApproval(requestId, { ...ref, ...offer });
      offered = true;
      while (live()) {
        const record = await status();
        if (
          !live() ||
          !same(ref, record) ||
          record.requestId !== requestId ||
          record.sessionId !== evidence.sessionId ||
          record.agentId !== agent.id ||
          record.callId !== evidence.callId ||
          record.toolName !== evidence.toolName ||
          record.argumentsDigest !== descriptor.argumentsDigest ||
          record.expiresAt !== expiresAt ||
          record.expiresAt <= Date.now()
        )
          return "cancelled";
        if (record.state === "allowed-once" && record.allowRemoteOnce) {
          decided = true;
          return "allowed-once";
        }
        if (record.state === "denied") {
          decided = true;
          return "rejected";
        }
        if (record.state === "expired" || record.state === "cancelled")
          return "cancelled";
        await pause(
          Math.min(config.pollIntervalMs, expiresAt - Date.now()),
          signal,
        );
      }
      return "cancelled";
    } catch {
      return signal.aborted ? "cancelled" : "unavailable";
    } finally {
      if (offered && !decided) {
        try {
          if (scope.external)
            await remote!.cancelApproval!(`cancel:${requestId}`, {
              requestId,
              reason: "Native approval closure ended without a usable decision",
            });
          else
            ctx.taskSystem.ledger.cancelApproval(`cancel:${requestId}`, {
              ...ref,
              requestId,
              reason: "Native approval closure ended without a usable decision",
            });
        } catch {
          /* Expiry/lease loss remains fail-closed; no historical decision is replayed. */
        }
      }
    }
  };
  ctx.on("approval/request", (request, next) => {
    const scope = scopeOf(request.agent);
    const evidence =
      request.callId && calls.get(key(request.agent.id, request.callId));
    if (
      lifecycle.signal.aborted ||
      jobs.size >= config.maxPending ||
      !scope?.ref.executionId ||
      !evidence?.descriptor ||
      evidence.toolName !== request.toolName ||
      evidence.executionId !== scope.ref.executionId ||
      (scope.external &&
        (!scope.collaboration?.offerApproval ||
          !scope.collaboration.approvalStatus ||
          !scope.collaboration.cancelApproval))
    )
      return next();
    const job = answer(request, scope, evidence);
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    return job;
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      lifecycle.abort(new Error("Native approval bridge unloaded"));
      await Promise.allSettled([...jobs]);
      calls.clear();
    })());
  const removeDrain = ctx.taskSystem.addDrain(close);
  ctx.effect(() => async () => {
    await close();
    removeDrain();
  });
}
