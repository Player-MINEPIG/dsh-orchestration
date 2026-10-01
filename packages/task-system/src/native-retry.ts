import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";

export type NativeTransientCode =
  | "RATE_LIMIT"
  | "SERVER"
  | "TRANSPORT"
  | "TIMEOUT";
interface NativeRetryProof {
  sessionId: string;
  fromSeq: number;
  toSeq: number;
  terminalSeq: number;
  turn: number;
  code: NativeTransientCode;
  complete: true;
  quiescent: true;
  persisted: true;
  disposed: true;
}
export interface NativeCompletedTool {
  name: string;
  argumentsDigest: string;
}
export type NativeRetryWitness = NativeRetryProof &
  (
    | {
        kind: "dsh-owned-zero-tools-v1";
        toolCallCount: 0;
        toolDispatchCount: 0;
      }
    | {
        kind: "dsh-owned-completed-tools-v1";
        toolCallCount: number;
        toolDispatchCount: number;
        toolResultCount: number;
        completedTools: NativeCompletedTool[];
      }
  );
export interface NativeRetryObservationOptions {
  /** Operator-reviewed tools whose completed calls must never be replayed. */
  resumableTools?: readonly string[];
}

/** Fingerprint only the actual dispatch arguments. Never retain or log them. */
export function nativeToolFingerprint(
  name: string,
  args: unknown,
): NativeCompletedTool | undefined {
  if (typeof name !== "string" || !/^[\w][\w:./@-]{0,199}$/.test(name))
    return undefined;
  let bytes = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const hash = createHash("sha256");
  const append = (part: string) => {
    bytes += Buffer.byteLength(part);
    if (bytes > 1_000_000) throw new Error("fingerprint too large");
    hash.update(part);
  };
  function visit(value: unknown, depth: number) {
    if (++nodes > 100_000 || depth > 64)
      throw new Error("fingerprint too deep");
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      append(JSON.stringify(value));
      return;
    }
    if (typeof value === "string") {
      if (value.length > 1_000_000) throw new Error("fingerprint too large");
      append(JSON.stringify(value));
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value))
      throw new Error("fingerprint requires JSON");
    seen.add(value);
    try {
      const array = Array.isArray(value);
      if (
        !array &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      )
        throw new Error("fingerprint requires plain JSON");
      if (array && value.length > 100_000)
        throw new Error("fingerprint too large");
      const keys = array
        ? Array.from({ length: value.length }, (_, index) => String(index))
        : Object.keys(value).sort();
      if (keys.length > 100_000) throw new Error("fingerprint too large");
      append(array ? "[" : "{");
      for (const [index, key] of keys.entries()) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !("value" in property))
          throw new Error("fingerprint requires JSON data");
        if (index) append(",");
        if (!array) {
          append(JSON.stringify(key));
          append(":");
        }
        visit(property.value, depth + 1);
      }
      append(array ? "]" : "}");
    } finally {
      seen.delete(value);
    }
  }
  try {
    visit({ name, arguments: args }, 0);
    return { name, argumentsDigest: hash.digest("hex") };
  } catch {
    return undefined;
  }
}
const transientCodes = new Set<string>([
  "RATE_LIMIT",
  "SERVER",
  "TRANSPORT",
  "TIMEOUT",
]);

/** Live, contiguous evidence only. It never infers tool absence from old log snapshots. */
export class NativeRetryObservation {
  private readonly fromSeq: number;
  private nextSeq: number;
  private complete = true;
  private toolCalls = 0;
  private toolDispatches = 0;
  private toolResults = 0;
  private readonly resumableTools: ReadonlySet<string>;
  private readonly calls = new Map<
    string,
    {
      seq: number;
      turn: number;
      step: number;
      fingerprint: NativeCompletedTool;
      dispatched: boolean;
      resultSeq?: number;
    }
  >();
  private requestError?: {
    turn: number;
    step: number;
    code: string;
    nextSeq: number;
  };
  private lastStep?: { turn: number; step: number };
  private terminal?: { seq: number; turn: number; code?: string };
  constructor(
    ctx: Context,
    private readonly agent: Agent,
    options: NativeRetryObservationOptions = {},
  ) {
    this.resumableTools = new Set(options.resumableTools ?? []);
    this.fromSeq = this.nextSeq = agent.session.seq;
    ctx.on("session/event", (session, event) => {
      if (session !== agent.session) return;
      if (event.seq !== this.nextSeq) this.complete = false;
      this.nextSeq = event.seq + 1;
      if (event.type === "step/start")
        this.lastStep = { turn: event.data.turn, step: event.data.step };
      if (event.type === "tool/call") {
        this.toolCalls++;
        const data = event.data;
        let fingerprint: NativeCompletedTool | undefined;
        try {
          if (data.arguments.length <= 1_000_000)
            fingerprint = nativeToolFingerprint(
              data.name,
              JSON.parse(data.arguments),
            );
        } catch {
          /* Invalid raw arguments are never resumable evidence. */
        }
        if (
          this.toolCalls > 32 ||
          this.calls.has(data.callId) ||
          !this.resumableTools.has(data.name) ||
          !fingerprint
        ) {
          this.complete = false;
        } else {
          this.calls.set(data.callId, {
            seq: event.seq,
            turn: data.turn,
            step: data.step,
            fingerprint,
            dispatched: false,
          });
        }
      }
      if (event.type === "tool/result") {
        this.toolResults++;
        const data = event.data;
        const call = this.calls.get(data.message.toolCallId);
        if (
          !call ||
          !call.dispatched ||
          call.resultSeq !== undefined ||
          call.turn !== data.turn ||
          call.step !== data.step ||
          data.message.isError === true ||
          data.error !== undefined ||
          data.message.role !== "tool" ||
          event.surfaceOp !== "append" ||
          event.sourceEventSeqs?.length !== 1 ||
          event.sourceEventSeqs[0] !== call.seq ||
          event.seq <= call.seq
        ) {
          this.complete = false;
        } else {
          call.resultSeq = event.seq;
        }
      }
      if (event.type === "turn/end")
        this.terminal = {
          seq: event.seq,
          turn: event.data.turn,
          ...(event.data.reason.kind === "error"
            ? { code: event.data.reason.error.code }
            : {}),
        };
    });
    ctx.on("agent/request-error", async (payload, next) => {
      if (payload.agent === agent)
        this.requestError = {
          turn: payload.turn,
          step: payload.step,
          code: payload.failure.code,
          nextSeq: this.nextSeq,
        };
      // Native DSH retry policy keeps its normal authority inside a request.
      return next();
    });
  }
  dispatchObserved(exec: Readonly<ToolExecution>): void {
    this.toolDispatches++;
    const call = this.calls.get(exec.callId);
    const fingerprint = nativeToolFingerprint(exec.name, exec.arguments);
    // Schema defaults/transforms that change recorded arguments fail closed.
    if (
      this.toolDispatches > 32 ||
      exec.agent !== this.agent ||
      exec.parent !== undefined ||
      (exec.rootCallId !== undefined && exec.rootCallId !== exec.callId) ||
      exec.signal.aborted ||
      !call ||
      call.dispatched ||
      !fingerprint ||
      fingerprint.name !== call.fingerprint.name ||
      fingerprint.argumentsDigest !== call.fingerprint.argumentsDigest
    ) {
      this.complete = false;
      return;
    }
    call.dispatched = true;
  }
  /** Caller supplies completion facts only after idle, successful flush and owned-handle disposal. */
  witness(facts: {
    aborted: boolean;
    persisted: boolean;
    disposed: boolean;
  }): NativeRetryWitness | undefined {
    const terminal = this.terminal;
    if (
      facts.aborted ||
      !facts.persisted ||
      !facts.disposed ||
      !this.complete ||
      this.nextSeq !== this.agent.session.seq ||
      this.agent.status !== "idle" ||
      !terminal?.code ||
      !transientCodes.has(terminal.code) ||
      this.requestError?.code !== terminal.code ||
      this.requestError.turn !== terminal.turn ||
      this.lastStep?.turn !== this.requestError.turn ||
      this.lastStep.step !== this.requestError.step ||
      this.requestError.nextSeq > terminal.seq ||
      terminal.seq < this.fromSeq ||
      terminal.seq !== this.nextSeq - 1
    )
      return undefined;
    const proof: NativeRetryProof = {
      sessionId: this.agent.id,
      fromSeq: this.fromSeq,
      toSeq: this.nextSeq,
      terminalSeq: terminal.seq,
      turn: terminal.turn,
      code: terminal.code as NativeTransientCode,
      complete: true,
      quiescent: true,
      persisted: true,
      disposed: true,
    };
    if (
      this.toolCalls === 0 &&
      this.toolDispatches === 0 &&
      this.toolResults === 0
    )
      return {
        ...proof,
        kind: "dsh-owned-zero-tools-v1",
        toolCallCount: 0,
        toolDispatchCount: 0,
      };
    if (
      this.toolCalls === 0 ||
      this.toolCalls > 32 ||
      this.toolCalls !== this.toolDispatches ||
      this.toolCalls !== this.toolResults ||
      this.calls.size !== this.toolCalls ||
      [...this.calls.values()].some(
        (call) =>
          !call.dispatched ||
          call.resultSeq === undefined ||
          call.resultSeq >= this.requestError!.nextSeq,
      )
    )
      return undefined;
    return {
      ...proof,
      kind: "dsh-owned-completed-tools-v1",
      toolCallCount: this.toolCalls,
      toolDispatchCount: this.toolDispatches,
      toolResultCount: this.toolResults,
      completedTools: [...this.calls.values()].map((call) => ({
        ...call.fingerprint,
      })),
    };
  }
}
