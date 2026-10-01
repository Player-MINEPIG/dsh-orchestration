import * as lark from '@larksuiteoapi/node-sdk';
import type { Callback, FeishuTransport, Inbound, Message, SendReceipt, SendRequest } from './contracts.js';
import { SendRejected } from './contracts.js';
import { providerUuid } from './store.js';

type Obj = Record<string, any>;
function object(value: unknown): Obj { return value && typeof value === 'object' ? value as Obj : {}; }
function field(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`Invalid Feishu ${label}`);
  return value;
}
function milliseconds(value: unknown): number {
  const timestamp = Number(value);
  // Feishu callback headers use microseconds; message create_time uses milliseconds.
  return timestamp > 100_000_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
}
/** SDK dispatcher preserves the provider envelope/header. No identity is parsed from message text. */
export function normalizeMessage(input: unknown): Message {
  const raw = object(input), event = object(raw.event ?? raw), message = object(event.message), sender = object(event.sender);
  if (sender.sender_type !== 'user') throw new Error('Only user messages are accepted');
  if (message.message_type !== 'text') throw new Error('Only text input is supported by this channel');
  const content = object(JSON.parse(String(message.content)));
  if (typeof content.text !== 'string') throw new Error('Malformed text message');
  if (!['p2p', 'group'].includes(message.chat_type)) throw new Error('Unsupported chat type');
  return { kind: 'message', eventId: field(raw.header?.event_id ?? raw.event_id ?? message.message_id, 'event ID'),
    messageId: field(message.message_id, 'message ID'), chatId: field(message.chat_id, 'chat ID'),
    senderId: field(object(sender.sender_id).open_id, 'sender open ID'), chatType: message.chat_type,
    text: content.text, createdAt: Number(message.create_time),
    ...(message.parent_id ? { replyToMessageId: field(message.parent_id, 'parent ID') } : {}),
    ...(message.thread_id ? { threadId: field(message.thread_id, 'thread ID') } : {}) };
}
export function normalizeCallback(input: unknown): Callback {
  const raw = object(input), event = object(raw.event ?? raw), context = object(event.context), operator = object(event.operator);
  return { kind: 'callback', eventId: field(raw.header?.event_id ?? raw.event_id, 'callback event ID'),
    messageId: field(context.open_message_id, 'callback message ID'), chatId: field(context.open_chat_id, 'callback chat ID'),
    senderId: field(operator.open_id, 'operator open ID'), createdAt: milliseconds(raw.header?.create_time ?? raw.create_time),
    token: field(object(object(event.action).value).dsh_action, 'action token') };
}

export interface OfficialOptions { appId: string; appSecret: string; domain: 'feishu' | 'lark'; callbacksEnabled: boolean; requestTimeoutMs: number; }
const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
export function createDispatcher(receive: (event: Inbound) => void, callbacksEnabled: boolean): lark.EventDispatcher {
  return new lark.EventDispatcher({ logger: quietLogger }).register({
    'im.message.receive_v1': async data => { receive(normalizeMessage(data)); return {}; },
    ...(callbacksEnabled ? { 'card.action.trigger': async (data: unknown) => { receive(normalizeCallback(data)); return { toast: { type: 'info', content: 'Received; action result will follow separately' } }; } } : {}),
  });
}
function timedHttp(timeout: number): lark.HttpInstance {
  // A per-client wrapper preserves other host plugins' HTTP defaults.
  return new Proxy(lark.defaultHttpInstance, { get(target, property) {
    if (property === 'request') return (options: lark.HttpRequestOptions<unknown>) => target.request({ ...options, timeout });
    if (['get', 'delete', 'head', 'options'].includes(String(property))) return (url: string, options?: lark.HttpRequestOptions<unknown>) => target.request({ ...options, method: String(property), url, timeout });
    if (['post', 'put', 'patch'].includes(String(property))) return (url: string, data: unknown, options?: lark.HttpRequestOptions<unknown>) => target.request({ ...options, method: String(property), url, data, timeout });
    return Reflect.get(target, property);
  } }) as unknown as lark.HttpInstance; // SDK's default instance unwraps response.data in its interceptor.
}
/** SDK clients are constructed only when the host explicitly enables this plugin. */
export class OfficialFeishuTransport implements FeishuTransport {
  readonly client: lark.Client;
  private ws?: lark.WSClient;
  private cancelConnect?: () => void;
  private started = false;
  constructor(private options: OfficialOptions) {
    const common = { appId: options.appId, appSecret: options.appSecret,
      domain: options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      // Do not allow SDK logs to expose event bodies, credentials or request headers.
      logger: quietLogger, httpInstance: timedHttp(options.requestTimeoutMs),
    };
    this.client = new lark.Client(common);
  }
  async start(receive: (event: Inbound) => void): Promise<void> {
    if (this.started) throw new Error('Feishu transport already started');
    this.started = true;
    if (!/^cli_[0-9a-fA-F]{16}$/.test(this.options.appId)) throw new Error('Invalid Feishu application ID');
    const dispatcher = createDispatcher(receive, this.options.callbacksEnabled);
    // WSClient.start() returns before the handshake. Activation requires onReady.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); this.cancelConnect = undefined; if (error) { this.ws?.close({ force: true }); reject(error); } else resolve(); };
      const timer = setTimeout(() => finish(new Error('Feishu WebSocket handshake timed out')), this.options.requestTimeoutMs);
      this.cancelConnect = () => finish(new Error('Feishu connection stopped'));
      this.ws = new lark.WSClient({ appId: this.options.appId, appSecret: this.options.appSecret,
        domain: this.options.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
        logger: quietLogger, httpInstance: timedHttp(this.options.requestTimeoutMs), handshakeTimeoutMs: this.options.requestTimeoutMs,
        onReady: () => finish(), onError: () => finish(new Error('Feishu WebSocket connection failed')) });
      void this.ws.start({ eventDispatcher: dispatcher }).catch(() => finish(new Error('Feishu WebSocket startup failed')));
    });
  }
  async send(request: SendRequest): Promise<SendReceipt> {
    const msg_type = request.body.card ? 'interactive' : 'text';
    const content = JSON.stringify(request.body.card ?? { text: request.body.text });
    const data = { msg_type, content, uuid: providerUuid(request.deliveryId) };
    // One SDK request. No fallback to a new chat message and no retry after a timeout.
    const result = request.replyTo
      ? await this.client.im.message.reply({ path: { message_id: request.replyTo }, data })
      : await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: request.chatId } });
    if (typeof result.code !== 'number') throw new Error('Provider response had no result code; delivery is uncertain');
    if (result.code !== 0) throw new SendRejected(`provider:${result.code}`, result.code === 99991400, 30_000);
    if (!result.data?.message_id) throw new Error('Provider response had no message ID; delivery is uncertain');
    return { messageId: result.data.message_id };
  }
  async stop(): Promise<void> { this.started = false; this.cancelConnect?.(); this.ws?.close({ force: true }); }
}
