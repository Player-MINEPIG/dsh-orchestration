import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, statSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ensureOfficialRuntime } from '../../scripts/ci/runtime-install.mjs';
import { Workbench } from '../../packages/task-system/dist/workbench.js';
import { registerExecutor } from '../dsh/executor-fixture.mjs';
import { ScriptedModel } from '../dsh/scripted-model.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function startHost() {
  const runtimeRoot = process.env.DSH_OFFICIAL_ROOT ?? ensureOfficialRuntime().root;
  const require = createRequire(join(runtimeRoot, 'package.json'));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-project-native-browser-')));
  const originalHome = process.env.DSH_HOME, originalAgents = process.env.DSH_AGENTS_HOME;
  const restoreEnvironment = () => {
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
    if (originalAgents === undefined) delete process.env.DSH_AGENTS_HOME; else process.env.DSH_AGENTS_HOME = originalAgents;
  };
  process.env.DSH_HOME = join(directory, 'home');
  process.env.DSH_AGENTS_HOME = join(directory, 'agents');
  const { initializeProfileFromDefault, runProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')));
  const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-launch-environment')));
  const profile = 'project-native-browser';
  initializeProfileFromDefault(profile, 'web', process.env.DSH_HOME);
  const packages = join(process.env.DSH_HOME, 'profiles', profile, 'node_modules', '@dsh-task');
  mkdirSync(packages, { recursive: true });
  symlinkSync(join(repo, 'packages/task-system'), join(packages, 'task-system'), 'dir');
  const patch = join(directory, 'browser.patch.yml');
  writeFileSync(patch, JSON.stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port: 0, compression: 'none' } },
    { id: 'session-title-llm', disabled: true },
    { id: 'agent-default-model', config: { provider: 'test-offline', model: 'script' } },
    { insert: [
      { id: 'browser-task', name: '@dsh-task/task-system/plugin', config: { role: 'planner', nodeId: 'local', databasePath: join(directory, 'tasks.sqlite'), executionEnabled: false, keepAlive: false, schedulerEnabled: false, autoExecute: false, projectAgentOptions: { provider: 'test-offline', model: 'script' } } },
      { id: 'browser-task-settings', name: '@dsh-task/task-system' },
    ] },
  ]));
  let ctx;
  try {
    ({ ctx } = await runProfile({ profile, patchFiles: [patch], args: ['--no-open'], environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]) }));
    const model = new ScriptedModel([]);
    ctx.llm.registerAdapter(['test-offline'], model);
    const runtime = ctx.taskSystem.projects;
    runtime.saveSettings({ root: join(directory, 'projects'), expectedRevision: 0 });
    const created = await runtime.create({ commandId: 'browser-create-legacy', title: 'Native browser project', goal: 'Verify the production project panel and ordinary owner conversation', selection: { provider: 'test-offline', model: 'script' } });
    const target = join(directory, 'registered-owner'); mkdirSync(target);
    const workspace = await ctx.workspaceRegistry.create(target, 'Registered native owner');
    const url = ctx.connection.authenticatedUrl(ctx.webApp.getAdvertisedUrl());
    return { ctx, model, runtime, created, workspace, target, directory, url, async close() {
      await ctx.fiber.dispose();
      restoreEnvironment();
      rmSync(directory, { recursive: true, force: true });
    } };
  } catch (error) { await ctx?.fiber.dispose(); restoreEnvironment(); rmSync(directory, { recursive: true, force: true }); throw error; }
}

export async function testNativeProject(browser, { output } = {}) {
  const host = await startHost();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  await context.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined }); Object.defineProperty(crypto, 'subtle', { value: undefined }); });
  const page = await context.newPage();
  const errors = [], nativeCalls = [], placementCalls = [], nativeFailures = [];
  let frameParts = 0;
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (!response.url().includes('/api/taskPluginSettings/projectNativeConversation')) return;
    void response.json().then(value => {
      if (value.result?.ok === false) nativeFailures.push({ operation: response.request().postDataJSON()?.payload?.args?.input?.operation, error: value.result.error });
      if (value.result?.ok === true) {
        const result = value.result.value;
        const batches = Array.isArray(result?.polls) ? result.polls.map(leaf => leaf.result) : [result];
        for (const batch of batches) if (batch?.framePart) frameParts += 1;
      }
    }).catch(() => {});
  });
  page.on('request', request => {
    if (request.url().includes('/api/taskPluginSettings/saveProjectExecutionSettings')) { placementCalls.push(request.postDataJSON()?.payload?.args?.input); return; }
    if (!request.url().includes('/api/taskPluginSettings/projectNativeConversation')) return;
    const input = request.postDataJSON()?.payload?.args?.input;
    if (input) nativeCalls.push(input);
  });
  try {
    console.log('native browser: real Host ready');
    await page.goto(host.url);
    await page.waitForFunction(() => !document.querySelector('[data-dsh-boot]'));
    const preview = page.getByRole('dialog', { name: '预览版说明', exact: true });
    await preview.waitFor();
    await preview.getByRole('button', { name: '继续', exact: true }).click();
    await preview.waitFor({ state: 'hidden' });
    const navMetrics=async label=>page.getByRole('button',{name:label,exact:true}).evaluate(element=>{
      const icon=element.querySelector('svg').getBoundingClientRect(),title=element.querySelector('span:last-child').getBoundingClientRect();
      const pixel=value=>Math.round(value*100)/100;
      return {width:pixel(icon.width),height:pixel(icon.height),titleLeft:pixel(title.left),textAlign:getComputedStyle(element).textAlign};
    });
    const officialNav=await navMetrics('插件'),projectNav=await navMetrics('项目与任务');
    assert.equal(projectNav.width,officialNav.width,'project icon uses the official expanded sidebar size');
    assert.equal(projectNav.height,officialNav.height);
    assert.equal(projectNav.titleLeft,officialNav.titleLeft,'sidebar labels share the same left column');
    assert.equal(projectNav.textAlign,'left');
    if(output)await page.getByRole('button',{name:'项目与任务',exact:true}).locator('..').screenshot({path:join(output,'sidebar-icons-expanded.png')});
    await page.getByRole('button',{name:'收起侧边栏',exact:true}).click();
    await page.waitForTimeout(250);
    assert.equal((await navMetrics('项目与任务')).width,(await navMetrics('插件')).width,'project icon uses the official collapsed sidebar size');
    if(output)await page.getByRole('button',{name:'项目与任务',exact:true}).locator('..').screenshot({path:join(output,'sidebar-icons-collapsed.png')});
    await page.getByRole('button',{name:'打开侧边栏',exact:true}).click();
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: '项目与任务', exact: true }).click();
    const frame = page.frameLocator('iframe[title="项目与任务"]');
    await frame.getByRole('button', { name: '项目', exact: true }).click();
    await frame.getByText('Native browser project', { exact: true }).first().click();
    await frame.getByRole('button', { name: '项目对话', exact: true }).click();
    await frame.locator('#message-input').waitFor();
    console.log('native browser: legacy ProjectPanel opened');
    assert.equal(await page.locator('[data-project-native-host]').count(), 0, 'Legacy projects retain their original composer until explicit placement');
    host.model.script.push('Legacy production reply');
    await frame.locator('#message-input').fill('Legacy production prompt');
    await frame.getByRole('button', { name: '发送消息', exact: true }).click();
    await frame.getByText('Legacy production reply', { exact: true }).waitFor();
    console.log('native browser: legacy send and history passed');
    const before = await host.ctx.taskSystem.sessionPortal.conversation(host.created.projectId);
    assert.equal(before.nativeSession, undefined);
    assert.ok(before.messages.some(message => message.text === 'Legacy production prompt'));
    await frame.locator('[data-action="nav-back"]').first().click();
    await frame.locator('[data-action="project-execution-settings"]').first().click();
    await frame.locator('#settings-coordinator-node').waitFor();
    await frame.locator('#settings-coordinator-node').selectOption('local');
    await frame.locator('#settings-coordinator-workspace').selectOption(host.workspace.id);
    let lostPlacementAck = false, placementRetryDone;
    const placementRetryFinished = new Promise(resolve => { placementRetryDone = resolve; });
    await page.route('**/api/taskPluginSettings/saveProjectExecutionSettings', async route => {
      const response = await route.fetch();
      if (!lostPlacementAck) { lostPlacementAck = true; await route.abort('failed'); }
      else { await route.fulfill({ response }); placementRetryDone(); }
    });
    await frame.getByRole('button', { name: '保存设置', exact: true }).click();
    await frame.getByRole('button', { name: '重试原保存', exact: true }).waitFor();
    assert.equal(await frame.locator('#settings-coordinator-node').isDisabled(), true);
    assert.equal(await frame.getByRole('button', { name: '重新读取（替换草稿）', exact: true }).isDisabled(), true);
    if (output) await page.screenshot({ path: join(output, 'native-project-placement-uncertain.png'), fullPage: true });
    const retryPlacement = page.waitForRequest(request => request.url().includes('/api/taskPluginSettings/saveProjectExecutionSettings'));
    await frame.getByRole('button', { name: '重试原保存', exact: true }).click();
    await retryPlacement;
    await placementRetryFinished;
    assert.equal(placementCalls.length, 2);
    assert.equal(placementCalls[0].commandId, placementCalls[1].commandId);
    await page.unroute('**/api/taskPluginSettings/saveProjectExecutionSettings');
    await frame.getByRole('button', { name: '项目对话', exact: true }).click();
    console.log('native browser: explicit placement saved');
    const native = page.locator('[data-project-native-host]');
    await native.getByRole('button', { name: '对话对象：项目统筹', exact: true }).waitFor();
    const editor = native.locator('[contenteditable="true"]');
    await editor.waitFor();
    const placed = await host.ctx.taskSystem.sessionPortal.conversation(host.created.projectId);
    assert.equal(placed.nativeSession.binding.cwd, host.target);
    assert.equal(placed.nativeSession.binding.kind, 'native');
    const blankComposer = await native.locator('[data-composer-seat]').boundingBox();
    const chatBox = await native.boundingBox();
    assert.ok(blankComposer.y > chatBox.y + chatBox.height * 0.65, 'Blank native composer stays at the bottom of its owned chat seat');
    host.model.script.push('Native production owner reply');
    await editor.fill('Native production owner prompt');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    await native.getByText('Native production owner reply', { exact: true }).waitFor();
    const prompts = nativeCalls.filter(call => call.operation?.kind === 'session-prompt');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].commandId, prompts[0].operation.requestId);
    assert.equal(prompts[0].generation, placed.nativeSession.binding.generation);
    assert.ok(host.model.requests.some(request => JSON.stringify(request.messages).includes('Native production owner prompt')));
    assert.equal(await native.locator('[contenteditable="true"]').count(), 1);
    await native.getByRole('button', { name: /选择模型/ }).waitFor();
    await native.getByRole('button', { name: /访问模式/ }).waitFor();
    if (output) {
      await page.screenshot({ path: join(output, 'native-project-desktop.png'), fullPage: true });
      writeFileSync(join(output, 'native-project-calls.json'), JSON.stringify(nativeCalls, null, 2));
    }
    const imagePath = join(host.directory, 'native-project-screenshot.png');
    await page.screenshot({ path: imagePath, fullPage: true });
    assert.ok(statSync(imagePath).size > 16384, 'The real screenshot exceeds the former single-envelope image limit');
    const imageReplyText = 'Native production image reply. ' + 'This reply verifies complete project history after switching conversations. '.repeat(1000).trimEnd();
    host.model.script.push(imageReplyText);
    await native.locator('input[type="file"]').setInputFiles(imagePath);
    await native.locator('img').last().waitFor();
    await editor.fill('Native image over chunk carrier');
    await native.getByRole('button', { name: '发送消息', exact: true }).click();
    const imageReply = native.getByText(/^Native production image reply/);
    await imageReply.waitFor();
    assert.equal(await imageReply.textContent(), imageReplyText);
    const imagePrompt = nativeCalls.filter(call => call.operation?.kind === 'session-prompt').at(-1);
    assert.ok(imagePrompt.operation.content.some(part => part.type === 'image-upload'));
    assert.ok(imagePrompt.operation.content.every(part => part.type !== 'image'));
    assert.ok(nativeCalls.filter(call => call.operation?.kind === 'file-upload-part').length > 1);
    assert.ok(nativeCalls.every(call => Buffer.byteLength(JSON.stringify(call)) < 48 * 1024));
    assert.ok(host.model.requests.some(request => JSON.stringify(request.messages).includes('"type":"image"')));
    if (output) await page.screenshot({ path: join(output, 'native-project-image.png'), fullPage: true });
    const primaryPromptCount = nativeCalls.filter(call => call.operation?.kind === 'session-prompt').length;
    console.log('native browser: native owner send, controls and composer geometry passed');
    const ledger = host.ctx.taskSystem.ledger;
    ledger.registerWorkspace('browser-executor-workspace', { workspaceId: 'browser-executor-workspace', nodeId: 'worker', path: host.directory, label: 'Original executor workspace', state: 'ready', createdAt: new Date().toISOString() });
    registerExecutor(ledger, 'browser-executor-register', { nodeId: 'worker', roles: ['executor'], models: [{ provider: 'fixture', model: 'fixture', reasoningEfforts: [] }], capabilities: [], workspaceIds: ['browser-executor-workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
    const task = ledger.createTask('browser-original-task', { title: 'Original execution conversation', workspaceId: 'browser-executor-workspace' }).value;
    new Workbench(ledger).manage('browser-link-original', 'link_backlog_task', { backlogId: 'pr:' + host.created.projectId, taskId: task.taskId });
    const run = ledger.createRun('browser-original-run', { taskId: task.taskId, route: { nodeId: 'worker', workspaceId: 'browser-executor-workspace', provider: 'fixture', model: 'fixture', requiredCapabilities: [] } }).value;
    const claim = ledger.claim('browser-original-claim', { runId: run.runId, nodeId: 'worker', ttlMs: 60000 }).value;
    const execution = { runId: run.runId, attemptId: claim.attempt.attemptId, nodeId: 'worker', fence: claim.attempt.fence, executionId: 'browser-old-execution' };
    ledger.markRunning('browser-original-start', execution);
    const original = ledger.selectTaskSession('browser-original-session', { ...execution, workspaceId: 'browser-executor-workspace', session: { mode: 'new' } }).value;
    await page.waitForTimeout(3200);
    await native.getByRole('button', { name: '对话对象：项目统筹', exact: true }).click();
    await frame.locator(`[data-action="recipient-select"][data-id="${original.sessionId}"]`).click();
    await native.waitFor({ state: 'detached' });
    await frame.locator('#message-input').fill('Original executor target proof');
    await frame.getByRole('button', { name: '发送消息', exact: true }).click();
    await frame.locator('#messages .message.user').filter({ hasText: 'Original executor target proof' }).first().waitFor();
    const messages = ledger.sessionMessages(task.taskId);
    assert.ok(messages.some(message => message.sessionId === original.sessionId && message.text === 'Original executor target proof'));
    assert.equal(nativeCalls.filter(call => call.operation?.kind === 'session-prompt').length, primaryPromptCount, 'Executor messages never fall through to native primary');
    console.log('native browser: original executor recipient routing passed');
    let failCapabilities = true;
    await page.route('**/api/taskPluginSettings/projectNativeConversation', async route => {
      const envelope = route.request().postDataJSON();
      if (failCapabilities && envelope.payload?.args?.input?.operation?.kind === 'native-capabilities') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'task/project', message: 'Owner offline for UI fault injection', details: { reason: 'COORDINATOR_UNAVAILABLE' } } } }) });
      } else await route.continue();
    });
    await frame.locator('[data-action="recipient"]').click();
    await frame.locator('[data-action="recipient-select"][data-id=""]').click();
    await native.getByRole('alert').waitFor();
    await native.getByRole('button', { name: '选择对话对象', exact: true }).waitFor();
    await native.getByRole('button', { name: '选择对话对象', exact: true }).click();
    await frame.locator(`[data-action="recipient-select"][data-id="${original.sessionId}"]`).click();
    await native.waitFor({ state: 'detached' });
    failCapabilities = false;
    await page.unroute('**/api/taskPluginSettings/projectNativeConversation');
    await frame.locator('[data-action="recipient"]').click();
    await frame.locator('[data-action="recipient-select"][data-id=""]').click();
    await native.getByRole('button', { name: '对话对象：项目统筹', exact: true }).waitFor();
    await imageReply.waitFor();
    assert.equal(await imageReply.textContent(), imageReplyText, 'A native record larger than 48 KiB survives owner transport and remount without truncation');
    assert.ok(frameParts > 1, 'The production carrier reconstructs real SDK history frame fragments');
    await native.locator('img').last().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-project-native-host] img')].some(image => image.complete && image.naturalWidth > 0));
    assert.ok(nativeCalls.some(call => call.operation?.kind === 'attachment-read'));
    const collapse = page.getByRole('button', { name: '收起侧边栏', exact: true }).first();
    if (await collapse.isVisible()) await collapse.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await frame.locator('[data-action="project-context-toggle"]').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-project-native-host]')).visibility === 'hidden');
    await frame.locator('#project-context [data-action="project-context-close"]').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-project-native-host]')).visibility === 'visible');
    const mobileBox = await native.boundingBox();
    assert.ok(mobileBox.width > 200 && mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 391);
    if (output) await page.screenshot({ path: join(output, 'native-project-mobile.png'), fullPage: true });
    await frame.locator('[data-action="nav-back"]').first().click();
    await native.waitFor({ state: 'detached' });
    await frame.getByText('Native browser project', { exact: true }).first().waitFor();
    const binding=placed.nativeSession.binding;
    const trace=ledger.withDispatchOrigin({kind:'session',nodeId:'local',sessionId:binding.sessionId,cwd:binding.cwd},()=>ledger.createTask('browser-session-trace',{title:'Trace original responsible session'}).value);
    new Workbench(ledger).manage('browser-link-trace','link_backlog_task',{backlogId:'pr:'+host.created.projectId,taskId:trace.taskId});
    await page.setViewportSize({width:1440,height:1000});
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('[data-dsh-boot]'));
    await page.getByRole('button',{name:'项目与任务',exact:true}).click();
    const owner={kind:'session',nodeId:'local',sessionId:binding.sessionId,cwd:binding.cwd};
    const needsUser=ledger.withDispatchOrigin(owner,()=>ledger.createTask('browser-needs-user',{title:'Restore a missing workspace grant'}).value);
    new Workbench(ledger).manage('browser-link-needs-user','link_backlog_task',{backlogId:'pr:'+host.created.projectId,taskId:needsUser.taskId});
    ledger.withDispatchOrigin(owner,()=>ledger.taskCheckin({action:'responsibility',commandId:'browser-needs-user-declaration',taskId:needsUser.taskId,expectedVersion:ledger.checkins.view(needsUser.taskId).responsibilityVersion,state:'needs_user',summary:'Please restore the missing workspace grant; the coordinator cannot authorize this directory.'}));
    ledger.withDispatchOrigin(owner,()=>ledger.taskCheckin({action:'responsibility',commandId:'browser-coordinator-declaration',taskId:trace.taskId,expectedVersion:ledger.checkins.view(trace.taskId).responsibilityVersion,state:'coordinator',summary:'The original responsible session is arranging the next revision.'}));
    await frame.locator(`[data-action="task"][data-id="${trace.taskId}"]`).first().waitFor();
    await frame.locator('[data-action="responsibility-filter"][data-id="needs_user"]').click();
    await frame.getByText(needsUser.title,{exact:true}).waitFor();
    assert.equal(await frame.getByText(trace.title,{exact:true}).count(),0);
    const followupGroup=frame.getByRole('group',{name:'跟进状态',exact:true});
    const taskGroup=frame.getByRole('group',{name:'任务状态',exact:true});
    const followup=kind=>followupGroup.locator(`[data-id="${kind}"]`),taskStatus=kind=>taskGroup.locator(`[data-id="${kind}"]`);
    await taskStatus('draft').click();assert.equal(await followup('needs_user').getAttribute('aria-pressed'),'true');
    await frame.getByText(needsUser.title,{exact:true}).waitFor();
    await taskStatus('done').click();await frame.locator('.kanban .empty').waitFor();
    assert.equal(await followup('needs_user').getAttribute('aria-pressed'),'true');assert.equal(await taskStatus('done').getAttribute('aria-pressed'),'true');
    await followup('all').click();assert.equal(await taskStatus('done').getAttribute('aria-pressed'),'true');
    await taskStatus('all').click();await followup('needs_user').click();
    const theme=async value=>{
      await page.evaluate(value=>document.querySelector('iframe[title="项目与任务"]').contentWindow.postMessage({channel:'dsh-project-runtime',method:'theme',input:value},'*'),value);
      await frame.locator(`html[data-theme="${value}"]`).waitFor();
    };
    const verifyColors=async()=>{
      const colors=await followup('needs_user').evaluate(async element=>{await Promise.all(element.getAnimations().map(animation=>animation.finished));const style=getComputedStyle(element),root=getComputedStyle(document.documentElement);return {color:style.color,label:getComputedStyle(element.querySelector('span')).color,count:getComputedStyle(element.querySelector('b')).color,border:style.borderTopColor,state:style.getPropertyValue('--state-color').trim(),token:root.getPropertyValue('--status-review').trim()};});
      assert.equal(colors.color,colors.label);assert.equal(colors.color,colors.count);assert.equal(colors.color,colors.border);assert.equal(colors.state,colors.token);
      assert.equal(await frame.locator('.responsibility-badge[data-responsibility="needs_user"]').first().evaluate(element=>getComputedStyle(element).color),colors.color);
    };
    await theme('light');await verifyColors();
    if(output)await page.locator('iframe[title="项目与任务"]').screenshot({path:join(output,'task-filter-light.png')});
    await theme('dark');await verifyColors();
    if(output){await page.locator('iframe[title="项目与任务"]').screenshot({path:join(output,'task-filter-dark.png')});await frame.locator('.task-filter-groups').screenshot({path:join(output,'task-filter-groups-dark.png')});}
    const sidebarCollapse=page.getByRole('button',{name:'收起侧边栏',exact:true}).first();if(await sidebarCollapse.isVisible())await sidebarCollapse.click();
    await page.setViewportSize({width:390,height:844});
    await theme('dark');await verifyColors();
    for(const group of [followupGroup,taskGroup])assert.ok(await group.locator('.task-filter-options').evaluate(element=>element.scrollWidth<=element.clientWidth+1),'Filter groups wrap without horizontal scrolling');
    if(output)await page.locator('iframe[title="项目与任务"]').screenshot({path:join(output,'task-filter-mobile-dark.png')});
    await theme('light');if(output)await page.locator('iframe[title="项目与任务"]').screenshot({path:join(output,'task-filter-mobile-light.png')});
    await page.setViewportSize({width:1440,height:1000});
    console.log('native browser: independent filter dimensions, shared semantic colors and mobile wrapping passed');
    await frame.locator('[data-action="responsibility-filter"][data-id="all"]').click();
    await frame.locator(`[data-action="task"][data-id="${trace.taskId}"]`).first().click();
    await frame.getByRole('heading',{name:'原负责会话',exact:true}).waitFor();
    await frame.getByText(binding.cwd,{exact:false}).first().waitFor();
    await frame.getByRole('heading',{name:'原负责会话',exact:true}).scrollIntoViewIfNeeded();
    if(output)await page.screenshot({path:join(output,'task-original-session.png'),fullPage:true});
    const modelCallsBeforeNavigation=host.model.requests.length;
    await frame.getByRole('button',{name:'打开原生会话',exact:true}).click();
    await page.getByText('Native production owner prompt',{exact:true}).last().waitFor();
    assert.equal(host.model.requests.length,modelCallsBeforeNavigation,'Opening source history does not submit or rerun work');
    if(output)await page.screenshot({path:join(output,'task-open-original-session.png'),fullPage:true});
    console.log('native browser: task source opens the real session in its registered workspace');
    assert.deepEqual(errors, []);
    return { legacyComposer: true, explicitOrdinaryPlacement: true, realNativeSend: true, nativePromptIdentity: prompts[0].commandId, generation: placed.nativeSession.binding.generation, placementLostAck: true, originalExecutorRecipient: true, offlineRecipientRecovery: true, mobileDrawer: true, largeImageBytes: statSync(imagePath).size, insecureContextCrypto: true, losslessHistoryFragments: frameParts };
  } catch (error) {
    if (output) { await page.screenshot({ path: join(output, 'native-project-failure.png'), timeout: 5000 }).catch(() => {}); writeFileSync(join(output, 'native-project-failure.html'), await page.content().catch(() => '')); writeFileSync(join(output, 'native-project-errors.json'), JSON.stringify(errors)); writeFileSync(join(output, 'native-project-native-failures.json'), JSON.stringify(nativeFailures)); writeFileSync(join(output, 'native-project-model-requests.json'), JSON.stringify(host.model.requests)); }
    console.error('native browser failed:', error.message);
    throw error;
  } finally { await context.close(); await host.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { chromium } = await import('playwright');
  const output = resolve(process.env.DSH_BROWSER_OUTPUT ?? join(tmpdir(), 'dsh-native-project-browser-evidence'));
  mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.DSH_BROWSER_CHANNEL ? { channel: process.env.DSH_BROWSER_CHANNEL } : {}) });
  try { console.log(JSON.stringify(await testNativeProject(browser, { output }))); }
  finally { await browser.close(); }
}
