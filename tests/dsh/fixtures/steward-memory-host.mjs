import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const stewardMemoryPluginRoot = resolve('.runtime/steward-plugins');
export const stewardMemoryAvailable = existsSync(join(stewardMemoryPluginRoot, 'manager/src/index.js')) && existsSync(join(stewardMemoryPluginRoot, 'assembler/src/plugin.js'));
export const stewardMemoryPresetId = 'dsh-task-steward-native-v1';

/** Exact optional public plugins on the actual isolated Host. Registration never selects a session preset. */
export async function mountStewardMemory(h) {
  if (!stewardMemoryAvailable) throw Error('Pinned optional sources must exist under .runtime/steward-plugins');
  process.env.DSH_OFFICIAL_ROOT ??= resolve('.runtime/official-dsh-0.2.1-rc.2');
  if (!h.ctx.get('sessionController')) {
    const { attachProjectSessionHost } = await import('../../../packages/task-system/test/fixtures/project-session-host.mjs');
    await attachProjectSessionHost(h);
  }
  for (const [id, relative] of [['manager', 'manager/src/index.js'], ['assembler', 'assembler/src/plugin.js']])
    await h.ctx.loader.create({ id: 'product-memory-' + id, name: pathToFileURL(join(stewardMemoryPluginRoot, relative)).href, config: { storageDir: join(h.dir, id) } });
  await h.ctx.loader.await();
  assert.equal(h.ctx.dshPromptAssembler.version, '1.1.3');
  assert.equal(JSON.parse(readFileSync(join(stewardMemoryPluginRoot, 'manager/package.json'))).version, '1.0.0');
  const service = h.ctx.taskSystem.steward;
  const read = (scope, conversationId = 'main') => service.memoryConfiguration({ conversationId, scope });
  const configure = async (scope, { commandId, conversationId = 'main', mode = 'manager', presetId = stewardMemoryPresetId,
    initializeMissingRules = true, inheritProjectGenerations = true } = {}) => {
    if (!commandId) throw Error('Explicit memory configuration requires a stable commandId');
    const current = await read(scope, conversationId);
    return service.configureMemory({ conversationId, scope, commandId, expectedRevision: current.revision,
      expectedSelectionHash: current.selectionHash, mode, presetId, initializeMissingRules, inheritProjectGenerations });
  };
  return { manager: h.ctx.dshMemoryManager, assembler: h.ctx.dshPromptAssembler, read, configure };
}
