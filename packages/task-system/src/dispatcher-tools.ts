import { manualCheckFor } from "./task-checkin-surface.js";
import { z } from "zod";
import { ExecutionStatusRequest, nativeExecutionStatus } from "./execution-reconciliation.js";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { TaskSystemService } from "./dsh-plugin.js";
import { SessionMessageRequest } from "./session-commands.js";
import { TaskError } from "./ledger.js";
const output = {schema:{type:"json" as const},render:(_args:unknown,value:unknown)=>[{type:"text" as const,text:JSON.stringify(value)}]};

/** Identity and cwd come from the host. The central service owns every task mutation. */
export function mountDispatcherTools(ctx: Context, service: TaskSystemService) {
  const collaboration = service.sessionCollaboration;
  ctx.tools.register(defineTool({
    name: "task_execution_status",
    description: "Inspect a bound coordinator task's current Run, attempt, formal reports and exact local native evidence without messaging or resuming its executor. inspect returns actionVersion/evidenceVersion and canReconcile; reconcile may settle a proven startup AUTH/401 or verify an exact durable interrupted invocation has stopped with no submitted business result. The latter preserves the historical business result as unproven, never asserts it was not executed. Use exact returned versions and stable commandId. Insufficient, remote or active evidence remains unknown. Never dispatches or retries work; workers cannot use it.",
    parameters: { action: {type:"string",enum:["inspect","reconcile"],required:true},taskId:{type:"string",required:true},runId:{type:"string",required:true},commandId:{type:"string"},expectedEvidenceVersion:{type:"string"},expectedActionVersion:{type:"string"}},
    output,
    execute: async (args, exec) => {
      if (!exec.agent || service.native?.scopeFor(exec.agent)) throw new TaskError("FORBIDDEN", "Execution verification requires a real coordinator session");
      const agent = exec.agent, request = ExecutionStatusRequest.parse(args), cwd = agent.session.header.cwd;
      const projects = service.projects;
      if (!projects) throw new TaskError("UNAVAILABLE", "Coordinator execution verification is unavailable on this host");
      if (!cwd) throw new TaskError("FORBIDDEN", "Coordinator has no workspace identity");
      const authorize = () => {
        if (request.action === "reconcile" && ctx.get("sandboxPolicy")?.resolve({session:agent.session}).mode === "read-only") throw new TaskError("FORBIDDEN", "The current request is read-only; execution reconciliation writes are not allowed");
        const binding = collaboration.binding(agent);
        const managed = projects.projectForSession(String(agent.id)) || projects.taskForSession(String(agent.id));
        if (!managed && binding?.state !== "active") {
          const scoped = manualCheckFor(agent,request.taskId,request.runId), origin = service.ledger.getTask(request.taskId).dispatchOrigin;
          if (!scoped || !service.ledger.commandMatches(scoped.commandId,"workflow.task_checkin.request",{taskId:request.taskId,manualVerification:true}) ||
              origin?.kind !== "session" || origin.parentLease || origin.nodeId !== service.config.nodeId ||
              origin.sessionId !== String(agent.id) || origin.cwd !== cwd)
            throw new TaskError("FORBIDDEN", "Bind this coordinator or use its explicit task-scoped manual check");
        } else projects.assertExecutionCoordinatorTask(String(agent.id), cwd, request.taskId, binding?.projectId);
      };
      return z.json().parse(await nativeExecutionStatus(ctx, service, agent, request, authorize, exec.signal));
    },
  }));
  ctx.tools.register(defineTool({
    name: "task_session_message",
    description: "Communicate with an existing executor session without dispatching or rerunning a task. targets lists authorized task/session bindings; send queues text with a stable commandId; status reads that messageId's eventual reply. Queued is not delivered or task completion. Requires a current project PM or active /project session; task workers cannot use it.",
    parameters: { action: { type: "string", enum: ["targets", "send", "status"], required: true }, taskId: { type: "string", required: true },
      nodeId: { type: "string" }, sessionId: { type: "string" }, commandId: { type: "string" }, text: { type: "string" }, messageId: { type: "string" } },
    output,
    execute: async (args, exec) => {
      if (!exec.agent || service.native?.scopeFor(exec.agent)) throw new TaskError("FORBIDDEN", "Executor messages require an actual coordinator session");
      const request = SessionMessageRequest.parse(args);
      const projectId = service.projects?.projectForSession(String(exec.agent.id));
      if (projectId) {
        const cwd = exec.agent.session.header.cwd;
        if (!cwd) throw new TaskError("FORBIDDEN", "Coordinator has no workspace identity");
        service.sessionPortal.authorizeMessageSession(service.config.nodeId, String(exec.agent.id), cwd, projectId);
        await collaboration.activate(exec.agent, undefined, projectId);
      }
      return collaboration.command(exec.agent, { kind: "sessionMessage", input: request }, request.action === "send" ? request.commandId : String(exec.callId));
    },
  }));
  ctx.tools.register(defineTool({name:"project_list",description:"List authorized central projects. Their metadata does not require a directory on the central host.",parameters:{},output,execute:async(_args,exec)=>collaboration.command(exec.agent,{kind:"projects"},String(exec.callId))}));
  ctx.tools.register(defineTool({name:"project_start",description:"Register a central project for this ordinary session's real local workspace. This does not authorize execution or copy files.",parameters:{title:{type:"string"},goal:{type:"string"}},output,execute:async(args,exec)=>JSON.parse(JSON.stringify(await collaboration.activate(exec.agent!,args.title,undefined,args.goal)))}));
  ctx.tools.register(defineTool({name:"project_bind_session",description:"Bind this ordinary local session to an existing authorized central project. Node, session and cwd are supplied by the host.",parameters:{projectId:{type:"string",required:true}},output,execute:async(args,exec)=>JSON.parse(JSON.stringify(await collaboration.activate(exec.agent!,undefined,args.projectId)))}));
  ctx.tools.register(defineTool({name:"task_bind_dispatcher",description:"Register this project's current session as coordinator of a draft it created. Creates a coordination Run without an execution lease.",parameters:{commandId:{type:"string",required:true},taskId:{type:"string",required:true}},output,execute:async(args,exec)=>collaboration.command(exec.agent,{kind:"bind",taskId:args.taskId},args.commandId)}));
  ctx.tools.register(defineTool({name:"task_retry_return",description:"Retry an existing result's delivery to this original session without repeating execution.",parameters:{commandId:{type:"string",required:true},messageId:{type:"string",required:true}},output,execute:async(args,exec)=>collaboration.command(exec.agent,{kind:"retryReturn",messageId:args.messageId},args.commandId)}));
}
