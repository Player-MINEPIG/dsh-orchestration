import { ExecutionDisposition, ExecutorAlertStore, type ExecutorAlert } from "../executor-alerts.js";
import { ExecutionCatalogDelivery } from "../execution-models.js";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { closeSync, mkdirSync, openSync } from "node:fs";
import {
  isTransientReceipt,
  TRANSIENT_RECEIPT_TTL_MS,
} from "../receipt-retention.js";
import {
  byteLimit,
  commandLane,
  COMMAND_LANES,
  canonical,
  DEFAULT_MAX_RESPONSE_BYTES,
  EXECUTOR_OPERATIONS,
  digest,
  insist,
  ProtocolError,
} from "./protocol.js";
import type { CommandEnvelope, Json } from "./protocol.js";
import type {
  Claim,
  ExecutionResult,
  LeaseRef,
  Receipt,
  ExecutorIdentity,
} from "./ports.js";

const localWorkspaceGrant = z
  .object({
    registryId: z.string().min(1).max(200),
    workspaceId: z.string().min(1).max(128),
    nodeId: z.string().min(1).max(128),
    label: z.string().min(1).max(500),
    path: z.string().min(1).max(4096),
    enabled: z.boolean(),
  })
  .strict();
const commandOperation = z.enum(EXECUTOR_OPERATIONS);
const localWorkspaceGrantState = z
  .object({
    revision: z.number().int().nonnegative(),
    grants: z.array(localWorkspaceGrant).max(64),
  })
  .strict();
export type LocalWorkspaceGrant = z.infer<typeof localWorkspaceGrant>;
export type LocalWorkspaceGrantState = z.infer<typeof localWorkspaceGrantState>;
export interface CommandReceipt {
  commandId: string;
  state: "pending" | "done" | "uncertain";
  result?: Json;
}
export interface DispatchRecord {
  attemptId: string;
  state:
    | "dispatching"
    | "result"
    | "acknowledged"
    | "uncertain"
    | "cancellation"
    | "cancelled"
    | "retry_pending"
    | "retry_scheduled";
  claim: Claim;
  lease: LeaseRef;
  sessionId: string;
  workspacePath?: string;
  result?: ExecutionResult;
  receipt?: Receipt;
  detail?: string;
  reconciliation?: { runState: "cancelled" | "failed"; observedAt: string };
}
/** One owner per file. SQLite FULL/WAL commits precede side effects and admission ACKs. */
export class RecoveryStore {
  private db: DatabaseSync;
  private closed = false;
  readonly instanceId: string;
  readonly executorAlerts:ExecutorAlertStore;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    this.db = new DatabaseSync(path);
    this.executorAlerts=new ExecutorAlertStore(this.db);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version,
    );
    insist(version === 0 || version === 1, "UNSUPPORTED_STORE_VERSION");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS peer_sequences (node TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admission_sequences (node TEXT NOT NULL,lane TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(node,lane));
      CREATE TABLE IF NOT EXISTS nonces (node TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(node,nonce));
      CREATE TABLE IF NOT EXISTS commands (node TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT, PRIMARY KEY(node,id));
      CREATE TABLE IF NOT EXISTS dispatches (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbound (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    this.transaction(() => {
      const rows = this.db.prepare(
        "SELECT p.node,p.sequence,MAX(a.sequence) AS laneMax FROM peer_sequences p LEFT JOIN admission_sequences a ON a.node=p.node GROUP BY p.node",
      ).all();
      const seed = this.db.prepare(
        "INSERT INTO admission_sequences(node,lane,sequence) VALUES(?,?,?) ON CONFLICT(node,lane) DO UPDATE SET sequence=MAX(admission_sequences.sequence,excluded.sequence)",
      );
      for (const row of rows) {
        if (row.laneMax !== null && Number(row.sequence) <= Number(row.laneMax)) continue;
        for (const lane of COMMAND_LANES) seed.run(String(row.node), lane, Number(row.sequence));
      }
    });
    // Existing receipts have unknown provenance and remain durable. Only new,
    // explicitly classified observations receive an expiry.
    this.transaction(() => {
      if (!this.db.prepare("PRAGMA table_info(commands)").all().some(row => row.name === "operation"))
        this.db.exec("ALTER TABLE commands ADD COLUMN operation TEXT");
      for (const table of ["commands", "outbound"]) {
        if (
          !this.db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .some((row) => row.name === "expires")
        )
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN expires INTEGER`);
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS ${table}_expiry ON ${table}(expires) WHERE expires IS NOT NULL`,
        );
      }
    });
    // This is a nonsecret execution-owner identity, never an authentication key.
    this.db
      .prepare(
        "INSERT OR IGNORE INTO metadata(key,value) VALUES('instanceId',?)",
      )
      .run(randomUUID());
    this.instanceId = String(
      this.db.prepare("SELECT value FROM metadata WHERE key='instanceId'").get()
        ?.value,
    );
    insist(/^[0-9a-f-]{36}$/.test(this.instanceId), "INVALID_STORE_IDENTITY");
  }
  workspaceGrantState(): LocalWorkspaceGrantState {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key='localWorkspaceGrants'")
      .get();
    return row
      ? localWorkspaceGrantState.parse(JSON.parse(String(row.value)))
      : { revision: 0, grants: [] };
  }
  setWorkspaceGrant(
    grant: LocalWorkspaceGrant,
    expectedRevision: number,
  ): LocalWorkspaceGrantState {
    return this.transaction(() => {
      const state = this.workspaceGrantState();
      insist(
        state.revision === expectedRevision,
        "WORKSPACE_GRANT_CONFLICT",
        409,
      );
      const previous = state.grants.find(
        (saved) => saved.workspaceId === grant.workspaceId,
      );
      insist(
        !previous ||
          (previous.path === grant.path &&
            previous.workspaceId === grant.workspaceId &&
            previous.nodeId === grant.nodeId),
        "WORKSPACE_GRANT_PATH_CHANGED",
        409,
      );
      if (previous && canonical(previous) === canonical(grant)) return state;
      const next = localWorkspaceGrantState.parse({
        revision: state.revision + 1,
        grants: [
          ...state.grants
            .filter((saved) => saved.workspaceId !== grant.workspaceId)
            .map((saved) =>
              saved.registryId === grant.registryId
                ? { ...saved, enabled: false }
                : saved,
            ),
          grant,
        ],
      });
      this.db
        .prepare(
          "INSERT INTO metadata(key,value) VALUES('localWorkspaceGrants',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(canonical(next));
      return next;
    });
  }
  /** Assigns only a display identity for an already-authorized node; never grants access. */
  executorIdentity(schedulerId: string, nodeId: string): ExecutorIdentity {
    return this.transaction(() => {
      const key = `executor:${schedulerId}:${nodeId}`;
      this.db
        .prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)")
        .run(key, `executor-${randomUUID()}`);
      return {
        schedulerId,
        nodeId,
        executorId: String(
          this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key)
            ?.value,
        ),
      };
    });
  }
  networkPairings(): { address: string; nodeId: string }[] {
    return this.db
      .prepare("SELECT key,value FROM metadata WHERE key LIKE 'network-peer:%'")
      .all()
      .map((row) => ({
        address: String(row.key).slice(13),
        nodeId: String(row.value),
      }));
  }
  bindNetworkPeer(address: string, nodeId: string): void {
    this.transaction(() => {
      const all = this.networkPairings(),
        prior = all.find((row) => row.address === address);
      insist(
        !prior || prior.nodeId === nodeId,
        "NETWORK_PEER_IDENTITY_CHANGED",
        403,
      );
      insist(
        !all.some((row) => row.nodeId === nodeId && row.address !== address),
        "NETWORK_NODE_ALREADY_BOUND",
        403,
      );
      this.db
        .prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)")
        .run(`network-peer:${address}`, nodeId);
    });
  }
  retainNetworkPeers(addresses: readonly string[]): void {
    for (const row of this.networkPairings())
      if (!addresses.includes(row.address))
        this.db
          .prepare("DELETE FROM metadata WHERE key=?")
          .run(`network-peer:${row.address}`);
  }
  catalogDelivery(nodeId: string): ExecutionCatalogDelivery | undefined {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(`catalog-delivery:${nodeId}`);
    return row
      ? ExecutionCatalogDelivery.parse(JSON.parse(String(row.value)))
      : undefined;
  }
  saveCatalogDelivery(
    nodeId: string,
    delivery: ExecutionCatalogDelivery | undefined,
  ): void {
    const key = `catalog-delivery:${nodeId}`;
    if (!delivery) {
      this.db.prepare("DELETE FROM metadata WHERE key=?").run(key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(delivery));
  }
  sessionMessageState(id: string):
    | {
        state: "started" | "result";
        result?: import("./ports.js").SessionMessageResult;
      }
    | undefined {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(`message:${id}`);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  saveSessionMessageState(
    id: string,
    value: {
      state: "started" | "result";
      result?: import("./ports.js").SessionMessageResult;
    },
  ) {
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(`message:${id}`, JSON.stringify(value));
  }
  schedulerMapping(binding: string): ExecutorIdentity | undefined {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(`scheduler:${binding}`);
    return row
      ? (JSON.parse(String(row.value)) as ExecutorIdentity)
      : undefined;
  }
  legacySchedulerIs(schedulerId: string, nodeId: string): boolean {
    const mappings = this.db
      .prepare("SELECT value FROM metadata WHERE key LIKE 'scheduler:%'")
      .all()
      .map((row) => JSON.parse(String(row.value)) as ExecutorIdentity);
    return (
      mappings.length > 0 &&
      mappings.every(
        (mapping) =>
          mapping.schedulerId === schedulerId && mapping.nodeId === nodeId,
      )
    );
  }
  sessionWorkspace(
    key: string,
  ): { path: string; projectId: string | null; root?: string } | undefined {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(`workspace:${key}`);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  rememberSessionWorkspace(
    key: string,
    value: { path: string; projectId: string | null; root?: string },
  ): void {
    this.transaction(() => {
      const prior = this.sessionWorkspace(key);
      insist(
        !prior || canonical(prior) === canonical(value),
        "SESSION_WORKSPACE_CHANGED",
        409,
      );
      this.db
        .prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)")
        .run(`workspace:${key}`, canonical(value));
    });
  }
  rememberScheduler(
    binding: string,
    identity: ExecutorIdentity,
  ): ExecutorIdentity {
    return this.transaction(() => {
      const prior = this.schedulerMapping(binding);
      insist(
        !prior || canonical(prior) === canonical(identity),
        "SCHEDULER_IDENTITY_CHANGED",
        409,
      );
      this.db
        .prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)")
        .run(`scheduler:${binding}`, canonical(identity));
      return identity;
    });
  }
  executionId(attemptId: string): string {
    return `exec-${digest([this.instanceId, attemptId])}`;
  }
  private transaction<T>(fn: () => T): T {
    insist(!this.closed, "STORE_CLOSED", 503);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Authenticated replay rejection and admission are committed together. */
  admit(envelope: CommandEnvelope, now: number): CommandReceipt | undefined {
    return this.transaction(() => {
      const { nodeId: node, nonce, sequence, commandId: id } = envelope;
      this.db.prepare("DELETE FROM nonces WHERE expires < ?").run(now);
      this.db.prepare("DELETE FROM commands WHERE expires <= ?").run(now);
      insist(
        !this.db
          .prepare("SELECT 1 FROM nonces WHERE node=? AND nonce=?")
          .get(node, nonce),
        "REPLAY",
        409,
      );
      const lane = commandLane(envelope.operation, envelope.payload);
      const baseline = Number(this.db.prepare("SELECT sequence FROM peer_sequences WHERE node=?").get(node)?.sequence ?? 0);
      const seed = this.db.prepare("INSERT OR IGNORE INTO admission_sequences(node,lane,sequence) VALUES(?,?,?)");
      for (const candidate of COMMAND_LANES) seed.run(node, candidate, baseline);
      const priorSequence = this.db
        .prepare("SELECT sequence FROM admission_sequences WHERE node=? AND lane=?")
        .get(node, lane);
      insist(
        sequence > Number(priorSequence?.sequence ?? 0),
        "OUT_OF_ORDER",
        409,
      );
      const hash = digest({
        operation: envelope.operation,
        payload: envelope.payload,
      });
      const existing = this.db
        .prepare(
          "SELECT digest,state,result FROM commands WHERE node=? AND id=?",
        )
        .get(node, id);
      insist(!existing || existing.digest === hash, "COMMAND_CONFLICT", 409);
      this.db
        .prepare("INSERT INTO nonces(node,nonce,expires) VALUES(?,?,?)")
        .run(node, nonce, envelope.expiresAt);
      this.db.prepare("UPDATE admission_sequences SET sequence=? WHERE node=? AND lane=?").run(sequence, node, lane);
      this.db
        .prepare(
          "INSERT INTO peer_sequences(node,sequence) VALUES(?,?) ON CONFLICT(node) DO UPDATE SET sequence=MAX(peer_sequences.sequence,excluded.sequence)",
        )
        .run(node, sequence);
      if (existing) {
        this.db.prepare("UPDATE commands SET operation=? WHERE node=? AND id=? AND operation IS NULL")
          .run(envelope.operation, node, id);
        return {
          commandId: id,
          state: existing.state as CommandReceipt["state"],
          ...(existing.result
            ? { result: JSON.parse(String(existing.result)) as Json }
            : {}),
        };
      }
      this.db
        .prepare(
          "INSERT INTO commands(node,id,digest,state,operation,expires) VALUES(?,?,?,?,?,?)",
        )
        .run(
          node,
          id,
          hash,
          "pending",
          envelope.operation,
          isTransientReceipt(envelope.operation, envelope.payload)
            ? now + TRANSIENT_RECEIPT_TTL_MS
            : null,
        );
      return undefined;
    });
  }
  complete(
    node: string,
    commandId: string,
    result: Json,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  ): void {
    const serialized = canonical(result);
    insist(
      Buffer.byteLength(serialized) <=
        byteLimit(maxBytes, DEFAULT_MAX_RESPONSE_BYTES),
      "RESULT_LIMIT",
    );
    const update = this.db
      .prepare(
        "UPDATE commands SET state='done',result=? WHERE node=? AND id=? AND state='pending'",
      )
      .run(serialized, node, commandId);
    insist(update.changes === 1, "RECEIPT_STATE", 409);
  }
  /** Native transaction owner proved no claim committed; retain same command for retry. */
  rejectClaim(node: string, commandId: string, code: string, message: string): CommandReceipt {
    const result = { claimRejected: { code: code.slice(0, 100), message: message.slice(0, 1000) } };
    const serialized = canonical(result);
    return this.transaction(() => {
      this.db.prepare("UPDATE commands SET state='pending',result=? WHERE node=? AND id=? AND state IN ('pending','uncertain')")
        .run(serialized, node, commandId);
      const current = this.receipt(node, commandId);
      insist(current, "RECEIPT_STATE", 409);
      return current;
    });
  }
  uncertain(node: string, commandId: string): void {
    this.db
      .prepare(
        "UPDATE commands SET state='uncertain' WHERE node=? AND id=? AND state='pending'",
      )
      .run(node, commandId);
  }
  /** Promote uncertainty only from the transaction owner's exact durable receipt. */
  resolve(
    node: string,
    commandId: string,
    receipt: Receipt,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  ): CommandReceipt {
    insist(
      receipt.commandId === `remote-${digest([node, commandId])}`,
      "LEDGER_RECEIPT_MISMATCH",
      409,
    );
    insist(
      typeof receipt.acceptedAt === "string" &&
        Number.isFinite(Date.parse(receipt.acceptedAt)) &&
        Object.hasOwn(receipt, "value"),
      "INVALID_LEDGER_RECEIPT",
      409,
    );
    const json = JSON.parse(JSON.stringify(receipt)) as Json;
    const serialized = canonical(json);
    insist(
      Buffer.byteLength(serialized) <=
        byteLimit(maxBytes, DEFAULT_MAX_RESPONSE_BYTES),
      "RESULT_LIMIT",
    );
    return this.transaction(() => {
      const update = this.db
        .prepare(
          "UPDATE commands SET state='done',result=? WHERE node=? AND id=? AND state IN ('pending','uncertain')",
        )
        .run(serialized, node, commandId);
      if (update.changes !== 1) {
        const current = this.receipt(node, commandId);
        // Concurrent reconciliation may have committed the same durable proof.
        insist(
          current?.state === "done" && canonical(current.result) === serialized,
          "RECEIPT_STATE",
          409,
        );
        return current;
      }
      return { commandId, state: "done", result: json };
    });
  }
  receipt(
    node: string,
    commandId: string,
    now?: number,
  ): CommandReceipt | undefined {
    const row = this.db
      .prepare(
        "SELECT state,result FROM commands WHERE node=? AND id=? AND (? IS NULL OR expires IS NULL OR expires > ?)",
      )
      .get(node, commandId, now ?? null, now ?? null);
    return row
      ? {
          commandId,
          state: row.state as CommandReceipt["state"],
          ...(row.result
            ? { result: JSON.parse(String(row.result)) as Json }
            : {}),
        }
      : undefined;
  }
  commandOperation(node: string, commandId: string) {
    const row = this.db.prepare("SELECT operation FROM commands WHERE node=? AND id=?").get(node, commandId);
    return row?.operation == null ? undefined : commandOperation.parse(row.operation);
  }
  createDispatch(record: DispatchRecord): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO dispatches(id,data) VALUES(?,?)")
        .run(record.attemptId, canonical(record)).changes === 1
    );
  }
  saveDispatch(record: DispatchRecord): void {
    insist(
      this.db
        .prepare("UPDATE dispatches SET data=? WHERE id=?")
        .run(canonical(record), record.attemptId).changes === 1,
      "DISPATCH_MISSING",
    );
  }
  dispatch(attemptId: string): DispatchRecord | undefined {
    const row = this.db
      .prepare("SELECT data FROM dispatches WHERE id=?")
      .get(attemptId);
    return row ? (JSON.parse(String(row.data)) as DispatchRecord) : undefined;
  }
  dispatches(): DispatchRecord[] {
    return this.db
      .prepare("SELECT data FROM dispatches ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.data)) as DispatchRecord);
  }
  /** Bounded operator view: active recovery first, then recently admitted local attempts. */
  panelDispatches(limit = 201): DispatchRecord[] {
    insist(Number.isSafeInteger(limit) && limit >= 1 && limit <= 201, "INVALID_RECOVERY_LIMIT");
    return this.db.prepare("SELECT data FROM dispatches ORDER BY CASE WHEN json_extract(data,'$.state') IN ('acknowledged','cancelled','retry_scheduled') THEN 1 ELSE 0 END, rowid DESC LIMIT ?")
      .all(limit).map(row => JSON.parse(String(row.data)) as DispatchRecord);
  }
  /** Project only receipt metadata, never outbound payloads or business content. */
  panelClaims(limit = 201) {
    insist(Number.isSafeInteger(limit) && limit >= 1 && limit <= 201, "INVALID_RECOVERY_LIMIT");
    return this.db.prepare("SELECT id AS commandId,json_extract(data,'$.payload.runId') AS runId,json_extract(data,'$.state') AS state,json_extract(data,'$.endpoint') AS endpoint,json_extract(data,'$.audience') AS audience,json_extract(data,'$.receipt.result.claimRejected.code') AS code,json_extract(data,'$.receipt.result.claimRejected.message') AS message FROM outbound WHERE json_extract(data,'$.operation')='claim' AND json_extract(data,'$.state') IN ('sending','pending','uncertain') ORDER BY rowid DESC LIMIT ?")
      .all(limit).flatMap(row => typeof row.runId === "string" && typeof row.state === "string" ? [{commandId:String(row.commandId),runId:row.runId,state:row.state,endpoint:String(row.endpoint ?? ""),audience:String(row.audience ?? ""),...(typeof row.code === "string" ? {code:row.code,message:String(row.message ?? "")} : {})}] : []);
  }
  dispatchAuthority(runId:string,attemptId:string) {
    const row=this.db.prepare("SELECT json_extract(data,'$.endpoint') AS endpoint,json_extract(data,'$.audience') AS audience FROM outbound WHERE json_extract(data,'$.operation')='claim' AND json_extract(data,'$.payload.runId')=? AND json_extract(data,'$.state')='done' AND json_extract(data,'$.receipt.result.value.attempt.attemptId')=? AND json_extract(data,'$.receipt.result.value.run.runId')=? ORDER BY rowid DESC LIMIT 1").get(runId,attemptId,runId);
    return row && typeof row.endpoint==="string" && typeof row.audience==="string" ? {endpoint:row.endpoint,audience:row.audience} : undefined;
  }
  executionObservation(recordId:string) {
    const row=this.db.prepare("SELECT value FROM metadata WHERE key=?").get(`disposition:${recordId}`);
    if(!row)return undefined;
    const value=JSON.parse(String(row.value));
    return {authority:String(value.authority),observedAt:Number(value.observedAt),value:ExecutionDisposition.parse(value.value)};
  }
  saveExecutionObservation(recordId:string,authority:string,value:ExecutionDisposition,now:number) {
    this.db.prepare("INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`disposition:${recordId}`,canonical({authority,observedAt:now,value}));
  }
  executorAlert(recordId:string,fingerprint:string,canAcknowledge:boolean):ExecutorAlert {return this.executorAlerts.alert(recordId,fingerprint,canAcknowledge);}
  setExecutorAlert(recordId:string,fingerprint:string,acknowledged:boolean) {this.executorAlerts.set(recordId,fingerprint,acknowledged);}
  /** A durable dispatch without a result is an uncertain side effect, never executable again. */
  recover(): DispatchRecord[] {
    return this.transaction(() => {
      this.db
        .prepare("UPDATE commands SET state='uncertain' WHERE state='pending'")
        .run();
      return this.recoverDispatchRows();
    });
  }
  recoverDispatches(): DispatchRecord[] {
    return this.transaction(() => this.recoverDispatchRows());
  }
  private recoverDispatchRows(): DispatchRecord[] {
    const records = this.dispatches();
    for (const record of records)
      if (record.state === "dispatching") {
        record.state = "uncertain";
        record.detail =
          "Host stopped after durable dispatch intent; execution outcome requires reconciliation";
        this.saveDispatch(record);
      }
    return records;
  }
  nextSequence(node: string): number {
    return this.transaction(() => {
      const key = `outbound:${node}`;
      const sequence =
        Number(
          this.db
            .prepare("SELECT sequence FROM peer_sequences WHERE node=?")
            .get(key)?.sequence ?? 0,
        ) + 1;
      insist(Number.isSafeInteger(sequence), "SEQUENCE_EXHAUSTED");
      this.db
        .prepare(
          "INSERT INTO peer_sequences(node,sequence) VALUES(?,?) ON CONFLICT(node) DO UPDATE SET sequence=excluded.sequence",
        )
        .run(key, sequence);
      return sequence;
    });
  }
  saveOutbound(id: string, data: Json, now = Date.now()): void {
    const operation =
      data && typeof data === "object" && !Array.isArray(data)
        ? data.operation
        : undefined;
    this.transaction(() => {
      this.db.prepare("DELETE FROM outbound WHERE expires <= ?").run(now);
      this.db
        .prepare(
          "INSERT INTO outbound(id,data,expires) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires=excluded.expires",
        )
        .run(
          id,
          canonical(data),
          isTransientReceipt(operation, data && typeof data === "object" && !Array.isArray(data) ? data.payload : undefined) ? now + TRANSIENT_RECEIPT_TTL_MS : null,
        );
    });
  }
  outbound(id: string, now?: number): Json | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM outbound WHERE id=? AND (? IS NULL OR expires IS NULL OR expires > ?)",
      )
      .get(id, now ?? null, now ?? null);
    return row ? (JSON.parse(String(row.data)) as Json) : undefined;
  }
  pendingObservations(
    limit = 32,
  ): { commandId: string; data: Record<string, Json> }[] {
    insist(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 128,
      "INVALID_RECOVERY_LIMIT",
    );
    return this.db
      .prepare(
        "SELECT id,data FROM outbound WHERE json_extract(data,'$.operation')='observe' AND json_extract(data,'$.state') IN ('sending','pending','uncertain') ORDER BY id LIMIT ?",
      )
      .all(limit)
      .map((row) => ({
        commandId: String(row.id),
        data: JSON.parse(String(row.data)) as Record<string, Json>,
      }));
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
