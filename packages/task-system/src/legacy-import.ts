import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type {
  Artifact,
  Event,
  Json,
  Report,
  Run,
  Snapshot,
  Task,
} from "./contracts.js";
import { TaskError } from "./ledger.js";

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
// Selected historical tables contain SQL scalars. Preserve original JSON strings
// alongside projections so malformed or unfamiliar payloads are never discarded.
const sourceRow = (row: Row): Json =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v === null || typeof v === "string" || typeof v === "boolean"
        ? v
        : typeof v === "number" && Number.isFinite(v)
          ? v
          : typeof v === "bigint"
            ? v.toString()
            : v instanceof Uint8Array
              ? { encoding: "base64", value: Buffer.from(v).toString("base64") }
              : null,
    ]),
  );
function parsed(v: unknown, fallback: Json = null): Json {
  try {
    return JSON.parse(str(v)) as Json;
  } catch {
    return fallback;
  }
}
const key = (namespace: string, kind: string, v: unknown) =>
  `${namespace}:${kind}:${createHash("sha256").update(str(v)).digest("hex").slice(0, 32)}`;
const taskState = (s: string): Task["state"] =>
  (
    ({
      succeeded: "completed",
      completed: "completed",
      success: "completed",
      failed: "failed",
      cancelled: "cancelled",
      canceled: "cancelled",
      dismissed: "archived",
      archived: "archived",
      blocked: "waiting",
      running: "waiting",
      queued: "ready",
      pending: "inbox",
    }) as Record<string, Task["state"]>
  )[s] ?? "waiting";
const runState = (s: string): Run["state"] =>
  (
    ({
      succeeded: "succeeded",
      success: "succeeded",
      completed: "succeeded",
      partial: "succeeded",
      failed: "failed",
      cancelled: "cancelled",
      canceled: "cancelled",
      blocked: "blocked",
    }) as Record<string, Run["state"]>
  )[s] ?? "uncertain";
/** Read-only historical import. Does not import credential configuration, activate schedules, claim leases or execute old work. Report content remains private user data. */
export function readLegacyHermes(
  databasePath: string,
  options: { namespace?: string; maxRows?: number; observedAt?: string } = {},
): { snapshot: Snapshot; warnings: string[] } {
  const namespace = options.namespace ?? "hermes";
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace))
    throw new TaskError("INVALID", "Invalid import namespace");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const at = options.observedAt ?? new Date().toISOString();
  const warnings: string[] = [];
  const maxRows = options.maxRows ?? 50000;
  const exists = (table: string) =>
    Boolean(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table),
    );
  const rows = (table: string): Row[] => {
    if (!exists(table)) {
      warnings.push(`Missing source table ${table}`);
      return [];
    }
    const count = Number(
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
        .n,
    );
    if (count > maxRows)
      throw new TaskError(
        "TOO_LARGE",
        `${table} exceeds explicit import limit`,
      );
    return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  };
  try {
    const sourceTasks = rows("task_instances");
    const rawRuns = rows("task_runs"),
      rawReports = rows("task_result_submissions"),
      rawArtifacts = rows("report_artifacts"),
      rawEvents = rows("events");
    const inertTables = [
      "task_messages",
      "task_intake_candidates",
      "notification_outbox",
      "notification_card_actions",
      "alerts",
      "task_templates",
      "schedule_bindings",
      "schedule_occurrences",
      "dispatch_decisions",
      "session_resolution_decisions",
      "transient_run_retries",
      "worker_leases",
      "task_snapshots",
      "outbox",
      "candidate_bindings",
      "health",
    ];
    const inertRows = inertTables.flatMap((table) =>
      exists(table) ? rows(table).map((row) => ({ table, row })) : [],
    );
    const taskIds = new Set(sourceTasks.map((t) => str(t.task_id)));
    for (const row of [
      ...rawRuns,
      ...rawReports,
      ...rawArtifacts,
      ...rawEvents,
      ...inertRows.map(({ row }) => row),
    ]) {
      const sourceId = str(
        row.task_id ?? row.target_task_id ?? row.root_task_id,
      );
      if (sourceId && !taskIds.has(sourceId)) {
        sourceTasks.push({
          task_id: sourceId,
          title: "Unlinked legacy task",
          description:
            "Task definition missing from source; related evidence preserved without inventing its original goal.",
          status: "unknown",
        });
        taskIds.add(sourceId);
        warnings.push(
          "Missing task definition preserved as explicit unknown: " + sourceId,
        );
      }
    }
    const tasks: Task[] = sourceTasks.map((t) => ({
      taskId: key(namespace, "task", t.task_id),
      title: str(t.title) || "Imported task",
      description: str(t.description),
      kind: "observed",
      state: taskState(str(t.status)),
      createdAt: str(t.created_at) || at,
      updatedAt: str(t.updated_at) || at,
      tags: ["legacy-import", `legacy-id:${str(t.task_id)}`],
      admissionState:
        str(t.admission_state) === "dismissed" ? "dismissed" : "admitted",
      admissionRevision: 1,
      ...(taskIds.has(str(t.parent_task_id))
        ? { parentTaskId: key(namespace, "task", t.parent_task_id) }
        : {}),
      source: {
        label: "Read-only Hermes snapshot",
        observedAt: at,
        importedAt: at,
        ...(str(t.created_at) ? { originalCreatedAt: str(t.created_at) } : {}),
      },
    }));
    const sourceRuns = rawRuns.filter((r) => {
      if (!taskIds.has(str(r.task_id))) {
        warnings.push(`Orphan run retained only in source: ${str(r.run_id)}`);
        return false;
      }
      return true;
    });
    const runIds = new Set(sourceRuns.map((r) => str(r.run_id)));
    const runs: Run[] = sourceRuns.map((r) => ({
      runId: key(namespace, "run", r.run_id),
      taskId: key(namespace, "task", r.task_id),
      state: runState(str(r.status)),
      createdAt: str(r.created_at) || at,
      updatedAt: str(r.updated_at) || at,
      sessionIds: [
        r.session_id,
        r.runtime_session_id,
        r.stored_session_id,
        r.serve_runtime_session_id,
        r.serve_stored_session_id,
      ].filter((v): v is string => typeof v === "string" && v.length > 0),
      configuration: {
        legacyRunId: str(r.run_id),
        legacyDevice: str(r.device_id),
        legacyState: str(r.status),
        legacyAttempt: Number(r.attempt) || 1,
        importedAsObservation: true,
        sourceRecord: sourceRow(r),
      },
      ...(runState(str(r.status)) === "uncertain"
        ? { outcome: "unknown" as const }
        : {}),
    }));
    const reports: Report[] = rawReports
      .filter((r) => taskIds.has(str(r.task_id)))
      .map((r) => ({
        reportId: key(namespace, "submission", r.submission_id),
        taskId: key(namespace, "task", r.task_id),
        ...(sourceRuns.some(
          (run) =>
            str(run.run_id) === str(r.run_id) &&
            str(run.task_id) === str(r.task_id),
        )
          ? { runId: key(namespace, "run", r.run_id) }
          : {}),
        revision: 1,
        data: sourceRow(r),
        schemaId: "hermes-source/task_result_submissions",
        title: `Imported ${str(r.result_kind) || "result"} (${str(r.status) || "unknown validation"})`,
        body: JSON.stringify(
          {
            payload: parsed(r.payload_json),
            validation: parsed(r.validation_json),
            authoritativeResult: parsed(r.final_result_json),
            sourceSchema: str(r.schema_version),
            legacyRunId: str(r.run_id),
          },
          null,
          2,
        ),
        createdAt: str(r.created_at) || at,
        recordedAt: at,
        artifactIds: [],
        kind: "observation",
      }));
    for (const task of sourceTasks) {
      reports.push({
        reportId: key(namespace, "task-definition", task.task_id),
        taskId: key(namespace, "task", task.task_id),
        revision: 1,
        title: "Imported task definition and configuration evidence",
        body: "Historical configuration retained for review only; permissions, schedules and credentials are not activated.",
        data: sourceRow(task),
        schemaId: "hermes-source/task_instances",
        createdAt: str(task.updated_at) || str(task.created_at) || at,
        recordedAt: at,
        artifactIds: [],
        kind: "observation",
      });
    }
    for (const r of sourceRuns) {
      const summary = str(r.result_summary) || str(r.error_message);
      if (summary)
        reports.push({
          reportId: key(namespace, "run-summary", r.run_id),
          taskId: key(namespace, "task", r.task_id),
          runId: key(namespace, "run", r.run_id),
          revision: 1,
          title: "Imported run summary",
          body: summary,
          createdAt: str(r.updated_at) || at,
          recordedAt: at,
          artifactIds: [],
          kind: "observation",
        });
    }
    const artifacts: Artifact[] = rawArtifacts
      .filter((a) => taskIds.has(str(a.root_task_id)))
      .map((a) => ({
        artifactId: key(namespace, "artifact", a.artifact_id),
        taskId: key(namespace, "task", a.root_task_id),
        name: str(a.report_kind) || "Legacy artifact",
        mediaType: "application/json",
        ...(str(a.artifact_path) ? { uri: str(a.artifact_path) } : {}),
        ...(str(a.sha256) ? { sha256: str(a.sha256) } : {}),
        bytes: Number(a.byte_length) || 0,
        createdAt: str(a.created_at) || at,
        finalized: false,
      }));
    for (const artifact of rawArtifacts.filter((a) =>
      taskIds.has(str(a.root_task_id)),
    )) {
      reports.push({
        reportId: key(namespace, "artifact-evidence", artifact.artifact_id),
        taskId: key(namespace, "task", artifact.root_task_id),
        revision: 1,
        title: "Imported report artifact payload and provenance",
        body: "Stored artifact payload and original digest retained. Referenced external bytes have not been revalidated.",
        data: sourceRow(artifact),
        schemaId: "hermes-source/report_artifacts",
        createdAt: str(artifact.created_at) || at,
        recordedAt: at,
        artifactIds: [key(namespace, "artifact", artifact.artifact_id)],
        kind: "observation",
      });
    }
    const events: Event[] = rawEvents
      .filter((e) => !e.task_id || taskIds.has(str(e.task_id)))
      .map((e) => ({
        eventId: key(namespace, "event", e.event_id),
        ...(e.task_id ? { taskId: key(namespace, "task", e.task_id) } : {}),
        ...(runIds.has(str(e.run_id))
          ? { runId: key(namespace, "run", e.run_id) }
          : {}),
        type: `legacy.${str(e.event_type) || "event"}`,
        at: str(e.occurred_at) || str(e.created_at) || at,
        detail: {
          title: str(e.title),
          summary: str(e.summary),
          legacyEventId: str(e.event_id),
          sourceRecord: sourceRow(e),
        },
      }));
    for (const { table, row } of inertRows) {
      const sourceId = str(
        row.task_id ?? row.target_task_id ?? row.root_task_id,
      );
      const record = sourceRow(row);
      const digest = createHash("sha256")
        .update(JSON.stringify(record))
        .digest("hex");
      events.push({
        eventId: key(namespace, `source-${table}`, digest),
        ...(taskIds.has(sourceId)
          ? { taskId: key(namespace, "task", sourceId) }
          : {}),
        ...(runIds.has(str(row.run_id))
          ? { runId: key(namespace, "run", row.run_id) }
          : {}),
        type: `legacy.source.${table}`,
        at: str(row.updated_at) || str(row.created_at) || at,
        detail: { sourceTable: table, record, importedAsEvidenceOnly: true },
      });
      if (table === "task_messages" && taskIds.has(sourceId))
        reports.push({
          reportId: key(namespace, "message-evidence", digest),
          taskId: key(namespace, "task", sourceId),
          revision: 1,
          title: "Imported queued/follow-up message evidence",
          body:
            JSON.stringify(
              parsed(row.content_json, str(row.content_json)),
              null,
              2,
            ) || "Historical task message",
          data: record,
          schemaId: "hermes-source/task_messages",
          createdAt: str(row.created_at) || at,
          recordedAt: at,
          artifactIds: [],
          kind: "observation",
        });
    }
    warnings.push(
      "Historical overwritten payload revisions cannot be reconstructed; no missing content was invented.",
      "Artifact paths/digests are references only until the bytes are separately revalidated.",
      "Live runs imported as uncertain observations; schedules, peer identities, credentials and leases are never activated.",
      "Historical messages, candidates, notification intents, alerts, schedules and operational decisions are inert evidence only; pending work and callbacks are not reactivated.",
    );
    return {
      snapshot: {
        schemaVersion: "1",
        generatedAt: at,
        source: {
          kind: "explicit-import",
          label: "Read-only legacy Hermes import",
          observedAt: at,
          staleAfterMs: 86400_000,
        },
        tasks,
        runs,
        reports,
        artifacts,
        templates: [],
        events,
      },
      warnings,
    };
  } finally {
    db.close();
  }
}
