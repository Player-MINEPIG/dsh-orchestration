import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import { stewardBinding, type StewardBinding, type StewardScope } from "./steward-contracts.js";
import type { StewardConversations } from "./steward-conversations.js";
import type { stewardProjectCheckpoint } from "./steward-memory-context.js";
import { topicReference, topicSource, type TopicCardsPort, type TopicContext, type TopicRef } from "./steward-topic-types.js";
import type { EvidenceUnavailable } from "./steward-evidence.js";

const key = z.string().min(1).max(200);
const taskStatus = z.strictObject({ taskId: key, state: key, version: key,
  run: z.strictObject({ runId: key, state: key }).nullable(),
  reports: z.array(z.strictObject({ reportId: key, revision: z.union([key, z.number().int().nonnegative()]) })).max(2), reviewRequired: z.boolean() });
export type ContinuityTaskStatus = z.infer<typeof taskStatus>;
export interface StewardContinuityHost extends Pick<TopicCardsPort, "source"> {
  context(input: Parameters<TopicCardsPort["context"]>[0] & { binding?: StewardBinding }): Promise<TopicContext>;
  bindingForSession(sessionId: string): { conversationId: string; scope: StewardScope; binding: StewardBinding } | null;
  taskFacts?(binding: StewardBinding): ReturnType<typeof stewardProjectCheckpoint> | null;
  taskStatus?(binding: StewardBinding): ContinuityTaskStatus | null;
}
const tokens = z.strictObject({ totalTokens: z.number().int().nonnegative(), contextWindow: z.number().int().positive() });
export const continuityCapture = z.strictObject({ messageId: key, trigger: z.literal("turn-complete"), tokens: tokens.optional() });
export const continuityInspect = z.strictObject({ checkpointId: key.optional() });
const checkpoint = z.strictObject({
  id: key, topic: topicReference, binding: stewardBinding, triggerMessageId: key, throughSeq: z.number().int().nonnegative(), createdAt: key,
  reason: z.enum(["initial", "phase", "decisions", "budget"]), phase: key, authorityVersion: key, decisionVersion: key,
  decisions: z.array(z.strictObject({ id: key, text: z.string().max(600), truncated: z.boolean(),
    origin: z.enum(["authoritative", "extractive", "generated"]), sources: z.array(topicSource).min(1).max(8) })).max(8),
  sources: z.array(topicSource).max(24), incomplete: z.boolean(), tokens: tokens.optional(),
  task: taskStatus.nullable().default(null),
});
export type StewardCheckpoint = z.infer<typeof checkpoint>;
export type ContinuityResult = { kind: "checkpoint"; checkpoint: StewardCheckpoint; changed: boolean; dataOnly: true;
  verification: { status: "current" | "review-required"; reasons: string[]; automaticRetry: false }; notice: string } | EvidenceUnavailable;
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** Derived checkpoints refer to canonical originals and authority; they never own execution. */
export class StewardContinuity {
  private readonly db;
  constructor(ledger: Pick<TaskLedger, "managementDatabase">, private readonly store: StewardConversations, private readonly host: StewardContinuityHost) {
    this.db = ledger.managementDatabase();
    this.db.exec(`CREATE TABLE IF NOT EXISTS steward_continuity_checkpoints(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS steward_continuity_latest ON steward_continuity_checkpoints(scope_key);`);
  }
  private identity(sessionId: string) {
    const identity = this.host.bindingForSession(sessionId);
    if (!identity || identity.binding.sessionId !== sessionId) throw new TaskError("FORBIDDEN", "No current steward binding for this session");
    return identity;
  }
  private authority(binding: StewardBinding) {
    const ownedTask = this.host.taskStatus?.(binding);
    if (ownedTask) {
      const task = taskStatus.parse(ownedTask), risks: string[] = [];
      if (task.run && ["uncertain", "queued", "running"].includes(task.run.state)) risks.push("当前任务已有运行活跃或结果未证实，不能自动重跑。");
      if (task.reviewRequired) risks.push("当前任务仍需责任人核对或人员验收，缺少门禁记录不表示已通过。");
      const phase = task.run && ["queued", "running"].includes(task.run.state) ? "execution" : task.reviewRequired ? "acceptance"
        : task.state === "completed" ? "review" : "planning";
      return { phase, version: digest(task), incomplete: false, risks, task };
    }
    const facts = this.host.taskFacts?.(binding);
    if (!facts) return { phase: "discussion", version: digest(null), incomplete: false, risks: [], task: null };
    if ((binding.kind !== "managed" && binding.kind !== "native") || facts.projectId !== binding.projectId)
      throw new TaskError("FORBIDDEN", "Authority facts belong to another project");
    const phase = facts.tasks.some(task => task.run && ["running", "queued"].includes(task.run.state)) ? "execution"
      : facts.gates.gates.some(gate => gate.state !== "released") ? "acceptance"
      : facts.tasks.some(task => task.state === "completed") ? "review" : "planning";
    const risks: string[] = [];
    if (facts.tasks.some(task => task.run && ["uncertain", "running", "queued"].includes(task.run.state))) risks.push("已有运行仍活跃或结果未证实，先核对，不能自动重跑。");
    if (facts.gates.gates.some(gate => gate.state !== "released")) risks.push("人员验收门禁尚未放行，保持相关步骤等待。");
    return { phase, version: digest({ tasks: facts.tasks.map(task => ({ source: task.source, state: task.state, run: task.run,
      reports: task.reports.map(report => report.source), decision: task.decision?.source, checkin: task.checkin })), gates: facts.gates }),
      incomplete: facts.tasksTruncated || facts.gates.truncated, risks, task: null };
  }
  private latest(topic: TopicRef, binding: StewardBinding) {
    const row = this.db.prepare("SELECT data FROM steward_continuity_checkpoints WHERE scope_key=? ORDER BY rowid DESC LIMIT 1").get(digest({ topic, binding }));
    return row ? checkpoint.parse(JSON.parse(String(row.data))) : null;
  }
  private failure(error: unknown): EvidenceUnavailable {
    if (!(error instanceof TaskError)) throw error;
    if (error.code === "FORBIDDEN") return { kind: "forbidden", reason: "检查点或其来源不属于当前受权会话。" };
    if (error.code === "CONFLICT") return { kind: "stale", reason: "检查点来源版本已经变化，请先核对当前原文。" };
    if (["NOT_FOUND", "UNAVAILABLE"].includes(error.code)) return { kind: "needs_context", reason: "当前检查点所需来源暂不可用。" };
    throw error;
  }
  private result(value: StewardCheckpoint, changed: boolean, reasons: string[]): ContinuityResult {
    return { kind: "checkpoint", checkpoint: value, changed, dataOnly: true,
      verification: { status: reasons.length ? "review-required" : "current", reasons, automaticRetry: false },
      notice: "有界检查点与原文指针，不是人员验收或新的执行许可。恢复输出优先提供当前已核对的有效决定，旧检查点只保留轨迹；核对账本和来源后继续，不能自动重跑旧动作。" };
  }
  async capture(input: unknown): Promise<ContinuityResult> {
    const request = continuityCapture.parse(input);
    try {
      const message = this.store.message(request.messageId), current = this.identity(message.source.sessionId);
      if (message.role !== "user" || message.state.kind !== "completed")
        return { kind: "needs_context", reason: "只在真实原生用户回合完成后记录检查点。" };
      if (message.conversationId !== current.conversationId || canonical(message.scope) !== canonical(current.scope)
        || canonical(message.source) !== canonical(current.binding)) throw new TaskError("FORBIDDEN", "Completed message binding changed");
      const topic = { conversationId: current.conversationId, scope: current.scope };
      const context = await this.host.context({ topic, binding: current.binding, throughSeq: Number.MAX_SAFE_INTEGER, maintain: false });
      if (canonical(context.card.topic) !== canonical(topic) || canonical(context.card.binding) !== canonical(current.binding))
        throw new TaskError("FORBIDDEN", "Checkpoint context binding mismatch");
      const authority = this.authority(current.binding);
      const active = context.card.facts.filter(fact => fact.section === "decision" && fact.state === "active")
        .sort((a, b) => Math.max(0, ...b.sources.filter(source => source.kind === "message").map(source => source.seq))
          - Math.max(0, ...a.sources.filter(source => source.kind === "message").map(source => source.seq)));
      const decisionVersion = digest(active), previous = this.latest(topic, current.binding);
      const budget = !!request.tokens && request.tokens.totalTokens >= request.tokens.contextWindow * 0.7;
      const grew = request.tokens && (!previous?.tokens || request.tokens.totalTokens > previous.tokens.totalTokens);
      const reason = !previous ? "initial" : previous.phase !== authority.phase || previous.authorityVersion !== authority.version ? "phase"
        : previous.decisionVersion !== decisionVersion ? "decisions" : budget && grew ? "budget" : null;
      if (!reason) {
        if (!previous) throw new TaskError("INVALID", "Missing initial checkpoint");
        return this.result(previous, false, [...authority.risks, ...(previous.incomplete ? ["检查点资料仍不完整。"] : [])]);
      }
      const decisions = active.slice(0, 8).map(fact => ({ id: fact.id, text: Array.from(fact.text).slice(0, 600).join(""),
        truncated: Array.from(fact.text).length > 600, origin: fact.origin, sources: fact.sources }));
      const allSources = [...new Map([...decisions.flatMap(fact => fact.sources), ...context.originals.slice(-4).map(item => item.source)]
        .map(source => [canonical(source), source])).values()];
      const value: StewardCheckpoint = { id: digest({ topic, binding: current.binding, messageId: message.id, authority: authority.version,
        decisions: decisionVersion, tokens: request.tokens ?? null }), topic, binding: current.binding, triggerMessageId: message.id,
        throughSeq: context.card.observedThroughSeq, createdAt: new Date().toISOString(), reason, phase: authority.phase,
        authorityVersion: authority.version, decisionVersion, decisions, sources: allSources.slice(0, 24), task: authority.task,
        incomplete: !context.complete || context.card.freshness !== "current" || authority.incomplete || active.length > 8 || allSources.length > 24,
        ...(request.tokens ? { tokens: request.tokens } : {}) };
      if (Buffer.byteLength(canonical(value)) > 16000) return { kind: "needs_context", reason: "检查点超过有界资料预算，请先缩小或补齐来源。" };
      for (const ref of value.sources) await this.host.source({ conversationId: topic.conversationId, ref, offset: 0 });
      if (canonical(this.identity(message.source.sessionId)) !== canonical(current)) throw new TaskError("FORBIDDEN", "Binding changed during checkpoint capture");
      const inserted = this.db.prepare("INSERT OR IGNORE INTO steward_continuity_checkpoints VALUES(?,?,?)").run(value.id, digest({ topic, binding: current.binding }), canonical(value));
      this.db.prepare(`DELETE FROM steward_continuity_checkpoints WHERE scope_key=? AND id NOT IN
        (SELECT id FROM steward_continuity_checkpoints WHERE scope_key=? ORDER BY rowid DESC LIMIT 4)`).run(digest({ topic, binding: current.binding }), digest({ topic, binding: current.binding }));
      const saved = checkpoint.parse(JSON.parse(String(this.db.prepare("SELECT data FROM steward_continuity_checkpoints WHERE id=?").get(value.id)?.data)));
      return this.result(saved, Number(inserted.changes) > 0, [...authority.risks, ...(value.incomplete ? ["部分原文、决定或账本资料未完整纳入，恢复前需核对。"] : [])]);
    } catch (error) { return this.failure(error); }
  }
  async inspect(sessionId: string, input: unknown = {}): Promise<ContinuityResult> {
    const request = continuityInspect.parse(input);
    try {
      const current = this.identity(sessionId), topic = { conversationId: current.conversationId, scope: current.scope };
      const row = request.checkpointId ? this.db.prepare("SELECT data FROM steward_continuity_checkpoints WHERE id=?").get(request.checkpointId) : undefined;
      const value = request.checkpointId ? row ? checkpoint.parse(JSON.parse(String(row.data))) : null : this.latest(topic, current.binding);
      if (!value) return { kind: "needs_context", reason: "当前会话尚无可核对的检查点。" };
      if (canonical(value.topic) !== canonical(topic) || canonical(value.binding) !== canonical(current.binding))
        throw new TaskError("FORBIDDEN", "Checkpoint belongs to a different session or source generation");
      for (const ref of value.sources) await this.host.source({ conversationId: topic.conversationId, ref, offset: 0 });
      const context = await this.host.context({ topic, binding: current.binding, throughSeq: Number.MAX_SAFE_INTEGER, maintain: false });
      if (canonical(context.card.topic) !== canonical(topic) || canonical(context.card.binding) !== canonical(current.binding)
        || canonical(this.identity(sessionId)) !== canonical(current)) throw new TaskError("FORBIDDEN", "Current context binding changed");
      const authority = this.authority(current.binding), reasons: string[] = [...authority.risks];
      const active = context.card.facts.filter(fact => fact.section === "decision" && fact.state === "active")
        .sort((a, b) => Math.max(0, ...b.sources.filter(source => source.kind === "message").map(source => source.seq))
          - Math.max(0, ...a.sources.filter(source => source.kind === "message").map(source => source.seq)));
      if (!context.complete || context.card.freshness !== "current") return { kind: "needs_context", reason: "当前有效决定来源尚不完整或已过期，先重新取得当前原文；不沿用旧检查点结论。" };
      if (authority.version !== value.authorityVersion) reasons.push("任务、运行、门禁或人员决定已变化，先核对当前账本。");
      if (digest(active) !== value.decisionVersion) reasons.push("有效决定已替代或变化，先读取新决定来源。");
      const decisions = active.slice(0, 8).map(fact => ({ id: fact.id, text: Array.from(fact.text).slice(0, 600).join(""),
        truncated: Array.from(fact.text).length > 600, origin: fact.origin, sources: fact.sources }));
      const sources = [...new Map([...decisions.flatMap(fact => fact.sources), ...context.originals.slice(-4).map(item => item.source)]
        .map(source => [canonical(source), source])).values()];
      const currentView: StewardCheckpoint = { ...value, phase: authority.phase, authorityVersion: authority.version, task: authority.task,
        decisionVersion: digest(active), decisions, sources: sources.slice(0, 24), throughSeq: context.card.observedThroughSeq,
        incomplete: authority.incomplete || active.length > 8 || sources.length > 24 };
      if (currentView.incomplete) reasons.push("当前账本或有效决定仍有省略，先缩小范围核对。");
      if (Buffer.byteLength(canonical(currentView)) > 16000) return { kind: "needs_context", reason: "当前有效决定超过恢复预算，请指定当前来源。" };
      for (const ref of currentView.sources) await this.host.source({ conversationId: topic.conversationId, ref, offset: 0 });
      return this.result(currentView, false, reasons);
    } catch (error) { return this.failure(error); }
  }
}
