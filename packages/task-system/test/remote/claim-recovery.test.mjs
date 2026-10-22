import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../../dist/ledger.js';
import {RecoveryStore,RemoteGateway,RemoteClient,RemoteLedgerClient,IdentityVerifier,ExecutorWorker,signEnvelope,digest} from '../../dist/remote/api.js';
const keys=generateKeyPairSync('ed25519');
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'claim-recovery-'));let now=Date.now(),seq=0;
 const resources=[];t.after(async()=>{for(const r of resources.reverse())await(r.dispose?.()??r.close?.());rmSync(root,{recursive:true,force:true});});
 const ledger=TaskLedger.open(join(root,'ledger.sqlite'),{role:'planner',nodeId:'planner',now:()=>now});resources.push(ledger);
 ledger.registerWorkspace('workspace',{workspaceId:'ws',nodeId:'worker',path:root,label:'fixture',state:'ready',createdAt:new Date(now).toISOString()});
 ledger.registerNode('node',{nodeId:'worker',enabled:true,roles:['executor'],workspaceIds:['ws'],capabilities:[],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],maxConcurrent:1,lastSeenAt:new Date(now).toISOString()});
 const task=ledger.createTask('task',{title:'Existing authorized work',policy:{settlementQuietMs:0}}).value;
 const run=ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',workspaceId:'ws',provider:'fixture',model:'fixture',requiredCapabilities:[]}}).value;
 const peer={nodeId:'worker',keyId:'fixture',audience:'planner',publicKey:keys.publicKey,operations:['claim','getRun','getAttempt','markRunning','renew','submit','bindSession'],workspaces:['ws'],capabilities:[]};
 let store=new RecoveryStore(join(root,'gateway.sqlite'));resources.push(store);
 const makeGateway=(adapter=ledger)=>{const g=new RemoteGateway({role:'planner',nodeId:'planner',ledger:adapter,store,now:()=>now,verifier:new IdentityVerifier({audience:'planner',peers:[peer]})});resources.push(g);return g;};
 let gateway=makeGateway();
 const call=(commandId='same-claim')=>gateway.handle(JSON.stringify(signEnvelope({version:1,keyId:'fixture',nodeId:'worker',audience:'planner',commandId,nonce:`nonce-${++seq}`,sequence:seq,issuedAt:now,expiresAt:now+60000,operation:'claim',payload:{runId:run.runId,ttlMs:60000}},keys.privateKey)));
 return {root,ledger,task,run,resources,call,get store(){return store},get gateway(){return gateway},setAdapter(adapter){gateway=makeGateway(adapter)},restart(){store.close();store=new RecoveryStore(join(root,'gateway.sqlite'));resources.push(store);store.recover();gateway=makeGateway()},advance(ms){now+=ms},now:()=>now};
}

test('native pre-commit exception rolls back and same command recovers without a replacement Run',async t=>{
 const f=fixture(t),db=f.ledger.managementDatabase();
 db.exec(`CREATE TRIGGER fail_claim BEFORE INSERT ON commands WHEN NEW.id='remote-${digest(['worker','same-claim'])}' BEGIN SELECT RAISE(ABORT,'fixture before commit'); END`);
 const nativeClaim=f.ledger.claim.bind(f.ledger);let injected;
 f.ledger.claim=(...args)=>{try{return nativeClaim(...args)}catch(error){injected=error;throw error}};
 assert.equal((await f.call()).state,'uncertain');assert.match(injected.message,/fixture before commit/);assert.equal(f.ledger.snapshot().attempts.length,0);assert.equal(f.ledger.getRun(f.run.runId).state,'queued');
 db.exec('DROP TRIGGER fail_claim');
 const recovered=await f.call();assert.equal(recovered.state,'done');assert.equal(f.ledger.snapshot().attempts.length,1);assert.equal(f.ledger.snapshot().runs.length,1);
 assert.deepEqual(await f.call(),recovered);
});

test('lost gateway response after native commit and restart recovers the exact Attempt and lease',async t=>{
 const f=fixture(t),resolve=f.store.resolve.bind(f.store);let once=true;
 f.store.resolve=(...args)=>{if(once){once=false;throw Error('fixture lost after commit')}return resolve(...args)};
 assert.equal((await f.call()).state,'uncertain');const attempt=f.ledger.snapshot().attempts[0];assert.ok(attempt);
 f.restart();const receipt=await f.call();assert.equal(receipt.state,'done');assert.deepEqual(receipt.result.value.attempt,attempt);assert.equal(f.ledger.snapshot().attempts.length,1);
});

test('concurrent same-ID retries converge on one durable Attempt',async t=>{
 const f=fixture(t);const replies=await Promise.all([f.call(),f.call(),f.call()]);
 assert.ok(replies.every(r=>r.state==='done'));assert.deepEqual(replies[0],replies[1]);assert.equal(f.ledger.snapshot().attempts.length,1);
});

test('known BUSY is a durable visible non-admission, and the same command remains retryable',async t=>{
 const f=fixture(t),other=f.ledger.createRun('holder-run',{taskId:f.task.taskId,route:f.run.route}).value;
 const held=f.ledger.claim('holder',{runId:other.runId,nodeId:'worker',ttlMs:60000}).value;
 const denied=await f.call();assert.equal(denied.state,'pending');assert.equal(denied.result.claimRejected.code,'BUSY');assert.equal(f.ledger.getRun(f.run.runId).state,'queued');
 f.ledger.submit('settle-holder',{runId:other.runId,attemptId:held.attempt.attemptId,nodeId:'worker',fence:held.attempt.fence,outcome:'success',summary:'fixture capacity released'});
 const accepted=await f.call();assert.equal(accepted.state,'done');assert.equal(f.ledger.snapshot().attempts.filter(a=>a.runId===f.run.runId).length,1);
});

test('an adapter without explicit atomic claim recovery still cannot retry an unknown outcome',async t=>{
 const f=fixture(t);let calls=0;f.setAdapter({getRun:f.ledger.getRun.bind(f.ledger),claim(){calls++;throw Error('unknown external outcome')}});
 assert.equal((await f.call()).state,'uncertain');assert.equal((await f.call()).state,'uncertain');assert.equal(calls,1);
});

test('expired recovered claim is evidence only and never starts a provider',async t=>{
 const f=fixture(t),first=await f.call();assert.equal(first.state,'done');f.advance(60001);
 const clientStore=new RecoveryStore(':memory:');f.resources.push(clientStore);
 const client=new RemoteClient({endpoint:'https://fixture.invalid',nodeId:'worker',keyId:'fixture',audience:'planner',privateKey:keys.privateKey,store:clientStore,now:f.now,fetch:async(_url,opts)=>new Response(JSON.stringify(await f.gateway.handle(opts.body)))});f.resources.push(client);
 // Keep a separate authenticated stream above the direct-call envelope sequence.
 clientStore.nextSequence('worker');let executions=0;
 const worker=new ExecutorWorker({ledger:new RemoteLedgerClient(client,'worker'),store:clientStore,now:f.now,policy:{role:'executor',nodeId:'worker',capabilities:[],workspaces:[{workspaceId:'ws',nodeId:'worker',path:f.root,allowedRoot:f.root}]},provider:{id:'fixture',capabilities:[],supports:()=>true,execute:async()=>{executions++;return {outcome:'success',summary:'must not run'}}}});f.resources.push(worker);
 await assert.rejects(worker.execute(f.run.runId,'same-claim'),/LEASE_EXPIRED/);assert.equal(executions,0);assert.equal(f.ledger.snapshot().attempts.length,1);
});

test('client persists specific BUSY diagnosis and retries the same outbound command after capacity clears',async t=>{
 const f=fixture(t),other=f.ledger.createRun('holder-run',{taskId:f.task.taskId,route:f.run.route}).value;
 const held=f.ledger.claim('holder',{runId:other.runId,nodeId:'worker',ttlMs:60000}).value;
 const clientStore=new RecoveryStore(':memory:');f.resources.push(clientStore);
 const client=new RemoteClient({endpoint:'https://fixture.invalid',nodeId:'worker',keyId:'fixture',audience:'planner',privateKey:keys.privateKey,store:clientStore,now:f.now,fetch:async(_url,opts)=>new Response(JSON.stringify(await f.gateway.handle(opts.body)))});f.resources.push(client);
 const remote=new RemoteLedgerClient(client,'worker'),input={runId:f.run.runId,nodeId:'worker',ttlMs:60000};
 await assert.rejects(remote.claim('same-claim',input),error=>error.code==='BUSY' && error.message.includes('capacity'));
 const [diagnosis]=clientStore.panelClaims();assert.equal(diagnosis.code,'BUSY');assert.equal(diagnosis.state,'pending');assert.equal(diagnosis.endpoint,'https://fixture.invalid/');
 f.ledger.submit('settle-holder',{runId:other.runId,attemptId:held.attempt.attemptId,nodeId:'worker',fence:held.attempt.fence,outcome:'success',summary:'fixture capacity released'});
 const accepted=await remote.claim('same-claim',input);assert.equal(accepted.value.run.runId,f.run.runId);assert.equal(clientStore.panelClaims().length,0);
});
