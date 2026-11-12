export const topicCutoff = (observedAt: string, activeDays: number): string => new Date(Date.parse(observedAt) - activeDays * 86400000).toISOString();
export const topicActiveAt = (at: string | null, observedAt: string, activeDays: number): boolean =>
  at !== null && at >= topicCutoff(observedAt, activeDays) && at <= observedAt;
