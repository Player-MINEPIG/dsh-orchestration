/** Read/health observations can be sampled again; business commands cannot. */
export const TRANSIENT_RECEIPT_TTL_MS = 10 * 60 * 1000;

export function isTransientReceipt(operation: unknown): boolean {
  return typeof operation === "string" && [
    "listWork", "heartbeat", "getRun", "getAttempt", "receipt", "nodeStatus",
    "taskHistory", "taskWait", "approvalStatus", "sessionContext",
    "sessionMessages", "projectSnapshot",
  ].includes(operation);
}
