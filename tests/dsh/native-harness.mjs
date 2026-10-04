import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { ScriptedModel } from './scripted-model.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Real DSH Loader fixture for other packages; only the external model is scripted. */
export async function createNativeHarness({ config = {}, script = [], dir } = {}) {
  const ownedDirectory = !dir;
  dir ??= mkdtempSync(join(tmpdir(), 'dsh-native-fixture-'));
  mkdirSync(dir, { recursive: true });
  dir = realpathSync(dir);
  const ctx = new Context();
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(project, 'package.json')).href });
  await ctx.loader.root.update([
    ['llm', '@deepseek-ai/dsh-llm'], ['sessions', '@deepseek-ai/dsh-session'],
    ['sessionProjections', '@deepseek-ai/dsh-session-projection'], ['systemPrompt', '@deepseek-ai/dsh-system-prompt'],
    ['tools', '@deepseek-ai/dsh-tools'], ['agents', '@deepseek-ai/dsh-agent'],
    ['persistence', '@deepseek-ai/dsh-session-persistence-jsonl', { root: join(dir, 'sessions'), compression: 'none' }],
    ['agentLoop', '@deepseek-ai/dsh-agent-loop', { agents: [] }],
    ['task', pathToFileURL(join(project, 'packages/task-system/dist/dsh-plugin.js')).href, { role: 'both', nodeId: 'local', databasePath: join(dir, 'tasks.sqlite'), keepAlive: false, leaseTtlMs: 10000, ...config }],
  ].map(([id, name, config]) => ({ id, name, config })));
  await ctx.loader.await();
  assert.ok(ctx.taskSystem?.native, 'real Loader must provide native execution');
  const adapter = new ScriptedModel(script);
  ctx.llm.registerAdapter(['test-offline'], adapter);
  return {
    ctx, dir, adapter, ledger: ctx.taskSystem.ledger,
    async dispose() { await ctx.fiber.dispose(); if (ownedDirectory) rmSync(dir, { recursive: true, force: true }); },
  };
}
