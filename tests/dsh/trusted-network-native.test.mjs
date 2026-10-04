import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { createNativeHarness } from './native-harness.mjs';
import * as remotePlugin from '../../packages/remote-execution/dist/index.js';
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
    try {
      const ledger=authority.ledger;
      const route=missing==='credential'?{provider:'deepseek-official',model:'deepseek-flash'}:{provider:'absent-provider',model:'acceptance'};
      const expectedCode=missing==='credential'?'MISSING_CREDENTIAL':'NO_ADAPTER';
      if(missing==='credential'){
        executor.ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{DSH_TEST_EMPTY_KEY:''}}]));
        await executor.ctx.plugin(deepseekApiKey,{apiKeyEnv:'DSH_TEST_EMPTY_KEY',baseURL:'https://must-not-request.invalid/anthropic'});
      }
      ledger.registerWorkspace('network-workspace',{workspaceId:'acceptance',nodeId:'worker',path:executor.dir,label:'Isolated exact-address fixture',state:'ready',createdAt:new Date().toISOString()});
      ledger.registerNode('network-node',{nodeId:'worker',roles:['executor'],capabilities:['acceptance'],workspaceIds:['acceptance'],models:[{...route,reasoningEfforts:[]}],enabled:true,maxConcurrent:1,lastSeenAt:new Date().toISOString()});
      const port=await unusedPort();
      const operations=['listWork','claim','markRunning','bindSession','renew','submit','getRun','getAttempt','acknowledgeCancellation','taskWait','receipt','heartbeat','nodeStatus'];
      const serverConfig=remotePlugin.Config({role:'planner',nodeId:'planner',authMode:'trusted-network',statePath:join(authority.dir,'network.sqlite'),exposeHttp:true,routePath:'/commands',audience:'planner',trustedNetwork:{listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1','127.0.0.2','127.0.0.3'],peers:[{address:'127.0.0.2',nodeId:'worker',role:'executor',audience:'planner',operations,workspaces:['acceptance'],capabilities:['acceptance']}]}});
      const clientConfig=remotePlugin.Config({role:'executor',nodeId:'worker',authMode:'trusted-network',statePath:join(executor.dir,'network.sqlite'),exposeHttp:false,audience:'planner',capabilities:['acceptance'],workspaces:[{workspaceId:'acceptance',nodeId:'worker',path:executor.dir,allowedRoot:executor.dir}],pollIntervalMs:0,coordinator:{authMode:'trusted-network',endpoint:`http://127.0.0.1:${port}/commands`,audience:'planner',trustedNetwork:{address:'127.0.0.1',port,localAddress:'127.0.0.2',allowHttp:true},nativeRoutes:[{provider:route.provider,models:[{model:route.model,reasoningEfforts:[]}]}]}});
      serverFiber=await authority.ctx.plugin(remotePlugin,serverConfig);await serverFiber.await();
      clientFiber=await executor.ctx.plugin(remotePlugin,clientConfig);await clientFiber.await();
      await executor.ctx.remoteExecution.heartbeatNow();
      assert.equal(ledger.nodeStatuses()[0].state,'online');
      assert.equal(ledger.nodeStatuses()[0].runtimeReady,true);
      assert.equal(ledger.nodeStatuses()[0].providerStatus.state,'not-probed');
      const task=ledger.createTask('network-negative-task',{title:`Missing ${missing}`,workspaceId:'acceptance',policy:{allowedNodeIds:['worker'],allowedWorkspaceIds:['acceptance'],allowedTools:[],maxRuntimeMs:10000}}).value;
      const run=ledger.createRun('network-negative-run',{taskId:task.taskId,route:{nodeId:'worker',workspaceId:'acceptance',requiredCapabilities:['acceptance'],...route}}).value;
      const [result]=await executor.ctx.remoteExecution.nativeWorker.pollOnce(1);
      assert.equal(result.status,'fulfilled');assert.equal(result.value.state,'acknowledged');
      assert.equal(ledger.getRun(run.runId).state,'uncertain');
      assert.equal(ledger.getRun(run.runId).validation,'not-submitted');
      const settled=ledger.history(task.taskId).events.filter(event=>event.type==='run.settled');
      assert.equal(settled.length,1);assert.match(settled[0].detail.summary,new RegExp(expectedCode));
      assert.equal(ledger.history(task.taskId).reports.length,0);
      assert.equal(executor.ledger.snapshot().tasks.length,0);
      assert.equal(executor.adapter.requests.length,0);
      assert.equal(executor.ctx.taskSystem.native.activeCount,0);
      assert.equal(ledger.nodeStatuses()[0].activeClaims,1,'unknown effects remain conservatively reserved');
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
