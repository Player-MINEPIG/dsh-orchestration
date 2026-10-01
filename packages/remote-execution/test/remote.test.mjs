import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../dist/index.js'
import { RecoveryStore, IdentityVerifier, signEnvelope, parseEnvelope, RemoteGateway, ExecutorWorker, RemoteClient, RemoteLedgerClient, authorizedWorkspace, assertTransport, assertEndpoint, nativeExecutionAdapter } from '../dist/api.js'

const now = 1780000000000
// Disposable test-only keys, never reused or written into runtime config.
const keys = generateKeyPairSync('ed25519')
const peer = { keyId: 'fixture-key',nodeId: 'worker',publicKey: keys.publicKey,audience: 'planner',operations: ['claim','renew','submit','cancel','receipt','bindSession','markRunning','getRun','getAttempt','acknowledgeCancellation','listWork'],workspaces: ['workspace'],capabilities: ['read'] }
function signed(overrides = {}) { return signEnvelope({ version: 1,keyId: peer.keyId,nodeId: peer.nodeId,audience: peer.audience,commandId: 'command1',nonce: 'nonce1',sequence: 1,issuedAt: now,expiresAt: now + 60000,operation: 'claim',payload: { runId: 'run1',ttlMs: 60000 },...overrides },keys.privateKey) }
function temp(t) { const path = mkdtempSync(join(tmpdir(),'dsh-remote-test-')); t.after(() => rmSync(path,{ recursive: true,force: true })); return path }
function store(t,path = ':memory:') { const value = new RecoveryStore(path); t.after(() => value.close()); return value }
function fixtureLedger(time = () => now) {
  const task = { taskId: 'task1',title: 'Fixture',description: 'No model or external effects',workspaceId: 'workspace' }
  const run = { runId: 'run1',taskId: 'task1',state: 'running',configuration: {},route: { nodeId: 'worker',provider: 'fixture',model: 'fixture-model',workspaceId: 'workspace',requiredCapabilities: ['read'] } }
  const attempt = { attemptId: 'attempt1',taskId: 'task1',runId: 'run1',nodeId: 'worker',fence: 1,state: 'leased',leaseExpiresAt: new Date(time() + 60000).toISOString() }
  const receipts = new Map(); const calls = []
  const receipt = (commandId,value) => { const saved = receipts.get(commandId); if (saved) return saved; const r = { commandId,acceptedAt: new Date(time()).toISOString(),value: structuredClone(value) }; receipts.set(commandId,r); return r }
  const fence = input => { assert.equal(input.nodeId,attempt.nodeId); assert.equal(input.fence,attempt.fence); if (attempt.executionId !== undefined) assert.equal(input.executionId,attempt.executionId); if (attempt.state === 'cancelled' || Date.parse(attempt.leaseExpiresAt) <= time()) throw new Error('stale lease') }
  const ledger = {
    getRun: () => structuredClone(run), getAttempt: () => structuredClone(attempt),
    pendingRuns: node => run.state === 'queued' && run.route.nodeId === node ? [structuredClone(run)] : [],
    claim: (id,input) => { calls.push(['claim',id,input]); return receipt(id,{ task,run,attempt }) },
    renew: (id,input) => { fence(input); calls.push(['renew',id,input]); attempt.leaseExpiresAt = new Date(time() + input.ttlMs).toISOString(); return receipt(id,attempt) },
    bindSession: (id,input) => { fence(input); calls.push(['bindSession',id,input]); attempt.sessionId = input.sessionId; return receipt(id,attempt) },
    markRunning: (id,input) => { fence(input); assert.ok(input.executionId); calls.push(['markRunning',id,input]); attempt.state = 'running'; attempt.executionId = input.executionId; return receipt(id,attempt) },
    submit: (id,input) => { if (receipts.has(id)) return receipts.get(id); fence(input); calls.push(['submit',id,input]); run.state = 'succeeded'; attempt.state = 'settled'; return receipt(id,run) },
    cancel: (id,input) => { calls.push(['cancel',id,input]); run.cancellationRequested = true; return receipt(id,task) },
    acknowledgeCancellation: (id,input) => { assert.equal(run.cancellationRequested,true); calls.push(['acknowledgeCancellation',id,input]); attempt.state = 'cancelled'; run.state = 'cancelled'; return receipt(id,run) },
  }
  return { ledger,calls,task,run,attempt }
}
function gateway(t,options = {}) {
  const fixture = fixtureLedger()
  const recovery = store(t)
  return { ...fixture,store: recovery,gateway: new RemoteGateway({ role: 'planner',nodeId: 'planner',verifier: new IdentityVerifier({ audience: 'planner',peers: [peer] }),ledger: fixture.ledger,store: recovery,now: () => now,...options }) }
}
function worker(t,overrides = {}) {
  const root = temp(t); const fixture = fixtureLedger(); const recovery = store(t)
  let executions = 0
  const provider = { id: 'fixture',capabilities: ['read'],supports: () => true,execute: async () => { executions++; return { outcome: 'success',summary: 'fixture result' } },...overrides.provider }
  const policy = { role: 'executor',nodeId: 'worker',capabilities: ['read'],workspaces: [{ workspaceId: 'workspace',nodeId: 'worker',path: root,allowedRoot: root }],...overrides.policy }
  const w = new ExecutorWorker({ ledger: fixture.ledger,provider,store: recovery,policy,now: () => now,...overrides.options })
  t.after(() => w.dispose())
  return { ...fixture,root,store: recovery,provider,policy,worker: w,executions: () => executions }
}

test('pure auth: Ed25519 signs canonical payload; key identity binds node and audience', () => {
  const verifier = new IdentityVerifier({ audience: 'planner',peers: [peer] })
  assert.equal(verifier.verify(parseEnvelope(JSON.stringify(signed())),now).nodeId,'worker')
  assert.throws(() => verifier.verify(signed({ nodeId: 'other' }),now),/WRONG_NODE/)
  assert.throws(() => verifier.verify(signed({ audience: 'other' }),now),/WRONG_AUDIENCE/)
  const tampered = signed(); tampered.payload.runId = 'other'
  assert.throws(() => verifier.verify(tampered,now),/BAD_SIGNATURE/)
  assert.throws(() => verifier.verify(signed({ issuedAt: now - 120000,expiresAt: now - 60000 }),now),/STALE_REQUEST/)
  assert.throws(() => verifier.verify(signed({ issuedAt: now + 10000,expiresAt: now + 60000 }),now),/STALE_REQUEST/)
})
test('pure parsing: bounded body, version, fields, depth and command vocabulary', () => {
  assert.throws(() => parseEnvelope('x'.repeat(65537)),/BODY_LIMIT/)
  assert.throws(() => parseEnvelope(JSON.stringify({ ...signed(),version: 2 })),/UNSUPPORTED_VERSION/)
  assert.throws(() => parseEnvelope(JSON.stringify({ ...signed(),actor: 'admin' })),/ENVELOPE_FIELDS/)
  assert.throws(() => parseEnvelope(JSON.stringify({ ...signed(),operation: 'shell' })),/UNKNOWN_OPERATION/)
  assert.throws(() => parseEnvelope(Buffer.from([0xff])),/INVALID_JSON/)
})
test('mocked ledger: replay and reordering rejected, new authenticated retry returns stored receipt', async t => {
  const f = gateway(t)
  const first = await f.gateway.handle(JSON.stringify(signed()))
  assert.equal(first.state,'done'); assert.equal(f.calls.length,1)
  await assert.rejects(f.gateway.handle(JSON.stringify(signed())),/REPLAY/)
  const retry = signed({ nonce: 'nonce2',sequence: 2 })
  assert.deepEqual(await f.gateway.handle(JSON.stringify(retry)),first); assert.equal(f.calls.length,1)
  await assert.rejects(f.gateway.handle(JSON.stringify(signed({ nonce: 'nonce3',sequence: 1 }))),/OUT_OF_ORDER/)
  await assert.rejects(f.gateway.handle(JSON.stringify(signed({ nonce: 'nonce4',sequence: 3,payload: { runId: 'run1',ttlMs: 30000 } }))),/COMMAND_CONFLICT/)
})
test('mocked ledger: caller cannot supply a node, shell, notification or foreign attempt', async t => {
  const f = gateway(t)
  await assert.rejects(f.gateway.handle(JSON.stringify(signed({ payload: { runId: 'run1',ttlMs: 60000,nodeId: 'admin' } }))),/PAYLOAD_FIELDS/)
  await assert.rejects(f.gateway.handle(JSON.stringify(signed({ operation: 'submit',payload: { runId: 'run1',attemptId: 'attempt1',fence: 2,outcome: 'success',summary: 'x' } }))),/ATTEMPT_DENIED/)
  assert.equal(f.calls.length,0)
})
test('mocked ledger: explicit wrong node, denied workspace, missing capability and denied operation fail closed', async t => {
  for (const [restricted,pattern] of [[{ ...peer,workspaces: [] },/WORKSPACE_DENIED/],[{ ...peer,capabilities: [] },/CAPABILITY_DENIED/],[{ ...peer,operations: [] },/OPERATION_DENIED/]]) {
    const f = gateway(t,{ verifier: new IdentityVerifier({ audience: 'planner',peers: [restricted] }) })
    await assert.rejects(f.gateway.handle(JSON.stringify(signed())),pattern)
  }
  const f = gateway(t); f.run.route.nodeId = 'other'
  await assert.rejects(f.gateway.handle(JSON.stringify(signed())),/NODE_ROUTE_DENIED/)
})
test('SQLite restart preserves replay and marks interrupted command uncertain without ledger replay', async t => {
  const file = join(temp(t),'recovery.sqlite'); const s = new RecoveryStore(file)
  s.admit(signed(),now); s.close()
  const recovery = store(t,file); recovery.recover()
  const f = gateway(t,{ store: recovery })
  assert.equal((await f.gateway.handle(JSON.stringify(signed({ nonce: 'retry',sequence: 2 })))).state,'uncertain')
  assert.equal(f.calls.length,0)
  await assert.rejects(f.gateway.handle(JSON.stringify(signed())),/REPLAY/)
})
test('mocked ledger: unknown transaction outcome is durable uncertainty and cannot replay', async t => {
  const f = gateway(t); f.ledger.claim = () => { f.calls.push(['throw']); throw new Error('reply lost after commit') }
  assert.equal((await f.gateway.handle(JSON.stringify(signed()))).state,'uncertain')
  assert.equal((await f.gateway.handle(JSON.stringify(signed({ nonce: 'retry',sequence: 2 })))).state,'uncertain')
  assert.equal(f.calls.length,1)
})
test('pure transport: TLS or literal local loopback; no proxy header trust or URL credential', () => {
  assertTransport({ encrypted: true },false)
  assertTransport({ remoteAddress: '127.0.0.1',localAddress: '127.0.0.1' },true)
  assert.throws(() => assertTransport({ remoteAddress: '10.0.0.2',localAddress: '127.0.0.1' },true),/TLS_REQUIRED/)
  assert.throws(() => assertTransport({ remoteAddress: '127.0.0.1',localAddress: '127.0.0.1' },false),/TLS_REQUIRED/)
  assert.throws(() => assertEndpoint('http://example.test/',true),/TLS_REQUIRED/)
  assert.throws(() => assertEndpoint('http://localhost/',true),/TLS_REQUIRED/)
  assert.throws(() => assertEndpoint('https://user:secret@example.test/'),/INVALID_ENDPOINT/)
})
test('pure policy: canonical workspace root blocks symlink escape and planner execution', async t => {
  const f = worker(t); const claim = f.ledger.claim('claim',{ runId: 'run1',nodeId: 'worker',ttlMs: 60000 }).value
  assert.equal(await authorizedWorkspace(claim,f.policy,f.provider),f.root)
  await assert.rejects(authorizedWorkspace(claim,{ ...f.policy,role: 'planner' },f.provider),/EXECUTOR_ROLE_REQUIRED/)
  const outside = temp(t); const link = join(f.root,'escape'); symlinkSync(outside,link)
  await assert.rejects(authorizedWorkspace(claim,{ ...f.policy,workspaces: [{ ...f.policy.workspaces[0],path: link }] },f.provider),/WORKSPACE_ESCAPE/)
})
test('mocked execution: intent and session identity committed before dispatch, results before submit', async t => {
  const f = worker(t)
  f.provider.execute = async request => {
    const record = f.store.dispatch(request.claim.attempt.attemptId)
    assert.equal(record.state,'dispatching'); assert.equal(record.sessionId,request.sessionId)
    assert.deepEqual(f.calls.map(call => call[0]),['claim','markRunning','bindSession'])
    return { outcome: 'success',summary: 'done' }
  }
  const original = f.ledger.submit
  f.ledger.submit = (id,value) => { assert.equal(f.store.dispatch('attempt1').state,'result'); return original(id,value) }
  assert.equal((await f.worker.execute('run1','first-claim')).state,'acknowledged')
})
test('mocked execution: result ACK loss and restart retry only submission, never provider', async t => {
  const f = worker(t); const submit = f.ledger.submit; let fail = true
  f.ledger.submit = (id,value) => { const receipt = submit(id,value); if (fail) { fail = false; throw new Error('ack lost') } return receipt }
  assert.equal((await f.worker.execute('run1','first-claim')).state,'result')
  assert.equal(f.executions(),1)
  assert.equal((await f.worker.recoverResults())[0].state,'acknowledged')
  assert.equal(f.executions(),1); assert.equal(f.calls.filter(call => call[0] === 'submit').length,1)
})
test('mocked execution: crash after dispatch intent becomes uncertain on restart', async t => {
  const f = worker(t); const claim = f.ledger.claim('claim',{ runId: 'run1',nodeId: 'worker',ttlMs: 60000 }).value
  f.store.createDispatch({ attemptId: 'attempt1',state: 'dispatching',claim,lease: { runId: 'run1',attemptId: 'attempt1',nodeId: 'worker',fence: 1 },sessionId: 'session1' })
  assert.equal((await f.worker.recoverResults())[0].state,'uncertain')
  assert.equal((await f.worker.execute('run1','claim')).state,'uncertain'); assert.equal(f.executions(),0)
})
test('mocked execution: stale lease cannot dispatch and cancelled work cannot finalize', async t => {
  const stale = worker(t); stale.attempt.leaseExpiresAt = new Date(now - 1).toISOString()
  await assert.rejects(stale.worker.execute('run1','claim'),/LEASE_EXPIRED/); assert.equal(stale.executions(),0)
  let entered; const entry = new Promise(resolve => { entered = resolve })
  const f = worker(t,{ provider: { execute: async request => { entered(); await new Promise(resolve => request.signal.addEventListener('abort',resolve,{ once: true })); return { outcome: 'success',summary: 'late' } } } })
  const done = f.worker.execute('run1','claim'); await entry; await f.worker.cancel('run1')
  assert.equal((await done).state,'uncertain'); assert.equal(f.calls.filter(call => call[0] === 'submit').length,0)
})
test('mocked HTTP transport: signed full LedgerPort flow and lost response retain exact command', async t => {
  const f = gateway(t); const clientStore = store(t); let lose = true
  const client = new RemoteClient({ endpoint: 'https://fixture.invalid/dsh-task/v1/commands',audience: 'planner',nodeId: 'worker',keyId: peer.keyId,privateKey: keys.privateKey,store: clientStore,now: () => now,
    fetch: async (_url,options) => { const receipt = await f.gateway.handle(options.body); if (lose) { lose = false; throw new Error('response lost') } return new Response(JSON.stringify(receipt),{ status: 200 }) },
  })
  const adapter = new RemoteLedgerClient(client,'worker')
  await assert.rejects(adapter.claim('claim',{ runId: 'run1',nodeId: 'worker',ttlMs: 60000 }),/REMOTE_OUTCOME_UNCERTAIN/)
  const claim = await adapter.claim('claim',{ runId: 'run1',nodeId: 'worker',ttlMs: 60000 })
  assert.equal(claim.value.attempt.nodeId,'worker'); assert.equal(f.calls.filter(call => call[0] === 'claim').length,1)
  const ref = { runId: 'run1',attemptId: 'attempt1',nodeId: 'worker',fence: 1,executionId: 'fixture-owner' }
  await adapter.markRunning('start',ref); await adapter.bindSession('bind',{ ...ref,sessionId: 'session1' })
  await adapter.renew('renew',{ ...ref,ttlMs: 60000 }); await adapter.submit('result',{ ...ref,outcome: 'success',summary: 'done' })
  assert.equal((await adapter.getRun('run1')).state,'succeeded')
  assert.equal((await adapter.getAttempt('attempt1')).sessionId,'session1')
  assert.equal(f.calls.filter(call => call[0] === 'submit').length,1)
})
test('actual pinned Cordis lifecycle with mocked taskSystem: executor plugin mounts and unloads owned service', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  const root = temp(t); const f = fixtureLedger()
  await ctx.plugin({ name: 'mock-ledger-provider',apply(ctx) { ctx.provide('taskSystem',{ ledger: f.ledger }) } })
  const fiber = ctx.plugin(plugin,{ role: 'executor',nodeId: 'worker',statePath: join(root,'remote.sqlite') })
  await fiber
  assert.ok(ctx.get('remoteExecution'))
  assert.equal(ctx.get('remoteExecution').gateway,undefined)
  await fiber.dispose()
  assert.equal(ctx.get('remoteExecution'),undefined)
  const reopened = new RecoveryStore(join(root,'remote.sqlite')); reopened.close()
})

test('mocked ledger: authenticated discovery cannot enumerate another node or excluded workspace', async t => {
  const f = gateway(t)
  f.ledger.pendingRuns = node => { assert.equal(node,'worker'); return [f.run,{ ...f.run,runId: 'foreign',route: { ...f.run.route,nodeId: 'other' } },{ ...f.run,runId: 'secret',route: { ...f.run.route,workspaceId: 'secret' } }] }
  const result = await f.gateway.handle(JSON.stringify(signed({ operation: 'listWork',payload: {} })))
  assert.deepEqual(result.result.map(run => run.runId),['run1'])
  await assert.rejects(f.gateway.handle(JSON.stringify(signed({ operation: 'listWork',payload: { nodeId: 'other' } }))),/PAYLOAD_FIELDS/)
})

test('actual TaskLedger + crypto + SQLite connected fixture: discover, claim, execute, report, acknowledge; only provider/network mocked', async t => {
  const { TaskLedger } = await import('../../task-system/dist/index.js')
  const root = temp(t); const ledger = TaskLedger.open(join(root,'ledger.sqlite'),{ role: 'planner',nodeId: 'planner',now: () => now }); t.after(() => ledger.close())
  ledger.registerWorkspace('workspace',{ workspaceId: 'workspace',nodeId: 'worker',path: root,label: 'fixture',state: 'ready',createdAt: new Date(now).toISOString() })
  ledger.registerNode('node',{ nodeId: 'worker',roles: ['executor'],capabilities: ['read'],models: [{ provider: 'fixture',model: 'fixture-model',reasoningEfforts: [] }],workspaceIds: ['workspace'],enabled: true,lastSeenAt: new Date(now).toISOString() })
  const task = ledger.createTask('task',{ title: 'Connected fixture',workspaceId: 'workspace' }).value
  const run = ledger.createRun('run',{ taskId: task.taskId,route: { nodeId: 'worker',provider: 'fixture',model: 'fixture-model',requiredCapabilities: ['read'],workspaceId: 'workspace' } }).value
  const serverStore = store(t,join(root,'server.sqlite')); const clientStore = store(t,join(root,'client.sqlite')); const workerStore = store(t,join(root,'worker.sqlite'))
  const gateway = new RemoteGateway({ role: 'planner',nodeId: 'planner',ledger,store: serverStore,verifier: new IdentityVerifier({ audience: 'planner',peers: [peer] }),now: () => now })
  const client = new RemoteClient({ endpoint: 'https://fixture.invalid/commands',nodeId: 'worker',keyId: peer.keyId,audience: 'planner',privateKey: keys.privateKey,store: clientStore,now: () => now,fetch: async (_url,options) => new Response(JSON.stringify(await gateway.handle(options.body))) })
  const remote = new RemoteLedgerClient(client,'worker'); let executions = 0
  const worker = new ExecutorWorker({ ledger: remote,store: workerStore,policy: { role: 'executor',nodeId: 'worker',capabilities: ['read'],workspaces: [{ workspaceId: 'workspace',nodeId: 'worker',path: root,allowedRoot: root }] },now: () => now,
    provider: { id: 'fixture',capabilities: ['read'],supports: route => route.model === 'fixture-model',execute: async request => { executions++; assert.equal(request.workspacePath,root); return { outcome: 'success',summary: 'bounded fixture',report: { title: 'Fixture report',body: 'No live model call' } } } },
  }); t.after(() => worker.dispose())
  const results = await worker.pollOnce(1)
  assert.equal(results.length,1); assert.equal(results[0].status,'fulfilled'); assert.equal(results[0].value.state,'acknowledged')
  assert.equal(ledger.getRun(run.runId).state,'succeeded'); assert.equal(ledger.history(task.taskId).reports.length,1)
  assert.equal((await worker.pollOnce()).length,0); assert.equal(executions,1)
  assert.throws(() => remote.pendingRuns('other'),/WRONG_CLIENT_NODE/)
})

test('mocked execution: coordinator cancellation acknowledges only after provider quiescence', async t => {
  let entered; const entry = new Promise(resolve => { entered = resolve })
  const f = worker(t,{ provider: { execute: async request => { entered(); await new Promise(resolve => request.signal.addEventListener('abort',resolve,{ once: true })); return { outcome: 'partial',summary: 'Stopped, prior effects may remain' } } } })
  const done = f.worker.execute('run1','claim'); await entry
  f.ledger.cancel('cancel',{ taskId: 'task1',runId: 'run1',reason: 'User requested stop' })
  await f.worker.cancel('run1')
  assert.equal((await done).state,'cancelled'); assert.equal(f.calls.filter(call => call[0] === 'submit').length,0)
  assert.equal(f.calls.filter(call => call[0] === 'acknowledgeCancellation').length,1)
})

test('mocked ledger: exact result replay reads its receipt after settlement; fresh stale command is rejected', async t => {
  const f = gateway(t)
  const envelope = signed({ operation: 'submit',payload: { runId: 'run1',attemptId: 'attempt1',fence: 1,outcome: 'success',summary: 'done' } })
  const result = await f.gateway.handle(JSON.stringify(envelope)); assert.equal(result.state,'done')
  const retry = signed({ operation: 'submit',payload: envelope.payload,nonce: 'retry',sequence: 2 })
  assert.deepEqual(await f.gateway.handle(JSON.stringify(retry)),result)
  await assert.rejects(f.gateway.handle(JSON.stringify(signed({ commandId: 'new-result',operation: 'submit',payload: envelope.payload,nonce: 'new',sequence: 3 }))),/LEASE_EXPIRED/)
  assert.equal(f.calls.filter(call => call[0] === 'submit').length,1)
})

test('mocked execution: task-specific node/workspace restriction and runtime budget are enforced', async t => {
  const denied = worker(t); denied.task.policy = { allowedNodeIds: ['other'] }
  await assert.rejects(denied.worker.execute('run1','claim'),/TASK_NODE_DENIED/); assert.equal(denied.executions(),0)
  const workspaceDenied = worker(t); workspaceDenied.task.policy = { allowedWorkspaceIds: [] }
  await assert.rejects(workspaceDenied.worker.execute('run1','claim'),/TASK_WORKSPACE_DENIED/)
  let quiesced = false
  const budget = worker(t,{ provider: { execute: async request => { await new Promise(resolve => request.signal.addEventListener('abort',resolve,{ once: true })); quiesced = true; return { outcome: 'partial',summary: 'Timed out; effects require review' } } } })
  budget.task.policy = { maxRuntimeMs: 100,allowedTools: ['read'],maxDepth: 0 }
  assert.equal((await budget.worker.execute('run1','claim')).state,'uncertain')
  assert.equal(quiesced,true); assert.equal(budget.calls.filter(call => call[0] === 'submit').length,0)
})

test('pure native adapter: explicit provider/model/effort allowlist forwards execution-only requests', async () => {
  let received
  const adapter = nativeExecutionAdapter({ executeExternal: async request => { received = request; return { outcome: 'success',summary: 'fixture' } } },{ provider: 'native-provider',models: [{ model: 'mock',reasoningEfforts: ['low'] }],capabilities: ['read'] })
  const route = { nodeId: 'worker',provider: 'native-provider',model: 'mock',reasoningEffort: 'low',requiredCapabilities: ['read'] }
  assert.equal(adapter.supports(route),true); assert.equal(adapter.supports({ ...route,reasoningEffort: 'ultra' }),false)
  const request = { claim: { run: { route } },sessionId: 'owned-session',workspacePath: '/fixture',signal: new AbortController().signal }
  assert.equal((await adapter.execute(request)).outcome,'success'); assert.equal(received,request)
})
test('shared workspace and cancel operation never authorize cancelling another node assignment',async t=>{
  const f=gateway(t); f.run.route.nodeId='other-worker';
  await assert.rejects(f.gateway.handle(JSON.stringify(signed({operation:'cancel',payload:{runId:'run1',reason:'attempted foreign cancellation'}}))),/NODE_ROUTE_DENIED/);
  assert.equal(f.calls.length,0);assert.equal(f.run.cancellationRequested,undefined);
});
test('bounded structured report data and schema identity survive the atomic settlement protocol',async t=>{
  const f=gateway(t)
  const report={title:'Custom report',body:'Human-readable summary',schemaId:'custom.report.v1',data:{metrics:[{name:'checks',value:3}],complete:true}}
  const result=await f.gateway.handle(JSON.stringify(signed({operation:'submit',payload:{runId:'run1',attemptId:'attempt1',fence:1,outcome:'success',summary:'Complete',report}})))
  assert.equal(result.state,'done'); assert.deepEqual(f.calls.find(call=>call[0]==='submit')[2].report,report)
})
test('signed gateway requires start owner and rejects missing or foreign owner on a bound lease',async t=>{
  const f=gateway(t)
  const payload={runId:'run1',attemptId:'attempt1',fence:1}
  await assert.rejects(f.gateway.handle(JSON.stringify(signed({operation:'markRunning',payload}))),/PAYLOAD_FIELDS/)
  await f.gateway.handle(JSON.stringify(signed({operation:'markRunning',payload:{...payload,executionId:'owner-one'}})))
  for(const executionId of [undefined,'owner-two']){
    await assert.rejects(f.gateway.handle(JSON.stringify(signed({commandId:'foreign-renew',nonce:'next',sequence:2,operation:'renew',payload:{...payload,ttlMs:60000,...(executionId?{executionId}:{})}}))),/EXECUTION_OWNER_DENIED/)
  }
  assert.equal(f.attempt.executionId,'owner-one');assert.equal(f.calls.filter(call=>call[0]==='renew').length,0)
})
