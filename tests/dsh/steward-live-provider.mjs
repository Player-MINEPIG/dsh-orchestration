import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parse} from 'yaml';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'LIVE_PROVIDER_FAILURE';

export async function readLiveProviderRoute({profileRoot = join(homedir(), '.dsh/profiles/web')} = {}) {
  try {
    const entries = parse(await readFile(join(profileRoot, 'cordis.patch.yml'), 'utf8'));
    const route = Array.isArray(entries) && entries.find(entry => object(entry) && (entry.id === 'agent-default-model' || entry.name === '@deepseek-ai/dsh-agent-default-model'))?.config;
    return object(route) && typeof route.provider === 'string' && typeof route.model === 'string'
      ? {provider: route.provider, model: route.model, ...(typeof route.reasoningEffort === 'string' ? {reasoningEffort: route.reasoningEffort} : {})} : null;
  } catch { return null; }
}

/** Read only the configured adapter and settings document; no production Loader or SettingsStore runs. */
export async function attachLiveProvider(ctx, {
  isolatedRoot,
  profileRoot = join(homedir(), '.dsh/profiles/web'),
  maxOutputTokens = 512,
  catalogTimeoutMs = 15000,
  maxRequests,
} = {}) {
  let stop, catalog;
  const stats = {requests: 0, finishes: [], failures: 0, failureCodes: [], failureHints: []};
  const metadata = {mode: 'live-provider', adapter: 'dsh-magpie-connect', configured: false};
  const result = (reason) => ({configured: metadata.configured, reason, metadata: {...metadata}, stats, dispose: async () => {stop?.(); catalog?.stop();}});
  if (!isolatedRoot || !isAbsolute(isolatedRoot) || resolve(isolatedRoot).startsWith(resolve(profileRoot)) || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 2048)
    return result('ISOLATED_FIXTURE_REQUIRED');
  if (maxRequests !== undefined && (!Number.isInteger(maxRequests) || maxRequests < 1)) return result('INVALID_REQUEST_LIMIT');
  let entries, module, patch, route, page;
  try {
    entries = parse(await readFile(join(profileRoot, 'cordis.patch.yml'), 'utf8'));
    if (!Array.isArray(entries)) return result('PROFILE_FORMAT_UNSUPPORTED');
    patch = entries.find(entry => object(entry) && (entry.id === 'dsh-magpie-connect' || entry.name === 'dsh-magpie-connect'))?.config;
    route = entries.find(entry => object(entry) && (entry.id === 'agent-default-model' || entry.name === '@deepseek-ai/dsh-agent-default-model'))?.config;
    if (!object(patch) || !object(route)) return result('PROVIDER_NOT_CONFIGURED');
    const packageRoot = join(profileRoot, 'node_modules/dsh-magpie-connect');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.version !== '0.4.1') return result('ADAPTER_VERSION_UNVERIFIED');
    module = await import(pathToFileURL(join(packageRoot, 'lib/index.js')).href);
    const config = module.resolveConfig(patch);
    if (route.provider !== config.providerId || typeof route.model !== 'string') return result('DEFAULT_PROVIDER_UNSUPPORTED');
    metadata.adapterVersion = manifest.version;
    metadata.providerId = config.providerId;
    metadata.model = route.model;
    metadata.reasoningEffort = route.reasoningEffort;
    metadata.maxOutputTokens = maxOutputTokens;
    if (maxRequests !== undefined) metadata.maxRequests = maxRequests;
    try { page = JSON.parse(await readFile(join(config.dataDir, 'settings.json'), 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') page = {}; else return result('SETTINGS_UNREADABLE'); }
    if (!object(page)) return result('SETTINGS_INVALID');
    if ((page.baseUrl !== undefined && typeof page.baseUrl !== 'string') || (page.apiKey !== undefined && typeof page.apiKey !== 'string')) return result('SETTINGS_INVALID');
    const endpoint = module.resolveEffectiveEndpoint(config, page);
    if (!module.isConfigured(endpoint)) return result('CREDENTIALS_MISSING');
    const parsedEndpoint = new URL(endpoint.baseUrl);
    if (!['http:', 'https:'].includes(parsedEndpoint.protocol) || parsedEndpoint.username || parsedEndpoint.password) return result('ENDPOINT_INVALID');
    if (page.enabledModels !== undefined && (!Array.isArray(page.enabledModels) || !page.enabledModels.every(model => typeof model === 'string'))) return result('SETTINGS_INVALID');
    if (page.enabledModels && !page.enabledModels.includes(route.model)) return result('MODEL_DISABLED');
    metadata.endpointSource = page.baseUrl === undefined ? 'patch-or-default' : 'settings-page';
    metadata.credentialSource = page.apiKey === undefined ? 'patch' : 'settings-page';
    let catalogOk = false;
    catalog = new module.ModelCatalog({baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, fetchImpl: async (url, options = {}) => {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(catalogTimeoutMs)]) : AbortSignal.timeout(catalogTimeoutMs);
      const response = await fetch(url, {...options, signal});
      catalogOk = response.ok;
      return response;
    }});
    await catalog.refreshOnce();
    if (!catalogOk || !catalog.getEntry(route.model)) return result('LIVE_CATALOG_UNAVAILABLE');
    if (page.enabledModels) catalog.setEnabled(page.enabledModels);
    const adapter = new module.MagpieAdapter(catalog, {providerId: config.providerId, displayName: config.displayName, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, maxRetries: 0, timeoutMs: 60000, firstEventTimeoutMs: 30000, idleTimeoutMs: 20000});
    const resolveModel = adapter.resolveModel.bind(adapter), stream = adapter.stream.bind(adapter);
    adapter.resolveModel = (provider, model) => ({...resolveModel(provider, model), defaultMaxTokens: maxOutputTokens});
    adapter.stream = async function* (options) {
      if (maxRequests !== undefined && stats.requests >= maxRequests) throw Object.assign(new Error('Isolated live request budget exhausted'), {code: 'LIVE_REQUEST_BUDGET_EXHAUSTED'});
      stats.requests++;
      try {
        for await (const chunk of stream({...options, maxTokens: Math.min(options.maxTokens ?? maxOutputTokens, maxOutputTokens)})) {
          if (chunk.type === 'finish') {
            stats.finishes.push(chunk.reason.kind);
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              stats.failures++;
              stats.failureCodes.push(safeCode(chunk.reason.failure?.code));
              const detail = chunk.reason.failure?.message ?? '';
              const hints = [/max.?tokens|token.?budget|budget.?tokens|output.*(?:limit|token)/i.test(detail) && 'output-budget', /reasoning|thinking/i.test(detail) && 'reasoning-policy', /unsupported|not.support|not.found|unknown.model/i.test(detail) && 'unsupported-route', /401|403|auth|credential/i.test(detail) && 'authentication', /timeout|connect|network|socket|fetch/i.test(detail) && 'transport'];
              stats.failureHints.push(hints.filter(Boolean));
              yield {...chunk, reason: {...chunk.reason, failure: {code: safeCode(chunk.reason.failure?.code), message: 'Live provider request failed; credentials and endpoint details are withheld'}}};
              continue;
            }
          }
          yield chunk;
        }
      } catch {
        stats.failures++;
        throw Object.assign(new Error('Live provider request failed; credentials and endpoint details are withheld'), {code: 'LIVE_PROVIDER_FAILURE'});
      }
    };
    stop = ctx.llm.registerAdapter([config.providerId], adapter);
    metadata.configured = true;
    metadata.catalog = 'live';
    metadata.cache = 'memory-only';
    return result(null);
  } catch {
    stop?.(); catalog?.stop();
    return result('LIVE_PROVIDER_SETUP_FAILED');
  }
}

/** Add only the official token meter and compaction backend to an isolated native host. */
export async function attachOfficialCompaction(ctx, {
  runtimeRoot = resolve('.runtime/official-dsh-0.2.1-rc.2'),
  config = {auto: false, headroomTokens: 128, retainTokens: 64, maxTokens: 256},
} = {}) {
  for (const [id, name, options] of [
    ['steward-token-meter', 'dsh-token-meter', undefined],
    ['steward-compaction-basic', 'dsh-compaction-basic', config],
  ]) {
    const packageRoot = join(runtimeRoot, 'node_modules/@deepseek-ai', name);
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.version !== '0.2.1-rc.2') throw new Error('Official compaction fixture requires pinned DSH 0.2.1-rc.2');
    await ctx.loader.create({id, name: pathToFileURL(join(packageRoot, 'lib/index.js')).href, ...(options ? {config: options} : {})});
  }
  await ctx.loader.await();
  if (!ctx.tokenMeter || !ctx.compaction) throw new Error('Official compaction dependencies did not mount');
  return {version: '0.2.1-rc.2', tokenMeter: ctx.tokenMeter, compaction: ctx.compaction};
}
