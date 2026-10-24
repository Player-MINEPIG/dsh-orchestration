import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import {
  nativeProjectSession, projectSessionContinuation, projectContinuationDigest, projectSessionDecision, projectSessionEvidence, projectSessionReference, projectSessionStatus,
  sameProjectSession, type NativeProjectSession, type ProjectSessionCommand, type ProjectSessionDecision,
  type ProjectSessionEvidence, type ProjectSessionContinuation,
} from "./project-session-protocol.js";

export const projectSessionMove = z.object({
  operationId: z.string().min(1).max(200), projectId: z.string().min(1).max(200),
  expectedRevision: z.number().int().nonnegative(), old: projectSessionReference,
  sessionId: z.string().min(1).max(200),
  selection: z.object({ nodeId: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200), workspaceRevision: z.string().min(1).max(200) }).strict(),
  allowedNodeIds: z.array(z.string().min(1).max(200)).nullable(),
  executionBindings: z.record(z.string().min(1).max(200), z.string().min(1).max(200)),
}).strict();
export type ProjectSessionMove = z.infer<typeof projectSessionMove>;
const placementRecord = z.object({
  request: projectSessionMove, state: z.enum(["preparing", "committed", "complete", "aborting", "aborted"]),
  continuation: projectSessionContinuation.nullable().default(null), prepared: projectSessionEvidence.nullable(), frozen: projectSessionEvidence.nullable(), decision: projectSessionDecision.nullable(),
}).strict();
export type ProjectSessionPlacement = z.infer<typeof placementRecord>;
export interface ProjectSessionsPorts {
  owner(nodeId: string, command: ProjectSessionCommand): Promise<unknown>;
  checkCurrent(request: ProjectSessionMove): void;
  commit(request: ProjectSessionMove, next: NativeProjectSession): void;
  continuation?(request: ProjectSessionMove): Promise<ProjectSessionContinuation>;
}

export class ProjectSessions {
  private readonly db;
  private readonly pending = new Map<string, Promise<ProjectSessionPlacement>>();
  constructor(ledger: Pick<TaskLedger, "managementDatabase">, private readonly ports: ProjectSessionsPorts) {
    this.db = ledger.managementDatabase();
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_session_placements(operation TEXT PRIMARY KEY,project TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS project_session_placement_active ON project_session_placements(project) WHERE state IN ('preparing','committed','aborting');`);
  }
  status(operationId: string): ProjectSessionPlacement | undefined {
    const row = this.db.prepare("SELECT data FROM project_session_placements WHERE operation=?").get(operationId);
    return row ? placementRecord.parse(JSON.parse(String(row.data))) : undefined;
  }
  decision(operationId: string): ProjectSessionDecision | undefined { return this.status(operationId)?.decision ?? undefined; }
  outstanding(): ProjectSessionPlacement[] {
    return this.db.prepare("SELECT data FROM project_session_placements WHERE state IN ('preparing','committed','aborting') ORDER BY rowid").all().map(row => placementRecord.parse(JSON.parse(String(row.data))));
  }
  private save(record: ProjectSessionPlacement): ProjectSessionPlacement {
    const parsed = placementRecord.parse(record);
    this.db.prepare("INSERT INTO project_session_placements VALUES(?,?,?,?) ON CONFLICT(operation) DO UPDATE SET state=excluded.state,data=excluded.data")
      .run(parsed.request.operationId, parsed.request.projectId, parsed.state, canonical(parsed));
    return parsed;
  }
  async move(input: unknown): Promise<ProjectSessionPlacement> {
    const request = projectSessionMove.parse(input);
    if (request.projectId !== request.old.projectId || request.old.sessionId === request.sessionId)
      throw new TaskError("INVALID", "A placement must retain its project and mint a new session identity");
    const previous = this.status(request.operationId);
    if (previous && canonical(previous.request) !== canonical(request)) throw new TaskError("CONFLICT", "Placement retry changed its immutable request");
    const running = this.pending.get(request.operationId);
    if (running) return running;
    let record = previous;
    if (!record) {
      this.ports.checkCurrent(request);
      if (this.outstanding().some(item => item.request.projectId === request.projectId)) throw new TaskError("BUSY", "Project location change is already pending");
      record = this.save({ request, state: "preparing", continuation: null, prepared: null, frozen: null, decision: null });
    }
    const operation = this.drive(record).catch(async error => {
      if (!(error instanceof TaskError) || !["BUSY", "WORKSPACE_POLICY", "FORBIDDEN", "INVALID", "CONFLICT", "PROJECT_SESSION_SIZE"].includes(error.code)) throw error;
      const current = this.status(request.operationId);
      if (current?.state === "preparing") {
        const next = current.prepared ? nativeProjectSession.parse(current.prepared.binding) : null;
        const aborted = this.save({ ...current, state: "aborting", decision: { outcome: "abort", operationId: request.operationId, projectId: request.projectId, old: request.old, next } });
        await this.resolveAbort(aborted);
        const resolved = this.status(request.operationId);
        if (resolved) this.save({ ...resolved, state: "aborted" });
      }
      throw error;
    });
    this.pending.set(request.operationId, operation);
    try { return await operation; }
    finally { if (this.pending.get(request.operationId) === operation) this.pending.delete(request.operationId); }
  }
  private async receipt(nodeId: string, command: ProjectSessionCommand, kind: ProjectSessionEvidence["kind"], binding?: NativeProjectSession): Promise<ProjectSessionEvidence> {
    const result = projectSessionStatus.parse(await this.ports.owner(nodeId, command));
    if (result.kind !== kind || !("evidenceId" in result) || result.operationId !== command.operationId || result.binding.nodeId !== nodeId || binding && !sameProjectSession(result.binding, binding))
      throw new TaskError("UNAVAILABLE", "Owner has not supplied the required durable placement evidence");
    return result;
  }
  private async drive(initial: ProjectSessionPlacement): Promise<ProjectSessionPlacement> {
    let record = initial;
    const { request } = record;
    if (record.state === "complete" || record.state === "aborted") return record;
    if (record.state === "aborting") { await this.resolveAbort(record); return this.save({ ...(this.status(request.operationId) ?? record), state: "aborted" }); }
    if (record.state === "preparing") {
      if (!record.prepared) {
        const prepared = await this.receipt(request.selection.nodeId, {
          kind: "prepare", operationId: request.operationId, projectId: request.projectId,
          generation: request.old.generation + 1, sessionId: request.sessionId,
          workspaceId: request.selection.workspaceId, workspaceRevision: request.selection.workspaceRevision,
        }, "prepared");
        const binding = nativeProjectSession.parse(prepared.binding);
        if (binding.projectId !== request.projectId || binding.generation !== request.old.generation + 1 || binding.sessionId !== request.sessionId || binding.workspaceId !== request.selection.workspaceId || binding.workspaceRevision !== request.selection.workspaceRevision)
          throw new TaskError("FORBIDDEN", "Prepared owner session changed its requested identity");
        record = this.save({ ...record, prepared });
      }
      if (!record.frozen) {
        const frozen = await this.receipt(request.old.nodeId, { kind: "freeze", operationId: request.operationId, binding: request.old }, "frozen");
        if (!sameProjectSession(frozen.binding, request.old)) throw new TaskError("FORBIDDEN", "Frozen owner session does not match the old generation");
        record = this.save({ ...record, frozen });
      }
      if (this.ports.continuation) {
        if (!record.continuation) record = this.save({ ...record, continuation: projectSessionContinuation.parse(await this.ports.continuation(request)) });
        if (!record.continuation) throw new TaskError("CONFLICT", "Placement continuation is unavailable");
        const prepared = await this.receipt(request.selection.nodeId, { kind: "prepare", operationId: request.operationId, projectId: request.projectId, generation: request.old.generation + 1, sessionId: request.sessionId, workspaceId: request.selection.workspaceId, workspaceRevision: request.selection.workspaceRevision, continuation: record.continuation }, "prepared", nativeProjectSession.parse(record.prepared?.binding));
        if (prepared.continuationDigest !== projectContinuationDigest(record.continuation)) throw new TaskError("FORBIDDEN", "Owner did not confirm the immutable prepared continuation");
        record = this.save({ ...record, prepared });
      }
      if (!record.prepared) throw new TaskError("CONFLICT", "Placement has no prepared evidence");
      const next = nativeProjectSession.parse(record.prepared.binding);
      const decision: ProjectSessionDecision = { outcome: "commit", operationId: request.operationId, projectId: request.projectId, old: request.old, next };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.ports.checkCurrent(request);
        this.ports.commit(request, next);
        record = this.save({ ...record, state: "committed", decision });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        if (error instanceof TaskError && error.code === "CONFLICT") {
          record = this.save({ ...record, state: "aborting", decision: { ...decision, outcome: "abort" } });
          await this.resolveAbort(record);
          this.save({ ...record, state: "aborted" });
        }
        throw error;
      }
    }
    if (record.decision?.outcome !== "commit") throw new TaskError("CONFLICT", "Placement has no committed decision");
    await this.receipt(record.decision.next.nodeId, { kind: "activate", operationId: request.operationId, binding: record.decision.next, decision: record.decision }, "active", record.decision.next);
    const released = projectSessionStatus.parse(await this.ports.owner(request.old.nodeId, { kind: "release", operationId: request.operationId, binding: request.old, decision: record.decision }));
    if (released.kind !== "released" || !sameProjectSession(released.binding, request.old)) throw new TaskError("UNAVAILABLE", "Original owner has not acknowledged release");
    return this.save({ ...record, state: "complete" });
  }
  private async resolveAbort(initial: ProjectSessionPlacement) {
    let record = initial, decision = record.decision;
    if (!decision || decision.outcome !== "abort") return;
    if (!decision.next) {
      const status = projectSessionStatus.parse(await this.ports.owner(record.request.selection.nodeId, { kind: "status", operationId: decision.operationId, sessionId: record.request.sessionId }));
      if (status.kind !== "missing") {
        const next = nativeProjectSession.parse(status.binding);
        if (next.projectId !== record.request.projectId || next.sessionId !== record.request.sessionId || next.nodeId !== record.request.selection.nodeId || next.generation !== record.request.old.generation + 1)
          throw new TaskError("FORBIDDEN", "Abort status changed the prepared binding");
        decision = { ...decision, next };
        record = this.save({ ...record, decision });
      }
    }
    const resolvedDecision = decision;
    const release = async (binding: NativeProjectSession | ProjectSessionPlacement["request"]["old"]) => {
      const result = projectSessionStatus.parse(await this.ports.owner(binding.nodeId, { kind: "release", operationId: initial.request.operationId, binding, decision: resolvedDecision }));
      if (result.kind !== "released" || result.operationId !== initial.request.operationId || !sameProjectSession(result.binding, binding))
        throw new TaskError("UNAVAILABLE", "Aborted owner operation has not acknowledged release");
    };
    if (record.frozen) await release(decision.old);
    if (decision.next) await release(decision.next);
  }
}
