import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const workflowPath = '.github/workflows/ci.yml';
export const fullContext = 'Full CI';
export const releaseContext = 'Release approved';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function checkedSha(value) {
  assert.match(value ?? '', /^[a-f0-9]{40}$/, 'A complete lowercase commit SHA is required');
  return value;
}
export function checkedId(value) {
  assert.match(String(value ?? ''), /^[1-9][0-9]*$/, 'A positive run ID is required');
  assert.ok(Number.isSafeInteger(Number(value)), 'Run ID is outside the supported range');
  return Number(value);
}
export function checkedTag(value, version) {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version ?? '');
  assert.ok(parts, 'Invalid package version');
  for (const identifier of parts[4]?.split('.') ?? []) assert.ok(!/^0[0-9]+$/.test(identifier), 'Invalid numeric prerelease version');
  assert.equal(value, `v${version}`, 'Tag must match the tested task-system package version');
  return value;
}
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function candidatePackageVersion(candidate) {
  return JSON.parse(git('show', `${checkedSha(candidate)}:packages/task-system/package.json`)).version;
}
function ancestor(oldSha, newSha) {
  execFileSync('git', ['merge-base', '--is-ancestor', checkedSha(oldSha), checkedSha(newSha)]);
}
function packageRecords(directory) {
  const records = readdirSync(join(directory, 'packages')).filter((name) => name.endsWith('.tgz.json')).map((name) => json(join(directory, 'packages', name)));
  assert.ok(records.length >= 2, 'Both task-system and JEV tested archives are required');
  for (const record of records) {
    assert.equal(record.filename, basename(record.filename));
    assert.match(record.filename, /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/);
    const archive = join(directory, 'packages', record.filename);
    assert.equal(sha256(readFileSync(archive)), record.sha256, 'Tested archive checksum mismatch');
    const packed = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    assert.equal(packed.name, record.name);
    assert.equal(packed.version, record.version);
  }
  const task = records.find((record) => record.name === '@dsh-task/task-system');
  assert.ok(task, 'Missing tested task-system archive');
  assert.ok(records.some((record) => record.name === 'dsh-jev-plugin'), 'Missing tested JEV archive');
  assert.equal(new Set(records.map((record) => record.name)).size, records.length, 'Duplicate package records');
  for (const name of ['distribution', 'capabilities']) {
    const receipt = json(join(directory, `${name}.json`));
    assert.equal(receipt.ok, true, `${name} acceptance did not succeed`);
    assert.ok(receipt.packages?.length, `${name} has no tested package records`);
    for (const installed of receipt.packages) {
      const preserved = records.find((record) => record.name === installed.name);
      assert.ok(preserved, 'Installed package archive was not preserved');
      for (const key of ['name', 'version', 'filename', 'sha256']) assert.equal(installed[key], preserved[key], `Installed ${key} mismatch`);
    }
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}
export function createManifest(directory, context) {
  const packages = packageRecords(directory);
  const task = packages.find((record) => record.name === '@dsh-task/task-system');
  if (context.sourceVersion) assert.equal(task.version, context.sourceVersion, 'Tested archive version differs from candidate source');
  return {
    schemaVersion: 1, repository: context.repository, candidateSha: checkedSha(context.candidate),
    runId: checkedId(context.runId), runAttempt: checkedId(context.attempt), workflowPath,
    taskSystemVersion: task.version, packages,
    receipts: Object.fromEntries(['distribution', 'capabilities'].map((name) => [`${name}.json`, sha256(readFileSync(join(directory, `${name}.json`)))])),
  };
}
export function validateVerification(run, { repository, candidate, runId }) {
  assert.equal(run.id, checkedId(runId));
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.path, workflowPath);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'dev');
  assert.equal(run.head_sha, checkedSha(candidate));
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success', 'Full CI run must have completed successfully');
  checkedId(run.run_attempt);
  return `release-candidate-${candidate}-${run.id}-${run.run_attempt}`;
}
export function validateAcceptance(receipt, manifest, tag, confirmed) {
  assert.equal(confirmed, 'true', 'Explicit workflow confirmation is required');
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.candidateSha, manifest.candidateSha);
  assert.equal(receipt.fullCiRunId, manifest.runId);
  assert.equal(receipt.tag, checkedTag(tag, manifest.taskSystemVersion));
  assert.deepEqual(receipt.packages, manifest.packages, 'Acceptance must name the exact tested package bytes');
  assert.ok(Array.isArray(receipt.devices) && receipt.devices.length > 0, 'Declare the intended device scope and actual results');
  const names = new Set();
  for (const device of receipt.devices) {
    assert.ok(typeof device.id === 'string' && device.id.trim());
    assert.ok(!names.has(device.id), 'Duplicate device'); names.add(device.id);
    assert.ok(typeof device.platform === 'string' && device.platform.trim());
    assert.ok(Array.isArray(device.packages) && device.packages.length > 0);
    assert.ok(device.packages.some((item) => item.name === '@dsh-task/task-system'), 'Each declared device must test task-system');
    for (const installed of device.packages) {
      const tested = manifest.packages.find((item) => item.name === installed.name);
      assert.ok(tested && installed.sha256 === tested.sha256, 'Device used an untested package');
    }
    assert.ok(Array.isArray(device.checks) && device.checks.length > 0);
    for (const check of device.checks) {
      assert.equal(check.passed, true, 'Every declared device check must pass');
      assert.ok(typeof check.name === 'string' && check.name.trim());
      assert.ok(typeof check.evidence === 'string' && check.evidence.trim(), 'Device evidence is required');
    }
  }
  const confirmation = receipt.userConfirmation;
  for (const key of ['by', 'statement', 'evidence']) assert.ok(typeof confirmation?.[key] === 'string' && confirmation[key].trim(), `User confirmation ${key} is required`);
  assert.ok(Number.isFinite(Date.parse(confirmation.confirmedAt)), 'User confirmation timestamp is required');
}
export function validateManifest(directory, manifest, context, run) {
  const actual = createManifest(directory, { ...context, attempt: run.run_attempt });
  assert.deepEqual(manifest, actual, 'Candidate manifest is inconsistent with the immutable verification artifact');
}
export async function atomicPromote(candidate, tag, annotation, { remote = 'origin', beforePush = async () => {} } = {}) {
  checkedSha(candidate);
  assert.match(tag, /^v[0-9A-Za-z.+-]+$/);
  const lines = git('ls-remote', remote, 'refs/heads/main', `refs/tags/${tag}`, `refs/tags/${tag}^{}`).split('\n').filter(Boolean);
  const refs = new Map(lines.map((line) => { const [sha, ref] = line.split(/\s+/); return [ref, sha]; }));
  const main = refs.get('refs/heads/main');
  assert.ok(main, 'Remote main is missing');
  if (refs.has(`refs/tags/${tag}`)) {
    git('fetch', '--no-tags', remote, `refs/tags/${tag}`);
    assert.equal(git('rev-parse', 'FETCH_HEAD^{}'), candidate, 'Version tag already identifies another candidate');
    assert.equal(git('cat-file', '-t', 'FETCH_HEAD'), 'tag', 'Existing version tag is not annotated');
    const body = git('cat-file', '-p', 'FETCH_HEAD').split('\n\n').slice(1).join('\n\n');
    assert.deepEqual(JSON.parse(body), annotation, 'Version tag already has a different acceptance record');
    ancestor(candidate, main);
    return 'already promoted';
  }
  ancestor(main, candidate);
  const local = `refs/tags/${tag}`;
  assert.equal(git('tag', '--list', tag), '', 'Local version tag already exists');
  await beforePush();
  git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'tag', '-a', tag, candidate, '-m', JSON.stringify(annotation));
  try {
    git('push', '--atomic', remote, `${candidate}:refs/heads/main`, `${local}:${local}`);
  } finally {
    git('tag', '-d', tag);
  }
  return 'promoted';
}

async function main(command) {
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const context = { repository, candidate: checkedSha(env.CANDIDATE_SHA), runId: env.VERIFICATION_RUN_ID || env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT };
  const endpoint = `https://api.github.com/repos/${repository}`;
  async function api(path, method = 'GET', body) {
    const response = await fetch(`${endpoint}${path}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `GitHub ${method} ${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function status(state, statusContext, description, runId = env.GITHUB_RUN_ID) {
    await api(`/statuses/${context.candidate}`, 'POST', { state, context: statusContext, description,
      target_url: `https://github.com/${repository}/actions/runs/${checkedId(runId)}` });
  }
  const directory = resolve(env.RELEASE_DIRECTORY || '.runtime/release-candidate');
  if (command === 'prepare') {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(env.GITHUB_REF, 'refs/heads/dev', 'Verification must be dispatched on dev');
    assert.equal(env.GITHUB_SHA, context.candidate, 'Dispatch ref must identify the exact candidate');
    git('fetch', '--no-tags', 'origin', 'main', 'dev');
    assert.equal(git('rev-parse', 'origin/dev'), context.candidate, 'Candidate must be dev head when verification starts');
    ancestor(git('rev-parse', 'origin/main'), context.candidate);
    await status('pending', fullContext, 'Full candidate verification is running');
  } else if (command === 'manifest') {
    assert.equal(env.VERIFY_RESULTS, 'success,success,success,success,success', 'Every complete CI job must succeed');
    const manifest = createManifest(directory, { ...context, sourceVersion: json('packages/task-system/package.json').version });
    writeFileSync(join(directory, 'candidate.json'), JSON.stringify(manifest, null, 2) + '\n');
  } else if (command === 'full-status') {
    const success = env.FULL_RESULT === 'success';
    await status(success ? 'success' : 'failure', fullContext, success ? 'Complete Linux/macOS CI and tested packages passed' : 'Complete candidate verification failed');
  } else if (command === 'resolve') {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Promotion must execute the trusted main workflow');
    assert.ok(env.GITHUB_WORKFLOW_REF?.endsWith(`${workflowPath}@refs/heads/main`));
    const run = await api(`/actions/runs/${checkedId(context.runId)}`);
    const name = validateVerification(run, context);
    const artifacts = await api(`/actions/runs/${run.id}/artifacts?per_page=100`);
    const matches = artifacts.artifacts.filter((item) => item.name === name && !item.expired);
    assert.equal(matches.length, 1, 'One immutable candidate artifact from the successful attempt is required');
    appendFileSync(env.GITHUB_OUTPUT, `artifact_id=${matches[0].id}\n`);
    writeFileSync('.runtime-verified-run.json', JSON.stringify(run));
  } else if (command === 'promote') {
    assert.equal(env.GITHUB_REF, 'refs/heads/main');
    assert.ok(env.GITHUB_WORKFLOW_REF?.endsWith(`${workflowPath}@refs/heads/main`));
    const run = json('.runtime-verified-run.json');
    validateVerification(run, context);
    git('fetch', '--no-tags', 'origin', 'main', 'dev');
    const manifest = json(join(directory, 'candidate.json'));
    const sourceVersion = candidatePackageVersion(context.candidate);
    validateManifest(directory, manifest, { ...context, sourceVersion }, run);
    const acceptance = JSON.parse(env.ACCEPTANCE_JSON);
    validateAcceptance(acceptance, manifest, env.RELEASE_TAG, env.RELEASE_CONFIRM);
    git('fetch', '--no-tags', 'origin', 'main', 'dev');
    ancestor(context.candidate, git('rev-parse', 'origin/dev'));
    const annotation = { schemaVersion: 1, manifest, acceptance };
    console.log(await atomicPromote(context.candidate, checkedTag(env.RELEASE_TAG, manifest.taskSystemVersion), annotation, {
      beforePush: async () => {
        await status('success', releaseContext, 'Explicit device acceptance and user confirmation recorded');
        writeFileSync(join(directory, 'release-annotation.json'), JSON.stringify(annotation, null, 2) + '\n');
      },
    }));
  } else throw new Error('Unknown release control operation');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2]);
