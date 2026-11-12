import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError, type TaskLedger } from "./ledger.js";
import {
  stewardScope,
  type StewardMessage,
  type StewardSend,
  type StewardSnapshot,
} from "./steward-contracts.js";
import type { StewardConversations } from "./steward-conversations.js";
const key = z.string().min(1).max(160),
  choice = z.strictObject({ id: key, token: key });
export const stewardCorrectionRead = z.strictObject({
  conversationId: key,
  messageId: key,
});
export const stewardCorrect = z.strictObject({
  commandId: key.max(120),
  conversationId: key,
  messageId: key,
  expectedRevision: z.number().int().nonnegative(),
  resumeCorrectionId: key.optional(),
  expectedCorrectionRevision: z.number().int().nonnegative().optional(),
  target: stewardScope,
  recipient: choice.optional(),
});
export const stewardCorrectionHandoff = z.strictObject({
  commandId: key.max(120),
  conversationId: key,
  correctionId: key,
  sourceMessageId: key,
  expectedSourceRevision: z.number().int().nonnegative(),
  excerpt: z.string().min(1).max(2000),
  text: z.string().trim().min(1).max(8000),
  includeAttachments: z.boolean().default(false),
});
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Proof = { canRetarget: boolean; reason: string; pending?: boolean };
type Correction = {
  revision: number;
  needsRecipient?: boolean;
  correctionId: string;
  originalMessageId: string;
  requestMessageId: string;
  target: z.infer<typeof stewardScope>;
  recipient?: z.infer<typeof choice>;
  kind: "retargeted" | "review-required";
  messageId?: string;
  state?: StewardMessage["state"];
  notice: string;
};
interface CorrectionHost {
  authorize(
    scope: z.infer<typeof stewardScope>,
    conversationId: string,
  ): Promise<unknown>;
  proof(message: StewardMessage, withdraw: boolean): Proof;
  target(
    input: {
      conversationId: string;
      target: z.infer<typeof stewardScope>;
      recipient?: z.infer<typeof choice>;
    },
    material?: StewardMessage,
    reviewOnly?: boolean,
  ): Promise<{
    target: z.infer<typeof stewardScope>;
    recipient: z.infer<typeof choice>;
  }>;
  submit(
    request: StewardSend,
    material: StewardMessage,
    reviewOnly: boolean,
  ): Promise<StewardSnapshot>;
}

/** Corrects discussion delivery without rewriting its audit or inventing a stopped execution. */
export class StewardCorrections {
  private readonly db;
  private readonly jobs = new Map<string, Promise<Correction>>();
  constructor(
    ledger: Pick<TaskLedger, "managementDatabase">,
    private readonly store: StewardConversations,
    private readonly host: CorrectionHost,
  ) {
    this.db = ledger.managementDatabase();
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS steward_corrections(command TEXT PRIMARY KEY,input TEXT NOT NULL,data TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS steward_correction_resumes(command TEXT PRIMARY KEY,input TEXT NOT NULL,operation TEXT NOT NULL,result TEXT);
      CREATE TABLE IF NOT EXISTS steward_correction_material(operation TEXT PRIMARY KEY,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steward_correction_claims(message TEXT PRIMARY KEY,command TEXT NOT NULL); CREATE TABLE IF NOT EXISTS steward_handoff_commands(command TEXT PRIMARY KEY,input TEXT NOT NULL);`);
  }
  get active() {
    return this.jobs.size > 0;
  }
  async drain() {
    await Promise.allSettled([...this.jobs.values()]);
  }
  private original(message: StewardMessage) {
    if (message.role === "user") return message;
    if (message.replyTo) {
      const parent = this.store.message(message.replyTo);
      if (
        parent.role === "user" &&
        parent.conversationId === message.conversationId
      )
        return parent;
    }
    return message;
  }
  async options(input: unknown) {
    const request = stewardCorrectionRead.parse(input),
      message = this.store.message(request.messageId);
    if (message.conversationId !== request.conversationId)
      throw new TaskError(
        "FORBIDDEN",
        "Message belongs to another conversation",
      );
    await this.host.authorize(message.scope, request.conversationId);
    const original = this.original(message),
      proof = this.host.proof(original, false);
    const existing = this.db
      .prepare(
        "SELECT data,result FROM steward_corrections WHERE command=(SELECT command FROM steward_correction_claims WHERE message=?)",
      )
      .get(original.id);
    const correction: Correction | null = existing ? JSON.parse(String(existing.result ?? existing.data)) : null;
    return {
      message, original, ...proof,
      ...(correction?.needsRecipient ? { canRetarget: false, pending: false } : {}),
      correction,
    };
  }
  async correct(input: unknown): Promise<Correction> {
    const request = stewardCorrect.parse(input);
    if (Boolean(request.resumeCorrectionId) !== (request.expectedCorrectionRevision !== undefined))
      throw new TaskError("CONFLICT", "续接纠正需要原操作及其当前版本。");
    const operation = request.resumeCorrectionId ?? request.commandId;
    const active = this.jobs.get(operation);
    if (active) {
      await active;
      return this.correct(request);
    }
    const job = (request.resumeCorrectionId ? this.resume(request) : this.performCorrection(request))
      .finally(() => this.jobs.delete(operation));
    this.jobs.set(operation, job);
    return job;
  }
  private async performCorrection(input: unknown): Promise<Correction> {
    const request = stewardCorrect.parse(input),
      encoded = canonical(request),
      previous = this.db
        .prepare(
          "SELECT input,data,result FROM steward_corrections WHERE command=?",
        )
        .get(request.commandId);
    if (this.db.prepare("SELECT command FROM steward_correction_resumes WHERE command=?").get(request.commandId))
      throw new TaskError("CONFLICT", "此命令已用于续接纠正。");
    if (previous && previous.input !== encoded)
      throw new TaskError(
        "CONFLICT",
        "Correction command changed its contents",
      );
    const message = this.store.message(request.messageId);
    if (message.conversationId !== request.conversationId)
      throw new TaskError(
        "FORBIDDEN",
        "Message belongs to another conversation",
      );
    await this.host.authorize(message.scope, request.conversationId);
    await this.host.authorize(request.target, request.conversationId);
    if (previous?.result) return JSON.parse(String(previous.result));
    const observed = this.original(message),
      proofBefore = this.host.proof(observed, false);
    const target = previous
      ? undefined
      : proofBefore.canRetarget
        ? await this.host.target(request, observed, false)
        : {
            target: request.target,
            ...(request.recipient ? { recipient: request.recipient } : {}),
          };
    let value: Correction;
    if (previous) value = JSON.parse(String(previous.data));
    else {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const clicked = this.store.message(request.messageId);
        if (clicked.revision !== request.expectedRevision)
          throw new TaskError("CONFLICT", "消息状态已变化，请刷新后纠正。");
        const original = this.original(clicked),
          claim = this.db
            .prepare(
              "SELECT command FROM steward_correction_claims WHERE message=?",
            )
            .get(original.id);
        if (claim)
          throw new TaskError(
            "CONFLICT",
            "这条原请求已有纠正记录，请核对该记录而非重复改投。",
          );
        const proof = this.host.proof(original, false);
        if (proof.pending) throw new TaskError("BUSY", proof.reason);
        const canRetarget = proofBefore.canRetarget && proof.canRetarget;
        const kind = canRetarget ? "retargeted" : "review-required";
        value = {
          revision: 0,
          correctionId: request.commandId,
          originalMessageId: clicked.id,
          requestMessageId: original.id,
          target: target!.target,
          ...(target!.recipient ? { recipient: target!.recipient } : {}),
          kind,
          notice:
            kind === "retargeted"
              ? "已撤回尚未提交原生执行的待投请求，保留原记录并改投一次。"
              : "已记录纠正关系；原执行及其副作用不变。可明确移交所选资料，请目标会话先复核。",
        };
        this.db
          .prepare("INSERT INTO steward_correction_claims VALUES(?,?)")
          .run(original.id, request.commandId);
        if (canRetarget) {
          const verified = this.host.proof(original, true);
          if (!verified.canRetarget)
            throw new TaskError(
              "CONFLICT",
              "原请求已开始或登记状态变化，未改投。",
            );
          this.store.withdrawBeforeAdmission(
            original.id,
            original.revision,
            request.commandId,
          );
        }
        this.db.prepare("INSERT INTO steward_correction_material VALUES(?,?)")
          .run(request.commandId, this.materialDigest(original));
        this.db
          .prepare("INSERT INTO steward_corrections VALUES(?,?,?,NULL)")
          .run(request.commandId, encoded, canonical(value));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return this.deliver(value, request.conversationId);
  }
  private materialDigest(message: StewardMessage) {
    return digest(canonical({text:message.text,content:message.content,selection:message.selection,
      permission:message.permission,quote:message.quote,scope:message.scope,source:message.source,
      routingClarification:message.routingClarification,contextEvidence:message.contextEvidence,sourceContextWithheld:message.sourceContextWithheld,
      commandId:message.commandId}));
  }
  private command(operation: string) { return "corrected-" + digest(operation).slice(0, 32); }
  private async deliver(value: Correction, conversationId: string): Promise<Correction> {
    if (value.kind === "retargeted") {
      const original = this.store.message(value.requestMessageId), commandId = this.command(value.correctionId);
      let delivered = this.store.commandMessage(conversationId, commandId);
      if (!delivered && value.needsRecipient) return value;
      if (!delivered) {
        try {
          await this.host.submit({ conversationId, commandId, text: original.text, target: value.target,
            ...(value.recipient ? {recipient:value.recipient} : {}) }, original, false);
        } catch {
          // Canonical acceptance is the boundary: a lost acknowledgement never authorizes a second delivery.
        }
        delivered = this.store.commandMessage(conversationId, commandId);
      }
      if (!delivered) {
        value = {...value,revision:value.revision+1,needsRecipient:true,
          notice:"原请求已安全撤回，新接收会话尚未登记。请重新选择承接会话，续接同一次纠正；不要重发原任务。"};
        this.db.prepare("UPDATE steward_corrections SET data=? WHERE command=? AND result IS NULL")
          .run(canonical(value),value.correctionId);
        return value;
      }
      value = {...value,needsRecipient:false,messageId:delivered.id,state:delivered.state,
        notice:"已撤回未开始的原请求，并以同一次纠正登记到新接收会话。"};
    }
    this.db.prepare("UPDATE steward_corrections SET data=?,result=? WHERE command=?")
      .run(canonical(value),canonical(value),value.correctionId);
    return value;
  }
  private async resume(request: z.infer<typeof stewardCorrect>): Promise<Correction> {
    const operation = request.resumeCorrectionId!, encoded = canonical(request);
    if (operation === request.commandId) throw new TaskError("CONFLICT", "请使用新的续接命令。");
    const receipt = this.db.prepare("SELECT input,operation,result FROM steward_correction_resumes WHERE command=?")
      .get(request.commandId);
    if (receipt && (receipt.input !== encoded || receipt.operation !== operation))
      throw new TaskError("CONFLICT", "续接命令改变了内容。");
    if (this.db.prepare("SELECT command FROM steward_corrections WHERE command=?").get(request.commandId))
      throw new TaskError("CONFLICT", "此命令已用于另一纠正。");
    const row = this.db.prepare("SELECT data,result FROM steward_corrections WHERE command=?").get(operation);
    if (!row) throw new TaskError("NOT_FOUND", "纠正记录不存在。");
    let value: Correction = JSON.parse(String(row.result ?? row.data));
    const clicked = this.store.message(request.messageId), original = this.store.message(value.requestMessageId);
    if (clicked.conversationId !== request.conversationId || original.conversationId !== request.conversationId ||
      this.original(clicked).id !== original.id)
      throw new TaskError("FORBIDDEN", "续接对象不属于原纠正请求。");
    await this.host.authorize(clicked.scope, request.conversationId);
    await this.host.authorize(request.target, request.conversationId);
    if (receipt?.result) return JSON.parse(String(receipt.result));
    if (receipt) {
      // Resume after a crash at the durable control receipt, without changing its selected receiver.
      if (!row.result && value.revision !== request.expectedCorrectionRevision! + 1 &&
        !(value.needsRecipient && value.revision === request.expectedCorrectionRevision! + 2))
        throw new TaskError("CONFLICT", "这次续接已有更新的选择，请核对当前纠正记录。");
      value = row.result ? value : await this.deliver(value,request.conversationId);
      this.db.prepare("UPDATE steward_correction_resumes SET result=? WHERE command=?")
        .run(canonical(value),request.commandId);
      return value;
    }
    // An accepted canonical command may be reconciled, but can never change receiver or replay.
    if (this.store.commandMessage(request.conversationId,this.command(operation)))
      throw new TaskError("CONFLICT", "原纠正已登记到接收会话，不能重选或重放。");
    if (row.result || value.kind !== "retargeted" || !value.needsRecipient ||
      value.revision !== request.expectedCorrectionRevision || clicked.revision !== request.expectedRevision)
      throw new TaskError("CONFLICT", "纠正状态已变化，请刷新后核对。");
    const witness = this.db.prepare("SELECT digest FROM steward_correction_material WHERE operation=?").get(operation);
    const claim = this.db.prepare("SELECT command FROM steward_correction_claims WHERE message=?").get(original.id);
    if (claim?.command !== operation || original.state.kind !== "released" ||
      witness?.digest !== this.materialDigest(original))
      throw new TaskError("CONFLICT", "原请求撤回或冻结材料无法核对，未续接。");
    const selected = await this.host.target(request,original,false);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT data,result FROM steward_corrections WHERE command=?").get(operation);
      if (!current || current.data !== row.data || current.result ||
        this.store.message(request.messageId).revision !== request.expectedRevision ||
        this.store.commandMessage(request.conversationId,this.command(operation)) ||
        witness.digest !== this.materialDigest(this.store.message(original.id)))
        throw new TaskError("CONFLICT", "纠正状态已变化，未重复投递。");
      value = {...value,target:selected.target,recipient:selected.recipient,revision:value.revision+1,needsRecipient:false};
      this.db.prepare("INSERT INTO steward_correction_resumes VALUES(?,?,?,NULL)")
        .run(request.commandId,encoded,operation);
      this.db.prepare("UPDATE steward_corrections SET data=? WHERE command=? AND result IS NULL AND data=?")
        .run(canonical(value),operation,String(row.data));
      this.db.exec("COMMIT");
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
    value = await this.deliver(value,request.conversationId);
    this.db.prepare("UPDATE steward_correction_resumes SET result=? WHERE command=?")
      .run(canonical(value),request.commandId);
    return value;
  }
  async handoff(input: unknown): Promise<StewardSnapshot> {
    const request = stewardCorrectionHandoff.parse(input),
      row = this.db
        .prepare("SELECT data,result FROM steward_corrections WHERE command=?")
        .get(request.correctionId);
    if (!row)
      throw new TaskError("NOT_FOUND", "Correction record is unavailable");
    const correction: Correction = JSON.parse(String(row.result ?? row.data));
    const original = this.store.message(correction.requestMessageId),
      source = this.store.message(request.sourceMessageId);
    if (
      original.conversationId !== request.conversationId ||
      source.conversationId !== request.conversationId ||
      canonical(source.source) !== canonical(original.source)
    )
      throw new TaskError("FORBIDDEN", "移交资料不属于这条纠正关系的原会话。");
    if (
      source.revision !== request.expectedSourceRevision ||
      !source.text.includes(request.excerpt)
    )
      throw new TaskError("CONFLICT", "移交片段不是当前版本的精确原文。");
    await this.host.authorize(original.scope, request.conversationId);
    await this.host.authorize(correction.target, request.conversationId);
    const encoded = canonical(request),
      previous = this.db
        .prepare("SELECT input FROM steward_handoff_commands WHERE command=?")
        .get(request.commandId);
    if (previous && previous.input !== encoded)
      throw new TaskError("CONFLICT", "移交操作重试改变了原选段或附件范围。");
    this.db
      .prepare("INSERT OR IGNORE INTO steward_handoff_commands VALUES(?,?)")
      .run(request.commandId, encoded);
    const accepted = this.db
      .prepare("SELECT input FROM steward_handoff_commands WHERE command=?")
      .get(request.commandId);
    if (accepted?.input !== encoded)
      throw new TaskError("CONFLICT", "移交操作已有另一份内容。");
    await this.host.target(
      {
        conversationId: request.conversationId,
        target: correction.target,
        recipient: correction.recipient,
      },
      original,
      true,
    );
    return this.host.submit(
      {
        conversationId: request.conversationId,
        commandId: "handoff-" + digest(request.commandId).slice(0, 32),
        text: request.text,
        target: correction.target,
        ...(correction.recipient ? { recipient: correction.recipient } : {}),
        quote: {
          messageId: source.id,
          expectedRevision: source.revision,
          excerpt: request.excerpt,
        },
      },
      {
        ...original,
        content: request.includeAttachments ? original.content : [],
      },
      true,
    );
  }
}
