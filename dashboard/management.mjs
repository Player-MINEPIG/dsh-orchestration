/** Private management projection. Execution ownership is read from attempts, never route. */
const pick = (record = {}, fields) =>
  Object.fromEntries(
    fields
      .filter((key) => record?.[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
const arrays = {
  domains: ["domainId", "revision", "title", "summary", "state", "position"],
  projects: [
    "projectId",
    "revision",
    "title",
    "goal",
    "description",
    "state",
    "nextStep",
    "acceptanceCriteria",
    "targetAt",
    "createdAt",
    "updatedAt",
  ],
  backlogs: [
    "backlogId",
    "revision",
    "projectId",
    "title",
    "goal",
    "state",
    "priority",
    "acceptanceCriteria",
    "conditionStatus",
    "targetAt",
  ],
  domainProjects: ["domainId", "projectId"],
  backlogTasks: ["backlogId", "taskId"],
  projectWorkspaces: ["projectId", "workspaceId", "nodeId", "isDefault"],
  skills: [
    "skillId",
    "revision",
    "title",
    "summary",
    "abilityStatement",
    "practiceNotes",
    "methodNotes",
    "limitations",
    "state",
    "createdAt",
    "updatedAt",
  ],
  milestones: [
    "milestoneId",
    "projectId",
    "revision",
    "title",
    "goal",
    "state",
    "conditions",
    "completionMode",
    "conditionStatus",
    "targetAt",
  ],
  artifactRelations: [
    "relationId",
    "artifactId",
    "kind",
    "targetId",
    "action",
    "context",
    "runId",
    "attemptId",
    "recordedAt",
  ],
  criterionChecks: [
    "checkId",
    "ownerType",
    "ownerId",
    "ownerRevision",
    "criterionId",
    "observedStatus",
    "evidenceRefs",
    "note",
    "checkedAt",
    "source",
  ],
};
export function managementSnapshot(
  execution,
  workbench,
  identity,
  { canManage = false } = {},
) {
  const attempts = (execution.attempts || []).map((x) =>
    pick(x, [
      "attemptId",
      "taskId",
      "runId",
      "nodeId",
      "fence",
      "leaseExpiresAt",
      "state",
      "createdAt",
      "updatedAt",
      "sessionId",
      "executionId",
    ]),
  );
  const reports = (execution.reports || []).map((x) =>
    pick(x, [
      "reportId",
      "taskId",
      "runId",
      "attemptId",
      "sessionId",
      "revision",
      "previousReportId",
      "title",
      "body",
      "data",
      "schemaId",
      "kind",
      "createdAt",
      "recordedAt",
      "artifactIds",
    ]),
  );
  return {
    schemaVersion: "management.v1",
    generatedAt: execution.generatedAt,
    database: { ...identity },
    permissions: { canManage },
    source: pick(execution.source, [
      "kind",
      "label",
      "observedAt",
      "staleAfterMs",
    ]),
    ...Object.fromEntries(
      Object.entries(arrays).map(([key, fields]) => [
        key,
        (workbench[key] || []).map((x) => pick(x, fields)),
      ]),
    ),
    tasks: (execution.tasks || []).map((x) =>
      pick(x, [
        "taskId",
        "revision",
        "intentRevision",
        "title",
        "description",
        "goal",
        "acceptanceCriteria",
        "priority",
        "priorityOverride",
        "targetAt",
        "state",
        "kind",
        "parentTaskId",
        "workspaceId",
        "tags",
        "createdAt",
        "updatedAt",
      ]),
    ),
    runs: (execution.runs || []).map((x) => ({
      ...pick(x, [
        "runId",
        "taskId",
        "state",
        "createdAt",
        "updatedAt",
        "currentAttemptId",
        "historyOnly",
        "intentSnapshot",
        "templateId",
        "templateVersion",
        "reviewStatus",
        "cancellationRequested",
      ]),
      ...(x.route
        ? {
            route: pick(x.route, [
              "nodeId",
              "provider",
              "model",
              "reasoningEffort",
              "workspaceId",
            ]),
          }
        : {}),
      // Canonical ledger projection derives these from Attempt + explicit context associations.
      sessionIds: x.sessionIds || [],
      ...(x.configuration?.templateRef
        ? {
            templateRef: pick(x.configuration.templateRef, [
              "templateId",
              "version",
            ]),
          }
        : {}),
    })),
    attempts,
    reports,
    artifacts: [...(execution.artifacts || []), ...(workbench.artifacts || [])]
      .filter(
        (x, i, all) =>
          all.findIndex((y) => y.artifactId === x.artifactId) === i,
      )
      .map((x) =>
        pick(x, [
          "artifactId",
          "materialId",
          "taskId",
          "reportId",
          "name",
          "mediaType",
          "uri",
          "sha256",
          "bytes",
          "createdAt",
          "finalized",
          "contentRef",
          "availability",
          "versionStatus",
        ]),
      ),
    events: (execution.events || []).map((x) => ({
      ...pick(x, ["eventId", "taskId", "runId", "type", "at"]),
      detail: pick(x.detail, [
        "summary",
        "message",
        "title",
        "reason",
        "reasonCode",
        "code",
        ...(x.type === "run.pre_dispatch_failed"
          ? ["origin", "phase", "provider", "model", "attemptId", "nodeId"]
          : []),
      ]),
    })),
    workspaces: (execution.workspaces || []).map((x) =>
      pick(x, ["workspaceId", "nodeId", "path", "label", "state"]),
    ),
  };
}
export const MANAGEMENT_OPERATIONS = new Set([
  "create_domain",
  "update_domain",
  "create_project",
  "update_project",
  "create_backlog",
  "update_backlog",
  "link_domain_project",
  "unlink_domain_project",
  "link_backlog_task",
  "unlink_backlog_task",
  "create_task",
  "update_task",
]);
export function managementAdapter(ledger, workbench) {
  return {
    snapshot: () => workbench.snapshot(),
    manage: (commandId, operation, data) =>
      operation === "create_task"
        ? ledger.createTask(commandId, data)
        : operation === "update_task"
          ? ledger.updateTask(commandId, data)
          : workbench.manage(commandId, operation, data),
  };
}
export async function readManagementCommand(req) {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers["content-type"] || "",
    )
  )
    throw Object.assign(new Error("Use application/json"), { status: 415 });
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 262144)
      throw Object.assign(new Error("Command exceeds 256 KiB"), {
        status: 413,
      });
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON command"), { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["commandId", "operation", "data"].includes(key),
    ) ||
    typeof body.commandId !== "string" ||
    !body.commandId.trim() ||
    body.commandId.length > 256 ||
    !MANAGEMENT_OPERATIONS.has(body.operation) ||
    !body.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data)
  )
    throw Object.assign(new Error("Invalid management command"), {
      status: 400,
    });
  // Task management cannot set policy, owner, run state or trust claims. The ledger validates content and revisions.
  const taskFields =
    body.operation === "create_task"
      ? [
          "title",
          "description",
          "goal",
          "acceptanceCriteria",
          "priorityOverride",
          "targetAt",
          "tags",
        ]
      : body.operation === "update_task"
        ? [
            "taskId",
            "expectedRevision",
            "title",
            "description",
            "goal",
            "acceptanceCriteria",
            "priorityOverride",
            "targetAt",
            "tags",
            "state",
          ]
        : null;
  if (
    taskFields &&
    Object.keys(body.data).some((key) => !taskFields.includes(key))
  )
    throw Object.assign(
      new Error("Task execution authority cannot be changed by this form"),
      { status: 400 },
    );
  return body;
}
