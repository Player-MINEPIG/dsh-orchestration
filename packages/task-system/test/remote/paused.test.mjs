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
  const release=service.beginConfigurationEdit();release()
  assert.throws(()=>service.configureCoordinator({ledger}),{code:'REMOTE_PAUSED'})
  assert.throws(()=>service.createWorker({}),{code:'REMOTE_PAUSED'})
  assert.throws(()=>service.attachCarrier(Promise.resolve({close:async()=>{}})),{code:'REMOTE_PAUSED'})
  await assert.rejects(service.executorIdentity(),{code:'REMOTE_PAUSED'});await assert.rejects(service.heartbeatNow(),{code:'REMOTE_PAUSED'})
  await ctx.fiber.dispose();assert.equal(existsSync(statePath),false)
})
test('missing paused preserves the existing active configuration behavior',async t=>{
  assert.equal(remote.Config({}).paused,false)
  const dir=mkdtempSync(join(tmpdir(),'active-remote-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const ctx=new Context(),statePath=join(dir,'remote.sqlite');ctx.provide('taskSystem',{ledger:{}})
  await remote.apply(ctx,remote.Config({role:'executor',statePath}))
  assert.equal(ctx.get('remoteExecution').settingsSnapshot().paused,false);assert.equal(existsSync(statePath),true)
  await ctx.fiber.dispose()
})
