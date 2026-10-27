import { z } from "zod";

export const ReturnFailure = z.object({
  code: z.enum(["RETURN_UNAVAILABLE", "CHECKIN_BUSY", "RATE_LIMIT", "QUOTA", "ACCOUNT_QUOTA", "ABORTED"]),
  retryAfterMs: z.number().finite().nonnegative().max(365 * 86_400_000).optional(),
  resetAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type ReturnFailure = z.infer<typeof ReturnFailure>;

export class TaskReturnError extends Error {
  constructor(readonly failure: ReturnFailure) {
    super(`Task result continuation interrupted: ${failure.code}; retained for retry`);
  }
}

export function returnFailure(error: unknown): ReturnFailure {
  if (error instanceof TaskReturnError) return error.failure;
  if (error instanceof Error && "code" in error && error.code === "CHECKIN_BUSY") return { code: "CHECKIN_BUSY" };
  return { code: "RETURN_UNAVAILABLE" };
}

export function rateLimited(failure: ReturnFailure, now=Date.now()) {
  return failure.code==="RATE_LIMIT" || (["QUOTA","ACCOUNT_QUOTA"].includes(failure.code) && ((failure.retryAfterMs ?? 0)>0 || (failure.resetAt ? Date.parse(failure.resetAt)>now : false)));
}

export function returnRetryAt(failure: ReturnFailure, now: number) {
  return new Date(Math.max(now + (rateLimited(failure,now) ? 30 * 60_000 : 60_000), now + (failure.retryAfterMs ?? 0), failure.resetAt ? Date.parse(failure.resetAt) : 0)).toISOString();
}

export function providerReturnFailure(failure: {code:string;message?:string;providerRetryAfterMs?:number}, now = Date.now()): ReturnFailure | undefined {
  if (!["RATE_LIMIT", "QUOTA", "ACCOUNT_QUOTA"].includes(failure.code)) return undefined;
  const delay=ReturnFailure.shape.retryAfterMs.safeParse(failure.providerRetryAfterMs);
  const parsed = ReturnFailure.parse({code:failure.code,...(delay.success && delay.data !== undefined ? {retryAfterMs:delay.data} : {})});
  // This upstream reports a daily UTC reset in text rather than Retry-After.
  const reset = failure.message?.match(/resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/i);
  if (reset && +reset[1]! >= 1 && +reset[1]! <= 12 && +reset[2]! < 60) {
    const date = new Date(now);
    date.setUTCHours(+reset[1]! % 12 + (reset[3]!.toLowerCase() === "pm" ? 12 : 0), +reset[2]!, 0, 0);
    if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 1);
    parsed.resetAt = date.toISOString();
  }
  return parsed;
}
