function createStewardClient(React) {
  const h = React.createElement;
  const scopeKey = scope => scope?.kind === "project" ? `project:${scope.projectId}` : "personal";
  const fromKey = key => key.startsWith("project:") ? { kind: "project", projectId: key.slice(8) } : { kind: "personal" };
  const stateKind = state => typeof state === "string" ? state : state?.kind ?? "unknown";
  const stateLabels = { queued: "已排队", accepted: "已登记", admitted: "会话已接收", completed: "本轮已回复", stopped: "本轮已中断", released: "已结束等待 · 原结果未知", unknown: "未核实", "needs-reconciliation": "发送结果待核实", rejected: "未接收", failed: "处理失败", pending: "等待回复" };
  const failureText = failure => failure.details?.detail ?? failure.message ?? String(failure);
  function MemoryControls({ invoke, conversationId, scope }) {
    const [config,setConfig] = React.useState(null), [error,setError] = React.useState(""), [working,setWorking] = React.useState(false);
    const [preset,setPreset] = React.useState(""), [initialize,setInitialize] = React.useState(false), [inherit,setInherit] = React.useState(false);
    const identity = scopeKey(scope);
    const acceptConfig = value => { setConfig(value); setPreset(value.currentPresetId ?? value.presets?.[0]?.id ?? ""); setInherit(value.inheritAuthorized); };
    async function read() { setWorking(true); try { acceptConfig(await invoke("stewardMemoryRead",{conversationId,scope}));setError(""); }catch(failure){setError(failureText(failure));}finally{setWorking(false);} }
    React.useEffect(()=>{setConfig(null);setError("");setInitialize(false);},[conversationId,identity]);
    async function configure(mode, original) {
      setWorking(true);setError("");
      try { acceptConfig(await invoke("stewardMemoryConfigure", original ?? {conversationId,scope,commandId:crypto.randomUUID(),expectedRevision:config.revision,expectedSelectionHash:config.selectionHash,mode,
        ...(mode==="manager"?{presetId:preset,initializeMissingRules:initialize,inheritProjectGenerations:inherit}:{}),
        ...(mode==="native"&&config.pendingChange?{endPendingCommandId:config.pendingChange.commandId,confirmEndPending:true}:{})})); }
      catch(failure){const message=failureText(failure);await read();setError(message);}finally{setWorking(false);}
    }
    return h("details",null,h("summary",null,"当前对话的记忆与人格来源"),
      h("p",null,"按个人或当前项目分别设置。来源规则、原生预设与实际请求观测分别核对；安装插件本身不会授权共享历史。"),
      h("button",{type:"button",disabled:working,onClick:read},config?"刷新记忆设置":"读取记忆设置"),
      error&&h("p",{role:"alert"},error),config&&h("div",null,
        h("p",null,`当前：${config.mode==="manager"?"Manager / Assembler":"原生人格段"} · 第 ${config.session.generation} 代`),
        config.diagnostics?.map((item,index)=>h("p",{key:index},item)),
        config.missingResourceIds?.length>0&&h("p",null,`缺少资源规则：${config.missingResourceIds.join("、")}`),
        h("label",null,"原生装配预设 ",h("select",{"aria-label":"记忆装配预设",value:preset,disabled:working||config.readOnly||!config.available,onChange:event=>setPreset(event.target.value)},h("option",{value:""},"请选择预设"),config.presets?.map(item=>h("option",{key:item.id,value:item.id},item.name)))),
        h("p",null,h("label",null,h("input",{type:"checkbox",checked:initialize,disabled:working||config.readOnly,onChange:event=>setInitialize(event.target.checked)})," 为缺失项建立默认读取规则；保留已有允许、拒绝与条件")),
        scope.kind==="project"&&h("p",null,h("label",null,h("input",{type:"checkbox",checked:inherit,disabled:working||config.readOnly,onChange:event=>setInherit(event.target.checked)})," 同项目换代时沿用此已批准预设；不覆盖新会话已有选择")),
        config.pendingChange&&h("div",{className:"steward-alert"},"有一项配置结果尚未确认。可重试原操作，或明确结束此配置并恢复原生人格；不会撤销已保存的规则或覆盖实际预设。",h("button",{disabled:working,onClick:()=>configure(null,config.pendingChange.request)},"重试原配置")),
        h("button",{disabled:working||config.readOnly||!config.available||!preset||!!config.pendingChange,onClick:()=>configure("manager")},"明确启用此范围的资源装配")," ",
        h("button",{disabled:working||config.readOnly,onClick:()=>configure("native")},config.pendingChange?"结束待核实配置并恢复原生人格":"明确使用原生人格段")));
  }
  function GateControls({ invoke,conversationId,projectId,projectTitle,authorityId,onSnapshot,noticeCandidate }) {
    const [view,setView]=React.useState(null),[error,setError]=React.useState(""),[working,setWorking]=React.useState(false),[pending,setPendingAction]=React.useState(null);
    const [rootTask,setRootTask]=React.useState(""),[repairs,setRepairs]=React.useState(""),[downstream,setDownstream]=React.useState(""),[instruction,setInstruction]=React.useState("修复完成后等待我验收，再开始后续规划。"),[nextText,setNextText]=React.useState("人工已核对并验收当前修复结果。请按原先已授权的下一步继续；沿用原任务，遇到范围不明确时先澄清。");
    const [amendGate,setAmendGate]=React.useState(null),[amendTitle,setAmendTitle]=React.useState(""),[amendDescription,setAmendDescription]=React.useState("");
    const [independentTitle,setIndependentTitle]=React.useState(""),[independentDescription,setIndependentDescription]=React.useState(""),[independentBacklog,setIndependentBacklog]=React.useState("");
    const storageKey=authorityId?`dsh-steward-gate-action:${encodeURIComponent(authorityId)}:${conversationId}:${encodeURIComponent(projectId)}`:null;
    const saveAction=value=>{setPendingAction(value);try{if(storageKey){if(value)localStorage.setItem(storageKey,JSON.stringify(value));else localStorage.removeItem(storageKey);}}catch{}};
    React.useEffect(()=>{try{const value=JSON.parse(localStorage.getItem(storageKey)??"null");if(value?.input?.conversationId===conversationId&&typeof value.method==="string")setPendingAction(value);}catch{}},[storageKey]);
    async function read(latest=false,beforeRowId){if(!projectId)return;setWorking(true);try{const value=await invoke("stewardGateRead",{conversationId,projectId,...(!latest&&noticeCandidate?.gateId?{gateId:noticeCandidate.gateId}:{}),...(beforeRowId?{beforeRowId}:{})});setView(value);setIndependentBacklog(previous=>previous||value.backlogs?.[0]?.id||"");setError("");}catch(failure){setError(failureText(failure));}finally{setWorking(false);}}
    React.useEffect(()=>{setView(null);setError("");setRootTask("");setRepairs("");setDownstream("");setIndependentBacklog("");if(projectId)void read();},[projectId,conversationId,noticeCandidate?.gateId]);
    async function run(method,input){const original={method,input};saveAction(original);setWorking(true);setError("");try{const result=await invoke(method,input);if(result.snapshot)onSnapshot(result.snapshot);else if(result.messages)onSnapshot(result);saveAction(null);setAmendGate(null);await read();}catch(failure){if(failure.details?.actionOutcome==="not-applied"){saveAction(null);setError(`此操作未应用：${failureText(failure)}。请刷新并修改后再确认。`);}else setError(`操作结果待核实：${failureText(failure)}。可刷新状态或显式重试原操作。`);}finally{setWorking(false);}}
    const ids=value=>[...new Set(value.split(/[\s,，]+/).filter(Boolean))];
    return h("section",{"aria-label":"阶段验收",className:"steward-alert",style:{maxHeight:"45vh",overflow:"auto"}},h("strong",null,`${projectTitle} · 修复与阶段验收`),h("p",null,"执行成功会提醒你核对报告，只有这里的人工决定能释放验收点。已准入的执行不会因后来修订而被自动取消。"),
      h("button",{disabled:working,onClick:()=>read()},"刷新验收状态")," ",h("button",{disabled:working,onClick:()=>read(true)},"查看最近验收点"),error&&h("p",{role:"alert"},error),
      pending&&h("div",{role:"status"},"有一项操作尚未确认；不会自动重发。",h("button",{disabled:working,onClick:()=>run(pending.method,pending.input)},"重试原验收操作")),
      view?.notice&&h("small",null,view.notice),
      view?.page&&h("p",null,`当前页 ${view.gates.length} 项，共 ${view.page.total} 个验收点。`,view.page.hasMore&&h("button",{disabled:working,onClick:()=>read(true,view.page.nextBeforeRowId)},"较早验收点")),
      view?.gates?.map(gate=>h("article",{key:gate.gateId,"data-gate-id":gate.gateId},h("h3",null,({repairing:"等待修复结果","awaiting-acceptance":"待你验收 · 下游尚未开始",released:"已验收，可继续已授权后续工作"})[gate.state]),
        noticeCandidate?.gateId===gate.gateId&&noticeCandidate.candidateDigest!==gate.candidate.digest&&h("p",{role:"status"},"通知后的候选已有更新，下面显示当前结果，请重新核对。"),
        h("p",null,`修复任务 ${gate.candidate.taskIds.length} 项 · 执行 ${gate.candidate.runCount} 次 · 结果报告 ${gate.candidate.reportCount} 份`),
        gate.candidate.reports.map(report=>h("details",{key:report.reportId},h("summary",null,report.title),h("pre",null,report.body))),
        gate.lastDecision&&h("p",null,`上次人工决定：${gate.lastDecision.decision==="accept"?"验收通过":"需要继续修复"} · ${gate.lastDecision.at}`),
        h("label",null,"后续请求（确认后按此内容继续）",h("textarea",{"aria-label":`后续请求 ${gate.gateId}`,value:nextText,disabled:working||!!pending,onChange:event=>setNextText(event.target.value)})),
        h("button",{disabled:working||!!pending||!gate.candidate.ready,onClick:()=>run("stewardGateDecide",{conversationId,commandId:crypto.randomUUID(),gateId:gate.gateId,expectedRevision:gate.revision,candidateDigest:gate.candidate.digest,decision:"accept",comment:"验收通过，继续等待人工下一步。"})},"通过验收，继续等待")," ",
        h("button",{disabled:working||!!pending||!gate.candidate.ready||!nextText.trim(),onClick:()=>run("stewardGateAcceptContinue",{conversationId,commandId:crypto.randomUUID(),gateId:gate.gateId,expectedRevision:gate.revision,candidateDigest:gate.candidate.digest,text:nextText,comment:"验收并继续卡片中显示的后续请求。"})},"验收并继续此请求")," ",
        h("button",{disabled:working||!!pending||!gate.candidate.ready,onClick:()=>run("stewardGateDecide",{conversationId,commandId:crypto.randomUUID(),gateId:gate.gateId,expectedRevision:gate.revision,candidateDigest:gate.candidate.digest,decision:"request-repair",comment:"需要继续修复，未授权下游开始。"})},"需要继续修复")," ",
        gate.state==="released"&&h("button",{disabled:working||!!pending||!nextText.trim(),onClick:()=>run("stewardGateContinue",{conversationId,commandId:crypto.randomUUID(),gateId:gate.gateId,expectedRevision:gate.revision,candidateDigest:gate.candidate.digest,text:nextText})},"继续卡片中的后续请求")," ",
        h("button",{disabled:working||!!pending,onClick:()=>{setAmendGate(gate);setAmendTitle("");setAmendDescription("");}},"修订修复任务"),
        (gate.invocationCount>0||gate.downstreamRunCount>0)&&h("p",null,`已有后续规划准入 ${gate.invocationCount} 次、下游 Run ${gate.downstreamRunCount} 个；修订不会撤销这些历史效果。`),
        h("details",null,h("summary",null,"本次候选与准入依据"),h("pre",null,JSON.stringify({gateId:gate.gateId,revision:gate.revision,candidateDigest:gate.candidate.digest,invocations:gate.invocations,downstreamRuns:gate.downstreamRuns},null,2))))),
      amendGate&&h("div",{className:"steward-alert"},h("p",null,"修订会使先前验收失效，后续需要重新核对结果。此处明确新增一项修复任务；不会自动执行或取消旧任务。"),h("input",{"aria-label":"新修复任务名称",value:amendTitle,onChange:event=>setAmendTitle(event.target.value)}),h("textarea",{"aria-label":"新修复任务说明",value:amendDescription,onChange:event=>setAmendDescription(event.target.value)}),h("button",{disabled:working||!!pending||!amendTitle.trim(),onClick:()=>{const taskId=crypto.randomUUID();void run("stewardGateAmend",{conversationId,commandId:crypto.randomUUID(),comment:amendDescription||amendTitle,change:{gateId:amendGate.gateId,expectedRevision:amendGate.revision,upstreamTaskIds:[...amendGate.upstreamTaskIds,taskId],newRepairTasks:[{taskId,title:amendTitle,description:amendDescription}],repairEdits:[]}});}},"确认新增修复任务并重新等待")," ",h("button",{onClick:()=>setAmendGate(null)},"取消修订")),
      h("details",null,h("summary",null,"新建独立工作"),h("p",null,"明确在本项目另开独立任务，不把它伪装成当前修复，也不释放已有验收点。确认后将登记原任务并交给本机 PM 沿用。"),
        h("label",null,"独立工作名称",h("input",{"aria-label":"独立工作名称",value:independentTitle,onChange:event=>setIndependentTitle(event.target.value)})),
        h("label",null,"工作说明",h("textarea",{"aria-label":"独立工作说明",value:independentDescription,onChange:event=>setIndependentDescription(event.target.value)})),
        h("label",null,"项目任务列表",h("select",{"aria-label":"独立工作任务列表",value:independentBacklog,onChange:event=>setIndependentBacklog(event.target.value)},h("option",{value:""},"请选择"),view?.backlogs?.map(item=>h("option",{key:item.id,value:item.id},item.title)))),
        h("button",{disabled:working||!!pending||!independentTitle.trim()||!independentBacklog||!view?.revisionSnapshot?.independentAvailable,onClick:()=>run("stewardGateIndependent",{conversationId,commandId:crypto.randomUUID(),projectId,backlogId:independentBacklog,title:independentTitle,description:independentDescription,gateSnapshotDigest:view.revisionSnapshot.digest})},"明确授权此独立工作并继续")),
      h("details",null,h("summary",null,"设置新的验收点"),h("p",null,"绑定已有工作流任务与修复任务。普通消息不会被自动当成人工验收。任务 ID 可从任务中心复制；同一工作流范围的未声明工作会被阻止。"),
        h("label",null,"工作流根任务 ID",h("input",{"aria-label":"验收根任务ID",value:rootTask,onChange:event=>setRootTask(event.target.value)})),h("label",null,"修复任务 ID（逗号或换行分隔）",h("input",{"aria-label":"修复任务ID",value:repairs,onChange:event=>setRepairs(event.target.value)})),h("label",null,"已声明后续任务 ID（可空）",h("input",{"aria-label":"后续任务ID",value:downstream,onChange:event=>setDownstream(event.target.value)})),h("label",null,"验收要求",h("textarea",{"aria-label":"验收要求",value:instruction,onChange:event=>setInstruction(event.target.value)})),
        h("button",{disabled:working||!!pending||!rootTask.trim()||!ids(repairs).length||!instruction.trim(),onClick:()=>run("stewardGateArm",{conversationId,commandId:crypto.randomUUID(),instruction,gate:{gateId:crypto.randomUUID(),projectId,workstreamTaskId:rootTask.trim(),upstreamTaskIds:ids(repairs),downstreamTaskIds:ids(downstream),upstreamSteps:[],downstreamSteps:[]}})},"确认设置验收点")));
  }
  const styles = `.steward{height:100%;box-sizing:border-box;display:flex;flex-direction:column;max-width:980px;margin:auto;padding:24px;color:var(--dsw-alias-label-primary,#ddd);font:14px/1.6 system-ui}.steward header{display:flex;justify-content:space-between;gap:20px;align-items:center}.steward h1{font-size:22px;margin:0}.steward small,.steward .muted{color:var(--dsw-alias-label-secondary,#888)}.steward button,.steward select,.steward textarea{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#25272b);border:1px solid var(--dsw-alias-border-l2,#555);border-radius:8px;padding:7px 11px}.steward button{cursor:pointer}.steward button:disabled{opacity:.5;cursor:default}.steward-log{flex:1;min-height:180px;overflow:auto;padding:20px 0}.steward-message{padding:14px 17px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:12px;margin:12px 0;overflow-wrap:anywhere}.steward-message[data-role=user]{margin-left:12%;background:#398c8c12}.steward-message[data-role=notification]{border-left:3px solid #c4a25e}.steward-message p{white-space:pre-wrap;margin:9px 0}.steward-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:12px}.steward-meta button{padding:1px 8px;font-size:12px}.steward form{display:flex;flex-direction:column;gap:9px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#444)}.steward textarea{min-height:90px;resize:vertical}.steward-controls{display:flex;justify-content:space-between;gap:10px;align-items:center}.steward-alert{padding:10px 13px;border:1px solid #bd8e57;border-radius:8px;margin:9px 0;background:#bd8e5711}.steward details{font-size:12px}.steward pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:640px){.steward{padding:14px}.steward header{align-items:flex-start}.steward-message[data-role=user]{margin-left:4%}.steward-controls{align-items:stretch;flex-direction:column}}`;
  function StewardPanel({ invoke, openSession = () => {}, conversationId = "main", demoLabel }) {
    const [snapshot, setSnapshot] = React.useState(null), [text, setText] = React.useState("");
    const [selected, setSelected] = React.useState("personal"), [reply, setReply] = React.useState(null);
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
    const [refreshError, setRefreshError] = React.useState("");
    const [pending, setPending] = React.useState([]);
    const pendingRequests = React.useRef([]), inFlight = React.useRef(new Set()), activeConversation = React.useRef(conversationId);
    activeConversation.current = conversationId;
    const [recovery, setRecovery] = React.useState(null);
    const [gateProject,setGateProject] = React.useState(null), [gateNotice,setGateNotice] = React.useState(null);
    const [quote, setQuote] = React.useState(null), [loadingOlder, setLoadingOlder] = React.useState(false);
    const initialized = React.useRef(false), alive = React.useRef(true), log = React.useRef(null), follow = React.useRef(true);
    const current = React.useRef(null), appendCursor = React.useRef(0), anchor = React.useRef(null), sentFocus = React.useRef(null);
    const pendingKey = snapshot?.authorityId ? `dsh-steward-pending:${encodeURIComponent(snapshot.authorityId)}:${conversationId}` : null;
    const savePending = update => {
      const value = update(pendingRequests.current);
      pendingRequests.current = value; setPending(value);
      try { if (pendingKey) { if (value.length) localStorage.setItem(pendingKey, JSON.stringify(value)); else localStorage.removeItem(pendingKey); } } catch {}
    };
    const updatePending = (request, status, reason = "") => savePending(items => {
      const entry = { request, status, reason };
      return items.some(item => item.request.commandId === request.commandId)
        ? items.map(item => item.request.commandId === request.commandId ? entry : item) : [...items, entry];
    });
    const removePending = commandId => savePending(items => items.filter(item => item.request.commandId !== commandId));
    const sameAuthority = (request, authorityId, value) => alive.current && activeConversation.current === request.conversationId &&
      current.current?.authorityId === authorityId && (!value || value.authorityId === authorityId);
    const sourceAvailable = request => (!request.replyTo || snapshot?.messages.some(message => message.id === request.replyTo)) &&
      (!request.quote || snapshot?.messages.some(message => message.id === request.quote.messageId));
    function restorePending(request) {
      if (!sourceAvailable(request)) return;
      setText(request.text);
      if (request.target) setSelected(scopeKey(request.target)); else setSelected("auto");
      setReply(request.replyTo ? snapshot.messages.find(message => message.id === request.replyTo) : null);
      setQuote(request.quote ? { ...request.quote, scope: snapshot.messages.find(message => message.id === request.quote.messageId).scope } : null);
      removePending(request.commandId);
    }
    const accept = (value, mode = "latest") => {
      if (!alive.current) return;
      const previous = current.current;
      if (previous && previous.authorityId !== value.authorityId) {
        current.current = null; appendCursor.current = 0; anchor.current = null; sentFocus.current = null;
        initialized.current = false; pendingRequests.current = []; setPending([]);
        setSnapshot(null); setReply(null); setQuote(null); setRecovery(null); setGateProject(null); setGateNotice(null);
        return;
      }
      const merged = new Map((mode === "latest" ? [] : previous?.messages ?? []).map(message => [message.id, message]));
      if (value.commandMessage && !value.messages?.some(message=>message.id===value.commandMessage.id)) {
        sentFocus.current=value.commandMessage.id;follow.current=false;
      }
      for (const message of [...(value.messages ?? []), ...(value.commandMessage?[{...value.commandMessage,receiptOnly:!value.messages?.some(item=>item.id===value.commandMessage.id)}]:[])]) {
        if ((merged.get(message.id)?.revision ?? -1) <= (message.revision ?? 0)) merged.set(message.id, message);
      }
      for (const update of value.updates ?? []) {
        const message = merged.get(update.id);
        if (message && message.revision <= update.revision) merged.set(update.id, { ...message, ...update });
      }
      const ordered = [...merged.values()].sort((a, b) => a.seq - b.seq);
      const messages = mode === "older" || (mode === "append" && !follow.current) ? ordered.slice(0, 300) : ordered.slice(-300);
      const next = { ...value, messages };
      current.current = next;
      if (mode !== "older") appendCursor.current = Math.max(appendCursor.current, value.page?.lastSeq ?? 0);
      setSnapshot(next);
      if (!initialized.current) { initialized.current = true; setSelected(value.routing?.auto ? "auto" : scopeKey(value.currentScope)); }
    };
    React.useEffect(() => {
      alive.current = true;
      initialized.current = false;
      current.current = null; appendCursor.current = 0;
      let stopped = false, timer;
      async function refresh() {
        try {
          const known = current.current;
          const value = await invoke("stewardReconcile", { conversationId, limit: 50,
            ...(known ? { afterSeq: appendCursor.current, knownIds: known.messages.map(message => message.id) } : {}) });
          if (!stopped) { accept(value, known ? "append" : "latest"); setRefreshError(""); }
        }
        catch (failure) { if (!stopped) setRefreshError(failure.message ?? String(failure)); }
        finally { if (!stopped) timer = setTimeout(refresh, 1500); }
      }
      void refresh();
      return () => { stopped = true; alive.current = false; clearTimeout(timer); };
    }, [conversationId, invoke]);
    React.useEffect(() => {
      if (!pendingKey) return;
      let restored = [];
      try {
        const stored = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
        const entries = Array.isArray(stored) ? stored : stored ? [{ request: stored }] : [];
        restored = entries.filter(item => item.request?.conversationId === conversationId && typeof item.request.commandId === "string" && typeof item.request.text === "string")
          .map(item => item.status === "not-admitted" ? item : { request: item.request, status: "unknown", reason: "本机保存的原请求；服务器是否已登记仍需核实。" });
      } catch {}
      pendingRequests.current = restored; setPending(restored);
    }, [pendingKey]);
    React.useLayoutEffect(() => {
      if (!log.current) return;
      if (sentFocus.current) {
        const item=log.current.querySelector(`[data-message-id="${CSS.escape(sentFocus.current)}"]`);
        if(item)log.current.scrollTop+=item.getBoundingClientRect().top-log.current.getBoundingClientRect().top;
        sentFocus.current=null;
      } else if (anchor.current) {
        const item = log.current.querySelector(`[data-message-id="${CSS.escape(anchor.current.id)}"]`);
        if (item) log.current.scrollTop += item.getBoundingClientRect().top - anchor.current.top;
        anchor.current = null;
      } else if (follow.current) log.current.scrollTop = log.current.scrollHeight;
    }, [snapshot?.messages]);
    const projects = snapshot?.projects ?? [];
    const label = scope => scope?.kind === "project" ? projects.find(project => project.projectId === scope.projectId)?.title ?? scope.projectId : "闲聊";
    const replyMessage = reply;
    const effectiveScope = replyMessage?.scope ?? (selected && selected !== "auto" ? fromKey(selected) : snapshot?.currentScope ?? {kind:"personal"});
    const pageFirst = snapshot?.messages.find(message=>!message.receiptOnly)?.seq ?? snapshot?.page?.firstSeq;
    const hasOlder = !!pageFirst && pageFirst > (snapshot.page?.firstStoredSeq ?? pageFirst);
    const hasUnseen = !!snapshot?.messages.length && snapshot.messages.at(-1).seq < (snapshot.page?.lastStoredSeq ?? 0);
    async function loadOlder() {
      if (!hasOlder || loadingOlder) return;
      setLoadingOlder(true); follow.current = false;
      const first = [...(log.current?.querySelectorAll("[data-message-id]") ?? [])].find(item => item.getBoundingClientRect().bottom > log.current.getBoundingClientRect().top);
      if (first) anchor.current = { id: first.dataset.messageId, top: first.getBoundingClientRect().top };
      try { const first=current.current.messages.find(message=>!message.receiptOnly)?.seq ?? current.current.page?.firstSeq;
        accept(await invoke("stewardSnapshot", { conversationId, beforeSeq:first, limit: 50 }), "older"); }
      catch (failure) { setError(failure.message ?? String(failure)); anchor.current = null; }
      finally { setLoadingOlder(false); }
    }
    async function latest() {
      try { const value = await invoke("stewardReconcile", { conversationId, limit: 50 }); follow.current = true; accept(value); }
      catch (failure) { setError(failure.message ?? String(failure)); }
    }
    async function transmit(request) {
      if (inFlight.current.has(request.commandId)) return;
      const authorityId = current.current?.authorityId;
      inFlight.current.add(request.commandId);
      updatePending(request, "sending", "请求正在发送或分流，尚未确认服务器登记。不会自动重发。");
      try {
        const value = await invoke("stewardSend", request);
        if (!sameAuthority(request, authorityId, value)) return;
        accept(value, "append"); removePending(request.commandId);
      } catch (failure) { if (sameAuthority(request, authorityId)) {
        const rejected = failure.details?.admission === "not-admitted" || (failure.details?.reason ?? failure.code) === "CLARIFICATION";
        updatePending(request, rejected ? "not-admitted" : "unknown", rejected
          ? `本条未发送：${failureText(failure)}。可恢复原文后修改，或重试原请求。`
          : `尚未确认发送结果：${failureText(failure)}。可核实或重试原请求，不会自动重发。`);
      } }
      finally { inFlight.current.delete(request.commandId); }
    }
    async function reconcilePending(request) {
      if (inFlight.current.has(request.commandId)) return;
      const authorityId = current.current?.authorityId;
      inFlight.current.add(request.commandId); updatePending(request, "checking", "正在核实原请求。");
      try {
        const value = await invoke("stewardReconcile", { conversationId: request.conversationId, commandId: request.commandId });
        if (!sameAuthority(request, authorityId, value)) return;
        accept(value, "append");
        if (value.commandMessage || value.messages?.some(message => message.commandId === request.commandId)) removePending(request.commandId);
        else updatePending(request, "unknown", "尚未查到服务器登记；原请求仍可能在发送或分流中，不会自动重发。");
      } catch (failure) { if (sameAuthority(request, authorityId)) updatePending(request, "unknown", failureText(failure)); }
      finally { inFlight.current.delete(request.commandId); }
    }
    async function resolveWaiting() {
      if (!recovery) return;
      setBusy(true); setError("");
      try { const value = await invoke("stewardResolve", recovery); accept(value); setRecovery(null); const commandId = value.messages?.find(message => message.id === recovery.messageId)?.commandId; if (commandId) removePending(commandId); }
      catch (failure) { setError(`结束等待尚未确认：${failure.details?.detail ?? failure.message ?? String(failure)}。刷新核实后，可重试同一操作。`); }
      finally { setBusy(false); }
    }
    return h("section", { className: "steward", "aria-label": "管家对话" },
      h("style", null, styles),
      h("header", null, h("div", null, h("h1", null, "管家"), h("small", null, "一个窗口 · 闲聊与各项目独立会话")),
        h("details", null, h("summary", null, "身份与来源"), h("p", null, `身份 ${snapshot?.persona?.id ?? "读取中"} · 版本 ${snapshot?.persona?.version ?? "—"}`), h("p", null, `对话 ${conversationId}`), snapshot?.sources?.map(item => h("p", { key: `${item.source.nodeId}:${item.source.sessionId}` }, `${item.source.sessionId}：${({ ready: "已读取", unchecked: "未核查", unavailable: "暂不可读" })[item.status?.kind] ?? "未核实"}`)), snapshot?.limitations?.map(item => h("p", { key: item }, item)), demoLabel && h("p", null, demoLabel))),
      demoLabel && h("div", { className: "steward-alert", role: "status" }, demoLabel),
      snapshot?.context && h("small", { role: "status" }, `上下文来源：${({ "manager-assembler": "已连接资源管理与装配", "native-persona-section": "原生人格提示词段", unavailable: "资源装配暂不可用", "scope-specific-manager": "按范围设置资源装配", "available-not-delegated": "资源服务可用，尚未委托" })[snapshot.context.mode] ?? "未核实"}。${snapshot.context.diagnostic ?? ""}`),
      snapshot && h(MemoryControls,{key:`memory:${conversationId}:${scopeKey(effectiveScope)}`,invoke,conversationId,scope:effectiveScope}),
      effectiveScope.kind==="project"&&h("button",{onClick:()=>{setGateProject(effectiveScope.projectId);setGateNotice(null);}},`查看 ${label(effectiveScope)} 阶段验收`),
      gateProject&&h("div",null,h("button",{onClick:()=>setGateProject(null)},"关闭验收卡"),h(GateControls,{key:`gate:${conversationId}:${gateProject}`,invoke,conversationId,projectId:gateProject,projectTitle:label({kind:"project",projectId:gateProject}),authorityId:snapshot?.authorityId,onSnapshot:value=>{follow.current=true;accept(value);},noticeCandidate:gateNotice})),
      snapshot?.requestObservation && h("details", null, h("summary", null, snapshot.requestObservation.kind === "active" ? "原生请求快照观测" : "请求快照暂不可观测"),
        h("p", null, "仅核对官方模型调用边界的请求快照，不证明网络送达或模型理解。"), snapshot.requestObservation.reason && h("p", null, snapshot.requestObservation.reason),
        (snapshot.requests ?? []).slice(-5).reverse().map(request => h("p", { key: request.id }, `${new Date(request.observedAt).toLocaleTimeString()} · ${request.source.sessionId} · 步骤 ${request.stepSeq} · 人格${request.personaObserved ? "已观测" : "未观测"} · 装配证据${request.assemblerObserved ? "已观测" : "未观测"}`, h("br"), `请求摘要 ${request.requestHash}`))),
      snapshot?.sources?.some(item => item.status?.kind === "unavailable") && h("div", { className: "steward-alert", role: "status" }, "部分原会话暂不可读取。已保存的消息仍可查看；当前列表可能尚未包含最新回复。"),
      error && h("div", { className: "steward-alert", role: "alert" }, error),
      refreshError && h("div", { className: "steward-alert", role: "alert" }, refreshError),
      pending.map(item => h("div", { key: item.request.commandId, className: "steward-alert", role: "status", "data-pending-command": item.request.commandId },
        h("p", null, item.reason), h("small", null, `本机待核实请求 ${item.request.commandId} · ${item.request.target ? label(item.request.target) : item.request.replyTo ? "回复原消息" : "自动分流"}`), h("p", null, item.request.text),
        h("button", { disabled: ["sending", "checking"].includes(item.status), onClick: () => reconcilePending(item.request) }, "核实原请求"), " ",
        h("button", { disabled: ["sending", "checking"].includes(item.status), onClick: () => transmit(item.request) }, "重试原请求"), " ",
        item.status === "not-admitted" && h("button", { disabled: busy || !!text.trim() || !sourceAvailable(item.request), onClick: () => restorePending(item.request) }, "恢复原文到输入框"),
        item.status === "not-admitted" && !sourceAvailable(item.request) && h("small", null, "原回复或引用消息不在当前页。载入原消息后可恢复编辑；仍可核实或重试原请求。"))),
      recovery && h("div", { className: "steward-alert", role: "status" }, h("p", null, "原发送结果仍未知。此操作只结束等待，以便继续对话；不会重发消息、取消任务或认定任务完成。服务器会先核实原会话已空闲。"), h("button", { disabled: busy, onClick: resolveWaiting }, "确认结束等待"), " ", h("button", { disabled: busy, onClick: () => setRecovery(null) }, "继续等待")),
      snapshot?.attention?.items?.some(item => !snapshot.messages.some(message => message.id === item.id)) && h("details", { open: true, className: "steward-alert" }, h("summary", null, "较早的消息仍需核实"),
        snapshot.attention.items.filter(item => !snapshot.messages.some(message => message.id === item.id)).map(item => h("p", { key: item.id }, `${label(item.scope)} · ${stateLabels[item.state.kind] ?? "未核实"} · ${item.preview}`, " ", h("button", { disabled: busy || !!recovery, onClick: () => setRecovery({ conversationId, messageId: item.id, commandId: crypto.randomUUID(), expectedRevision: item.revision, expectedState: item.state.kind, confirm: true }) }, "结束此条等待"))),
        snapshot.attention.hasMore && h("small", null, "仅显示最早 20 条待核实消息，处理后可继续查看。")),
      h("div", { className: "steward-log", role: "log", "aria-label": "对话记录", ref: log, onScroll: event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; } },
        hasOlder && h("button", { disabled: loadingOlder, onClick: loadOlder }, loadingOlder ? "正在载入…" : "载入更早消息"),
        snapshot && h("small", { className: "muted" }, ` 当前保留 ${snapshot.messages.length} 条，最多 300 条。原始记录保存在服务器，可继续分页。`),
        !snapshot ? h("p", { className: "muted" }, "正在恢复对话…") : !snapshot.messages.length ? h("p", { className: "muted" }, "从闲聊开始，或选择一个项目。回复旧消息会回到它所属的项目。") : snapshot.messages.map(message => {
          const parent = message.replyTo && (snapshot.messages.find(item => item.id === message.replyTo) ?? snapshot.references?.find(item => item.id === message.replyTo));
          const state = stateKind(message.state);
          return h("article", { className: "steward-message", key: message.id, "data-role": message.role, "data-message-id": message.id, "data-scope": scopeKey(message.scope) },
            h("div", { className: "steward-meta" }, h("strong", null, message.role === "user" ? "你" : message.role === "notification" ? "项目通知" : message.role === "assistant" ? "管家" : "未识别来源"), h("span", null, label(message.scope)), h("time", { dateTime: message.createdAt }, new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })), message.role === "user" && h("span", { "data-state": state }, stateLabels[state] ?? state)),
            message.replyTo && h("small", null, parent ? `回复 ${label(parent.scope)}「${(parent.text ?? parent.preview).slice(0, 70)}」` : "回复较早的消息"), h("p", null, message.text),
            message.quote && h("blockquote", null, h("small", null, `明确引用自 ${label(message.quote.scope)}`), h("p", null, message.quote.excerpt)),
            message.state?.reason && h("p", { className: "muted" }, message.state.reason),
            message.resolution && h("p", { className: "muted" }, "你曾结束对此条消息的等待；后续原生证据仍会继续核实。"),
            message.gate&&message.scope.kind==="project"&&h("button",{onClick:()=>{setGateProject(message.scope.projectId);setGateNotice(message.gate);}},"打开这次验收候选"),
            h("div", { className: "steward-meta" }, h("button", { disabled: busy, onClick: () => { setReply(message); setQuote(null); setError(""); } }, "回复"),
              h("button", { disabled: busy, onClick: () => { setQuote({ messageId: message.id, expectedRevision: message.revision, excerpt: message.text.slice(0, 2000), scope: message.scope }); setReply(null); setSelected(""); setError(""); } }, "引用到…"),
              message.role === "user" && ["accepted", "admitted", "needs-reconciliation"].includes(state) && h("button", { disabled: busy || !!recovery, onClick: () => setRecovery({ conversationId, messageId: message.id, commandId: crypto.randomUUID(), expectedRevision: message.revision, expectedState: state, confirm: true }) }, "结束等待并继续"),
              h("details", null, h("summary", null, "本条依据"), h("p", null, `范围：${label(message.scope)}`), h("p", null, `消息：${message.id}`), message.replyTo && h("p", null, `被回复消息：${message.replyTo}`), message.source && h("p", null, `原会话：${message.source.nodeId ?? "local"} / ${message.source.sessionId} · 第 ${message.source.generation ?? 0} 代`), message.source?.sessionId && h("button", { onClick: () => openSession(message.source.sessionId) }, "打开原会话"), message.quote && h("pre", null, JSON.stringify(message.quote, null, 2)), message.manifest && h("pre", null, JSON.stringify(message.manifest, null, 2)))));
        })),
      hasUnseen && h("button", { onClick: latest }, "有较新消息 · 返回最新"),
      h("form", { onSubmit: event => { event.preventDefault(); if (busy || !text.trim() || (quote && (!selected || selected === "auto" || !quote.excerpt.trim()))) return; const request = { conversationId, commandId: crypto.randomUUID(), text: text.trim(), ...(reply ? { replyTo: reply.id } : selected === "auto" ? { routingMode: "auto" } : { target: fromKey(selected) }), ...(quote ? { quote: { messageId: quote.messageId, expectedRevision: quote.expectedRevision, excerpt: quote.excerpt } } : {}) }; setText(""); setReply(null); setQuote(null); setError(""); void transmit(request); } },
        replyMessage && h("div", { className: "steward-alert" }, `回复 ${label(replyMessage.scope)}：「${replyMessage.text.slice(0, 90)}」`, " ", h("button", { type: "button", onClick: () => setReply(null) }, "取消回复")),
        quote && h("div", { className: "steward-alert" }, h("p", null, `分享一段 ${label(quote.scope)} 原文到明确选择的目标。只分享下面的连续原文片段，不转移其他历史。`), h("textarea", { "aria-label": "引用原文片段", value: quote.excerpt, maxLength: 2000, disabled: busy, onChange: event => setQuote({ ...quote, excerpt: event.target.value }) }), h("small", null, `来源 ${quote.messageId} · 版本 ${quote.expectedRevision} · 最多 2000 字；可删选连续片段，不可改写原文。`), " ", h("button", { type: "button", onClick: () => setQuote(null) }, "取消引用")),
        h("label", null, "本条对话对象 ", h("select", { "aria-label": "本条对话对象", value: replyMessage ? scopeKey(replyMessage.scope) : selected, disabled: busy || !!reply, onChange: event => setSelected(event.target.value) }, quote && h("option", { value: "" }, "请选择引用目标"), snapshot?.routing?.auto && !quote && h("option", { value: "auto" }, "自动判断 · 不明确时询问"), h("option", { value: "personal" }, "闲聊"), ...projects.map(project => h("option", { key: project.projectId, value: `project:${project.projectId}` }, project.title)))),
        h("textarea", { "aria-label": "消息", value: text, disabled: busy, placeholder: "发送消息…", onChange: event => setText(event.target.value), onKeyDown: event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit(); } }),
        h("div", { className: "steward-controls" }, h("small", null, reply ? "按被回复消息的范围发送；不会切换其他项目。" : quote ? "确认后将选定原文明确分享至本条对话对象。" : "每个项目保留自己的历史。后台通知不会改变当前对话对象。"), h("button", { type: "submit", disabled: busy || !snapshot || !text.trim() || (quote && (!selected || selected === "auto" || !quote.excerpt.trim())) }, busy ? "正在登记…" : quote ? "分享引用并发送" : "发送"))));
  }
  return { StewardPanel };
}
