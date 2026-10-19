import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeHarness } from './native-harness.mjs';
import * as remote from '../../packages/task-system/dist/remote/index.js';
import { readStartupSettings, saveStartupSettings } from '../../packages/task-system/dist/startup-settings.js';

async function until(check) {
  const deadline=Date.now()+10000;
  while(!check()){assert.ok(Date.now()<deadline,'state transition timed out');await delay(20);}
}

test('executor switch: paused diagnostic, automatic heartbeat/task reception, immediate offline and safe restart across two actual DSH hosts', {timeout:30000},async()=>{
 const planner=await createNativeHarness({config:{role:'planner',nodeId:'planner'}});
 const worker=await createNativeHarness({config:{role:'executor',nodeId:'worker'},script:[{name:'task_submit_result',args:{outcome:'success',summary:'9 + 6 = 15',reportTitle:'Switch acceptance',reportBody:'15'}}]});
 let gatewayFiber,workerFiber;
 try {
  const portServer=http.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  const ledger=planner.ledger;
  ledger.registerWorkspace('switch-workspace',{workspaceId:'workspace',nodeId:'worker',path:worker.dir,label:'Isolated switch test',state:'ready',createdAt:new Date().toISOString()});
  ledger.registerNode('switch-worker',{nodeId:'worker',roles:['executor'],enabled:true,capabilities:[],workspaceIds:['workspace'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],lastSeenAt:new Date().toISOString(),maxConcurrent:1});
  const operations=['executorIdentity','heartbeat','listWork','claim','markRunning','bindSession','renew','submit','getRun','getAttempt','receipt','taskWait','acknowledgeCancellation'];
  gatewayFiber=await planner.ctx.plugin(remote,{role:'planner',nodeId:'planner',statePath:join(planner.dir,'remote.sqlite'),authMode:'trusted-network',audience:'planner',exposeHttp:true,routePath:'/commands',trustedNetwork:{listen:{address:'127.0.0.1',port},allowHttp:true,allowedAddresses:['127.0.0.1'],peers:[{address:'127.0.0.1',nodeId:'worker',role:'executor',audience:'planner',operations,workspaces:['workspace'],capabilities:[]}]}});
  await gatewayFiber.await();
  const entry={options:{id:'task-remote-execution',name:'@dsh-task/task-system/remote',config:remote.Config({paused:true,role:'executor',nodeId:'worker',statePath:join(worker.dir,'remote.sqlite'),authMode:'trusted-network',workspaces:[{workspaceId:'workspace',nodeId:'worker',path:worker.dir,allowedRoot:worker.dir}],coordinator:{endpoint:`http://127.0.0.1:${port}/commands`,audience:'planner',authMode:'trusted-network',trustedNetwork:{address:'127.0.0.1',port,localAddress:'127.0.0.1',allowHttp:true},nativeRoutes:[{provider:'test-offline',models:[{model:'script',reasoningEfforts:[]}]}]}})}};
  entry.options.config.executionLimits=entry.options.config.executionLimits.get();
  const editor={entries:()=>[entry],edit:async(row,change)=>{row.options.config=change(structuredClone(row.options.config),{});}};
  // Persistence callback is isolated; public startup validation and both hosts' runtimes are real.
  const ctx={get:key=>key==='configEditor'?editor:worker.ctx.get(key)};
  workerFiber=await worker.ctx.plugin(remote,entry.options.config);await workerFiber.await();
  const service=worker.ctx.remoteExecution;
  assert.equal(ledger.nodeStatuses()[0].state,'unknown');
  await service.checkConnection(entry.options.config.coordinator.endpoint,entry.options.config.coordinator.trustedNetwork);
  assert.equal(ledger.nodeStatuses()[0].state,'unknown','diagnostics do not send a heartbeat');
  const task=ledger.createTask('switch-task',{title:'Calculate 9 + 6',workspaceId:'workspace',policy:{allowedNodeIds:['worker'],allowedWorkspaceIds:['workspace'],allowedTools:[],maxRuntimeMs:10000}}).value;
  const run=ledger.createRun('switch-run',{taskId:task.taskId,route:{nodeId:'worker',workspaceId:'workspace',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
  await delay(100);assert.equal(ledger.snapshot().attempts.length,0);
  await saveStartupSettings(ctx,{target:'remote',expected:readStartupSettings(ctx).remote.values,changes:{paused:false}});
  assert.equal(entry.options.config.executionLimits.pollIntervalMs,1000);assert.equal(entry.options.config.coordinator.heartbeatIntervalMs,5000);
  await workerFiber.dispose();workerFiber=await worker.ctx.plugin(remote,entry.options.config);await workerFiber.await();
  await until(()=>ledger.getRun(run.runId).state==='succeeded');
  await until(()=>ledger.nodeStatuses()[0].state==='online');
  assert.equal(worker.adapter.requests.length,1);assert.equal(ledger.history(task.taskId).reports[0].body,'15');
  await until(()=>worker.ctx.remoteExecution.queueSnapshot().items.length===0);
  await saveStartupSettings(ctx,{target:'remote',expected:readStartupSettings(ctx).remote.values,changes:{paused:true}});
  await workerFiber.dispose();workerFiber=await worker.ctx.plugin(remote,entry.options.config);await workerFiber.await();
  assert.equal(ledger.nodeStatuses()[0].state,'unavailable');
  assert.equal(worker.ctx.remoteExecution.settingsSnapshot().polling,false);
  assert.equal(worker.ctx.remoteExecution.heartbeatSnapshot().state,'disabled');
  const attempts=ledger.snapshot().attempts.length;
  await saveStartupSettings(ctx,{target:'remote',expected:readStartupSettings(ctx).remote.values,changes:{paused:false}});
  await workerFiber.dispose();workerFiber=await worker.ctx.plugin(remote,entry.options.config);await workerFiber.await();
  await until(()=>ledger.nodeStatuses()[0].state==='online');await delay(1100);
  assert.equal(ledger.snapshot().attempts.length,attempts);assert.equal(worker.adapter.requests.length,1);
  assert.equal(planner.ctx.taskSystem.native,undefined);
 } finally {await workerFiber?.dispose();await gatewayFiber?.dispose();await worker.dispose();await planner.dispose();}
});
