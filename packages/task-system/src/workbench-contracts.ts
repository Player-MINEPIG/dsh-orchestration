import { randomUUID } from "node:crypto";

/** Management objects use relational storage; criteria are bounded value structures. */
export type Priority = "low" | "normal" | "high" | "urgent";
export type ConditionStatus = "pending" | "met" | "unmet" | "unknown";
export interface VersionRef {
  type:
    | "task"
    | "artifact"
    | "milestone"
    | "report"
    | "project"
    | "backlog"
    | "skill";
  id: string;
  revision?: number;
}
export interface Criterion {
  criterionId: string;
  description: string;
  kind:
    | "task_completion"
    | "task_acceptance"
    | "artifact_acceptance"
    | "milestone_completion"
    | "manual_check";
  targetRef?: VersionRef;
  requiredEvidence: string;
}
export interface CriterionView extends Criterion {
  observedStatus: ConditionStatus;
  evidenceRefs: VersionRef[];
  checkedAt?: string;
  source?: { role: string; nodeId: string; kind: "management-check" };
}
export class CriterionValidationError extends Error {
  readonly code = "INVALID";
  constructor(message: string) {
    super(message);
    this.name = "CriterionValidationError";
  }
}
const invalid = (message: string): never => {
  throw new CriterionValidationError(message);
};
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\w][\w:./@-]*$/.test(value) &&
  value.length <= 200;
export function validateVersionRef(value: unknown): VersionRef {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid("Invalid target reference");
  const ref = value as Record<string, unknown>;
  if (
    Object.keys(ref).some((key) => !["type", "id", "revision"].includes(key)) ||
    ![
      "task",
      "artifact",
      "milestone",
      "report",
      "project",
      "backlog",
      "skill",
    ].includes(String(ref.type)) ||
    !validId(ref.id)
  )
    return invalid("Invalid target reference");
  if (
    ref.revision !== undefined &&
    (!Number.isSafeInteger(ref.revision) || Number(ref.revision) < 1)
  )
    return invalid("Invalid target revision");
  if (
    (ref.type === "artifact" || ref.type === "report") &&
    ref.revision !== undefined
  )
    return invalid("Immutable version references use their ID, not revision");
  return {
    type: ref.type as VersionRef["type"],
    id: ref.id,
    ...(ref.revision === undefined ? {} : { revision: ref.revision as number }),
  };
}
export function validateCriteria(
  value: unknown,
  validateTarget?: (ref: VersionRef) => void,
): Criterion[] {
  if (!Array.isArray(value) || value.length > 128)
    return invalid("Criteria must be an array of at most 128 items");
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return invalid("Invalid criterion");
    const row = raw as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) =>
          ![
            "criterionId",
            "description",
            "kind",
            "targetRef",
            "requiredEvidence",
          ].includes(key),
      )
    )
      return invalid(
        "Criterion checks are read-only; unexpected criterion field",
      );
    const criterionId = row.criterionId ?? randomUUID();
    if (!validId(criterionId) || ids.has(criterionId))
      return invalid("Invalid or duplicate criterionId");
    ids.add(criterionId);
    if (
      typeof row.description !== "string" ||
      !row.description.trim() ||
      row.description.length > 4000
    )
      return invalid("Invalid criterion description");
    const kind = row.kind ?? "manual_check";
    if (
      ![
        "task_completion",
        "task_acceptance",
        "artifact_acceptance",
        "milestone_completion",
        "manual_check",
      ].includes(String(kind))
    )
      return invalid("Invalid criterion kind");
    const requiredEvidence = row.requiredEvidence ?? "";
    if (typeof requiredEvidence !== "string" || requiredEvidence.length > 4000)
      return invalid("Invalid required evidence");
    const targetRef =
      row.targetRef === undefined
        ? undefined
        : validateVersionRef(row.targetRef);
    const requiredType = (
      {
        task_completion: "task",
        task_acceptance: "task",
        artifact_acceptance: "artifact",
        milestone_completion: "milestone",
      } as Record<string, string>
    )[kind as string];
    if (requiredType && (!targetRef || targetRef.type !== requiredType))
      return invalid("Criterion requires a matching target reference");
    if (
      (requiredType === "task" || requiredType === "milestone") &&
      targetRef?.revision === undefined
    )
      return invalid("Criterion must fix the target intent/content revision");
    if (targetRef) validateTarget?.(targetRef);
    return {
      criterionId,
      description: row.description,
      kind: kind as Criterion["kind"],
      requiredEvidence,
      ...(targetRef ? { targetRef } : {}),
    };
  });
}
export interface Domain {
  domainId: string;
  revision: number;
  title: string;
  summary: string;
  state: "active" | "archived";
  position: number;
}
export interface Project {
  projectId: string;
  revision: number;
  title: string;
  goal: string;
  description: string;
  state: "draft" | "active" | "paused" | "archived";
  nextStep: string;
  acceptanceCriteria: CriterionView[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  targetAt?: string;
}
export interface Backlog {
  backlogId: string;
  revision: number;
  projectId: string;
  title: string;
  goal: string;
  state: "open" | "paused" | "completed" | "cancelled" | "archived";
  priority: Priority;
  acceptanceCriteria: CriterionView[];
  conditionStatus: ConditionStatus;
  targetAt?: string;
}
export interface Skill {
  skillId: string;
  revision: number;
  title: string;
  summary: string;
  abilityStatement: string;
  practiceNotes: string;
  methodNotes: string;
  limitations: string;
  state: "draft" | "active" | "archived";
  createdAt: string;
  updatedAt: string;
}
export interface Milestone {
  milestoneId: string;
  revision: number;
  projectId: string;
  title: string;
  goal: string;
  state: "planned" | "active" | "awaiting_review" | "cancelled" | "archived";
  conditions: CriterionView[];
  completionMode: "all" | "any";
  conditionStatus: ConditionStatus;
  targetAt?: string;
}
export interface DomainProject {
  domainId: string;
  projectId: string;
}
export interface BacklogTask {
  backlogId: string;
  taskId: string;
}
export interface ProjectWorkspace {
  projectId: string;
  workspaceId: string;
  nodeId: string;
  isDefault: boolean;
  revision: number;
}
/** Declarations only: registration does not fetch, copy, hash, publish or verify bytes. */
export type ContentRef =
  | { kind: "native"; provider: string; fileId: string; version: string }
  | { kind: "git"; repository: string; commit: string; path: string }
  | { kind: "object"; provider: string; objectId: string; version: string }
  | { kind: "live"; url: string };
export interface RegisteredArtifact {
  artifactId: string;
  name: string;
  materialId?: string;
  mediaType?: string;
  taskId?: string;
  reportId?: string;
  contentRef: ContentRef;
  availability: "unknown";
  versionStatus: "pinned" | "live";
  bytes?: number;
  sha256?: string;
  createdAt: string;
}
export interface ArtifactRelation {
  relationId: string;
  artifactId: string;
  kind: "project" | "task" | "report" | "skill" | "predecessor";
  targetId: string;
  action?:
    | "produced"
    | "modified"
    | "derived"
    | "referenced"
    | "explained"
    | "validated"
    | "reflected";
  context: string;
  runId?: string;
  attemptId?: string;
  recordedAt: string;
}
export interface CriterionCheck {
  checkId: string;
  ownerType: "project" | "backlog" | "milestone";
  ownerId: string;
  ownerRevision: number;
  criterionId: string;
  observedStatus: Exclude<ConditionStatus, "pending">;
  evidenceRefs: VersionRef[];
  note: string;
  checkedAt: string;
  source: { role: string; nodeId: string; kind: "management-check" };
}
export interface WorkbenchSnapshot {
  schemaVersion: "1";
  generatedAt: string;
  domains: Domain[];
  projects: Project[];
  backlogs: Backlog[];
  skills: Skill[];
  milestones: Milestone[];
  domainProjects: DomainProject[];
  backlogTasks: BacklogTask[];
  projectWorkspaces: ProjectWorkspace[];
  milestoneBacklogs: { milestoneId: string; backlogId: string }[];
  milestoneTasks: { milestoneId: string; taskId: string }[];
  skillProjects: { skillId: string; projectId: string; context: string }[];
  skillReports: { skillId: string; reportId: string; context: string }[];
  artifacts: RegisteredArtifact[];
  artifactRelations: ArtifactRelation[];
  criterionChecks: CriterionCheck[];
}
export type WorkbenchOperation =
  | "create_domain"
  | "update_domain"
  | "create_project"
  | "update_project"
  | "create_backlog"
  | "update_backlog"
  | "create_skill"
  | "update_skill"
  | "create_milestone"
  | "update_milestone"
  | "link_domain_project"
  | "unlink_domain_project"
  | "link_backlog_task"
  | "unlink_backlog_task"
  | "link_project_workspace"
  | "unlink_project_workspace"
  | "link_milestone_backlog"
  | "unlink_milestone_backlog"
  | "link_milestone_task"
  | "unlink_milestone_task"
  | "link_skill_project"
  | "unlink_skill_project"
  | "link_skill_report"
  | "unlink_skill_report"
  | "register_artifact"
  | "link_artifact"
  | "check_criterion";
