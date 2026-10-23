import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { TaskLedger } from '../../dist/index.js'
import * as plugin from '../../dist/remote/index.js'
import { IdentityVerifier, TrustedNetworkVerifier, RecoveryStore, RemoteGateway, RemoteClient, RemoteLedgerClient, signEnvelope, httpHandler, startTrustedNetworkCarrier } from '../../dist/remote/api.js'

const now = 1780000000000
const operations = ['listWork','claim','markRunning','bindSession','renew','submit','getRun','getAttempt','receipt','cancel']
const peer = { address: '127.0.0.1',nodeId: 'worker',role: 'executor',audience: 'planner',operations,workspaces: ['workspace'],capabilities: ['read'] }
const policy = (port = 49152,overrides = {}) => ({ listen: { address: '127.0.0.1',port },allowHttp: true,allowedAddresses: ['127.0.0.1','127.0.0.2'],peers: [peer],...overrides })
const context = (port = 49152,overrides = {}) => ({ remoteAddress: '127.0.0.1',localAddress: '127.0.0.1',localPort: port,...overrides })
const envelope = (overrides = {}) => ({ version: 2,authMode: 'trusted-network',nodeId: 'worker',audience: 'planner',commandId: 'claim1',nonce: 'nonce1',sequence: 1,issuedAt: now,expiresAt: now + 60000,operation: 'claim',payload: { runId: 'run1',ttlMs: 60000 },...overrides })
const body = overrides => JSON.stringify(envelope(overrides))

function fixture(t,options = {}) {
  const run = { runId: 'run1',taskId: 'task1',state: 'queued',configuration: {},route: { nodeId: 'worker',workspaceId: 'workspace',provider: 'fixture',model: 'fixture',requiredCapabilities: ['read'] } }
  const attempt = { attemptId: 'attempt1',taskId: 'task1',runId: 'run1',nodeId: 'worker',fence: 1,state: 'leased',leaseExpiresAt: new Date(now + 60000).toISOString() }
  const calls = []
  const ledger = {
    getRun: () => structuredClone(run),getAttempt: () => structuredClone(attempt),
    pendingRuns: node => node === run.route.nodeId ? [structuredClone(run)] : [],
    claim: (commandId,input) => { calls.push({ commandId,input }); return { commandId,acceptedAt: new Date(now).toISOString(),value: { task: { taskId: 'task1',workspaceId: 'workspace' },run,attempt } } },
  }
  const store = new RecoveryStore(':memory:')
  const network = options.policy ?? policy()
  const gateway = new RemoteGateway({ role: 'planner',nodeId: 'planner',ledger,store,now: () => now,verifier: new TrustedNetworkVerifier({ audience: 'planner',...network }),...options.gateway })
  t.after(async () => { await gateway.dispose(); store.close() })
  return { gateway,ledger,run,attempt,calls,store,policy: network }
}
const listen = (server,port = 0,address = '127.0.0.1') => new Promise((resolve,reject) => {
  server.once('error',reject)
  server.listen(port,address,() => { server.removeListener('error',reject); resolve(server.address().port) })
})
const close = server => new Promise(resolve => { if (!server?.listening) return resolve(); server.close(resolve); server.closeAllConnections() })
async function unusedPort() { const server = http.createServer(); const port = await listen(server); await close(server); return port }
function request(port,envelopeValue = envelope({ operation: 'listWork',payload: {} }),options = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request({ hostname: '127.0.0.1',port,path: '/commands',method: 'POST',agent: false,localAddress: '127.0.0.1',...options,headers: { 'content-type': 'application/json',...options.headers } },res => {
      const chunks = []; res.on('data',chunk => chunks.push(chunk)); res.on('error',reject)
      res.on('end',() => {
        try { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode,body: text ? JSON.parse(text) : null }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error',reject); req.end(JSON.stringify(envelopeValue))
  })
}
function clientOptions(port,store,overrides = {}) {
  return { authMode: 'trusted-network',endpoint: `http://127.0.0.1:${port}/commands`,trustedNetwork: { address: '127.0.0.1',port,localAddress: '127.0.0.1',allowHttp: true },nodeId: 'worker',audience: 'planner',store,now: () => now,timeoutMs: 1000,...overrides }
}

test('trusted network requires explicit HTTP policy, literal address and exact listener',async t => {
  for (const network of [policy(0),policy(70000),policy(49152,{ allowHttp: false }),policy(49152,{ listen: { address: '0.0.0.0',port: 49152 } }),policy(49152,{ listen: { address: 'localhost',port: 49152 } })]) {
    assert.throws(() => new TrustedNetworkVerifier({ audience: 'planner',...network }),/OPT_IN|LISTEN|ADDRESS|PORT|LITERAL_IP/)
  }
  const f = fixture(t)
  await assert.rejects(f.gateway.handle(body()),/TRANSPORT|SOCKET|CONTEXT|ADDRESS|LISTEN/)
  for (const wrong of [{ localAddress: '127.0.0.2' },{ localPort: 49153 },{ localAddress: undefined },{ localPort: undefined }]) {
    await assert.rejects(f.gateway.handle(body(),context(49152,wrong)),/LISTEN|ADDRESS|PORT|TRANSPORT|SOCKET|LITERAL_IP/)
  }
})

test('trusted network derives peer identity from the socket and requires both allowlist and peer entry',async t => {
  const f = fixture(t)
  for (const remoteAddress of ['127.0.0.3','127.0.0.2','203.0.113.9',undefined]) {
    await assert.rejects(f.gateway.handle(body(),context(49152,{ remoteAddress })),/PEER|ADDRESS|TRANSPORT|SOCKET|LITERAL_IP/)
  }
  await assert.rejects(f.gateway.handle(body({ nodeId: 'admin' }),context()),/WRONG_NODE/)
  await assert.rejects(f.gateway.handle(body({ audience: 'other-planner' }),context()),/WRONG_AUDIENCE/)
  assert.equal(f.calls.length,0)
  assert.equal((await f.gateway.handle(body(),context())).state,'done')
  assert.equal(f.calls[0].input.nodeId,'worker')
})

test('trusted network normalizes IPv4-mapped sockets without permitting duplicate or foreign identities',async t => {
  for (const mapped of ['::ffff:127.0.0.1','::ffff:7f00:1']) {
    assert.throws(() => new TrustedNetworkVerifier({ audience: 'planner',...policy(49152,{ allowedAddresses: ['127.0.0.1',mapped] }) }),/DUPLICATE_NETWORK_ADDRESS/)
    assert.throws(() => new TrustedNetworkVerifier({ audience: 'planner',...policy(49152,{ peers: [peer,{ ...peer,address: mapped,nodeId: 'other-worker' }] }) }),/DUPLICATE_NETWORK_PEER/)
  }
  const f = fixture(t)
  await assert.rejects(f.gateway.handle(body(),context(49152,{ remoteAddress: '::ffff:127.0.0.2' })),/NETWORK_PEER_REQUIRED/)
  await assert.rejects(f.gateway.handle(body(),context(49152,{ remoteAddress: '::ffff:127.0.0.3' })),/NETWORK_ADDRESS_DENIED/)
  assert.equal((await f.gateway.handle(body(),context(49152,{ remoteAddress: '::ffff:7f00:1',localAddress: '::ffff:127.0.0.1' }))).state,'done')
  assert.equal(f.calls.length,1)
  assert.equal(f.calls[0].input.nodeId,'worker')
})

test('trusted network cannot mix unsigned v2 with signed v1 or introduce signing fields',async t => {
  const f = fixture(t)
  const keys = generateKeyPairSync('ed25519')
  const signedPeer = { ...peer,keyId: 'fixture-key',publicKey: keys.publicKey }
  const signed = signEnvelope({ version: 1,keyId: signedPeer.keyId,nodeId: 'worker',audience: 'planner',commandId: 'claim1',nonce: 'nonce1',sequence: 1,issuedAt: now,expiresAt: now + 60000,operation: 'claim',payload: { runId: 'run1',ttlMs: 60000 } },keys.privateKey)
  const signedGateway = new RemoteGateway({ role: 'planner',nodeId: 'planner',ledger: f.ledger,store: f.store,now: () => now,verifier: new IdentityVerifier({ audience: 'planner',peers: [signedPeer] }) })
  t.after(() => signedGateway.dispose())
  await assert.rejects(f.gateway.handle(JSON.stringify(signed),context()),/AUTH_MODE|VERSION|ENVELOPE/)
  await assert.rejects(signedGateway.handle(body(),context()),/AUTH_MODE|VERSION|ENVELOPE/)
  for (const overrides of [{ authMode: 'signed' },{ authMode: undefined },{ version: 1 },{ keyId: 'fixture-key' },{ signature: signed.signature },{ role: 'both' }]) {
    await assert.rejects(f.gateway.handle(body(overrides),context()),/AUTH_MODE|VERSION|ENVELOPE/)
  }
  assert.equal(f.calls.length,0)
  assert.equal((await signedGateway.handle(JSON.stringify(signed))).state,'done')
})

test('trusted network preserves operation, workspace, capability, route and payload restrictions',async t => {
  for (const [restriction,expected] of [[{ operations: [] },/OPERATION_DENIED/],[{ workspaces: [] },/WORKSPACE_DENIED/],[{ capabilities: [] },/CAPABILITY_DENIED/]]) {
    const f = fixture(t,{ policy: policy(49152,{ peers: [{ ...peer,...restriction }] }) })
    await assert.rejects(f.gateway.handle(body(),context()),expected)
    assert.equal(f.calls.length,0)
  }
  const f = fixture(t)
  await assert.rejects(f.gateway.handle(body({ payload: { runId: 'run1',ttlMs: 60000,nodeId: 'admin' } }),context()),/PAYLOAD_FIELDS/)
  f.run.route.nodeId = 'other'
  await assert.rejects(f.gateway.handle(body(),context()),/NODE_ROUTE_DENIED/)
  assert.equal(f.calls.length,0)
})

test('trusted network executor operation requires explicit execution permission',async t => {
  const f = fixture(t,{ policy: policy(49152,{ peers: [{ ...peer,role: 'planner' }] }) })
  await assert.rejects(f.gateway.handle(body(),context()),/EXECUTION_DISABLED|OPERATION_DENIED/)
  assert.equal(f.calls.length,0)
})

test('trusted network discovery filters unauthorized runs and rejects foreign attempt fences',async t => {
  const f = fixture(t)
  f.ledger.pendingRuns = () => [f.run,{ ...f.run,runId: 'other-node',route: { ...f.run.route,nodeId: 'other' } },{ ...f.run,runId: 'secret',route: { ...f.run.route,workspaceId: 'secret' } },{ ...f.run,runId: 'capability',route: { ...f.run.route,requiredCapabilities: ['write'] } }]
  const discovery = await f.gateway.handle(body({ operation: 'listWork',payload: {} }),context())
  assert.deepEqual(discovery.result.map(run => run.runId),['run1'])
  await assert.rejects(f.gateway.handle(body({ commandId: 'submit1',nonce: 'nonce2',sequence: 2,operation: 'submit',payload: { runId: 'run1',attemptId: 'attempt1',fence: 2,outcome: 'success',summary: 'foreign fence' } }),context()),/ATTEMPT_DENIED/)
})

test('trusted network enforces expiry, nonces, sequence order and command digest before effects',async t => {
  const f = fixture(t)
  for (const time of [{ issuedAt: now - 120000,expiresAt: now - 60000 },{ issuedAt: now + 10000,expiresAt: now + 60000 },{ expiresAt: now + 300000 }]) {
    await assert.rejects(f.gateway.handle(body(time),context()),/STALE_REQUEST/)
  }
  const first = await f.gateway.handle(body(),context())
  await assert.rejects(f.gateway.handle(body(),context()),/REPLAY/)
  const retry = await f.gateway.handle(body({ nonce: 'retry',sequence: 2 }),context())
  assert.deepEqual(retry,first)
  await assert.rejects(f.gateway.handle(body({ nonce: 'old',sequence: 1 }),context()),/OUT_OF_ORDER/)
  await assert.rejects(f.gateway.handle(body({ nonce: 'conflict',sequence: 3,payload: { runId: 'run1',ttlMs: 30000 } }),context()),/COMMAND_CONFLICT/)
  assert.equal(f.calls.length,1)
})

test('trusted network carrier rejects bad Host, Origin and proxy identity forgery before admission',async t => {
  const port = await unusedPort()
  const f = fixture(t,{ policy: policy(port) })
  const carrier = await startTrustedNetworkCarrier(f.gateway,{ ...f.policy,routePath: '/commands' })
  t.after(() => carrier.close())
  for (const headers of [{ host: 'evil.invalid' },{ host: `localhost:${port}` },{ host: '127.0.0.1' },{ host: `127.0.0.1:${port + 1}` },{ origin: 'https://example.invalid' },{ origin: 'null' },{ origin: '' }]) {
    const result = await request(port,undefined,{ headers })
    assert.ok(result.status >= 400,JSON.stringify(headers))
  }
  const missingHost = await request(port,undefined,{ setHost: false })
  assert.ok(missingHost.status >= 400)
  await t.test('unconfigured source IP cannot use proxy headers to gain identity', { skip: process.platform === 'darwin' ? 'macOS has no default 127.0.0.2 loopback alias; source-IP denial remains covered by verifier tests' : false }, async () => {
    const spoofed = await request(port,undefined,{ localAddress: '127.0.0.2',headers: { 'x-forwarded-for': '127.0.0.1','x-forwarded-proto': 'https','x-forwarded-host': `127.0.0.1:${port}` } })
    assert.ok(spoofed.status >= 400)
  })
  for (const headers of [{ 'x-forwarded-for': '127.0.0.1' },{ 'x-forwarded-proto': 'https' },{ forwarded: 'for=127.0.0.1;proto=https' }]) {
    const result = await request(port,undefined,{ headers })
    assert.equal(result.status,403)
    assert.equal(result.body.error,'PROXY_HEADERS_DENIED')
  }
  assert.equal(f.store.receipt('worker','claim1'),undefined)
  assert.equal((await request(port)).status,200)
})

test('trusted network HTTP opt-in cannot enable an unsigned request on the default signed carrier',async t => {
  const keys = generateKeyPairSync('ed25519')
  const f = fixture(t,{ gateway: { verifier: new IdentityVerifier({ audience: 'planner',peers: [{ ...peer,keyId: 'fixture-key',publicKey: keys.publicKey }] }) } })
  const server = http.createServer(httpHandler(f.gateway))
  const port = await listen(server)
  t.after(() => close(server))
  const result = await request(port,undefined,{ headers: { 'x-forwarded-proto': 'https' } })
  assert.equal(result.status,403)
  assert.equal(result.body.error,'TLS_REQUIRED')
  assert.equal(f.calls.length,0)
})

test('trusted network client refuses DNS, target mismatch, HTTP ambiguity and signing mode confusion before sending',t => {
  const store = new RecoveryStore(':memory:')
  t.after(() => store.close())
  const options = clientOptions(49152,store)
  for (const change of [
    { endpoint: 'http://localhost:49152/commands' },
    { endpoint: 'http://example.invalid:49152/commands' },
    { endpoint: 'http://127.0.0.2:49152/commands' },
    { endpoint: 'http://127.0.0.1:49153/commands' },
    { endpoint: 'http://user:secret@127.0.0.1:49152/commands' },
    { endpoint: 'http://127.0.0.1:49152/commands?other=1' },
    { trustedNetwork: { ...options.trustedNetwork,allowHttp: false } },
    { trustedNetwork: { ...options.trustedNetwork,localAddress: 'localhost' } },
    { keyId: 'unexpected-signing-key' },
  ]) {
    assert.throws(() => new RemoteClient({ ...options,...change }),/ENDPOINT|ADDRESS|TARGET|PORT|OPT_IN|AUTH|SIGN|MODE|CONFIG|LITERAL_IP/)
  }
})

test('trusted network native HTTP client refuses redirects without sending the command to the redirect target',async t => {
  let targetRequests = 0
  const target = http.createServer((_req,res) => { targetRequests++; res.end('{}') })
  const targetPort = await listen(target)
  const redirect = http.createServer((_req,res) => { res.writeHead(307,{ location: `http://127.0.0.1:${targetPort}/commands` }); res.end() })
  const port = await listen(redirect)
  const store = new RecoveryStore(':memory:')
  const client = new RemoteClient(clientOptions(port,store))
  t.after(async () => { await client.dispose(); await close(redirect); await close(target); store.close() })
  assert.equal((await client.send('listWork','redirect-command',{})).state,'uncertain')
  assert.equal(targetRequests,0)
})

test('trusted network native client binds the configured source and rejects an allowlisted address without a peer',async t => {
  const port = await unusedPort()
  const f = fixture(t,{ policy: policy(port) })
  const carrier = await startTrustedNetworkCarrier(f.gateway,{ ...f.policy,routePath: '/commands' })
  const store = new RecoveryStore(':memory:')
  const client = new RemoteClient(clientOptions(port,store,{ trustedNetwork: { address: '127.0.0.1',port,localAddress: '127.0.0.2',allowHttp: true } }))
  t.after(async () => { await client.dispose(); await carrier.close(); store.close() })
  assert.equal((await client.send('claim','wrong-source',{ runId: 'run1',ttlMs: 60000 })).state,'uncertain')
  assert.equal(f.calls.length,0)
  assert.equal(f.store.receipt('worker','wrong-source'),undefined)
})

test('trusted network IPv6 carrier requires a bracketed exact Host and accepts the native literal target',async t => {
  const probe = http.createServer()
  let port
  try { port = await listen(probe,0,'::1'); await close(probe) }
  catch (error) {
    if (['EADDRNOTAVAIL','EAFNOSUPPORT'].includes(error.code)) { t.skip('IPv6 loopback is unavailable on this test host'); return }
    throw error
  }
  const network = policy(port,{ listen: { address: '::1',port },allowedAddresses: ['::1'],peers: [{ ...peer,address: '::1' }] })
  const f = fixture(t,{ policy: network })
  const carrier = await startTrustedNetworkCarrier(f.gateway,{ ...network,routePath: '/commands' })
  const store = new RecoveryStore(':memory:')
  const client = new RemoteClient(clientOptions(port,store,{ endpoint: `http://[::1]:${port}/commands`,trustedNetwork: { address: '::1',port,localAddress: '::1',allowHttp: true } }))
  t.after(async () => { await client.dispose(); await carrier.close(); store.close() })
  for (const host of [`::1:${port}`,`[0:0:0:0:0:0:0:1]:${port}`,`[::1]:${port + 1}`]) {
    const response = await request(port,undefined,{ hostname: '::1',localAddress: '::1',headers: { host } })
    assert.equal(response.status,403)
    assert.equal(response.body.error,'HOST_DENIED')
  }
  assert.equal((await client.send('claim','ipv6-claim',{ runId: 'run1',ttlMs: 60000 })).state,'done')
  assert.equal(f.calls.length,1)
})

test('durable client receipts cannot be reused after changing authentication mode or source identity',async t => {
  const port = await unusedPort()
  const f = fixture(t,{ policy: policy(port) })
  const carrier = await startTrustedNetworkCarrier(f.gateway,{ ...f.policy,routePath: '/commands' })
  const store = new RecoveryStore(':memory:')
  const client = new RemoteClient(clientOptions(port,store))
  const changedSource = new RemoteClient(clientOptions(port,store,{ trustedNetwork: { address: '127.0.0.1',port,localAddress: '127.0.0.2',allowHttp: true } }))
  const keys = generateKeyPairSync('ed25519')
  let signedRequests = 0
  const signed = new RemoteClient({ endpoint: `http://127.0.0.1:${port}/commands`,allowLoopbackHttp: true,nodeId: 'worker',audience: 'planner',keyId: 'fixture-key',privateKey: keys.privateKey,store,fetch: async () => { signedRequests++; throw new Error('Authentication mode change must fail before transport') } })
  t.after(async () => { await client.dispose(); await changedSource.dispose(); await signed.dispose(); await carrier.close(); store.close() })
  const payload = { runId: 'run1',ttlMs: 60000 }
  assert.equal((await client.send('claim','saved-command',payload)).state,'done')
  await assert.rejects(changedSource.send('claim','saved-command',payload),/SAVED_AUTH_MISMATCH/)
  await assert.rejects(signed.send('claim','saved-command',payload),/SAVED_AUTH_MISMATCH/)
  assert.equal(signedRequests,0)
  assert.equal(f.calls.length,1)
})

test('actual Cordis activation reports an occupied trusted-network port and releases its failed service',async () => {
  const root = mkdtempSync(join(tmpdir(),'dsh-trusted-bind-'))
  const occupied = http.createServer((_req,res) => { res.writeHead(418,{ 'content-type': 'application/json' }); res.end('{"error":"fixture-owner"}') })
  const port = await listen(occupied)
  const ctx = new Context()
  try {
    await ctx.plugin({ name: 'occupied-port-ledger',apply(ctx) { ctx.provide('taskSystem',{ ledger: { pendingRuns: () => [] } }) } }).await()
    const config = { role: 'planner',nodeId: 'planner',audience: 'planner',statePath: join(root,'recovery.sqlite'),authMode: 'trusted-network',trustedNetwork: policy(port),exposeHttp: true,routePath: '/commands' }
    const failed = ctx.plugin(plugin,config)
    await assert.rejects(failed.await(),error => error.code === 'EADDRINUSE')
    assert.equal(ctx.get('remoteExecution'),undefined)
    assert.equal((await request(port)).status,418,'failed startup must not close another listener')
    await failed.dispose()
    const reopened = new RecoveryStore(config.statePath)
    reopened.close()
    await close(occupied)
    const retry = ctx.plugin(plugin,config)
    await retry.await()
    assert.ok(ctx.get('remoteExecution')?.gateway)
    const issuedAt = Date.now()
    assert.equal((await request(port,envelope({ operation: 'listWork',payload: {},issuedAt,expiresAt: issuedAt + 60000 }))).status,200)
    await retry.dispose()
  } finally { await ctx.fiber.dispose(); await close(occupied); rmSync(root,{ recursive: true,force: true }) }
})

test('actual Cordis disposal closes the trusted-network listener and remount preserves durable replay protection',async () => {
  const root = mkdtempSync(join(tmpdir(),'dsh-trusted-lifecycle-'))
  const port = await unusedPort()
  const ctx = new Context()
  let reads = 0
  try {
    await ctx.plugin({ name: 'trusted-lifecycle-ledger',apply(ctx) { ctx.provide('taskSystem',{ ledger: { pendingRuns: () => { reads++; return [] } } }) } }).await()
    const config = { role: 'planner',nodeId: 'planner',audience: 'planner',statePath: join(root,'recovery.sqlite'),authMode: 'trusted-network',trustedNetwork: policy(port),exposeHttp: true,routePath: '/commands' }
    const first = ctx.plugin(plugin,config)
    await first.await()
    const service = ctx.get('remoteExecution')
    assert.ok(service?.gateway)
    const issuedAt = Date.now()
    const command = envelope({ commandId: 'lifecycle-read',operation: 'listWork',payload: {},issuedAt,expiresAt: issuedAt + 60000 })
    assert.equal((await request(port,command)).status,200)
    await first.dispose()
    assert.equal(ctx.get('remoteExecution'),undefined)
    await assert.rejects(request(port,command),/ECONNREFUSED|ECONNRESET|socket hang up/)
    await assert.rejects(service.gateway.handle(JSON.stringify(command),context(port)),/DRAINING/)
    const rebind = http.createServer()
    assert.equal(await listen(rebind,port),port)
    await close(rebind)
    const second = ctx.plugin(plugin,config)
    await second.await()
    const replay = await request(port,command)
    assert.equal(replay.status,409)
    assert.equal(replay.body.error,'REPLAY')
    assert.equal((await request(port,{ ...command,nonce: 'new-process-nonce',sequence: 2 })).status,200)
    assert.equal(reads,1,'durable command retry must reuse the receipt after remount')
    await second.dispose()
  } finally { await ctx.fiber.dispose(); rmSync(root,{ recursive: true,force: true }) }
})

test('actual Cordis disposal closes an in-flight HTTP socket and drains admitted work before journal teardown',async () => {
  const root = mkdtempSync(join(tmpdir(),'dsh-trusted-drain-'))
  const port = await unusedPort()
  const ctx = new Context()
  let release,entered,reads = 0
  const blocked = new Promise(resolve => { release = resolve })
  const entry = new Promise(resolve => { entered = resolve })
  try {
    await ctx.plugin({ name: 'trusted-drain-ledger',apply(ctx) { ctx.provide('taskSystem',{ ledger: { pendingRuns: async () => { reads++; entered(); await blocked; return [] } } }) } }).await()
    const statePath = join(root,'recovery.sqlite')
    const fiber = ctx.plugin(plugin,{ role: 'planner',nodeId: 'planner',audience: 'planner',statePath,authMode: 'trusted-network',trustedNetwork: policy(port),exposeHttp: true,routePath: '/commands' })
    await fiber.await()
    const service = ctx.get('remoteExecution')
    const issuedAt = Date.now()
    const command = envelope({ commandId: 'draining-command',operation: 'listWork',payload: {},issuedAt,expiresAt: issuedAt + 60000 })
    const response = request(port,command).then(value => ({ value }),error => ({ error }))
    await entry
    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    const interrupted = await response
    assert.match(String(interrupted.error),/ECONNRESET|socket hang up/)
    assert.equal(disposed,false,'journal teardown must wait for already admitted ledger work')
    const rebind = http.createServer()
    assert.equal(await listen(rebind,port),port,'the listener is reusable while old ledger work drains')
    await close(rebind)
    release()
    await disposing
    const reopened = new RecoveryStore(statePath)
    try {
      assert.equal(reopened.receipt('worker','draining-command')?.state,'done','admitted work commits its receipt before closing the journal')
      await assert.rejects(service.gateway.handle(body({ commandId: 'after-disposal',nonce: 'after-disposal',sequence: 2 }),context(port)),/DRAINING/)
      assert.equal(reopened.receipt('worker','after-disposal'),undefined)
    } finally { reopened.close() }
    assert.equal(reads,1)
    assert.equal(ctx.get('remoteExecution'),undefined)
  } finally { release(); await ctx.fiber.dispose(); rmSync(root,{ recursive: true,force: true }) }
})

test('trusted network service disposal awaits pending carrier startup and immediately closes the late listener',async () => {
  const root = mkdtempSync(join(tmpdir(),'dsh-trusted-startup-'))
  const port = await unusedPort()
  const ctx = new Context()
  let completeStartup,carrier
  const pending = new Promise(resolve => { completeStartup = resolve })
  try {
    await ctx.plugin({ name: 'trusted-startup-ledger',apply(ctx) { ctx.provide('taskSystem',{ ledger: { pendingRuns: () => [] } }) } }).await()
    const owned = new RecoveryStore(join(root,'recovery.sqlite'))
    const service = new plugin.RemoteExecutionService(ctx,plugin.Config({ role: 'planner',nodeId: 'planner',audience: 'planner',statePath: join(root,'recovery.sqlite'),paused:true,pauseScope:'executor',authMode: 'trusted-network',trustedNetwork: policy(port),exposeHttp: true,routePath: '/commands' }),ctx.get('taskSystem').ledger,owned)
    const attaching = service.attachCarrier(pending)
    const disposal = service.dispose()
    assert.equal(service.dispose(),disposal,'concurrent callers must await the same disposal work')
    let disposed = false
    void disposal.then(() => { disposed = true })
    carrier = await startTrustedNetworkCarrier(service.gateway,{ ...policy(port),routePath: '/commands' })
    assert.equal(disposed,false,'disposal must not finish before pending startup resolves')
    completeStartup(carrier)
    await attaching
    await disposal
    assert.equal(carrier.server.listening,false)
    const rebind = http.createServer()
    assert.equal(await listen(rebind,port),port)
    await close(rebind)
    await assert.rejects(service.gateway.handle(body(),context(port)),/DRAINING/)
    await service.dispose()
  } finally { completeStartup(carrier ?? { close: async () => {} }); await carrier?.close(); await ctx.fiber.dispose(); rmSync(root,{ recursive: true,force: true }) }
})

test('actual trusted network HTTP ledger flow survives disconnect, lost ACK and durable client/server restart without duplicate effects',async () => {
  const root = mkdtempSync(join(tmpdir(),'dsh-trusted-http-'))
  const port = await unusedPort()
  const network = policy(port)
  const serverFile = join(root,'server.sqlite'),clientFile = join(root,'client.sqlite')
  const ledger = TaskLedger.open(join(root,'ledger.sqlite'),{ role: 'planner',nodeId: 'planner',now: () => now })
  let serverStore,clientStore,gateway,client,server,remote
  let submitCalls = 0,dropResultAck = false
  const received = []
  const submit = ledger.submit.bind(ledger)
  ledger.submit = (...args) => { submitCalls++; return submit(...args) }
  const start = async () => {
    serverStore = new RecoveryStore(serverFile)
    serverStore.recover()
    clientStore = new RecoveryStore(clientFile)
    gateway = new RemoteGateway({ role: 'planner',nodeId: 'planner',ledger,store: serverStore,now: () => now,verifier: new TrustedNetworkVerifier({ audience: 'planner',...network }) })
    const handle = gateway.handle.bind(gateway)
    gateway.handle = async (data,socket) => { const command = JSON.parse(Buffer.from(data).toString('utf8')); received.push(command); return handle(data,socket) }
    const handler = httpHandler(gateway,{ trustedNetwork: network })
    server = http.createServer((req,res) => {
      const end = res.end.bind(res)
      res.end = (...args) => {
        if (dropResultAck && serverStore.receipt('worker','result')?.state === 'done') { dropResultAck = false; req.socket.destroy(); return res }
        return end(...args)
      }
      void handler(req,res)
    })
    await listen(server,port)
    client = new RemoteClient(clientOptions(port,clientStore))
    remote = new RemoteLedgerClient(client,'worker')
  }
  const stop = async () => { await client?.dispose(); await close(server); await gateway?.dispose(); clientStore?.close(); serverStore?.close() }
  try {
    ledger.registerWorkspace('workspace',{ workspaceId: 'workspace',nodeId: 'worker',path: root,label: 'Disposable fixture',state: 'ready',createdAt: new Date(now).toISOString() })
    ledger.registerNode('node',{ nodeId: 'worker',roles: ['executor'],capabilities: ['read'],models: [{ provider: 'fixture',model: 'fixture',reasoningEfforts: [] }],workspaceIds: ['workspace'],enabled: true,lastSeenAt: new Date(now).toISOString() })
    const task = ledger.createTask('task',{ title: 'Trusted network fixture',workspaceId: 'workspace' }).value
    const run = ledger.createRun('run',{ taskId: task.taskId,route: { nodeId: 'worker',provider: 'fixture',model: 'fixture',requiredCapabilities: ['read'],workspaceId: 'workspace' } }).value
    await start()
    assert.equal((await remote.pendingRuns('worker')).length,1)
    const claimed = await remote.claim('claim',{ runId: run.runId,nodeId: 'worker',ttlMs: 60000 })
    const lease = { runId: run.runId,attemptId: claimed.value.attempt.attemptId,nodeId: 'worker',fence: claimed.value.attempt.fence,executionId: 'fixture-owner' }
    await remote.markRunning('start',lease)
    await remote.bindSession('bind',{ ...lease,sessionId: 'fixture-session' })
    await close(server)
    await assert.rejects(remote.renew('renew',{ ...lease,ttlMs: 60000 }),/REMOTE_OUTCOME_UNCERTAIN/)
    assert.equal(clientStore.outbound('renew').state,'uncertain')
    await listen(server,port)
    await remote.renew('renew',{ ...lease,ttlMs: 60000 })
    const settlement = { ...lease,outcome: 'success',summary: 'Fixture complete',report: { title: 'Trusted network fixture',body: 'No external network, model or user task' } }
    dropResultAck = true
    await assert.rejects(remote.submit('result',settlement),/REMOTE_OUTCOME_UNCERTAIN/)
    assert.equal(ledger.getRun(run.runId).state,'succeeded')
    assert.equal(clientStore.outbound('result').state,'uncertain')
    await stop()
    await start()
    assert.equal((await remote.submit('result',settlement)).value.state,'succeeded')
    assert.equal((await remote.getRun(run.runId)).state,'succeeded')
    assert.equal((await remote.getAttempt(lease.attemptId)).sessionId,'fixture-session')
    assert.equal(submitCalls,1)
    assert.equal(ledger.history(task.taskId).reports.length,1)
    assert.equal((await remote.pendingRuns('worker')).length,0)
    assert.ok(received.length >= 9)
    for (const command of received) { assert.equal(command.version,2); assert.equal(command.authMode,'trusted-network'); assert.equal(Object.hasOwn(command,'signature'),false); assert.equal(Object.hasOwn(command,'keyId'),false) }
    const resultAttempts = received.filter(command => command.commandId === 'result')
    assert.equal(resultAttempts.length,2)
    assert.notEqual(resultAttempts[0].nonce,resultAttempts[1].nonce)
    assert.ok(resultAttempts[1].sequence > resultAttempts[0].sequence)
  } finally { await stop(); ledger.close(); rmSync(root,{ recursive: true,force: true }) }
})
