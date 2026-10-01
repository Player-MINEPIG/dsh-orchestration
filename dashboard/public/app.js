import {STATE_LABELS,REPORT_LABELS,escapeHtml as e,safeUri,newestFirst,sourceIsStale,taskIsStale,validateSnapshot,filteredTasks,taskRecords,taskStats,parseRoute,isDismissed,visibleRecords} from './model.js';
const config={apiBase:'./api',refreshIntervalMs:15000,...window.DSH_DASHBOARD_CONFIG};
const API=new URL(config.apiBase.replace(/\/$/,'')+'/',location.href.split('#')[0]);
const main=document.querySelector('#main');
const SNAPSHOT_MODE=config.mode==='snapshot';
let data=null,loadError=null,isLoading=false,filter='all',query='',listQuery='',showDismissed=false,requestNumber=0,lastFetchedAt=null;
const icons={info:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7.3"/><path d="M10 9v5m0-8v1"/></svg>',search:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>',folder:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2 4h5l1 2h6v7H2z"/></svg>',run:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="m5 3 7 5-7 5z"/></svg>',report:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M4 2h8v12H4zM6 5h4M6 8h4M6 11h3"/></svg>',lock:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>'};
const time=value=>{if(!value||!Number.isFinite(Date.parse(value)))return '未记录';return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'UTC'}).format(new Date(value))+' UTC';};
const relative=value=>{const elapsed=Math.max(0,Date.now()-Date.parse(value));if(!Number.isFinite(elapsed))return '未记录';if(elapsed<60000)return '刚刚';if(elapsed<3600000)return `${Math.floor(elapsed/60000)} 分钟前`;if(elapsed<86400000)return `${Math.floor(elapsed/3600000)} 小时前`;return `${Math.floor(elapsed/86400000)} 天前`;};
const linkToTask=(id,tab='overview')=>`#task/${encodeURIComponent(id)}/${tab}`;
const status=state=>`<span class="status ${e(STATE_LABELS[state]?state:'unknown')}">${e(STATE_LABELS[state]||'未记录')}</span>`;
const taskById=id=>data.tasks.find(x=>x.taskId===id);
const curationBadge=task=>isDismissed(task)?'<span class="curation-badge" title="已从日常列表排除；生命周期和历史保留">已排除</span>':'';
function curationControl(){const count=data.tasks.filter(isDismissed).length;return `<div class="curation-control"><label for="show-dismissed"><input id="show-dismissed" type="checkbox" ${showDismissed?'checked':''}>显示已排除任务 <span>(${count})</span></label><span class="hint">${showDismissed?'当前包含已排除任务及其历史':'日常列表不含已排除任务'}</span></div>`;}
const taskName=id=>taskById(id)?.title||id||'未关联任务';
const reportLabel=kind=>REPORT_LABELS[kind]||'报告';
const empty=(title,body,symbol='◫')=>`<div class="empty-state"><div class="empty-symbol" aria-hidden="true">${symbol}</div><h2>${e(title)}</h2><p>${e(body)}</p></div>`;
const readOnly=`<span class="view-tag">${icons.lock}${SNAPSHOT_MODE?'只读快照':'只读视图'}</span>`;
function sourceNotice(){if(SNAPSHOT_MODE)return `<div class="source-notice snapshot-notice">${icons.info}<div><strong>只读快照 · 截至 ${e(time(data.source.observedAt))}</strong><br>这是从同一 Task System 导出的记录，不会自动跟随执行端更新。页面刷新也只会读取当前发布的快照。</div></div>`;return `<div class="source-notice">${icons.info}<div><strong>${data.source.kind==='explicit-import'?'显式同步的任务记录':'来自 DSH 任务系统'}</strong> · ${e(data.source.label)}<br>页面每 ${Math.round(Math.max(5000,config.refreshIntervalMs)/1000)} 秒读取记录；读取成功不代表执行端刚刚上报。仅显示已接入的任务，较旧状态会标注“待刷新”。</div></div>`;}
function errorBanner(){return loadError?`<div class="error-banner" role="alert">${e(loadError)}${data?'，当前保留上一次成功读取的记录。':''}<button class="text-button" data-action="refresh">重试连接</button></div>`:'';}
function pageIntro(eyebrow,title,description){return `<div class="page-intro"><div><div class="eyebrow">${e(eyebrow)}</div><h1>${e(title)}</h1><p>${e(description)}</p></div>${readOnly}</div>`;}
function searchField(value,placeholder='搜索任务名称、编号或标签',id='task-search'){return `<label class="search-field">${icons.search}<input id="${id}" type="search" value="${e(value)}" placeholder="${e(placeholder)}" aria-label="${e(placeholder)}" autocomplete="off"></label>`;}
function taskCard(task){
  const records=taskRecords(data,task.taskId),latest=records.reports[0],stale=taskIsStale(task,data);
  const symbol=task.kind==='scheduled'?'◷':task.tags?.includes('media')?'◈':'◫';
  const workspace=data.workspaces?.find(x=>x.workspaceId===task.workspaceId);
  return `<article class="task-card"><a class="task-card-link" href="${linkToTask(task.taskId)}" aria-label="查看任务：${e(task.title)}"><div class="task-topline"><div class="task-title-row"><span class="task-mark" aria-hidden="true">${symbol}</span><div class="task-title-group"><h2>${e(task.title)}</h2><div class="task-id">${e(task.taskId)}</div></div></div><div class="task-state-labels">${status(task.state)}${curationBadge(task)}</div></div><p class="task-summary">${e(latest?.body||task.description||'尚无进展报告')}</p><div class="task-bottomline"><div class="task-meta"><span class="meta-icon">${icons.run}${records.runs.length?`${records.runs.length} 次执行`:'执行未记录'}</span><span class="meta-icon">${icons.report}${records.reports.length} 份报告</span><span class="meta-icon workspace-meta">${icons.folder}${e(workspace?.label||task.workspaceId||'工作区未记录')}</span></div><span class="freshness ${stale?'is-stale':''}" title="最后确认：${e(time(task.updatedAt))}">${stale?'◷ 待刷新 · ':'最后确认 · '}${relative(task.updatedAt)}<span class="chevron" aria-hidden="true">↗</span></span></div></a></article>`;
}
function taskList(){
 const items=filteredTasks(data,filter,query,{includeDismissed:showDismissed});
 return items.length?items.map(taskCard).join(''):empty(query?'没有匹配的任务':'当前筛选没有任务',query?'换一个关键词，或打开“显示已排除任务”。':'可切换状态筛选，或打开“显示已排除任务”查看保留的历史。');
}
function tasksPage(){
 const s=taskStats(data,{includeDismissed:showDismissed});
 return pageIntro('YOUR TASKS','我负责的任务','每个任务都有连续的执行与报告历史，随时回来接着看。')+`<section class="summary-grid" aria-label="任务概况">${[[showDismissed?'全部任务':'日常任务',s.total,showDismissed?`包含 ${s.dismissed} 项已排除`:`已排除 ${s.dismissed} 项`,'emphasis'],['进行与等待',s.active,`${s.attention} 项等待 / 失败`, ''],['已完成',s.completed,'保留历史以便复盘',''],['报告记录',s.reports,s.runs?`关联 ${s.runs} 次已记录执行`:'执行关联尚未接入','']].map(([label,count,note,cls])=>`<div class="summary-item ${cls}"><span class="metric-label">${label}</span><strong class="metric-value">${count}</strong><span class="metric-note">${note}</span></div>`).join('')}</section>`+sourceNotice()+`<div class="toolbar"><div class="filter-tabs" role="group" aria-label="筛选任务">${[['all','全部',s.total],['active','进行中',s.active],['attention','需关注',s.attention],['completed','已完成',s.completed]].map(([value,label,count])=>`<button class="filter-tab ${filter===value?'active':''}" data-filter="${value}" aria-pressed="${filter===value}">${label}<span>${count}</span></button>`).join('')}</div>${searchField(query)}</div>${curationControl()}<section class="task-list" id="task-list" aria-label="任务列表">${taskList()}</section>`;
}
function reportCard(report,{taskLink=false}={}){
 const run=report.runId?data.runs.find(r=>r.runId===report.runId):null;
 const prior=report.previousReportId?data.reports.find(r=>r.reportId===report.previousReportId):null;
 return `<article class="report-item" id="report-${e(report.reportId)}"><div class="report-topline"><h3>${e(report.title)}</h3><span class="report-label">${e(reportLabel(report.kind))} · v${e(report.revision)}</span></div>${taskLink?`<a class="text-button" href="${linkToTask(report.taskId,'reports')}">${e(taskName(report.taskId))} ↗</a>${curationBadge(taskById(report.taskId))}`:''}<p class="report-content">${e(report.body)}</p><div class="report-metadata"><span>报告时间 ${e(time(report.createdAt))}</span><span>执行 ${e(run?.runId||'未记录')}</span><span>Session ${e(report.sessionId||'未记录')}</span></div><details><summary>查看来源与版本</summary><dl class="key-value"><dt>报告 ID</dt><dd>${e(report.reportId)}</dd><dt>入库时间</dt><dd>${e(time(report.recordedAt))}</dd><dt>产物关联</dt><dd>${report.artifactIds?.length||0} 份</dd><dt>上一份报告</dt><dd>${e(report.previousReportId||'无修订关联')}</dd></dl>${prior?`<div class="revision"><div class="hint">前一版本 · ${e(prior.title)} · ${e(time(prior.createdAt))}</div><p>${e(prior.body)}</p></div>`:''}</details></article>`;
}
function runCard(run,{taskLink=false}={}){
 const taskReports=data.reports.filter(x=>x.runId===run.runId),route=run.route||{};
 return `<article class="run-item"><div class="run-header"><h3>${e(run.runId)}</h3>${status(run.state)}</div>${taskLink?`<a class="text-button" href="${linkToTask(run.taskId,'runs')}">${e(taskName(run.taskId))} ↗</a>${curationBadge(taskById(run.taskId))}`:''}<div class="run-grid"><div>开始记录<strong>${e(time(run.createdAt))}</strong></div><div>最后更新<strong>${e(time(run.updatedAt))}</strong></div><div>执行端<strong>${e(route.nodeId||'未记录')}</strong></div><div>模型<strong>${e(route.model&&route.model!=='unknown'?route.model:'未记录')}</strong></div><div>Session<strong>${e(run.sessionIds?.length?run.sessionIds.join(' · '):'未记录')}</strong></div><div>报告<strong>${taskReports.length} 份${run.outcome?` · ${e({success:'成功',partial:'部分完成',failure:'失败',blocked:'受阻',unknown:'结果待确认'}[run.outcome]||run.outcome)}`:''}</strong></div></div></article>`;
}
function artifactList(artifacts){return artifacts.length?artifacts.map(item=>{
 const uri=safeUri(item.uri),name=uri?`<a href="${e(uri)}" rel="noopener noreferrer" target="_blank">${e(item.name)} ↗</a>`:e(item.name);
 return `<article class="artifact-item"><span class="artifact-icon" aria-hidden="true">▤</span><div class="artifact-info"><strong>${name}</strong><p>${e(item.mediaType||'格式未记录')} · ${e(time(item.createdAt))}<br>${item.finalized?'已记录产物':'尚未定稿'}${item.bytes?` · ${(item.bytes/1024/1024).toFixed(1)} MB`:''}${!uri?'<br>本地记录；请从原交付位置打开':''}</p>${!uri&&item.uri?`<p>${e(item.uri)}</p>`:''}${item.sha256?`<details><summary class="hint">文件校验值</summary><p>${e(item.sha256)}</p></details>`:''}</div></article>`;
 }).join(''):empty('尚无产物记录','任务产生的文件会关联到对应报告；没有登记的文件不会被推断为已完成。','▤');}
function eventSummary(event){const detail=event.detail;return typeof detail==='string'?detail:detail&&typeof detail==='object'?(detail.summary||detail.message||detail.title||''):'';}
function timeline(events){return events.length?`<ol class="timeline">${events.slice(0,30).map(event=>`<li class="timeline-item"><div class="timeline-date">${e(time(event.at))}</div><h3>${e(event.type)}</h3>${eventSummary(event)?`<p>${e(eventSummary(event))}</p>`:''}</li>`).join('')}</ol>${events.length>30?`<p class="hint">当前展示最近 30 条事件；完整报告保留在“报告”页。</p>`:''}`:empty('尚无事件记录','完整报告仍可在“报告”页查看。','◷');}
function taskDetail(route){
 const task=taskById(route.taskId);
 if(!task)return `<a class="back-link" href="#tasks">← 返回任务列表</a>`+empty('未找到这个任务','任务可能尚未接入当前数据源，或链接中的任务编号不正确。');
 const rec=taskRecords(data,task.taskId),stale=taskIsStale(task,data),workspace=data.workspaces?.find(x=>x.workspaceId===task.workspaceId);
 let content='';
 if(route.tab==='overview')content=`<section class="panel"><div class="section-heading"><h2>当前进展</h2>${status(task.state)}</div><p class="overview-summary">${e(rec.reports[0]?.body||task.description||'尚无进展报告')}</p>${stale?`<div class="attention-banner">这条任务状态需要刷新。最后确认于 ${e(time(task.updatedAt))}；页面联网不代表执行端仍在运行。</div>`:''}</section><section class="panel"><h2>任务时间线</h2>${timeline(rec.events)}</section>`;
 if(route.tab==='runs')content=`<section class="panel"><div class="section-heading"><h2>执行历史</h2><span>${rec.runs.length} 次 Run</span></div><p class="hint" style="margin-bottom:20px">同一任务可有多次执行。未记录的执行端、模型和 Session 保持未知。</p>${rec.runs.length?rec.runs.map(x=>runCard(x)).join(''):empty('没有已登记的执行','报告可以独立附在任务上；不会为了显示历史而虚构一次执行。','▷')}</section>`;
 if(route.tab==='reports')content=`<div class="section-heading"><h2>报告历史</h2><span>${rec.reports.length} 份 · 按报告时间排序</span></div>${rec.reports.length?rec.reports.map(x=>reportCard(x)).join(''):empty('尚无报告','新的进展、结果和修订将保留在同一个任务下。','▤')}`;
 if(route.tab==='artifacts')content=`<section class="panel"><div class="section-heading"><h2>产物记录</h2><span>${rec.artifacts.length} 份</span></div>${artifactList(rec.artifacts)}</section>`;
 return `<a class="back-link" href="#tasks">← 返回任务列表</a><div class="page-intro detail-intro"><div><div class="eyebrow">TASK · ${e(task.taskId)}</div><h1>${e(task.title)}</h1><p>${e(task.description)}</p></div>${readOnly}</div>${isDismissed(task)?`<div class="curation-notice">${curationBadge(task)}<span>此任务已从日常列表排除，执行状态与全部历史仍保留。查看此页面不会恢复任务。</span></div>`:''}<nav class="detail-tabs" aria-label="任务详情">${[['overview','概况',null],['runs','执行',rec.runs.length],['reports','报告',rec.reports.length],['artifacts','产物',rec.artifacts.length]].map(([tab,label,count])=>`<a href="${linkToTask(task.taskId,tab)}" class="${route.tab===tab?'active':''}" ${route.tab===tab?'aria-current="page"':''}>${label}${count!==null?`<small>${count}</small>`:''}</a>`).join('')}</nav><div class="detail-layout"><div class="detail-primary">${content}</div><aside class="detail-aside" aria-label="任务信息"><section class="panel"><h2>记录信息</h2><dl class="key-value"><dt>状态</dt><dd>${status(task.state)}</dd><dt>收录</dt><dd>${isDismissed(task)?curationBadge(task):e(task.admissionState==='admitted'?'已纳入':'默认纳入')}${task.admissionRevision!==undefined?` · 第 ${e(task.admissionRevision)} 版`:''}</dd><dt>任务类型</dt><dd>${e({ad_hoc:'临时任务',scheduled:'定时任务',observed:'显式接入'}[task.kind]||'未记录')}</dd><dt>最后确认</dt><dd>${e(time(task.updatedAt))}${stale?'<br><span class="status stale">待刷新</span>':''}</dd><dt>创建记录</dt><dd>${e(time(task.createdAt))}${task.kind==='observed'?'<br><span class="hint">导入记录时间；原始创建时间未记录</span>':''}</dd><dt>数据来源</dt><dd>${e(data.source.label)}</dd>${task.parentTaskId?`<dt>上级任务</dt><dd><a class="text-button" href="${linkToTask(task.parentTaskId)}">${e(taskName(task.parentTaskId))}</a></dd>`:''}</dl></section><section class="panel"><h2>实际工作区</h2><p class="hint">${e(workspace?.label||task.workspaceId||'尚未登记工作区')}</p>${workspace?`<p class="aside-note">${e(workspace.nodeId)}<br>${e(workspace.path)}</p>`:''}<p class="aside-note">工作区是执行项目的实际目录，任务是持续跟踪的工作目标。</p></section><section class="panel"><h2>连续的任务历史</h2><p class="hint">${rec.runs.length} 次执行<br>${rec.reports.length} 份报告<br>${rec.artifacts.length} 份产物</p><p class="aside-note">切换 Session、重试或新增报告，都不会自动创建另一个任务。</p></section></aside></div>`;
}
function allRuns(){
 const scoped=visibleRecords(data,'runs',{includeDismissed:showDismissed});
 const items=newestFirst(scoped).filter(x=>`${x.runId} ${taskName(x.taskId)} ${(x.sessionIds||[]).join(' ')}`.toLocaleLowerCase().includes(listQuery.toLocaleLowerCase()));
 return pageIntro('RUN HISTORY','每一次执行','按任务关联保留执行记录，明确区分任务状态与执行结果。')+`<div class="toolbar"><span class="hint">${scoped.length} 次已登记执行（当前范围）</span>${searchField(listQuery,'搜索任务、执行或 Session','list-search')}</div>${curationControl()}<section class="panel">${items.length?items.map(x=>runCard(x,{taskLink:true})).join(''):empty('没有匹配的执行记录','切换关键词，或等待数据来源登记执行记录。','▷')}</section>`;
}
function allReports(){
 const scoped=visibleRecords(data,'reports',{includeDismissed:showDismissed});
 const items=newestFirst(scoped).filter(x=>`${x.title} ${x.body} ${taskName(x.taskId)} ${x.sessionId||''}`.toLocaleLowerCase().includes(listQuery.toLocaleLowerCase()));
 return pageIntro('REPORT HISTORY','报告与复盘','进展、结果和修订各自保留，可回到所属任务查看完整上下文。')+`<div class="toolbar"><span class="hint">${scoped.length} 份报告 · 当前范围全部版本</span>${searchField(listQuery,'搜索报告内容或任务','list-search')}</div>${curationControl()}${items.length?items.map(x=>reportCard(x,{taskLink:true})).join(''):empty('没有匹配的报告','切换关键词，或等待任务产生新的报告。','▤')}`;
}
function configurationPage(){
 const schedules=visibleRecords(data,'schedules',{includeDismissed:showDismissed});
 return pageIntro('CONFIGURATION','配置与模板','任务类型由配置定义；日报、游戏日报和自定义任务共用同一框架。')+`<div class="source-notice">${icons.info}<div><strong>当前是只读查看</strong><br>此处展示核心已注册的模板与调度记录。新增、编辑与执行由 DSH 宿主的管理入口负责。</div></div><section class="section-heading"><h2>任务模板</h2><span>${data.templates.length} 个已注册</span></section>${data.templates.length?`<div class="template-grid">${data.templates.map(template=>`<section class="panel"><div class="section-heading"><h2>${e(template.name)}</h2><span class="report-label">v${e(template.version)}</span></div><p class="hint">${e(template.description)}</p><p class="aside-note">${e(template.templateId)}</p><details><summary class="text-button">参数结构</summary><pre class="config-json">${e(JSON.stringify(template.inputSchema,null,2))}</pre></details></section>`).join('')}</div>`:empty('尚未注册任务模板','这里会直接读取 Task System 的模板清单，不预置虚构的日报配置。','☷')}<section class="panel" style="margin-top:22px"><h2>调度记录</h2>${curationControl()}${Array.isArray(data.schedules)&&schedules.length?schedules.map(schedule=>`<div class="config-row"><h3><a href="${linkToTask(schedule.taskId)}">${e(taskName(schedule.taskId))} ↗</a> ${curationBadge(taskById(schedule.taskId))}</h3><p class="hint">${schedule.enabled?'已启用':'已暂停'} · 下次时间 ${e(time(schedule.nextDueAt))}<br>模板 ${e(schedule.templateId)} · v${e(schedule.templateVersion)} · 每 ${e(schedule.intervalMs/60000)} 分钟</p></div>`).join(''):`<p class="hint">${Array.isArray(data.schedules)?'当前筛选没有调度记录。':'当前查询来源尚未提供调度记录；没有数据不等于没有定时任务。'}</p>`}</section>`;
}
function render({preserveFocus=true}={}){
 const route=parseRoute(location.hash),active=document.activeElement,focus=preserveFocus&&active?.id?{id:active.id,start:active.selectionStart,end:active.selectionEnd}:null;
 document.querySelectorAll('[data-nav]').forEach(a=>{const match=a.dataset.nav===(route.view==='task'?'tasks':route.view);a.classList.toggle('active',match);match?a.setAttribute('aria-current','page'):a.removeAttribute('aria-current');});
 const labels={tasks:'任务看板',runs:'执行历史',reports:'报告历史',configuration:'配置与模板',task:'任务详情'};
 document.querySelector('#breadcrumb').innerHTML=route.view==='task'?`<a href="#tasks">任务看板</a><span>/</span><span>任务详情</span>`:e(labels[route.view]||'任务看板');
 if(!data){if(loadError)main.innerHTML=errorBanner()+empty('暂时无法读取任务','确认云电脑上的任务服务仍在运行，然后重试。你的任务记录没有被修改。');return;}
 document.querySelector('#task-count').textContent=taskStats(data,{includeDismissed:showDismissed}).total;
 const footer=document.querySelector('#footer-source');footer.textContent=SNAPSHOT_MODE?`只读快照 · 截至 ${time(data.source.observedAt)} · 来源：${data.source.label}`:`来源：${data.source.label} · 最近读取 ${time(lastFetchedAt)}`;
 const page=route.view==='tasks'?tasksPage():route.view==='task'?taskDetail(route):route.view==='runs'?allRuns():route.view==='reports'?allReports():route.view==='configuration'?configurationPage():empty('未找到页面','请返回任务列表。');
 main.innerHTML=errorBanner()+(SNAPSHOT_MODE&&route.view!=='tasks'?sourceNotice():'')+page;
 if(focus){const input=document.getElementById(focus.id);if(input){input.focus({preventScroll:true});if(typeof input.setSelectionRange==='function'&&focus.start!==null)input.setSelectionRange(focus.start,focus.end);}}
}
function setConnection(online){document.querySelector('#connection-dot').className=`dot ${online?'online':'offline'}`;document.querySelector('#connection-status').textContent=online?(SNAPSHOT_MODE?'只读快照':'数据源已连接'):'连接待恢复';document.querySelector('#refresh-button').disabled=isLoading;}
async function refresh({manual=false}={}){
 if(isLoading)return;
 isLoading=true;setConnection(!loadError&&Boolean(data));const serial=++requestNumber;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{
  const response=await fetch((SNAPSHOT_MODE?new URL(config.snapshotUrl||'./snapshot.json',location.href.split('#')[0]):new URL('snapshot',API)),{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',signal:controller.signal});
  if(!response.ok)throw new Error(response.status===401||response.status===403?'需要通过宿主身份验证':`读取失败（HTTP ${response.status}）`);
  const next=validateSnapshot(await response.json());if(serial!==requestNumber)return;
  data=next;lastFetchedAt=new Date().toISOString();loadError=null;
  if(manual){const toast=document.querySelector('#toast');toast.textContent=SNAPSHOT_MODE?'已重新读取当前发布的快照':'已重新读取任务记录';toast.hidden=false;setTimeout(()=>{toast.hidden=true;},2200);}
 }catch(error){if(serial!==requestNumber)return;loadError=error.name==='AbortError'?'任务数据源连接超时':error.message==='Failed to fetch'?'暂时无法连接任务数据源':`任务数据暂不可用：${error.message}`;}
 finally{clearTimeout(timer);isLoading=false;setConnection(!loadError);render();}
}
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-filter]');if(button){filter=button.dataset.filter;render({preserveFocus:false});return;}
 if(event.target.closest('[data-action="refresh"],#refresh-button'))refresh({manual:true});
});
document.addEventListener('change',event=>{
 if(event.target.id==='show-dismissed'){showDismissed=event.target.checked;render();}
});
document.addEventListener('input',event=>{
 if(event.target.id==='task-search'){query=event.target.value;document.querySelector('#task-list').innerHTML=taskList();}
 if(event.target.id==='list-search'){listQuery=event.target.value;render();}
});
window.addEventListener('hashchange',()=>{listQuery='';render({preserveFocus:false});window.scrollTo({top:0,behavior:'instant'});});
document.title=config.title||'DSH · 任务看板';
const access=document.querySelector('.sidebar-footer>div');access.innerHTML=`${e(config.accessLabel||'宿主任务视图')}<small>${e(config.accessDescription||'只读视图')}</small>`;
refresh();if(!SNAPSHOT_MODE)setInterval(()=>{if(!document.hidden)refresh();},Math.max(5000,Number(config.refreshIntervalMs)||15000));
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!SNAPSHOT_MODE)refresh();});
