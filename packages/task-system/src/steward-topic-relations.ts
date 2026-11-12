import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import { stewardScope, type StewardScope } from "./steward-contracts.js";
import { topicReference, type TopicRef } from "./steward-topic-types.js";

const key = z.string().min(1).max(160);
export const topicRelationInput = z.strictObject({
  commandId: key,
  topic: topicReference,
  expectedRevision: z.number().int().nonnegative(),
  parent: stewardScope.nullable(),
  role: z.string().trim().max(100).default(""),
  responsibility: z.string().trim().max(500).default(""),
});
const relation = z.strictObject({
  topic: topicReference,
  revision: z.number().int().nonnegative(),
  parent: stewardScope.nullable(),
  role: z.string(),
  responsibility: z.string(),
  updatedAt: z.string().nullable(),
});
export type TopicRelation = z.infer<typeof relation>;

/** Discussion membership is metadata, never a workspace or task-authority grant. */
export class StewardTopicRelations {
  private readonly db;
  constructor(
    ledger: Pick<TaskLedger, "managementDatabase">,
    private readonly authorize: (topic: TopicRef) => Promise<unknown>,
    private readonly inherited: {
      parent?(topic: TopicRef): StewardScope | null;
      children?(topic: TopicRef): StewardScope[];
    } = {},
  ) {
    this.db = ledger.managementDatabase();
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS steward_topic_relations(conversation TEXT NOT NULL,scope TEXT NOT NULL,parent TEXT,data TEXT NOT NULL,PRIMARY KEY(conversation,scope));
      CREATE INDEX IF NOT EXISTS steward_topic_relation_parent ON steward_topic_relations(conversation,parent);
      CREATE TABLE IF NOT EXISTS steward_topic_relation_commands(command TEXT PRIMARY KEY,input TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steward_topic_artifacts(conversation TEXT NOT NULL,scope TEXT NOT NULL,session TEXT NOT NULL,call TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(conversation,session,call));
      CREATE INDEX IF NOT EXISTS steward_topic_artifact_scope ON steward_topic_artifacts(conversation,scope,session);`);
  }
  read(topic: TopicRef): TopicRelation {
    const row = this.db
      .prepare(
        "SELECT data FROM steward_topic_relations WHERE conversation=? AND scope=?",
      )
      .get(topic.conversationId, canonical(topic.scope));
    return row
      ? relation.parse(JSON.parse(String(row.data)))
      : {
          topic,
          revision: 0,
          parent: this.inherited.parent?.(topic) ?? null,
          role: "",
          responsibility: "",
          updatedAt: null,
        };
  }
  async configure(input: unknown): Promise<TopicRelation> {
    const request = topicRelationInput.parse(input),
      encoded = canonical(request);
    const previous = this.db
      .prepare(
        "SELECT input,result FROM steward_topic_relation_commands WHERE command=?",
      )
      .get(request.commandId);
    if (previous) {
      if (previous.input !== encoded)
        throw new TaskError(
          "CONFLICT",
          "This placement command changed its contents",
        );
      await this.authorize(request.topic);
      return relation.parse(JSON.parse(String(previous.result)));
    }
    await this.authorize(request.topic);
    if (request.parent)
      await this.authorize({
        conversationId: request.topic.conversationId,
        scope: request.parent,
      });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Another caller can finish this same command while authorization awaits.
      const completed = this.db
        .prepare(
          "SELECT input,result FROM steward_topic_relation_commands WHERE command=?",
        )
        .get(request.commandId);
      if (completed) {
        if (completed.input !== encoded)
          throw new TaskError(
            "CONFLICT",
            "This placement command changed its contents",
          );
        this.db.exec("COMMIT");
        return relation.parse(JSON.parse(String(completed.result)));
      }
      const current = this.read(request.topic);
      if (current.revision !== request.expectedRevision)
        throw new TaskError("CONFLICT", "话题归属已变化，请刷新后核对。");
      let parent = request.parent;
      const visited = new Set([canonical(request.topic.scope)]);
      for (let count = 0; parent; count++) {
        const encodedParent = canonical(parent);
        if (visited.has(encodedParent))
          throw new TaskError("INVALID", "话题归属不能形成循环。");
        if (count >= 32)
          throw new TaskError("LIMIT", "话题归属层级过深，请先整理关系。");
        visited.add(encodedParent);
        parent = this.read({
          conversationId: request.topic.conversationId,
          scope: parent,
        }).parent;
      }
      const next = relation.parse({
        topic: request.topic,
        revision: current.revision + 1,
        parent: request.parent,
        role: request.role,
        responsibility: request.responsibility,
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare(
          "INSERT INTO steward_topic_relations VALUES(?,?,?,?) ON CONFLICT(conversation,scope) DO UPDATE SET parent=excluded.parent,data=excluded.data",
        )
        .run(
          request.topic.conversationId,
          canonical(request.topic.scope),
          request.parent ? canonical(request.parent) : null,
          canonical(next),
        );
      this.db
        .prepare("INSERT INTO steward_topic_relation_commands VALUES(?,?,?)")
        .run(request.commandId, encoded, canonical(next));
      this.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  root(topic: TopicRef): TopicRef {
    let current = topic;
    const visited = new Set<string>();
    for (let count = 0; count < 32; count++) {
      const key = canonical(current.scope);
      if (visited.has(key))
        throw new TaskError("CONFLICT", "话题归属关系需要核对。");
      visited.add(key);
      const parent = this.read(current).parent;
      if (!parent) return current;
      current = { conversationId: topic.conversationId, scope: parent };
    }
    throw new TaskError("LIMIT", "话题归属层级超出核对范围。");
  }
  stamp(topic: TopicRef): string {
    const group = this.group(topic);
    return canonical({
      root: this.root(topic),
      complete: group.complete,
      relations: group.scopes.map((scope) =>
        this.read({ conversationId: topic.conversationId, scope }),
      ),
    });
  }
  group(topic: TopicRef): { scopes: StewardScope[]; complete: boolean } {
    const pending = [this.root(topic).scope],
      scopes: StewardScope[] = [],
      seen = new Set<string>();
    let complete = true;
    while (pending.length) {
      const current = pending.shift()!,
        key = canonical(current);
      if (seen.has(key)) continue;
      seen.add(key);
      if (scopes.length === 8) {
        complete = false;
        break;
      }
      scopes.push(current);
      const rows = this.db
        .prepare(
          "SELECT scope FROM steward_topic_relations WHERE conversation=? AND parent=? ORDER BY scope LIMIT 9",
        )
        .all(topic.conversationId, key);
      if (rows.length > 8) complete = false;
      pending.push(
        ...rows.map((row) => stewardScope.parse(JSON.parse(String(row.scope)))),
      );
      for (const child of this.inherited.children?.({
        conversationId: topic.conversationId,
        scope: current,
      }) ?? []) {
        // An explicit newer placement takes precedence over an older project association.
        if (
          canonical(
            this.read({ conversationId: topic.conversationId, scope: child })
              .parent,
          ) === key
        )
          pending.push(child);
      }
    }
    return { scopes, complete };
  }

  recordArtifact(input: {
    conversationId: string;
    scope: StewardScope;
    sessionId: string;
    callId: string;
    name: string;
  }) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO steward_topic_artifacts VALUES(?,?,?,?,?)",
      )
      .run(
        input.conversationId,
        canonical(input.scope),
        input.sessionId,
        input.callId,
        input.name,
      );
  }
  artifacts(topic: TopicRef, sessionId: string): string[] {
    return this.db
      .prepare(
        "SELECT name FROM steward_topic_artifacts WHERE conversation=? AND scope=? AND session=? ORDER BY rowid DESC LIMIT 16",
      )
      .all(topic.conversationId, canonical(topic.scope), sessionId)
      .map((row) => String(row.name));
  }
}
