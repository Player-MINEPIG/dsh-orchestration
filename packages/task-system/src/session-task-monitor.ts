import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import type { TaskLedger } from "./ledger.js";
import type { ProjectRuntime } from "./project-runtime.js";
import { sessionCodexJobs, SessionCodexJobFold, type CodexJobRecord, codexJobRows, type SessionJobRegistry } from "./session-codex-jobs.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Returned results first; acceptance and refreshes must not move a result. */
export function sortSessionTasks<T extends { returnedAt?: string | null; time?: string | null }>(tasks: readonly T[]): T[] {
  const timestamp = (value?: string | null) => value ? Date.parse(value) || 0 : 0;
  return [...tasks].sort((a, b) => timestamp(b.returnedAt) - timestamp(a.returnedAt) || timestamp(b.time) - timestamp(a.time));
}

class DispatchReceiptFold {
  private calls=new Map<string,string>();
  private ids=new Set<string>();
  clone(){const copy=new DispatchReceiptFold();copy.calls=new Map(this.calls);copy.ids=new Set(this.ids);return copy;}
  snapshot(){return [...this.ids];}
  consume(events:readonly SessionEvent[]){
    for(const event of events){
      if(event.type==="tool/call"){
        const {name,callId,arguments:args}=event.data;
        if(!["task_dispatch","project_dispatch","task_plan","task_run","task_delegate"].includes(name))continue;
        if(name==="task_plan"){try{if(JSON.parse(args).action!=="apply")continue;}catch{continue;}}
        this.calls.set(callId,name);
      }else if(event.type==="tool/result"){
        const {message}=event.data,known=this.calls.has(message.toolCallId);this.calls.delete(message.toolCallId);
        if(message.isError||event.data.error||!known)continue;
        for(const part of message.content){if(part.type!=="text")continue;try{
          const receipt=JSON.parse(part.text),value=record(receipt?.value)??record(receipt);if(value?.localOnly===true)continue;
          const taskId=value?.taskId??record(value?.task)?.taskId??record(value?.run)?.taskId;
          if(typeof taskId==="string"&&taskId)this.ids.add(taskId);
        }catch{ /* Tool errors are not dispatch receipts. */ }}
      }
    }
  }
}
/** Only successful dispatch receipts count; queries and inherited fork history do not. */
export function dispatchedTaskIds(events:readonly SessionEvent[]):string[]{const fold=new DispatchReceiptFold();fold.consume(events);return fold.snapshot();}

export interface LiveSessionEvidence {readonly id:string;readonly seq:number;readonly inheritedEventCount:number}
interface SessionEvidenceEntry {
  revision:unknown;identity:symbol;cursor:number;inherited:number;sizeBytes?:number;headerIdentity:string;
  dispatch:DispatchReceiptFold;codex:SessionCodexJobFold;live?:WeakRef<LiveSessionEvidence>;
}
/** Bound metadata-only history folds. Live append feeds avoid the SDK's full-file decode path. */
export class SessionDispatchIndex {
  private cache=new Map<string,SessionEvidenceEntry>();
  private flights=new Map<string,{identity:symbol;ticket:symbol;promise:Promise<{ids:string[];codexJobs:CodexJobRecord[]}>}>();
  observe(session:LiveSessionEvidence,event:SessionEvent){
    const entry=this.cache.get(String(session.id));if(!entry||entry.live?.deref()!==session||event.seq!==entry.cursor)return;
    entry.dispatch.consume([event]);entry.codex.consume([event]);entry.cursor=event.seq+1;
  }
  detach(session:LiveSessionEvidence){const entry=this.cache.get(String(session.id));if(entry?.live?.deref()===session)entry.live=undefined;}
  async read(persistence:SessionPersistence,sessionId:string,live?:LiveSessionEvidence){return (await this.readHistory(persistence,sessionId,live)).ids;}
  readHistory(persistence:SessionPersistence,sessionId:string,live?:LiveSessionEvidence){
    const flight=this.flights.get(sessionId),identity=persistence.identity;if(flight?.identity===identity)return flight.promise;
    const ticket=Symbol(),pending=this.refresh(persistence,sessionId,live,identity,ticket).finally(()=>{if(this.flights.get(sessionId)?.ticket===ticket)this.flights.delete(sessionId);});
    this.flights.set(sessionId,{identity,ticket,promise:pending});return pending;
  }
  private snapshot(entry:SessionEvidenceEntry){return {ids:entry.dispatch.snapshot(),codexJobs:entry.codex.snapshot()};}
  private async refresh(persistence:SessionPersistence,sessionId:string,live:LiveSessionEvidence|undefined,identity:symbol,ticket:symbol){
    const prior=this.cache.get(sessionId);
    if(prior?.identity===identity&&live&&prior.live?.deref()===live&&prior.cursor===live.seq&&prior.inherited===live.inheritedEventCount)return this.snapshot(prior);
    const id=SessionId(sessionId),stat=await persistence.stat(id);
    if(!stat){if(this.flights.get(sessionId)?.ticket===ticket)this.cache.delete(sessionId);return {ids:[],codexJobs:[]};}
    const headerIdentity=JSON.stringify(stat.header),compatible=prior?.identity===identity&&prior.headerIdentity===headerIdentity&&
      !(stat.eventCount!==undefined&&stat.eventCount<prior.cursor)&&!(stat.sizeBytes!==undefined&&prior.sizeBytes!==undefined&&stat.sizeBytes<prior.sizeBytes);
    if(compatible&&prior.revision===stat.revision&&!live)return this.snapshot(prior);
    const handle=await persistence.open(id,"read");
    try{
      const inherited=handle.inheritedEventCount,reuse=compatible&&prior.inherited===inherited;
      const dispatch=reuse?prior.dispatch.clone():new DispatchReceiptFold(),codex=reuse?prior.codex.clone():new SessionCodexJobFold();
      const offset=reuse?prior.cursor:inherited,{events}=await handle.read(offset);
      dispatch.consume(events);codex.consume(events);
      const last=events.at(-1),cursor=last&&Number.isSafeInteger(last.seq)?last.seq+1:offset+events.length;
      const current=this.cache.get(sessionId);
      if(reuse&&current?.identity===identity&&current.cursor>cursor)return this.snapshot(current);
      const entry:SessionEvidenceEntry={identity,revision:stat.revision,headerIdentity,cursor,inherited,sizeBytes:stat.sizeBytes,dispatch,codex,live:live?new WeakRef(live):undefined};
      if(this.flights.get(sessionId)?.ticket!==ticket)return this.snapshot(entry);
      this.cache.delete(sessionId);this.cache.set(sessionId,entry);while(this.cache.size>32)this.cache.delete(this.cache.keys().next().value??"");
      return this.snapshot(entry);
    }finally{await handle.close();}
  }
}

/** Durable dispatch operations cover ACKs not yet flushed into the conversation. */
export function sessionDispatchOperations(ledger: TaskLedger, sessionId: string) {
  const db = ledger.managementDatabase();
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_session_operations'").get())
    return { taskIds: [] as string[], pending: 0 };
  const taskIds = new Set<string>();
  let pending = 0;
  for(const row of db.prepare("SELECT json_extract(data,'$.state') state,json_extract(data,'$.result.taskId') task_id FROM project_session_operations WHERE session_id=? AND json_extract(data,'$.input.action')='dispatch'").all(sessionId)){
    if(row.state==="pending")pending++;
    if(row.state==="acknowledged"&&typeof row.task_id==="string")taskIds.add(row.task_id);
  }
  return { taskIds: [...taskIds], pending };
}

/** Reuse the task center's public rows and classification, scoped before returning to the browser. */
export function sessionTaskSnapshot(snapshot: unknown, roots: readonly string[], sessionId: string, pending = 0, codexJobs: readonly CodexJobRecord[] = [], registry?: SessionJobRegistry) {
  const candidate = record(snapshot);
  if (!candidate || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.runs)) throw new Error("Invalid task snapshot");
  const view = snapshot as ReturnType<ProjectRuntime["snapshot"]>;
  const direct = new Set(roots), ids = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of view.tasks) if (task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
      ids.add(task.id); changed = true;
    }
  }
  const ledgerTasks = view.tasks.filter(task => ids.has(task.id)).map(task => ({
    id: task.id, title: task.title, description: task.description, status: task.status,
    stateLabel: task.stateLabel, parentTaskId: task.parentTaskId, direct: direct.has(task.id),
    node: task.node, model: task.model, time: task.time,
    returnedAt: task.returnedAt ?? (["review", "done", "accepted", "error", "cancelled"].includes(task.status) ? task.time : undefined),
    report: task.report,
    runId: task.runId, runState: task.runState, reviewStatus: task.reviewStatus,
    ...("sessionIds" in task ? {sessionIds:task.sessionIds} : {}),
  }));
  const tasks = [...ledgerTasks, ...codexJobRows(codexJobs, sessionId, registry)];
  const visible = new Set(tasks.map(task => task.id));
  const counts: Record<string, number> = { all: tasks.length };
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return {
    sessionId, tasks, counts, directCount: tasks.filter(task => task.direct).length,
    externalDispatchCount: codexJobs.length,
    pendingDispatches: pending, unavailableTasks: roots.filter(id => !visible.has(id)).length,
    sampledAt: view.sampledAt ?? view.viewContext?.observedAt ?? new Date().toISOString(),
    runs: view.runs.filter(run => visible.has(run.taskId)).map(run => ({
      id: run.id, taskId: run.taskId, state: run.state, reviewStatus: run.reviewStatus,
      createdAt: run.createdAt, node: run.node, model: run.model,
      parentRunId:run.parentRunId, parentTaskId:run.parentTaskId, sessionIds:run.sessionIds,
    })),
  };
}
