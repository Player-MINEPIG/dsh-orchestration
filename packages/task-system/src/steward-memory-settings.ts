import { createHash } from "node:crypto";
import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { TaskSystemService } from "./dsh-plugin.js";
import { canonical, TaskError } from "./ledger.js";
import { stewardBinding, stewardScope, type StewardBinding } from "./steward-contracts.js";

const key = z.string().min(1).max(160);
export const stewardMemoryRead = z.strictObject({ conversationId: key, scope: stewardScope });
export const stewardMemoryConfigure = stewardMemoryRead.extend({ commandId: key,
  expectedRevision: z.number().int().nonnegative(), expectedSelectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(["native", "manager"]), presetId: key.optional(),
  initializeMissingRules: z.boolean().default(false), inheritProjectGenerations: z.boolean().default(false),
  endPendingCommandId: key.optional(), confirmEndPending: z.literal(true).optional(),
});
export type StewardMemoryConfigure = z.infer<typeof stewardMemoryConfigure>;
export const memoryHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const scopeKey = (binding: StewardBinding) => binding.kind === "personal" ? `personal:${binding.sessionId}` : `project:${binding.projectId}`;
export const memoryPreset = z.object({ id: z.string(), name: z.string(), backend: z.literal("native"),
  rules: z.array(z.object({ kind: z.string(), enabled: z.boolean(), role: z.string() }).passthrough()),
}).passthrough();
const policy = z.object({ revision: z.number().int().positive(), mode: z.enum(["native", "manager"]),
  binding: stewardBinding, selectionHash: z.string(), inherit: z.boolean(), commandId: z.string().optional(),
  endedPendingCommandId: z.string().optional(), selectionObserved: z.boolean().default(true) });
const pending = z.object({ digest: z.string(), request: stewardMemoryConfigure, binding: stewardBinding,
  selected: z.unknown(), beforeHash: z.string(), done: z.boolean() });
const resourceSnapshot = z.object({ revision: z.number().int(), local: z.unknown().nullable(), configError: z.unknown().nullable() }).passthrough();
export const STEWARD_NATIVE_PRESET = {
  id: "dsh-task-steward-native-v1", format: "dsh-tavern-request-assembly", version: 1,
  name: "Steward · scoped native resources", backend: "native",
  rules: [{ id: "system", kind: "native-system" }, { id: "memory", kind: "memory-manager.resources", role: "system" },
    { id: "history", kind: "history" }, { id: "input", kind: "input" }],
};
export interface StewardMemoryConfiguration {
  revision: number; selectionHash: string; mode: "native" | "manager"; available: boolean; readOnly: boolean;
  selectionObserved: boolean;
  sourceRegistered: boolean; scope: { kind: "personal" } | { kind: "project"; projectId: string };
  session: { sessionId: string; generation: number; nodeId: string }; currentPresetId: string | null;
  presets: { id: string; name: string }[]; missingResourceIds: string[]; diagnostics: string[];
  inheritAuthorized: boolean; pendingChange: { commandId: string; request: StewardMemoryConfigure } | null;
}
const compatible = (value: unknown) => {
  const result = memoryPreset.safeParse(value);
  if (!result.success) return false;
  return ["native-system", "history", "input", "memory-manager.resources"].every(kind =>
    result.data.rules.filter(rule => rule.kind === kind && rule.enabled).length === 1) &&
    result.data.rules.find(rule => rule.kind === "memory-manager.resources")?.role === "system";
};
const selectedContentHash = (value: unknown) => {
  if (value === null) return memoryHash(null);
  const { builtin: _builtin, pluginId: _pluginId, ...selection } = z.object({ builtin: z.unknown().optional(), pluginId: z.unknown().optional() }).passthrough().parse(value);
  return memoryHash(selection);
};

/** Stores delegation/command metadata only. Rules and selected prompt snapshots remain owned by the public plugins. */
export class StewardMemorySettings {
  private readonly db;
  private readonly jobs = new Map<string, Promise<StewardMemoryConfiguration>>();
  constructor(private readonly task: TaskSystemService, private readonly ctx: Context,
    private readonly checkBinding: (binding: StewardBinding) => void,
    private readonly resourceIds: (binding: StewardBinding) => string[],
    private readonly legacyDelegated: () => boolean,
    private readonly registered: () => boolean) {
    this.db = task.ledger.managementDatabase();
    this.db.exec(`CREATE TABLE IF NOT EXISTS steward_memory_scopes(scope TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steward_memory_changes(id TEXT PRIMARY KEY,scope TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS steward_memory_change_scope ON steward_memory_changes(scope);`);
  }
  private saved(binding: StewardBinding) {
    const row = this.db.prepare("SELECT data FROM steward_memory_scopes WHERE scope=?").get(scopeKey(binding));
    return row ? policy.parse(JSON.parse(String(row.data))) : undefined;
  }
  managed(binding: StewardBinding): boolean { return this.saved(binding)?.mode === "manager" || !this.saved(binding) && this.legacyDelegated(); }
  hasManagedScopes(): boolean { return !!this.db.prepare("SELECT 1 FROM steward_memory_scopes WHERE json_extract(data,'$.mode')='manager' LIMIT 1").get(); }
  private ports() {
    const manager = this.ctx.get("dshMemoryManager"), assembler = this.ctx.get("dshPromptAssembler");
    if (!this.registered() || manager?.protocolVersion !== 1 || typeof manager.configurationSnapshot !== "function" ||
      typeof manager.saveEntry !== "function" || typeof assembler?.store?.list !== "function" ||
      typeof assembler.store.applySnapshot !== "function" || typeof assembler.store.hasSelection !== "function" ||
      typeof assembler.store.copySelection !== "function")
      throw new TaskError("UNAVAILABLE", "Memory Manager/Assembler public configuration services are unavailable");
    return { manager, assembler };
  }
  private assertMutationIdle(binding: StewardBinding) {
    const agent = this.ctx.get("agents")?.get(SessionId(binding.sessionId));
    if (agent && (agent.status !== "idle" || agent.inbox.nextTurn.length || agent.inbox.nextStep.length))
      throw new TaskError("BUSY", "Native input arrived during memory configuration; inspect the pending change after that turn finishes");
    if (binding.kind !== "personal" && this.db.prepare("SELECT 1 FROM pr_turns WHERE owner=? AND state IN ('queued','running') LIMIT 1").get(binding.projectId))
      throw new TaskError("BUSY", "The project PM has a queued or active turn; memory configuration remains pending");
  }
  configuration(binding: StewardBinding): StewardMemoryConfiguration {
    this.checkBinding(binding);
    const saved = this.saved(binding), mode = this.managed(binding) ? "manager" : "native";
    let selection: unknown = null, selectionObserved = false, presets: { id: string; name: string }[] = [], missing = this.resourceIds(binding);
    const diagnostics: string[] = [];
    const local = binding.nodeId === this.task.config.nodeId;
    let available = false;
    if (local) try {
      const assembler = this.ctx.get("dshPromptAssembler");
      if (typeof assembler?.store?.selection === "function") { selection = assembler.store.selection(binding.sessionId); selectionObserved = true; }
    } catch { diagnostics.push("当前原生预设暂不可读取；未把未知状态当作未选择。"); }
    if (!local) diagnostics.push("远端 owner 未提供正式 Manager/Assembler 配置端口；不使用本地来源或预设代替。");
    else try {
      const { manager, assembler } = this.ports();
      const catalog = z.array(z.unknown()).parse(assembler.store.list());
      presets = catalog.filter(compatible).map(value => { const preset = memoryPreset.parse(value); return { id: preset.id, name: preset.name }; });
      missing = this.resourceIds(binding).filter(id => !resourceSnapshot.parse(manager.configurationSnapshot({ id, adapterId: "dsh-task.steward", sessionId: binding.sessionId })).local);
      available = true;
      if (!manager.isAdapterEnabled("dsh-task.steward")) diagnostics.push("Steward 来源已在 Manager 停用，既有规则不会被覆盖。");
      if (missing.length) diagnostics.push("存在缺失来源规则；可显式创建缺失项，已有规则（含拒绝）保持原样。");
      if (mode === "manager" && !compatible(selection)) diagnostics.push("当前会话未选择兼容的 native 资源预设；不会旁路恢复人格段。");
    } catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)); }
    const pendingRow = this.db.prepare("SELECT id,data FROM steward_memory_changes WHERE scope=? AND json_extract(data,'$.done')=0 ORDER BY rowid LIMIT 1").get(scopeKey(binding));
    const outstanding = pendingRow ? { id: String(pendingRow.id), value: pending.parse(JSON.parse(String(pendingRow.data))) } : null;
    if (!selectionObserved) diagnostics.push("实际预设状态未知；显式恢复原生所有权不会覆盖已有预设或Manager规则。");
    return { revision: saved?.revision ?? 0, selectionHash: selectionObserved ? memoryHash(selection) : memoryHash({ selection: "unavailable" }), mode, available, readOnly: !local,
      sourceRegistered: this.registered(), selectionObserved, scope: binding.kind === "personal" ? { kind: "personal" } : { kind: "project", projectId: binding.projectId },
      session: { sessionId: binding.sessionId, generation: binding.generation, nodeId: binding.nodeId },
      currentPresetId: memoryPreset.safeParse(selection).data?.id ?? null, presets, missingResourceIds: missing, diagnostics,
      inheritAuthorized: saved?.inherit ?? false, pendingChange: outstanding ? { commandId: outstanding.id, request: outstanding.value.request } : null };
  }
  configure(input: unknown, binding: StewardBinding): Promise<StewardMemoryConfiguration> {
    const request = stewardMemoryConfigure.parse(input), digest = memoryHash(request), existing = this.db.prepare("SELECT data FROM steward_memory_changes WHERE id=?").get(request.commandId);
    if (existing && pending.parse(JSON.parse(String(existing.data))).digest !== digest)
      return Promise.reject(new TaskError("CONFLICT", "Memory configuration command changed its original contents"));
    const active = this.jobs.get(request.commandId);
    if (active) return active;
    const job = this.change(request, binding, digest).finally(() => this.jobs.delete(request.commandId));
    this.jobs.set(request.commandId, job);
    return job;
  }
  private async change(request: StewardMemoryConfigure, binding: StewardBinding, digest: string) {
    this.checkBinding(binding);
    const actualScope = binding.kind === "personal" ? { kind: "personal" } : { kind: "project", projectId: binding.projectId };
    if (canonical(request.scope) !== canonical(actualScope)) throw new TaskError("FORBIDDEN", "Configuration scope differs from its trusted native binding");
    if (binding.nodeId !== this.task.config.nodeId) throw new TaskError("UNAVAILABLE", "Configure memory on the actual native owner; no remote owner adapter is available");
    this.assertMutationIdle(binding);
    if (request.mode === "native") return this.restoreNative(request, binding, digest);
    if (request.endPendingCommandId || request.confirmEndPending) throw new TaskError("INVALID", "Ending a pending attempt requires explicit native ownership");
    const key = scopeKey(binding);
    let change: z.infer<typeof pending>;
    const old = this.db.prepare("SELECT data FROM steward_memory_changes WHERE id=?").get(request.commandId);
    if (old && pending.parse(JSON.parse(String(old.data))).done) return this.configuration(binding);
    const { manager, assembler } = this.ports();
    if (old) {
      change = pending.parse(JSON.parse(String(old.data)));
      if (change.done) return this.configuration(binding);
      if (memoryHash(change.binding) !== memoryHash(binding)) throw new TaskError("CONFLICT", "Original configuration targets an older native binding; inspect it before a new decision");
    } else {
      const current = this.configuration(binding);
      if (current.pendingChange) throw new TaskError("CONFLICT", "Resolve the original pending memory configuration first");
      if (current.revision !== request.expectedRevision || current.selectionHash !== request.expectedSelectionHash)
        throw new TaskError("CONFLICT", "Memory configuration or selected native preset changed");
      let selected: unknown = null;
      if (request.mode === "manager") {
        if (current.missingResourceIds.length && !request.initializeMissingRules)
          throw new TaskError("CONFIGURATION", "Authorize missing source-rule initialization or configure Manager first");
        if (!request.presetId) throw new TaskError("INVALID", "Choose a native resource preset explicitly");
        selected = assembler.store.get(request.presetId);
        if (!compatible(selected)) throw new TaskError("CONFIGURATION", "Selected preset must contain one native system/history/input and one system-role Manager resource source");
        assembler.runtime.requireAvailable(selected);
      }
      change = { digest, request, binding, selected, beforeHash: current.selectionHash, done: false };
      this.db.prepare("INSERT INTO steward_memory_changes VALUES(?,?,?)").run(request.commandId, key, canonical(change));
    }
    if (request.mode === "manager") {
      for (const id of this.resourceIds(binding)) {
        this.checkBinding(binding);
        this.assertMutationIdle(binding);
        const snapshot = resourceSnapshot.parse(manager.configurationSnapshot({ id, adapterId: "dsh-task.steward", sessionId: binding.sessionId }));
        if (snapshot.configError) throw new TaskError("CONFIGURATION", "Repair Manager configuration before delegation; existing rules were not overwritten");
        if (!snapshot.local) {
          if (!request.initializeMissingRules) throw new TaskError("CONFIGURATION", "Source rules are missing; explicitly authorize initialization or configure Manager first");
          await manager.saveEntry({ id, adapterId: "dsh-task.steward", sessionId: binding.sessionId, expectedRevision: snapshot.revision,
            entry: { id, adapterId: "dsh-task.steward", whitelist: [{ global: true }], blacklist: [],
              retrieve: { on: "before_model_request", rule: true, strategy: [{ operation: "memory.read_content" }, { operation: "memory.to_text" }] } } });
        }
      }
      this.checkBinding(binding);
      this.assertMutationIdle(binding);
      const selected = assembler.store.selection(binding.sessionId), currentHash = memoryHash(selected);
      const matchesIntended = selectedContentHash(selected) === selectedContentHash(change.selected);
      if (currentHash !== change.beforeHash && !matchesIntended)
        throw new TaskError("CONFLICT", "Native preset changed during configuration; no newer selection was overwritten");
      if (!matchesIntended) assembler.store.applySnapshot(binding.sessionId, change.selected);
    }
    this.checkBinding(binding);
    const prior = this.saved(binding), next = { revision: (prior?.revision ?? 0) + 1, mode: request.mode,
      binding, selectionHash: memoryHash(assembler.store.selection(binding.sessionId)), inherit: request.mode === "manager" && binding.kind !== "personal" && request.inheritProjectGenerations };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO steward_memory_scopes VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data").run(key, canonical(next));
      this.db.prepare("UPDATE steward_memory_changes SET data=? WHERE id=?").run(canonical({ ...change, done: true }), request.commandId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.configuration(binding);
  }
  private restoreNative(request: StewardMemoryConfigure, binding: StewardBinding, digest: string) {
    const existing = this.db.prepare("SELECT data FROM steward_memory_changes WHERE id=?").get(request.commandId);
    if (existing && pending.parse(JSON.parse(String(existing.data))).done) return this.configuration(binding);
    const current = this.configuration(binding);
    if (current.revision !== request.expectedRevision || current.selectionHash !== request.expectedSelectionHash)
      throw new TaskError("CONFLICT", "Memory ownership or native preset observation changed; inspect it before release");
    if (current.pendingChange) {
      if (request.endPendingCommandId !== current.pendingChange.commandId || request.confirmEndPending !== true)
        throw new TaskError("CONFLICT", "Explicitly confirm which pending configuration is being ended");
    } else if (request.endPendingCommandId || request.confirmEndPending) throw new TaskError("CONFLICT", "Pending configuration changed; refresh before release");
    const completed = { digest, request, binding, selected: null, beforeHash: current.selectionHash, done: true };
    const next = { revision: current.revision + 1, mode: "native", binding, selectionHash: current.selectionHash,
      selectionObserved: current.selectionObserved, inherit: false, commandId: request.commandId,
      ...(request.endPendingCommandId ? { endedPendingCommandId: request.endPendingCommandId } : {}) };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (current.pendingChange) {
        const row = this.db.prepare("SELECT data FROM steward_memory_changes WHERE id=?").get(current.pendingChange.commandId);
        if (!row) throw new TaskError("CONFLICT", "Pending configuration disappeared");
        const original = pending.parse(JSON.parse(String(row.data)));
        this.db.prepare("UPDATE steward_memory_changes SET data=? WHERE id=?").run(canonical({ ...original, done: true,
          outcome: "ended-by-user-native", endedBy: request.commandId }), current.pendingChange.commandId);
      }
      this.db.prepare("INSERT INTO steward_memory_scopes VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data").run(scopeKey(binding), canonical(next));
      this.db.prepare("INSERT INTO steward_memory_changes VALUES(?,?,?)").run(request.commandId, scopeKey(binding), canonical(completed));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.configuration(binding);
  }
  prepare(binding: StewardBinding) {
    this.checkBinding(binding);
    if (this.db.prepare("SELECT 1 FROM steward_memory_changes WHERE scope=? AND json_extract(data,'$.done')=0 LIMIT 1").get(scopeKey(binding)))
      throw new TaskError("BUSY", "Resolve the original memory configuration before a new native turn");
    const saved = this.saved(binding);
    if (!saved || saved.mode !== "manager") return;
    if (binding.nodeId !== this.task.config.nodeId) throw new TaskError("UNAVAILABLE", "Managed memory requires its actual native owner adapter");
    const { assembler } = this.ports();
    if (memoryHash(saved.binding) === memoryHash(binding)) {
      if (memoryHash(assembler.store.selection(binding.sessionId)) !== saved.selectionHash)
        throw new TaskError("CONFLICT", "The selected native preset changed after authorization; choose the current memory policy explicitly");
      return;
    }
    if (binding.kind === "personal" || saved.binding.kind === "personal" || binding.projectId !== saved.binding.projectId || !saved.inherit)
      throw new TaskError("CONFIGURATION", "This native generation has not been authorized to inherit memory policy");
    if (assembler.store.hasSelection(binding.sessionId)) {
      if (memoryHash(assembler.store.selection(binding.sessionId)) !== saved.selectionHash)
        throw new TaskError("CONFIGURATION", "New native generation already has an explicit preset; choose its memory policy without overwriting it");
      this.db.prepare("UPDATE steward_memory_scopes SET data=? WHERE scope=?").run(canonical({ ...saved, binding }), scopeKey(binding));
      return;
    }
    if (memoryHash(assembler.store.selection(saved.binding.sessionId)) !== saved.selectionHash)
      throw new TaskError("CONFLICT", "Previously authorized native preset changed; inheritance requires a new explicit decision");
    assembler.store.copySelection(saved.binding.sessionId, binding.sessionId);
    this.checkBinding(binding);
    this.db.prepare("UPDATE steward_memory_scopes SET data=? WHERE scope=?").run(canonical({ ...saved, binding }), scopeKey(binding));
  }
}
