import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const results = join(root, 'tests/dsh/results');
const scratch = mkdtempSync(join(tmpdir(), 'dsh-upgrade-distribution-'));
const runtime = resolve(process.env.DSH_TEST_RUNTIME_DIR ?? join(scratch, 'runtime'));
const baselineDirectory = process.env.DSH_TEST_BASELINE_DIR && resolve(process.env.DSH_TEST_BASELINE_DIR);
const finalManifest = JSON.parse(readFileSync(join(results, 'final-pack-integrities.json')));
const names = ['task-system', 'typed-decisions', 'remote-execution', 'feishu-channel'];
const expectedVersions = { 'task-system': '0.1.1', 'typed-decisions': '0.1.0', 'remote-execution': '0.1.1', 'feishu-channel': '0.1.1' };
const receipt = { ok: false, dshVersion: '0.2.0-rc.2', node: process.version, scratch, baselinePackages: [], finalPackages: [], stages: [], privateRegistryRequests: [] };
const env = { ...process.env, DSH_HOME: join(scratch, 'home'), DSH_AGENTS_HOME: join(scratch, 'agents'), DSH_TELEMETRY_DISABLED: '1', XDG_DATA_HOME: join(scratch, 'data'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state'), npm_config_cache: join(scratch, 'npm-cache'), npm_config_store_dir: process.env.DSH_TEST_STORE_DIR ?? join(scratch, 'pnpm-store'), npm_config_update_notifier: 'false', npm_config_fetch_retries: '0' };
for (const key of Object.keys(env)) if (/^(DEEPSEEK|OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|DSH_API|DSH_FEISHU|TYPESAFE_API)/.test(key)) delete env[key];
mkdirSync(join(scratch, 'workspace'));
const profile = 'four-package-upgrade-acceptance';
const profileDir = join(env.DSH_HOME, 'profiles', profile);
const databasePath = join(scratch, 'tasks.sqlite');
const recoveryPath = join(scratch, 'remote-recovery.sqlite');
let bin, registryServer, runNumber = 0;
function stage(name, facts = {}) { receipt.stages.push({ name, ok: true, ...facts }); process.stderr.write(`Passed: ${name}\n`); }
function fingerprint(path) {
  const bytes = readFileSync(path);
  return { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
async function run(command, args, options = {}) {
  const label = `${++runNumber}-${command === process.execPath ? 'dsh' : command}`;
  const child = spawn(command, args, { cwd: join(scratch, 'workspace'), env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out`)); }, 240000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  writeFileSync(join(scratch, `${label}.stdout.log`), stdout);
  writeFileSync(join(scratch, `${label}.stderr.log`), stderr);
  assert.equal(result.code, 0, `${command} ${args.join(' ')} failed (${result.signal}):\n${stdout}\n${stderr}`);
  assert.doesNotMatch(stdout + stderr, /ERR_PNPM_FETCH_404|ERR_PNPM_PEER_DEP_ISSUES|unmet peer @dsh-task/i);
  return stdout;
}
const dsh = args => run(process.execPath, [bin, ...args]);
function checkManifest(versions) {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json')));
  const installed = {};
  for (const name of names) {
    const id = `@dsh-task/${name}`;
    assert.equal(manifest.dsh.profile.bundles.filter(bundle => bundle === id).length, 1, `${id} bundle must appear exactly once`);
    assert.match(manifest.dependencies[id], /^file:/, `${id} must retain its local tarball dependency`);
    installed[name] = JSON.parse(readFileSync(join(profileDir, 'node_modules', id, 'package.json'))).version;
    assert.equal(installed[name], versions[name]);
  }
  assert.equal(receipt.privateRegistryRequests.length, 0, 'local tarball upgrades must never resolve private-scope registry packages');
  return { installed, dependencies: manifest.dependencies, bundles: manifest.dsh.profile.bundles };
}
async function boot(phase, instanceId) {
  const out = join(scratch, `boot-${phase}.json`);
  const child = spawn(process.execPath, [bin, '--profile', profile, '--patch', join(scratch, 'upgrade.patch.yml')], { cwd: join(scratch, 'workspace'), env: { ...env, DSH_TASK_PROBE_OUT: out, DSH_UPGRADE_PHASE: phase, DSH_UPGRADE_RECOVERY: recoveryPath, DSH_UPGRADE_STORE_ID: instanceId }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exit;
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => { child.once('error', error => { exit = { error: String(error) }; resolve(exit); }); child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); }); });
  try {
    const deadline = Date.now() + 45000;
    while (!existsSync(out) && !exit && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(existsSync(out), `${phase} probe absent: ${JSON.stringify(exit)}\n${stdout}\n${stderr}`);
    const facts = JSON.parse(readFileSync(out)); assert.equal(facts.ok, true);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(exit, undefined, 'combined installed host must remain alive');
    child.kill('SIGTERM'); const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    await closed; clearTimeout(timeout);
    assert.equal(exit.code, 0, `combined host must drain cleanly: ${stderr}`);
    stage(`boot-${phase}-retains-state`, facts);
  } finally {
    if (!exit) { child.kill('SIGKILL'); await closed; }
    writeFileSync(join(scratch, `boot-${phase}.stdout.log`), stdout); writeFileSync(join(scratch, `boot-${phase}.stderr.log`), stderr);
  }
}
try {
  assert.equal(finalManifest.ok, true);
  assert.ok(baselineDirectory, 'DSH_TEST_BASELINE_DIR must select the preserved original 0.1.0 tarballs');
  const requireRuntime = createRequire(join(runtime, 'package.json'));
  const runtimePackage = requireRuntime.resolve('@deepseek-ai/dsh/package.json');
  assert.equal(JSON.parse(readFileSync(runtimePackage)).version, receipt.dshVersion);
  bin = join(dirname(runtimePackage), 'lib/bin.js');
  stage('official-pinned-runtime');
  const baseline = {}, current = {};
  for (const name of names) {
    const id = `@dsh-task/${name}`;
    baseline[name] = join(baselineDirectory, `dsh-task-${name}-0.1.0.tgz`);
    receipt.baselinePackages.push({ name: id, filename: `dsh-task-${name}-0.1.0.tgz`, ...fingerprint(baseline[name]) });
    const selected = finalManifest.packages.find(item => item.name === id);
    assert.ok(selected); assert.equal(selected.filename, `dsh-task-${name}-${expectedVersions[name]}.tgz`);
    current[name] = join(results, 'final-packages', selected.filename);
    assert.deepEqual(fingerprint(current[name]), { integrity: selected.integrity, sha256: selected.sha256, bytes: selected.bytes });
    receipt.finalPackages.push(selected);
  }
  assert.equal(fingerprint(baseline['typed-decisions']).integrity, fingerprint(current['typed-decisions']).integrity, 'typed decisions must retain its exact baseline bytes');
  stage('verified-baseline-and-final-tarball-identities');
  registryServer = createServer((request, response) => {
    receipt.privateRegistryRequests.push(request.url);
    response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"Private package registry access is forbidden in this upgrade test"}');
  });
  await new Promise((resolve, reject) => { registryServer.once('error', reject); registryServer.listen(0, '127.0.0.1', resolve); });
  const privateRegistry = `http://127.0.0.1:${registryServer.address().port}/`;
  const npmrc = join(scratch, 'isolated.npmrc');
  writeFileSync(npmrc, `@dsh-task:registry=${privateRegistry}\nfetch-retries=0\n`);
  env.npm_config_userconfig = npmrc; env.NPM_CONFIG_USERCONFIG = npmrc;
  await dsh(['plugin', '--profile', profile, 'add', '--allow-build=protobufjs', ...names.map(name => baseline[name])]);
  assert.equal((await run('pnpm', ['config', 'get', '@dsh-task:registry'], { cwd: profileDir })).trim(), privateRegistry);
  const versions = Object.fromEntries(names.map(name => [name, '0.1.0']));
  stage('actual-add-four-baseline-packages', checkManifest(versions));
  const requireProfile = createRequire(join(profileDir, 'package.json'));
  const { RecoveryStore } = await import(pathToFileURL(requireProfile.resolve('@dsh-task/remote-execution/api')).href);
  const recovery = new RecoveryStore(recoveryPath);
  const instanceId = recovery.instanceId;
  recovery.saveOutbound('upgrade-sentinel', { kind: 'upgrade-fixture', unchanged: true }); recovery.close();
  const probe = join(scratch, 'upgrade-probe.mjs');
  writeFileSync(probe, `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
export const name = 'four-package-upgrade-probe';
export const inject = ['taskSystem', 'remoteExecution', 'typedDecisions', 'feishuChannel', 'tools'];
export async function apply(ctx) {
  const ledger = ctx.taskSystem.ledger;
  if (process.env.DSH_UPGRADE_PHASE === 'baseline') {
    ledger.createTask('upgrade-task-command', { taskId: 'upgrade-retained-task', title: 'Retain across real package upgrades' });
    ledger.appendReport('upgrade-report-command', { taskId: 'upgrade-retained-task', title: 'Pre-upgrade report', body: 'Original package state must survive all three package replacements', kind: 'observation' });
    ledger.createRun('upgrade-run-command', { taskId: 'upgrade-retained-task', configuration: { input: { sentinel: 'pre-upgrade' } } });
  }
  assert.equal(ledger.getTask('upgrade-retained-task').title, 'Retain across real package upgrades');
  const history = ledger.history('upgrade-retained-task');
  assert.equal(history.reports.length, 1); assert.equal(history.reports[0].title, 'Pre-upgrade report');
  const runs = ledger.snapshot().runs.filter(run => run.taskId === 'upgrade-retained-task');
  assert.equal(runs.length, 1); assert.equal(runs[0].state, 'queued'); assert.equal(runs[0].configuration.input.sentinel, 'pre-upgrade');
  const deadline = Date.now() + 10000;
  while (!ctx.taskSystem.native && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(ctx.taskSystem.native); assert.ok(ctx.remoteExecution.gateway); assert.ok(ctx.tools.get('task_query'));
  assert.equal(ctx.feishuChannel.inspect().enabled, false);
  assert.ok(ctx.typedDecisions.capabilities());
  for (const id of ['task-system', 'task-remote-execution', 'task-typed-decisions', 'feishu-channel']) assert.equal([...ctx.loader.entries()].find(entry => entry.options.id === id)?.fiber?.state, 2, id + ' must be active');
  const database = new DatabaseSync(process.env.DSH_UPGRADE_RECOVERY, { readOnly: true });
  assert.equal(database.prepare("SELECT value FROM metadata WHERE key='instanceId'").get().value, process.env.DSH_UPGRADE_STORE_ID);
  assert.deepEqual(JSON.parse(database.prepare("SELECT data FROM outbound WHERE id='upgrade-sentinel'").get().data), { kind: 'upgrade-fixture', unchanged: true });
  assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 1); database.close();
  writeFileSync(process.env.DSH_TASK_PROBE_OUT, JSON.stringify({ ok: true, phase: process.env.DSH_UPGRADE_PHASE, taskId: 'upgrade-retained-task', runId: runs[0].runId, runState: runs[0].state, reports: history.reports.length, recoveryInstanceId: process.env.DSH_UPGRADE_STORE_ID, recoverySentinelRetained: true, fourServicesActive: true, liveModelCalls: 0, feishuEnabled: false }));
}
`);
  writeFileSync(join(scratch, 'upgrade.patch.yml'), `- id: task-system\n  config:\n    databasePath: ${JSON.stringify(databasePath)}\n    nodeId: upgrade-node\n    role: both\n    keepAlive: true\n    autoExecute: false\n- id: task-remote-execution\n  config:\n    role: both\n    nodeId: upgrade-node\n    statePath: ${JSON.stringify(recoveryPath)}\n    exposeHttp: false\n- insert:\n    - id: upgrade-probe\n      name: ${JSON.stringify(pathToFileURL(probe).href)}\n`);
  await boot('baseline', instanceId);
  for (const name of ['feishu-channel', 'task-system', 'remote-execution']) {
    await dsh(['plugin', '--profile', profile, 'add', ...(name === 'feishu-channel' ? ['--allow-build=protobufjs'] : []), current[name]]);
    versions[name] = expectedVersions[name];
    stage(`actual-upgrade-${name}`, checkManifest(versions));
    const dump = await dsh(['--profile', profile, '--patch', join(scratch, 'upgrade.patch.yml'), '--dump-config']);
    assert.doesNotMatch(dump, /headless-runner/);
    JSON.parse(await dsh(['--profile', profile, '--patch', join(scratch, 'upgrade.patch.yml'), '--dump-config-schema']));
    await boot(name, instanceId);
  }
  assert.equal(receipt.privateRegistryRequests.length, 0);
  stage('no-private-registry-resolution', { requests: 0, isolatedRegistryTrap: true, typedDecisionsUnchanged: true, upgradeOrder: ['feishu-channel@0.1.1', 'task-system@0.1.1', 'remote-execution@0.1.1'] });
  receipt.ok = true;
} catch (error) { receipt.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (registryServer?.listening) await new Promise(resolve => registryServer.close(resolve));
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, 'upgrade.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}
