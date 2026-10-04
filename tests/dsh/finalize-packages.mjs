import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const results = join(root, 'tests/dsh/results');
const directory = join(results, 'final-packages');
const distribution = JSON.parse(readFileSync(join(results, 'distribution.json')));
const capabilities = JSON.parse(readFileSync(join(results, 'capabilities.json')));
assert.equal(distribution.ok, true, 'task CLI acceptance must pass before finalizing packages');
assert.equal(capabilities.ok, true, 'independent CLI acceptance must pass before finalizing packages');
const taskProof = distribution.stages.find(stage => stage.name === 'built-tarball');
assert.ok(taskProof?.integrity);
const expected = new Map(capabilities.packages.map(item => [item.name, item.integrity]));
assert.equal(expected.get('@dsh-task/task-system'), taskProof.integrity, 'both CLI receipts must use the same task-system bytes');
const cache = mkdtempSync(join(tmpdir(), 'dsh-final-package-cache-'));
mkdirSync(directory, { recursive: true });
const packages = [];
for (const name of ['task-system', 'typed-decisions', 'feishu-channel']) {
  const result = spawnSync('npm', ['pack', '--json', '--pack-destination', directory], { cwd: join(root, 'packages', name), env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  assert.equal(pack.integrity, expected.get(pack.name), `${pack.name} changed after its successful real CLI run`);
  const bytes = readFileSync(join(directory, pack.filename));
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pack.integrity);
  packages.push({ name: pack.name, filename: pack.filename, integrity: pack.integrity, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
const manifest = { ok: true, checkedAt: new Date().toISOString(), dshVersion: distribution.dshVersion, directory: 'tests/dsh/results/final-packages', comparedReceipts: ['distribution.json', 'capabilities.json'], packages };
writeFileSync(join(results, 'final-pack-integrities.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
