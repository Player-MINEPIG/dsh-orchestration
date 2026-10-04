import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { TaskLedger } from '../../dist/index.js'
import * as plugin from '../../dist/remote/index.js'
import { IdentityVerifier, RecoveryStore, RemoteGateway, RemoteClient, RemoteLedgerClient, ExecutorWorker, observationForwarder, signEnvelope, digest } from '../../dist/remote/api.js'

const keyA = generateKeyPairSync('ed25519'), keyB = generateKeyPairSync('ed25519') // disposable fixtures only
const operations = ['observe','receipt','listWork','claim','bindSession','markRunning','renew','submit','getRun','getAttempt','acknowledgeCancellation']
const peers = [
  { keyId: 'key-a',nodeId: 'node-a',publicKey: keyA.publicKey,audience: 'planner',operations,workspaces: ['workspace'],capabilities: ['read'] },
  { keyId: 'key-b',nodeId: 'node-b',publicKey: keyB.publicKey,audience: 'planner',operations: ['observe','receipt'],workspaces: ['workspace'],capabilities: [] },
]
const observation = { workspaceId: 'workspace',sessionId: 'same-session',sourceRevision: '1',title: 'Observation',body: 'Explicit observation only',observedAt: '2026-10-01T12:00:00.000Z',truncated: false }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'dsh-observe-')); const resources = []
  t.after(async () => { for (const value of resources.reverse()) await (value.dispose?.() ?? value.close?.()); rmSync(root,{ recursive: true,force: true }) })
  const ledger = TaskLedger.open(join(root,'ledger.sqlite'),{ role: 'planner',nodeId: 'planner' }); resources.push(ledger)
  const serverStore = new RecoveryStore(join(root,'server.sqlite')); resources.push(serverStore)
  const gateway = new RemoteGateway({ role: 'planner',nodeId: 'planner',ledger,store: serverStore,verifier: new IdentityVerifier({ audience: 'planner',peers }) }); resources.push(gateway)
  const clients = (node = 'node-a',fetcher) => {
    const recovery = new RecoveryStore(join(root,`${node}.sqlite`)); resources.push(recovery)
    const client = new RemoteClient({ endpoint: 'https://fixture.invalid/commands',audience: 'planner',nodeId: node,keyId: node === 'node-a' ? 'key-a' : 'key-b',privateKey: node === 'node-a' ? keyA.privateKey : keyB.privateKey,store: recovery,
      fetch: fetcher ?? (async (_url,options) => new Response(JSON.stringify(await gateway.handle(options.body)))) }); resources.push(client)
    return { recovery,client,remote: new RemoteLedgerClient(client,node) }
  }
  return { root,resources,ledger,serverStore,gateway,clients }
}
function envelope(payload,overrides = {}) {
  const now = Date.now()
  return signEnvelope({ version: 1,keyId: 'key-a',nodeId: 'node-a',audience: 'planner',commandId: 'raw-command',nonce: 'raw-nonce',sequence: 100,issuedAt: now,expiresAt: now + 60000,operation: 'observe',payload,...overrides },keyA.privateKey)
}

test('actual TaskLedger signed observation: node/session isolation, bounded input, no task/run authority', async t => {
  const f = fixture(t); const a = f.clients(), b = f.clients('node-b')
  const first = await a.remote.observe('first',observation)
  const duplicate = await a.remote.observe('same-source-new-delivery',observation)
  assert.equal(first.value.candidateId,duplicate.value.candidateId)
  const other = await b.remote.observe('first',{ ...observation,body: 'Other authenticated node' })
  assert.notEqual(first.value.candidateId,other.value.candidateId)
  assert.match(first.value.sourceId,/^remote-dsh:node-a:workspace:/)
  assert.equal(f.ledger.observationCandidates('pending').length,2)
  assert.equal(f.ledger.snapshot().tasks.length,0); assert.equal(f.ledger.snapshot().runs.length,0)
  for (const payload of [{ ...observation,nodeId: 'node-b' },{ ...observation,sourceId: other.value.sourceId },{ ...observation,taskId: 'injected' },{ ...observation,cwd: '/secret' },{ ...observation,body: 'x'.repeat(8001) }]) {
    await assert.rejects(f.gateway.handle(JSON.stringify(envelope(payload))),/PAYLOAD_FIELDS|INVALID_OBSERVATION_BODY/)
  }
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope(observation,{ nodeId: 'node-b' }))),/WRONG_NODE/)
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope({ ...observation,workspaceId: 'private-workspace' }))),/WORKSPACE_DENIED/)
})

test('actual TaskLedger committed capture recovers from lost gateway receipt after restart without recapturing', async t => {
  const f = fixture(t); let captures = 0
  const capture = f.ledger.captureObservation.bind(f.ledger)
  f.ledger.captureObservation = (...args) => { captures++; return capture(...args) }
  const complete = f.serverStore.complete.bind(f.serverStore); let fail = true
  f.serverStore.complete = (...args) => { if (fail) { fail = false; throw new Error('crash before gateway receipt') } return complete(...args) }
  const { client,remote,recovery } = f.clients()
  await assert.rejects(remote.captureObservation('capture-crash',observation),/REMOTE_OUTCOME_UNCERTAIN/)
  assert.equal(f.serverStore.receipt('node-a','capture-crash').state,'uncertain')
  assert.equal(f.ledger.commandReceipt(`remote-${digest(['node-a','capture-crash'])}`).value.state,'pending')
  await client.dispose(); recovery.close(); await f.gateway.dispose(); f.serverStore.close()
  const restartedStore = new RecoveryStore(join(f.root,'server.sqlite')); f.resources.push(restartedStore); restartedStore.recover()
  const restartedGateway = new RemoteGateway({ role: 'planner',nodeId: 'planner',ledger: f.ledger,store: restartedStore,verifier: new IdentityVerifier({ audience: 'planner',peers }) }); f.resources.push(restartedGateway)
  const restarted = f.clients('node-a',async (_url,options) => new Response(JSON.stringify(await restartedGateway.handle(options.body))))
  const results = await restarted.remote.recoverObservations()
  assert.equal(results.length,1); assert.equal(results[0].state,'done'); assert.equal(captures,1)
  assert.equal(restartedStore.receipt('node-a','capture-crash').state,'done')
  assert.equal(f.ledger.observationCandidates().length,1)
  assert.equal((await restarted.remote.recoverObservations()).length,0)
})

test('matching durable receipt required; absent or foreign receipt never causes reexecution', async t => {
  const f = fixture(t); let captures = 0
  f.ledger.captureObservation = () => { captures++; throw new Error('unknown capture') }
  const a = f.clients()
  await assert.rejects(a.remote.observe('uncertain',observation),/REMOTE_OUTCOME_UNCERTAIN/)
  f.ledger.commandReceipt = () => ({ commandId: 'foreign-command',acceptedAt: new Date().toISOString(),value: { state: 'pending' } })
  assert.equal((await a.remote.recoverObservations())[0].state,'uncertain'); assert.equal(captures,1)
  f.ledger.commandReceipt = () => undefined
  assert.equal((await a.remote.recoverObservations())[0].state,'uncertain'); assert.equal(captures,1)
})

test('workspace observation forwarder sends only captured cwd under both roots; no raw path on wire', async t => {
  const f = fixture(t); const workspace = join(f.root,'allowed'); const outside = join(f.root,'outside'); mkdirSync(workspace); mkdirSync(outside)
  const escape = join(workspace,'escape'); symlinkSync(outside,escape)
  let sends = 0; let wire
  const { remote } = f.clients('node-a',async (_url,options) => { sends++; wire = JSON.parse(options.body); return new Response(JSON.stringify(await f.gateway.handle(options.body))) })
  const forward = observationForwarder(remote,{ workspaceId: 'workspace',nodeId: 'node-a',path: workspace,allowedRoot: f.root })
  for (const cwd of [undefined,outside,escape]) assert.equal((await forward({ ...observation,cwd })).state,'local-only')
  assert.equal(sends,0)
  assert.equal((await forward({ ...observation,cwd: workspace })).value.state,'pending'); assert.equal(sends,1)
  assert.equal(Object.hasOwn(wire.payload,'cwd'),false); assert.equal(Object.hasOwn(wire.payload,'sourceId'),false)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(forward({ ...observation,cwd: workspace },{ signal: abort.signal }),/TRANSPORT_ABORTED/)
  assert.equal(sends,1)
})

test('actual Cordis config bootstrap discovers and executes native route through signed planner; native/network mocked', async t => {
  const f = fixture(t); const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const oldFetch = globalThis.fetch, envName = 'DSH_REMOTE_DISPOSABLE_TEST_KEY', previous = process.env[envName]
  process.env[envName] = keyA.privateKey.export({ type: 'pkcs8',format: 'pem' })
  t.after(() => { globalThis.fetch = oldFetch; if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous })
  globalThis.fetch = async (_url,options) => new Response(JSON.stringify(await f.gateway.handle(options.body)))
  f.ledger.registerWorkspace('ws',{ workspaceId: 'workspace',nodeId: 'node-a',path: f.root,label: 'fixture',state: 'ready',createdAt: new Date().toISOString() })
  f.ledger.registerNode('node',{ nodeId: 'node-a',roles: ['executor'],capabilities: ['read'],models: [{ provider: 'vendor-a',model: 'fixture',reasoningEfforts: [] }],workspaceIds: ['workspace'],enabled: true,lastSeenAt: new Date().toISOString() })
  const task = f.ledger.createTask('task',{ title: 'Config bootstrap',workspaceId: 'workspace' }).value
  const run = f.ledger.createRun('run',{ taskId: task.taskId,route: { nodeId: 'node-a',provider: 'vendor-a',model: 'fixture',workspaceId: 'workspace',requiredCapabilities: ['read'] } }).value
  let executions = 0, sink, detached = false
  const local = { ledger: {},config: { autoAdmitObservations: false },native: { executeExternal: async request => { executions++; assert.equal(request.claim.run.runId,run.runId); return { outcome: 'success',summary: 'native boundary fixture' } } },subscribeObservations(fn) { sink = fn; return () => { detached = true } } }
  await ctx.plugin({ apply(ctx) { ctx.provide('taskSystem',local) } })
  const fiber = ctx.plugin(plugin,{ role: 'executor',nodeId: 'node-a',statePath: join(f.root,'host.sqlite'),capabilities: ['read'],workspaces: [{ workspaceId: 'workspace',nodeId: 'node-a',path: f.root,allowedRoot: f.root }],pollIntervalMs: 100,
    coordinator: { endpoint: 'https://fixture.invalid/commands',audience: 'planner',keyId: 'key-a',privateKeyEnv: envName,nativeRoutes: [{ provider: 'vendor-a',models: [{ model: 'fixture',reasoningEfforts: [] }] },{ provider: 'vendor-b',models: [{ model: 'other',reasoningEfforts: ['low'] }] }] },observationForwarding: { workspaceId: 'workspace' },
  }); await fiber
  for (let i = 0; i < 100 && f.ledger.getRun(run.runId).state !== 'succeeded'; i++) await delay(10)
  assert.equal(f.ledger.getRun(run.runId).state,'succeeded'); assert.equal(executions,1)
  assert.ok(ctx.get('remoteExecution').nativeWorker)
  await sink({ ...observation,cwd: f.root },{ signal: new AbortController().signal })
  assert.equal(f.ledger.observationCandidates().length,1)
  await fiber.dispose(); assert.equal(detached,true); assert.equal(ctx.get('remoteExecution'),undefined)
  const previousExecutions = executions; await delay(120); assert.equal(executions,previousExecutions)
})

test('actual TaskLedger committed settlement recovers receipt without a second submit or reopened lease', async t => {
  const f = fixture(t)
  f.ledger.registerWorkspace('ws',{ workspaceId: 'workspace',nodeId: 'node-a',path: f.root,label: 'fixture',state: 'ready',createdAt: new Date().toISOString() })
  f.ledger.registerNode('node',{ nodeId: 'node-a',roles: ['executor'],capabilities: ['read'],models: [{ provider: 'fixture',model: 'fixture',reasoningEfforts: [] }],workspaceIds: ['workspace'],enabled: true,lastSeenAt: new Date().toISOString() })
  const task = f.ledger.createTask('task',{ title: 'Recover result',workspaceId: 'workspace' }).value
  const run = f.ledger.createRun('run',{ taskId: task.taskId,route: { nodeId: 'node-a',provider: 'fixture',model: 'fixture',workspaceId: 'workspace',requiredCapabilities: ['read'] } }).value
  const { remote } = f.clients(); const claim = (await remote.claim('claim',{ runId: run.runId,nodeId: 'node-a',ttlMs: 60000 })).value
  const input = { runId: run.runId,attemptId: claim.attempt.attemptId,nodeId: 'node-a',fence: claim.attempt.fence,outcome: 'success',summary: 'Committed before transport loss' }
  let submits = 0; const submit = f.ledger.submit.bind(f.ledger)
  f.ledger.submit = (...args) => { submits++; return submit(...args) }
  const complete = f.serverStore.complete.bind(f.serverStore)
  f.serverStore.complete = (node,id,result) => { if (id === 'submit-crash') throw new Error('journal completion lost'); return complete(node,id,result) }
  await assert.rejects(remote.submit('submit-crash',input),/REMOTE_OUTCOME_UNCERTAIN/)
  assert.equal(f.ledger.getRun(run.runId).state,'succeeded'); assert.equal(submits,1)
  f.serverStore.complete = complete
  const receipt = await remote.submit('submit-crash',input)
  assert.equal(receipt.value.state,'succeeded'); assert.equal(submits,1)
  assert.equal(f.serverStore.receipt('node-a','submit-crash').state,'done')
})

test('native coordinator config rejects forwarding without binding or with a second admission authority', () => {
  assert.equal(plugin.Config({}).coordinator ?? null,null)
  assert.equal(plugin.Config({}).observationForwarding ?? null,null)
  const config = plugin.Config({ role: 'executor',nodeId: 'node-a',statePath: ':memory:',coordinator: { endpoint: 'https://fixture.invalid',audience: 'planner',keyId: 'key-a',privateKeyEnv: 'DSH_REMOTE_CONFIG_TEST_KEY',nativeRoutes: [] },observationForwarding: { workspaceId: 'workspace' } })
  const env = process.env.DSH_REMOTE_CONFIG_TEST_KEY; process.env.DSH_REMOTE_CONFIG_TEST_KEY = keyA.privateKey.export({ type: 'pkcs8',format: 'pem' })
  try {
    const ctx = new Context(); const recovery = new RecoveryStore(':memory:')
    const service = new plugin.RemoteExecutionService(ctx,config,{},recovery)
    assert.throws(() => service.configureCoordinator({ ledger: {},config: { autoAdmitObservations: true },subscribeObservations: () => () => {} }),/OBSERVATION_REQUIRES_SINGLE_AUTHORITY/)
    assert.throws(() => service.configureCoordinator({ ledger: {},config: { autoAdmitObservations: false },subscribeObservations: () => () => {} }),/OBSERVATION_WORKSPACE_BINDING_REQUIRED/)
    recovery.close()
  } finally { if (env === undefined) delete process.env.DSH_REMOTE_CONFIG_TEST_KEY; else process.env.DSH_REMOTE_CONFIG_TEST_KEY = env }
})

test('actual TaskLedger: separate recovery stores sharing node and claim execute once; wrong owner cannot mutate lease', async t => {
  const f = fixture(t)
  f.ledger.registerWorkspace('ws',{ workspaceId: 'workspace',nodeId: 'node-a',path: f.root,label: 'fixture',state: 'ready',createdAt: new Date().toISOString() })
  f.ledger.registerNode('node',{ nodeId: 'node-a',roles: ['executor'],capabilities: ['read'],models: [{ provider: 'fixture',model: 'fixture',reasoningEfforts: [] }],workspaceIds: ['workspace'],enabled: true,lastSeenAt: new Date().toISOString() })
  const task = f.ledger.createTask('task',{ title: 'Competing stores',workspaceId: 'workspace' }).value
  const run = f.ledger.createRun('run',{ taskId: task.taskId,route: { nodeId: 'node-a',provider: 'fixture',model: 'fixture',workspaceId: 'workspace',requiredCapabilities: ['read'] } }).value
  const stores = [new RecoveryStore(join(f.root,'owner-a.sqlite')),new RecoveryStore(join(f.root,'owner-b.sqlite'))]; f.resources.push(...stores)
  assert.notEqual(stores[0].instanceId,stores[1].instanceId)
  let executions = 0, entered, release
  const started = new Promise(resolve => { entered = resolve }), complete = new Promise(resolve => { release = resolve })
  const provider = { id: 'fixture',capabilities: ['read'],supports: route => route.provider === 'fixture' && route.model === 'fixture',execute: async () => { executions++; entered(); await complete; return { outcome: 'success',summary: 'Only one execution' } } }
  const workers = stores.map(store => new ExecutorWorker({ ledger: f.ledger,provider,store,policy: { role: 'executor',nodeId: 'node-a',capabilities: ['read'],workspaces: [{ workspaceId: 'workspace',nodeId: 'node-a',path: f.root,allowedRoot: f.root }] } })); f.resources.push(...workers)
  const attempts = workers.map(worker => worker.execute(run.runId,'same-deterministic-claim'))
  await started
  const rejectedOwner = await Promise.race(attempts)
  assert.equal(rejectedOwner.state,'uncertain'); assert.equal(executions,1)
  const current = f.ledger.getAttempt(rejectedOwner.attemptId)
  const ownerIds = stores.map(store => store.executionId(current.attemptId))
  assert.ok(ownerIds.includes(current.executionId)); assert.notEqual(current.executionId,rejectedOwner.lease.executionId)
  const foreign = { runId: run.runId,attemptId: current.attemptId,nodeId: 'node-a',fence: current.fence,executionId: rejectedOwner.lease.executionId }
  assert.throws(() => f.ledger.renew('foreign-renew',{ ...foreign,ttlMs: 60000 }))
  assert.throws(() => f.ledger.bindSession('foreign-session',{ ...foreign,sessionId: 'foreign-session' }))
  assert.throws(() => f.ledger.submit('foreign-result',{ ...foreign,outcome: 'success',summary: 'Not my result' }))
  assert.equal(f.ledger.getAttempt(current.attemptId).executionId,current.executionId)
  release()
  const results = await Promise.all(attempts)
  assert.equal(results.filter(result => result.state === 'acknowledged').length,1); assert.equal(executions,1)
  assert.equal(f.ledger.getRun(run.runId).state,'succeeded')
  const persistedId = stores[0].instanceId; stores[0].close()
  const reopened = new RecoveryStore(join(f.root,'owner-a.sqlite')); f.resources.push(reopened)
  assert.equal(reopened.instanceId,persistedId); assert.equal(reopened.executionId(current.attemptId),ownerIds[0])
})
