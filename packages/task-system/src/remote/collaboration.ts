import { TaskReadOptions } from "../task-reads.js";
import { NodeReadOptions } from "../node-reads.js";
import { digest, insist } from "./protocol.js";
import type { ExecutionCollaboration, LedgerPort, LeaseRef } from "./ports.js";

/** In-process callbacks capture authority; callers never supply parent or lease fields. */
export function bindCollaboration(
  ledger: LedgerPort,
  lease: LeaseRef,
  taskId: string,
  signal: AbortSignal,
  availableOperations?: readonly string[],
): ExecutionCollaboration {
  const ref = Object.freeze({ ...lease });
  const live = (): void => {
    insist(!signal.aborted, "EXECUTION_ABORTED", 409);
    insist(ref.executionId, "EXECUTION_OWNER_REQUIRED", 403);
  };
  const command = (kind: string, id: string): string => {
    insist(
      typeof id === "string" && id.length > 0 && id.length <= 256,
      "INVALID_COLLABORATION_COMMAND",
    );
    return `collab-${digest([ref.executionId, kind, id])}`;
  };
  return Object.freeze<ExecutionCollaboration>({
    ...(availableOperations
      ? { availableOperations: Object.freeze([...availableOperations]) }
      : {}),
    async nodes(read) {
      live();
      insist(ledger.readExecutionModels, "EXECUTION_CATALOG_UNSUPPORTED", 503);
      return await ledger.readExecutionModels(ref.nodeId,NodeReadOptions.parse(read ?? {}),true);
    },
    async offerApproval(id, input) {
      live();
      insist(ledger.offerApproval, "APPROVAL_BRIDGE_UNSUPPORTED", 503);
      return await ledger.offerApproval(
        command("offerApproval", id),
        {
          ...ref,
          requestId: input.requestId,
          sessionId: input.sessionId,
          agentId: input.agentId,
          callId: input.callId,
          toolName: input.toolName,
          argumentsDigest: input.argumentsDigest,
          description: input.description,
          expiresAt: input.expiresAt,
          allowRemoteOnce: input.allowRemoteOnce,
        },
        { signal },
      );
    },
    async approvalStatus(requestId) {
      live();
      insist(ledger.approvalStatus, "APPROVAL_BRIDGE_UNSUPPORTED", 503);
      return await ledger.approvalStatus({ ...ref, requestId }, { signal });
    },
    async cancelApproval(id, input) {
      // Cleanup only narrows this captured request authority and remains usable after abort.
      insist(ref.executionId, "EXECUTION_OWNER_REQUIRED", 403);
      insist(ledger.cancelApproval, "APPROVAL_BRIDGE_UNSUPPORTED", 503);
      return await ledger.cancelApproval(command("cancelApproval", id), {
        ...ref,
        requestId: input.requestId,
        reason: input.reason,
      });
    },
    async delegate(id, input) {
      live();
      insist(ledger.delegateTask, "COLLABORATION_UNSUPPORTED", 503);
      // Select allowed fields explicitly; extra runtime properties cannot overwrite the bound ref.
      return await ledger.delegateTask(
        command("delegate", id),
        {
          ...ref,
          title: input.title,
          ...(input.display ? { display: input.display } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.route ? { route: input.route } : {}),
          ...(input.policy ? { policy: input.policy } : {}),
          ...(input.configuration !== undefined
            ? { configuration: input.configuration }
            : {}),
        },
        { signal },
      );
    },
    async history(targetTaskId = taskId,read) {
      live();
      insist(ledger.scopedHistory, "COLLABORATION_UNSUPPORTED", 503);
      return await ledger.scopedHistory(
        { ...ref, taskId: targetTaskId,read:TaskReadOptions.parse(read ?? {}) },
        { signal },
      );
    },
    async wait(targetTaskId = taskId, quietMs?: number) {
      live();
      insist(ledger.scopedAllSettled, "COLLABORATION_UNSUPPORTED", 503);
      return await ledger.scopedAllSettled(
        {
          ...ref,
          taskId: targetTaskId,
          ...(quietMs !== undefined ? { quietMs } : {}),
        },
        { signal },
      );
    },
    async note(id, input) {
      live();
      insist(ledger.queueScopedNote, "COLLABORATION_UNSUPPORTED", 503);
      return await ledger.queueScopedNote(
        command("note", id),
        { ...ref, taskId: input.targetTaskId ?? taskId, body: input.body },
        { signal },
      );
    },
    async report(id, input) {
      live();
      insist(ledger.appendScopedReport, "COLLABORATION_UNSUPPORTED", 503);
      return await ledger.appendScopedReport(
        command("report", id),
        {
          ...ref,
          taskId: input.targetTaskId ?? taskId,
          title: input.title,
          body: input.body,
          ...(input.data !== undefined ? { data: input.data } : {}),
          ...(input.schemaId !== undefined ? { schemaId: input.schemaId } : {}),
          ...(input.artifactIds !== undefined
            ? { artifactIds: input.artifactIds }
            : {}),
        },
        { signal },
      );
    },
  });
}
