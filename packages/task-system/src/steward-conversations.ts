import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import { stewardBinding, stewardMessage, stewardMessageUpdate, stewardAttention, stewardScope, stewardState, stewardSourceStatus, stewardResolve, stewardRequestObservation, STEWARD_PERSONA,
  type StewardRequestObservation,
  type StewardBinding, type StewardMessage, type StewardScope, type StewardSend, type StewardQuote, stewardRead } from "./steward-contracts.js";

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
    this.db.exec(`CREATE INDEX IF NOT EXISTS steward_pending_source ON steward_messages(conversation,json_extract(data,'$.source'))
      WHERE json_extract(data,'$.role')='user' AND json_extract(data,'$.state.kind') NOT IN ('completed','rejected','stopped','released');
      CREATE INDEX IF NOT EXISTS steward_scope_latest ON steward_messages(conversation,json_extract(data,'$.scope.kind'),json_extract(data,'$.scope.projectId'),seq);
      CREATE INDEX IF NOT EXISTS steward_native_source ON steward_sources(json_extract(data,'$.binding.sessionId'),json_extract(data,'$.binding.nodeId'));`);
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
  conversationBatch(afterId: string, limit = 8): string[] {
    return this.db.prepare("SELECT id FROM steward_conversations WHERE id>? ORDER BY id LIMIT ?").all(afterId, limit).map(row => String(row.id));
  }
  sourcesForSession(sessionId: string, nodeId: string) {
    const rows = this.db.prepare("SELECT conversation,data FROM steward_sources WHERE json_extract(data,'$.binding.sessionId')=? AND json_extract(data,'$.binding.nodeId')=? LIMIT 101").all(sessionId, nodeId);
    if (rows.length > 100) throw new TaskError("LIMIT", "One native session is linked to too many visible conversations");
    return rows.map(row => ({ conversationId: String(row.conversation), binding: cursor.parse(JSON.parse(String(row.data))).binding }));
  }
  hasSession(sessionId: string, nodeId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM steward_sources WHERE json_extract(data,'$.binding.sessionId')=? AND json_extract(data,'$.binding.nodeId')=? LIMIT 1").get(sessionId, nodeId);
  }
  cursorBatch(conversationId: string, afterKey: string, limit = 16) {
    return this.db.prepare("SELECT session,data FROM steward_sources WHERE conversation=? AND session>? ORDER BY session LIMIT ?").all(conversationId, afterKey, limit)
      .map(row => ({ key: String(row.session), value: cursor.parse(JSON.parse(String(row.data))) }));
  }
  messages(conversationId: string, afterSeq = 0): StewardMessage[] {
    return this.db.prepare("SELECT data FROM steward_messages WHERE conversation=? AND seq>? ORDER BY seq")
      .all(conversationId, afterSeq).map(row => stewardMessage.parse(JSON.parse(String(row.data))));
  }
  page(input: z.infer<typeof stewardRead>) {
    const { conversationId, limit, afterSeq, beforeSeq } = input;
    const first = this.db.prepare("SELECT seq FROM steward_messages WHERE conversation=? ORDER BY seq LIMIT 1").get(conversationId);
    const last = this.db.prepare("SELECT seq FROM steward_messages WHERE conversation=? ORDER BY seq DESC LIMIT 1").get(conversationId);
    const rows = afterSeq !== undefined
      ? this.db.prepare("SELECT data FROM steward_messages WHERE conversation=? AND seq>? ORDER BY seq LIMIT ?").all(conversationId, afterSeq, limit)
      : beforeSeq !== undefined
        ? this.db.prepare("SELECT data FROM steward_messages WHERE conversation=? AND seq<? ORDER BY seq DESC LIMIT ?").all(conversationId, beforeSeq, limit).reverse()
        : this.db.prepare("SELECT data FROM steward_messages WHERE conversation=? ORDER BY seq DESC LIMIT ?").all(conversationId, limit).reverse();
    const messages = rows.map(row => stewardMessage.parse(JSON.parse(String(row.data))));
    const firstSeq = messages.at(0)?.seq ?? null, lastSeq = messages.at(-1)?.seq ?? null;
    const firstStoredSeq = first ? Number(first.seq) : null, lastStoredSeq = Number(last?.seq ?? 0);
    const ids = [...new Set(input.knownIds)];
    const updateRows = ids.length ? this.db.prepare(`SELECT id,json_extract(data,'$.revision') AS revision,json_extract(data,'$.state') AS state,json_extract(data,'$.resolution') AS resolution,json_extract(data,'$.replyTo') AS parent FROM steward_messages WHERE conversation=? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`).all(conversationId, ...ids) : [];
    const updates = updateRows.map(row => stewardMessageUpdate.parse({ id: row.id, revision: row.revision ?? 0,
      state: JSON.parse(String(row.state)), resolution: row.resolution === null ? null : JSON.parse(String(row.resolution)) }));
    const parents = [...new Set([...messages.map(message => message.replyTo), ...updateRows.map(row => typeof row.parent === "string" ? row.parent : null)].filter((id): id is string => id !== null))].slice(0,100);
    const references = parents.length ? this.db.prepare(`SELECT id,json_extract(data,'$.scope') AS scope,substr(json_extract(data,'$.text'),1,160) AS preview FROM steward_messages WHERE conversation=? AND id IN (${parents.map(() => "?").join(",")})`).all(conversationId,...parents)
      .map(row => ({ id: String(row.id), scope: stewardScope.parse(JSON.parse(String(row.scope))), preview: String(row.preview) })) : [];
    return { messages, updates, references, page: { firstStoredSeq, lastStoredSeq, firstSeq, lastSeq,
      hasOlder: firstSeq !== null && firstStoredSeq !== null && firstSeq > firstStoredSeq,
      hasNewer: lastSeq !== null && lastSeq < lastStoredSeq, limit } };
  }
  attention(conversationId: string) {
    const rows = this.db.prepare("SELECT id,seq,json_extract(data,'$.scope') AS scope,json_extract(data,'$.state') AS state,COALESCE(json_extract(data,'$.revision'),0) AS revision,substr(json_extract(data,'$.text'),1,160) AS preview FROM steward_messages WHERE conversation=? AND json_extract(data,'$.role')='user' AND json_extract(data,'$.state.kind') NOT IN ('completed','rejected','stopped','released') ORDER BY seq LIMIT 21").all(conversationId);
    return { items: rows.slice(0,20).map(row => stewardAttention.parse({ ...row, scope: JSON.parse(String(row.scope)), state: JSON.parse(String(row.state)) })), hasMore: rows.length > 20 };
  }
  nativeRequest(conversationId: string, rpcId: string | undefined, binding?: StewardBinding): StewardMessage | undefined {
    if (!rpcId?.startsWith("steward-")) return undefined;
    const row = this.db.prepare("SELECT data FROM steward_messages WHERE id=? AND conversation=?").get(rpcId.slice(8), conversationId);
    if (!row) return undefined;
    const message = stewardMessage.parse(JSON.parse(String(row.data)));
    return message.role === "user" && (!binding || stewardBindingKey(message.source) === stewardBindingKey(binding)) ? message : undefined;
  }
  commandMessage(conversationId: string, commandId: string): StewardMessage | null {
    const row = this.db.prepare("SELECT m.data FROM steward_commands c JOIN steward_messages m ON m.id=c.message WHERE c.id=? AND m.conversation=?").get(commandId, conversationId);
    return row ? stewardMessage.parse(JSON.parse(String(row.data))) : null;
  }
  activeMessage(conversationId: string, binding: StewardBinding): StewardMessage | undefined {
    const row = this.db.prepare("SELECT data FROM steward_messages WHERE conversation=? AND json_extract(data,'$.source')=? AND json_extract(data,'$.role')='user' AND json_extract(data,'$.state.kind') NOT IN ('completed','rejected','stopped','released') ORDER BY seq LIMIT 1")
      .get(conversationId, canonical(binding));
    return row ? stewardMessage.parse(JSON.parse(String(row.data))) : undefined;
  }
  projectSubscription(conversationId: string, projectId: string): StewardMessage | undefined {
    const row = this.db.prepare("SELECT data FROM steward_messages WHERE conversation=? AND json_extract(data,'$.scope.kind')='project' AND json_extract(data,'$.scope.projectId')=? ORDER BY seq DESC LIMIT 1").get(conversationId, projectId);
    return row ? stewardMessage.parse(JSON.parse(String(row.data))) : undefined;
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
  accept(request: StewardSend, scope: StewardScope, binding: StewardBinding, afterSeq: number, quote: StewardQuote | null = null): StewardMessage {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.replay(request);
      if (previous) { this.db.exec("COMMIT"); return previous; }
      const active = this.activeMessage(request.conversationId, binding);
      if (active) throw new TaskError("BUSY", "This scope has an unfinished message; reconcile it before sending another");
      const value = this.insert({ conversationId: request.conversationId, role: "user", text: request.text, commandId: request.commandId,
        scope, replyTo: request.replyTo ?? null, createdAt: new Date().toISOString(), source: binding,
        nativeSeq: null, provenance: null, state: { kind: "accepted" }, revision: 0, resolution: null, quote,
        manifest: { persona: STEWARD_PERSONA, scope, history: "scope-native-session", evidence: "selection-only",
          resources: [{ id: STEWARD_PERSONA.id, version: STEWARD_PERSONA.version }, ...(quote ? [{ id: `quote:${quote.messageId}`, version: `${quote.revision}:${quote.excerptHash}` }] : [])] } });
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
    return this.db.prepare("SELECT data FROM steward_sources WHERE conversation=? ORDER BY rowid DESC LIMIT 100").all(conversationId)
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

