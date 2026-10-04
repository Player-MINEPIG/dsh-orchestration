import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskLedger } from '../../dist/index.js'
import { RecoveryStore,RemoteGateway,RemoteClient,RemoteLedgerClient,IdentityVerifier,ExecutorWorker,validateRetryWitness,signEnvelope } from '../../dist/remote/api.js'
const key=generateKeyPairSync('ed25519') // Disposable fixture; this test mocks native evidence, not its production capture.
const operations=['listWork','claim','markRunning','bindSession','renew','submit','getRun','getAttempt','retryBeforeEffects','receipt']
const witness=sessionId=>({kind:'dsh-owned-zero-tools-v1',sessionId,fromSeq:1,toSeq:5,terminalSeq:4,turn:0,code:'RATE_LIMIT',toolCallCount:0,toolDispatchCount:0,complete:true,quiescent:true,persisted:true,disposed:true})
const fingerprint=(name='fs:read',argumentsDigest='a'.repeat(64))=>({name,argumentsDigest})
const completedWitness=(sessionId,completedTools=[fingerprint()])=>({...witness(sessionId),kind:'dsh-owned-completed-tools-v1',toolCallCount:completedTools.length,toolDispatchCount:completedTools.length,toolResultCount:completedTools.length,completedTools})
function fixture(t,{maxRetries=1,maxRuntimeMs=120000,resumableTools=[],allowedTools}={}) {
  const root=mkdtempSync(join(tmpdir(),'dsh-retry-')),resources=[];let now=Date.now()
  t.after(async()=>{for(const r of resources.reverse())await(r.dispose?.()??r.close?.());rmSync(root,{recursive:true,force:true})})
  const ledger=TaskLedger.open(join(root,'ledger.sqlite'),{role:'planner',nodeId:'planner',now:()=>now,safeRetry:{maxRetries,baseDelayMs:30000,maxDelayMs:60000,resumableTools}});resources.push(ledger)
  ledger.registerWorkspace('workspace',{workspaceId:'workspace',nodeId:'worker',path:root,label:'fixture',state:'ready',createdAt:new Date(now).toISOString()})
  ledger.registerNode('node',{nodeId:'worker',roles:['executor'],capabilities:['read'],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],workspaceIds:['workspace'],enabled:true,lastSeenAt:new Date(now).toISOString()})
  const route={nodeId:'worker',provider:'fixture',model:'fixture',workspaceId:'workspace',requiredCapabilities:['read']}
  const task=ledger.createTask('task',{title:'Bounded retry',workspaceId:'workspace',policy:{maxRuntimeMs,settlementQuietMs:0,...(allowedTools ? {allowedTools} : {})}}).value
  const run=ledger.createRun('run',{taskId:task.taskId,route}).value
  const peer={nodeId:'worker',keyId:'fixture',audience:'planner',publicKey:key.publicKey,operations,workspaces:['workspace'],capabilities:['read']}
  const serverStore=new RecoveryStore(join(root,'server.sqlite'));resources.push(serverStore)
  const gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger,store:serverStore,now:()=>now,verifier:new IdentityVerifier({audience:'planner',peers:[peer]})});resources.push(gateway)
  const clientStore=new RecoveryStore(join(root,'client.sqlite'));resources.push(clientStore)
  const client=new RemoteClient({endpoint:'https://fixture.invalid',nodeId:'worker',keyId:'fixture',audience:'planner',privateKey:key.privateKey,store:clientStore,now:()=>now,fetch:async(_url,options)=>new Response(JSON.stringify(await gateway.handle(options.body)))});resources.push(client)
  const remote=new RemoteLedgerClient(client,'worker')
  const worker=(execute,path='worker.sqlite')=>{const store=new RecoveryStore(join(root,path));resources.push(store);const value=new ExecutorWorker({ledger:remote,store,now:()=>now,policy:{role:'executor',nodeId:'worker',capabilities:['read'],workspaces:[{workspaceId:'workspace',nodeId:'worker',path:root,allowedRoot:root}]},provider:{id:'fixture',capabilities:['read'],supports:()=>true,execute}});resources.push(value);return {worker:value,store}}
  return {root,resources,ledger,run,task,remote,serverStore,gateway,worker,now:()=>now,advance:delta=>now+=delta}
}

test('retry witness schema rejects effectful, incomplete, unknown-code, wrong-session, and invalid sequence attestations',()=>{
  validateRetryWitness(witness('session'),'session')
  for(const bad of [{...witness('session'),toolCallCount:1},{...witness('session'),toolDispatchCount:1},{...witness('session'),disposed:false},{...witness('session'),complete:false},{...witness('session'),code:'SEMANTIC'},{...witness('session'),toSeq:4},{...witness('session'),fromSeq:-1},{...witness('session'),shell:'arbitrary'}]) assert.throws(()=>validateRetryWitness(bad,'session'))
  assert.throws(()=>validateRetryWitness(witness('other'),'session'),/INVALID_RETRY_SESSION/)
})

test('completed-tool wire witness is a closed bounded union with exact digests and may repeat fingerprints',()=>{
  validateRetryWitness(completedWitness('session'),'session')
  validateRetryWitness(completedWitness('session',Array.from({length:32},()=>fingerprint())),'session')
  const valid=completedWitness('session')
  for(const bad of [
    {...valid,kind:'dsh-owned-completed-tools-v2'},
    {...valid,toolCallCount:0,toolDispatchCount:0,toolResultCount:0,completedTools:[]},
    completedWitness('session',Array.from({length:33},()=>fingerprint())),
    {...valid,toolCallCount:1.5},{...valid,toolDispatchCount:0},{...valid,toolResultCount:0},
    {...valid,completedTools:[]},{...valid,completedTools:[fingerprint(),fingerprint()]},
    {...valid,completedTools:[{...fingerprint(),arguments:{path:'untrusted'}}]},
    {...valid,completedTools:[{name:'fs:read'}]},{...valid,completedTools:[null]},
    {...valid,completedTools:[fingerprint('')]},{...valid,completedTools:[fingerprint('x'.repeat(201))]},
    {...valid,completedTools:[fingerprint('fs:read','A'.repeat(64))]},
    {...valid,completedTools:[fingerprint('fs:read','a'.repeat(63))]},
    {...valid,code:['RATE_LIMIT']},{...valid,complete:false},{...valid,quiescent:false},
    {...valid,persisted:false},{...valid,disposed:false},{...valid,toSeq:4},
    {...witness('session'),completedTools:[]},{...witness('session'),toolResultCount:0},
  ]) assert.throws(()=>validateRetryWitness(bad,'session'))
  const {toolResultCount,...missing}=valid
  assert.throws(()=>validateRetryWitness(missing,'session'),/INVALID_RETRY_WITNESS_FIELDS/)
})

test('actual signed completed-tool continuation requires pinned tools and preserves deduplicated fingerprints through zero-tool retries (native evidence mocked)',async t=>{
  const configured=['fs:read'],f=fixture(t,{maxRetries:3,maxRuntimeMs:300000,resumableTools:configured,allowedTools:['fs:read']}),seen=[]
  configured.push('fs:write')
  assert.deepEqual(f.ledger.getRun(f.run.runId).retryPolicy.resumableTools,['fs:read'])
  const firstTool=fingerprint(),secondTool=fingerprint('fs:read','b'.repeat(64))
  const {worker}=f.worker(async request=>{
    seen.push(request)
    if(seen.length===1)return {outcome:'unknown',summary:'Transient after two completed reads',retryWitness:completedWitness(request.sessionId,[firstTool,firstTool])}
    if(seen.length===2)return {outcome:'unknown',summary:'Transient before further tools',retryWitness:witness(request.sessionId)}
    if(seen.length===3)return {outcome:'unknown',summary:'Transient after another completed read',retryWitness:completedWitness(request.sessionId,[secondTool])}
    return {outcome:'success',summary:'Continued saved session'}
  })
  assert.equal((await worker.pollOnce())[0].value.state,'retry_scheduled')
  assert.deepEqual(f.ledger.getRun(f.run.runId).retry.completedTools,[firstTool])
  f.advance(30000)
  assert.equal((await worker.pollOnce())[0].value.state,'retry_scheduled')
  assert.deepEqual(seen[1].claim.run.retry.completedTools,[firstTool])
  assert.deepEqual(f.ledger.getRun(f.run.runId).retry.completedTools,[firstTool])
  f.advance(60000)
  assert.equal((await worker.pollOnce())[0].value.state,'retry_scheduled')
  assert.deepEqual(f.ledger.getRun(f.run.runId).retry.completedTools,[firstTool,secondTool])
  f.advance(60000)
  assert.equal((await worker.pollOnce())[0].value.state,'acknowledged')
  assert.deepEqual(seen[3].claim.run.retry.completedTools,[firstTool,secondTool])
  assert.equal(new Set(seen.map(request=>request.sessionId)).size,1)
  assert.equal(new Set(seen.map(request=>request.claim.attempt.attemptId)).size,4)
  assert.equal(f.ledger.getRun(f.run.runId).state,'succeeded')
})

test('actual signed coordinator rejects unlisted completed tools and task-excluded tools without scheduling continuation',async t=>{
  for(const [label,policy] of [
    ['default-deny',{}],
    ['operator-deny',{resumableTools:['fs:read']}],
    ['task-deny',{resumableTools:['fs:write'],allowedTools:['fs:read']}],
  ])await t.test(label,async t=>{
    const f=fixture(t,policy),claim=(await f.remote.claim('claim',{runId:f.run.runId,nodeId:'worker',ttlMs:60000})).value
    const ref={runId:f.run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:'owner'}
    await f.remote.markRunning('start',ref);await f.remote.bindSession('bind',{...ref,sessionId:'bound-session'})
    await assert.rejects(f.remote.retryBeforeEffects('denied-tool',{...ref,witness:completedWitness('bound-session',[fingerprint('fs:write')])}),/REMOTE_OUTCOME_UNCERTAIN/)
    assert.equal(f.ledger.getRun(f.run.runId).state,'running')
    assert.equal(f.ledger.getRun(f.run.runId).retry,undefined)
    assert.equal(f.ledger.getAttempt(claim.attempt.attemptId).state,'running')
  })
})

test('signed malformed or unclosed completed-tool proofs never reach the actual coordinator transition',async t=>{
  const f=fixture(t,{resumableTools:['fs:read']}),claim=(await f.remote.claim('claim',{runId:f.run.runId,nodeId:'worker',ttlMs:60000})).value
  const ref={runId:f.run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:'owner'}
  await f.remote.markRunning('start',ref);await f.remote.bindSession('bind',{...ref,sessionId:'bound-session'})
  let transitions=0;const original=f.ledger.retryBeforeEffects.bind(f.ledger)
  f.ledger.retryBeforeEffects=(...args)=>{transitions++;return original(...args)}
  const valid=completedWitness('bound-session')
  for(const [index,bad] of [
    {...valid,toolDispatchCount:0},{...valid,toolResultCount:0},{...valid,disposed:false},
    {...valid,completedTools:[{...fingerprint(),rawArguments:'forbidden'}]},
    {...valid,completedTools:[fingerprint('fs:read','A'.repeat(64))]},
  ].entries())await assert.rejects(f.remote.retryBeforeEffects(`invalid-${index}`,{...ref,witness:bad}),/REMOTE_OUTCOME_UNCERTAIN/)
  assert.equal(transitions,0)
  assert.equal(f.ledger.getRun(f.run.runId).state,'running')
  assert.equal(f.ledger.getRun(f.run.runId).retry,undefined)
})

test('runtime result guard rejects unclosed, wrong-session and non-unknown completed-tool evidence before retry dispatch',async t=>{
  for(const [label,change] of [
    ['unclosed',result=>({...result,retryWitness:{...result.retryWitness,toolResultCount:0}})],
    ['wrong-session',result=>({...result,retryWitness:{...result.retryWitness,sessionId:'other-session'}})],
    ['wrong-outcome',result=>({...result,outcome:'success'})],
    ['invalid-allowance',result=>({...result,retryAllowed:'yes'})],
  ])await t.test(label,async t=>{
    const f=fixture(t,{resumableTools:['fs:read']});let executions=0,transitions=0
    const original=f.ledger.retryBeforeEffects.bind(f.ledger)
    f.ledger.retryBeforeEffects=(...args)=>{transitions++;return original(...args)}
    const {worker}=f.worker(async request=>{executions++;return change({outcome:'unknown',summary:'Invalid runtime evidence fixture',retryWitness:completedWitness(request.sessionId)})})
    assert.equal((await worker.pollOnce())[0].value.state,'uncertain')
    assert.equal(transitions,0);assert.equal(executions,1)
    assert.equal(f.ledger.getRun(f.run.runId).retry,undefined)
    await worker.recoverResults();assert.equal(executions,1);assert.equal(transitions,0)
  })
})

test('actual signed TaskLedger retry waits for backoff, preserves run/session/runtime origin, and acquires a new fenced attempt (native witness mocked)',async t=>{
  const f=fixture(t),seen=[]
  const {worker,store}=f.worker(async request=>{seen.push(request);return seen.length===1?{outcome:'unknown',summary:'Rate limited before any tool',retryWitness:witness(request.sessionId)}:{outcome:'success',summary:'Recovered'}})
  const first=(await worker.pollOnce())[0]
  assert.equal(first.status,'fulfilled');assert.equal(first.value.state,'retry_scheduled')
  let run=f.ledger.getRun(f.run.runId);assert.equal(run.state,'queued');assert.equal(run.retry.count,1)
  const origin=run.executionStartedAt,session=run.retry.sessionId
  assert.deepEqual(await worker.pollOnce(),[]);assert.equal(seen.length,1)
  f.advance(30000)
  const next=(await worker.pollOnce())[0];assert.equal(next.value.state,'acknowledged');assert.equal(seen.length,2)
  assert.equal(seen[1].sessionId,session);assert.equal(seen[1].claim.attempt.sessionId,session)
  assert.notEqual(seen[0].claim.attempt.attemptId,seen[1].claim.attempt.attemptId)
  assert.ok(seen[1].claim.attempt.fence>seen[0].claim.attempt.fence)
  run=f.ledger.getRun(f.run.runId);assert.equal(run.state,'succeeded');assert.equal(run.executionStartedAt,origin)
  assert.deepEqual(store.dispatches().map(record=>record.state).sort(),['acknowledged','retry_scheduled'])
})

test('actual retry commit with lost gateway completion recovers exact receipt after journal restart, without provider replay',async t=>{
  const f=fixture(t);let effects=0,retries=0
  const originalRetry=f.ledger.retryBeforeEffects.bind(f.ledger);f.ledger.retryBeforeEffects=(...args)=>{retries++;return originalRetry(...args)}
  const provider=async request=>{effects++;return effects===1?{outcome:'unknown',summary:'Transient before tools',retryWitness:witness(request.sessionId)}:{outcome:'success',summary:'Recovered'}}
  const first=f.worker(provider),complete=f.serverStore.complete.bind(f.serverStore);let lost=true
  f.serverStore.complete=(node,command,...rest)=>{if(lost&&command.startsWith('retry-')){lost=false;throw new Error('crash after core commit')}return complete(node,command,...rest)}
  assert.equal((await first.worker.pollOnce())[0].value.state,'retry_pending');assert.equal(f.ledger.getRun(f.run.runId).retry.count,1)
  await first.worker.dispose();first.store.close();f.serverStore.complete=complete
  const restarted=f.worker(provider);assert.equal((await restarted.worker.recoverResults())[0].state,'retry_scheduled')
  assert.equal(effects,1);assert.equal(retries,1)
  f.advance(30000);assert.equal((await restarted.worker.pollOnce())[0].value.state,'acknowledged');assert.equal(effects,2)
})

test('completed-tool retry with lost ACK restores the exact proof and fingerprints without redispatch (native evidence mocked)',async t=>{
  const f=fixture(t,{resumableTools:['fs:read']});let executions=0,transitions=0,completedReads=0
  const original=f.ledger.retryBeforeEffects.bind(f.ledger)
  f.ledger.retryBeforeEffects=(...args)=>{transitions++;return original(...args)}
  const provider=async request=>{
    executions++
    if(executions===1){completedReads++;return {outcome:'unknown',summary:'Transient after completed read',retryWitness:completedWitness(request.sessionId)}}
    assert.deepEqual(request.claim.run.retry.completedTools,[fingerprint()])
    return {outcome:'success',summary:'Continued with prior completion context'}
  }
  const first=f.worker(provider),complete=f.serverStore.complete.bind(f.serverStore);let lost=true
  f.serverStore.complete=(node,command,...rest)=>{if(lost&&command.startsWith('retry-')){lost=false;throw new Error('lost ACK after core retry commit')}return complete(node,command,...rest)}
  const pending=(await first.worker.pollOnce())[0].value
  assert.equal(pending.state,'retry_pending')
  assert.deepEqual(pending.result.retryWitness.completedTools,[fingerprint()])
  assert.deepEqual(f.ledger.getRun(f.run.runId).retry.completedTools,[fingerprint()])
  const sessionId=pending.sessionId
  await first.worker.dispose();first.store.close();f.serverStore.complete=complete
  const restarted=f.worker(provider)
  const recovered=(await restarted.worker.recoverResults())[0]
  assert.equal(recovered.state,'retry_scheduled')
  assert.deepEqual(recovered.result.retryWitness,pending.result.retryWitness)
  assert.deepEqual(recovered.receipt.value.retry.completedTools,[fingerprint()])
  assert.equal(executions,1);assert.equal(completedReads,1);assert.equal(transitions,1)
  await restarted.worker.recoverResults();assert.equal(executions,1);assert.equal(transitions,1)
  f.advance(30000)
  const continued=(await restarted.worker.pollOnce())[0].value
  assert.equal(continued.state,'acknowledged');assert.equal(continued.sessionId,sessionId)
  assert.equal(executions,2);assert.equal(completedReads,1);assert.equal(transitions,1)
  assert.equal(f.ledger.getRun(f.run.runId).state,'succeeded')
})

test('retry recovery revalidates the durable runtime outcome before sending its saved transition',async t=>{
  const f=fixture(t,{resumableTools:['fs:read']});let executions=0,requests=0
  // An unavailable transport leaves a valid native result durably pending.
  f.remote.retryBeforeEffects=async()=>{requests++;throw new Error('fixture transport unavailable')}
  const {worker,store}=f.worker(async request=>{executions++;return {outcome:'unknown',summary:'Transient after completed read',retryWitness:completedWitness(request.sessionId)}})
  const pending=(await worker.pollOnce())[0].value
  assert.equal(pending.state,'retry_pending');assert.equal(requests,1)
  const saved=store.dispatch(pending.attemptId)
  saved.result.outcome='success';store.saveDispatch(saved)
  await assert.rejects(worker.recoverResults(),/RETRY_REQUIRES_UNKNOWN_OUTCOME/)
  assert.equal(requests,1);assert.equal(executions,1)
  assert.equal(f.ledger.getRun(f.run.runId).retry,undefined)
})

test('disabled retry budget returns a durable safe terminal failure; ordinary unknown never retries',async t=>{
  const f=fixture(t,{maxRetries:0}),{worker}=f.worker(async request=>({outcome:'unknown',summary:'No tools before rate limit',retryWitness:witness(request.sessionId)}))
  assert.equal((await worker.pollOnce())[0].value.state,'acknowledged');assert.equal(f.ledger.getRun(f.run.runId).state,'failed')
  const next=f.ledger.createRun('ordinary',{taskId:f.task.taskId,route:f.run.route}).value
  let attempts=0;const other=f.worker(async()=>{attempts++;return {outcome:'unknown',summary:'Outcome may have effects'}},'ordinary.sqlite')
  assert.equal((await other.worker.execute(next.runId,'ordinary-claim')).state,'acknowledged')
  assert.equal(f.ledger.getRun(next.runId).state,'uncertain');f.advance(30000);assert.deepEqual(await other.worker.pollOnce(),[]);assert.equal(attempts,1)
})

test('signed retry requires current execution owner and matching session; invalid witness cannot schedule a new attempt',async t=>{
  const f=fixture(t),claim=(await f.remote.claim('claim',{runId:f.run.runId,nodeId:'worker',ttlMs:60000})).value
  const ref={runId:f.run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:'owner'}
  await f.remote.markRunning('start',ref);await f.remote.bindSession('bind',{...ref,sessionId:'bound-session'})
  await assert.rejects(f.remote.retryBeforeEffects('wrong-owner',{...ref,executionId:'other',witness:witness('bound-session')}),/REMOTE_OUTCOME_UNCERTAIN/)
  await assert.rejects(f.remote.retryBeforeEffects('wrong-session',{...ref,witness:witness('other-session')}),/REMOTE_OUTCOME_UNCERTAIN/)
  assert.equal(f.ledger.getRun(f.run.runId).state,'running');assert.equal(f.ledger.getRun(f.run.runId).retry,undefined)
})


test('actual signed retry stops after the pinned maximum and never starts another provider attempt',async t=>{
  const f=fixture(t,{maxRetries:1});let executions=0
  const {worker}=f.worker(async request=>{executions++;return {outcome:'unknown',summary:'Transient before tools',retryWitness:witness(request.sessionId)}})
  assert.equal((await worker.pollOnce())[0].value.state,'retry_scheduled')
  f.advance(30000);assert.equal((await worker.pollOnce())[0].value.state,'acknowledged')
  assert.equal(f.ledger.getRun(f.run.runId).state,'failed');assert.equal(executions,2)
  f.advance(60000);assert.deepEqual(await worker.pollOnce(),[]);assert.equal(executions,2)
})


test('a stricter host runtime budget can refuse retry but cannot expand coordinator policy',async t=>{
  const f=fixture(t,{maxRetries:2});let executions=0
  const {worker}=f.worker(async request=>{executions++;return {outcome:'unknown',summary:'Host budget cannot fit another delay',retryWitness:witness(request.sessionId),retryAllowed:false}})
  assert.equal((await worker.pollOnce())[0].value.state,'acknowledged')
  assert.equal(f.ledger.getRun(f.run.runId).state,'failed');assert.equal(f.ledger.getRun(f.run.runId).retry,undefined)
  f.advance(60000);assert.deepEqual(await worker.pollOnce(),[]);assert.equal(executions,1)
})
