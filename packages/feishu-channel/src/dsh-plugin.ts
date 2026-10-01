import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import type { TaskSystemService } from '@dsh-task/task-system/plugin';
import type { Alert, ApprovalRequest, Delivery, Report } from '@dsh-task/task-system/contracts';
import type { ActionBinding, ChatConsumer, Inbound, InboxEntry, Json, Outbound, SendRequest, TaskReportRenderer } from './contracts.js';
import { SendRejected, type FeishuTransport } from './contracts.js';
import { ChannelStore, digest } from './store.js';
import { OfficialFeishuTransport } from './transport.js';
import { alertCard, approvalCard, cardTokens, lifecycleCard, taskCard } from './cards.js';

export const name = 'dsh-feishu-channel';
export interface Config {
  enabled?: boolean; databasePath?: string; appIdEnv?: string; appSecretEnv?: string;
  domain?: 'feishu' | 'lark'; allowedChatIds?: string[]; allowedUserIds?: string[]; operatorUserIds?: string[];
  taskIntegration?: boolean; callbacksEnabled?: boolean; narrativeEnabled?: boolean;
  maxEntries?: number; maxPayloadBytes?: number; maxEventAgeMs?: number; retentionMs?: number;
  pollIntervalMs?: number; requestTimeoutMs?: number; consumerTimeoutMs?: number; maxSendAttempts?: number;
}
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false), databasePath: z.string().default('.dsh-task/feishu-channel.sqlite'),
  appIdEnv: z.string().default('DSH_FEISHU_APP_ID'), appSecretEnv: z.string().default('DSH_FEISHU_APP_SECRET'),
  domain: z.union([z.const('feishu'), z.const('lark')]).default('feishu'),
  allowedChatIds: z.array(z.string()).default([]), allowedUserIds: z.array(z.string()).default([]), operatorUserIds: z.array(z.string()).default([]),
  taskIntegration: z.boolean().default(false), callbacksEnabled: z.boolean().default(false), narrativeEnabled: z.boolean().default(true),
  maxEntries: z.number().min(10).max(100_000).step(1).default(10000),
  maxPayloadBytes: z.number().min(4096).max(262144).step(1).default(65536),
  maxEventAgeMs: z.number().min(1000).max(604800000).step(1).default(86400000),
  retentionMs: z.number().min(1000).max(2592000000).step(1).default(604800000),
  pollIntervalMs: z.number().min(25).max(60000).step(1).default(1000),
  requestTimeoutMs: z.number().min(100).max(120000).step(1).default(10000),
  consumerTimeoutMs: z.number().min(100).max(600000).step(1).default(120000),
  maxSendAttempts: z.number().min(1).max(20).step(1).default(5),
});
export type ResolvedConfig = Required<Config>;
export type TransportFactory = (config: ResolvedConfig) => FeishuTransport;
declare module '@deepseek-ai/cordis' { interface Context { feishuChannel: FeishuChannelService; } }
class CommandRejected extends Error {}
function plain(value: unknown): Json { return JSON.parse(JSON.stringify(value)) as Json; }
function knownError(error: unknown): string { return error instanceof CommandRejected ? error.message : 'Handling failed; inspect local status before retrying'; }
function approvalCallDigest(request: ApprovalRequest): string {
  return digest(JSON.stringify([request.requestId, request.taskId, request.runId, request.attemptId, request.nodeId,
    request.executionId, request.fence, request.sessionId, request.agentId, request.callId, request.toolName,
    request.argumentsDigest, request.description, request.allowRemoteOnce, request.expiresAt]));
}
async function bounded<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation timed out; effect is unknown')), ms);
      abort = () => reject(new Error('Plugin stopped; effect is unknown'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

/** Native service consumed by host plugins. No listener, daemon, model or credentials are created by default. */
export class FeishuChannelService extends Service {
  private task?: TaskSystemService;
  private taskGeneration = 0;
  private consumer?: ChatConsumer;
  private consumerGeneration = 0;
  private rendererGeneration = 0;
  private renderers = new Map<string, { generation: number; render: TaskReportRenderer }>();
  private accepting = true;
  private running?: Promise<void>;
  private lifecycle = new AbortController();
  constructor(ctx: Context, readonly config: ResolvedConfig, readonly store?: ChannelStore, readonly transport?: FeishuTransport) { super(ctx, 'feishuChannel'); }
  attachTaskSystem(service: TaskSystemService): () => void {
    const generation = ++this.taskGeneration;
    this.task = service;
    return () => { if (this.taskGeneration === generation) { this.task = undefined; this.taskGeneration++; } };
  }
  /** Exactly one host consumer owns ordinary chat; deregistration never affects unrelated agents. */
  consume(consumer: ChatConsumer): () => void {
    if (this.consumer) throw new Error('A Feishu chat consumer is already registered');
    // Cordis traces service-bound callbacks through proxies. Primitive generations
    // preserve ownership across that boundary; function identity does not.
    const generation = ++this.consumerGeneration;
    this.consumer = consumer;
    return () => { if (this.consumerGeneration === generation) { this.consumer = undefined; this.consumerGeneration++; } };
  }
  /** Host plugin extension only. Delivery payloads and model output cannot register renderers. */
  registerTaskReportRenderer(schemaId: string, render: TaskReportRenderer): () => void {
    if (!/^[\w][\w.:-]{0,199}$/.test(schemaId) || typeof render !== 'function') throw new Error('A bounded schema ID and report renderer are required');
    if (this.renderers.has(schemaId)) throw new Error('A report renderer is already registered for this schema');
    const generation = ++this.rendererGeneration;
    this.renderers.set(schemaId, { generation, render });
    return () => { if (this.renderers.get(schemaId)?.generation === generation) this.renderers.delete(schemaId); };
  }
  private active(): ChannelStore {
    if (!this.config.enabled || !this.accepting || !this.store || !this.transport) throw new Error('Feishu channel is disabled or draining');
    return this.store;
  }
  /** Only the authenticated SDK transport (or a trusted host adapter) calls this method. */
  receive(event: Inbound): void {
    const store = this.active();
    if (!this.config.allowedChatIds.includes(event.chatId) || !this.config.allowedUserIds.includes(event.senderId)) throw new CommandRejected('Sender or chat is not allowed');
    if (!Number.isFinite(event.createdAt) || event.createdAt < Date.now() - this.config.maxEventAgeMs || event.createdAt > Date.now() + 300000) throw new CommandRejected('Event timestamp is stale or invalid');
    if (event.kind === 'callback' && !this.config.callbacksEnabled) throw new CommandRejected('Card callbacks are disabled; use an explicit slash command');
    store.accept(event);
  }
  /** Trusted host API. Only configured chats can receive an explicitly keyed message. */
  send(request: SendRequest): void {
    const store = this.active();
    if (!this.config.allowedChatIds.includes(request.chatId)) throw new Error('Destination chat is not allowed');
    if (request.category === 'narrative' && !this.config.narrativeEnabled) return;
    store.enqueue(request);
  }
  inspect(): { enabled: boolean; consumerAttached: boolean; taskAttached: boolean; rendererSchemaIds: string[]; inbox: InboxEntry[]; outbox: ReturnType<ChannelStore['outbox']> } {
    return { enabled: this.config.enabled, consumerAttached: Boolean(this.consumer), taskAttached: Boolean(this.task), rendererSchemaIds: [...this.renderers.keys()], inbox: this.store?.inbox() ?? [], outbox: this.store?.outbox() ?? [] };
  }
  /** Host/operator API, deliberately not a chat command or model tool. */
  reconcileDelivery(deliveryId: string, evidence: { outcome: 'sent' | 'not-sent'; reason: string; messageId?: string }): ReturnType<ChannelStore['reconcileDelivery']> {
    const entry = this.active().reconcileDelivery(deliveryId, evidence);
    if (entry.receipt) this.store!.bindActions(cardTokens(entry.body), entry.receipt.messageId);
    return entry;
  }
  tick(): Promise<void> {
    if (!this.accepting || !this.config.enabled) return Promise.resolve();
    this.running ??= this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async drain(): Promise<void> {
    const store = this.active();
    store.prune();
    // Send durable acceptance receipts before potentially slow planner/chat work.
    await this.flushLocal();
    for (const entry of store.inbox().filter(row => row.state === 'queued' && (this.consumer || row.event.kind === 'callback' || /^\/(?:task|alert|approval|diagnostic)(?:\s|$)/.test(row.event.text))).slice(0, 25)) {
      if (!this.accepting) break;
      const command = entry.event.kind === 'callback' || /^\/(?:task|alert|approval|diagnostic)(?:\s|$)/.test(entry.event.text);
      if (!command && !this.consumer) continue;
      if (!store.claimInbox(entry.id)) continue;
      const response = (body: Outbound, category: 'control' | 'narrative' = 'control'): SendRequest => ({ deliveryId: `result:${entry.id}`, chatId: entry.event.chatId, replyTo: entry.event.messageId, category, body });
      try {
        const output = command ? await this.command(entry)
          : await bounded(this.consumer!(Object.freeze(entry.event as Extract<Inbound, { kind: 'message' }>), { invocationId: entry.id, signal: this.lifecycle.signal }), this.config.consumerTimeoutMs, this.lifecycle.signal);
        const category = command ? 'control' : 'narrative';
        store.settleInbox(entry.id, 'done', 'Handled', output && (category === 'control' || this.config.narrativeEnabled) ? response(output, category) : undefined);
      } catch (error) {
        const state = error instanceof CommandRejected ? 'rejected' : 'uncertain';
        store.settleInbox(entry.id, state, knownError(error), response({ text: state === 'uncertain' ? 'Handling stopped with an unknown outcome. Do not repeat an action until its effects are checked.' : knownError(error) }));
      }
    }
    if (this.accepting) { await this.flushLocal(); await this.flushTasks(); }
  }
  private operator(event: Inbound): TaskSystemService {
    if (!this.config.taskIntegration || !this.task) throw new CommandRejected('Task integration is unavailable');
    if (!this.config.operatorUserIds.includes(event.senderId)) throw new CommandRejected('This user is not a configured task operator');
    return this.task;
  }
  private diagnosticCommand(entry: InboxEntry): Outbound {
    const event = entry.event;
    if (!this.config.operatorUserIds.includes(event.senderId)) throw new CommandRejected('This user is not a configured channel operator');
    if (event.kind !== 'message') throw new CommandRejected('Connectivity checks require an explicit slash command');
    const parts = event.text.trim().split(/\s+/);
    if (parts.length !== 2 || !/^[1-9]\d*$/.test(parts[1] ?? '') || Number(parts[1]) > 3600) throw new CommandRejected('Use /diagnostic <seconds>, with an integer from 1 to 3600');
    const seconds = Number(parts[1]);
    this.store!.enqueue({ deliveryId: `diagnostic:${entry.id}`, chatId: event.chatId, replyTo: event.messageId, category: 'control',
      notBefore: Date.now() + seconds * 1000, body: { text: `Requested Feishu connectivity check (${entry.id}). The host reached this chat after the requested delay; this message does not test task execution or approve any action.` } });
    return { text: `Connectivity check queued for this chat in ${seconds} seconds. It will send on an online host tick at or after that time.` };
  }
  private render(taskId: string, chatId: string, reportId?: string, requestedRunId?: string): Outbound {
    const history = this.task!.ledger.history(taskId);
    const report = reportId ? history.reports.find(row => row.reportId === reportId) : undefined;
    if (reportId && !report) throw new CommandRejected('Report does not belong to this task');
    const runId = report?.runId ?? requestedRunId;
    const run = runId ? history.runs.find(row => row.runId === runId) : history.runs.at(-1);
    if (runId && !run) throw new CommandRejected('Run does not belong to this task');
    const actions: ActionBinding[] = [];
    if (this.config.callbacksEnabled && run && run.runId === history.runs.at(-1)?.runId) {
      const names: ActionBinding['action'][] = ['status'];
      if (run.state === 'blocked' && !run.cancellationRequested) names.push('continue');
      if (['queued', 'running', 'blocked'].includes(run.state) && !run.cancellationRequested) names.push('cancel');
      for (const action of names) actions.push(this.store!.createAction({ chatId, taskId, runId: run.runId, action, expiresAt: Date.now() + Math.min(this.config.maxEventAgeMs, 3600000) }));
    }
    const confirmation = history.task.confirmation;
    if (this.config.callbacksEnabled && !report && confirmation?.required && confirmation.state === 'pending' && (!run || run.state === 'queued')) {
      for (const action of ['approve', 'reject'] as const) actions.push(this.store!.createAction({
        chatId, taskId, ...(run ? { runId: run.runId } : {}), expectedRevision: confirmation.revision, action,
        expiresAt: Date.now() + Math.min(this.config.maxEventAgeMs, 3600000),
      }));
    }
    return taskCard(history.task, run, report, actions);
  }
  private async command(entry: InboxEntry): Promise<Outbound> {
    if (entry.event.kind === 'message' && /^\/diagnostic(?:\s|$)/.test(entry.event.text)) return this.diagnosticCommand(entry);
    if ((entry.event.kind === 'message' && /^\/approval(?:\s|$)/.test(entry.event.text)) ||
      (entry.event.kind === 'callback' && this.store!.action(entry.event.token)?.action.startsWith('approval-'))) return this.approvalCommand(entry);
    if (entry.event.kind === 'message' && /^\/alert(?:\s|$)/.test(entry.event.text)) return this.alertCommand(entry);
    const event = entry.event, task = this.operator(event), ledger = task.ledger;
    const key = `feishu:${digest(entry.id)}`;
    let action: string, taskId: string | undefined, runId: string | undefined, expectedRevision: number | undefined;
    if (event.kind === 'callback') {
      const binding = this.store!.action(event.token);
      if (!binding || binding.chatId !== event.chatId || binding.messageId !== event.messageId || binding.expiresAt < Date.now()) throw new CommandRejected('Card action is expired or does not match this message');
      if (binding.consumed) throw new CommandRejected('This card action was already handled; request fresh status');
      ({ action, taskId, runId, expectedRevision } = binding);
      this.store!.consumeAction(event.token, entry.id);
    } else {
      const parts = event.text.trim().split(/\s+/); action = parts[1] ?? 'help'; taskId = parts[2]; runId = parts[3];
      if (action === 'help') return { text: 'Commands: /task list; /task create <title>; /task status <taskId>; /task report <taskId> [reportId]; /task approve|reject <taskId> <confirmationRevision>; /task dismiss|restore <taskId> <admissionRevision>; /task continue <taskId> <blockedRunId>; /task cancel <taskId> <runId>. Confirmation covers the current task/run plan at that revision; every new or changed run plan needs fresh explicit confirmation. Dismiss/restore only changes task visibility; it does not cancel execution or remove history.' };
      if (['approve', 'reject', 'dismiss', 'restore'].includes(action)) {
        if (parts.length !== 4 || !/^[1-9]\d*$/.test(parts[3] ?? '') || !Number.isSafeInteger(Number(parts[3]))) throw new CommandRejected('This control requires exactly a task ID and positive revision; use /task help');
        expectedRevision = Number(parts[3]); runId = undefined;
      }
      if (action === 'create') {
        const title = event.text.replace(/^\/task\s+create\s*/, '').trim();
        if (!title || title.length > 500) throw new CommandRejected('Task title must be 1–500 characters');
        const created = ledger.createTask(key, { title, description: title }).value;
        return this.render(created.taskId, event.chatId);
      }
      if (action === 'list') {
        const tasks = ledger.querySnapshot().tasks;
        return { text: tasks.length ? tasks.slice(-50).map(row => `${row.taskId} | ${row.state} | ${row.title}`).join('\n') + (tasks.length > 50 ? '\nShowing latest 50; full history is in the task ledger.' : '') : 'No tasks recorded' };
      }
    }
    if (!taskId) throw new CommandRejected('An explicit task ID is required');
    let history: ReturnType<typeof ledger.history>;
    try { history = ledger.history(taskId); } catch { throw new CommandRejected('Task was not found'); }
    if (action === 'dismiss' || action === 'restore') {
      if (expectedRevision === undefined || expectedRevision !== (history.task.admissionRevision ?? 1)) throw new CommandRejected('Task admission revision changed; request fresh status');
      try {
        ledger.setTaskAdmission(key, { taskId, expectedRevision, state: action === 'dismiss' ? 'dismissed' : 'admitted',
          actor: `feishu:open_id:${event.senderId}`, reason: `Explicit ${action} by authenticated Feishu operator; message ${event.messageId}; event ${event.eventId}` });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && ['CONFLICT', 'FORBIDDEN', 'INVALID'].includes(String(error.code))) throw new CommandRejected('Task admission was not changed; request fresh status');
        throw error;
      }
      return this.render(taskId, event.chatId);
    }
    if (action === 'approve' || action === 'reject') {
      const confirmation = history.task.confirmation;
      if (!confirmation?.required) throw new CommandRejected('Task does not require confirmation; request fresh status');
      if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision !== confirmation.revision) throw new CommandRejected('Task confirmation revision changed; request fresh status');
      if (event.kind === 'callback' && runId && history.runs.at(-1)?.runId !== runId) throw new CommandRejected('Confirmation card no longer matches the latest run; request fresh status');
      try {
        ledger.setTaskConfirmation(key, { taskId, expectedRevision, approved: action === 'approve',
          actor: `feishu:open_id:${event.senderId}`, reason: `Explicit ${action} by authenticated Feishu operator; message ${event.messageId}; event ${event.eventId}` });
      } catch (error) {
        // These codes are transactional precondition failures, not ambiguous side effects.
        if (error && typeof error === 'object' && 'code' in error && ['CONFLICT', 'FORBIDDEN', 'INVALID'].includes(String(error.code))) throw new CommandRejected('Task confirmation was not changed; check current status and resolve active execution before deciding again');
        throw error;
      }
      return this.render(taskId, event.chatId);
    }
    if (action === 'status') return this.render(taskId, event.chatId);
    if (action === 'report') {
      const report: Report | undefined = runId ? history.reports.find(row => row.reportId === runId) : history.reports.at(-1);
      if (!report) throw new CommandRejected('No matching report recorded for this task');
      return this.render(taskId, event.chatId, report.reportId);
    }
    const run = history.runs.find(row => row.runId === runId);
    if (!run || history.runs.at(-1)?.runId !== runId) throw new CommandRejected('Control must name the latest run of this task');
    if (action === 'continue') {
      if (run.state !== 'blocked' || run.cancellationRequested) throw new CommandRejected('Only a blocked run can continue; uncertain effects need operator reconciliation');
      ledger.continueRun(key, { taskId, runId: run.runId });
      return this.render(taskId, event.chatId);
    }
    if (action === 'cancel') {
      if (!['queued', 'running', 'blocked'].includes(run.state) || run.cancellationRequested) throw new CommandRejected('Run already ended or cancellation is already requested');
      ledger.cancel(key, { taskId, runId: run.runId, reason: `Explicit Feishu operator request ${event.messageId}` });
      await bounded(task.native?.cancelTask(taskId, run.runId) ?? Promise.resolve(), this.config.consumerTimeoutMs, this.lifecycle.signal);
      return this.render(taskId, event.chatId);
    }
    throw new CommandRejected('Unknown task command; use /task help');
  }
  private renderApproval(request: ApprovalRequest, chatId: string): Outbound {
    const actions: ActionBinding[] = [];
    if (this.config.callbacksEnabled && request.state === 'pending' && request.expiresAt > Date.now()) {
      for (const action of (request.allowRemoteOnce ? ['approval-once', 'approval-deny'] : ['approval-deny']) as Array<'approval-once' | 'approval-deny'>) actions.push(this.store!.createAction({
        chatId, taskId: request.taskId, runId: request.runId, approvalId: request.requestId,
        approvalCallDigest: approvalCallDigest(request), expectedRevision: request.revision, action,
        expiresAt: Math.min(request.expiresAt, Date.now() + this.config.maxEventAgeMs, Date.now() + 3600000),
      }));
    }
    const body = approvalCard(request, actions);
    this.validateOutbound(body);
    return body;
  }
  private approvalCommand(entry: InboxEntry): Outbound {
    const event = entry.event, ledger = this.operator(event).ledger;
    let action: string, requestId: string | undefined, expectedRevision: number | undefined, binding: ActionBinding | undefined;
    if (event.kind === 'callback') {
      binding = this.store!.action(event.token);
      if (!binding || binding.chatId !== event.chatId || binding.messageId !== event.messageId || binding.expiresAt <= Date.now()) throw new CommandRejected('Approval card is expired or does not match this message');
      if (binding.consumed) throw new CommandRejected('This approval control was already handled; request fresh status');
      if (!['approval-once', 'approval-deny'].includes(binding.action)) throw new CommandRejected('Card does not identify a runtime approval');
      action = binding.action === 'approval-once' ? 'once' : 'deny'; requestId = binding.approvalId; expectedRevision = binding.expectedRevision;
    } else {
      const parts = event.text.trim().split(/\s+/); action = parts[1] ?? 'help'; requestId = parts[2];
      if (action === 'help') return { text: 'Runtime approvals: /approval list; /approval show <requestId>; /approval once <requestId> <revision>; /approval deny <requestId> <revision>. Review the concrete action and call identity first. Decisions apply once to the exact current live call before its expiry. Actions marked host-review-only cannot be allowed remotely. Task confirmation is separate.' };
      if (action === 'list') {
        if (parts.length !== 2) throw new CommandRejected('Use /approval list');
        const requests = ledger.approvals().filter(request => request.state === 'pending' && request.expiresAt > Date.now());
        return { text: requests.length ? requests.slice(0, 50).map(request => `${request.requestId}@${request.revision} | ${request.toolName} | ${request.allowRemoteOnce ? 'remote once available' : 'host review only'} | expires ${new Date(request.expiresAt).toISOString()}`).join('\n') + '\nUse /approval show <requestId> to review the exact action before deciding.' : 'No pending runtime approval requests' };
      }
      if (action === 'show') {
        if (parts.length !== 3) throw new CommandRejected('Use /approval show <requestId>');
      } else if (['once', 'deny'].includes(action)) {
        if (parts.length !== 4 || !/^[1-9]\d*$/.test(parts[3] ?? '') || !Number.isSafeInteger(Number(parts[3]))) throw new CommandRejected('Use /approval once|deny <requestId> <positive revision>');
        expectedRevision = Number(parts[3]);
      } else throw new CommandRejected('Unknown runtime approval command; use /approval help');
    }
    if (!requestId) throw new CommandRejected('An explicit approval request ID is required');
    let request: ApprovalRequest;
    try { request = ledger.getApproval(requestId); } catch { throw new CommandRejected('Runtime approval request was not found'); }
    if (action === 'show') return this.renderApproval(request, event.chatId);
    if (request.state !== 'pending' || request.expiresAt <= Date.now()) throw new CommandRejected('Runtime approval is no longer pending or has expired; request fresh status');
    if (expectedRevision === undefined || expectedRevision !== request.revision) throw new CommandRejected('Runtime approval revision changed; request fresh status');
    if (binding && (binding.taskId !== request.taskId || binding.runId !== request.runId || binding.approvalCallDigest !== approvalCallDigest(request))) throw new CommandRejected('Approval card does not match this exact native call; request fresh status');
    if (action === 'once' && !request.allowRemoteOnce) throw new CommandRejected('This action requires host approval review; it cannot be allowed remotely');
    if (event.kind === 'callback') this.store!.consumeAction(event.token, entry.id);
    try {
      ledger.respondApproval(`feishu:${digest(entry.id)}`, { requestId, expectedRevision, decision: action === 'once' ? 'allowed-once' : 'denied', actor: `feishu:open_id:${event.senderId}` });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['CONFLICT', 'FORBIDDEN', 'INVALID', 'NOT_FOUND', 'STALE_ASSIGNMENT', 'LEASE_EXPIRED', 'EXPIRED'].includes(String(error.code))) throw new CommandRejected('Runtime approval was not applied; its call, lease, revision or expiry is no longer eligible. Request fresh status');
      throw error;
    }
    return this.renderApproval(ledger.getApproval(requestId), event.chatId);
  }
  private alertCommand(entry: InboxEntry): Outbound {
    const event = entry.event, ledger = this.operator(event).ledger;
    if (event.kind !== 'message') throw new CommandRejected('Alert controls require an explicit slash command');
    const parts = event.text.trim().split(/\s+/), action = parts[1] ?? 'help';
    if (action === 'help') return { text: 'Alert commands: /alert list [all]; /alert show <alertId>; /alert ack <alertId> <revision>; /alert resolve <alertId> <revision>; /alert ack-many <alertId>@<revision> ...; /alert resolve-many <alertId>@<revision> ... . Bulk commands require 1–20 unique explicit IDs and current revisions, and apply atomically. Alert decisions do not settle task execution.' };
    if (action === 'list') {
      if (parts.length > 3 || (parts[2] !== undefined && parts[2] !== 'all')) throw new CommandRejected('Use /alert list or /alert list all');
      const alerts = ledger.alerts({ includeResolved: parts[2] === 'all' });
      return { text: alerts.length ? alerts.slice(0, 50).map(alert => `${alert.alertId}@${alert.revision} | ${alert.severity} | ${alert.status} | ${alert.title.slice(0, 160)}`).join('\n') + (alerts.length > 50 ? '\nShowing first 50; all alerts remain in the ledger.' : '') + '\nUse /alert show <alertId> for details and current controls.' : 'No matching alerts recorded' };
    }
    if (action === 'show') {
      if (parts.length !== 3) throw new CommandRejected('Use /alert show <alertId>');
      try { return alertCard(ledger.getAlert(parts[2]!)); } catch { throw new CommandRejected('Alert was not found'); }
    }
    const state = action === 'ack' || action === 'ack-many' ? 'acknowledged' : action === 'resolve' || action === 'resolve-many' ? 'resolved' : undefined;
    if (!state) throw new CommandRejected('Unknown alert command; use /alert help');
    const parseRevision = (value: string | undefined): number => {
      if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new CommandRejected('Alert controls require a positive current revision');
      return Number(value);
    };
    const changes: { alertId: string; state: 'acknowledged' | 'resolved'; expectedRevision: number }[] = [];
    if (action.endsWith('-many')) {
      if (parts.length < 3 || parts.length > 22) throw new CommandRejected('Bulk controls require 1–20 explicit alertId@revision entries');
      for (const item of parts.slice(2)) {
        const split = item.lastIndexOf('@');
        if (split < 1) throw new CommandRejected('Each bulk entry must be alertId@revision');
        changes.push({ alertId: item.slice(0, split), state, expectedRevision: parseRevision(item.slice(split + 1)) });
      }
    } else {
      if (parts.length !== 4) throw new CommandRejected('Use /alert ack|resolve <alertId> <revision>');
      changes.push({ alertId: parts[2]!, state, expectedRevision: parseRevision(parts[3]) });
    }
    if (new Set(changes.map(change => change.alertId)).size !== changes.length) throw new CommandRejected('Bulk controls require unique alert IDs');
    for (const change of changes) {
      let alert: Alert;
      try { alert = ledger.getAlert(change.alertId); } catch { throw new CommandRejected('An alert was not found; no changes applied'); }
      if (alert.revision !== change.expectedRevision) throw new CommandRejected('An alert revision changed; no changes applied. Request current alert status');
      if (alert.status === 'resolved' || (state === 'acknowledged' && alert.status !== 'open')) throw new CommandRejected('An alert is already acknowledged or resolved; no changes applied');
    }
    const operator = { actor: `feishu:open_id:${event.senderId}`, reason: `Explicit ${action} by authenticated Feishu operator; message ${event.messageId}; event ${event.eventId}` };
    try {
      if (action.endsWith('-many')) ledger.setAlertsState(`feishu:${digest(entry.id)}`, { changes, ...operator });
      else ledger.setAlertState(`feishu:${digest(entry.id)}`, { ...changes[0]!, ...operator });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['CONFLICT', 'FORBIDDEN', 'INVALID', 'NOT_FOUND'].includes(String(error.code))) throw new CommandRejected('Alert state was not changed; request current status before trying again');
      throw error;
    }
    if (changes.length === 1) return alertCard(ledger.getAlert(changes[0]!.alertId));
    return { text: changes.map(change => { const alert = ledger.getAlert(change.alertId); return `${alert.alertId}@${alert.revision} | ${alert.status}`; }).join('\n') + '\nAlert decisions recorded. Task execution outcomes are unchanged.' };
  }
  private async flushLocal(): Promise<void> {
    const store = this.store!;
    for (const row of store.outbox().filter(row => (row.state === 'pending' || (row.state === 'failed' && row.retryable)) && row.nextAt <= Date.now() && row.attempts < this.config.maxSendAttempts).slice(0, 50)) {
      if (!this.accepting) break;
      if (row.attempts >= this.config.maxSendAttempts) continue;
      const claim = store.claimDelivery(row.deliveryId); if (!claim) continue;
      try {
        const receipt = await bounded(this.transport!.send(claim), this.config.requestTimeoutMs, this.lifecycle.signal);
        if (!receipt.messageId) throw new Error('Missing provider message identity');
        store.finish(claim.deliveryId, 'sent', { receipt });
        store.bindActions(cardTokens(claim.body), receipt.messageId);
      } catch (error) {
        if (store.getDelivery(claim.deliveryId)?.state !== 'sending') throw error;
        store.finish(claim.deliveryId, error instanceof SendRejected ? 'failed' : 'uncertain', {
          error: error instanceof SendRejected ? error.code : 'Provider effect unknown; reconciliation required',
          retryable: error instanceof SendRejected && error.retryable,
          ...(error instanceof SendRejected ? { retryAfterMs: error.retryAfterMs } : {}),
        });
      }
    }
  }
  private async flushTasks(): Promise<void> {
    if (!this.config.taskIntegration || !this.task) return;
    const ledger = this.task.ledger;
    let claimedCount = 0;
    for (const row of ledger.deliveries().filter(row => row.destination.startsWith('feishu:chat:') && (row.state === 'pending' || (row.state === 'failed' && (row.receipt as { retryable?: boolean } | undefined)?.retryable)) && Date.parse(row.nextAttemptAt) <= Date.now() && row.attempts < this.config.maxSendAttempts)) {
      if (!this.accepting || claimedCount >= 50) break;
      if (row.attempts >= this.config.maxSendAttempts || (row.state === 'failed' && !(row.receipt as { retryable?: boolean } | undefined)?.retryable)) continue;
      const chatId = row.destination.slice('feishu:chat:'.length);
      if (!this.config.allowedChatIds.includes(chatId) || Date.parse(row.nextAttemptAt) > Date.now()) continue;
      if (row.replyToDeliveryId) {
        const anchor = ledger.deliveries().find(delivery => delivery.deliveryId === row.replyToDeliveryId);
        if (!anchor || anchor.state !== 'sent' || !this.feishuReceiptMessage(anchor)) continue;
      }
      if (row.kind !== 'approval' && row.taskId && ledger.getTask(row.taskId).admissionState === 'dismissed') continue;
      const specialized = ['legacy-report', 'legacy-report-error'].includes(row.kind);
      if (specialized && row.reportId && row.taskId) {
        const report = ledger.history(row.taskId).reports.find(report => report.reportId === row.reportId);
        // A temporarily unloaded renderer is a missing capability, not a failed send.
        // Leave the durable delivery pending so mounting its owner can resume it.
        if (report?.schemaId && !this.renderers.has(report.schemaId)) continue;
      }
      let claim: Delivery;
      try { claim = ledger.claimDelivery(`feishu-claim:${randomUUID()}`, { deliveryId: row.deliveryId, ttlMs: this.config.requestTimeoutMs + 10000 }).value; }
      catch { continue; }
      claimedCount++;
      let started = false;
      try {
        if (!['task-state', 'report', 'result', 'feishu.task-state', 'feishu.report', 'legacy-report', 'legacy-report-error', 'alert', 'approval', 'lifecycle.created', 'lifecycle.terminal'].includes(claim.kind)) throw new SendRejected('unsupported-delivery-kind');
        // Cards use authoritative ledger records, never identity or state claims in payload text.
        const body = claim.kind === 'alert' ? this.renderAlertDelivery(claim)
          : claim.kind === 'approval' ? this.renderApprovalDelivery(claim, chatId)
          : claim.kind.startsWith('lifecycle.') ? this.renderLifecycleDelivery(claim) : await this.renderTaskDelivery(claim, chatId, specialized);
        const replyTo = this.deliveryReply(claim);
        this.validateOutbound(body);
        started = true;
        const receipt = await bounded(this.transport!.send({ deliveryId: claim.deliveryId, chatId, category: 'control', body, ...(replyTo ? { replyTo } : {}) }), this.config.requestTimeoutMs, this.lifecycle.signal);
        if (!receipt.messageId) throw new Error('Missing provider message identity');
        ledger.finishDelivery(`feishu-finish:${claim.claimToken}`, { deliveryId: claim.deliveryId, claimToken: claim.claimToken!, status: 'sent', receipt: plain({ ...receipt, provider: 'feishu' }) });
        this.store!.bindActions(cardTokens(body), receipt.messageId);
      } catch (error) {
        // If finalization itself failed after provider acceptance, leave the claim for core recovery.
        const current = ledger.deliveries().find(value => value.deliveryId === claim.deliveryId);
        if (current?.state !== 'sending') continue;
        const known = !started || error instanceof SendRejected;
        ledger.finishDelivery(`feishu-error:${claim.claimToken}`, { deliveryId: claim.deliveryId, claimToken: claim.claimToken!, status: known ? 'failed' : 'uncertain',
          receipt: { provider: 'feishu', error: error instanceof SendRejected ? error.code : known ? 'invalid-local-presentation' : 'Provider effect unknown; reconciliation required', retryable: error instanceof SendRejected && error.retryable },
          retryAfterMs: error instanceof SendRejected ? error.retryAfterMs : 1000 });
      }
    }
  }
  private async renderTaskDelivery(claim: Delivery, chatId: string, specialized: boolean): Promise<Outbound> {
    if (!claim.taskId) throw new SendRejected('task-delivery-requires-task-identity');
    const history = this.task!.ledger.history(claim.taskId);
    const report = claim.reportId ? history.reports.find(report => report.reportId === claim.reportId) : undefined;
    if (claim.reportId && !report) throw new SendRejected('report-does-not-belong-to-task');
    if (claim.runId && !history.runs.some(run => run.runId === claim.runId)) throw new SendRejected('run-does-not-belong-to-task');
    if (claim.runId && report?.runId && claim.runId !== report.runId) throw new SendRejected('delivery-run-report-identity-mismatch');
    const registration = report?.schemaId ? this.renderers.get(report.schemaId) : undefined;
    if (specialized && (!report?.schemaId || report.data === undefined || !registration)) throw new SendRejected('specialized-report-requires-registered-schema-data');
    if (report?.schemaId && registration) {
      const run = report.runId ? history.runs.find(run => run.runId === report.runId) : undefined;
      const body = await bounded(Promise.resolve(registration.render(Object.freeze({ task: history.task, ...(run ? { run } : {}), report }))), this.config.requestTimeoutMs, this.lifecycle.signal);
      if (this.renderers.get(report.schemaId)?.generation !== registration.generation) throw new SendRejected('report-renderer-detached-before-send');
      return body;
    }
    return this.render(claim.taskId, chatId, claim.reportId, claim.runId);
  }
  private renderAlertDelivery(claim: Delivery): Outbound {
    if (!claim.alertId) throw new SendRejected('alert-delivery-requires-alert-identity');
    const alert = this.task!.ledger.getAlert(claim.alertId);
    if (claim.taskId && alert.taskId !== claim.taskId) throw new SendRejected('alert-delivery-task-identity-mismatch');
    return alertCard(alert);
  }
  private renderApprovalDelivery(claim: Delivery, chatId: string): Outbound {
    if (!claim.approvalId || !claim.taskId) throw new SendRejected('approval-delivery-requires-request-and-task-identity');
    const request = this.task!.ledger.getApproval(claim.approvalId);
    if (request.taskId !== claim.taskId) throw new SendRejected('approval-delivery-task-identity-mismatch');
    return this.renderApproval(request, chatId);
  }
  private feishuReceiptMessage(delivery: Delivery): string | undefined {
    const receipt = delivery.receipt;
    return receipt && typeof receipt === 'object' && !Array.isArray(receipt) && receipt.provider === 'feishu' && typeof receipt.messageId === 'string' && receipt.messageId.trim() ? receipt.messageId : undefined;
  }
  private deliveryReply(claim: Delivery): string | undefined {
    if (!claim.replyToDeliveryId) {
      if (claim.kind === 'lifecycle.terminal') throw new SendRejected('terminal-delivery-requires-creation-anchor');
      return undefined;
    }
    const anchor = this.task!.ledger.deliveries().find(row => row.deliveryId === claim.replyToDeliveryId);
    if (!anchor || anchor.state !== 'sent' || anchor.destination !== claim.destination || anchor.taskId !== claim.taskId || anchor.kind !== 'lifecycle.created' || claim.dependsOnDeliveryId !== anchor.deliveryId) throw new SendRejected('delivery-creation-anchor-mismatch');
    const messageId = this.feishuReceiptMessage(anchor);
    if (!messageId) throw new SendRejected('creation-anchor-has-no-feishu-receipt');
    return messageId;
  }
  private renderLifecycleDelivery(claim: Delivery): Outbound {
    if (!claim.taskId) throw new SendRejected('lifecycle-delivery-requires-task-identity');
    const history = this.task!.ledger.history(claim.taskId);
    if (claim.kind === 'lifecycle.created') {
      if (claim.replyToDeliveryId || claim.dependsOnDeliveryId) throw new SendRejected('creation-anchor-cannot-depend-on-another-delivery');
      return lifecycleCard(history.task, 'lifecycle.created');
    }
    const run = history.runs.find(run => run.runId === claim.runId);
    if (!run || !['succeeded', 'failed', 'cancelled', 'blocked', 'uncertain'].includes(run.state)) throw new SendRejected('terminal-delivery-requires-terminal-run-identity');
    const report = history.reports.filter(report => report.runId === run.runId).at(-1);
    return lifecycleCard(history.task, 'lifecycle.terminal', run, report);
  }
  private validateOutbound(body: Outbound): void {
    const text = typeof body?.text === 'string' && Boolean(body.text.trim());
    const card = Boolean(body?.card && typeof body.card === 'object' && !Array.isArray(body.card));
    if (text === card || (text && body.card !== undefined) || (card && body.text !== undefined)) throw new SendRejected('invalid-report-renderer-output');
    if (Buffer.byteLength(JSON.stringify(body)) > this.config.maxPayloadBytes) throw new SendRejected('report-renderer-output-exceeds-limit');
  }
  async close(): Promise<void> {
    this.accepting = false; this.lifecycle.abort();
    try { await this.transport?.stop(); await this.running; }
    finally { this.store?.close(); }
  }
}

function official(config: ResolvedConfig): FeishuTransport {
  const appId = process.env[config.appIdEnv], appSecret = process.env[config.appSecretEnv];
  if (!appId || !appSecret) throw new Error('Configured Feishu credential environment references are missing');
  return new OfficialFeishuTransport({ appId, appSecret, domain: config.domain, callbacksEnabled: config.callbacksEnabled, requestTimeoutMs: config.requestTimeoutMs });
}
async function mount(ctx: Context, input: Config, factory: TransportFactory): Promise<void> {
  const config = Config(input) as ResolvedConfig;
  if (config.retentionMs <= config.maxEventAgeMs + 300000) throw new Error('retentionMs must exceed maxEventAgeMs plus clock skew to preserve replay deduplication');
  if (config.enabled && (!config.allowedChatIds.length || !config.allowedUserIds.length)) throw new Error('Enabled Feishu requires explicit allowed chat and sender IDs');
  if (config.operatorUserIds.some(user => !config.allowedUserIds.includes(user))) throw new Error('Task operators must also be allowed channel senders');
  let store: ChannelStore | undefined, transport: FeishuTransport | undefined;
  if (config.enabled) { transport = factory(config); store = new ChannelStore(config.databasePath, config); }
  const service = new FeishuChannelService(ctx, config, store, transport);
  let timer: ReturnType<typeof setInterval> | undefined;
  ctx.effect(() => async () => { if (timer) clearInterval(timer); await service.close(); });
  if (config.taskIntegration) ctx.inject(['taskSystem'], taskCtx => {
    const detach = service.attachTaskSystem(taskCtx.taskSystem);
    taskCtx.effect(() => detach);
  });
  if (transport) {
    await transport.start(event => service.receive(event));
    timer = setInterval(() => { void service.tick().catch(() => ctx.logger.warn('Feishu channel maintenance failed; inspect durable channel status')); }, config.pollIntervalMs);
  }
}
export async function apply(ctx: Context, input: Config): Promise<void> { await mount(ctx, input, official); }
/** Explicit dependency injection for a host-owned adapter and offline integration tests. */
export function withTransport(factory: TransportFactory) { return { name, Config, apply: (ctx: Context, input: Config) => mount(ctx, input, factory) }; }
