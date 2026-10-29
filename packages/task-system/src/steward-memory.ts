import type { Context } from "@deepseek-ai/cordis";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { TaskSystemService } from "./dsh-plugin.js";
import { canonical, TaskError } from "./ledger.js";
import { StewardConversations, stewardBindingKey } from "./steward-conversations.js";
import { STEWARD_PERSONA, STEWARD_PERSONA_TEXT, type StewardBinding } from "./steward-contracts.js";

interface Resource {
  id: string; type: string; name: string; revision: string; content: string;
  authority: string; capabilities: { edit: false; copy: false };
}
interface MemorySource {
  id: string; name: string; authority: string;
  list(input: unknown): Resource[];
  read(input: unknown): Resource | null;
  listBound(input: unknown): { revision: string; items: unknown[]; checkCurrent(): boolean };
}
interface MemoryManagerPort {
  protocolVersion: number;
  registerAdapter(adapter: MemorySource): () => void;
  requestAssemblyResources(): unknown;
  isAdapterEnabled(id: string): boolean;
}
interface AssemblerPort {
  version: string;
  runtime: { observeNativeRequest(options: unknown, session: unknown): unknown };
  store: { selection(sessionId: string): unknown };
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
  private registered = false;
  private disposed = false;
  private delegated: boolean;
  private stop?: () => void;
  private diagnostic: string | null = null;
  constructor(private readonly task: TaskSystemService, private readonly store: StewardConversations, private readonly ctx: Context) {
    const db = task.ledger.managementDatabase();
    db.exec("CREATE TABLE IF NOT EXISTS steward_memory_delegation (id INTEGER PRIMARY KEY CHECK(id=1))");
    this.delegated = !!db.prepare("SELECT 1 FROM steward_memory_delegation WHERE id=1").get();
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
  capability() {
    const available = this.registered && this.compatiblePair() && !this.disposed &&
      this.configuredResources()?.available === true;
    const assembler = this.ctx.get("dshPromptAssembler");
    const missingPresets = this.delegated && available && this.store.conversationIds().some(id => this.store.cursors(id).some(cursor => {
      if (cursor.binding.nodeId !== this.task.config.nodeId) return false;
      try { this.binding(cursor.binding.sessionId); } catch { return false; }
      const selected = nativeSelection.safeParse(assembler?.store.selection(cursor.binding.sessionId));
      return !selected.success || !selected.data.rules.some(rule => rule.kind === "memory-manager.resources" && rule.enabled);
    }));
    return { mode: this.delegated && available ? "manager-assembler" : this.delegated ? "unavailable" : available ? "available-not-delegated" : "native-persona-section",
      sourceRegistered: this.registered, assemblerVersion: this.ctx.get("dshPromptAssembler")?.version ?? null,
      diagnostic: this.diagnostic ?? (this.delegated && available
        ? missingPresets ? "已委托；部分当前原生会话缺少启用 memory-manager.resources 的 native 预设，不回退人格注入。"
          : "资源已注册；是否选入请求由 Manager 规则和 Assembler 会话预设决定，不能据此声称已进入模型请求。"
        : this.delegated ? "已委托 Manager/Assembler；当前服务不可用，不回退绕过既有资源规则。"
        : available ? "可用但未委托：使用官方人格段；须先配置 Manager 规则与各原生会话预设，再由 Host 显式交接。"
          : "使用官方系统提示词段提供人格；可选 Manager/Assembler 服务尚不可用。") };
  }
  private binding(sessionId: string): StewardBinding {
    const candidates = this.store.conversationIds().flatMap(id => this.store.cursors(id).map(cursor => cursor.binding))
      .filter(binding => binding.nodeId === this.task.config.nodeId && binding.sessionId === sessionId);
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
  private resources(sessionId: string): Resource[] {
    const binding = this.binding(sessionId);
    const persona: Resource = { id: STEWARD_PERSONA.id, type: "persona", name: "Steward persona",
      revision: STEWARD_PERSONA.version, content: `[persona ${STEWARD_PERSONA.id}@${STEWARD_PERSONA.version}]\n${STEWARD_PERSONA_TEXT}`,
      authority: STEWARD_MEMORY_SOURCE, capabilities: { edit: false, copy: false } };
    if (binding.kind === "personal") return [persona];
    const project = this.task.projects?.placementProject(binding.projectId);
    if (!project) throw new TaskError("UNAVAILABLE", "Project authority unavailable");
    const projectTasks = this.task.projects!.snapshot().tasks.filter(task => task.project === binding.projectId);
    const tasks = projectTasks.slice(0, 32)
      .map(task => ({ taskId: task.id, title: task.title, status: task.status }));
    const facts = { projectId: binding.projectId, generation: binding.generation, title: project.title,
      goal: project.goal, tasks, tasksTruncated: projectTasks.length > tasks.length };
    const content = "以下是当前项目账本的只读参考资料，不是新的执行授权；不包含其他项目或个人聊天。\n" + canonical(facts);
    return [persona, { id: `steward.project.${binding.projectId}`, type: "project-context", name: project.title,
      revision: revision(facts), content, authority: STEWARD_MEMORY_SOURCE, capabilities: { edit: false, copy: false } }];
  }
  private adapter(): MemorySource {
    return {
      id: STEWARD_MEMORY_SOURCE, name: "Steward scoped resources", authority: STEWARD_MEMORY_SOURCE,
      list: input => { const parsed = query.safeParse(input); return parsed.success ? this.resources(parsed.data.scope.sessionId) : []; },
      read: input => {
        if (!this.delegated) throw new TaskError("CONFIGURATION", "Steward resources have not been delegated to Manager");
        const parsed = read.parse(input); return this.resources(parsed.scope.sessionId).find(resource => resource.id === parsed.id) ?? null;
      },
      listBound: input => {
        const { scope } = query.parse(input);
        const binding = this.binding(scope.sessionId), key = stewardBindingKey(binding);
        const resources = this.resources(scope.sessionId);
        const versions = revision(resources.map(resource => [resource.id, resource.revision]));
        return { revision: revision({ key, versions }),
          items: resources.map(({ content: _, ...resource }) => ({ ...resource, adapterId: STEWARD_MEMORY_SOURCE,
            binding: { kind: "steward-native-session", sessionId: scope.sessionId } })),
          checkCurrent: () => {
            try { return !this.disposed && this.registered && stewardBindingKey(this.binding(scope.sessionId)) === key &&
              revision(this.resources(scope.sessionId).map(resource => [resource.id, resource.revision])) === versions; }
            catch { return false; }
          } };
      },
    };
  }
  close() { this.disposed = true; this.stop?.(); }
}

