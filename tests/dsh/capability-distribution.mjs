import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DSH_VERSION, ensureOfficialRuntime } from '../../scripts/ci/runtime-install.mjs';
import { preserveTestedPackage } from '../../scripts/ci/tested-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDirectory = resolve(process.env.DSH_CI_RESULTS_DIR ?? join(root, '.runtime/ci-results'));
const scratch = mkdtempSync(join(tmpdir(), 'dsh-capability-distribution-'));
const includeFeishu = process.argv.includes('--include-feishu') || process.env.DSH_CI_INCLUDE_FEISHU === '1';
const receipt = { ok: false, dshVersion: DSH_VERSION, scratch, packages: [], stages: [] };
const env = { ...process.env, DSH_HOME: join(scratch, 'home'), DSH_AGENTS_HOME: join(scratch, 'agents'), DSH_TELEMETRY_DISABLED: '1', XDG_DATA_HOME: join(scratch, 'data'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state'), npm_config_cache: join(scratch, 'npm-cache'), npm_config_store_dir: process.env.DSH_TEST_STORE_DIR ?? join(scratch, 'pnpm-store'), npm_config_update_notifier: 'false' };
for (const key of Object.keys(env)) if (/^(DEEPSEEK|OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|DSH_API)/.test(key)) delete env[key];
mkdirSync(join(scratch, 'workspace'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: join(scratch, 'workspace'), env, encoding: 'utf8', timeout: 180000, ...options });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const dsh = args => run(process.execPath, [bin, ...args]);
function stage(name, facts = {}) { receipt.stages.push({ name, ok: true, ...facts }); process.stderr.write(`Passed: ${name}\n`); }
function pack(directory) {
  const output = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', scratch], { cwd: join(root, 'packages', directory) }))[0];
  assert.ok(output.files.some(file => file.path.startsWith(directory === 'jev' ? 'lib/' : 'dist/')));
  receipt.packages.push({ ...preserveTestedPackage(output, join(scratch, output.filename), resultsDirectory), integrity: output.integrity });
  return join(scratch, output.filename);
}
async function boot(profile, capability, patch, absent = false) {
  const out = join(scratch, `${capability}-${absent ? 'removed' : 'boot'}.json`);
  const probePatch = join(scratch, `${capability}-${absent ? 'removed' : 'boot'}.yml`);
  const module = pathToFileURL(join(root, 'tests/dsh', absent ? 'capability-absence-probe.mjs' : 'capability-probe.mjs')).href;
  writeFileSync(probePatch, `${absent ? '' : patch}\n- insert:\n    - id: acceptance-probe\n      name: ${JSON.stringify(module)}\n`);
  const child = spawn(process.execPath, [bin, '--profile', profile, '--patch', probePatch], { cwd: join(scratch, 'workspace'), env: { ...env, DSH_TEST_CAPABILITY: capability, DSH_TASK_PROBE_OUT: out, DSH_TEST_PROFILE_DIR: join(env.DSH_HOME, 'profiles', profile) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '', exit;
  child.stderr.on('data', x => { stderr += x; }); child.stdout.on('data', x => { stdout += x; });
  const closed = new Promise(resolve => child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  try {
    const deadline = Date.now() + 45000;
    while (!exit && !existsSync(out) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(out), `${profile} failed: ${JSON.stringify(exit)}\n${stdout}\n${stderr}`);
    const facts = JSON.parse(readFileSync(out)); assert.equal(facts.ok, true);
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    await closed; clearTimeout(timeout);
    assert.equal(exit.code, 0, stderr);
    stage(`${capability}-${absent ? 'boot-after-remove' : 'real-cli-boot'}`, facts);
  } finally { if (!exit) { child.kill('SIGKILL'); await closed; } writeFileSync(join(scratch, `${capability}-${absent}.stderr.log`), stderr); }
}
let bin;
try {
  const runtime = ensureOfficialRuntime();
  bin = runtime.bin;
  receipt.runtime = runtime.root;
  receipt.includeFeishu = includeFeishu;
  stage('official-pinned-runtime');
  const jev = 'dsh-jev-plugin';
  const jevProfile = 'jev-only-acceptance';
  dsh(['plugin', '--profile', jevProfile, 'add', pack('jev')]);
  stage('jev-actual-plugin-add');
  const jevPatch = `- id: jev\n  config:\n    provider: native\n    nativeProvider: installed-offline\n    model: script\n    dailyCallLimit: 0\n    dailyTokenLimit: 0\n`;
  assert.match(dsh(['--profile', jevProfile, '--dump-config']), /dsh-jev-plugin/);
  assert.doesNotMatch(dsh(['--profile', jevProfile, '--dump-config']), /typed-decisions/);
  JSON.parse(dsh(['--profile', jevProfile, '--dump-config-schema']));
  await boot(jevProfile, 'jev', jevPatch);
  dsh(['plugin', '--profile', jevProfile, 'remove', jev]);
  assert.doesNotMatch(dsh(['--profile', jevProfile, '--dump-config']), /dsh-jev-plugin/);
  stage('jev-actual-plugin-remove');
  await boot(jevProfile, 'jev', '', true);

  const remote = '@dsh-task/task-system';
  const remoteProfile = 'remote-no-decisions-acceptance';
  dsh(['plugin', '--profile', remoteProfile, 'add', pack('task-system')]);
  stage('remote-actual-plugin-add');
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  env.DSH_TEST_PEER_KEY = join(scratch, 'test-peer-private.pem');
  writeFileSync(env.DSH_TEST_PEER_KEY, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  env.DSH_TASK_DATABASE = join(scratch, 'remote-ledger.sqlite');
  const remotePatch = `- insert:\n    - id: task-remote-execution\n      name: '@dsh-task/task-system/remote'\n      config: {}\n- id: task-system\n  config:\n    databasePath: ${JSON.stringify(env.DSH_TASK_DATABASE)}\n    role: both\n    nodeId: coordinator\n    keepAlive: true\n- id: task-remote-execution\n  config:\n    role: both\n    nodeId: coordinator\n    statePath: ${JSON.stringify(join(scratch, 'remote-recovery.sqlite'))}\n    exposeHttp: true\n    peers:\n      - keyId: probe-key\n        nodeId: probe-node\n        publicKey: ${JSON.stringify(publicKey)}\n        audience: task-coordinator\n        operations: [claim, bindSession, markRunning, submit, observe]\n        workspaces: [probe-workspace]\n        capabilities: [offline-probe]\n`;
  assert.match(dsh(['--profile', remoteProfile, '--dump-config']), /@dsh-task\/task-system/);
  JSON.parse(dsh(['--profile', remoteProfile, '--dump-config-schema']));
  await boot(remoteProfile, 'remote', remotePatch);
  dsh(['plugin', '--profile', remoteProfile, 'remove', remote]);
  assert.doesNotMatch(dsh(['--profile', remoteProfile, '--dump-config']), /@dsh-task\/task-system/);
  assert.ok(existsSync(join(scratch, 'remote-recovery.sqlite')));
  const recovery = new DatabaseSync(join(scratch, 'remote-recovery.sqlite'), { readOnly: true });
  try {
    assert.ok(recovery.prepare("SELECT COUNT(*) AS count FROM commands WHERE state='done'").get().count >= 5, 'removal retains authenticated command receipts');
  } finally { recovery.close(); }
  stage('remote-actual-plugin-remove-retains-recovery');
  await boot(remoteProfile, 'remote', '', true);
  if (includeFeishu) {
    const feishu = '@dsh-task/feishu-channel';
    const feishuProfile = 'feishu-standalone-acceptance';
    dsh(['plugin', '--profile', feishuProfile, 'add', '--allow-build=protobufjs', pack('feishu-channel')]);
    stage('feishu-actual-plugin-add');
    assert.match(dsh(['--profile', feishuProfile, '--dump-config']), /@dsh-task\/feishu-channel\/plugin/);
    JSON.parse(dsh(['--profile', feishuProfile, '--dump-config-schema']));
    await boot(feishuProfile, 'feishu', `- insert:\n    - id: installed-feishu-native-chat\n      name: '@dsh-task/feishu-channel/dsh-chat'\n      config:\n        enabled: false\n`);
    dsh(['plugin', '--profile', feishuProfile, 'remove', feishu]);
    assert.doesNotMatch(dsh(['--profile', feishuProfile, '--dump-config']), /@dsh-task\/feishu-channel\/plugin/);
    stage('feishu-actual-plugin-remove');
    await boot(feishuProfile, 'feishu', '', true);
  }
  receipt.ok = true;
} catch (error) { receipt.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(join(resultsDirectory, 'capabilities.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}
