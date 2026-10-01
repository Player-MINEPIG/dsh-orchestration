// SPDX-License-Identifier: MIT
// Independent implementation of the public wire contracts pinned in README.md.
import { createHmac, randomUUID } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';

export const PROVIDER_ENDPOINTS = Object.freeze({ deepseek: 'https://api.deepseek.com/user/balance', aliyun: 'https://business.aliyuncs.com/', metadata: 'http://100.100.100.200/latest/' });
const MESSAGES = Object.freeze({ disabled: 'Provider is disabled', credentials: 'Explicit provider credentials are unavailable', configuration: 'Invalid quota configuration', timeout: 'Provider read timed out', cancelled: 'Provider read was cancelled', network: 'Provider transport failed', http: 'Provider returned an unsuccessful HTTP status', limit: 'Provider response exceeded the configured byte bound', response: 'Provider returned an invalid response' });
export class QuotaError extends Error {
  constructor(code, { retryable = false, status } = {}) { super(MESSAGES[code] ?? MESSAGES.response); this.name = 'QuotaError'; this.code = Object.hasOwn(MESSAGES, code) ? code : 'response'; this.retryable = retryable; if (Number.isInteger(status)) this.status = status; }
}
export const safeFailure = error => ({ code: error instanceof QuotaError ? error.code : 'response', message: error instanceof QuotaError ? MESSAGES[error.code] : MESSAGES.response, retryable: error instanceof QuotaError && error.retryable, ...(error instanceof QuotaError && error.status ? { status: error.status } : {}) });
const ensure = (value, code = 'response') => { if (!value) throw new QuotaError(code); };
const bounds = ({ timeoutMs = 12000, maxBytes = 262144 } = {}) => { ensure(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000 && Number.isInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 1048576, 'configuration'); return { timeoutMs, maxBytes }; };
function allowedUrl(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.hash) throw new QuotaError('configuration');
  if (url.origin === 'https://api.deepseek.com' && url.pathname === '/user/balance' && !url.search) return url;
  if (url.origin === 'https://business.aliyuncs.com' && url.pathname === '/' && url.searchParams.get('Action') === 'QueryAccountBalance' && url.searchParams.get('Version') === '2017-12-14') return url;
  if (url.origin === 'http://100.100.100.200' && !url.search && /^\/latest\/(?:api\/token|meta-data\/ram\/security-credentials\/(?:[A-Za-z0-9_.-]{1,128})?)$/.test(url.pathname)) return url;
  throw new QuotaError('configuration');
}
/** Optional production transport. Direct connections only; no redirects, proxies, env reads, or ambient authentication. */
export function createDirectHttpTransport() {
  return ({ url: raw, method, headers, signal, maxBytes }) => new Promise((resolve, reject) => {
    const url = allowedUrl(raw); const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, { method, headers, signal, agent: false }, response => {
      const chunks = []; let length = 0;
      response.on('data', chunk => { length += chunk.length; if (length > maxBytes) request.destroy(new QuotaError('limit')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.end();
  });
}
async function readBounded(transport, request, options) {
  const { timeoutMs, maxBytes } = bounds(options); ensure(typeof transport === 'function', 'configuration'); allowedUrl(request.url);
  const controller = new AbortController(); let timer; let stop;
  const deadline = new Promise((_, reject) => {
    const abort = code => { controller.abort(); reject(new QuotaError(code, { retryable: code === 'timeout' })); };
    timer = setTimeout(() => abort('timeout'), timeoutMs);
    stop = () => abort('cancelled'); options?.signal?.addEventListener('abort', stop, { once: true });
    if (options?.signal?.aborted) stop();
  });
  try {
    const response = await Promise.race([deadline, Promise.resolve().then(() => { controller.signal.throwIfAborted(); return transport({ ...request, signal: controller.signal, maxBytes, redirect: 'error' }); })]);
    ensure(response && Number.isInteger(response.status));
    if (response.status < 200 || response.status >= 300) throw new QuotaError('http', { status: response.status, retryable: response.status === 408 || response.status === 429 || response.status >= 500 });
    // The transport contract intentionally requires already-bounded bytes; it cannot return a live response stream.
    ensure(typeof response.body === 'string' || Buffer.isBuffer(response.body) || response.body instanceof Uint8Array);
    if (Buffer.byteLength(response.body) > maxBytes) throw new QuotaError('limit'); const body = Buffer.from(response.body);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { throw new QuotaError('response'); }
  } catch (error) { if (error instanceof QuotaError) throw error; throw new QuotaError('network', { retryable: true }); }
  finally { clearTimeout(timer); options?.signal?.removeEventListener('abort', stop); }
}
async function readJson(transport, request, options) { const text = await readBounded(transport, request, options); try { const value = JSON.parse(text); ensure(value && typeof value === 'object' && !Array.isArray(value)); return value; } catch { throw new QuotaError('response'); } }
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\r\n\0]/.test(value);
const currency = value => { ensure(typeof value === 'string' && /^[A-Za-z]{3}$/.test(value)); return value.toUpperCase(); };
const decimal = value => { ensure(typeof value === 'string' && value.length <= 128 && /^-?\d+(?:\.\d+)?$/.test(value)); return value; };
const metric = (name, unit, value) => ({ metric: name, dimension: unit, unit, value: decimal(value) });
/** Returns only approved metric fields, never raw provider JSON or credentials. */
export async function collectDeepSeek({ enabled = false, apiKey, transport, ...options } = {}) {
  ensure(enabled === true, 'disabled'); ensure(secret(apiKey), 'credentials');
  const payload = await readJson(transport, { url: PROVIDER_ENDPOINTS.deepseek, method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': 'dsh-quota-reader/1' } }, options);
  ensure(Array.isArray(payload.balance_infos) && payload.balance_infos.length >= 1 && payload.balance_infos.length <= 32);
  const metrics = payload.balance_infos.flatMap(item => { ensure(item && typeof item === 'object'); const unit = currency(item.currency); return [['total_balance', 'balance.total'], ['granted_balance', 'balance.granted'], ['topped_up_balance', 'balance.topped_up']].map(([field, name]) => metric(name, unit, item[field])); });
  ensure(new Set(metrics.map(item => `${item.metric}:${item.dimension}`)).size === metrics.length);
  return { provider: 'deepseek', source: 'deepseek.user.balance', metrics };
}
/** Explicit ECS metadata access, never automatic discovery. The returned credentials must stay in host memory. */
export async function readEcsRoleCredentials({ enabled = false, transport, ...options } = {}) {
  ensure(enabled === true, 'disabled');
  const token = (await readBounded(transport, { url: `${PROVIDER_ENDPOINTS.metadata}api/token`, method: 'PUT', headers: { 'X-aliyun-ecs-metadata-token-ttl-seconds': '600' } }, { ...options, maxBytes: Math.min(options.maxBytes ?? 16384, 16384) })).trim(); ensure(secret(token), 'credentials');
  const headers = { 'X-aliyun-ecs-metadata-token': token };
  const role = (await readBounded(transport, { url: `${PROVIDER_ENDPOINTS.metadata}meta-data/ram/security-credentials/`, method: 'GET', headers }, { ...options, maxBytes: Math.min(options.maxBytes ?? 1024, 1024) })).trim();
  ensure(/^[A-Za-z0-9_.-]{1,128}$/.test(role), 'credentials');
  const value = await readJson(transport, { url: `${PROVIDER_ENDPOINTS.metadata}meta-data/ram/security-credentials/${role}`, method: 'GET', headers }, options);
  ensure(value.Code === 'Success', 'credentials');
  const credentials = { accessKeyId: value.AccessKeyId, accessKeySecret: value.AccessKeySecret, securityToken: value.SecurityToken };
  ensure(Object.values(credentials).every(secret), 'credentials'); return credentials;
}
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
export async function collectAlibaba({ enabled = false, credentials, transport, now = () => new Date(), nonce = randomUUID, ...options } = {}) {
  ensure(enabled === true, 'disabled'); ensure(credentials && secret(credentials.accessKeyId) && secret(credentials.accessKeySecret) && (credentials.securityToken === undefined || secret(credentials.securityToken)), 'credentials');
  const time = new Date(now()); ensure(Number.isFinite(time.getTime()), 'configuration'); const id = nonce(); ensure(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id), 'configuration');
  const params = { AccessKeyId: credentials.accessKeyId, Action: 'QueryAccountBalance', Format: 'JSON', SignatureMethod: 'HMAC-SHA1', SignatureNonce: id, SignatureVersion: '1.0', Timestamp: time.toISOString().replace(/\.\d{3}Z$/, 'Z'), Version: '2017-12-14', ...(credentials.securityToken ? { SecurityToken: credentials.securityToken } : {}) };
  const canonical = Object.keys(params).sort().map(key => `${encode(key)}=${encode(params[key])}`).join('&');
  const signature = createHmac('sha1', `${credentials.accessKeySecret}&`).update(`GET&%2F&${encode(canonical)}`).digest('base64');
  const payload = await readJson(transport, { url: `${PROVIDER_ENDPOINTS.aliyun}?${canonical}&Signature=${encode(signature)}`, method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'dsh-quota-reader/1' } }, options);
  ensure(payload.Success === true && payload.Data && typeof payload.Data === 'object'); const unit = currency(payload.Data.Currency ?? 'CNY');
  const metrics = [['AvailableAmount', 'account.available'], ['AvailableCashAmount', 'account.cash'], ['CreditAmount', 'account.credit']].flatMap(([field, name]) => payload.Data[field] === undefined || payload.Data[field] === '' ? [] : [metric(name, unit, payload.Data[field])]);
  ensure(metrics.length); return { provider: 'aliyun', source: 'aliyun.bss.QueryAccountBalance', metrics };
}
