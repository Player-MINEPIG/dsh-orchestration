function createStewardClient(React) {
  const h = React.createElement;
  const scopeKey = scope => scope?.kind === "project" ? `project:${scope.projectId}` : "personal";
  const fromKey = key => key.startsWith("project:") ? { kind: "project", projectId: key.slice(8) } : { kind: "personal" };
  const stateKind = state => typeof state === "string" ? state : state?.kind ?? "unknown";
  const stateLabels = { accepted: "已登记", admitted: "会话已接收", completed: "本轮已回复", stopped: "本轮已中断", released: "已结束等待 · 原结果未知", unknown: "未核实", "needs-reconciliation": "发送结果待核实", rejected: "未接收", failed: "处理失败", pending: "等待回复" };
  const styles = `.steward{height:100%;box-sizing:border-box;display:flex;flex-direction:column;max-width:980px;margin:auto;padding:24px;color:var(--dsw-alias-label-primary,#ddd);font:14px/1.6 system-ui}.steward header{display:flex;justify-content:space-between;gap:20px;align-items:center}.steward h1{font-size:22px;margin:0}.steward small,.steward .muted{color:var(--dsw-alias-label-secondary,#888)}.steward button,.steward select,.steward textarea{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#25272b);border:1px solid var(--dsw-alias-border-l2,#555);border-radius:8px;padding:7px 11px}.steward button{cursor:pointer}.steward button:disabled{opacity:.5;cursor:default}.steward-log{flex:1;min-height:180px;overflow:auto;padding:20px 0}.steward-message{padding:14px 17px;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:12px;margin:12px 0;overflow-wrap:anywhere}.steward-message[data-role=user]{margin-left:12%;background:#398c8c12}.steward-message[data-role=notification]{border-left:3px solid #c4a25e}.steward-message p{white-space:pre-wrap;margin:9px 0}.steward-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:12px}.steward-meta button{padding:1px 8px;font-size:12px}.steward form{display:flex;flex-direction:column;gap:9px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#444)}.steward textarea{min-height:90px;resize:vertical}.steward-controls{display:flex;justify-content:space-between;gap:10px;align-items:center}.steward-alert{padding:10px 13px;border:1px solid #bd8e57;border-radius:8px;margin:9px 0;background:#bd8e5711}.steward details{font-size:12px}.steward pre{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:640px){.steward{padding:14px}.steward header{align-items:flex-start}.steward-message[data-role=user]{margin-left:4%}.steward-controls{align-items:stretch;flex-direction:column}}`;
  function StewardPanel({ invoke, openSession = () => {}, conversationId = "main", demoLabel }) {
    const [snapshot, setSnapshot] = React.useState(null), [text, setText] = React.useState("");
    const [selected, setSelected] = React.useState("personal"), [reply, setReply] = React.useState(null);
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState("");
    const [refreshError, setRefreshError] = React.useState("");
    const [pending, setPending] = React.useState(null);
    const [recovery, setRecovery] = React.useState(null);
    const initialized = React.useRef(false), alive = React.useRef(true), log = React.useRef(null), follow = React.useRef(true);
    const pendingKey = snapshot?.authorityId ? `dsh-steward-pending:${encodeURIComponent(snapshot.authorityId)}:${conversationId}` : null;
    const savePending = value => { setPending(value); try { if (pendingKey) { if (value) localStorage.setItem(pendingKey, JSON.stringify(value)); else localStorage.removeItem(pendingKey); } } catch {} };
    const accept = value => {
      if (!alive.current) return;
      setSnapshot(value);
      if (!initialized.current) { initialized.current = true; setSelected(value.routing?.auto ? "auto" : scopeKey(value.currentScope)); }
    };
    React.useEffect(() => {
      alive.current = true;
      initialized.current = false;
      let stopped = false, timer;
      async function refresh() {
        try { const value = await invoke("stewardReconcile", { conversationId }); if (!stopped) { accept(value); setRefreshError(""); } }
        catch (failure) { if (!stopped) setRefreshError(failure.message ?? String(failure)); }
        finally { if (!stopped) timer = setTimeout(refresh, 1500); }
      }
      void refresh();
      return () => { stopped = true; alive.current = false; clearTimeout(timer); };
    }, [conversationId, invoke]);
    React.useEffect(() => {
      if (!pendingKey) return;
      try { const stored = JSON.parse(localStorage.getItem(pendingKey) ?? "null"); if (stored?.conversationId === conversationId && typeof stored.commandId === "string" && typeof stored.text === "string") setPending(stored); } catch {}
    }, [pendingKey]);
    React.useEffect(() => { if (log.current && follow.current) log.current.scrollTop = log.current.scrollHeight; }, [snapshot?.messages?.length]);
    const projects = snapshot?.projects ?? [];
    const label = scope => scope?.kind === "project" ? projects.find(project => project.projectId === scope.projectId)?.title ?? scope.projectId : "闲聊";
    const replyMessage = reply ? snapshot?.messages.find(message => message.id === reply) : null;
    async function transmit(request) {
      setBusy(true); setError(""); savePending(request);
      try {
        const value = await invoke("stewardSend", request);
        if (!alive.current) return;
        accept(value); savePending(null); setText(""); setReply(null);
      } catch (failure) { if (alive.current) {
        if ((failure.details?.reason ?? failure.code) === "CLARIFICATION") { savePending(null); setError(failure.details?.detail ?? failure.message ?? String(failure)); }
        else setError(`尚未确认发送结果：${failure.message ?? String(failure)}。可以核实，或重试原请求。`);
      } }
      finally { if (alive.current) setBusy(false); }
    }
    async function reconcilePending() {
      setBusy(true);
      try {
        const value = await invoke("stewardReconcile", { conversationId }); accept(value);
        if (value.messages?.some(message => message.id === pending?.commandId || message.commandId === pending?.commandId)) savePending(null);
      } catch (failure) { setError(failure.message ?? String(failure)); }
      finally { setBusy(false); }
    }
    async function resolveWaiting() {
      if (!recovery) return;
      setBusy(true); setError("");
      try { const value = await invoke("stewardResolve", recovery); accept(value); setRecovery(null); if (pending?.commandId === value.messages?.find(message => message.id === recovery.messageId)?.commandId) savePending(null); }
      catch (failure) { setError(`结束等待尚未确认：${failure.details?.detail ?? failure.message ?? String(failure)}。刷新核实后，可重试同一操作。`); }
      finally { setBusy(false); }
    }
    return h("section", { className: "steward", "aria-label": "管家对话" },
      h("style", null, styles),
      h("header", null, h("div", null, h("h1", null, "管家"), h("small", null, "一个窗口 · 闲聊与各项目独立会话")),
        h("details", null, h("summary", null, "身份与来源"), h("p", null, `身份 ${snapshot?.persona?.id ?? "读取中"} · 版本 ${snapshot?.persona?.version ?? "—"}`), h("p", null, `对话 ${conversationId}`), snapshot?.sources?.map(item => h("p", { key: `${item.source.nodeId}:${item.source.sessionId}` }, `${item.source.sessionId}：${({ ready: "已读取", unchecked: "未核查", unavailable: "暂不可读" })[item.status?.kind] ?? "未核实"}`)), snapshot?.limitations?.map(item => h("p", { key: item }, item)), demoLabel && h("p", null, demoLabel))),
      demoLabel && h("div", { className: "steward-alert", role: "status" }, demoLabel),
      snapshot?.context && h("small", { role: "status" }, `上下文来源：${({ "manager-assembler": "已连接资源管理与装配", "native-persona-section": "原生人格提示词段", unavailable: "资源装配暂不可用" })[snapshot.context.mode] ?? "未核实"}。${snapshot.context.diagnostic ?? ""}`),
      snapshot?.requestObservation && h("details", null, h("summary", null, snapshot.requestObservation.kind === "active" ? "原生请求快照观测" : "请求快照暂不可观测"),
        h("p", null, "仅核对官方模型调用边界的请求快照，不证明网络送达或模型理解。"), snapshot.requestObservation.reason && h("p", null, snapshot.requestObservation.reason),
        (snapshot.requests ?? []).slice(-5).reverse().map(request => h("p", { key: request.id }, `${new Date(request.observedAt).toLocaleTimeString()} · ${request.source.sessionId} · 步骤 ${request.stepSeq} · 人格${request.personaObserved ? "已观测" : "未观测"} · 装配证据${request.assemblerObserved ? "已观测" : "未观测"}`, h("br"), `请求摘要 ${request.requestHash}`))),
      snapshot?.sources?.some(item => item.status?.kind === "unavailable") && h("div", { className: "steward-alert", role: "status" }, "部分原会话暂不可读取。已保存的消息仍可查看；当前列表可能尚未包含最新回复。"),
      error && h("div", { className: "steward-alert", role: "alert" }, error),
      refreshError && h("div", { className: "steward-alert", role: "alert" }, refreshError),
      pending && h("div", { className: "steward-alert", role: "status" }, h("p", null, "有一条发送结果尚未确认的原请求。不会自动重发。"), h("p", null, pending.text), h("button", { disabled: busy, onClick: reconcilePending }, "核实原请求"), " ", h("button", { disabled: busy, onClick: () => transmit(pending) }, "重试原请求")),
      recovery && h("div", { className: "steward-alert", role: "status" }, h("p", null, "原发送结果仍未知。此操作只结束等待，以便继续对话；不会重发消息、取消任务或认定任务完成。服务器会先核实原会话已空闲。"), h("button", { disabled: busy, onClick: resolveWaiting }, "确认结束等待"), " ", h("button", { disabled: busy, onClick: () => setRecovery(null) }, "继续等待")),
      h("div", { className: "steward-log", role: "log", "aria-label": "对话记录", ref: log, onScroll: event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; } },
        !snapshot ? h("p", { className: "muted" }, "正在恢复对话…") : !snapshot.messages.length ? h("p", { className: "muted" }, "从闲聊开始，或选择一个项目。回复旧消息会回到它所属的项目。") : snapshot.messages.map(message => {
          const parent = message.replyTo && snapshot.messages.find(item => item.id === message.replyTo);
          const state = stateKind(message.state);
          return h("article", { className: "steward-message", key: message.id, "data-role": message.role, "data-message-id": message.id, "data-scope": scopeKey(message.scope) },
            h("div", { className: "steward-meta" }, h("strong", null, message.role === "user" ? "你" : message.role === "notification" ? "项目通知" : message.role === "assistant" ? "管家" : "未识别来源"), h("span", null, label(message.scope)), h("time", { dateTime: message.createdAt }, new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })), message.role === "user" && h("span", { "data-state": state }, stateLabels[state] ?? state)),
            parent && h("small", null, `回复「${parent.text.slice(0, 70)}」`), h("p", null, message.text),
            message.state?.reason && h("p", { className: "muted" }, message.state.reason),
            message.resolution && h("p", { className: "muted" }, "你曾结束对此条消息的等待；后续原生证据仍会继续核实。"),
            h("div", { className: "steward-meta" }, h("button", { disabled: busy || !!pending, onClick: () => { setReply(message.id); setError(""); } }, "回复"),
              message.role === "user" && ["accepted", "admitted", "needs-reconciliation"].includes(state) && h("button", { disabled: busy || !!recovery, onClick: () => setRecovery({ conversationId, messageId: message.id, commandId: crypto.randomUUID(), expectedRevision: message.revision, expectedState: state, confirm: true }) }, "结束等待并继续"),
              h("details", null, h("summary", null, "本条依据"), h("p", null, `范围：${label(message.scope)}`), h("p", null, `消息：${message.id}`), message.source && h("p", null, `原会话：${message.source.nodeId ?? "local"} / ${message.source.sessionId} · 第 ${message.source.generation ?? 0} 代`), message.source?.sessionId && h("button", { onClick: () => openSession(message.source.sessionId) }, "打开原会话"), message.manifest && h("pre", null, JSON.stringify(message.manifest, null, 2)))));
        })),
      h("form", { onSubmit: event => { event.preventDefault(); if (busy || pending || !text.trim()) return; void transmit({ conversationId, commandId: crypto.randomUUID(), text: text.trim(), ...(reply ? { replyTo: reply } : selected === "auto" ? { routingMode: "auto" } : { target: fromKey(selected) }) }); } },
        replyMessage && h("div", { className: "steward-alert" }, `回复 ${label(replyMessage.scope)}：「${replyMessage.text.slice(0, 90)}」`, " ", h("button", { type: "button", onClick: () => setReply(null) }, "取消回复")),
        h("label", null, "本条对话对象 ", h("select", { "aria-label": "本条对话对象", value: replyMessage ? scopeKey(replyMessage.scope) : selected, disabled: busy || !!pending || !!reply, onChange: event => setSelected(event.target.value) }, snapshot?.routing?.auto && h("option", { value: "auto" }, "自动判断 · 不明确时询问"), h("option", { value: "personal" }, "闲聊"), ...projects.map(project => h("option", { key: project.projectId, value: `project:${project.projectId}` }, project.title)))),
        h("textarea", { "aria-label": "消息", value: text, disabled: busy || !!pending, placeholder: "发送消息…", onChange: event => setText(event.target.value), onKeyDown: event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit(); } }),
        h("div", { className: "steward-controls" }, h("small", null, reply ? "按被回复消息的范围发送；不会切换其他项目。" : "每个项目保留自己的历史。后台通知不会改变当前对话对象。"), h("button", { type: "submit", disabled: busy || !!pending || !snapshot || !text.trim() }, busy ? "正在登记…" : "发送"))));
  }
  return { StewardPanel };
}
