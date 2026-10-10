import { TaskError, canonical } from "../ledger.js";
import {
  digest,
  mappedId,
  validateRegistration,
  type RegistrationPacket,
} from "./protocol.js";
export interface RegistrationRecord {
  registrationId: string;
  projectId: string;
  namespace: string;
  projectExternalId: string;
  sourceRevision: number;
  digest: string;
  mode: RegistrationPacket["mode"];
  importedAt: string;
  updatedAt: string;
  observedAt: string;
  staleAfterMs: number;
  origin: RegistrationPacket["origin"];
  packet: RegistrationPacket;
  central: {
    revision: number;
    note: string;
    review: "unreviewed" | "accepted" | "needs_work";
    actor?: string;
    evidenceReportIds: string[];
    revoked: boolean;
    withdrawn: boolean;
  };
}
export interface RegistrationStore {
  get<T>(kind: string, id: string): T | undefined;
  put(
    kind: string,
    id: string,
    value: unknown,
    parent?: string | null,
    state?: string | null,
  ): void;
  now(): string;
}
export function intakeRegistration(
  s: RegistrationStore,
  input: unknown,
  namespaces?: readonly string[],
) {
  const p = validateRegistration(input);
  if (namespaces && !namespaces.includes(p.namespace))
    throw new TaskError("FORBIDDEN", "Source namespace not authorized");
  const map = (kind: string, external: string) =>
    mappedId(p.namespace, p.projectExternalId, kind, external);
  const registrationId = map("registration", p.projectExternalId),
    projectId = map("project", p.projectExternalId),
    old = s.get<RegistrationRecord>("registration", registrationId),
    hash = digest(p);
  // Replay is decided before terminal/revocation checks, and returns the original source receipt.
  const receiptId = map("receipt", String(p.revision)),
    prior = s.get<{ digest: string; value: unknown }>(
      "registration-receipt",
      receiptId,
    );
  if (prior) {
    if (prior.digest !== hash)
      throw new TaskError("CONFLICT", "Source revision has different content");
    return prior.value;
  }
  if (old?.central.revoked || old?.central.withdrawn)
    throw new TaskError(
      "FORBIDDEN",
      "Registration intake has been revoked or withdrawn",
    );
  if ((old?.sourceRevision ?? 0) !== p.previousRevision)
    throw new TaskError("CONFLICT", "Source revision changed; refresh receipt");
  if (old && old.mode !== "live")
    throw new TaskError(
      "CONFLICT",
      "Final/history submission is sealed; create a distinct source project for follow-up",
    );
  if (old && p.mode === "history")
    throw new TaskError(
      "CONFLICT",
      "Historical intake cannot overwrite a live registration",
    );
  if (old && canonical(old.origin) !== canonical(p.origin))
    throw new TaskError("CONFLICT", "Origin identity changed");
  if (old && Date.parse(p.observedAt) < Date.parse(old.observedAt))
    throw new TaskError("CONFLICT", "Observation time moved backwards");
  if (old)
    for (const kind of [
      "tasks",
      "runs",
      "reports",
      "artifacts",
      "outcomes",
    ] as const)
      for (const row of old.packet[kind]) {
        const next = p[kind].find((x) => x.externalId === row.externalId);
        if (!next)
          throw new TaskError(
            "CONFLICT",
            "Full snapshots cannot drop existing identities",
          );
        if (
          ["reports", "artifacts"].includes(kind) &&
          canonical(row) !== canonical(next)
        )
          throw new TaskError(
            "CONFLICT",
            "Evidence immutable; append a new external identity",
          );
        if (
          kind === "runs" &&
          !["queued", "running"].includes(
            (row as RegistrationPacket["runs"][number]).state,
          ) &&
          canonical(row) !== canonical(next)
        )
          throw new TaskError("CONFLICT", "Terminal run evidence immutable");
      }
  const now = s.now(),
    timestamp = (t: string | null) => t ?? now;
  const put = (
    kind: string,
    id: string,
    v: unknown,
    parent: string | null = null,
    state: string | null = null,
  ) => {
    const previous = s.get(kind, id);
    if (previous && !old && kind !== "workspace")
      throw new TaskError("CONFLICT", "Identity already exists");
    s.put(kind, id, v, parent, state);
  };
  // These workspace references authorize no filesystem access or node execution.
  const workspaceId = map("workspace", p.projectExternalId);
  put("workspace", workspaceId, {
    workspaceId,
    nodeId: p.origin.nodeId,
    path: p.origin.workspaceUri,
    label: p.project.title,
    state: "archived",
    createdAt: old?.importedAt ?? now,
  });
  put(
    "project",
    projectId,
    {
      projectId,
      title: p.project.title,
      goal: p.project.goal,
      state: p.project.state,
      nextStep: p.project.nextStep,
      workspaceId,
      milestones: p.project.milestones.map((m) => ({
        milestoneId: map("milestone", m.externalId),
        title: m.title,
        weight: m.weight,
        state: m.state,
        evidenceReportIds: m.reportIds.map((x) => map("report", x)),
      })),
      revision:
        (s.get<{ revision: number }>("project", projectId)?.revision ?? 0) + 1,
      createdAt:
        p.project.createdAt ??
        s.get<{ createdAt: string }>("project", projectId)?.createdAt ??
        now,
      updatedAt: timestamp(p.project.updatedAt),
    },
    null,
    p.project.state,
  );
  for (const [rank, t] of p.tasks.entries()) {
    const taskId = map("task", t.externalId),
      prev = s.get<{ admissionState?: string; admissionRevision?: number }>(
        "task",
        taskId,
      );
    const state = ["unknown", "pending"].includes(t.state) ? "inbox" : t.state;
    put(
      "task",
      taskId,
      {
        taskId,
        title: t.title,
        description: t.description,
        goal: t.goal,
        state,
        kind: "observed",
        createdAt:
          t.createdAt ??
          s.get<{ createdAt: string }>("task", taskId)?.createdAt ??
          now,
        updatedAt: timestamp(t.updatedAt),
        tags: ["source:" + p.namespace, "registration:" + p.mode],
        intentRevision: p.revision,
        workspaceId,
        ...(t.parentTaskId
          ? { parentTaskId: map("task", t.parentTaskId) }
          : {}),
        admissionState: prev?.admissionState ?? "admitted",
        admissionRevision: prev?.admissionRevision ?? 1,
        source: {
          originalTimesUnknown: t.createdAt === null || t.updatedAt === null,
          label: p.namespace,
          observedAt: p.observedAt,
          importedAt: old?.importedAt ?? now,
          ...(t.createdAt ? { originalCreatedAt: t.createdAt } : {}),
        },
      },
      t.parentTaskId ? map("task", t.parentTaskId) : null,
      state,
    );
    const linkId = map("link", t.externalId);
    put(
      "project-task",
      linkId,
      {
        linkId,
        projectId,
        taskId,
        stage: t.stage,
        rank: t.rank ?? rank,
        revision: p.revision,
        updatedAt: now,
        ...(t.milestoneId
          ? { milestoneId: map("milestone", t.milestoneId) }
          : {}),
      },
      projectId,
    );
  }
  for (const r of p.runs) {
    const runId = map("run", r.externalId),
      taskId = map("task", r.taskId);
    put(
      "run",
      runId,
      {
        runId,
        taskId,
        state: r.state,
        outcome: r.outcome,
        sessionIds: r.sessionIds,
        observationOnly: true,
        configuration: {
          sourceExecution: {
            evidenceUri: r.evidenceUri,
            provider: r.provider ?? null,
            model: r.model ?? null,
            reasoningEffort: r.reasoningEffort ?? null,
            originalCreatedAt: r.createdAt,
            originalUpdatedAt: r.updatedAt,
          },
        },
        createdAt:
          r.createdAt ??
          s.get<{ createdAt: string }>("run", runId)?.createdAt ??
          now,
        updatedAt: timestamp(r.updatedAt),
        ...(r.parentRunId ? { parentRunId: map("run", r.parentRunId) } : {}),
      },
      taskId,
      r.state,
    );
  }
  for (const a of p.artifacts) {
    const artifactId = map("artifact", a.externalId);
    if (!s.get("artifact", artifactId))
      put(
        "artifact",
        artifactId,
        {
          artifactId,
          taskId: map("task", a.taskId),
          name: a.name,
          mediaType: a.mediaType,
          uri: a.uri,
          ...(a.bytes !== undefined ? { bytes: a.bytes } : {}),
          createdAt: timestamp(a.createdAt),
          finalized: false,
        },
        map("task", a.taskId),
      );
  }
  for (const r of p.reports) {
    const reportId = map("report", r.externalId);
    if (!s.get("report", reportId))
      put(
        "report",
        reportId,
        {
          reportId,
          taskId: map("task", r.taskId),
          ...(r.runId ? { runId: map("run", r.runId) } : {}),
          title: r.title,
          body: r.body,
          kind: r.kind,
          revision: 1,
          artifactIds: r.artifactIds.map((x) => map("artifact", x)),
          createdAt: timestamp(r.createdAt),
          recordedAt: now,
          data: {
            evidenceUri: r.evidenceUri,
            originalCreatedAt: r.createdAt,
            sourceNamespace: p.namespace,
          },
        },
        map("task", r.taskId),
      );
  }
  for (const o of p.outcomes) {
    const outcomeId = map("outcome", o.externalId),
      prev = s.get<{ state: string; feedback: string; revision: number }>(
        "outcome",
        outcomeId,
      );
    put("outcome", outcomeId, {
      outcomeId,
      title: o.title,
      summary: o.summary,
      feedback:
        prev?.feedback ?? "来源验收声明：" + o.acceptance + "；中央尚未复核",
      state: prev?.state ?? "draft",
      projectIds: [projectId],
      taskIds: o.taskIds.map((x) => map("task", x)),
      reportIds: o.reportIds.map((x) => map("report", x)),
      capabilityIds: [],
      revision: (prev?.revision ?? 0) + 1,
      createdAt:
        o.createdAt ??
        s.get<{ createdAt: string }>("outcome", outcomeId)?.createdAt ??
        now,
      updatedAt: now,
    });
  }
  const record: RegistrationRecord = {
    registrationId,
    projectId,
    namespace: p.namespace,
    projectExternalId: p.projectExternalId,
    sourceRevision: p.revision,
    digest: hash,
    mode: p.mode,
    importedAt: old?.importedAt ?? now,
    updatedAt: now,
    observedAt: p.observedAt,
    staleAfterMs: p.staleAfterMs,
    origin: p.origin,
    packet: p,
    central: old?.central ?? {
      revision: 0,
      note: "",
      review: "unreviewed",
      evidenceReportIds: [],
      revoked: false,
      withdrawn: false,
    },
  };
  s.put("registration", registrationId, record);
  const receipt = {
    protocol: p.protocol,
    registrationId,
    projectId,
    sourceRevision: p.revision,
    digest: hash,
    importedAt: now,
    identityMap: Object.fromEntries(
      ["tasks", "runs", "reports", "artifacts", "outcomes"].map((k) => [
        k,
        Object.fromEntries(
          p[k as "tasks"].map((x) => [
            x.externalId,
            map(k.slice(0, -1), x.externalId),
          ]),
        ),
      ]),
    ),
  };
  s.put("registration-receipt", receiptId, { digest: hash, value: receipt });
  return receipt;
}
export function manageRegistration(
  s: RegistrationStore,
  input: {
    registrationId: string;
    expectedRevision: number;
    note: string;
    review: RegistrationRecord["central"]["review"];
    evidenceReportIds: string[];
    revoked: boolean;
  },
  actor: string,
) {
  const old = s.get<RegistrationRecord>("registration", input.registrationId);
  if (!old) throw new TaskError("NOT_FOUND", "Registration not found");
  if (old.central.revision !== input.expectedRevision)
    throw new TaskError("CONFLICT", "Central revision changed");
  if (
    !actor.trim() ||
    typeof input.note !== "string" ||
    input.note.length > 10000 ||
    !["unreviewed", "accepted", "needs_work"].includes(input.review) ||
    typeof input.revoked !== "boolean" ||
    !Array.isArray(input.evidenceReportIds) ||
    input.evidenceReportIds.length > 100
  )
    throw new TaskError("INVALID", "Invalid central metadata");
  for (const id of input.evidenceReportIds)
    if (
      !old.packet.reports.some(
        (r) =>
          mappedId(
            old.namespace,
            old.projectExternalId,
            "report",
            r.externalId,
          ) === id,
      )
    )
      throw new TaskError("INVALID", "Review evidence must belong to project");
  if (input.review !== "unreviewed" && !input.evidenceReportIds.length)
    throw new TaskError("INVALID", "Review requires report evidence");
  const record = {
    ...old,
    central: {
      ...old.central,
      note: input.note,
      review: input.review,
      evidenceReportIds: input.evidenceReportIds,
      revoked: input.revoked,
      revision: old.central.revision + 1,
      actor,
    },
  };
  s.put("registration", old.registrationId, record);
  return record.central;
}
