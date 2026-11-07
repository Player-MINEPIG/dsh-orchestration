import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage,ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
import {applyCheckinSurface,manualCheckFor} from '../../packages/task-system/dist/task-checkin-surface.js';
import {TaskReturnDelivery} from '../../packages/task-system/dist/task-returns.js';
import {TaskReturnInbox} from '../../packages/task-system/dist/remote/task-return-inbox.js';
import {RemoteClient,RemoteLedgerClient,RemoteGateway,RecoveryStore,IdentityVerifier} from '../../packages/task-system/dist/remote/api.js';
let seq=0;
async function call(h,agent,name,args){const result=await h.ctx.tools.execute({name,arguments:args,callId:ToolCallId('checkin-'+ ++seq),agent,signal:new AbortController().signal});assert.equal(result.isError,false,JSON.stringify(result.error));return result.value;}
async function events(h,id){const handle=await h.ctx.sessionPersistence.open(SessionId(id),'read');try{return(await handle.read()).events;}finally{await handle.close();}}
async function draft(h,id){const handle=await h.ctx.agents.create({sessionId:SessionId(id),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});await call(h,handle.agent,'task_create',{commandId:'draft-'+id,title:'Task '+id});return{handle,task:h.ledger.snapshot().tasks.find(task=>task.title==='Task '+id)};}

test('a Run completing during the final deadline refresh withdraws without steering or a false failed ACK',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});let delivery;
 try{
  const {handle,task}=await draft(h,'completed-at-admission');let clock=Date.now();h.ledger.clock=()=>clock;
  h.ledger.registerNode('worker',{nodeId:'worker',roles:['executor'],enabled:true,models:[{provider:'test-offline',model:'script'}],workspaceIds:[],capabilities:[],maxConcurrent:1});
  const catalog=h.ledger.executionModels.request('catalog',{nodeId:'worker'}).catalog.request;h.ledger.completeExecutionModels('catalog-result',{nodeId:'worker',requestId:catalog.requestId,generation:catalog.generation,result:{state:'success',complete:true,observedAt:clock,models:[{provider:'test-offline',model:'script'}]}});
  const run=h.ledger.withDispatchOrigin(task.dispatchOrigin,()=>h.ledger.createRun('bounded',{taskId:task.taskId,expectedExecutionMs:1000,route:{nodeId:'worker',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value),claim=h.ledger.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:60000}).value,ref={runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:'work'};
  h.ledger.markRunning('prepare',ref);h.ledger.markExecutionStarted('actual',ref);clock+=1000;h.ledger.checkins.tick();const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];let refreshes=0;
  delivery=new TaskReturnDelivery(h.ctx,async current=>{if(++refreshes===2){h.ledger.submit('done',{...ref,outcome:'success',summary:'Finished before admission'});h.ledger.checkins.tick();}const refreshed=h.ledger.pendingSessionMessages('local',{messageId:current.messageId,forAdmission:true})[0];return refreshed?.admission==='obsolete'?'obsolete':refreshed?.admission==='defer'?undefined:refreshed;});
  const receipt=await delivery.deliver(message);assert.equal(receipt.withdrawn,true);h.ledger.completeSessionMessage('withdrawn-ack',{nodeId:'local',messageId:message.messageId,state:'completed',...receipt});assert.equal(h.ledger.getSessionMessage(message.messageId).withdrawn,true);assert.equal(h.adapter.requests.length,0);assert.equal((await events(h,String(handle.agent.id))).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,0);assert.equal(h.ledger.getRun(run.runId).state,'succeeded');
 }finally{await delivery?.dispose();await h.dispose();}
});
function remote(h){
 h.ledger.registerNode("remote-local",{nodeId:"local",roles:["planner"],enabled:true,models:[],capabilities:[],workspaceIds:[],maxConcurrent:1});
 const keys=generateKeyPairSync('ed25519'),server=new RecoveryStore(':memory:'),outbox=new RecoveryStore(':memory:');
 const gateway=new RemoteGateway({role:'planner',nodeId:'central',ledger:h.ledger,store:server,verifier:new IdentityVerifier({audience:'central',peers:[{keyId:'key',nodeId:'local',publicKey:keys.publicKey,audience:'central',operations:['sessionMessages','sessionMessageReply','projectCollaborate'],workspaces:[],capabilities:[]}]})});
 const client=new RemoteClient({endpoint:'https://fixture.invalid/commands',nodeId:'local',audience:'central',keyId:'key',privateKey:keys.privateKey,store:outbox,fetch:async(_url,options)=>new Response(JSON.stringify(await gateway.handle(options.body)))});
 return{ledger:new RemoteLedgerClient(client,'local'),async dispose(){await client.dispose();await gateway.dispose();outbox.close();server.close();}};
}

test('a real cold original session processes a distinct draft check-in, records progress and replays without another turn',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});
 try{
  const {handle,task}=await draft(h,'cold-checkin');assert.ok(task.dispatchOrigin.composition.tools.includes("task_checkin"));h.ledger.checkins.request('manual',task.taskId);const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];await h.ctx.sessions.flush(handle.agent.session);await handle.dispose();
  const nextCheckAt=new Date(Date.now()+60000).toISOString();h.adapter.script.push({name:'task_checkin',args:{action:'update',commandId:'progress',taskId:task.taskId,observation:'waiting_external',summary:'Verified external condition; check later',plan:{kind:'scheduled',nextCheckAt}}},'Progress recorded');
  const receipt=await h.ctx.taskSystem.taskReturns.deliver(message);h.ledger.completeSessionMessage('ack',{nodeId:'local',messageId:message.messageId,state:'completed',...receipt});
  assert.equal(h.ledger.checkins.view(task.taskId).nextCheckAt,nextCheckAt);assert.equal(h.ledger.getTask(task.taskId).state,'ready');assert.equal(h.ledger.snapshot().runs.length,0);
  const before=h.adapter.requests.length;await h.ctx.taskSystem.taskReturns.deliver(message);assert.equal(h.adapter.requests.length,before);assert.equal((await events(h,'cold-checkin')).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,1);
 }finally{await h.dispose();}
});

test('busy responsible turn defers a check without steering, model calls or delivery budget consumption',async()=>{
 let started,release;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false},script:[async()=>{started();await gate;return'Current work done';},'Progress reviewed']});
 try{
  const {handle,task}=await draft(h,'busy-checkin');handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Actual current work'}]}));await ready;
  h.ledger.checkins.request('manual',task.taskId);const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];h.ctx.taskSystem.tick();await h.ctx.taskSystem.returnJob;
  assert.equal(h.adapter.requests.length,1);assert.equal(handle.agent.inbox.nextTurn.length+handle.agent.inbox.nextStep.length,0);assert.equal(h.ledger.checkins.view(task.taskId).deliveryFailures,0);assert.equal(h.ledger.getSessionMessage(message.messageId).deliveryAttempts,undefined);
  release();await handle.agent.whenIdle();h.ledger.clock=()=>Date.now()+60001;await h.ctx.taskSystem.taskReturns.deliver(message);assert.equal((await events(h,'busy-checkin')).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,1);
 }finally{release?.();await h.dispose();}
});

test('remote continuation envelope and exact owner update work without a project binding or execution workspace grant',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});let transport,pump,delivery;
 try{
  const {handle,task}=await draft(h,'remote-checkin');h.ledger.checkins.request('manual',task.taskId);await h.ctx.sessions.flush(handle.agent.session);await handle.dispose();transport=remote(h);
  const nextCheckAt=new Date(Date.now()+60000).toISOString();h.adapter.script.push('Checked remote request');
  delivery=new TaskReturnDelivery(h.ctx,async message=>(await transport.ledger.pendingSessionMessages('local',{kind:'continuation',messageId:message.messageId}))[0]);
  pump=new TaskReturnInbox(transport.ledger,'local',(message,signal)=>delivery.deliver(message,signal));await pump.poll();
  assert.equal(h.ledger.checkins.view(task.taskId).pendingMessageId,null);assert.equal((await events(h,'remote-checkin')).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,1);
  const response=await transport.ledger.projectCollaborate('local','update-remote',{action:'session',sessionId:'remote-checkin',cwd:h.dir,command:{kind:'checkin',input:{action:'update',commandId:'progress',taskId:task.taskId,observation:'waiting_external',summary:'Verified through authenticated remote authority',plan:{kind:'scheduled',nextCheckAt}}}});
  assert.equal(response.confirmed,true);assert.equal(h.ledger.checkins.view(task.taskId).nextCheckAt,nextCheckAt);
  await assert.rejects(transport.ledger.projectCollaborate('local','forged-owner',{action:'session',sessionId:'other-session',cwd:h.dir,command:{kind:'checkin',input:{action:'request',commandId:'forged',taskId:task.taskId}}}));
 }finally{await pump?.dispose();await delivery?.dispose();await transport?.dispose();await h.dispose();}
});

test('existing-agent model mismatch is visible and never overwrites its selected provider',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});
 try{
  const {handle,task}=await draft(h,'model-checkin');const stored=h.ledger.getTask(task.taskId);stored.dispatchOrigin.composition.model='different-model';h.ledger.managementDatabase().prepare("UPDATE entities SET data=? WHERE kind='task' AND id=?").run(JSON.stringify(stored),task.taskId);h.ledger.checkins.request('manual',task.taskId);const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];
  await assert.rejects(h.ctx.taskSystem.taskReturns.deliver(message),e=>e.code==='CHECKIN_COMPOSITION_UNAVAILABLE');assert.equal(handle.agent.options.model,'script');assert.equal(h.adapter.requests.length,0);
 }finally{await h.dispose();}
});


test('a user turn starting during final authority refresh cannot receive an injected check-in',async()=>{
 let started,release;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false},script:[async()=>{started();await gate;return'User work';}]});let delivery;
 try{
  const {handle,task}=await draft(h,'admission-race');h.ledger.checkins.request('manual',task.taskId);const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];let refreshes=0;
  delivery=new TaskReturnDelivery(h.ctx,async current=>{if(++refreshes===2){handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'New actual user turn'}]}));await ready;}return current;});
  await assert.rejects(delivery.deliver(message),e=>e.code==='CHECKIN_BUSY');assert.equal(h.adapter.requests.length,1);assert.equal(handle.agent.inbox.nextTurn.length+handle.agent.inbox.nextStep.length,0);assert.equal((await events(h,'admission-race')).filter(e=>e.type==='user/message'&&e.data.source.kind==='dsh-task-checkin').length,0);release();await handle.agent.whenIdle();
 }finally{release?.();await delivery?.dispose();await h.dispose();}
});

test('controller-owned check-in follows the actual per-message model rather than immutable Agent startup options',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false},script:['Seed selected model','Check-in processed']});
 try{
  const {attachProjectSessionHost}=await import('../../packages/task-system/test/fixtures/project-session-host.mjs');
  const {pinStewardTurnSelection}=await import('../../packages/task-system/dist/steward-turn-selection.js');
  await attachProjectSessionHost(h);h.adapter.listModels=async()=>[{id:'script'},{id:'selected'}];
  const id=SessionId('selected-model-checkin');
  const handle=await h.ctx.agents.create({sessionId:id,meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
  const resolved=await h.ctx.sessionController.resolveAgent(id);assert.equal(resolved.error,undefined);const agent=resolved.agent;
  pinStewardTurnSelection(agent,'selected-seed',{provider:'test-offline',model:'selected'});
  await h.ctx.sessionController.prompt({sessionId:id,requestId:'selected-seed',mode:'queue',content:[{type:'text',text:'Seed selected model'}]},AbortSignal.timeout(10000));
  await agent.whenIdle();assert.equal(agent.options.model,'script');assert.equal(agent.session.requestHeader().config.model,'selected');
  await call(h,agent,'task_create',{commandId:'selected-model-task',title:'Selected model check-in'});
  const task=h.ledger.snapshot().tasks[0];assert.equal(task.dispatchOrigin.composition.model,'selected');
  h.ledger.checkins.request('selected-model-request',task.taskId);
  const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];
  await h.ctx.taskSystem.taskReturns.deliver(message);
  assert.equal(h.adapter.requests.at(-1).model,'selected');assert.equal(h.adapter.requests.length,2);
  assert.equal(agent.options.model,'script','Delivery does not overwrite startup or global model');
  assert.equal(h.ctx.agentDefaultModel.currentSelection().model,'script');
  agent.session.append('model/selection',{provider:'test-offline',model:'script'});
  const another={...message,messageId:'new-selection-event',checkIn:{...message.checkIn,eventId:'new-selection-event'}};
  const changed=new TaskReturnDelivery(h.ctx);try{await assert.rejects(changed.deliver(another),e=>e.code==='CHECKIN_COMPOSITION_UNAVAILABLE');}finally{await changed.dispose();}
  assert.equal(h.adapter.requests.length,2,'New explicit model selection is preserved, not overwritten');
 }finally{await h.dispose();}
});

async function legacyDraft(h,id){
 const handle=await h.ctx.agents.create({sessionId:SessionId(id),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
 const off=handle.agent.ctx.tools.restrict({deny:['task_checkin','task_execution_status']});
 await call(h,handle.agent,'task_create',{commandId:'legacy-'+id,title:'Task '+id});off();
 return{handle,task:h.ledger.snapshot().tasks.find(task=>task.title==='Task '+id)};
}

test('manual task-center check advertises and runs scoped status first despite a legacy mask, then restores ordinary tools',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});try{
  const {handle,task}=await legacyDraft(h,'legacy-manual');assert.ok(!task.dispatchOrigin.composition.tools.includes('task_checkin'));
  const view=h.ledger.taskActionState(task.taskId);await h.ctx.taskSystem.projects.actOnTask({action:'check',commandId:'current-button',taskId:task.taskId,expectedVersion:view.version,runId:null,confirmationRevision:1});
  const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];assert.equal(message.checkIn.manualChecks[0].taskId,task.taskId);
  let status;h.ctx.on('tools/result',(exec,result)=>{if(exec.name==='task_checkin')status=result;});
  h.adapter.script.push(options=>{const tools=options.tools.map(tool=>tool.name);assert.ok(tools.includes('task_checkin'));assert.ok(!tools.includes('task_dispatch'));assert.ok(!tools.includes('task_session_message'));assert.ok(!tools.includes('read'));return{name:'task_checkin',args:{action:'status',taskId:task.taskId}};},()=>{assert.equal(status.isError,false,JSON.stringify(status));return 'CHECKED_WITHOUT_EXECUTION';});
  const receipt=await h.ctx.taskSystem.taskReturns.deliver(message);h.ledger.completeSessionMessage('ack-current-button',{messageId:message.messageId,nodeId:'local',state:'completed',...receipt});
  h.adapter.script.push(options=>{assert.ok(options.tools.some(tool=>tool.name==='task_dispatch'));assert.ok(options.tools.some(tool=>tool.name==='task_execution_status'));return 'ORDINARY_TOOLS_RESTORED';});
  handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'A separate ordinary user turn'}]}));await handle.agent.whenIdle();assert.equal(h.ledger.snapshot().runs.length,0);
 }finally{await h.dispose();}
});

test('old automatic capability snapshots hide unavailable check-in tools and use the available query instead',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});try{
  const {task}=await legacyDraft(h,'legacy-auto');h.ledger.clock=()=>Date.now()+31*60000;h.ledger.checkins.tick();
  const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];assert.equal(message.checkIn.automatic,true);assert.equal(message.checkIn.manualChecks,undefined);
  let result;h.ctx.on('tools/result',(exec,value)=>{if(exec.name==='task_query')result=value;});
  h.adapter.script.push(options=>{assert.ok(!options.tools.some(tool=>tool.name==='task_checkin'));assert.ok(!options.tools.some(tool=>tool.name==='task_execution_status'));return{name:'task_query',args:{taskId:task.taskId}};},()=>{assert.equal(result.isError,false);return 'OLD_SCOPE_FACTS_ONLY';});
  const receipt=await h.ctx.taskSystem.taskReturns.deliver(message);h.ledger.completeSessionMessage('ack-old-auto',{messageId:message.messageId,nodeId:'local',state:'completed',...receipt});assert.equal(h.ledger.snapshot().runs.length,0);
 }finally{await h.dispose();}
});

test('manual verification retains PTC transport with a task-scoped SDK and restores the ordinary surface',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});let undo;
 try{
  const req=createRequire(join(process.env.DSH_OFFICIAL_ROOT,'package.json'));
  for(const [id,name,config] of [
   ['check-fs','@deepseek-ai/dsh-fs-local',{cwd:h.dir}],
   ['check-directory','@deepseek-ai/dsh-working-directory',{defaultDirectory:h.dir}],
   ['check-sandbox','@deepseek-ai/dsh-sandbox-local'],
   ['check-policy','@deepseek-ai/dsh-sandbox-policy',{mode:'danger-full-access',workspaceRoot:h.dir}],
   ['check-subprocess','@deepseek-ai/dsh-subprocess-local'],
   ['check-ptc','@deepseek-ai/dsh-ptc-runtime-node'],
  ])await h.ctx.loader.create({id,name:pathToFileURL(req.resolve(name)).href,config});
  await h.ctx.loader.await();
  const {handle,task}=await legacyDraft(h,'ptc-manual');undo=handle.agent.ctx.tools.presentAs('ptc');
  await h.ctx.taskSystem.projects.actOnTask({action:'check',commandId:'ptc-current-button',taskId:task.taskId,expectedVersion:h.ledger.taskActionState(task.taskId).version,runId:null,confirmationRevision:1});
  const message=h.ledger.pendingSessionMessages('local',{kind:'continuation'})[0];let result;
  h.ctx.on('tools/result',(exec,value)=>{if(exec.name==='task_checkin')result=value;});
  h.adapter.script.push(options=>{
   assert.deepEqual(options.tools.map(tool=>tool.name),['run_code']);
   const prompt=options.messages.flatMap(message=>message.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
   assert.match(prompt,/JSON contracts:/);assert.match(prompt,/"name":"task_checkin"/);assert.doesNotMatch(prompt,/"name":"task_dispatch"/);
   return{name:'run_code',args:{code:'return await tools.task_checkin('+JSON.stringify({action:'status',taskId:task.taskId})+');',description:'Inspect only the authorized task'}};
  },()=>{assert.equal(result?.isError,false,JSON.stringify(result));return 'PTC_SOURCE_SCOPED_CHECK_DONE';});
  const receipt=await h.ctx.taskSystem.taskReturns.deliver(message);h.ledger.completeSessionMessage('ack-ptc-manual',{messageId:message.messageId,nodeId:'local',state:'completed',...receipt});
  assert.ok(handle.agent.ctx.tools.get('task_dispatch',handle.agent),'Ordinary capability restored');
  assert.ok(handle.agent.ctx.tools.schemas(handle.agent).some(tool=>tool.name==='run_code'),'Presentation unchanged');
  assert.equal(h.ledger.snapshot().runs.length,0);
 }finally{undo?.();await h.dispose();}
});

test('a failed check surface installation removes all partial guards and grants',async()=>{
 const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}});
 try{
  const {handle,task}=await legacyDraft(h,'failed-surface');
  const agent=handle.agent, originalOn=agent.ctx.on;
  agent.ctx.on=function(name,...args){if(name==='system-prompt/assemble')throw new Error('Synthetic hook installation failure');return originalOn.call(this,name,...args);};
  const message={messageId:'failed-install',checkIn:{automatic:false,manualChecks:[{taskId:task.taskId,commandId:'grant',runId:'run'}]}};
  try{assert.throws(()=>applyCheckinSurface(agent,message,[]),/Synthetic hook installation failure/);}finally{agent.ctx.on=originalOn;}
  assert.equal(manualCheckFor(agent,task.taskId,'run'),undefined);
  assert.ok(agent.ctx.tools.get('task_dispatch',agent));
  const status=await call(h,agent,'task_query',{taskId:task.taskId});assert.ok(status);
 }finally{await h.dispose();}
});
