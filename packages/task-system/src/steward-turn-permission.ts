import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-permission-presets";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";

export const stewardPermission = z.strictObject({ preset: z.string().min(1).max(160),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]), approval: z.enum(["ask", "never"]) });
export type StewardPermission = z.infer<typeof stewardPermission>;
const stamp = z.strictObject({ preset: z.number().int(), sandbox: z.number().int(), approval: z.number().int() });
const baseline = stewardPermission.extend({ stamp, effectivePreset: z.string() });
const fact = z.discriminatedUnion("kind", [z.strictObject({kind:z.literal("preset"),value:z.string()}),
  z.strictObject({kind:z.literal("sandbox"),value:stewardPermission.shape.sandbox}),
  z.strictObject({kind:z.literal("approval"),value:stewardPermission.shape.approval})]);
const allowed = z.strictObject({preset:z.boolean(),sandbox:z.boolean(),approval:z.boolean()});
const marker = z.strictObject({ selection: stewardPermission, turn: z.number().int().optional(), baseline: baseline.optional(), applied: stamp.optional(), restoringFrom: baseline.optional(), applyingPlan:z.array(fact).optional(), restoringPlan:z.array(fact).optional(), restoringAllowed:allowed.optional() });
type Marker = z.infer<typeof marker>;
type Stamp = z.infer<typeof stamp>;
type Fact = z.infer<typeof fact>;
type Row = { request: string; session: string; state: string; value: Marker };

export class StewardTurnPermissions {
  private readonly restores = new Map<string, Promise<void>>();
  private readonly db: ReturnType<TaskLedger["managementDatabase"]>;
  constructor(private readonly ctx: Context, ledger: TaskLedger) {
    this.db = ledger.managementDatabase();
    this.db.exec("CREATE TABLE IF NOT EXISTS steward_turn_permissions(request TEXT PRIMARY KEY,session TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS steward_permission_session ON steward_turn_permissions(session,state)");
    ctx.inject(["tools"], scope => scope.tools.guard(exec => {
      if (!exec.agent || !this.db.prepare("SELECT 1 FROM steward_sources WHERE json_extract(data,'$.binding.sessionId')=? LIMIT 1").get(exec.agent.id)) return;
      if (!this.ctx.get("sandboxPolicy") || this.canWrite(exec.agent)) return;
      if (exec.name === "steward_create_project" || exec.name.startsWith("task_") && !["task_nodes", "task_query", "task_history", "task_wait", "task_alerts"].includes(exec.name) || exec.name.startsWith("project_") && exec.name !== "project_list") {
        if (exec.name === "task_execution_status" && z.object({action:z.literal("inspect")}).safeParse(exec.arguments).success) return;
        if (exec.name === "task_observations" && z.object({action:z.literal("list")}).safeParse(exec.arguments).success) return;
        if (exec.name === "task_session_message") {
          const input = z.object({ action: z.enum(["targets", "status"]) }).safeParse(exec.arguments);
          if (input.success) return;
        }
        return "The current request is read-only; orchestration writes are not allowed";
      }
    }));
    ctx.on("agent/inbox/claimed", payload => {
      if (payload.message.source.kind !== "user" || !("rpcId" in payload.message.source)) return;
      const row = this.row(payload.message.source.rpcId);
      if (row?.session === payload.agent.id && row.state === "pending") {
        row.value.turn = payload.turn;
        this.save(row, "claimed");
      }
    });
    ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
      if (context.agent) await this.prepare(context.agent);
      return next();
    }, { prepend: true });
    ctx.on("agent/pre-step", async (payload, next) => {
      await this.prepare(payload.agent);
      return next();
    });
    ctx.on("session/event", (session, event) => {
      if (event.type !== "turn/end") return;
      for (const row of this.entries(session.header.id)) if (row.value.turn === event.data.turn) {
        if (row.state === "claimed") { this.save(row, "cancelled"); continue; }
        queueMicrotask(() => { void this.restore(session, row).catch(error =>
          this.ctx.logger.warn(`Steward permission restoration needs reconciliation: ${String(error)}`)); });
      }
    });
    ctx.on("agent/created", async ({ agent }) => { await this.prepare(agent, true); }, { prepend: true });
  }
  get active() { return this.restores.size > 0; }
  async drain() { await Promise.allSettled(this.restores.values()); }
  catalog() { return this.service().catalog(); }
  resolve(preset: string): StewardPermission { const { sandbox, approval } = this.service().resolve(preset); return { preset, sandbox, approval }; }
  arm(agent: Agent, request: string, selection: StewardPermission | undefined): void {
    if (!selection) return;
    const actual = this.resolve(selection.preset);
    if (actual.sandbox !== selection.sandbox || actual.approval !== selection.approval)
      throw new TaskError("CONFLICT", "The permission preset changed; choose it again before sending");
    this.current(agent.session);
    const previous = this.row(request);
    if (previous) {
      if (previous.session !== agent.id || canonical(previous.value.selection) !== canonical(selection))
        throw new TaskError("CONFLICT", "The original request permission changed");
      if (previous.state !== "pending") throw new TaskError("CONFLICT", "The original permission-scoped request was already claimed");
      return;
    }
    this.db.prepare("INSERT INTO steward_turn_permissions VALUES(?,?,?,?)").run(request, agent.id, "pending", canonical({ selection }));
  }
  canWrite(agent: Agent, request?: string): boolean {
    const active = this.entries(agent.id);
    const original = request ? this.row(request) : undefined;
    if (original && (original.session !== agent.id || original.state !== "active")) return false;
    if (request && active.length && !active.some(row => row.request === request)) return false;
    const mode = this.ctx.get("sandboxPolicy")?.resolve({ session: agent.session }).mode;
    return mode !== undefined && mode !== "read-only";
  }
  private service() {
    const service = this.ctx.get("permissionPresets");
    if (!service) throw new TaskError("UNAVAILABLE", "Native permission presets are unavailable");
    return service;
  }
  private row(request: string): Row | undefined {
    const row = this.db.prepare("SELECT request,session,state,data FROM steward_turn_permissions WHERE request=?").get(request);
    return row ? { request: String(row.request), session: String(row.session), state: String(row.state), value: marker.parse(JSON.parse(String(row.data))) } : undefined;
  }
  private entries(session: string): Row[] {
    return this.db.prepare("SELECT request FROM steward_turn_permissions WHERE session=? AND state IN ('claimed','applying','active','restoring')").all(session)
      .flatMap(row => { const value = this.row(String(row.request)); return value ? [value] : []; });
  }
  private stamp(session: Session) {
    const result = { preset: -1, sandbox: -1, approval: -1 };
    for (const event of session.snapshotEvents()) {
      if (event.type === "permission/preset") result.preset = event.seq;
      if (event.type === "sandbox/mode") result.sandbox = event.seq;
      if (event.type === "approval/policy") result.approval = event.seq;
    }
    return result;
  }
  private current(session: Session) {
    const stamps = this.stamp(session), policy = this.ctx.get("sandboxPolicy"), approval = this.ctx.get("approval");
    if (!policy || !approval || Object.values(stamps).some(value => value < 0))
      throw new TaskError("UNAVAILABLE", "The native source must have initialized permission facts before using a request override");
    const raw = this.ctx.get("sessionProjections")?.stateOf(session, "permissions");
    if (!raw?.preset || !raw.sandbox || !raw.approval)
      throw new TaskError("UNAVAILABLE", "The native source permission facts are not initialized");
    return { preset: raw.preset, sandbox: raw.sandbox, approval: raw.approval, stamp: stamps, effectivePreset: this.service().current(session) };
  }
  private save(row: Row, state: string) {
    this.db.prepare("UPDATE steward_turn_permissions SET state=?,data=? WHERE request=?").run(state, canonical(row.value), row.request);
    row.state = state;
  }
  private async prepare(agent: Agent, creating = false) {
    await this.restores.get(agent.id);
    const events = agent.session.snapshotEvents();
    for (const row of this.entries(agent.id)) {
      const started = events.some(event => event.type === "turn/start" && event.data.turn === row.value.turn),
        ended = events.some(event => event.type === "turn/end" && event.data.turn === row.value.turn);
      if (ended || !started) {
        if (row.state === "claimed") this.save(row, "cancelled");
        else await this.restore(agent.session, row);
      } else if (creating) throw new TaskError("UNAVAILABLE", "An unfinished permission-scoped turn must be reconciled before this source can resume");
      else if (row.state === "claimed") {
        this.apply(agent, row);
        await this.flush(agent.session);
      } else if (row.state !== "active") throw new TaskError("UNAVAILABLE", "The permission-scoped turn could not be applied safely");
    }
  }
  private async flush(session: Session) {
    const sessions = this.ctx.get("sessions");
    if (!sessions) throw new TaskError("UNAVAILABLE", "Native session durability is unavailable");
    if (!await sessions.flush(session)) throw new TaskError("UNAVAILABLE", "Native permission durability was not acknowledged");
  }
  private apply(agent: Agent, row: Row) {
    const actual = this.resolve(row.value.selection.preset);
    if (actual.sandbox !== row.value.selection.sandbox || actual.approval !== row.value.selection.approval)
      throw new TaskError("CONFLICT", "The queued permission preset changed before execution");
    const previous = this.current(agent.session), selected = row.value.selection;
    row.value.baseline = previous;
    row.value.applyingPlan = [
      ...(previous.effectivePreset !== selected.preset ? [{kind:"preset" as const,value:selected.preset}] : []),
      ...(previous.sandbox !== selected.sandbox ? [{kind:"sandbox" as const,value:selected.sandbox}] : []),
      ...(previous.approval !== selected.approval ? [{kind:"approval" as const,value:selected.approval}] : []),
      {kind:"preset",value:selected.preset},
    ];
    this.save(row, "applying");
    this.service().set(agent.session, row.value.selection.preset);
    agent.session.append("permission/preset", { preset: row.value.selection.preset });
    row.value.applied = this.stamp(agent.session);
    this.save(row, "active");
  }
  private recoverApplied(session: Session, from: Stamp, plan: Fact[] | undefined): Stamp {
    if (!plan) throw new TaskError("UNAVAILABLE", "The permission transition plan is missing");
    const result = { ...from }; let index = 0;
    for (const event of session.snapshotEvents()) {
      if (event.seq <= Math.max(...Object.values(from))) continue;
      const observed = event.type === "permission/preset" ? {kind:"preset",value:event.data.preset}
        : event.type === "sandbox/mode" ? {kind:"sandbox",value:event.data.mode}
        : event.type === "approval/policy" ? {kind:"approval",value:event.data.policy} : undefined;
      if (!observed) continue;
      const expected = plan[index];
      if (!expected || expected.kind !== observed.kind || expected.value !== observed.value) break;
      result[expected.kind] = event.seq; index++;
    }
    return result;
  }
  private restore(session: Session, row: Row): Promise<void> {
    const previous = this.restores.get(session.header.id);
    if (previous) return previous;
    const job = this.restoreNow(session, row).finally(() => this.restores.delete(session.header.id));
    this.restores.set(session.header.id, job);
    return job;
  }
  private async restoreNow(session: Session, row: Row) {
    const previous = row.value.baseline;
    if (!previous) throw new TaskError("UNAVAILABLE", "The original permission baseline is missing");
    const applied = row.state === "restoring" && row.value.restoringFrom
      ? this.recoverApplied(session,row.value.restoringFrom.stamp,row.value.restoringPlan)
      : row.value.applied ?? this.recoverApplied(session,previous.stamp,row.value.applyingPlan), current = this.current(session);
    const prior = row.value.restoringAllowed ?? {preset:true,sandbox:true,approval:true};
    const sandboxOurs = prior.sandbox && current.stamp.sandbox === applied.sandbox,
      approvalOurs = prior.approval && current.stamp.approval === applied.approval,
      presetOurs = prior.preset && current.stamp.preset === applied.preset && sandboxOurs && approvalOurs;
    row.value.applied = applied;
    row.value.restoringFrom = current;
    row.value.restoringAllowed = {preset:presetOurs,sandbox:sandboxOurs,approval:approvalOurs};
    row.value.restoringPlan = [
      ...(sandboxOurs && current.sandbox !== previous.sandbox ? [{kind:"sandbox" as const,value:previous.sandbox}] : []),
      ...(approvalOurs && current.approval !== previous.approval ? [{kind:"approval" as const,value:previous.approval}] : []),
      ...(presetOurs ? [{kind:"preset" as const,value:previous.preset}] : []),
    ];
    this.save(row, "restoring");
    for (const entry of row.value.restoringPlan) {
      if (entry.kind === "sandbox") setSandboxMode(session,entry.value);
      else if (entry.kind === "approval") setApprovalPolicy(session,entry.value);
      else session.append("permission/preset",{preset:entry.value});
    }
    await this.flush(session);
    this.save(row, "restored");
  }
}
