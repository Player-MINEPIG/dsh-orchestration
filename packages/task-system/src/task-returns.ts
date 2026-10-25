import { sessionContinuation } from "./remote/ports.js";
import { TaskError } from "./ledger.js";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { foldRequestHeader, SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { DispatchOrigin, Json } from "./contracts.js";
import type { SessionMessage, SessionContinuationReceipt, CheckinRef } from "./remote/ports.js";
import { z } from "zod";

const retiredDmcContinuation = z.object({
  version: z.literal(1), sessionId: z.string().min(1), runId: z.string().min(1),
  role: z.enum(["writer", "review", "investigate"]), workspaceId: z.string().min(1),
  sourceId: z.string().min(1), itemId: z.string().min(1), itemVersion: z.string().min(1),
  contextVersion: z.string().min(1), assemblyId: z.string().min(1),
  assemblyHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** The durable inbox is the receipt. Reconcile it before retrying an outbox event. */
export function containsTaskReturn(events: readonly unknown[], eventId: string): boolean {
  const matches = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if ("source" in value) {
      const source = value.source;
      if (source && typeof source === "object" && "kind" in source && (source.kind === "dsh-task-result" || source.kind === "dsh-task-checkin") && "eventId" in source && source.eventId === eventId) return true;
    }
    if ("type" in value && "data" in value) {
      if (value.type === "user/message") return matches(value.data);
      if (value.type === "agent/inbox/spliced" && value.data && typeof value.data === "object" && "inserted" in value.data && Array.isArray(value.data.inserted)) return value.data.inserted.some(matches);
    }
    return false;
  };
  return events.some(matches);
}

export function taskReturnCompleted(events:readonly SessionEvent[],eventId:string):boolean {
  let currentTurn:number | undefined;
  let resultTurn:number | undefined;
  for(const event of events) {
    if(event.type==="turn/start")currentTurn=event.data.turn;
    if(event.type==="user/message" && (event.data.source.kind==="dsh-task-result" || event.data.source.kind==="dsh-task-checkin") && event.data.source.eventId===eventId)resultTurn=currentTurn;
    if(event.type==="turn/end" && resultTurn!==undefined && event.data.turn===resultTurn && event.data.reason.kind==="completed")return true;
  }
  return false;
}

export interface OriginContinuationAdapter {
  id:string;
  capture(agent:Agent):Json | undefined;
  resume(ctx:Context,agent:Agent,data:Json):Promise<void> | void;
}
type ReturnSession = {
  admission: Promise<void>;
  deliveries: number;
  handle?: AgentHandle;
};

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
  private readonly lifetime=new AbortController();
  private readonly sessions = new Map<string, ReturnSession>();
  private readonly deliveries = new Map<string, Promise<SessionContinuationReceipt>>();
  private readonly handles = new Set<AgentHandle>();
  constructor(private ctx: Context, private readonly refreshCheckIn?: (message:SessionMessage)=>Promise<SessionMessage | "obsolete" | undefined>) {}
  bindContext(ctx:Context){this.ctx=ctx;}
  deliver(message: SessionMessage, signal?: AbortSignal): Promise<SessionContinuationReceipt> {
    const origin = sessionContinuation(message)?.origin;
    if (!origin || origin.kind !== "session" || origin.sessionId !== message.sessionId || origin.nodeId !== message.nodeId) return Promise.reject(new Error("Invalid task return binding"));
    if (message.checkIn && origin.parentLease) return Promise.reject(new TaskError("FORBIDDEN", "A check-in cannot revive a protected execution session"));
    const key = JSON.stringify([message.sessionId, sessionContinuation(message)!.eventId]);
    const existing = this.deliveries.get(key);
    if (existing) return existing;
    const state = this.sessions.get(message.sessionId) ?? {admission: Promise.resolve(), deliveries: 0};
    if (message.checkIn && state.deliveries) return Promise.reject(new TaskError("CHECKIN_BUSY", "A session continuation is already being processed"));
    this.sessions.set(message.sessionId, state);
    state.deliveries++;
    const admitted = state.admission.catch(() => {}).then(() => this.admit(message, origin, state, signal));
    state.admission = admitted.then(() => {}, () => {});
    const delivery = admitted.then(async receipt => {
      const reply=await receipt.completion;
      if (!message.checkIn) return reply;
      const events=await this.read(origin.sessionId);
      let checkInTasks: CheckinRef[]=[];
      for(const event of events) if(event.type==="user/message" && event.data.source.kind==="dsh-task-checkin" && event.data.source.eventId===message.checkIn.eventId) checkInTasks=event.data.source.checkInTasks ?? [];
      return {reply,checkInTasks};
    }).finally(() => {
      this.deliveries.delete(key);
      state.deliveries--;
      this.releaseSession(message.sessionId, state);
    });
    this.deliveries.set(key, delivery);
    return delivery;
  }
  private releaseSession(sessionId: string, state: ReturnSession) {
    if (state.deliveries) return;
    const handle = state.handle;
    if (!handle) {
      if (this.sessions.get(sessionId) === state) this.sessions.delete(sessionId);
      return;
    }
    void handle.agent.whenIdle().then(() => {
      const cleanup = state.admission.then(async () => {
        if (state.deliveries || state.handle !== handle) return;
        await handle.dispose();
        state.handle = undefined;
        this.handles.delete(handle);
        if (!state.deliveries && this.sessions.get(sessionId) === state) this.sessions.delete(sessionId);
      });
      state.admission = cleanup.catch(() => {});
      return cleanup;
    }).catch(() => {});
  }
  private async read(sessionId: string) {
    const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), "read");
    try { return (await handle.read()).events; } finally { await handle.close(); }
  }
  private async admit(message: SessionMessage, origin: Extract<DispatchOrigin, {kind:"session"}>, state: ReturnSession, signal?: AbortSignal): Promise<{completion: Promise<string>}> {
    const abort = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    abort.throwIfAborted();
    const eventId = sessionContinuation(message)!.eventId;
    let liveMask: (()=>void) | undefined;
    let liveAllowedTools: Set<string> | undefined;
    const refresh = async () => {
      if (!message.checkIn || !this.refreshCheckIn) return true;
      const current = await this.refreshCheckIn(message);
      if (current === "obsolete") return false;
      if (!current) throw new TaskError("CHECKIN_BUSY", "Task check-in is deferred by current task facts");
      message = current; return true;
    };
    const previousHandle = state.handle;
    try {
      if (!await refresh()) return {completion:Promise.resolve("Check-in no longer relevant")};
      const events=await this.read(origin.sessionId);
      if (taskReturnCompleted(events,eventId)) return {completion: Promise.resolve("Task result processed in the original session")};
      let agent = this.ctx.agents.get(SessionId(origin.sessionId));
      let originalTools: string[] | undefined;
      if (message.checkIn && agent) {
        const otherInput = [...agent.inbox.nextTurn,...agent.inbox.nextStep].some(input=>!("eventId" in input.source) || input.source.eventId!==eventId);
        if (agent.status !== "idle" || otherInput) throw new TaskError("CHECKIN_BUSY", "Responsible session is active; check-in deferred");
        const composition=origin.composition;
        if (composition && (agent.options.provider!==composition.provider || agent.options.model!==composition.model)) throw new TaskError("CHECKIN_COMPOSITION_UNAVAILABLE", "Responsible session model differs from its captured check-in binding");
        originalTools=composition?.tools;
        if (!originalTools) throw new TaskError("CHECKIN_COMPOSITION_UNAVAILABLE", "Original check-in capability mask unavailable");
        liveAllowedTools=new Set(originalTools);
      }
      if (!agent) {
        const header=foldRequestHeader(events);
        const composition = origin.composition ?? (header?.config.provider && header.config.model ? {provider:header.config.provider,model:header.config.model,...(header.config.reasoningEffort?{reasoningEffort:String(header.config.reasoningEffort)}:{}),tools:header.tools?.map(tool=>tool.name)} : undefined);
        if (!composition?.provider || !composition.model) throw new Error("Original session model binding unavailable; task result retained for retry");
        originalTools=composition.tools ?? header?.tools?.map(tool=>tool.name);
        if(!originalTools)throw new Error("Original session tool composition unavailable");
        const allowed=new Set(originalTools);
        const handle = await this.ctx.agents.resume({
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
              if(adapter)await adapter.resume(ctx,resumed,structuredClone(origin.continuation.data));
              else {
                const retired=retiredDmcContinuation.safeParse(origin.continuation.data);
                if(origin.continuation.id!=="dmc-analysis-v1" || !retired.success || retired.data.sessionId!==origin.sessionId)
                  throw new Error("Original session continuation adapter unavailable");
              }
            }
            ctx.tools.guard(exec=>allowed.has(exec.name) ? undefined : "Tool is outside the original session capability mask");
            if (origin.parentLease) {
              ctx.tools.guard(exec => exec.name.startsWith("task_") ? "The original task lease expired; this result continuation does not grant a lease" : undefined);
              ctx.systemPrompt.section({name:"task-result-continuation",order:110,interpolate:false,text:()=>"这是原会话接收的子任务结果续接。历史执行租约未恢复，不得使用历史租约结算或重做任务。核对中央报告后完成本次汇总；如需新执行，通过统一派发工具获得新授权。"});
            }
          },
        });
        this.handles.add(handle);
        state.handle = handle;
        agent = handle.agent;
      }
      if (originalTools) {
        const available = new Set(agent.ctx.tools.schemas(agent).map(tool => tool.name));
        if (originalTools.some(tool => !available.has(tool))) throw new Error("Original session tools unavailable; retained for retry");
      }
      if (origin.cwd && agent.session.header.cwd !== origin.cwd) throw new Error("Original session workspace changed");
      await this.ctx.sessions.flush(agent.session);
      const current = await this.read(origin.sessionId);
      if (taskReturnCompleted(current, eventId)) {liveMask?.();return {completion: Promise.resolve("Task result processed in the original session")};}
      abort.throwIfAborted();
      if (!await refresh()) {liveMask?.();return {completion:Promise.resolve("Check-in no longer relevant")};}
      if (message.checkIn) {
        const otherInput=[...agent.inbox.nextTurn,...agent.inbox.nextStep].some(input=>!("eventId" in input.source) || input.source.eventId!==eventId);
        if (agent.status!=="idle" || otherInput) throw new TaskError("CHECKIN_BUSY", "Responsible session became active before admission");
        const allowed=liveAllowedTools;
        if(allowed)liveMask=agent.ctx.tools.guard(exec=>allowed.has(exec.name) ? undefined : "Tool is outside the original session capability mask");
      }
      const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(input => (input.source.kind === "dsh-task-result" || input.source.kind === "dsh-task-checkin") && input.source.eventId === eventId);
      if (pending) {
        agent.inbox.remove(pending.id);
        agent.steer(pending);
      } else {
        const consumed = current.some(event => event.type === "user/message" && (event.data.source.kind === "dsh-task-result" || event.data.source.kind === "dsh-task-checkin") && event.data.source.eventId === eventId);
        agent.steer(createUserMessage({source:message.checkIn ? {kind:"dsh-task-checkin",eventId,taskId:message.taskId,checkInTasks:message.checkIn.tasks} : {kind:"dsh-task-result",eventId,taskId:message.taskId},content:[{type:"text",text:consumed ? `继续处理已在原会话持久化的任务结果事件 ${eventId}。上轮在完成前中断；核对已完成的工具结果与中央账本，继续未完成的汇总，避免重复提交或重跑任务。` : message.text}]}));
      }
      const completion = this.waitForCompletion(agent, eventId, abort);
      // Keep a rejection observed while the durable receipt is still flushing.
      void completion.catch(() => {});
      await this.ctx.sessions.flush(agent.session);
      abort.throwIfAborted();
      return {completion:liveMask ? completion.finally(liveMask) : completion};
    } catch (error) {
      liveMask?.();
      const handle = state.handle;
      if (handle && handle !== previousHandle) {
        await handle.dispose();
        state.handle = undefined;
        this.handles.delete(handle);
      }
      throw error;
    }
  }
  private waitForCompletion(agent: Agent, eventId: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let checking = Promise.resolve();
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        off();
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve("Task result processed in the original session");
      };
      const onAbort = () => finish(signal.reason ?? new Error("Task return delivery interrupted"));
      const check = (idle: boolean) => {
        checking = checking.then(async () => {
          if (settled) return;
          await this.ctx.sessions.flush(agent.session);
          if (taskReturnCompleted(await this.read(String(agent.id)), eventId)) finish();
          else if (idle) finish(new Error("Task result continuation interrupted; retained for retry"));
        }).catch(finish);
      };
      const off = this.ctx.on("session/event", (session, event) => {
        if (session === agent.session && event.type === "turn/end") check(false);
      });
      signal.addEventListener("abort", onAbort, {once: true});
      if (signal.aborted) onAbort();
      void agent.whenIdle().then(() => check(true), finish);
    });
  }
  async dispose() {
    this.lifetime.abort(new Error("Task return delivery stopping"));
    await Promise.allSettled([...this.deliveries.values()]);
    await Promise.allSettled([...this.handles].map(handle => handle.dispose()));
    this.handles.clear();
    this.sessions.clear();
  }
}
