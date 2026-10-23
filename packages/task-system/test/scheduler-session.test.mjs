import {registerExecutor} from '../../../tests/dsh/executor-fixture.mjs';
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { TaskLedger } from '../dist/ledger.js'
import { chooseExecutionSession } from '../dist/execution-session.js'
import { RecoveryStore, IdentityVerifier, TrustedNetworkVerifier, RemoteGateway, RemoteClient, RemoteLedgerClient, ExecutorWorker, signEnvelope } from '../dist/remote/api.js'
import { TaskPluginSettings, queueDescriptor, executorIdentityDescriptor } from '../dist/settings.js'
import { DecisionEngine, StructuredModelProvider } from './legacy-model-fixture.mjs'
const operations = ['executorIdentity','sessionContext','selectTaskSession','claim','markRunning','bindSession','submit','getRun','getAttempt','listWork','renew']
function legacyStoredRun(ledger,run,workspaceId=run.route.workspaceId??'default') {
  // Pre-managed-directory records derived a node default without making it a
  // caller constraint. Reconstruct that persisted shape to retain compatibility tests.
  const {projectContext,...stored}=run;stored.route={...stored.route,workspaceId};
  ledger.managementDatabase().prepare("UPDATE entities SET data=? WHERE kind='run' AND id=?").run(JSON.stringify(stored),run.runId);
  return ledger.getRun(run.runId);
}
function fixture(t, {legacy=false}={}) {
  const dir = mkdtempSync(join(tmpdir(),'scheduler-sessions-'))
  t.after(() => rmSync(dir,{ recursive: true,force: true }))
  const ledger = TaskLedger.open(join(dir,'ledger.sqlite'))
  t.after(() => ledger.close())
  for (const workspaceId of ['default','other']) { mkdirSync(join(dir,workspaceId)); ledger.registerWorkspace(`workspace-${workspaceId}`,{ workspaceId,nodeId:'worker',path:join(dir,workspaceId),label:workspaceId,state:'ready',createdAt:new Date().toISOString() }) }
  registerExecutor(ledger,'node',{ nodeId:'worker',roles:['executor'],models:[{provider:'mock',model:'mock',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default','other'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString(),maxConcurrent:4 })
  const task = ledger.createTask('task',{ taskId:'same-task',title:'Private queue title',description:'private execution description',policy:{allowedTools:[]} }).value
  const route = { nodeId:'worker',provider:'mock',model:'mock',requiredCapabilities:[] }
  const run = (id,workspaceId) => {const created=ledger.createRun(`run-${id}`,{ runId:`run-${id}`,taskId:task.taskId,route:{...route,...(workspaceId?{workspaceId}:{})} }).value;return legacy?legacyStoredRun(ledger,created):created}
  const claim = (r,id) => { const c=ledger.claim(`claim-${id}`,{ runId:r.runId,nodeId:'worker',ttlMs:60000 }).value; const ref={runId:r.runId,attemptId:c.attempt.attemptId,nodeId:'worker',fence:c.attempt.fence,executionId:`execution-${id}`}; c.attempt=ledger.markRunning(`start-${id}`,ref).value; return {c,ref} }
  return {ledger,dir,task,route,run,claim}
}
async function select(f,ref,c,options={}) {
  const choice = await chooseExecutionSession({claim:c,context:f.ledger.sessionContext(ref),managedWorkspaceAvailable:true,workspaces:['default','other'].map(workspaceId=>({workspaceId,nodeId:'worker',description:workspaceId,eligible:true})),...options})
  return f.ledger.selectTaskSession(`select-${ref.attemptId}`,{...ref,...choice}).value
}
test('managed Task session reuse persists across distinct runs and reopening without deriving a node workspace',async t=>{
  const f=fixture(t); const first=f.run('one'); assert.equal(first.route.workspaceId,undefined);assert.ok(first.projectContext); assert.equal(f.route.workspaceId,undefined)
  const {c,ref}=f.claim(first,'one'); const a=await select(f,ref,c); assert.equal(a.resume,false);assert.equal(a.workspaceId,undefined)
  f.ledger.submit('settle-one',{...ref,outcome:'success',summary:'ok'})
  const other=TaskLedger.open(join(f.dir,'ledger.sqlite')); t.after(()=>other.close()); assert.equal(other.schedulerIdentity(),f.ledger.schedulerIdentity())
  const next=f.claim(f.run('two'),'two'); const b=await select(f,next.ref,next.c); assert.equal(b.sessionId,a.sessionId); assert.equal(b.resume,true)
})
test('same Task and node on distinct schedulers never share a session',async t=>{
  const a=fixture(t),b=fixture(t); const one=a.claim(a.run('one'),'one'),two=b.claim(b.run('one'),'one')
  const x=await select(a,one.ref,one.c),y=await select(b,two.ref,two.c)
  assert.notEqual(x.schedulerId,y.schedulerId); assert.notEqual(x.sessionId,y.sessionId)
})
test('foreign or workspace-mismatched session and a second owner are rejected without replacing the active binding',async t=>{
  const f=fixture(t),x=f.claim(f.run('one'),'one'),first=await select(f,x.ref,x.c)
  assert.throws(()=>f.ledger.selectTaskSession('replace-active',{...x.ref,session:{mode:'new'}}),/Active attempt/)
  assert.throws(()=>f.ledger.selectTaskSession('wrong-workspace',{...x.ref,workspaceId:'other',session:{mode:'reuse',sessionId:first.sessionId}}),/not an owned/)
  assert.throws(()=>f.ledger.selectTaskSession('foreign-session',{...x.ref,session:{mode:'reuse',sessionId:'ordinary-unowned-session'}}),/not an owned/)
  const y=f.claim(f.run('two'),'two'); assert.throws(()=>f.ledger.selectTaskSession('duplicate-owner',{...y.ref,session:{mode:'reuse',sessionId:first.sessionId}}),/already owned/)
  assert.equal(f.ledger.getAttempt(x.ref.attemptId).sessionId,first.sessionId)
})
test('legacy stored runs permit an optional decision to select an eligible alternate workspace',async t=>{
  const f=fixture(t,{legacy:true}),x=f.claim(f.run('one'),'one'); let calls=0
  const provider=new StructuredModelProvider('ordinary',[{model:'judge',version:'fixture',reasoningEfforts:[]}],{complete:async()=>{calls++;return {output:{answers:{session:{type:'choice',choice:'new'},workspace:{type:'choice',choice:'other'}}},modelVersion:'fixture'}}})
  const decisions=new DecisionEngine([provider],{defaultProvider:'ordinary',maxAttempts:1});t.after(()=>decisions.close())
  const selected=await select(f,x.ref,x.c,{decisions});assert.equal(calls,1);assert.equal(selected.workspaceId,'other');assert.equal(f.ledger.getRun(x.ref.runId).route.workspaceId,'other')
  const event=f.ledger.snapshot().events.find(event=>event.type==='session.selected');assert.ok(event.detail.decision);assert.equal(event.detail.decision.status,'answered')
  f.ledger.submit('settle-decision',{...x.ref,outcome:'success',summary:'fixture'})
  const nextRun=f.run('after-alternate');assert.equal(nextRun.route.workspaceId,'other')
  const next=f.claim(nextRun,'after-alternate'),reused=await select(f,next.ref,next.c);assert.equal(reused.sessionId,selected.sessionId);assert.equal(reused.resume,true);assert.equal(reused.workspaceId,'other')
})
test('legacy configured invalid default workspace fails rather than inventing a path',async t=>{
  const f=fixture(t,{legacy:true}),x=f.claim(f.run('one'),'one')
  await assert.rejects(chooseExecutionSession({claim:x.c,context:f.ledger.sessionContext(x.ref),workspaces:[]}),/default workspace/)
})
function remote(t,f,{network=false,allowed=operations}={}) {
  const keys=generateKeyPairSync('ed25519'),store=new RecoveryStore(':memory:'),clientStore=new RecoveryStore(':memory:')
  t.after(()=>{store.close();clientStore.close()})
  const peer={keyId:'fixture',nodeId:'worker',publicKey:keys.publicKey,audience:'scheduler',operations:allowed,workspaces:['default','other'],capabilities:[]}
  const verifier=network?new TrustedNetworkVerifier({audience:'scheduler',listen:{address:'127.0.0.1',port:45678},allowHttp:true,allowedAddresses:['127.0.0.2'],peers:[{...peer,address:'127.0.0.2',role:'executor'}]}):new IdentityVerifier({audience:'scheduler',peers:[peer]})
  let gateway=new RemoteGateway({role:'planner',nodeId:'scheduler',verifier,ledger:f.ledger,store})
  const client=new RemoteClient({endpoint:'http://127.0.0.1:45678/commands',audience:'scheduler',nodeId:'worker',keyId:'fixture',privateKey:keys.privateKey,store:clientStore,allowLoopbackHttp:true,fetch:async(_url,init)=>new Response(JSON.stringify(await gateway.handle(init.body)),{status:200})})
  t.after(()=>client.dispose())
  return {store,clientStore,client,peer,gateway,keys,remote:new RemoteLedgerClient(client,'worker'),replace(next){gateway=next}}
}
test('authenticated scheduler assigns a stable executor ID; reconnection pins exact destination identity',async t=>{
  const f=fixture(t),r=remote(t,f); const a=await r.client.executorIdentity(),b=await r.client.executorIdentity(); assert.deepEqual(a,b); assert.equal(a.schedulerId,f.ledger.schedulerIdentity());assert.match(a.executorId,/^executor-/)
  const another=fixture(t);r.replace(new RemoteGateway({role:'planner',nodeId:'scheduler',verifier:new IdentityVerifier({audience:'scheduler',peers:[r.peer]}),ledger:another.ledger,store:r.store}))
  await assert.rejects(r.client.executorIdentity(),/SCHEDULER_IDENTITY_CHANGED/)
})
test('identity query cannot nominate another node or bypass an operation grant',async t=>{
  const f=fixture(t),r=remote(t,f,{allowed:[]}),now=Date.now()
  const envelope=overrides=>signEnvelope({version:1,keyId:'fixture',nodeId:'worker',audience:'scheduler',commandId:'identity',nonce:'nonce',sequence:1,issuedAt:now,expiresAt:now+60000,operation:'executorIdentity',payload:{},...overrides},r.keys.privateKey)
  await assert.rejects(r.gateway.handle(JSON.stringify(envelope({}))),/OPERATION_DENIED/)
  await assert.rejects(r.gateway.handle(JSON.stringify(envelope({nodeId:'someone-else'}))),/WRONG_NODE/)
})
test('trusted network identity query uses exact peer socket and never the claimed node alone',async t=>{
  const f=fixture(t),r=remote(t,f,{network:true}),now=Date.now(),env={version:2,authMode:'trusted-network',nodeId:'worker',audience:'scheduler',commandId:'identity',nonce:'nonce',sequence:1,issuedAt:now,expiresAt:now+60000,operation:'executorIdentity',payload:{}}
  const transport={remoteAddress:'127.0.0.2',localAddress:'127.0.0.1',localPort:45678}; const result=await r.gateway.handle(JSON.stringify(env),transport);assert.equal(result.result.nodeId,'worker')
  await assert.rejects(r.gateway.handle(JSON.stringify({...env,nonce:'n2',sequence:2}),{...transport,remoteAddress:'127.0.0.3'}),/NETWORK_ADDRESS_DENIED/)
})
test('signed remote worker uses authority Task binding and asks provider to resume on its second run',async t=>{
  const f=fixture(t),r=remote(t,f),seen=[],store=new RecoveryStore(':memory:');t.after(()=>store.close())
  const worker=new ExecutorWorker({ledger:r.remote,provider:{id:'mock',capabilities:[],supports:()=>true,execute:async req=>{seen.push({sessionId:req.sessionId,resume:req.resumeSession});return {outcome:'success',summary:'mock-only result'}}},store,policy:{role:'executor',nodeId:'worker',capabilities:[],workspaces:['default','other'].map(workspaceId=>({workspaceId,nodeId:'worker',path:join(f.dir,workspaceId),allowedRoot:f.dir}))},taskSessions:true,prepare:()=>r.client.executorIdentity()})
  t.after(()=>worker.dispose())
  assert.equal((await worker.execute(f.run('one','default').runId,'claim-remote-one')).state,'acknowledged')
  assert.equal((await worker.execute(f.run('two','default').runId,'claim-remote-two')).state,'acknowledged')
  assert.equal(seen.length,2);assert.equal(seen[0].resume,false);assert.equal(seen[1].resume,true);assert.equal(seen[0].sessionId,seen[1].sessionId)
})
test('settings queue is bounded read-only data and identity RPC has no caller-supplied target',async t=>{
  const f=fixture(t);f.run('queue');const ctx={get:name=>name==='taskSystem'?{ledger:f.ledger,config:{nodeId:'worker'}}:undefined}
  const before=f.ledger.snapshot().events.length,view=await TaskPluginSettings.prototype.queue.call({ctx})
  assert.equal(view.items.length,1);assert.equal(view.items[0].title,'Private queue title');assert.ok(!JSON.stringify(view).includes('private execution description'));assert.equal(f.ledger.snapshot().events.length,before)
  assert.deepEqual(queueDescriptor.parameters,[]);assert.deepEqual(executorIdentityDescriptor.parameters,[])
})

test('scheduler-assigned IDs survive store reopening and differ across scheduler authorities',t=>{
  const f=fixture(t),file=join(f.dir,'identity.sqlite'),store=new RecoveryStore(file)
  const first=store.executorIdentity(f.ledger.schedulerIdentity(),'worker');store.close()
  const reopened=new RecoveryStore(file);t.after(()=>reopened.close())
  assert.deepEqual(reopened.executorIdentity(f.ledger.schedulerIdentity(),'worker'),first)
  const other=fixture(t);assert.notEqual(reopened.executorIdentity(other.ledger.schedulerIdentity(),'worker').executorId,first.executorId)
})

test('concurrent first-run snapshots cannot silently create two default Task sessions',async t=>{
  const f=fixture(t),a=f.claim(f.run('one'),'one'),b=f.claim(f.run('two'),'two')
  const workspaces=[{workspaceId:'default',nodeId:'worker',description:'default',eligible:true}]
  const first=await chooseExecutionSession({claim:a.c,context:f.ledger.sessionContext(a.ref),managedWorkspaceAvailable:true,workspaces})
  const second=await chooseExecutionSession({claim:b.c,context:f.ledger.sessionContext(b.ref),managedWorkspaceAvailable:true,workspaces})
  f.ledger.selectTaskSession('first-choice',{...a.ref,...first})
  assert.throws(()=>f.ledger.selectTaskSession('racing-choice',{...b.ref,...second}),/catalog changed/)
  assert.equal(f.ledger.sessionContext(a.ref).sessions.length,1)
})

test('legacy runtime refresh rejects a stale alternate-workspace decision and falls back to its still-legal default',async t=>{
  const f=fixture(t,{legacy:true}),x=f.claim(f.run('one'),'one')
  const provider=new StructuredModelProvider('ordinary',[{model:'judge',version:'fixture',reasoningEfforts:[]}],{complete:async()=>{
    f.ledger.registerNode('narrow-workspaces',{...f.ledger.getNode('worker'),workspaceIds:['default']})
    return {output:{answers:{session:{type:'choice',choice:'new'},workspace:{type:'choice',choice:'other'}}},modelVersion:'fixture'}
  }})
  const decisions=new DecisionEngine([provider],{defaultProvider:'ordinary',maxAttempts:1});t.after(()=>decisions.close())
  const selected=await select(f,x.ref,x.c,{decisions,refresh:()=>f.ledger.sessionContext(x.ref)})
  assert.equal(selected.workspaceId,'default')
})
test('a refreshed fallback uses the refreshed Task binding in its commit CAS',async t=>{
  const f=fixture(t),seed=f.claim(f.run('seed'),'seed'),prior=await select(f,seed.ref,seed.c);f.ledger.submit('settle-seed',{...seed.ref,outcome:'success',summary:'Seed compatible managed session'});
  const x=f.claim(f.run('one'),'one');let concurrentlyBound
  const provider=new StructuredModelProvider('ordinary',[{model:'judge',version:'fixture',reasoningEfforts:[]}],{complete:async()=>{
    concurrentlyBound=f.ledger.selectTaskSession('other-authority-call',{...x.ref,expectedTaskSessionId:prior.sessionId,session:{mode:'new'}}).value
    return {output:{answers:{session:{type:'choice',choice:'new'}}},modelVersion:'fixture'}
  }})
  const decisions=new DecisionEngine([provider],{defaultProvider:'ordinary',maxAttempts:1});t.after(()=>decisions.close())
  const selected=await select(f,x.ref,x.c,{decisions,refresh:()=>f.ledger.sessionContext(x.ref)})
  assert.equal(selected.sessionId,concurrentlyBound.sessionId);assert.equal(selected.resume,true)
})
test('remote worker renews its lease while an optional session decision is pending',async t=>{
  const f=fixture(t),store=new RecoveryStore(':memory:');t.after(()=>store.close())
  const worker=new ExecutorWorker({ledger:f.ledger,provider:{id:'mock',capabilities:[],supports:()=>true,execute:async()=>({outcome:'success',summary:'fixture-only'})},store,ttlMs:1000,taskSessions:true,policy:{role:'executor',nodeId:'worker',capabilities:[],workspaces:['default','other'].map(workspaceId=>({workspaceId,nodeId:'worker',path:join(f.dir,workspaceId),allowedRoot:f.dir}))},chooseSession:async(claim,context,signal,refresh)=>{
    await new Promise(resolve=>setTimeout(resolve,1200));signal.throwIfAborted()
    return chooseExecutionSession({claim,context:await refresh(),signal,workspaces:['default','other'].map(workspaceId=>({workspaceId,nodeId:'worker',description:workspaceId,eligible:true}))})
  }})
  t.after(()=>worker.dispose())
  const started=Date.now(),result=await worker.execute(f.run('long-decision','default').runId,'long-claim')
  assert.ok(Date.now()-started>=1200);assert.equal(result.state,'acknowledged');assert.equal(f.ledger.getRun(result.claim.run.runId).state,'succeeded')
})


test('explicitly granted bound session is reused without model decisions and revoked workspace grants still fail',async t=>{
 const f=fixture(t),x=f.claim(f.run('first','default'),'first'),bound=await select(f,x.ref,x.c);
 f.ledger.submit('settle-first',{...x.ref,outcome:'failure',summary:'Stopped'});
 const next=f.claim(f.run('retry','default'),'retry');let calls=0;
 const decisions={ask:async()=>{calls++;throw Error('Existing binding must not call a model');}};
 const context=f.ledger.sessionContext(next.ref),workspaces=['default','other'].map(workspaceId=>({workspaceId,nodeId:'worker',description:workspaceId,eligible:true}));
 const choice=await chooseExecutionSession({claim:next.c,context,workspaces,decisions});
 assert.equal(calls,0);assert.equal(choice.session.sessionId,bound.sessionId);assert.equal(choice.expectedTaskSessionId,bound.sessionId);
 const reused=f.ledger.selectTaskSession('cached-session',{...next.ref,...choice}).value;assert.equal(reused.resume,true);
 await assert.rejects(chooseExecutionSession({claim:next.c,context:{...context,eligibleWorkspaceIds:['other']},workspaces,decisions}),/not eligible/);
 assert.equal(calls,0);
});

test('managed task selection requires the execution root instead of borrowing the node default',async t=>{const f=fixture(t),x=f.claim(f.run('root-required'),'root-required');await assert.rejects(chooseExecutionSession({claim:x.c,context:f.ledger.sessionContext(x.ref),workspaces:[{workspaceId:'default',nodeId:'worker',description:'old default',eligible:true}]}),/TASK_EXECUTION_ROOT_REQUIRED/);assert.equal(f.ledger.getAttempt(x.ref.attemptId).sessionId,undefined)});
