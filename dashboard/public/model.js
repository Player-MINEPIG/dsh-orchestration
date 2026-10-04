/* Read-only projections of packages/task-system/src/contracts.ts. No second ledger. */
export const STATE_LABELS = Object.freeze({candidate:'候选',partial:'部分完成',inbox:'待整理',ready:'待执行',running:'进行中',waiting:'等待中',completed:'已完成',failed:'失败',cancelled:'已取消',archived:'已归档',queued:'排队中',blocked:'受阻',succeeded:'成功',uncertain:'结果待确认'});
export const REPORT_LABELS = Object.freeze({progress:'进展',result:'结果',review:'复盘',observation:'状态记录'});
export const TERMINAL_TASK_STATES = new Set(['completed','cancelled','archived']);
export const ATTENTION_TASK_STATES = new Set(['waiting','failed']);
export const escapeHtml = (value='') => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const safeUri = value => { try { const url=new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch {return null;} };
export const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export const newestFirst = (items,key='createdAt') => [...items].sort((a,b)=>timestamp(b[key])-timestamp(a[key]));
export const sourceIsStale = (at,staleAfterMs,now=Date.now()) => !timestamp(at) || now-timestamp(at)>staleAfterMs;
export const taskIsStale = (task,snapshot,now=Date.now()) => !TERMINAL_TASK_STATES.has(task.state) && sourceIsStale(task.updatedAt,snapshot.source.staleAfterMs,now);
export function validateSnapshot(data){
  if(!data || data.schemaVersion!=='1') throw new Error('不支持的数据版本');
  for(const key of ['tasks','runs','reports','artifacts','templates','events']) if(!Array.isArray(data[key])) throw new Error(`缺少 ${key} 数据`);
  if(!data.source || !Number.isFinite(data.source.staleAfterMs) || data.source.staleAfterMs<=0) throw new Error('缺少数据来源或有效的过期时间');
  for(const [kind,id] of [['tasks','taskId'],['runs','runId'],['reports','reportId'],['artifacts','artifactId']]){
    const ids=new Set();
    for(const record of data[kind]){
      if(typeof record[id]!=='string'||!record[id]||ids.has(record[id])) throw new Error(`${kind} 标识无效或重复`);
      ids.add(record[id]);
    }
  }
  return data;
}
export const isDismissed = task => task?.admissionState==='dismissed';
export function visibleTasks(snapshot,{includeDismissed=false}={}){
  return snapshot.tasks.filter(task=>includeDismissed||!isDismissed(task));
}
export function visibleRecords(snapshot,collection,{includeDismissed=false}={}){
  const hidden=new Set(includeDismissed?[]:snapshot.tasks.filter(isDismissed).map(task=>task.taskId));
  return (snapshot[collection]||[]).filter(record=>!hidden.has(record.taskId));
}
export function filteredTasks(snapshot,filter='all',query='',{includeDismissed=false}={}){
  const term=query.trim().toLocaleLowerCase();
  return newestFirst(visibleTasks(snapshot,{includeDismissed}),'updatedAt').filter(task=>{
    const match=filter==='all'||(filter==='active'&&!TERMINAL_TASK_STATES.has(task.state))||(filter==='attention'&&ATTENTION_TASK_STATES.has(task.state))||(filter==='completed'&&task.state==='completed');
    if(!match) return false;
    if(!term) return true;
    return [task.title,task.description,task.taskId,...(task.tags||[])].some(value=>String(value||'').toLocaleLowerCase().includes(term));
  });
}
export function taskRecords(snapshot,taskId){
  return {runs:newestFirst(snapshot.runs.filter(x=>x.taskId===taskId)),reports:newestFirst(snapshot.reports.filter(x=>x.taskId===taskId)),artifacts:newestFirst(snapshot.artifacts.filter(x=>x.taskId===taskId)),events:newestFirst(snapshot.events.filter(x=>x.taskId===taskId),'at')};
}
export const runEvents = (snapshot,runId) => newestFirst(snapshot.events.filter(event=>event.runId===runId),'at');
export function taskStats(snapshot,{includeDismissed=false}={}){
  const tasks=visibleTasks(snapshot,{includeDismissed});
  return {total:tasks.length,active:tasks.filter(t=>!TERMINAL_TASK_STATES.has(t.state)).length,attention:tasks.filter(t=>ATTENTION_TASK_STATES.has(t.state)).length,completed:tasks.filter(t=>t.state==='completed').length,reports:visibleRecords(snapshot,'reports',{includeDismissed}).length,runs:visibleRecords(snapshot,'runs',{includeDismissed}).length,dismissed:snapshot.tasks.filter(isDismissed).length,allTotal:snapshot.tasks.length};
}
export function parseRoute(hash){
  const pieces=hash.replace(/^#/,'').split('/');
  if(pieces[0]==='task'&&pieces[1]){try{return {view:'task',taskId:decodeURIComponent(pieces[1]),tab:['overview','runs','reports','artifacts'].includes(pieces[2])?pieces[2]:'overview'};}catch{return {view:'not-found'};}}
  return {view:['tasks','runs','reports','configuration'].includes(pieces[0])?pieces[0]:'tasks'};
}
