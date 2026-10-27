import { sessionContinuation, continuationReply } from "./ports.js";
import { ProtocolError } from "./protocol.js";
import { returnFailure } from "../task-return-failure.js";
import type { LedgerPort, SessionMessage, SessionContinuationReceipt } from "./ports.js";

/** Ordinary session results do not require a workload provider, claim or execution slot. */
export class TaskReturnInbox {
  private stopped = false;
  private paused = false;
  private readonly deliveries = new Map<string, Promise<void>>();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private abort = new AbortController();
  constructor(private ledger: LedgerPort, private nodeId: string, private deliver: (message: SessionMessage, signal: AbortSignal) => Promise<SessionContinuationReceipt>, private prepare?: () => Promise<unknown>) {}
  start(intervalMs: number) {
    this.timer = setInterval(() => { void this.poll().catch(() => {}); }, intervalMs);
    void this.poll().catch(() => {});
  }
  poll(): Promise<void> {
    if (this.stopped || this.paused) return Promise.resolve();
    const discovery = this.pending ??= this.receive().finally(() => { this.pending = undefined; });
    return discovery.then(async () => { await Promise.allSettled([...this.deliveries.values()]); });
  }
  private async receive() {
    if (!this.ledger.pendingSessionMessages || !this.ledger.completeSessionMessage) return;
    await this.prepare?.();
    const messages = await this.ledger.pendingSessionMessages(this.nodeId, {kind:"continuation", excludeMessageIds:[...this.deliveries.keys()]});
    for (const message of messages) {
      if (this.stopped || this.paused) break;
      const continuation=sessionContinuation(message);
      if (!continuation || continuation.origin.kind !== "session" || continuation.origin.nodeId !== this.nodeId || message.nodeId !== this.nodeId) continue;
      if (this.deliveries.has(message.messageId)) continue;
      const job = this.receiveMessage(message).finally(() => { this.deliveries.delete(message.messageId); });
      this.deliveries.set(message.messageId, job);
    }
  }
  private async receiveMessage(message: SessionMessage) {
    try {
      const reply = await this.deliver(message, this.abort.signal);
      await this.ledger.completeSessionMessage!(`task-return-ack:${message.messageId}`, {messageId:message.messageId,nodeId:this.nodeId,state:"completed",...continuationReply(reply)});
    } catch (error) {
      if (this.stopped || this.paused) return;
      const failure = returnFailure(error);
      await Promise.resolve(this.ledger.completeSessionMessage!(`task-return-failure:${message.messageId}:${Date.now()}`, {messageId:message.messageId,nodeId:this.nodeId,state:"failed",reply:failure.code,failure})).catch(() => {});
    }
  }
  async beginConfigurationEdit() {
    if (this.paused || this.stopped || this.deliveries.size) throw new ProtocolError("CONFIGURATION_BUSY",409);
    this.paused = true;
    await this.pending?.catch(() => {});
    return () => { this.paused = false; };
  }
  async dispose() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort(new Error("Service stopping"));
    await this.pending?.catch(() => {});
    await Promise.allSettled([...this.deliveries.values()]);
  }
}
