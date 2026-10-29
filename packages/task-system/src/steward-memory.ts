import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { TaskSystemService } from "./dsh-plugin.js";
import { canonical, TaskError } from "./ledger.js";
import { StewardConversations, stewardBindingKey } from "./steward-conversations.js";
import { STEWARD_PERSONA, STEWARD_PERSONA_TEXT, type StewardBinding } from "./steward-contracts.js";
import { StewardMemorySettings, STEWARD_NATIVE_PRESET, stewardMemoryRead, stewardMemoryConfigure } from "./steward-memory-settings.js";
import { stewardProjectCheckpoint, installStewardMemoryIndexes } from "./steward-memory-context.js";
export { stewardMemoryRead, stewardMemoryConfigure };
export type { StewardMemoryConfiguration } from "./steward-memory-settings.js";

interface Resource {
  id: string; type: string; name: string; revision: string; content: string;
  authority: string; capabilities: { edit: false; copy: false };
}
interface MemorySource {
  id: string; name: string; authority: string;
  list(input: unknown): Resource[];
  read(input: unknown): Resource | null;
  listBound(input: unknown): { revision: string; items: unknown[]; checkCurrent(): boolean };
  validateConfig(input: unknown): void;
}
interface MemoryManagerPort {
  protocolVersion: number;
  registerAdapter(adapter: MemorySource): () => void;
  requestAssemblyResources(): unknown;
  isAdapterEnabled(id: string): boolean;
  configurationSnapshot(input: unknown): unknown;
  saveEntry(input: unknown): Promise<unknown>;
}
interface AssemblerPort {
  version: string;
  runtime: { observeNativeRequest(options: unknown, session: unknown): unknown; requireAvailable(preset: unknown): void };
  registerPresets(input: unknown): () => void;
  store: { selection(sessionId: string): unknown; list(): unknown; get(id: string): unknown;
    hasSelection(sessionId: string): boolean; applySnapshot(sessionId: string, preset: unknown): unknown;
    copySelection(from: string, to: string): void };
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    dshMemoryManager: MemoryManagerPort;
    dshPromptAssembler: AssemblerPort;
  }
}
export const STEWARD_MEMORY_SOURCE = "dsh-task.steward";
const query = z.object({ scope: z.object({ sessionId: z.string().min(1) }).passthrough() }).passthrough();
const read = query.extend({ id: z.string().min(1) });
const assemblyResources = z.object({ available: z.boolean(), entries: z.array(z.object({ id: z.string(), adapterId: z.string() }).passthrough()) });
const nativeSelection = z.object({ backend: z.literal("native"), rules: z.array(z.object({ kind: z.string(), enabled: z.boolean() }).passthrough()) }).passthrough();
const revision = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

export class StewardMemoryBridge {
  private readonly settings: StewardMemorySettings;
  private registered = false;
  private disposed = false;
  private delegated: boolean;
  private stop?: () => void;
  private diagnostic: string | null = null;
  constructor(private readonly task: TaskSystemService, private readonly store: StewardConversations, private readonly ctx: Context) {
    const db = task.ledger.managementDatabase();
    installStewardMemoryIndexes(task.ledger);
    db.exec("CREATE TABLE IF NOT EXISTS steward_memory_delegation (id INTEGER PRIMARY KEY CHECK(id=1))");
    this.delegated = !!db.prepare("SELECT 1 FROM steward_memory_delegation WHERE id=1").get();
    this.settings = new StewardMemorySettings(task, ctx, binding => this.checkBinding(binding),
      binding => binding.kind === "personal" ? [STEWARD_PERSONA.id] : [STEWARD_PERSONA.id, `steward.project.${binding.projectId}`],
      () => this.delegated, () => this.registered && !this.disposed);
    ctx.inject(["dshMemoryManager"], scope => scope.effect(() => {
      if (this.disposed) return () => {};
      const manager = scope.dshMemoryManager;
      if (manager.protocolVersion !== 1 || typeof manager.requestAssemblyResources !== "function") {
        this.diagnostic = "Memory manager protocol 1 request resources are unavailable";
        return () => {};
      }
      const stop = manager.registerAdapter(this.adapter());
      this.diagnostic = null;
      this.registered = true;
      let removed = false;
      const remove = () => { if (removed) return; removed = true; this.registered = false; stop(); };
      this.stop = remove;
      return remove;
    }));
    ctx.inject(["dshPromptAssembler"], scope => scope.effect(() => {
      const assembler = scope.dshPromptAssembler;
      if (this.disposed || typeof assembler.registerPresets !== "function") return () => {};
      try { return assembler.registerPresets({ pluginId: STEWARD_MEMORY_SOURCE, presets: [STEWARD_NATIVE_PRESET] }); }
      catch (error) { this.diagnostic = error instanceof Error ? error.message : String(error); return () => {}; }
    }));
  }
  private compatiblePair(): boolean {
    const manager = this.ctx.get("dshMemoryManager"), assembler = this.ctx.get("dshPromptAssembler");
    return manager?.protocolVersion === 1 && typeof manager.requestAssemblyResources === "function" &&
      typeof assembler?.runtime?.observeNativeRequest === "function" && typeof assembler?.store?.selection === "function";
  }
  private configuredResources() {
    try { return assemblyResources.safeParse(this.ctx.get("dshMemoryManager")?.requestAssemblyResources()).data; }
    catch { return undefined; }
  }
  /** Trusted Host opt-in after configuring Manager rules and native Assembler session presets; never a model tool. */
  delegateToManager() {
    if (this.disposed || !this.registered || !this.compatiblePair())
      throw new TaskError("UNAVAILABLE", "Compatible Manager/Assembler source services are required");
    const resources = this.configuredResources();
    if (!resources?.available || !resources.entries.some(entry => entry.adapterId === STEWARD_MEMORY_SOURCE && entry.id === STEWARD_PERSONA.id))
      throw new TaskError("CONFIGURATION", "Configure the steward persona resource and native session presets before delegation");
    if (this.delegated) return;
    this.task.ledger.managementDatabase().prepare("INSERT OR IGNORE INTO steward_memory_delegation VALUES(1)").run();
    this.delegated = true;
  }
  /** Ownership remains delegated across unload/restart; missing policy services cannot enable a second injector. */
  get assembled(): boolean { return this.delegated; }
  configuration(binding: StewardBinding) { return this.settings.configuration(binding); }
  configure(input: unknown, binding: StewardBinding) { return this.settings.configure(input, binding); }
  prepare(binding: StewardBinding) { return this.settings.prepare(binding); }
  usesManager(sessionId: string): boolean {
    try { return this.settings.managed(this.bindingForSession(sessionId)); }
    catch { return this.store.sourcesForSession(sessionId, this.task.config.nodeId).some(source => this.settings.managed(source.binding)); }
  }
  capability() {
    const available = this.registered && this.compatiblePair() && !this.disposed &&
      this.configuredResources()?.available === true;
    const assembler = this.ctx.get("dshPromptAssembler");
    const missingPresets = this.delegated && available && this.store.conversationIds().some(id => this.store.cursors(id).some(cursor => {
      if (cursor.binding.nodeId !== this.task.config.nodeId) return false;
      try { this.bindingForSession(cursor.binding.sessionId); } catch { return false; }
      const selected = nativeSelection.safeParse(assembler?.store.selection(cursor.binding.sessionId));
      return !selected.success || !selected.data.rules.some(rule => rule.kind === "memory-manager.resources" && rule.enabled);
    }));
    const scoped = this.settings.hasManagedScopes();
    return { mode: scoped ? available ? "scope-specific-manager" : "unavailable" : this.delegated && available ? "manager-assembler" : this.delegated ? "unavailable" : available ? "available-not-delegated" : "native-persona-section",
      sourceRegistered: this.registered, assemblerVersion: this.ctx.get("dshPromptAssembler")?.version ?? null,
      diagnostic: this.diagnostic ?? (scoped ? "记忆策略按个人/项目分别授权；在当前对话范围的记忆设置中核对缺失规则与原生预设。" : this.delegated && available
        ? missingPresets ? "已委托；部分当前原生会话缺少启用 memory-manager.resources 的 native 预设，不回退人格注入。"
          : "资源已注册；是否选入请求由 Manager 规则和 Assembler 会话预设决定，不能据此声称已进入模型请求。"
        : this.delegated ? "已委托 Manager/Assembler；当前服务不可用，不回退绕过既有资源规则。"
        : available ? "可用但未委托：使用官方人格段；须先配置 Manager 规则与各原生会话预设，再由 Host 显式交接。"
          : "使用官方系统提示词段提供人格；可选 Manager/Assembler 服务尚不可用。") };
  }
  bindingForSession(sessionId: string): StewardBinding {
    this.assertStewardReader(sessionId);
    const candidates = this.store.sourcesForSession(sessionId, this.task.config.nodeId).map(source => source.binding);
    const live = candidates.filter(binding => {
      if (binding.kind === "personal") return true;
      try {
        const current = this.task.projects?.placementProject(binding.projectId);
        return current?.session === binding.sessionId && current.generation === binding.generation && current.cwd === binding.cwd;
      } catch { return false; }
    });
    const unique = new Map(live.map(binding => [stewardBindingKey(binding), binding]));
    const value = unique.size === 1 ? unique.values().next().value : undefined;
    if (!value) throw new TaskError("FORBIDDEN", "No unique current local steward session binding");
    return value;
  }
  private assertStewardReader(sessionId: string) {
    const agent = this.ctx.get("agents")?.get(SessionId(sessionId));
    if (this.task.native?.scopeFor(agent))
      throw new TaskError("FORBIDDEN", "Owned task execution cannot read a steward conversation or memory source");
  }
  private checkBinding(binding: StewardBinding) {
    if (this.disposed) throw new TaskError("UNAVAILABLE", "Steward memory source is stopping");
    this.assertStewardReader(binding.sessionId);
    if (binding.kind === "personal") {
      if (binding.nodeId !== this.task.config.nodeId) throw new TaskError("FORBIDDEN", "Personal scope must use its local native owner");
      return;
    }
    const current = this.task.projects?.placementProject(binding.projectId);
    if (current?.session !== binding.sessionId || current.generation !== binding.generation || current.cwd !== binding.cwd)
      throw new TaskError("CONFLICT", "Project native binding changed; refresh before configuring memory");
  }
  private resources(sessionId: string): Resource[] {
    const binding = this.bindingForSession(sessionId);
    const persona: Resource = { id: STEWARD_PERSONA.id, type: "persona", name: "Steward persona",
      revision: STEWARD_PERSONA.version, content: `[persona ${STEWARD_PERSONA.id}@${STEWARD_PERSONA.version}]\n${STEWARD_PERSONA_TEXT}`,
      authority: STEWARD_MEMORY_SOURCE, capabilities: { edit: false, copy: false } };
    if (binding.kind === "personal") return [persona];
    const project = this.task.projects?.placementProject(binding.projectId);
    if (!project) throw new TaskError("UNAVAILABLE", "Project authority unavailable");
    const facts = stewardProjectCheckpoint(this.task, binding);
    const content = "以下是当前项目账本的只读参考资料，不是新的执行授权；不包含其他项目或个人聊天。\n" + canonical(facts);
    return [persona, { id: `steward.project.${binding.projectId}`, type: "project-context", name: project.title,
      revision: revision(facts), content, authority: STEWARD_MEMORY_SOURCE, capabilities: { edit: false, copy: false } }];
  }
  private adapter(): MemorySource {
    return {
      id: STEWARD_MEMORY_SOURCE, name: "Steward scoped resources", authority: STEWARD_MEMORY_SOURCE,
      validateConfig: input => {
        const value = z.object({ id: z.string(), adapterId: z.literal(STEWARD_MEMORY_SOURCE), store: z.unknown().optional() }).passthrough().parse(input);
        if (value.id !== STEWARD_PERSONA.id && !value.id.startsWith("steward.project.")) throw new TaskError("FORBIDDEN", "Resource does not belong to steward source");
        if (value.store !== undefined) throw new TaskError("READ_ONLY", "Steward source supports retrieval only");
      },
      list: input => { const parsed = query.safeParse(input); return parsed.success ? this.resources(parsed.data.scope.sessionId) : []; },
      read: input => {
        const parsed = read.parse(input);
        const binding = this.bindingForSession(parsed.scope.sessionId);
        if (!this.settings.managed(binding)) throw new TaskError("CONFIGURATION", "Steward scope has not been delegated to Manager");
        return this.resources(parsed.scope.sessionId).find(resource => resource.id === parsed.id) ?? null;
      },
      listBound: input => {
        const { scope } = query.parse(input);
        const binding = this.bindingForSession(scope.sessionId), key = stewardBindingKey(binding);
        const resources = this.resources(scope.sessionId);
        const versions = revision(resources.map(resource => [resource.id, resource.revision]));
        return { revision: revision({ key, versions }),
          items: resources.map(({ content: _, ...resource }) => ({ ...resource, adapterId: STEWARD_MEMORY_SOURCE,
            binding: { kind: "steward-native-session", sessionId: scope.sessionId } })),
          checkCurrent: () => {
            try { return !this.disposed && this.registered && stewardBindingKey(this.bindingForSession(scope.sessionId)) === key &&
              revision(this.resources(scope.sessionId).map(resource => [resource.id, resource.revision])) === versions; }
            catch { return false; }
          } };
      },
    };
  }
  close() { this.disposed = true; this.stop?.(); }
}

