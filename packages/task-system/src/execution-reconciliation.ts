import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError } from "./ledger.js";
import type { Run, Attempt } from "./contracts.js";
import type { TaskSystemService } from "./dsh-plugin.js";

const key = z.string().min(1).max(200);
export const ExecutionStatusRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("inspect"), taskId: key, runId: key }),
  z.strictObject({
    action: z.literal("reconcile"),
    taskId: key,
    runId: key,
    commandId: key,
    expectedEvidenceVersion: key,
    expectedActionVersion: key,
  }),
]);
type Request = z.infer<typeof ExecutionStatusRequest>;
const authFailureEvidence = z.strictObject({
  kind: z.literal("native-auth-zero-tools-v1"),
  coordinatorSessionId: key,
  nodeId: key,
  sessionId: key,
  attemptId: key,
  executionId: key,
  fence: z.number().int().positive(),
  turn: z.number().int().positive(),
  fromSeq: z.number().int().nonnegative(),
  terminalSeq: z.number().int().nonnegative(),
  code: z.literal("AUTH"),
  httpStatus: z.literal(401),
  toolCallCount: z.literal(0),
  actionVersion: key,
  evidenceVersion: key,
});
const interruptedStopEvidence = z.strictObject({
  kind: z.literal("native-interrupted-stopped-v1"),
  coordinatorSessionId: key,
  nodeId: key,
  sessionId: key,
  attemptId: key,
  executionId: key,
  fence: z.number().int().positive(),
  interruptionCommandId: key,
  interruptedAt: z.iso.datetime(),
  eventCount: z.number().int().nonnegative().max(2000),
  lastSeq: z.number().int().min(-1),
  businessResult: z.literal("unproven"),
  actionVersion: key,
  evidenceVersion: key,
});
const nativeFailureEvidence = z.discriminatedUnion("kind", [
  authFailureEvidence,
  interruptedStopEvidence,
]);
export type NativeFailureEvidence = z.infer<typeof nativeFailureEvidence>;
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const reconciliationCommand = (sessionId: string, commandId: string) =>
  `execution-reconcile:${digest({ sessionId, commandId })}`;

export type NativeFailureFacts =
  | {
      proven: true;
      turn: number;
      fromSeq: number;
      terminalSeq: number;
      code: "AUTH";
      httpStatus: 401;
      toolCallCount: 0;
    }
  | { proven: false; reason: string };

export function nativeFailureFacts(
  events: readonly SessionEvent[],
  reference: {
    taskId: string;
    runId: string;
    attemptId: string;
    provider: string;
    model: string;
  },
): NativeFailureFacts {
  const unknown = (reason: string): NativeFailureFacts => ({
    proven: false,
    reason,
  });
  if (
    events.length > 2000 ||
    events.some((event, index) => event.seq !== index)
  )
    return unknown("原生记录超出本次有界核实范围或前缀不完整。");
  const instructions = events.filter(
    (event) =>
      event.type === "user/message" &&
      event.data.source.kind === "dsh-task" &&
      event.data.source.form === "instructions" &&
      event.data.source.taskId === reference.taskId &&
      event.data.source.runId === reference.runId &&
      event.data.source.attemptId === reference.attemptId,
  );
  const instructionTurns = new Set(
    instructions.map(
      (input) =>
        events.findLast(
          (event) => event.type === "turn/start" && event.seq < input.seq,
        )?.seq,
    ),
  );
  if (
    !instructions.length ||
    instructionTurns.size !== 1 ||
    instructionTurns.has(undefined)
  )
    return unknown(
      "缺少唯一对应当前 attempt 的原生任务轮次；不能借同会话其他轮次结算。",
    );
  const start = events.find((event) => instructionTurns.has(event.seq));
  const terminal =
    start?.type === "turn/start"
      ? events.findLast(
          (event) =>
            event.type === "turn/end" && event.data.turn === start.data.turn,
        )
      : undefined;
  if (
    start?.type !== "turn/start" ||
    terminal?.type !== "turn/end" ||
    terminal.data.turn !== start.data.turn ||
    terminal.data.reason.kind !== "error"
  )
    return unknown("对应原生轮次尚无完整错误终止证据，或会话已出现后续轮次。");
  const metadataTail = new Set(["session/end-seed", "model/selection"]);
  if (
    events.some(
      (event) => event.seq > terminal.seq && !metadataTail.has(event.type),
    )
  )
    return unknown(
      "目标轮次后出现新的执行事件或尚未支持的尾部事件；保留结果未知。",
    );
  const turn = events.filter(
    (event) => event.seq >= start.seq && event.seq <= terminal.seq,
  );
  const error = z
    .object({ code: z.literal("AUTH"), status: z.literal(401) })
    .safeParse(terminal.data.reason.error);
  const requests = turn.filter((event) => event.type === "request/header");
  const metadataKinds = new Set([
    "agent-instructions",
    "runtime-context",
    "skill-catalog",
    "time-context",
  ]);
  const causal = turn
    .filter((event) => event.type === "user/message")
    .every((event) => {
      if (event.type !== "user/message") return false;
      const source = event.data.source;
      return source.kind === "dsh-task"
        ? source.taskId === reference.taskId &&
            source.runId === reference.runId &&
            source.attemptId === reference.attemptId
        : metadataKinds.has(source.kind);
    });
  if (
    !error.success ||
    !causal ||
    requests.length !== 1 ||
    turn.some(
      (event) =>
        event.type === "tool/call" ||
        event.type === "tool/result" ||
        event.type === "assistant/message",
    )
  )
    return unknown(
      "本次仅能自动核实启动期 AUTH/401 且无模型输出或工具调用的失败；其他异常需更多可信执行证据。",
    );
  const request = requests[0];
  if (
    request?.type !== "request/header" ||
    request.data.header.config.provider !== reference.provider ||
    request.data.header.config.model !== reference.model
  )
    return unknown("原生请求模型与当前运行路由不一致。");
  return {
    proven: true,
    turn: start.data.turn,
    fromSeq: start.seq,
    terminalSeq: terminal.seq,
    code: "AUTH",
    httpStatus: 401,
    toolCallCount: 0,
  };
}

export function interruptedStopFacts(
  service: TaskSystemService,
  run: Run,
  attempt: Attempt,
  events: readonly SessionEvent[],
) {
  if (
    run.state !== "uncertain" ||
    attempt.state !== "uncertain" ||
    !attempt.executionId ||
    events.length > 2000 ||
    events.some((event, index) => event.seq !== index) ||
    run.resultSummary !==
      "Native execution interrupted: native-runtime-error" ||
    service.results.get(`native-result:${attempt.attemptId}`)
  )
    return;
  const ledger = service.ledger,
    db = ledger.managementDatabase();
  const interruptionCommandId = `interrupted:${attempt.attemptId}`;
  const ref = {
    runId: run.runId,
    attemptId: attempt.attemptId,
    nodeId: attempt.nodeId,
    fence: attempt.fence,
    executionId: attempt.executionId,
  };
  const interrupted = ledger.commandReceipt<Run>(interruptionCommandId);
  if (
    !interrupted ||
    !ledger.commandMatches(interruptionCommandId, "submit", {
      ...ref,
      outcome: "unknown",
      summary: "Native execution interrupted: native-runtime-error",
    }) ||
    interrupted.value.runId !== run.runId ||
    interrupted.value.taskId !== run.taskId ||
    interrupted.value.currentAttemptId !== attempt.attemptId ||
    interrupted.value.state !== "uncertain"
  )
    return;
  if (
    db
      .prepare(
        "SELECT 1 FROM events WHERE run_id=? AND json_extract(data,'$.type')='run.execution_started' LIMIT 1",
      )
      .get(run.runId)
  )
    return;
  const settled = db
    .prepare(
      "SELECT data FROM events WHERE run_id=? AND json_extract(data,'$.type')='run.settled' ORDER BY seq DESC LIMIT 1",
    )
    .get(run.runId);
  const parsed = z
    .object({
      at: z.iso.datetime(),
      detail: z.object({
        outcome: z.literal("unknown"),
        summary: z.literal(
          "Native execution interrupted: native-runtime-error",
        ),
      }),
    })
    .safeParse(settled ? JSON.parse(String(settled.data)) : undefined);
  if (!parsed.success) return;
  const transactionMs =
    Date.parse(parsed.data.at) - Date.parse(interrupted.acceptedAt);
  if (
    transactionMs < 0 ||
    transactionMs > 30_000 ||
    Number(
      db
        .prepare(
          "SELECT COUNT(*) n FROM entities WHERE kind='attempt' AND parent=?",
        )
        .get(run.runId)?.n,
    ) !== 1 ||
    Number(
      db
        .prepare(
          "SELECT COUNT(*) n FROM events WHERE run_id=? AND json_extract(data,'$.type')='run.settled'",
        )
        .get(run.runId)?.n,
    ) !== 1
  )
    return;
  const sourceReference = z.object({
    kind: z.literal("dsh-task"),
    runId: z.string().optional(),
    attemptId: z.string().optional(),
  });
  const matches = (source: unknown) => {
    const parsed = sourceReference.safeParse(source);
    return (
      parsed.success &&
      (parsed.data.runId === run.runId ||
        parsed.data.attemptId === attempt.attemptId)
    );
  };
  for (const event of events) {
    if (event.type === "user/message" && matches(event.data.source)) return;
    if (
      event.type === "agent/inbox/spliced" &&
      event.data.inserted.some((message) => matches(message.source))
    )
      return;
  }
  return {
    interruptionCommandId,
    interruptedAt: interrupted.acceptedAt,
    eventCount: events.length,
    lastSeq: events.at(-1)?.seq ?? -1,
    businessResult: "unproven" as const,
  };
}

export async function nativeExecutionStatus(
  ctx: Context,
  service: TaskSystemService,
  agent: Agent,
  input: Request,
  authorize: () => void,
  signal: AbortSignal,
) {
  authorize();
  signal.throwIfAborted();
  const ledger = service.ledger,
    db = ledger.managementDatabase(),
    run = ledger.getRun(input.runId);
  if (run.taskId !== input.taskId)
    throw new TaskError("FORBIDDEN", "Run is outside the authorized task");
  const actionVersion = ledger.taskActionState(input.taskId).version;
  const attempt = run.currentAttemptId
    ? ledger.getAttempt(run.currentAttemptId)
    : undefined;
  const reports = ledger.demandReads
    .facts("report", input.taskId)
    .filter((row) => row.runId === run.runId && row.kind === "result")
    .slice(-8)
    .map((row) => ({ reportId: row.reportId, revision: row.revision }));
  const base = {
    taskId: input.taskId,
    runId: run.runId,
    runState: run.state,
    actionVersion,
    executionStartedAt: run.executionStartedAt ?? null,
    resultSummary: run.resultSummary?.slice(0, 1000) ?? null,
    hasResultReport: reports.length > 0,
    reports,
    attempt: attempt
      ? {
          attemptId: attempt.attemptId,
          nodeId: attempt.nodeId,
          fence: attempt.fence,
          state: attempt.state,
          sessionId: attempt.sessionId ?? null,
        }
      : null,
  };
  const unknown = (reason: string) => {
    authorize();
    signal.throwIfAborted();
    return {
      ...base,
      reconciled: false,
      canReconcile: false,
      evidence: { status: "unknown", reason },
    };
  };
  const commandId =
    input.action === "reconcile"
      ? reconciliationCommand(String(agent.id), input.commandId)
      : undefined;
  const replay = commandId
    ? ledger.commandReceipt<ReturnType<typeof ledger.getRun>>(commandId)
    : undefined;
  if (replay && input.action === "reconcile") {
    if (
      replay.value.runId !== input.runId ||
      replay.value.taskId !== input.taskId
    )
      throw new TaskError(
        "CONFLICT",
        "Reconciliation command belongs to another execution",
      );
    const row = db
      .prepare(
        "SELECT data FROM events WHERE run_id=? AND json_extract(data,'$.type')='run.reconciled' AND json_extract(data,'$.detail.reconciliationCommandId')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(run.runId, replay.commandId);
    const event = row
      ? z
          .object({ detail: z.object({ evidence: nativeFailureEvidence }) })
          .parse(JSON.parse(String(row.data)))
      : undefined;
    if (
      !event ||
      event.detail.evidence.coordinatorSessionId !== String(agent.id) ||
      event.detail.evidence.evidenceVersion !== input.expectedEvidenceVersion ||
      event.detail.evidence.actionVersion !== input.expectedActionVersion
    )
      throw new TaskError(
        "CONFLICT",
        "Reconciliation command cannot be reused with changed input",
      );
    return {
      ...base,
      runState: replay.value.state,
      reconciled: true,
      canReconcile: false,
      evidence: {
        status:
          event.detail.evidence.kind === "native-interrupted-stopped-v1"
            ? "stopped-result-unproven"
            : "proven-start-failure",
        ...event.detail.evidence,
      },
      notice: "已返回同一持久核实回执；未重新执行或重复结算。",
    };
  }
  if (!["uncertain", "running", "queued"].includes(run.state)) {
    const row = db
      .prepare(
        "SELECT data FROM events WHERE run_id=? AND json_extract(data,'$.type')='run.reconciled' ORDER BY seq DESC LIMIT 1",
      )
      .get(run.runId);
    const stopped = interruptedStopEvidence.safeParse(
      row ? JSON.parse(String(row.data)).detail?.evidence : undefined,
    );
    return {
      ...base,
      reconciled: false,
      canReconcile: false,
      evidence: stopped.success
        ? { status: "stopped-result-unproven", ...stopped.data }
        : {
            status: "ledger-terminal",
            reason: "账本已有正式终态；报告不等于用户验收。",
          },
    };
  }
  if (
    service.config.centralMode !== "host" ||
    !attempt ||
    !attempt.sessionId ||
    !attempt.executionId ||
    attempt.runId !== run.runId ||
    attempt.nodeId !== service.config.nodeId ||
    run.route?.nodeId !== attempt.nodeId ||
    run.route.backend ||
    run.route.execution
  )
    return unknown(
      "当前宿主没有这次原生执行的本机所有者证据；不得发送聊天代替核实。",
    );
  const agents = ctx.get("agents"),
    persistence = ctx.get("sessionPersistence");
  if (!agents || !persistence)
    return unknown("当前宿主未提供原生执行状态与持久记录；保留结果未知。");
  const sessionId = SessionId(attempt.sessionId),
    target = ledger
      .sessionMessageTargets(input.taskId)
      .find(
        (row) =>
          row.sessionId === sessionId &&
          row.nodeId === attempt.nodeId &&
          row.schedulerId === ledger.schedulerIdentity(),
      );
  if (!target) return unknown("当前任务缺少与该原生执行会话对应的正式绑定。");
  const latest = () =>
    db
      .prepare(
        "SELECT id FROM entities WHERE kind='run' AND parent=? AND COALESCE(json_extract(data,'$.historyOnly'),0)=0 AND COALESCE(json_extract(data,'$.observationOnly'),0)=0 ORDER BY rowid DESC LIMIT 1",
      )
      .get(input.taskId)?.id;
  if (latest() !== run.runId)
    return unknown("任务已有更新的运行；不能用旧运行的证据更新当前状态。");
  const frozen = digest({ run, attempt });
  const active = () => {
    const live = agents.get(sessionId);
    return (
      !!db
        .prepare(
          "SELECT 1 FROM entities WHERE kind='attempt' AND state IN ('leased','running') AND json_extract(data,'$.sessionId')=? LIMIT 1",
        )
        .get(String(sessionId)) ||
      service.native?.hasOwnedSession(String(sessionId)) ||
      service.native?.hasOwnedExecution({
        runId: run.runId,
        attemptId: attempt.attemptId,
        nodeId: attempt.nodeId,
        fence: attempt.fence,
        executionId: attempt.executionId,
      }) ||
      (!!live &&
        (live.status !== "idle" ||
          live.inbox.nextTurn.length > 0 ||
          live.inbox.nextStep.length > 0))
    );
  };
  if (active())
    return unknown("执行端仍持有本次执行或会话有活动输入；尚不能确认停止。");
  const before = await persistence.stat(sessionId);
  if (!before) return unknown("原生持久记录不可用；保留结果未知。");
  if (before.sizeBytes !== undefined && before.sizeBytes > 8 * 1024 * 1024)
    return unknown("原生记录超出本次有界核实范围；保留结果未知。");
  const handle = await persistence.open(sessionId, "read");
  let events;
  try {
    if (handle.inheritedEventCount !== 0 || handle.header.id !== sessionId)
      return unknown("无法证明这是未继承的完整执行记录。");
    events = (await handle.read(0, 2001, { signal })).events;
    if (
      events.length <= 2000 &&
      (await handle.read(events.length, 1, { signal })).events.length
    )
      return unknown("原生记录不是完整前缀；保留结果未知。");
  } finally {
    await handle.close();
  }
  const proof = nativeFailureFacts(events, {
    taskId: input.taskId,
    runId: run.runId,
    attemptId: attempt.attemptId,
    provider: run.route.provider,
    model: run.route.model,
  });
  const stopped =
    !proof.proven && service.native && reports.length === 0
      ? interruptedStopFacts(service, run, attempt, events)
      : undefined;
  if (!proof.proven && !stopped) return unknown(proof.reason);
  authorize();
  signal.throwIfAborted();
  const after = await persistence.stat(sessionId);
  authorize();
  signal.throwIfAborted();
  const attached = ctx.get("sessions")?.get(sessionId);
  if (
    !after ||
    (attached !== undefined && attached.seq !== events.length) ||
    (after.eventCount !== undefined && after.eventCount !== events.length) ||
    after.revision !== before.revision ||
    active() ||
    latest() !== run.runId ||
    frozen !==
      digest({
        run: ledger.getRun(run.runId),
        attempt: ledger.getAttempt(attempt.attemptId),
      })
  )
    throw new TaskError(
      "CONFLICT",
      "Execution evidence changed; inspect again before reconciliation",
    );
  const common = {
    coordinatorSessionId: String(agent.id),
    nodeId: attempt.nodeId,
    sessionId: String(sessionId),
    attemptId: attempt.attemptId,
    executionId: attempt.executionId,
    fence: attempt.fence,
    actionVersion,
  };
  const facts = proof.proven
    ? {
        ...common,
        kind: "native-auth-zero-tools-v1" as const,
        turn: proof.turn,
        fromSeq: proof.fromSeq,
        terminalSeq: proof.terminalSeq,
        code: "AUTH" as const,
        httpStatus: 401 as const,
        toolCallCount: 0 as const,
      }
    : {
        ...common,
        kind: "native-interrupted-stopped-v1" as const,
        ...stopped!,
      };
  const evidence: NativeFailureEvidence = {
    ...facts,
    evidenceVersion: digest({ ...facts, revision: after.revision }),
  };
  if (input.action === "inspect")
    return {
      ...base,
      canReconcile: run.state === "uncertain",
      reconciled: false,
      evidence: {
        status:
          evidence.kind === "native-interrupted-stopped-v1"
            ? "stopped-result-unproven"
            : "proven-start-failure",
        ...evidence,
      },
      notice:
        evidence.kind === "native-interrupted-stopped-v1"
          ? "持久中断回执与当前所有者状态确认此次调用已经停止，未提交可信业务结果；旧研究结果仍未知，不代表从未执行或成功。核实本身不重跑。"
          : "原生已持久终止，未产生模型输出或工具调用；只能据此结算失败，不代表任务成功，也不重试。",
    };
  authorize();
  signal.throwIfAborted();
  if (input.expectedEvidenceVersion !== evidence.evidenceVersion)
    throw new TaskError(
      "CONFLICT",
      "Native evidence version changed; inspect again",
    );
  const result = ledger.resolveUncertain(
    reconciliationCommand(String(agent.id), input.commandId),
    {
      runId: run.runId,
      outcome: "failed",
      reason:
        evidence.kind === "native-interrupted-stopped-v1"
          ? "调度会话依据确切持久中断回执、完整原生记录与当前所有者核实此次调用已停止，未提交业务结果；历史业务结果仍未知，不代表从未执行。未重跑。"
          : "调度会话依据完整原生记录确认启动期 AUTH/401、无模型输出和工具调用，原执行已结束；未重新执行。",
      expectedActionVersion: input.expectedActionVersion,
      evidence,
    },
  );
  return {
    ...base,
    runState: result.value.state,
    reconciled: true,
    canReconcile: false,
    evidence: {
      status:
        evidence.kind === "native-interrupted-stopped-v1"
          ? "stopped-result-unproven"
          : "proven-start-failure",
      ...evidence,
    },
    notice:
      evidence.kind === "native-interrupted-stopped-v1"
        ? "已据证核实此次运行停止；历史业务结果仍未知。未派发或重跑任务。"
        : "已据证结算失败；未派发或重跑任务。",
  };
}
