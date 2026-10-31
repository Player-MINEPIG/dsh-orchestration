import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeHarness} from './native-harness.mjs';
import {attachLiveProvider, readLiveProviderRoute} from './steward-live-provider.mjs';
import {mountStewardMemory} from './fixtures/steward-memory-host.mjs';

export async function runStewardLiveSmoke({isolatedRoot, maxOutputTokens = 512, maxRequests = 12} = {}) {
  if (!isolatedRoot) throw new Error('An explicit isolated live smoke root is required');
  const route = await readLiveProviderRoute();
  if (!route) return {configured: false, reason: 'DEFAULT_MODEL_UNAVAILABLE'};
  const h = await createNativeHarness({dir: resolve(isolatedRoot), config: {role: 'both', schedulerEnabled: false, projectAgentOptions: route}});
  let live;
  const observations = [], results = [], toolResults = [];
  try {
    live = await attachLiveProvider(h.ctx, {isolatedRoot: h.dir, maxOutputTokens, maxRequests});
    if (!live.configured) return {configured: false, reason: live.reason, metadata: live.metadata};
    assert.equal(live.metadata.providerId, route.provider); assert.equal(live.metadata.model, route.model);
    const memory = await mountStewardMemory(h), service = h.ctx.taskSystem.steward, projects = h.ctx.taskSystem.projects;
    projects.saveSettings({root: join(h.dir, 'projects'), expectedRevision: 0});
    const alpha = await projects.create({commandId: 'live-alpha', title: 'Live Alpha', goal: 'Synthetic Alpha context isolation only'});
    const beta = await projects.create({commandId: 'live-beta', title: 'Live Beta', goal: 'Synthetic Beta context isolation only'});
    for (const scope of [{kind: 'personal'}, {kind: 'project', projectId: alpha.projectId}, {kind: 'project', projectId: beta.projectId}]) await memory.configure(scope, {commandId: 'live-memory-' + (scope.projectId ?? 'personal')});
    h.ctx.on('tools/result', (exec, result) => {
      toolResults.push({name: exec.name, sessionId: exec.agent ? String(exec.agent.id) : null, isError: result.isError, dataOnly: result.value?.dataOnly === true, itemCount: Array.isArray(result.value?.items) ? result.value.items.length : 0});
    });
    h.ctx.on('llm/stream', async function* (options, next) {
      if (options.provider === route.provider) {
        const serialized = JSON.stringify(options.messages);
        observations.push({sessionId: options.sessionId ?? null, classifier: options.messages[0]?.source?.kind === 'dsh-steward-route-classifier', requestHash: createHash('sha256').update(serialized).digest('hex'), personaCount: (serialized.match(/\[persona dsh-steward@1\]/g) ?? []).length, alphaValue: serialized.includes('ALPHA_VALUE_7491'), betaValue: serialized.includes('BETA_VALUE_3826'), personalValue: serialized.includes('PERSONAL_ARCHIVE_EXACT_5183'), recallOffered: options.tools?.some(tool => tool.name === 'steward_recall') ?? false});
      }
      yield* next();
    });
    async function send(commandId, text, extra = {}) {
      await service.send({conversationId: 'main', commandId, text, routingMode: 'auto', ...extra});
      const until = Date.now() + 90000;
      while (Date.now() < until) {
        const snapshot = await service.reconcile({conversationId: 'main'});
        const user = snapshot.messages.find(message => message.commandId === commandId);
        if (user?.state.kind === 'completed') {
          const assistant = snapshot.messages.findLast(message => message.role === 'assistant' && message.replyTo === user.id);
          if (!assistant) throw new Error('Live native turn completed without an assistant response');
          results.push({commandId, scope: user.scope, route: user.routing, reply: assistant.text.slice(0, 500)});
          return {user, assistant};
        }
        if (user && ['rejected', 'needs-reconciliation'].includes(user.state.kind)) throw new Error('Live native turn requires explicit reconciliation');
        await new Promise(done => setTimeout(done, 40));
      }
      throw new Error('Live native turn did not complete within the bounded wait');
    }
    await send('live-personal', '闲聊，不交给任何项目。请记住合成历史标记 PERSONAL_ARCHIVE_EXACT_5183，代号是silver。仅回复 PERSONAL_OK。');
    const a = await send('live-a', '@Live Alpha 请记住本项目代号 ALPHA_VALUE_7491。不要执行任务，只回复 ALPHA_OK。');
    await send('live-b', '@Live Beta 请记住本项目代号 BETA_VALUE_3826。不要执行任务，只回复 BETA_OK。');
    await send('live-personal-back', '回到闲聊，不属于任何项目。请只回复 BACK_OK。');
    const reply = await send('live-reply-a', '即使提到 Live Beta，也只继续被回复的旧消息。请只回答该项目先前记录的代号。', {replyTo: a.assistant.id});
    assert.equal(reply.user.scope.projectId, alpha.projectId);
    assert.match(reply.assistant.text, /ALPHA_VALUE_7491/);
    const recall = await send('live-recall', '必须先实际调用 steward_recall，query=PERSONAL_ARCHIVE_EXACT_5183、limit=3，然后只回复工具返回的合成历史标记和代号。', {target: {kind: 'personal'}});
    assert.match(recall.assistant.text, /PERSONAL_ARCHIVE_EXACT_5183|silver/);
    assert.ok(toolResults.some(result => result.name === 'steward_recall' && !result.isError && result.dataOnly && result.itemCount > 0), 'A real successful scoped recall tool result is required');
    const native = observations.filter(item => !item.classifier);
    assert.ok(observations.filter(item => item.classifier).length >= 2);
    assert.ok(native.every(item => item.personaCount === 1));
    assert.ok(native.some(item => item.alphaValue && !item.betaValue && !item.personalValue));
    assert.ok(native.some(item => item.betaValue && !item.alphaValue && !item.personalValue));
    assert.ok(native.some(item => item.personalValue && !item.alphaValue && !item.betaValue));
    const personal = await service.memoryConfiguration({conversationId: 'main', scope: {kind: 'personal'}});
    assert.equal(personal.mode, 'manager');
    assert.equal(live.stats.failures, 0);
    return {configured: true, passed: true, metadata: live.metadata, stats: live.stats, observations, toolResults, results, limits: ['Synthetic local personal/A/B scopes only', 'No production task, configuration, deployment or remote owner tested', 'Provider output is real; semantic correctness is limited to these prompts']};
  } catch (error) {
    return {configured: !!live?.configured, passed: false, reason: 'LIVE_SMOKE_FAILED', failure: String(error?.message ?? 'Unknown failure').slice(0, 500), metadata: live?.metadata, stats: live?.stats, observations, toolResults, results};
  } finally { await live?.dispose(); await h.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.DSH_STEWARD_LIVE !== '1') throw new Error('Set DSH_STEWARD_LIVE=1 for explicitly authorized live requests');
  const root = resolve(process.env.DSH_STEWARD_LIVE_ROOT ?? `.runtime/steward-live-${randomUUID()}`);
  await mkdir(root, {recursive: true});
  const evidence = await runStewardLiveSmoke({isolatedRoot: root});
  await writeFile(join(root, 'live-smoke-evidence.json'), JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({...evidence, evidencePath: join(root, 'live-smoke-evidence.json')}) + '\n');
  if (!evidence.passed) process.exitCode = 1;
}
