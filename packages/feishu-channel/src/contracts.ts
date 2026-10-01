import type { Task, Run, Report } from '@dsh-task/task-system/contracts';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type InboxState = 'queued' | 'processing' | 'done' | 'rejected' | 'uncertain';
export interface Message {
  kind: 'message'; eventId: string; messageId: string; chatId: string; senderId: string;
  chatType: 'p2p' | 'group'; text: string; createdAt: number;
  replyToMessageId?: string; threadId?: string;
}
export interface Callback {
  kind: 'callback'; eventId: string; messageId: string; chatId: string; senderId: string;
  createdAt: number; token: string;
}
export type Inbound = Message | Callback;
export interface InboxEntry { id: string; event: Inbound; state: InboxState; detail?: string; }
export type Outbound = { text: string; card?: never } | { card: Record<string, Json>; text?: never };
export interface SendRequest {
  deliveryId: string; chatId: string; body: Outbound; replyTo?: string;
  /** Optional durable local scheduling timestamp; sending still requires an online host tick. */
  notBefore?: number;
  category: 'control' | 'narrative';
}
export interface SendReceipt { messageId: string; }
export type SendState = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';
export interface OutboxEntry extends SendRequest {
  state: SendState; attempts: number; nextAt: number; receipt?: SendReceipt;
  error?: string; retryable?: boolean;
  reconciliation?: { reason: string; at: number; outcome: 'sent' | 'not-sent' };
}
/** An implementation MUST resolve only after provider acceptance with an ID.
 * It MUST NOT retry an ambiguous send, and must await the durable receive handler before ACK. */
export interface FeishuTransport {
  start(receive: (event: Inbound) => void): Promise<void>;
  send(request: SendRequest): Promise<SendReceipt>;
  stop(): Promise<void>;
}
/** Only explicit provider rejection is a known failure. Timeout/network loss is uncertain. */
export class SendRejected extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryAfterMs = 1000) { super(code); }
}
export interface ChatContext {
  /** Stable invocation key; do not deduce sender identity or permission from message text. */
  invocationId: string; signal: AbortSignal;
}
export type ChatConsumer = (message: Readonly<Message>, context: ChatContext) => Promise<Outbound | void>;
export interface TaskReportContext { task: Task; run?: Run; report: Report; }
/** Trusted, side-effect-free host renderer. Revalidate the stored schema/data before rendering. */
export type TaskReportRenderer = (context: Readonly<TaskReportContext>) => Outbound | Promise<Outbound>;
export interface ActionBinding {
  token: string; chatId: string; messageId?: string; taskId: string; runId?: string;
  action: 'status' | 'continue' | 'cancel' | 'approve' | 'reject' | 'approval-once' | 'approval-deny';
  /** Runtime approvals bind one exact native tool call, independently of task confirmation. */
  approvalId?: string; approvalCallDigest?: string;
  /** Present on explicit revision-checked controls, never parsed from model text. */
  expectedRevision?: number;
  expiresAt: number; consumed?: string;
}
