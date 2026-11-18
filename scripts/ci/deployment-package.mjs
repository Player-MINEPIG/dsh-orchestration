import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { preserveTestedPackage } from './tested-package.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sourceSha = git('rev-parse', 'HEAD');
assert.equal(process.env.GITHUB_REF, 'refs/heads/dev', 'Ordinary packages come from dev');
assert.equal(sourceSha, process.env.GITHUB_SHA, 'Package source must equal workflow commit');
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Package source must be committed');
const output = resolve('.runtime/deployment-package');
mkdirSync(output, { recursive: true });
const packages = [];
for (const directory of ['task-system', 'jev']) {
  const cwd = resolve('packages', directory);
  const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd, encoding: 'utf8' }))[0];
  // Verify every public entry resolves to shipped bytes before preserving the archive.
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json')));
  const entries = [manifest.main, manifest.types, ...Object.values(manifest.exports ?? {}).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))].filter(Boolean);
  for (const entry of entries) assert.ok(pack.files.some(file => file.path === entry.replace(/^\.\//, '')), `Missing shipped entry ${entry}`);
  packages.push(preserveTestedPackage(pack, join(output, pack.filename), output));
}
writeFileSync(join(output, 'deployment.json'), JSON.stringify({ schemaVersion: 1, sourceSha, branch: 'dev', repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, validation: 'build and public package entries; applicable PR checks precede merge', packages }, null, 2) + '\n');
