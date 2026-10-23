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
export function createReleaseRecord(manifest, input, operator) {
  assert.equal(input.confirmed, 'true', 'Explicit workflow confirmation is required');
  const text = (value, name, limit) => {
    assert.ok(typeof value === 'string' && value.trim(), `${name} is required`);
    assert.ok(Buffer.byteLength(value, 'utf8') <= limit, `${name} is too long`);
    return value.trim();
  };
  const summary = text(input.summary, 'Acceptance summary', 240);
  assert.ok(!/[\r\n\x00-\x1f\x7f]/.test(summary), 'Acceptance summary must be one line');
  const report = text(input.report, 'Detailed acceptance record', 40000);
  const userConfirmation = text(input.userConfirmation, 'Actual user confirmation evidence', 8000);
  for (const name of ['actor', 'triggeringActor', 'workflowRef']) assert.ok(typeof operator[name] === 'string' && operator[name]);
  return {
    schemaVersion: 2, manifest,
    acceptance: { summary, report, userConfirmation, confirmed: true },
    operator: { actor: operator.actor, triggeringActor: operator.triggeringActor, workflowRef: operator.workflowRef,
      runId: checkedId(operator.runId), runAttempt: checkedId(operator.runAttempt) },
  };
}
export function shortTagMessage(record) {
  return `${record.acceptance.summary}\n\nCI: https://github.com/${record.manifest.repository}/actions/runs/${checkedId(record.manifest.runId)}`;
}
export function releaseRecordName(candidate, runId, attempt) {
  return `release-record-${checkedSha(candidate)}-${checkedId(runId)}-${checkedId(attempt)}`;
}
export function validateUploadedRecord(artifact, { candidate, runId, attempt, digest }) {
  assert.ok(artifact, 'Detailed release record has not been uploaded');
  assert.equal(artifact.name, releaseRecordName(candidate, runId, attempt));
  assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run?.id, checkedId(runId));
  assert.ok(artifact.size_in_bytes > 0);
  assert.match(digest ?? '', /^[a-f0-9]{64}$/, 'Artifact upload digest is required');
  assert.equal(artifact.digest, `sha256:${digest}`, 'Uploaded release record digest mismatch');
}
export function validateManifest(directory, manifest, context, run) {
  const actual = createManifest(directory, { ...context, attempt: run.run_attempt });
  assert.deepEqual(manifest, actual, 'Candidate manifest is inconsistent with the immutable verification artifact');
}
export async function atomicPromote(candidate, tag, tagMessage, { remote = 'origin', beforePush = async () => {} } = {}) {
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
    const tagged = execFileSync('git', ['cat-file', '-p', 'FETCH_HEAD'], { encoding: 'utf8' });
    const body = tagged.split('\n\n').slice(1).join('\n\n').replace(/\n$/, '');
    assert.equal(body, tagMessage, 'Version tag already has a different acceptance summary or CI link');
    ancestor(candidate, main);
    return 'already promoted';
  }
  ancestor(main, candidate);
  const local = `refs/tags/${tag}`;
  assert.equal(git('tag', '--list', tag), '', 'Local version tag already exists');
  await beforePush();
  git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'tag', '--cleanup=verbatim', '-a', tag, candidate, '-m', tagMessage + '\n');
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
  } else if (command === 'record' || command === 'promote') {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(env.GITHUB_REF, 'refs/heads/main');
    assert.ok(env.GITHUB_WORKFLOW_REF?.endsWith(`${workflowPath}@refs/heads/main`));
    const run = json('.runtime-verified-run.json');
    validateVerification(run, context);
    git('fetch', '--no-tags', 'origin', 'main', 'dev');
    const manifest = json(join(directory, 'candidate.json'));
    const sourceVersion = candidatePackageVersion(context.candidate);
    validateManifest(directory, manifest, { ...context, sourceVersion }, run);
    ancestor(context.candidate, git('rev-parse', 'origin/dev'));
    const record = createReleaseRecord(manifest, {
      summary: env.ACCEPTANCE_SUMMARY, report: env.ACCEPTANCE_RECORD,
      userConfirmation: env.USER_CONFIRMATION, confirmed: env.RELEASE_CONFIRM,
    }, { actor: env.GITHUB_ACTOR, triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
      workflowRef: env.GITHUB_WORKFLOW_REF, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT });
    const tagMessage = shortTagMessage(record);
    const tag = checkedTag(`v${manifest.taskSystemVersion}`, manifest.taskSystemVersion);
    if (command === 'record') {
      writeFileSync(join(directory, 'release-record.json'), JSON.stringify(record, null, 2) + '\n');
      writeFileSync(join(directory, 'tag-message.txt'), tagMessage + '\n');
    } else {
      assert.deepEqual(json(join(directory, 'release-record.json')), record, 'Detailed record changed after upload');
      assert.equal(readFileSync(join(directory, 'tag-message.txt'), 'utf8'), tagMessage + '\n', 'Tag text changed after upload');
      const artifacts = await api(`/actions/runs/${checkedId(env.GITHUB_RUN_ID)}/artifacts?per_page=100`);
      const artifact = artifacts.artifacts.find((item) => item.id === checkedId(env.UPLOADED_RECORD_ID));
      validateUploadedRecord(artifact, { candidate: context.candidate, runId: env.GITHUB_RUN_ID,
        attempt: env.GITHUB_RUN_ATTEMPT, digest: env.UPLOADED_RECORD_DIGEST });
      console.log(await atomicPromote(context.candidate, tag, tagMessage, {
        beforePush: () => status('success', releaseContext, 'Detailed acceptance artifact stored; user confirmation recorded'),
      }));
    }
  } else throw new Error('Unknown release control operation');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2]);
