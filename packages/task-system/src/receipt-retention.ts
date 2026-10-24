/** Read/health observations can be sampled again; business commands cannot. */
export const TRANSIENT_RECEIPT_TTL_MS = 10 * 60 * 1000;

export function isTransientReceipt(operation: unknown, payload?: unknown): boolean {
  if (operation === "projectCollaborate" && record(payload) && record(payload.input) &&
      payload.input.action === "project-session" && record(payload.input.request)) {
    const request = payload.input.request;
    if (request.kind === "exchange" || request.kind === "decision") return true;
    if (request.kind === "application" && record(request.input)) {
      const input = request.input;
      if (["execution-settings", "conversation", "authorize-owner"].includes(String(input.kind))) return true;
      if (input.kind === "native-conversation" && record(input.input) && record(input.input.operation)) {
        const native = input.input.operation;
        return ["native-capabilities", "session-list", "session-projections", "session-page", "settings-describe", "stream-close", "model-catalog", "skills-list", "permissions-catalog", "commands-list", "attachment-read"].includes(String(native.kind)) ||
          native.kind === "stream-poll" && native.stream !== "user-question-wait";
      }
    }
  }
  return typeof operation === "string" && [
    "listWork", "heartbeat", "getRun", "executionDisposition", "getAttempt", "receipt", "nodeStatus",
    "taskHistory", "taskWait", "approvalStatus", "sessionContext",
    "sessionMessages", "projectSnapshot", "executionModelRequests", "executionModelView",
  ].includes(operation);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
