import { createHash } from "node:crypto";
import type { PageResult, RunHeader, TaskStatus, ViewContext, DemandReadInputs } from "./demand-reads.js";
import type { LocalCodexStore } from "./local-codex.js";
import { TaskError } from "./ledger.js";
import { parseTaskStatus } from "./demand-read-inputs.js";
import { z } from "zod";
import { codexJobRows, type CodexJobRecord, type SessionJobRegistry } from "./session-codex-jobs.js";

type MaybePromise<T> = T | Promise<T>;
export type SessionTaskOwner = "task" | "local-codex" | "codex-cli";
export interface SessionTaskHeader {
  id: string; title: string; status: TaskStatus; direct: boolean; time?: string | null;
  returnedAt?: string | null; owner: SessionTaskOwner; source?: string;
  stateLabel?: string | null; parentTaskId?: string | null; runId?: string | null;
  runState?: string | null; reviewStatus?: string | null; node?: string | null; model?: string | null;
  sessionId?: string; sessionIds?: string[]; reasoningEffort?: string;
  detailVersion?: string;
}
export interface SessionHeaderQuery { status?: TaskStatus | "all"; search?: string; offset: number; limit: number }
export interface SessionHeaderSlice {
  items: SessionTaskHeader[]; total: number; counts: Record<string, number>; directCount: number;
  unavailableTasks: number; revision: string; sampledAt: string; viewContext?: ViewContext; runs?: RunHeader[];
}
/** Already bound to one authorized session and authority scope. Bounds precede payload decoding. */
export interface SessionTaskHeaderSource { readHeaders(query: SessionHeaderQuery): MaybePromise<SessionHeaderSlice> }
export interface SessionTaskPage extends PageResult<SessionTaskHeader> {
  sessionId: string; tasks: SessionTaskHeader[]; counts: Record<string, number>; directCount: number;
  localCodexCount: number; externalDispatchCount: number; pendingDispatches: number; unavailableTasks: number;
  runs: RunHeader[]; viewContext?: ViewContext;
}
export interface SessionTaskDetail {
  task: SessionTaskHeader & { description?: string; report?: string; cwd?: string; permissionLabel?: string;
    acceptance?: {sessionId:string;evidence:string;acceptedAt:string} };
  runs: PageResult<SessionRunHeader>;
}
export interface SessionRunHeader {id:string;taskId:string;state:string;createdAt:string;reviewStatus?:string|null;node?:string|null;model?:string|null;parentRunId?:string|null;parentTaskId?:string|null;sessionIds:string[]}
export interface SessionDemandDependencies {
  sessionId: string; roots: readonly string[]; pendingDispatches: number; codexJobs: readonly CodexJobRecord[];
  jobs?: SessionJobRegistry; localCodex?: LocalCodexStore;
  ledgerSource: SessionTaskHeaderSource; localExecutorSource?: SessionTaskHeaderSource;
  taskOverlaySources?: readonly SessionTaskHeaderSource[];
}
const headerSchema=z.object({id:z.string(),title:z.string(),status:z.string().transform(parseTaskStatus),direct:z.boolean(),time:z.string().nullable().optional(),returnedAt:z.string().nullable().optional(),source:z.string().optional(),stateLabel:z.string().nullable().optional(),parentTaskId:z.string().nullable().optional(),runId:z.string().nullable().optional(),runState:z.string().nullable().optional(),reviewStatus:z.string().nullable().optional(),node:z.string().nullable().optional(),model:z.string().nullable().optional(),sessionId:z.string().optional(),sessionIds:z.array(z.string()).optional(),reasoningEffort:z.string().optional(),detailVersion:z.string().optional()});
const sourceSliceSchema=z.object({items:z.array(headerSchema),total:z.number().int().nonnegative(),counts:z.record(z.string(),z.number().int().nonnegative()),directCount:z.number().int().nonnegative(),unavailableTasks:z.number().int().nonnegative(),revision:z.string(),sampledAt:z.string(),viewContext:z.object({role:z.enum(['planner','executor']),scope:z.enum(['all','central','node','local']),nodeId:z.string(),displayName:z.string().optional(),observedAt:z.string()}).optional()});
export function parseSessionHeaderSlice(input:unknown):SessionHeaderSlice {
  const value=sourceSliceSchema.parse(input);
  return {...value,items:value.items.map(row=>({...row,owner:'task'}))};
}
const sessionRunSchema=z.object({id:z.string(),taskId:z.string(),state:z.string(),createdAt:z.string(),reviewStatus:z.string().nullable().optional(),node:z.string().nullable().optional(),model:z.string().nullable().optional(),parentRunId:z.string().nullable().optional(),parentTaskId:z.string().nullable().optional(),sessionIds:z.array(z.string()).default([])});
const sessionDetailSchema=z.object({task:headerSchema.omit({direct:true}).extend({direct:z.boolean().default(false),description:z.string().optional(),reportId:z.string().nullable().optional(),reportPreview:z.string().optional()}),runs:z.object({items:z.array(sessionRunSchema),total:z.number(),page:z.number(),pageSize:z.number(),pages:z.number(),revision:z.string(),sampledAt:z.string()})});
export function parseLedgerSessionDetail(input:unknown):SessionTaskDetail & {reportId?:string|null} {
  const value=sessionDetailSchema.parse(input);
  return {task:{...value.task,owner:'task',report:value.task.reportPreview},runs:value.runs,reportId:value.task.reportId};
}
export function emptySessionRuns():PageResult<SessionRunHeader> {return {items:[],page:0,pageSize:5,total:0,pages:0,revision:'empty',sampledAt:new Date().toISOString()};}
const timestamp = (value?: string | null) => value ? Date.parse(value) || 0 : 0;
const idOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function compareSessionHeaders(a: SessionTaskHeader, b: SessionTaskHeader) {
  return timestamp(b.returnedAt) - timestamp(a.returnedAt) || timestamp(b.time) - timestamp(a.time) || idOrder(a.id, b.id) || idOrder(a.owner, b.owner);
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function updating(): never { throw new TaskError("READ_MODEL_UPDATING", "Session read changed while selecting a page"); }

/** Small receipt-derived shell job headers are already metadata, never process output. */
export function arraySessionHeaderSource(items: readonly SessionTaskHeader[]): SessionTaskHeaderSource {
  const ordered = [...items].sort(compareSessionHeaders), counts: Record<string, number> = {all: ordered.length};
  for (const row of ordered) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const directCount = ordered.filter(row => row.direct).length, revision = digest(ordered), sampledAt = new Date().toISOString();
  return {readHeaders(query) {
    const search = query.search?.toLowerCase() ?? "";
    const rows = ordered.filter(row => (!query.status || query.status === "all" || row.status === query.status) &&
      (!search || [row.title,row.node,row.id,row.parentTaskId,row.runId,row.sessionId,...(row.sessionIds ?? []),row.stateLabel].filter(Boolean).join(" ").toLowerCase().includes(search)));
    return {items: rows.slice(query.offset,query.offset+query.limit),total:rows.length,counts,directCount,unavailableTasks:0,revision,sampledAt};
  }};
}

/** Select a union page by indexed rank probes; never retrieve the prefix before its offset. */
export async function readSessionDemandPage(input: DemandReadInputs["sessionTaskPage"], deps: SessionDemandDependencies): Promise<SessionTaskPage> {
  const pageSize = Math.min(50,Math.max(1,input.pageSize ?? 20));
  const taskSource = deps.localExecutorSource ?? deps.ledgerSource;
  const sources: SessionTaskHeaderSource[] = [taskSource,...(deps.localExecutorSource?[]:deps.taskOverlaySources??[])];
  const taskSourceCount=sources.length;
  const localIndex = deps.localCodex ? sources.push(deps.localCodex.headerSource(deps.sessionId))-1 : -1;
  const jobs = codexJobRows(deps.codexJobs,deps.sessionId,deps.jobs).map(row => ({
    id:row.id,title:row.title,status:parseTaskStatus(row.status),stateLabel:row.stateLabel,direct:true,owner:"codex-cli",
    source:row.source,node:row.node,model:row.model,time:row.time,returnedAt:row.returnedAt,
  } satisfies SessionTaskHeader));
  sources.push(arraySessionHeaderSource(jobs));
  const query = {status:input.status,search:input.search};
  const states = await Promise.all(sources.map(async (source,index) => {
    const initial = await source.readHeaders({...query,offset:0,limit:1});
    const probes = new Map<number,SessionTaskHeader>();
    if(initial.items[0])probes.set(0,initial.items[0]);
    return {source,index,initial,probes,position:0};
  }));
  const authority = states[0];
  if(!authority)updating();
  const total = states.reduce((n,state) => n+state.initial.total,0), pages = Math.ceil(total/pageSize);
  const page = Math.min(Math.max(0,input.page ?? 0),Math.max(0,pages-1));
  type SourceState = typeof authority;
  const read = async (state:SourceState,offset:number,limit:number) => {
    const result = await state.source.readHeaders({...query,offset,limit});
    if(result.revision!==state.initial.revision||result.total!==state.initial.total)updating();
    return result;
  };
  const at = async (state:SourceState,rank:number) => {
    const cached=state.probes.get(rank);
    if(cached)return cached;
    const result=await read(state,rank,1),value=result.items[0];
    if(!value)updating();
    state.probes.set(rank,value);
    return value;
  };
  let remaining=page*pageSize;
  while(remaining>0){
    const active=states.filter(state=>state.position<state.initial.total);
    if(!active.length)updating();
    const step=Math.max(1,Math.floor(remaining/active.length));
    const pivots=await Promise.all(active.map(async state=>{
      const count=Math.min(step,state.initial.total-state.position);
      return {state,count,value:await at(state,state.position+count-1)};
    }));
    pivots.sort((a,b)=>compareSessionHeaders(a.value,b.value)||a.state.index-b.state.index);
    const chosen=pivots[0];
    if(!chosen)updating();
    chosen.state.position+=chosen.count;
    remaining-=chosen.count;
  }
  const tails=await Promise.all(states.map(state=>state.position===state.initial.total?{...state.initial,items:[],runs:[]}:read(state,state.position,Math.min(pageSize,state.initial.total-state.position))));
  const items=tails.flatMap(source=>source.items).sort(compareSessionHeaders).slice(0,pageSize),counts:Record<string,number>={all:0};
  for(const state of states)for(const [status,count]of Object.entries(state.initial.counts))counts[status]=(counts[status]??0)+count;
  const taskIds=new Set(items.filter(row=>row.owner==="task").map(row=>row.id));
  const runs=tails.slice(0,taskSourceCount).flatMap(source=>source.runs??[]).filter(run=>taskIds.has(run.taskId));
  return {sessionId:deps.sessionId,items,tasks:items,page,pageSize,total,pages,counts,
    directCount:states.reduce((n,state)=>n+state.initial.directCount,0),localCodexCount:states.find(state=>state.index===localIndex)?.initial.counts.all??0,
    externalDispatchCount:deps.codexJobs.length,pendingDispatches:deps.pendingDispatches,unavailableTasks:authority.initial.unavailableTasks,
    runs,revision:digest(states.map(state=>state.initial.revision)),sampledAt:new Date().toISOString(),viewContext:authority.initial.viewContext};
}
