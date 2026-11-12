import { createHash } from "node:crypto";
import { z } from "zod";
import type { StewardScope } from "./steward-contracts.js";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";

const key = z.string().min(1).max(160);
export const stewardIndependentTopic = z.strictObject({
  id: key, conversationId: key, commandId: key, title: z.string().min(1).max(100),
  createdAt: z.string(), revision: z.number().int().nonnegative(),
  projectId: key.nullable(), taskIds: z.array(key).max(50),
});
export type StewardIndependentTopic = z.infer<typeof stewardIndependentTopic>;
export const independentTopicScope = (topic: StewardIndependentTopic): Extract<StewardScope,{kind:"workbench"}> => ({ kind: "workbench", topicId: topic.id });

/** Stable discussion identity, separate from native session and project/task identity. */
export class StewardTopics {
  private readonly db;
  constructor(ledger: Pick<TaskLedger, "managementDatabase">) {
    this.db = ledger.managementDatabase();
    this.db.exec(`CREATE TABLE IF NOT EXISTS steward_independent_topics(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,command TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(conversation,command));
      CREATE INDEX IF NOT EXISTS steward_independent_topic_conversation ON steward_independent_topics(conversation,id); CREATE INDEX IF NOT EXISTS steward_independent_topic_title ON steward_independent_topics(conversation,json_extract(data,'$.title')); CREATE INDEX IF NOT EXISTS steward_independent_topic_project ON steward_independent_topics(json_extract(data,'$.projectId'),id)`);
  }
  create(input: { conversationId: string; commandId: string; text: string }): StewardIndependentTopic {
    const existing = this.db.prepare("SELECT data FROM steward_independent_topics WHERE conversation=? AND command=?").get(input.conversationId, input.commandId);
    if (existing) return stewardIndependentTopic.parse(JSON.parse(String(existing.data)));
    const id = createHash("sha256").update(canonical({ conversationId: input.conversationId, commandId: input.commandId })).digest("hex").slice(0, 32);
    const title = Array.from(input.text.replace(/\s+/gu, " ").trim()).slice(0, 40).join("") || "新话题";
    const topic = stewardIndependentTopic.parse({ id, conversationId: input.conversationId, commandId: input.commandId,
      title, createdAt: new Date().toISOString(), revision: 0, projectId: null, taskIds: [] });
    this.db.prepare("INSERT OR IGNORE INTO steward_independent_topics VALUES(?,?,?,?)").run(id, input.conversationId, input.commandId, canonical(topic));
    return this.get(input.conversationId, id);
  }
  get(conversationId: string, topicId: string): StewardIndependentTopic {
    const row = this.db.prepare("SELECT data FROM steward_independent_topics WHERE id=? AND conversation=?").get(topicId, conversationId);
    if (!row) throw new TaskError("FORBIDDEN", "Topic does not belong to this conversation");
    return stewardIndependentTopic.parse(JSON.parse(String(row.data)));
  }
  titleForId(topicId: string): string {
    const row = this.db.prepare("SELECT json_extract(data,'$.title') AS title FROM steward_independent_topics WHERE id=?").get(topicId);
    if (!row) throw new TaskError("FORBIDDEN", "Independent topic is unavailable");
    return String(row.title);
  }
  list(conversationId: string): StewardIndependentTopic[] {
    return this.db.prepare("SELECT data FROM steward_independent_topics WHERE conversation=? ORDER BY rowid DESC LIMIT 100").all(conversationId)
      .map(row => stewardIndependentTopic.parse(JSON.parse(String(row.data))));
  }
  forProject(projectId: string): StewardIndependentTopic[] {
    return this.db.prepare("SELECT data FROM steward_independent_topics WHERE json_extract(data,'$.projectId')=? ORDER BY id LIMIT 100").all(projectId)
      .map(row=>stewardIndependentTopic.parse(JSON.parse(String(row.data))));
  }
  update(input: { conversationId: string; topicId: string; expectedRevision: number; projectId?: string; taskId?: string }): StewardIndependentTopic {
    const previous = this.get(input.conversationId, input.topicId);
    if (previous.revision !== input.expectedRevision) throw new TaskError("CONFLICT", "Topic changed; refresh before updating its associations");
    if (input.projectId && previous.projectId && input.projectId !== previous.projectId) throw new TaskError("CONFLICT", "Topic already belongs to another project");
    const next = stewardIndependentTopic.parse({ ...previous, projectId: input.projectId ?? previous.projectId,
      taskIds: input.taskId && !previous.taskIds.includes(input.taskId) ? [...previous.taskIds, input.taskId] : previous.taskIds,
      revision: previous.revision + 1 });
    if (this.db.prepare("UPDATE steward_independent_topics SET data=? WHERE id=? AND conversation=? AND data=?").run(canonical(next), previous.id, previous.conversationId, canonical(previous)).changes !== 1)
      throw new TaskError("CONFLICT", "Topic changed while updating its associations");
    return next;
  }
}
