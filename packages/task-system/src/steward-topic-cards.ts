import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import { stewardBinding, stewardScope, type StewardScope } from "./steward-contracts.js";
import { topicCard, topicFact, topicListInput, topicReference, topicSource, topicSourceInput,
  type TopicCard, type TopicCardsPort, type TopicContext, type TopicFact, type TopicHostReads,
  type TopicListItem, type TopicOriginal, type TopicRef, type TopicSource, type TopicSourcePage } from "./steward-topic-types.js";

const CONTEXT_BYTES = 10 * 1024, BATCH_BYTES = 8 * 1024, CARD_BYTES = 24 * 1024;
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const size = (value: unknown) => Buffer.byteLength(canonical(value));
const sourceKey = (source: TopicSource) => canonical(source);
const scopeArgs = (scope: StewardScope) => [scope.kind, scope.kind === "project" ? scope.projectId : null];
const visible = "conversation=? AND json_extract(data,'$.scope.kind')=? AND json_extract(data,'$.scope.projectId') IS ?";
// A canonical message keeps its original text separate; sourced routing answers remain part of the same versioned evidence body.
const sourceText = "(json_extract(data,'$.text') || CASE WHEN json_type(data,'$.routingClarification')='object' THEN char(10)||char(10)||'[分流问题与用户澄清原文；不代替原始请求]'||char(10)||json_extract(data,'$.routingClarification') ELSE '' END)";
const listCursor = z.strictObject({ stage: z.enum(["local", "projects"]), page: z.number().int().nonnegative(), offset: z.number().int().nonnegative().max(12), query: z.string().max(200) });
const evidence = z.strictObject({ factId: z.string().min(1).max(200), source: topicSource, quote: z.string().min(1).max(1800) });
/** A compactor returns data, never routing authority. Each changed fact requires an exact
 * quote from this batch. Supersession additionally requires later, explicit user evidence. */
export const topicCompactionOutput = z.strictObject({ summary: z.string().max(300), facts: z.array(topicFact).max(32),
  evidence: z.array(evidence).max(64), supersessions: z.array(z.strictObject({ factId: z.string().min(1).max(200),
    replacementId: z.string().min(1).max(200), source: topicSource, quote: z.string().min(1).max(1800) })).max(32).default([]) });
const stored = z.strictObject({ schemaVersion: z.literal(1), card: topicCard, historyStamp: z.string(), failure: z.string().max(500).optional() });
const originalRow = z.strictObject({ id: z.string(), seq: z.number(), revision: z.number(), role: z.enum(["user", "assistant", "notification"]),
  scope: stewardScope, binding: stewardBinding, replyTo: z.string().nullable(), text: z.string(), totalBytes: z.number() });
type Authority = Awaited<ReturnType<TopicHostReads["authorize"]>>;
type Snapshot = z.infer<typeof stored>;

function utf8Prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  let end = Math.min(buffer.length, Math.max(0, bytes));
  while (end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
function terms(text: string): string[] {
  const output = new Set<string>();
  for (const word of text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    output.add(word);
    if (/\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      for (let index = 0; index + 1 < chars.length && output.size < 256; index++) output.add(chars.slice(index, index + 2).join(""));
    }
    if (output.size >= 256) break;
  }
  return [...output].slice(0, 256);
}
function version(input: Omit<TopicCard, "version"> & { version?: string }): TopicCard {
  const { version: _previousVersion, ...card } = input;
  return { ...card, version: digest(card) };
}
function sourcedSummary(facts: TopicFact[]): string {
  const active = facts.filter(fact => fact.state === "active");
  const fact = active.find(item => item.origin === "authoritative" && item.section === "goal") ?? active.find(item => item.section === "goal") ?? active[0];
  return fact ? utf8Prefix(`${fact.origin === "generated" ? "Generated: " : fact.origin === "extractive" ? "原文：" : ""}${fact.text}`, 280) : "原生对话记录，展开查看来源。";
}
function mark(card: TopicCard, freshness: TopicCard["freshness"], coverageReason: string): TopicCard {
  return version({ ...card, freshness, coverageReason });
}
function compactItem(card: TopicCard, lastDiscussion: TopicListItem["lastDiscussion"]): TopicListItem {
  return { topic: card.topic, version: card.version, title: card.title, summary: card.summary, freshness: card.freshness, lastDiscussion,
    ...(card.coverageReason ? { coverageReason: card.coverageReason } : {}) };
}

/** Derived cards over existing authorized canonical records; reading never creates a session. */
export class StewardTopicCards implements TopicCardsPort {
  private readonly db;
  private readonly jobs = new Map<string, Promise<void>>();
  constructor(ledger: Pick<TaskLedger, "managementDatabase">, private readonly host: TopicHostReads) {
    this.db = ledger.managementDatabase();
    this.db.exec(`CREATE INDEX IF NOT EXISTS steward_topic_discussion_latest ON steward_messages(conversation,json_extract(data,'$.scope.kind'),json_extract(data,'$.scope.projectId'),seq DESC) WHERE json_extract(data,'$.role') IN ('user','assistant')`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS steward_topic_cards(topic_key TEXT PRIMARY KEY,conversation TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS steward_topic_card_conversation ON steward_topic_cards(conversation,topic_key);
      CREATE TABLE IF NOT EXISTS steward_topic_terms(conversation TEXT NOT NULL,term TEXT NOT NULL,topic_key TEXT NOT NULL,PRIMARY KEY(conversation,term,topic_key));`);
  }

  async list(input: Parameters<TopicCardsPort["list"]>[0]) {
    const request = topicListInput.parse(input), query = request.query ?? "";
    let cursor = request.cursor ? listCursor.parse(JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")))
      : { stage: "local" as const, page: 0, offset: 0, query };
    if (cursor.query !== query) throw new TaskError("CONFLICT", "Topic query changed; restart pagination");
    const items: TopicListItem[] = [];
    let hasMore = true;
    for (let pass = 0; pass < 3 && items.length < request.limit && hasMore; pass++) {
      if (cursor.stage === "local") {
        const scopes: StewardScope[] = [{ kind: "personal" }, { kind: "workbench" }];
        while (cursor.offset < scopes.length && items.length < request.limit) {
          const scope = scopes[cursor.offset++];
          if (!scope || !this.db.prepare(`SELECT 1 FROM steward_messages WHERE ${visible} LIMIT 1`).get(request.conversationId, ...scopeArgs(scope))) continue;
          try {
            const authority = await this.host.authorize({ conversationId: request.conversationId, scope });
            if (query && !authority.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
            items.push(await this.overview({ conversationId: request.conversationId, scope }, authority));
          } catch (error) { if (!(error instanceof TaskError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND"))) throw error; }
        }
        if (cursor.offset < scopes.length) break;
        cursor = { stage: "projects", page: 0, offset: 0, query };
      } else {
        const page = await this.host.projects({ conversationId: request.conversationId, query, page: cursor.page, limit: 12 });
        while (cursor.offset < page.items.length && items.length < request.limit) {
          const project = page.items[cursor.offset++];
          if (!project) continue;
          const topic: TopicRef = { conversationId: request.conversationId, scope: { kind: "project", projectId: project.projectId } };
          try { items.push(await this.overview(topic, await this.host.authorize(topic))); }
          catch (error) { if (!(error instanceof TaskError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND"))) throw error; }
        }
        if (cursor.offset < page.items.length) break;
        hasMore = page.hasMore;
        cursor = { stage: "projects", page: cursor.page + 1, offset: 0, query };
      }
    }
    return { items, hasMore, nextCursor: hasMore ? Buffer.from(canonical(cursor)).toString("base64url") : null };
  }

  async context(input: Parameters<TopicCardsPort["context"]>[0]): Promise<TopicContext> {
    const topic = topicReference.parse(input.topic), throughSeq = z.number().int().nonnegative().parse(input.throughSeq);
    const authority = await this.host.authorize(topic), key = digest(topic);
    let snapshot = this.snapshot(topic, authority, throughSeq);
    const batch = this.batch(topic, snapshot.card.coverageSeq, throughSeq, false);
    const history = this.history(topic, throughSeq);
    // Complete small histories remain literal; a paid compactor is unnecessary.
    const literal = snapshot.card.coverageSeq === 0 && batch.complete;
    const oversizedGoal = Boolean(authority.project && authority.project.goal.length > 1800);
    if (input.maintain && !literal && batch.originals.length && this.host.compact) {
      const running = this.jobs.get(key);
      if (running) await running;
      else {
        const job = this.maintain(topic, authority, throughSeq, snapshot, batch.originals, input.requestBudget);
        this.jobs.set(key, job);
        try { await job; } finally { this.jobs.delete(key); }
      }
      snapshot = this.snapshot(topic, await this.host.authorize(topic), throughSeq);
    }
    let card = snapshot.card;
    const fresh = history.lastSeq <= card.coverageSeq || literal;
    if (snapshot.failure) card = mark(card, "insufficient", snapshot.failure);
    else if (!fresh) card = mark(card, card.coverageSeq ? "stale" : "insufficient", "尚有较早内容未整理；请结合所列原文与来源核对。");
    else if (literal && !oversizedGoal) {
      const quoted = batch.originals.find(original => original.role === "user" && original.text.trim());
      if (!card.facts.length && quoted) card = version({ ...card, summary: utf8Prefix(`原文：${quoted.text}`, 280), sources: [quoted.source] });
      // Cache the searchable projection, but do not claim summary coverage for literal text.
      // A later long-history compaction must still start with the earlier messages.
      this.save({ ...snapshot, card });
      card = version({ ...card, coverageSeq: history.lastSeq, observedThroughSeq: history.lastSeq, freshness: "current", coverageReason: undefined });
    }
    const raw = this.batch(topic, 0, throughSeq, !literal);
    const originals: TopicOriginal[] = [];
    let complete = fresh && !snapshot.failure && !oversizedGoal;
    for (const original of raw.originals) {
      if (size({ card, originals: [...originals, original], complete, byteLimit: CONTEXT_BYTES }) <= CONTEXT_BYTES) originals.push(original);
      else { complete = false; break; }
    }
    if (!raw.complete && literal) complete = false;
    if (size({ card, originals, complete, byteLimit: CONTEXT_BYTES }) > CONTEXT_BYTES) {
      card = this.routingCard(card, CONTEXT_BYTES - 500);
      originals.length = 0;
      complete = false;
    }
    if (!complete && card.freshness === "current") card = mark(card, "insufficient", "部分资料未纳入本次上下文，请展开来源或补充说明。");
    // Marking an omission also consumes bytes; never cross the serialized context boundary.
    while (originals.length && size({ card, originals, complete, byteLimit: CONTEXT_BYTES }) > CONTEXT_BYTES) originals.pop();
    return { card, originals, complete, byteLimit: CONTEXT_BYTES };
  }

  async candidates(input: Parameters<TopicCardsPort["candidates"]>[0]): Promise<TopicCard[]> {
    const conversationId = z.string().min(1).max(200).parse(input.conversationId), exclude = stewardScope.parse(input.exclude);
    const queries = z.array(z.string().trim().min(1).max(200)).max(3).parse(input.queries);
    const limit = z.number().int().min(1).max(4).parse(input.limit ?? 4), scopes: StewardScope[] = [];
    const tokens = [...new Set(queries.flatMap(terms))].slice(0, 24);
    if (tokens.length) {
      const rows = this.db.prepare(`SELECT c.scope,COUNT(*) AS rank FROM steward_topic_terms t JOIN steward_topic_cards c ON c.topic_key=t.topic_key
        WHERE t.conversation=? AND t.term IN (${tokens.map(() => "?").join(",")}) GROUP BY t.topic_key ORDER BY rank DESC,t.topic_key LIMIT 8`).all(conversationId, ...tokens);
      for (const row of rows) scopes.push(stewardScope.parse(JSON.parse(String(row.scope))));
    }
    // ProjectRuntime supplies authorized, SQL-prefiltered metadata pages, never histories.
    for (const query of queries) {
      const page = await this.host.projects({ conversationId, query, page: 0, limit: 4 });
      for (const project of page.items.slice(0, 4)) scopes.push({ kind: "project", projectId: project.projectId });
    }
    const seen = new Set([canonical(exclude)]), output: TopicCard[] = [];
    for (const scope of scopes) {
      const key = canonical(scope);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const topic = { conversationId, scope }, authority = await this.host.authorize(topic);
        const card = this.snapshot(topic, authority, Number.MAX_SAFE_INTEGER).card;
        const preview = this.routingCard(card, 2048);
        if (size([...output, preview]) > 8192) break;
        output.push(preview);
        if (output.length >= limit) break;
      } catch (error) { if (!(error instanceof TaskError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND"))) throw error; }
    }
    return output;
  }

  async source(input: Parameters<TopicCardsPort["source"]>[0]): Promise<TopicSourcePage> {
    const { conversationId, ref, offset } = topicSourceInput.parse(input);
    const topic: TopicRef = { conversationId, scope: ref.kind === "project" ? { kind: "project", projectId: ref.id } : ref.scope };
    const authority = await this.host.authorize(topic);
    let bytes: Uint8Array, totalBytes: number;
    if (ref.kind === "project") {
      if (authority.project?.id !== ref.id || authority.project.revision !== ref.revision) throw new TaskError("CONFLICT", "Project source changed; refresh the topic card");
      const content = Buffer.from(authority.project.goal);
      bytes = content.subarray(offset, offset + 2004); totalBytes = content.length;
    } else {
      const row = this.db.prepare(`SELECT seq,json_extract(data,'$.revision') AS revision,json_extract(data,'$.source') AS binding,
        substr(CAST(${sourceText} AS BLOB),?,2004) AS content,length(CAST(${sourceText} AS BLOB)) AS length
        FROM steward_messages WHERE id=? AND ${visible}`).get(offset + 1, ref.id, conversationId, ...scopeArgs(ref.scope));
      if (!row) throw new TaskError("FORBIDDEN", "Source is outside this conversation and topic");
      if (Number(row.seq) !== ref.seq || Number(row.revision ?? 0) !== ref.revision || canonical(JSON.parse(String(row.binding))) !== canonical(ref.binding))
        throw new TaskError("CONFLICT", "Message source changed; refresh the topic card");
      if (!(row.content instanceof Uint8Array)) throw new TaskError("INVALID", "Source is not UTF-8 text");
      bytes = row.content; totalBytes = Number(row.length);
    }
    if (offset > totalBytes) throw new TaskError("INVALID", "Offset is outside the source");
    if (((bytes[0] ?? 0) & 0xc0) === 0x80) throw new TaskError("INVALID", "Offset splits a UTF-8 character");
    let consumed = Math.min(2000, bytes.length);
    while (consumed < bytes.length && ((bytes[consumed] ?? 0) & 0xc0) === 0x80) consumed--;
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, consumed));
    return { ref, content, offset, totalBytes, nextOffset: offset + consumed < totalBytes ? offset + consumed : null, byteLimit: 2000, coordinate: "utf-8-bytes" };
  }

  private history(topic: TopicRef, throughSeq: number) {
    const row = this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(seq),0) AS lastSeq,COALESCE(SUM(COALESCE(json_extract(data,'$.revision'),0)),0) AS revisions
      FROM steward_messages WHERE ${visible} AND seq<=?`).get(topic.conversationId, ...scopeArgs(topic.scope), throughSeq);
    return { count: Number(row?.count ?? 0), lastSeq: Number(row?.lastSeq ?? 0), revisions: Number(row?.revisions ?? 0) };
  }
  private batch(topic: TopicRef, afterSeq: number, throughSeq: number, latest: boolean) {
    const rows = this.db.prepare(`SELECT id,seq,COALESCE(json_extract(data,'$.revision'),0) AS revision,json_extract(data,'$.role') AS role,
      json_extract(data,'$.scope') AS scope,json_extract(data,'$.source') AS binding,json_extract(data,'$.replyTo') AS replyTo,
      substr(CAST(${sourceText} AS BLOB),1,8196) AS text,length(CAST(${sourceText} AS BLOB)) AS totalBytes
      FROM steward_messages WHERE ${visible} AND seq>? AND seq<=? ORDER BY seq ${latest ? "DESC" : "ASC"} LIMIT 17`)
      .all(topic.conversationId, ...scopeArgs(topic.scope), afterSeq, throughSeq);
    const originals: TopicOriginal[] = [];
    let complete = rows.length <= 16;
    for (const row of rows.slice(0, 16)) {
      if (!(row.text instanceof Uint8Array)) throw new TaskError("INVALID", "Canonical source is not text");
      // SQL's prefix may end inside a Unicode character. Decode only a valid prefix.
      let end = Math.min(8192, row.text.length);
      while (end < row.text.length && ((row.text[end] ?? 0) & 0xc0) === 0x80) end--;
      const value = originalRow.parse({ ...row, scope: JSON.parse(String(row.scope)), binding: JSON.parse(String(row.binding)), text: Buffer.from(row.text.subarray(0, end)).toString("utf8") });
      const original: TopicOriginal = { source: { kind: "message", id: value.id, revision: value.revision, seq: value.seq, scope: value.scope, binding: value.binding },
        role: value.role, text: value.text, ...(value.replyTo ? { replyTo: value.replyTo } : {}) };
      if (value.totalBytes > Buffer.byteLength(value.text) || size([...originals, original]) > BATCH_BYTES) { complete = false; break; }
      originals.push(original);
    }
    if (latest) originals.reverse();
    return { originals, complete };
  }
  private snapshot(topic: TopicRef, authority: Authority, throughSeq: number): Snapshot {
    const row = this.db.prepare("SELECT data FROM steward_topic_cards WHERE topic_key=?").get(digest(topic));
    const parsed = row ? stored.safeParse(JSON.parse(String(row.data))) : null;
    const history = this.history(topic, throughSeq);
    if (parsed?.success && canonical(parsed.data.card.binding) === canonical(authority.binding) && parsed.data.card.coverageSeq <= throughSeq) {
      const snapshot = parsed.data;
      const prefix = this.history(topic, snapshot.card.coverageSeq);
      const project = snapshot.card.sources.find(source => source.kind === "project");
      if (snapshot.historyStamp === digest(prefix) && this.sourcesCurrent(topic, snapshot.card.sources)
        && (!project || authority.project?.id === project.id && authority.project.revision === project.revision)) {
        const changed = history.lastSeq > snapshot.card.coverageSeq;
        return { ...snapshot, card: version({ ...snapshot.card, title: authority.title.slice(0, 500), observedThroughSeq: history.lastSeq,
          freshness: changed ? "stale" : snapshot.card.freshness, ...(changed ? { coverageReason: "最近有新消息，话题整理待更新。" } : {}) }) };
      }
    }
    const facts: TopicFact[] = [], sources: TopicSource[] = [];
    if (authority.project?.goal) {
      const source: TopicSource = { kind: "project", id: authority.project.id, revision: authority.project.revision };
      sources.push(source);
      // An oversized authoritative goal remains readable by exact source pages.
      if (authority.project.goal.length <= 1800) facts.push({ id: `project-goal:${authority.project.id}`, section: "goal", text: authority.project.goal,
        origin: "authoritative", state: "active", sources: [source] });
    }
    const omittedGoal = authority.project && authority.project.goal.length > 1800;
    return { schemaVersion: 1, card: version({ topic, binding: authority.binding, title: authority.title.slice(0, 500) || "Topic", summary: utf8Prefix(authority.project?.goal ?? "原生对话记录，展开查看来源。", 280), facts,
      coverageSeq: 0, observedThroughSeq: history.lastSeq, freshness: history.count || omittedGoal ? "insufficient" : "current",
      ...(history.count || omittedGoal ? { coverageReason: omittedGoal ? "目标较长，请展开读取完整原文。" : "尚未整理全部历史，可查看相关原文。" } : {}), sources }), historyStamp: digest(this.history(topic, 0)) };
  }
  private async overview(topic: TopicRef, authority: Authority): Promise<TopicListItem> {
    const last = this.db.prepare(`SELECT json_extract(data,'$.role') AS role,json_extract(data,'$.createdAt') AS at,
      substr(json_extract(data,'$.text'),1,161) AS excerpt,
      EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.content')) WHERE json_extract(value,'$.type') IN ('file','image')) AS attachments
      FROM steward_messages WHERE ${visible} AND json_extract(data,'$.role') IN ('user','assistant') ORDER BY seq DESC LIMIT 1`).get(topic.conversationId, ...scopeArgs(topic.scope));
    const value = last ? z.object({role:z.enum(["user","assistant"]),at:z.string(),excerpt:z.string(),attachments:z.number()}).parse(last) : null;
    const characters = value ? Array.from(value.excerpt) : [];
    return compactItem(this.snapshot(topic, authority, Number.MAX_SAFE_INTEGER).card, value ? {role:value.role,at:value.at,excerpt:characters.slice(0,160).join(""),hasAttachments:!!value.attachments,truncated:characters.length>160} : null);
  }
  private sourcesCurrent(topic: TopicRef, sources: TopicSource[]): boolean {
    for (const source of sources) {
      if (source.kind !== "message") continue;
      const row = this.db.prepare(`SELECT seq,COALESCE(json_extract(data,'$.revision'),0) AS revision,json_extract(data,'$.source') AS binding
        FROM steward_messages WHERE id=? AND ${visible}`).get(source.id, topic.conversationId, ...scopeArgs(source.scope));
      if (!row || canonical(source.scope) !== canonical(topic.scope) || Number(row.seq) !== source.seq || Number(row.revision) !== source.revision
        || canonical(JSON.parse(String(row.binding))) !== canonical(source.binding)) return false;
    }
    return true;
  }
  private save(snapshot: Snapshot) {
    const card = topicCard.parse(snapshot.card), key = digest(card.topic);
    this.db.prepare("INSERT OR REPLACE INTO steward_topic_cards VALUES(?,?,?,?)").run(key, card.topic.conversationId, canonical(card.topic.scope), canonical({ ...snapshot, card }));
    this.db.prepare("DELETE FROM steward_topic_terms WHERE topic_key=?").run(key);
    const insert = this.db.prepare("INSERT OR IGNORE INTO steward_topic_terms VALUES(?,?,?)");
    for (const term of terms([card.title, card.summary, ...card.facts.filter(fact => fact.state === "active").map(fact => fact.text)].join(" ")))
      insert.run(card.topic.conversationId, term, key);
  }
  private async maintain(topic: TopicRef, authority: Authority, throughSeq: number, previous: Snapshot, delta: TopicOriginal[],
    requestBudget: Parameters<TopicCardsPort["context"]>[0]["requestBudget"]) {
    const compact = this.host.compact;
    if (!compact) return;
    const fail = (reason: string) => this.save({ ...previous, failure: reason });
    try {
      requestBudget?.signal.throwIfAborted();
      requestBudget?.claimCall();
      const output = topicCompactionOutput.parse(await compact({ previous: previous.card, delta }, requestBudget?.signal));
      requestBudget?.signal.throwIfAborted();
      const facts = this.mergeFacts(previous.card.facts, delta, output);
      const sources = [...new Map([...previous.card.sources, ...facts.flatMap(fact => fact.sources)].map(source => [sourceKey(source), source])).values()];
      const coverageSeq = delta.at(-1)?.source.seq ?? previous.card.coverageSeq;
      const card = topicCard.parse(version({ ...previous.card, facts, sources, summary: sourcedSummary(facts), coverageSeq, observedThroughSeq: this.history(topic, throughSeq).lastSeq,
        freshness: coverageSeq >= this.history(topic, throughSeq).lastSeq ? "current" : "stale", coverageReason: coverageSeq < this.history(topic, throughSeq).lastSeq ? "已更新一批相关内容，仍有历史资料待整理。" : undefined }));
      if (size(card) > CARD_BYTES) { fail("话题资料较多，已保留既有内容，请展开来源核对。"); return; }
      const current = await this.host.authorize(topic);
      if (canonical(current) !== canonical(authority) || digest(this.history(topic, previous.card.coverageSeq)) !== previous.historyStamp)
        throw new TaskError("CONFLICT", "Topic authority or covered history changed during maintenance");
      for (const original of delta) await this.source({ conversationId: topic.conversationId, ref: original.source, offset: 0 });
      requestBudget?.signal.throwIfAborted();
      this.save({ schemaVersion: 1, card, historyStamp: digest(this.history(topic, coverageSeq)) });
    } catch { fail("本次整理未通过来源校验，既有内容已保留，请查看原文或补充说明。"); }
  }
  private mergeFacts(previous: TopicFact[], delta: TopicOriginal[], output: z.infer<typeof topicCompactionOutput>): TopicFact[] {
    const bySource = new Map(delta.map(original => [sourceKey(original.source), original]));
    const old = new Map(previous.map(fact => [fact.id, fact])), result = new Map(old);
    const verified = (source: TopicSource, quote: string) => {
      const original = bySource.get(sourceKey(source));
      if (!original || !original.text.includes(quote)) throw new TaskError("INVALID", "Compaction evidence is not an exact batch quote");
      return original;
    };
    const ids = new Set<string>();
    for (const fact of output.facts) {
      if (ids.has(fact.id)) throw new TaskError("INVALID", "Duplicate compacted fact id");
      ids.add(fact.id);
      const prior = old.get(fact.id);
      if (prior && canonical(prior) === canonical(fact)) continue;
      // Immutable fact identities keep earlier decisions and constraints reviewable.
      if (prior || fact.origin !== "generated" || fact.state !== "active" || fact.supersededBy) throw new TaskError("INVALID", "Changed facts require a new generated identity");
      const proofs = output.evidence.filter(item => item.factId === fact.id);
      if (!proofs.length || fact.sources.some(source => !proofs.some(proof => sourceKey(proof.source) === sourceKey(source))))
        throw new TaskError("INVALID", "Every new fact source needs exact evidence");
      for (const proof of proofs) {
        verified(proof.source, proof.quote);
        if (!fact.sources.some(source => sourceKey(source) === sourceKey(proof.source))) throw new TaskError("INVALID", "Evidence source is absent from the fact");
      }
      result.set(fact.id, fact);
    }
    for (const supersession of output.supersessions) {
      const prior = old.get(supersession.factId), replacement = result.get(supersession.replacementId), original = verified(supersession.source, supersession.quote);
      const lastPriorSeq = Math.max(0, ...(prior?.sources.filter(source => source.kind === "message").map(source => source.seq) ?? []));
      if (!prior || prior.origin === "authoritative" || prior.state !== "active" || !replacement || replacement.id === prior.id || old.has(replacement.id)
        || original.role !== "user" || original.source.seq <= lastPriorSeq || !replacement.sources.some(source => sourceKey(source) === sourceKey(original.source)))
        throw new TaskError("INVALID", "Supersession needs a replacement and later user evidence");
      result.set(prior.id, { ...prior, state: "superseded", supersededBy: replacement.id });
    }
    return [...result.values()];
  }
  private routingCard(card: TopicCard, byteLimit: number): TopicCard {
    if (size(card) <= byteLimit) return card;
    let output = version({ ...card, title: utf8Prefix(card.title, 180), summary: utf8Prefix(card.summary, 200), facts: [], sources: [], freshness: "insufficient",
      coverageReason: "路由预览未含全部内容，请展开话题或补充说明。" });
    for (const fact of card.facts) {
      const sources = [...new Map([...output.sources, ...fact.sources].map(source => [sourceKey(source), source])).values()];
      const next = version({ ...output, facts: [...output.facts, fact], sources });
      if (size(next) <= byteLimit) output = next;
    }
    if (size(output) > byteLimit) throw new TaskError("LIMIT", "Topic identity exceeds the routing preview budget");
    return output;
  }
}
