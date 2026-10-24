import type { ExecutionRoute } from "../contracts.js";
import type { ExecutionModelChoice } from "../execution-models.js";
export interface ProjectSessionInput {
  action: "session" | "activate" | "status" | "nodes" | "dispatch" | "update" | "submit";
  command?: import("../session-commands.js").SessionCommand;
  sessionId: string;
  cwd: string;
  composition?: Extract<import("../contracts.js").DispatchOrigin,{kind:"session"}>["composition"];
  projectId?: string;
  title?: string;
  goal?: string;
  summary?: string;
  route?: ExecutionRoute;
  nodeId?: string;
  executionModel?: ExecutionModelChoice;
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

export type ProjectCollaborationInput = ProjectSessionInput | {
  action: "control";
  control: import("../central-control.js").CentralTaskControl;
  sessionId?: never;
  cwd?: never;
  composition?: never;
} | {
  action: "project-session";
  request: import("../project-session-service.js").ProjectSessionAction;
};
