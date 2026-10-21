import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage,ToolCallId} from '@deepseek-ai/dsh-llm';
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

test('busy origin consumes the result in its next turn and acknowledgement waits for that turn',async()=>{
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
