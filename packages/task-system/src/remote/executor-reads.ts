import { createHash } from "node:crypto";
import type { Run } from "../contracts.js";
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { executorPanelSnapshot, type ExecutorPanelRecord } from '../executor-panel.js';
import { TaskError, type TaskLedger } from '../ledger.js';
import { executorAlertFingerprint } from '../executor-alerts.js';
import type { DemandReadMethod, DemandReadInputs, ExecutorClaim, PageInput, TaskQuery } from '../demand-reads.js';
import type { RecoveryStore, RecoveryClaimHeader, RecoveryDispatchHeader } from './store.js';

type PendingHeader={commandId:string;runId:string;attemptId:string;sessionId:string;state:string;readyAt:number;reasonCode?:string;summary:string};
interface Sources {
  ledger:TaskLedger; nodeId:string; store?:RecoveryStore;
  queue:()=>{revision:string;records:ExecutorPanelRecord[]};
  queueDetail?:(runId:string)=>string;
  queueExecution?:(runId:string)=>Pick<Run,'intentSnapshot'|'projectContext'|'contextNotes'>|undefined;
  pending:()=>PendingHeader[];
  pendingDetail:(commandId:string)=>{settlement:{summary:string;report?:{body:string}}}|undefined;
  decorate:(record:ExecutorPanelRecord)=>ExecutorPanelRecord;
  decorateClaim:(claim:RecoveryClaimHeader)=>ExecutorClaim;
  context:()=>{queueObservedAt:string|null;pollState:string;connection:unknown;heartbeat:unknown};
}
const bounds=(q:PageInput)=>{
  const page=q.page??0,pageSize=q.pageSize??20;
  if(!Number.isSafeInteger(page)||page<0||page>1_000_000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50)throw new TaskError('INVALID','Invalid page bounds');
  return {page,pageSize};
};
const statusNames=['error','review','running','draft','queued','cancelling','accepted','done','handled','cancelled','archived','observed','unknown'];
const responsibilityNames=['needs_user','coordinator','unreviewed','resolved','none'];
/** One disposable SQL read product. Only changed compact source headers enter this database. */
export class ExecutorDemandReads {
  private readonly db=new DatabaseSync(':memory:');
  private ledgerRevision=-1;
  private storeRevision=-1;
  private queueRevision='';
  private pendingRevision='';
  private pending=new Map<string,PendingHeader>();
  private queue=new Map<string,ExecutorPanelRecord>();
  private attemptRuns=new Map<string,string>();
  constructor(private readonly sources:Sources){
    this.db.exec(`CREATE TABLE records(source TEXT NOT NULL,id TEXT NOT NULL,priority INTEGER NOT NULL,active INTEGER NOT NULL,seq INTEGER NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,time TEXT NOT NULL,status TEXT NOT NULL,project TEXT NOT NULL,title TEXT NOT NULL,data TEXT NOT NULL,time_ms REAL NOT NULL,returned_ms REAL NOT NULL,PRIMARY KEY(source,id));
      CREATE INDEX record_run ON records(run_id,priority DESC,active DESC,seq DESC);
      CREATE INDEX record_task ON records(task_id,time DESC,seq DESC);
      CREATE TABLE claims(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX claim_run ON claims(run_id,seq DESC);
      CREATE TABLE reports(id TEXT PRIMARY KEY,source TEXT NOT NULL,run_id TEXT NOT NULL,task_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX report_run ON reports(run_id,seq DESC);
      CREATE VIEW runs AS SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY run_id ORDER BY priority DESC,active DESC,seq DESC,id) chosen FROM records) WHERE chosen=1;
      CREATE VIEW tasks AS SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY time DESC,seq DESC,run_id) latest FROM runs) WHERE latest=1;`);
  }
  close(){this.db.close();}
  private revision(){return `${this.ledgerRevision}:${this.storeRevision}:${this.queueRevision}:${this.pendingRevision}`;}
  private context(){return {role:'executor',scope:'local',nodeId:this.sources.nodeId,observedAt:new Date().toISOString(),...this.sources.context()};}
  private envelope<T>(items:T[],total:number,q:PageInput){const b=bounds(q);b.page=Math.min(b.page,Math.max(0,Math.ceil(total/b.pageSize)-1));return {...b,items,total,pages:Math.ceil(total/b.pageSize),revision:this.revision(),sampledAt:new Date().toISOString()};}
  private upsert(row:ExecutorPanelRecord,seq:number,id:string){
    if(row.nodeId!==this.sources.nodeId){this.db.prepare('DELETE FROM records WHERE source=? AND id=?').run(row.source,id);return;}
    const decorated=this.sources.decorate({...row,description:'',report:row.report?.slice(0,2000),detail:row.detail}),task=executorPanelSnapshot(this.sources.nodeId,[decorated]).tasks[0];
    if(!task)return;
    const priority=row.source==='local-recovery'?2:row.source==='local-queue'?1:0;
    const active=Number(!['acknowledged','cancelled','retry_scheduled'].includes(row.state));
    this.db.prepare(`INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET priority=excluded.priority,active=excluded.active,seq=excluded.seq,run_id=excluded.run_id,task_id=excluded.task_id,time=excluded.time,status=excluded.status,project=excluded.project,title=excluded.title,data=excluded.data,time_ms=excluded.time_ms,returned_ms=excluded.returned_ms`)
      .run(row.source,id,priority,active,seq,row.runId,row.taskId,row.time,task.status,row.projectId??'unassigned',row.title,JSON.stringify(decorated),Date.parse(row.time)||0,
        task.returnedAt||['review','done','accepted','error','cancelled'].includes(task.status)?Date.parse(row.time)||0:0);
  }
  private localRun(id:string){
    const {ledger,nodeId}=this.sources,run=ledger.demandReads.fact('run',id),task=run?ledger.demandReads.fact('task',run.taskId):undefined;
    if(!run||!task||run.route?.nodeId!==nodeId||run.observationOnly||run.historyOnly){this.db.prepare("DELETE FROM records WHERE source='local-ledger' AND id=?").run(id);return;}
    const attempts=ledger.demandReads.facts('attempt',run.runId);
    for(const attempt of attempts)this.attemptRuns.set(attempt.attemptId,run.runId);
    const attempt=attempts.find(a=>a.attemptId===run.currentAttemptId);
    const sessions=ledger.managementDatabase().prepare('SELECT session_id FROM run_context_sessions WHERE run_id=? ORDER BY session_id').all(id).map(row=>String(row.session_id));
    const pending=this.pending.get(id);
    const disposition={schedulerId:ledger.schedulerIdentity(),runId:id,taskId:run.taskId,taskState:task.state,runState:run.state,
      attemptId:attempt?.attemptId??null,attemptState:attempt?.state??null,currentAttemptId:run.currentAttemptId??null,cancellationRequested:!!run.cancellationRequested};
    const row:ExecutorPanelRecord&{detailVersion:string}={detailVersion:executorAlertFingerprint({task:task.detailComponentDigest,run:run.detailComponentDigest}),taskId:run.taskId,runId:id,title:task.title,description:'',state:pending?'result':run.state,source:'local-ledger',nodeId,time:run.updatedAt,
      sessionIds:[...new Set([...sessions,...attempts.flatMap(a=>a.sessionId?[a.sessionId]:[]),...(pending?[pending.sessionId]:[])])],
      executionDriver:run.route?.backend||run.route?.execution?'external':'dsh',parentTaskId:task.parentTaskId,parentRunId:run.parentRunId,
      projectId:run.projectId??undefined,projectTitle:run.projectTitle??undefined,model:run.route?.model,workspaceId:run.route?.workspaceId,
      report:pending?.summary??run.resultSummaryPreview,detail:pending?.reasonCode,outcome:run.outcome,attemptId:attempt?.attemptId,authorityDisposition:disposition};
    const recordId=`local:${id}:${attempt?.attemptId??'none'}`,fingerprint=executorAlertFingerprint({recordId,state:row.state,outcome:row.outcome??null,disposition});
    row.alert=ledger.executorAlerts.alert(recordId,fingerprint,['failed','blocked','partial'].includes(row.state)&&!['leased','running'].includes(disposition.attemptState??''));
    this.upsert(row,run.sourceSeq,id);
  }
  private report(id:string){
    const report=this.sources.ledger.demandReads.fact('report',id);
    if(!report?.runId){this.db.prepare('DELETE FROM reports WHERE id=?').run(id);return;}
    // Executor rows retain the old local-only unread semantics; actual authority versions stay exact.
    const header={id:report.reportId,taskId:report.taskId,runId:report.runId,kind:report.kind,title:report.title,contentVersion:report.contentVersion,
      readAt:null,unread:false,hasHtmlPresentation:report.hasHtmlPresentation,createdAt:report.createdAt,recordedAt:report.recordedAt};
    this.db.prepare("INSERT INTO reports VALUES(?,'local-ledger',?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,task_id=excluded.task_id,seq=excluded.seq,data=excluded.data")
      .run(id,report.runId,report.taskId,report.sourceSeq,JSON.stringify(header));
  }
  private recovery(id:string){
    const header=this.sources.store?.dispatchHeader(id);
    if(!header){this.db.prepare("DELETE FROM records WHERE source='local-recovery' AND id=?").run(id);this.db.prepare('DELETE FROM reports WHERE id=?').run(`recovery:${id}`);return;}
    this.upsert(header,header.sourceSeq,id);
    const reportId=`recovery:${id}`;
    if(header.hasReport){const report={id:reportId,taskId:header.taskId,runId:header.runId,kind:'result',title:`${header.title} · 本机执行结果`,contentVersion:header.reportVersion??`local:${header.sourceSeq}`,readAt:null,unread:false,hasHtmlPresentation:false,createdAt:header.time,recordedAt:header.time};
      this.db.prepare("INSERT INTO reports VALUES(?,'local-recovery',?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,task_id=excluded.task_id,seq=excluded.seq,data=excluded.data").run(reportId,header.runId,header.taskId,header.sourceSeq,JSON.stringify(report));
    }else this.db.prepare('DELETE FROM reports WHERE id=?').run(reportId);
  }
  private claim(id:string){
    const row=this.sources.store?.claimHeader(id);
    if(!row||!['sending','pending','uncertain'].includes(row.state)){this.db.prepare('DELETE FROM claims WHERE id=?').run(id);return row?.runId;}
    this.db.prepare('INSERT INTO claims VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,seq=excluded.seq,data=excluded.data').run(id,row.runId,row.sourceSeq,JSON.stringify(this.sources.decorateClaim(row)));
    return row.runId;
  }
  private queueRun(row:ExecutorPanelRecord){
    const claimRow=this.db.prepare('SELECT data FROM claims WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(row.runId);
    const claim:ExecutorClaim|undefined=claimRow?JSON.parse(String(claimRow.data)):undefined;
    const value=claim?{...row,state:claim.code?'claim_rejected':claim.state==='uncertain'?'claim_uncertain':'claim_pending',
      detail:[claim.recoveryNote,claim.code?`${claim.code}: ${claim.message??''}`:undefined,claim.endpoint?`原调度端 ${claim.endpoint}`:undefined].filter(Boolean).join(' · ')}:row;
    this.upsert(value,Date.parse(row.time)||0,row.runId);
  }
  private sync(){
    const previousPending=new Map(this.pending),previousQueue=new Map(this.queue),previousAttempts=new Map(this.attemptRuns);
    const {ledger,store}=this.sources;
    ledger.demandReads.ensureFacts();
    const ledgerRevision=Number(ledger.demandReads.revision),storeRevision=store?.panelReadRevision??0;
    const pending=this.sources.pending(),pendingRevision=JSON.stringify(pending);
    const affected=new Set<string>();
    if(pendingRevision!==this.pendingRevision){for(const id of this.pending.keys())affected.add(id);this.pending=new Map(pending.map(row=>[row.runId,row]));for(const id of this.pending.keys())affected.add(id);}
    this.db.exec('BEGIN');
    try{
      const ledgerChanges=this.ledgerRevision<0?[]:ledger.demandReads.changesSince(this.ledgerRevision);
      if(this.ledgerRevision<0||ledgerChanges.some(row=>row.kind==='rebuild')){this.db.prepare("DELETE FROM records WHERE source='local-ledger'").run();this.db.prepare("DELETE FROM reports WHERE source='local-ledger'").run();this.attemptRuns.clear();for(const row of ledger.demandReads.facts('run'))this.localRun(row.runId);for(const row of ledger.demandReads.facts('report'))this.report(row.reportId);}
      else for(const change of ledgerChanges){
        if(change.kind==='run'||change.kind==='session')affected.add(change.id);
        else if(change.kind==='task'){
          for(const row of this.db.prepare("SELECT run_id FROM records WHERE source='local-ledger' AND task_id=?").all(change.id))affected.add(String(row.run_id));
          for(const row of ledger.managementDatabase().prepare("SELECT id FROM demand_entity_facts WHERE kind='run' AND task_id=? AND node_id=?").all(change.id,this.sources.nodeId))affected.add(String(row.id));
        }else if(change.kind==='report')this.report(change.id);
        else if(change.kind==='attempt'){const row=ledger.demandReads.fact('attempt',change.id);const run=row?.runId??this.attemptRuns.get(change.id);if(run)affected.add(run);if(!row)this.attemptRuns.delete(change.id);}
        else if(change.kind==='executor-alert'){const row=this.db.prepare("SELECT run_id FROM records WHERE source='local-ledger' AND json_extract(data,'$.alert.recordId')=?").get(change.id);if(row)affected.add(String(row.run_id));}
      }
      for(const id of affected)this.localRun(id);
      if(pendingRevision!==this.pendingRevision){
        this.db.prepare("DELETE FROM reports WHERE id LIKE 'native:%'").run();
        for(const entry of pending){const record=this.db.prepare("SELECT task_id,title FROM records WHERE source='local-ledger' AND run_id=?").get(entry.runId);if(!record)continue;
          const report={id:`native:${entry.commandId}`,taskId:String(record.task_id),runId:entry.runId,kind:'result',title:`${record.title} · 待回传结果`,contentVersion:`local-ready:${entry.commandId}:${entry.state}:${entry.readyAt}`,readAt:null,unread:false,hasHtmlPresentation:false,createdAt:new Date(entry.readyAt).toISOString(),recordedAt:new Date(entry.readyAt).toISOString()};
          this.db.prepare("INSERT INTO reports VALUES(?,'local-ledger',?,?,?,?)").run(report.id,entry.runId,report.taskId,entry.readyAt,JSON.stringify(report));
        }
      }
      if(store){
        const storeChanges=this.storeRevision<0?[]:store.panelChangesSince(this.storeRevision);
        if(this.storeRevision<0||storeChanges.some(row=>row.kind==='rebuild')){this.db.prepare("DELETE FROM records WHERE source='local-recovery'").run();this.db.prepare("DELETE FROM reports WHERE source='local-recovery'").run();this.db.prepare('DELETE FROM claims').run();for(const row of store.dispatchHeaders())this.recovery(row.attemptId!);for(const row of store.claimHeaders())this.claim(row.commandId);}
        else for(const change of storeChanges){
          if(change.kind==='dispatch')this.recovery(change.id);
          else if(change.kind==='claim'){const old=this.db.prepare('SELECT run_id FROM claims WHERE id=?').get(change.id);const id=this.claim(change.id);if(id)affected.add(id);if(old)affected.add(String(old.run_id));}
          else {const [kind,...id]=change.id.split(':');if(kind==='dispatch')this.recovery(id.join(':'));else if(kind==='claim')this.claim(id.join(':'));}
        }
      }
      const queue=this.sources.queue();
      if(queue.revision!==this.queueRevision){this.db.prepare("DELETE FROM records WHERE source='local-queue'").run();this.queue=new Map(queue.records.map(row=>[row.runId,{...row,description:'',report:row.report?.slice(0,2000),detail:row.detail}]));for(const row of this.queue.values())this.queueRun(row);}
      else for(const id of affected){const row=this.queue.get(id);if(row)this.queueRun(row);}
      this.db.exec('COMMIT');
      this.ledgerRevision=ledgerRevision;this.storeRevision=storeRevision;this.queueRevision=queue.revision;this.pendingRevision=pendingRevision;
      ledger.demandReads.acknowledgeChanges(ledgerRevision);store?.acknowledgePanelChanges(storeRevision);
    }catch(error){if(this.db.isTransaction){this.db.exec('ROLLBACK');this.pending=previousPending;this.queue=previousQueue;this.attemptRuns=previousAttempts;}throw error;}
  }
  private detailVersion(record:ExecutorPanelRecord){
    const row=record as ExecutorPanelRecord&{detailVersion?:string;reportVersion?:string};
    const hash=createHash('sha256').update(JSON.stringify([row.source,row.runId,row.detailVersion??row.reportVersion??row.alert?.fingerprint??row.time]));
    for(const report of this.db.prepare("SELECT id,json_extract(data,'$.contentVersion') version FROM reports WHERE run_id=? AND source=? ORDER BY id").iterate(row.runId,row.source))hash.update(JSON.stringify([report.id,report.version]));
    return hash.digest('hex');
  }
  sessionOverrideTaskIds(sessionId:string,rootTaskIds:readonly string[]) {
    this.sync();
    return this.db.prepare(`WITH RECURSIVE seeds(id) AS (SELECT value FROM json_each(?) UNION SELECT r.task_id FROM runs r WHERE EXISTS(SELECT 1 FROM json_each(json_extract(r.data,'$.sessionIds')) WHERE value=?)),scope(id) AS (SELECT id FROM seeds UNION SELECT t.task_id FROM tasks t JOIN scope s ON json_extract(t.data,'$.parentTaskId')=s.id)
      SELECT task_id FROM tasks WHERE task_id IN (SELECT id FROM scope) ORDER BY task_id`).all(JSON.stringify(rootTaskIds),sessionId).map(row=>String(row.task_id));
  }
  private sessionHeaders(q:{sessionId:string;rootTaskIds?:string[];offset?:number;limit?:number;status?:string;search?:string}){
    const offset=q.offset??0,limit=q.limit??20;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new TaskError('INVALID','Invalid session header bounds');
    const roots=JSON.stringify(q.rootTaskIds??[]),cte=`WITH RECURSIVE seeds(id) AS (SELECT value FROM json_each(?) UNION SELECT r.task_id FROM runs r WHERE EXISTS(SELECT 1 FROM json_each(json_extract(r.data,'$.sessionIds')) WHERE value=?)),scope(id) AS (SELECT id FROM seeds UNION SELECT t.task_id FROM tasks t JOIN scope s ON json_extract(t.data,'$.parentTaskId')=s.id) `;
    const args:SQLInputValue[]=[roots,q.sessionId],where=['task_id IN (SELECT id FROM scope)'];
    const counts:Record<string,number>={all:0};for(const row of this.db.prepare(`${cte} SELECT status,count(*) n FROM tasks WHERE ${where[0]} GROUP BY status`).all(...args)){counts[String(row.status)]=Number(row.n);counts.all=(counts.all??0)+Number(row.n);}
    const directCount=Number(this.db.prepare(`${cte} SELECT count(*) n FROM tasks WHERE task_id IN (SELECT id FROM seeds)`).get(...args)?.n??0);
    const unavailableTasks=Number(this.db.prepare("SELECT count(*) n FROM json_each(?) root WHERE NOT EXISTS(SELECT 1 FROM tasks WHERE task_id=root.value)").get(roots)?.n??0);
    if(q.status&&q.status!=='all'){where.push('status=?');args.push(q.status);}if(q.search){where.push('instr(lower(title),lower(?))>0');args.push(q.search);}
    const predicate=where.join(' AND '),total=Number(this.db.prepare(`${cte} SELECT count(*) n FROM tasks WHERE ${predicate}`).get(...args)?.n??0);
    const rows=this.db.prepare(`${cte} SELECT data,task_id IN (SELECT id FROM seeds) direct FROM tasks WHERE ${predicate} ORDER BY returned_ms DESC,time_ms DESC,task_id COLLATE BINARY ASC LIMIT ? OFFSET ?`).all(...args,limit,offset);
    const items=rows.map(row=>{const record:ExecutorPanelRecord=JSON.parse(String(row.data)),task=this.card(record);return {...task,detailVersion:this.detailVersion(record),direct:!!row.direct,returnedAt:task.returnedAt??(['review','done','accepted','error','cancelled'].includes(task.status)?task.time:null)};});
    const scopeHash=createHash('sha256').update(JSON.stringify({sessionId:q.sessionId,status:q.status??'all',search:q.search??'',counts,directCount,unavailableTasks}));
    for(const row of this.db.prepare(`${cte} SELECT task_id,status,time_ms,returned_ms,data,task_id IN (SELECT id FROM seeds) direct FROM tasks WHERE task_id IN (SELECT id FROM scope) ORDER BY task_id COLLATE BINARY`).iterate(roots,q.sessionId)){
      const record:ExecutorPanelRecord=JSON.parse(String(row.data));scopeHash.update(JSON.stringify([row.task_id,row.status,row.time_ms,row.returned_ms,!!row.direct,row.data,this.detailVersion(record)]));
    }
    return {items,total,counts,directCount,unavailableTasks,revision:scopeHash.digest('hex'),sampledAt:new Date().toISOString(),viewContext:this.context(),runs:items.flatMap(task=>task.runId?[this.runHeader(this.record(task.id,task.runId))]:[])};
  }
  private taskWhere(q:TaskQuery&{sessionId?:string}){const parts=['1'],args:SQLInputValue[]=[];
    if(q.project?.kind==='project'){parts.push('project=?');args.push(q.project.projectId);}else if(q.project?.kind==='unassigned')parts.push("project='unassigned'");
    if(q.sessionId){parts.push("EXISTS(SELECT 1 FROM runs rr WHERE rr.task_id=tasks.task_id AND EXISTS(SELECT 1 FROM json_each(json_extract(rr.data,'$.sessionIds')) WHERE value=?))");args.push(q.sessionId);}
    if(q.excludeHandled)parts.push("status<>'handled'");
    const base={where:parts.join(' AND '),args:[...args]};
    if(q.status&&q.status!=='all'){parts.push('status=?');args.push(q.status);}if(q.responsibility&&q.responsibility!=='all'&&q.responsibility!=='none')parts.push('0');if(q.unreadCompletedOnly)parts.push('0');
    if(q.search){parts.push('instr(lower(title),lower(?))>0');args.push(q.search);}
    return {where:parts.join(' AND '),args,base};
  }
  private counts(q:TaskQuery&{sessionId?:string}){const w=this.taskWhere(q),byStatus=Object.fromEntries(statusNames.map(s=>[s,0])),matchedByStatus={...byStatus},byResponsibility=Object.fromEntries(responsibilityNames.map(s=>[s,0]));
    for(const row of this.db.prepare(`SELECT status,count(*) n FROM tasks WHERE ${w.base.where} GROUP BY status`).all(...w.base.args))byStatus[String(row.status)]=Number(row.n);
    for(const row of this.db.prepare(`SELECT status,count(*) n FROM tasks WHERE ${w.where} GROUP BY status`).all(...w.args))matchedByStatus[String(row.status)]=Number(row.n);
    const baseTotal=Object.values(byStatus).reduce((a,b)=>a+b,0);byResponsibility.none=baseTotal;
    return {baseTotal,byStatus,byResponsibility,unreadCompleted:0,matchedTotal:Object.values(matchedByStatus).reduce((a,b)=>a+b,0),matchedByStatus};
  }
  private card(record:ExecutorPanelRecord){
    const row=this.sources.decorate(record),task=executorPanelSnapshot(this.sources.nodeId,[row]).tasks[0];if(!task)throw new TaskError('NOT_FOUND','Local task unavailable');
    const report=this.db.prepare(`SELECT p.data FROM reports p JOIN runs r ON r.run_id=p.run_id AND r.source=p.source WHERE p.run_id=? AND json_extract(p.data,'$.kind')='result' ORDER BY p.seq DESC LIMIT 1`).get(row.runId);
    const reportId=report?JSON.parse(String(report.data)).id:null;
    return {...task,showInCoordinator:true,kind:'ad_hoc',delegationDisplay:'task',observationOnly:false,checkin:{responsibility:{state:'none',summary:''},owner:null,approvalRequired:false,execution:{phase:'not_set'}},
      actionVersion:row.alert?.fingerprint??this.revision(),dispatchIssue:null,canRepair:false,revision:1,workflowBinding:null,canRunDirect:false,unreadResultCount:0,maxResultRetries:0,resultRetry:{limit:0,count:0,remaining:0,eligible:false},
      executionStartedAt:null,executionEndedAt:null,canRequestStatus:false,progressRequest:null,confirmationRevision:1,canHandle:false,canConfirm:false,canComplete:false,canRequestMaterials:false,manualCompletion:null,materialsStatus:null,materialsLabel:null,
      reportSource:'execution',reportUpdatedAt:null,canCancel:false,canRetry:false,retryDisabledReason:null,conversationKind:'temporary',canRestore:false,canReconcile:false,confirmationPending:false,runStatus:task.status,resultStatus:task.status,
      reportId,reportPreview:row.report?.slice(0,300)??'',childAttentionCount:0,deviceLabel:row.nodeId,effort:'默认',run:row.runId,nativeState:row.state,dispatchState:null};
  }
  private graphPage(q:DemandReadInputs['taskGraphPage']){
    let cte='',where='1';const args:SQLInputValue[]=[];
    if(q.runId){const run=this.db.prepare('SELECT task_id FROM runs WHERE run_id=?').get(q.runId);if(!run)throw new TaskError('NOT_FOUND','Local execution unavailable');
      cte=`WITH RECURSIVE graph_runs(id) AS (SELECT ? UNION SELECT r.run_id FROM runs r JOIN graph_runs g ON json_extract(r.data,'$.parentRunId')=g.id) `;args.push(q.runId);where='task_id IN (SELECT task_id FROM runs WHERE run_id IN (SELECT id FROM graph_runs))';
    }else if(q.taskId){this.record(q.taskId);cte=`WITH RECURSIVE graph(id) AS (SELECT ? UNION SELECT t.task_id FROM tasks t JOIN graph g ON json_extract(t.data,'$.parentTaskId')=g.id) `;args.push(q.taskId);where='task_id IN (SELECT id FROM graph)';}
    else if(q.parentTaskId){where="json_extract(data,'$.parentTaskId')=?";args.push(q.parentTaskId);}
    if(q.projectId){where+=' AND project=?';args.push(q.projectId);}
    const total=Number(this.db.prepare(`${cte} SELECT count(*) n FROM tasks WHERE ${where}`).get(...args)?.n??0),b=bounds(q);b.page=Math.min(b.page,Math.max(0,Math.ceil(total/b.pageSize)-1));
    const items=this.db.prepare(`${cte} SELECT data FROM tasks WHERE ${where} ORDER BY time DESC,seq DESC,task_id LIMIT ? OFFSET ?`).all(...args,b.pageSize,b.page*b.pageSize).map(row=>this.card(JSON.parse(String(row.data))));
    const visible=new Set(items.map(task=>task.id));
    return {...this.envelope(items,total,b),edges:items.flatMap(task=>task.parentTaskId?[{from:task.parentTaskId,to:task.id,kind:'task'}]:[]),
      boundary:items.flatMap(task=>task.parentTaskId&&!visible.has(task.parentTaskId)?[{id:task.parentTaskId,parentId:null,remaining:1}]:[])};
  }
  private taskPage(q:TaskQuery&PageInput&{sessionId?:string},givenCounts?:ReturnType<ExecutorDemandReads['counts']>){const w=this.taskWhere(q),count=givenCounts??this.counts(q),b=bounds(q);b.page=Math.min(b.page,Math.max(0,Math.ceil(count.matchedTotal/b.pageSize)-1));
    const rows=this.db.prepare(`SELECT data FROM tasks WHERE ${w.where} ORDER BY time DESC,seq DESC,task_id LIMIT ? OFFSET ?`).all(...w.args,b.pageSize,b.page*b.pageSize);
    return {...this.envelope(rows.map(row=>this.card(JSON.parse(String(row.data)))),count.matchedTotal,b),counts:count,viewContext:this.context()};}
  private runHeader(record:ExecutorPanelRecord){const row=this.sources.decorate(record),run=executorPanelSnapshot(this.sources.nodeId,[row]).runs[0];if(!run)throw new TaskError('NOT_FOUND','Local execution unavailable');
    return {...run,createdAt:row.time,taskTitle:row.title,projectTitle:row.projectTitle??'unassigned',insertionOrdinal:Number(this.db.prepare(`SELECT count(*) n FROM runs WHERE task_id=? AND (seq<? OR(seq=? AND run_id<=?))`).get(row.taskId,
        Number(this.db.prepare('SELECT seq FROM runs WHERE run_id=?').get(row.runId)?.seq??0),Number(this.db.prepare('SELECT seq FROM runs WHERE run_id=?').get(row.runId)?.seq??0),row.runId)?.n??0),reportCount:Number(this.db.prepare('SELECT count(*) n FROM reports WHERE run_id=? AND source=?').get(row.runId,row.source)?.n??0),unreadResultCount:0,executionStartedAt:null,executionEndedAt:null,outcome:row.outcome??null,observationOnly:false,reasoningEffort:null,occurrenceId:null,delegationDisplay:'task'};}
  private runPage(q:PageInput&{taskId?:string;parentRunId?:string;status?:string;sessionId?:string;project?:TaskQuery['project']}){const parts=['1'],args:SQLInputValue[]=[];
    if(q.taskId){parts.push('task_id=?');args.push(q.taskId);}if(q.parentRunId){parts.push("json_extract(data,'$.parentRunId')=?");args.push(q.parentRunId);}if(q.status){parts.push('status=?');args.push(q.status);}if(q.project?.kind==='project'){parts.push('project=?');args.push(q.project.projectId);}else if(q.project?.kind==='unassigned')parts.push("project='unassigned'");
    if(q.sessionId){parts.push("EXISTS(SELECT 1 FROM json_each(json_extract(runs.data,'$.sessionIds')) WHERE value=?)");args.push(q.sessionId);}
    const where=parts.join(' AND '),total=Number(this.db.prepare(`SELECT count(*) n FROM runs WHERE ${where}`).get(...args)?.n??0),b=bounds(q);b.page=Math.min(b.page,Math.max(0,Math.ceil(total/b.pageSize)-1));
    const rows=this.db.prepare(`SELECT data FROM runs WHERE ${where} ORDER BY time DESC,seq DESC,run_id LIMIT ? OFFSET ?`).all(...args,b.pageSize,b.page*b.pageSize);
    return this.envelope(rows.map(row=>this.runHeader(JSON.parse(String(row.data)))),total,b);}
  private reportPage(q:PageInput&{taskId?:string;runId?:string;project?:TaskQuery['project'];kind?:string;presentation?:TaskQuery['presentation']}){const parts=['p.source=r.source'],args:SQLInputValue[]=[];
    if(q.kind){parts.push("json_extract(p.data,'$.kind')=?");args.push(q.kind);}
    if(q.taskId){parts.push('p.task_id=?');args.push(q.taskId);}if(q.runId){parts.push('p.run_id=?');args.push(q.runId);}if(q.project?.kind==='project'){parts.push('r.project=?');args.push(q.project.projectId);}else if(q.project?.kind==='unassigned')parts.push("r.project='unassigned'");
    const from=`FROM reports p JOIN runs r ON r.run_id=p.run_id WHERE ${parts.join(' AND ')}`,total=Number(this.db.prepare(`SELECT count(*) n ${from}`).get(...args)?.n??0),b=bounds(q);b.page=Math.min(b.page,Math.max(0,Math.ceil(total/b.pageSize)-1));
    const items=this.db.prepare(`SELECT p.data ${from} ORDER BY p.seq DESC,p.id LIMIT ? OFFSET ?`).all(...args,b.pageSize,b.page*b.pageSize).map(row=>JSON.parse(String(row.data)));
    return this.envelope(items,total,b);}
  private record(taskId:string,runId?:string):ExecutorPanelRecord {const row=runId?this.db.prepare('SELECT data FROM runs WHERE task_id=? AND run_id=?').get(taskId,runId):this.db.prepare('SELECT data FROM tasks WHERE task_id=?').get(taskId);if(!row)throw new TaskError('NOT_FOUND','Local task or execution unavailable');return JSON.parse(String(row.data));}
  private runDetail(q:DemandReadInputs['taskRunDetail']){
    const row=this.record(q.taskId,q.runId);
    let execution:Pick<Run,'intentSnapshot'|'projectContext'|'contextNotes'>|undefined;
    let attempts:{attemptId:string;taskId:string;runId:string;nodeId:string;fence:number;state:string;sessionId?:string;executionId?:string}[]=[];
    if(row.source==='local-ledger'){
      execution=this.sources.ledger.getRun(row.runId);
      attempts=this.sources.ledger.demandReads.facts('attempt',row.runId).map(a=>({attemptId:a.attemptId,taskId:a.taskId,runId:a.runId,nodeId:a.nodeId,fence:a.fence,state:a.state,sessionId:a.sessionId,executionId:a.executionId}));
    }else if(row.source==='local-recovery'){
      const saved=row.attemptId?this.sources.store?.dispatch(row.attemptId):undefined;
      if(!saved||saved.claim.run.runId!==row.runId||saved.claim.task.taskId!==row.taskId)throw new TaskError('NOT_FOUND','Local recovery unavailable');
      execution=saved.claim.run;
      const a=saved.claim.attempt;
      if(a?.attemptId)attempts=[{attemptId:a.attemptId,taskId:a.taskId,runId:a.runId,nodeId:a.nodeId,fence:a.fence,state:row.authorityDisposition?.attemptState??a.state,sessionId:saved.sessionId,executionId:a.executionId}];
    }else execution=this.sources.queueExecution?.(row.runId);
    const snapshot=execution?.intentSnapshot;
    const retryPrompt=(execution?.contextNotes??[]).map(note=>typeof note==='string'?note:note.body).join('\n\n');
    return {run:{...this.runHeader(row),settlementSummary:row.report??null,retryPrompt,inputSnapshot:snapshot?{title:snapshot.title,description:snapshot.description,goal:snapshot.goal??null,criteria:snapshot.acceptanceCriteria,project:execution?.projectContext?.project??null}:null},
      attempts,reports:this.reportPage({taskId:q.taskId,runId:q.runId}),children:this.runPage({parentRunId:q.runId})};
  }
  private exact(row:ExecutorPanelRecord){
    if(row.source==='local-recovery'){
      const dispatch=row.attemptId?this.sources.store?.dispatch(row.attemptId):undefined;
      if(!dispatch||dispatch.claim.run.runId!==row.runId||dispatch.claim.task.taskId!==row.taskId)throw new TaskError('NOT_FOUND','Local recovery unavailable');
      return {...row,description:dispatch.claim.task.description??'',report:dispatch.result?.report?.body??dispatch.result?.summary,detail:dispatch.detail};
    }
    if(row.source==='local-ledger'){
      const task=this.sources.ledger.getTask(row.taskId),pending=this.pending.get(row.runId),result=pending?this.sources.pendingDetail(pending.commandId):undefined;
      return {...row,description:task.description,report:result?.settlement.report?.body??result?.settlement.summary??row.report};
    }
    return {...row,description:this.sources.queueDetail?.(row.runId)??''};
  }
  alert(recordId:string){
    this.sync();
    if(recordId.startsWith('claim:')){const claim=this.db.prepare('SELECT data FROM claims WHERE id=?').get(recordId.slice(6));if(claim)return (JSON.parse(String(claim.data)) as ExecutorClaim).alert;}
    const record=this.db.prepare("SELECT data FROM records WHERE json_extract(data,'$.alert.recordId')=? ORDER BY priority DESC,seq DESC LIMIT 1").get(recordId);
    if(!record)throw new TaskError('NOT_FOUND','Local alert unavailable');
    const row:ExecutorPanelRecord=JSON.parse(String(record.data));const alert=this.sources.decorate(row).alert;
    if(!alert)throw new TaskError('NOT_FOUND','Local alert unavailable');return alert;
  }
  read<M extends DemandReadMethod>(method:M,input:DemandReadInputs[M]):unknown{
    this.sync();
    switch(method){
      case 'readBootstrap':{const executorClaims=this.readClaims({});return {settings:{root:null,revision:0,enabled:false},viewCapabilities:{planner:true,executor:true},viewContext:{...this.context(),unresolvedClaims:executorClaims.items,truncated:executorClaims.total>executorClaims.items.length},nodes:[],scheduleRuntime:null,executorClaims};}
      case 'executorClaimsPage':return this.readClaims(input as DemandReadInputs['executorClaimsPage']);
      case 'taskPage':return this.taskPage(input as DemandReadInputs['taskPage']);
      case 'taskBoard':{const q=input as DemandReadInputs['taskBoard'],counts=this.counts(q),columnsCounts=q.status&&q.status!=='all'?this.counts({...q,status:'all'}):counts;
        const columns=Object.fromEntries(q.columns.map(column=>{const total=columnsCounts.matchedByStatus[column.status]??0,
          matchedByStatus=Object.fromEntries(statusNames.map(status=>[status,status===column.status?total:0]));
          return [column.status,this.taskPage({...q,status:column.status,page:column.page,pageSize:q.pageSize??5},{...columnsCounts,matchedTotal:total,matchedByStatus})];}));
        return {columns,counts,revision:this.revision(),sampledAt:new Date().toISOString(),viewContext:this.context(),nodes:[]};}
      case 'taskHistoryPage':{const q=input as DemandReadInputs['taskHistoryPage'];this.record(q.taskId);return this.runPage(q);}
      case 'executionPage':return this.runPage(input as DemandReadInputs['executionPage']);
      case 'reportListPage':return this.reportPage(input as DemandReadInputs['reportListPage']);
      case 'taskDetail':{const q=input as DemandReadInputs['taskDetail'],row=this.record(q.taskId),exact=this.exact(row);
        const sessionIds=this.db.prepare("SELECT DISTINCT s.value FROM runs r,json_each(json_extract(r.data,'$.sessionIds')) s WHERE r.task_id=? ORDER BY s.value").all(q.taskId).map(value=>String(value.value));
        return {task:{...this.card(row),sessionIds,description:exact.description,artifact:'本机执行结果',recommendation:[],candidateChecks:[]},runs:this.runPage({taskId:q.taskId,pageSize:5}),reports:this.reportPage({taskId:q.taskId}),childAttention:this.envelope([],0,{})};}
      case 'taskRunDetail':return this.runDetail(input as DemandReadInputs['taskRunDetail']);
      case 'taskReportDetail':{const q=input as DemandReadInputs['taskReportDetail'],cached=this.db.prepare('SELECT p.data,p.source,p.run_id FROM reports p JOIN runs r ON r.run_id=p.run_id AND r.source=p.source WHERE p.id=? AND p.task_id=?').get(q.reportId,q.taskId);if(!cached||q.runId&&cached.run_id!==q.runId)throw new TaskError('NOT_FOUND','Local report unavailable');
        const header=JSON.parse(String(cached.data)),row=this.record(q.taskId,String(cached.run_id));
        if(q.reportId.startsWith('native:')){const ready=this.sources.pendingDetail(q.reportId.slice(7));if(!ready)throw new TaskError('NOT_FOUND','Pending result unavailable');return {...header,body:ready.settlement.report?.body??ready.settlement.summary,workflowOutputs:[]};}
        if(cached.source==='local-recovery'){const exact=this.exact(row);return {...header,body:exact.report??'',workflowOutputs:[]};}
        const raw=this.sources.ledger.managementDatabase().prepare("SELECT data FROM entities WHERE kind='report' AND id=? AND parent=?").get(q.reportId,q.taskId);if(!raw)throw new TaskError('NOT_FOUND','Local report unavailable');const report=JSON.parse(String(raw.data));return {...header,body:report.body,workflowOutputs:report.workflowOutputs??[]};}
      case 'taskSessionAccess':{const q=input as DemandReadInputs['taskSessionAccess'];if(q.nodeId!==this.sources.nodeId||!this.db.prepare("SELECT 1 FROM runs WHERE task_id=? AND json_extract(data,'$.executionDriver')='dsh' AND EXISTS(SELECT 1 FROM json_each(json_extract(runs.data,'$.sessionIds')) WHERE value=?) LIMIT 1").get(q.taskId,q.sessionId))throw new TaskError('FORBIDDEN','Session does not belong to this local task');return {allowed:true};}
      case 'taskAttentionGroupPage':return {...this.envelope([],0,input as PageInput),totalAttention:0,unbound:0};
      case 'taskAttentionPage':return this.envelope([],0,input as PageInput);
      case 'taskGraphPage':return this.graphPage(input as DemandReadInputs['taskGraphPage']);
      case 'sessionTaskPage':{const q=input as DemandReadInputs['sessionTaskPage']&{rootTaskIds?:string[];offset?:number;limit?:number};
        if(q.rootTaskIds!==undefined||q.offset!==undefined||q.limit!==undefined)return this.sessionHeaders(q);
        return {...this.taskPage(q),sessionId:q.sessionId};}
      case 'projectListPage':case 'scheduleListPage':case 'workflowListPage':case 'projectResourcesPage':return this.envelope([],0,input as PageInput);
      default:throw new TaskError('BOUNDED_READS_UNSUPPORTED','This product is unavailable in the local executor view');
    }
  }
  private readClaims(q:PageInput){const b=bounds(q),total=Number(this.db.prepare('SELECT count(*) n FROM claims').get()?.n??0);b.page=Math.min(b.page,Math.max(0,Math.ceil(total/b.pageSize)-1));return this.envelope(this.db.prepare('SELECT data FROM claims ORDER BY seq DESC,id LIMIT ? OFFSET ?').all(b.pageSize,b.page*b.pageSize).map(row=>JSON.parse(String(row.data)) as ExecutorClaim),total,b);}
}
