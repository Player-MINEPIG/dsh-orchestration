import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicPromote, candidatePackageVersion, checkedSha, checkedTag, createManifest, validateAcceptance, validateManifest, validateVerification } from '../../scripts/ci/release-control.mjs';
import { preserveTestedPackage } from '../../scripts/ci/tested-package.mjs';

const candidate = 'a'.repeat(40);
const repository = 'owner/repository';
const context = { repository, candidate, runId: '12', attempt: '2', sourceVersion: '0.2.51' };
const run = { id: 12, repository: { full_name: repository }, head_repository: { full_name: repository }, path: '.github/workflows/ci.yml', event: 'workflow_dispatch', head_branch: 'dev', head_sha: candidate, status: 'completed', conclusion: 'success', run_attempt: 2 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-test-'));
  const packages = [];
  for (const [name, version, filename] of [['@dsh-task/task-system', '0.2.51', 'task.tgz'], ['dsh-jev-plugin', '0.3.4', 'jev.tgz']]) {
    const source = join(root, filename + '-source');
    mkdirSync(join(source, 'package'), { recursive: true });
    writeFileSync(join(source, 'package/package.json'), JSON.stringify({ name, version }));
    execFileSync('tar', ['-czf', join(root, filename), '-C', source, 'package']);
    packages.push(preserveTestedPackage({ name, version, filename }, join(root, filename), root));
  }
  writeFileSync(join(root, 'distribution.json'), JSON.stringify({ ok: true, packages: [packages[0]] }));
  writeFileSync(join(root, 'capabilities.json'), JSON.stringify({ ok: true, packages }));
  return root;
}
function acceptance(manifest) {
  return { schemaVersion: 1, candidateSha: candidate, fullCiRunId: 12, tag: 'v0.2.51', packages: manifest.packages,
    devices: [{ id: 'fixture-device', platform: 'fixture-os', packages: [{ name: '@dsh-task/task-system', sha256: manifest.packages.find((item) => item.name === '@dsh-task/task-system').sha256 }], checks: [{ name: 'fixture-check', passed: true, evidence: 'Synthetic unit-test evidence only' }] }],
    userConfirmation: { by: 'fixture-user', confirmedAt: '2026-10-23T00:00:00Z', statement: 'Synthetic test declaration', evidence: 'Unit-test fixture; not a real release authorization' } };
}

test('release identifiers reject abbreviated SHA, shell syntax and mismatched version tags', () => {
  assert.equal(checkedSha(candidate), candidate);
  assert.throws(() => checkedSha('abc123'));
  assert.throws(() => checkedSha('$(id)'));
  assert.equal(checkedTag('v0.2.51', '0.2.51'), 'v0.2.51');
  assert.throws(() => checkedTag('v0.2.50', '0.2.51'));
  assert.throws(() => checkedTag('v0.2.51;id', '0.2.51'));
});
test('verification must be the exact successful same-repository dev dispatch and attempt', () => {
  assert.equal(validateVerification(run, context), `release-candidate-${candidate}-12-2`);
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'main' }, { event: 'pull_request' }, { conclusion: 'failure' }, { path: 'other.yml' }, { head_repository: { full_name: 'fork/repository' } }]) {
    assert.throws(() => validateVerification({ ...run, ...patch }, context));
  }
});
test('manifest binds installed archive bytes, both successful receipts and candidate package version', () => {
  const root = fixture();
  try {
    const manifest = createManifest(root, context);
    assert.equal(manifest.taskSystemVersion, '0.2.51');
    validateManifest(root, manifest, context, run);
    assert.throws(() => createManifest(root, { ...context, sourceVersion: '0.2.50' }));
    // No working-tree version lookup: promotion reads the newer candidate version as data.
    validateManifest(root, manifest, { ...context, sourceVersion: '0.2.51' }, run);
    const record = manifest.packages[0];
    const archive = join(root, 'packages', record.filename);
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('changed')]));
    assert.throws(() => createManifest(root, context), /checksum/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('duplicate package names preserve the very same bytes and reject changed repacks', () => {
  const root = fixture();
  try {
    const pack = { name: '@dsh-task/task-system', version: '0.2.51', filename: 'task.tgz' };
    preserveTestedPackage(pack, join(root, 'task.tgz'), root);
    writeFileSync(join(root, 'task.tgz'), 'different archive');
    assert.throws(() => preserveTestedPackage(pack, join(root, 'task.tgz'), root), /same tested bytes/);
    assert.throws(() => preserveTestedPackage({ ...pack, filename: '../task.tgz' }, join(root, 'task.tgz'), root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('acceptance rejects absent confirmation, failed devices, altered packages and wrong candidate', () => {
  const root = fixture();
  try {
    const manifest = createManifest(root, context);
    const receipt = acceptance(manifest);
    validateAcceptance(receipt, manifest, 'v0.2.51', 'true');
    assert.throws(() => validateAcceptance(receipt, manifest, 'v0.2.51', 'false'));
    for (const mutate of [
      (item) => { item.candidateSha = 'b'.repeat(40); },
      (item) => { item.fullCiRunId = 13; },
      (item) => { item.devices = []; },
      (item) => { item.devices[0].checks[0].passed = false; },
      (item) => { item.devices[0].packages[0].sha256 = 'wrong'; },
      (item) => { item.userConfirmation.evidence = ''; },
    ]) {
      const changed = structuredClone(receipt); mutate(changed);
      assert.throws(() => validateAcceptance(changed, manifest, 'v0.2.51', 'true'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('ordinary atomic push fast-forwards main with an annotated immutable tag; retry converges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-git-'));
  const previous = process.cwd();
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--bare', 'remote.git'); git('init', '-b', 'main', 'work');
    process.chdir(join(root, 'work'));
    const local = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    local('config', 'user.name', 'Fixture'); local('config', 'user.email', 'fixture@example.invalid');
    local('remote', 'add', 'origin', join(root, 'remote.git'));
    mkdirSync('packages/task-system', { recursive: true });
    writeFileSync('packages/task-system/package.json', JSON.stringify({ version: '0.2.50' }));
    writeFileSync('file', 'base'); local('add', '.'); local('commit', '-m', 'base');
    const base = local('rev-parse', 'HEAD'); local('push', 'origin', 'HEAD:main');
    writeFileSync('file', 'candidate');
    writeFileSync('packages/task-system/package.json', JSON.stringify({ version: '0.2.51' }));
    local('commit', '-am', 'candidate');
    const sha = local('rev-parse', 'HEAD'); local('push', 'origin', 'HEAD:dev');
    local('checkout', '--detach', base);
    assert.equal(JSON.parse(readFileSync('packages/task-system/package.json')).version, '0.2.50');
    assert.equal(candidatePackageVersion(sha), '0.2.51', 'Trusted old main reads the newer candidate manifest without checkout');
    local('checkout', '--detach', sha);
    let approved = 0;
    const options = { beforePush: async () => { approved++; } };
    const annotation = { fixture: 'Synthetic acceptance only' };
    assert.equal(await atomicPromote(sha, 'v0.2.51', annotation, options), 'promoted');
    assert.equal(approved, 1);
    assert.match(local('ls-remote', 'origin', 'refs/heads/main'), new RegExp(`^${sha}\\s`));
    assert.equal(await atomicPromote(sha, 'v0.2.51', annotation, options), 'already promoted');
    assert.equal(approved, 1);
    await assert.rejects(atomicPromote(base, 'v0.2.52', annotation, options));
    await assert.rejects(atomicPromote(sha, 'v0.2.51', { different: true }, options));
    assert.equal(approved, 1, 'Ref conflicts must be rejected before approval');
    writeFileSync('file', 'next'); local('commit', '-am', 'next');
    const next = local('rev-parse', 'HEAD');
    writeFileSync(join(root, 'remote.git/hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(atomicPromote(next, 'v0.2.52', annotation, options));
    assert.match(local('ls-remote', 'origin', 'refs/heads/main'), new RegExp(`^${sha}\\s`));
    assert.equal(local('ls-remote', 'origin', 'refs/tags/v0.2.52'), '', 'Rejected atomic transaction must create neither ref');
  } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
});
