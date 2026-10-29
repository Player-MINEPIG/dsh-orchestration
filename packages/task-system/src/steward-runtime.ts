import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage, ReasoningEffortId, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { TaskSystemService } from "./dsh-plugin.js";
import { canonical, TaskError } from "./ledger.js";
import { StewardConversations, stewardBindingKey, type StewardCursor } from "./steward-conversations.js";
import { StewardMemoryBridge } from "./steward-memory.js";
import { resolveStewardRoute, createStewardClassifier } from "./steward-routing.js";
import { STEWARD_PERSONA, STEWARD_PERSONA_TEXT, stewardBinding, stewardRead, stewardSend, stewardResolve,
  type StewardBinding, type StewardMessage, type StewardScope, type StewardSend, type StewardSnapshot } from "./steward-contracts.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const metadata = z.object({
  sessionId: z.string(), generation: z.number().int(), workspace: z.string(),
  nativeSession: z.object({ binding: stewardBinding }).optional(),
});
const wireEvent = z.object({ seq: z.number().int(), type: z.string(), time: z.number(), data: z.unknown() });
const wirePage = z.object({ records: z.array(z.object({ event: wireEvent })), hasMore: z.boolean() });
const userData = z.object({ id: z.string(), source: z.object({ kind: z.string(), rpcId: z.string().optional() }).passthrough() }).passthrough();
const assistantData = z.object({ message: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough() }).passthrough();
const endData = z.object({ reason: z.object({ kind: z.string() }).passthrough() }).passthrough();
type ObservedEvent = z.infer<typeof wireEvent>;
const limitations = [
  "Context manifests record selection, not complete provider-request verification.",
  "Optional memory resources require explicit Host delegation, Manager policy and native Assembler presets.",
  "Native turn completion is not task completion, user acceptance, or proof of reading.",
  "Remote project persona assembly requires an owner-side adapter.",
  "Request observation proves the local llm/stream boundary only, not provider delivery or understanding.",
  "Long-session pagination and sustained-load behavior are not yet verified.",
];

export class StewardRuntime {
  readonly store: StewardConversations;
  readonly memory: StewardMemoryBridge;
  private ctx: Context;
  private readonly sends = new Map<string, Promise<StewardSnapshot>>();
  private readonly reads = new Map<string, Promise<StewardSnapshot>>();
  private readonly handles = new Map<string, Awaited<ReturnType<Context["agents"]["create"]>>>();
  private readonly personalJobs = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private promptDisposer?: () => void;
  private requestDisposer?: () => void;
  private requestDiagnostic: string | null = null;
  private closed = false;
  constructor(private readonly task: TaskSystemService, ctx: Context) {
    this.ctx = ctx;
    this.store = new StewardConversations(task.ledger);
    this.memory = new StewardMemoryBridge(task, this.store, ctx);
  }
  get active(): boolean { return this.sends.size > 0 || this.personalJobs.size > 0; }
  bindContext(ctx: Context) {
    this.ctx = ctx;
    this.promptDisposer?.();
    this.promptDisposer = ctx.systemPrompt.section({
      name: "dsh-steward-persona", order: 10200, interpolate: false,
      text: ({ agent }) => !this.memory.assembled && agent && this.store.conversationIds().some(id =>
        this.store.cursors(id).some(cursor => cursor.binding.sessionId === agent.id && cursor.binding.nodeId === this.task.config.nodeId))
        ? `[persona ${STEWARD_PERSONA.id}@${STEWARD_PERSONA.version}]\n${STEWARD_PERSONA_TEXT}` : "",
    });
    this.requestDisposer?.();
    const runtime = this;
    this.requestDisposer = ctx.on("llm/stream", async function* (options, next) {
      try { runtime.observeRequest(options); }
      catch (error) { runtime.requestDiagnostic = error instanceof Error ? error.message : String(error); }
      yield* next();
    });
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const conversationId of this.store.conversationIds()) void this.reconcile({ conversationId }).catch(() => {});
      }, 2000);
      this.timer.unref();
    }
  }
  private ready() {
    if (this.closed) throw new TaskError("UNAVAILABLE", "Steward conversation is stopping");
    if (this.task.config.centralMode !== "host" || !this.task.projects)
      throw new TaskError("UNAVAILABLE", "Open the steward on the project authority host");
  }
  private projects() {
    this.ready();
    return this.task.projects!.snapshot().projects.filter(project => project.canChat)
      .map(project => ({ projectId: project.id, title: project.title }));
  }
  snapshot(input: unknown): StewardSnapshot {
    this.ready();
    const request = stewardRead.parse(input);
    this.store.ensure(request.conversationId);
    const all = this.store.messages(request.conversationId);
    return { authorityId: this.task.ledger.schedulerIdentity(), conversationId: request.conversationId,
      currentScope: this.store.current(request.conversationId), persona: STEWARD_PERSONA,
      messages: all.filter(message => message.seq > (request.afterSeq ?? 0)), projects: this.projects(),
      lastSeq: all.at(-1)?.seq ?? 0, limitations, routing: { auto: !!this.task.config.projectAgentOptions && !!this.ctx.get("llm") },
      context: this.memory.capability(),
      requests: this.store.requests(request.conversationId),
      requestObservation: { kind: this.requestDiagnostic || !this.requestDisposer ? "unavailable" : "active", reason: this.requestDiagnostic },
      sources: this.store.cursors(request.conversationId).map(cursor => ({ source: cursor.binding, status: cursor.status })) };
  }
  private observeRequest(options: GenerateOptions) {
    if (!options.sessionId || !Object.isFrozen(options)) return;
    const session = this.ctx.agents.get(options.sessionId)?.session;
    if (!session || canonical(options.messages) !== canonical(session.deriveMessages())) return;
    const step = session.snapshotEvents().findLast(event => event.type === "step/start");
    if (!step) return;
    const sources = this.store.conversationIds().flatMap(conversationId => this.store.cursors(conversationId)
      .filter(cursor => cursor.binding.nodeId === this.task.config.nodeId && cursor.binding.sessionId === options.sessionId)
      .map(cursor => ({ conversationId, binding: cursor.binding })));
    const unique = new Set(sources.map(source => stewardBindingKey(source.binding)));
    if (unique.size !== 1) return;
    const { signal: _signal, ...request } = options;
    const requestHash = createHash("sha256").update(canonical(request)).digest("hex");
    const messageHash = createHash("sha256").update(canonical(options.messages)).digest("hex");
    const assembly = this.ctx.get("dshPromptAssembler")?.runtime.observeNativeRequest(options, session);
    const personaObserved = options.messages.some(message => message.role === "system" &&
      message.content.some(part => part.type === "text" && part.text.includes(STEWARD_PERSONA_TEXT)));
    for (const { conversationId, binding } of sources) {
      const original = this.store.messages(conversationId).findLast(message => message.role === "user" && stewardBindingKey(message.source) === stewardBindingKey(binding));
      this.store.observeRequest({ id: hash(`${conversationId}:${stewardBindingKey(binding)}:${step.seq}:${requestHash}`), conversationId,
        source: binding, stepSeq: step.seq, observedAt: new Date().toISOString(), requestHash, messageHash,
        selectedResources: original?.manifest.resources ?? [], personaObserved, assemblerObserved: !!assembly,
        assemblyHash: assembly ? createHash("sha256").update(canonical(assembly)).digest("hex") : null });
    }
    this.requestDiagnostic = null;
  }
  send(input: unknown): Promise<StewardSnapshot> {
    this.ready();
    this.task.assertConversationAdmission();
    const request = stewardSend.parse(input);
    // Check the immutable command even when another invocation is still in flight.
    const previous = this.store.replay(request);
    const active = this.sends.get(request.commandId);
    if (active) {
      if (!previous) return active.then(() => this.send(request));
      return active;
    }
    if (previous) return this.reconcile({ conversationId: request.conversationId });
    const job = this.submit(request).finally(() => this.sends.delete(request.commandId));
    this.sends.set(request.commandId, job);
    return job;
  }
  async resolve(input: unknown): Promise<StewardSnapshot> {
    this.ready();
    this.task.assertConversationAdmission();
    const request = stewardResolve.parse(input);
    if (this.store.resolutionReplay(request)) return this.snapshot({ conversationId: request.conversationId });
    const key = `resolution:${request.commandId}`;
    const active = this.sends.get(key);
    if (active) { await active; return this.resolve(input); }
    const job = this.resolveUncertain(request).finally(() => this.sends.delete(key));
    this.sends.set(key, job);
    return job;
  }
  private async resolveUncertain(request: z.infer<typeof stewardResolve>): Promise<StewardSnapshot> {
    await this.reconcile({ conversationId: request.conversationId });
    const message = this.store.message(request.messageId), binding = message.source;
    if (message.conversationId !== request.conversationId || message.role !== "user")
      throw new TaskError("FORBIDDEN", "Message belongs to another conversation");
    if (binding.nodeId !== this.task.config.nodeId)
      throw new TaskError("UNAVAILABLE", "Remote owner recovery requires an owner-side idle and inbox inspection");
    const current = await this.resolveBinding(message.scope, request.conversationId);
    if (stewardBindingKey(current) !== stewardBindingKey(binding))
      throw new TaskError("CONFLICT", "Project generation changed; inspect the original native owner instead");
    const persistence = this.ctx.sessionPersistence;
    if (await persistence.stat(SessionId(binding.sessionId))) {
      const handle = await persistence.open(SessionId(binding.sessionId), "read");
      try {
        const events = (await handle.read()).events;
        const projected = this.ctx.sessionProjections.restore({}, events, SessionLogOffset(0), handle.header, handle.inheritedEventCount);
        const inbox = z.object({ "next-turn": z.array(z.unknown()), "next-step": z.array(z.unknown()) })
          .parse(projected.snapshot.values.inbox);
        if (inbox["next-turn"].length || inbox["next-step"].length)
          throw new TaskError("BUSY", "The native session still has pending input; inspect it before ending the wait");
      } finally { await handle.close(); }
    }
    // Revalidate synchronously after the final native read; do not wake or cancel any owner.
    const agent = this.ctx.agents.get(SessionId(binding.sessionId));
    if (agent && (agent.status !== "idle" || agent.inbox.nextTurn.length || agent.inbox.nextStep.length))
      throw new TaskError("BUSY", "The native session is still active");
    if (binding.kind !== "personal") {
      const project = this.task.projects!.placementProject(binding.projectId);
      if (project.session !== binding.sessionId || project.generation !== binding.generation)
        throw new TaskError("CONFLICT", "Project generation changed during recovery");
      const db = this.task.ledger.managementDatabase();
      const custody = db.prepare("SELECT data FROM project_session_owner_custody WHERE session=?").get(binding.sessionId);
      if (custody && z.array(z.unknown()).parse(JSON.parse(String(custody.data))).length)
        throw new TaskError("BUSY", "The native owner still holds pending input");
      if (db.prepare("SELECT command FROM pr_turns WHERE session=? AND state IN ('queued','running')").get(binding.sessionId))
        throw new TaskError("BUSY", "The managed project turn is still active");
    }
    this.store.release(request);
    return this.snapshot({ conversationId: request.conversationId });
  }
  private async resolveBinding(scope: StewardScope, conversationId: string): Promise<StewardBinding> {
    if (!this.ctx.get("agents") || !this.ctx.get("sessions") || !this.ctx.get("sessionPersistence"))
      throw new TaskError("UNAVAILABLE", "Native session services are unavailable");
    if (scope.kind === "personal") {
      if (!this.task.config.projectAgentOptions) throw new TaskError("CONFIGURATION", "Configure the conversation model first");
      const key = hash(this.task.ledger.schedulerIdentity() + ":" + conversationId);
      return { kind: "personal", nodeId: this.task.config.nodeId, sessionId: `steward-personal-${key}`,
        generation: 1, cwd: join(dirname(resolve(this.task.config.databasePath)), "steward", key) };
    }
    if (!this.projects().some(project => project.projectId === scope.projectId))
      throw new TaskError("FORBIDDEN", "Project is not available to this conversation");
    const description = metadata.parse(await this.task.sessionPortal.conversation(scope.projectId));
    return description.nativeSession?.binding ?? {
      kind: "managed", projectId: scope.projectId, nodeId: this.task.config.nodeId,
      sessionId: description.sessionId, generation: description.generation, cwd: description.workspace,
    };
  }
  private async submit(request: StewardSend): Promise<StewardSnapshot> {
    let scope = this.store.resolveScope(request);
    if (request.routingMode === "auto") {
      const replyScope = request.replyTo ? this.store.message(request.replyTo).scope : undefined;
      const options = this.task.config.projectAgentOptions;
      const result = await resolveStewardRoute({ text: request.text, projects: this.projects(),
        previousScope: this.store.current(request.conversationId), explicitTarget: request.target, replyScope,
        ...(options && this.ctx.get("llm") ? { classify: createStewardClassifier(this.ctx, options) } : {}) });
      if (result.kind === "clarification") throw new TaskError("CLARIFICATION", result.question);
      scope = result.target;
    }
    const binding = await this.resolveBinding(scope, request.conversationId);
    const initial = await this.events(binding, -1);
    // Awaiting native reads can overlap another send; acceptance and the attempted marker are synchronous.
    if (this.store.replay(request)) return this.reconcile({ conversationId: request.conversationId });
    const message = this.store.accept(request, scope, binding, initial.at(-1)?.seq ?? -1);
    this.store.setState(message.id, { kind: "needs-reconciliation", reason: "Native admission has started; reconcile before any retry." });
    try {
      if (binding.kind === "personal") await this.promptPersonal(binding, message);
      else if (binding.kind === "managed") {
        const current = this.task.projects!.placementProject(binding.projectId);
        if (current.session !== binding.sessionId || current.generation !== binding.generation)
          throw new TaskError("CONFLICT", "Project generation changed before admission");
        this.task.projects!.send({ projectId: binding.projectId, commandId: this.store.requestId(message.id), text: message.text });
      } else {
        await this.task.sessionPortal.nativeConversation({ projectId: binding.projectId, generation: binding.generation,
          commandId: this.store.requestId(message.id), operation: { kind: "session-prompt",
            requestId: this.store.requestId(message.id), mode: "queue", content: [{ type: "text", text: message.text }] } });
      }
      if (this.store.message(message.id).state.kind !== "completed")
        this.store.setState(message.id, { kind: "admitted", requestId: this.store.requestId(message.id) });
    } catch (error) {
      // An ambiguous transport/runtime failure must never cause a fresh native prompt.
      if (error instanceof TaskError && ["CONFLICT", "FORBIDDEN", "CONFIGURATION", "BUSY"].includes(error.code))
        this.store.setState(message.id, { kind: "rejected", reason: error.message });
      else this.store.setState(message.id, { kind: "needs-reconciliation", reason: "Native admission is uncertain. This message will not be resent automatically." });
    }
    return this.reconcile({ conversationId: request.conversationId });
  }
  private async promptPersonal(binding: Extract<StewardBinding, { kind: "personal" }>, message: StewardMessage) {
    let handle = this.handles.get(binding.sessionId);
    if (!handle) {
      const selected = this.task.config.projectAgentOptions;
      if (!selected) throw new TaskError("CONFIGURATION", "Configure the conversation model first");
      const { reasoningEffort, ...selection } = selected;
      const agentOptions = { ...selection, ...(reasoningEffort ? { reasoningEffort: ReasoningEffortId(reasoningEffort) } : {}) };
      const setup = (ctx: Context, _agent: Agent) => { ctx.tools.restrict({ allow: [] }); };
      mkdirSync(binding.cwd, { recursive: true, mode: 0o700 });
      const stored = await this.ctx.sessionPersistence.stat(SessionId(binding.sessionId));
      handle = stored
        ? await this.ctx.agents.resume({ resumeSessionId: SessionId(binding.sessionId), agentOptions, setup })
        : await this.ctx.agents.create({ sessionId: SessionId(binding.sessionId), meta: { cwd: binding.cwd }, agentOptions, setup });
      this.handles.set(binding.sessionId, handle);
    }
    handle.agent.followup(createUserMessage({ source: { kind: "user", rpcId: this.store.requestId(message.id) },
      content: [{ type: "text", text: message.text }] }));
    const agent = handle.agent;
    const done = agent.whenIdle().then(() => this.ctx.sessions.flush(agent.session)).then(() => {}).catch(() => {})
      .finally(() => this.personalJobs.delete(done));
    this.personalJobs.add(done);
    await this.ctx.sessions.flush(agent.session);
  }
  private async events(binding: StewardBinding, afterSeq: number): Promise<ObservedEvent[]> {
    if (binding.nodeId === this.task.config.nodeId) {
      const persistence = this.ctx.get("sessionPersistence");
      if (!persistence) throw new TaskError("UNAVAILABLE", "Native persistence is unavailable");
      if (!await persistence.stat(SessionId(binding.sessionId))) return [];
      const agent = this.ctx.get("agents")?.get(SessionId(binding.sessionId));
      if (agent) await this.ctx.sessions.flush(agent.session);
      const handle = await persistence.open(SessionId(binding.sessionId), "read");
      try { return (await handle.read(afterSeq + 1)).events.map(event => wireEvent.parse(event)); }
      finally { await handle.close(); }
    }
    if (binding.kind !== "native") throw new TaskError("UNAVAILABLE", "Remote managed session cannot be projected");
    // A page is an ordinary persisted projection, not a new prompt or task-return acknowledgement.
    const projection = z.object({ kind: z.literal("sequenced"), asOfSeq: z.number() }).passthrough()
      .parse(await this.task.sessionPortal.nativeConversation({ projectId: binding.projectId, generation: binding.generation, operation: { kind: "session-projections" } }));
    if (projection.asOfSeq <= afterSeq) return [];
    const result: ObservedEvent[] = [];
    let beforeSeq: number | undefined;
    for (let page = 0; page < 20; page++) {
      const value = wirePage.parse(await this.task.sessionPortal.nativeConversation({ projectId: binding.projectId,
        generation: binding.generation, operation: { kind: "session-page", throughSeq: projection.asOfSeq,
          ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: 100 } }));
      result.push(...value.records.map(record => record.event).filter(event => event.seq > afterSeq));
      const first = value.records.at(0)?.event.seq;
      if (!value.hasMore || first === undefined || first <= afterSeq) return result.sort((a, b) => a.seq - b.seq);
      beforeSeq = first;
    }
    throw new TaskError("LIMIT", "Native history catchup exceeds one bounded page batch");
  }
  reconcile(input: unknown): Promise<StewardSnapshot> {
    this.ready();
    const { conversationId } = stewardRead.parse(input);
    const active = this.reads.get(conversationId);
    if (active) return active;
    const job = this.catchup(conversationId).finally(() => this.reads.delete(conversationId));
    this.reads.set(conversationId, job);
    return job;
  }
  private async catchup(conversationId: string): Promise<StewardSnapshot> {
    this.store.ensure(conversationId);
    for (const cursor of this.store.cursors(conversationId)) {
      try {
        for (const event of await this.events(cursor.binding, cursor.afterSeq)) this.observe(conversationId, cursor, event);
        cursor.status = { kind: "ready", observedAt: new Date().toISOString() };
      } catch {
        cursor.status = { kind: "unavailable", observedAt: new Date().toISOString(),
          reason: "The native source could not be read. Its last durable cursor and messages are retained." };
      }
      this.store.saveCursor(conversationId, cursor);
    }
    this.notifications(conversationId);
    return this.snapshot({ conversationId });
  }
  private observe(conversationId: string, cursor: StewardCursor, event: ObservedEvent) {
    if (event.seq <= cursor.afterSeq) return;
    if (event.type === "user/message") {
      const source = userData.parse(event.data);
      const own = this.store.messages(conversationId).find(message => message.role === "user" &&
        stewardBindingKey(message.source) === stewardBindingKey(cursor.binding) && this.store.requestId(message.id) === source.source.rpcId);
      if (own) {
        cursor.currentUser = own.id;
        if (!cursor.pendingUsers.includes(own.id)) cursor.pendingUsers.push(own.id);
      }
      else if (source.source.kind === "user") cursor.currentUser = null;
      if (own && own.state.kind !== "completed") this.store.setState(own.id, { kind: "admitted", requestId: this.store.requestId(own.id) });
    } else if (event.type === "assistant/message" && cursor.currentUser) {
      const own = this.store.message(cursor.currentUser);
      const text = assistantData.parse(event.data).message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      if (text) this.store.project({ conversationId, role: "assistant", text, commandId: null, scope: own.scope, replyTo: own.id,
        source: cursor.binding, nativeSeq: event.seq, provenance: null, createdAt: new Date(event.time).toISOString(),
        state: { kind: "completed" }, manifest: own.manifest }, `native:${stewardBindingKey(cursor.binding)}:${event.seq}`);
    } else if (event.type === "turn/end") {
      const reason = endData.parse(event.data).reason.kind;
      for (const id of cursor.pendingUsers)
        this.store.setState(id, reason === "completed" ? { kind: "completed" } : { kind: "stopped", reason: `Native turn ended: ${reason}` });
      cursor.pendingUsers = [];
      cursor.currentUser = null;
    }
    cursor.afterSeq = event.seq;
    this.store.saveCursor(conversationId, cursor);
  }
  private notifications(conversationId: string) {
    const db = this.task.ledger.managementDatabase();
    const messages = this.store.messages(conversationId);
    const projects = this.task.projects!.snapshot();
    const eventSchema = z.object({ eventId: z.string(), taskId: z.string().optional(), runId: z.string().optional(), type: z.string(), at: z.string(), detail: z.unknown() });
    const rows = db.prepare("SELECT seq,data FROM events WHERE seq>? ORDER BY seq LIMIT 200").all(this.store.eventCursor(conversationId));
    for (const row of rows) {
      const event = eventSchema.parse(JSON.parse(String(row.data)));
      const task = projects.tasks.find(task => task.id === event.taskId);
      if (task && event.type === "decision.applied") {
        const decision = z.object({ decisionId: z.string() }).passthrough().safeParse(event.detail);
        const origin = decision.success && messages.find(message => message.role === "user" &&
          message.scope.kind === "project" && message.scope.projectId === task.project &&
          decision.data.decisionId === `project-message:${this.store.requestId(message.id)}`);
        if (origin) this.store.bindTask(conversationId, task.id, origin.id);
      }
      const origin = task && this.store.taskOrigin(conversationId, task.id);
      const subscription = origin ?? (task && messages.find(message => message.scope.kind === "project" && message.scope.projectId === task.project));
      if (event.type === "report.appended") {
        const reportId = z.object({ reportId: z.string() }).safeParse(event.detail);
        const report = reportId.success ? this.task.ledger.getReport(reportId.data.reportId) : undefined;
        const initialRequest = report?.kind === "progress" && report.title === "Task request" && !report.runId;
        const coveredBySettlement = report?.kind === "result" && event.runId && db.prepare(
          "SELECT seq FROM events WHERE run_id=? AND seq>? AND json_extract(data,'$.type')='run.settled' LIMIT 1"
        ).get(event.runId, Number(row.seq));
        if (initialRequest || coveredBySettlement) {
          this.store.advanceEvents(conversationId, Number(row.seq));
          continue;
        }
      }
      if (task && subscription && ["run.execution_started", "run.settled", "report.appended", "task.checkin_updated", "task.execution_check_queued"].includes(event.type)) {
        const detail = z.object({ summary: z.string().optional(), outcome: z.string().optional() }).passthrough().safeParse(event.detail);
        const outcome = detail.success ? detail.data.outcome : undefined;
        const summary = detail.success ? detail.data.summary?.slice(0, 2000) : undefined;
        const state = event.type === "run.execution_started" ? "已开始执行。"
          : event.type === "run.settled" ? `本次执行已结束（${outcome === "success" ? "成功" : outcome === "failure" ? "失败" : outcome === "partial" ? "部分完成" : outcome === "blocked" ? "受阻" : "结果未知"}）。请查看报告，再决定是否验收或继续。`
          : event.type === "report.appended" ? "有新报告可查看。请核对其中的进展和结果。"
          : event.type === "task.checkin_updated" ? "已更新进度检查记录。"
          : "已到预计检查时间，需要核实进度；这不表示执行失败。";
        this.store.project({ conversationId, role: "notification", commandId: null, text: `「${task.title}」${state}${summary ? "\n记录摘要：" + summary : ""}`,
          scope: subscription.scope, replyTo: origin?.id ?? null, createdAt: event.at, source: subscription.source, nativeSeq: null,
          provenance: { kind: "ledger", eventId: event.eventId, eventType: event.type, taskId: task.id, runId: event.runId ?? null },
          state: { kind: "completed" }, manifest: subscription.manifest }, `ledger:${event.eventId}`);
      }
      this.store.advanceEvents(conversationId, Number(row.seq));
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.promptDisposer?.();
    this.requestDisposer?.();
    this.memory.close();
    await Promise.allSettled([...this.sends.values(), ...this.reads.values()]);
    for (const handle of this.handles.values()) handle.agent.cancel({ kind: "hook", reason: "Steward personal session is stopping" });
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()));
    await Promise.allSettled([...this.personalJobs]);
    this.handles.clear();
  }
}

