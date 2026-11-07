import { z } from "zod";
import type { ModelCatalog } from "@deepseek-ai/dsh-api-session-controller/types";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import { stewardSelection } from "./steward-contracts.js";

export const stewardRoutingRead = z.strictObject({});
export const stewardRoutingConfigure = z.strictObject({ commandId: z.string().min(1).max(160),
  expectedRevision: z.number().int().nonnegative(), fallback: stewardSelection.nullable() });
const stored = z.strictObject({ revision: z.number().int().nonnegative(), fallback: stewardSelection.nullable() });
type Selection = z.infer<typeof stewardSelection>;

function available(selection: Selection, groups: ModelCatalog["groups"]): boolean {
  const model = groups.find(group => group.id === selection.provider)?.models.find(item => item.id === selection.model);
  return !!model && (!selection.reasoningEffort || !!model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort));
}
function lightweight(groups: ModelCatalog["groups"], jev: Selection | null): Selection | null {
  const selections: Selection[] = [];
  for (const id of ["gpt-5-mini", "group/gpt-ds-eco", "gpt-5-nano", "deepseek-flash"]) {
    for (const group of groups) {
      const model = group.models.find(item => item.id === id);
      if (!model) continue;
      const effort = ["none", "off", "minimal", "low"].find(id => model.reasoning?.efforts.some(item => item.id === id));
      selections.push({ provider: group.id, model: model.id, ...(effort ? { reasoningEffort: effort } : {}) });
    }
  }
  return selections.find(selection => selection.provider !== jev?.provider || selection.model !== jev.model) ?? selections[0] ?? null;
}

/** Independent routing preferences; the project coordinator's model is never a default. */
export class StewardRoutingSettings {
  private readonly db;
  constructor(ledger: Pick<TaskLedger, "managementDatabase">, private readonly catalog: () => Promise<ModelCatalog>,
    private readonly jevAvailable: () => boolean, private readonly activeDays: () => number, private readonly jevSelection: () => Selection | null = () => null) {
    this.db = ledger.managementDatabase();
    this.db.exec("CREATE TABLE IF NOT EXISTS steward_routing_settings(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS steward_routing_setting_commands(id TEXT PRIMARY KEY,data TEXT NOT NULL)");
  }
  private saved() {
    const row = this.db.prepare("SELECT data FROM steward_routing_settings WHERE id='global'").get();
    return row ? stored.parse(JSON.parse(String(row.data))) : { revision: 0, fallback: null };
  }
  async read() {
    const saved = this.saved();
    let groups: ModelCatalog["groups"] = [];
    try { groups = (await this.catalog()).groups; } catch { /* An unavailable catalog cannot authorize a model. */ }
    const fallback = saved.fallback ? available(saved.fallback, groups) ? saved.fallback : null : lightweight(groups, this.jevSelection());
    return { revision: saved.revision, configuredFallback: saved.fallback, fallback, available: groups,
      source: fallback ? saved.fallback ? "saved" as const : "default" as const : "unavailable" as const,
      jevAvailable: this.jevAvailable(), activeDays: this.activeDays() };
  }
  async configure(input: unknown) {
    const request = stewardRoutingConfigure.parse(input), encoded = canonical(request);
    const prior = this.db.prepare("SELECT data FROM steward_routing_setting_commands WHERE id=?").get(request.commandId);
    if (prior) {
      if (prior.data !== encoded) throw new TaskError("CONFLICT", "Routing settings retry changed its contents");
      return this.read();
    }
    if (request.fallback && !available(request.fallback, (await this.catalog()).groups))
      throw new TaskError("CONFIGURATION", "Choose an available routing model and reasoning effort");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.saved();
      if (current.revision !== request.expectedRevision) throw new TaskError("CONFLICT", "Routing settings changed; refresh before saving");
      this.db.prepare("INSERT INTO steward_routing_settings VALUES('global',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(canonical({ revision: current.revision + 1, fallback: request.fallback }));
      this.db.prepare("INSERT INTO steward_routing_setting_commands VALUES(?,?)").run(request.commandId, encoded);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.read();
  }
}
