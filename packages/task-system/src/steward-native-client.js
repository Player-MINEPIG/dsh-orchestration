function createStewardDisplayJournal() {
  const rows = new Map(), listeners = new Set();
  let nextSeq = 0;
  const records = [];
  function encode(message, start) {
    const time = Date.parse(message.createdAt), turn = message.seq;
    const event = (type, data, surfaceOp) => ({ type: "event", event: {
      type, seq: start++, time, data, ...(surfaceOp ? { surfaceOp } : {}),
    } });
    const result = [event("turn/start", { turn }), event("step/start", { turn, step: 0 })];
    if (message.role === "user") result.push(event("user/message", {
      id: message.id, role: "user", source: { kind: "user", ...(message.commandId ? { rpcId: message.commandId } : {}) },
      content: [{ type: "text", text: message.text }],
    }, "append"));
    else result.push(event("assistant/message", { turn, step: 0, message: {
      id: message.id, role: "assistant", source: { kind: "model", provider: "steward-display", model: "canonical-history" },
      content: [{ type: "text", text: message.text }],
    }, stream: [] }, "append"));
    result.push(event("step/end", { turn, step: 0 }), event("turn/end", { turn, reason: { kind: "completed" } }));
    return result;
  }
  return {
    sync(messages) {
      messages = [...messages].sort((a, b) => a.seq - b.seq).slice(-300);
      const incoming = [...messages].sort((a, b) => a.seq - b.seq).filter(message => !rows.has(message.id));
      if (!incoming.length) return;
      const appended = incoming.flatMap(message => { const result = encode(message, nextSeq); nextSeq += result.length; rows.set(message.id, message); return result; });
      records.push(...appended);
      if (appended.length) for (const listener of listeners) listener(appended);
    },
    replace(messages) {
      rows.clear(); records.length = 0;
      for (const message of [...messages].sort((a, b) => a.seq - b.seq).slice(-300)) {
        const encoded = encode(message, nextSeq); nextSeq += encoded.length; rows.set(message.id, message); records.push(...encoded);
      }
      for (const listener of listeners) listener(null);
    },
    get ids() { return [...rows.keys()]; },
    get cursor() { return nextSeq - 1; },
    get records() { return records; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    page(beforeSeq, maxMessages = 50) { return records.filter(row => row.event.seq < beforeSeq).slice(-Math.min(maxMessages, 100) * 5); },
  };
}

function createStewardNativeClient({ React, Context, modules, hostContext, createPortal }) {
  const h = React.createElement, imports = new Map();
  const load = name => {
    const id = `@deepseek-ai/${name}`;
    if (!imports.has(id)) imports.set(id, modules.import(id));
    return imports.get(id);
  };
  const emptyInbox = { "next-turn": [], "next-step": [] };
  const unsupported = endpoint => ({ ok: false, error: { code: "steward/display-only", message: "此操作不适用于管家统一视图。请打开对应原会话。", details: { endpoint } } });
  const aborted = signal => { if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); };
  const waitFor = (source, predicate, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
    let off = () => {};
    const finish = error => { clearTimeout(timer); off(); signal.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
    const check = () => { if (predicate(source.getSnapshot())) finish(); };
    const cancel = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(new Error("原生管家界面加载超时。")), 15000);
    signal.addEventListener("abort", cancel, { once: true }); off = source.subscribe(check); check();
  });
  const service = (ctx, name) => ({ getSnapshot: () => !!ctx.get(name), subscribe: listener => { const timer = setInterval(listener, 25); return () => clearInterval(timer); } });
  const idle = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
  const ShellState = React.createContext(null);
  function createPlacement() {
    let snapshot = { chat: null, composer: null, view: 'chat' };
    const listeners = new Set();
    const set = (key, value) => { if (snapshot[key] === value) return; snapshot = { ...snapshot, [key]: value }; for (const listener of listeners) listener(); };
    return { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, chat: node => set('chat', node), composer: node => set('composer', node), select: view => set('view', view) };
  }
  function SourceViews({ renderSlot }) {
    const { placement, selected } = React.useContext(ShellState);
    return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
      h('div', { ref: placement.chat, 'data-steward-unified-chat': '', style: { flex: 1, minHeight: 0, display: selected === 'chat' ? 'flex' : 'none', flexDirection: 'column' } }),
      selected && selected !== 'chat' && renderSlot('conversation.session', { view: selected }));
  }
  const sourceContentSlots = { views: SourceViews };
  function SourceShell(props) {
    const { bridge, placement, sessionId, useStore, useConversationViews } = props;
    const tabs = useConversationViews(value => value), saved = useStore(value => value.view), request = useStore(value => value.viewRequest ?? null);
    const presentation = React.useSyncExternalStore(placement.subscribe, placement.getSnapshot, placement.getSnapshot);
    const selected = tabs.some(tab => tab.id === presentation.view) ? presentation.view : tabs.some(tab => tab.id === 'chat') ? 'chat' : null;
    React.useEffect(() => { if (request && tabs.some(tab => tab.id === saved)) placement.select(saved); }, [request, saved]);
    const source = React.useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
    const nativeTitle = props.useSessions(value => value.byId[sessionId]?.displayTitle);
    const nativePreset = props.useSessions(value => value.byId[sessionId]?.projectionValues?.agentPreset);
    const blank = props.useSession(value => value.blank);
    React.useLayoutEffect(() => {
      const off = hostContext.slots.inject('conversation.composer', () => hostContext.slots.register({
        name: 'conversation.composer', id: 'steward-router', priority: -100,
        select: owner => owner.sessionId === sessionId ? true : null,
      }, function RouterComposer() { return null; }));
      return off;
    }, [sessionId, placement]);
    return h(ShellState.Provider, { value: { placement, selected } },
      h('div', { className: 'steward-native-heading', 'data-steward-browse-session': sessionId },
        h('div', { className: 'steward-native-title-row' }, h('strong', { title: sessionId }, nativeTitle || `管家 · ${source.sourceScopeLabel}`), typeof nativePreset === 'string' && h('span', { title: `原生 Agent 预设 ${nativePreset}` }, nativePreset), source.renderBrowseTopic()),
        h('div', { role: 'tablist', 'data-conversation-tabs': '' }, tabs.map(tab => h('button', { key: tab.id, type: 'button', role: 'tab', 'aria-selected': selected === tab.id, onClick: () => { hostContext.get('uiConversation').binding(sessionId).activate(tab.id); placement.select(tab.id); } }, tab.label)))),
      blank && selected !== 'chat' && h('p', { role: 'status' }, '该原会话尚无对话轮次，原生页面会在开始对话后显示。'),
      props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: sourceContentSlots }));
  }
  if (hostContext) hostContext.slots.inject('steward.session.shell', () => {
    let registration;
    const install = () => {
      if (registration) return;
      const native = hostContext.slots.entriesOfSlot('conversation.session').find(entry => entry.store);
      if (!native) return;
      if (typeof native.store !== 'object' || typeof native.inject !== 'function') throw new Error('当前 DSH 的会话注册不兼容。');
      registration = hostContext.slots.register({ name: 'steward.session.shell', store: native.store, inject: native.inject,
      }, SourceShell);
    };
    const off = hostContext.slots.subscribe('conversation.session', install); install();
    return () => { off(); registration?.(); };
  });
  function SessionShell({ bridge, handle, renderSlot, SessionProvider }) {
    const mount = React.useRef(null), eventRoot = React.useRef(null), references = React.useRef(new Map()), placement = React.useMemo(createPlacement, []);
    const [source, setSource] = React.useState(null), [sourceRefresh, setSourceRefresh] = React.useState(0), [sourceError, setSourceError] = React.useState(''), [displayStatus, setDisplayStatus] = React.useState('正在加载原生输入框…');
    const view = React.useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
    const sourceKey = JSON.stringify(view.sourceScope);
    const sourceToken = view.sourceScope.kind === 'project' ? view.projects?.find(project => project.projectId === view.sourceScope.projectId)?.bindingToken : null;
    React.useEffect(() => {
      const lifetime = new AbortController(); let reference;
      const current = () => { const latest = bridge.getSnapshot(); return !lifetime.signal.aborted && latest.authorityId === view.authorityId && latest.conversationId === view.conversationId && JSON.stringify(latest.sourceScope) === sourceKey && (latest.sourceScope.kind !== 'project' || latest.projects?.find(project => project.projectId === latest.sourceScope.projectId)?.bindingToken === sourceToken); };
      handle.current?.rememberSourceFocus();
      setSource(null); setSourceError('');
      (async () => {
        const value = await view.invoke('stewardSourceSession', { conversationId: view.conversationId, scope: view.sourceScope });
        if (!current()) return;
        await hostContext.get('sessions').refresh();
        if (!current()) return;
        reference = hostContext.get('sessions').retain(value.binding.sessionId, { source: 'projectConversation' });
        references.current.set(reference, false);
        await reference.ready;
        if (current()) { references.current.set(reference, true); setSource({ reference, binding: value.binding }); }
        else { reference.release(); references.current.delete(reference); }
      })().catch(error => { if (current()) setSourceError(error.message ?? String(error)); });
      return () => { lifetime.abort(); if (reference && references.current.get(reference) === false) { reference.release(); references.current.delete(reference); } };
    }, [view.authorityId, view.conversationId, sourceKey, sourceToken, sourceRefresh]);
    React.useEffect(() => { for (const [reference, published] of references.current) if (published && reference !== source?.reference) { reference.release(); references.current.delete(reference); } }, [source]);
    React.useEffect(() => () => { for (const reference of references.current.keys()) reference.release(); references.current.clear(); }, []);
    React.useEffect(() => {
      const lifetime = new AbortController(); let mounted;
      api.mount(mount.current, bridge, { signal: lifetime.signal, eventRoot: eventRoot.current, placement, onState: message => { setDisplayStatus(message); bridge.getSnapshot().setStatus(message); } })
        .then(value => { if (lifetime.signal.aborted) void value.dispose(); else { mounted = value; handle.current = value; } })
        .catch(error => { if (!lifetime.signal.aborted) { setDisplayStatus(error.message ?? String(error)); bridge.notice(error.message ?? String(error)); } });
      return () => { lifetime.abort(); handle.current = null; if (mounted) void mounted.dispose(); };
    }, [view.authorityId, view.conversationId]);
    React.useEffect(() => { if (source || sourceError) handle.current?.restoreBrowseFocus(); }, [source, sourceError]);
    return h('div', { ref: eventRoot, className: 'steward-full-session', 'data-steward-native-host': '', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
      h('div', { ref: mount, style: { display: 'none' } }), displayStatus && h('p', { role: 'status' }, displayStatus),
      source ? h(SessionProvider, { key: source.binding.sessionId, session: source.reference }, renderSlot('steward.session.shell', { bridge, placement })) :
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          h('div', { className: 'steward-native-heading' }, h('div', { className: 'steward-native-title-row' }, h('strong', null, '管家'), view.renderBrowseTopic())),
          h('p', { role: sourceError ? 'alert' : 'status' }, sourceError || '正在读取当前话题的原会话…'),
          sourceError && h('button', { type: 'button', onClick: () => setSourceRefresh(value => value + 1) }, '重新读取原会话'),
          h('div', { ref: placement.chat, style: { flex: 1, minHeight: 0 } })),
      h('div', { ref: placement.composer, 'data-steward-router-composer': '' }));
  }

  const api = {
    SessionShell,
    async mount(container, bridge, { signal, onState, eventRoot = container, placement } = {}) {
      const ctx = new Context(), lifetime = new AbortController(), journal = createStewardDisplayJournal();
      const cancel = () => lifetime.abort(signal.reason);
      if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
      const snapshot = bridge.getSnapshot(), identity = `${snapshot.authorityId}:${snapshot.conversationId}`;
      const sessionId = `steward-display:${identity}`, createdAt = Date.now();
      let reference, unmount, offBridge, offSubmissions, offInput;
      const prepared = new Map();
      let browseHadComposerFocus = false, sourceHadComposerFocus = false;
      let DisplayCarrierError;
      const projections = () => ({ asOfSeq: journal.cursor, values: { inbox: emptyInbox } });
      const summary = () => ({ sessionId, updatedAt: Date.now(), agentAvailable: false, running: false, blank: journal.records.length === 0 });
      const sync = () => {
        if (`${bridge.getSnapshot().authorityId}:${bridge.getSnapshot().conversationId}` !== identity) return;
        const messages = bridge.getSnapshot().messages.slice(-300), ids = journal.ids;
        const previous = new Set(ids), next = new Set(messages.map(message => message.id));
        const newBeforeTail = messages.some(message => !previous.has(message.id) && message.seq < Math.max(0, ...bridge.getSnapshot().messages.filter(message => previous.has(message.id)).map(message => message.seq)));
        if (ids.length && (ids.some(id => !next.has(id)) || newBeforeTail)) {
          journal.replace(messages);
        } else journal.sync(messages);
      };
      sync(); offBridge = bridge.subscribe(sync);
      const rpc = {
        async call(channel, endpoint, payload, signal) {
          if (channel !== "/api") return unsupported(endpoint);
          try {
            const request = payload?.args?.request;
            let value;
            switch (endpoint) {
              case "commands/list": value = []; break;
              case "session/list": value = { items: [summary()] }; break;
              case "session/projections": value = { kind: "sequenced", ...projections() }; break;
              case "session/page": {
                if (request?.address?.sessionId !== sessionId) return unsupported(endpoint);
                const before = request.beforeSeq ?? journal.cursor + 1;
                if (!journal.page(before).length && bridge.getSnapshot().hasOlder) await bridge.loadOlder();
                sync();
                const records = journal.page(before, request.maxMessages);
                value = { records, hasMore: !!bridge.getSnapshot().hasOlder || journal.records[0]?.event.seq < records[0]?.event.seq };
                break;
              }
              case "session/prompt": {
                if (request?.sessionId !== sessionId || request.mode !== "queue" || !Array.isArray(request.content) || !request.content.length || request.content.some(part => part.type !== "text"))
                  throw new Error("管家目前仅接收文字；附件请在对应原会话中发送。");
                const text = request.content.map(part => part.text).join("\n");
                if (`${bridge.getSnapshot().authorityId}:${bridge.getSnapshot().conversationId}` !== identity) throw new Error("管家权限来源已变化；请核对原请求。");
                const captured = prepared.get(request.requestId);
                if (!captured) throw new Error("本条消息的目标快照缺失，请核对原请求后重试。");
                if (captured.error) throw captured.error;
                if (captured.request.text !== text.trim()) throw new Error("原生消息与已保存的原请求不一致。");
                const trackedOriginal = bridge.submit(captured.request);
                await trackedOriginal;
                sync(); const displayReceipt = { accepted: true }; value = displayReceipt; break;
              }
              default: return unsupported(endpoint);
            }
            return { ok: true, value };
          } catch (error) {
            return { ok: false, error: { code: typeof error?.code === "string" ? error.code : "steward/admission-unknown", message: error?.message ?? String(error), details: {} } };
          }
        },
        async *open(channel, endpoint, payload, signal) {
          if (channel !== "/api") throw new Error("Unsupported display channel");
          switch (endpoint) {
            case "$events": yield { type: "ready", clientId: sessionId, host: { home: "/steward-display" } }; break;
            case "remoteAccess/follow": yield { type: "baseline", owner: false, grants: [{ resource: { kind: "global" }, actions: ["session/list", "session/control"] }, { resource: { kind: "session", id: sessionId }, actions: ["session/prompt", "session/follow", "session/page", "session/projections"] }] }; break;
            case "workspace/follow": yield { type: "baseline", value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }; break;
            case "session/control": yield { type: "baseline", value: { projections: { [sessionId]: projections() } } }; break;
            case "session/follow": {
              if (payload?.args?.request?.address?.sessionId !== sessionId) throw new Error("Display session identity changed");
              const pending = []; let wake, replace = false;
              const off = journal.subscribe(records => {
                if (records === null) { replace = true; pending.length = 0; } else pending.push(...records);
                wake?.();
              });
              const abort = () => wake?.(); signal.addEventListener("abort", abort);
              try {
                yield { type: "snapshot", header: { version: 4, id: sessionId, createdAt, isSeeded: false },
                  cursor: journal.cursor, records: [...journal.records], hasMore: false,
                  projections: projections(), assistantStream: { revision: 0 } };
                while (!signal.aborted) {
                  if (replace) throw new DisplayCarrierError("Steward display window changed");
                  while (pending.length && !replace) yield pending.shift();
                  await new Promise(resolve => { wake = resolve; if (pending.length || replace || signal.aborted) resolve(); });
                  wake = undefined;
                }
              } finally { off(); signal.removeEventListener("abort", abort); }
              return;
            }
            default: throw new Error(`Unsupported display stream: ${endpoint}`);
          }
          await idle(signal);
        },
      };
      const dispose = async () => {
        lifetime.abort(); offBridge?.(); offSubmissions?.(); offInput?.(); signal?.removeEventListener("abort", cancel);
        for (const event of ["paste", "drop", "dragover", "change"]) eventRoot.removeEventListener(event, denyFiles, true);
        await Promise.resolve(); unmount?.(); reference?.release(); await ctx.fiber.dispose();
      };
      function denyFiles(event) {
        if (placement && !event.target?.closest?.("[data-steward-router-composer]")) return;
        if (event.type === "change" && event.target instanceof HTMLInputElement && event.target.type === "file" && event.target.files?.length) {
          event.preventDefault(); event.stopImmediatePropagation(); event.target.value = "";
          bridge.notice("管家目前仅接收文字；附件请在对应原会话中发送。"); return;
        }
        const transfer = event.clipboardData ?? event.dataTransfer;
        if (transfer && (transfer.files?.length || Array.from(transfer.items ?? []).some(item => item.kind === "file") || Array.from(transfer.types ?? []).includes("Files"))) {
          event.preventDefault(); event.stopImmediatePropagation();
          bridge.notice("管家目前仅接收文字；附件请在对应原会话中发送。");
        }
      }
      for (const event of ["paste", "drop", "dragover", "change"]) eventRoot.addEventListener(event, denyFiles, true);
      try {
        onState?.("正在加载 DSH 原生对话…");
        aborted(lifetime.signal);
        const connectionModule = await load("dsh-client-connection");
        aborted(lifetime.signal);
        const gatewayModule = await load("dsh-api-gateway");
        aborted(lifetime.signal);
        DisplayCarrierError = gatewayModule.RemoteStreamCarrierError;
        connectionModule.installConnection(ctx, { interactions: "answer", transport: { rpc }, location: { hostname: "steward-display.invalid" } });
        const panelSnapshot = { activePanelId: null };
        const panelInfo = { getSnapshot: () => panelSnapshot, subscribe: () => () => {} };
        ctx.reflect.provide("layout", { panelInfo, selectPanel() {}, beginNavigation: () => lifetime.signal,
          toggleSidebar() {}, openRightbar() {}, closeRightbar() {} });
        ctx.reflect.provide("fileUpload", { upload: async () => unsupported("fileUploads/upload") });
        const plugins = ["dsh-typert-registry", "dsh-api-gateway", "dsh-api-remotes", "dsh-api-remote-access", "dsh-api-session-controller", "dsh-api-workspace-controller"];
        for (const name of plugins) { const plugin = await load(name); aborted(lifetime.signal); ctx.plugin(plugin); }
        onState?.("正在初始化会话服务…");
        await waitFor(service(ctx, "sessions"), Boolean, lifetime.signal);
        onState?.("正在连接原生视图…");
        await waitFor(ctx.connection.generation, value => value !== undefined, lifetime.signal);
        await ctx.sessions.refresh();
        reference = ctx.sessions.retain(sessionId, { source: "projectConversation", signal: lifetime.signal });
        onState?.("正在恢复原生历史…");
        const binding = await reference.ready;
        const capture = () => {
          const pending = binding.session.getSnapshot().pendingSubmissions;
          const active = new Set(pending.map(item => item.requestId));
          for (const id of prepared.keys()) if (!active.has(id)) prepared.delete(id);
          for (const item of pending) {
            if (prepared.has(item.requestId)) continue;
            try { prepared.set(item.requestId, { request: bridge.prepare(item.text, item.requestId) }); }
            catch (error) { prepared.set(item.requestId, { error }); }
          }
        };
        offSubmissions = binding.session.subscribe(capture);
        for (const name of ["dsh-client-ui-renderer", "dsh-client-locale", "dsh-client-shortcuts", "dsh-client-ui-session", "dsh-client-ui-workspace", "dsh-client-ui-settings", "dsh-client-ui-conversation", "dsh-client-ui-chat", "dsh-client-ui-tool", "dsh-client-ui-sidebar-right", "dsh-client-resources", "dsh-client-ui-input-trigger", "dsh-client-ui-commands"])
          { const plugin = await load(name); aborted(lifetime.signal); ctx.plugin(plugin); }
        onState?.("正在初始化原生组件…");
        await waitFor(service(ctx, "slots"), Boolean, lifetime.signal);
        await waitFor(service(ctx, "conversation"), Boolean, lifetime.signal);
        ctx.slots.provideRoot({ hooks: { panelInfo } });
        function useBridge() { return React.useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot); }
        function Controls() { const state = useBridge(); return state.renderControls(); }
        function DisplayViews({ renderSlot }) {
          const seats = React.useSyncExternalStore(placement.subscribe, placement.getSnapshot, placement.getSnapshot);
          return seats.chat ? createPortal(renderSlot('conversation.session', { view: 'chat' }), seats.chat) : null;
        }
        const displayContentSlots = { views: DisplayViews };
        function DisplayConversation({ renderFactorySlot }) {
          return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: displayContentSlots });
        }
        function AssistantActions({ messageId }) { const state = useBridge(), message = state.messages.find(message => message.id === messageId); return message ? state.renderActions(message, false) : null; }
        function UserMessage({ node, renderFactorySlot, loadImage }) {
          const state = useBridge(), turn = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn.turn : null;
          const message = state.messages.find(message => message.seq === turn);
          if (!message) return null;
          return h('article', { className: 'steward-native-user', 'data-message-id': message.id, 'data-role': 'user', 'data-scope': state.scopeKey(message.scope) },
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', width: '100%' } }, renderFactorySlot('conversation.chat.user.content', { content: { text: message.text, attachments: [], extraBlocks: [] }, facts: {}, loadImage })),
            h('div', { className: 'steward-icon-row' }, state.renderActions(message, true)));
        }
        ctx.slots.register({ name: "root", children: { main: { kind: "keyed", scope: "root" }, "shell.overlay": { kind: "list", scope: "root" }, "steward.native.conversation": { kind: "single", scope: "session" } } },
          function Root({ SessionProvider, renderSlot }) {
            const seats = React.useSyncExternalStore(placement.subscribe, placement.getSnapshot, placement.getSnapshot);
            return h(SessionProvider, { session: reference }, seats.composer && createPortal(renderSlot('steward.native.conversation', {}), seats.composer), renderSlot('shell.overlay', {}));
          });
        ctx.slots.inject('steward.native.conversation', () => ctx.slots.register({ name: 'steward.native.conversation' }, DisplayConversation));
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'steward-context' }, Controls));
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'user', priority: -100 }, UserMessage));
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'steward-message-actions' }, AssistantActions));
        ctx.inject(['commandUi'], scope => scope.effect(() => {
          const send = scope.commandUi.register({ name: 'steward_topic', label: () => '选择本条话题', available: () => true, ui: { kind: 'popupSelect', options: async () => bridge.getSnapshot().topicOptions, onSelect: option => bridge.getSnapshot().chooseTopic(option.id) } });
          const browse = scope.commandUi.register({ name: 'steward_browse', label: () => '浏览话题', available: () => true, ui: { kind: 'popupSelect', options: async () => bridge.getSnapshot().browseOptions, onSelect: option => { const previous = JSON.stringify(bridge.getSnapshot().sourceScope); bridge.getSnapshot().chooseBrowse(option.id); setTimeout(() => { if (!lifetime.signal.aborted && previous === JSON.stringify(bridge.getSnapshot().sourceScope) && browseHadComposerFocus) { browseHadComposerFocus = false; input.focus(); } }, 0); } } });
          return () => { browse(); send(); };
        }, 'steward topic commands'));
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'steward-send-topic' }, function SendTopic() { const state = useBridge(); return state.renderSendTopic(); }));
        const input = ctx.conversation.input.for(ctx.sessions.scope(sessionId));
        offInput = input.state.subscribe(() => bridge.onDraft(input.state.getSnapshot().draft));
        function HiddenDisplayMetric() { return null; }
        ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({ name: "conversation.chat.node", key: "turn-process", priority: -100 }, HiddenDisplayMetric));
        ctx.slots.inject("conversation.composer.dock", function* () {
          for (const id of ["activity", "usage"]) yield ctx.slots.register({ name: "conversation.composer.dock", id, priority: -100 }, HiddenDisplayMetric);
        });
        aborted(lifetime.signal);
        unmount = ctx.uiRenderer.mount(container);
        onState?.("");
        return { dispose, rememberSourceFocus() { sourceHadComposerFocus = !!placement.getSnapshot().composer?.contains(document.activeElement); }, rememberBrowseFocus() { browseHadComposerFocus = !!placement.getSnapshot().composer?.contains(document.activeElement); }, restoreBrowseFocus() { if (browseHadComposerFocus || sourceHadComposerFocus) { browseHadComposerFocus = false; sourceHadComposerFocus = false; input.focus(); } }, openTopics(kind) { const scope = ctx.sessions.scope(sessionId); return ctx.inputTriggers.sessionOf(scope).adjudicate(kind === 'browse' ? '/steward_browse' : '/steward_topic', lifetime.signal, { attachments: 0 }).catch(error => bridge.notice(error.message ?? String(error))); }, getDraft: () => input.state.getSnapshot().draft, setDraft(text) { const scope = ctx.sessions.scope(sessionId); ctx.conversation.input.for(scope).setDraft(text); ctx.conversation.input.for(scope).focus(); } };
      } catch (error) { await dispose(); throw error; }
    },
  };
  return api;
}
