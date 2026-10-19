import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { foldRequestHeader, SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { DispatchOrigin, Json } from "./contracts.js";
import type { SessionMessage } from "./remote/ports.js";

/** The durable inbox is the receipt. Reconcile it before retrying an outbox event. */
export function containsTaskReturn(events: readonly unknown[], eventId: string): boolean {
  const matches = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if ("source" in value) {
      const source = value.source;
      if (source && typeof source === "object" && "kind" in source && source.kind === "dsh-task-result" && "eventId" in source && source.eventId === eventId) return true;
    }
    if ("type" in value && "data" in value) {
      if (value.type === "user/message") return matches(value.data);
      if (value.type === "agent/inbox/spliced" && value.data && typeof value.data === "object" && "inserted" in value.data && Array.isArray(value.data.inserted)) return value.data.inserted.some(matches);
    }
    return false;
  };
  return events.some(matches);
}

export interface OriginContinuationAdapter {
  id:string;
  capture(agent:Agent):Json | undefined;
  resume(ctx:Context,agent:Agent,data:Json):Promise<void> | void;
}
export class TaskReturnDelivery {
  private readonly adapters=new Map<string,OriginContinuationAdapter>();
  register(adapter:OriginContinuationAdapter) {
    if(this.adapters.has(adapter.id))throw new Error("Origin continuation adapter already registered");
    this.adapters.set(adapter.id,adapter);
    return ()=>{if(this.adapters.get(adapter.id)===adapter)this.adapters.delete(adapter.id);};
  }
  capture(agent:Agent):{id:string;data:Json} | undefined {
    let binding:{id:string;data:Json} | undefined;
    for(const adapter of this.adapters.values()) {
      const data=adapter.capture(agent);
      if(data===undefined)continue;
      if(binding)throw new Error("Ambiguous original session continuation adapters");
      binding={id:adapter.id,data:structuredClone(data)};
    }
    return binding;
  }
  private readonly sessions = new Map<string, Promise<string>>();
  private readonly handles = new Set<AgentHandle>();
  constructor(private readonly ctx: Context) {}
  async deliver(message: SessionMessage): Promise<string> {
    const origin = message.completion?.origin;
    if (!origin || origin.kind !== "session" || origin.sessionId !== message.sessionId || origin.nodeId !== message.nodeId) throw new Error("Invalid task return binding");
    const previous = this.sessions.get(message.sessionId) ?? Promise.resolve("");
    const delivery = previous.catch(() => "").then(() => this.send(message, origin));
    this.sessions.set(message.sessionId, delivery);
    try { return await delivery; }
    finally { if (this.sessions.get(message.sessionId) === delivery) this.sessions.delete(message.sessionId); }
  }
  private async read(sessionId: string) {
    const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), "read");
    try { return (await handle.read()).events; } finally { await handle.close(); }
  }
  private async send(message: SessionMessage, origin: Extract<DispatchOrigin, {kind:"session"}>): Promise<string> {
    const eventId = message.completion!.eventId;
    const events=await this.read(origin.sessionId);
    if (containsTaskReturn(events, eventId)) return "Task result durably queued for the original session's next turn";
    let agent = this.ctx.agents.get(SessionId(origin.sessionId));
    let handle: AgentHandle | undefined;
    if (!agent) {
      const header=foldRequestHeader(events);
      const composition = origin.composition ?? (header?.config.provider && header.config.model ? {provider:header.config.provider,model:header.config.model,...(header.config.reasoningEffort?{reasoningEffort:String(header.config.reasoningEffort)}:{}),tools:header.tools?.map(tool=>tool.name)} : undefined);
      if (!composition?.provider || !composition.model) throw new Error("Original session model binding unavailable; task result retained for retry");
      handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(origin.sessionId),
        agentOptions: { provider: composition.provider, model: composition.model, ...(composition.reasoningEffort ? {reasoningEffort: ReasoningEffortId(composition.reasoningEffort)} : {}) },
        setup: async (ctx, resumed) => {
          const projections = this.ctx.get("sessionProjections") as unknown as {stateOf(session: Agent["session"],name:string):unknown} | undefined;
          const recorded = projections?.stateOf(resumed.session, "agentPreset");
          const preset = composition.preset ?? (typeof recorded === "string" ? recorded : resumed.session.header.agentPreset);
          if (preset) {
            const presets=ctx.get("agentPresets");
            if(!presets)throw new Error("Original session preset unavailable");
            await presets.mount(ctx,preset);
          }
          if(origin.continuation) {
            const adapter=this.adapters.get(origin.continuation.id);
            if(!adapter)throw new Error("Original session continuation adapter unavailable");
            await adapter.resume(ctx,resumed,structuredClone(origin.continuation.data));
          }
          const tools=composition.tools ?? header?.tools?.map(tool=>tool.name);
          if(!tools)throw new Error("Original session tool composition unavailable");
          const available=new Set(ctx.tools.schemas(resumed).map(tool=>tool.name));
          if(tools.some(tool=>!available.has(tool)))throw new Error("Original session tools unavailable; retained for retry");
          ctx.tools.restrict({allow:tools});
          if (origin.parentLease) {
            ctx.tools.guard(exec => ["task_settle", "task_report"].includes(exec.name) ? "The original task lease expired; this result continuation does not grant a lease" : undefined);
            ctx.systemPrompt.section({name:"task-result-continuation",order:110,interpolate:false,text:()=>"这是原会话接收的子任务结果续接。历史执行租约未恢复，不得使用历史租约结算或重做任务。核对中央报告后完成本次汇总；如需新执行，通过统一派发工具获得新授权。"});
          }
        },
      });
      this.handles.add(handle);
      agent = handle.agent;
    }
    try {
    if (origin.cwd && agent.session.header.cwd !== origin.cwd) throw new Error("Original session workspace changed");
    await this.ctx.sessions.flush(agent.session);
    if (containsTaskReturn(await this.read(origin.sessionId), eventId)) return "Task result durably queued for the original session's next turn";
    agent.followup(createUserMessage({source:{kind:"dsh-task-result",eventId,taskId:message.taskId},content:[{type:"text",text:message.text}]}));
    await this.ctx.sessions.flush(agent.session);
    if (handle) {
      const owned = handle;
      void agent.whenIdle().then(() => owned.dispose()).finally(() => this.handles.delete(owned)).catch(error=>this.ctx.logger.warn("task result continuation stopped: %s", error));
    }
    return "Task result durably queued for the original session's next turn";
    } catch(error) {
      if(handle) {this.handles.delete(handle);await handle.dispose();}
      throw error;
    }
  }
  async dispose() {
    await Promise.allSettled([...this.sessions.values()]);
    await Promise.allSettled([...this.handles].map(handle => handle.dispose()));
    this.handles.clear();
  }
}
