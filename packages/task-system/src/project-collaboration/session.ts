import { validateCollaborationInput } from "./authority.js";
import type { ProjectCollaborationInput } from "./types.js";
import type { SessionCommand } from "../session-commands.js";
import type { Json } from "../contracts.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ProtocolError } from "../remote/protocol.js";
import { TaskError, type TaskLedger } from "../ledger.js";

export type CollaborationAction = "session" | "activate" | "status" | "nodes" | "dispatch" | "update" | "submit";
export interface CollaborationInput {
  action: CollaborationAction;
  command?: SessionCommand;
  sessionId: string;
  cwd: string;
  composition?: Extract<import("../contracts.js").DispatchOrigin,{kind:"session"}>["composition"];
  projectId?: string;
  title?: string;
  goal?: string;
  summary?: string;
  description?: string;
  route?: unknown;
  nodeId?: string;
  executionModel?: unknown;
  taskId?:string;retry?:boolean;expectedActionVersion?:string;configuration?:Json;read?:import("../task-reads.js").TaskReadOptions | import("../node-reads.js").NodeReadOptions;
}
export type CollaborationPort = (nodeId: string, commandId: string, input: CollaborationInput) => unknown | Promise<unknown>;
export interface SessionBinding {
  sessionId: string;
  nodeId: string;
  cwd: string;
  state: "pending" | "active" | "paused";
  projectId?: string;
  activationId: string;
}
interface Operation {
  commandId: string;
  sessionId: string;
  input: CollaborationInput;
  state: "pending" | "acknowledged" | "rejected";
  result?: unknown;
  errorCode?: string;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(k => (value as any)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function unwrap(result: unknown): any {
  if (result && typeof result === "object" && "value" in result) return result.value;
  return result;
}
/** Only session bindings and replayable client requests live here. Projects remain central-owned. */
export class SessionCollaboration {
  private readonly db;
  constructor(
    ledger: Pick<TaskLedger, "managementDatabase">,
    readonly nodeId: string,
    private readonly call: CollaborationPort,
    private readonly owned: (agent: Agent) => boolean = () => false,
  ) {
    this.db = ledger.managementDatabase();
    this.db.exec(`CREATE TABLE IF NOT EXISTS project_session_bindings(session_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_session_operations(command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  private identity(agent?: Agent) {
    if (!agent || this.owned(agent)) throw new TaskError("FORBIDDEN", "协作模式仅供本地用户会话使用，执行端受管任务不能登记另一个项目。");
    const cwd = agent.session.header.cwd;
    if (!cwd || !isAbsolute(cwd)) throw new TaskError("INVALID", "当前会话没有绝对工作目录，无法激活项目协作。");
    return { sessionId: String(agent.id), cwd: resolve(cwd) };
  }
  binding(agent?: Agent): SessionBinding | undefined {
    if (!agent || this.owned(agent)) throw new TaskError("FORBIDDEN", "当前执行会话不允许项目协作。");
    const row = this.db.prepare("SELECT data FROM project_session_bindings WHERE session_id=?").get(String(agent.id));
    if (!row) return;
    const identity = this.identity(agent);
    const binding = JSON.parse(String(row.data)) as SessionBinding;
    if (binding.cwd !== identity.cwd || binding.nodeId !== this.nodeId) throw new TaskError("FORBIDDEN", "会话的节点或工作目录与已登记绑定不一致，拒绝恢复协作模式。");
    return binding;
  }
  private save(binding: SessionBinding) {
    this.db.prepare("INSERT INTO project_session_bindings VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data").run(binding.sessionId, JSON.stringify(binding));
  }
  private operation(commandId: string): Operation | undefined {
    const row = this.db.prepare("SELECT data FROM project_session_operations WHERE command_id=?").get(commandId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private saveOperation(op: Operation) {
    this.db.prepare("INSERT INTO project_session_operations VALUES (?,?,?) ON CONFLICT(command_id) DO UPDATE SET data=excluded.data").run(op.commandId, op.sessionId, JSON.stringify(op));
  }
  private async send(commandId: string, input: CollaborationInput) {
    const prior = this.operation(commandId);
    if (prior && canonical(prior.input) !== canonical(input)) throw new TaskError("CONFLICT", "同一 requestId 的请求内容发生变化；重试必须沿用原始内容。");
    if (prior?.state === "acknowledged") return prior.result;
    const op: Operation = prior ?? { commandId, sessionId: input.sessionId, input, state: "pending" };
    this.saveOperation(op);
    try {
      const result = unwrap(await this.call(this.nodeId, commandId, input));
      this.saveOperation({ ...op, state: "acknowledged", result });
      return result;
    } catch (error) {
      // Persist the exact request, never credentials or raw transport error bodies.
      const code = (error as { code?: string }).code;
      if (! ["UNAVAILABLE", "REMOTE_OUTCOME_UNCERTAIN", "COLLABORATION_PENDING"].includes(code ?? "") && (error instanceof TaskError || error instanceof ProtocolError)) {
        this.saveOperation({ ...op, state: "rejected", errorCode: code });
        throw error;
      }
      throw new TaskError("COLLABORATION_PENDING", `请求 ${commandId} 已保存在本机，中央尚未确认。恢复连接后以相同 requestId 和内容重试；不要创建重复任务。`);
    }
  }
  async activate(agent: Agent, title?: string, projectId?: string, goal?: string) {
    const identity = this.identity(agent), prior = this.binding(agent);
    if (prior?.state === "active") {
      if (projectId && projectId !== prior.projectId) throw new TaskError("CONFLICT", "请先 /project leave 再连接另一个项目。");
      return { binding: prior, alreadyActive: true };
    }
    let commandId: string;
    let input: CollaborationInput;
    if (prior && !prior.projectId) {
      const op = this.operation(prior.activationId)!;
      if (projectId !== op.input.projectId || (title && title !== op.input.title)) throw new TaskError("CONFLICT", "存在待确认激活请求，请以原始 /project start 或 attach 参数重试。");
      commandId = prior.activationId;
      input = op.input;
    } else {
      commandId = `collaboration-${randomUUID()}`;
      input = { action: "activate", ...identity, projectId: projectId ?? prior?.projectId, ...(title ? { title } : {}), ...(goal ? {goal} : {}) };
    }
    const binding: SessionBinding = { ...identity, nodeId: this.nodeId, state: "pending", activationId: commandId };
    this.save(binding);
    let result: any;
    try { result = await this.send(commandId, input); }
    catch (error) {
      if ((error as {code?: string}).code !== "COLLABORATION_PENDING") {
        if (prior?.projectId) this.save(prior);
        else this.db.prepare("DELETE FROM project_session_bindings WHERE session_id=?").run(identity.sessionId);
      }
      throw error;
    }
    if (!result || result.confirmed !== true || typeof result.projectId !== "string" || !result.projectId) throw new TaskError("COLLABORATION_PENDING", "中央回执缺少 projectId；协作未激活，请重试原命令。");
    const current = this.binding(agent);
    if (current?.activationId !== commandId || current.state === "paused") return { binding: current, result, paused: true };
    this.save({ ...binding, state: "active", projectId: result.projectId });
    return { binding: this.binding(agent), result };
  }
  async command(agent: Agent | undefined, command: SessionCommand, requestId: string) {
    const identity = this.identity(agent), binding = this.binding(agent);
    if (command.kind !== "projects" && (binding?.state !== "active" || !binding.projectId)) throw new TaskError("FORBIDDEN", "Bind the current session to a central project first");
    if (!requestId?.trim() || requestId.length > 200) throw new TaskError("INVALID", "A stable command ID is required");
    const selected = agent!.session.requestHeader()?.config;
    const provider = selected?.provider ?? agent!.options.provider, model = selected?.model ?? agent!.options.model;
    const effort = selected?.reasoningEffort ?? agent!.options.reasoningEffort;
    const preset = agent!.ctx.get("agentPresets")?.composedPreset(agent!.ctx) ?? agent!.session.header.agentPreset;
    const composition = provider && model ? {provider,model,...(effort?{reasoningEffort:String(effort)}:{}),tools:agent!.ctx.tools.schemas(agent).map(tool=>tool.name),...(preset?{preset}:{})} : undefined;
    const response = await this.send(`session-${hash(`${identity.sessionId}:${command.kind}:${requestId}`)}`, {action:"session", ...identity, command, ...(binding?.projectId?{projectId:binding.projectId}:{}), ...(composition?{composition}:{})});
    if (!response || response.confirmed !== true || !("result" in response)) throw new TaskError("COLLABORATION_PENDING", "Central session command has no confirmed receipt");
    return response.result;
  }
  leave(agent: Agent) {
    const binding = this.binding(agent);
    if (binding) this.save({ ...binding, state: "paused" });
    return { binding: this.binding(agent), message: "当前会话协作模式已暂停；中央项目和待确认记录保留。" };
  }
  localStatus(agent: Agent) {
    const identity = this.identity(agent);
    const operations = this.db.prepare("SELECT data FROM project_session_operations WHERE session_id=?").all(identity.sessionId).map(row => JSON.parse(String(row.data)) as Operation);
    return { binding: this.binding(agent) ?? null,
      pendingOperations: operations.filter(op => op.state === "pending").map(op => ({ commandId: op.commandId, action: op.input.action })),
      rejectedOperations: operations.filter(op => op.state === "rejected").map(op => ({ commandId: op.commandId, action: op.input.action, code: op.errorCode })),
    };
  }
  async invoke(agent: Agent | undefined, action: Exclude<CollaborationAction, "activate">, args: { title?: string; goal?: string; summary?: string; description?: string; route?: unknown; nodeId?: string; executionModel?: unknown; taskId?:string;retry?:boolean;expectedActionVersion?:string;configuration?:Json;read?:import("../task-reads.js").TaskReadOptions | import("../node-reads.js").NodeReadOptions }, callId: string, requestId?: string) {
    const identity = this.identity(agent), binding = this.binding(agent);
    if (!binding || binding.state !== "active" || !binding.projectId) throw new TaskError("FORBIDDEN", "请先在当前会话运行 /project 激活协作模式。");
    const readOnly = action === "status" || action === "nodes";
    if (!readOnly && (!requestId?.trim() || requestId.length > 160)) throw new TaskError("INVALID", "写入操作必须提供稳定的 requestId（1–160 字符），重试使用同一个 ID。");
    const commandId = `collaboration-${hash(`${identity.sessionId}:${action}:${readOnly ? callId : requestId}`)}`;
    const selected=agent!.session.requestHeader()?.config;
    const provider=selected?.provider ?? agent!.options.provider,model=selected?.model ?? agent!.options.model;
    const effort=selected?.reasoningEffort ?? agent!.options.reasoningEffort;
    const preset=agent!.ctx.get("agentPresets")?.composedPreset(agent!.ctx) ?? agent!.session.header.agentPreset;
    const composition=provider && model ? {provider,model,...(effort?{reasoningEffort:String(effort)}:{}),tools:agent!.ctx.tools.schemas(agent).map(tool=>tool.name),...(preset?{preset}:{})} : undefined;
    return this.send(commandId, { ...args, action, ...identity, projectId: binding.projectId, ...(action==="dispatch" && composition ? {composition} : {}) });
  }
  prompt(agent?: Agent): string {
    if (!agent || this.owned(agent)) return "";
    const binding = this.binding(agent);
    if (binding?.state !== "active") return "";
    return `当前会话已激活中央项目协作：${JSON.stringify({ projectId: binding.projectId, cwd: binding.cwd, nodeId: binding.nodeId })}\n\n${readFileSync(new URL("./SKILL.md", import.meta.url), "utf8")}`;
  }
}

/** A configured coordinator remains authoritative while paused or offline. */
export function collaborationAuthority(
  role: string,
  local: { projectCollaborate?: (nodeId: string, commandId: string, input: ProjectCollaborationInput) => unknown },
  remote?: { settingsSnapshot(): { coordinatorConfigured: boolean; paused: boolean }; coordinatorLedger?: { projectCollaborate?: (nodeId: string, commandId: string, input: ProjectCollaborationInput) => unknown } },
): CollaborationPort {
  const settings = remote?.settingsSnapshot();
  const needsRemote = role === "remote" || role === "executor" || settings?.coordinatorConfigured === true || Boolean(remote?.coordinatorLedger);
  const port = needsRemote ? remote?.coordinatorLedger : local;
  if ((needsRemote && settings?.paused) || !port?.projectCollaborate)
    throw new TaskError("UNAVAILABLE", "配置的中央协作接口当前不可用；本机不会代建第二个中央项目。");
  return (nodeId, commandId, input) => { validateCollaborationInput(input); return port.projectCollaborate!(nodeId, commandId, input); };
}
