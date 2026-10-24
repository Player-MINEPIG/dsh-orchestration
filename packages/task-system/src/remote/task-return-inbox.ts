import { ProtocolError } from "./protocol.js";
import type { LedgerPort, SessionMessage } from "./ports.js";

/** Ordinary session results do not require a workload provider, claim or execution slot. */
export class TaskReturnInbox {
  private stopped = false;
  private paused = false;
  private deliveries = 0;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private abort = new AbortController();
  constructor(private ledger: LedgerPort, private nodeId: string, private deliver: (message: SessionMessage, signal: AbortSignal) => Promise<string>, private prepare?: () => Promise<unknown>) {}
  start(intervalMs: number) {
    this.timer = setInterval(() => { void this.poll().catch(() => {}); }, intervalMs);
    void this.poll().catch(() => {});
  }
  poll(): Promise<void> {
    if (this.stopped || this.paused) return Promise.resolve();
    return this.pending ??= this.receive().finally(() => { this.pending = undefined; });
  }
  private async receive() {
    if (!this.ledger.pendingSessionMessages || !this.ledger.completeSessionMessage) return;
    await this.prepare?.();
    const messages = await this.ledger.pendingSessionMessages(this.nodeId, {kind:"completion"});
    for (const message of messages) {
      if (this.stopped || this.paused) break;
      if (!message.completion || message.completion.origin.kind !== "session" || message.completion.origin.nodeId !== this.nodeId || message.nodeId !== this.nodeId) continue;
      this.deliveries++;
      try {
        const reply = await this.deliver(message, this.abort.signal);
        await this.ledger.completeSessionMessage(`task-return-ack:${message.messageId}`, {messageId:message.messageId,nodeId:this.nodeId,state:"completed",reply});
      } catch {
        if (this.stopped || this.paused) break;
        await Promise.resolve(this.ledger.completeSessionMessage(`task-return-failure:${message.messageId}:${Date.now()}`, {messageId:message.messageId,nodeId:this.nodeId,state:"failed",reply:"RETURN_UNAVAILABLE: original session unavailable; retained for retry"})).catch(() => {});
      } finally { this.deliveries--; }
    }
  }
  async beginConfigurationEdit() {
    if (this.paused || this.stopped || this.deliveries) throw new ProtocolError("CONFIGURATION_BUSY",409);
    this.paused = true;
    await this.pending?.catch(() => {});
    return () => { this.paused = false; };
  }
  async dispose() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort(new Error("Service stopping"));
    await this.pending?.catch(() => {});
  }
}
