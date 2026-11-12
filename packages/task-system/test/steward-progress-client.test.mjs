import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('../src/steward-progress-client.js', import.meta.url), 'utf8');
const { groupStewardNotifications: group, createStewardProgressRenderer: createRenderer } = runInNewContext(`${source}\n({ groupStewardNotifications, createStewardProgressRenderer })`, { Date });
const notification = (seq, extra = {}) => ({ id: `notice-${seq}`, seq, role: 'notification',
  createdAt: `2026-11-08T00:${String(seq).padStart(2, '0')}:00Z`, text: `raw native-runtime-error runId=internal-${seq}`,
  scope: { kind: 'project', projectId: 'project-a' }, provenance: { taskId: 'task-a', runId: 'run-a' }, ...extra });
const presentation = (summary, extra = {}) => ({ taskTitle: '研究发布时间', summary, targets: [], needsDecision: false, ...extra });
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(messages, extra = {}) {
  const opened = [], actions = [], renderedActions = [];
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) });
  const Component = createRenderer({ createElement: h });
  const props = { messages, onOpen: (messageId, targetId) => opened.push({ messageId, targetId }),
    renderActions: (message, includeCopy) => {
      renderedActions.push({ message, includeCopy });
      return h('button', { type: 'button', 'data-original-action': message.id, onClick: () => actions.push(message.id) }, '引用这条记录');
    }, ...extra };
  const tree = Component(props);
  const all = (predicate, node = tree, visible = false) => {
    if (!node || typeof node !== 'object') return [];
    const children = visible && node.type === 'details' && !node.props.open ? node.children.filter(child => child?.type === 'summary') : node.children;
    return [...(predicate(node) ? [node] : []), ...children.flatMap(child => all(predicate, child, visible))];
  };
  const text = (node = tree, visible = false) => {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (!node || node.type === 'style') return '';
    const children = visible && node.type === 'details' && !node.props.open ? node.children.filter(child => child?.type === 'summary') : node.children;
    return children.map(child => text(child, visible)).join(' ');
  };
  return { tree, props, Component, opened, actions, renderedActions, all, text, visibleText: () => text(tree, true),
    visibleButtons: () => all(node => node.type === 'button', tree, true) };
}

test('adjacent progress keeps the first real message identity and every original record', () => {
  const messages = Array.from({ length: 5 }, (_, index) => Object.freeze(notification(index + 1)));
  Object.freeze(messages);
  const groups = group(messages);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'progress');
  assert.equal(groups[0].id, messages[0].id);
  assert.deepEqual(Array.from(groups[0].messages), messages);
  groups[0].messages.forEach((message, index) => assert.equal(message, messages[index]));
  const next = group([...messages, notification(6)])[0];
  assert.equal(next.id, groups[0].id);
  assert.equal(messages.length, 5);
});

for (const [name, change] of [
  ['user message', { role: 'user' }],
  ['assistant message', { role: 'assistant' }],
  ['another task', { provenance: { taskId: 'task-b', runId: 'run-b' } }],
  ['another project', { scope: { kind: 'project', projectId: 'project-b' } }],
  ['another scope', { scope: { kind: 'workbench' } }],
  ['gate notification', { gate: { gateId: 'gate-a' } }],
  ['user decision', { presentation: presentation('需要你选择后续方案', { needsDecision: true }) }],
]) {
  test(`${name} interrupts adjacent same-task grouping`, () => {
    const first = notification(1), boundary = notification(2, change), last = notification(3);
    const groups = group([first, boundary, last]);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].messages[0], first);
    assert.equal(groups[2].messages[0], last);
    if (['user message', 'assistant message', 'gate notification', 'user decision'].includes(name)) {
      assert.equal(groups[1].kind, 'message');
      assert.equal(groups[1].message, boundary);
    }
  });
}

test('missing task provenance remains an ordinary message and singleton progress can expose an entry', () => {
  const unbound = notification(1, { provenance: null }), single = notification(2);
  const groups = group([unbound, single]);
  assert.equal(groups[0].kind, 'message');
  assert.equal(groups[0].message, unbound);
  assert.deepEqual(plain(groups[1]), { kind: 'progress', id: single.id, messages: [single] });
});

test('state explanation and material notice survive a later low-information check-in', () => {
  const messages = [
    notification(33, { presentation: presentation('旧运行已核实停止', { emphasis: 'state' }) }),
    notification(34, { provenance: { taskId: 'task-a', runId: 'run-b' }, presentation: presentation('重试已经开始', { emphasis: 'state' }) }),
    notification(35, { provenance: { taskId: 'task-a', runId: 'run-b' }, presentation: presentation('处理过程被打断，尚未收到正式结果。', { emphasis: 'state' }) }),
    notification(36, { provenance: { taskId: 'task-a', runId: 'run-b' }, presentation: presentation('已追加进度记录', { emphasis: 'record',
      materialNotice: '已有一份研究稿可以阅读，尚未作为正式结果提交。', targets: [{ id: 'file-b', kind: 'file', label: '查看研究报告' }] }) }),
    notification(37, { provenance: { taskId: 'task-a', runId: null }, presentation: presentation('状态已更新', { emphasis: 'checkin', targets: [{ id: 'record-c', kind: 'record', label: '查看进度记录' }] }) }),
  ];
  const f = fixture(messages);
  assert.match(f.visibleText(), /研究发布时间.*处理过程被打断，尚未收到正式结果。/s);
  assert.match(f.visibleText(), /已有一份研究稿可以阅读，尚未作为正式结果提交。/);
  assert.doesNotMatch(f.visibleText(), /状态已更新|native-runtime-error|runId=|run-b|任务级|5 条|5条/);
  assert.deepEqual(f.visibleButtons().map(button => f.text(button)), ['查看研究报告']);
  assert.equal(f.opened.length, 0, 'Rendering must not read any target body');
  f.visibleButtons()[0].props.onClick();
  assert.deepEqual(f.opened, [{ messageId: 'notice-36', targetId: 'file-b' }]);
});

test('without state emphasis the latest human summary wins, with no raw-text fallback while pending', () => {
  const first = notification(1, { presentation: presentation('已收到研究材料') });
  const f = fixture([first, notification(2, { presentation: presentation('现在等待核验来源') })]);
  assert.match(f.visibleText(), /现在等待核验来源/);
  assert.doesNotMatch(f.visibleText(), /已收到研究材料/);
  const pending = fixture([notification(3)]);
  assert.match(pending.visibleText(), /正在读取这项工作的进展…/);
  assert.doesNotMatch(pending.visibleText(), /native-runtime-error|internal-3/);
  const known = fixture([first, notification(4)]);
  assert.match(known.visibleText(), /已收到研究材料.*正在读取最新进展…/s);
  assert.doesNotMatch(known.visibleText(), /native-runtime-error|internal-4/);
});

test('an earlier file keeps its original message target and never becomes a later-run result', () => {
  const old = notification(1, { presentation: presentation('先前已有文件', { targets: [{ id: 'old-file', kind: 'file', label: '查看文件' }] }) });
  const latest = notification(2, { provenance: { taskId: 'task-a', runId: 'run-new' }, presentation: presentation('本轮未收到正式结果', { emphasis: 'state' }) });
  const f = fixture([old, latest]);
  assert.match(f.visibleText(), /本轮未收到正式结果.*查看文件.*来自此前的进度说明/s);
  assert.doesNotMatch(f.visibleText(), /研究报告|run-a|run-new|任务级/);
  f.visibleButtons()[0].props.onClick();
  assert.deepEqual(f.opened, [{ messageId: old.id, targetId: 'old-file' }]);
});

test('task-level history is labeled without inheriting another message run and preserves original actions', () => {
  const messages = [notification(1, { presentation: presentation('执行已停止') }), notification(2, {
    provenance: { taskId: 'task-a', runId: null }, presentation: presentation('已登记任务级说明', { targets: [{ id: 'record-a', kind: 'record' }] }),
  })];
  const f = fixture(messages);
  const row = f.all(node => node.type === 'li' && node.props['data-message-id'] === messages[1].id)[0];
  assert.match(f.text(row), /任务级记录（未关联某次执行）/);
  assert.doesNotMatch(f.text(row), /run-a/);
  assert.deepEqual(f.renderedActions.map(value => value.message), messages);
  assert.equal(f.renderedActions.every(value => value.includeCopy === true), true);
  f.all(node => node.props['data-original-action'] === messages[1].id)[0].props.onClick();
  assert.deepEqual(f.actions, [messages[1].id]);
  const original = f.all(node => node.type === 'details' && node.props.className === 'steward-progress-original', row)[0];
  assert.match(f.text(original), /raw native-runtime-error runId=internal-2/);
  const record = f.all(node => node.type === 'button' && f.text(node) === '查看进度记录', row)[0];
  record.props.onClick();
  assert.deepEqual(f.opened, [{ messageId: messages[1].id, targetId: 'record-a' }]);
});

test('native disclosure semantics keep keyboard access and original timestamps without a custom interaction trap', () => {
  const message = notification(1, { presentation: presentation('需要你阅读材料', { targets: [{ id: 'record-a', kind: 'record', label: '查看进度记录' }] }) });
  const Component = createRenderer(React);
  const html = renderToStaticMarkup(React.createElement(Component, { messages: [message], onOpen() {}, renderActions: () => React.createElement('button', { type: 'button' }, '原消息操作') }));
  assert.match(html, /<section[^>]*aria-label="任务进展：研究发布时间"/);
  assert.match(html, /<details class="steward-progress-history"><summary>查看进展与依据<\/summary>/);
  assert.match(html, /<details class="steward-progress-original"><summary>原始记录与依据<\/summary>/);
  assert.match(html, /dateTime="2026-11-08T00:01:00Z"/);
  assert.match(html, /<button[^>]*type="button"[^>]*aria-label="查看进度记录"[^>]*>查看进度记录<\/button>/);
  assert.doesNotMatch(html, /tabindex="-1"|role="button"/);
});

test('empty progress does not render and missing preview callback does not expose a dead action', () => {
  assert.equal(fixture([]).tree, null);
  const f = fixture([notification(1, { presentation: presentation('材料已登记', { targets: [{ id: 'file-a', kind: 'file' }] }) })], { onOpen: undefined });
  assert.equal(f.visibleButtons()[0].props.disabled, true);
});


test('same task notices in different independent topics keep separate groups and original actions', () => {
  const first=notification(1,{scope:{kind:'workbench',topicId:'topic-a'}}),second=notification(2,{scope:{kind:'workbench',topicId:'topic-b'}});
  const grouped=group([first,second]);assert.equal(grouped.length,2);assert.equal(grouped[0].messages[0],first);assert.equal(grouped[1].messages[0],second);
  for(const item of grouped){const rendered=fixture(item.messages);for(const button of rendered.all(node=>node.props['data-original-action']))button.props.onClick();assert.deepEqual(rendered.actions,[item.messages[0].id]);}
});
