/** Exercise the plugin's native command event bridge with real Cordis lifecycle.
 * React elements are inspected without a DOM; the main acceptance uses the real browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
let ui;
const Modal = function OfficialModal() {};
const Button = function OfficialButton() {};
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
};
vm.runInNewContext(readFileSync(new URL('../../packages/task-system/dist/settings-client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(row) { ui = row.factory(name => name === 'react' ? React : { Modal, Button }); } } },
});

test('public project command event opens official result modal even without any chat turn; other commands unaffected', async () => {
  const ctx = new Context();
  let registration, feedback, removed = 0;
  await ctx.plugin({ apply(host) { host.provide('slots', {
    inject(name, callback) { assert.equal(name, 'shell.overlay'); return callback(); },
    register(descriptor, component) { registration = { descriptor, component }; return () => { removed++; }; },
  }); } });
  const plugin = ctx.plugin({ inject: ['slots'], apply(child) { feedback = ui.mountProjectCommandFeedback(child); } });
  await plugin;
  ctx.emit('command/executed', 'blank-session', 'other-command', { kind: 'success', text: 'unrelated' });
  assert.equal(feedback.getSnapshot(), null);
  ctx.emit('command/executed', 'blank-session', 'project', { kind: 'success', text: '{"pending":[],"acknowledged":["r1"]}' });
  const modal = registration.component(registration.descriptor.inject());
  assert.equal(modal.type, Modal); assert.equal(modal.props.open, true);
  assert.equal(modal.props.children[0].props['aria-label'], '项目命令详情');
  assert.match(modal.props.children[0].props.children[0], /acknowledged/);
  assert.equal(feedback.getSnapshot().sessionId, 'blank-session');
  modal.props.onClose(); assert.equal(feedback.getSnapshot(), null);
  await plugin.dispose();
  ctx.emit('command/executed', 'blank-session', 'project', { kind: 'success', text: 'after disposal' });
  assert.equal(feedback.getSnapshot(), null); assert.equal(removed, 1);
  await ctx.fiber.dispose();
});

test('pending and failure results remain visible in order and untrusted text is never HTML', () => {
  const feedback = new ui.ProjectCommandFeedback();
  feedback.accept('s1', 'project', { kind: 'success', text: '已保存到本机待发送队列，中央尚未确认；恢复连接后 /project sync 重试。' });
  feedback.accept('s2', 'project', { kind: 'error', text: 'FORBIDDEN: <img src=x onerror=alert(1)>' });
  let result = ui.ProjectCommandResult({ feedback });
  assert.equal(result.props.title, '项目快照待同步');
  result.props.onClose();
  result = ui.ProjectCommandResult({ feedback });
  assert.equal(result.props.title, '项目操作未完成');
  assert.equal(result.props.children[0].props.role, 'alert');
  assert.equal(result.props.children[0].props.children[0], 'FORBIDDEN: <img src=x onerror=alert(1)>');
  assert.equal(result.props.children[0].props.dangerouslySetInnerHTML, undefined);
  result.props.footer.props.onClick();
  assert.equal(ui.ProjectCommandResult({ feedback }), null);
});


test('pending collaboration activation instructs retry of original command, while historical snapshots retain sync guidance', () => {
  const feedback = new ui.ProjectCommandFeedback();
  feedback.accept('s', 'project', { kind: 'error', text: 'COLLABORATION_PENDING: 中央尚未确认此操作；使用相同参数重试。' });
  let modal = ui.ProjectCommandResult({ feedback });
  assert.equal(modal.props.title, '会话协作待确认');
  assert.match(modal.props.description, /重试原 \/project 命令/);
  assert.doesNotMatch(modal.props.description, /快照|\/project sync/);
  assert.equal(modal.props.children[0].props.role, 'alert');
  modal.props.onClose();
  feedback.accept('s', 'project', { kind: 'success', text: '已保存到本机待发送队列，中央尚未确认。' });
  modal = ui.ProjectCommandResult({ feedback });
  assert.equal(modal.props.title, '项目快照待同步');
  assert.match(modal.props.description, /\/project sync/);
});
