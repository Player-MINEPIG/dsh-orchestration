import { authorizedWorkspace } from "./policy.js";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import type { WorkerOptions } from "./worker.js";
import type { SessionMessage, SessionMessageResult } from "./ports.js";
/** Plain session messages share the authenticated carrier, never a task lease. */
export class SessionMessages {
  private active = new Map<
    string,
    { session: string; abort: AbortController; done: Promise<void> }
  >();
  private stopped = false;
  constructor(private options: WorkerOptions) {}
  get activeCount() {
    return this.active.size;
  }
  async poll(concurrency: number) {
    const { ledger, provider, policy } = this.options;
    if (
      this.stopped ||
      !ledger.pendingSessionMessages ||
      !ledger.completeSessionMessage ||
      !provider.sendSessionMessage
    )
      return;
    const messages = await ledger.pendingSessionMessages(policy.nodeId);
    for (const message of messages) {
      if (
        this.active.size >= concurrency &&
        !this.options.store.sessionMessageState(message.messageId)
      )
        continue;
      if (
        this.active.has(message.messageId) ||
        [...this.active.values()].some((a) => a.session === message.sessionId)
      )
        continue;
      const abort = new AbortController();
      const done = this.deliver(message, abort.signal)
        .catch(() => {})
        .finally(() => this.active.delete(message.messageId));
      this.active.set(message.messageId, {
        session: message.sessionId,
        abort,
        done,
      });
    }
  }
  private async deliver(message: SessionMessage, signal: AbortSignal) {
    const { store, ledger, provider, policy } = this.options;
    let saved = store.sessionMessageState(message.messageId);
    if (saved?.state === "started") {
      saved = {
        state: "result",
        result: {
          state: "uncertain",
          reply:
            "服务中断，消息可能已进入原会话；为避免重复操作，没有自动重发。请查看执行端原会话。",
        },
      };
      store.saveSessionMessageState(message.messageId, saved);
    }
    if (!saved) {
      const record = store
        .dispatches()
        .find(
          (d) =>
            d.sessionId === message.sessionId &&
            d.claim.task.taskId === message.taskId &&
            d.claim.run.route?.workspaceId === message.workspaceId,
        );
      const binding = policy.workspaces.find(
        (w) =>
          w.workspaceId === message.workspaceId && w.nodeId === message.nodeId,
      );
      let result: SessionMessageResult;
      if (!record || !binding)
        result = {
          state: "failed",
          reply: "本执行端没有此任务原会话的授权记录，未发送消息。",
        };
      else {
        let stage = "检查会话授权";
        try {
          const root = await authorizedWorkspace(
            record.claim,
            policy,
            provider,
          );
          const path = await realpath(record.workspacePath ?? root),
            sub = relative(root, path);
          if (sub === ".." || sub.startsWith(`..${sep}`) || isAbsolute(sub))
            throw new Error("Session outside authorized workspace");
          stage = "准备原会话";
          const reply = await provider.sendSessionMessage!(
            message,
            record,
            () => {
              store.saveSessionMessageState(message.messageId, {
                state: "started",
              });
              stage = "等待原会话回复";
            },
            signal,
          );
          result = {
            state: "completed",
            reply: reply || "本轮未返回文本，请查看执行端原会话。",
          };
        } catch (error) {
          if (
            (error as { code?: string }).code === "SESSION_BUSY" &&
            !store.sessionMessageState(message.messageId)
          )
            return;
          result = {
            state: store.sessionMessageState(message.messageId)
              ? "uncertain"
              : "failed",
            reply: store.sessionMessageState(message.messageId)
              ? `${stage}时中断，消息已交给执行端，但未确认完整回复；请查看原会话，未自动重发。`
              : `${stage}失败，消息尚未进入原会话；未自动重发。`,
          };
        }
      }
      if (
        result.reply.length > 12000 ||
        Buffer.byteLength(result.reply) > 24000
      ) {
        let reply = result.reply.slice(0, 11900);
        while (Buffer.byteLength(reply) > 23800) reply = reply.slice(0, -100);
        result.reply = reply + "\n[回复过长，完整内容保留在执行端原会话]";
      }
      saved = { state: "result", result };
      store.saveSessionMessageState(message.messageId, saved);
    }
    await ledger.completeSessionMessage!(`message-reply-${message.messageId}`, {
      messageId: message.messageId,
      nodeId: policy.nodeId,
      ...saved.result!,
    });
  }
  async dispose() {
    this.stopped = true;
    for (const a of this.active.values())
      a.abort.abort(new Error("Service stopping"));
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
}
