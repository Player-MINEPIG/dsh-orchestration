import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { TaskError, type TaskLedger } from './ledger.js';
import type { CompactRun, CompactReport } from './ledger-read-index.js';
import type { ReadScope, TaskCard, TaskQuery, TaskCounts, TaskStatus, Responsibility, PageInput, PageResult, RunHeader, ReportHeader, ViewContext } from './demand-reads.js';

const statuses: TaskStatus[] = ['error','review','running','draft','queued','cancelling','accepted','done','handled','cancelled','archived','observed','unknown'];
const responsibilities: Responsibility[] = ['needs_user','coordinator','unreviewed','resolved','none'];
export function pageBounds(input: PageInput, defaultSize = 20, maximum = 50) {
  const page = input.page ?? 0, pageSize = input.pageSize ?? defaultSize;
  if (!Number.isSafeInteger(page) || page < 0 || page > 1_000_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maximum)
    throw new TaskError('INVALID','Invalid page bounds');
  return {page,pageSize};
}
/** The display product contains cards only. Filtering/counting/paging happens before its JSON is read. */
export class DemandTaskViews {
  constructor(readonly db: DatabaseSync, readonly ledger: TaskLedger, readonly nodeId: string,
    project: (taskId: string) => {card: TaskCard; search: string; nextTransition: number|null}|undefined,
    private readonly attentionCount:(taskId:string,scope:ReadScope)=>number) {
    db.exec('CREATE TABLE IF NOT EXISTS demand_display_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)');
    const displayVersion=db.prepare('SELECT version FROM demand_display_meta WHERE id=1').get()?.version;
    if(displayVersion!==1)db.exec('DROP TABLE IF EXISTS demand_task_display');
    db.exec(`CREATE TABLE IF NOT EXISTS demand_task_display(id TEXT PRIMARY KEY,seq INTEGER NOT NULL,project TEXT NOT NULL,title TEXT NOT NULL,search_text TEXT NOT NULL,status TEXT NOT NULL,responsibility TEXT NOT NULL,coordinator INTEGER NOT NULL,unread INTEGER NOT NULL,updated_at TEXT NOT NULL,next_transition_at REAL,data TEXT NOT NULL,header_digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS demand_session_digest ON demand_task_display(id,status,header_digest);
      CREATE INDEX IF NOT EXISTS demand_display_order ON demand_task_display(updated_at DESC,seq DESC,id);
      CREATE INDEX IF NOT EXISTS demand_display_project ON demand_task_display(project,coordinator,status,updated_at DESC,seq DESC);
      CREATE INDEX IF NOT EXISTS demand_display_due ON demand_task_display(next_transition_at,id);
      CREATE INDEX IF NOT EXISTS demand_display_status ON demand_task_display(coordinator,status,updated_at DESC,seq DESC);
      CREATE INDEX IF NOT EXISTS demand_display_responsibility ON demand_task_display(responsibility,updated_at DESC,seq DESC);`);
    db.prepare('INSERT OR REPLACE INTO demand_display_meta VALUES(1,1)').run();
    // Display-only sources invalidate their dependency closure, never every historical task.
    const seeds:Record<string,(row:string)=>string>={
      wb_backlog_tasks:row=>`SELECT ${row}.task_id id`,
      wb_backlogs:row=>`SELECT task_id id FROM wb_backlog_tasks WHERE backlog_id=${row}.backlog_id`,
      wb_projects:row=>`SELECT l.task_id id FROM wb_backlog_tasks l JOIN wb_backlogs b ON b.backlog_id=l.backlog_id WHERE b.project_id=${row}.project_id`,
      pr_task_presentation:row=>`SELECT ${row}.task id`,pr_dispatch:row=>`SELECT ${row}.task id`,pr_task_routes:row=>`SELECT ${row}.task id`,
      pr_report_reads:row=>`SELECT task_id id FROM demand_entity_facts WHERE kind='report' AND id=${row}.report`,
      workflow_task_bindings:row=>`SELECT ${row}.task_id id`,
      workflow_runs:row=>`SELECT task_id id FROM demand_entity_facts WHERE kind='run' AND id=json_extract(${row}.data,'$.runId')`,
    };
    for(const [table,seed] of Object.entries(seeds)) {
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
      for(const operation of ['INSERT','UPDATE','DELETE']) {
        const rows=operation==='UPDATE'?['OLD','NEW']:[operation==='DELETE'?'OLD':'NEW'];
        const invalidations=rows.map(row=>`INSERT INTO demand_task_dirty(task_id,generation)
          WITH RECURSIVE seed(id) AS (${seed(row)}), descendants(id) AS (SELECT id FROM seed UNION SELECT f.id FROM demand_entity_facts f JOIN descendants d ON f.parent=d.id WHERE f.kind='task'),
          related(id) AS (SELECT id FROM descendants UNION SELECT f.parent FROM demand_entity_facts f JOIN related r ON f.id=r.id WHERE f.kind='task' AND f.parent IS NOT NULL)
          SELECT id,(SELECT revision FROM demand_read_meta WHERE id=1) FROM related WHERE id IS NOT NULL ON CONFLICT(task_id) DO UPDATE SET generation=excluded.generation;`).join('');
        db.exec(`CREATE TRIGGER IF NOT EXISTS demand_display_${table}_${operation} AFTER ${operation} ON ${table} BEGIN UPDATE demand_read_meta SET revision=revision+1 WHERE id=1;${invalidations} END;`);
      }
    }
    db.exec(`INSERT INTO demand_task_dirty(task_id,generation) SELECT f.id,0 FROM demand_entity_facts f LEFT JOIN demand_task_display d ON d.id=f.id WHERE f.kind='task' AND d.id IS NULL ON CONFLICT(task_id) DO NOTHING`);
    ledger.demandReads.bindProjector(taskId => {
      const value = project(taskId);
      if (!value) { db.prepare('DELETE FROM demand_task_display WHERE id=?').run(taskId); return; }
      const card = value.card;
      const seq = Number(db.prepare("SELECT seq FROM demand_entity_facts WHERE kind='task' AND id=?").get(taskId)?.seq ?? 0);
      db.prepare(`INSERT INTO demand_task_display VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,project=excluded.project,title=excluded.title,search_text=excluded.search_text,status=excluded.status,responsibility=excluded.responsibility,coordinator=excluded.coordinator,unread=excluded.unread,updated_at=excluded.updated_at,next_transition_at=excluded.next_transition_at,data=excluded.data,header_digest=excluded.header_digest`)
        .run(card.id,seq,card.project,card.title,value.search,card.status,card.checkin.responsibility.state,Number(card.showInCoordinator),card.unreadResultCount,card.time,value.nextTransition,JSON.stringify(card),createHash('sha256').update(JSON.stringify({id:card.id,title:card.title,status:card.status,stateLabel:card.stateLabel,parentTaskId:card.parentTaskId,runId:card.runId,runState:card.runState,reviewStatus:card.reviewStatus,node:card.node,model:card.model,time:card.time,returnedAt:card.returnedAt,actionVersion:card.actionVersion,reportVersion:card.reportId?ledger.demandReads.fact('report',card.reportId)?.contentVersion:null})).digest('hex'));
    });
  }
  current<T>(read:()=>T):T {
    this.db.prepare(`INSERT INTO demand_task_dirty(task_id,generation) SELECT id,(SELECT revision FROM demand_read_meta WHERE id=1) FROM demand_task_display WHERE next_transition_at<=? ON CONFLICT(task_id) DO UPDATE SET generation=excluded.generation`).run(Date.parse(this.ledger.managementNow()));
    return this.ledger.demandReads.withCurrent(read);
  }
  context(scope:ReadScope):ViewContext { return {role:scope.kind==='planner'?'planner':'executor',scope:scope.kind==='planner'?'all':'node',nodeId:scope.kind==='node'?scope.nodeId:this.nodeId,observedAt:new Date().toISOString()}; }
  /** Seeds descend before ancestors are added, so context ancestors never grant sibling access. */
  scope(scope:ReadScope):{cte:string;args:SQLInputValue[];predicate:string} {
    if(scope.kind==='planner') return {cte:'',args:[],predicate:'1'};
    const collaboration = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_bindings'").get();
    return {cte:`WITH RECURSIVE seeds(id) AS (
      SELECT task_id FROM demand_entity_facts WHERE kind IN ('run','attempt','schedule') AND node_id=?
      UNION SELECT id FROM demand_entity_facts WHERE kind='task' AND json_extract(data,'$.workspaceId') IN (SELECT id FROM demand_entity_facts WHERE kind='workspace' AND node_id=?)
      ${collaboration?`UNION SELECT d.id FROM demand_task_display d JOIN collaboration_bindings b ON b.project_id=d.project WHERE b.owner_node_id=?`:''}),
      descendants(id) AS (SELECT id FROM seeds UNION SELECT f.id FROM demand_entity_facts f JOIN descendants d ON f.parent=d.id WHERE f.kind='task'),
      visible(id) AS (SELECT id FROM descendants UNION SELECT f.parent FROM demand_entity_facts f JOIN visible v ON f.id=v.id WHERE f.kind='task' AND f.parent IS NOT NULL) `,
      args:collaboration?[scope.nodeId,scope.nodeId,scope.nodeId]:[scope.nodeId,scope.nodeId],predicate:'d.id IN (SELECT id FROM visible)'};
  }
  private query(query:TaskQuery, scope:ReadScope, facets=false) {
    const access=this.scope(scope),parts=[access.predicate],args=[...access.args];
    if(query.project?.kind==='unassigned') parts.push("d.project='unassigned'");
    else if(query.project?.kind==='project') {parts.push('d.project=?');args.push(query.project.projectId);}
    const presentation=query.presentation??'coordinator';
    if(presentation!=='all') {parts.push('d.coordinator=?');args.push(Number(presentation==='coordinator'));}
    if(!facets) {
      if(query.status&&query.status!=='all') {if(!statuses.includes(query.status))throw new TaskError('INVALID','Invalid status');parts.push('d.status=?');args.push(query.status);}
      if(query.responsibility&&query.responsibility!=='all') {if(!responsibilities.includes(query.responsibility))throw new TaskError('INVALID','Invalid responsibility');parts.push('d.responsibility=?');args.push(query.responsibility);}
      if(query.unreadCompletedOnly) parts.push("d.unread>0 AND d.status IN ('done','accepted')");
      if(query.search) {if(query.search.length>500)throw new TaskError('INVALID','Search is too long');parts.push("instr(lower(d.search_text),lower(?))>0");args.push(query.search);}
    }
    return {cte:access.cte,where:parts.join(' AND '),args};
  }
  counts(query:TaskQuery,scope:ReadScope):TaskCounts {
    const base=this.query(query,scope,true),match=this.query(query,scope);
    const byStatus=Object.fromEntries(statuses.map(s=>[s,0])) as Record<TaskStatus,number>,byResponsibility=Object.fromEntries(responsibilities.map(s=>[s,0])) as Record<Responsibility,number>;
    for(const row of this.db.prepare(`${base.cte} SELECT status,COUNT(*) n FROM demand_task_display d WHERE ${base.where} GROUP BY status`).all(...base.args)) byStatus[String(row.status) as TaskStatus]=Number(row.n);
    for(const row of this.db.prepare(`${base.cte} SELECT responsibility,COUNT(*) n FROM demand_task_display d WHERE ${base.where} GROUP BY responsibility`).all(...base.args)) byResponsibility[String(row.responsibility) as Responsibility]=Number(row.n);
    const matchedByStatus={...Object.fromEntries(statuses.map(s=>[s,0]))} as Record<TaskStatus,number>;
    for(const row of this.db.prepare(`${match.cte} SELECT status,COUNT(*) n FROM demand_task_display d WHERE ${match.where} GROUP BY status`).all(...match.args)) matchedByStatus[String(row.status) as TaskStatus]=Number(row.n);
    return {baseTotal:Object.values(byStatus).reduce((a,b)=>a+b,0),byStatus,byResponsibility,
      unreadCompleted:Number(this.db.prepare(`${base.cte} SELECT COUNT(*) n FROM demand_task_display d WHERE ${base.where} AND d.unread>0 AND d.status IN ('done','accepted')`).get(...base.args)?.n??0),matchedTotal:Object.values(matchedByStatus).reduce((a,b)=>a+b,0),matchedByStatus};
  }
  envelope<T>(items:T[],total:number,bounds:{page:number;pageSize:number}):PageResult<T>{return {...bounds,items,total,pages:Math.ceil(total/bounds.pageSize),revision:this.ledger.demandReads.revision,sampledAt:new Date().toISOString()};}
  mask(card:TaskCard,scope:ReadScope):TaskCard {
    const visible={...card,childAttentionCount:this.attentionCount(card.id,scope),deviceLabel:card.node};
    if(scope.kind==='planner')return visible;
    const owner=this.ledger.demandReads.fact('task',card.id)?.dispatchOrigin;
    const own=owner?.kind==='session'&&owner.nodeId===scope.nodeId;
    return {...visible,canHandle:false,canConfirm:false,canComplete:false,canRequestMaterials:false,canCancel:card.canCancel&&own,canRetry:false,canRestore:false,canReconcile:false,canRequestStatus:card.canRequestStatus&&own};
  }
  card(id:string,scope:ReadScope):TaskCard {
    const access=this.scope(scope),row=this.db.prepare(`${access.cte} SELECT d.data FROM demand_task_display d WHERE d.id=? AND ${access.predicate}`).get(...access.args,id);
    if(!row)throw new TaskError('NOT_FOUND','Task unavailable');
    return this.mask(JSON.parse(String(row.data)),scope);
  }
  selectTaskPage(query:TaskQuery&PageInput,scope:ReadScope,total:number):PageResult<TaskCard> {
    const bounds=pageBounds(query),q=this.query(query,scope);
    bounds.page=Math.min(bounds.page,Math.max(0,Math.ceil(total/bounds.pageSize)-1));
    const items=this.db.prepare(`${q.cte} SELECT d.data FROM demand_task_display d WHERE ${q.where} ORDER BY d.updated_at DESC,d.seq DESC,d.id LIMIT ? OFFSET ?`).all(...q.args,bounds.pageSize,bounds.page*bounds.pageSize).map(row=>this.mask(JSON.parse(String(row.data)),scope));
    return this.envelope(items,total,bounds);
  }
  taskPage(query:TaskQuery&PageInput,scope:ReadScope) {
    const counts=this.counts(query,scope);
    return {...this.selectTaskPage(query,scope,counts.matchedTotal),counts,viewContext:this.context(scope)};
  }
  runHeader(run:CompactRun,seq:number):RunHeader {
    const task=this.db.prepare('SELECT title,project FROM demand_task_display WHERE id=?').get(run.taskId);
    const parent=this.ledger.demandReads.fact('task',run.taskId)?.parentTaskId??null;
    const reports=this.db.prepare("SELECT COUNT(*) n,SUM(CASE WHEN json_extract(f.data,'$.kind')='result' AND NOT EXISTS(SELECT 1 FROM pr_report_reads rr WHERE rr.report=f.id AND rr.version=json_extract(f.data,'$.contentVersion')) THEN 1 ELSE 0 END) unread FROM demand_entity_facts f WHERE f.kind='report' AND f.run_id=?").get(run.runId);
    return {delegationDisplay:this.ledger.demandReads.fact('task',run.taskId)?.delegationDisplay?.mode??'task',id:run.runId,taskId:run.taskId,state:run.state,node:run.route?.nodeId??null,model:run.route?.model??null,createdAt:run.createdAt,parentRunId:run.parentRunId??null,parentTaskId:parent,
      reviewStatus:run.reviewStatus??null,executionStartedAt:run.executionStartedAt??null,executionEndedAt:['queued','running'].includes(run.state)?null:run.updatedAt,outcome:run.outcome??null,observationOnly:!!run.observationOnly,
      executionDriver:run.workflowInvocation?'workflow':run.observationOnly?'source':run.route?.backend?'official-codex':'dsh',reasoningEffort:run.route?.reasoningEffort??null,occurrenceId:run.occurrenceId??null,sessionIds:this.db.prepare("SELECT session_id FROM run_context_sessions WHERE run_id=? UNION SELECT json_extract(data,'$.sessionId') FROM demand_entity_facts WHERE kind='attempt' AND run_id=? AND json_extract(data,'$.sessionId') IS NOT NULL").all(run.runId,run.runId).map(row=>String(row.session_id)),
      insertionOrdinal:Number(this.db.prepare("SELECT COUNT(*) n FROM demand_entity_facts WHERE kind='run' AND task_id=? AND seq<=?").get(run.taskId,seq)?.n??0),reportCount:Number(reports?.n??0),unreadResultCount:Number(reports?.unread??0),taskTitle:String(task?.title??run.taskId),projectTitle:String(task?.project??'unassigned')};
  }
  runPage(input:PageInput&{taskId?:string;parentRunId?:string;status?:string;sessionId?:string;project?:TaskQuery['project']},scope:ReadScope,defaultSize=20):PageResult<RunHeader> {
    const bounds=pageBounds(input,defaultSize),access=this.scope(scope),where=["f.kind='run'",access.predicate],args=[...access.args];
    for(const [field,column] of [['taskId','f.task_id'],['parentRunId',"json_extract(f.data,'$.parentRunId')"],['status','f.state']] as const)if(input[field]){where.push(`${column}=?`);args.push(input[field]!);}
    if(input.project?.kind==='project'){where.push('d.project=?');args.push(input.project.projectId);}else if(input.project?.kind==='unassigned')where.push("d.project='unassigned'");
    if(input.sessionId){where.push("(EXISTS(SELECT 1 FROM demand_entity_facts a WHERE a.kind='attempt' AND a.run_id=f.id AND json_extract(a.data,'$.sessionId')=?) OR EXISTS(SELECT 1 FROM run_context_sessions c WHERE c.run_id=f.id AND c.session_id=?))");args.push(input.sessionId,input.sessionId);}
    const from=`FROM demand_entity_facts f JOIN demand_task_display d ON d.id=f.task_id WHERE ${where.join(' AND ')}`;
    const total=Number(this.db.prepare(`${access.cte} SELECT COUNT(*) n ${from}`).get(...args)?.n??0);
    bounds.page=Math.min(bounds.page,Math.max(0,Math.ceil(total/bounds.pageSize)-1));
    const rows=this.db.prepare(`${access.cte} SELECT f.data,f.seq ${from} ORDER BY f.seq DESC LIMIT ? OFFSET ?`).all(...args,bounds.pageSize,bounds.page*bounds.pageSize);
    return this.envelope(rows.map(row=>this.runHeader(JSON.parse(String(row.data)),Number(row.seq))),total,bounds);
  }
  reportHeader(report:CompactReport):ReportHeader {
    const readAt=this.db.prepare('SELECT read_at FROM pr_report_reads WHERE report=? AND version=?').get(report.reportId,report.contentVersion)?.read_at;
    return {id:report.reportId,taskId:report.taskId,...(report.runId?{runId:report.runId}:{}),kind:report.kind,title:report.title,contentVersion:report.contentVersion,readAt:readAt?String(readAt):null,unread:report.kind==='result'&&!readAt,hasHtmlPresentation:report.hasHtmlPresentation,createdAt:report.createdAt,recordedAt:report.recordedAt};
  }
  reportPage(input:PageInput&{taskId?:string;runId?:string;project?:TaskQuery['project'];kind?:CompactReport['kind'];presentation?:'coordinator'|'execution'|'all'},scope:ReadScope):PageResult<ReportHeader> {
    const bounds=pageBounds(input),access=this.scope(scope),where=["f.kind='report'",access.predicate],args=[...access.args];
    if(input.taskId){where.push('f.task_id=?');args.push(input.taskId);}if(input.runId){where.push('f.run_id=?');args.push(input.runId);}
    if(input.kind){where.push("json_extract(f.data,'$.kind')=?");args.push(input.kind);}if(input.presentation&&input.presentation!=='all'){where.push('d.coordinator=?');args.push(Number(input.presentation==='coordinator'));}
    if(input.project?.kind==='project'){where.push('d.project=?');args.push(input.project.projectId);}else if(input.project?.kind==='unassigned')where.push("d.project='unassigned'");
    const from=`FROM demand_entity_facts f JOIN demand_task_display d ON d.id=f.task_id WHERE ${where.join(' AND ')}`;
    const total=Number(this.db.prepare(`${access.cte} SELECT COUNT(*) n ${from}`).get(...args)?.n??0);
    bounds.page=Math.min(bounds.page,Math.max(0,Math.ceil(total/bounds.pageSize)-1));
    const rows=this.db.prepare(`${access.cte} SELECT f.data ${from} ORDER BY f.seq DESC LIMIT ? OFFSET ?`).all(...args,bounds.pageSize,bounds.page*bounds.pageSize);
    return this.envelope(rows.map(row=>this.reportHeader(JSON.parse(String(row.data)))),total,bounds);
  }
}
