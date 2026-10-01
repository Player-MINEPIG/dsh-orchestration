#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSourceScope, readCodexDaily, readHermesDaily, readGameDaily, readAutoMasDaily } from './index.mjs';

export async function readManifest({ root, configFile, limits }) {
  const scope = await createSourceScope(resolve(root), limits);
  const config = await scope.json(configFile);
  const result = {};
  if (config.codex) result.codex = await readCodexDaily({ window: config.window, ...config.codex, scope });
  if (config.hermes) result.hermes = await readHermesDaily({ window: config.window, ...config.hermes, scope });
  if (config.game) result.game = await readGameDaily({ window: config.window, ...config.game, scope });
  if (config.automas) result.game = await readAutoMasDaily({ window: config.window, ...config.automas, scope });
  if (!Object.keys(result).length) throw new Error('Manifest needs codex, hermes or game configuration');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--root' || args[2] !== '--config') throw new Error('Usage: node readers/run.mjs --root EXPORT_ROOT --config manifest.json');
    process.stdout.write(JSON.stringify(await readManifest({ root: args[1], configFile: args[3] }), null, 2) + '\n');
  } catch (error) { process.stderr.write(`${error.code ?? 'reader'}: ${error.message}\n`); process.exitCode = 1; }
}
