import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const project = id => ({ kind: "project", projectId: id });
const ref = { kind: "project", id: "a", revision: "revision-7" };
const item = (id = "a") => ({ topic: { conversationId: "main", scope: project(id) }, title: `话题 ${id}`, summary: `简短摘要 ${id}`, version: "v1", freshness: "stale" });
const card = (id = "a") => ({ ...item(id), binding: null, coverageSeq: 4, observedThroughSeq: 6, coverageReason: "还有两条消息未覆盖", sources: [ref], facts: [
  { id: `goal-${id}`, section: "goal", text: `详细目标 ${id}`, origin: "authoritative", state: "active", sources: [ref] },
  { id: `decision-${id}`, section: "decision", text: `历史决定 ${id}`, origin: "extractive", state: "superseded", supersededBy: "new-decision", sources: [ref] },
] });
const page = (items = [item()], nextCursor = null) => ({ items, hasMore: nextCursor !== null, nextCursor });
const original = (offset = 0, nextOffset = null) => ({ ref, content: `原文内容 ${offset}`, offset, totalBytes: 4000, nextOffset, byteLimit: 2000, coordinate: "utf-8-bytes" });

function fixture(invoke) {
  const hooks = []; let cursor = 0, effects = [], tree;
  const changed = (prior, next) => !prior || prior.length !== next.length || next.some((value, index) => value !== prior[index]);
  const React = {
    Fragment: "Fragment",
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) { const slot = cursor++; hooks[slot] ??= { value: typeof initial === "function" ? initial() : initial }; return [hooks[slot].value, next => { hooks[slot].value = typeof next === "function" ? next(hooks[slot].value) : next; }]; },
    useRef(initial) { const slot = cursor++; return hooks[slot] ??= { current: initial }; },
    useId() { const slot = cursor++; return `id-${slot}`; },
    useEffect(fn, deps) { const slot = cursor++; if (changed(hooks[slot]?.deps, deps)) { const prior = hooks[slot]; hooks[slot] = { deps, cleanup: prior?.cleanup }; effects.push(() => { prior?.cleanup?.(); hooks[slot].cleanup = fn(); }); } },
  };
  const context = vm.createContext({});
  vm.runInContext(`${readFileSync(new URL("../src/steward-topic-overview.js", import.meta.url), "utf8")}\nglobalThis.create = createTopicOverview;`, context);
  const Component = context.create(React), applied = [], calls = [];
  const props = { invoke: (method, input) => { calls.push({ method, input }); return invoke(method, input); }, conversationId: "main", initialScope: project("a"), onApply: scope => applied.push(scope), onClose: () => { closed++; } };
  let closed = 0;
  const render = () => { cursor = 0; effects = []; tree = Component(props); const pending = effects; effects = []; pending.forEach(effect => effect()); return tree; };
  const all = (predicate, node = tree) => !node || typeof node !== "object" ? [] : [...(predicate(node) ? [node] : []), ...(node.children ?? []).filter(child=>child!==undefined).flatMap(child => all(predicate, child))];
  const text = (node = tree) => typeof node === "string" || typeof node === "number" ? String(node) : (node?.children ?? []).filter(child => child!==undefined && child?.type !== "style").map(child => text(child)).join(" ");
  const button = label => all(node => node.type === "button" && text(node) === label)[0];
  const toggle = id => all(node => node.type === "button" && node.props.className === "sto-card-toggle" && text(node).includes(`话题 ${id}`))[0];
  const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } };
  render();
  return { props, calls, applied, all, text, button, toggle, render, settle, closed: () => closed, unmount: () => hooks.forEach(hook => hook?.cleanup?.()) };
}
const plain = value => JSON.parse(JSON.stringify(value));

test("overview stays compact; expansion and exact-version source pagination are read-only until Apply", async () => {
  const f = fixture(async (method, input) => method === "stewardTopics" ? page() : method === "stewardTopic" ? card() : original(input.offset, input.offset === 0 ? 2000 : null));
  await f.settle();
  assert.deepEqual(f.calls.map(call => call.method), ["stewardTopics"]);
  assert.match(f.text(), /话题 a.*简短摘要 a/s);
  assert.doesNotMatch(f.text(), /详细目标|原文内容|应用到管家|明确记录/);
  assert.equal(f.applied.length, 0);
  f.toggle("a").props.onClick(); await f.settle();
  assert.deepEqual(f.calls.map(call => call.method), ["stewardTopics", "stewardTopic"]);
  assert.match(f.text(), /详细目标 a/); assert.match(f.text(), /明确记录/); assert.match(f.text(), /原文摘录 · 已被替代/);
  assert.match(f.text(), /已覆盖至 #4 \/ 已观察至 #6/); assert.match(f.text(), /用于下一条消息/);
  assert.doesNotMatch(f.text(), /原文内容/); assert.equal(f.applied.length, 0);
  f.all(node => node.type === "button" && node.props["aria-label"] === "查看引用 1：项目目标")[0].props.onClick(); await f.settle();
  assert.deepEqual(plain(f.calls.at(-1)), { method: "stewardTopicSource", input: { conversationId: "main", ref, offset: 0 } });
  assert.match(f.text(), /原文内容 0/);
  f.button("下一段原文").props.onClick(); await f.settle();
  assert.equal(f.calls.at(-1).input.offset, 2000); assert.match(f.text(), /原文内容 2000/);
  assert.equal(f.button("下一段原文").props.disabled, true);
  f.button("上一段原文").props.onClick(); await f.settle(); assert.equal(f.calls.at(-1).input.offset, 0);
  f.button("应用到管家").props.onClick(); f.render();
  assert.deepEqual(plain(f.applied), [project("a")]);
  assert.equal(f.calls.some(call => !["stewardTopics", "stewardTopic", "stewardTopicSource"].includes(call.method)), false);
  assert.match(f.text(), /已应用到下一条消息/);
});

test("switching and collapsing discard in-flight details and original pages", async () => {
  const a = deferred(), b = deferred(), source = deferred();
  const f = fixture((method, input) => method === "stewardTopics" ? Promise.resolve(page([item("a"), item("b")])) : method === "stewardTopic" ? (input.topic.scope.projectId === "a" ? a.promise : b.promise) : source.promise);
  await f.settle(); f.toggle("a").props.onClick(); f.render(); f.toggle("b").props.onClick(); f.render();
  a.resolve(card("a")); await f.settle(); assert.doesNotMatch(f.text(), /详细目标 a/);
  b.resolve(card("b")); await f.settle(); assert.match(f.text(), /详细目标 b/);
  f.all(node => node.type === "button" && node.props["aria-label"]?.startsWith("查看引用"))[0].props.onClick(); f.render();
  f.toggle("b").props.onClick(); f.render(); source.resolve(original()); await f.settle();
  assert.doesNotMatch(f.text(), /详细目标|原文内容|应用到管家/); assert.equal(f.applied.length, 0);
});

test("search supersedes earlier list reads and page navigation preserves the query", async () => {
  const old = deferred();
  const f = fixture((method, input) => !input.query ? old.promise : Promise.resolve(input.cursor ? page([item("b")]) : page([item("a")], "second")));
  await f.settle();
  f.all(node => node.type === "input")[0].props.onChange({ target: { value: "search" } }); await f.settle();
  assert.equal(f.calls.at(-1).input.query, "search");
  old.resolve(page([item("old")])); await f.settle(); assert.doesNotMatch(f.text(), /话题 old/);
  f.button("下一页话题").props.onClick(); await f.settle(); assert.equal(f.calls.at(-1).input.cursor, "second"); assert.equal(f.calls.at(-1).input.query, "search"); assert.match(f.text(), /话题 b/);
  f.button("上一页话题").props.onClick(); await f.settle(); assert.equal(f.calls.at(-1).input.cursor, undefined); assert.match(f.text(), /话题 a/);
});

test("source revision conflict keeps the cited version visible and requires explicit detail refresh", async () => {
  const f = fixture(async method => { if (method === "stewardTopics") return page(); if (method === "stewardTopic") return card(); throw new Error("引用版本已经变更"); });
  await f.settle(); f.toggle("a").props.onClick(); await f.settle();
  f.all(node => node.type === "button" && node.props["aria-label"]?.startsWith("查看引用"))[0].props.onClick(); await f.settle();
  assert.match(f.text(), /这条引用暂不可读取.*引用版本已经变更/s);
  assert.match(f.text(), /更新|版本/);
  assert.equal(f.calls.filter(call => call.method === "stewardTopic").length, 1);
  f.button("刷新话题并重新选择来源").props.onClick(); await f.settle();
  assert.equal(f.calls.filter(call => call.method === "stewardTopic").length, 2);
  assert.equal(f.calls.filter(call => call.method === "stewardTopicSource").length, 1);
  assert.doesNotMatch(f.text(), /暂不可读取/);
});

test("conversation changes and close prevent late async results from appearing", async () => {
  const detail = deferred(), other = deferred();
  const f = fixture((method, input) => method === "stewardTopics" ? input.conversationId === "main" ? Promise.resolve(page()) : other.promise : detail.promise);
  await f.settle(); f.toggle("a").props.onClick(); f.render();
  f.props.conversationId = "other"; f.render(); await f.settle();
  detail.resolve(card()); await f.settle(); assert.doesNotMatch(f.text(), /详细目标/);
  f.button("关闭").props.onClick(); f.render(); assert.equal(f.closed(), 1);
  other.resolve(page([item("late")])); await f.settle(); assert.doesNotMatch(f.text(), /话题 late/);
  f.unmount();
});

test('details are a separate dialog; repeated fact citations share one number and the collapsed directory renders only six references per page',async()=>{const many={...card(),sources:[ref,...Array.from({length:20},(_,i)=>({kind:'message',id:'long-message-identifier-'+i,seq:i+1,revision:0,scope:project('a'),binding:{kind:'managed',projectId:'a',sessionId:'source-a',generation:1,nodeId:'host',cwd:'/a'}}))]};const f=fixture(async method=>method==='stewardTopics'?page([{...item(),lastDiscussion:{role:'user',excerpt:'最近一条请求',at:'2030-01-01T10:30:00Z',hasAttachments:false,truncated:false}}]):many);await f.settle();assert.equal(f.all(node=>node.type==='dialog').length,0);assert.equal(f.all(node=>node.type==='time')[0].props.dateTime,'2030-01-01T10:30:00Z');f.toggle('a').props.onClick();await f.settle();assert.equal(f.all(node=>node.type==='dialog'&&node.props['aria-label']==='话题详情').length,1);const tiles=f.all(node=>node.type==='article');assert.equal(f.all(node=>node.props.className==='sto-detail',tiles[0]).length,0);assert.equal(f.all(node=>node.props.className==='sto-directory-item').length,6);assert.ok(f.all(node=>node.type==='button'&&node.props['aria-label']==='查看引用 1：项目目标').length>=2);assert.equal(f.all(node=>node.type==='details'&&node.props['aria-label']==='引用目录')[0].props.open,undefined);assert.doesNotMatch(f.text(),/long-message-identifier|revision-7|new-decision/);const calls=f.calls.length;f.button('下一页引用').props.onClick();f.render();assert.equal(f.all(node=>node.props.className==='sto-directory-item').length,6);assert.equal(f.calls.length,calls);f.all(node=>node.type==='button'&&node.props['aria-label']==='关闭话题详情')[0].props.onClick();f.render();assert.equal(f.all(node=>node.type==='dialog').length,0);assert.equal(f.applied.length,0);});

test('summary preview counts graphemes with its ellipsis inside100; full text remains in details and footer uses the actual discussion',async()=>{const summary='👨‍👩‍👧‍👦'.repeat(10)+'字'.repeat(95),discussion={role:'assistant',excerpt:'## **结论**\n- 只调研，不执行 [来源](https://example.test)',at:'2030-01-02T11:22:00Z',hasAttachments:false,truncated:false};const value={...item(),summary,lastDiscussion:discussion};const f=fixture(async method=>method==='stewardTopics'?page([value]):{...card(),summary});await f.settle();const preview=f.all(node=>node.props.className==='sto-summary')[0],display=f.text(preview);assert.equal(Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(display)).length,100);assert.ok(display.endsWith('…'));assert.equal(display.startsWith('👨‍👩‍👧‍👦'.repeat(10)),true);assert.match(f.text(),/上次聊到：助手：结论 只调研，不执行 来源/);assert.doesNotMatch(f.text(),/https:\/\/|已覆盖最新消息/);assert.equal(f.all(node=>node.type==='time')[0].props.dateTime,discussion.at);f.toggle('a').props.onClick();await f.settle();assert.equal(f.text(f.all(node=>node.props.className==='sto-full-summary')[0]),summary);assert.equal(f.calls.some(call=>call.method==='stewardTopicSource'),false);});

test('empty and attachment-only discussions show no fabricated goal snippet; full summary already covered by a fact is not duplicated',async()=>{let value={...item(),summary:'项目目标'};const f=fixture(async method=>method==='stewardTopics'?page([value]):{...card(),summary:'项目目标',facts:[{...card().facts[0],text:'项目目标以及完整约束'}]});await f.settle();assert.match(f.text(),/上次聊到：尚未开始讨论/);assert.equal(f.all(node=>node.type==='time').length,0);f.toggle('a').props.onClick();await f.settle();assert.equal(f.all(node=>node.props.className==='sto-full-summary').length,0);const file=fixture(async()=>page([{...item(),lastDiscussion:{role:'user',excerpt:'',at:'2030-01-01T10:00:00Z',hasAttachments:true,truncated:false}}]));await file.settle();assert.match(file.text(),/上次聊到：你：发送了附件/);assert.equal(file.all(node=>node.type==='time')[0].props.dateTime,'2030-01-01T10:00:00Z');});
