import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import {
  verifyOfficialProfile,
  type OfficialBackend,
} from "./official-execution.js";

// Public app-server v2 metadata only. The official provider still owns initialization,
// the ephemeral thread, turn, cancellation and managed-range disposal.
type Rpc = {
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: unknown;
};
export const isolatedFeatures = [
  "plugins",
  "apps",
  "remote_plugin",
  "hooks",
] as const;
/** Bound each complete or incomplete JSON-RPC line before concatenation/parsing. */
export const OFFICIAL_RPC_MAX_LINE_BYTES = 4 * 1024 * 1024;
export interface OfficialPermissionAudit {
  model: string;
  reasoningEffort: string;
  productThreadId: string;
  disabledFeatures: readonly string[];
  mcpServerCount: 0;
  configurationLayerTypes: string[];
}

/** Hold thread/start's response until this same app-server proves the permission contract. */
export function guardOfficialTransport(
  child: SubprocessHandle,
  backend: OfficialBackend,
  cwd: string,
  onAudit?: (audit: OfficialPermissionAudit) => void,
): SubprocessHandle {
  if (!child.stdin || !child.stdout) {
    child.terminate();
    throw new Error("official permission audit requires piped transport");
  }
  const rawIn = child.stdin,
    rawOut = child.stdout,
    stdout = new PassThrough();
  const prefix = `dsh-permission-${randomUUID()}:`;
  let held: Rpc | undefined, started: Rpc | undefined;
  let phase:
    | "idle"
    | "config"
    | "thread"
    | "features"
    | "mcp"
    | "ready"
    | "denied" = "idle";
  let layers: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  const send = (message: Rpc) => rawIn.write(JSON.stringify(message) + "\n");
  const emit = (message: Rpc) => stdout.write(JSON.stringify(message) + "\n");
  const deny = () => {
    if (phase === "denied") return;
    phase = "denied";
    clearTimeout(timer);
    if (held)
      emit({
        id: held.id,
        error: {
          code: -32000,
          message:
            "Official Codex effective permission contract could not be confirmed",
        },
      });
    else
      stdout.destroy(new Error("Official Codex permission transport rejected"));
  };
  const probe = (
    method: string,
    params: Record<string, unknown>,
    key: string,
  ) => send({ id: prefix + key, method, params });
  const acceptConfig = (result: any) => {
    const c = result?.config;
    if (
      !c ||
      c.model !== backend.model ||
      c.model_reasoning_effort !== backend.reasoningEffort ||
      c.sandbox_mode !== "read-only" ||
      c.approval_policy !== "never" ||
      !Array.isArray(c.project_root_markers) ||
      c.project_root_markers.length !== 0 ||
      isolatedFeatures.some((name) => c.features?.[name] !== false) ||
      Object.values(c.mcp_servers ?? {}).some(
        (s: any) => s?.enabled !== false,
      ) ||
      !Array.isArray(result.layers) ||
      result.layers.some(
        (l: any) => l.name?.type === "project" && !l.disabledReason,
      )
    )
      return deny();
    layers = result.layers
      .map((l: any) => l.name?.type)
      .filter((x: unknown): x is string => typeof x === "string");
    phase = "thread";
    send(held!);
  };
  const acceptThread = (message: Rpc) => {
    const r = message.result;
    if (
      !r ||
      r.model !== backend.model ||
      r.reasoningEffort !== backend.reasoningEffort ||
      r.approvalPolicy !== "never" ||
      r.sandbox?.type !== "readOnly" ||
      r.sandbox.networkAccess !== false ||
      r.thread?.ephemeral !== true ||
      typeof r.thread.id !== "string"
    )
      return deny();
    started = message;
    phase = "features";
    probe(
      "experimentalFeature/list",
      { threadId: r.thread.id, limit: 200 },
      "features",
    );
  };
  const onOutgoing = (message: Rpc) => {
    if (message.method === "thread/start") {
      if (
        phase !== "idle" ||
        message.params?.cwd !== cwd ||
        message.params?.ephemeral !== true
      )
        return deny();
      held = message;
      phase = "config";
      timer = setTimeout(deny, 30000);
      probe("config/read", { cwd, includeLayers: true }, "config");
    } else if (message.method === "turn/start" && phase !== "ready") deny();
    else if (phase !== "denied") send(message);
  };
  const onIncoming = (message: Rpc) => {
    if (typeof message.id === "string" && message.id.startsWith(prefix)) {
      if (message.error || phase === "denied") return deny();
      if (message.id === prefix + "config" && phase === "config")
        acceptConfig(message.result);
      else if (message.id === prefix + "features" && phase === "features") {
        const r = message.result;
        if (
          !Array.isArray(r?.data) ||
          r.nextCursor !== null ||
          isolatedFeatures.some(
            (name) =>
              r.data.find((f: any) => f.name === name)?.enabled !== false,
          )
        )
          return deny();
        phase = "mcp";
        probe(
          "mcpServerStatus/list",
          {
            threadId: started!.result.thread.id,
            limit: 200,
            detail: "toolsAndAuthOnly",
          },
          "mcp",
        );
      } else if (message.id === prefix + "mcp" && phase === "mcp") {
        if (
          !Array.isArray(message.result?.data) ||
          message.result.data.length !== 0 ||
          message.result.nextCursor !== null
        )
          return deny();
        onAudit?.({
          model: backend.model,
          reasoningEffort: backend.reasoningEffort,
          productThreadId: started!.result.thread.id,
          disabledFeatures: isolatedFeatures,
          mcpServerCount: 0,
          configurationLayerTypes: layers,
        });
        phase = "ready";
        clearTimeout(timer);
        emit(started!);
        held = undefined;
      } else deny();
    } else if (held && message.id === held.id && phase === "thread")
      acceptThread(message);
    else emit(message);
  };
  const inDecoder = new StringDecoder("utf8"),
    outDecoder = new StringDecoder("utf8");
  const lines = (receive: (message: Rpc) => void) => {
    let partial = "",
      bytes = 0;
    return (text: string) => {
      let offset = 0;
      while (offset < text.length && phase !== "denied") {
        const newline = text.indexOf("\n", offset),
          end = newline < 0 ? text.length : newline;
        const piece = text.slice(offset, end),
          length = Buffer.byteLength(piece);
        if (bytes + length > OFFICIAL_RPC_MAX_LINE_BYTES) {
          partial = "";
          bytes = 0;
          deny();
          return;
        }
        partial += piece;
        bytes += length;
        if (newline < 0) return;
        const line = partial;
        partial = "";
        bytes = 0;
        if (line.trim()) receive(JSON.parse(line));
        offset = newline + 1;
      }
    };
  };
  const readOutgoing = lines(onOutgoing),
    readIncoming = lines(onIncoming);
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      try {
        readOutgoing(inDecoder.write(chunk));
        callback();
      } catch {
        deny();
        callback();
      }
    },
    final(callback) {
      rawIn.end();
      callback();
    },
  });
  rawOut.on("data", (chunk: Buffer) => {
    try {
      readIncoming(outDecoder.write(chunk));
    } catch {
      deny();
    }
  });
  rawOut.on("end", () => {
    clearTimeout(timer);
    stdout.end();
  });
  rawOut.on("error", () => deny());
  rawIn.on("error", () => deny());
  void child.done.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
  return {
    stdin,
    stdout,
    get stderr() {
      return child.stderr;
    },
    get control() {
      return child.control;
    },
    get collected() {
      return child.collected;
    },
    get done() {
      return child.done;
    },
    terminate: () => child.terminate(),
    waitForExit: (signal) => child.waitForExit(signal),
  };
}

/** Decorate only the registered official provider's subprocesses, retaining range ownership. */
export function installOfficialPermissionGuard(
  subprocess: { spawn(spec: SubprocessSpawnSpec): SubprocessHandle },
  backends: readonly OfficialBackend[],
  onAudit?: (audit: OfficialPermissionAudit) => void,
): () => void {
  const spawn = subprocess.spawn;
  const guarded = (spec: SubprocessSpawnSpec) => {
    const backend = backends.find(
      (b) =>
        spec.env?.CODEX_HOME &&
        realpathSync(b.codexHome) === realpathSync(spec.env.CODEX_HOME),
    );
    if (!backend) return spawn.call(subprocess, spec);
    verifyOfficialProfile(backend, spec.cwd);
    if (
      spec.argv.length !== 4 ||
      spec.argv[2] !== "app-server" ||
      spec.argv[3] !== "--stdio"
    )
      throw new Error("unsupported official Codex launch contract");
    // The host's desktop IPC/originator settings are not this backend's environment.
    const env = Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => key.startsWith("CODEX_"))
        .map((key) => [key, undefined]),
    );
    return guardOfficialTransport(
      spawn.call(subprocess, { ...spec, env: { ...env, ...spec.env } }),
      backend,
      spec.cwd,
      onAudit,
    );
  };
  subprocess.spawn = guarded;
  return () => {
    if (subprocess.spawn === guarded) subprocess.spawn = spawn;
  };
}
