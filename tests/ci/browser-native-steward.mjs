import assert from 'node:assert/strict';
import { startHost } from './browser-native-project.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function testNativeSteward(browser, { output } = {}) {
  const host = await startHost(), errors = [], calls = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log('native steward navigation', new URL(frame.url()).pathname); });
  page.on('console', message => { if (message.type() === 'error') console.log('BROWSER', message.text()); });
  page.on('request', request => { if (request.url().includes('/api/taskPluginSettings/stewardSend')) calls.push(request.postDataJSON()?.payload?.args?.input); });
  try {
    await page.goto(host.url);
    await page.waitForFunction(() => !document.querySelector('[data-dsh-boot]'));
    const preview = page.getByRole('dialog', { name: '预览版说明', exact: true });
    await preview.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '管家', exact: true }).click();
    const native = page.locator('[data-steward-native-host]'), editor = native.locator('[contenteditable="true"]');
    await editor.waitFor();
    assert.equal(await page.locator('.steward-log').count(), 0);
    assert.equal(await page.locator('textarea[aria-label="消息"]').count(), 0);
    assert.equal(await native.locator('[data-composer-card]').count(), 1);
    assert.equal(await native.getByRole('button', { name: /选择模型|停止|重试|撤销/ }).count(), 0);
    await native.getByText('当前仅支持文字；附件请在对应原会话中发送。', { exact: true }).waitFor();
    await native.getByRole('combobox', { name: '本条对话对象', exact: true }).selectOption('personal');
    host.model.script.push('**原生 Markdown 回复**\n\n- 原生列表');
    await editor.fill('Native steward first prompt');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await native.locator('strong').filter({ hasText: '原生 Markdown 回复' }).waitFor();
    assert.equal(await native.getByText('Native steward first prompt', { exact: true }).count(), 1);
    assert.equal(calls.length, 1);
    await native.locator('[data-message-id]').filter({ hasText: '本轮已回复' }).waitFor();
    const target = native.getByRole('combobox', { name: '本条对话对象', exact: true });
    const second = await host.runtime.create({ commandId: 'steward-browser-b', title: 'Steward Beta', goal: 'Isolated Beta', selection: { provider: 'test-offline', model: 'script' } });
    await target.locator('option').filter({ hasText: 'Steward Beta' }).waitFor({ state: 'attached' });
    let releaseA, startedA;
    const heldA = new Promise(resolve => { releaseA = resolve; });
    const aStarted = new Promise(resolve => { startedA = resolve; });
    host.model.script.push(async () => { startedA(); await heldA; return 'Alpha private response'; });
    await target.selectOption(`project:${host.created.projectId}`);
    await editor.fill('ALPHA_PRIVATE_FIRST');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await aStarted;
    await target.selectOption(`project:${second.projectId}`);
    host.model.script.push('Beta independent response');
    await editor.fill('BETA_PRIVATE_FIRST');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await native.getByText('Beta independent response', { exact: true }).waitFor();
    assert.equal(await editor.isEditable(), true);
    assert.equal(calls.find(call => call.text === 'ALPHA_PRIVATE_FIRST').target.projectId, host.created.projectId);
    assert.equal(calls.find(call => call.text === 'BETA_PRIVATE_FIRST').target.projectId, second.projectId);
    const betaRequest = host.model.requests.find(request => JSON.stringify(request.messages).includes('BETA_PRIVATE_FIRST'));
    assert.ok(betaRequest);
    assert.equal(JSON.stringify(betaRequest.messages).includes('ALPHA_PRIVATE_FIRST'), false);
    releaseA();
    await native.getByText('Alpha private response', { exact: true }).waitFor();
    assert.equal(await target.inputValue(), `project:${second.projectId}`, 'Late Alpha reply cannot switch Beta recipient');

    await target.selectOption('personal');
    await editor.fill('freeze personal before paint');
    await page.evaluate(() => { window.savedNativeRAF = window.requestAnimationFrame; window.heldNativeRAF = []; window.requestAnimationFrame = callback => { window.heldNativeRAF.push(callback); return window.heldNativeRAF.length; }; });
    host.model.script.push('Frozen personal response');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await target.selectOption(`project:${second.projectId}`);
    await page.evaluate(() => { window.requestAnimationFrame = window.savedNativeRAF; for (const callback of window.heldNativeRAF) window.requestAnimationFrame(callback); });
    await native.getByText('Frozen personal response', { exact: true }).waitFor();
    assert.equal(calls.find(call => call.text === 'freeze personal before paint').target.kind, 'personal');
    const personalRequest = host.model.requests.find(request => JSON.stringify(request.messages).includes('freeze personal before paint'));
    assert.equal(JSON.stringify(personalRequest.messages).includes('ALPHA_PRIVATE_FIRST'), false);
    assert.equal(JSON.stringify(personalRequest.messages).includes('BETA_PRIVATE_FIRST'), false);

    let releaseAdmission, enteredAdmission;
    const admissionHeld = new Promise(resolve => { releaseAdmission = resolve; });
    const admissionEntered = new Promise(resolve => { enteredAdmission = resolve; });
    await page.route('**/api/taskPluginSettings/stewardSend', async route => {
      if (route.request().postDataJSON().payload.args.input.text === 'HELD_ADMISSION_ALPHA') { enteredAdmission(); await admissionHeld; }
      await route.continue();
    });
    await target.selectOption(`project:${host.created.projectId}`);
    await editor.fill('HELD_ADMISSION_ALPHA');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await admissionEntered;
    assert.equal(await editor.isEditable(), true, 'A pending native prompt RPC does not lock the global composer');
    await target.selectOption('personal');
    host.model.script.push('Personal response before Alpha admission');
    await editor.fill('PERSONAL_BEFORE_ALPHA_ADMISSION');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await native.getByText('Personal response before Alpha admission', { exact: true }).waitFor();
    host.model.script.push('Alpha response after held admission'); releaseAdmission();
    await native.getByText('Alpha response after held admission', { exact: true }).waitFor();
    await page.unroute('**/api/taskPluginSettings/stewardSend');
    const canonical = await host.ctx.taskSystem.steward.snapshot({ conversationId: 'main', limit: 100 });
    const alphaMessage = canonical.messages.find(message => message.text === 'ALPHA_PRIVATE_FIRST');
    await native.locator(`[data-message-id="${alphaMessage.id}"]`).getByRole('button', { name: '回复', exact: true }).click();
    assert.equal(await target.isDisabled(), true);
    host.model.script.push('Alpha reply to old message');
    await editor.fill('Reply to Alpha old message');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await native.getByText('Alpha reply to old message', { exact: true }).waitFor();
    assert.equal(calls.at(-1).replyTo, alphaMessage.id);
    await native.locator(`[data-message-id="${alphaMessage.id}"]`).getByRole('button', { name: '引用到…', exact: true }).click();
    await target.selectOption(`project:${second.projectId}`);
    host.model.script.push('Beta explicit quotation response');
    await editor.fill('Discuss this explicitly shared excerpt');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await native.getByText('Beta explicit quotation response', { exact: true }).waitFor();
    assert.equal(calls.at(-1).target.projectId, second.projectId);
    assert.equal(calls.at(-1).quote.messageId, alphaMessage.id);
    assert.equal(calls.at(-1).quote.excerpt, 'ALPHA_PRIVATE_FIRST');

    await editor.fill('preserve draft on unsupported attachment');
    await editor.evaluate(element => { const transfer = new DataTransfer(); transfer.items.add(new File(["unsupported"], "unsupported.txt", { type: "text/plain" })); element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer })); });
    await page.getByRole('alert').filter({ hasText: '管家目前仅接收文字' }).waitFor();
    assert.equal(await editor.innerText(), 'preserve draft on unsupported attachment');
    assert.equal(calls.some(call => call.text === 'preserve draft on unsupported attachment'), false);
    await editor.fill('');

    let loseAck = true;
    await page.route('**/api/taskPluginSettings/stewardSend', async route => {
      if (loseAck && route.request().postDataJSON().payload.args.input.text === 'lost acknowledgment original') { loseAck = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await target.selectOption('personal');
    host.model.script.push('Lost acknowledgment real reply');
    await editor.fill('lost acknowledgment original');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.locator('[data-pending-command]').filter({ hasText: 'lost acknowledgment original' }).waitFor();
    await page.getByText(/尚未确认发送结果/).waitFor();
    assert.equal(await editor.innerText(), '', 'Unknown acknowledgment must not recreate a fresh-send draft');
    const lostCommand = calls.find(call => call.text === 'lost acknowledgment original').commandId;
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('[data-dsh-boot]'));
    await page.getByRole('button', { name: '管家', exact: true }).click();
    await editor.waitFor();
    await page.locator(`[data-pending-command="${lostCommand}"]`).waitFor();
    await native.getByText('Lost acknowledgment real reply', { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.text === 'lost acknowledgment original').length, 1, 'Reload never resends an unknown original');
    await page.locator(`[data-pending-command="${lostCommand}"]`).getByRole('button', { name: '核实原请求', exact: true }).click();
    await page.locator(`[data-pending-command="${lostCommand}"]`).waitFor({ state: 'detached' });
    assert.equal(await native.getByText('lost acknowledgment original', { exact: true }).count(), 1);
    await page.unroute('**/api/taskPluginSettings/stewardSend');
    const seed = (await host.ctx.taskSystem.steward.snapshot({ conversationId: 'main', limit: 100 })).messages[0];
    let releaseWindowAdmission, enteredWindowAdmission;
    const windowAdmissionHeld = new Promise(resolve => { releaseWindowAdmission = resolve; });
    const windowAdmissionEntered = new Promise(resolve => { enteredWindowAdmission = resolve; });
    await page.route('**/api/taskPluginSettings/stewardSend', async route => {
      if (route.request().postDataJSON().payload.args.input.text === 'HELD_WHILE_WINDOW_RESET') { enteredWindowAdmission(); await windowAdmissionHeld; }
      await route.continue();
    });
    await target.selectOption('personal');
    await editor.fill('HELD_WHILE_WINDOW_RESET');
    await page.evaluate(() => { window.savedWindowRAF = window.requestAnimationFrame; window.heldWindowRAF = []; window.requestAnimationFrame = callback => { window.heldWindowRAF.push(callback); return window.heldWindowRAF.length; }; });
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await editor.fill('Draft survives bounded native window reconnect');
    const editorState = await editor.evaluate(element => { window.retainedStewardEditor = element; const selection = getSelection(); return { anchor: selection.anchorOffset, focus: selection.focusOffset }; });
    console.log('native steward: seeding bounded history');
    for (let index = 0; index < 320; index++) host.ctx.taskSystem.steward.store.project({
      ...seed, id: undefined, seq: undefined, role: 'notification', commandId: null, replyTo: null, nativeSeq: null,
      text: `Synthetic retained notification ${index}`, state: { kind: 'completed' },
    }, `native-browser-retention-${index}`);
    await native.getByText('已载入 300 条消息；更早记录保留在服务器。', { exact: true }).waitFor({ timeout: 30000 });
    await page.evaluate(() => { window.requestAnimationFrame = window.savedWindowRAF; for (const callback of window.heldWindowRAF) window.requestAnimationFrame(callback); });
    await windowAdmissionEntered;
    const windowCommand = calls.find(call => call.text === 'HELD_WHILE_WINDOW_RESET').commandId;
    await page.waitForFunction(() => { const host = document.querySelector('[data-steward-native-host]'); for (const element of host.querySelectorAll('*')) if (element.scrollHeight > element.clientHeight + 200 && element.clientHeight > 100) element.scrollTop = element.scrollHeight; return host.innerText.includes('Synthetic retained notification 319'); }, { timeout: 30000 });
    assert.equal(await editor.innerText(), 'Draft survives bounded native window reconnect');
    assert.equal(await editor.evaluate(element => element === window.retainedStewardEditor && document.activeElement === element), true, 'Pruning retains the exact focused native editor');
    assert.deepEqual(await editor.evaluate(() => ({ anchor: getSelection().anchorOffset, focus: getSelection().focusOffset })), editorState, 'Pruning retains the native caret');
    assert.equal(await native.getByText('Native steward first prompt', { exact: true }).count(), 0, 'Capped native history drops old text together with canonical receipt data');
    await page.locator(`[data-pending-command="${windowCommand}"]`).waitFor();
    assert.equal(await target.inputValue(), 'personal');
    host.model.script.push('Admission completes after native window reset'); releaseWindowAdmission();
    await native.getByText('Admission completes after native window reset', { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.text === 'HELD_WHILE_WINDOW_RESET').length, 1);
    assert.equal(await editor.innerText(), 'Draft survives bounded native window reconnect');
    await page.unroute('**/api/taskPluginSettings/stewardSend');
    host.model.script.push('Reply after bounded window reconnect');
    await target.selectOption('personal');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await native.getByText('Reply after bounded window reconnect', { exact: true }).waitFor();
    await native.getByRole('button', { name: '载入更早消息', exact: true }).click();
    await native.getByRole('button', { name: '返回最新', exact: true }).waitFor();
    await native.getByRole('button', { name: '返回最新', exact: true }).click();
    await native.getByText('Reply after bounded window reconnect', { exact: true }).waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    if (output) await page.screenshot({ path: join(output, 'native-steward.png'), fullPage: true });
    return { calls: calls.length, errors };
  } catch (error) {
    if (output) await page.screenshot({ path: join(output, 'native-steward-failure.png'), fullPage: true }).catch(() => {});
    console.log('STEWARD BODY', (await page.locator('body').innerText()).slice(-2500));
    throw error;
  } finally { await context.close(); await host.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, channel: process.env.DSH_BROWSER_CHANNEL || 'chrome' });
  try { console.log(await testNativeSteward(browser, { output: process.env.DSH_BROWSER_OUTPUT || '/private/tmp' })); }
  finally { await browser.close(); }
}
