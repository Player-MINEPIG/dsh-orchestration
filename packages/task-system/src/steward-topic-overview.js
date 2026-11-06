function createTopicOverview(React) {
  const h = React.createElement;
  const scopeKey = scope => scope?.kind === "project" ? `project:${scope.projectId}` : scope?.kind ?? "";
  const topicKey = topic => JSON.stringify([topic.conversationId, scopeKey(topic.scope)]);
  const sourceKey = ref => JSON.stringify(ref, function(_key,value){return value && !Array.isArray(value) && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])) : value;});
  const freshness = { current: "已覆盖最新消息", stale: "有待更新", insufficient: "信息不足" };
  const origins = { authoritative: "明确记录", extractive: "原文摘录", generated: "模型整理" };
  const sections = { goal: "目标", decision: "决定", constraint: "约束", question: "待解问题" };
  const failureText = failure => String(failure?.details?.detail ?? failure?.message ?? "读取失败，请稍后重试。").slice(0, 500);
  const sourceLabel = ref => ref.kind === "message" ? `对话记录 ${ref.seq}` : "项目目标";
  const triggerLabel = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(value)) : "尚未触发";
  const styles = `
    .steward-topic-overview{box-sizing:border-box;container-type:inline-size;container-name:topics;display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto;padding:24px;color:var(--dsw-alias-label-primary,#ddd);background:var(--dsw-alias-bg-base,#171719);font:14px/1.6 system-ui}
    .steward-topic-overview *{box-sizing:border-box}.steward-topic-overview .sto-toolbar,.sto-dialog .sto-actions,.sto-dialog .sto-dialog-heading,.steward-topic-overview .sto-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.steward-topic-overview .sto-toolbar,.sto-dialog .sto-dialog-heading{justify-content:space-between}.steward-topic-overview h2{font-size:20px;margin:0}.steward-topic-overview h3{font-size:14px;margin:20px 0 8px}.steward-topic-overview p{margin:8px 0}.steward-topic-overview .sto-muted{color:var(--dsw-alias-label-secondary,#aaa)}
    .steward-topic-overview button,.steward-topic-overview input{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#25272b);border:1px solid var(--dsw-alias-border-l2,#555);border-radius:8px;padding:7px 12px}.steward-topic-overview button{cursor:pointer}.steward-topic-overview button:disabled{cursor:default;opacity:.5}.steward-topic-overview button:focus-visible,.steward-topic-overview input:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#75b9d3);outline-offset:2px}.steward-topic-overview .sto-search{display:block;max-width:560px;width:100%;margin:18px 0 24px}.steward-topic-overview .sto-search input{display:block;width:100%;margin-top:4px}
    .steward-topic-overview .sto-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-content:start}.steward-topic-overview .sto-card{min-width:0;border:1px solid var(--dsw-alias-border-l2,#444);border-radius:14px;overflow:hidden}.steward-topic-overview .sto-card[aria-current=true]{border-color:var(--dsw-alias-accent-primary,#75b9d3)}.steward-topic-overview button.sto-card-toggle{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:12px;text-align:left;width:100%;min-height:228px;height:100%;border:0;padding:20px;background:color-mix(in srgb,var(--dsw-alias-bg-base,#171719) 96%,var(--dsw-alias-label-primary,#ddd) 4%)}.steward-topic-overview .sto-title{font-size:17px;font-weight:600;margin-top:18px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.steward-topic-overview .sto-summary{color:var(--dsw-alias-label-secondary,#aaa);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.steward-topic-overview .sto-trigger{position:absolute;right:14px;top:14px;max-width:90px;text-align:right;color:var(--dsw-alias-label-caption,#888);font-size:11px}.steward-topic-overview .sto-freshness{margin-top:auto;font-size:11px;color:var(--dsw-alias-label-caption,#888)}.steward-topic-overview .sto-footer{justify-content:space-between;margin-top:24px}
    .steward-topic-overview .sto-dialog{width:min(820px,calc(100vw - 40px));max-height:86dvh;overflow:auto;padding:24px;border:1px solid var(--dsw-alias-border-l2,#555);border-radius:16px;color:inherit;background:var(--dsw-alias-bg-base,#1b1b1e);box-shadow:0 24px 100px #0008}.sto-dialog::backdrop{background:#0008;backdrop-filter:blur(3px)}.sto-dialog .sto-dialog-heading h2{overflow-wrap:anywhere}.sto-dialog .sto-detail{padding-top:12px;overflow-wrap:anywhere}.sto-dialog .sto-detail-actions{position:sticky;top:-24px;z-index:1;padding:12px 0;background:var(--dsw-alias-bg-base,#1b1b1e)}.sto-dialog .sto-fact{padding:12px 0}.sto-dialog .sto-fact-text,.sto-dialog .sto-quoted-original{white-space:pre-wrap;overflow-wrap:anywhere}.sto-dialog .sto-provenance{font-size:11px;color:var(--dsw-alias-label-caption,#888)}.sto-dialog .sto-cites{display:inline-flex;gap:2px;flex-wrap:wrap;vertical-align:baseline}.sto-dialog .sto-cites button{font-size:12px;border:0;background:transparent;color:var(--dsw-alias-text-brand,#75a8ed);padding:0 3px}.sto-dialog .sto-directory{margin:20px 0}.sto-dialog .sto-directory summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#aaa)}.sto-dialog .sto-directory-item{display:flex;align-items:center;gap:8px;padding:6px 0}.sto-dialog .sto-source{padding:16px 0;margin:14px 0;border-top:1px solid var(--dsw-alias-border-l2,#444)}.sto-dialog blockquote{border-left:2px solid var(--dsw-alias-text-brand,#75a8ed);margin:12px 0;padding:2px 16px}.sto-dialog .sto-tech{font-size:11px;color:var(--dsw-alias-label-caption,#888);margin-top:16px}.sto-dialog .sto-tech pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}.steward-topic-overview .sto-error{border-left:3px solid #bd8e57;padding:5px 12px;margin:10px 0}
    @container topics (min-width:850px){.steward-topic-overview .sto-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@container topics (min-width:1180px){.steward-topic-overview .sto-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media(max-width:560px){.steward-topic-overview{padding:14px}.steward-topic-overview .sto-grid{gap:10px}.steward-topic-overview button.sto-card-toggle{padding:14px;min-height:220px}.steward-topic-overview .sto-title{font-size:15px;padding-right:0;margin-top:22px}.steward-topic-overview .sto-summary{font-size:12px}.steward-topic-overview .sto-dialog{width:calc(100vw - 20px);max-height:92dvh;padding:18px}.sto-dialog .sto-detail-actions{top:-18px}}
  `;

  return function TopicOverview({ invoke, conversationId, initialScope, onApply, onClose }) {
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
        return h("article",{className:"sto-card",key,"aria-current":scopeKey(item.topic.scope)===scopeKey(initialScope)?"true":undefined},h("button",{type:"button",className:"sto-card-toggle","aria-haspopup":"dialog","aria-expanded":expanded===key,onClick:event=>expanded===key?clearDetail():void loadDetail(item,event?.currentTarget)},h("span",{className:"sto-trigger",title:item.lastTriggeredAt?`上次请求：${item.lastTriggeredAt}；登记不表示任务开工。`:"尚无已登记用户请求"},h("time",{dateTime:item.lastTriggeredAt??undefined},triggerLabel(item.lastTriggeredAt))),h("strong",{className:"sto-title",title:item.title},item.title),h("span",{className:"sto-summary"},item.summary||"暂无摘要"),h("span",{className:"sto-freshness"},freshness[item.freshness])));
      })),
      expanded && h("dialog",{ref:dialog,className:"sto-dialog","aria-label":"话题详情",onCancel:event=>{event.preventDefault();clearDetail();},onKeyDown:event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();clearDetail();}}},h("div",{className:"sto-dialog-heading"},h("h2",null,detail.card?.title ?? list.items.find(item=>topicKey(item.topic)===expanded)?.title ?? "话题详情"),h("button",{type:"button","aria-label":"关闭话题详情",onClick:clearDetail},"关闭")),renderDetail(list.items.find(item=>topicKey(item.topic)===expanded)??{title:"话题",topic:{conversationId,scope:initialScope}})),
      h("div", { className: "sto-actions sto-footer" }, h("span", { className: "sto-muted" }, `第 ${navigation.previous.length + 1} 页`), h("div", { className: "sto-actions" },
        h("button", { type: "button", disabled: list.loading || !navigation.previous.length, onClick: () => changePage(navigation.previous.at(-1), navigation.previous.slice(0, -1)) }, "上一页话题"),
        h("button", { type: "button", disabled: list.loading || !list.hasMore || !list.nextCursor, onClick: () => changePage(list.nextCursor, [...navigation.previous, navigation.cursor]) }, "下一页话题"))));
  };
}
