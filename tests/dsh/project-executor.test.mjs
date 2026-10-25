import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createNativeHarness} from './native-harness.mjs';
import {RemoteGateway,RemoteClient,RemoteLedgerClient,RecoveryStore,ExecutorWorker,IdentityVerifier,nativeExecutionAdapter} from '../../packages/task-system/dist/remote/api.js';

for(const managed of [false,true]) test(`two native DSH hosts dispatch project/shared temporary workspaces; managed=${managed}`,  {timeout:30000},async()=>{
 const planner=await createNativeHarness({config:{role:'planner',nodeId:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
 const worker=await createNativeHarness({executionRoot:true,presets:false,config:{role:'executor',nodeId:'worker',executionAgentPreset:'executor-files',executionTools:['read','write','edit']},script:[...Array.from({length:5},()=>({name:'task_submit_result',args:{outcome:'success',summary:'Verified',reportTitle:'Result',reportBody:'Verified project context'}})),{name:'write',args:{file_path:'test.md',content:'Isolated temporary workspace fixture'}},{name:'read',args:{file_path:'test.md'}},{name:'task_submit_result',args:{outcome:'success',summary:'File written and read back'}},{name:'read',args:{file_path:'test.md'}},{name:'task_submit_result',args:{outcome:'success',summary:'Other task has a separate directory'}}]});
 const stores=['server','client','worker'].map(n=>new RecoveryStore(join(worker.dir,n+'.sqlite')));let gateway,executor,client;
 try {
  await worker.ctx.loader.create({id:'fs',name:'@deepseek-ai/dsh-fs-local',config:{cwd:worker.dir}});
  await worker.ctx.loader.create({id:'working-directory',name:'@deepseek-ai/dsh-working-directory',config:{}});
  await worker.ctx.loader.create({id:'presets',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'executor-files'}});
  await worker.ctx.loader.create({id:'file-preset',name:'@deepseek-ai/dsh-agent-preset',config:{id:'executor-files',plugins:[{id:'file-tools',name:'@deepseek-ai/dsh-tool-fs',config:{}}]}});await worker.ctx.loader.await();
  const ledger=planner.ledger,runtime=planner.ctx.taskSystem.projects;runtime.saveSettings({root:join(planner.dir,'projects'),expectedRevision:0});
  const {projectId}=await runtime.create({commandId:'project',title:'Executor project',goal:'Test project isolation'});
  ledger.registerWorkspace('workspace',{workspaceId:'root',nodeId:'worker',path:worker.dir,label:'Authorized parent',state:'ready',createdAt:new Date().toISOString()});
  ledger.registerNode('node',{nodeId:'worker',roles:['executor'],capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:['root'],enabled:true,maxConcurrent:2});
  const route={nodeId:'worker',...(managed?{}:{workspaceId:'root'}),provider:'test-offline',model:'script',requiredCapabilities:[]};
  const task=ledger.createTask('task',{title:'Project task'}).value;runtime.linkTask(runtime.snapshot().projects[0].sessionId,task.taskId);
  const run=ledger.createRun('run',{taskId:task.taskId,route}).value;assert.equal(run.projectContext.project.projectId,projectId);
  const sibling=ledger.createTask('sibling',{title:'Same project second task'}).value;runtime.linkTask(runtime.snapshot().projects[0].sessionId,sibling.taskId);const siblingRun=ledger.createRun('sibling-run',{taskId:sibling.taskId,route}).value;
  const keys=generateKeyPairSync('ed25519'),peer={keyId:'fixture',nodeId:'worker',publicKey:keys.publicKey,audience:'planner',operations:['executorIdentity','claim','renew','submit','receipt','bindSession','markRunning','getRun','getAttempt','listWork','taskWait','sessionContext','selectTaskSession'],workspaces:managed?[]:['root'],capabilities:[]};
  gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger,store:stores[0],verifier:new IdentityVerifier({audience:'planner',peers:[peer]})});
  client=new RemoteClient({endpoint:'https://fixture.invalid/commands',nodeId:'worker',keyId:'fixture',audience:'planner',privateKey:keys.privateKey,store:stores[1],fetch:async(_url,options)=>{try{return new Response(JSON.stringify(await gateway.handle(options.body)))}catch(e){return new Response(JSON.stringify({error:e.code}),{status:e.status??400})}}});
  const remote=new RemoteLedgerClient(client,'worker');await client.executorIdentity();
  if(managed){
   const fixed=ledger.createTask('fixed',{title:'Explicit workspace',workspaceId:'root'}).value;const fixedRun=ledger.createRun('fixed-run',{taskId:fixed.taskId,route}).value;assert.equal(fixedRun.route.workspaceId,'root');await assert.rejects(client.send('claim','fixed-denied',{runId:fixedRun.runId,ttlMs:10000,projectContextVersion:1},{diagnostic:true}),/WORKSPACE_DENIED/);assert.ok(!(await remote.pendingRuns('worker')).some(run=>run.runId===fixedRun.runId));
   const constrained=ledger.createTask('constrained',{title:'Explicit policy',policy:{allowedWorkspaceIds:['root']}}).value;assert.throws(()=>ledger.createRun('policy-denied',{taskId:constrained.taskId,route}),/Task policy excludes workspace/);
  }

  await assert.rejects(client.send('claim','old-client',{runId:run.runId,ttlMs:10000},{diagnostic:true}),/PROJECT_CONTEXT_UPGRADE_REQUIRED/);assert.equal(ledger.snapshot().attempts.length,0);
  const attached=[];
  worker.ctx.provide('workspaceRegistry',{create:async(path,title)=>({attachSession:async(id)=>{const h=await worker.ctx.sessionPersistence.open(id,'read');try{assert.equal(h.header.cwd,path);attached.push({path,title,id})}finally{await h.close()}}})});
  const provider=nativeExecutionAdapter(worker.ctx.taskSystem.native,{provider:'test-offline',models:[{model:'script',reasoningEfforts:[]}],capabilities:[]});
  const executed=[],activePaths=new Map(),overlaps=[],execute=provider.execute.bind(provider);provider.execute=async(request)=>{const active=activePaths.get(request.workspacePath)??0;if(active)overlaps.push(request.workspacePath);activePaths.set(request.workspacePath,active+1);try{const result=await execute(request);const session=await worker.ctx.sessionPersistence.open(SessionId(request.sessionId),'read');try{assert.equal(session.header.cwd,request.workspacePath,'native session retains the exact executor-authorized cwd');executed.push({path:session.header.cwd,id:request.sessionId,taskId:request.claim.task.taskId});}finally{await session.close();}return result}finally{activePaths.set(request.workspacePath,activePaths.get(request.workspacePath)-1)}};
  executor=new ExecutorWorker({ledger:remote,provider,store:stores[2],...(managed?{projectRoot:()=>worker.dir}:{}),policy:{role:'executor',nodeId:'worker',capabilities:[],workspaces:managed?[]:[{workspaceId:'root',nodeId:'worker',path:worker.dir,allowedRoot:worker.dir}]}});
  const result=await executor.pollOnce(2);assert.equal(result.length,2,'same project shared cwd uses node capacity');assert.equal(ledger.getRun(siblingRun.runId).state,'succeeded');assert.ok(overlaps.length,'real native providers overlap in their shared cwd');assert.equal(result[0].value.state,'acknowledged',JSON.stringify(result));
  assert.equal(ledger.getRun(run.runId).state,'succeeded');const first=executed.find(item=>item.taskId===task.taskId);if(managed){assert.notEqual(first.path,worker.dir);assert.ok(first.path.startsWith(worker.dir+'/scheduler-'));}else assert.equal(first.path,worker.dir,'an explicitly authorized project repository retains its original cwd');
  assert.ok(!worker.adapter.requests[0].tools.some(t=>['task_history','task_query','task_report'].includes(t.name)),'model only sees operations granted by the coordinator');
  assert.ok(worker.adapter.requests[0].tools.some(t=>t.name==='write'),'native execution mounts the DSH tool preset before restricting tools');
  assert.match(JSON.stringify(worker.adapter.requests[0].messages),new RegExp(projectId));assert.match(JSON.stringify(worker.adapter.requests[0].messages),/Test project isolation/);
  assert.match(JSON.stringify(worker.adapter.requests[0].messages),/currentTimeUTC/);
  await executor.pollOnce(2);assert.equal(ledger.getRun(siblingRun.runId).state,'succeeded');const second=executed.find(item=>item.taskId===sibling.taskId);assert.equal(second.path,first.path);assert.notEqual(second.id,first.id);
  ledger.createRun('same-task',{taskId:task.taskId,route});await executor.pollOnce();assert.equal(executed[2].id,first.id);assert.equal(executed[2].path,first.path);
  const temporary=ledger.createTask('temporary',{title:'Temporary'}).value;await runtime.prepareTaskConversation(temporary.taskId);const tr=ledger.createRun('temp-run',{taskId:temporary.taskId,route}).value;if(managed)assert.equal(tr.projectContext.project,null);else{assert.equal(tr.projectContext,undefined);assert.equal(tr.workspaceConstraint,'root');}
  const otherTemporary=ledger.createTask('temporary-other',{title:'Another temporary'}).value;await runtime.prepareTaskConversation(otherTemporary.taskId);const otherTempRun=ledger.createRun('temp-run-other',{taskId:otherTemporary.taskId,route}).value;
  const tempResults=await executor.pollOnce(2);assert.equal(tempResults.length,2,'temporary tasks sharing a cwd use node capacity');assert.equal(ledger.getRun(otherTempRun.runId).state,'succeeded');assert.equal(tempResults[0].value.state,'acknowledged');assert.equal(executed[3].path,managed?join(worker.dir,'temporary-tasks'):worker.dir);assert.notEqual(executed[3].id,first.id);
  await executor.pollOnce(2);assert.equal(executed[4].path,executed[3].path);assert.notEqual(executed[4].id,executed[3].id);if(managed){assert.equal(attached[3].title,'temporary-tasks');assert.equal(attached[4].title,'temporary-tasks');}else assert.equal(attached.length,3,'explicit non-project tasks do not create sidebar workspaces');
  assert.match(JSON.stringify(worker.adapter.requests[3].messages),/creating a file without write/);
  const writer=ledger.createTask('temporary-writer',{title:'Write isolated file'}).value;await runtime.prepareTaskConversation(writer.taskId);ledger.createRun('writer-run',{taskId:writer.taskId,route});const writeResult=await executor.pollOnce();assert.equal(writeResult[0].value.state,'acknowledged');assert.equal(readFileSync(join(executed[5].path,'test.md'),'utf8'),'Isolated temporary workspace fixture');assert.equal(existsSync(join(worker.dir,'test.md')),!managed,'managed tasks keep files below the temporary directory; explicit grants use the selected repository');
  const reader=ledger.createTask('temporary-reader',{title:'Check isolated directory'}).value;await runtime.prepareTaskConversation(reader.taskId);ledger.createRun('reader-run',{taskId:reader.taskId,route});await executor.pollOnce();assert.equal(executed[6].path,executed[5].path);assert.equal(existsSync(join(executed[6].path,'test.md')),true,'ordinary temporary tasks intentionally share their selected directory');assert.notEqual(executed[6].id,executed[5].id);assert.ok(worker.adapter.requests[5].tools.some(t=>t.name==='write'));
  assert.equal(worker.ledger.snapshot().tasks.length,0);assert.equal(planner.ctx.taskSystem.native,undefined);assert.equal(ledger.snapshot().attempts.length,7);
 } finally {await executor?.dispose();await gateway?.dispose();await client?.dispose();stores.forEach(s=>s.close());await worker.dispose();await planner.dispose();}
});
