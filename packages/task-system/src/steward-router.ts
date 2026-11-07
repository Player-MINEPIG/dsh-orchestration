import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import { stewardBinding, stewardScope, stewardSend, type StewardSend, type StewardScope } from "./steward-contracts.js";
import {stewardPermission} from "./steward-turn-permission.js";
import type { TopicCardsPort, TopicContext } from "./steward-topic-types.js";

const frozen = z.strictObject({ scope: stewardScope, latestMessageId: z.string().nullable(), throughSeq: z.number().int().nonnegative() });
const answer = z.strictObject({ commandId: z.string(), text: z.string(), at: z.string() });
const record = z.strictObject({ commandId: z.string(), conversationId: z.string(), request: stewardSend, digest: z.string(), createdAt: z.string(), latest: frozen,
  phase: z.enum(["routing", "clarifying", "resolved"]), questionId: z.string(), question: z.string(), reason: z.enum(["uncertain", "new-work", "timeout", "unavailable", "invalid-output", "budget"]).nullable(),
  permission:stewardPermission.nullable().default(null), candidates: z.array(stewardScope).max(4), answers: z.array(answer).max(8), binding: stewardBinding.nullable(), delivery: stewardSend.nullable(), parent: z.string().nullable() });
export type RouterRecord = z.infer<typeof record>;
export type RouterView = Omit<RouterRecord, "request" | "digest" | "delivery"> & { text: string; original: StewardSend; uploadCount: number; executorAdmitted: boolean };
export type SemanticCall = (input: { stage: "latest" | "candidates" | "answer" | "association"; text: string; original?: string; question?: string; context?: TopicContext; candidates?: unknown[] }, signal?: AbortSignal) => Promise<unknown>;
const decision = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("route"), target: stewardScope }),
  z.strictObject({ kind: z.literal("search"), queries: z.array(z.string().trim().min(1).max(100)).min(1).max(3) }),
  z.strictObject({ kind: z.literal("clarification"), question: z.string().trim().min(1).max(500) }),
  z.strictObject({ kind: z.literal("new-work"), question: z.string().trim().min(1).max(500) }),
  z.strictObject({ kind: z.literal("answer") }), z.strictObject({ kind: z.literal("new-request") }),
]);
const same = (a: StewardScope, b: StewardScope) => canonical(a) === canonical(b);
const digest = (request: StewardSend) => createHash("sha256").update(canonical(request)).digest("hex");

async function within<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted(); let abort:()=>void=()=>{};
  const stopped=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new TaskError("TIMEOUT","Router deadline"));signal.addEventListener("abort",abort,{once:true});});
  try{return await Promise.race([work,stopped]);}finally{signal.removeEventListener("abort",abort);}
}

/** Router receipts are durable, but are deliberately not executor messages or native turns. */
export class StewardRouter {
  private readonly db;
  constructor(ledger: Pick<TaskLedger, "managementDatabase">, private readonly cards: TopicCardsPort) {
    this.db = ledger.managementDatabase();
    this.db.exec("CREATE TABLE IF NOT EXISTS steward_router(command TEXT PRIMARY KEY,conversation TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS steward_router_conversation ON steward_router(conversation)");
  }
  private save(value: RouterRecord) { this.db.prepare("INSERT INTO steward_router VALUES(?,?,?) ON CONFLICT(command) DO UPDATE SET data=excluded.data").run(value.commandId, value.conversationId, canonical(record.parse(value))); }
  get(commandId: string): RouterRecord | null { const row = this.db.prepare("SELECT data FROM steward_router WHERE command=?").get(commandId); return row ? record.parse(JSON.parse(String(row.data))) : null; }
  list(conversationId: string): RouterView[] {
    return this.db.prepare("SELECT data FROM steward_router WHERE conversation=? ORDER BY CASE WHEN json_extract(data,'$.phase')='clarifying' THEN 0 ELSE 1 END,rowid DESC LIMIT 40").all(conversationId).reverse().map(row => {
      const value = record.parse(JSON.parse(String(row.data))); const { request, digest: _digest, delivery: _delivery, ...rest } = value;
      return { ...rest, text: request.text, original:request, uploadCount: request.uploads?.length ?? 0, executorAdmitted: !!this.db.prepare("SELECT 1 FROM steward_commands WHERE id=?").get(value.commandId) };
    });
  }
  private unresolved(conversationId:string): RouterRecord[] {
    return this.db.prepare("SELECT data FROM steward_router WHERE conversation=? AND json_extract(data,'$.phase')='clarifying' AND json_extract(data,'$.parent') IS NULL ORDER BY rowid LIMIT 2").all(conversationId).map(row=>record.parse(JSON.parse(String(row.data))));
  }
  private question(conversationId:string,questionId:string):RouterRecord|null {
    const row=this.db.prepare("SELECT data FROM steward_router WHERE conversation=? AND json_extract(data,'$.questionId')=? AND json_extract(data,'$.phase')='clarifying' AND json_extract(data,'$.parent') IS NULL").get(conversationId,questionId);
    return row?record.parse(JSON.parse(String(row.data))):null;
  }
  private commitParent(value:RouterRecord,expected:string):boolean {
    return this.db.prepare("UPDATE steward_router SET data=? WHERE command=? AND data=?").run(canonical(record.parse(value)),value.commandId,expected).changes===1;
  }
  private wait(value: RouterRecord, question: string, reason: RouterRecord["reason"], candidates = value.candidates) {
    value.phase = "clarifying"; value.question = question; value.reason = reason; value.candidates = candidates; this.save(value); return value;
  }
  async prepare(request: StewardSend, latest: z.infer<typeof frozen>, call?: SemanticCall, retain?:()=>void, permission?:z.infer<typeof stewardPermission>): Promise<RouterRecord> {
    const prior = this.get(request.commandId);
    if (prior) { if (prior.digest !== digest(request)) throw new TaskError("CONFLICT", "Router retry changed the original request"); if(prior.phase==="routing") return this.wait(prior,"上次分流在确认前中断，原请求仍完整保留。请明确选择收件话题。","unavailable"); return prior; }
    const value: RouterRecord = { commandId: request.commandId, conversationId: request.conversationId, request, digest: digest(request), createdAt: new Date().toISOString(), latest,
      permission:permission??null, phase: "routing", questionId: randomUUID(), question: "", reason: null, candidates: [], answers: [], binding: null, delivery: null, parent: null };
    // Commit before any auxiliary model call. A crash leaves an explicit, recoverable router receipt.
    if((!request.routeQuestionId || !this.question(request.conversationId,request.routeQuestionId)) && Number(this.db.prepare("SELECT COUNT(*) n FROM steward_router WHERE conversation=? AND json_extract(data,'$.phase')!='resolved' AND json_extract(data,'$.parent') IS NULL").get(request.conversationId)?.n??0)>=20) throw new TaskError("LIMIT","有20条分流请求尚未确认，请先处理已保存的问题。");
    this.db.exec("BEGIN IMMEDIATE");try{retain?.();this.save(value);this.db.exec("COMMIT");}catch(error){this.db.exec("ROLLBACK");throw error;}
    let calls = 0;
    const deadline = Date.now() + 30000;
    const signal=AbortSignal.timeout(30000);
    const claimCall=()=>{if(signal.aborted||Date.now()>=deadline)throw new TaskError("TIMEOUT","Router deadline exhausted");if(++calls>3)throw new TaskError("LIMIT","Router call budget exhausted");};
    const invoke = async (input: Parameters<SemanticCall>[0]) => {
      if(!call) throw new TaskError("UNAVAILABLE","Router service is unavailable");
      claimCall();
      if (Buffer.byteLength(canonical(input)) > 32768) throw new TaskError("LIMIT", "Router input budget");
      return decision.parse(await within(call(input, signal),signal));
    };
    try {
      const explicit = request.routeQuestionId ? this.question(request.conversationId,request.routeQuestionId) : undefined;
      const unanswered = this.unresolved(request.conversationId);
      const candidate = explicit ?? (unanswered.length === 1 ? unanswered[0] : undefined);
      if (request.routeQuestionId && !explicit) return this.wait(value, "这个分流问题已变化或不属于当前窗口，请查看最新问题。", "uncertain");
      if (candidate && (!request.target || request.routeQuestionId) && !request.replyTo && !request.quote) {
        const parent = this.get(candidate.commandId);
        if (!parent || parent.answers.length >= 8) return this.wait(value, "这项澄清已达到有界上下文上限，请明确选择话题；原请求仍保留。", "budget");
        const relation = request.routeQuestionId ? { kind: "answer" as const } : await invoke({ stage: "association", text: request.text, original: parent.request.text, question: parent.question });
        if (relation.kind === "answer") {
          if (request.uploads?.length) return this.wait(value, "澄清回答不能合并新的附件到原请求。请只回答此问题，或明确作为新请求发送。", "uncertain");
          const expectedParent=canonical(parent);
          parent.answers.push({ commandId: request.commandId, text: request.text, at: value.createdAt });
          value.parent = parent.commandId; this.save(value);
          const contexts = await within(Promise.all((request.target ? [request.target] : parent.candidates).map(scope => this.cards.context({ topic: { conversationId: request.conversationId, scope }, throughSeq: parent.latest.throughSeq, maintain: false }))),signal);
          const resolved = request.target ? {kind:"route" as const,target:request.target} : await invoke({ stage: "answer", text: request.text, original: parent.request.text, question: parent.question, candidates: contexts.map(item => item.card) });
          if (resolved.kind === "route" && contexts.some(item => same(item.card.topic.scope, resolved.target))) {
            parent.delivery = this.delivery(parent, resolved.target);
            if(parent.delivery.text.length+parent.answers.reduce((n,item)=>n+item.text.length,0)>16000) return this.wait(value,"原请求与澄清合计超过消息上限，请保留原请求并重新整理；不会截掉正文。","budget"); parent.binding = contexts.find(item => same(item.card.topic.scope, resolved.target))?.card.binding ?? null;
            parent.phase = "resolved"; if(!this.commitParent(parent,expectedParent)) return this.wait(value,"原分流问题已被另一条回答更新，请查看最新状态；本回答未另行投递。","uncertain"); value.phase = "resolved"; value.delivery = parent.delivery; value.binding = parent.binding; this.save(value); return value;
          }
          parent.phase="clarifying";parent.question=resolved.kind === "clarification" || resolved.kind === "new-work" ? resolved.question : "仍无法确认收件话题，请选择一个候选或说明这是新请求。";parent.reason="uncertain";
          if(!this.commitParent(parent,expectedParent)) return this.wait(value,"原分流问题已更新，请查看最新状态；本回答未另行投递。","uncertain");
          value.phase = "resolved"; this.save(value); return value;
        }
      }
      const context = await within(this.cards.context({ topic: { conversationId: request.conversationId, scope: latest.scope }, throughSeq: latest.throughSeq, maintain: true, requestBudget:{signal,claimCall} }),signal);
      if (Buffer.byteLength(canonical(context)) > 10240) return this.wait(value, "最新话题资料超过路由预算，无法完整核对。请明确选择话题；原文未被截断。", "budget", [latest.scope]);
      const initial = await invoke({ stage: "latest", text: request.text, context });
      if (initial.kind === "route" && same(initial.target, latest.scope)) {
        if(latest.scope.kind==="workbench"&&!context.originals.length&&!context.card.facts.length) return this.wait(value,"这是尚未归属的话题，要明确交给管家工作区承接吗？","new-work",[{kind:"workbench"}]);
        value.phase = "resolved"; value.binding = context.card.binding; value.delivery = this.delivery(value, initial.target); this.save(value); return value;
      }
      if (initial.kind === "new-work") return this.wait(value, initial.question, "new-work", [{ kind: "workbench" }]);
      if(initial.kind==="clarification") return this.wait(value,initial.question,"uncertain",[latest.scope]);
      if(initial.kind!=="search") return this.wait(value,"分流结果未给出可靠收件人，请明确选择话题；原请求保持完整。","invalid-output",[latest.scope]);
      const queries = initial.queries;
      const candidates = await within(this.cards.candidates({ conversationId: request.conversationId, queries, exclude: latest.scope, limit: 4 }),signal);
      const small = candidates.map(card => ({ ...card, facts: card.facts.filter(item => item.state === "active"), sources: [] }));
      if (Buffer.byteLength(canonical(small)) > 8192) return this.wait(value, "候选话题资料超过路由预算，请明确选择话题。原请求完整保留。", "budget", candidates.map(item => item.topic.scope));
      if (!candidates.length) return this.wait(value, "尚无可靠话题匹配。要把这项新工作交给管家工作区吗？也可明确选择现有话题。", "new-work", [{ kind: "workbench" }]);
      const result = await invoke({ stage: "candidates", text: request.text, candidates: small });
      if (result.kind === "route" && candidates.some(item => same(item.topic.scope, result.target))) {
        value.phase = "resolved"; value.binding = candidates.find(item => same(item.topic.scope, result.target))?.binding ?? null; value.delivery = this.delivery(value, result.target); this.save(value); return value;
      }
      return this.wait(value, result.kind === "clarification" || result.kind === "new-work" ? result.question : "这些话题仍有歧义，请说明要交给哪一个。", "uncertain", candidates.map(item => item.topic.scope));
    } catch (error) {
      const reason = error instanceof TaskError && error.code === "LIMIT" ? "budget" : error instanceof TaskError && error.code === "TIMEOUT" ? "timeout" : error instanceof z.ZodError || error instanceof SyntaxError ? "invalid-output" : "unavailable";
      return this.wait(value, "自动分流未能可靠完成，原请求完整保留在分流层。请选择话题或回答澄清；没有投递项目或管家工作区。", reason);
    }
  }
  private delivery(value: RouterRecord, target: StewardScope): StewardSend {
    const { routingMode: _mode, contextAnchor: _anchor, latestTopic: _latest, routeQuestionId: _question, ...original } = value.request;
    return { ...original, target };
  }
}
