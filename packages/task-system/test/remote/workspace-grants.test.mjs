import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, renameSync,unlinkSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Config, RemoteExecutionService } from '../../dist/remote/index.js'
import { RecoveryStore, RemoteClient, RemoteLedgerClient, RemoteGateway, IdentityVerifier, signEnvelope, authorizedWorkspace } from '../../dist/remote/api.js'
import { executorWorkspaceSnapshot, localWorkspaceBindings } from '../../dist/remote/workspace-grants.js'

function local(t, { paused = true, configured = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-grants-')))
  const first = join(root, 'first'), second = join(root, 'second')
  mkdirSync(first); mkdirSync(second)
  const entries = [{ id: 'registry-one', title: 'Existing project', path: first }, { id: 'private-two', title: 'Private directory', path: second }]
  const registry = { list: () => entries }, native = { activeCount: 0 }, ctx = new Context(), ledger = {}
  ctx.provide('workspaceRegistry', registry)
  ctx.provide('taskSystem', { ledger, native })
  const config = Config({ role: 'executor', nodeId: 'worker', statePath: join(root, 'remote.sqlite'), paused, pollIntervalMs: 0, workspaces: configured })
  const store = paused ? undefined : new RecoveryStore(config.statePath)
  const service = new RemoteExecutionService(ctx, config, ledger, store)
  t.after(async () => { await service.dispose(); rmSync(root, { recursive: true, force: true }) })
  return { root, first, second, entries, registry, native, service, config, store, ledger }
}

test('owner selects an existing registry directory explicitly; CAS, durable identity and revocation survive restart', async t => {
  const f = local(t)
  const initial = await f.service.workspaceGrantCatalog()
  assert.equal(initial.revision, 0)
  assert.deepEqual(initial.items.map(item => [item.registryId, item.enabled, item.state, item.source]), [['registry-one', false, 'ready', 'local'], ['private-two', false, 'ready', 'local']])
  const first = await f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 0 })
  assert.equal(first.revision, 1); assert.equal(first.publication, 'not-connected')
  assert.equal(first.items[0].path, f.first); assert.equal(first.items[0].workspaceId, initial.items[0].workspaceId)
  assert.equal(first.items[1].enabled, false); assert.deepEqual(f.service.config.workspaces, [])
  await assert.rejects(f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: false, expectedRevision: 0 }), { code: 'WORKSPACE_GRANT_CONFLICT' })
  await assert.rejects(f.service.setLocalWorkspaceGrant({ registryId: 'unknown', enabled: true, expectedRevision: 1 }), { code: 'WORKSPACE_REGISTRY_ENTRY_REQUIRED' })
  await assert.rejects(f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 1, path: f.second }))
  await f.service.dispose()
  const ctx = new Context(); ctx.provide('workspaceRegistry', f.registry); ctx.provide('taskSystem', { ledger: {} })
  const restored = new RemoteExecutionService(ctx, f.config, {})
  t.after(() => restored.dispose())
  assert.deepEqual(await restored.workspaceGrantCatalog(), { nodeId: 'worker', revision: 1, items: first.items })
  const revoked = await restored.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: false, expectedRevision: 1 })
  assert.equal(revoked.revision, 2); assert.equal(revoked.items[0].state, 'revoked')
  const recovery = new RecoveryStore(f.config.statePath)
  try {
    assert.deepEqual(localWorkspaceBindings('worker', recovery, f.registry), [])
    assert.deepEqual(executorWorkspaceSnapshot('worker', recovery, [], f.registry).map(item => [item.workspaceId, item.state]), [[first.items[0].workspaceId, 'revoked']])
  } finally { recovery.close() }
})

test('live executor authorization rejects revoked, missing, moved and symlink-replaced local grants', async t => {
  const f = local(t, { paused: false })
  const granted = await f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 0 })
  const workspaceId = granted.items[0].workspaceId
  const provider = { id: 'fixture', capabilities: [], supports: () => true }
  const claim = { task: { taskId: 'task', workspaceId }, run: { runId: 'run', taskId: 'task', route: { nodeId: 'worker', workspaceId, requiredCapabilities: [] } }, attempt: { nodeId: 'worker', taskId: 'task', runId: 'run' } }
  const policy = { role: 'executor', nodeId: 'worker', capabilities: [], get workspaces() { return localWorkspaceBindings('worker', f.store, f.registry) } }
  assert.equal(await authorizedWorkspace(claim, policy, provider), f.first)
  assert.deepEqual(executorWorkspaceSnapshot('worker', f.store, [], f.registry).map(item => item.path), [f.first])
  f.entries[0].path = f.second
  await assert.rejects(authorizedWorkspace(claim, policy, provider), { code: 'WORKSPACE_DENIED' })
  assert.equal(executorWorkspaceSnapshot('worker', f.store, [], f.registry)[0].state, 'unavailable')
  f.entries[0].path = f.first
  renameSync(f.first, `${f.first}-original`); symlinkSync(f.second, f.first)
  await assert.rejects(authorizedWorkspace(claim, policy, provider), { code: 'WORKSPACE_DENIED' })
  await assert.rejects(f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 1 }), { code: 'WORKSPACE_GRANT_PATH_INVALID' })
  unlinkSync(f.first); renameSync(`${f.first}-original`, f.first)
  await f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: false, expectedRevision: 1 })
  await assert.rejects(authorizedWorkspace(claim, policy, provider), { code: 'WORKSPACE_DENIED' })
  assert.equal((await f.service.workspaceGrantCatalog()).revision, 2)
})

test('re-authorizing a changed registry path creates a new ID and leaves the original grant revoked', async t => {
  const f = local(t, { paused: false })
  const original = await f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 0 })
  const oldId = original.items[0].workspaceId
  f.entries[0].path = f.second
  const changed = await f.service.workspaceGrantCatalog()
  assert.equal(changed.items[0].enabled, false)
  assert.notEqual(changed.items[0].workspaceId, oldId)
  const authorized = await f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 1 })
  const next = authorized.items.find(item => item.registryId === 'registry-one' && item.path === f.second)
  assert.equal(next.enabled, true); assert.notEqual(next.workspaceId, oldId)
  assert.equal(authorized.items.find(item => item.workspaceId === oldId).state, 'revoked')
  assert.equal(authorized.items.find(item => item.workspaceId === oldId).registryId, '')
  const snapshot = executorWorkspaceSnapshot('worker', f.store, [], f.registry)
  assert.equal(snapshot.find(item => item.workspaceId === oldId).state, 'revoked')
  assert.deepEqual(localWorkspaceBindings('worker', f.store, f.registry).map(item => [item.workspaceId, item.path]), [[next.workspaceId, f.second]])
})

test('owner edits are rejected while native work or worker dispatch is active; configured grants remain configuration owned', async t => {
  const f = local(t, { paused: false })
  f.native.activeCount = 1
  await assert.rejects(f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 0 }), { code: 'CONFIGURATION_BUSY' })
  f.native.activeCount = 0
  const worker = f.service.createWorker({ id: 'fixture', capabilities: [], supports: () => true, execute: async () => ({ outcome: 'success', summary: 'fixture' }) })
  const release = await worker.beginConfigurationEdit()
  try { await assert.rejects(f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 0 }), { code: 'CONFIGURATION_BUSY' }) } finally { release() }
  assert.equal((await f.service.workspaceGrantCatalog()).revision, 0)
  f.service.config.workspaces.push({ workspaceId: 'configured', nodeId: 'worker', path: f.first, allowedRoot: f.first })
  assert.equal((await f.service.workspaceGrantCatalog()).items[0].source, 'configuration')
  await assert.rejects(f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 0 }), { code: 'WORKSPACE_GRANT_CONFIGURED' })
  f.service.config.workspaces[0].allowedRoot = f.second
  assert.equal((await f.service.workspaceGrantCatalog()).items[0].state, 'unavailable')
  assert.equal(executorWorkspaceSnapshot('worker', f.store, f.service.config.workspaces, f.registry)[0].state, 'unavailable')
})

test('the live service worker observes local grants, blocks edits during execution and rejects the same route after revocation', async t => {
  const f = local(t, { paused: false })
  const granted = await f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 0 })
  const workspaceId = granted.items[0].workspaceId
  let attempt, run, entered, release, effects = 0
  const started = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve)
  t.after(() => release())
  const receipt = (commandId, value) => ({ commandId, value: structuredClone(value) })
  Object.assign(f.ledger, {
    claim: (id, input) => {
      run = { runId: input.runId, taskId: 'task', route: { nodeId: 'worker', workspaceId, provider: 'fixture', model: 'fixture', requiredCapabilities: [] } }
      attempt = { attemptId: `attempt-${input.runId}`, runId: input.runId, taskId: 'task', nodeId: 'worker', fence: 1, state: 'leased', leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }
      return receipt(id, { task: { taskId: 'task', title: 'Fixture', workspaceId }, run, attempt })
    },
    markRunning: (id, lease) => { Object.assign(attempt, { executionId: lease.executionId, state: 'running' }); return receipt(id, attempt) },
    bindSession: (id, input) => { attempt.sessionId = input.sessionId; return receipt(id, attempt) },
    renew: id => receipt(id, attempt),
    submit: id => receipt(id, { ...run, state: 'succeeded' }),
  })
  const worker = f.service.createWorker({ id: 'fixture', capabilities: [], supports: () => true, execute: async input => { effects++; assert.ok(input.workspacePath.startsWith(f.first)); entered(); await gate; return { outcome: 'success', summary: 'Local grant execution' } } })
  const running = worker.execute('first', 'claim-first')
  await started
  await assert.rejects(f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: false, expectedRevision: 1 }), { code: 'CONFIGURATION_BUSY' })
  release(); assert.equal((await running).state, 'acknowledged')
  await f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: false, expectedRevision: 1 })
  await assert.rejects(worker.execute('second', 'claim-second'), { code: 'WORKSPACE_DENIED' })
  assert.equal(effects, 1)
})

test('service heartbeat automatically publishes only configured and persisted grants with physical availability', async t => {
  const f = local(t, { paused: false }), samples = []
  f.service.config.coordinator = { endpoint: 'https://fixture.invalid/commands', audience: 'planner', nativeRoutes: [] }
  f.service.coordinatorLedger = { recordNodeHeartbeat: (id, sample) => { samples.push(sample); return { commandId: id, value: {} } } }
  await f.service.heartbeatNow()
  assert.deepEqual(samples[0].workspaces, [])
  const granted = await f.service.setLocalWorkspaceGrant({ registryId: 'registry-one', enabled: true, expectedRevision: 0 })
  assert.equal(granted.publication, 'acknowledged')
  assert.deepEqual(samples.at(-1).workspaces.map(item => [item.path, item.state]), [[f.first, 'ready']])
  assert.equal(JSON.stringify(samples).includes('private-two'), false)
  renameSync(f.first, `${f.first}-moved`)
  await f.service.heartbeatNow()
  assert.equal(samples.at(-1).workspaces[0].state, 'unavailable')
})

const keys = generateKeyPairSync('ed25519') // Disposable fixture keys.
function transport(t, { managedAccess = false, unsupported = false } = {}) {
  const now = Date.now(), calls = [], store = new RecoveryStore(':memory:'), outbound = new RecoveryStore(':memory:')
  const peer = { keyId: 'fixture', nodeId: 'worker', audience: 'planner', publicKey: keys.publicKey, operations: ['heartbeat'], workspaces: ['authorized'], capabilities: [] }
  const ledger = { nodeStatuses: () => [{ nodeId: 'worker', state: 'online' }], recordNodeHeartbeat: (commandId, value) => { calls.push(['heartbeat', commandId, value]); return { commandId, value } }, ...(!unsupported && { recordExecutorWorkspaces: (commandId, value) => { calls.push(['workspaces', commandId, value]); return { commandId, value } } }) }
  const verifier = managedAccess ? { authMode: 'ed25519', verify: (envelope, clock, network) => ({ ...new IdentityVerifier({ audience: 'planner', peers: [peer] }).verify(envelope, clock, network), managedAccess: true }) } : new IdentityVerifier({ audience: 'planner', peers: [peer] })
  const gateway = new RemoteGateway({ role: 'planner', nodeId: 'planner', ledger, store, now: () => now, verifier })
  const client = new RemoteClient({ endpoint: 'https://fixture.invalid/commands', nodeId: 'worker', audience: 'planner', keyId: 'fixture', privateKey: keys.privateKey, store: outbound, now: () => now, fetch: async (_, options) => new Response(JSON.stringify(await gateway.handle(options.body))) })
  t.after(async () => { await client.dispose(); await gateway.dispose(); store.close(); outbound.close() })
  let sequence = 1000
  const raw = workspaces => { sequence++; return JSON.stringify(signEnvelope({ version: 1, keyId: 'fixture', nodeId: 'worker', audience: 'planner', commandId: `raw-${sequence}`, nonce: `nonce-${sequence}`, sequence, issuedAt: now, expiresAt: now + 60000, operation: 'heartbeat', payload: { sampledAt: now, runtimeReady: true, activeExecutions: 0, workspaces } }, keys.privateKey)) }
  return { now, calls, gateway, remote: new RemoteLedgerClient(client, 'worker'), raw }
}
const metadata = { workspaceId: 'authorized', nodeId: 'worker', label: 'Explicit directory', path: '/controlled/project', state: 'ready' }

test('signed heartbeat carries only explicit grants through the real client and gateway; omissions remain compatible', async t => {
  const f = transport(t)
  await f.remote.recordNodeHeartbeat('sample', { nodeId: 'worker', sampledAt: f.now, runtimeReady: true, activeExecutions: 0, workspaces: [metadata] })
  assert.deepEqual(f.calls.map(call => call[0]), ['workspaces', 'heartbeat'])
  assert.deepEqual(f.calls[0][2], { nodeId: 'worker', sampledAt: f.now, workspaces: [metadata] })
  assert.ok(f.calls[0][1].endsWith(':workspaces'))
  await f.remote.recordNodeHeartbeat('revoke', { nodeId: 'worker', sampledAt: f.now, runtimeReady: true, activeExecutions: 0, workspaces: [{ ...metadata, state: 'revoked' }] })
  assert.equal(f.calls[2][2].workspaces[0].state, 'revoked')
  await f.remote.recordNodeHeartbeat('legacy', { nodeId: 'worker', sampledAt: f.now, runtimeReady: true, activeExecutions: 0 })
  assert.equal(f.calls.length, 5); assert.equal(f.calls[4][0], 'heartbeat')
})

test('gateway rejects foreign node, duplicate IDs, path escape spelling, unknown fields and oversized snapshots before mutation', async t => {
  const f = transport(t)
  for (const [values, code] of [
    [[{ ...metadata, nodeId: 'victim' }], 'WORKSPACE_NODE_MISMATCH'],
    [[metadata, metadata], 'DUPLICATE_EXECUTOR_WORKSPACE'],
    [[{ ...metadata, path: '/controlled/../private' }], 'INVALID_EXECUTOR_WORKSPACES'],
    [[{ ...metadata, allowedRoot: '/' }], 'INVALID_EXECUTOR_WORKSPACES'],
    [Array.from({ length: 65 }, (_, index) => ({ ...metadata, workspaceId: `workspace-${index}` })), 'INVALID_EXECUTOR_WORKSPACES'],
  ]) await assert.rejects(f.gateway.handle(f.raw(values)), { code })
  assert.deepEqual(f.calls, [])
  const old = transport(t, { unsupported: true })
  await assert.rejects(old.gateway.handle(old.raw([metadata])), { code: 'WORKSPACE_CATALOG_UNSUPPORTED' })
  assert.deepEqual(old.calls, [])
  const managed = transport(t, { managedAccess: true })
  await managed.gateway.handle(managed.raw([{ ...metadata, workspaceId: 'new-local-grant' }]))
  assert.equal(managed.calls[0][2].workspaces[0].workspaceId, 'new-local-grant')
  await assert.rejects(managed.gateway.handle(managed.raw([{ ...metadata, nodeId: 'victim' }])), { code: 'WORKSPACE_NODE_MISMATCH' })
})

test('static peer workspace allowlist filters advertisements without expanding grants and later authorized snapshots remain visible',async t=>{
 const f=transport(t);
 await f.gateway.handle(f.raw([{...metadata,workspaceId:'not-allowed-by-static-peer'}]));
 assert.deepEqual(f.calls[0][2].workspaces,[]);
 await f.gateway.handle(f.raw([metadata]));
 assert.deepEqual(f.calls[2][2].workspaces,[metadata]);
});

function trustedRegistry(f) {
 f.service.config.coordinator={endpoint:'http://127.0.0.1:49152/commands',audience:'planner',authMode:'trusted-network',trustedNetwork:{address:'127.0.0.1',port:49152,localAddress:'127.0.0.1',allowHttp:true},nativeRoutes:[]};
 const provider={id:'fixture',capabilities:[],supports:()=>true};
 const claim=workspaceId=>({task:{taskId:'task',workspaceId},run:{runId:'run',taskId:'task',route:{nodeId:'worker',workspaceId,requiredCapabilities:[]}},attempt:{nodeId:'worker',taskId:'task',runId:'run'}});
 const policy={role:'executor',nodeId:'worker',capabilities:[],get workspaces(){return f.service.workspaceBindings()}};
 return {authorize:id=>authorizedWorkspace(claim(id),policy,provider)};
}

test('trusted registry directories are discoverable and executable from the same live source without creating local grants',async t=>{
 const f=local(t,{paused:false}),g=trustedRegistry(f),samples=[];
 const catalog=await f.service.workspaceGrantCatalog();
 assert.deepEqual(catalog.items.map(i=>[i.source,i.enabled,i.available]),[['registry',true,true],['registry',true,true]]);
 assert.deepEqual(f.store.workspaceGrantState(),{revision:0,grants:[]});
 f.service.coordinatorLedger={recordNodeHeartbeat:(id,sample)=>{samples.push(sample);return {commandId:id,value:{}}}};
 await f.service.heartbeatNow();assert.deepEqual(samples[0].workspaces.map(i=>i.workspaceId),catalog.items.map(i=>i.workspaceId));
 assert.equal(await g.authorize(catalog.items[0].workspaceId),f.first);
 f.entries.splice(0,1);await assert.rejects(g.authorize(catalog.items[0].workspaceId),{code:'WORKSPACE_DENIED'});
 await f.service.heartbeatNow();assert.equal(samples.at(-1).workspaces.some(i=>i.workspaceId===catalog.items[0].workspaceId),false);
});

test('registry path changes get new identities; explicit disabled directories stay disabled and can be re-enabled',async t=>{
 const f=local(t,{paused:false}),g=trustedRegistry(f),first=(await f.service.workspaceGrantCatalog()).items[0];
 const disabled=await f.service.setLocalWorkspaceGrant({registryId:'registry-one',enabled:false,expectedRevision:0});
 assert.equal(disabled.items[0].enabled,false);assert.equal(disabled.items[0].state,'revoked');assert.equal(disabled.items[0].available,true);
 await assert.rejects(g.authorize(first.workspaceId),{code:'WORKSPACE_DENIED'});
 const next=join(f.root,'changed');mkdirSync(next);f.entries[0].path=next;
 const changed=(await f.service.workspaceGrantCatalog()).items[0];assert.notEqual(changed.workspaceId,first.workspaceId);assert.equal(changed.enabled,false);
 const enabled=await f.service.setLocalWorkspaceGrant({registryId:'registry-one',enabled:true,expectedRevision:1});
 const current=enabled.items.find(i=>i.registryId==='registry-one');assert.equal(current.enabled,true);assert.equal(await g.authorize(current.workspaceId),next);
 await assert.rejects(g.authorize(first.workspaceId),{code:'WORKSPACE_DENIED'});
 renameSync(next,next+'-missing');assert.equal((await f.service.workspaceGrantCatalog()).items[0].available,false);await assert.rejects(g.authorize(current.workspaceId),{code:'WORKSPACE_DENIED'});
});

test('configuration roots take precedence and signed connections do not auto-adopt native registry directories',async t=>{
 const f=local(t,{paused:false});assert.equal((await f.service.workspaceGrantCatalog()).items.every(i=>!i.enabled),true);assert.deepEqual(f.service.workspaceBindings(),[]);
 trustedRegistry(f);f.service.config.workspaces.push({workspaceId:'configured',nodeId:'worker',path:f.first,allowedRoot:f.second});
 const catalog=await f.service.workspaceGrantCatalog();assert.equal(catalog.items[0].source,'configuration');assert.equal(catalog.items[0].state,'unavailable');assert.equal(catalog.items[0].available,false);
 assert.equal(f.service.workspaceBindings().some(w=>w.path===f.first),false);
 const staticPeer=transport(t);await staticPeer.gateway.handle(staticPeer.raw([{workspaceId:catalog.items[1].workspaceId,nodeId:'worker',label:'Registry',path:f.second,state:'ready'}]));assert.deepEqual(staticPeer.calls[0][2].workspaces,[]);
 const managed=transport(t,{managedAccess:true});await managed.gateway.handle(managed.raw([{workspaceId:catalog.items[1].workspaceId,nodeId:'worker',label:'Registry',path:f.second,state:'ready'}]));assert.equal(managed.calls[0][2].workspaces[0].workspaceId,catalog.items[1].workspaceId);
});
