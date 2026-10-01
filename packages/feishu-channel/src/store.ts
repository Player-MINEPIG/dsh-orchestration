import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActionBinding, Inbound, InboxEntry, InboxState, OutboxEntry, SendRequest, SendReceipt, SendState } from './contracts.js';

export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function inboundId(event: Inbound): string { return `${event.kind}:${event.kind === 'message' ? event.messageId : event.eventId}`; }
export function providerUuid(deliveryId: string): string { return digest(`dsh-feishu-v1:${deliveryId}`).slice(0, 32); }
export interface StoreOptions { maxEntries: number; maxPayloadBytes: number; retentionMs: number; now?: () => number; }

/** Channel-owned SQLite only. Unresolved work is never evicted to make space. */
export class ChannelStore {
  private db: DatabaseSync;
  private closed = false;
  readonly now: () => number;
  constructor(path: string, readonly options: StoreOptions) {
    this.now = options.now ?? Date.now;
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(token TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
      INSERT INTO schema_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_meta);
      CREATE INDEX IF NOT EXISTS inbox_state ON inbox(state,at);
      CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state,at);
    `);
    const version = this.db.prepare('SELECT version FROM schema_meta').get() as { version: number };
    if (version.version !== 1) { this.db.close(); throw new Error('Unsupported channel schema'); }
    // External effects may have happened before a host crash. Never replay them.
    this.db.prepare("UPDATE inbox SET state='uncertain', detail='Host stopped during handling; reconcile before a new request' WHERE state='processing'").run();
    for (const row of this.outbox()) if (row.state === 'sending') this.finish(row.deliveryId, 'uncertain', { error: 'Host stopped during provider send' });
  }
  private capacity(table: 'inbox' | 'outbox' | 'actions', limit: number): void {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    if (row.count >= limit) throw new Error(`${table} capacity reached; unresolved work retained`);
  }
  private encode(value: unknown): string {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > this.options.maxPayloadBytes) throw new Error('Channel payload exceeds configured limit');
    return data;
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Returns only after inbox and mandatory acceptance receipt are durably committed. */
  accept(event: Inbound): { id: string; duplicate: boolean } {
    const id = inboundId(event);
    // Provider event ids can differ for the same message delivery. The message ID is authoritative.
    const identity = { ...event, eventId: event.kind === 'message' ? event.messageId : event.eventId };
    const fingerprint = digest(identity);
    const data = this.encode(event);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT digest FROM inbox WHERE id=?').get(id) as { digest: string } | undefined;
      if (old) { if (old.digest !== fingerprint) throw new Error('Inbound identity reused with changed content'); return { id, duplicate: true }; }
      this.capacity('inbox', this.options.maxEntries);
      this.db.prepare("INSERT INTO inbox(id,digest,data,state,at) VALUES(?,?,?,'queued',?)").run(id, fingerprint, data, this.now());
      this.enqueue({ deliveryId: `ack:${id}`, chatId: event.chatId, replyTo: event.messageId,
        category: 'control', body: { text: `Received (${id}). Queued for handling; this is not a completion confirmation.` } });
      return { id, duplicate: false };
    });
  }
  getInbox(id: string): InboxEntry | undefined {
    const row = this.db.prepare('SELECT id,data,state,detail FROM inbox WHERE id=?').get(id) as { id: string; data: string; state: InboxState; detail?: string } | undefined;
    return row ? { id: row.id, event: JSON.parse(row.data) as Inbound, state: row.state, ...(row.detail ? { detail: row.detail } : {}) } : undefined;
  }
  inbox(): InboxEntry[] {
    return (this.db.prepare('SELECT id FROM inbox ORDER BY at,rowid').all() as { id: string }[]).map(row => this.getInbox(row.id)!);
  }
  claimInbox(id: string): boolean { return this.db.prepare("UPDATE inbox SET state='processing' WHERE id=? AND state='queued'").run(id).changes === 1; }
  settleInbox(id: string, state: 'done' | 'rejected' | 'uncertain', detail: string, response?: SendRequest): void {
    this.transaction(() => {
      if (response) this.enqueue(response);
      this.db.prepare('UPDATE inbox SET state=?,detail=? WHERE id=? AND state=\'processing\'').run(state, detail.slice(0, 1000), id);
    });
  }
  enqueue(request: SendRequest): OutboxEntry {
    if (request.notBefore !== undefined && (!Number.isSafeInteger(request.notBefore) || request.notBefore < 0)) throw new Error('Invalid outbound scheduling timestamp');
    const data = this.encode(request);
    const fingerprint = digest(request);
    const old = this.db.prepare('SELECT digest,data FROM outbox WHERE id=?').get(request.deliveryId) as { digest: string; data: string } | undefined;
    if (old) { if (old.digest !== fingerprint) throw new Error('Outbound identity reused with changed content'); return JSON.parse(old.data) as OutboxEntry; }
    this.capacity('outbox', this.options.maxEntries * 3);
    const entry: OutboxEntry = { ...JSON.parse(data), state: 'pending', attempts: 0, nextAt: request.notBefore ?? this.now() };
    this.db.prepare("INSERT INTO outbox VALUES(?,?,?,'pending',?)").run(request.deliveryId, fingerprint, this.encode(entry), this.now());
    return entry;
  }
  outbox(): OutboxEntry[] { return (this.db.prepare('SELECT data FROM outbox ORDER BY at,rowid').all() as { data: string }[]).map(row => JSON.parse(row.data) as OutboxEntry); }
  getDelivery(id: string): OutboxEntry | undefined {
    const row = this.db.prepare('SELECT data FROM outbox WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as OutboxEntry : undefined;
  }
  claimDelivery(id: string): OutboxEntry | undefined {
    return this.transaction(() => {
      const entry = this.getDelivery(id);
      if (!entry || !(entry.state === 'pending' || (entry.state === 'failed' && entry.retryable)) || entry.nextAt > this.now()) return undefined;
      entry.state = 'sending'; entry.attempts++;
      this.db.prepare("UPDATE outbox SET state='sending',data=? WHERE id=?").run(this.encode(entry), id);
      return entry;
    });
  }
  finish(id: string, state: Extract<SendState, 'sent' | 'failed' | 'uncertain'>, result: { receipt?: SendReceipt; error?: string; retryable?: boolean; retryAfterMs?: number }): void {
    const entry = this.getDelivery(id);
    if (!entry || entry.state !== 'sending') throw new Error('Outgoing claim is no longer active');
    Object.assign(entry, { state, ...result, nextAt: this.now() + (result.retryAfterMs ?? 1000) });
    this.db.prepare('UPDATE outbox SET state=?,data=? WHERE id=?').run(state, this.encode(entry), id);
  }
  /** Trusted operator evidence only. Resolving not-sent never schedules another send. */
  reconcileDelivery(id: string, evidence: { outcome: 'sent' | 'not-sent'; reason: string; messageId?: string }): OutboxEntry {
    return this.transaction(() => {
      const entry = this.getDelivery(id);
      if (!entry || entry.state !== 'uncertain') throw new Error('Only uncertain delivery can be reconciled');
      if (!evidence.reason.trim() || evidence.reason.length > 1000) throw new Error('A bounded reconciliation reason is required');
      if (evidence.outcome === 'sent' && !evidence.messageId?.trim()) throw new Error('Confirmed send requires provider message ID');
      entry.state = evidence.outcome === 'sent' ? 'sent' : 'failed';
      entry.retryable = false;
      entry.reconciliation = { reason: evidence.reason, outcome: evidence.outcome, at: this.now() };
      if (evidence.messageId) entry.receipt = { messageId: evidence.messageId };
      this.db.prepare('UPDATE outbox SET state=?,data=? WHERE id=?').run(entry.state, this.encode(entry), id);
      return entry;
    });
  }
  createAction(input: Omit<ActionBinding, 'token' | 'consumed'>): ActionBinding {
    this.capacity('actions', this.options.maxEntries * 6);
    const value: ActionBinding = { ...input, token: randomBytes(24).toString('hex') };
    this.db.prepare('INSERT INTO actions VALUES(?,?,?)').run(value.token, this.encode(value), value.expiresAt);
    return value;
  }
  action(token: string): ActionBinding | undefined {
    const row = this.db.prepare('SELECT data FROM actions WHERE token=?').get(token) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as ActionBinding : undefined;
  }
  bindActions(tokens: string[], messageId: string): void {
    for (const token of tokens) { const action = this.action(token); if (action) { action.messageId = messageId; this.db.prepare('UPDATE actions SET data=? WHERE token=?').run(this.encode(action), token); } }
  }
  consumeAction(token: string, invocationId: string): ActionBinding {
    return this.transaction(() => {
      const action = this.action(token);
      if (!action || action.expiresAt < this.now()) throw new Error('Card action expired or unknown');
      if (action.consumed && action.consumed !== invocationId) throw new Error('Card action already handled; request fresh status');
      action.consumed = invocationId;
      this.db.prepare('UPDATE actions SET data=? WHERE token=?').run(this.encode(action), token);
      return action;
    });
  }
  prune(): void {
    const cutoff = this.now() - this.options.retentionMs;
    this.db.prepare("DELETE FROM inbox WHERE at < ? AND state IN ('done','rejected')").run(cutoff);
    this.db.prepare("DELETE FROM outbox WHERE at < ? AND state='sent'").run(cutoff);
    this.db.prepare('DELETE FROM actions WHERE expires < ?').run(this.now());
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
