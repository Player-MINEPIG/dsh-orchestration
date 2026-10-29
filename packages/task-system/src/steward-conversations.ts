import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import { stewardBinding, stewardMessage, stewardScope, stewardState, stewardSourceStatus, stewardResolve, stewardRequestObservation, STEWARD_PERSONA,
  type StewardRequestObservation,
  type StewardBinding, type StewardMessage, type StewardScope, type StewardSend } from "./steward-contracts.js";

const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const stewardBindingKey = (binding: StewardBinding) => digest(binding);
const cursor = z.strictObject({ binding: stewardBinding, afterSeq: z.number().int().min(-1), currentUser: z.string().nullable(),
  pendingUsers: z.array(z.string()).default([]),
  status: stewardSourceStatus.default({ kind: "unchecked" }) });
export type StewardCursor = z.infer<typeof cursor>;
export class StewardConversations {
  private readonly db;
  constructor(ledger: Pick<TaskLedger, "managementDatabase">) {
    this.db = ledger.managementDatabase();
    this.db.exec(`CREATE TABLE IF NOT EXISTS steward_conversations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,event_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS steward_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS steward_message_conversation ON steward_messages(conversation,seq);
      CREATE TABLE IF NOT EXISTS steward_commands(id TEXT PRIMARY KEY,digest TEXT NOT NULL,message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steward_sources(conversation TEXT NOT NULL,session TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(conversation,session));
      CREATE TABLE IF NOT EXISTS steward_projections(conversation TEXT NOT NULL,source TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(conversation,source));
      CREATE TABLE IF NOT EXISTS steward_task_origins(conversation TEXT NOT NULL,task TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(conversation,task));
      CREATE TABLE IF NOT EXISTS steward_resolutions(command TEXT PRIMARY KEY,digest TEXT NOT NULL,message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steward_requests(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS steward_request_conversation ON steward_requests(conversation);`);
  }
  observeRequest(input: StewardRequestObservation) {
    const value = stewardRequestObservation.parse(input);
    this.db.prepare("INSERT OR IGNORE INTO steward_requests VALUES(?,?,?)").run(value.id, value.conversationId, canonical(value));
  }
  requests(conversationId: string): StewardRequestObservation[] {
    return this.db.prepare("SELECT data FROM steward_requests WHERE conversation=? ORDER BY rowid DESC LIMIT 50")
      .all(conversationId).reverse().map(row => stewardRequestObservation.parse(JSON.parse(String(row.data))));
  }
  ensure(conversationId: string) {
    const latest = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get();
    this.db.prepare("INSERT OR IGNORE INTO steward_conversations VALUES(?,?,?)")
      .run(conversationId, canonical({ kind: "personal" }), Number(latest?.seq ?? 0));
  }
  conversationIds(): string[] {
    return this.db.prepare("SELECT id FROM steward_conversations").all().map(row => String(row.id));
  }
  messages(conversationId: string, afterSeq = 0): StewardMessage[] {
    return this.db.prepare("SELECT data FROM steward_messages WHERE conversation=? AND seq>? ORDER BY seq")
      .all(conversationId, afterSeq).map(row => stewardMessage.parse(JSON.parse(String(row.data))));
  }
  message(id: string): StewardMessage {
    const row = this.db.prepare("SELECT data FROM steward_messages WHERE id=?").get(id);
    if (!row) throw new TaskError("NOT_FOUND", "Conversation message does not exist");
    return stewardMessage.parse(JSON.parse(String(row.data)));
  }
  current(conversationId: string): StewardScope {
    this.ensure(conversationId);
    const row = this.db.prepare("SELECT scope FROM steward_conversations WHERE id=?").get(conversationId);
    return stewardScope.parse(JSON.parse(String(row?.scope)));
  }
  resolveScope(request: StewardSend): StewardScope {
    this.ensure(request.conversationId);
    const replied = request.replyTo ? this.message(request.replyTo) : undefined;
    if (replied && replied.conversationId !== request.conversationId)
      throw new TaskError("FORBIDDEN", "Reply belongs to another conversation");
    if (replied && request.target && canonical(replied.scope) !== canonical(request.target))
      throw new TaskError("CONFLICT", "Reply and selected scope disagree; choose the intended conversation");
    return request.target ?? replied?.scope ?? this.current(request.conversationId);
  }
  replay(request: StewardSend): StewardMessage | undefined {
    const row = this.db.prepare("SELECT digest,message FROM steward_commands WHERE id=?").get(request.commandId);
    if (!row) return undefined;
    if (row.digest !== digest(request)) throw new TaskError("CONFLICT", "Message retry changed its contents");
    return this.message(String(row.message));
  }
  requestId(messageId: string): string { return `steward-${messageId}`; }
  accept(request: StewardSend, scope: StewardScope, binding: StewardBinding, afterSeq: number): StewardMessage {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.replay(request);
      if (previous) { this.db.exec("COMMIT"); return previous; }
      const active = this.messages(request.conversationId).find(message => message.role === "user" &&
        stewardBindingKey(message.source) === stewardBindingKey(binding) && !["completed", "rejected", "stopped", "released"].includes(message.state.kind));
      if (active) throw new TaskError("BUSY", "This scope has an unfinished message; reconcile it before sending another");
      const value = this.insert({ conversationId: request.conversationId, role: "user", text: request.text, commandId: request.commandId,
        scope, replyTo: request.replyTo ?? null, createdAt: new Date().toISOString(), source: binding,
        nativeSeq: null, provenance: null, state: { kind: "accepted" }, revision: 0, resolution: null,
        manifest: { persona: STEWARD_PERSONA, scope, history: "scope-native-session", evidence: "selection-only",
          resources: [{ id: STEWARD_PERSONA.id, version: STEWARD_PERSONA.version }] } });
      this.db.prepare("INSERT INTO steward_commands VALUES(?,?,?)").run(request.commandId, digest(request), value.id);
      this.db.prepare("UPDATE steward_conversations SET scope=? WHERE id=?").run(canonical(scope), request.conversationId);
      this.db.prepare("INSERT OR IGNORE INTO steward_sources VALUES(?,?,?)")
        .run(request.conversationId, stewardBindingKey(binding), canonical({ binding, afterSeq, currentUser: null, pendingUsers: [] }));
      this.db.exec("COMMIT");
      return value;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private insert(input: Omit<z.input<typeof stewardMessage>, "id" | "seq">): StewardMessage {
    const id = randomUUID();
    const result = this.db.prepare("INSERT INTO steward_messages(id,conversation,data) VALUES(?,?,?)").run(id, input.conversationId, "{}");
    const value = stewardMessage.parse({ ...input, id, seq: Number(result.lastInsertRowid) });
    this.db.prepare("UPDATE steward_messages SET data=? WHERE id=?").run(canonical(value), id);
    return value;
  }
  setState(id: string, state: z.infer<typeof stewardState>) {
    const message = this.message(id);
    if (canonical(message.state) === canonical(state)) return;
    this.db.prepare("UPDATE steward_messages SET data=? WHERE id=?").run(canonical({ ...message, state, revision: message.revision + 1 }), id);
  }
  cursors(conversationId: string): StewardCursor[] {
    return this.db.prepare("SELECT data FROM steward_sources WHERE conversation=?").all(conversationId)
      .map(row => cursor.parse(JSON.parse(String(row.data))));
  }
  saveCursor(conversationId: string, value: StewardCursor) {
    this.db.prepare("UPDATE steward_sources SET data=? WHERE conversation=? AND session=?")
      .run(canonical(value), conversationId, stewardBindingKey(value.binding));
  }
  project(input: Omit<z.input<typeof stewardMessage>, "id" | "seq">, sourceId: string): StewardMessage {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT message FROM steward_projections WHERE conversation=? AND source=?").get(input.conversationId, sourceId);
      if (existing) { const value = this.message(String(existing.message)); this.db.exec("COMMIT"); return value; }
      const value = this.insert(input);
      this.db.prepare("INSERT INTO steward_projections VALUES(?,?,?)").run(input.conversationId, sourceId, value.id);
      this.db.exec("COMMIT");
      return value;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  eventCursor(conversationId: string): number {
    return Number(this.db.prepare("SELECT event_seq FROM steward_conversations WHERE id=?").get(conversationId)?.event_seq ?? 0);
  }
  advanceEvents(conversationId: string, seq: number) {
    this.db.prepare("UPDATE steward_conversations SET event_seq=? WHERE id=? AND event_seq<?").run(seq, conversationId, seq);
  }
  bindTask(conversationId: string, taskId: string, messageId: string) {
    const message = this.message(messageId);
    if (message.conversationId !== conversationId || message.role !== "user" || message.scope.kind !== "project")
      throw new TaskError("FORBIDDEN", "Task origin must be a project user message in this conversation");
    this.db.prepare("INSERT OR IGNORE INTO steward_task_origins VALUES(?,?,?)").run(conversationId, taskId, messageId);
  }
  taskOrigin(conversationId: string, taskId: string): StewardMessage | undefined {
    const row = this.db.prepare("SELECT message FROM steward_task_origins WHERE conversation=? AND task=?").get(conversationId, taskId);
    return row ? this.message(String(row.message)) : undefined;
  }
  resolutionReplay(input: z.infer<typeof stewardResolve>): StewardMessage | undefined {
    const row = this.db.prepare("SELECT digest,message FROM steward_resolutions WHERE command=?").get(input.commandId);
    if (!row) return undefined;
    if (row.digest !== digest(input)) throw new TaskError("CONFLICT", "Resolution retry changed its contents");
    return this.message(String(row.message));
  }
  release(input: z.infer<typeof stewardResolve>): StewardMessage {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.resolutionReplay(input);
      if (prior) { this.db.exec("COMMIT"); return prior; }
      const message = this.message(input.messageId);
      if (message.conversationId !== input.conversationId || message.role !== "user")
        throw new TaskError("FORBIDDEN", "Resolution belongs to another conversation");
      if (message.revision !== input.expectedRevision || message.state.kind !== input.expectedState)
        throw new TaskError("CONFLICT", "Message evidence changed; review it before resolving");
      const next = stewardMessage.parse({ ...message, revision: message.revision + 1,
        state: { kind: "released", reason: "用户已结束等待并允许继续对话；原发送结果仍未确定，没有重新发送或取消任务。" },
        resolution: { commandId: input.commandId, at: new Date().toISOString(), priorState: input.expectedState } });
      this.db.prepare("UPDATE steward_messages SET data=? WHERE id=?").run(canonical(next), message.id);
      this.db.prepare("INSERT INTO steward_resolutions VALUES(?,?,?)").run(input.commandId, digest(input), message.id);
      this.db.exec("COMMIT"); return next;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

