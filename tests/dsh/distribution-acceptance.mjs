import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DSH_VERSION, ensureOfficialRuntime } from '../../scripts/ci/runtime-install.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDirectory = resolve(process.env.DSH_CI_RESULTS_DIR ?? join(root, '.runtime/ci-results'));
const scratch = mkdtempSync(join(tmpdir(), 'dsh-task-distribution-'));
const receipt = { ok: false, dshVersion: DSH_VERSION, node: process.version, scratch, stages: [] };
const env = {
  ...process.env,
  DSH_HOME: join(scratch, 'home'), DSH_AGENTS_HOME: join(scratch, 'agents'),
  DSH_TELEMETRY_DISABLED: '1', DSH_TASK_DATABASE: join(scratch, 'state', 'tasks.sqlite'),
  XDG_DATA_HOME: join(scratch, 'xdg-data'), XDG_CACHE_HOME: join(scratch, 'xdg-cache'), XDG_STATE_HOME: join(scratch, 'xdg-state'),
  npm_config_store_dir: process.env.DSH_TEST_STORE_DIR ?? join(scratch, 'pnpm-store'),
  npm_config_cache: join(scratch, 'npm-cache'),
  npm_config_update_notifier: 'false',
};
for (const key of Object.keys(env)) if (/^(DEEPSEEK|OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|DSH_API)/.test(key)) delete env[key];
mkdirSync(join(scratch, 'workspace'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 180000, ...options });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function stage(name, detail = {}) { receipt.stages.push({ name, ok: true, ...detail }); process.stderr.write(`Passed: ${name}\n`); }
try {
  const { root: runtime, bin: dshBin } = ensureOfficialRuntime();
  receipt.runtime = runtime;
  stage('official-pinned-runtime');
  const dsh = args => run(process.execPath, [dshBin, ...args], { cwd: join(scratch, 'workspace') });
  const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', scratch], { cwd: join(root, 'packages/task-system') }))[0];
  const tarball = join(scratch, pack.filename);
  assert.ok(pack.files.some(file => file.path === 'dist/dsh-plugin.js'));
  assert.ok(pack.files.some(file => file.path === 'dsh.bundle.yml'));
  assert.ok(pack.files.some(file => file.path === 'dist/task-pack/plugin.mjs'));
  assert.ok(pack.files.some(file => file.path === 'dist/task-pack/activity/plugin.mjs'));
  assert.ok(!pack.files.some(file => file.path.startsWith('src/')));
  stage('built-tarball', { filename: pack.filename, integrity: pack.integrity });
  const profile = 'task-native-acceptance';
  dsh(['plugin', '--profile', profile, 'add', tarball]);
  const profileDir = join(env.DSH_HOME, 'profiles', profile);
  let manifest = JSON.parse(readFileSync(join(profileDir, 'package.json')));
  assert.ok(manifest.dsh.profile.bundles.includes('@dsh-task/task-system'));
  assert.ok(manifest.dependencies['@dsh-task/task-system']);
  stage('actual-plugin-add');
  const dump = dsh(['--profile', profile, '--dump-config']);
  assert.match(dump, /@dsh-task\/task-system\/plugin/);
  assert.doesNotMatch(dump, /headless-runner/);
  writeFileSync(join(scratch, 'composed.yml'), dump);
  stage('persistent-base-backed-composition');
  const schema = JSON.parse(dsh(['--profile', profile, '--dump-config-schema']));
  assert.ok(JSON.stringify(schema).includes('databasePath'));
  writeFileSync(join(scratch, 'config-schema.json'), JSON.stringify(schema, null, 2));
  stage('native-config-schema');

  async function boot(role, absent = false) {
    const out = join(scratch, `probe-${role}.json`);
    const probeModule = pathToFileURL(join(root, 'tests/dsh', absent ? 'cli-absence-probe.mjs' : 'cli-probe.mjs')).href;
    const probePatch = join(scratch, `probe-${role}.yml`);
    writeFileSync(probePatch, `${absent ? '' : `${role === 'both' ? `- id: task-system\n  config:\n    databasePath: ${JSON.stringify(env.DSH_TASK_DATABASE)}\n    nodeId: local\n    role: both\n    executionAgentPreset: ci-offline\n    keepAlive: true\n    executionTools: [legacy_report_prepare, activity_sources_read, activity_report_prepare]\n    trustedUnconfinedTools: true\n` : ''}- insert:\n    - id: acceptance-preset-registry\n      name: '@deepseek-ai/dsh-agent-preset-registry'\n      config:\n        default: ci-offline\n    - id: acceptance-preset\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: ci-offline\n        plugins: []\n    - id: installed-legacy-task-pack\n      name: '@dsh-task/task-system/task-pack/plugin'\n      config:\n        artifactDirectory: ${JSON.stringify(join(scratch, 'native-artifacts'))}\n    - id: installed-activity-reports\n      name: '@dsh-task/task-system/activity/plugin'\n      config: {}\n    - id: installed-quota-monitor\n      name: '@dsh-task/task-system/task-pack/quota/plugin'\n      config:\n        enabled: false\n    - id: installed-native-approval-bridge\n      name: '@dsh-task/task-system/approval-bridge'\n      config:\n        enabled: false\n`}\n- insert:\n    - id: acceptance-probe\n      name: ${JSON.stringify(probeModule)}\n`);
    const args = [dshBin, '--profile', profile];
    if (!absent) args.push('--patch', join(root, 'profiles', `${role}.patch.yml`));
    args.push('--patch', probePatch);
    const child = spawn(process.execPath, args, { cwd: join(scratch, 'workspace'), env: { ...env, DSH_TASK_PROBE_OUT: out, DSH_TEST_PROFILE_DIR: profileDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exit;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }));
    try {
      const deadline = Date.now() + 45000;
      while (!existsSync(out) && !exit && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(existsSync(out), `probe absent: ${JSON.stringify(exit)}\n${stdout}\n${stderr}`);
      const result = JSON.parse(readFileSync(out));
      assert.equal(result.ok, true);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(exit, undefined, 'persistent host must remain alive after finite probe');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
      await closed;
      clearTimeout(timeout);
      assert.equal(exit.code, 0, `supervisor SIGTERM must drain cleanly: ${stderr}`);
      stage(absent ? 'boot-after-removal' : `boot-${role}-persistent-and-dispose`, result);
    } finally {
      if (!exit) { child.kill('SIGKILL'); await closed; }
      writeFileSync(join(scratch, `boot-${role}.stderr.log`), stderr);
    }
  }
  await boot('both');
  await boot('planner');
  await boot('executor');
  dsh(['plugin', '--profile', profile, 'remove', '@dsh-task/task-system']);
  manifest = JSON.parse(readFileSync(join(profileDir, 'package.json')));
  assert.ok(!manifest.dsh.profile.bundles.includes('@dsh-task/task-system'));
  assert.equal(manifest.dependencies?.['@dsh-task/task-system'], undefined);
  assert.ok(existsSync(env.DSH_TASK_DATABASE));
  const retained = new DatabaseSync(env.DSH_TASK_DATABASE, { readOnly: true });
  try {
    const task = JSON.parse(retained.prepare("SELECT data FROM entities WHERE kind='task' AND id=?").get('cli-retained-task').data);
    assert.equal(task.title, 'Installed tarball persisted task');
    assert.ok(retained.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind='report'").get().count >= 3, 'removal retains original and native execution reports');
  } finally { retained.close(); }
  assert.doesNotMatch(dsh(['--profile', profile, '--dump-config']), /@dsh-task\/task-system\/plugin/);
  stage('actual-plugin-remove-retains-data');
  await boot('removed', true);
  receipt.ok = true;
} catch (error) {
  receipt.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(join(resultsDirectory, 'distribution.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}
