import { CronExpressionParser } from "cron-parser";
import type { Json, Schedule } from "./contracts.js";

/** Resolve a calendar window from the scheduled slot, never the recovery time. */
export function scheduleInput(schedule: Pick<Schedule, "input" | "calendarWindow">, occurrenceAt: string): Json {
  if (schedule.calendarWindow === undefined) return schedule.input;
  const rule = schedule.calendarWindow;
  if (
    !rule ||
    typeof rule !== "object" ||
    Object.keys(rule).some((k) => !["timeZone", "dayOffset"].includes(k)) ||
    typeof rule.timeZone !== "string" ||
    ![-1, 0].includes(rule.dayOffset) ||
    !schedule.input ||
    typeof schedule.input !== "object" ||
    Array.isArray(schedule.input)
  )
    throw new Error("Invalid schedule calendar window");
  const instant = Date.parse(occurrenceAt);
  if (!Number.isFinite(instant)) throw new Error("Invalid schedule occurrence");
  new Intl.DateTimeFormat("en", { timeZone: rule.timeZone }).format();
  const days = CronExpressionParser.parse("0 0 * * *", {
    tz: rule.timeZone,
    currentDate: new Date(instant + 1),
  });
  let start = days.prev().toISOString()!;
  let end: string;
  if (rule.dayOffset === -1) {
    end = start;
    start = days.prev().toISOString()!;
  } else
    end = CronExpressionParser.parse("0 0 * * *", {
      tz: rule.timeZone,
      currentDate: start,
    })
      .next()
      .toISOString()!;
  return {
    ...schedule.input,
    windowStart: start,
    windowEnd: end,
    timeZone: rule.timeZone,
  };
}
