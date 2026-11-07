import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Report } from "./contracts.js";
import type { TaskSystemService } from "./dsh-plugin.js";
import { canonical, TaskError } from "./ledger.js";
import type { StewardMessage } from "./steward-contracts.js";
import type { StewardConversations } from "./steward-conversations.js";

const key = z.string().min(1).max(200);
export const stewardProgressRead = z.strictObject({
  conversationId: key,
  messageIds: z.array(key).max(100),
});
export const stewardDocumentOpen = z.strictObject({
  conversationId: key,
  messageId: key,
  targetId: key,
});
const reportData = z.object({
  reportRelativePath: z.string().min(1).max(4096).optional(),
});
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export interface ProgressPresentation {
  taskTitle: string;
  summary: string;
  emphasis: "state" | "record" | "checkin";
  materialNotice?: string;
  needsDecision: boolean;
  targets: { id: string; kind: "file" | "record"; label: string }[];
}
type DocumentTarget =
  | {
      kind: "file";
      id: string;
      label: string;
      sessionId: string;
      path: string;
      reportId: string;
      version: string;
    }
  | {
      kind: "record";
      id: string;
      label: string;
      reportId: string;
      version: string;
      title: string;
      body: string;
      recordedAt: string;
      reportKind: Report["kind"];
    };

export class StewardProgress {
  constructor(
    private ctx: Context,
    private task: TaskSystemService,
    private store: StewardConversations,
    private authorize: (projectId: string) => void,
  ) {}
  bindContext(ctx: Context) {
    this.ctx = ctx;
  }
  private message(conversationId: string, messageId: string) {
    const message = this.store.message(messageId);
    if (
      message.conversationId !== conversationId ||
      message.role !== "notification" ||
      !message.provenance ||
      message.scope.kind !== "project"
    )
      throw new TaskError("FORBIDDEN", "这条进展不属于当前可查看的话题。");
    this.authorize(message.scope.projectId);
    if (
      this.task.ledger.projectForTask(message.provenance.taskId) !==
      message.scope.projectId
    )
      throw new TaskError("FORBIDDEN", "进展的项目归属已变化。");
    return message;
  }
  private summary(message: StewardMessage, reports: Report[]) {
    const provenance = message.provenance!;
    if (message.gate?.state === "awaiting-acceptance")
      return "结果已经送到，正在等你核对；后续工作尚未开始。";
    const event = this.task.ledger
      .managementDatabase()
      .prepare("SELECT data FROM events WHERE id=?")
      .get(provenance.eventId);
    const detail = z
      .object({
        type: z.string(),
        detail: z.object({ outcome: z.string().optional() }).passthrough(),
      })
      .safeParse(event ? JSON.parse(String(event.data)) : undefined);
    if (provenance.eventType === "acceptance.decided")
      return message.gate?.state === "released"
        ? "你已验收这次候选；后续工作仍按明确授权安排。"
        : "你要求继续修复，验收点尚未释放。";
    if (provenance.eventType === "acceptance.amended")
      return "修复要求已经修订，需要重新核对后再验收。";
    if (provenance.eventType === "acceptance.armed")
      return "已设置验收点，结果到达后会等你核对。";
    if (provenance.eventType === "acceptance.operation_admitted")
      return "后续规划请求已经登记，尚不表示工作完成。";
    if (provenance.eventType === "run.execution_started")
      return "已经开始处理这项工作。";
    if (provenance.eventType === "run.settled") {
      const outcome = detail.success ? detail.data.detail.outcome : undefined;
      if (outcome === "unknown") {
        const verified =
          provenance.runId &&
          this.task.ledger
            .managementDatabase()
            .prepare(
              "SELECT data FROM events WHERE run_id=? AND json_extract(data,'$.type')='run.reconciled' ORDER BY seq DESC LIMIT 1",
            )
            .get(provenance.runId);
        return verified
          ? "处理过程被打断，调度已核实这次执行停止；尚未收到正式结果。"
          : "处理过程被打断，尚未收到正式结果。";
      }
      if (outcome === "success")
        return reports.some(
          (report) =>
            report.kind === "result" && report.runId === provenance.runId,
        )
          ? "工作已提交结果，可以查看；这还不代表你已验收。"
          : "执行已经结束，但尚未收到可查看的正式结果。";
      return outcome === "blocked"
        ? "工作暂时遇到阻碍，调度会核实需要什么帮助。"
        : "这次没有完成工作，调度会核实原因与后续安排。";
    }
    if (provenance.eventType === "report.appended")
      return reports.some(
        (report) =>
          report.kind === "result" && report.runId === provenance.runId,
      )
        ? "已经收到执行结果，等待你查看。"
        : "调度补充了一条进度说明；它不是正式完成回执。";
    if (provenance.eventType === "run.reconciled")
      return "调度已核实这次执行停止，现有材料不代表任务已经完成。";
    if (provenance.eventType === "task.checkin_updated") {
      const checked = z
        .object({ detail: z.object({ observation: z.string() }) })
        .safeParse(event ? JSON.parse(String(event.data)) : undefined);
      return checked.success && checked.data.detail.observation === "blocked"
        ? "调度检查后记录了当前阻碍，具体说明可以展开查看。"
        : "调度已核对当前进展，并记录了后续安排。";
    }
    return provenance.eventType === "task.execution_check_queued"
      ? "已到计划检查时间，调度会核实进展。"
      : "这项工作的安排有了变化，可以展开查看依据。";
  }
  private reports(message: StewardMessage) {
    const provenance = message.provenance!;
    if (provenance.eventType === "report.appended") {
      const row = this.task.ledger
        .managementDatabase()
        .prepare("SELECT data FROM events WHERE id=?")
        .get(provenance.eventId);
      const event = z
        .object({ detail: z.object({ reportId: z.string() }) })
        .safeParse(row ? JSON.parse(String(row.data)) : undefined);
      if (!event.success) return [];
      const report = this.task.ledger.getReport(event.data.detail.reportId);
      return report.taskId === provenance.taskId ? [report] : [];
    }
    if (!provenance.runId) return [];
    return this.task.ledger
      .managementDatabase()
      .prepare(
        "SELECT id FROM entities WHERE kind='report' AND parent=? AND json_extract(data,'$.runId')=? ORDER BY (json_extract(data,'$.kind')='result') DESC,rowid DESC LIMIT 8",
      )
      .all(provenance.taskId, provenance.runId)
      .map((row) => this.task.ledger.getReport(String(row.id)));
  }
  private async targets(
    message: StewardMessage,
    reports: Report[],
    cache = new Map<string, { version: string; targets: DocumentTarget[] }>(),
  ): Promise<DocumentTarget[]> {
    const targets: DocumentTarget[] = [];
    for (const report of reports) {
      const version = hash(report),
        recordId = hash({ kind: "record", reportId: report.reportId, version }),
        cached = cache.get(report.reportId);
      if (cached?.version === version) {
        targets.push(...cached.targets);
        continue;
      }
      const first = targets.length;
      targets.push({
        kind: "record",
        id: recordId,
        label: report.kind === "result" ? "查看结果记录" : "查看进度记录",
        reportId: report.reportId,
        version,
        title: report.title,
        body: report.body,
        recordedAt: report.recordedAt,
        reportKind: report.kind,
      });
      if (!report.sessionId) continue;
      const binding = this.task.ledger
        .sessionMessageTargets(report.taskId)
        .find(
          (target) =>
            target.sessionId === report.sessionId &&
            target.nodeId === this.task.config.nodeId,
        );
      if (!binding) continue;
      const stored = await this.ctx
        .get("sessionPersistence")
        ?.stat(SessionId(report.sessionId));
      if (!stored?.header.cwd || stored.header.id !== report.sessionId)
        continue;
      const data = reportData.safeParse(report.data),
        body = report.body.slice(0, 12000);
      const paths =
        data.success && data.data.reportRelativePath
          ? [data.data.reportRelativePath]
          : [
              ...[
                ...body.matchAll(
                  /(?:研究报告|报告|文件)(?:绝对)?路径\s*[:：]\s*(?:<([^>]+)>|([^\r\n。；;]+))/gu,
                ),
              ].map((match) => (match[1] ?? match[2] ?? "").trim()),
              ...[
                ...body.matchAll(
                  /\[([^\]]*(?:报告|文件|成果|report|artifact)[^\]]*)\]\(<?([^)>]+)>?\)/giu,
                ),
              ].map((match) => (match[2] ?? "").trim()),
            ];
      for (const path of [...new Set(paths)].slice(0, 4)) {
        try {
          const cwd = realpathSync(stored.header.cwd),
            absolute = realpathSync(resolve(cwd, path)),
            inside = relative(cwd, absolute);
          if (
            isAbsolute(inside) ||
            inside === ".." ||
            inside.startsWith(".." + sep) ||
            !statSync(absolute).isFile()
          )
            continue;
          const id = hash({
            kind: "file",
            reportId: report.reportId,
            version,
            sessionId: report.sessionId,
            path: absolute,
          });
          targets.push({
            kind: "file",
            id,
            label: /研究报告|调研报告|研究稿|research[ _-]*report/i.test(
              report.title + " " + basename(absolute),
            )
              ? "查看研究报告"
              : "查看文件",
            sessionId: report.sessionId,
            path: absolute,
            reportId: report.reportId,
            version,
          });
        } catch {}
      }
      cache.set(report.reportId, { version, targets: targets.slice(first) });
      if (hash(this.task.ledger.getReport(report.reportId)) !== version)
        throw new TaskError("CONFLICT", "进度记录已变化，请刷新后再查看。");
    }
    this.message(message.conversationId, message.id);
    return targets;
  }
  async read(input: unknown) {
    const request = stewardProgressRead.parse(input),
      result = [],
      cache = new Map<string, { version: string; targets: DocumentTarget[] }>();
    for (const id of request.messageIds) {
      const message = this.message(request.conversationId, id),
        reports = this.reports(message),
        targets = await this.targets(message, reports, cache);
      const files = targets.filter((target) => target.kind === "file");
      let summary = this.summary(message, reports);
      const materialNotice = files.length
        ? reports.some((report) => report.kind === "result")
          ? "已有结果文件可以查看，仍需你核对。"
          : files.some((file) => file.label === "查看研究报告")
            ? "已有一份研究稿，可以先阅读。"
            : "已有工作文件可以查看。"
        : undefined;
      const presentation: ProgressPresentation = {
        taskTitle: this.task.ledger.getTask(message.provenance!.taskId).title,
        summary,
        emphasis: message.provenance!.eventType.startsWith("run.")
          ? "state"
          : message.provenance!.eventType === "report.appended"
            ? "record"
            : "checkin",
        ...(materialNotice ? { materialNotice } : {}),
        needsDecision: !!message.gate,
        targets: targets.map(({ id, kind, label }) => ({ id, kind, label })),
      };
      result.push({ messageId: id, presentation });
    }
    return result;
  }
  async open(input: unknown) {
    const request = stewardDocumentOpen.parse(input),
      message = this.message(request.conversationId, request.messageId),
      targets = await this.targets(message, this.reports(message)),
      target = targets.find((target) => target.id === request.targetId);
    if (!target)
      throw new TaskError(
        "NOT_FOUND",
        "这份记录或研究文件目前不可查看，请刷新进展。",
      );
    return {
      ...target,
      source: {
        taskId: message.provenance!.taskId,
        projectId:
          message.scope.kind === "project" ? message.scope.projectId : "",
        messageId: message.id,
      },
      ...(target.kind === "file" ? { name: basename(target.path) } : {}),
    };
  }
}
