import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Context} from '@deepseek-ai/cordis'
import * as remote from '../../dist/remote/index.js'

test('paused remote loads a configuration service before any store, key, listener, polling or heartbeat initialization',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'paused-remote-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const ctx=new Context(),statePath=join(dir,'never-created','remote.sqlite')
  const ledger=new Proxy({}, {get(){throw Error('paused remote must not inspect or claim the ledger')}})
  ctx.provide('taskSystem',{ledger})
  const config=remote.Config({paused:true,role:'both',statePath,authMode:'ed25519',exposeHttp:true,pollIntervalMs:100,coordinator:{endpoint:'https://no-network.invalid/commands',audience:'fixture',authMode:'ed25519',privateKeyEnv:'DSH_PAUSED_FIXTURE_MUST_NOT_BE_READ',heartbeatIntervalMs:1000,nativeRoutes:[{provider:'fixture',models:[{model:'fixture'}]}]}})
  await remote.apply(ctx,config)
  const service=ctx.get('remoteExecution');assert.ok(service)
  assert.equal(service.settingsSnapshot().paused,true);assert.equal(service.settingsSnapshot().polling,false)
  assert.equal(service.gateway,undefined);assert.equal(service.nativeWorker,undefined);assert.equal(service.coordinatorLedger,undefined);assert.equal(existsSync(statePath),false)
  assert.deepEqual(service.queueSnapshot().items,[])
  const release=await service.beginConfigurationEdit();release()
  await assert.rejects(service.configureCoordinator({ledger}),{code:'REMOTE_PAUSED'})
  assert.throws(()=>service.createWorker({}),{code:'REMOTE_PAUSED'})
  assert.throws(()=>service.attachCarrier(Promise.resolve({close:async()=>{}})),{code:'REMOTE_PAUSED'})
  await assert.rejects(service.executorIdentity(),{code:'REMOTE_PAUSED'});await assert.rejects(service.heartbeatNow(),{code:'REMOTE_PAUSED'})
  await ctx.fiber.dispose();assert.equal(existsSync(statePath),false)
})
test('missing upstream keeps an executor inactive without initializing unused runtime resources',async t=>{
  assert.equal(remote.Config({}).paused,false)
  const dir=mkdtempSync(join(tmpdir(),'active-remote-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const ctx=new Context(),statePath=join(dir,'remote.sqlite');ctx.provide('taskSystem',{ledger:{}})
  await remote.apply(ctx,remote.Config({role:'executor',statePath}))
  assert.equal(ctx.get('remoteExecution').settingsSnapshot().paused,true);assert.equal(existsSync(statePath),false)
  await ctx.fiber.dispose()
})

test('executor pause preserves an explicitly independent listener and pure planners ignore unused coordinator fields',async t=>{
  const {createServer}=await import('node:net');const {TaskLedger}=await import('../../dist/ledger.js');const {RemoteClient,RecoveryStore}=await import('../../dist/remote/api.js');
  for(const role of ['both','planner']){
    const dir=mkdtempSync(join(tmpdir(),'independent-listener-'));const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
    const ledger=TaskLedger.open(join(dir,'tasks.sqlite'),{nodeId:'scheduler',role});const ctx=new Context();ctx.provide('taskSystem',{ledger,config:{role}});
    const policy={listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1'],peers:[{address:'127.0.0.1',nodeId:'',nickname:'worker',role:'executor',audience:'planner',operations:[],workspaces:[],capabilities:[]}]};
    const config=remote.Config({role,nodeId:'scheduler',statePath:join(dir,'remote.sqlite'),paused:true,pauseScope:'executor',exposeHttp:true,routePath:'/commands',authMode:'trusted-network',audience:'planner',trustedNetwork:policy,coordinator:{endpoint:'not-a-valid-endpoint',audience:'unused',privateKeyEnv:'MUST_NOT_READ',heartbeatIntervalMs:1000},pollIntervalMs:100});
    let client,clientStore;
    try{
      await remote.apply(ctx,config);const service=ctx.get('remoteExecution');assert.ok(service.gateway);assert.equal(service.nativeWorker,undefined);assert.equal(service.coordinatorLedger,undefined);assert.equal(service.heartbeatSnapshot().state,'disabled');
      clientStore=new RecoveryStore(join(dir,'client.sqlite'));client=new RemoteClient({endpoint:`http://127.0.0.1:${port}/commands`,nodeId:'worker',audience:'planner',authMode:'trusted-network',trustedNetwork:{address:'127.0.0.1',port,localAddress:'127.0.0.1',allowHttp:true},store:clientStore});
      const receipt=await client.send('executorIdentity','fixture-identity',{});assert.equal(receipt.state,'done',JSON.stringify(receipt));assert.equal(receipt.result.nodeId,'worker');await assert.rejects(service.executorIdentity(),{code:'REMOTE_PAUSED'});
    }finally{await client?.dispose();clientStore?.close();await ctx.fiber.dispose();ledger.close();rmSync(dir,{recursive:true,force:true});}
  }
});

test('both role may connect and heartbeat with its own listener completely unconfigured',async t=>{
  const {createServer}=await import('node:http');const {TaskLedger}=await import('../../dist/ledger.js');const {RemoteGateway,RecoveryStore,TrustedNetworkVerifier,httpHandler}=await import('../../dist/remote/api.js');
  const dir=mkdtempSync(join(tmpdir(),'independent-executor-'));const planner=TaskLedger.open(join(dir,'planner.sqlite'),{nodeId:'planner',role:'planner'}),store=new RecoveryStore(join(dir,'server.sqlite'));
  const policy={listen:{address:'127.0.0.1',port:1},allowHttp:true,allowedAddresses:['127.0.0.1'],peers:[{address:'127.0.0.1',nodeId:'',nickname:'worker',role:'executor',audience:'planner',operations:[],workspaces:[],capabilities:[]}]};
  let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(done=>server.listen(0,'127.0.0.1',done));policy.listen.port=server.address().port;
  const gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger:planner,store,verifier:new TrustedNetworkVerifier({...policy,audience:'planner',pairings:store})});handler=httpHandler(gateway,{trustedNetwork:policy});
  const ledger=TaskLedger.open(join(dir,'worker.sqlite'),{nodeId:'worker',role:'both'}),ctx=new Context();ctx.provide('taskSystem',{ledger,config:{role:'both'}});
  try{
    await remote.apply(ctx,remote.Config({role:'both',nodeId:'worker',statePath:join(dir,'client.sqlite'),paused:false,pauseScope:'executor',exposeHttp:false,authMode:'trusted-network',trustedNetwork:null,coordinator:{endpoint:`http://127.0.0.1:${policy.listen.port}/commands`,audience:'planner',authMode:'trusted-network',trustedNetwork:{address:'127.0.0.1',port:policy.listen.port,localAddress:'127.0.0.1',allowHttp:true},heartbeatIntervalMs:1000,nativeRoutes:[]}}));
    const service=ctx.get('remoteExecution');assert.equal(service.gateway,undefined);assert.ok(service.nativeWorker);for(let i=0;i<100 && service.heartbeatSnapshot().state!=='acknowledged';i++)await new Promise(done=>setTimeout(done,10));assert.equal(service.heartbeatSnapshot().state,'acknowledged');assert.equal(planner.nodeStatuses()[0].nodeId,'worker');
  }finally{await ctx.fiber.dispose();await gateway.dispose();await new Promise(done=>server.close(done));store.close();ledger.close();planner.close();rmSync(dir,{recursive:true,force:true});}
});
