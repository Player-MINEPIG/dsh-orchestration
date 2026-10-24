import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {TaskLedger} from '../dist/ledger.js';
import {RecoveryStore} from '../dist/remote/store.js';
import {RemoteGateway} from '../dist/remote/gateway.js';
import {RemoteClient,RemoteLedgerClient} from '../dist/remote/client.js';
import {TrustedNetworkVerifier} from '../dist/remote/trusted-network.js';
import {httpHandler} from '../dist/remote/http.js';
import {removeNetworkPairings} from '../dist/network-pairings.js';

test('real HTTP source pairing validates before bind, persists identity, accepts requested model catalogs, and revokes last peer',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'pairing-'));const ledger=TaskLedger.open(join(dir,'task.sqlite'),{nodeId:'planner',role:'planner'});const state=join(dir,'server.sqlite');let store=new RecoveryStore(state);let handler,gateway,client;
 const server=createServer((req,res)=>handler(req,res));await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;
 const policy={listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1'],peers:[{address:'127.0.0.1',nickname:'我的笔记本',nodeId:'',role:'executor',audience:'planner',operations:[],workspaces:[],capabilities:[]}]};
 const mount=peers=>{gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger,store,verifier:new TrustedNetworkVerifier({...policy,peers,pairings:store,audience:'planner'})});handler=httpHandler(gateway,{trustedNetwork:{...policy,peers}});};
 mount(policy.peers);
 client=new RemoteClient({endpoint:`http://127.0.0.1:${port}/commands`,nodeId:'new-device',audience:'planner',authMode:'trusted-network',trustedNetwork:{address:'127.0.0.1',port,localAddress:'127.0.0.1',allowHttp:true},store:new RecoveryStore(join(dir,'client.sqlite'))});
 try {
  const before=()=>({pairs:store.networkPairings(),nodes:ledger.nodeStatuses().map(row=>row.nodeId)});
  await assert.rejects(client.send('heartbeat','bad-payload',{sampledAt:Date.now(),runtimeReady:'wrong',activeExecutions:0},{diagnostic:true}),/INVALID_RUNTIME_READY/);assert.deepEqual(before(),{pairs:[],nodes:[]});
  await assert.rejects(client.send('heartbeat','stale-sample',{sampledAt:0,runtimeReady:true,activeExecutions:0},{diagnostic:true}),/STALE_HEARTBEAT_SAMPLE/);assert.deepEqual(before(),{pairs:[],nodes:[]});
  const sameNodeStore=new RecoveryStore(join(dir,'collision.sqlite'));const sameNode=new RemoteClient({endpoint:`http://127.0.0.1:${port}/commands`,nodeId:'planner',audience:'planner',authMode:'trusted-network',trustedNetwork:{address:'127.0.0.1',port,localAddress:'127.0.0.1',allowHttp:true},store:sameNodeStore});await assert.rejects(sameNode.executorIdentity({diagnostic:true}),/NODE_ID_COLLISION/);await sameNode.dispose();sameNodeStore.close();assert.deepEqual(before(),{pairs:[],nodes:[]});
  const identity=await client.executorIdentity();assert.equal(identity.nodeId,'new-device');assert.equal(ledger.getNode('new-device').models.length,0);
  ledger.setNodeCapabilities('operator-capabilities','new-device',['activity.reports.v1']);
  await client.send('heartbeat','foreign-catalog',{sampledAt:Date.now(),runtimeReady:true,activeExecutions:0,providerStatus:{state:'not-probed',providers:[],executionRoutes:[{nodeId:'someone-else',provider:'p',model:'m',requiredCapabilities:['untrusted.v1']}]}});
  assert.deepEqual(ledger.getNode('new-device').models,[],'legacy heartbeat metadata cannot grant or replace executor models');
  assert.deepEqual(ledger.getNode('new-device').capabilities,['activity.reports.v1'],'authenticated heartbeat cannot replace operator capabilities with self-reported grants');
  const request=ledger.executionModels.request('requested-catalog',{nodeId:'new-device'}).catalog.request;
  const result={state:'success',observedAt:Date.now(),complete:true,models:[{provider:'p',model:'m'}]};
  const remote=new RemoteLedgerClient(client,'new-device');
  await assert.rejects(remote.completeExecutionModels('foreign-request',{nodeId:'new-device',requestId:'11111111-1111-4111-8111-111111111111',generation:request.generation,result}),/REMOTE_OUTCOME_UNCERTAIN/);
  assert.deepEqual(ledger.getNode('new-device').models,[]);
  await remote.completeExecutionModels('requested-models',{nodeId:'new-device',requestId:request.requestId,generation:request.generation,result});

  await client.send('heartbeat','ready',{sampledAt:Date.now(),runtimeReady:true,activeExecutions:0,providerStatus:{state:'not-probed',providers:[{provider:'p',state:'not-probed'}],executionRoutes:[{nodeId:'new-device',provider:'p',model:'m',requiredCapabilities:[]}]}});
  assert.equal(ledger.nodeStatuses()[0].state,'online');assert.deepEqual(ledger.getNode('new-device').models,[{provider:'p',model:'m',reasoningEfforts:[]}]);
  const replay=await fetch(`http://127.0.0.1:${port}/commands`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:2,authMode:'trusted-network',nodeId:'new-device',audience:'planner',commandId:'replayed-model-change',nonce:'replayed-model-nonce',sequence:1,issuedAt:Date.now(),expiresAt:Date.now()+30000,operation:'heartbeat',payload:{sampledAt:Date.now(),runtimeReady:true,activeExecutions:0,providerStatus:{state:'ready',providers:[],executionRoutes:[{nodeId:'new-device',provider:'evil',model:'changed',requiredCapabilities:[]}]}}})});assert.equal(replay.status,409);assert.equal((await replay.json()).error,'OUT_OF_ORDER');assert.deepEqual(ledger.getNode('new-device').models,[{provider:'p',model:'m',reasoningEfforts:[]}]);assert.deepEqual(store.networkPairings(),[{address:'127.0.0.1',nodeId:'new-device'}]);
  assert.equal((await client.executorIdentity()).executorId,identity.executorId);
  await gateway.dispose();store.close();store=new RecoveryStore(state);mount(policy.peers);assert.equal((await client.executorIdentity()).executorId,identity.executorId);
  assert.deepEqual(ledger.getNode('new-device').capabilities,['activity.reports.v1']);
  ledger.setNodeCapabilities('operator-revoke-capabilities','new-device',[]);
  await client.send('heartbeat','after-capability-revocation',{sampledAt:Date.now(),runtimeReady:true,activeExecutions:0,providerStatus:{state:'not-probed',providers:[],executionRoutes:[{nodeId:'new-device',provider:'p',model:'m',requiredCapabilities:['activity.reports.v1']}]}});
  assert.deepEqual(ledger.getNode('new-device').capabilities,[],'normal heartbeat must preserve operator revocation');
  const intruderStore=new RecoveryStore(join(dir,'intruder.sqlite'));const intruder=new RemoteClient({endpoint:`http://127.0.0.1:${port}/commands`,nodeId:'renamed-device',audience:'planner',authMode:'trusted-network',trustedNetwork:{address:'127.0.0.1',port,localAddress:'127.0.0.1',allowHttp:true},store:intruderStore});
  await assert.rejects(intruder.executorIdentity({diagnostic:true}),/WRONG_NODE/);await intruder.dispose();intruderStore.close();
  await gateway.dispose();removeNetworkPairings(state,['127.0.0.1']);mount([]);assert.deepEqual(store.networkPairings(),[]);await assert.rejects(client.executorIdentity({diagnostic:true}),/NETWORK_PEER_REQUIRED/);
  assert.ok(ledger.getNode('new-device'),'removal must not delete historical node or task records');
 } finally {await client?.dispose();await gateway?.dispose();store.close();await new Promise(done=>server.close(done));ledger.close();rmSync(dir,{recursive:true,force:true});}
});
