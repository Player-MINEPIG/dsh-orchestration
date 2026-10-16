import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateResultValidationFailure } from "./remote/protocol.js";
import type { LeaseRef, Receipt, Run, Settlement } from "./contracts.js";

/** Only the trusted native owner can attest these facts, after disposal and flush.
 * Tool submissions and reconstructed session logs are never ready results.
 */
export interface NativeReadyResult {
  commandId: string;
  ref: LeaseRef & { executionId: string };
  sessionId: string;
  readyAt: number;
  settlement: Settlement;
  quiescent: true;
  sessionPersisted: true;
}
export type NativeJournalState = "ready" | "committed" | "held" | "rejected";
export interface NativeJournalEntry extends NativeReadyResult {
  digest: string;
  state: NativeJournalState;
  receipt?: Receipt<Run>;
  reasonCode?: string;
}
export interface NativeResultJournalOptions {
  maxEntries?: number;
  /** Total UTF-8 bytes of retained ready payloads, receipts and reason codes. */
  maxBytes?: number;
  maxEntryBytes?: number;
  busyTimeoutMs?: number;
}

export class NativeJournalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeJournalError";
  }
}
function fail(code: string, message: string): never {
  throw new NativeJournalError(code, message);
}
function integer(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail("INVALID", `Invalid ${label}`);
  return value;
}
function identifier(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[\w][\w:./@-]*$/.test(value)
  )
    fail("INVALID", `Invalid ${label}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("INVALID", "Unexpected ready-result field");
}

/** Bounded, strict JSON canonicalization. No accessors, toJSON, or file reads. */
function canonical(value: unknown, maxBytes: number): string {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const add = (part: string) => {
    bytes += Buffer.byteLength(part, "utf8");
    if (bytes > maxBytes) fail("TOO_LARGE", "Journal entry exceeds byte limit");
    return part;
  };
  function visit(item: unknown, depth: number): string {
    if (++nodes > 100_000 || depth > 64)
      fail("TOO_LARGE", "Journal entry exceeds structural limit");
    if (item === null) return add("null");
    if (typeof item === "string") {
      if (item.length > maxBytes)
        fail("TOO_LARGE", "Journal entry exceeds byte limit");
      return add(JSON.stringify(item));
    }
    if (typeof item === "boolean") return add(JSON.stringify(item));
    if (typeof item === "number" && Number.isFinite(item))
      return add(JSON.stringify(item));
    if (typeof item !== "object" || item === null)
      return fail("INVALID", "Journal values must be JSON");
    if (ancestors.has(item)) fail("INVALID", "Cyclic journal value");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const parts = [add("[")];
        for (let i = 0; i < item.length; i++) {
          const property = Object.getOwnPropertyDescriptor(item, String(i));
          if (!property || !("value" in property))
            fail("INVALID", "Journal arrays must contain JSON values");
          if (i) parts.push(add(","));
          parts.push(visit(property.value, depth + 1));
        }
        parts.push(add("]"));
        return parts.join("");
      }
      if (!record(item)) fail("INVALID", "Journal values must be plain JSON");
      const parts = [add("{")];
      let first = true;
      for (const key of Object.keys(item).sort()) {
        const property = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in property))
          fail("INVALID", "Journal values cannot contain accessors");
        // Match the authority's canonical command encoding for optional fields.
        if (property.value === undefined) continue;
        if (!first) parts.push(add(","));
        first = false;
        parts.push(
          add(JSON.stringify(key)),
          add(":"),
          visit(property.value, depth + 1),
        );
      }
      parts.push(add("}"));
      return parts.join("");
    } finally {
      ancestors.delete(item);
    }
  }
  return visit(value, 0);
}
const digest = (json: string) =>
  createHash("sha256").update(json).digest("hex");
function validateReady(value: unknown): asserts value is NativeReadyResult {
  if (!record(value)) fail("INVALID", "Invalid ready result");
  exactKeys(value, [
    "commandId",
    "ref",
    "sessionId",
    "readyAt",
    "settlement",
    "quiescent",
    "sessionPersisted",
  ]);
  identifier(value.commandId, "commandId");
  identifier(value.sessionId, "sessionId");
  integer(value.readyAt as number, 0, 8_640_000_000_000_000, "readyAt");
  if (value.quiescent !== true || value.sessionPersisted !== true)
    fail("NOT_READY", "Native agent must be disposed and its session flushed");
  const ref = value.ref;
  if (!record(ref)) fail("INVALID", "Invalid native lease reference");
  exactKeys(ref, ["runId", "attemptId", "nodeId", "fence", "executionId"]);
  for (const key of ["runId", "attemptId", "nodeId", "executionId"])
    identifier(ref[key], key);
  integer(ref.fence as number, 1, Number.MAX_SAFE_INTEGER, "lease fence");
  const settlement = value.settlement;
  if (!record(settlement)) fail("INVALID", "Invalid native settlement");
  exactKeys(settlement, [
    "runId",
    "attemptId",
    "nodeId",
    "fence",
    "executionId",
    "outcome",
    "summary",
    "resultValidationFailure",
    "report",
    "notifications",
  ]);
  if (settlement.resultValidationFailure !== undefined) {
    try { validateResultValidationFailure(settlement.resultValidationFailure); } catch { fail("INVALID", "Invalid result rejection attestation"); }
    if (settlement.outcome !== "failure" || settlement.report !== undefined || (settlement.resultValidationFailure as {sessionId:string}).sessionId !== value.sessionId)
      fail("INVALID", "Result rejection does not match native session");
  }
  for (const key of ["runId", "attemptId", "nodeId", "fence", "executionId"])
    if (settlement[key] !== ref[key])
      fail("INVALID", "Settlement must match the exact native lease");
  if (
    !["success", "partial", "failure", "blocked", "unknown"].includes(
      settlement.outcome as string,
    ) ||
    typeof settlement.summary !== "string" ||
    !settlement.summary.trim() ||
    settlement.summary.length > 5000
  )
    fail("INVALID", "Invalid native terminal outcome");
}
interface Row {
  command_id: string;
  digest: string;
  ready_json: string;
  state: NativeJournalState;
  receipt_json: string | null;
  reason_code: string | null;
  bytes: number;
}

/** Independent durability boundary: never opens or locks the authority ledger.
 * Retained rows are not evicted, so a full journal fails closed instead of losing
 * a terminal receipt or forgetting an idempotency conflict. No staged state exists.
 */
export class NativeResultJournal {
  private readonly db: DatabaseSync;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private closed = false;

  static open(path: string, options: NativeResultJournalOptions = {}) {
    return new NativeResultJournal(path, options);
  }
  constructor(path: string, options: NativeResultJournalOptions = {}) {
    this.maxEntries = integer(
      options.maxEntries ?? 1024,
      1,
      100_000,
      "entry limit",
    );
    this.maxBytes = integer(
      options.maxBytes ?? 32 * 1024 * 1024,
      1024,
      256 * 1024 * 1024,
      "journal byte limit",
    );
    this.maxEntryBytes = integer(
      options.maxEntryBytes ?? Math.min(4 * 1024 * 1024, this.maxBytes),
      512,
      this.maxBytes,
      "entry byte limit",
    );
    const timeout = integer(
      options.busyTimeoutMs ?? 1000,
      0,
      5000,
      "busy timeout",
    );
    if (
      typeof path !== "string" ||
      !path ||
      path === ":memory:" ||
      path.includes("\0")
    )
      fail("INVALID", "Native result journal requires a durable file path");
    const file = resolve(path);
    const firstDirectory = mkdirSync(dirname(file), {
      recursive: true,
      mode: 0o700,
    });
    let created = false;
    try {
      closeSync(openSync(file, "wx", 0o600));
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(file).isFile())
        fail("INVALID", "Journal path must be a regular file");
    }
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`
        PRAGMA busy_timeout=${timeout};
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA wal_autocheckpoint=64;
        PRAGMA journal_size_limit=1048576;
        CREATE TABLE IF NOT EXISTS native_journal_meta(version INTEGER NOT NULL);
        INSERT INTO native_journal_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM native_journal_meta);
        CREATE TABLE IF NOT EXISTS native_results(
          command_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          digest TEXT NOT NULL,
          ready_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('ready','committed','held','rejected')),
          receipt_json TEXT,
          reason_code TEXT,
          bytes INTEGER NOT NULL,
          UNIQUE(attempt_id, execution_id)
        );
      `);
      const schema = this.db
        .prepare("SELECT version FROM native_journal_meta")
        .all() as { version: number }[];
      if (schema.length !== 1 || schema[0]?.version !== 1)
        fail("SCHEMA", "Unsupported native result journal schema");
      // SQLite FULL flushes its WAL. Windows cannot fsync a directory through
      // Node; flush the database with a writable file handle instead. This does
      // not claim POSIX directory-entry durability on Windows. All I/O failures
      // still propagate; other platforms retain the directory sync below.
      if (created || firstDirectory) {
        if (process.platform === "win32") {
          const fd = openSync(file, "r+");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } else {
          const stop = firstDirectory
            ? dirname(resolve(firstDirectory))
            : dirname(file);
          let directory = dirname(file);
          for (;;) {
            const fd = openSync(directory, "r");
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
            if (directory === stop) break;
            directory = dirname(directory);
          }
        }
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private assertOpen() {
    if (this.closed) fail("CLOSED", "Native result journal is closed");
  }
  private transaction<T>(fn: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private row(commandId: string): Row | undefined {
    return this.db
      .prepare("SELECT * FROM native_results WHERE command_id=?")
      .get(commandId) as Row | undefined;
  }
  private decode(row: Row): NativeJournalEntry {
    if (digest(row.ready_json) !== row.digest)
      fail("CORRUPT", "Native result journal digest mismatch");
    const value: unknown = JSON.parse(row.ready_json);
    validateReady(value);
    if (value.commandId !== row.command_id)
      fail("CORRUPT", "Native result journal identity mismatch");
    return {
      ...value,
      digest: row.digest,
      state: row.state,
      ...(row.receipt_json
        ? { receipt: JSON.parse(row.receipt_json) as Receipt<Run> }
        : {}),
      ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
    };
  }
  private capacity(extraEntries: number, extraBytes: number) {
    const usage = this.db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM native_results",
      )
      .get() as { count: number; bytes: number };
    if (
      usage.count + extraEntries > this.maxEntries ||
      usage.bytes + extraBytes > this.maxBytes
    )
      fail(
        "FULL",
        "Native result journal capacity exhausted; retained results were not removed",
      );
  }
  ready(input: NativeReadyResult): NativeJournalEntry {
    this.assertOpen();
    // Canonicalize before inspecting fields so caller accessors never run.
    const json = canonical(input, this.maxEntryBytes);
    const exact: unknown = JSON.parse(json);
    validateReady(exact);
    const key = digest(json);
    return this.transaction(() => {
      const old = this.row(exact.commandId);
      if (old) {
        if (old.digest !== key)
          fail(
            "CONFLICT",
            "Terminal command reused with a different ready result",
          );
        return this.decode(old);
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM native_results WHERE attempt_id=? AND execution_id=?",
          )
          .get(exact.ref.attemptId, exact.ref.executionId)
      )
        fail("CONFLICT", "Native execution already has a terminal command");
      const bytes = Buffer.byteLength(json, "utf8");
      this.capacity(1, bytes);
      this.db
        .prepare(
          "INSERT INTO native_results(command_id,attempt_id,execution_id,digest,ready_json,state,bytes) VALUES(?,?,?,?,?,'ready',?)",
        )
        .run(
          exact.commandId,
          exact.ref.attemptId,
          exact.ref.executionId,
          key,
          json,
          bytes,
        );
      return this.decode(this.row(exact.commandId)!);
    });
  }
  get(commandId: string): NativeJournalEntry | undefined {
    this.assertOpen();
    identifier(commandId, "commandId");
    const row = this.row(commandId);
    return row ? this.decode(row) : undefined;
  }
  /** Held rows retain ready proof and are retryable; rejected rows require review. */
  pending(): NativeJournalEntry[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        "SELECT * FROM native_results WHERE state IN ('ready','held') ORDER BY rowid",
      )
      .all() as unknown as Row[];
    return rows.map((row) => this.decode(row));
  }
  markCommitted(commandId: string, receipt: Receipt<Run>): NativeJournalEntry {
    const json = canonical(receipt, this.maxEntryBytes);
    const exact = JSON.parse(json) as Receipt<Run>;
    if (
      !record(exact) ||
      exact.commandId !== commandId ||
      typeof exact.acceptedAt !== "string" ||
      !Number.isFinite(Date.parse(exact.acceptedAt)) ||
      !record(exact.value)
    )
      fail("INVALID", "Invalid authoritative settlement receipt");
    return this.finish(commandId, "committed", json, null);
  }
  hold(commandId: string, reasonCode: string): NativeJournalEntry {
    return this.withReason(commandId, "held", reasonCode);
  }
  reject(commandId: string, reasonCode: string): NativeJournalEntry {
    return this.withReason(commandId, "rejected", reasonCode);
  }
  private withReason(
    commandId: string,
    state: "held" | "rejected",
    reasonCode: string,
  ) {
    if (
      typeof reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)
    )
      fail(
        "INVALID",
        "Journal reason must be a bounded code, not error or session text",
      );
    return this.finish(commandId, state, null, reasonCode);
  }
  private finish(
    commandId: string,
    state: NativeJournalState,
    receipt: string | null,
    reason: string | null,
  ): NativeJournalEntry {
    identifier(commandId, "commandId");
    return this.transaction(() => {
      const row =
        this.row(commandId) ??
        fail("NOT_FOUND", "Native terminal result not found");
      const entry = this.decode(row);
      if (row.state === "committed" || row.state === "rejected") {
        if (
          row.state !== state ||
          row.receipt_json !== receipt ||
          row.reason_code !== reason
        )
          fail("CONFLICT", "Native terminal result is already finalized");
        return entry;
      }
      if (
        receipt &&
        (JSON.parse(receipt) as Receipt<Run>).value.runId !== entry.ref.runId
      )
        fail("INVALID", "Authoritative receipt belongs to another run");
      if (
        row.state === state &&
        row.receipt_json === receipt &&
        row.reason_code === reason
      )
        return entry;
      const extra =
        Buffer.byteLength(receipt ?? "", "utf8") +
        Buffer.byteLength(reason ?? "", "utf8") -
        Buffer.byteLength(row.reason_code ?? "", "utf8");
      this.capacity(0, extra);
      this.db
        .prepare(
          "UPDATE native_results SET state=?,receipt_json=?,reason_code=?,bytes=bytes+? WHERE command_id=?",
        )
        .run(state, receipt, reason, extra, commandId);
      return this.decode(this.row(commandId)!);
    });
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
