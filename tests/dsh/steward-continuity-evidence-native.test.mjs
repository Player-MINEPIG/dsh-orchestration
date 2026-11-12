import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {SessionId} from '@deepseek-ai/dsh-session';
import {startHost} from '../ci/browser-native-project.mjs';
import {createNativeHarness} from './native-harness.mjs';
import {attachOfficialCompaction} from './steward-live-provider.mjs';
import {registerExecutor} from './executor-fixture.mjs';

const failureHosts=new WeakMap();
function watchTaskPM(h){const entry={host:h,errors:[],ends:[],failed:false};failureHosts.set(h.ctx.taskSystem.steward,entry);const push=h.model.script.push.bind(h.model.script);h.model.script.push=(...items)=>push(...items.map(item=>typeof item==='function'?async options=>{try{return await item(options)}catch(error){entry.errors.push(String(error.stack??error));throw error}}:item));h.ctx.on('session/event',(session,event)=>{if(event.type==='turn/end')entry.ends.push({sessionId:String(session.id),reason:event.data.reason})});}
async function closeHost(h){const entry=failureHosts.get(h.ctx.taskSystem.steward);if(entry?.failed&&process.env.DSH_KEEP_TASKPM_FIXTURE==='1')await h.ctx.fiber.dispose();else await h.close();}
async function completed(service,commandId){
 for(let n=0;n<600;n++){const value=await service.reconcile({conversationId:'main',commandId});if(value.commandMessage?.state.kind==='completed')return value.commandMessage;await new Promise(r=>setTimeout(r,10));}
 const record=failureHosts.get(service);if(record){record.failed=true;const h=record.host;writeFileSync('.runtime/taskpm-diagnostic.json',JSON.stringify({fixtureDirectory:h.directory,commandId,message:service.store.commandMessage('main',commandId),turns:h.ctx.taskSystem.ledger.managementDatabase().prepare('SELECT command,owner,session,state,native_admission,error FROM pr_turns').all(),scriptErrors:record.errors,turnEnds:record.ends,lastRequests:h.model.requests.slice(-2).map(options=>({model:options.model,system:options.system,messages:options.messages,tools:options.tools?.map(tool=>tool.name)}))},null,2));}throw Error(`Native command did not complete: ${commandId}`);
}
const send=(commandId,text,extra={})=>({conversationId:'main',commandId,text,...extra});
const serialized=options=>JSON.stringify(options.messages);
function toolValue(result){if(result.value!==undefined)return result.value;return JSON.parse(result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'));}

test('normal read-only steward entry discovers without IDs, follows known shared pointers and denies donor history and stale references',{timeout:40000},async()=>{
 const h=await startHost();try{
  const s=h.ctx.taskSystem.steward,results=[];h.ctx.on('tools/result',(exec,result)=>{if(exec.name==='steward_evidence')results.push(toolValue(result));});
  h.model.script.push('Source discussion recorded');await s.send(send('evidence-donor','SHARED_COMPAT_B PRIVATE_DONOR_NATIVE',{routeCreateTopic:true}));const donor=await completed(s,'evidence-donor');
  h.model.script.push('Received selected material');await s.send(send('evidence-receiver','Please review only the shared compatibility material',{routeCreateTopic:true,quote:{messageId:donor.id,expectedRevision:donor.revision,excerpt:'SHARED_COMPAT_B'}}));const receiver=await completed(s,'evidence-receiver');
  h.model.script.push(options=>{assert.ok(options.tools.some(tool=>tool.name==='steward_evidence'));return{name:'steward_evidence',args:{question:'What compatibility decision was shared with this conversation?'}};},()=>{
   assert.equal(results.at(-1).kind,'evidence');assert.match(JSON.stringify(results.at(-1)),/SHARED_COMPAT_B/);assert.doesNotMatch(JSON.stringify(results.at(-1)),/PRIVATE_DONOR_NATIVE/);
   return{name:'steward_evidence',args:{question:'Read the precise authorized excerpt',references:[{kind:'shared',messageId:receiver.id,expectedRevision:String(receiver.revision)}]}};
  },()=>{assert.equal(results.at(-1).items[0].record.content,'SHARED_COMPAT_B');return{name:'steward_evidence',args:{question:'Try the donor record',references:[{kind:'message',messageId:donor.id,expectedRevision:String(donor.revision)}]}};},()=>{
   assert.equal(results.at(-1).kind,'forbidden');return{name:'steward_evidence',args:{question:'Check old pointer',references:[{kind:'shared',messageId:receiver.id,expectedRevision:'999'}]}};
  },()=>{assert.equal(results.at(-1).kind,'stale');return 'Only authorized evidence read; no execution started';});
  await s.send(send('evidence-question','问管家：昨天最后采纳哪条兼容决定？',{target:receiver.scope,permissionPreset:'read-only'}));await completed(s,'evidence-question');
  assert.equal(results.length,4);assert.equal(h.ctx.taskSystem.ledger.snapshot().tasks.length,0);assert.equal(h.ctx.taskSystem.ledger.snapshot().runs.length,0);
 }finally{await closeHost(h);}
});

test('completed-turn checkpoints enter the next real prompt after official compaction and recover wait-for-human evidence without rerunning',{timeout:50000},async()=>{
 const h=await startHost();let resumed;try{
  const s=h.ctx.taskSystem.steward,ledger=h.ctx.taskSystem.ledger;
  h.model.resolveModel=(provider,model)=>({provider,id:model,name:'Measured continuity fixture',context:{contextWindow:4096},defaultMaxTokens:256});
  const {compaction}=await attachOfficialCompaction(h.ctx,{runtimeRoot:process.env.DSH_OFFICIAL_ROOT});
  const selection={provider:'test-offline',model:'script'};
  h.model.script.push('Deployment is only discussed, no action performed');await s.send(send('continuity-old','DEPLOY_OLD_A: 准备部署。'+ 'Synthetic planning detail. '.repeat(60),{routeCreateTopic:true,selection}));const first=await completed(s,'continuity-old');
  h.model.script.push('I will wait for your acceptance');await s.send(send('continuity-replaced','COMPAT_DECISION_B: 不要部署，等我验收。',{target:first.scope,selection}));const changed=await completed(s,'continuity-replaced');
  let checkpoint;
  for(let n=0;n<300;n++){checkpoint=await s.continuity.inspect(first.source.sessionId,{});if(checkpoint.kind==='checkpoint'&&checkpoint.checkpoint.sources.some(source=>source.id===changed.id))break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(checkpoint.kind,'checkpoint');assert.ok(checkpoint.checkpoint.sources.some(source=>source.id===changed.id),'The normal completed-turn hook supplies the current original pointer');
  assert.equal(checkpoint.checkpoint.tokens.contextWindow,4096);assert.ok(checkpoint.checkpoint.tokens.totalTokens>0,'The trusted hook records an actual native token-meter reading');
  let agent=h.ctx.agents.get(SessionId(first.source.sessionId));
  if(!agent){resumed=await h.ctx.agents.resume({resumeSessionId:SessionId(first.source.sessionId),agentOptions:{provider:'test-offline',model:'script'}});agent=resumed.agent;}
  await agent.whenIdle();const generation=agent.session.surface.replaceGeneration;
  h.model.script.push('Prior discussion condensed. Read current scoped evidence before deciding any deployment action.');
  const compacted=await compaction.compactNow(agent,new AbortController().signal,'continuity-native-proof');assert.ok(compacted?.shadowedSeqs.length);assert.ok(agent.session.surface.replaceGeneration>generation);
  const before={tasks:ledger.snapshot().tasks.length,runs:ledger.snapshot().runs.length};let recalled;
  h.ctx.on('tools/result',(exec,result)=>{if(exec.name==='steward_evidence')recalled=toolValue(result);});
  h.model.script.push(options=>{
   const request=JSON.stringify(options);assert.match(request,/dsh-steward-checkpoint|当前会话有界恢复核对/);assert.match(request,new RegExp(changed.id));
   assert.match(request,/automaticRetry|不能自动重跑/);return{name:'steward_evidence',args:{question:'What is the latest compatibility decision and may deployment proceed?'}};
  },()=>{assert.equal(recalled.kind,'evidence');assert.match(JSON.stringify(recalled),/COMPAT_DECISION_B/);return 'Current sourced decision is to wait for human acceptance. No deployment or retry performed.';});
  await s.send(send('continuity-next','按最新决定应该继续什么？',{target:first.scope,permissionPreset:'read-only'}));await completed(s,'continuity-next');
  assert.equal(ledger.snapshot().tasks.length,before.tasks);assert.equal(ledger.snapshot().runs.length,before.runs);assert.equal(s.store.message(changed.id).text,changed.text);
 }finally{await resumed?.dispose();await closeHost(h);}
});

test('a real owned worker discovers only assigned TaskContext handoff and cannot borrow steward or other-task history',{timeout:30000},async()=>{
 const h=await createNativeHarness({executionRoot:true,config:{role:'both',schedulerEnabled:false}});try{
  const ledger=h.ledger,results=[];h.ctx.on('tools/result',(exec,result)=>{if(exec.name==='steward_evidence')results.push(toolValue(result));});
  registerExecutor(ledger,'evidence-worker-node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
  const task=ledger.createTask('evidence-worker-task',{title:'Inspect assigned compatibility evidence',description:'Read the directed report, then return a verified result',policy:{allowedTools:['steward_evidence']}}).value;
  const note=ledger.appendReport('evidence-worker-handoff',{taskId:task.taskId,kind:'note',title:'Directed compatibility handoff',body:'ASSIGNED_COMPAT_B: wait for acceptance.',data:{actor:'responsible-PM'}}).value;
  const review=ledger.appendReport('evidence-worker-review',{taskId:task.taskId,kind:'note',title:'Directed reviewer note',body:'REVIEWER_SCOPE_ONLY: evidence does not grant deployment permission.',data:{actor:'assigned-reviewer'}}).value;
  const foreign=ledger.createTask('evidence-worker-foreign',{title:'Foreign task'}).value;ledger.appendReport('evidence-worker-foreign-note',{taskId:foreign.taskId,kind:'note',title:'Private',body:'FOREIGN_TASK_NATIVE_SECRET'});
  const run=ledger.createRun('evidence-worker-run',{taskId:task.taskId,contextNotes:[note.reportId,review.reportId],route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
  const claim=ledger.claim('evidence-worker-claim',{runId:run.runId,nodeId:'local',ttlMs:20000}).value;
  h.adapter.script.push(options=>{assert.ok(options.tools.some(tool=>tool.name==='steward_evidence'));assert.equal(options.tools.some(tool=>tool.name==='steward_recall'),false);assert.doesNotMatch(serialized(options),/FOREIGN_TASK_NATIVE_SECRET/);return{name:'steward_evidence',args:{question:'Which compatibility decision was handed to this task?'}};},()=>{
   const result=results.at(-1);assert.equal(result.kind,'evidence');assert.equal(result.coverage,'assigned-material-only');assert.match(JSON.stringify(result),/ASSIGNED_COMPAT_B/);assert.match(JSON.stringify(result),/REVIEWER_SCOPE_ONLY/);
   const report=result.items.find(item=>item.record.source?.id===note.reportId).record;return{name:'steward_evidence',args:{question:'Read the versioned directed report',references:[{kind:'record',recordKind:'report',recordId:note.reportId,expectedRevision:report.source.revision}]}};
  },()=>{assert.equal(results.at(-1).items[0].record.content,'ASSIGNED_COMPAT_B: wait for acceptance.');return{name:'steward_evidence',args:{question:'Try an unrelated task',references:[{kind:'record',recordKind:'task',recordId:foreign.taskId}]}};
  },()=>{assert.equal(results.at(-1).kind,'forbidden');return{name:'task_submit_result',args:{outcome:'success',summary:'Authorized handoff verified without foreign history',reportBody:'The current assigned material says to wait for acceptance.'}};});
  const result=await h.ctx.taskSystem.native.execute(claim);assert.equal(result.submitted,true);assert.equal(result.run.state,'succeeded');assert.equal(ledger.snapshot().runs.length,1);assert.doesNotMatch(JSON.stringify(results),/FOREIGN_TASK_NATIVE_SECRET/);
 }finally{await h.dispose();}
});


test('the normal project PM discovers authorized ledger evidence without IDs and follows its version, without seeing another project', {timeout:30000},async()=>{
 const h=await startHost();try{
  const s=h.ctx.taskSystem.steward,ledger=h.ctx.taskSystem.ledger,project=h.created;
  const task=ledger.createTask('authority-current-task',{title:'Compatibility decision'}).value;h.runtime.linkTask(h.runtime.placementProject(project.projectId).session,task.taskId);
  const report=ledger.appendReport('authority-current-report',{taskId:task.taskId,kind:'note',title:'Current compatibility decision',body:'LEDGER_COMPAT_B: wait for human acceptance.',data:{actor:'responsible-PM'}}).value;
  const foreign=await h.runtime.create({commandId:'authority-foreign-project',title:'Other private project',goal:'PRIVATE_OTHER_AUTHORITY'});
  const otherTask=ledger.createTask('authority-foreign-task',{title:'Other project task'}).value;h.runtime.linkTask(h.runtime.placementProject(foreign.projectId).session,otherTask.taskId);
  ledger.appendReport('authority-foreign-report',{taskId:otherTask.taskId,kind:'note',title:'Unrelated',body:'PRIVATE_OTHER_REPORT'});
  const results=[];h.ctx.on('tools/result',(exec,result)=>{if(exec.name==='steward_evidence')results.push(toolValue(result));});
  const before={tasks:ledger.snapshot().tasks.length,runs:ledger.snapshot().runs.length};
  h.model.script.push({name:'steward_evidence',args:{question:'Which compatibility decision is recorded in this project ledger?'}},()=>{
   const value=results.at(-1);assert.equal(value.kind,'evidence');assert.match(JSON.stringify(value),/LEDGER_COMPAT_B/);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_OTHER_REPORT|PRIVATE_OTHER_AUTHORITY/);
   const item=value.items.find(item=>item.record.source?.id===report.reportId);assert.ok(item);return{name:'steward_evidence',args:{question:'Read exact version',references:[{kind:'record',recordKind:'report',recordId:report.reportId,expectedRevision:item.record.source.revision}]}};
  },()=>{assert.match(results.at(-1).items[0].record.content,/LEDGER_COMPAT_B/);return 'The authorized ledger says wait for acceptance; no new execution.';});
  await s.send(send('authority-question','问管家：最后采纳哪条兼容决定？',{target:{kind:'project',projectId:project.projectId},permissionPreset:'read-only'}));await completed(s,'authority-question');
  assert.equal(results.length,2);assert.equal(ledger.snapshot().tasks.length,before.tasks);assert.equal(ledger.snapshot().runs.length,before.runs);
 }finally{await closeHost(h);}
});

test('a real task PM seat reads its responsible task material and restores task status without project-wide authority or a worker lease',{timeout:40000},async()=>{
 const h=await startHost();watchTaskPM(h);try{
  const s=h.ctx.taskSystem.steward,ledger=h.ctx.taskSystem.ledger;
  h.model.script.push('Ordinary topic remains separate');await s.send(send('taskpm-topic','ORDINARY_TOPIC_PRIVATE_HISTORY',{routeCreateTopic:true}));const original=await completed(s,'taskpm-topic');
  const topic={conversationId:'main',scope:original.scope},revision=(await s.topicProjectOptions({topic})).topic.revision;
  const created=await s.topicTaskCreate({commandId:'taskpm-create',topic,expectedRevision:revision,title:'Responsible task PM',description:'TASKPM_COMPAT_ONLY: verify assigned compatibility and wait for acceptance.'});
  ledger.appendReport('taskpm-owned-report',{taskId:created.taskId,kind:'note',title:'Directed task PM evidence',body:'TASKPM_DIRECTED_B: do not deploy; await acceptance.',data:{actor:'assigned-reviewer'}});
  const foreign=ledger.createTask('taskpm-unrelated',{title:'Other task'}).value;ledger.appendReport('taskpm-unrelated-report',{taskId:foreign.taskId,kind:'note',title:'Private',body:'UNRELATED_TASKPM_SECRET'});
  let seats=(await s.topicSessions({topic})).seats;const taskSeat=seats.find(seat=>seat.role==='task-coordinator'&&seat.taskId===created.taskId);assert.ok(taskSeat);
  const results=[];h.ctx.on('tools/result',(exec,result)=>{if(['steward_evidence','steward_continuity'].includes(exec.name))results.push({name:exec.name,value:toolValue(result)});});
  const beforeRuns=ledger.snapshot().runs.length;
  h.model.script.push(options=>{assert.doesNotMatch(JSON.stringify(options.messages),/ORDINARY_TOPIC_PRIVATE_HISTORY|UNRELATED_TASKPM_SECRET/);return{name:'steward_evidence',args:{question:'What was handed to the task I coordinate?'}};},()=>{
   const result=results.at(-1).value;assert.equal(result.kind,'evidence');assert.equal(result.coverage,'assigned-material-only');assert.match(JSON.stringify(result),/TASKPM_COMPAT_ONLY/);assert.match(JSON.stringify(result),/TASKPM_DIRECTED_B/);assert.doesNotMatch(JSON.stringify(result),/UNRELATED_TASKPM_SECRET/);return{name:'steward_evidence',args:{question:'Try an unrelated task',references:[{kind:'record',recordKind:'task',recordId:foreign.taskId}]}};
  },()=>{assert.equal(results.at(-1).value.kind,'forbidden');return 'The responsible task remains waiting for acceptance; no retry.';});
  await s.send(send('taskpm-question','问管家：我负责的任务有哪些有效依据？',{target:original.scope,recipient:{id:taskSeat.id,token:taskSeat.token},permissionPreset:'read-only'}));const pmMessage=await completed(s,'taskpm-question');assert.equal(pmMessage.source.sessionId,taskSeat.source.sessionId);
  let checkpoint;
  for(let n=0;n<300;n++){checkpoint=await s.continuity.inspect(pmMessage.source.sessionId,{});if(checkpoint.kind==='checkpoint'&&checkpoint.checkpoint.task?.taskId===created.taskId)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(checkpoint.kind,'checkpoint');assert.equal(checkpoint.checkpoint.task.taskId,created.taskId);assert.equal(checkpoint.verification.automaticRetry,false);
  seats=(await s.topicSessions({topic})).seats;const current=seats.find(seat=>seat.id===taskSeat.id);assert.ok(current);
  h.model.script.push({name:'steward_continuity',args:{}},()=>{const result=results.at(-1).value;assert.equal(result.checkpoint.task.taskId,created.taskId);assert.equal(result.verification.automaticRetry,false);return 'Current task state verified without new execution.';});
  await s.send(send('taskpm-restore','核对当前状态，不要重新执行。',{target:original.scope,recipient:{id:current.id,token:current.token},permissionPreset:'read-only'}));await completed(s,'taskpm-restore');assert.equal(ledger.snapshot().runs.length,beforeRuns);
 }finally{await closeHost(h);}
});
