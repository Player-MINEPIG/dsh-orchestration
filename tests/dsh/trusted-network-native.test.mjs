import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { ScriptedModel } from './scripted-model.mjs';
import { createNativeHarness } from './native-harness.mjs';
import * as remotePlugin from '../../packages/task-system/dist/remote/index.js';
import * as deepseekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';

async function unusedPort() {
  const server=http.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

for (const missing of ['credential','adapter']) {
  test(`two real DSH hosts carry missing ${missing} through the exact-address HTTP mode without keys and retain state across remount`, {timeout:20000}, async()=>{
    const authority=await createNativeHarness({config:{nodeId:'planner'}});
    const executor=await createNativeHarness({config:{role:'executor',nodeId:'worker'},script:[]});
    let serverFiber,clientFiber;
    let credentialsAvailable=true,revokeAdapter=()=>{};
    try {
      const ledger=authority.ledger;
      const route=missing==='credential'?{provider:'deepseek-official',model:'deepseek-flash'}:{provider:'absent-provider',model:'acceptance'};
      const expectedCode=missing==='credential'?'MISSING_CREDENTIAL':'NO_ADAPTER';
      if(missing==='credential'){
        executor.ctx.provide('credentials',{resolve:async()=>credentialsAvailable?{value:'sk-isolated-ci-catalog-fixture'}:undefined});
        executor.ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{DSH_TEST_EMPTY_KEY:''}}]));
        await executor.ctx.plugin(deepseekApiKey,{apiKeyEnv:'DSH_TEST_EMPTY_KEY',baseURL:'https://must-not-request.invalid/anthropic'});
      }
      if(missing==='adapter'){const adapter=new ScriptedModel([]);adapter.listModels=async provider=>[{provider,id:route.model,name:'Installed catalog fixture'}];revokeAdapter=executor.ctx.llm.registerAdapter([route.provider],adapter);}
      ledger.registerWorkspace('network-workspace',{workspaceId:'acceptance',nodeId:'worker',path:executor.dir,label:'Isolated exact-address fixture',state:'ready',createdAt:new Date().toISOString()});
      ledger.registerNode('network-node',{nodeId:'worker',roles:['executor'],capabilities:['acceptance'],workspaceIds:['acceptance'],models:[{...route,reasoningEfforts:[]}],enabled:true,maxConcurrent:1,lastSeenAt:new Date().toISOString()});
      const port=await unusedPort();
      const peerAddress=process.platform==='darwin'?'127.0.0.1':'127.0.0.2';
      const operations=['listWork','claim','markRunning','bindSession','renew','submit','getRun','getAttempt','acknowledgeCancellation','taskWait','receipt','heartbeat','nodeStatus','executorIdentity','executionModelRequests','completeExecutionModels'];
      const serverConfig=remotePlugin.Config({role:'planner',nodeId:'planner',authMode:'trusted-network',statePath:join(authority.dir,'network.sqlite'),exposeHttp:true,routePath:'/commands',audience:'planner',trustedNetwork:{listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1','127.0.0.2','127.0.0.3'],peers:[{address:peerAddress,nodeId:'worker',role:'executor',audience:'planner',operations,workspaces:['acceptance'],capabilities:['acceptance']}]}});
      const clientConfig=remotePlugin.Config({role:'executor',nodeId:'worker',authMode:'trusted-network',statePath:join(executor.dir,'network.sqlite'),exposeHttp:false,audience:'planner',capabilities:['acceptance'],workspaces:[{workspaceId:'acceptance',nodeId:'worker',path:executor.dir,allowedRoot:executor.dir}],pollIntervalMs:0,coordinator:{authMode:'trusted-network',endpoint:`http://127.0.0.1:${port}/commands`,audience:'planner',trustedNetwork:{address:'127.0.0.1',port,localAddress:peerAddress,allowHttp:true}}});
      serverConfig.executionLimits=serverConfig.executionLimits?.get?.() ?? serverConfig.executionLimits;clientConfig.executionLimits=clientConfig.executionLimits?.get?.() ?? clientConfig.executionLimits;
      serverFiber=await authority.ctx.plugin(remotePlugin,serverConfig);await serverFiber.await();
      clientFiber=await executor.ctx.plugin(remotePlugin,clientConfig);await clientFiber.await();
      await executor.ctx.remoteExecution.heartbeatNow();
      assert.equal(ledger.nodeStatuses()[0].state,'online');
      assert.equal(ledger.nodeStatuses()[0].runtimeReady,true);
      assert.equal(ledger.nodeStatuses()[0].providerStatus.state,'not-probed');
      const catalog=await ledger.refreshNodeModels('worker');
      assert.equal(catalog.catalog.state,'fresh');
      assert.ok(catalog.catalog.positiveSnapshot.models.some(model=>model.provider===route.provider&&model.model===route.model),'execution is admitted only after the real remote inventory publishes this tuple');
      const task=ledger.createTask('network-negative-task',{title:`Missing ${missing}`,workspaceId:'acceptance',policy:{allowedNodeIds:['worker'],allowedWorkspaceIds:['acceptance'],allowedTools:[],maxRuntimeMs:10000}}).value;
      const run=ledger.createRun('network-negative-run',{taskId:task.taskId,route:{nodeId:'worker',workspaceId:'acceptance',requiredCapabilities:['acceptance'],...route}}).value;
      credentialsAvailable=false;revokeAdapter();
      const [result]=await executor.ctx.remoteExecution.nativeWorker.pollOnce(1);
      assert.equal(result.status,'fulfilled');assert.equal(result.value.state,'acknowledged');
      assert.equal(ledger.getRun(run.runId).state,missing==='adapter'?'blocked':'uncertain');
      if(missing==='adapter') assert.equal(ledger.history(task.taskId).events.find(e=>e.type==='run.pre_dispatch_failed').detail.code,'NO_ADAPTER');
      assert.equal(ledger.getRun(run.runId).validation,undefined);
      const settled=ledger.history(task.taskId).events.filter(event=>event.type==='run.settled');
      assert.equal(settled.length,1);assert.match(settled[0].detail.summary,new RegExp(expectedCode));
      assert.equal(ledger.history(task.taskId).reports.length,0);
      assert.equal(executor.ledger.snapshot().tasks.length,0);
      assert.equal(executor.adapter.requests.length,0);
      assert.equal(executor.ctx.taskSystem.native.activeCount,0);
      assert.equal(ledger.nodeStatuses()[0].activeClaims,missing==='adapter'?0:1,'known no-dispatch block releases its lease; unknown effects remain reserved');
      await clientFiber.dispose();clientFiber=undefined;
      await serverFiber.dispose();serverFiber=undefined;
      serverFiber=await authority.ctx.plugin(remotePlugin,serverConfig);await serverFiber.await();
      clientFiber=await executor.ctx.plugin(remotePlugin,clientConfig);await clientFiber.await();
      const recovered=await executor.ctx.remoteExecution.nativeWorker.recoverResults();
      assert.equal(recovered.length,1);assert.equal(recovered[0].state,'acknowledged');
      assert.deepEqual(await executor.ctx.remoteExecution.nativeWorker.pollOnce(1),[]);
      assert.equal(ledger.history(task.taskId).events.filter(event=>event.type==='run.settled').length,1);
      assert.equal(executor.adapter.requests.length,0);
    } finally {await clientFiber?.dispose();await serverFiber?.dispose();await executor.dispose();await authority.dispose();}
  });
}

test('mounted remote plugin forwards exact native progress through two DSH hosts', {timeout:20000}, async()=>{
    const missing='progress';
    const authority=await createNativeHarness({config:{nodeId:'planner'}});
    const executor=await createNativeHarness({config:{role:'executor',nodeId:'worker',executionTimeoutMs:100},script:['hang']});
    let serverFiber,clientFiber;
    try {
      const ledger=authority.ledger;
      const route={provider:'test-offline',model:'script'};
      ledger.registerWorkspace('network-workspace',{workspaceId:'acceptance',nodeId:'worker',path:executor.dir,label:'Isolated exact-address fixture',state:'ready',createdAt:new Date().toISOString()});
      ledger.registerNode('network-node',{nodeId:'worker',roles:['executor'],capabilities:['acceptance'],workspaceIds:['acceptance'],models:[{...route,reasoningEfforts:[]}],enabled:true,maxConcurrent:1,lastSeenAt:new Date().toISOString()});
      const port=await unusedPort();
      const peerAddress=process.platform==='darwin'?'127.0.0.1':'127.0.0.2';
      const operations=['listWork','claim','markRunning','bindSession','renew','submit','getRun','getAttempt','acknowledgeCancellation','taskWait','receipt','heartbeat','nodeStatus','executorIdentity','executionModelRequests','completeExecutionModels'];
      const serverConfig=remotePlugin.Config({role:'planner',nodeId:'planner',authMode:'trusted-network',statePath:join(authority.dir,'network.sqlite'),exposeHttp:true,routePath:'/commands',audience:'planner',trustedNetwork:{listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1','127.0.0.2','127.0.0.3'],peers:[{address:peerAddress,nodeId:'worker',role:'executor',audience:'planner',operations,workspaces:['acceptance'],capabilities:['acceptance']}]}});
      const clientConfig=remotePlugin.Config({role:'executor',nodeId:'worker',leaseTtlMs:1000,authMode:'trusted-network',statePath:join(executor.dir,'network.sqlite'),exposeHttp:false,audience:'planner',capabilities:['acceptance'],workspaces:[{workspaceId:'acceptance',nodeId:'worker',path:executor.dir,allowedRoot:executor.dir}],pollIntervalMs:0,coordinator:{authMode:'trusted-network',endpoint:`http://127.0.0.1:${port}/commands`,audience:'planner',trustedNetwork:{address:'127.0.0.1',port,localAddress:peerAddress,allowHttp:true}}});
      serverConfig.executionLimits=serverConfig.executionLimits?.get?.() ?? serverConfig.executionLimits;clientConfig.executionLimits=clientConfig.executionLimits?.get?.() ?? clientConfig.executionLimits;
      serverFiber=await authority.ctx.plugin(remotePlugin,serverConfig);await serverFiber.await();
      clientFiber=await executor.ctx.plugin(remotePlugin,clientConfig);await clientFiber.await();
      await executor.ctx.remoteExecution.heartbeatNow();
      assert.equal(ledger.nodeStatuses()[0].state,'online');
      assert.equal(ledger.nodeStatuses()[0].runtimeReady,true);
      assert.equal(ledger.nodeStatuses()[0].providerStatus.state,'not-probed');
      const catalog=await ledger.refreshNodeModels('worker');
      assert.equal(catalog.catalog.state,'fresh');
      assert.ok(catalog.catalog.positiveSnapshot.models.some(model=>model.provider===route.provider&&model.model===route.model),'execution is admitted only after the real remote inventory publishes this tuple');
      const task=ledger.createTask('network-negative-task',{title:`Missing ${missing}`,workspaceId:'acceptance',policy:{allowedNodeIds:['worker'],allowedWorkspaceIds:['acceptance'],allowedTools:[],maxRuntimeMs:100}}).value;
      const run=ledger.createRun('network-negative-run',{taskId:task.taskId,route:{nodeId:'worker',workspaceId:'acceptance',requiredCapabilities:['acceptance'],...route}}).value;
      const until=async predicate=>{const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'progress timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
      const pending=executor.ctx.remoteExecution.nativeWorker.pollOnce(1);
      await until(()=>executor.adapter.requests.length===1);
      const a=ledger.requestExecutionStatus('mounted-progress',{runId:run.runId,expectedActionVersion:ledger.taskActionState(task.taskId).version}).value;
      await until(()=>ledger.getAttempt(a.attemptId).progressRequest?.reportedAt);
      assert.match(ledger.getAttempt(a.attemptId).progressRequest.summary,/正在生成下一步；已完成 0 步、0 次工具调用/);
      assert.equal(executor.adapter.requests.length,1);
      assert.equal(ledger.getRun(run.runId).state,'running');
      ledger.cancel('mounted-cancel',{taskId:task.taskId,reason:'Operator stop after status'});
      await executor.ctx.remoteExecution.nativeWorker.cancel(run.runId);
      assert.equal((await pending)[0].value.state,'cancelled');
      assert.equal(ledger.getRun(run.runId).state,'cancelled');
    } finally {await clientFiber?.dispose();await serverFiber?.dispose();await executor.dispose();await authority.dispose();}
  });
