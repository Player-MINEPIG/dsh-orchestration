import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createNativeHarness } from '../../../tests/dsh/native-harness.mjs';
import { executeOfficialSubagent, officialProfileConfig } from '../dist/index.js';

for (const cancelled of [false, true]) {
  test(`actual rc2 activation ${cancelled ? 'abort' : 'result'} waits for provider quiescence`, { timeout: 10000 }, async t => {
    const h = await createNativeHarness();
    t.after(() => h.dispose());
    for (const [id, name] of [['fs', '@deepseek-ai/dsh-fs-local'], ['directory', '@deepseek-ai/dsh-working-directory'], ['subagents', '@deepseek-ai/dsh-subagent']]) {
      await h.ctx.loader.create({ id, name, config: {} });
    }
    await h.ctx.loader.await();
    assert.ok(h.ctx.subagents);
    const home = join(h.dir, 'codex-profile');
    mkdirSync(home);
    const backend = { backend: 'activation-fixture', provider: 'codex', model: 'fixture', reasoningEffort: 'low', codexHome: home, permissionContract: 'codex-native' };
    writeFileSync(join(home, 'config.toml'), officialProfileConfig(backend));
    const parent = await h.ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: h.dir } });
    t.after(() => parent.dispose());
    const abort = new AbortController();
    const published = Promise.withResolvers();
    const disposing = Promise.withResolvers();
    const released = Promise.withResolvers();
    const output = Promise.withResolvers();
    let quiescent = false;
    let settled = false;
    h.ctx.subagents.registerProvider({
      name: backend.backend,
      inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      async start(request) {
        assert.equal(request.parent, parent.agent);
        assert.equal(request.cwd, h.dir);
        request.signal.addEventListener('abort', () => output.resolve({ stopReason: 'cancelled', output: [] }), { once: true });
        return {
          id: SessionId(randomUUID()),
          result: output.promise,
          async dispose() { disposing.resolve(); await released.promise; quiescent = true; },
        };
      },
    });
    const running = executeOfficialSubagent({ subagents: h.ctx.subagents, parent: parent.agent, route: { nodeId: 'local', backend: backend.backend, provider: backend.provider, model: backend.model, reasoningEffort: backend.reasoningEffort }, policy: { allowedBackends: [backend.backend] }, backends: [backend], prompt: 'Verify activation lifecycle', signal: abort.signal, onPublished: id => published.resolve(id) });
    const observed = running.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    const rejected = cancelled ? assert.rejects(observed, /fixture cancellation/) : undefined;
    assert.ok(await published.promise);
    if (cancelled) abort.abort(new Error('fixture cancellation'));
    else output.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'verified' }] });
    await disposing.promise;
    assert.equal(settled, false);
    released.resolve();
    if (cancelled) await rejected;
    else assert.equal((await observed).outcome, 'success');
    assert.equal(quiescent, true);
  });
}
