import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import { nativeProjectSession, projectSessionCommand } from "./project-session-protocol.js";
import { ProjectNativeOperation, projectNativeOperationWrites } from "./project-session-native.js";
import type { Json } from "./contracts.js";

const id = z.string().min(1).max(200);
const MAX_PACKET_BYTES = 60 * 1024;
const PART_BYTES = 32 * 1024;
const MAX_PARTS = 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const ProjectOwnerRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lifecycle"), command: projectSessionCommand }).strict(),
  z.object({ kind: z.literal("native"), binding: nativeProjectSession, operation: ProjectNativeOperation }).strict(),
]);
export type ProjectOwnerRequest = z.infer<typeof ProjectOwnerRequest>;
export const ProjectHostCatalog = z.object({
  revision: id,
  workspaces: z.array(z.object({ workspaceId: id, path: z.string().min(1).max(4096), label: z.string().max(500) }).strict()).max(64),
  available: z.boolean(),
}).strict();
export type ProjectHostCatalog = z.infer<typeof ProjectHostCatalog>;
const resultPart = z.object({
  callId: id, index: z.number().int().nonnegative(), count: z.number().int().positive().max(MAX_PARTS),
  digest: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(PART_BYTES),
}).strict();
const exchangeInput = z.object({ catalog: ProjectHostCatalog.optional(), result: resultPart.optional() }).strict();
export type ProjectSessionExchange = z.infer<typeof exchangeInput>;
const outcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: z.json() }).strict(),
  z.object({ kind: z.literal("error"), code: id }).strict(),
]);
type Outcome = z.infer<typeof outcome>;
const call = z.object({ callId: id, request: ProjectOwnerRequest }).strict();
const exchangeResult = z.object({ acknowledged: resultPart.omit({ text: true }).optional(), call: call.optional() }).strict();
export type ProjectSessionExchangeResult = z.infer<typeof exchangeResult>;

function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PACKET_BYTES)
    throw new TaskError("PROJECT_SESSION_SIZE", "Project session packet exceeds its transport budget");
  return value;
}
function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && error.code.length <= 200)
    return error.code;
  return "PROJECT_SESSION_FAILED";
}
function transientLifecycle(request: ProjectOwnerRequest, code: string): boolean {
  return request.kind === "lifecycle" && ["UNAVAILABLE", "PROJECT_SESSION_PENDING", "CENTRAL_UNAVAILABLE", "COORDINATOR_UNAVAILABLE", "COLLABORATION_PENDING", "REMOTE_OUTCOME_UNCERTAIN"].includes(code);
}
function json(value: unknown): Json { return z.json().parse(value); }
function unwrap(value: unknown): Json {
  const parsed = outcome.parse(value);
  if (parsed.kind === "error") throw new TaskError(parsed.code, "Project session owner could not confirm this operation");
  return parsed.value;
}

/** Project commands use the existing authenticated peer carrier and bounded responses. */
export class ProjectSessionCarrier {
  private readonly db;
  private readonly local = new Map<string, Promise<void>>();
  private stopped = false;
  private closing?: Promise<void>;
  constructor(
    ledger: Pick<TaskLedger, "managementDatabase">,
    readonly nodeId: string,
    private readonly execute: (request: ProjectOwnerRequest, callId: string) => Promise<unknown>,
    private readonly authorizePeer: (nodeId: string) => void,
    private readonly localResult?: (callId: string, result: string) => void,
  ) {
    this.db = ledger.managementDatabase();
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_session_carrier_calls(id TEXT PRIMARY KEY,node TEXT NOT NULL,digest TEXT NOT NULL,request TEXT NOT NULL,result TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS project_session_carrier_parts(call_id TEXT NOT NULL,part INTEGER NOT NULL,count INTEGER NOT NULL,digest TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(call_id,part));
      CREATE TABLE IF NOT EXISTS project_session_host_catalog(node TEXT PRIMARY KEY,data TEXT NOT NULL,observed INTEGER NOT NULL);`);
    if (this.localResult)
      for (const row of this.db.prepare("SELECT id,result FROM project_session_carrier_calls WHERE node=? AND result IS NOT NULL").all(this.nodeId))
        this.localResult(String(row.id), String(row.result));
  }
  private expireReads() {
    for (const row of this.db.prepare("SELECT id FROM project_session_carrier_calls WHERE expires<=?").all(Date.now())) {
      this.db.prepare("DELETE FROM project_session_carrier_parts WHERE call_id=?").run(String(row.id));
      this.db.prepare("DELETE FROM project_session_carrier_calls WHERE id=?").run(String(row.id));
    }
  }
  catalogs() {
    if (this.stopped) throw new TaskError("UNAVAILABLE", "Project session carrier is stopping");
    return this.db.prepare("SELECT node,data,observed FROM project_session_host_catalog ORDER BY node").all().map(row => ({
      nodeId: String(row.node), ...ProjectHostCatalog.parse(JSON.parse(String(row.data))), observedAt: Number(row.observed),
    }));
  }
  lookup(callId: string) {
    if (this.stopped) throw new TaskError("UNAVAILABLE", "Project session carrier is stopping");
    const row = this.db.prepare("SELECT node,request FROM project_session_carrier_calls WHERE id=?").get(callId);
    return row ? { nodeId: String(row.node), request: ProjectOwnerRequest.parse(JSON.parse(String(row.request))) } : undefined;
  }
  publish(nodeId: string, catalog: ProjectHostCatalog) {
    if (this.stopped) throw new TaskError("UNAVAILABLE", "Project session carrier is stopping");
    this.authorizePeer(nodeId);
    const parsed = bounded(ProjectHostCatalog.parse(catalog));
    this.db.prepare("INSERT INTO project_session_host_catalog VALUES(?,?,?) ON CONFLICT(node) DO UPDATE SET data=excluded.data,observed=excluded.observed")
      .run(nodeId, canonical(parsed), Date.now());
  }
  async request(nodeId: string, requestId: string, input: ProjectOwnerRequest, signal?: AbortSignal): Promise<Json> {
    if (this.stopped) throw new TaskError("UNAVAILABLE", "Project session carrier is stopping");
    this.authorizePeer(nodeId);
    this.expireReads();
    const parsed = bounded(ProjectOwnerRequest.parse(input)), digest = hash(canonical(parsed));
    id.parse(requestId);
    const previous = this.db.prepare("SELECT node,digest FROM project_session_carrier_calls WHERE id=?").get(requestId);
    if (previous && (previous.node !== nodeId || previous.digest !== digest))
      throw new TaskError("CONFLICT", "A project session retry changed its owner or contents");
    const expires = parsed.kind === "native" && safeNativeRetry(parsed.operation) ? Date.now() + 120_000 : null;
    this.db.prepare("INSERT OR IGNORE INTO project_session_carrier_calls VALUES(?,?,?,?,NULL,?)").run(requestId, nodeId, digest, canonical(parsed), expires);
    if (nodeId === this.nodeId && !this.local.has(requestId)) {
      const work = this.runLocal(requestId, parsed).finally(() => this.local.delete(requestId));
      this.local.set(requestId, work);
    }
    const deadline = Date.now() + 12_000;
    while (!signal?.aborted) {
      if (this.stopped) throw new TaskError("PROJECT_SESSION_PENDING", "Original project session request remains recorded while the carrier is stopping");
      const row = this.db.prepare("SELECT result FROM project_session_carrier_calls WHERE id=?").get(requestId);
      if (row?.result) return unwrap(JSON.parse(String(row.result)));
      if (Date.now() >= deadline) throw new TaskError("PROJECT_SESSION_PENDING", "Project session operation remains pending on its original owner");
      await new Promise<void>(resolve => setTimeout(resolve, 40));
    }
    throw new TaskError("PROJECT_SESSION_PENDING", "Project session operation remains recorded on its original owner");
  }
  private async runLocal(callId: string, request: ProjectOwnerRequest) {
    const previous = this.db.prepare("SELECT result FROM project_session_carrier_calls WHERE id=?").get(callId);
    if (previous?.result) return;
    let result: Outcome;
    try { result = { kind: "value", value: json(await this.execute(request, callId)) }; }
    catch (error) {
      const code = errorCode(error);
      if (transientLifecycle(request, code)) return;
      result = { kind: "error", code };
    }
    this.db.prepare("UPDATE project_session_carrier_calls SET result=? WHERE id=?").run(canonical(result), callId);
    this.localResult?.(callId, canonical(result));
  }
  exchange(nodeId: string, input: unknown): ProjectSessionExchangeResult {
    if (this.stopped) throw new TaskError("UNAVAILABLE", "Project session carrier is stopping");
    this.authorizePeer(nodeId);
    this.expireReads();
    const parsed = bounded(exchangeInput.parse(input));
    if (parsed.catalog) this.publish(nodeId, parsed.catalog);
    const result = parsed.result;
    let completed = false;
    if (result) {
      const owned = this.db.prepare("SELECT node,result FROM project_session_carrier_calls WHERE id=?").get(result.callId);
      if (!owned) return { acknowledged: { callId: result.callId, index: result.index, count: result.count, digest: result.digest } };
      if (owned.node !== nodeId) throw new TaskError("FORBIDDEN", "Project session receipt belongs to another owner");
      if (Buffer.byteLength(result.text) > PART_BYTES || result.index >= result.count)
        throw new TaskError("PROJECT_SESSION_SIZE", "Invalid project session receipt fragment");
      const previous = this.db.prepare("SELECT count,digest,text FROM project_session_carrier_parts WHERE call_id=? AND part=?").get(result.callId, result.index);
      if (previous && (previous.count !== result.count || previous.digest !== result.digest || previous.text !== result.text))
        throw new TaskError("CONFLICT", "Project session receipt fragment changed during retry");
      const storedBytes = this.db.prepare("SELECT COALESCE(SUM(length(CAST(text AS BLOB))),0) AS bytes FROM project_session_carrier_parts WHERE call_id=?").get(result.callId);
      if (!previous && Number(storedBytes?.bytes) + Buffer.byteLength(result.text) > MAX_RESULT_BYTES)
        throw new TaskError("PROJECT_SESSION_SIZE", "Project session receipt exceeds its result budget");
      this.db.prepare("INSERT OR IGNORE INTO project_session_carrier_parts VALUES(?,?,?,?,?)").run(result.callId, result.index, result.count, result.digest, result.text);
      const parts = this.db.prepare("SELECT part,count,digest,text FROM project_session_carrier_parts WHERE call_id=? ORDER BY part").all(result.callId);
      if (parts.reduce((sum, part) => sum + Buffer.byteLength(String(part.text)), 0) > MAX_RESULT_BYTES)
        throw new TaskError("PROJECT_SESSION_SIZE", "Project session receipt exceeds its result budget");
      if (parts.length === result.count) {
        if (parts.some((part, index) => part.part !== index || part.count !== result.count || part.digest !== result.digest))
          throw new TaskError("CONFLICT", "Project session receipt fragments disagree");
        const text = parts.map(part => String(part.text)).join("");
        if (hash(text) !== result.digest) throw new TaskError("CONFLICT", "Project session receipt digest does not match");
        const parsedResult = outcome.parse(JSON.parse(text));
        if (owned.result && owned.result !== canonical(parsedResult)) throw new TaskError("CONFLICT", "Project session outcome changed");
        this.db.prepare("UPDATE project_session_carrier_calls SET result=? WHERE id=?").run(canonical(parsedResult), result.callId);
        completed = true;
      }
    }
    const pending = !result || completed ? this.db.prepare("SELECT id,request FROM project_session_carrier_calls WHERE node=? AND result IS NULL ORDER BY rowid LIMIT 1").get(nodeId) : undefined;
    const acknowledgement = result ? { acknowledged: { callId: result.callId, index: result.index, count: result.count, digest: result.digest } } : {};
    const response = { ...acknowledgement,
      ...(pending ? { call: { callId: String(pending.id), request: ProjectOwnerRequest.parse(JSON.parse(String(pending.request))) } } : {}) };
    return bounded(result && Buffer.byteLength(JSON.stringify(response)) > MAX_PACKET_BYTES ? acknowledgement : response);
  }
  dispose(): Promise<void> {
    this.stopped = true;
    return this.closing ??= Promise.allSettled([...this.local.values()]).then(() => {});
  }

}

export class ProjectSessionOwnerCarrier {
  private readonly db;
  private stopped = false;
  private configurationPaused = false;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly running = new Map<string, Promise<Json>>();
  constructor(
    ledger: Pick<TaskLedger, "managementDatabase">,
    private readonly exchange: (input: ProjectSessionExchange) => Promise<unknown>,
    private readonly catalog: () => ProjectHostCatalog,
    private readonly execute: (request: ProjectOwnerRequest, callId: string) => Promise<unknown>,
  ) {
    this.db = ledger.managementDatabase();
    this.db.exec("CREATE TABLE IF NOT EXISTS project_session_owner_calls(id TEXT PRIMARY KEY,digest TEXT NOT NULL,request TEXT NOT NULL,result TEXT,part INTEGER NOT NULL DEFAULT 0,expires INTEGER)");
  }
  start(intervalMs = 250) {
    this.timer = setInterval(() => { void this.poll().catch(() => {}); }, Math.max(100, intervalMs));
    void this.poll().catch(() => {});
  }
  poll(): Promise<void> {
    if (this.stopped || this.configurationPaused) return Promise.resolve();
    return this.pending ??= this.receive().finally(() => { this.pending = undefined; });
  }
  async beginConfigurationEdit(): Promise<() => void> {
    if (this.stopped || this.configurationPaused || this.running.size)
      throw new TaskError("CONFIGURATION_BUSY", "Project session owner is active");
    this.configurationPaused = true;
    try {
      await this.pending?.catch(() => {});
      if (this.stopped) throw new TaskError("CONFIGURATION_BUSY", "Project session owner is stopping");
      this.expireReads();
      const unfinished = this.db.prepare("SELECT id,result,part FROM project_session_owner_calls").all()
        .some(row => row.result === null || Number(row.part) < fragments(String(row.result), String(row.id)).length);
      if (this.stopped || this.running.size || unfinished)
        throw new TaskError("CONFIGURATION_BUSY", "Project session owner has unfinished operations");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.configurationPaused = false;
      };
    } catch (error) {
      this.configurationPaused = false;
      throw error;
    }
  }
  private expireReads() {
    this.db.prepare("DELETE FROM project_session_owner_calls WHERE expires<=? AND result IS NOT NULL").run(Date.now());
  }
  private async receive() {
    this.expireReads();
    const pending = this.db.prepare("SELECT id,result,part FROM project_session_owner_calls WHERE result IS NOT NULL ORDER BY rowid").all()
      .find(row => Number(row.part) < fragments(String(row.result), String(row.id)).length);
    const pieces = pending ? fragments(String(pending.result), String(pending.id)) : [];
    const result = pending ? { callId: String(pending.id), index: Number(pending.part), count: pieces.length, digest: hash(String(pending.result)), text: pieces[Number(pending.part)]! } : undefined;
    const response = bounded(exchangeResult.parse(await this.exchange(bounded(result ? { result } : { catalog: this.catalog() }))));
    if (this.stopped) return;
    if (response.acknowledged && result && canonical(response.acknowledged) === canonical({ callId: result.callId, index: result.index, count: result.count, digest: result.digest }))
      this.db.prepare("UPDATE project_session_owner_calls SET part=MAX(part,?) WHERE id=?").run(result.index + 1, result.callId);
    if (!response.call || this.stopped || this.configurationPaused) return;
    const { callId, request } = response.call;
    await this.perform(request, callId).catch(() => {});
  }
  perform(request: ProjectOwnerRequest, callId: string): Promise<Json> {
    if (this.stopped) return Promise.reject(new TaskError("UNAVAILABLE", "Project session owner carrier is stopping"));
    if (this.configurationPaused) return Promise.reject(new TaskError("CONFIGURATION_BUSY", "Project session configuration is changing"));
    this.expireReads();
    const pending = this.running.get(callId);
    if (pending) return pending;
    const work = this.performOwned(ProjectOwnerRequest.parse(request), callId).finally(() => this.running.delete(callId));
    this.running.set(callId, work);
    return work;
  }
  acknowledgeLocalResult(callId: string, result: string): void {
    const row = this.db.prepare("SELECT result FROM project_session_owner_calls WHERE id=?").get(callId);
    if (row?.result === result)
      this.db.prepare("UPDATE project_session_owner_calls SET part=? WHERE id=?").run(fragments(result, callId).length, callId);
  }
  private async performOwned(request: ProjectOwnerRequest, callId: string): Promise<Json> {
    id.parse(callId);
    const digest = hash(canonical(request));
    const previous = this.db.prepare("SELECT digest,result FROM project_session_owner_calls WHERE id=?").get(callId);
    if (previous && previous.digest !== digest) throw new TaskError("CONFLICT", "Owner session request changed during retry");
    if (previous?.result) return unwrap(JSON.parse(String(previous.result)));
    let answer: Outcome;
    if (previous && request.kind === "native" && !safeNativeRetry(request.operation))
      answer = { kind: "error", code: "PROJECT_SESSION_UNCERTAIN" };
    else {
      const expires = request.kind === "native" && safeNativeRetry(request.operation) ? Date.now() + 120_000 : null;
      this.db.prepare("INSERT OR IGNORE INTO project_session_owner_calls(id,digest,request,result,expires) VALUES(?,?,?,NULL,?)").run(callId, digest, canonical(request), expires);
      try { answer = { kind: "value", value: json(await this.execute(request, callId)) }; }
      catch (error) {
        const code = errorCode(error);
        if (transientLifecycle(request, code)) throw new TaskError(code, "Project session owner is not ready; retry retains the original command");
        answer = { kind: "error", code };
      }
    }
    let encoded = canonical(answer);
    if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) encoded = canonical({ kind: "error", code: "PROJECT_SESSION_SIZE" });
    this.db.prepare("UPDATE project_session_owner_calls SET result=? WHERE id=?").run(encoded, callId);
    return unwrap(JSON.parse(encoded));
  }
  async dispose() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...(this.pending ? [this.pending] : []), ...this.running.values()]);
  }
}

function safeNativeRetry(operation: ProjectNativeOperation): boolean {
  return !projectNativeOperationWrites(operation);
}

function fragments(text: string, callId: string): string[] {
  const pieces: string[] = [];
  const overhead = Buffer.byteLength(JSON.stringify({ result: {
    callId, index: MAX_PARTS - 1, count: MAX_PARTS, digest: "0".repeat(64), text: "",
  } }));
  let current = "", bytes = 0, encodedBytes = overhead;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    const encodedSize = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > PART_BYTES || encodedBytes + encodedSize > MAX_PACKET_BYTES) {
      pieces.push(current); current = ""; bytes = 0; encodedBytes = overhead;
    }
    current += character; bytes += size; encodedBytes += encodedSize;
  }
  if (current || !pieces.length) pieces.push(current);
  return pieces;
}
