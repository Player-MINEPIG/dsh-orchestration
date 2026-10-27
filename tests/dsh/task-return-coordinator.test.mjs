import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage,ToolCallId,LlmError} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
import {TaskReturnDelivery} from '../../packages/task-system/dist/task-returns.js';
let seq=0;
const call=async(h,agent,name,args)=>{
 const result=await h.ctx.tools.execute({name,arguments:args,callId:ToolCallId('coordinator-'+ ++seq),agent,signal:new AbortController().signal});
 assert.equal(result.isError,false,JSON.stringify(result.error));return result.value;
};
const read=async(h,id)=>{const handle=await h.ctx.sessionPersistence.open(SessionId(id),'read');try{return (await handle.read()).events;}finally{await handle.close();}};
const catalog=(l,nodeId)=>{const req=l.executionModels.request('catalog-'+ ++seq,{nodeId}).catalog.request;l.completeExecutionModels('catalog-result-'+ ++seq,{nodeId,requestId:req.requestId,generation:req.generation,result:{state:'success',complete:true,observedAt:Date.now(),models:[{provider:'test-offline',model:'script'}]}});};

test('public tools bind a planner official workspace without a self Node, dispatch an MBP child, cold-return and formally complete its parent Task',async()=>{
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}}});
 try {
  const runtime=h.ctx.taskSystem.projects,root=join(h.dir,'projects'),existing=join(h.dir,'aws-repo');mkdirSync(existing,{recursive:true});runtime.saveSettings({root,expectedRevision:0});
  const {attachWorkspaceRegistry}=await import('../settings/local-workspace-harness.mjs');const registry=await attachWorkspaceRegistry(h),official=await registry.create(existing,'AWS local repository');
  const project=await runtime.create({commandId:'smoke-project',title:'Smoke project',goal:'One parent with one MBP child',workspace:{kind:'registered',nodeId:'local',workspaceId:'registry:'+official.id}});
  assert.throws(()=>h.ledger.getNode('local'),error=>error.code==='NOT_FOUND');
  h.ledger.registerNode('mbp-node',{nodeId:'mbp',roles:['executor'],enabled:true,models:[{provider:'test-offline',model:'script'}],capabilities:[],workspaceIds:[],maxConcurrent:2});catalog(h.ledger,'mbp');
  const parent=await h.ctx.agents.create({sessionId:SessionId('aws-original-coordinator'),meta:{cwd:existing},agentOptions:{provider:'test-offline',model:'script'}});
  let taskId;
  h.adapter.script.push({name:'project_list',args:{}},{name:'project_bind_session',args:{projectId:project.projectId}},{name:'task_create',args:{commandId:'parent-draft',title:'Organize issue list',policy:{settlementQuietMs:0}}},()=>{taskId=h.ledger.snapshot().tasks.find(task=>task.title==='Organize issue list').taskId;return {name:'task_bind_dispatcher',args:{commandId:'bind-parent',taskId}};},{name:'task_dispatch',args:{commandId:'mbp-child',title:'Read-only issue analysis',description:'Return evidence for the parent.',nodeId:'mbp',executionModel:{provider:'test-offline',model:'script'}}},'Waiting for the MBP result.');
  parent.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Select this project, create my parent organizing task, register this session as coordinator and dispatch an MBP child.'}]}));await parent.agent.whenIdle();await h.ctx.sessions.flush(parent.agent.session);
  const binding=h.ledger.dispatcherForSession('local',String(parent.agent.id));assert.ok(binding,'the agent binds through the public tool');
  const child=h.ledger.snapshot().tasks.find(task=>task.parentTaskId===taskId);assert.ok(child,'formal dispatch automatically keeps parent Task linkage');
  const run=h.ledger.history(child.taskId).runs[0];assert.equal(run.parentRunId,binding.runId);assert.equal(run.route.nodeId,'mbp');assert.equal(run.workspaceConstraint,undefined,'AWS existing cwd is never sent as an MBP workspace constraint');assert.equal(run.projectContext.project.projectId,project.projectId);assert.equal(run.dispatchOrigin.sessionId,'aws-original-coordinator');
  const claim=h.ledger.claim('mbp-claim',{runId:run.runId,nodeId:'mbp',ttlMs:10000}).value;
  h.ledger.submit('mbp-finish',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'mbp',fence:claim.attempt.fence,outcome:'success',summary:'MBP verified the issue list',report:{title:'MBP analysis',body:'Read-only analysis verified from the issue list.'}});
  const message=h.ledger.pendingSessionMessages('local')[0];assert.ok(message.completion);await parent.dispose();
  h.adapter.script.push({name:'task_history',args:{taskId:child.taskId}},{name:'task_submit_result',args:{outcome:'success',summary:'Parent organized the issue list',reportTitle:'Organized issues',reportBody:'Child report reviewed; the parent grouping is complete.'}});
  await h.ctx.taskSystem.taskReturns.deliver(message);
  const complete=h.ledger.getRun(binding.runId);assert.equal(complete.state,'succeeded');assert.equal(h.ledger.getTask(taskId).state,'completed');assert.equal(h.ledger.history(taskId).reports.at(-1).body,'Child report reviewed; the parent grouping is complete.');
  const events=await read(h,'aws-original-coordinator');assert.equal(events.filter(event=>event.type==='user/message' && event.data.source.kind==='dsh-task-result').length,1);
  await h.ctx.taskSystem.taskReturns.deliver(message);assert.equal((await read(h,'aws-original-coordinator')).filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result').length,1,'exact replay does not inject another result');
 }finally{await h.dispose();}
});

test('a persisted inbox return after a crash is resumed and consumed once without duplicating its result payload',async()=>{
 const h=await createNativeHarness({script:['Recovered pending result']});
 try {
  const id=SessionId('persisted-return-origin'),parent=await h.ctx.agents.create({sessionId:id,meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  const origin={kind:'session',nodeId:'local',sessionId:String(id),cwd:h.dir,composition:{provider:'test-offline',model:'script',tools:h.ctx.tools.schemas(parent.agent).map(tool=>tool.name)}};
  const message={messageId:'persisted-event',taskId:'child',nodeId:'local',sessionId:String(id),workspaceId:'origin-session',completion:{eventId:'persisted-event',origin,runId:'child-run'},text:'One persisted result payload',state:'queued'};
  parent.agent.inbox.append('next-turn',createUserMessage({source:{kind:'dsh-task-result',eventId:'persisted-event',taskId:'child'},content:[{type:'text',text:message.text}]}));await h.ctx.sessions.flush(parent.agent.session);await parent.dispose();
  await h.ctx.taskSystem.taskReturns.deliver(message);
  const events=await read(h,String(id));assert.equal(events.filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result').length,1);assert.ok(events.some(event=>event.type==='turn/end'&&event.data.reason.kind==='completed'));assert.equal(h.adapter.requests.length,1);
 }finally{await h.dispose();}
});

test('busy origin persists steering and acknowledgement waits for its completed turn',async()=>{
 let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
 const h=await createNativeHarness({script:[async()=>{started();await gate;return 'Original turn finished';},'Result turn finished']});
 try {
  const id=SessionId('busy-return-origin'),parent=await h.ctx.agents.create({sessionId:id,meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  parent.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Long current turn'}]}));await ready;
  const origin={kind:'session',nodeId:'local',sessionId:String(id),cwd:h.dir,composition:{provider:'test-offline',model:'script',tools:h.ctx.tools.schemas(parent.agent).map(tool=>tool.name)}};
  const message={messageId:'busy-event',taskId:'child',nodeId:'local',sessionId:String(id),workspaceId:'origin-session',completion:{eventId:'busy-event',origin,runId:'child-run'},text:'Busy result payload',state:'queued'};
  let acknowledged=false;const delivered=h.ctx.taskSystem.taskReturns.deliver(message).then(()=>acknowledged=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(acknowledged,false);release();await delivered;
  const events=await read(h,String(id));const source=events.find(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result');assert.ok(source);assert.equal(events.filter(event=>event.type==='turn/end'&&event.data.reason.kind==='completed').length,2);
 }finally{release?.();await h.dispose();}
});

test('cold return rejects unknown or malformed retired adapters without running the model',async()=>{
 const h=await createNativeHarness();
 try{
  const id=SessionId('invalid-adapter-origin'),parent=await h.ctx.agents.create({sessionId:id,meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  const origin={kind:'session',nodeId:'local',sessionId:String(id),cwd:h.dir,composition:{provider:'test-offline',model:'script',tools:[]}};await h.ctx.sessions.flush(parent.agent.session);await parent.dispose();
  for(const continuation of [{id:'unknown-adapter',data:{}},{id:'dmc-analysis-v1',data:{version:1,sessionId:String(id)}}]){
   await assert.rejects(h.ctx.taskSystem.taskReturns.deliver({messageId:'invalid-event',taskId:'child',nodeId:'local',sessionId:String(id),completion:{eventId:'invalid-event',origin:{...origin,continuation}},text:'Synthetic report'}),/adapter unavailable/);
   assert.equal(h.ctx.agents.get(id),undefined);assert.equal(h.adapter.requests.length,0);
  }
 }finally{await h.dispose();}
});

test('missing tools after creation retain the report and dispose the resumed handle',async()=>{
 const h=await createNativeHarness();
 try{
  const id=SessionId('missing-tool-origin'),parent=await h.ctx.agents.create({sessionId:id,meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  const origin={kind:'session',nodeId:'local',sessionId:String(id),cwd:h.dir,composition:{provider:'test-offline',model:'script',tools:['removed-plugin-tool']}};await h.ctx.sessions.flush(parent.agent.session);await parent.dispose();
  await assert.rejects(h.ctx.taskSystem.taskReturns.deliver({messageId:'missing-event',taskId:'child',nodeId:'local',sessionId:String(id),completion:{eventId:'missing-event',origin},text:'Synthetic report'}),/tools unavailable/);
  assert.equal(h.ctx.agents.get(id),undefined);assert.equal(h.adapter.requests.length,0);
  assert.equal((await read(h,String(id))).filter(event=>event.type==='user/message').length,0);
 }finally{await h.dispose();}
});

test('cold persisted inbox cannot escape the original mask or revive its expired parent lease',async()=>{
 const h=await createNativeHarness({script:[{name:'task_create',args:{commandId:'forbidden',title:'Must not exist'}},{name:'task_query',args:{}},'Controlled report consumed']});
 try{
  const id=SessionId('guarded-pending-origin'),parent=await h.ctx.agents.create({sessionId:id,meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  const origin={kind:'session',nodeId:'local',sessionId:String(id),cwd:h.dir,composition:{provider:'test-offline',model:'script',tools:['task_query']},parentLease:{runId:'expired-run',attemptId:'expired-attempt',nodeId:'local',fence:1}};
  const message={messageId:'guarded-event',taskId:'child',nodeId:'local',sessionId:String(id),completion:{eventId:'guarded-event',origin},text:'Synthetic report queued before a restart'};
  parent.agent.inbox.append('next-turn',createUserMessage({source:{kind:'dsh-task-result',eventId:message.messageId,taskId:'child'},content:[{type:'text',text:message.text}]}));await h.ctx.sessions.flush(parent.agent.session);await parent.dispose();
  await h.ctx.taskSystem.taskReturns.deliver(message);
  const events=await read(h,String(id)),results=events.filter(event=>event.type==='tool/result');
  assert.match(JSON.stringify(results),/outside the original session capability mask/);assert.match(JSON.stringify(results),/original task lease expired/);assert.equal(h.ledger.snapshot().tasks.length,0);
  assert.equal(events.filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result').length,1);
 }finally{await h.dispose();}
});


test('two returns durably enter a busy origin before either is processed and complete at its next step', {timeout:10000}, async()=>{
 let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
 const h=await createNativeHarness({script:[async()=>{started();await gate;return {name:'task_query',args:{}};},'Both reports processed']});
 try {
  const id=SessionId('parallel-return-origin'),parent=await h.ctx.agents.create({sessionId:id,meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  parent.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Working turn'}]}));await ready;
  const origin={kind:'session',nodeId:'local',sessionId:String(id),cwd:h.dir,composition:{provider:'test-offline',model:'script',tools:[]}};
  const message=n=>({messageId:'parallel-'+n,taskId:'child-'+n,nodeId:'local',sessionId:String(id),completion:{eventId:'parallel-'+n,origin},text:'Result '+n});
  const jobs=[1,2].map(n=>h.ctx.taskSystem.taskReturns.deliver(message(n)));
  try {
   for(let i=0;i<100 && parent.agent.inbox.nextStep.length+parent.agent.inbox.nextTurn.length<2;i++)await new Promise(resolve=>setTimeout(resolve,5));
   await h.ctx.sessions.flush(parent.agent.session);
   const pending=parent.agent.inbox.nextStep;
   assert.equal(pending.filter(input=>input.source.kind==='dsh-task-result').length,2,'both reports must enter next-step inbox while the current request is blocked');
   const durable=await read(h,String(id));
   for(const n of [1,2])assert.ok(durable.some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(input=>input.source.kind==='dsh-task-result'&&input.source.eventId==='parallel-'+n)));
  }finally{release();await Promise.all(jobs);}
  const events=await read(h,String(id));
  assert.equal(events.filter(event=>event.type==='turn/start').length,1,'results join the current turn instead of scheduling redundant followup turns');
  assert.equal(events.filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result').length,2);
  const requests=h.adapter.requests.length;
  await Promise.all([1,2].map(n=>h.ctx.taskSystem.taskReturns.deliver(message(n))));
  assert.equal(h.adapter.requests.length,requests,'processed reports must not wake another turn');
 }finally{release?.();await h.dispose();}
});


test('a return completes independently of unrelated followup work and replay does not wake it again', {timeout:10000}, async()=>{
 let releaseResult,releaseOther,resultStarted,otherStarted;
 const resultGate=new Promise(resolve=>releaseResult=resolve),otherGate=new Promise(resolve=>releaseOther=resolve),resultReady=new Promise(resolve=>resultStarted=resolve),otherReady=new Promise(resolve=>otherStarted=resolve);
 const h=await createNativeHarness({script:[async()=>{resultStarted();await resultGate;return 'Result processed';},async()=>{otherStarted();await otherGate;return 'Unrelated turn completed';}]});
 let timer;
 try {
  const id=SessionId('return-before-idle'),parent=await h.ctx.agents.create({sessionId:id,agentOptions:{provider:'test-offline',model:'script'}});
  const origin={kind:'session',nodeId:'local',sessionId:String(id),composition:{provider:'test-offline',model:'script',tools:[]}};
  const message={messageId:'own-turn-event',taskId:'child',nodeId:'local',sessionId:String(id),completion:{eventId:'own-turn-event',origin},text:'Result payload'};
  const delivery=h.ctx.taskSystem.taskReturns.deliver(message);
  try {
   await resultReady;
   parent.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Unrelated work'}]}));
   releaseResult();await otherReady;
   await Promise.race([delivery,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('result completion blocked by unrelated work')),2000);})]);
   assert.equal(parent.agent.status,'running','delivery must not await unrelated whole-agent idle');
   await h.ctx.taskSystem.taskReturns.deliver(message);
   assert.equal((await read(h,String(id))).filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result').length,1);
  }finally{clearTimeout(timer);releaseResult();releaseOther();await delivery;await parent.agent.whenIdle();}
 }finally{releaseResult();releaseOther();await h.dispose();}
});

test('interrupted consumed result recovers the same event without repeating its payload or any task execution', {timeout:10000}, async()=>{
 const h=await createNativeHarness({script:['hang','Recovered summary']});
 try {
  const id=SessionId('interrupted-return'),parent=await h.ctx.agents.create({sessionId:id,agentOptions:{provider:'test-offline',model:'script'}});
  const origin={kind:'session',nodeId:'local',sessionId:String(id),composition:{provider:'test-offline',model:'script',tools:[]}};
  const message={messageId:'interrupted-event',taskId:'child',nodeId:'local',sessionId:String(id),completion:{eventId:'interrupted-event',origin},text:'Unique original report payload'};
  const delivery=h.ctx.taskSystem.taskReturns.deliver(message);void delivery.catch(()=>{});
  for(let i=0;i<100&&!h.adapter.requests.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(h.adapter.requests.length,1);
  parent.agent.cancel({kind:'user'});await assert.rejects(delivery,/interrupted/);await parent.dispose();
  await h.ctx.taskSystem.taskReturns.deliver(message);
  const events=await read(h,String(id)),returned=events.filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result');
  assert.equal(returned.filter(event=>JSON.stringify(event.data.content).includes(message.text)).length,1);
  assert.equal(returned.length,2,'one recovery instruction refers to the already persisted event');
  assert.equal(h.ledger.snapshot().runs.length,0,'delivery never restarts a Task');
  const count=h.adapter.requests.length;await h.ctx.taskSystem.taskReturns.deliver(message);assert.equal(h.adapter.requests.length,count);
 }finally{await h.dispose();}
});


test('concurrent cold returns share a resumed handle until both result events complete', {timeout:10000}, async()=>{
 let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);
 const h=await createNativeHarness({script:[async()=>{started();await gate;return {name:'task_query',args:{}};},'Cold results processed']});
 let jobs=[];
 try{
  const id=SessionId('cold-parallel-origin'),parent=await h.ctx.agents.create({sessionId:id,agentOptions:{provider:'test-offline',model:'script'}});
  const origin={kind:'session',nodeId:'local',sessionId:String(id),composition:{provider:'test-offline',model:'script',tools:['task_query']}};
  await h.ctx.sessions.flush(parent.agent.session);await parent.dispose();
  const message=n=>({messageId:'cold-'+n,taskId:'child-'+n,nodeId:'local',sessionId:String(id),completion:{eventId:'cold-'+n,origin},text:'Cold report '+n});
  jobs=[1,2].map(n=>h.ctx.taskSystem.taskReturns.deliver(message(n)));
  await ready;
  for(let i=0;i<100&&!h.ctx.agents.get(id)?.inbox.nextStep.some(input=>input.source.kind==='dsh-task-result'&&input.source.eventId==='cold-2');i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(h.ctx.agents.get(id).inbox.nextStep.some(input=>input.source.kind==='dsh-task-result'&&input.source.eventId==='cold-2'));
  release();await Promise.all(jobs);
  const events=await read(h,String(id));for(const n of [1,2])assert.equal(events.filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result'&&event.data.source.eventId==='cold-'+n).length,1);
 }finally{release();await Promise.allSettled(jobs);await h.dispose();}
});

test('dispatcher root wait excludes only its bound coordinator while children and other session Runs remain visible',async()=>{
 const h=await createNativeHarness();
 try{
  await h.ctx.plugin(await import('../../packages/task-system/dist/project-registration/plugin.js'),{namespaces:['fixture/local']});
  const l=h.ledger;
  l.registerNode('wait-node',{nodeId:'local',roles:['both'],enabled:true,capabilities:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],workspaceIds:[],maxConcurrent:3});
  h.ctx.taskSystem.executionDirectories.save({root:h.dir,expectedRevision:0});
  catalog(l,'local');
  const session=async id=>(await h.ctx.agents.create({sessionId:SessionId(id),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}})).agent;
  const agent=await session('dispatcher-wait-owner');
  const project=await call(h,agent,'project_start',{title:'Coordinator wait fixture'});
  const parent=(await call(h,agent,'task_create',{commandId:'wait-parent',title:'Coordinate child work',policy:{settlementQuietMs:0}})).value;
  await call(h,agent,'task_bind_dispatcher',{commandId:'wait-bind',taskId:parent.taskId});
  const binding=l.dispatcherForSession('local',String(agent.id));assert.ok(binding);
  assert.equal(h.ctx.taskSystem.native.scopeFor(agent),undefined,'dispatcher is an ordinary session rather than a native owner');
  const wait=(caller,taskId)=>call(h,caller,'task_wait',{taskId,quietMs:0,timeoutMs:0});
  assert.equal((await wait(agent,parent.taskId)).settled,true,'an empty dispatcher root does not wait for its own final result');
  await call(h,agent,'task_dispatch',{commandId:'wait-child',title:'Child work',description:'Finish the isolated fixture',nodeId:'local',executionModel:{provider:'test-offline',model:'script'}});
  const child=l.snapshot().tasks.find(task=>task.parentTaskId===parent.taskId),run=l.history(child.taskId).runs[0];
  assert.equal(run.parentRunId,binding.runId);
  for(const taskId of [parent.taskId,child.taskId]){
   const state=await wait(agent,taskId);assert.equal(state.settled,false);assert.deepEqual(state.pendingRunIds,[run.runId]);
  }
  const claim=l.claim('wait-child-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
  const ref={runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'local',fence:claim.attempt.fence,executionId:'wait-child-owner'};
  l.markRunning('wait-child-start',ref);
  for(const taskId of [parent.taskId,child.taskId]){
   const state=await wait(agent,taskId);assert.equal(state.settled,false);assert.deepEqual(state.pendingRunIds,[run.runId]);
  }
  l.submit('wait-child-finish',{...ref,outcome:'success',summary:'Child fixture completed'});
  assert.equal((await wait(agent,parent.taskId)).settled,true);
  assert.equal((await wait(agent,child.taskId)).settled,true);
  assert.equal(l.getRun(binding.runId).state,'running','waiting does not settle the coordinator');
  const other=await session('dispatcher-wait-other');
  await call(h,other,'project_bind_session',{projectId:project.binding.projectId});
  const otherTask=(await call(h,other,'task_create',{commandId:'wait-other-parent',title:'Another coordinator',policy:{settlementQuietMs:0}})).value;
  await call(h,other,'task_bind_dispatcher',{commandId:'wait-other-bind',taskId:otherTask.taskId});
  const otherBinding=l.dispatcherForSession('local',String(other.id));assert.ok(otherBinding);
  const foreignWait=await wait(agent,otherTask.taskId);
  assert.equal(foreignWait.settled,false);assert.deepEqual(foreignWait.pendingRunIds,[otherBinding.runId],'caller cannot exclude another session coordinator');
  const observer=await session('dispatcher-wait-no-binding');
  await call(h,observer,'project_bind_session',{projectId:project.binding.projectId});
  assert.equal(l.dispatcherForSession('local',String(observer.id)),undefined);
  const unboundWait=await wait(observer,parent.taskId);
  assert.equal(unboundWait.settled,false);assert.deepEqual(unboundWait.pendingRunIds,[binding.runId],'an unbound session cannot exclude an arbitrary running Run');
 }finally{await h.dispose();}
});


test('a known provider quota error cools the real session before another result can steer, including a new delivery instance',async()=>{
 const h=await createNativeHarness({script:[()=>{throw new LlmError("Claude Code: You've hit your session limit · resets 1:10pm (UTC)",'RATE_LIMIT',{providerRetryAfterMs:7200000});}]});let restarted;
 try{
  const id=SessionId('quota-return-origin'),parent=await h.ctx.agents.create({sessionId:id,agentOptions:{provider:'test-offline',model:'script'}});
  const origin={kind:'session',nodeId:'local',sessionId:String(id),composition:{provider:'test-offline',model:'script',tools:[]}};
  const message=n=>({messageId:'quota-'+n,taskId:'child-'+n,nodeId:'local',sessionId:String(id),completion:{eventId:'quota-'+n,origin},text:'Result '+n});
  await assert.rejects(h.ctx.taskSystem.taskReturns.deliver(message(1)),error=>error.failure?.code==='RATE_LIMIT'&&error.failure.retryAfterMs===7200000&&Boolean(error.failure.resetAt));
  await assert.rejects(h.ctx.taskSystem.taskReturns.deliver(message(2)),error=>error.failure?.code==='RATE_LIMIT');
  assert.equal(h.adapter.requests.length,1,'second event does not reset the model retry budget');
  await h.ctx.sessions.flush(parent.agent.session);await parent.dispose();restarted=new TaskReturnDelivery(h.ctx);
  await assert.rejects(restarted.deliver(message(3)),error=>error.failure?.code==='RATE_LIMIT');
  assert.equal(h.adapter.requests.length,1,'persisted terminal quota blocks steering after delivery restart');
  assert.equal((await read(h,String(id))).filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result').length,1);
 }finally{await restarted?.dispose();await h.dispose();}
});
