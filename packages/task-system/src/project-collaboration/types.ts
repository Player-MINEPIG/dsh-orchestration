import type { ExecutionRoute } from "../contracts.js";
export interface ProjectCollaborationInput {
  action: "activate" | "status" | "nodes" | "dispatch" | "update" | "submit";
  sessionId: string;
  cwd: string;
  projectId?: string;
  title?: string;
  goal?: string;
  summary?: string;
  route?: ExecutionRoute;
  description?: string;
}
export interface CollaborationSummary {
  projectId: string;
  backlogId: string;
  ownerNodeId: string;
  sessionId: string;
  cwd: string;
  title: string;
  goal: string;
  summary: string;
  state: "active" | "pending_review";
  updatedAt: string;
}
