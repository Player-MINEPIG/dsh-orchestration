import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { adoptSessionEvent, SessionSeq, SessionId, type UserMessage, type SessionEvent } from "@deepseek-ai/dsh-session";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { TaskError, type TaskLedger } from "./ledger.js";
import {
  nativeProjectSession, projectSessionCommand, projectSessionDecision, projectSessionReference,
  sameProjectSession, type NativeProjectSession, type ProjectSessionCommand,
  type ProjectSessionDecision, type ProjectSessionEvidence, type ProjectSessionPrepare,
  type ProjectSessionReference, type ProjectSessionStatus,
} from "./project-session-protocol.js";

export interface ProjectSessionNative {
  create(request: { sessionId: SessionId; cwd: string }): Promise<{ sessionId: SessionId }>;
  resolveAgent(sessionId: SessionId): Promise<{ agent: Agent } | { error: Error }>;
}
export interface ProjectSessionOwnerPorts {
  native: ProjectSessionNative;
  workspace(input: { workspaceId: string; workspaceRevision: string }): Promise<{ cwd: string; workspaceId: string; workspaceRevision: string }>;
  authorize(binding: ProjectSessionReference, access: "read" | "write" | "freeze"): Promise<void>;
  verifyDecision(decision: ProjectSessionDecision): Promise<void>;
  activate(agent: Agent, binding: NativeProjectSession): Promise<void>;
  restoreManaged?(binding: Extract<ProjectSessionReference, { kind: "managed" }>): Promise<Agent>;
}
const recordBase = {
  operationId: z.string().min(1).max(200), intent: z.enum(["prepare", "freeze"]),
  binding: projectSessionReference, evidenceId: z.string().min(1).max(200),
};
const ownerRecord = z.discriminatedUnion("phase", [
  z.object({ ...recordBase, phase: z.literal("pending") }).strict(),
  z.object({ ...recordBase, phase: z.literal("held") }).strict(),
  z.object({ ...recordBase, phase: z.literal("active"), decision: projectSessionDecision }).strict(),
  z.object({ ...recordBase, phase: z.literal("released"), decision: projectSessionDecision }).strict(),
]);
type OwnerRecord = z.infer<typeof ownerRecord>;
interface Hold {
  record: OwnerRecord;
  ready: Promise<void>;
  readyResolve(): void;
  readyReject(error: unknown): void;
  released: Promise<void>;
  release(): void;
  agent?: Agent;
}

export class ProjectSessionOwner {
  private readonly db;
  private readonly holds = new Map<string, Hold>();
  private readonly operations = new Map<string, Promise<ProjectSessionStatus>>();
  private readonly stopListening: () => void;
  private readonly tracked = new WeakSet<Agent>();
  private readonly closing = new Set<string>();
  private readonly replaying = new Set<string>();
  private readonly stopCustody: (() => void)[] = [];
  constructor(
    ledger: Pick<TaskLedger, "managementDatabase">,
    private readonly ctx: Context,
    readonly nodeId: string,
    private readonly ports: ProjectSessionOwnerPorts,
  ) {
    this.db = ledger.managementDatabase();
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_session_owner_operations(
      operation TEXT NOT NULL, session TEXT NOT NULL, phase TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(operation,session));
      CREATE TABLE IF NOT EXISTS project_session_owner_custody(session TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS project_session_owner_hold ON project_session_owner_operations(session) WHERE phase IN ('pending','held');`);
    this.stopCustody.push(ctx.on("agent/inbox/inserted", ({ agent }) => this.capture(agent)));
    this.stopCustody.push(ctx.on("agent/inbox/discarded", ({ agent }) => {
      if (!this.closing.has(String(agent.id))) this.capture(agent);
    }));
    this.stopCustody.push(ctx.on("session/event", (session, event) => {
      if (event.type !== "user/message") return;
      const id = String(session.id), messageId = event.data.id;
      void this.ctx.sessions.flush(session).then(() => {
        const remaining = this.custody(id).filter(item => item.message.id !== messageId);
        if (remaining.length) this.db.prepare("UPDATE project_session_owner_custody SET data=? WHERE session=?").run(JSON.stringify(remaining), id);
        else this.db.prepare("DELETE FROM project_session_owner_custody WHERE session=?").run(id);
      }).catch(() => {});
    }));
    this.stopListening = ctx.on("agent/created", async ({ agent, signal }) => {
      const id = String(agent.id);
      this.closing.delete(id);
      if (signal) this.tracked.add(agent);
      signal?.addEventListener("abort", () => this.closing.add(id), { once: true });
      const record = this.unresolved(id);
      if (!record) return;
      const hold = this.holds.get(String(agent.id)) ?? this.newHold(record);
      try {
        this.checkAgent(agent, record.binding);
        if (record.intent === "freeze" && record.phase === "pending" && (agent.inbox.nextTurn.length || agent.inbox.nextStep.length))
          throw new TaskError("BUSY", "Original session has pending input");
        hold.agent = agent;
        this.restoreCustody(agent);
        this.capture(agent);
        await this.ctx.sessions.flush(agent.session);
        if (record.phase === "active" || record.phase === "released") {
          hold.readyResolve();
          await this.wakeHeld(hold);
          hold.release(); this.holds.delete(id);
          return;
        }
        hold.record = this.save({ ...record, phase: "held" });
        hold.readyResolve();
        if (signal) await Promise.race([hold.released, new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
          void hold.released.finally(() => signal.removeEventListener("abort", abort));
        })]);
        else await hold.released;
      } catch (error) {
        hold.readyReject(error);
        throw error;
      }
    });
  }
  private custody(sessionId: string): { target: "next-turn" | "next-step"; message: UserMessage }[] {
    const row = this.db.prepare("SELECT data FROM project_session_owner_custody WHERE session=?").get(sessionId);
    if (!row) return [];
    const items = z.array(z.object({ target: z.enum(["next-turn", "next-step"]), message: z.unknown() })).parse(JSON.parse(String(row.data)));
    return items.map(item => {
      const data = JSON.parse(JSON.stringify(item.message));
      const event = adoptSessionEvent<Extract<SessionEvent, { type: "user/message" }>>({ type: "user/message", seq: SessionSeq(0), time: 0, surfaceOp: "append", data });
      return { target: item.target, message: event.data };
    });
  }
  private capture(agent: Agent) {
    const id = String(agent.id);
    if (this.replaying.has(id) || !this.holds.has(id) && !this.db.prepare("SELECT session FROM project_session_owner_custody WHERE session=?").get(id)) return;
    const items = [
      ...agent.inbox.nextTurn.map(message => ({ target: "next-turn", message })),
      ...agent.inbox.nextStep.map(message => ({ target: "next-step", message })),
    ];
    this.db.prepare("INSERT INTO project_session_owner_custody VALUES(?,?) ON CONFLICT(session) DO UPDATE SET data=excluded.data").run(id, JSON.stringify(items));
  }
  private restoreCustody(agent: Agent) {
    const id = String(agent.id), consumed = new Set(agent.session.snapshotEvents().flatMap(event => event.type === "user/message" ? [event.data.id] : []));
    const pending = new Set([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(message => message.id));
    this.replaying.add(id);
    try {
      for (const item of this.custody(id)) if (!consumed.has(item.message.id) && !pending.has(item.message.id)) {
        agent.inbox.append(item.target, item.message);
        pending.add(item.message.id);
      }
    } finally { this.replaying.delete(id); }
  }
  private async wakeHeld(hold: Hold) {
    const agent = hold.agent;
    if (!agent) return;
    const turn = agent.inbox.nextTurn.at(-1), step = agent.inbox.nextStep.at(-1);
    const message = turn ?? step;
    if (!message) return;
    const id = String(agent.id);
    this.replaying.add(id);
    try {
      agent.inbox.remove(message.id);
      agent.send(message, turn ? "next-turn" : "next-step", true);
      await this.ctx.sessions.flush(agent.session);
    } finally { this.replaying.delete(id); }
  }
  private read(operationId: string, sessionId: string): OwnerRecord | undefined {
    const row = this.db.prepare("SELECT data FROM project_session_owner_operations WHERE operation=? AND session=?").get(operationId, sessionId);
    return row ? ownerRecord.parse(JSON.parse(String(row.data))) : undefined;
  }
  private unresolved(sessionId: string): OwnerRecord | undefined {
    const row = this.db.prepare("SELECT data FROM project_session_owner_operations WHERE session=? AND (phase IN ('pending','held') OR EXISTS(SELECT 1 FROM project_session_owner_custody WHERE session=project_session_owner_operations.session)) ORDER BY rowid DESC LIMIT 1").get(sessionId);
    return row ? ownerRecord.parse(JSON.parse(String(row.data))) : undefined;
  }
  private save(record: OwnerRecord): OwnerRecord {
    const parsed = ownerRecord.parse(record);
    this.db.prepare("INSERT INTO project_session_owner_operations VALUES(?,?,?,?) ON CONFLICT(operation,session) DO UPDATE SET phase=excluded.phase,data=excluded.data")
      .run(parsed.operationId, parsed.binding.sessionId, parsed.phase, JSON.stringify(parsed));
    return parsed;
  }
  private newHold(record: OwnerRecord): Hold {
    const previous = this.holds.get(record.binding.sessionId);
    if (previous) {
      if (previous.record.operationId !== record.operationId) throw new TaskError("BUSY", "Another placement owns this session");
      return previous;
    }
    let readyResolve: () => void = () => {}, readyReject: (error: unknown) => void = () => {}, release: () => void = () => {};
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const released = new Promise<void>(resolve => { release = resolve; });
    void ready.catch(() => {});
    const hold: Hold = { record, ready, readyResolve, readyReject, released, release };
    this.holds.set(record.binding.sessionId, hold);
    return hold;
  }
  private checkAgent(agent: Agent, binding: ProjectSessionReference) {
    if (String(agent.id) !== binding.sessionId || agent.session.header.cwd !== binding.cwd)
      throw new TaskError("CONFLICT", "Original session identity or cwd changed");
  }
  private checkBinding(binding: ProjectSessionReference) {
    if (binding.nodeId !== this.nodeId || !isAbsolute(binding.cwd)) throw new TaskError("FORBIDDEN", "Session binding is not local to this owner");
  }
  private evidence(record: OwnerRecord): ProjectSessionStatus {
    if (record.phase === "pending") return { kind: "pending", operationId: record.operationId, binding: record.binding };
    const kind = record.phase === "held" ? record.intent === "prepare" ? "prepared" : "frozen" : record.phase;
    return { kind, operationId: record.operationId, binding: record.binding, evidenceId: record.evidenceId };
  }
  status(operationId: string, sessionId: string): ProjectSessionStatus {
    const record = this.read(operationId, sessionId);
    return record ? this.evidence(record) : { kind: "missing" };
  }
  async handle(input: unknown): Promise<ProjectSessionStatus> {
    const command = projectSessionCommand.parse(input);
    if (command.kind === "status") return this.status(command.operationId, command.sessionId);
    const sessionId = command.kind === "prepare" ? command.sessionId : command.binding.sessionId;
    const key = `${command.operationId}:${sessionId}:${command.kind}`;
    const prior = this.operations.get(key);
    if (prior) {
      await prior.catch(() => {});
      return this.handle(command);
    }
    const operation = this.execute(command);
    this.operations.set(key, operation);
    try { return await operation; }
    finally { if (this.operations.get(key) === operation) this.operations.delete(key); }
  }
  private async execute(command: Exclude<ProjectSessionCommand, { kind: "status" }>): Promise<ProjectSessionStatus> {
    switch (command.kind) {
      case "prepare": return this.prepare(command);
      case "freeze": return this.freeze(command.operationId, command.binding);
      case "activate": return this.activate(command.operationId, command.binding, command.decision);
      case "release": return this.release(command.operationId, command.binding, command.decision);
    }
  }
  private async prepare(input: ProjectSessionPrepare): Promise<ProjectSessionStatus> {
    const previous = this.read(input.operationId, input.sessionId);
    if (previous) {
      const binding = previous.binding;
      if (previous.intent !== "prepare" || binding.kind !== "native" || binding.projectId !== input.projectId || binding.generation !== input.generation || binding.workspaceId !== input.workspaceId || binding.workspaceRevision !== input.workspaceRevision)
        throw new TaskError("CONFLICT", "Prepare retry changed its immutable binding");
      if (previous.phase === "active" || previous.phase === "released") return this.evidence(previous);
      return this.restoreHold(previous);
    }
    const workspace = await this.ports.workspace(input);
    if (workspace.workspaceId !== input.workspaceId || workspace.workspaceRevision !== input.workspaceRevision || !isAbsolute(workspace.cwd))
      throw new TaskError("WORKSPACE_POLICY", "Owner workspace registration changed");
    const binding = nativeProjectSession.parse({ kind: "native", projectId: input.projectId, generation: input.generation, nodeId: this.nodeId, sessionId: input.sessionId, ...workspace });
    const record = this.save({ operationId: input.operationId, intent: "prepare", binding, phase: "pending", evidenceId: randomUUID() });
    const hold = this.newHold(record);
    void this.ports.native.create({ sessionId: SessionId(binding.sessionId), cwd: binding.cwd }).then(result => {
      if (String(result.sessionId) !== binding.sessionId) throw new TaskError("CONFLICT", "Native create replaced the prepared identity");
    }).catch(error => hold.readyReject(error));
    await hold.ready;
    return this.status(input.operationId, input.sessionId);
  }
  private async restoreHold(record: OwnerRecord): Promise<ProjectSessionStatus> {
    const present = this.holds.get(record.binding.sessionId);
    if (present) { await present.ready; return this.status(record.operationId, record.binding.sessionId); }
    const hold = this.newHold(record);
    const live = this.ctx.agents.get(SessionId(record.binding.sessionId));
    if (live) this.holdLive(hold, live);
    else void this.startRestore(record).catch(error => hold.readyReject(error));
    try { await hold.ready; }
    catch (error) { this.holds.delete(record.binding.sessionId); throw error; }
    return this.status(record.operationId, record.binding.sessionId);
  }
  private async startRestore(record: OwnerRecord): Promise<void> {
    if (record.intent === "prepare" && record.phase === "pending" && !await this.ctx.sessionPersistence.stat(SessionId(record.binding.sessionId))) {
      const result = await this.ports.native.create({ sessionId: SessionId(record.binding.sessionId), cwd: record.binding.cwd });
      if (String(result.sessionId) !== record.binding.sessionId) throw new TaskError("CONFLICT", "Native create replaced the prepared identity");
    } else await this.resolve(record.binding);
  }
  private async resolve(binding: ProjectSessionReference): Promise<Agent> {
    if (binding.kind === "managed") {
      if (!this.ports.restoreManaged) throw new TaskError("UNAVAILABLE", "Managed session restoration must retain its original composition");
      return this.ports.restoreManaged(binding);
    }
    const result = await this.ports.native.resolveAgent(SessionId(binding.sessionId));
    if ("error" in result) throw result.error;
    return result.agent;
  }
  private holdLive(hold: Hold, agent: Agent) {
    try {
      this.checkAgent(agent, hold.record.binding);
      if (!this.tracked.has(agent)) throw new TaskError("UNAVAILABLE", "Session owner must observe this runtime lifecycle before freezing it; restart the host to restore safely");
      const running = agent.runMaintenance(async () => {
        if (hold.record.phase === "pending" && hold.record.intent === "freeze" && (agent.inbox.nextTurn.length || agent.inbox.nextStep.length))
          throw new TaskError("BUSY", "Original session has pending input");
        hold.agent = agent;
        this.restoreCustody(agent);
        this.capture(agent);
        await this.ctx.sessions.flush(agent.session);
        hold.record = this.save({ ...hold.record, phase: "held" });
        hold.readyResolve();
        await hold.released;
      });
      void running.catch(error => hold.readyReject(error));
    } catch (error) { hold.readyReject(error instanceof TaskError ? error : new TaskError("BUSY", error instanceof Error ? error.message : "Session lifecycle is busy")); }
  }
  private async freeze(operationId: string, binding: ProjectSessionReference): Promise<ProjectSessionStatus> {
    this.checkBinding(binding);
    await this.ports.authorize(binding, "freeze");
    const previous = this.read(operationId, binding.sessionId);
    if (previous) {
      if (previous.intent !== "freeze" || !sameProjectSession(previous.binding, binding)) throw new TaskError("CONFLICT", "Freeze retry changed its binding");
      if (previous.phase === "released") return this.evidence(previous);
      return this.restoreHold(previous);
    }
    const other = this.unresolved(binding.sessionId);
    if (other) throw new TaskError("BUSY", "Another placement owns this session");
    const record: OwnerRecord = { operationId, intent: "freeze", binding, phase: "pending", evidenceId: randomUUID() };
    const hold = this.newHold(record);
    const live = this.ctx.agents.get(SessionId(binding.sessionId));
    if (live) {
      this.holdLive(hold, live);
      if (hold.agent) this.save(record);
    } else {
      this.save(record);
      void this.resolve(binding).catch(error => hold.readyReject(error));
    }
    try { await hold.ready; }
    catch (error) {
      this.holds.delete(binding.sessionId);
      this.db.prepare("DELETE FROM project_session_owner_operations WHERE operation=? AND session=? AND phase='pending'").run(operationId, binding.sessionId);
      hold.release();
      throw error;
    }
    return this.status(operationId, binding.sessionId);
  }
  private decisionRecord(operationId: string, binding: ProjectSessionReference, decision: ProjectSessionDecision): OwnerRecord {
    this.checkBinding(binding);
    if (decision.operationId !== operationId || decision.projectId !== binding.projectId ||
      !sameProjectSession(decision.old, binding) && !(decision.next && sameProjectSession(decision.next, binding)))
      throw new TaskError("FORBIDDEN", "Decision does not name this exact session binding");
    const record = this.read(operationId, binding.sessionId);
    if (!record || !sameProjectSession(record.binding, binding)) throw new TaskError("CONFLICT", "Owner operation binding is unavailable");
    if ((record.phase === "active" || record.phase === "released") && JSON.stringify(record.decision) !== JSON.stringify(decision))
      throw new TaskError("CONFLICT", "Owner operation already has another decision");
    return record;
  }
  private async activate(operationId: string, binding: NativeProjectSession, decision: ProjectSessionDecision): Promise<ProjectSessionStatus> {
    const record = this.decisionRecord(operationId, binding, decision);
    if (decision.outcome !== "commit" || !sameProjectSession(decision.next, binding) || record.intent !== "prepare")
      throw new TaskError("FORBIDDEN", "Activation requires the committed prepared binding");
    await this.ports.verifyDecision(decision);
    if (record.phase === "active") {
      if (this.custody(binding.sessionId).length && !this.ctx.agents.get(SessionId(binding.sessionId))) await this.resolve(binding);
      return this.evidence(record);
    }
    if (record.phase === "released") throw new TaskError("CONFLICT", "Prepared session was already released");
    await this.restoreHold(record);
    const workspace = await this.ports.workspace(binding);
    if (workspace.cwd !== binding.cwd || workspace.workspaceId !== binding.workspaceId || workspace.workspaceRevision !== binding.workspaceRevision)
      throw new TaskError("WORKSPACE_POLICY", "Owner workspace registration changed before activation");
    const hold = this.holds.get(binding.sessionId);
    if (!hold?.agent) throw new TaskError("UNAVAILABLE", "Prepared session has no held runtime");
    await this.ports.activate(hold.agent, binding);
    await this.wakeHeld(hold);
    const active = this.save({ ...record, phase: "active", decision });
    hold.release(); this.holds.delete(binding.sessionId);
    return this.evidence(active);
  }
  private async release(operationId: string, binding: ProjectSessionReference, decision: ProjectSessionDecision): Promise<ProjectSessionStatus> {
    const record = this.decisionRecord(operationId, binding, decision);
    await this.ports.verifyDecision(decision);
    if (record.phase === "released") {
      if (this.custody(binding.sessionId).length && !this.ctx.agents.get(SessionId(binding.sessionId))) await this.resolve(binding);
      return this.evidence(record);
    }
    if (record.phase === "active" || record.intent === "prepare" && decision.outcome === "commit")
      throw new TaskError("CONFLICT", "Committed prepared session must be activated");
    await this.restoreHold(record);
    const held = this.holds.get(binding.sessionId);
    if (held) await this.wakeHeld(held);
    const released = this.save({ ...record, phase: "released", decision });
    this.holds.get(binding.sessionId)?.release(); this.holds.delete(binding.sessionId);
    return this.evidence(released);
  }
  async admit(binding: ProjectSessionReference, access: "read" | "write"): Promise<void> {
    this.checkBinding(binding);
    await this.ports.authorize(binding, access);
    if (access === "read") return;
    const rows = this.db.prepare("SELECT data FROM project_session_owner_operations WHERE session=? AND phase='active'").all(binding.sessionId);
    if (!rows.some(row => sameProjectSession(ownerRecord.parse(JSON.parse(String(row.data))).binding, binding)))
      throw new TaskError("FORBIDDEN", "Project session has not been activated");
    const unresolved = this.unresolved(binding.sessionId);
    if (unresolved && (unresolved.phase === "pending" || unresolved.phase === "held")) throw new TaskError("BUSY", "Project session is changing location");
  }
  outstanding(): ProjectSessionStatus[] {
    return this.db.prepare("SELECT data FROM project_session_owner_operations WHERE phase IN ('pending','held') ORDER BY rowid").all()
      .map(row => this.evidence(ownerRecord.parse(JSON.parse(String(row.data)))));
  }
  async recover(): Promise<void> {
    const rows = this.db.prepare("SELECT data FROM project_session_owner_operations WHERE phase IN ('active','released') AND EXISTS(SELECT 1 FROM project_session_owner_custody WHERE session=project_session_owner_operations.session) ORDER BY rowid DESC").all();
    const restored = new Set<string>();
    for (const row of rows) {
      const record = ownerRecord.parse(JSON.parse(String(row.data)));
      if (restored.has(record.binding.sessionId)) continue;
      restored.add(record.binding.sessionId);
      if (!this.ctx.agents.get(SessionId(record.binding.sessionId))) await this.resolve(record.binding);
    }
  }
  async withAgent<T>(binding: ProjectSessionReference, operation: (agent: Agent) => Promise<T>, access: "read" | "write" = "read"): Promise<T> {
    await this.admit(binding, access);
    const agent = this.ctx.agents.get(SessionId(binding.sessionId)) ?? await this.resolve(binding);
    this.checkAgent(agent, binding);
    return operation(agent);
  }
  dispose() {
    this.stopListening();
    for (const stop of this.stopCustody) stop();
    for (const hold of this.holds.values()) {
      this.closing.add(hold.record.binding.sessionId);
      hold.agent?.cancel({ kind: "disposed" }, { keepInbox: true });
      hold.readyReject(new TaskError("UNAVAILABLE", "Session owner is stopping"));
      hold.release();
    }
    this.holds.clear();
  }
}
