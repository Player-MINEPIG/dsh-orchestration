import type { ExecutorPanelRecord } from "../executor-panel.js";
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
export type RecoveryDispatchHeader = ExecutorPanelRecord & {sourceSeq:number;schedulerId?:string;receiptCommandId?:string;reportVersion?:string;hasReport?:number};
export interface RecoveryClaimHeader {commandId:string;runId:string;state:string;endpoint:string;audience:string;code?:string;message?:string;attemptId?:string;sourceSeq:number}
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
    this.preparePanelHeaders();
  }
  private preparePanelHeaders() {
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS recovery_panel_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO recovery_panel_revision VALUES(1,0);
        CREATE TABLE IF NOT EXISTS recovery_panel_retention(id INTEGER PRIMARY KEY CHECK(id=1),floor INTEGER NOT NULL);
        INSERT OR IGNORE INTO recovery_panel_retention VALUES(1,-1);
        CREATE TABLE IF NOT EXISTS recovery_panel_changes(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(kind,id));
        CREATE INDEX IF NOT EXISTS recovery_panel_change_revision ON recovery_panel_changes(revision,kind,id);
        CREATE TABLE IF NOT EXISTS recovery_dispatch_headers(id TEXT PRIMARY KEY,seq INTEGER NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,outcome TEXT,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS recovery_dispatch_run ON recovery_dispatch_headers(run_id,seq DESC);
        CREATE INDEX IF NOT EXISTS recovery_dispatch_state ON recovery_dispatch_headers(state,seq);
        CREATE TABLE IF NOT EXISTS recovery_claim_headers(id TEXT PRIMARY KEY,seq INTEGER NOT NULL,run_id TEXT NOT NULL,attempt_id TEXT,state TEXT NOT NULL,endpoint TEXT NOT NULL,audience TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS recovery_claim_run ON recovery_claim_headers(run_id,attempt_id,state,seq DESC);
        CREATE INDEX IF NOT EXISTS recovery_claim_state ON recovery_claim_headers(state,seq DESC);
        CREATE TABLE IF NOT EXISTS recovery_disposition_probes(record_id TEXT PRIMARY KEY,next_at REAL NOT NULL);`);
      const dispatch = (row:string) => `INSERT INTO recovery_dispatch_headers VALUES(${row}.id,${row}.rowid,COALESCE(json_extract(${row}.data,'$.claim.run.runId'),''),COALESCE(json_extract(${row}.data,'$.claim.task.taskId'),''),COALESCE(json_extract(${row}.data,'$.state'),''),json_extract(${row}.data,'$.result.outcome'),
        json_object('taskId',json_extract(${row}.data,'$.claim.task.taskId'),'runId',json_extract(${row}.data,'$.claim.run.runId'),
          'title',COALESCE(json_extract(${row}.data,'$.claim.task.title'),json_extract(${row}.data,'$.claim.run.taskId'),''),'description','',
          'state',json_extract(${row}.data,'$.state'),'source','local-recovery','nodeId',COALESCE(json_extract(${row}.data,'$.lease.nodeId'),json_extract(${row}.data,'$.claim.attempt.nodeId'),''),
          'time',COALESCE(json_extract(${row}.data,'$.receipt.acceptedAt'),json_extract(${row}.data,'$.claim.run.updatedAt'),''),
          'sessionIds',json(CASE WHEN COALESCE(json_extract(${row}.data,'$.sessionId'),'')='' THEN '[]' ELSE json_array(json_extract(${row}.data,'$.sessionId')) END),
          'executionDriver',CASE WHEN json_extract(${row}.data,'$.claim.run.route.backend') IS NOT NULL OR json_extract(${row}.data,'$.claim.run.route.execution') IS NOT NULL THEN 'external' ELSE 'dsh' END,
          'parentTaskId',json_extract(${row}.data,'$.claim.task.parentTaskId'),'parentRunId',json_extract(${row}.data,'$.claim.run.parentRunId'),
          'projectId',json_extract(${row}.data,'$.claim.run.projectContext.project.projectId'),'projectTitle',json_extract(${row}.data,'$.claim.run.projectContext.project.title'),
          'model',json_extract(${row}.data,'$.claim.run.route.model'),'workspaceId',json_extract(${row}.data,'$.claim.run.route.workspaceId'),
          'executionDirectory',json_extract(${row}.data,'$.workspacePath'),'detail',json_extract(${row}.data,'$.detail'),
          'report',substr(json_extract(${row}.data,'$.result.summary'),1,2000),'outcome',json_extract(${row}.data,'$.result.outcome'),
          'attemptId',${row}.id,'schedulerId',json_extract(${row}.data,'$.claim.run.projectContext.schedulerId'),
          'claimNodeId',json_extract(${row}.data,'$.claim.attempt.nodeId'),'hasProjectContext',CASE WHEN json_extract(${row}.data,'$.claim.run.projectContext') IS NULL THEN 0 ELSE 1 END,'receiptCommandId',json_extract(${row}.data,'$.receipt.commandId'),'sourceSeq',${row}.rowid,'reportVersion','local:'||(SELECT revision FROM recovery_panel_revision WHERE id=1),'hasReport',CASE WHEN COALESCE(json_extract(${row}.data,'$.result.report.body'),json_extract(${row}.data,'$.result.summary'),'')<>'' THEN 1 ELSE 0 END))
        ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,run_id=excluded.run_id,task_id=excluded.task_id,state=excluded.state,outcome=excluded.outcome,data=excluded.data;`;
      const claim = (row:string) => `INSERT INTO recovery_claim_headers SELECT ${row}.id,${row}.rowid,COALESCE(json_extract(${row}.data,'$.payload.runId'),''),json_extract(${row}.data,'$.receipt.result.value.attempt.attemptId'),COALESCE(json_extract(${row}.data,'$.state'),''),COALESCE(json_extract(${row}.data,'$.endpoint'),''),COALESCE(json_extract(${row}.data,'$.audience'),''),
        json_object('commandId',${row}.id,'runId',json_extract(${row}.data,'$.payload.runId'),'state',json_extract(${row}.data,'$.state'),
          'endpoint',COALESCE(json_extract(${row}.data,'$.endpoint'),''),'audience',COALESCE(json_extract(${row}.data,'$.audience'),''),
          'code',json_extract(${row}.data,'$.receipt.result.claimRejected.code'),'message',json_extract(${row}.data,'$.receipt.result.claimRejected.message'),
          'attemptId',json_extract(${row}.data,'$.receipt.result.value.attempt.attemptId'),'sourceSeq',${row}.rowid)
        WHERE json_extract(${row}.data,'$.operation')='claim'
        ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,run_id=excluded.run_id,attempt_id=excluded.attempt_id,state=excluded.state,endpoint=excluded.endpoint,audience=excluded.audience,data=excluded.data;`;
      for (const operation of ['INSERT','UPDATE','DELETE'] as const) for (const [table,kind] of [['dispatches','dispatch'],['outbound','claim']] as const) {
        const row=operation==='DELETE'?'OLD':'NEW';
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS recovery_panel_${table}_${operation} AFTER ${operation} ON ${table} ${table==='outbound'?`WHEN json_extract(${row}.data,'$.operation')='claim'`:''} BEGIN
          UPDATE recovery_panel_revision SET revision=revision+1 WHERE id=1;
          ${operation==='DELETE'?`DELETE FROM recovery_${kind}_headers WHERE id=OLD.id;`:kind==='dispatch'?dispatch(row):`DELETE FROM recovery_claim_headers WHERE id=NEW.id; ${claim(row)}`}
          INSERT INTO recovery_panel_changes VALUES('${kind}',${row}.id,(SELECT revision FROM recovery_panel_revision WHERE id=1)) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision;
          DELETE FROM recovery_disposition_probes WHERE record_id='${kind}:'||${row}.id;
        END;`);
      }
      for (const operation of ['INSERT','UPDATE','DELETE'] as const) {
        const row=operation==='DELETE'?'OLD':'NEW';
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS recovery_panel_alert_${operation} AFTER ${operation} ON executor_alert_dispositions BEGIN
          UPDATE recovery_panel_revision SET revision=revision+1 WHERE id=1;
          INSERT INTO recovery_panel_changes VALUES('alert',${row}.record,(SELECT revision FROM recovery_panel_revision WHERE id=1)) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision;
        END;`);
      }
      if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='panelHeadersV1'").get()) {
        for (const row of this.db.prepare('SELECT id FROM dispatches ORDER BY rowid').all()) {
          this.db.prepare('UPDATE dispatches SET data=data WHERE id=?').run(String(row.id));
        }
        for (const row of this.db.prepare("SELECT id FROM outbound WHERE json_extract(data,'$.operation')='claim' ORDER BY rowid").all()) {
          this.db.prepare('UPDATE outbound SET data=data WHERE id=?').run(String(row.id));
        }
        this.db.prepare("INSERT INTO metadata VALUES('panelHeadersV1','1')").run();
      }
    });
  }
  get panelReadRevision() {return Number(this.db.prepare('SELECT revision FROM recovery_panel_revision WHERE id=1').get()?.revision??0);}
  acknowledgePanelChanges(revision:number) {this.db.prepare('UPDATE recovery_panel_retention SET floor=MAX(floor,?) WHERE id=1').run(revision);this.db.prepare('DELETE FROM recovery_panel_changes WHERE revision<=?').run(revision);}
  panelChangesSince(revision:number) {if(revision<Number(this.db.prepare('SELECT floor FROM recovery_panel_retention WHERE id=1').get()?.floor??-1))return [{kind:'rebuild',id:''}];return this.db.prepare('SELECT kind,id FROM recovery_panel_changes WHERE revision>? ORDER BY revision,kind,id').all(revision).map(row=>({kind:String(row.kind),id:String(row.id)}));}
  dispatchHeader(attemptId:string):RecoveryDispatchHeader|undefined {const row=this.db.prepare('SELECT data FROM recovery_dispatch_headers WHERE id=?').get(attemptId);return row?JSON.parse(String(row.data)):undefined;}
  activeDispatchHeaders():RecoveryDispatchHeader[] {return this.db.prepare("SELECT data FROM recovery_dispatch_headers WHERE state NOT IN ('acknowledged','cancelled','retry_scheduled') ORDER BY seq").all().map(row=>JSON.parse(String(row.data)));}
  dispatchHeaders():RecoveryDispatchHeader[] {return this.db.prepare('SELECT data FROM recovery_dispatch_headers ORDER BY seq').all().map(row=>JSON.parse(String(row.data)));}
  claimHeader(commandId:string):RecoveryClaimHeader|undefined {const row=this.db.prepare('SELECT data FROM recovery_claim_headers WHERE id=?').get(commandId);return row?JSON.parse(String(row.data)):undefined;}
  claimHeaders():RecoveryClaimHeader[] {return this.db.prepare("SELECT data FROM recovery_claim_headers WHERE state IN ('sending','pending','uncertain') ORDER BY seq DESC").all().map(row=>JSON.parse(String(row.data)));}
  sessionDispatch(sessionId:string,taskId:string,workspaceId:string):DispatchRecord|undefined {
    const row=this.db.prepare("SELECT id FROM recovery_dispatch_headers WHERE json_extract(data,'$.sessionIds[0]')=? AND task_id=? AND json_extract(data,'$.workspaceId')=? ORDER BY id LIMIT 1").get(sessionId,taskId,workspaceId);
    return row?this.dispatch(String(row.id)):undefined;
  }
  hasLegacySessionMapping(sessionId:string,taskId:string,nodeId:string):boolean {
    return !!this.db.prepare("SELECT 1 FROM recovery_dispatch_headers WHERE json_extract(data,'$.sessionIds[0]')=? AND task_id=? AND json_extract(data,'$.claimNodeId')=? AND json_extract(data,'$.hasProjectContext')=0 LIMIT 1").get(sessionId,taskId,nodeId);
  }
  dispatchCandidates(states:readonly DispatchRecord['state'][]):DispatchRecord[] {
    if(!states.length)return [];
    return this.db.prepare(`SELECT d.data FROM dispatches d JOIN recovery_dispatch_headers h ON h.id=d.id WHERE h.state IN (${states.map(()=>'?').join(',')}) ORDER BY h.seq`)
      .all(...states).map(row=>JSON.parse(String(row.data)) as DispatchRecord);
  }
  dispositionCandidates(endpoint:string,audience:string,now:number,limit=4,excludedRunIds:readonly string[]=[]) {
    return this.db.prepare(`WITH candidates(record_id,run_id,attempt_id,scheduler_id,endpoint,audience,seq) AS (
      SELECT 'dispatch:'||d.id,d.run_id,d.id,json_extract(d.data,'$.schedulerId'),c.endpoint,c.audience,d.seq FROM recovery_dispatch_headers d
        JOIN recovery_claim_headers c ON c.run_id=d.run_id AND c.attempt_id=d.id AND c.state='done'
        WHERE d.state='acknowledged' AND d.outcome IN ('failure','blocked','partial','unknown') AND c.endpoint=? AND c.audience=?
      UNION SELECT 'claim:'||id,run_id,NULL,NULL,endpoint,audience,seq FROM recovery_claim_headers WHERE state IN ('sending','pending','uncertain') AND endpoint=? AND audience=?)
      SELECT c.* FROM candidates c LEFT JOIN recovery_disposition_probes p ON p.record_id=c.record_id
      WHERE COALESCE(p.next_at,0)<=? ${excludedRunIds.length?`AND c.run_id NOT IN (${excludedRunIds.map(()=>'?').join(',')})`:''} ORDER BY COALESCE(p.next_at,0),c.seq,c.record_id LIMIT ?`).all(endpoint,audience,endpoint,audience,now,...excludedRunIds,limit)
      .map(row=>({recordId:String(row.record_id),runId:String(row.run_id),attemptId:row.attempt_id?String(row.attempt_id):undefined,schedulerId:row.scheduler_id?String(row.scheduler_id):undefined,authority:{endpoint:String(row.endpoint),audience:String(row.audience)}}));
  }
  markDispositionProbe(recordId:string,nextAt:number) {this.db.prepare('INSERT INTO recovery_disposition_probes VALUES(?,?) ON CONFLICT(record_id) DO UPDATE SET next_at=excluded.next_at').run(recordId,nextAt);}
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
    const row=this.db.prepare("SELECT endpoint,audience FROM recovery_claim_headers WHERE run_id=? AND attempt_id=? AND state='done' ORDER BY seq DESC LIMIT 1").get(runId,attemptId);
    return row?{endpoint:String(row.endpoint),audience:String(row.audience)}:undefined;
  }
  executionObservation(recordId:string) {
    const row=this.db.prepare("SELECT value FROM metadata WHERE key=?").get(`disposition:${recordId}`);
    if(!row)return undefined;
    const value=JSON.parse(String(row.value));
    return {authority:String(value.authority),observedAt:Number(value.observedAt),value:ExecutionDisposition.parse(value.value)};
  }
  saveExecutionObservation(recordId:string,authority:string,value:ExecutionDisposition,now:number) {
    this.db.prepare('UPDATE recovery_panel_revision SET revision=revision+1 WHERE id=1').run();
    this.db.prepare("INSERT INTO recovery_panel_changes VALUES('observation',?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision").run(recordId,this.panelReadRevision);
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
    const records = this.dispatchCandidates(["dispatching","result","cancellation","retry_pending","uncertain"]);
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
