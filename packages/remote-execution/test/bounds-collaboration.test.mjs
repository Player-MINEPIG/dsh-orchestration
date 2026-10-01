import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskLedger } from '../../task-system/dist/index.js'
import { RecoveryStore,RemoteGateway,RemoteClient,RemoteLedgerClient,IdentityVerifier,ExecutorWorker,bindCollaboration,signEnvelope,MAX_WIRE_BYTES } from '../dist/api.js'
const keys = generateKeyPairSync('ed25519') // disposable fixture only
const ops = ['claim','renew','bindSession','markRunning','submit','getRun','getAttempt','listWork','delegate','taskHistory','taskWait','taskNote','taskReport','receipt']
const peer = { keyId:'fixture-key',nodeId:'worker',audience:'planner',publicKey:keys.publicKey,operations:ops,workspaces:['workspace'],capabilities:['read'] }
function fixture(t,limit=65536) {
  const root=mkdtempSync(join(tmpdir(),'dsh-bounds-')); const resources=[]
  t.after(async()=>{for(const r of resources.reverse())await(r.dispose?.()??r.close?.());rmSync(root,{recursive:true,force:true})})
  const ledger=TaskLedger.open(join(root,'ledger.sqlite'),{role:'planner',nodeId:'planner'});resources.push(ledger)
  ledger.registerWorkspace('ws',{workspaceId:'workspace',nodeId:'worker',path:root,label:'fixture',state:'ready',createdAt:new Date().toISOString()})
  ledger.registerNode('node',{nodeId:'worker',roles:['executor'],capabilities:['read'],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],workspaceIds:['workspace'],enabled:true,lastSeenAt:new Date().toISOString(),maxConcurrent:4})
  const route={nodeId:'worker',provider:'fixture',model:'fixture',workspaceId:'workspace',requiredCapabilities:['read']}
  const serverStore=new RecoveryStore(join(root,'server.sqlite'));resources.push(serverStore)
  const gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger,store:serverStore,verifier:new IdentityVerifier({audience:'planner',peers:[peer]}),maxBodyBytes:limit,maxResponseBytes:Math.max(limit,131072)});resources.push(gateway)
  let network=0
  const clientStore=new RecoveryStore(join(root,'client.sqlite'));resources.push(clientStore)
  const client=new RemoteClient({endpoint:'https://fixture.invalid/commands',nodeId:'worker',audience:'planner',keyId:'fixture-key',privateKey:keys.privateKey,store:clientStore,maxBodyBytes:limit,maxResponseBytes:Math.max(limit,131072),fetch:async(_url,options)=>{network++;return new Response(JSON.stringify(await gateway.handle(options.body)))}});resources.push(client)
  return {root,resources,ledger,route,serverStore,gateway,clientStore,client,remote:new RemoteLedgerClient(client,'worker'),network:()=>network}
}
function envelope(payload,operation='submit') {const now=Date.now();return signEnvelope({version:1,keyId:'fixture-key',nodeId:'worker',audience:'planner',commandId:'large-request',nonce:'large-nonce',sequence:1000,issuedAt:now,expiresAt:now+60000,operation,payload},keys.privateKey)}

test('actual TaskLedger opted-in 1 MiB signed worker roundtrip preserves >64 KiB report.data and >128 KiB claim response',async t=>{
  const f=fixture(t,1024*1024),blob='d'.repeat(200*1024)
  const task=f.ledger.createTask('task',{title:'Large daily node report',workspaceId:'workspace',policy:{requiredResources:['daily-node'],settlementQuietMs:0}}).value
  const run=f.ledger.createRun('run',{taskId:task.taskId,route:f.route,configuration:{largeInput:blob}}).value
  const store=new RecoveryStore(join(f.root,'worker.sqlite'));f.resources.push(store)
  const worker=new ExecutorWorker({ledger:f.remote,store,maxResultBytes:1024*1024,policy:{role:'executor',nodeId:'worker',capabilities:['read'],workspaces:[{workspaceId:'workspace',nodeId:'worker',path:f.root,allowedRoot:f.root}]},provider:{id:'fixture',capabilities:['read'],supports:()=>true,execute:async request=>{
    assert.equal(request.claim.run.configuration.largeInput,blob)
    assert.deepEqual(request.claim.task.policy.requiredResources,['daily-node'])
    return {outcome:'success',summary:'Daily structured result',report:{title:'Daily',body:'Human-readable summary',schemaId:'daily.fixture.v1',data:{nodeReport:blob,games:[{name:'fixture',result:'ok'}]}}}
  }}});f.resources.push(worker)
  assert.equal((await worker.execute(run.runId,'claim-large')).state,'acknowledged')
  const report=f.ledger.history(task.taskId).reports[0]
  assert.equal(report.data.nodeReport,blob);assert.equal(report.schemaId,'daily.fixture.v1');assert.equal(f.ledger.snapshot().artifacts.length,0)
})

test('request byte caps reject before ledger effects and before client network transmission',async t=>{
  const f=fixture(t)
  const task=f.ledger.createTask('task',{title:'Bounded',workspaceId:'workspace'}).value
  const run=f.ledger.createRun('run',{taskId:task.taskId,route:f.route}).value
  const payload={runId:run.runId,attemptId:'not-dispatched',fence:1,outcome:'success',summary:'summary',report:{title:'large',body:'summary',data:{blob:'x'.repeat(70000)}}}
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope(payload))),/BODY_LIMIT/)
  assert.equal(f.ledger.getRun(run.runId).state,'queued');assert.equal(f.serverStore.receipt('worker','large-request'),undefined)
  await assert.rejects(f.remote.submit('client-large',{...payload,nodeId:'worker'}),/BODY_LIMIT/)
  assert.equal(f.network(),0);assert.equal(f.clientStore.outbound('client-large'),undefined)
  assert.throws(()=>new RemoteClient({endpoint:'https://fixture.invalid',audience:'planner',nodeId:'worker',keyId:'fixture-key',privateKey:keys.privateKey,store:f.clientStore,maxBodyBytes:Infinity}),/INVALID_BYTE_LIMIT/)
  assert.throws(()=>new RemoteGateway({role:'planner',nodeId:'planner',ledger:f.ledger,store:f.serverStore,verifier:new IdentityVerifier({audience:'planner',peers:[peer]}),maxResponseBytes:MAX_WIRE_BYTES+1}),/INVALID_BYTE_LIMIT/)
})

test('response caps cancel bounded chunked bodies and oversized declared lengths; outcome remains uncertain',async t=>{
  const f=fixture(t);let cancelled=0
  const stream=()=>new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(800))},cancel(){cancelled++}})
  const make=fetch=>{const client=new RemoteClient({endpoint:'https://fixture.invalid',audience:'planner',nodeId:'worker',keyId:'fixture-key',privateKey:keys.privateKey,store:f.clientStore,maxResponseBytes:1024,fetch});f.resources.push(client);return client}
  const chunked=make(async()=>new Response(stream()))
  assert.equal((await chunked.send('getRun','chunked',{runId:'run'})).state,'uncertain');assert.equal(cancelled,1)
  const advertised=make(async()=>new Response(stream(),{headers:{'content-length':'2048'}}))
  assert.equal((await advertised.send('getRun','advertised',{runId:'run'})).state,'uncertain');assert.equal(cancelled,2)
})

test('actual TaskLedger signed scoped collaboration delegates, waits, reports, queues notes; foreign targets and identity injection fail',async t=>{
  const f=fixture(t)
  const parent=f.ledger.createTask('parent',{title:'Parent',workspaceId:'workspace',policy:{maxDepth:3,maxChildren:3,settlementQuietMs:0}}).value
  const unrelated=f.ledger.createTask('unrelated',{title:'Private unrelated task',workspaceId:'workspace'}).value
  const parentRun=f.ledger.createRun('parent-run',{taskId:parent.taskId,route:f.route}).value
  const claim=(await f.remote.claim('parent-claim',{runId:parentRun.runId,nodeId:'worker',ttlMs:60000})).value
  const ref={runId:parentRun.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:'parent-owner'}
  await f.remote.markRunning('parent-start',ref)
  const controller=new AbortController(), collaboration=bindCollaboration(f.remote,ref,parent.taskId,controller.signal)
  const child=(await collaboration.delegate('child',{title:'Child',configuration:{work:'read-only'},parentTaskId:unrelated.taskId,nodeId:'other'})).value
  assert.equal(f.ledger.getTask(child.task.taskId).parentTaskId,parent.taskId)
  assert.equal((await collaboration.history(child.task.taskId)).task.taskId,child.task.taskId)
  assert.equal((await collaboration.wait(undefined,0)).settled,false)
  await collaboration.report('progress',{targetTaskId:child.task.taskId,title:'Progress',body:'Evidence',data:{progress:1}})
  await collaboration.note('note',{targetTaskId:child.task.taskId,body:'Use this in a later run'})
  await assert.rejects(collaboration.history(unrelated.taskId),/REMOTE_OUTCOME_UNCERTAIN/)
  await assert.rejects(collaboration.note('foreign-note',{targetTaskId:unrelated.taskId,body:'Must not arrive'}),/REMOTE_OUTCOME_UNCERTAIN/)
  assert.equal(f.ledger.history(unrelated.taskId).reports.length,0)
  const childClaim=(await f.remote.claim('child-claim',{runId:child.run.runId,nodeId:'worker',ttlMs:60000})).value
  const childRef={runId:child.run.runId,attemptId:childClaim.attempt.attemptId,nodeId:'worker',fence:childClaim.attempt.fence,executionId:'child-owner'}
  await f.remote.markRunning('child-start',childRef);await f.remote.submit('child-result',{...childRef,outcome:'success',summary:'done'})
  assert.equal((await collaboration.wait(undefined,0)).settled,true)
  const next=f.ledger.createRun('next-child',{taskId:child.task.taskId,route:f.route}).value
  assert.equal(next.contextNotes[0].body,'Use this in a later run')
  controller.abort();await assert.rejects(collaboration.report('late',{title:'Late',body:'Must not run'}),/EXECUTION_ABORTED/)
  await assert.rejects(f.gateway.handle(JSON.stringify(envelope({...ref,title:'Injected',parentTaskId:unrelated.taskId},'delegate'))),/PAYLOAD_FIELDS/)
})
