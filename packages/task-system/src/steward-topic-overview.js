function createTopicOverview(React) {
  const h = React.createElement;
  const scopeKey = scope => scope?.kind === "project" ? `project:${scope.projectId}` : scope?.kind ?? "";
  const topicKey = topic => JSON.stringify([topic.conversationId, scopeKey(topic.scope)]);
  const sourceKey = ref => JSON.stringify(ref);
  const freshness = { current: "已覆盖最新消息", stale: "有待更新", insufficient: "信息不足" };
  const origins = { authoritative: "明确记录", extractive: "原文摘录", generated: "模型整理" };
  const sections = { goal: "目标", decision: "决定", constraint: "约束", question: "待解问题" };
  const failureText = failure => String(failure?.details?.detail ?? failure?.message ?? "读取失败，请稍后重试。").slice(0, 500);
  const sourceLabel = ref => ref.kind === "message" ? `消息 #${ref.seq} · 版本 ${ref.revision}` : `项目目标 · 版本 ${ref.revision}`;
  const styles = `
    .steward-topic-overview{box-sizing:border-box;max-height:65vh;overflow:auto;padding:14px;margin:8px 0;border:1px solid var(--dsw-alias-border-l2,#555);border-radius:12px;color:var(--dsw-alias-label-primary,#ddd);background:var(--dsw-alias-bg-base,#25272b);font:13px/1.5 system-ui}
    .steward-topic-overview *{box-sizing:border-box}.steward-topic-overview .sto-toolbar,.steward-topic-overview .sto-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.steward-topic-overview .sto-toolbar{justify-content:space-between}.steward-topic-overview h2{font-size:16px;margin:0}.steward-topic-overview h3{font-size:13px;margin:14px 0 6px}.steward-topic-overview p{margin:6px 0}.steward-topic-overview .sto-muted{color:var(--dsw-alias-label-secondary,#aaa)}
    .steward-topic-overview button,.steward-topic-overview input{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#25272b);border:1px solid var(--dsw-alias-border-l2,#555);border-radius:7px;padding:5px 9px}.steward-topic-overview button{cursor:pointer}.steward-topic-overview button:disabled{cursor:default;opacity:.5}.steward-topic-overview button:focus-visible,.steward-topic-overview input:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#75b9d3);outline-offset:2px}.steward-topic-overview .sto-search{display:block;width:100%;margin:12px 0}.steward-topic-overview .sto-search input{display:block;width:100%;margin-top:4px}
    .steward-topic-overview .sto-card{border:1px solid var(--dsw-alias-border-l2,#555);border-radius:9px;margin:7px 0;overflow:hidden}.steward-topic-overview .sto-card[aria-current=true]{border-color:var(--dsw-alias-accent-primary,#75b9d3)}.steward-topic-overview button.sto-card-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;text-align:left;width:100%;border:0;border-radius:0;padding:10px 12px}.steward-topic-overview .sto-title,.steward-topic-overview .sto-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.steward-topic-overview .sto-summary{grid-column:1/-1;color:var(--dsw-alias-label-secondary,#aaa)}.steward-topic-overview .sto-freshness{font-size:11px;font-weight:normal;align-self:center}.steward-topic-overview .sto-detail{padding:0 12px 12px;border-top:1px solid var(--dsw-alias-border-l2,#555);overflow-wrap:anywhere}.steward-topic-overview .sto-fact{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#555)}.steward-topic-overview .sto-fact:last-child{border-bottom:0}.steward-topic-overview .sto-fact-text{white-space:pre-wrap}.steward-topic-overview .sto-provenance{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa)}.steward-topic-overview .sto-sources{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}.steward-topic-overview .sto-sources button{font-size:11px;padding:3px 6px}.steward-topic-overview .sto-source{padding:10px;margin:10px 0;border:1px solid var(--dsw-alias-border-l2,#555);border-radius:8px}.steward-topic-overview pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:220px;overflow:auto}.steward-topic-overview .sto-error{color:var(--dsw-alias-label-primary,#ddd);border-left:3px solid #bd8e57;padding:5px 9px;margin:8px 0}.steward-topic-overview .sto-footer{justify-content:space-between;margin-top:10px}.steward-topic-overview .sto-apply{margin-top:14px}
    @media(max-width:540px){.steward-topic-overview{padding:10px;max-height:60vh}.steward-topic-overview button.sto-card-toggle{grid-template-columns:minmax(0,1fr)}.steward-topic-overview .sto-freshness{grid-row:3}.steward-topic-overview .sto-actions{gap:6px}}
  `;

  return function TopicOverview({ invoke, conversationId, initialScope, onApply, onClose }) {
    const [query, setQuery] = React.useState("");
    const [navigation, setNavigation] = React.useState({ cursor: undefined, previous: [] });
    const [refresh, setRefresh] = React.useState(0);
    const [list, setList] = React.useState({ items: [], hasMore: false, nextCursor: null, loading: true, error: "" });
    const [expanded, setExpanded] = React.useState(null);
    const [detail, setDetail] = React.useState({ card: null, loading: false, error: "" });
    const [source, setSource] = React.useState(null);
    const [applied, setApplied] = React.useState("");
    const alive = React.useRef(true), requests = React.useRef({ list: 0, detail: 0, source: 0 });
    const identity = React.useRef(conversationId), search = React.useRef(null);
    const instanceId = React.useId();
    identity.current = conversationId;

    const clearDetail = () => {
      requests.current.detail++; requests.current.source++;
      setExpanded(null); setDetail({ card: null, loading: false, error: "" }); setSource(null); setApplied("");
    };
    const close = () => { alive.current = false; requests.current.list++; clearDetail(); onClose(); };
    React.useEffect(() => {
      alive.current = true;
      const priorFocus = typeof document === "undefined" ? null : document.activeElement;
      search.current?.focus();
      return () => { alive.current = false; requests.current.list++; requests.current.detail++; requests.current.source++; if (priorFocus?.isConnected) priorFocus.focus?.(); };
    }, []);
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

    async function loadDetail(item) {
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
          topic: card.topic, version: card.version, title: card.title, summary: card.summary, freshness: card.freshness, coverageReason: card.coverageReason,
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
    const refs = (sources, prefix) => h("div", { className: "sto-sources" }, ...sources.map((ref, index) => h("button", {
      key: `${prefix}:${sourceKey(ref)}`, type: "button", onClick: () => void loadSource(ref),
      "aria-label": `查看${sourceLabel(ref)}原文`, "aria-pressed": source ? sourceKey(source.ref) === sourceKey(ref) : false,
    }, `来源 ${index + 1} · ${sourceLabel(ref)}`)));
    const renderDetail = item => {
      const card = detail.card;
      return h("div", { className: "sto-detail", id: `${instanceId}-detail`, "aria-label": `${item.title}详情` },
        detail.loading && h("p", { role: "status" }, "正在读取话题详情…"),
        detail.error && h("div", { className: "sto-error", role: "alert" }, h("p", null, detail.error), h("button", { type: "button", onClick: () => void loadDetail(item) }, "重试读取详情")),
        card && h(React.Fragment, null,
          h("p", { className: "sto-muted" }, `${freshness[card.freshness]} · 已覆盖至 #${card.coverageSeq} / 已观察至 #${card.observedThroughSeq}`),
          card.coverageReason && h("p", { className: "sto-muted" }, card.coverageReason),
          h("div", {className:"sto-actions"}, h("button", { type: "button", onClick: () => void loadDetail(item) }, "刷新话题详情"), h("button", { type: "button", onClick: () => { onApply(card.topic.scope); setApplied(topicKey(card.topic)); } }, "应用到管家"), h("span", {className:"sto-muted"}, "用于下一条消息")),
          ...Object.entries(sections).map(([section, title]) => {
            const facts = card.facts.filter(fact => fact.section === section);
            return h("section", { key: section, "aria-label": title }, h("h3", null, title), facts.length ? facts.map(fact => h("div", { className: "sto-fact", key: fact.id },
              h("div", { className: "sto-provenance" }, `${origins[fact.origin]}${fact.state === "superseded" ? " · 已被替代" : ""}${fact.supersededBy ? ` · 后续记录 ${fact.supersededBy}` : ""}`),
              h("p", { className: "sto-fact-text" }, fact.text), refs(fact.sources, fact.id))) : h("p", { className: "sto-muted" }, "暂无有来源支持的记录"));
          }),
          card.sources.length > 0 && h("section", { "aria-label": "话题来源" }, h("h3", null, "话题来源"), refs(card.sources, "card")),
          source && h("section", { className: "sto-source", "aria-label": "来源原文" },
            h("div", { className: "sto-actions" }, h("strong", null, sourceLabel(source.ref)), h("button", { type: "button", onClick: () => { requests.current.source++; setSource(null); } }, "收起原文")),
            source.loading && h("p", { role: "status" }, "正在读取该版本原文…"),
            source.error && h("div", { className: "sto-error", role: "alert" }, h("p", null, `未能读取所引用版本的原文：${source.error}`), h("p", null, "可刷新话题详情，再明确选择来源查看当前版本。"), h("button", { type: "button", onClick: () => void loadDetail(item) }, "刷新话题并重新选择来源")),
            source.page && h(React.Fragment, null,
              h("pre", null, source.page.content),
              h("p", { className: "sto-muted" }, `UTF-8 字节位置 ${source.page.offset} / 共 ${source.page.totalBytes} 字节 · 每页最多 ${source.page.byteLimit} 字节`),
              h("div", { className: "sto-actions" },
                h("button", { type: "button", disabled: !source.previous.length, onClick: () => void loadSource(source.ref, source.previous.at(-1), source.previous.slice(0, -1)) }, "上一页原文"),
                h("button", { type: "button", disabled: source.page.nextOffset === null, onClick: () => void loadSource(source.ref, source.page.nextOffset, [...source.previous, source.page.offset]) }, "下一页原文")))),
          applied === topicKey(card.topic) && h("p", { role: "status" }, "已应用到下一条消息。")));
    };

    return h("section", { className: "steward-topic-overview", "aria-label": "话题总览", onKeyDown: event => { if (event.key === "Escape") { event.stopPropagation(); close(); } } },
      h("style", null, styles),
      h("div", { className: "sto-toolbar" }, h("h2", null, "话题总览"), h("button", { type: "button", onClick: close, "aria-label": "关闭话题总览" }, "关闭")),
      h("label", { className: "sto-search" }, "搜索话题", h("input", { ref: search, type: "search", value: query, maxLength: 200, placeholder: "名称或关键词", onChange: event => {
        requests.current.list++; clearDetail(); setQuery(event.target.value); setNavigation({ cursor: undefined, previous: [] });
        setList({ items: [], hasMore: false, nextCursor: null, loading: true, error: "" });
      } })),
      list.loading && h("p", { role: "status" }, "正在读取话题…"),
      list.error && h("div", { className: "sto-error", role: "alert" }, h("p", null, list.error), h("button", { type: "button", onClick: () => setRefresh(value => value + 1) }, "重试读取话题")),
      !list.loading && !list.error && !list.items.length && h("p", { className: "sto-muted" }, query.trim() ? "没有匹配的话题，请换一个关键词。" : "暂无可浏览的话题。"),
      ...list.items.map(item => {
        const key = topicKey(item.topic), open = expanded === key;
        return h("article", { className: "sto-card", key, "aria-current": scopeKey(item.topic.scope) === scopeKey(initialScope) ? "true" : undefined },
          h("button", { type: "button", className: "sto-card-toggle", "aria-expanded": open, ...(open ? { "aria-controls": `${instanceId}-detail` } : {}), onClick: () => { if (open) clearDetail(); else void loadDetail(item); } },
            h("strong", { className: "sto-title", title: item.title }, `${open ? "▾" : "▸"} ${item.title}`), h("span", { className: "sto-freshness" }, freshness[item.freshness]), h("span", { className: "sto-summary", title: item.summary }, item.summary || "暂无摘要")),
          open && renderDetail(item));
      }),
      h("div", { className: "sto-actions sto-footer" }, h("span", { className: "sto-muted" }, `第 ${navigation.previous.length + 1} 页`), h("div", { className: "sto-actions" },
        h("button", { type: "button", disabled: list.loading || !navigation.previous.length, onClick: () => changePage(navigation.previous.at(-1), navigation.previous.slice(0, -1)) }, "上一页话题"),
        h("button", { type: "button", disabled: list.loading || !list.hasMore || !list.nextCursor, onClick: () => changePage(list.nextCursor, [...navigation.previous, navigation.cursor]) }, "下一页话题"))));
  };
}
