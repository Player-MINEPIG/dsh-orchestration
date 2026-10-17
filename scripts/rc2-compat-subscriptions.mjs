import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeVersion = '0.2.1-rc.2';
const patchedVersion = '0.9.9-rc2.1';
const sourceUrl = 'https://registry.npmjs.org/dsh-plugin-subscriptions/-/dsh-plugin-subscriptions-0.9.9.tgz';
const sourceIntegrity = 'sha512-eXdAPyCONv4F3o+yfcpeHji7mfIQBr4u2vjUC+Bg6XESASOmwNGc0+Ewmpu5u+5hEBXktP0L/27GMn57mtlPAQ==';
const providers = ['codex', 'claude', 'grok', 'copilot', 'antigravity'];
const toolNames = ['x_search', 'video_generate', 'image_generate'];
const self = fileURLToPath(import.meta.url);

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function verify(packageDir, runtimeDir, testRoot) {
  process.env.DSH_HOME = join(testRoot, 'home');
  process.env.DSH_AGENTS_HOME = join(testRoot, 'agents');
  const modules = join(runtimeDir, 'node_modules');
  const hostPath = name => join(modules, '@deepseek-ai', name, 'lib/index.js');
  const hostImport = name => import(pathToFileURL(hostPath(name)).href);
  assert.equal((await json(join(modules, '@deepseek-ai/dsh-llm/package.json'))).version, runtimeVersion);
  await symlink(modules, join(packageDir, 'node_modules'));
  const { MockAgent, setGlobalDispatcher } = await import(pathToFileURL(join(modules, 'undici/index.js')).href);
  const network = new MockAgent();
  network.disableNetConnect();
  let networkAttempts = 0;
  const dispatch = network.dispatch.bind(network);
  network.dispatch = (...args) => {
    networkAttempts += 1;
    return dispatch(...args);
  };
  setGlobalDispatcher(network);
  const { Context } = await hostImport('cordis');
  const { Loader } = await hostImport('cordis-plugin-loader');
  const { evaluatePluginCompatibility } = await hostImport('dsh-app-boot');
  const manifest = await json(join(packageDir, 'package.json'));
  const compatibility = evaluatePluginCompatibility(manifest, {}, runtimeVersion);
  if (manifest.version === '0.9.9') {
    assert.ok(compatibility && !compatibility.exempted);
    assert.equal(Object.keys(compatibility.requirements).length, 5);
  } else {
    assert.equal(manifest.version, patchedVersion);
    assert.equal(compatibility, undefined);
  }
  const authDir = join(process.env.DSH_HOME, 'plugins/subscriptions');
  await mkdir(authDir, { recursive: true });
  const fixtures = Object.fromEntries(providers.map(provider => [provider, {
    default: 'offline-fixture',
    accounts: {
      'offline-fixture': {
        accessToken: 'offline-access-fixture',
        refreshToken: 'offline-refresh-fixture',
        expiresAt: Date.now() + 86_400_000,
        accountId: 'offline-fixture',
        projectId: 'offline-fixture',
        emailAddress: 'offline@example.invalid',
      },
    },
  }]));
  await writeFile(join(authDir, 'auth.json'), JSON.stringify(fixtures), { mode: 0o600 });
  const ctx = new Context();
  const loaderFiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(`${testRoot}/`).href });
  await loaderFiber.await();
  const hostEntries = [
    ['llm', 'dsh-llm'],
    ['system-prompt', 'dsh-system-prompt'],
    ['tools', 'dsh-tools'],
    ['web', 'dsh-web'],
  ];
  const hostVersions = {};
  for (const [, name] of hostEntries) {
    hostVersions[name] = (await json(join(modules, '@deepseek-ai', name, 'package.json'))).version;
    assert.equal(hostVersions[name], runtimeVersion);
  }
  for (const [id, name] of hostEntries) await ctx.loader.create({ id, name: hostPath(name) });
  await ctx.loader.await();
  for (const [id] of hostEntries) assert.equal(ctx.loader.resolve(id).fiber.state, 2);
  const config = {
    providers,
    models: Object.fromEntries(providers.map(provider => [provider, [{
      id: `${provider}-compat-check`,
      name: 'Offline compatibility fixture',
      contextWindow: 8192,
      maxTokens: 1024,
      inputModalities: ['text'],
    }]])),
  };
  const cycles = [];
  try {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await ctx.loader.create({ id: 'subscriptions', name: join(packageDir, 'lib/index.js'), config });
      await ctx.loader.await();
      const fiber = ctx.loader.resolve('subscriptions').fiber;
      await fiber.await();
      assert.equal(fiber.state, 2);
      assert.deepEqual((await ctx.llm.listProviders()).map(provider => provider.id).sort(), [...providers].sort());
      const models = [];
      for (const provider of providers) {
        const model = `${provider}-compat-check`;
        assert.ok((await ctx.llm.listModels(provider)).some(item => item.id === model));
        const info = await ctx.llm.resolveModelInfo(provider, model);
        assert.equal(info.context.contextWindow, 8192);
        assert.equal(info.defaultMaxTokens, 1024);
        const prepared = await ctx.llm.prepareCall({ provider, model });
        assert.equal(prepared.config.provider, provider);
        assert.equal(prepared.config.model, model);
        assert.equal(prepared.config.maxTokens, 1024);
        models.push({ provider, model, contextWindow: info.context.contextWindow, maxTokens: prepared.config.maxTokens });
      }
      for (const name of toolNames) assert.ok(ctx.tools.get(name), `${name} registered through the native tools service`);
      const effects = fiber.getEffects().map(effect => effect.label);
      assert.ok(effects.some(label => label.includes('hourly model catalog refresh')));
      assert.ok(effects.some(label => label.includes('claude background sync timer')));
      ctx.loader.remove('subscriptions');
      await ctx.loader.await();
      await fiber.dispose();
      await fiber.await();
      assert.deepEqual(await ctx.llm.listProviders(), []);
      for (const name of toolNames) assert.equal(ctx.tools.get(name), undefined);
      assert.equal(fiber.state, 4);
      assert.deepEqual(fiber.getEffects(), []);
      cycles.push({ active: true, models, tools: toolNames, unloadedProviders: 0, unloadedTools: 0, disposedEffects: 0 });
    }
  } finally {
    for (const [id] of [...hostEntries].reverse()) ctx.loader.remove(id);
    await ctx.loader.await();
    await loaderFiber.dispose();
    await network.close();
  }
  assert.equal(networkAttempts, 0, 'verification made no HTTP requests');
  return { version: manifest.version, compatibility: compatibility ?? null, nativeLoader: true, nativeServices: hostVersions, poolEnabled: true, cycles, networkAttempts };
}

async function fileHashes(root, prefix = '') {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fileHashes(root, name));
    else if (entry.isFile()) result[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    else throw new Error(`Unexpected source entry ${name}`);
  }
  return result;
}

async function main() {
  const [runtimeArg, outputArg, sourceArg, evidenceArg] = process.argv.slice(2);
  assert.ok(runtimeArg && outputArg, 'Usage: node scripts/rc2-compat-subscriptions.mjs RUNTIME_DIR OUTPUT_DIR [SOURCE_TGZ] [EVIDENCE_JSON]');
  const runtimeDir = resolve(runtimeArg);
  const output = resolve(outputArg);
  await mkdir(output, { recursive: true });
  let source;
  if (sourceArg) source = await readFile(resolve(sourceArg));
  else {
    const response = await fetch(sourceUrl);
    assert.ok(response.ok, `source download returned HTTP ${response.status}`);
    source = Buffer.from(await response.arrayBuffer());
  }
  const integrity = `sha512-${createHash('sha512').update(source).digest('base64')}`;
  assert.equal(integrity, sourceIntegrity, 'upstream tarball matches the pinned official npm integrity');
  const originalArchive = join(output, 'dsh-plugin-subscriptions-0.9.9.tgz');
  await writeFile(originalArchive, source);
  const work = await mkdtemp(join(tmpdir(), 'dsh-subscriptions-rc2-'));
  const baseline = join(work, 'baseline');
  const patched = join(work, 'patched');
  const unpacked = join(work, 'unpacked');
  for (const dir of [baseline, patched, unpacked]) await mkdir(dir);
  for (const dir of [baseline, patched]) execFileSync('tar', ['-xzf', originalArchive, '-C', dir]);
  const runCheck = (packageDir, name) => JSON.parse(execFileSync(process.execPath, [self, '--verify', packageDir, runtimeDir, join(work, name)], { encoding: 'utf8', timeout: 30_000 }));
  const baselineResult = runCheck(join(baseline, 'package'), 'baseline-check');
  const packageDir = join(patched, 'package');
  const manifestPath = join(packageDir, 'package.json');
  const manifest = await json(manifestPath);
  assert.equal(manifest.name, 'dsh-plugin-subscriptions');
  assert.equal(manifest.version, '0.9.9');
  manifest.version = patchedVersion;
  const peerChanges = {};
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    manifest.peerDependencies[name] = `${range} || ${runtimeVersion}`;
    peerChanges[name] = { before: range, after: manifest.peerDependencies[name] };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const packResult = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--offline', '--pack-destination', output, '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, npm_config_cache: join(work, 'npm-cache'), npm_config_update_notifier: 'false' },
  }));
  const archive = join(output, packResult[0].filename);
  execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
  const originalFiles = await fileHashes(join(baseline, 'package'));
  const patchedFiles = await fileHashes(join(unpacked, 'package'));
  const changedFiles = Object.keys({ ...originalFiles, ...patchedFiles }).filter(name => originalFiles[name] !== patchedFiles[name]);
  assert.deepEqual(changedFiles, ['package.json']);
  const patchedResult = runCheck(join(unpacked, 'package'), 'patched-check');
  const bytes = await readFile(archive);
  const evidence = {
    runtimeVersion,
    nodeVersion: process.version,
    source: { url: sourceUrl, integrity, sha256: createHash('sha256').update(source).digest('hex'), license: 'MIT', files: Object.keys(originalFiles).length },
    patch: { version: patchedVersion, changedFiles, peerChanges, sourceApiChanges: [], licensePreserved: originalFiles.LICENSE === patchedFiles.LICENSE },
    package: { filename: packResult[0].filename, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: packResult[0].integrity },
    before: baselineResult,
    after: patchedResult,
    limits: ['No real credentials or paid model calls were used.', 'OAuth provider connectivity and browser Settings interactions were not exercised.', 'Only the exact 0.2.1-rc.2 runtime was added to the existing peer ranges.'],
  };
  if (evidenceArg) {
    await mkdir(dirname(resolve(evidenceArg)), { recursive: true });
    await writeFile(resolve(evidenceArg), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  console.log(JSON.stringify({ archive, ...evidence }, null, 2));
}

if (process.argv[2] === '--verify') {
  console.log(JSON.stringify(await verify(...process.argv.slice(3))));
} else {
  await main();
}
