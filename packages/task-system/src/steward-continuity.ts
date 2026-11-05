import type { StewardMessage } from "./steward-contracts.js";
import { stewardBindingKey } from "./steward-conversations.js";

export function isProjectContinuation(text: string): boolean {
  return /^(?:(?:那|那么|好的|好|请|现在)[，,\s]*)?(?:就)?(?:开始|启动|继续)(?:吧|执行|工作|下去|这个项目)?[。！!]?$/u.test(text.trim()) ||
    /^(?:please\s+)?(?:start|continue|go ahead)[.!]?$/iu.test(text.trim());
}

/** Recipient evidence only. The original PM remains responsible for interpreting the action. */
export function projectContinuity(messages: readonly StewardMessage[], anchorId?: string) {
  const users = messages.filter(message => message.role === "user");
  let anchor = anchorId ? users.find(message => message.id === anchorId) : users.at(-1);
  for (let depth = 0; depth < 3 && anchor; depth++) {
    if (anchor.state.kind !== "completed") return;
    if (anchor.scope.kind === "project") {
      const projectId = anchor.scope.projectId, anchorId = anchor.id;
      const source = stewardBindingKey(anchor.source);
      const response = messages.findLast(message => message.role === "assistant" && message.replyTo === anchorId &&
        message.scope.kind === "project" && message.scope.projectId === projectId && stewardBindingKey(message.source) === source);
      return response ? { anchor, response, scope: anchor.scope } : undefined;
    }
    if (anchor.scope.kind !== "workbench" || anchor.quote || !anchor.route || !isProjectContinuation(anchor.text)) return;
    const beforeSeq = anchor.seq;
    anchor = users.findLast(message => message.seq < beforeSeq);
  }
}
