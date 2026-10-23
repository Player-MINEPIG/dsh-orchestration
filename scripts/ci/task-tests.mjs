import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const suites = JSON.parse(readFileSync(new URL('../../tests/ci/suites.json', import.meta.url)));
const directory = 'packages/task-system/test';
const files = [directory, `${directory}/remote`, 'tests/dsh', 'tests/settings'].flatMap(path =>
  readdirSync(resolve(root, path)).filter(name => name.endsWith('.test.mjs')).map(name => `${path}/${name}`));
const assigned = Object.values(suites).flat();
assert.equal(new Set(assigned).size, assigned.length, 'A task test belongs to exactly one suite');
assert.deepEqual([...assigned].sort(), files.sort(), 'Register every task test in tests/ci/suites.json');
const group = process.argv[2];
assert.ok(Object.hasOwn(suites, group), `Unknown suite: ${group}`);
let env = process.env;
if (group === 'official') {
  const { ensureOfficialRuntime } = await import('./runtime-install.mjs');
  const runtime = ensureOfficialRuntime();
  env = { ...env, DSH_OFFICIAL_ROOT: runtime.root };
}
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...suites[group]], { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
