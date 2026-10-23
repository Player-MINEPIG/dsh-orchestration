import type { Json, Run, Snapshot } from "./contracts.js";

function scheduledFor(configuration: Json): string | undefined {
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration)
  )
    return;
  const trigger = configuration.trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return;
  return typeof trigger.scheduledFor === "string" &&
    Number.isFinite(Date.parse(trigger.scheduledFor))
    ? trigger.scheduledFor
    : undefined;
}

export function scheduledTimeZone(configuration: Json): string | undefined {
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration)
  )
    return;
  const trigger = configuration.trigger;
  if (
    !trigger ||
    typeof trigger !== "object" ||
    Array.isArray(trigger) ||
    typeof trigger.timeZone !== "string"
  )
    return;
  try {
    new Intl.DateTimeFormat("en", { timeZone: trigger.timeZone });
    return trigger.timeZone;
  } catch {
    return;
  }
}

function dateParts(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  return parts
    .filter((part) => ["year", "month", "day"].includes(part.type))
    .map((part) => part.value)
    .join("-");
}

/** Derive display text from the dispatched intent and scheduled slot, never wall time. */
export function taskSessionTitle(input: {
  title: string;
  configuration: Json;
  timeZone?: string;
  ordinal?: number;
}): string {
  const clean = input.title.replace(/\s+/gu, " ").trim() || "任务";
  const characters = Array.from(clean);
  const base =
    characters.length > 30 ? characters.slice(0, 29).join("") + "…" : clean;
  const slot = scheduledFor(input.configuration);
  const timeZone = scheduledTimeZone(input.configuration) ?? input.timeZone;
  const date =
    slot && timeZone ? ` · ${dateParts(slot, timeZone).slice(5)}` : "";
  const ordinal =
    input.ordinal && input.ordinal > 1 ? ` · 第${input.ordinal}次` : "";
  const suffix = date + ordinal;
  const available = Array.from(base);
  while (
    available.length &&
    Buffer.byteLength(available.join("") + suffix) > 80
  )
    available.pop();
  return available.join("").trimEnd() + suffix;
}

/** The authority's ordered Run history supplies repeat numbering, scoped to a scheduled day. */
export function runSessionTitle(
  run: Run,
  snapshot: Pick<Snapshot, "tasks" | "runs"> & { timeZone?: string },
): string {
  const task = snapshot.tasks.find((task) => task.taskId === run.taskId);
  if (!task) throw new Error("Task title authority is missing");
  const timeZone = scheduledTimeZone(run.configuration) ?? snapshot.timeZone;
  const slot = scheduledFor(run.configuration);
  const runs = snapshot.runs.filter(
    (candidate) =>
      candidate.taskId === task.taskId &&
      !candidate.historyOnly &&
      !candidate.observationOnly,
  );
  const index = runs.findIndex((candidate) => candidate.runId === run.runId);
  const preceding = index < 0 ? [] : runs.slice(0, index + 1);
  const ordinal =
    slot && timeZone
      ? preceding.filter((candidate) => {
          const candidateSlot = scheduledFor(candidate.configuration);
          return (
            candidateSlot &&
            dateParts(
              candidateSlot,
              scheduledTimeZone(candidate.configuration) ?? timeZone,
            ) === dateParts(slot, timeZone)
          );
        }).length
      : slot
        ? undefined
        : preceding.length;
  return taskSessionTitle({
    title: run.intentSnapshot?.title ?? task.title,
    configuration: run.configuration,
    timeZone,
    ordinal,
  });
}
