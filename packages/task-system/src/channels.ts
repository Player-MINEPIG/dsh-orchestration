import type { TaskLedger } from "./ledger.js";

/** Public structural port used by optional notification/control adapters. */
export interface TaskChannelPort {
  ledger: Pick<
    TaskLedger,
    | "alerts"
    | "approvals"
    | "cancel"
    | "claimDelivery"
    | "continueRun"
    | "createTask"
    | "deliveries"
    | "finishDelivery"
    | "getAlert"
    | "getApproval"
    | "getTask"
    | "history"
    | "querySnapshot"
    | "respondApproval"
    | "setAlertState"
    | "setAlertsState"
    | "setTaskAdmission"
    | "setTaskConfirmation"
  >;
  /** Cancellation follows the same owning native execution's quiescence. */
  native?: { cancelTask(taskId: string, runId?: string): Promise<void> };
}
