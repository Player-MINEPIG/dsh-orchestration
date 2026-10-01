import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskLedger } from '../../task-system/dist/index.js'
import { RecoveryStore,RemoteGateway,RemoteClient,RemoteLedgerClient,IdentityVerifier,bindCollaboration,signEnvelope,digest } from '../dist/api.js'
const key=generateKeyPairSync('ed25519') // Disposable fixture only; all descriptions below are fabricated public fixture text.
const ops=['claim','markRunning','bindSession','offerApproval','approvalStatus','cancelApproval','receipt']
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'dsh-approval-')),resources=[];let now=Date.now(),sequence=0
  t.after(async()=>{for(const r of resources.reverse())await(r.dispose?.()??r.close?.());rmSync(root,{recursive:true,force:true})})
  const ledger=TaskLedger.open(join(root,'ledger.sqlite'),{role:'planner',nodeId:'planner',now:()=>now});resources.push(ledger)
  ledger.registerWorkspace('workspace',{workspaceId:'workspace',nodeId:'worker',path:root,label:'fixture',state:'ready',createdAt:new Date(now).toISOString()})
  ledger.registerNode('node',{nodeId:'worker',roles:['executor'],capabilities:['read'],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],workspaceIds:['workspace'],enabled:true,lastSeenAt:new Date(now).toISOString()})
  const route={nodeId:'worker',provider:'fixture',model:'fixture',workspaceId:'workspace',requiredCapabilities:['read']}
  const task=ledger.createTask('task',{title:'Scoped approval fixture',workspaceId:'workspace',policy:{allowedTools:['read_file'],settlementQuietMs:0}}).value
  const run=ledger.createRun('run',{taskId:task.taskId,route}).value
  const peer={nodeId:'worker',keyId:'fixture',audience:'planner',publicKey:key.publicKey,operations:ops,workspaces:['workspace'],capabilities:['read']}
  const serverStore=new RecoveryStore(join(root,'server.sqlite'));resources.push(serverStore)
  const gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger,store:serverStore,now:()=>now,verifier:new IdentityVerifier({audience:'planner',peers:[peer]})});resources.push(gateway)
  const clientFactory=()=>{
    const store=new RecoveryStore(join(root,'client.sqlite'));resources.push(store)
    const client=new RemoteClient({endpoint:'https://fixture.invalid',nodeId:'worker',keyId:'fixture',audience:'planner',privateKey:key.privateKey,store,now:()=>now,fetch:async(_url,options)=>new Response(JSON.stringify(await gateway.handle(options.body)))});resources.push(client)
    return {store,client,remote:new RemoteLedgerClient(client,'worker')}
  }
  const a=clientFactory()
  const claim=async (which=run,id='first',ttlMs=60000)=>{
    const attempt=(await a.remote.claim(`claim-${id}`,{runId:which.runId,nodeId:'worker',ttlMs})).value.attempt
    const ref={runId:which.runId,attemptId:attempt.attemptId,nodeId:'worker',fence:attempt.fence,executionId:`owner-${id}`}
    await a.remote.markRunning(`start-${id}`,ref);await a.remote.bindSession(`session-${id}`,{...ref,sessionId:`session-${id}`});return ref
  }
  const offer=(id='first')=>({requestId:`request-${id}`,sessionId:`session-${id}`,agentId:`agent-${id}`,callId:`call-${id}`,toolName:'read_file',argumentsDigest:digest({path:'public-fixture.txt'}),description:'Read the fabricated public fixture file',expiresAt:now+120000,allowRemoteOnce:true})
  const signed=(operation,payload,overrides={})=>JSON.stringify(signEnvelope({version:1,keyId:'fixture',nodeId:'worker',audience:'planner',commandId:`raw-${++sequence}`,nonce:`nonce-${sequence}`,sequence:10000+sequence,issuedAt:now,expiresAt:now+60000,operation,payload,...overrides},key.privateKey))
  return {root,resources,ledger,route,run,task,gateway,serverStore,peer,...a,claim,offer,signed,clientFactory,now:()=>now,advance:delta=>now+=delta}
}
const wire=ref=>({runId:ref.runId,attemptId:ref.attemptId,fence:ref.fence,executionId:ref.executionId})

test('actual signed approval offer is replay-safe; only trusted coordinator response changes the pending decision',async t=>{
  const f=fixture(t),ref=await f.claim(),offer=f.offer()
  const receipt=await f.remote.offerApproval('offer',{...ref,...offer})
  assert.equal(receipt.value.state,'pending');assert.equal(receipt.value.nodeId,'worker')
  assert.deepEqual(await f.remote.offerApproval('offer',{...ref,...offer}),receipt)
  assert.equal(f.ledger.approvals().length,1);assert.equal((await f.remote.approvalStatus({...ref,requestId:offer.requestId})).state,'pending')
  f.ledger.respondApproval('trusted-response',{requestId:offer.requestId,expectedRevision:1,decision:'allowed-once',actor:'fixture-operator'})
  assert.equal((await f.remote.approvalStatus({...ref,requestId:offer.requestId})).state,'allowed-once')
  await assert.rejects(f.gateway.handle(f.signed('respondApproval',{requestId:offer.requestId,decision:'allowed-once',actor:'self'})),/UNKNOWN_OPERATION/)
  for(const extra of [{actor:'self'},{source:'host'},{decision:'allowed-once'},{arguments:{path:'private'}},{shell:'arbitrary'}]) await assert.rejects(f.gateway.handle(f.signed('offerApproval',{...wire(ref),...offer,...extra})),/PAYLOAD_FIELDS/)
  assert.equal(f.ledger.getRun(f.run.runId).state,'running')
})

test('approval operations reject wrong node, execution, fence, session, tool policy and invalid bounds',async t=>{
  const f=fixture(t),ref=await f.claim(),offer=f.offer()
  await f.remote.offerApproval('offer',{...ref,...offer})
  await assert.rejects(f.remote.approvalStatus({...ref,fence:ref.fence+1,requestId:offer.requestId}),/REMOTE_OUTCOME_UNCERTAIN/)
  await assert.rejects(f.remote.approvalStatus({...ref,executionId:'other-owner',requestId:offer.requestId}),/REMOTE_OUTCOME_UNCERTAIN/)
  await assert.rejects(f.remote.offerApproval('foreign-session',{...ref,...f.offer('other')}),/REMOTE_OUTCOME_UNCERTAIN/)
  await assert.rejects(f.remote.offerApproval('forbidden-tool',{...ref,...offer,requestId:'forbidden-tool',toolName:'shell'}),/REMOTE_OUTCOME_UNCERTAIN/)
  await assert.rejects(f.gateway.handle(f.signed('approvalStatus',{...wire(ref),requestId:offer.requestId},{nodeId:'other-node'})),/WRONG_NODE/)
  for(const change of [{description:'x'.repeat(4001)},{argumentsDigest:'not-a-digest'},{allowRemoteOnce:'yes'},{expiresAt:f.now()+300001}]) await assert.rejects(f.gateway.handle(f.signed('offerApproval',{...wire(ref),...offer,...change})),/INVALID_APPROVAL|INVALID_ARGUMENTS_DIGEST/)
  assert.equal(f.ledger.approvals().length,1)
})

test('status receipts cannot grant after lease expiry; late response fails and bound cleanup can cancel after abort',async t=>{
  const f=fixture(t),ref=await f.claim(f.run,'first',1000),offer=f.offer()
  const controller=new AbortController(),collaboration=bindCollaboration(f.remote,ref,f.task.taskId,controller.signal)
  await collaboration.offerApproval('offer',{...offer,nodeId:'other',runId:'other',executionId:'other'})
  assert.equal(f.ledger.getApproval(offer.requestId).nodeId,'worker')
  const status=f.signed('approvalStatus',{...wire(ref),requestId:offer.requestId},{commandId:'status-before-expiry'})
  assert.equal((await f.gateway.handle(status)).result.state,'pending')
  f.advance(1001)
  await assert.rejects(f.gateway.handle(f.signed('approvalStatus',{...wire(ref),requestId:offer.requestId},{commandId:'status-before-expiry'})),/LEASE_EXPIRED/)
  assert.throws(()=>f.ledger.respondApproval('late',{requestId:offer.requestId,expectedRevision:1,decision:'allowed-once',actor:'fixture-operator'}),/live pending/)
  controller.abort();await assert.rejects(collaboration.approvalStatus(offer.requestId),/EXECUTION_ABORTED/)
  const cleanup=await f.gateway.handle(f.signed('cancelApproval',{...wire(ref),requestId:offer.requestId,reason:'Live callback retired'}))
  assert.equal(cleanup.result.value.state,'cancelled')
})

test('cleanup callback after abort retains the captured identity and does not allow peer self-approval',async t=>{
  const f=fixture(t),ref=await f.claim(),controller=new AbortController(),port=bindCollaboration(f.remote,ref,f.task.taskId,controller.signal),offer=f.offer()
  await port.offerApproval('offer',offer);controller.abort()
  const cancelled=await port.cancelApproval('cancel',{requestId:offer.requestId,reason:'Native handle retired',nodeId:'other',executionId:'other'})
  assert.equal(cancelled.value.state,'cancelled');assert.equal(cancelled.value.executionId,ref.executionId)
  assert.equal(port.respondApproval,undefined)
})

test('journal restart cannot reuse a retired request on a new attempt or apply a late response',async t=>{
  const f=fixture(t),ref=await f.claim(),offer=f.offer()
  await f.remote.offerApproval('old-offer',{...ref,...offer})
  await f.remote.cancelApproval('old-cancel',{...ref,requestId:offer.requestId,reason:'Old live callback disposed'})
  f.ledger.cancel('cancel-run',{taskId:f.task.taskId,runId:f.run.runId,reason:'Restart fixture'})
  await f.client.dispose();f.store.close()
  const resumed=f.clientFactory(),next=f.ledger.createRun('next',{taskId:f.task.taskId,route:f.route}).value
  const attempt=(await resumed.remote.claim('new-claim',{runId:next.runId,nodeId:'worker',ttlMs:60000})).value.attempt
  const nextRef={runId:next.runId,attemptId:attempt.attemptId,nodeId:'worker',fence:attempt.fence,executionId:'new-owner'}
  await resumed.remote.markRunning('new-start',nextRef);await resumed.remote.bindSession('new-session',{...nextRef,sessionId:'new-session'})
  await assert.rejects(resumed.remote.approvalStatus({...nextRef,requestId:offer.requestId}),/REMOTE_OUTCOME_UNCERTAIN/)
  await assert.rejects(resumed.remote.offerApproval('reuse-old-request',{...nextRef,...offer,sessionId:'new-session'}),/REMOTE_OUTCOME_UNCERTAIN/)
  assert.throws(()=>f.ledger.respondApproval('late-old-response',{requestId:offer.requestId,expectedRevision:1,decision:'allowed-once',actor:'fixture-operator'}),/live pending/)
  const fresh=await resumed.remote.offerApproval('fresh-offer',{...nextRef,...f.offer('new'),sessionId:'new-session'})
  assert.equal(fresh.value.state,'pending');assert.equal(fresh.value.executionId,'new-owner')
  assert.equal(f.ledger.approvals().length,2)
})
