function createStewardDisplayJournal() {
  const groups = groupStewardNotifications;
  const progressSizes = new Map();
  const rows = new Map(), pendingPhases = new Map(), listeners = new Set();
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
      content: message.content ?? [{ type: "text", text: message.text }],
    }, "append"));
    else result.push(event("assistant/message", { turn, step: 0, message: {
      id: message.id, role: "assistant", source: { kind: "model", provider: "steward-display", model: "canonical-history" },
      content: [{ type: "text", text: message.text }],
    }, stream: [] }, "append"));
    result.push(event("step/end", { turn, step: 0 }), event("turn/end", { turn, reason: { kind: "completed" } }));
    return result;
  }
  return {
    syncPending(pending, nativePending, messages) {
      const active = new Set(pending.map(item => item.request.commandId)), native = new Set(nativePending.map(item => item.requestId));
      for (const id of new Set([...pendingPhases.keys(), ...active, ...native])) {
        const phase = active.has(id) ? messages.some(message => message.role === 'user' && message.commandId === id) ? 'canonical' : 'pending' : native.has(id) ? 'hidden' : 'done';
        if (pendingPhases.get(id) === phase) continue;
        if (phase === 'done') pendingPhases.delete(id); else pendingPhases.set(id, phase);
        const record = { type: 'event', event: { type: 'plugin:steward/routing', seq: nextSeq++, time: Date.now(), ignorable: true, data: { requestId: id, phase } } };
        records.push(record); for (const listener of listeners) listener([record]);
      }
    },
    appendPermission(preset) { const record = { type: "event", event: { type: "permission/preset", seq: nextSeq++, time: Date.now(), data: { preset } } }; records.push(record); for (const listener of listeners) listener([record]); },
    appendModel(selection) { const record = { type: "event", event: { type: "model/selection", seq: nextSeq++, time: Date.now(), data: selection } }; records.push(record); for (const listener of listeners) listener([record]); },
    sync(messages, notify = true) {
      messages = [...messages].sort((a, b) => a.seq - b.seq).slice(-300);
      const appended = [];
      for (let group of groups(messages)) {
        if(group.kind==='message'&&group.message.role==='notification'&&group.message.provenance)group={kind:'progress',id:group.message.id,messages:[group.message]};
        if (group.kind === 'progress') {
          if (progressSizes.get(group.id) === group.messages.length) continue;
          progressSizes.set(group.id, group.messages.length);
          for (const message of group.messages) rows.set(message.id, message);
          appended.push({type:'event',event:{type:'plugin:steward/progress',seq:nextSeq++,time:Date.parse(group.messages.at(-1).createdAt),ignorable:true,data:{id:group.id,messageIds:group.messages.map(message=>message.id)}}});
        } else if (!rows.has(group.message.id)) {
          const encoded=encode(group.message,nextSeq);nextSeq+=encoded.length;
          rows.set(group.message.id,group.message);appended.push(...encoded);
        }
      }
      records.push(...appended);
      if (notify && appended.length) for (const listener of listeners) listener(appended);
    },
    replace(messages) {
      rows.clear(); pendingPhases.clear(); progressSizes.clear(); records.length = 0;
      this.sync(messages,false);
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
    let snapshot = { chat: null, composer: null, header: null, sidebar:null, sidebarShown:false, sidebarFullscreen:false, view: 'chat' };
    const listeners = new Set();
    const set = (key, value) => { if (snapshot[key] === value) return; snapshot = { ...snapshot, [key]: value }; for (const listener of listeners) listener(); };
    return { getSnapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, chat: node => set('chat', node), composer: node => set('composer', node), header: node => set('header',node), sidebar:node=>set('sidebar',node), rightbar:(shown,fullscreen=false)=>{set('sidebarShown',shown);set('sidebarFullscreen',fullscreen);}, select: view => set('view', view) };
  }
  function SourceViews({ renderSlot }) {
    const { placement, selected, overviewOpen } = React.useContext(ShellState);
    return h('div', { inert:overviewOpen?'':undefined, style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
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
    return h(ShellState.Provider, { value: { placement, selected, overviewOpen:source.overviewOpen } },
      h('div', { className: 'steward-native-heading', 'data-steward-browse-session': sessionId },
        h('div', { ref:placement.header, className: 'steward-native-title-row' }, h('strong', { title: sessionId }, nativeTitle || `管家 · ${source.sourceScopeLabel}`), typeof nativePreset === 'string' && h('span', { title: `原生 Agent 预设 ${nativePreset}` }, nativePreset), source.renderBrowseTopic(), h('button',{type:'button',className:'steward-icon-button','aria-label':'打开原生文件侧栏',title:'打开原生文件侧栏',onClick:()=>{void bridge.preview?.openGuide().catch(error=>{if(error.name!=='AbortError')bridge.notice(error.message);});}},h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},h('path',{d:'M3 4h18v16H3z M15 4v16'})))),
        h('div', { inert:source.overviewOpen?'':undefined, role: 'tablist', 'data-conversation-tabs': '' }, tabs.map(tab => h('button', { key: tab.id, type: 'button', role: 'tab', 'aria-selected': selected === tab.id, onClick: () => { hostContext.get('uiConversation').binding(sessionId).activate(tab.id); placement.select(tab.id); } }, tab.label)))),
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
    const mount = React.useRef(null), sidebarMount=React.useRef(null), eventRoot = React.useRef(null), references = React.useRef(new Map()), placement = React.useMemo(createPlacement, []);
    const [source, setSource] = React.useState(null), [sourceRefresh, setSourceRefresh] = React.useState(0), [sourceError, setSourceError] = React.useState(''), [displayStatus, setDisplayStatus] = React.useState('正在加载原生输入框…');
    const view = React.useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
    const seats=React.useSyncExternalStore(placement.subscribe,placement.getSnapshot,placement.getSnapshot);
    const [overviewTop,setOverviewTop]=React.useState(56);
    React.useLayoutEffect(()=>{
      const header=seats.header,root=eventRoot.current;if(!header||!root)return;
      const update=()=>setOverviewTop(Math.max(0,header.getBoundingClientRect().bottom-root.getBoundingClientRect().top));update();
      const observer=new ResizeObserver(update);observer.observe(header);observer.observe(root);return()=>observer.disconnect();
    },[seats.header,view.overviewOpen]);
    React.useLayoutEffect(()=>{const binding=source?.binding??null;bridge.previewSource=binding;queueMicrotask(()=>{if(bridge.previewSource===binding)void bridge.preview?.setSource(binding);});return()=>{delete bridge.previewSource;};},[source,bridge]);
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
      api.mount(mount.current, bridge, { signal: lifetime.signal, eventRoot: eventRoot.current, sidebarContainer:sidebarMount.current, placement, onState: message => { setDisplayStatus(message); bridge.getSnapshot().setStatus(message); } })
        .then(value => { if (lifetime.signal.aborted) void value.dispose(); else { mounted = value; handle.current = value; } })
        .catch(error => { if (!lifetime.signal.aborted) { setDisplayStatus(error.message ?? String(error)); bridge.notice(error.message ?? String(error)); } });
      return () => { lifetime.abort(); handle.current = null; if (mounted) void mounted.dispose(); };
    }, [view.authorityId, view.conversationId]);
    React.useEffect(() => { if (source || sourceError) handle.current?.restoreBrowseFocus(); }, [source, sourceError]);
    return h('div', { ref: eventRoot, className: 'steward-full-session', 'data-steward-native-host': '', style: { position:'relative', display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0 } },
      h('div',{style:{display:'flex',flexDirection:'column',flex:1,minWidth:0,minHeight:0}},
      h('div', { ref: mount, style: { display: 'none' } }),h('div',{ref:sidebarMount,style:{display:'none'}}), displayStatus && h('p', { role: 'status' }, displayStatus),
      source ? h(SessionProvider, { key: source.binding.sessionId, session: source.reference }, renderSlot('steward.session.shell', { bridge, placement })) :
        h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          h('div', { className: 'steward-native-heading' }, h('div', { ref:placement.header, className: 'steward-native-title-row' }, h('strong', null, '管家'), view.renderBrowseTopic())),
          h('p', { role: sourceError ? 'alert' : 'status' }, sourceError || '正在读取当前话题的原会话…'),
          sourceError && h('button', { type: 'button', onClick: () => setSourceRefresh(value => value + 1) }, '重新读取原会话'),
          h('div', { ref: placement.chat, style: { flex: 1, minHeight: 0 } })),
      h('div', { ref: placement.composer, inert:view.overviewOpen?'':undefined, 'data-steward-router-composer': '' }),
      view.overviewOpen && h('div',{'data-steward-overview-layer':'',style:{position:'absolute',top:overviewTop,left:0,right:0,bottom:0,zIndex:30,display:'flex',minHeight:0,background:'var(--dsw-alias-bg-base,#171719)'}},view.renderOverview())),
      h('div',{ref:placement.sidebar,'data-steward-native-rightbar':'',style:{position:seats.sidebarFullscreen?'absolute':'relative',inset:seats.sidebarFullscreen?0:undefined,width:seats.sidebarShown?(seats.sidebarFullscreen?'100%':'min(45%, 720px)'):0,minWidth:0,height:'100%',zIndex:seats.sidebarFullscreen?40:undefined}}));
  }

  const api = {
    SessionShell,
    async mount(container, bridge, { signal, onState, eventRoot = container, sidebarContainer, placement } = {}) {
      const ctx = new Context(), lifetime = new AbortController(), journal = createStewardDisplayJournal();
      const cancel = () => lifetime.abort(signal.reason);
      if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
      const snapshot = bridge.getSnapshot(), identity = `${snapshot.authorityId}:${snapshot.conversationId}`;
      const sessionId = `steward-display:${identity}`, createdAt = Date.now();
      let reference, unmount, offBridge, offSubmissions, offInput,sidebarReference,sidebarRevision=0,sidebarJob=null;
      const sidebarBindings=new Map();
      let sidebarCtx,sidebarUnmount,sidebarSetup,sidebarReady=false,sidebarCommitted=null;
      const sidebarCommitListeners=new Set();
      let pendingReady = false, nativePending = [];
      const prepared = new Map(), controls = new Set(),fileCapabilities=new Map();
      const followTarget = { provider: 'steward-target', model: 'follow' };
      const modelKey = `dsh-steward-model:${identity}`;
      let selectedModel = followTarget;
      try { const stored = JSON.parse(localStorage.getItem(modelKey) ?? 'null'); if (stored && typeof stored.provider === 'string' && typeof stored.model === 'string') selectedModel = stored; } catch {}
      const setModel = selection => { localStorage.setItem(modelKey, JSON.stringify(selection)); selectedModel = selection; journal.appendModel(selection); for (const listener of controls) listener(); };
      const followPermission = 'steward-follow-target';
      let selectedPermission = followPermission;
      const setPermission = preset => { selectedPermission = preset; journal.appendPermission(preset); for (const listener of controls) listener(); };
      const capturedInvoke = snapshot.invoke;
      const assertAuthority = () => { aborted(lifetime.signal); if (`${bridge.getSnapshot().authorityId}:${bridge.getSnapshot().conversationId}` !== identity) throw new Error('管家权限来源已变化；原请求保留在原来源，未继续发送。'); };
      const invoke = async (method, input) => { assertAuthority(); const value = await capturedInvoke(method, input); assertAuthority(); return value; };
      async function stageBytes(bytes, name, mediaType, signal, progress, onStart) {
        if (bytes.length > 8388608) throw new Error('附件不能超过 8 MiB。');
        let uploadId;
        try {
          const start = await invoke('stewardUpload', { kind: 'start', conversationId: snapshot.conversationId, commandId: crypto.randomUUID?.() ?? `upload-${Date.now()}-${Math.random()}`, bytes: bytes.length, name: name || 'attachment', ...(mediaType ? { mediaType } : {}) });
          uploadId = start.uploadId; onStart?.(uploadId);
          if (!start.completed) for (let offset = 0, index = 0; offset < bytes.length; offset += 24576, index++) {
            aborted(signal ?? lifetime.signal);
            const chunk = bytes.subarray(offset, offset + 24576);
            const receipt = await invoke('stewardUpload', { kind: 'part', conversationId: snapshot.conversationId, uploadId, index, data: btoa(String.fromCharCode(...chunk)) });
            if (receipt.nextIndex !== index + 1) throw new Error('附件上传进度无效。');
            progress?.({loaded: offset + chunk.length, total: bytes.length});
          }
          return await invoke('stewardUpload', { kind: 'finish', conversationId: snapshot.conversationId, uploadId });
        } catch (error) { if (uploadId) void invoke('stewardUpload', { kind: 'abort', conversationId: snapshot.conversationId, uploadId }).catch(() => {}); throw error; }
      }
      async function readChunks(method, input) {
        let offset = 0, metadata; const chunks = [];
        while (true) {
          const leaf = await invoke(method, { conversationId: snapshot.conversationId, ...input, offset });
          if (leaf.offset !== offset || leaf.totalBytes > 8388608 || typeof leaf.data !== 'string') throw new Error('附件读取进度无效。');
          metadata = leaf.content;
          const decoded = atob(leaf.data); chunks.push(decoded); offset += decoded.length;
          if (leaf.eof) { if (offset !== leaf.totalBytes) throw new Error('附件内容不完整。'); break; }
          if (!decoded.length) throw new Error('附件读取未推进。');
        }
        return { content: metadata, data: btoa(chunks.join('')) };
      }
      let browseHadComposerFocus = false, sourceHadComposerFocus = false;
      let DisplayCarrierError;
      const projections = () => ({ asOfSeq: journal.cursor, values: { inbox: emptyInbox, permissions: {currentValue:selectedPermission}, modelSelection: { lastUsed: null, next: selectedModel }, ...(snapshot.media?.imageLimits ? { imageLimits: snapshot.media.imageLimits } : {}) } });
      const summary = () => ({ sessionId, updatedAt: Date.now(), agentAvailable: false, running: false, blank: journal.records.length === 0 });
      const sync = () => {
        if (`${bridge.getSnapshot().authorityId}:${bridge.getSnapshot().conversationId}` !== identity) return;
        const messages = bridge.getSnapshot().messages.slice(-300), ids = journal.ids;
        const previous = new Set(ids), next = new Set(messages.map(message => message.id));
        const newBeforeTail = messages.some(message => !previous.has(message.id) && message.seq < Math.max(0, ...bridge.getSnapshot().messages.filter(message => previous.has(message.id)).map(message => message.seq)));
        if (ids.length && (ids.some(id => !next.has(id)) || newBeforeTail)) {
          journal.replace(messages);
        } else journal.sync(messages);
        if (pendingReady) journal.syncPending(bridge.getSnapshot().pending ?? [], nativePending, messages);
      };
      sync(); offBridge = bridge.subscribe(sync);
      const rpc = {
        async call(channel, endpoint, payload, signal) {
          if (channel !== "/api") return unsupported(endpoint);
          try {
            if (endpoint.startsWith("workspaceFiles/")) {
              const args = payload?.args ?? {},
                method = endpoint.slice("workspaceFiles/".length);
              if (!["read", "readBytes", "stat", "list"].includes(method)) return unsupported(endpoint);
              const layoutBinding = sidebarBindings.get(args.workspaceFileScopeId);
              const target = layoutBinding?.sessionId ?? args.workspaceFileScopeId,
                source = bridge.previewSource;
              const capability = fileCapabilities.get(`${target}:${args.path}`);
              const sourceKey = JSON.stringify(source);
              if (capability) {
                const current = await invoke("stewardDocument", capability);
                aborted(signal);
                aborted(lifetime.signal);
                if (current.kind !== "file" || current.sessionId !== target || current.path !== args.path)
                  throw new Error("文件来源已变化，请重新打开。");
              } else if (!source || target !== source.sessionId || !layoutBinding)
                throw new Error("这个文件不属于当前浏览话题或已核实的工作记录。");
              const remote = hostContext.remote.workspaceFiles;
              let result;
              if (method === "read") result = await remote.read(target, args.path, args.range ?? {}, signal);
              else if (method === "readBytes")
                result = await remote.readBytes(target, args.path, args.options ?? {}, signal);
              else if (method === "stat") result = await remote.stat(target, args.path, signal);
              else result = await remote.list(target, args.path, signal);
              aborted(signal);
              aborted(lifetime.signal);
              if (!capability && JSON.stringify(bridge.previewSource) !== sourceKey)
                throw new Error("浏览话题已经变化，请重新打开文件。");
              return result;
            }
            const request = payload?.args?.request;
            let value;
            switch (endpoint) {
              case "permissionPresets/catalog": { const catalog=await invoke('stewardPermissionCatalog',{});value={...catalog,options:[{value:followPermission,name:'本次权限：跟随目标',description:'仅下一条请求；分流后沿用实际目标会话的权限，不改变默认设置。'},...catalog.options.map(option=>({...option,description:`仅下一条请求；${option.description??option.name}`}))]};break; }
              case "commands/execute": { const args=payload?.args,match=typeof args?.line==='string'&&/^\/permission\s+([^\s]+)\s*$/.exec(args.line);if(args?.agentId!==sessionId||!match||args.submittedAttachments?.length)return unsupported(endpoint);if(match[1]!==followPermission)await invoke('stewardValidatePermission',{preset:match[1]});setPermission(match[1]);value={matched:true};break; }
              case "session/modelCatalog": { const catalog = await invoke('stewardModelCatalog', {}); value = { ...catalog, default: followTarget, routableProviders: ['steward-target', ...catalog.routableProviders], groups: [{ id: 'steward-target', name: '管家', models: [{ id: 'follow', name: '跟随目标会话', description: '消息分流后使用实际目标会话的模型' }] }, ...catalog.groups] }; break; }
              case "session/selectModel": { if (request?.sessionId !== sessionId) return unsupported(endpoint); const selection = request.provider === followTarget.provider && request.model === followTarget.model ? followTarget : await invoke('stewardValidateModel', { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) }); setModel(selection); value = { selected: selection }; break; }
              case "session/attachment": { const message = bridge.getSnapshot().messages.find(message => message.content?.some(part => part.type === 'image' && part.attachment.attachmentId === request?.attachmentId)); if (!message) throw new Error('附件不属于当前可读取消息。'); const read = await readChunks('stewardAttachmentRead', { messageId: message.id, attachmentId: request.attachmentId }); value = { attachment: read.content.attachment, data: read.data }; break; }
              case "commands/list": value = []; break;
              case "session/list": value = { items: [summary(),...Array.from(sidebarBindings,([id,binding])=>({sessionId:id,cwd:binding.cwd,updatedAt:Date.now(),agentAvailable:false,running:false,blank:false}))] }; break;
              case "session/projections": value = { kind: "sequenced", ...projections() }; break;
              case "session/page": {
                if(sidebarBindings.has(request?.address?.sessionId)){const binding=sidebarBindings.get(request.address.sessionId);return await hostContext.remote.session.page({...request,address:{...request.address,sessionId:binding.sessionId}},signal);}
                if(request?.address?.sessionId!==sessionId)throw new Error('这个会话不属于当前文件视图。');
                if (request?.address?.sessionId !== sessionId) return unsupported(endpoint);
                const before = request.beforeSeq ?? journal.cursor + 1;
                if (!journal.page(before).length && bridge.getSnapshot().hasOlder) await bridge.loadOlder();
                sync();
                const records = journal.page(before, request.maxMessages);
                value = { records, hasMore: !!bridge.getSnapshot().hasOlder || journal.records[0]?.event.seq < records[0]?.event.seq };
                break;
              }
              case "session/prompt": {
                if (request?.sessionId !== sessionId || request.mode !== "queue" || !Array.isArray(request.content) || !request.content.length || request.content.some(part => !['text', 'image', 'file'].includes(part.type))) throw new Error('不支持的原生消息内容。');
                const text = request.content.filter(part => part.type === 'text').map(part => part.text).join("\n");
                if (`${bridge.getSnapshot().authorityId}:${bridge.getSnapshot().conversationId}` !== identity) throw new Error("管家权限来源已变化；请核对原请求。");
                const captured = prepared.get(request.requestId);
                if (!captured) throw new Error("本条消息的目标快照缺失，请核对原请求后重试。");
                if (captured.error) throw captured.error;
                if (captured.request.text !== text.trim()) throw new Error("原生消息与已保存的原请求不一致。");
                const uploads = [];
                try {
                for (const part of request.content) {
                  if (part.type === 'file') { uploads.push(part.receiptId); captured.request = bridge.stage(captured.request, [...uploads]); }
                  else if (part.type === 'image') { const decoded = atob(part.data), bytes = Uint8Array.from(decoded, value => value.charCodeAt(0)); const staged = await stageBytes(bytes, part.name, part.mediaType, signal, undefined, uploadId => { captured.request = bridge.stage(captured.request, [...uploads, uploadId]); }); uploads.push(staged.receiptId); }
                }
                } catch (error) { if (`${bridge.getSnapshot().authorityId}:${bridge.getSnapshot().conversationId}` === identity) bridge.preparationFailed(captured.request, error); throw error; }
                aborted(signal); assertAuthority();
                const original = bridge.complete(captured.request, uploads);
                aborted(signal); assertAuthority();
                const trackedOriginal = bridge.submit(original);
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
          if(endpoint==='workspaceFiles/changes'){
            const args=payload?.args??{},source=bridge.previewSource,layoutBinding=sidebarBindings.get(args.workspaceFileScopeId),target=layoutBinding?.sessionId??args.workspaceFileScopeId;
            const capability=fileCapabilities.get(`${target}:${args.path}`),sourceKey=JSON.stringify(source);
            if(capability)await invoke('stewardDocument',capability);
            else if(!source||target!==source.sessionId||!layoutBinding)throw new Error('文件来源已经变化。');
            aborted(signal);aborted(lifetime.signal);
            for await(const frame of hostContext.remote.workspaceFiles.changes(target,args.path,signal)){
              if(!capability&&JSON.stringify(bridge.previewSource)!==sourceKey)return;
              yield frame;
            }
            return;
          }
          switch (endpoint) {
            case "$events": yield { type: "ready", clientId: sessionId, host: { home: "/steward-display" } }; break;
            case "remoteAccess/follow": yield { type: "baseline", owner: false, grants: [{ resource: { kind: "global" }, actions: ["session/list", "session/control", "session/modelCatalog", "permissionPresets/catalog", "session/follow", "session/page", "session/projections"] }, { resource: { kind: "session", id: sessionId }, actions: ["session/prompt", "session/follow", "session/page", "session/projections", "session/selectModel", "session/attachment", "commands/execute"] }] }; break;
            case "workspace/follow": yield { type: "baseline", value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }; break;
            case "session/control": {
              let wake, changed = false; const off = () => { changed = true; wake?.(); }; controls.add(off); const cancel = () => wake?.(); signal.addEventListener('abort', cancel);
              try { yield { type: 'baseline', value: { projections: { [sessionId]: projections() } } }; while (!signal.aborted) { await new Promise(resolve => { wake = resolve; if (changed || signal.aborted) resolve(); }); wake = undefined; if (changed && !signal.aborted) { changed = false; yield { type: 'projection', sessionId, key: 'modelSelection', value: { lastUsed: null, next: selectedModel }, seq: journal.cursor }; } } }
              finally { controls.delete(off); signal.removeEventListener('abort', cancel); } return;
            }
            case "session/follow": {
              const realId=payload?.args?.request?.address?.sessionId;
              if(sidebarBindings.has(realId)){
                const binding=sidebarBindings.get(realId);
                for await(const frame of hostContext.remote.session.follow({...payload.args.request,address:{...payload.args.request.address,sessionId:binding.sessionId}},signal)){
                  if(sidebarBindings.get(realId)!==binding)return;
                  yield frame.type==='snapshot'?{...frame,header:{...frame.header,id:realId}}:frame;
                }
                return;
              }
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
        lifetime.abort(); delete bridge.preview;placement.rightbar(false); offBridge?.(); offSubmissions?.(); offInput?.(); signal?.removeEventListener("abort", cancel);
        await Promise.resolve(); sidebarRevision++;sidebarReference?.release();sidebarUnmount?.();await sidebarCtx?.fiber.dispose();unmount?.();reference?.release();await ctx.fiber.dispose();
      };
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
        ctx.reflect.provide('fileUpload', { async upload(target, data, name, signal, progress) {
          try { if (target !== sessionId) throw new Error('附件目标已变化。'); const source = data instanceof Blob ? data.stream() : data instanceof Uint8Array ? new Blob([data]).stream() : new Response(data).body;
            if (!source) throw new Error('附件内容不可读。');
            const reader = source.getReader(), chunks = []; let bytes = 0;
            try { for (;;) { aborted(signal); const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 8388608) throw new Error('附件不能超过 8 MiB。'); chunks.push(part.value); } }
            finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            const staged = await stageBytes(new Uint8Array(await new Blob(chunks).arrayBuffer()), name, undefined, signal, progress); return { ok: true, value: { receiptId: staged.receiptId, file: staged.content.attachment } }; }
          catch (error) { return { ok: false, error: {code:'steward/upload',message:error.message??String(error)} }; }
        } });
        const plugins = ["dsh-typert-registry", "dsh-api-gateway", "dsh-api-remotes", "dsh-api-remote-access", "dsh-api-session-controller", "dsh-api-workspace-controller"];
        for (const name of plugins) { const plugin = await load(name); aborted(lifetime.signal); ctx.plugin(plugin); }
        onState?.("正在初始化会话服务…");
        await waitFor(service(ctx, "sessions"), Boolean, lifetime.signal);
        onState?.("正在连接原生视图…");
        await waitFor(ctx.connection.generation, value => value !== undefined, lifetime.signal);
        await ctx.sessions.refresh();
        reference = ctx.sessions.retain(sessionId, { source: "mainView", signal: lifetime.signal });
        onState?.("正在恢复原生历史…");
        const binding = await reference.ready;
        const capture = () => {
          const pending = binding.session.getSnapshot().pendingSubmissions; nativePending = pending;
          const active = new Set(pending.map(item => item.requestId));
          for (const id of prepared.keys()) if (!active.has(id)) prepared.delete(id);
          for (const item of pending) {
            if (prepared.has(item.requestId)) continue;
            try { prepared.set(item.requestId, { request: bridge.prepare(item.text, item.requestId, { attachmentCount: item.attachments?.length ?? 0, ...(selectedModel.provider !== followTarget.provider ? { selection: { ...selectedModel } } : {}), ...(selectedPermission!==followPermission?{permissionPreset:selectedPermission}:{}) }) }); if(selectedPermission!==followPermission)setPermission(followPermission); }
            catch (error) { prepared.set(item.requestId, { error }); }
          }
          if (pendingReady) sync();
        };
        offSubmissions = binding.session.subscribe(capture);
        for (const name of ["dsh-client-ui-renderer", "dsh-client-locale", "dsh-client-shortcuts", "dsh-client-ui-session", "dsh-client-ui-workspace", "dsh-client-ui-settings", "dsh-client-ui-conversation", "dsh-client-ui-chat", "dsh-client-ui-attachment", "dsh-client-ui-model-selection", "dsh-client-ui-tool", "dsh-client-ui-sidebar-right", "dsh-client-resources", "dsh-client-ui-input-trigger", "dsh-client-ui-commands", "dsh-client-ui-permission-presets"])
          { const plugin = await load(name); aborted(lifetime.signal); ctx.plugin(plugin); }
        onState?.("正在初始化原生组件…");
        await waitFor(service(ctx, "slots"), Boolean, lifetime.signal);
        await waitFor(service(ctx, "conversation"), Boolean, lifetime.signal);
        ctx.slots.provideRoot({ hooks: { panelInfo } });
        function useBridge() { return React.useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot); }
        function Controls() { const state = useBridge(); return state.renderControls(); }
        const { TextShimmer, IconThinkOutlineRegular } = await load('dsh-client-ui-primitives');
        aborted(lifetime.signal);
        // Display-only input identity suppresses the native echo without retiring its real submission.
        // A materialized Definition keeps its key: done becomes hidden; unresolved native echoes keep a visible empty tombstone.
        ctx.uiConversation.events.register({
          kind: 'steward-routing', target: 'chat',
          match: { 'plugin:steward/routing': event => ({ id: event.data.requestId, role: 'start', exclusive: true }) },
          start: (_context, match) => ({ ...match.event.data, anchorSeq: match.event.seq }),
          update: ({ state }, match) => ({ ...state, ...match.event.data, ...(state.phase !== match.event.data.phase ? { anchorSeq: match.event.seq } : {}) }),
          buildViewNode: ({ state, key, id }) => ({ key, kind: 'steward-routing', id, target: 'chat', anchorSeq: state.anchorSeq, location: { kind: 'session' }, visibility: state.phase === 'done' ? 'hidden' : 'visible', groupTree: 'input', data: { requestId: id, source: { kind: 'user', rpcId: id } } }),
        });
        function RoutingPending({ node, renderFactorySlot, loadImage }) {
          const state = useBridge(), item = state.pending?.find(item => item.request.commandId === node.data.requestId);
          if (!item) return null;
          const echo = nativePending.find(pending => pending.requestId === item.request.commandId);
          const attachments = (echo?.attachments ?? []).map(part => part.type === 'image' ? { type: 'image', image: { preview: { url: part.value.previewUrl, ...part.value } } } : { type: 'file', file: part.value });
          const canonical = state.messages.find(message => message.role === 'user' && message.commandId === item.request.commandId);
          const running = !canonical && ['preparing', 'sending', 'checking'].includes(item.status);
          const label = item.status === 'preparing' ? '正在保存附件…' : item.status === 'checking' ? '正在核实原请求…' : '正在发送或分流…';
          return h('div', { 'data-pending-command': item.request.commandId, 'data-pending-phase': item.status, 'data-display-only': true },
            !canonical && h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, renderFactorySlot('conversation.chat.user.content', { content: { text: item.request.text, attachments, extraBlocks: [] }, facts: {}, loadImage })),
            running ? h('div', { className: 'steward-routing-row', role: 'status', title: '尚未确认服务器登记；这是发送/分流状态，并非项目已开始执行。' }, h(IconThinkOutlineRegular, { width: 18, height: 18, 'aria-hidden': true }), h(TextShimmer, null, label)) :
              h('div', { className: 'steward-routing-recovery', role: 'status' }, h('p', null, canonical ? '服务器已登记原请求；原回执仍待核实，不会自动重发。' : item.reason), !echo && item.request.uploads?.length > 0 && h('small', null, `原请求保留 ${item.request.uploads.length} 个附件。`), state.renderPendingRecovery(item)));
        }
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'steward-routing' }, RoutingPending));
        const Progress=createStewardProgressRenderer(React);
        ctx.uiConversation.events.register({
          kind:'steward-progress',target:'chat',
          match:{'plugin:steward/progress':event=>({id:event.data.id,role:'start',exclusive:true})},
          start:(_context,match)=>({...match.event.data,anchorSeq:match.event.seq}),
          update:({state},match)=>({...state,...match.event.data}),
          buildViewNode:({state,key,id})=>({key,kind:'steward-progress',id,target:'chat',anchorSeq:state.anchorSeq,location:{kind:'session'},visibility:'visible',data:{messageIds:state.messageIds}}),
        });
        function ProgressNode({node}) {
          const state=useBridge(),ids=new Set(node.data.messageIds),messages=state.messages.filter(message=>ids.has(message.id));
          return h(Progress,{messages,renderActions:state.renderActions,renderDecision:state.renderDecision,onOpen:async(messageId,targetId)=>{
            const identity=`${state.authorityId}:${state.conversationId}`;
            try {
              const target=await state.invoke('stewardDocument',{conversationId:state.conversationId,messageId,targetId});
              const latest=bridge.getSnapshot();
              if(lifetime.signal.aborted||`${latest.authorityId}:${latest.conversationId}`!==identity)return;
              if(target.kind==='file'){fileCapabilities.set(`${target.sessionId}:${target.path}`,{conversationId:state.conversationId,messageId,targetId});await bridge.preview.open(target);}else latest.openProgressRecord(target);
            }catch(error){if(!lifetime.signal.aborted)bridge.notice(error.message??String(error));}
          }});
        }
        ctx.slots.inject('conversation.chat.node',()=>ctx.slots.register({name:'conversation.chat.node',key:'steward-progress'},ProgressNode));
        pendingReady = true; capture(); sync();
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
          return h('article', { className: 'steward-native-user', 'data-message-id': message.id, 'data-role': 'user', 'data-scope': state.scopeKey(message.scope), 'data-actions-reveal': state.messages.filter(item => item.role === 'user').at(-1)?.id === message.id ? 'always' : 'hover' },
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', width: '100%' } }, renderFactorySlot('conversation.chat.user.content', { content: { text: message.text, attachments: (message.content ?? []).filter(part => part.type !== 'text').map(part => part.type === 'image' ? { type: 'image', image: { attachment: part.attachment } } : { type: 'file', file: part.attachment }), extraBlocks: [] }, facts: {}, loadImage })),
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
        const ensureSidebar = () =>
          (sidebarSetup ??= (async () => {
            if (!sidebarContainer) throw new Error("当前宿主没有文件侧栏位置。");
            sidebarCtx = new Context();
            connectionModule.installConnection(sidebarCtx, {
              interactions: "answer",
              transport: { rpc },
              location: { hostname: "steward-display.invalid" },
            });
            sidebarCtx.reflect.provide("layout", {
              panelInfo,
              selectPanel() {},
              beginNavigation: () => lifetime.signal,
              toggleSidebar() {},
              openRightbar(_track, fullscreen) {
                placement.rightbar(true, fullscreen);
              },
              closeRightbar() {
                placement.rightbar(false);
              },
            });
            sidebarCtx.reflect.provide("configForms", hostContext.get("configForms"));
            sidebarCtx.reflect.provide("fileUpload", ctx.get("fileUpload"));
            const realResources = hostContext.get("resources");
            const resourceAddress = (address) => {
              const prefix = "dsh-resource://file/session/";
              if (!address.startsWith(prefix)) return address;
              const boundary = address.indexOf("/", prefix.length);
              if (boundary < 0) return address;
              const binding = sidebarBindings.get(
                decodeURIComponent(address.slice(prefix.length, boundary)),
              );
              return binding
                ? prefix + encodeURIComponent(binding.sessionId) + address.slice(boundary)
                : address;
            };
            sidebarCtx.reflect.provide("resources", {
              source: (address) => realResources.source(resourceAddress(address)),
              pin: (address, signal) => realResources.pin(resourceAddress(address), signal),
              register: (provider) => realResources.register(provider),
            });

            for (const name of plugins) {
              sidebarCtx.plugin(await load(name));
              aborted(lifetime.signal);
            }
            for (const name of [
              "dsh-client-ui-renderer",
              "dsh-client-locale",
              "dsh-client-shortcuts",
              "dsh-client-ui-session",
              "dsh-client-ui-sidebar-right",
              "dsh-client-ui-sidebar-documentpreview",
              "dsh-client-ui-sidebar-files",
            ]) {
              sidebarCtx.plugin(await load(name));
              aborted(lifetime.signal);
            }
            await waitFor(service(sidebarCtx, "sessions"), Boolean, lifetime.signal);
            await waitFor(
              sidebarCtx.connection.generation,
              (value) => value !== undefined,
              lifetime.signal,
            );
            await waitFor(service(sidebarCtx, "slots"), Boolean, lifetime.signal);
            await waitFor(service(sidebarCtx, "sidebarRight"), Boolean, lifetime.signal);
            sidebarCtx.slots.provideRoot({
              hooks: { panelInfo },
              keyedHooks: { resource: (address) => sidebarCtx.resources.source(address) },
            });
            sidebarCtx.slots.register(
              { name: "root", children: { rightbar: { kind: "single", scope: "root" } } },
              function SidebarRoot({ renderSlot }) {
                const seats = React.useSyncExternalStore(
                  placement.subscribe,
                  placement.getSnapshot,
                  placement.getSnapshot,
                );
                const current = React.useSyncExternalStore(
                  sidebarCtx.uiSession.adapter.current.subscribe,
                  sidebarCtx.uiSession.adapter.current.getSnapshot,
                  sidebarCtx.uiSession.adapter.current.getSnapshot,
                ).key;
                React.useEffect(() => {
                  sidebarCommitted = current;
                  for (const listener of sidebarCommitListeners) listener();
                  return () => {
                    if (sidebarCommitted === current) sidebarCommitted = null;
                  };
                }, [current]);
                const [width, setWidth] = React.useState(eventRoot?.clientWidth ?? 1200);
                React.useEffect(() => {
                  if (!eventRoot) return;
                  const observer = new ResizeObserver(() => setWidth(eventRoot.clientWidth));
                  observer.observe(eventRoot);
                  return () => observer.disconnect();
                }, []);
                return seats.sidebar
                  ? createPortal(
                      renderSlot("rightbar", {
                        width: Math.min(width * 0.45, 720),
                        viewportWidth: width,
                        canShow: true,
                      }),
                      seats.sidebar,
                    )
                  : null;
              },
            );
            sidebarUnmount = sidebarCtx.uiRenderer.mount(sidebarContainer);
            sidebarReady = true;
          })().catch(async (error) => {
            sidebarReady = false;
            sidebarUnmount?.();
            sidebarUnmount = null;
            await sidebarCtx?.fiber.dispose();
            sidebarCtx = null;
            sidebarSetup = null;
            if (lifetime.signal.aborted) throw lifetime.signal.reason;
            throw new Error("原生文件侧栏暂不可用，请稍后再试。");
          }));
        const switchSidebarSource = async (binding) => {
          const layoutId = binding
            ? `${sessionId}:rightbar:${binding.sessionId}:${binding.generation ?? 0}`
            : null;
          if (
            sidebarReference?.sessionId === layoutId &&
            JSON.stringify(sidebarBindings.get(layoutId)) === JSON.stringify(binding)
          )
            return;
          const revision = ++sidebarRevision,
            previous = sidebarReference;
          sidebarReference = null;
          if (previous && sidebarCtx) {
            try {
              for (const tab of sidebarCtx.sidebarRight.openTabs.getSnapshot())
                if (tab.sessionId === previous.sessionId)
                  sidebarCtx.sidebarRight.closeIn(previous.sessionId, tab.tabId);
            } finally {
              previous.release();
            }
          }
          sidebarBindings.clear();
          placement.rightbar(false);
          if (!binding) return;
          sidebarBindings.set(layoutId, binding);
          if (!sidebarReady) return;
          let retained;
          try {
            await sidebarCtx.sessions.refresh();
            aborted(lifetime.signal);
            if (revision !== sidebarRevision) return;
            retained = sidebarCtx.sessions.retain(layoutId, {
              source: "mainView",
              signal: lifetime.signal,
            });
            await retained.ready;
            aborted(lifetime.signal);
            if (revision !== sidebarRevision) {
              retained.release();
              return;
            }
            sidebarReference = retained;
            await waitFor(
              {
                getSnapshot: () => sidebarCommitted === layoutId,
                subscribe: (listener) => {
                  sidebarCommitListeners.add(listener);
                  return () => sidebarCommitListeners.delete(listener);
                },
              },
              Boolean,
              lifetime.signal,
            );
          } catch (error) {
            retained?.release();
            if (sidebarReference === retained) sidebarReference = null;
            if (!lifetime.signal.aborted && revision === sidebarRevision)
              bridge.notice("原生文件来源暂不可读取，请重新选择浏览话题。");
          }
        };
        bridge.preview = {
          setSource(binding) {
            const key = JSON.stringify(binding);
            if (sidebarJob?.key === key) return sidebarJob.promise;
            const job = {
              key,
              promise: switchSidebarSource(binding).catch((error) => {
                sidebarBindings.clear();
                placement.rightbar(false);
                if (!lifetime.signal.aborted) bridge.notice("文件侧栏暂时无法切换，请重新选择浏览话题。");
              }),
            };
            sidebarJob = job;
            void job.promise.finally(() => {
              if (sidebarJob === job) sidebarJob = null;
            });
            return job.promise;
          },
          async open(target) {
            await ensureSidebar();
            await bridge.preview.setSource(bridge.previewSource);
            aborted(lifetime.signal);
            if (!sidebarReference) throw new Error("文件栏还在读取当前话题，请稍后再试。");
            const path = target.path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
            sidebarCtx.sidebarRight.openResourceIn(
              sidebarReference.sessionId,
              `dsh-resource://file/session/${encodeURIComponent(target.sessionId)}/${path.split("/").map(encodeURIComponent).join("/")}`,
            );
          },
          async openGuide() {
            await ensureSidebar();
            await bridge.preview.setSource(bridge.previewSource);
            aborted(lifetime.signal);
            if (!sidebarReference) throw new Error("文件栏还在读取当前话题，请稍后再试。");
            sidebarCtx.sidebarRight.openTabIn(sidebarReference.sessionId, "guide");
          },
        };
        void bridge.preview.setSource(bridge.previewSource);
        aborted(lifetime.signal);
        unmount = ctx.uiRenderer.mount(container);
        onState?.("");
        return { dispose, async restoreRequest(request) { const before = input.state.getSnapshot(); if (before.draft.trim() || before.attachmentIds.length || before.phase !== 'plain') throw new Error('输入框已有文字或附件，请保留当前草稿后再恢复。'); const files = []; for (const uploadId of request.uploads ?? []) { const read = await readChunks('stewardUploadRead', { uploadId }), part = read.content, bytes = Uint8Array.from(atob(read.data), value => value.charCodeAt(0)); files.push(new File([bytes], part.attachment.name ?? 'attachment', {type: part.type === 'image' ? part.attachment.mediaType : 'application/octet-stream'})); } const current = input.state.getSnapshot(); if (current.draftRev !== before.draftRev || current.attachmentIds.length || current.phase !== 'plain') throw new Error('读取附件时草稿已变化，原请求仍保留。'); setModel(request.selection ?? followTarget); setPermission(request.permissionPreset ?? followPermission); const drafts = files.length ? ctx.conversation.createDrafts(sessionId, files) : []; input.setDraft(request.text); if (drafts.length && !input.addAttachments(drafts.map(draft => draft.id))) throw new Error('原生输入框无法恢复附件。'); input.focus(); }, rememberSourceFocus() { sourceHadComposerFocus = !!placement.getSnapshot().composer?.contains(document.activeElement); }, rememberBrowseFocus() { browseHadComposerFocus = !!placement.getSnapshot().composer?.contains(document.activeElement); }, restoreBrowseFocus() { if (browseHadComposerFocus || sourceHadComposerFocus) { browseHadComposerFocus = false; sourceHadComposerFocus = false; input.focus(); } }, openTopics(kind) { const scope = ctx.sessions.scope(sessionId); return ctx.inputTriggers.sessionOf(scope).adjudicate(kind === 'browse' ? '/steward_browse' : '/steward_topic', lifetime.signal, { attachments: 0 }).catch(error => bridge.notice(error.message ?? String(error))); }, focus: () => input.focus(), getDraft: () => input.state.getSnapshot().draft, hasAttachments: () => input.state.getSnapshot().attachmentIds.length > 0, setDraft(text) { const scope = ctx.sessions.scope(sessionId); ctx.conversation.input.for(scope).setDraft(text); ctx.conversation.input.for(scope).focus(); } };
      } catch (error) { await dispose(); throw error; }
    },
  };
  return api;
}
