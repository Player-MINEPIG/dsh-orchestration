import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createNativeHarness } from '../dsh/native-harness.mjs';
import { TaskPluginSettings } from '../../packages/task-system/dist/settings.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), 10000); })]); }
  finally { clearTimeout(timer); }
}

/** Production React component plus real Host authority; only response timing and diagnostic labels are synthetic. */
export async function testStewardScopeResponses(browser, { output } = {}) {
  const h = await createNativeHarness({ config: { role: 'both', schedulerEnabled: false,
    projectAgentOptions: { provider: 'test-offline', model: 'script' } } });
  process.env.DSH_OFFICIAL_ROOT ??= resolve('.runtime/official-dsh-0.2.1-rc.2');
  const releaseMemory = deferred(), memoryStarted = deferred(), releaseGate = deferred(), gateStarted = deferred();
  const calls = [], errors = [];
  let server, context;
  try {
    const { attachProjectSessionHost } = await import('../../packages/task-system/test/fixtures/project-session-host.mjs');
    await attachProjectSessionHost(h);
    const projects = h.ctx.taskSystem.projects;
    projects.saveSettings({ root: join(h.dir, 'projects'), expectedRevision: 0 });
    const a = await projects.create({ commandId: 'browser-scope-a', title: 'Scope Alpha', goal: 'Synthetic Alpha' });
    const b = await projects.create({ commandId: 'browser-scope-b', title: 'Scope Beta', goal: 'Synthetic Beta' });
    const settings = Object.assign(Object.create(TaskPluginSettings.prototype), { ctx: h.ctx });
    const initial = await settings.stewardSnapshot({ conversationId: 'main' });
    const compiled = readFileSync(new URL('../../packages/task-system/dist/settings-client.js', import.meta.url), 'utf8');
    const start = compiled.indexOf('function createStewardClient(React) {');
    const endMarker = '  return { StewardPanel };\n}';
    const end = compiled.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, 'Use the actual built settings client, not a duplicated component');
    const component = compiled.slice(start, end + endMarker.length);
    const assets = new Map([
      ['/react.js', readFileSync(new URL('../../node_modules/react/umd/react.production.min.js', import.meta.url))],
      ['/react-dom.js', readFileSync(new URL('../../node_modules/react-dom/umd/react-dom.production.min.js', import.meta.url))],
      ['/steward.js', component],
    ]);
    let delayMemory = true, delayGate = true, sentMessage, burstPage;
    const notices = (start, count) => Array.from({ length: count }, (_, index) => ({
      ...sentMessage, id: `synthetic-notification-${start + index}`, role: 'notification', commandId: undefined,
      seq: sentMessage.seq + start + index, text: `Synthetic trailing report notification ${start + index}`, state: { kind: 'completed' },
    }));
    server = createServer(async (request, response) => {
      try {
        if (assets.has(request.url)) { response.setHeader('content-type', 'text/javascript'); response.end(assets.get(request.url)); return; }
        if (request.url === '/rpc' && request.method === 'POST') {
          let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 20000); }
          const { method, input } = JSON.parse(body);
          assert.ok(['stewardReconcile', 'stewardSnapshot', 'stewardMemoryRead', 'stewardGateRead', 'stewardSend'].includes(method));
          calls.push({ method, input });
          if (method === 'stewardSend') h.adapter.script.push('Synthetic browser reply');
          const value = await settings[method](input);
          if (method === 'stewardSend') {
            sentMessage = value.commandMessage;
            assert.ok(sentMessage?.id && sentMessage.commandId === input.commandId, 'Real authority returns the exact submitted command outside the tail');
            value.messages = notices(100, 50);
            burstPage = { ...value.page, firstSeq: sentMessage.seq + 100, lastSeq: sentMessage.seq + 149,
              firstStoredSeq: sentMessage.seq, lastStoredSeq: sentMessage.seq + 149 };
            value.page = burstPage;
            assert.equal(value.messages.some(message => message.id === sentMessage.id), false);
          }
          if (method === 'stewardReconcile' && sentMessage) { value.messages = []; value.page = burstPage; }
          if (method === 'stewardSnapshot' && sentMessage) {
            assert.equal(input.beforeSeq, sentMessage.seq + 100, 'Older-page request uses actual page cursor, not receipt-only command sequence');
            value.messages = notices(50, 50); value.page = { ...burstPage, firstSeq: sentMessage.seq + 50, lastSeq: sentMessage.seq + 99 };
          }
          const projectId = input.scope?.projectId ?? input.projectId;
          if (method === 'stewardMemoryRead') {
            value.diagnostics = [`${projectId === a.projectId ? 'ALPHA' : 'BETA'}_MEMORY_RESPONSE`];
            if (projectId === a.projectId && delayMemory) { delayMemory = false; memoryStarted.resolve(); await releaseMemory.promise; }
          }
          if (method === 'stewardGateRead') {
            value.notice = `${projectId === a.projectId ? 'ALPHA' : 'BETA'}_GATE_RESPONSE`;
            if (projectId === a.projectId && delayGate) { delayGate = false; gateStarted.resolve(); await releaseGate.promise; }
          }
          response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value })); return;
        }
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><html><body style="margin:0;background:#181a1d"><div id="root" style="height:100vh"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/steward.js"></script><script>
          const invoke=async(method,input)=>{const result=await(await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,input})})).json();if(result.error)throw new Error(result.error);return result.value;};
          ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(createStewardClient(React).StewardPanel,{invoke}));
        </script></body></html>`);
      } catch (error) {
        response.statusCode = 400; response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: error.details?.detail ?? error.message }));
      }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const target = page.getByRole('combobox', { name: '本条对话对象', exact: true });
    await target.selectOption(`project:${a.projectId}`);
    await page.getByText('当前对话的记忆与人格来源', { exact: true }).click();
    await page.getByRole('button', { name: '读取记忆设置', exact: true }).click();
    await bounded(memoryStarted.promise, 'Alpha memory authority read');
    await target.selectOption(`project:${b.projectId}`);
    await page.getByText('当前对话的记忆与人格来源', { exact: true }).click();
    await page.getByRole('button', { name: '读取记忆设置', exact: true }).click();
    await page.getByText('BETA_MEMORY_RESPONSE', { exact: true }).waitFor();
    const memoryResponse = page.waitForResponse(response => response.url().endsWith('/rpc') && response.request().postDataJSON().method === 'stewardMemoryRead' && response.request().postDataJSON().input.scope.projectId === a.projectId);
    releaseMemory.resolve(); await memoryResponse;
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await page.getByText('ALPHA_MEMORY_RESPONSE', { exact: true }).count(), 0);
    assert.equal(await page.getByText('BETA_MEMORY_RESPONSE', { exact: true }).count(), 1);

    const storageKey = `dsh-steward-gate-action:${encodeURIComponent(initial.authorityId)}:main:${encodeURIComponent(a.projectId)}`;
    const pending = { method: 'stewardGateDecide', input: { conversationId: 'main', commandId: 'alpha-pending-synthetic', gateId: 'not-dispatched', projectId: a.projectId } };
    await page.evaluate(({ storageKey, pending }) => localStorage.setItem(storageKey, JSON.stringify(pending)), { storageKey, pending });
    await target.selectOption(`project:${a.projectId}`);
    await page.getByRole('button', { name: '查看 Scope Alpha 阶段验收', exact: true }).click();
    await bounded(gateStarted.promise, 'Alpha gate authority read');
    await page.getByRole('button', { name: '重试原验收操作', exact: true }).waitFor();
    await target.selectOption(`project:${b.projectId}`);
    await page.getByRole('button', { name: '查看 Scope Beta 阶段验收', exact: true }).click();
    const gate = page.getByRole('region', { name: '阶段验收', exact: true });
    await gate.getByText('BETA_GATE_RESPONSE', { exact: true }).waitFor();
    const gateResponse = page.waitForResponse(response => response.url().endsWith('/rpc') && response.request().postDataJSON().method === 'stewardGateRead' && response.request().postDataJSON().input.projectId === a.projectId);
    releaseGate.resolve(); await gateResponse;
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await gate.getByText('ALPHA_GATE_RESPONSE', { exact: true }).count(), 0);
    assert.equal(await gate.getByText('BETA_GATE_RESPONSE', { exact: true }).count(), 1);
    assert.equal(await gate.getByRole('button', { name: '重试原验收操作', exact: true }).count(), 0, 'Alpha uncertain command is not offered under Beta');
    assert.equal(await page.evaluate(key => !!localStorage.getItem(key), storageKey), true, 'Alpha recovery receipt was preserved');
    if (output) await page.screenshot({ path: join(output, 'steward-beta-after-late-alpha.png'), fullPage: true });
    await target.selectOption(`project:${a.projectId}`);
    await page.getByRole('button', { name: '查看 Scope Alpha 阶段验收', exact: true }).click();
    await gate.getByRole('button', { name: '重试原验收操作', exact: true }).waitFor();
    await gate.getByText('ALPHA_GATE_RESPONSE', { exact: true }).waitFor();
    assert.equal(calls.some(call => call.method === pending.method), false, 'Uncertain action is never replayed automatically');
    await page.getByRole('button', { name: '关闭验收卡', exact: true }).click();
    await target.selectOption('personal');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('USER_MESSAGE_OUTSIDE_NOTIFICATION_TAIL');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const submitted = page.locator('[data-role="user"]').filter({ hasText: 'USER_MESSAGE_OUTSIDE_NOTIFICATION_TAIL' });
    await submitted.waitFor();
    assert.equal(await submitted.getAttribute('data-message-id'), sentMessage.id);
    const log = page.getByRole('log', { name: '对话记录', exact: true });
    assert.equal(await log.locator('[data-role="notification"]').count(), 50);
    const positioned = await submitted.evaluate(element => {
      const box = element.getBoundingClientRect(), parent = element.closest('[role="log"]').getBoundingClientRect();
      return { visible: box.top >= parent.top - 2 && box.top < parent.bottom && box.bottom > parent.top,
        offset: box.top - parent.top };
    });
    assert.equal(positioned.visible, true, 'Submitted message is focused inside the visible log despite the fifty-message trailing page');
    assert.ok(positioned.offset < 35, 'Scroll anchor points to the submitted command rather than the latest notification');
    assert.ok(await log.locator('[data-message-id]').count() <= 300);
    if (output) await page.screenshot({ path: join(output, 'steward-command-outside-tail.png'), fullPage: true });
    await page.getByRole('button', { name: '载入更早消息', exact: true }).click();
    await page.getByText('Synthetic trailing report notification 50', { exact: true }).waitFor();
    assert.equal(calls.find(call => call.method === 'stewardSnapshot').input.beforeSeq, sentMessage.seq + 100);
    assert.equal(await log.locator('[data-role="notification"]').count(), 100, 'Intermediate notification page remains reachable');
    assert.equal(await submitted.count(), 1);
    assert.deepEqual(errors, []);
    return { productionReact: true, actualHostAuthority: true, delayedMemoryScopeIsolation: true, delayedGateScopeIsolation: true,
      pendingActionScopedAndPreserved: true, noAutomaticReplay: true, commandOutsideTailVisibleAndFocused: true,
      notificationTailCount: 50, intermediatePageReachable: true, receiptDoesNotReplacePageCursor: true, javaScriptErrors: errors.length };
  } finally {
    releaseMemory.resolve(); releaseGate.resolve();
    await context?.close();
    if (server?.listening) await new Promise(done => server.close(done));
    await h.dispose();
  }
}
