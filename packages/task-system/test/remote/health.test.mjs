import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { TaskLedger } from '../../dist/index.js'
import * as plugin from '../../dist/remote/index.js'
import { RecoveryStore,RemoteGateway,RemoteClient,RemoteLedgerClient,IdentityVerifier,signEnvelope } from '../../dist/remote/api.js'
const key=generateKeyPairSync('ed25519') // Disposable fixture, never production key material.
const operations=['heartbeat','nodeStatus','claim','markRunning','bindSession','renew','submit','getRun','getAttempt','receipt']
function fixture(t,{clock=true}={}) {
  const root=mkdtempSync(join(tmpdir(),'dsh-health-')), resources=[]; let ms=Date.now(), sequence=0
  const now=()=>clock?ms:Date.now()
  t.after(async()=>{for(const r of resources.reverse())await(r.dispose?.()??r.close?.());rmSync(root,{recursive:true,force:true})})
  const ledger=TaskLedger.open(join(root,'ledger.sqlite'),{role:'planner',nodeId:'planner',now,heartbeatTtlMs:5000});resources.push(ledger)
  const node={nodeId:'worker',roles:['executor'],capabilities:['read'],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],workspaceIds:['workspace'],enabled:true,lastSeenAt:new Date(now()).toISOString(),maxConcurrent:2}
  ledger.registerNode('node',node)
  ledger.registerNode('other',{...node,nodeId:'private-other',capabilities:['private-capability']})
  ledger.registerWorkspace('workspace',{workspaceId:'workspace',nodeId:'worker',path:root,label:'fixture',state:'ready',createdAt:new Date(now()).toISOString()})
  const peer={keyId:'fixture',nodeId:'worker',audience:'planner',publicKey:key.publicKey,operations,workspaces:['workspace'],capabilities:['read']}
  const serverStore=new RecoveryStore(join(root,'server.sqlite'));resources.push(serverStore)
  const gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger,store:serverStore,now,verifier:new IdentityVerifier({audience:'planner',peers:[peer]})});resources.push(gateway)
  const store=new RecoveryStore(join(root,'client.sqlite'));resources.push(store)
  const client=new RemoteClient({endpoint:'https://fixture.invalid/commands',nodeId:'worker',audience:'planner',keyId:'fixture',privateKey:key.privateKey,store,now,fetch:async(_url,options)=>new Response(JSON.stringify(await gateway.handle(options.body)))});resources.push(client)
  const signed=(operation,payload,overrides={})=>JSON.stringify(signEnvelope({version:1,keyId:'fixture',nodeId:'worker',audience:'planner',commandId:`raw-${++sequence}`,nonce:`nonce-${sequence}`,sequence:10000+sequence,issuedAt:now(),expiresAt:now()+60000,operation,payload,...overrides},key.privateKey))
  return {root,resources,ledger,node,peer,serverStore,gateway,client,remote:new RemoteLedgerClient(client,'worker'),now,advance:delta=>ms+=delta,signed}
}
const status={state:'not-probed',providers:[{provider:'fixture',state:'not-probed'}]}

test('actual TaskLedger signed heartbeat tracks finite stale/recovery, own-only status, capacity, and preserves all grants',async t=>{
  const f=fixture(t), before=f.ledger.getNode('worker')
  assert.equal((await f.remote.ownNodeStatus()).state,'unknown')
  const first={nodeId:'worker',sampledAt:f.now(),runtimeReady:true,activeExecutions:1,providerStatus:status}
  await f.remote.recordNodeHeartbeat('heartbeat-first',first)
  let own=await f.remote.ownNodeStatus()
  assert.equal(own.nodeId,'worker');assert.equal(own.state,'online');assert.equal(own.runtimeReady,true)
  assert.equal(own.activeExecutions,1);assert.equal(own.maxConcurrent,2);assert.equal(own.source,'authenticated-peer')
  assert.equal(JSON.stringify(own).includes('private-other'),false);assert.equal(JSON.stringify(own).includes('private-capability'),false)
  assert.deepEqual(f.ledger.getNode('worker'),before)
  f.advance(5001);assert.equal((await f.remote.ownNodeStatus()).state,'stale')
  await f.remote.recordNodeHeartbeat('heartbeat-first',first)
  assert.equal((await f.remote.ownNodeStatus()).state,'stale') // A cached receipt does not refresh health.
  await f.remote.recordNodeHeartbeat('heartbeat-recovered',{...first,sampledAt:f.now(),activeExecutions:0})
  own=await f.remote.ownNodeStatus();assert.equal(own.state,'online')
  const recoveredAt=own.observedAt
  await f.remote.recordNodeHeartbeat('older-sample',{...first,runtimeReady:false})
  own=await f.remote.ownNodeStatus();assert.equal(own.runtimeReady,true);assert.equal(own.observedAt,recoveredAt)
  f.advance(1);await f.remote.recordNodeHeartbeat('runtime-down',{...first,sampledAt:f.now(),runtimeReady:false,activeExecutions:0})
  assert.equal((await f.remote.ownNodeStatus()).state,'unavailable')
  assert.deepEqual(f.ledger.getNode('worker'),before)
})

test('health wire rejects spoofed identity, arbitrary health URLs, grant fields, invalid provider flags, and stale new samples',async t=>{
  const f=fixture(t), sample={sampledAt:f.now(),runtimeReady:true,activeExecutions:0,providerStatus:status}
  for(const payload of [{...sample,nodeId:'private-other'},{...sample,source:'host-local'},{...sample,capabilities:['shell']},{...sample,healthUrl:'https://private.invalid'}, {...sample,activeExecutions:129}, {...sample,providerStatus:{state:'verified',providers:[]}}, {...sample,providerStatus:{state:'ready',providers:[{provider:'fixture',state:'verified'}]}}]) {
    await assert.rejects(f.gateway.handle(f.signed('heartbeat',payload)),/PAYLOAD_FIELDS|INVALID_ACTIVE_EXECUTIONS|INVALID_PROVIDER_STATE/)
  }
  await assert.rejects(f.gateway.handle(f.signed('nodeStatus',{nodeId:'private-other'})),/PAYLOAD_FIELDS/)
  await assert.rejects(f.gateway.handle(f.signed('heartbeat',sample,{nodeId:'private-other'})),/WRONG_NODE/)
  await assert.rejects(f.gateway.handle(f.signed('heartbeat',{...sample,sampledAt:f.now()-60001})),/STALE_HEARTBEAT_SAMPLE/)
  await assert.rejects(f.gateway.handle(f.signed('heartbeat',{...sample,sampledAt:f.now()+5001})),/STALE_HEARTBEAT_SAMPLE/)
  assert.equal(f.ledger.nodeStatuses().find(n=>n.nodeId==='worker').state,'unknown')
  assert.throws(()=>new RemoteGateway({role:'executor',nodeId:'worker',ledger:f.ledger,store:f.serverStore,verifier:new IdentityVerifier({audience:'planner',peers:[f.peer]})}),/PLANNER_ROLE_REQUIRED/)
  const denied=new RemoteGateway({role:'planner',nodeId:'planner',ledger:f.ledger,store:f.serverStore,verifier:new IdentityVerifier({audience:'planner',peers:[{...f.peer,operations:['nodeStatus']}]})});f.resources.push(denied)
  await assert.rejects(denied.handle(f.signed('heartbeat',sample)),/OPERATION_DENIED/)
  const unknown=new RemoteGateway({role:'planner',nodeId:'planner',ledger:f.ledger,store:f.serverStore,verifier:new IdentityVerifier({audience:'planner',peers:[{...f.peer,nodeId:'unregistered'}]})});f.resources.push(unknown)
  await assert.rejects(unknown.handle(f.signed('heartbeat',sample,{nodeId:'unregistered'})),/REGISTERED_NODE_REQUIRED/)
})

test('actual TaskLedger accepts informational provider observations without granting an unknown model vendor',async t=>{
  const f=fixture(t)
  await f.remote.recordNodeHeartbeat('unverified-provider',{nodeId:'worker',sampledAt:f.now(),runtimeReady:true,activeExecutions:0,providerStatus:{state:'ready',providers:[{provider:'unregistered-vendor',state:'ready'}]}})
  const task=f.ledger.createTask('task',{title:'Cannot expand grants',workspaceId:'workspace'}).value
  assert.throws(()=>f.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',provider:'unregistered-vendor',model:'arbitrary',workspaceId:'workspace',requiredCapabilities:['read']}}))
  assert.deepEqual(f.ledger.getNode('worker').models,f.node.models)
})

test('actual Cordis opt-in heartbeat reports native presence and actual execution count; timer drains on unload (network/native mocked)',async t=>{
  const f=fixture(t,{clock:false}), ctx=new Context();t.after(()=>ctx.fiber.dispose())
  const originalFetch=globalThis.fetch, env='DSH_HEARTBEAT_DISPOSABLE_KEY', previous=process.env[env]
  process.env[env]=key.privateKey.export({format:'pem',type:'pkcs8'})
  t.after(()=>{globalThis.fetch=originalFetch;if(previous===undefined)delete process.env[env];else process.env[env]=previous})
  let sends=0;globalThis.fetch=async(_url,options)=>{sends++;return new Response(JSON.stringify(await f.gateway.handle(options.body)))}
  t.mock.timers.enable({apis:['setInterval']})
  const local={ledger:{}};await ctx.plugin({apply(ctx){ctx.provide('taskSystem',local)}})
  const fiber=ctx.plugin(plugin,{role:'executor',nodeId:'worker',statePath:join(f.root,'native.sqlite'),capabilities:['read'],workspaces:[{workspaceId:'workspace',nodeId:'worker',path:f.root,allowedRoot:f.root}],coordinator:{endpoint:'https://fixture.invalid/commands',audience:'planner',keyId:'fixture',privateKeyEnv:env,heartbeatIntervalMs:1000,nativeRoutes:[{provider:'fixture',models:[{model:'fixture',reasoningEfforts:[]}]}]}});await fiber
  const service=ctx.get('remoteExecution')
  for(let i=0;i<100&&!f.ledger.nodeStatuses().find(n=>n.nodeId==='worker').observedAt;i++)await immediate()
  assert.equal(f.ledger.nodeStatuses().find(n=>n.nodeId==='worker').runtimeReady,false)
  let entered,release;const started=new Promise(resolve=>entered=resolve), gate=new Promise(resolve=>release=resolve)
  local.native={executeExternal:async()=>{entered();await gate;return {outcome:'success',summary:'fixture'}}}
  const task=f.ledger.createTask('task',{title:'Active heartbeat',workspaceId:'workspace',policy:{settlementQuietMs:0}}).value
  const run=f.ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',provider:'fixture',model:'fixture',workspaceId:'workspace',requiredCapabilities:['read']}}).value
  const running=service.nativeWorker.execute(run.runId,'claim');await started;await service.heartbeatNow()
  let own=f.ledger.nodeStatuses().find(n=>n.nodeId==='worker')
  assert.equal(own.runtimeReady,true);assert.equal(own.activeExecutions,1);assert.deepEqual(own.providerStatus,{...status,executionRoutes:[{nodeId:'worker',provider:'fixture',model:'fixture',requiredCapabilities:[]}]})
  release();assert.equal((await running).state,'acknowledged')
  delete local.native;t.mock.timers.tick(1000)
  for(let i=0;i<100&&f.ledger.nodeStatuses().find(n=>n.nodeId==='worker').runtimeReady;i++)await immediate()
  own=f.ledger.nodeStatuses().find(n=>n.nodeId==='worker');assert.equal(own.runtimeReady,false);assert.equal(own.activeExecutions,0)
  assert.equal(service.heartbeatSnapshot().state,'acknowledged');
  // A ConfigEditor reload holds the admission guard while unloading the old instance.
  service.beginConfigurationEdit();
  await fiber.dispose();assert.equal(f.ledger.nodeStatuses().find(n=>n.nodeId==='worker').state,'unavailable');const stopped=sends;t.mock.timers.tick(60000);await immediate();assert.equal(sends,stopped)
  assert.equal(plugin.Config({}).coordinator??null,null)
  assert.equal(plugin.Config({coordinator:{endpoint:'https://fixture.invalid',audience:'planner',keyId:'fixture',privateKeyEnv:env}}).coordinator.heartbeatIntervalMs,0)
})


test('offline notification follows the last in-flight heartbeat and stops future heartbeats',async t=>{
 const f=fixture(t,{clock:false}),ctx=new Context();
 const config=plugin.Config({role:'executor',nodeId:'worker',coordinator:{endpoint:'https://fixture.invalid',audience:'planner',nativeRoutes:[]}});
 const owned=new RecoveryStore(':memory:');
 const service=new plugin.RemoteExecutionService(ctx,config,{},owned);
 const samples=[];let release;
 service.coordinatorLedger={recordNodeHeartbeat:async(_id,input)=>{samples.push(input);if(input.runtimeReady)await new Promise(resolve=>release=resolve);return {value:{}};}};
 await ctx.plugin({apply(ctx){ctx.provide('taskSystem',{native:{executeExternal(){}}});}});
 service.heartbeatPending=service.heartbeatNow();
 const disposing=service.dispose();await immediate();assert.equal(samples.length,1);
 release();await disposing;
 assert.equal(samples.length,2);assert.equal(samples[0].runtimeReady,true);assert.equal(samples[1].runtimeReady,false);
 assert.ok(samples[1].sampledAt>samples[0].sampledAt);
 await assert.rejects(service.heartbeatNow(),{code:'DRAINING'});await ctx.fiber.dispose();
});
