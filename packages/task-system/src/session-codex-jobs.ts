import { createHash } from "node:crypto";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

type JobState = "running" | "stopping" | "completed" | "killed" | "failed";
export interface CodexJobRecord {
  id: string;
  jobId: string;
  title: string;
  model?: string;
  seq: number;
  startedAt: number;
  acknowledgedAt: number;
  returnedAt?: number;
  commandHash: string;
  state?: JobState;
  exitCode?: number;
}
/** Minimal optional ctx.jobs contract; never consume output or control a job. */
export interface SessionJobRegistry {
  list(sessionId: string): readonly {
    id: string; owner?: string; label: string; startedAt: number; finishedAt?: number;
    status: JobState; detail?: string;
  }[];
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const textOf = (content: readonly { type: string; text?: string }[]) =>
  content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");

// Deliberately recognize direct executables and literal PowerShell assignments only.
// Reading a Codex log, mentioning Codex in a prompt, or `exec --help` is not dispatch.
function isCodexExec(command: string) {
  if (/\bexec\s+(?:--help|-h|help)\b/i.test(command)) return false;
  const executable = String.raw`(?:[\w.:/\\-]*[/\\])?codex(?:\.exe|\.cmd)?`;
  if (new RegExp(String.raw`(?:^|[;|\n])\s*(?:&\s*)?["']?${executable}["']?\s+exec\b`, "i").test(command)) return true;
  for (const match of command.matchAll(new RegExp(String.raw`\$(\w+)\s*=\s*["']${executable}["']`, "gi"))) {
    if (new RegExp(String.raw`&\s*\$${match[1]}\s+exec\b`, "i").test(command.slice(match.index! + match[0].length))) return true;
  }
  return false;
}

function updateState(job: CodexJobRecord, text: string, time: number) {
  const matches = [...text.matchAll(/\[status: (running|stopping|completed|killed|failed)(?:, ([^\]\r\n]*))?\]/g)];
  const match = matches.at(-1);
  if (!match) return;
  // A replayed running observation cannot undo a terminal notice.
  if (["completed", "killed", "failed"].includes(job.state ?? "")) return;
  job.state = match[1] as JobState;
  if (["completed", "killed", "failed"].includes(job.state) && Number.isFinite(time)) job.returnedAt = time;
  const code = match[2]?.match(/\bexit code: (-?\d+)\b/);
  if (code) job.exitCode = Number(code[1]);
}

/** Read only paired tool receipts and host-authored job notices, never assistant claims. */
export function sessionCodexJobs(events: readonly SessionEvent[]): CodexJobRecord[] {
  const calls = new Map<string, { event: Extract<SessionEvent, { type: "tool/call" }>; args: Record<string, unknown> }>();
  const jobs: CodexJobRecord[] = [], current = new Map<string, CodexJobRecord>();
  const notice = (message: { source?: { kind: string }; content: readonly { type: string; text?: string }[] }, time: number) => {
    if (message.source?.kind !== "tool-jobs") return;
    const text = textOf(message.content), id = text.match(/^background job ([\w-]+)\b/)?.[1];
    const job = id && current.get(id);
    if (job) updateState(job, text, time);
  };
  for (const event of events) {
    if (event.type === "tool/call" && ["pwsh", "bash", "job_output", "job_kill"].includes(event.data.name)) {
      try { calls.set(event.data.callId, { event, args: JSON.parse(event.data.arguments) }); } catch { /* Incomplete call. */ }
    } else if (event.type === "tool/result") {
      const call = calls.get(event.data.message.toolCallId);
      calls.delete(event.data.message.toolCallId);
      if (!call || event.data.message.isError || event.data.error) continue;
      const text = textOf(event.data.message.content);
      if (["pwsh", "bash"].includes(call.event.data.name)) {
        const command = call.args.command;
        if (typeof command !== "string" || !isCodexExec(command)) continue;
        const jobId = text.match(/^started background job ([\w-]+)\s*$/)?.[1]
          ?? text.match(/\[still running after \d+ms; moved to background job ([\w-]+)\]/)?.[1];
        if (!jobId) continue;
        const job: CodexJobRecord = {
          id: `shell-codex:${call.event.seq}:${call.event.data.callId}`, jobId,
          title: typeof call.args.description === "string" ? call.args.description.slice(0, 240) : "Codex CLI 执行",
          model: command.match(/(?:^|\s)(?:-m|--model)\s+["']?([\w.-]+)/)?.[1],
          seq: call.event.seq, startedAt: call.event.time, acknowledgedAt: event.time,
          commandHash: hash(command), state: "running",
        };
        jobs.push(job); current.set(jobId, job);
      } else {
        const job = typeof call.args.job_id === "string" && current.get(call.args.job_id);
        if (!job) continue;
        if (call.event.data.name === "job_kill" && text === `requested cancellation of job ${job.jobId}`) job.state = "stopping";
        else updateState(job, text, event.time);
      }
    } else if (event.type === "user/message") notice(event.data, event.time);
    else if (event.type === "agent/inbox/spliced") for (const message of event.data.inserted) notice(message, event.time);
  }
  return jobs;
}

export function codexJobRows(records: readonly CodexJobRecord[], sessionId: string, registry?: SessionJobRegistry) {
  const live = registry?.list(sessionId) ?? [];
  return records.map(record => {
    // Job IDs restart with the host. Match owner, command and registration window too.
    const current = live.find(job => job.owner === sessionId && job.id === record.jobId
      && job.startedAt >= record.startedAt && job.startedAt <= record.acknowledgedAt
      && hash(job.label) === record.commandHash);
    const state = current?.status ?? (["completed", "killed", "failed"].includes(record.state ?? "") ? record.state : undefined);
    const exitCode = current?.detail?.match(/\bexit code: (-?\d+)\b/)?.[1] ?? record.exitCode;
    const status = state === "completed" ? (exitCode !== undefined && Number(exitCode) !== 0 ? "error" : "handled")
      : state === "failed" ? "error" : state === "killed" ? "cancelled"
        : state === "stopping" ? "cancelling" : state === "running" ? "running" : "unknown";
    const stateLabel = ({ handled: "进程已结束（未验收）", error: "进程异常", cancelled: "进程已取消", cancelling: "取消中", running: "执行中", unknown: "状态待核实" })[status];
    const returnedAt = current?.finishedAt ?? record.returnedAt;
    return {
      id: record.id, title: record.title, status, stateLabel, direct: true,
      source: "codex-cli", node: "本机 · Codex CLI", model: record.model,
      time: new Date(record.startedAt).toISOString(),
      returnedAt: returnedAt !== undefined ? new Date(returnedAt).toISOString() : undefined,
      description: `由会话通过 shell 直接启动，后台任务 ${record.jobId}，轨迹事件 #${record.seq}。`,
      report: `未进入 task-system 任务账本。${stateLabel}${exitCode !== undefined ? `；shell 退出码 ${exitCode}` : ""}。进程状态不代表 Codex 的结果或任务验收。${status === "unknown" ? "当前进程已无法从后台任务注册表核实；不会将历史运行状态当作仍在执行。" : ""}`,
    };
  });
}
