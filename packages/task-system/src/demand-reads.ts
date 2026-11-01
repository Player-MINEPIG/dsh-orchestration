import type { SessionTaskPage } from "./session-demand-reads.js";
import type { ExecutorAlert, ExecutionDisposition } from "./executor-alerts.js";
import type { ProjectRuntime } from "./project-runtime.js";
import type { Json, Report } from "./contracts.js";

type Legacy = ReturnType<ProjectRuntime["snapshot"]>;
type LegacyTask = Legacy["tasks"][number];
type LegacyRun = Legacy["runs"][number];
type LegacyProject = Legacy["projects"][number];
export type ReadView = "planner" | "executor";
export type ReadScope = { readonly kind: "planner" } | { readonly kind: "node"; readonly nodeId: string };
export type ProjectSelector = { kind: "all" } | { kind: "unassigned" } | { kind: "project"; projectId: string };
export type TaskStatus = "error" | "review" | "running" | "draft" | "queued" | "cancelling" | "accepted" | "done" | "handled" | "cancelled" | "archived" | "observed" | "unknown";
export type Responsibility = "needs_user" | "coordinator" | "unreviewed" | "resolved" | "none";
export interface PageInput { page?: number; pageSize?: number }
export interface PageResult<T> {
  items: T[]; page: number; pageSize: number; total: number; pages: number;
  revision: string; sampledAt: string;
}
export interface ViewContext {
  role: ReadView; scope: "all" | "central" | "node" | "local"; nodeId: string;
  displayName?: string; observedAt: string;
}
export interface TaskQuery {
  view?: ReadView; project?: ProjectSelector; presentation?: "coordinator" | "execution" | "all";
  status?: "all" | TaskStatus; responsibility?: "all" | Responsibility;
  unreadCompletedOnly?: boolean; search?: string; order?: "updated-desc";
}
export type TaskCard = Pick<LegacyTask,
  "id" | "showInCoordinator" | "kind" | "parentTaskId" | "parentRunId" | "delegationDisplay" |
  "observationOnly" | "project" | "title" | "status" | "checkin" | "actionVersion" |
  "dispatchIssue" | "canRepair" | "runId" | "revision" | "workflowBinding" | "canRunDirect" |
  "unreadResultCount" | "maxResultRetries" | "resultRetry" | "executionStartedAt" | "executionEndedAt" |
  "canRequestStatus" | "progressRequest" | "confirmationRevision" | "canHandle" | "canConfirm" |
  "canComplete" | "canRequestMaterials" | "manualCompletion" | "materialsStatus" | "materialsLabel" |
  "reportSource" | "reportUpdatedAt" | "canCancel" | "canRetry" | "retryDisabledReason" |
  "conversationKind" | "canRestore" | "canReconcile" | "confirmationPending" | "stateLabel" |
  "runStatus" | "resultStatus" | "runState" | "node" | "model" | "effort" | "reportId" |
  "time" | "returnedAt" | "run" | "nativeState" | "dispatchState" | "reviewStatus"
> & { projectTitle: string; reportPreview: string; childAttentionCount: number; deviceLabel: string };
export interface TaskCounts {
  baseTotal: number; byStatus: Record<TaskStatus, number>; byResponsibility: Record<Responsibility, number>;
  unreadCompleted: number; matchedTotal: number; matchedByStatus: Record<TaskStatus, number>;
}
export interface TaskBoardInput extends TaskQuery { columns: { status: TaskStatus; page: number }[]; pageSize?: number }
export interface TaskBoard {
  columns: Partial<Record<TaskStatus, PageResult<TaskCard>>>; counts: TaskCounts;
  revision: string; sampledAt: string; viewContext: ViewContext; nodes: Legacy["nodes"];
}
export type TaskPage = PageResult<TaskCard> & { counts: TaskCounts; viewContext: ViewContext };
export type RunHeader = Pick<LegacyRun,
  "id" | "taskId" | "state" | "node" | "model" | "createdAt" | "parentRunId" | "parentTaskId" |
  "reviewStatus" | "executionStartedAt" | "executionEndedAt" | "outcome" | "observationOnly" |
  "executionDriver" | "reasoningEffort" | "occurrenceId" | "sessionIds"
> & { insertionOrdinal: number; reportCount: number; unreadResultCount: number; projectTitle: string; taskTitle: string; delegationDisplay: TaskCard["delegationDisplay"] };
export interface ReportHeader {
  id: string; taskId: string; runId?: string; kind: Report["kind"]; title: string;
  contentVersion: string; readAt: string | null; unread: boolean; hasHtmlPresentation: boolean;
  createdAt: string; recordedAt?: string;
}
export type ReportDetail = ReportHeader & { body: string; workflowOutputs: NonNullable<Report["workflowOutputs"]> };
export interface AttentionGroup {parentRunId:string;taskId:string|null;count:number;createdAt:string|null}
export type AttentionGroups = PageResult<AttentionGroup> & {totalAttention:number;unbound:number};
export type AttentionRow = LegacyTask["childAttention"][number];
export interface TaskDetail {
  task: TaskCard & Pick<LegacyTask, "description" | "artifact" | "recommendation" | "candidateChecks">;
  runs: PageResult<RunHeader>; reports: PageResult<ReportHeader>; childAttention: PageResult<AttentionRow>;
}
export interface RunDetail { run: LegacyRun; attempts: Legacy["attempts"]; reports: PageResult<ReportHeader>; children: PageResult<RunHeader> }
export interface GraphPage extends PageResult<TaskCard> {
  edges: { from: string; to: string; kind: "task" | "run" | "workflow" }[];
  boundary: { id: string; parentId: string | null; remaining: number }[];
}
export type ProjectCard = Pick<LegacyProject, "id" | "title" | "stage" | "workspaceNodeId" | "workspace" | "session" | "sessionId" | "phase" | "canChat" | "canConfigure"> & {
  taskCounts: TaskCounts; descriptionPreview: string;
  collaborationPreview?: { summary: string; updatedAt: string; state: string };
  activity: { status: TaskStatus; label: string; focus: Pick<TaskCard,"id"|"title"|"status"|"stateLabel"> | null };
};
export interface ProjectDetail {
  project: Omit<LegacyProject, "messages">; taskCounts: TaskCounts;
  collaborations: PageResult<Legacy["projectCollaborations"][number]>;
  registrations: PageResult<Legacy["projectRegistrations"][number]>;
}
export type ScheduleCard = Omit<Legacy["schedules"][number], "occurrences">;
export type ScheduleOccurrence = Legacy["schedules"][number]["occurrences"][number] & { run: RunHeader | null };
export type WorkflowHeader = Omit<Legacy["workflowDefinitions"][number], "steps" | "stages" | "calls"> & { nodeIds: string[]; stepCount: number };
export type WorkflowRunHeader = Omit<Legacy["workflowRuns"][number], "definition" | "dispatches" | "steps">;
export type ResourceKind = "artifacts" | "milestones" | "registrations" | "collaborations";
export type ResourceItem = Legacy["artifacts"][number] | Legacy["milestones"][number] | Legacy["projectRegistrations"][number] | Legacy["projectCollaborations"][number];
export interface ExecutorClaim {commandId:string;runId:string;state:string;endpoint:string;audience:string;code?:string;message?:string;resolved:boolean;authorityDisposition:ExecutionDisposition|null;dispositionObservedAt:string|null;alert:ExecutorAlert;recoveryNote?:string}
export interface Bootstrap {
  executorClaims?: PageResult<ExecutorClaim>;
  settings: Legacy["settings"] & { enabled: boolean }; viewCapabilities: { planner: boolean; executor: boolean };
  viewContext: ViewContext; nodes: Legacy["nodes"]; scheduleRuntime: Legacy["scheduleRuntime"];
  temporaryTaskCount: number; scheduleCount: number;
}
type Viewed = { view?: ReadView };
type TaskId = Viewed & { taskId: string };
type ProjectPageInput = Viewed & PageInput & { search?: string };
type ExecutionInput = Viewed & PageInput & { project?: ProjectSelector; sessionId?: string; taskId?: string; parentRunId?: string; status?: string };
export interface DemandReadInputs {
  readBootstrap: Viewed;
  executorClaimsPage: Viewed & PageInput;
  taskBoard: TaskBoardInput;
  taskPage: TaskQuery & PageInput;
  taskDetail: TaskId;
  taskHistoryPage: TaskId & PageInput;
  taskRunDetail: TaskId & { runId: string };
  taskReportDetail: TaskId & { runId?: string; reportId: string };
  taskAttentionGroupPage: TaskId & PageInput;
  taskAttentionPage: TaskId & PageInput & { parentRunId?: string };
  taskGraphPage: Viewed & PageInput & { projectId?: string; taskId?: string; runId?: string; parentTaskId?: string };
  taskSessionAccess: TaskId & { nodeId: string; sessionId: string };
  projectListPage: ProjectPageInput;
  projectDetail: Viewed & { projectId: string };
  projectCreateOptions: Viewed;
  projectResourcesPage: Viewed & PageInput & { projectId?: string; kind: ResourceKind };
  scheduleListPage: Viewed & PageInput & { project?: ProjectSelector };
  scheduleDetail: Viewed & { scheduleId: string };
  scheduleHistoryPage: Viewed & PageInput & { scheduleId: string };
  executionPage: ExecutionInput;
  reportListPage: Viewed & PageInput & { project?: ProjectSelector; taskId?: string; runId?: string; kind?: Report["kind"]; presentation?: TaskQuery["presentation"] };
  workflowListPage: Viewed & PageInput & { projectId?: string };
  workflowDetail: Viewed & { workflowId: string };
  workflowRunPage: Viewed & PageInput & { workflowId: string; taskId?:string;runId?:string;legacyOnly?:boolean };
  workflowRunDetail: Viewed & { workflowRunId: string };
  workflowStepDetail: Viewed & { workflowRunId: string; stepId: string };
  sessionTaskPage: Viewed & PageInput & { sessionId: string; status?: TaskStatus | "all"; search?: string };
}
export interface DemandReadOutputs {
  readBootstrap: Bootstrap;
  executorClaimsPage: PageResult<ExecutorClaim>;
  taskBoard: TaskBoard;
  taskPage: TaskPage;
  taskDetail: TaskDetail;
  taskHistoryPage: PageResult<RunHeader>;
  taskRunDetail: RunDetail;
  taskReportDetail: ReportDetail;
  taskAttentionGroupPage: AttentionGroups;
  taskAttentionPage: PageResult<AttentionRow>;
  taskGraphPage: GraphPage;
  taskSessionAccess: { allowed: true };
  projectListPage: PageResult<ProjectCard>;
  projectDetail: ProjectDetail;
  projectCreateOptions: { settings: Legacy["settings"]; workspaceOptions: Legacy["workspaceOptions"] };
  projectResourcesPage: PageResult<ResourceItem>;
  scheduleListPage: PageResult<ScheduleCard>;
  scheduleDetail: { schedule: ScheduleCard; task: TaskCard | null };
  scheduleHistoryPage: PageResult<ScheduleOccurrence>;
  executionPage: PageResult<RunHeader>;
  reportListPage: PageResult<ReportHeader>;
  workflowListPage: PageResult<WorkflowHeader>;
  workflowDetail: { definition: Json; nodes: Json[]; workspaces: Json[]; programs: Json[]; models: Json[]; taskBindings: Json[] };
  workflowRunPage: PageResult<WorkflowRunHeader>;
  workflowRunDetail: { run: Json; definition: Json };
  workflowStepDetail: Json;
  sessionTaskPage: SessionTaskPage;
}
export const demandReadMethods = [
  "readBootstrap", "executorClaimsPage", "taskBoard", "taskPage", "taskDetail", "taskHistoryPage", "taskRunDetail", "taskReportDetail",
  "taskAttentionGroupPage", "taskAttentionPage", "taskGraphPage", "taskSessionAccess", "projectListPage", "projectDetail", "projectCreateOptions",
  "projectResourcesPage", "scheduleListPage", "scheduleDetail", "scheduleHistoryPage", "executionPage", "reportListPage",
  "workflowListPage", "workflowDetail", "workflowRunPage", "workflowRunDetail", "workflowStepDetail", "sessionTaskPage",
] as const satisfies readonly (keyof DemandReadInputs & keyof DemandReadOutputs)[];
export type DemandReadMethod = (typeof demandReadMethods)[number];
