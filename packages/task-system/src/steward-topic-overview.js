function createTopicOverview(React) {
  const h = React.createElement;
  const scopeKey = scope => scope?.kind === "project" ? `project:${scope.projectId}` : scope?.kind === "workbench" && scope.topicId ? `workbench:${scope.topicId}` : scope?.kind ?? "";
  const topicKey = topic => JSON.stringify([topic.conversationId, scopeKey(topic.scope)]);
  const sourceKey = ref => JSON.stringify(ref, function(_key,value){return value && !Array.isArray(value) && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])) : value;});
  const freshness = { current: "已覆盖最新消息", stale: "有待更新", insufficient: "信息不足" };
  const origins = { authoritative: "明确记录", extractive: "原文摘录", generated: "模型整理" };
  const sections = { goal: "目标", decision: "决定", constraint: "约束", question: "待解问题" };
  const failureText = failure => String(failure?.details?.detail ?? failure?.message ?? "读取失败，请稍后重试。").slice(0, 500);
  const sourceLabel = ref => ref.kind === "message" ? `对话记录 ${ref.seq}` : "项目目标";
  const characters = text => typeof Intl.Segmenter === "function" ? Array.from(new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(text),part=>part.segment) : Array.from(text);
  const clip = (text,limit,more=false) => {const parts=characters(text);return parts.length>limit||more ? parts.slice(0,limit-1).join("")+"…" : text;};
  const plainPreview = text => text.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g,"$1").replace(/(^|\n)\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/g,"$1").replace(/\*\*([^*]+)\*\*/g,"$1").replace(/__([^_]+)__/g,"$1").replace(/`([^`]+)`/g,"$1").replace(/\s+/g," ").trim();
  const discussionLabel = value => value ? `上次聊到：${value.role === "user" ? "你" : "助手"}：${clip(plainPreview(value.excerpt)||(value.hasAttachments?"发送了附件":"无文字内容"),64,value.truncated)}` : "上次聊到：尚未开始讨论";
  const timeLabel = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(value)) : "";
  const styles = `
    .steward-topic-overview{box-sizing:border-box;container-type:inline-size;container-name:topics;display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto;padding:24px;color:var(--dsw-alias-label-primary,#ddd);background:var(--dsw-alias-bg-base,#171719);font:14px/1.6 system-ui}
    .steward-topic-overview *{box-sizing:border-box}.steward-topic-overview .sto-toolbar,.sto-dialog .sto-actions,.sto-dialog .sto-dialog-heading,.steward-topic-overview .sto-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.steward-topic-overview .sto-toolbar,.sto-dialog .sto-dialog-heading{justify-content:space-between}.steward-topic-overview h2{font-size:20px;margin:0}.steward-topic-overview h3{font-size:14px;margin:20px 0 8px}.steward-topic-overview p{margin:8px 0}.steward-topic-overview .sto-muted{color:var(--dsw-alias-label-secondary,#aaa)}
    .steward-topic-overview button,.steward-topic-overview input,.steward-topic-overview select,.steward-topic-overview textarea{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#25272b);border:1px solid var(--dsw-alias-border-l2,#555);border-radius:8px;padding:7px 12px}.steward-topic-overview button{cursor:pointer}.steward-topic-overview button:disabled{cursor:default;opacity:.5}.steward-topic-overview button:focus-visible,.steward-topic-overview input:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#75b9d3);outline-offset:2px}.steward-topic-overview .sto-search{display:block;max-width:560px;width:100%;margin:18px 0 24px}.steward-topic-overview .sto-search input{display:block;width:100%;margin-top:4px}
    .steward-topic-overview .sto-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-content:start}.steward-topic-overview .sto-card{min-width:0;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:14px;overflow:hidden}.steward-topic-overview .sto-card[aria-current=true]{border-color:var(--dsw-alias-accent-primary,#75b9d3)}.steward-topic-overview button.sto-card-toggle{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:12px;text-align:left;width:100%;min-height:300px;height:100%;border:0;padding:20px;background:color-mix(in srgb,var(--dsw-alias-bg-base,#171719) 96%,var(--dsw-alias-label-primary,#ddd) 4%)}.steward-topic-overview .sto-title{font-size:17px;font-weight:600;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.steward-topic-overview .sto-summary{color:var(--dsw-alias-label-secondary,#aaa);display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.steward-topic-overview .sto-card-context{margin-top:auto;display:flex;flex-direction:column;gap:6px;align-self:stretch;text-align:left;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#aaa)}.steward-topic-overview .sto-last-discussion{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.steward-topic-overview .sto-discussion-time{font-size:11px;color:var(--dsw-alias-label-caption,#888)}.steward-topic-overview .sto-footer{justify-content:space-between;margin-top:24px}
    .steward-topic-overview .sto-dialog{width:min(820px,calc(100vw - 40px));max-height:86dvh;overflow:auto;padding:24px;border:1px solid var(--dsw-alias-border-l2,#555);border-radius:16px;color:inherit;background:var(--dsw-alias-bg-base,#1b1b1e);box-shadow:0 24px 100px #0008}.sto-dialog::backdrop{background:#0008;backdrop-filter:blur(3px)}.sto-dialog .sto-dialog-heading h2{overflow-wrap:anywhere}.sto-dialog .sto-detail{padding-top:12px;overflow-wrap:anywhere}.sto-dialog .sto-detail-actions{position:sticky;top:-24px;z-index:1;padding:12px 0;background:var(--dsw-alias-bg-base,#1b1b1e)}.sto-dialog .sto-fact{padding:12px 0}.sto-dialog .sto-fact-text,.sto-dialog .sto-quoted-original{white-space:pre-wrap;overflow-wrap:anywhere}.sto-dialog .sto-provenance{font-size:11px;color:var(--dsw-alias-label-caption,#888)}.sto-dialog .sto-cites{display:inline-flex;gap:2px;flex-wrap:wrap;vertical-align:baseline}.sto-dialog .sto-cites button{font-size:12px;border:0;background:transparent;color:var(--dsw-alias-text-brand,#75a8ed);padding:0 3px}.sto-dialog .sto-directory{margin:20px 0}.sto-dialog .sto-directory summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#aaa)}.sto-dialog .sto-directory-item{display:flex;align-items:center;gap:8px;padding:6px 0}.sto-dialog .sto-source{padding:16px 0;margin:14px 0;border-top:1px solid var(--dsw-alias-border-l2,#444)}.sto-dialog blockquote{border-left:2px solid var(--dsw-alias-text-brand,#75a8ed);margin:12px 0;padding:2px 16px}.sto-dialog .sto-tech{font-size:11px;color:var(--dsw-alias-label-caption,#888);margin-top:16px}.sto-dialog .sto-tech pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}.steward-topic-overview .sto-error{border-left:3px solid #bd8e57;padding:5px 12px;margin:10px 0}
    .sto-work-controls{border-top:1px solid var(--dsw-alias-border-l2,#555);margin-top:24px;padding-top:8px}.sto-work-form{margin-top:16px;padding:16px 0}.sto-work-form h4{margin:0 0 12px}.sto-work-field{display:flex;flex-direction:column;gap:6px;margin:12px 0;max-width:580px}.sto-work-field textarea{min-height:100px;resize:vertical}.sto-work-form fieldset{border:0;padding:12px 0;margin:12px 0}.sto-task-choice{display:flex;align-items:center;gap:8px;margin:8px 0}.sto-task-choice input{width:auto}.sto-work-field input,.sto-work-field select,.sto-work-field textarea{width:100%;min-width:0}.sto-linked-tasks{padding-left:20px}.sto-work-controls .sto-actions{margin:10px 0}
    .sto-conversation-controls button{min-height:44px}.sto-seat-list{list-style:none;padding:0;margin:16px 0}.sto-seat-list>li{padding:16px 0;border-top:1px solid var(--dsw-alias-border-l2,#555);overflow-wrap:anywhere}.sto-conversation-controls button:hover:not(:disabled){background:var(--dsw-alias-bg-l2,#303237)}.sto-conversation-controls select:focus-visible,.sto-conversation-controls textarea:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#75b9d3);outline-offset:2px}
    @container topics (min-width:850px){.steward-topic-overview .sto-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@container topics (min-width:1180px){.steward-topic-overview .sto-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media(max-width:560px){.steward-topic-overview{padding:14px}.steward-topic-overview .sto-grid{gap:10px}.steward-topic-overview button.sto-card-toggle{padding:14px;min-height:280px}.steward-topic-overview .sto-title{font-size:15px;padding-right:0;margin-top:0}.steward-topic-overview .sto-summary{font-size:12px}.steward-topic-overview .sto-dialog{width:calc(100vw - 20px);max-height:92dvh;padding:18px}.sto-dialog .sto-detail-actions{top:-18px}}
  `;

  function TopicWorkControls({invoke,topic,onChanged,openSession,openTask}) {
    const [options,setOptions]=React.useState(null),[loading,setLoading]=React.useState(true),[mode,setMode]=React.useState(null),[working,setWorking]=React.useState(false),[message,setMessage]=React.useState("");
    const [form,setForm]=React.useState({title:"",goal:"",projectId:"",taskId:""}),[taskIds,setTaskIds]=React.useState([]),[uncertain,setUncertain]=React.useState(false);
    const [taskQuery,setTaskQuery]=React.useState(""),[taskPage,setTaskPage]=React.useState(0),[taskChoices,setTaskChoices]=React.useState({items:[],pages:0,loading:false});
    const operation=React.useRef(null),alive=React.useRef(true),identity=topicKey(topic);
    const read=async()=>{setLoading(true);try{const value=await invoke("topicProjectOptions",{topic});if(alive.current){setOptions(value);setTaskIds(value.topic.taskIds);setForm(previous=>({...previous,title:previous.title||value.topic.title}));if(value.pendingOperation&&!operation.current){operation.current=value.pendingOperation;setUncertain(true);setMessage("有一项已提交的操作尚未确认。请继续上次操作，避免重复创建。");}}return value;}catch(error){if(alive.current)setMessage(failureText(error));}finally{if(alive.current)setLoading(false);}};
    React.useEffect(()=>{alive.current=true;void read();return()=>{alive.current=false;};},[identity]);
    React.useEffect(()=>{if(mode!=="bind-task")return;let current=true;setTaskChoices(previous=>({...previous,loading:true,error:""}));void invoke("taskPage",{view:"planner",project:{kind:"unassigned"},status:"all",...(taskQuery.trim()?{search:taskQuery.trim()}:{}),order:"updated-desc",page:taskPage,pageSize:10}).then(value=>{if(current){setTaskChoices({...value,loading:false});setForm(previous=>value.items.some(task=>task.id===previous.taskId)?previous:{...previous,taskId:""});}}).catch(error=>{if(current)setTaskChoices({items:[],pages:0,loading:false,error:failureText(error)});});return()=>{current=false;};},[mode,taskQuery,taskPage,identity]);
    const disabled=working||uncertain,field=(key,label,multiline=false)=>h("label",{className:"sto-work-field"},h("span",null,label),h(multiline?"textarea":"input",{value:form[key],disabled,maxLength:multiline?20000:100,onChange:event=>setForm(previous=>({...previous,[key]:event.target.value}))}));
    const begin=next=>{setMode(next);setMessage("");};
    const perform=async(method,input)=>{
      if(working)return;const request=operation.current??{method,input};operation.current=request;setWorking(true);setUncertain(false);setMessage("");
      try{const result=await invoke(request.method,request.input);if(!alive.current)return;operation.current=null;setMode(null);setForm(previous=>({...previous,goal:"",taskId:""}));await read();onChanged?.();
        setMessage(request.method==="topicProjectConfigure"?request.input.mode==="create"?"已升级为项目；原话题会话、文件与已有执行记录保持不变。":result.sameWorkspace?"已关联项目，共用原工作区。":"已关联项目；话题文件仍在原工作区，可继续打开原话题会话。":request.method==="topicTaskCreate"?"任务已创建并提交规划，可在任务页查看进展。":"已关联原任务，已有执行与报告保留。");
      }catch(error){if(alive.current){const rejected=["CONFLICT","FORBIDDEN","INVALID","CONFIGURATION","BUSY"].includes(error?.details?.reason??error?.code);if(rejected)operation.current=null;setUncertain(!rejected);if((error?.details?.reason??error?.code)==="BUSY")void read();setMessage(rejected?`操作未完成：${failureText(error)}。刷新后核对。`:`操作结果尚未确认：${failureText(error)}。请重试原操作，表单已保留。`);}}finally{if(alive.current)setWorking(false);}
    };
    const submit=()=>{
      const base={commandId:crypto.randomUUID(),topic,expectedRevision:options.topic.revision};
      if(mode==="create-project"||mode==="link-project")void perform("topicProjectConfigure",{...base,taskIds,mode:mode==="create-project"?"create":"link",...(mode==="create-project"?{title:form.title.trim(),goal:form.goal.trim()}:{projectId:form.projectId})});
      else if(mode==="create-task")void perform("topicTaskCreate",{...base,title:form.title.trim(),description:form.goal.trim()});
      else if(mode==="bind-task")void perform("topicTaskBind",{...base,taskId:form.taskId});
    };
    const complete=mode==="link-project"?!!form.projectId:mode==="bind-task"?!!form.taskId:!!form.title.trim()&&!!form.goal.trim();
    return h("section",{className:"sto-work-controls","aria-label":"话题任务与项目"},h("h3",null,"任务与项目"),
      h("p",{className:"sto-muted"},"这个话题有自己的会话和文件工作区。讨论本身不会创建项目或启动任务。"),
      loading&&h("p",{role:"status"},"正在读取话题关联…"),
      options&&h(React.Fragment,null,
        h("div",{className:"sto-actions"},h("button",{type:"button",onClick:()=>openSession(options.source.binding.sessionId)},"打开原话题会话"),
          options.topic.projectId?h("span",null,`已关联项目：${options.projects.find(project=>project.projectId===options.topic.projectId)?.title??"项目"}`):h("button",{type:"button",disabled,onClick:()=>begin("create-project")},"升级为项目"),
          !options.topic.projectId&&h("button",{type:"button",disabled,onClick:()=>begin("link-project")},"关联已有项目"),
          h("button",{type:"button",disabled,onClick:()=>begin("create-task")},"创建并交给调度"),h("button",{type:"button",disabled,onClick:()=>begin("bind-task")},"关联已有任务")),
        options.tasks.length>0&&h("ul",{className:"sto-linked-tasks"},...options.tasks.map(task=>h("li",{key:task.taskId},h("span",null,task.title)," ",h("button",{type:"button",onClick:()=>openTask(task.taskId)},"查看任务与结果")))),
        mode&&h("form",{className:"sto-work-form",onSubmit:event=>{event.preventDefault();if(complete&&!disabled)submit();}},
          h("h4",null,{"create-project":"升级为新项目","link-project":"关联已有项目","create-task":"创建并交给调度","bind-task":"关联已有任务"}[mode]),
          mode==="create-project"&&h("p",{className:"sto-muted"},"沿用此话题已有的文件工作区。确认后建立项目统筹会话，原话题会话继续保留。"),
          mode==="link-project"&&h(React.Fragment,null,h("p",{className:"sto-muted"},"只建立关联，不移动话题文件。你仍可打开原话题会话。"),h("label",{className:"sto-work-field"},h("span",null,"选择项目"),h("select",{value:form.projectId,disabled,onChange:event=>setForm(previous=>({...previous,projectId:event.target.value}))},h("option",{value:""},"请选择项目"),...options.projects.map(project=>h("option",{key:project.projectId,value:project.projectId},project.title))))),
          (mode==="create-project"||mode==="create-task")&&h(React.Fragment,null,field("title",mode==="create-project"?"项目名称":"任务名称"),field("goal",mode==="create-project"?"项目目标":"任务指令与完成标准",true)),
          mode==="create-task"&&h("p",{className:"sto-muted"},"确认后会提交规划并按授权安排执行，执行端不可用时等待；不会重发话题中的旧消息。"),
          (mode==="create-project"||mode==="link-project")&&h("fieldset",{disabled},h("legend",null,"同时绑定这些已有任务"),options.tasks.length?options.tasks.map(task=>h("label",{key:task.taskId,className:"sto-task-choice"},h("input",{type:"checkbox",checked:taskIds.includes(task.taskId),onChange:event=>setTaskIds(previous=>event.target.checked?[...previous,task.taskId]:previous.filter(id=>id!==task.taskId))}),task.title)):h("p",{className:"sto-muted"},"此话题还没有关联任务。可以稍后添加。")),
          mode==="bind-task"&&h(React.Fragment,null,h("label",{className:"sto-work-field"},h("span",null,"搜索未归属项目的任务"),h("input",{type:"search",value:taskQuery,disabled,onChange:event=>{setTaskQuery(event.target.value);setTaskPage(0);}})),h("label",{className:"sto-work-field"},h("span",null,"选择已有任务"),h("select",{value:form.taskId,disabled:disabled||taskChoices.loading,onChange:event=>setForm(previous=>({...previous,taskId:event.target.value}))},h("option",{value:""},taskChoices.loading?"正在读取任务…":"请选择任务"),...taskChoices.items.map(task=>h("option",{key:task.id,value:task.id},`${task.title}${task.stateLabel?` · ${task.stateLabel}`:""}`)))),taskChoices.error&&h("p",{role:"alert"},taskChoices.error),!taskChoices.loading&&!taskChoices.items.length&&h("p",{className:"sto-muted"},"当前没有符合条件的临时任务。"),taskChoices.pages>1&&h("div",{className:"sto-actions"},h("button",{type:"button",disabled:disabled||taskPage===0,onClick:()=>setTaskPage(value=>value-1)},"上一页任务"),h("button",{type:"button",disabled:disabled||taskPage+1>=taskChoices.pages,onClick:()=>setTaskPage(value=>value+1)},"下一页任务"))),
          h("div",{className:"sto-actions"},h("button",{type:"submit",disabled:disabled||!complete},working?"正在提交…":{"create-project":"确认升级为项目","link-project":"确认关联项目","create-task":"确认创建并交给调度","bind-task":"确认关联任务"}[mode]),h("button",{type:"button",disabled,onClick:()=>setMode(null)},"取消")))),
      message&&h("p",{role:uncertain?"alert":"status"},message),uncertain&&h("button",{type:"button",disabled:working,onClick:()=>perform()},"继续上次操作"),h("button",{type:"button",disabled:working||loading,onClick:read},"刷新话题关联"));
  }
  function TopicSessionControls({invoke,topic,onApply,onChanged,openSession}) {
    const [state,setState]=React.useState({loading:true}),[editing,setEditing]=React.useState(false),[form,setForm]=React.useState({parent:"",role:"",responsibility:""});
    const [query,setQuery]=React.useState(""),[page,setPage]=React.useState({cursor:undefined,previous:[]}),[targets,setTargets]=React.useState({items:[],loading:false,hasMore:false});
    const [saving,setSaving]=React.useState(false),[uncertain,setUncertain]=React.useState(false),[notice,setNotice]=React.useState("");
    const generation=React.useRef(0),operation=React.useRef(null),identity=topicKey(topic);
    const load=async()=>{const request=++generation.current;setState(old=>({...old,loading:true,error:""}));try{const value=await invoke("stewardTopicSessions",{topic});if(request===generation.current){setState({value,loading:false});if(!operation.current)setForm({parent:value.relation.parent?JSON.stringify(value.relation.parent):"",role:value.relation.role,responsibility:value.relation.responsibility});}}catch(error){if(request===generation.current)setState(old=>({...old,loading:false,error:failureText(error)}));}};
    React.useEffect(()=>{void load();return()=>{generation.current++;};},[identity]);
    React.useEffect(()=>{if(!editing)return;let active=true;setTargets(old=>({...old,loading:true,error:""}));const timer=setTimeout(()=>{void invoke("stewardTopics",{conversationId:topic.conversationId,...(query.trim()?{query:query.trim()}:{}),...(page.cursor?{cursor:page.cursor}:{}),limit:8}).then(value=>{if(active)setTargets({...value,loading:false});}).catch(error=>{if(active)setTargets({items:[],hasMore:false,loading:false,error:failureText(error)});});},180);return()=>{active=false;clearTimeout(timer);};},[editing,query,page.cursor,identity]);
    const relation=state.value?.relation,disabled=saving||uncertain||state.loading||!!state.error;
    const options=new Map(targets.items.filter(item=>scopeKey(item.topic.scope)!==scopeKey(topic.scope)).map(item=>[JSON.stringify(item.topic.scope),item.title]));
    if(relation?.parent&&!options.has(JSON.stringify(relation.parent)))options.set(JSON.stringify(relation.parent),"当前归属话题");
    if(form.parent&&!options.has(form.parent))options.set(form.parent,"已选择的归属话题");
    const dirty=!!relation&&(form.parent!==(relation.parent?JSON.stringify(relation.parent):"")||form.role!==relation.role||form.responsibility!==relation.responsibility);
    const save=async()=>{if(saving||!relation)return;const request=operation.current??{commandId:crypto.randomUUID(),topic,expectedRevision:relation.revision,parent:form.parent?JSON.parse(form.parent):null,role:form.role.trim(),responsibility:form.responsibility.trim()};operation.current=request;setSaving(true);setNotice("");try{await invoke("stewardTopicRelationConfigure",request);operation.current=null;setUncertain(false);setEditing(false);await load();onChanged?.();setNotice("逻辑归属与职责已保存；原会话、工作区和执行记录保持不变。");}catch(error){const rejected=["CONFLICT","FORBIDDEN","INVALID","LIMIT"].includes(error?.details?.reason??error?.code);if(rejected)operation.current=null;setUncertain(!rejected);setNotice(rejected?`未保存：${failureText(error)}。请刷新后核对。`:`保存结果尚未确认：${failureText(error)}。可继续核实同一操作。`);}finally{setSaving(false);}};
    const roles={discussion:"讨论会话","task-coordinator":"任务负责会话","project-coordinator":"项目统筹会话"};
    return h("section",{className:"sto-work-controls sto-conversation-controls","aria-label":"话题归属与承接会话"},
      h("h3",null,"话题归属与承接会话"),h("p",{className:"sto-muted"},"改归属只改变讨论的逻辑关联；不会移动文件、更改工具权限或重放旧消息。"),
      state.loading&&h("p",{role:"status"},"正在读取原会话与职责…"),state.error&&h("p",{role:"alert"},state.error),
      relation&&h("p",null,relation.parent?"此讨论已关联上级话题。":"此讨论保持独立。",relation.role?` 角色说明：${relation.role}`:"",relation.responsibility?` · ${relation.responsibility}`:""),
      h("div",{className:"sto-actions"},h("button",{type:"button",disabled:disabled||!relation,onClick:()=>{setEditing(value=>!value);setNotice("");}},editing?"收起归属设置":"修改逻辑归属与职责"),h("button",{type:"button",disabled:saving,onClick:()=>void load()},"刷新承接会话")),
      editing&&h("form",{className:"sto-work-form",onSubmit:event=>{event.preventDefault();void save();}},
        h("label",{className:"sto-work-field"},h("span",null,"搜索已有归属话题"),h("input",{type:"search",value:query,disabled,onChange:event=>{setQuery(event.target.value);setPage({cursor:undefined,previous:[]});}})),
        h("label",{className:"sto-work-field"},h("span",null,"逻辑归属"),h("select",{value:form.parent,disabled,onChange:event=>setForm(old=>({...old,parent:event.target.value}))},h("option",{value:""},"保持独立话题"),...[...options].map(([value,label])=>h("option",{key:value,value},label)))),
        targets.loading&&h("p",{role:"status"},"正在读取这一页话题…"),targets.error&&h("p",{role:"alert"},targets.error),
        !targets.loading&&!targets.items.length&&h("p",{className:"sto-muted"},"本页没有匹配话题，可以修改搜索词。"),
        h("div",{className:"sto-actions"},h("button",{type:"button",disabled:disabled||!page.previous.length,onClick:()=>setPage(old=>({cursor:old.previous.at(-1),previous:old.previous.slice(0,-1)}))},"上一页归属话题"),h("button",{type:"button",disabled:disabled||!targets.hasMore||!targets.nextCursor,onClick:()=>setPage(old=>({cursor:targets.nextCursor,previous:[...old.previous,old.cursor]}))},"下一页归属话题")),
        h("label",{className:"sto-work-field"},h("span",null,"角色说明"),h("input",{value:form.role,maxLength:100,disabled,onChange:event=>setForm(old=>({...old,role:event.target.value}))})),
        h("label",{className:"sto-work-field"},h("span",null,"职责与已有产物"),h("textarea",{value:form.responsibility,maxLength:500,disabled,onChange:event=>setForm(old=>({...old,responsibility:event.target.value}))})),
        h("button",{type:"submit",disabled:disabled||!dirty},saving?"正在保存…":"保存逻辑归属与职责")),
      state.value?.seats?.length?h("ul",{className:"sto-seat-list"},...state.value.seats.map(seat=>h("li",{key:seat.id},h("strong",null,seat.title," · ",roles[seat.role]??seat.role),h("p",null,seat.responsibility||"尚未记录职责说明。"),seat.artifacts.length>0&&h("p",{className:"sto-muted"},`已有产物：${seat.artifacts.join("、")}`),
        h("div",{className:"sto-actions"},h("button",{type:"button",disabled,onClick:()=>onApply(topic.scope,{id:seat.id,token:seat.token},`${seat.title} · ${roles[seat.role]??seat.role}`)},`用于下一条消息：${roles[seat.role]??seat.role}`),h("button",{type:"button",disabled:!!state.error||state.loading,onClick:()=>openSession(seat.source.sessionId)},"打开这个原会话")),
        h("details",{className:"sto-tech"},h("summary",null,"原会话与工作区"),h("p",null,`${seat.source.nodeId} / ${seat.source.sessionId}`),h("p",null,seat.source.cwd))))):!state.loading&&h("p",{className:"sto-muted"},"当前没有可用承接会话，请刷新或打开已知原会话核对。"),
      state.value&&!state.value.complete&&h("p",{className:"sto-muted"},"关联会话较多，仅展示当前有界范围；请明确选择原会话。"),
      notice&&h("p",{role:uncertain?"alert":"status"},notice),uncertain&&h("button",{type:"button",disabled:saving,onClick:()=>void save()},"继续核实这次保存"));
  }
  return function TopicOverview({ invoke, conversationId, initialScope, onApply, onClose, onChanged, openSession = () => {}, openTask = () => {} }) {
    const [query, setQuery] = React.useState("");
    const [navigation, setNavigation] = React.useState({ cursor: undefined, previous: [] });
    const [refresh, setRefresh] = React.useState(0);
    const [list, setList] = React.useState({ items: [], hasMore: false, nextCursor: null, loading: true, error: "" });
    const [expanded, setExpanded] = React.useState(null);
    const [detail, setDetail] = React.useState({ card: null, loading: false, error: "" });
    const [source, setSource] = React.useState(null);
    const [applied, setApplied] = React.useState(""), [sourcePage,setSourcePage]=React.useState(0);
    const dialog=React.useRef(null), detailTrigger=React.useRef(null), sourceHeading=React.useRef(null);
    const alive = React.useRef(true), requests = React.useRef({ list: 0, detail: 0, source: 0 });
    const identity = React.useRef(conversationId), search = React.useRef(null);
    const instanceId = React.useId();
    identity.current = conversationId;

    const clearDetail = () => {
      requests.current.detail++; requests.current.source++;
      dialog.current?.close?.();
      setExpanded(null); setSourcePage(0); detailTrigger.current?.focus?.(); setDetail({ card: null, loading: false, error: "" }); setSource(null); setApplied("");
    };
    const close = () => { alive.current = false; requests.current.list++; clearDetail(); onClose(); };
    React.useEffect(() => {
      alive.current = true;
      const priorFocus = typeof document === "undefined" ? null : document.activeElement;
      search.current?.focus();
      return () => { alive.current = false; requests.current.list++; requests.current.detail++; requests.current.source++; if (priorFocus?.isConnected) priorFocus.focus?.(); };
    }, []);
    React.useEffect(()=>{const node=dialog.current,heading=sourceHeading.current;if(!source||!node||!heading)return;heading.focus({preventScroll:true});node.scrollTo({top:Math.max(0,node.scrollTop+heading.getBoundingClientRect().top-node.getBoundingClientRect().top-96),behavior:"smooth"});},[source?.ref,source?.loading]);
    React.useEffect(()=>{const node=dialog.current;if(expanded && node && !node.open)node.showModal();return()=>{if(node?.open)node.close();};},[expanded]);
    React.useEffect(() => {
      setQuery(""); setNavigation({ cursor: undefined, previous: [] }); clearDetail();
    }, [conversationId]);
    React.useEffect(() => {
      const request = ++requests.current.list;
      let cancelled = false;
      setList({ items: [], hasMore: false, nextCursor: null, loading: true, error: "" });
      const current = () => !cancelled && alive.current && identity.current === conversationId && requests.current.list === request;
      Promise.resolve().then(() => invoke("stewardTopics", { conversationId, ...(query.trim() ? { query: query.trim() } : {}), ...(navigation.cursor ? { cursor: navigation.cursor } : {}), limit: 12 }))
        .then(page => { if (current()) setList({ ...page, loading: false, error: "" }); })
        .catch(failure => { if (current()) setList({ items: [], hasMore: false, nextCursor: null, loading: false, error: failureText(failure) }); });
      return () => { cancelled = true; };
    }, [invoke, conversationId, query, navigation.cursor, refresh]);

    async function loadDetail(item,trigger) {
      if(trigger)detailTrigger.current=trigger;setSourcePage(0);
      const key = topicKey(item.topic), request = ++requests.current.detail;
      requests.current.source++;
      setExpanded(key); setDetail({ card: null, loading: true, error: "" }); setSource(null); setApplied("");
      const current = () => alive.current && identity.current === conversationId && requests.current.detail === request;
      try {
        const card = await invoke("stewardTopic", { topic: item.topic });
        if (!current()) return;
        if (topicKey(card.topic) !== key) throw new Error("返回的话题与请求不一致，请刷新后重试。");
        setDetail({ card, loading: false, error: "" });
        setList(previous => ({ ...previous, items: previous.items.map(entry => topicKey(entry.topic) === key ? {
          ...entry, topic: card.topic, version: card.version, title: card.title, summary: card.summary, freshness: card.freshness, coverageReason: card.coverageReason,
        } : entry) }));
      } catch (failure) { if (current()) setDetail({ card: null, loading: false, error: failureText(failure) }); }
    }
    async function loadSource(ref, offset = 0, previous = []) {
      const request = ++requests.current.source, detailRequest = requests.current.detail;
      setSource({ ref, page: null, previous, loading: true, error: "" });
      const current = () => alive.current && identity.current === conversationId && requests.current.source === request && requests.current.detail === detailRequest;
      try {
        const page = await invoke("stewardTopicSource", { conversationId, ref, offset });
        if (!current()) return;
        if (page.ref.kind !== ref.kind || page.ref.id !== ref.id || page.ref.revision !== ref.revision || page.offset !== offset)
          throw new Error("原文版本或分页位置不一致，请刷新话题后重新选择来源。");
        setSource({ ref, page, previous, loading: false, error: "" });
      } catch (failure) { if (current()) setSource({ ref, page: null, previous, loading: false, error: failureText(failure) }); }
    }
    const changePage = (cursor, previous) => {
      requests.current.list++; clearDetail();
      setList({ items: [], hasMore: false, nextCursor: null, loading: true, error: "" });
      setNavigation({ cursor, previous });
    };
    const uniqueSources=detail.card ? [...new Map([...detail.card.facts.flatMap(fact=>fact.sources),...detail.card.sources].map(ref=>[sourceKey(ref),ref])).values()] : [];
    const citeNumber=ref=>uniqueSources.findIndex(value=>sourceKey(value)===sourceKey(ref))+1;
    const refs = sources => h("span",{className:"sto-cites"},...sources.map(ref=>h("button",{key:sourceKey(ref),type:"button",onClick:()=>void loadSource(ref),"aria-label":`查看引用 ${citeNumber(ref)}：${sourceLabel(ref)}`,title:sourceLabel(ref)},`[${citeNumber(ref)}]`)));
    const renderDetail = item => {
      const card = detail.card;
      return h("div", { className: "sto-detail", id: `${instanceId}-detail`, "aria-label": `${item.title}详情` },
        detail.loading && h("p", { role: "status" }, "正在读取话题详情…"),
        detail.error && h("div", { className: "sto-error", role: "alert" }, h("p", null, detail.error), h("button", { type: "button", onClick: () => void loadDetail(item) }, "重试读取详情")),
        card && h(React.Fragment, null,
          h("p", { className: "sto-muted" }, `${freshness[card.freshness]} · 已覆盖至 #${card.coverageSeq} / 已观察至 #${card.observedThroughSeq}`),
          card.coverageReason && h("p", { className: "sto-muted" }, card.coverageReason),
          h("div", {className:"sto-actions sto-detail-actions"}, h("button", { type: "button", onClick: () => void loadDetail(item) }, "刷新话题详情"), h("button", { type: "button", onClick: () => { onApply(card.topic.scope); setApplied(topicKey(card.topic)); } }, "应用到管家"), h("span", {className:"sto-muted"}, "用于下一条消息")),
          h(TopicSessionControls,{key:`sessions:${topicKey(card.topic)}`,invoke,topic:card.topic,onApply:(scope,recipient,humanLabel)=>{onApply(scope,recipient,humanLabel);setApplied(topicKey(card.topic));},onChanged:()=>{setRefresh(value=>value+1);onChanged?.();},openSession}),
          card.topic.scope.kind === "workbench" && card.topic.scope.topicId && h(TopicWorkControls,{key:topicKey(card.topic),invoke,topic:card.topic,onChanged:()=>{setRefresh(value=>value+1);onChanged?.();},openSession,openTask}),
          card.summary && !card.facts.some(fact=>fact.text.includes(card.summary)) && h("section",{"aria-label":"完整话题摘要"},h("h3",null,"简介"),h("p",{className:"sto-full-summary",style:{whiteSpace:"pre-wrap"}},card.summary)),
          ...Object.entries(sections).map(([section, title]) => {
            const facts = card.facts.filter(fact => fact.section === section);
            return h("section", { key: section, "aria-label": title }, h("h3", null, title), facts.length ? facts.map(fact => h("div", { className: "sto-fact", key: fact.id },
              h("div", { className: "sto-provenance" }, `${origins[fact.origin]}${fact.state === "superseded" ? " · 已被替代" : ""}`),
              h("p", { className: "sto-fact-text" }, fact.text, " ",refs(fact.sources)))) : h("p", { className: "sto-muted" }, "暂无有来源支持的记录"));
          }),
          uniqueSources.length>0 && h("details",{className:"sto-directory","aria-label":"引用目录"},h("summary",null,"查看引用"),...uniqueSources.slice(sourcePage*6,sourcePage*6+6).map(ref=>h("div",{className:"sto-directory-item",key:sourceKey(ref)},refs([ref]),h("span",null,sourceLabel(ref)))),uniqueSources.length>6&&h("div",{className:"sto-actions"},h("button",{type:"button",disabled:sourcePage===0,onClick:()=>setSourcePage(value=>value-1)},"上一页引用"),h("button",{type:"button",disabled:(sourcePage+1)*6>=uniqueSources.length,onClick:()=>setSourcePage(value=>value+1)},"下一页引用"))),
          source && h("section", { className: "sto-source", "aria-label": "引用原文" },
            h("div", { className: "sto-actions" }, h("strong", {ref:sourceHeading,tabIndex:-1}, `引用 [${citeNumber(source.ref)}] · ${sourceLabel(source.ref)}`), h("button", { type: "button", onClick: () => { requests.current.source++; setSource(null); } }, "收起原文")),
            source.loading && h("p", { role: "status" }, "正在读取引用原文…"),
            source.error && h("div", { className: "sto-error", role: "alert" }, h("p", null, `这条引用暂不可读取：${source.error}`), h("p", null, "可刷新话题详情，再明确选择来源查看当前版本。"), h("button", { type: "button", onClick: () => void loadDetail(item) }, "刷新话题并重新选择来源")),
            source.page && h(React.Fragment, null,
              h("blockquote",null,h("p",{className:"sto-quoted-original"},source.page.content)),
              h("p", { className: "sto-muted" }, `第 ${source.previous.length+1} 段${source.page.nextOffset !== null ? " · 还有下文" : " · 已到末尾"}`),
              h("div", { className: "sto-actions" },
                h("button", { type: "button", disabled: !source.previous.length, onClick: () => void loadSource(source.ref, source.previous.at(-1), source.previous.slice(0, -1)) }, "上一段原文"),
                h("button", { type: "button", disabled: source.page.nextOffset === null, onClick: () => void loadSource(source.ref, source.page.nextOffset, [...source.previous, source.page.offset]) }, "下一段原文")))),
          source?.page && h("details",{className:"sto-tech"},h("summary",null,"技术详情"),h("pre",null,JSON.stringify({reference:source.ref,offset:source.page.offset,totalBytes:source.page.totalBytes,coordinate:source.page.coordinate},null,2)),h("button",{type:"button",onClick:()=>{void navigator.clipboard.writeText(JSON.stringify(source.ref,null,2)).catch(()=>{});}},"复制引用信息")),
          applied === topicKey(card.topic) && h("p", { role: "status" }, "已应用到下一条消息。")));
    };

    return h("section", { className: "steward-topic-overview", "aria-label": "话题总览", onKeyDown: event => { if (event.key === "Escape" && !expanded) { event.stopPropagation(); close(); } } },
      h("style", null, styles),
      h("div", { className: "sto-toolbar" }, h("h2", null, "话题总览"), h("button", { type: "button", onClick: close, "aria-label": "关闭话题总览" }, "关闭")),
      h("label", { className: "sto-search" }, "搜索话题", h("input", { ref: search, type: "search", value: query, maxLength: 200, placeholder: "名称或关键词", onChange: event => {
        requests.current.list++; clearDetail(); setQuery(event.target.value); setNavigation({ cursor: undefined, previous: [] });
        setList({ items: [], hasMore: false, nextCursor: null, loading: true, error: "" });
      } })),
      list.loading && h("p", { role: "status" }, "正在读取话题…"),
      list.error && h("div", { className: "sto-error", role: "alert" }, h("p", null, list.error), h("button", { type: "button", onClick: () => setRefresh(value => value + 1) }, "重试读取话题")),
      !list.loading && !list.error && !list.items.length && h("p", { className: "sto-muted" }, query.trim() ? "没有匹配的话题，请换一个关键词。" : "暂无可浏览的话题。"),
      h("div",{className:"sto-grid"},...list.items.map(item => {
        const key=topicKey(item.topic);
        return h("article",{className:"sto-card",key,"aria-current":scopeKey(item.topic.scope)===scopeKey(initialScope)?"true":undefined},h("button",{type:"button",className:"sto-card-toggle","aria-haspopup":"dialog","aria-expanded":expanded===key,onClick:event=>expanded===key?clearDetail():void loadDetail(item,event?.currentTarget)},h("strong",{className:"sto-title",title:item.title},item.title),h("span",{className:"sto-summary"},clip(item.summary||"暂无摘要",100)),h("span",{className:"sto-card-context"},h("span",{className:"sto-last-discussion"},discussionLabel(item.lastDiscussion)),item.lastDiscussion && h("time",{className:"sto-discussion-time",dateTime:item.lastDiscussion.at,title:`最近讨论：${item.lastDiscussion.at}`},timeLabel(item.lastDiscussion.at)))));
      })),
      expanded && h("dialog",{ref:dialog,className:"sto-dialog","aria-label":"话题详情",onCancel:event=>{event.preventDefault();clearDetail();},onKeyDown:event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();clearDetail();}}},h("div",{className:"sto-dialog-heading"},h("h2",null,detail.card?.title ?? list.items.find(item=>topicKey(item.topic)===expanded)?.title ?? "话题详情"),h("button",{type:"button","aria-label":"关闭话题详情",onClick:clearDetail},"关闭")),renderDetail(list.items.find(item=>topicKey(item.topic)===expanded)??{title:"话题",topic:{conversationId,scope:initialScope}})),
      h("div", { className: "sto-actions sto-footer" }, h("span", { className: "sto-muted" }, `第 ${navigation.previous.length + 1} 页`), h("div", { className: "sto-actions" },
        h("button", { type: "button", disabled: list.loading || !navigation.previous.length, onClick: () => changePage(navigation.previous.at(-1), navigation.previous.slice(0, -1)) }, "上一页话题"),
        h("button", { type: "button", disabled: list.loading || !list.hasMore || !list.nextCursor, onClick: () => changePage(list.nextCursor, [...navigation.previous, navigation.cursor]) }, "下一页话题"))));
  };
}
