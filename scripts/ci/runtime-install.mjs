import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DSH_VERSION = '0.2.1-rc.2';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Both distribution suites use this installation, while profiles and ledgers
// belong to each suite's separate temporary directory.
export function ensureOfficialRuntime() {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Official DSH acceptance requires Node.js 24 or newer');
  const root = resolve(process.env.DSH_CI_RUNTIME_ROOT ?? join(repository, '.runtime', `official-dsh-${DSH_VERSION}`));
  const manifest = join(root, 'node_modules/@deepseek-ai/dsh/package.json');
  if (!existsSync(manifest) || !existsSync(join(root, 'node_modules/@deepseek-ai/dsh-web-app/package.json'))) {
    mkdirSync(root, { recursive: true });
    const project = join(root, 'package.json');
    if (!existsSync(project)) writeFileSync(project, JSON.stringify({ private: true, name: 'dsh-ci-official-runtime', version: '0.0.0' }) + '\n');
    const pnpm = join(repository, 'node_modules/pnpm/bin/pnpm.cjs');
    assert.ok(existsSync(pnpm), 'Run npm ci before preparing the official runtime');
    const result = spawnSync(process.execPath, [pnpm, '--dir', root, 'add', '--shamefully-hoist', '--save-exact', '--reporter=append-only', '--allow-build=@deepseek-ai/dsh-subprocess-local', '--allow-build=@google/genai', '--allow-build=koffi', '--allow-build=node-pty', '--allow-build=protobufjs', `@deepseek-ai/dsh@${DSH_VERSION}`, `@deepseek-ai/dsh-web-app@${DSH_VERSION}`], { cwd: root, env: { ...process.env, npm_config_update_notifier: 'false' }, encoding: 'utf8', timeout: 300000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `Official runtime install failed:\n${result.stdout}\n${result.stderr}`);
  }
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, DSH_VERSION, `Expected fixed official runtime at ${root}`);
  const webManifest = join(root, 'node_modules/@deepseek-ai/dsh-web-app/package.json');
  assert.equal(JSON.parse(readFileSync(webManifest, 'utf8')).version, DSH_VERSION, `Expected fixed official web application at ${root}`);
  const bin = join(dirname(manifest), 'lib/bin.js');
  assert.ok(existsSync(bin), `Official CLI is missing: ${bin}`);
  return { root, bin, packageRoot: dirname(manifest), version: DSH_VERSION };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = ensureOfficialRuntime();
  if (process.argv.includes('--github-env')) {
    assert.ok(process.env.GITHUB_ENV, '--github-env requires GITHUB_ENV');
    appendFileSync(process.env.GITHUB_ENV, `DSH_OFFICIAL_ROOT=${runtime.root}\n`);
  }
  process.stdout.write(JSON.stringify(runtime) + '\n');
}
