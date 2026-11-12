import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import { stewardBinding, stewardScope, stewardSend, type StewardSend, type StewardScope } from "./steward-contracts.js";
import {stewardPermission} from "./steward-turn-permission.js";
import { topicReference, topicSource, type TopicCardsPort, type TopicContext, type TopicOriginal } from "./steward-topic-types.js";
import { refineTopicEvidence } from "./steward-evidence.js";
import type { TriageTrace } from "./steward-routing.js";
import { assertRoutingBudget, compactRoutingCandidates, localRoutingQueries } from "./steward-routing-budget.js";
import { topicActiveAt } from "./steward-topic-activity.js";

const frozen = z.strictObject({ scope: stewardScope, latestMessageId: z.string().nullable(), throughSeq: z.number().int().nonnegative() });
const answer = z.strictObject({ commandId: z.string(), text: z.string(), at: z.string() });
const routeRecipient = z.strictObject({id:z.string().min(1).max(200),token:z.string().min(1).max(500)});
const routeOption = z.strictObject({ id: z.string(), label: z.string(), target: stewardScope, recipient:routeRecipient.optional(), action: z.literal("create-topic").optional() });
const traceEntry = z.strictObject({ tier: z.enum(["program", "jev", "fallback"]), stage: z.string(), startedAt: z.string(), durationMs: z.number().nonnegative(),
  outcome: z.enum(["accepted", "abstained", "failed"]), modelCall:z.boolean().optional(), provider: z.string().optional(), model: z.string().optional() });
const progress = z.strictObject({ scope: stewardScope, independentText: z.string().min(1).max(8000), dependentText: z.string().min(1).max(8000), messageId: z.string().optional() });
const continuationEvidence = z.strictObject({topic:topicReference,originals:z.array(z.strictObject({source:topicSource.options[0],role:z.enum(["user","assistant","notification"]),text:z.string(),replyTo:z.string().optional()})).max(16)});
const continuation = z.strictObject({ originalCommandId: z.string(), originalMessageId: z.string(), evidence: continuationEvidence.optional() });
const record = z.strictObject({ commandId: z.string(), conversationId: z.string(), request: stewardSend, digest: z.string(), createdAt: z.string(), latest: frozen,
  phase: z.enum(["routing", "clarifying", "resolved"]), questionId: z.string(), question: z.string(), reason: z.enum(["uncertain", "new-work", "timeout", "unavailable", "invalid-output", "budget"]).nullable(),
  progress: progress.optional(), continuation: continuation.optional(),
  options: z.array(routeOption).max(4).optional(), trace: z.array(traceEntry).max(16).optional(), clarifiedAt: z.string().optional(), resolvedAt: z.string().optional(),
  permission:stewardPermission.nullable().default(null), candidates: z.array(stewardScope).max(4), answers: z.array(answer).max(8), binding: stewardBinding.nullable(), delivery: stewardSend.nullable(), parent: z.string().nullable() });
export type RouterRecord = z.infer<typeof record>;
export type RouterView = Omit<RouterRecord, "request" | "digest" | "delivery" | "options"> & { options: z.infer<typeof routeOption>[]; text: string; original: StewardSend; uploadCount: number; executorAdmitted: boolean; pendingDependency: boolean };
export type SemanticCall = (input: { stage: "latest" | "candidates" | "answer" | "association" | "recipient"; text: string; original?: string; question?: string; context?: TopicContext; candidates?: unknown[]; recipients?: {id:string;role:string;responsibility:string;artifacts:string[];scopeLabel:string}[]; actions?: ("create-topic"|"continue-dependent")[] }, signal?: AbortSignal, trace?: (value: TriageTrace) => void) => Promise<unknown>;
const decision = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("route"), target: stewardScope }),
  z.strictObject({ kind: z.literal("candidate"), id: z.string().regex(/^topic_(?:[0-9]|[12][0-9]|3[01])$/) }),
  z.strictObject({ kind: z.literal("create-topic") }),
  z.strictObject({ kind: z.literal("independent") }),
  z.strictObject({ kind: z.literal("continue-dependent") }),
  z.strictObject({ kind: z.literal("independent-part"), independentText: z.string().min(1).max(8000), dependentText: z.string().min(1).max(8000), question: z.string().min(1).max(500), candidateIds: z.array(z.string().regex(/^topic_(?:[0-9]|[12][0-9]|3[01])$/)).max(4).optional() }),
  z.strictObject({ kind: z.literal("inspect"), candidateIds: z.array(z.string().regex(/^topic_(?:[0-9]|[12][0-9]|3[01])$/)).min(1).max(2).refine(ids => new Set(ids).size === ids.length, "Duplicate inspection ID") }),
  z.strictObject({ kind: z.literal("search"), queries: z.array(z.string().trim().min(1).max(100)).min(1).max(3) }),
  z.strictObject({ kind: z.literal("clarification"), question: z.string().trim().min(1).max(500), targets: z.array(stewardScope).max(4).optional(), candidateIds: z.array(z.string().regex(/^topic_(?:[0-9]|[12][0-9]|3[01])$/)).max(4).refine(ids => new Set(ids).size === ids.length, "Duplicate routing candidate ID").optional() }),
  z.strictObject({ kind: z.literal("new-work"), question: z.string().trim().min(1).max(500) }),
  z.strictObject({ kind: z.literal("answer") }), z.strictObject({ kind: z.literal("new-request") }),
]);
const same = (a: StewardScope, b: StewardScope) => canonical(a) === canonical(b);
const digest = (request: StewardSend) => createHash("sha256").update(canonical(request)).digest("hex");

const newTopicOption: z.infer<typeof routeOption> = { id: "new-topic", label: "新开普通话题", target: { kind: "workbench" }, action: "create-topic" };
function optionsFor(scopes: StewardScope[], titles = new Map<string, string>()): z.infer<typeof routeOption>[] {
  return scopes.filter((scope, index) => scopes.findIndex(other => same(scope, other)) === index).map(target => ({
    id: createHash("sha256").update(canonical(target)).digest("hex").slice(0, 16),
    label: target.kind === "personal" ? "继续历史话题「闲聊」" : target.kind === "workbench" ? `在${titles.get(canonical(target)) ?? "历史话题"}中继续` : `在${titles.get(canonical(target)) ?? "候选项目"}中继续`,
    target,
  }));
}
function semanticOptions(scopes: StewardScope[], titles = new Map<string,string>()): z.infer<typeof routeOption>[] {
  return optionsFor(scopes,titles);
}
function visibleOptions(value: RouterRecord): z.infer<typeof routeOption>[] {
  if (value.options !== undefined) return value.options.map(option =>
    !option.action && option.target.kind === "workbench" && !option.target.topicId && option.label === "作为独立工作处理" ? newTopicOption : option);
  const legacyPersonalOrWorkbenchQuestion = value.reason === "uncertain" && value.candidates.length === 1 && value.candidates[0]?.kind === "personal"
    && value.question.includes("个人话题「闲聊」中继续，还是作为一项新的独立工作处理");
  return legacyPersonalOrWorkbenchQuestion ? [...optionsFor([{kind:"personal"}]),newTopicOption] : value.reason === "new-work" ? [newTopicOption] : optionsFor(value.reason === "uncertain" ? [] : value.candidates);
}
function clarificationChoices(targets: StewardScope[] | undefined, allowed: StewardScope[]): StewardScope[] {
  const choices = targets ?? [];
  const offered = allowed;
  if (choices.some(target => !offered.some(scope => same(scope, target)))) {
    throw new TaskError("INVALID", "Router clarification named an unavailable topic");
  }
  return choices;
}

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
  private save(value: RouterRecord) { if(value.phase==="resolved")value.resolvedAt??=new Date().toISOString(); this.db.prepare("INSERT INTO steward_router VALUES(?,?,?) ON CONFLICT(command) DO UPDATE SET data=excluded.data").run(value.commandId, value.conversationId, canonical(record.parse(value))); }
  get(commandId: string): RouterRecord | null { const row = this.db.prepare("SELECT data FROM steward_router WHERE command=?").get(commandId); return row ? record.parse(JSON.parse(String(row.data))) : null; }
  list(conversationId: string): RouterView[] {
    return this.db.prepare("SELECT data FROM steward_router WHERE conversation=? ORDER BY CASE WHEN json_extract(data,'$.phase')='clarifying' THEN 0 ELSE 1 END,rowid DESC LIMIT 40").all(conversationId).reverse().map(row => {
      const value = record.parse(JSON.parse(String(row.data))); const { request, digest: _digest, delivery: _delivery, ...rest } = value;
      return { ...rest, options: visibleOptions(value), text: request.text, original:request, uploadCount: request.uploads?.length ?? 0, executorAdmitted: !!this.db.prepare("SELECT 1 FROM steward_commands WHERE id=?").get(value.commandId), pendingDependency: !!value.progress && value.phase === "clarifying" };
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
  private createIndependent(value: RouterRecord, create: (parent: RouterRecord) => StewardScope, expected?: string, stage = "explicit-new-topic", part?: { independentText: string; dependentText: string; question: string; scopes: StewardScope[] }): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (expected && this.db.prepare("SELECT data FROM steward_router WHERE command=?").get(value.commandId)?.data !== expected) {
        this.db.exec("COMMIT"); return false;
      }
      const started = Date.now(), target = create(value);
      if (target.kind !== "workbench" || !target.topicId) throw new TaskError("INVALID", "A new topic requires its own identity");
      const entry: z.infer<typeof traceEntry> = {tier:"program",stage,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,outcome:"accepted"};
      value.trace = [...value.trace ?? [], entry].slice(-16);
      value.phase = "resolved"; value.resolvedAt = new Date().toISOString(); value.delivery = this.delivery(value,target); value.binding = null;
      if (part) {
        value.progress = {scope:target,independentText:part.independentText,dependentText:part.dependentText};
        value.phase="clarifying";delete value.resolvedAt;value.question=part.question;value.reason="uncertain";value.clarifiedAt??=new Date().toISOString();
        value.candidates=part.scopes;value.options=optionsFor(part.scopes);
      }
      if (expected) {
        if (!this.commitParent(value,expected)) throw new TaskError("CONFLICT", "The original question changed during topic creation");
      } else this.save(value);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  deferRecipients(commandId:string,input:{question:string;options:{label:string;target:StewardScope;recipient:z.infer<typeof routeRecipient>}[]}):RouterRecord {
    const value=this.get(commandId);
    if(!value || value.phase!=="resolved" || value.progress || this.db.prepare("SELECT 1 FROM steward_commands WHERE id=?").get(commandId))
      throw new TaskError("CONFLICT","Recipient clarification requires an unadmitted resolved original");
    const expected=canonical(value);
    const options=z.array(routeOption).min(1).max(4).parse(input.options.map((option,index)=>({...option,id:`recipient-${index}`})));
    value.phase="clarifying";value.question=z.string().min(1).max(500).parse(input.question);value.reason="uncertain";value.candidates=options.map(option=>option.target);value.options=options;value.delivery=null;delete value.resolvedAt;
    if(!this.commitParent(value,expected))throw new TaskError("CONFLICT","The original request changed before recipient clarification");
    return value;
  }
  ackProgress(commandId: string, messageId: string): void {
    const value=this.get(commandId);
    if(!value?.progress) throw new TaskError("CONFLICT","The original request has no independent progress");
    if(value.progress.messageId && value.progress.messageId!==messageId) throw new TaskError("CONFLICT","Independent progress is already bound to another message");
    if(value.progress.messageId===messageId)return;
    const expected=canonical(value);value.progress.messageId=messageId;
    if(!this.commitParent(value,expected) && this.get(commandId)?.progress?.messageId!==messageId)
      throw new TaskError("CONFLICT","The original progress changed before admission acknowledgment");
  }
  reopenDependency(originalCommandId:string,answerCommandId:string,question:string):boolean {
    const prompt=z.string().min(1).max(500).parse(question);
    this.db.exec("BEGIN IMMEDIATE");try {
      const parent=this.get(originalCommandId),child=this.get(answerCommandId);
      if(!parent?.progress?.messageId || child?.parent!==originalCommandId || child.continuation?.originalCommandId!==originalCommandId
        || child.continuation.originalMessageId!==parent.progress.messageId || parent.answers.at(-1)?.commandId!==answerCommandId
        || this.db.prepare("SELECT 1 FROM steward_commands WHERE id=?").get(answerCommandId)) {this.db.exec("COMMIT");return false;}
      if(parent.phase==="clarifying" && child.phase==="clarifying" && !child.delivery){this.db.exec("COMMIT");return true;}
      if(parent.phase!=="resolved" || child.delivery?.commandId!==answerCommandId){this.db.exec("COMMIT");return false;}
      const expected=canonical(parent);parent.phase="clarifying";parent.question=prompt;parent.reason="uncertain";delete parent.resolvedAt;
      child.phase="clarifying";child.question=prompt;child.reason="uncertain";child.delivery=null;delete child.resolvedAt;
      if(!this.commitParent(parent,expected)){this.db.exec("COMMIT");return false;}this.save(child);this.db.exec("COMMIT");return true;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  private continueDependent(parent:RouterRecord,value:RouterRecord,expected:string,evidence?:{topic:z.infer<typeof topicReference>;originals:TopicOriginal[]}):boolean {
    const progress=parent.progress;
    if(!progress?.messageId)throw new TaskError("CONFLICT","Independent work has not been admitted yet");
    const {uploads:_uploads,quote:_quote,replyTo:_reply,...frozen}=this.delivery(parent,progress.scope);
    value.delivery={...frozen,commandId:value.commandId,text:progress.dependentText,replyTo:progress.messageId};
    value.continuation={originalCommandId:parent.commandId,originalMessageId:progress.messageId,...(evidence?{evidence}:{})};value.binding=null;value.phase="resolved";
    parent.phase="resolved";parent.reason=null;parent.resolvedAt=new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");try{
      if(!this.commitParent(parent,expected)){this.db.exec("COMMIT");value.delivery=null;delete value.continuation;return false;}
      this.save(value);this.db.exec("COMMIT");return true;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  private wait(value: RouterRecord, question: string, reason: RouterRecord["reason"], candidates = value.candidates, options = optionsFor(candidates)) {
    value.phase = "clarifying"; value.delivery=null; value.clarifiedAt ??= new Date().toISOString(); value.question = question; value.reason = reason; value.candidates = candidates; value.options = options; this.save(value); return value;
  }
  async prepare(request: StewardSend, latest: z.infer<typeof frozen>, call?: SemanticCall, retain?:()=>void, permission?:z.infer<typeof stewardPermission>, options: { createTopic?: (parent: RouterRecord) => StewardScope; activeDays?: number } = {}): Promise<RouterRecord> {
    const prior = this.get(request.commandId);
    if (prior) { if (prior.digest !== digest(request)) throw new TaskError("CONFLICT", "Router retry changed the original request"); if(prior.phase==="routing") return this.wait(prior,"上次分流在确认前中断，原请求仍完整保留。请明确选择收件话题。","unavailable"); return prior; }
    const value: RouterRecord = { commandId: request.commandId, conversationId: request.conversationId, request, digest: digest(request), createdAt: new Date().toISOString(), latest,
      options: [], permission:permission??null, phase: "routing", questionId: randomUUID(), question: "", reason: null, candidates: [], answers: [], binding: null, delivery: null, parent: null };
    // Commit before any auxiliary model call. A crash leaves an explicit, recoverable router receipt.
    if(!request.routeCreateTopic && (!request.routeQuestionId || !this.question(request.conversationId,request.routeQuestionId)) && Number(this.db.prepare("SELECT COUNT(*) n FROM steward_router WHERE conversation=? AND json_extract(data,'$.phase')!='resolved' AND json_extract(data,'$.parent') IS NULL").get(request.conversationId)?.n??0)>=20) throw new TaskError("LIMIT","有20条分流请求尚未确认，请先处理已保存的问题。");
    this.db.exec("BEGIN IMMEDIATE");try{retain?.();this.save(value);this.db.exec("COMMIT");}catch(error){this.db.exec("ROLLBACK");throw error;}
    let calls = 0;
    const deadline = Date.now() + 30000;
    const signal=AbortSignal.timeout(30000);
    const claimCall=()=>{if(signal.aborted||Date.now()>=deadline)throw new TaskError("TIMEOUT","Router deadline exhausted");if(++calls>3)throw new TaskError("LIMIT","Router call budget exhausted");};
    const invoke = async (input: Parameters<SemanticCall>[0]) => {
      if(!call) throw new TaskError("UNAVAILABLE","Router service is unavailable");
      claimCall();
      assertRoutingBudget(input);
      const result = decision.parse(await within(call(input, signal, entry => { value.trace = [...value.trace ?? [], entry].slice(-16); this.save(value); }),signal));
      if (result.kind === "clarification" && (input.stage === "candidates" ? result.targets !== undefined : result.candidateIds !== undefined))
        throw new TaskError("INVALID", "Clarification used the wrong stage's recipient format");
      if ((result.kind === "independent" || result.kind === "independent-part") && (input.stage === "answer" || !request.text.trim() || request.routeQuestionId || request.replyTo))
        throw new TaskError("INVALID", "This input cannot independently start a new request");
      return result;
    };
    const independentPart = (part: Extract<z.infer<typeof decision>,{kind:"independent-part"}>,scopes:StewardScope[] = []) => {
      const first=request.text.indexOf(part.independentText),second=request.text.indexOf(part.dependentText);
      const spans=[{start:first,end:first+part.independentText.length},{start:second,end:second+part.dependentText.length}].sort((a,b)=>a.start-b.start);
      const separators=/^[\s，,。.;；:：!?！？、]*$/u;
      const clauseGap=request.text.slice(spans[0]!.end,spans[1]!.start);
      const readOnlyClause=/^(?:(?:请|先|帮我|请先|please)\s*)?(?:比较|对比|列出|说明|介绍|总结|解释|compare\b|list\b|explain\b|summari[sz]e\b)/iu.test(part.independentText.trim());
      const constrained=/(?:不要|别|不得|不能|不准|未授权|禁止|先不|暂不|除非|只有|等[^，,。;；]{0,80}(?:再|后)|\b(?:if|unless|until|before|not|never|don.t)\b)/iu.test(request.text);
      if(first<0 || second<0 || first>=second || !part.independentText.trim() || !part.dependentText.trim() || spans[0]!.end>spans[1]!.start
        || !separators.test(request.text.slice(0,spans[0]!.start)) || !separators.test(clauseGap) || !/[，,。.;；:：!?！？]/u.test(clauseGap) || !separators.test(request.text.slice(spans[1]!.end)) || !readOnlyClause || constrained)
        throw new TaskError("INVALID","Independent work must preserve complete original clauses and all constraints; otherwise keep the request waiting");
      if(!options.createTopic)throw new TaskError("UNAVAILABLE","Independent topic creation is unavailable");
      this.createIndependent(value,options.createTopic,undefined,"independent-readonly-part",{...part,scopes});
      return value;
    };
    const createIndependentRequest = () => {
      if (!options.createTopic) throw new TaskError("UNAVAILABLE", "Independent topic creation is unavailable");
      this.createIndependent(value,options.createTopic,undefined,"self-contained-new-topic");return value;
    };
    const selectCandidates = async (shortlist:Awaited<ReturnType<TopicCardsPort["candidates"]>>,independentProposed=false):Promise<RouterRecord> => {
      const contexts = shortlist.items, candidates = contexts.map(item => item.card);
      const titles = new Map(candidates.map(item => [canonical(item.topic.scope), item.title]));
      const visible = candidates.slice(0, 3).map(item => item.topic.scope);
      if (!shortlist.complete) return this.wait(value,"相关话题过多，本次未投递。可以确认下列具体话题；其余话题请先在发送菜单明确选择，再重新发送原请求。原请求仍完整保留。","uncertain",visible,
        [...optionsFor(visible,titles),newTopicOption]);
      if (!candidates.length && independentProposed) return createIndependentRequest();
      if (!candidates.length) return this.wait(value, "没有找到可靠匹配的话题。要新开普通话题吗？也可以自己说明。", "uncertain", [], [newTopicOption]);
      value.candidates = visible; value.options = optionsFor(visible,titles); this.save(value);
      let small = compactRoutingCandidates(contexts);
      let result = await invoke({ stage: "candidates", text: request.text, candidates: small });
      if(result.kind==="inspect") {
        const indices=result.candidateIds.map(id=>{const index=small.findIndex(item=>item.id===id);if(index<0)throw new TaskError("INVALID","Inspection named an unavailable candidate");return index;});
        for(const index of indices) {
          const selected=contexts[index]!;
          const read=await within(refineTopicEvidence({topic:selected.card.topic,throughSeq:latest.throughSeq,query:request.text.slice(0,500),signal},this.cards),signal);
          if(read.kind!=="evidence") {
            const scopes=read.kind==="forbidden"?[]:indices.map(item=>candidates[item]!.topic.scope);
            return this.wait(value,"相关依据仍不足，请明确这一步所依据的话题或原文；其它独立请求不受影响。","uncertain",scopes,optionsFor(scopes,titles));
          }
          contexts[index]=read.context;
          small[index]={...compactRoutingCandidates([read.context],8192)[0]!,id:small[index]!.id};
        }
        result=await invoke({stage:"candidates",text:request.text,candidates:small});
      }
      if (result.kind === "independent" && small.every(item=>item.complete && item.freshness==="current")) return createIndependentRequest();
      if (result.kind === "independent-part") {
        const scopes=(result.candidateIds??[]).map(id=>{const index=small.findIndex(item=>item.id===id);if(index<0)throw new TaskError("INVALID","Independent work named an unavailable dependency");return candidates[index]!.topic.scope;});
        return independentPart(result,scopes);
      }
      const index = result.kind === "candidate" ? small.findIndex(item => item.id === result.id) : -1;
      const selected = candidates[index], preview = small[index];
      if (selected && preview?.complete && preview.freshness === "current") {
        const target = selected.topic.scope;
        const at = this.cards.activity ? await within(this.cards.activity({conversationId:request.conversationId,scope:target},latest.throughSeq),signal) : undefined;
        if(target.kind==="personal" || target.kind==="workbench"&&!target.topicId || at !== undefined && !topicActiveAt(at,value.createdAt,options.activeDays ?? 30))
          return this.wait(value,"找到可能相关的历史话题，请先确认是否继续；也可以新开普通话题。","uncertain",[target],[...optionsFor([target],titles),newTopicOption]);
        value.phase = "resolved"; value.binding = selected.binding; value.delivery = this.delivery(value,target); this.save(value); return value;
      }
      if (result.kind === "new-work") return this.wait(value, "要新开普通话题继续这条请求吗？也可以自己说明。", "new-work", [], [newTopicOption]);
      const choices = result.kind === "clarification" ? (result.candidateIds ?? []).map(id => {
        const position = small.findIndex(item => item.id === id);
        if (position < 0) throw new TaskError("INVALID", "Clarification named an unavailable candidate ID");
        return candidates[position]!.topic.scope;
      }) : [];
      return this.wait(value, choices.length ? "这条原请求想在哪个话题继续？请选择下列去向，也可以自己说明。" : result.kind === "clarification" ? result.question : "这些话题仍有歧义或资料不完整，请说明要交给哪一个。", "uncertain", choices.slice(0,4), semanticOptions(choices.slice(0,4), titles));
    };
    const independent = async () => {
      const queries=localRoutingQueries(request.text);
      if(!queries)return this.wait(value,"请求本身可以独立讨论，但相关话题检索超过本次词数预算。请明确选择或新开普通话题；原文完整保留。","budget",[],[newTopicOption]);
      const shortlist=await within(this.cards.candidates({conversationId:request.conversationId,queries,exclude:latest.scope,throughSeq:latest.throughSeq,limit:32}),signal);
      return selectCandidates(shortlist,true);
    };
    try {
      if (request.routeCreateTopic && !request.routeQuestionId) {
        if (!options.createTopic) throw new TaskError("UNAVAILABLE", "Independent topic creation is unavailable");
        this.createIndependent(value,options.createTopic); return value;
      }
      let matched: Awaited<ReturnType<NonNullable<TopicCardsPort["deterministic"]>>> = {matches:[],complete:true};
      if (!request.routeQuestionId) {
      const started = Date.now(), startedAt = new Date(started).toISOString();
      matched = this.cards.deterministic ? await within(this.cards.deterministic({ conversationId: request.conversationId, text: request.text, throughSeq: latest.throughSeq }),signal) : { matches: [], complete: true };
      value.trace = [...value.trace ?? [], { tier: "program", stage: "exact-match", startedAt, durationMs: Date.now()-started, outcome: matched.matches.length ? "accepted" : "abstained" }]; this.save(value);
      if (!matched.complete || matched.matches.length > 1 || matched.matches.some(item => !topicActiveAt(item.lastActiveAt,value.createdAt,options.activeDays ?? 30))) {
        const titles = new Map(matched.matches.map(item => [canonical(item.card.topic.scope), `${item.card.title}（上次活动 ${item.lastActiveAt ?? "时间未知"}）`]));
        const scopes = matched.matches.map(item => item.card.topic.scope);
        return this.wait(value,"找到较早或同名的相关记录。请明确选择要继续的具体话题，或新开普通话题；也可以说明这次与旧记录无关。","uncertain",scopes,
          [...optionsFor(scopes.slice(0,3),titles),newTopicOption]);
      }
      const direct = matched.directed && matched.matches.length === 1 ? matched.matches[0] : undefined;
      if (direct) {
        value.phase = "resolved"; value.binding = direct.card.binding; value.delivery = this.delivery(value,direct.card.topic.scope); this.save(value); return value;
      }
      }
      const explicit = request.routeQuestionId ? this.question(request.conversationId,request.routeQuestionId) : undefined;
      const unanswered = this.unresolved(request.conversationId);
      const candidate = explicit ?? (unanswered.length === 1 ? unanswered[0] : undefined);
      if (request.routeQuestionId && !explicit) return this.wait(value, "这个分流问题已变化或不属于当前窗口，请查看最新问题。", "uncertain");
      if (candidate && (!request.target || request.routeQuestionId) && !request.replyTo && !request.quote) {
        const parent = this.get(candidate.commandId);
        if (!parent) return this.wait(value,"这项原问题已变化，请查看最新状态。","uncertain");
        const relation = request.routeQuestionId ? { kind: "answer" as const } : await invoke({ stage: "association", text: request.text, original: parent.request.text, question: parent.question });
        if (relation.kind === "independent") return await independent();
        if (relation.kind === "independent-part") return independentPart(relation);
        if (relation.kind === "answer") {
          if(parent.answers.length>=8)return this.wait(value,"这项澄清已达到有界上下文上限，请明确选择话题；原请求仍保留。","budget");
          if (request.uploads?.length) return this.wait(value, "澄清回答不能合并新的附件到原请求。请只回答此问题，或明确作为新请求发送。", "uncertain");
          if(visibleOptions(parent).some(option=>option.recipient) && (!request.target || !request.recipient))
            return this.wait(value,"请从原问题选择具体承接会话；不会仅凭相同话题猜测执行对象。","uncertain",[],[]);
          if (request.routeCreateTopic && parent.progress)
            return this.wait(value,"独立部分已接收，原问题只续接尚待确认的步骤。要另开话题，请作为新的独立请求发送。","uncertain",[],[]);
          if (request.routeCreateTopic && (!options.createTopic || !visibleOptions(parent).some(option => option.action === "create-topic")))
            return this.wait(value, "原问题未提供新建话题选项，请查看最新问题。", "uncertain", [], []);
          if (request.target && !visibleOptions(parent).some(option => same(option.target, request.target!) && JSON.stringify(option.recipient??null)===JSON.stringify(request.recipient??null) && (request.routeCreateTopic ? option.action === "create-topic" : !option.action))) {
            return this.wait(value, "这个选项不属于原分流问题，请查看原问题或另发一条明确指定话题的新请求。", "uncertain", [], []);
          }
          if(parent.progress && !parent.progress.messageId)return this.wait(value,"独立部分尚未确认接收，请稍后在原问题继续；不会重复发送。","uncertain",[],[]);
          const expectedParent=canonical(parent);
          parent.answers.push({ commandId: request.commandId, text: request.text, at: value.createdAt });
          value.parent = parent.commandId; this.save(value);
          if (request.routeCreateTopic && options.createTopic) {
            if (!this.createIndependent(parent,options.createTopic,expectedParent)) return this.wait(value,"原问题已更新，请查看最新状态。","uncertain");
            value.phase = "resolved"; value.delivery = parent.delivery; value.binding = null; this.save(value); return value;
          }
          const offeredOptions = visibleOptions(parent);
          const scopes = request.target ? [request.target] : [...parent.candidates, ...offeredOptions.filter(option=>!option.action).map(option=>option.target)]
            .filter(scope=>scope.kind!=="workbench" || !!scope.topicId)
            .filter((scope,index,all)=>all.findIndex(other=>same(scope,other))===index);
          const contexts = await within(Promise.all(scopes.map(scope => this.cards.context({ topic: { conversationId: request.conversationId, scope }, throughSeq: parent.latest.throughSeq, maintain: false }))),signal);
          const actions: ("create-topic"|"continue-dependent")[] = parent.progress ? ["continue-dependent"] : offeredOptions.some(option=>option.action==="create-topic") ? ["create-topic"] : [];
          const resolved = request.target ? {kind:"route" as const,target:request.target} : await invoke({ stage: "answer", text: request.text, original: parent.request.text, question: parent.question, candidates: contexts.map(item => item.card),actions });
          if(parent.progress && (resolved.kind==="continue-dependent" || resolved.kind==="route" && contexts.some(item=>same(item.card.topic.scope,resolved.target)))) {
            let evidence: {topic:z.infer<typeof topicReference>;originals:TopicOriginal[]}|undefined;
            if(resolved.kind==="route") {
              const topic={conversationId:parent.conversationId,scope:resolved.target};
              const read=await within(refineTopicEvidence({topic,throughSeq:latest.throughSeq,query:parent.progress.dependentText.slice(0,500),signal},this.cards),signal);
              if(read.kind!=="evidence") {
                parent.question="相关依据仍不足，请直接提供这一步所需的有效预算或原文；已完成的独立部分不会重做。";
                if(!this.commitParent(parent,expectedParent))return this.wait(value,"原问题已更新，请查看最新状态。","uncertain",[],[]);
                value.phase="resolved";this.save(value);return value;
              }
              evidence={topic,originals:read.context.originals};
            }
            if(!this.continueDependent(parent,value,expectedParent,evidence))return this.wait(value,"另一条回答已先续接此步骤；本回答未重复投递。","uncertain",[],[]);
            return value;
          }
          if (resolved.kind === "create-topic") {
            if (!actions.includes("create-topic") || !options.createTopic) throw new TaskError("INVALID", "This question did not authorize a new-topic action");
            if(parent.request.text.length+parent.answers.reduce((n,item)=>n+item.text.length,0)>16000) return this.wait(value,"原请求与澄清合计超过消息上限，请重新整理；原文不会被截断。","budget");
            if (!this.createIndependent(parent,options.createTopic,expectedParent)) return this.wait(value,"原问题已更新，请查看最新状态。","uncertain");
            value.phase="resolved";value.delivery=parent.delivery;value.binding=null;this.save(value);return value;
          }
          if (resolved.kind === "route" && contexts.some(item => same(item.card.topic.scope, resolved.target))) {
            parent.delivery = this.delivery(parent, resolved.target);
            const selectedRecipient=offeredOptions.find(option=>same(option.target,resolved.target) && JSON.stringify(option.recipient??null)===JSON.stringify(request.recipient??null))?.recipient;
            if(selectedRecipient)parent.delivery.recipient=selectedRecipient;
            if(parent.delivery.text.length+parent.answers.reduce((n,item)=>n+item.text.length,0)>16000) return this.wait(value,"原请求与澄清合计超过消息上限，请保留原请求并重新整理；不会截掉正文。","budget"); parent.binding = contexts.find(item => same(item.card.topic.scope, resolved.target))?.card.binding ?? null;
            parent.phase = "resolved"; parent.resolvedAt=new Date().toISOString(); if(!this.commitParent(parent,expectedParent)) return this.wait(value,"原分流问题已被另一条回答更新，请查看最新状态；本回答未另行投递。","uncertain"); value.phase = "resolved"; value.delivery = parent.delivery; value.binding = parent.binding; this.save(value); return value;
          }
          if (resolved.kind === "clarification") {
            const choices = clarificationChoices(resolved.targets, contexts.map(item => item.card.topic.scope));
            const titles = new Map(contexts.map(item => [canonical(item.card.topic.scope), item.card.title]));
            parent.options = [...semanticOptions(choices,titles).slice(0,actions.includes("create-topic")?3:4),...(actions.includes("create-topic")?[newTopicOption]:[])];
            parent.candidates = contexts.map(item => item.card.topic.scope);
          } else if (resolved.kind === "new-work") {
            parent.options = parent.progress ? [] : [newTopicOption];
            parent.candidates = [];
          }
          parent.phase="clarifying";parent.question=resolved.kind === "clarification" || resolved.kind === "new-work" ? resolved.question : "仍无法确认收件话题，请选择一个候选或说明这是新请求。";parent.reason="uncertain";
          if(!this.commitParent(parent,expectedParent)) return this.wait(value,"原分流问题已更新，请查看最新状态；本回答未另行投递。","uncertain");
          value.phase = "resolved"; this.save(value); return value;
        }
      }
      const currentScope = matched.matches[0]?.card.topic.scope ?? latest.scope;
      const context = await within(this.cards.context({ topic: { conversationId: request.conversationId, scope: currentScope }, throughSeq: latest.throughSeq, maintain: false }),signal);
      if (Buffer.byteLength(canonical(context)) > 10240) return this.wait(value, "最新话题资料超过路由预算，无法完整核对。请明确选择话题；原文未被截断。", "budget", [latest.scope]);
      value.candidates = [currentScope]; value.options = optionsFor([currentScope],new Map([[canonical(currentScope),context.card.title]])); this.save(value);
      const initial = await invoke({ stage: "latest", text: request.text, context });
      if (initial.kind === "independent") return await independent();
      if (initial.kind === "independent-part") return independentPart(initial);
      if (initial.kind === "route" && same(initial.target, currentScope)) {
        if(currentScope.kind==="workbench"&&!context.originals.length&&!context.card.facts.length) return this.wait(value,"这是尚未归属的话题，要新开普通话题继续吗？","new-work",[],[newTopicOption]);
        const at = this.cards.activity ? await within(this.cards.activity({conversationId:request.conversationId,scope:currentScope},latest.throughSeq),signal) : undefined;
        if(currentScope.kind==="personal" || currentScope.kind==="workbench"&&!currentScope.topicId || at !== undefined && !topicActiveAt(at,value.createdAt,options.activeDays ?? 30))
          return this.wait(value,"这条请求可能对应历史话题，请确认继续此话题，或新开普通话题。","uncertain",[currentScope],[...optionsFor([currentScope],new Map([[canonical(currentScope),context.card.title]])),newTopicOption]);
        value.phase = "resolved"; value.binding = context.card.binding; value.delivery = this.delivery(value, initial.target); this.save(value); return value;
      }
      if (initial.kind === "new-work") return this.wait(value, "要新开普通话题继续这条请求吗？也可以说明要继续的已有话题。", "new-work", [], [newTopicOption]);
      if(initial.kind==="clarification") {
        const choices = clarificationChoices(initial.targets, [currentScope]);
        return this.wait(value, choices.length ? "这条原请求想在哪个话题继续？请选择下列去向，也可以自己说明。" : initial.question, "uncertain", [currentScope], semanticOptions(choices, new Map([[canonical(currentScope), context.card.title]])));
      }
      if(initial.kind!=="search") return this.wait(value,"分流结果未给出可靠收件人，请明确选择话题；原请求保持完整。","invalid-output",[latest.scope]);
      const queries = initial.queries;
      const shortlist = await within(this.cards.candidates({ conversationId: request.conversationId, queries, exclude: currentScope, throughSeq: latest.throughSeq, limit: 32 }),signal);
      return await selectCandidates(shortlist);

    } catch (error) {
      const reason = error instanceof TaskError && error.code === "LIMIT" ? "budget" : error instanceof TaskError && error.code === "TIMEOUT" ? "timeout" : error instanceof z.ZodError || error instanceof SyntaxError ? "invalid-output" : "unavailable";
      return this.wait(value, "自动分流暂未可靠完成，原请求已保留。可以新开普通话题，或说明要继续的已有话题；尚未投递或启动任务。", reason, value.candidates,
        [...(value.options ?? optionsFor(value.candidates)).filter(option=>!option.action).slice(0,3),newTopicOption]);
    }
  }
  private delivery(value: RouterRecord, target: StewardScope): StewardSend {
    const { routingMode: _mode, contextAnchor: _anchor, latestTopic: _latest, routeQuestionId: _question, routeCreateTopic: _create, ...original } = value.request;
    return { ...original, target };
  }
}
