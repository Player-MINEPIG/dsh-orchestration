import { z } from "zod";
import { digest } from "./remote/protocol.js";

export const ExecutionDisposition = z.object({
  schedulerId:z.string().min(1).max(200),runId:z.string().min(1).max(200),taskId:z.string().min(1).max(200),
  taskState:z.string().max(100),runState:z.string().max(100),
  attemptId:z.string().max(200).nullable(),attemptState:z.string().max(100).nullable(),
  currentAttemptId:z.string().max(200).nullable(),cancellationRequested:z.boolean(),
}).strict();
export type ExecutionDisposition = z.infer<typeof ExecutionDisposition>;
export interface ExecutorAlert {
  recordId:string;fingerprint:string;canAcknowledge:boolean;acknowledged:boolean;acknowledgedAt:string|null;
}
export function executorAlertFingerprint(value: unknown): string {return digest(value);}

/** Local reminder metadata is independent of task execution and command receipts. */
export class ExecutorAlertStore {
  constructor(private db:import("node:sqlite").DatabaseSync,options:{readOnly?:boolean}={}) {
    if(!options.readOnly)db.exec("CREATE TABLE IF NOT EXISTS executor_alert_dispositions(record TEXT NOT NULL,fingerprint TEXT NOT NULL,acknowledged INTEGER NOT NULL,at TEXT NOT NULL,PRIMARY KEY(record,fingerprint))");
  }
  alert(recordId:string,fingerprint:string,canAcknowledge:boolean):ExecutorAlert {
    const supported=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_alert_dispositions'").get();
    const row=supported?this.db.prepare("SELECT acknowledged,at FROM executor_alert_dispositions WHERE record=? AND fingerprint=?").get(recordId,fingerprint):undefined;
    return {recordId,fingerprint,canAcknowledge,acknowledged:row?.acknowledged===1,acknowledgedAt:row?.acknowledged===1?String(row.at):null};
  }
  set(recordId:string,fingerprint:string,acknowledged:boolean) {
    this.db.prepare("INSERT INTO executor_alert_dispositions VALUES(?,?,?,?) ON CONFLICT(record,fingerprint) DO UPDATE SET acknowledged=excluded.acknowledged,at=excluded.at").run(recordId,fingerprint,Number(acknowledged),new Date().toISOString());
  }
}
