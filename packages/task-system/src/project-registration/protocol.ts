import { z } from "zod";
import { createHash } from "node:crypto";
import { canonical, TaskError } from "../ledger.js";
const key = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w][\w:./@-]*$/);
const text = z.string().trim().min(1).max(10000);
const time = z.iso.datetime({ offset: true }).nullable();
const refs = z.array(key).max(500);
const base = { externalId: key, createdAt: time, updatedAt: time };
export const RegistrationSchema = z.strictObject({
  protocol: z.literal("dsh.project-registration/v1"),
  namespace: key,
  projectExternalId: key,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  previousRevision: z.number().int().nonnegative(),
  idempotencyKey: key,
  mode: z.enum(["live", "final", "history"]),
  observedAt: z.iso.datetime({ offset: true }),
  staleAfterMs: z.number().int().min(1000).max(86400000),
  origin: z.strictObject({ nodeId: key, harness: text, workspaceUri: text }),
  project: z.strictObject({
    title: text.max(500),
    goal: text,
    state: z.enum(["active", "paused", "completed", "archived"]),
    nextStep: z.string().max(10000),
    createdAt: time,
    updatedAt: time,
    milestones: z
      .array(
        z.strictObject({
          externalId: key,
          title: text.max(500),
          weight: z.number().positive().max(1000),
          state: z.enum(["planned", "active"]),
          reportIds: refs,
        }),
      )
      .max(50),
  }),
  tasks: z
    .array(
      z.strictObject({
        ...base,
        title: text.max(500),
        description: z.string().max(10000),
        goal: z.string().max(10000),
        state: z.enum([
          "pending",
          "running",
          "waiting",
          "completed",
          "failed",
          "cancelled",
          "unknown",
        ]),
        parentTaskId: key.optional(),
        milestoneId: key.optional(),
        stage: z.enum(["next", "backlog", "supporting"]),
        rank: z.number().int().min(0).max(100000),
      }),
    )
    .max(500),
  runs: z
    .array(
      z.strictObject({
        ...base,
        taskId: key,
        parentRunId: key.optional(),
        state: z.enum([
          "queued",
          "running",
          "succeeded",
          "failed",
          "cancelled",
          "uncertain",
          "blocked",
        ]),
        outcome: z.enum([
          "success",
          "partial",
          "failure",
          "blocked",
          "unknown",
        ]),
        sessionIds: refs,
        evidenceUri: text,
        provider: text.optional(),
        model: text.optional(),
        reasoningEffort: text.optional(),
      }),
    )
    .max(1000),
  reports: z
    .array(
      z.strictObject({
        externalId: key,
        taskId: key,
        runId: key.optional(),
        title: text.max(500),
        body: z.string().trim().min(1).max(500000),
        kind: z.enum(["progress", "result", "review", "observation", "note"]),
        createdAt: time,
        evidenceUri: text,
        artifactIds: refs,
      }),
    )
    .max(1000),
  artifacts: z
    .array(
      z.strictObject({
        externalId: key,
        taskId: key,
        name: text.max(500),
        mediaType: text.max(200),
        uri: text,
        bytes: z.number().int().nonnegative().optional(),
        createdAt: time,
        availability: z.enum([
          "origin-local",
          "central",
          "unknown",
          "unavailable",
        ]),
        evidenceUri: text,
      }),
    )
    .max(2000),
  outcomes: z
    .array(
      z.strictObject({
        ...base,
        title: text.max(500),
        summary: text,
        taskIds: refs,
        reportIds: refs,
        acceptance: z.enum(["unknown", "pending_user", "accepted", "rejected"]),
        acceptanceEvidenceUri: text.optional(),
      }),
    )
    .max(100),
});
export type RegistrationPacket = z.infer<typeof RegistrationSchema>;
export function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function mappedId(
  namespace: string,
  project: string,
  kind: string,
  external: string,
) {
  return "reg-" + kind + "-" + digest([namespace, project, kind, external]);
}
export function validateRegistration(input: unknown): RegistrationPacket {
  const result = RegistrationSchema.safeParse(input);
  if (!result.success)
    throw new TaskError(
      "INVALID",
      "Invalid registration: " +
        result.error.issues
          .map((x) => x.path.join(".") + ": " + x.message)
          .join("; "),
    );
  const p = result.data;
  if (canonical(p).length > 1900000)
    throw new TaskError("TOO_LARGE", "Registration exceeds 1.9MB");
  if (p.revision !== p.previousRevision + 1)
    throw new TaskError("CONFLICT", "Revision must advance exactly once");
  if (
    p.mode === "final" &&
    !["completed", "archived"].includes(p.project.state)
  )
    throw new TaskError(
      "INVALID",
      "Final submission requires a terminal project snapshot",
    );
  const sets = Object.fromEntries(
    ["tasks", "runs", "reports", "artifacts", "outcomes"].map((k) => {
      const rows = p[k as "tasks"] as { externalId: string }[];
      const ids = new Set(rows.map((x) => x.externalId));
      if (ids.size !== rows.length)
        throw new TaskError("INVALID", "Duplicate " + k + " identity");
      return [k, ids];
    }),
  );
  const milestones = new Set(p.project.milestones.map((x) => x.externalId));
  if (milestones.size !== p.project.milestones.length)
    throw new TaskError("INVALID", "Duplicate milestone");
  const ref = (kind: string, value: string | undefined) => {
    if (value && !(kind === "milestones" ? milestones : sets[kind])?.has(value))
      throw new TaskError("INVALID", "Dangling " + kind + " reference");
  };
  for (const t of p.tasks) {
    ref("tasks", t.parentTaskId);
    ref("milestones", t.milestoneId);
    const visited = new Set([t.externalId]);
    let parent = t.parentTaskId;
    while (parent) {
      if (visited.has(parent))
        throw new TaskError("INVALID", "Task parent cycle");
      visited.add(parent);
      parent = p.tasks.find((x) => x.externalId === parent)?.parentTaskId;
    }
  }
  for (const r of p.runs) {
    ref("tasks", r.taskId);
    ref("runs", r.parentRunId);
    if (r.parentRunId) {
      const parentRun = p.runs.find((x) => x.externalId === r.parentRunId);
      const task = p.tasks.find((x) => x.externalId === r.taskId);
      if (task?.parentTaskId !== parentRun?.taskId)
        throw new TaskError(
          "INVALID",
          "Run parent task must match source task parent",
        );
    }
    const visited = new Set([r.externalId]);
    let parent = r.parentRunId;
    while (parent) {
      if (visited.has(parent))
        throw new TaskError("INVALID", "Run parent cycle");
      visited.add(parent);
      parent = p.runs.find((x) => x.externalId === parent)?.parentRunId;
    }
  }
  for (const r of p.reports) {
    ref("tasks", r.taskId);
    ref("runs", r.runId);
    if (
      r.runId &&
      p.runs.find((x) => x.externalId === r.runId)?.taskId !== r.taskId
    )
      throw new TaskError("INVALID", "Report run/task mismatch");
    r.artifactIds.forEach((x) => {
      ref("artifacts", x);
      if (p.artifacts.find((a) => a.externalId === x)?.taskId !== r.taskId)
        throw new TaskError("INVALID", "Report artifact/task mismatch");
    });
  }
  p.artifacts.forEach((a) => ref("tasks", a.taskId));
  p.project.milestones.forEach((m) =>
    m.reportIds.forEach((x) => ref("reports", x)),
  );
  for (const o of p.outcomes) {
    o.taskIds.forEach((x) => ref("tasks", x));
    o.reportIds.forEach((x) => ref("reports", x));
    if (
      ["accepted", "rejected"].includes(o.acceptance) &&
      !o.acceptanceEvidenceUri
    )
      throw new TaskError(
        "INVALID",
        "Source acceptance claim requires evidence URI",
      );
  }
  return p;
}
