import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = mkdtempSync(join(tmpdir(), 'dsh-capability-distribution-'));
const runtime = resolve(process.env.DSH_TEST_RUNTIME_DIR ?? join(scratch, 'runtime'));
const receipt = { ok: false, dshVersion: '0.2.0-rc.2', scratch, packages: [], stages: [] };
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
  assert.ok(output.files.some(file => file.path.startsWith('dist/')));
  receipt.packages.push({ name: output.name, filename: output.filename, integrity: output.integrity });
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
  mkdirSync(runtime, { recursive: true });
  if (!existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))) {
    run('pnpm', ['--dir', runtime, 'add', '--save-exact', '--reporter=append-only', '--allow-build=@deepseek-ai/dsh-subprocess-local', '--allow-build=@google/genai', '--allow-build=koffi', '--allow-build=node-pty', '--allow-build=protobufjs', '@deepseek-ai/dsh@0.2.0-rc.2'], { timeout: 300000 });
  }
  const require = createRequire(join(runtime, 'package.json'));
  const dshPackage = require.resolve('@deepseek-ai/dsh/package.json');
  assert.equal(JSON.parse(readFileSync(dshPackage)).version, '0.2.0-rc.2');
  bin = join(dirname(dshPackage), 'lib/bin.js');
  stage('official-pinned-runtime');
  const typed = '@dsh-task/typed-decisions';
  const typedProfile = 'typed-only-acceptance';
  dsh(['plugin', '--profile', typedProfile, 'add', pack('typed-decisions')]);
  stage('typed-actual-plugin-add');
  const typedPatch = `- id: task-typed-decisions\n  config:\n    defaultProvider: rules\n    providers:\n      - id: rules\n        kind: rules\n        rulesVersion: '1'\n        rules:\n          - questionId: persist\n            questionVersion: '1'\n            path: [approved]\n            equals: true\n            answer: { type: noul, noul: 1 }\n`;
  assert.match(dsh(['--profile', typedProfile, '--dump-config']), /@dsh-task\/typed-decisions/);
  JSON.parse(dsh(['--profile', typedProfile, '--dump-config-schema']));
  await boot(typedProfile, 'typed', typedPatch + `- insert:\n    - id: installed-ordinary-completion\n      name: '@dsh-task/typed-decisions/dsh-completion'\n      config:\n        routes:\n          - model: offline-judge\n            modelVersion: script\n            provider: installed-offline\n            reasoningEfforts: []\n        maxOutputTokens: 256\n        maxInputBytes: 16384\n        maxOutputBytes: 16384\n        maxRuntimeMs: 2000\n        maxConcurrent: 1\n`);
  dsh(['plugin', '--profile', typedProfile, 'remove', typed]);
  assert.doesNotMatch(dsh(['--profile', typedProfile, '--dump-config']), /@dsh-task\/typed-decisions/);
  stage('typed-actual-plugin-remove');
  await boot(typedProfile, 'typed', '', true);

  const remote = '@dsh-task/task-system';
  const remoteProfile = 'remote-no-decisions-acceptance';
  dsh(['plugin', '--profile', remoteProfile, 'add', pack('task-system')]);
  stage('remote-actual-plugin-add');
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  env.DSH_TEST_PEER_KEY = join(scratch, 'test-peer-private.pem');
  writeFileSync(env.DSH_TEST_PEER_KEY, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  env.DSH_TASK_DATABASE = join(scratch, 'remote-ledger.sqlite');
  const remotePatch = `- insert:\n    - id: task-remote-execution\n      name: '@dsh-task/task-system/remote'\n      config: {}\n- id: task-system\n  config:\n    databasePath: ${JSON.stringify(env.DSH_TASK_DATABASE)}\n    role: both\n    nodeId: coordinator\n    keepAlive: true\n- id: task-remote-execution\n  config:\n    role: both\n    nodeId: coordinator\n    statePath: ${JSON.stringify(join(scratch, 'remote-recovery.sqlite'))}\n    exposeHttp: false\n    peers:\n      - keyId: probe-key\n        nodeId: probe-node\n        publicKey: ${JSON.stringify(publicKey)}\n        audience: task-coordinator\n        operations: [claim, bindSession, markRunning, submit, observe]\n        workspaces: [probe-workspace]\n        capabilities: [offline-probe]\n`;
  assert.match(dsh(['--profile', remoteProfile, '--dump-config']), /@dsh-task\/task-system/);
  JSON.parse(dsh(['--profile', remoteProfile, '--dump-config-schema']));
  await boot(remoteProfile, 'remote', remotePatch);
  dsh(['plugin', '--profile', remoteProfile, 'remove', remote]);
  assert.doesNotMatch(dsh(['--profile', remoteProfile, '--dump-config']), /@dsh-task\/task-system/);
  assert.ok(existsSync(join(scratch, 'remote-recovery.sqlite')));
  stage('remote-actual-plugin-remove-retains-recovery');
  await boot(remoteProfile, 'remote', '', true);
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
  receipt.ok = true;
} catch (error) { receipt.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  mkdirSync(join(root, 'tests/dsh/results'), { recursive: true });
  writeFileSync(join(root, 'tests/dsh/results/capabilities.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}
