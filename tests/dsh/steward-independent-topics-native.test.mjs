import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {startHost} from '../ci/browser-native-project.mjs';
import {registerExecutor} from './executor-fixture.mjs';
async function completed(s,id){for(let n=0;n<400;n++){const value=await s.reconcile({conversationId:'main',commandId:id});if(value.commandMessage?.state.kind==='completed')return value;await new Promise(r=>setTimeout(r,10));}throw Error('native topic did not complete');}
const send=(id,text,extra={})=>({conversationId:'main',commandId:id,text,...extra});

test('explicit new-topic submissions mint distinct real sources and never mix recall or model history',{timeout:30000},async()=>{
 const h=await startHost();try{
  const s=h.ctx.taskSystem.steward;h.model.script.push('A reply','B reply');
  await s.send(send('topic-A','ALPHA_PRIVATE',{routeCreateTopic:true}));const a=(await completed(s,'topic-A')).commandMessage;
  await s.send(send('topic-B','BETA_PRIVATE',{routeCreateTopic:true}));const b=(await completed(s,'topic-B')).commandMessage;
  assert.ok(a.scope.topicId);assert.ok(b.scope.topicId);assert.notEqual(a.scope.topicId,b.scope.topicId);assert.notEqual(a.source.sessionId,b.source.sessionId);assert.notEqual(a.source.cwd,b.source.cwd);
  assert.equal(h.model.requests.length,2,'manual new-topic intent uses no classifier');assert.match(JSON.stringify(h.model.requests[0]),/ordinary steward topic/);assert.match(JSON.stringify(h.model.requests[0]),/casual discussion or work/);assert.match(JSON.stringify(h.model.requests[0]),/Discussion alone does not create a project or authorize task dispatch/);
  assert.doesNotMatch(JSON.stringify(h.model.requests[1].messages),/ALPHA_PRIVATE|A reply/);
  assert.throws(()=>s.recall.read(b.source.sessionId,{messageId:a.id,expectedRevision:String(a.revision)}),{code:'FORBIDDEN'});
  assert.equal(s.recall.read(b.source.sessionId,{query:'BETA_PRIVATE'}).items.length,1);
  assert.deepEqual((await s.send(send('topic-A','ALPHA_PRIVATE',{routeCreateTopic:true}))).commandMessage.scope,a.scope);
  assert.equal(h.model.requests.length,2);
  await assert.rejects(s.send(send('topic-A','changed',{routeCreateTopic:true})),{code:'CONFLICT'});
  for(const message of [a,b]){
   const workspace=h.ctx.workspaceRegistry.list().find(item=>item.path===message.source.cwd);assert.ok(workspace);assert.ok(workspace.sessionIds.includes(message.source.sessionId));assert.match(workspace.title,/^管家/);
   assert.ok(await h.ctx.sessionPersistence.stat(message.source.sessionId));
  }
  h.model.script.push(options=>{const text=JSON.stringify(options.messages);assert.match(text,/ALPHA/);assert.doesNotMatch(text,/ALPHA_PRIVATE|BETA_PRIVATE|A reply/);return 'Quote-aware new discussion'});
  await s.send(send('topic-quote','A selected fragment in a fresh discussion',{routeCreateTopic:true,quote:{messageId:a.id,expectedRevision:a.revision,excerpt:'ALPHA'}}));
  const quoted=(await completed(s,'topic-quote')).commandMessage;
  assert.notEqual(quoted.source.sessionId,a.source.sessionId);assert.equal(quoted.quote.source.sessionId,a.source.sessionId);
  const activity=s.snapshot({conversationId:'main'}).topicActivity.items;assert.ok(activity.some(item=>item.scope.topicId===a.scope.topicId));assert.ok(activity.some(item=>item.scope.topicId===b.scope.topicId));
 }finally{await h.close()}
});

test('promotion reuses the registered topic workspace and preserves real session, files, task, run, attempt and report',{timeout:30000},async()=>{
 const h=await startHost();try{
  const s=h.ctx.taskSystem.steward,ledger=h.ctx.taskSystem.ledger;
  h.model.script.push('The original discussion remains here');await s.send(send('promote-source','A research discussion',{routeCreateTopic:true}));
  const message=(await completed(s,'promote-source')).commandMessage,topic={conversationId:'main',scope:message.scope};
  const path=join(message.source.cwd,'notes.txt');writeFileSync(path,'original topic material');
  const originalWorkspace=h.ctx.workspaceRegistry.list().find(item=>item.path===message.source.cwd);
  registerExecutor(ledger,'topic-worker',{nodeId:'worker',roles:['executor'],models:[{provider:'worker-model',model:'small',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()});
  const task=ledger.createTask('topic-existing-task',{title:'Existing real task',description:'Preserve its execution history'}).value;
  const run=ledger.createRun('topic-original-run',{taskId:task.taskId,route:{nodeId:'worker',provider:'worker-model',model:'small',requiredCapabilities:[]}}).value;
  const attempt=ledger.claim('topic-original-claim',{runId:run.runId,nodeId:'worker',ttlMs:10000}).value.attempt;
  ledger.submit('topic-original-result',{runId:run.runId,attemptId:attempt.attemptId,nodeId:'worker',fence:attempt.fence,outcome:'failure',summary:'Synthetic old result',report:{title:'Original report',body:'Keep the original report'}});
  const historical={run:ledger.getRun(run.runId),attempt:ledger.snapshot().attempts.find(item=>item.attemptId===attempt.attemptId),reports:ledger.snapshot().reports.filter(item=>item.taskId===task.taskId)};
  const initial=(await s.topicProjectOptions({topic})).topic;
  const attached=await s.topicTaskBind({commandId:'topic-attach',topic,expectedRevision:initial.revision,taskId:task.taskId});
  const input={commandId:'topic-upgrade',topic,expectedRevision:attached.topic.revision,mode:'create',title:'Promoted research',goal:'Continue the existing work without rewriting its history',taskIds:[task.taskId]};
  const result=await s.topicProjectConfigure(input);assert.equal(result.sameWorkspace,true);assert.equal(result.physicalWorkspaceMoved,false);assert.equal(result.sourceSessionId,message.source.sessionId);
  const workspace=h.ctx.workspaceRegistry.list().find(item=>item.id===originalWorkspace.id);assert.equal(workspace.title,'Promoted research');assert.ok(workspace.sessionIds.includes(message.source.sessionId));assert.ok(workspace.sessionIds.includes(result.projectSessionId));
  assert.equal(readFileSync(path,'utf8'),'original topic material');assert.deepEqual(s.store.message(message.id),message);
  assert.deepEqual(ledger.getRun(run.runId),historical.run);assert.deepEqual(ledger.snapshot().attempts.find(item=>item.attemptId===attempt.attemptId),historical.attempt);assert.deepEqual(ledger.snapshot().reports.filter(item=>item.taskId===task.taskId),historical.reports);
  assert.equal(ledger.projectForTask(task.taskId),result.projectId);
  await s.sourceSession({conversationId:'main',scope:message.scope});assert.equal(workspace.title,'Promoted research');
  assert.deepEqual(await s.topicProjectConfigure(input),result);assert.equal(s.projectTopics(result.projectId)[0].topic.scope.topicId,message.scope.topicId);
  assert.equal(h.model.requests.length,1,'promotion and opening original sources perform no inference');
 }finally{await h.close()}
});

test('an explicit topic task action creates one formal temporary task without creating a task for every discussion',{timeout:30000},async()=>{
 const h=await startHost();try{
  const s=h.ctx.taskSystem.steward,ledger=h.ctx.taskSystem.ledger;h.model.script.push('Planning discussion only');
  await s.send(send('task-topic','Discuss a possible deliverable',{routeCreateTopic:true}));const message=(await completed(s,'task-topic')).commandMessage;
  assert.equal(ledger.snapshot().tasks.length,0);
  const topic={conversationId:'main',scope:message.scope},record=(await s.topicProjectOptions({topic})).topic;
  const input={commandId:'make-topic-task',topic,expectedRevision:record.revision,title:'A real temporary task',description:'Prepare a deliverable once an authorized executor is configured'};
  const result=await s.topicTaskCreate(input);assert.ok(ledger.getTask(result.taskId));assert.ok(result.topic.taskIds.includes(result.taskId));
  assert.equal(ledger.snapshot().tasks.length,1);assert.equal((await s.topicProjectOptions({topic})).tasks[0].taskId,result.taskId);
  assert.deepEqual(await s.topicTaskCreate(input),result);assert.equal(ledger.snapshot().tasks.length,1);
  await assert.rejects(s.topicTaskCreate({...input,title:'changed'}),{code:'CONFLICT'});
  assert.equal(h.model.requests.length,1,'no unsolicited task or background summary model call');
 }finally{await h.close()}
});

test('completed real turns maintain one bounded card batch in the background; opening old history never starts maintenance',{timeout:30000},async()=>{
 const h=await startHost();let release;try{
  const s=h.ctx.taskSystem.steward;h.model.script.push('Initial reply');await s.send(send('maintenance-seed','Preserve the original goal',{routeCreateTopic:true}));
  const original=(await completed(s,'maintenance-seed')).commandMessage,topic={conversationId:'main',scope:original.scope};
  await s.configureRouting({commandId:'maintenance-model',expectedRevision:0,fallback:{provider:'test-offline',model:'script'}});
  for(let n=0;n<22;n++)s.store.project({...original,role:n%2?'assistant':'user',commandId:null,text:`Historical requirement ${n}`,replyTo:original.id,state:{kind:'completed'},nativeSeq:null},`seed-history-${n}`);
  const before=h.model.requests.length;await s.topicDetail({topic});await s.reconcile({conversationId:'main'});assert.equal(h.model.requests.length,before,'history/view access causes no model backfill');
  let started;const begun=new Promise(r=>started=r);
  h.model.script.push('The current request is complete',async options=>{assert.match(options.system,/Maintain a sourced topic card/);const input=JSON.parse(options.messages[0].content[0].text);assert.ok(input.delta.length<=16);started();await new Promise(r=>release=r);const evidence=input.delta.find(item=>item.role==='user');return JSON.stringify({summary:'A sourced requirement',facts:[{id:'original-goal',section:'goal',text:evidence.text,origin:'generated',state:'active',sources:[evidence.source]}],evidence:[{factId:'original-goal',source:evidence.source,quote:evidence.text}],supersessions:[]})});
  await s.send(send('maintenance-current','Continue this exact discussion',{target:original.scope}));
  const finished=await completed(s,'maintenance-current');await begun;assert.equal(finished.commandMessage.state.kind,'completed','delivery does not wait for compaction');
  assert.ok(s.snapshot({conversationId:'main'}).topicMaintenance.some(item=>item.state==='running'));
  release();release=undefined;
  for(let n=0;n<200&&s.snapshot({conversationId:'main'}).topicMaintenance.some(item=>item.state==='running');n++)await new Promise(r=>setTimeout(r,10));
  const maintained=await s.topicDetail({topic});assert.ok(maintained.coverageSeq>0);assert.ok(maintained.facts.some(item=>item.id==='original-goal'));
  const calls=h.model.requests.length;await s.topicDetail({topic});await s.reconcile({conversationId:'main'});assert.equal(h.model.requests.length,calls,'no repeated batch without a new completed real turn');
 }finally{release?.();await h.close()}
});
