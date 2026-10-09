#!/usr/bin/env node
// Tailscale Serve -> loopback identity/auth bridge -> authenticated DSH Web.
import http from 'node:http';
import { isIP } from 'node:net';
import { open, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(headers) {
  const copy = { ...headers };
  for (const name of [...hopHeaders, ...String(headers.connection ?? '').split(',').map(s => s.trim().toLowerCase())]) delete copy[name];
  return copy;
}
function finish(res, status, message) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}
function rejectSocket(socket, status = 403) {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Read backwards in bounded chunks: startup URLs remain usable even in a long log.
// Tokens are never logged, returned to the browser, or put in command arguments.
export async function latestLaunchToken(logPath) {
  const file = await open(logPath, 'r');
  try {
    let offset = (await file.stat()).size, suffix = '';
    while (offset > 0) {
      const length = Math.min(offset, 65536); offset -= length;
      const bytes = Buffer.alloc(length);
      await file.read(bytes, 0, length, offset);
      const text = bytes.toString('utf8') + suffix;
      const matches = [...text.matchAll(/https?:\/\/[^\s]*[?&]token=([A-Za-z0-9_-]{20,})/g)];
      if (matches.length) return matches.at(-1)[1];
      suffix = text.slice(0, 4096);
    }
    throw new Error('No DSH launch token available');
  } finally { await file.close(); }
}

// DSH 0.2.0-rc.2 skips its Host settings mirror on non-loopback pages.
// This opt-in applies only to assets served through the owner-authenticated
// proxy. Keep connection.isLoopback and every server authentication fence intact.
const settingsMirrorGate = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";';
export function enableHostSettings(source) {
  if (source.split(settingsMirrorGate).length !== 2) throw new Error('Unsupported DSH settings client');
  return source.replace(settingsMirrorGate, 'const persistence = "host";');
}
function settingsAsset(req, config) {
  if (config.hostSettings !== true || !['GET', 'HEAD'].includes(req.method)) return false;
  try {
    return req.url.startsWith('/plugins/??') && decodeURIComponent(req.url).includes('@deepseek-ai/dsh-client-ui-settings/client.js');
  } catch { return false; }
}

export function createAuthProxy(config, dependencies = {}) {
  const origin = new URL(config.publicOrigin);
  const upstream = new URL(config.upstream);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw new Error('publicOrigin must be an HTTPS origin');
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.pathname !== '/' || upstream.search || upstream.hash || upstream.username || upstream.password)
    throw new Error('upstream must be a loopback HTTP origin');
  if (!config.allowedLogin || !/^\d+$/.test(String(config.allowedUserId))) throw new Error('An explicit Tailscale owner is required');
  const whois = dependencies.whois ?? (async ip => JSON.parse((await exec(config.tailscaleBinary ?? '/usr/bin/tailscale', ['whois', '--json', ip], { timeout: 5000, maxBuffer: 262144 })).stdout));
  const token = dependencies.launchToken ?? (() => latestLaunchToken(config.launchLog));
  const identities = new Map();
  let cookie, expiresAt = 0, authenticating;
  const sockets = new Set();
  function invalidate(value) { if (cookie === value) { cookie = undefined; expiresAt = 0; } }
  async function authorize(req) {
    if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)) return false;
    if (req.headers.host !== origin.host || req.headers['tailscale-user-login'] !== config.allowedLogin) return false;
    if (req.headers.origin && req.headers.origin !== origin.origin) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site' && !(
      ['GET', 'HEAD'].includes(req.method) && new URL(req.url, origin).pathname === '/' &&
      req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
    )) return false;
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return false;
    // Serve appends the real client to X-Forwarded-For. Do not trust the first hop.
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim();
    if (!isIP(ip)) return false;
    let entry = identities.get(ip);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (identities.size >= 64) identities.clear();
      const pending = whois(ip).then(result => {
        const user = result.UserProfile, node = result.Node;
        // whois omits MachineAuthorized for peers; Serve already enforces network admission.
        return String(user?.ID) === String(config.allowedUserId) && user?.LoginName === config.allowedLogin &&
          String(node?.User) === String(config.allowedUserId) && !node?.Tags?.length;
      });
      entry = { pending, expiresAt: Date.now() + 10000 };
      identities.set(ip, entry);
      pending.catch(() => identities.delete(ip));
    }
    return entry.pending;
  }
  async function login() {
    if (cookie && Date.now() < expiresAt) return cookie;
    if (authenticating) return authenticating;
    authenticating = (async () => {
      const launchToken = await token();
      return new Promise((resolve, reject) => {
        const request = http.get(new URL('/?token=' + encodeURIComponent(launchToken), upstream), { agent: false, headers: { host: origin.host } }, response => {
          response.resume();
          const value = response.headers['set-cookie']?.find(c => c.startsWith('dsh-auth-'));
          const maxAge = /(?:^|;)\s*Max-Age=(\d+)/i.exec(value ?? '');
          if (response.statusCode !== 303 || !value || !maxAge || Number(maxAge[1]) < 120) return reject(new Error('DSH authentication not ready'));
          cookie = value.split(';')[0];
          expiresAt = Date.now() + Math.min(Number(maxAge[1]) - 60, 86400) * 1000;
          resolve(cookie);
        });
        request.setTimeout(10000, () => request.destroy(new Error('Authentication timeout')));
        request.on('error', reject);
      });
    })();
    try { return await authenticating; } finally { authenticating = undefined; }
  }
  function headers(req, value, upgrade = false) {
    const result = cleanHeaders(req.headers);
    for (const key of Object.keys(result)) if (key.startsWith('tailscale-') || key.startsWith('x-forwarded-')) delete result[key];
    result.host = origin.host;
    result.cookie = value;
    if (settingsAsset(req, config)) {
      result['accept-encoding'] = 'identity';
      delete result['if-none-match']; delete result['if-modified-since'];
    }
    if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
    return result;
  }
  function responseHeaders(input) {
    const output = cleanHeaders(input);
    if (output['set-cookie']) {
      output['set-cookie'] = output['set-cookie'].filter(c => !c.startsWith('dsh-auth-'));
      if (!output['set-cookie'].length) delete output['set-cookie'];
    }
    return output;
  }
  async function forward(req, res, retry = false) {
    const value = await login();
    if (res.destroyed) return;
    const outbound = http.request(new URL(req.url, upstream), { method: req.method, headers: headers(req, value) }, response => {
      if (response.statusCode === 401) {
        response.resume(); invalidate(value);
        if (!retry && ['GET', 'HEAD'].includes(req.method) && !req.headers['content-length'] && !req.headers['transfer-encoding']) {
          forward(req, res, true).catch(() => finish(res, 503, 'DSH 正在恢复连接，请稍后刷新。\n')); return;
        }
        finish(res, 503, 'DSH 认证正在恢复，本次请求未自动重发，请稍后重试。\n'); return;
      }
      if (settingsAsset(req, config) && req.method === 'GET' && response.statusCode === 200) {
        const chunks = []; let size = 0;
        response.setTimeout(10000, () => response.destroy(new Error('Settings asset timeout')));
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) response.destroy(new Error('Settings asset too large'));
          else chunks.push(chunk);
        });
        response.on('error', () => finish(res, 502, '无法读取 DSH 设置客户端。\n'));
        response.on('end', () => {
          if (res.destroyed || res.headersSent) return;
          try {
            if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Compressed settings asset');
            const body = Buffer.from(enableHostSettings(Buffer.concat(chunks).toString('utf8')));
            const output = responseHeaders(response.headers);
            delete output.etag; delete output['last-modified'];
            output['cache-control'] = 'no-store'; output['content-length'] = body.length;
            res.writeHead(200, output); res.end(body);
          } catch { finish(res, 502, '当前 DSH 设置客户端不兼容此入口，请检查版本。\n'); }
        });
        return;
      }
      res.writeHead(response.statusCode ?? 502, responseHeaders(response.headers));
      response.on('error', () => res.destroy()); response.pipe(res);
    });
    outbound.on('error', () => finish(res, 503, 'DSH 暂时不可用，请稍后刷新。\n'));
    res.on('close', () => outbound.destroy());
    if (retry) outbound.end(); else req.pipe(outbound);
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (!await authorize(req)) return finish(res, 403, '此入口仅允许指定的 Tailscale 账号访问。\n');
      const url = new URL(req.url, origin);
      // Old login bookmarks continue to work, but browser-supplied tokens are unused.
      if (url.pathname === '/' && url.searchParams.has('token') && ['GET', 'HEAD'].includes(req.method)) {
        url.searchParams.delete('token');
        res.writeHead(303, { location: url.pathname + url.search, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return;
      }
      await forward(req, res);
    } catch { finish(res, 503, '自动登录暂不可用，请稍后刷新。\n'); }
  });
  async function upgrade(req, socket, head, retry = false) {
    const value = await login();
    if (socket.destroyed) return;
    const outbound = http.request(new URL(req.url, upstream), { agent: false, headers: headers(req, value, true) });
    outbound.on('upgrade', (response, target, targetHead) => {
      sockets.add(target); target.on('close', () => sockets.delete(target));
      const responseHeaders = cleanHeaders(response.headers);
      responseHeaders.connection = 'Upgrade'; responseHeaders.upgrade = 'websocket';
      // Do not pass DSH credentials in upgrade response headers either.
      delete responseHeaders['set-cookie'];
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(responseHeaders).map(([k,v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
      if (targetHead.length) socket.write(targetHead);
      if (head.length) target.write(head);
      target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy());
      socket.on('close', () => target.destroy()); target.on('close', () => socket.destroy());
      target.pipe(socket); socket.pipe(target);
    });
    outbound.on('response', response => {
      response.resume();
      if (response.statusCode === 401) {
        invalidate(value);
        if (!retry) { upgrade(req, socket, head, true).catch(() => rejectSocket(socket, 503)); return; }
      }
      rejectSocket(socket, response.statusCode === 403 ? 403 : 503);
    });
    outbound.on('error', () => rejectSocket(socket, 503));
    socket.on('close', () => outbound.destroy());
    outbound.end();
  }
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || !await authorize(req)) return rejectSocket(socket);
      await upgrade(req, socket, head);
    } catch { rejectSocket(socket, 503); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return { server, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const proxy = createAuthProxy(config);
  proxy.server.listen(config.port, '127.0.0.1', () => console.log('DSH Tailscale authentication proxy ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await proxy.close(); process.exit(0); });
}
