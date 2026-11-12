import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {setSandboxMode} from '@deepseek-ai/dsh-sandbox-policy';
import {startHost} from '../ci/browser-native-project.mjs';
import {registerExecutor} from './executor-fixture.mjs';
const presets={'read-only':{sandbox:'read-only',approval:'never'},'workspace-write':{sandbox:'workspace-write',approval:'ask'},'danger-full-access':{sandbox:'danger-full-access',approval:'never'}};
async function fixture(){const host=await startHost({permissionPresets:presets});try{const req=createRequire(join(process.env.DSH_OFFICIAL_ROOT,'package.json'));await host.ctx.loader.create({id:'permission-native-files',name:pathToFileURL(req.resolve('@deepseek-ai/dsh-tool-fs')).href,config:{read:true,write:true,edit:false,readImage:false}});await host.ctx.loader.await();const permissions=host.ctx.taskSystem.steward.permissions,handle=await host.ctx.agents.create({sessionId:'permission-'+crypto.randomUUID(),agentOptions:{provider:'test-offline',model:'script'},meta:{cwd:host.directory}});return{...host,permissions,handle,agent:handle.agent,async close(){await handle.dispose();await host.close();}};}catch(error){await host.close();throw error;}}
function send(h,id,selection,text=id){h.permissions.arm(h.agent,id,selection);h.agent.followup(createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text}]}));}

test('actual native read-only policy governs a single claimed turn then restores before the next queued turn',{timeout:30000},async()=>{const h=await fixture();try{const path=join(h.directory,'readonly-denied.txt'),next=join(h.directory,'workspace-next.txt'),seen=[];h.ctx.on('agent/request',async(payload,next)=>{if(payload.agent===h.agent)seen.push(h.ctx.sandboxPolicy.resolve({session:h.agent.session}).mode);return next();});h.model.script.push({name:'write',args:{file_path:path,content:'DENIED'}},options=>{assert.match(JSON.stringify(options.messages),/read.only|READ_ONLY|sandbox|permission|denied/i);return 'READONLY_DONE';},{name:'write',args:{file_path:next,content:'PERMITTED'}},'NEXT_DONE');send(h,'readonly-turn',h.permissions.resolve('read-only'));send(h,'default-next',undefined);await h.agent.whenIdle();assert.equal(existsSync(path),false);assert.ok(existsSync(next),JSON.stringify({seen,requests:h.model.requests.map(r=>({tools:r.tools?.map(t=>t.name),messages:r.messages}))}));assert.equal(readFileSync(next,'utf8'),'PERMITTED');assert.deepEqual(seen,['read-only','read-only','workspace-write','workspace-write']);assert.equal(h.ctx.permissionPresets.current(h.agent.session),'workspace-write');assert.equal(h.ctx.agentDefaultModel.currentSelection().model,'script');assert.equal(h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT state FROM steward_turn_permissions WHERE request='readonly-turn'").get().state,'restored');}finally{await h.close();}});

test('restoration preserves a later explicit native permission change rather than overwriting it',{timeout:30000},async()=>{const h=await fixture();try{h.model.script.push(()=>{setSandboxMode(h.agent.session,'danger-full-access');return 'MANUAL_CHANGE';});send(h,'manual-change',h.permissions.resolve('read-only'));await h.agent.whenIdle();assert.equal(h.ctx.sandboxPolicy.resolve({session:h.agent.session}).mode,'danger-full-access');assert.equal(h.ctx.approval.overrideOf(h.agent.session),'ask');}finally{await h.close();}});

test('restore durability barrier retains the marker and blocks the next native model until acknowledged',{timeout:30000},async()=>{
 const h=await fixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();const flush=h.ctx.sessions.flush.bind(h.ctx.sessions);let held=false;
 try{
  h.ctx.sessions.flush=async session=>{if(session.id===h.agent.id&&!held&&h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT 1 FROM steward_turn_permissions WHERE request='flush-held' AND state='restoring'").get()){held=true;entered.resolve();await release.promise;}return flush(session);};
  const seen=[];h.ctx.on('agent/request',async(payload,next)=>{if(payload.agent===h.agent)seen.push({mode:h.ctx.sandboxPolicy.resolve({session:h.agent.session}).mode,approval:h.ctx.approval.overrideOf(h.agent.session)});return next();});
  h.model.script.push('HELD_END','ORDINARY_AFTER_ACK');send(h,'flush-held',h.permissions.resolve('read-only'));await entered.promise;
  assert.equal(h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT state FROM steward_turn_permissions WHERE request='flush-held'").get().state,'restoring');
  send(h,'after-held',undefined);await new Promise(resolve=>setImmediate(resolve));assert.equal(h.model.requests.length,1,'A later model cannot run while restoration lacks a native durability ACK');
  release.resolve();await h.agent.whenIdle();await h.permissions.drain();assert.deepEqual(seen,[{mode:'read-only',approval:'never'},{mode:'workspace-write',approval:'ask'}]);
  assert.equal(h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT state FROM steward_turn_permissions WHERE request='flush-held'").get().state,'restored');
 }finally{release.resolve();h.ctx.sessions.flush=flush;await h.close();}
});

test('an injected restoration write failure cannot leak temporary policy into a queued ordinary request',{timeout:30000},async()=>{
 const h=await fixture(),append=h.agent.session.append.bind(h.agent.session);let failed=false;
 try{
  h.agent.session.append=(type,data,...options)=>{if(!failed&&type==='sandbox/mode'&&data.mode==='workspace-write'){failed=true;throw Error('Injected restoration append failure');}return append(type,data,...options);};
  const seen=[];h.ctx.on('agent/request',async(payload,next)=>{if(payload.agent===h.agent)seen.push(h.ctx.sandboxPolicy.resolve({session:h.agent.session}).mode);return next();});
  h.model.script.push('FIRST_END','ORDINARY_SAFE');send(h,'restore-failure',h.permissions.resolve('read-only'));send(h,'ordinary-queued',undefined);await h.agent.whenIdle();await h.permissions.drain();
  if(h.model.requests.length===1){send(h,'ordinary-after-reconciliation',undefined);await h.agent.whenIdle();await h.permissions.drain();}
  assert.equal(failed,true);assert.deepEqual(seen,['read-only','workspace-write']);
 }finally{h.agent.session.append=append;await h.close();}
});

test('cold native resume restores a retained marker before releasing work after a failed restoration',{timeout:30000},async()=>{
 const h=await fixture(),append=h.agent.session.append.bind(h.agent.session);let resumed,restarted;
 try{
  h.agent.session.append=(type,data,...options)=>{if(type==='sandbox/mode'&&data.mode==='workspace-write')throw Error('Simulated crash before baseline write');return append(type,data,...options);};
  h.model.script.push('DURABLE_TEMP_TURN');send(h,'cold-restore',h.permissions.resolve('read-only'));await h.agent.whenIdle();await h.permissions.drain();
  assert.equal(h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT state FROM steward_turn_permissions WHERE request='cold-restore'").get().state,'restoring');
  assert.equal(h.ctx.sandboxPolicy.resolve({session:h.agent.session}).mode,'read-only');await h.ctx.sessions.flush(h.agent.session);await h.handle.dispose();
  const calls=h.model.requests.length;await h.ctx.fiber.dispose();
  const req=createRequire(join(process.env.DSH_OFFICIAL_ROOT,'package.json')),{runProfile}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh/profile-boot'))),{createLaunchEnvironmentSnapshot}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-launch-environment')));
  ({ctx:restarted}=await runProfile({profile:'project-native-browser',patchFiles:[],args:['--no-open'],environment:createLaunchEnvironmentSnapshot([{source:'process',values:{...process.env}}])}));restarted.llm.registerAdapter(['test-offline'],h.model);
  resumed=await restarted.agents.resume({resumeSessionId:h.agent.id,agentOptions:{provider:'test-offline',model:'script'}});
  assert.equal(h.model.requests.length,calls);assert.equal(restarted.permissionPresets.current(resumed.agent.session),'workspace-write');assert.equal(restarted.approval.overrideOf(resumed.agent.session),'ask');assert.equal(restarted.taskSystem.ledger.managementDatabase().prepare("SELECT state FROM steward_turn_permissions WHERE request='cold-restore'").get().state,'restored');
 }finally{await resumed?.dispose();await restarted?.fiber.dispose();await h.close();}
});

test('read-only managed requests deny dispatch and session-message writes, while the subsequent ordinary request can dispatch',{timeout:30000},async()=>{
 const h=await fixture();try{
  const service=h.ctx.taskSystem.steward,db=h.ctx.taskSystem.ledger.managementDatabase(),count=()=>Number(db.prepare("SELECT COUNT(*) n FROM entities WHERE kind='task'").get().n),before=count();
  const toolText=options=>JSON.stringify(options.messages.findLast(message=>message.role==='tool')?.content);
  const dispatch=options=>{const request=options.messages.findLast(message=>message.source?.kind==='user');return {name:'task_dispatch',args:{commandId:'project-message:'+request.source.rpcId,title:'天气数据采集',description:'采集天气数据',nodeId:'permission-worker'}};};
  const done=async id=>{for(let n=0;n<400;n++){const value=await service.reconcile({conversationId:'main',commandId:id});if(value.commandMessage?.state.kind==='completed')return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Managed policy turn did not finish');};
  h.model.script.push(dispatch,options=>{assert.match(toolText(options),/read-only/);return{name:'task_session_message',args:{action:'send',taskId:'not-a-real-task',nodeId:'local',sessionId:'not-a-session',commandId:'must-not-queue',text:'No side effect'}};},options=>{assert.match(toolText(options),/read-only/);return 'READONLY_NO_EFFECT';});
  await service.send({conversationId:'main',commandId:'readonly-dispatch',text:'请派任务收集天气数据',target:{kind:'project',projectId:h.created.projectId},permissionPreset:'read-only'});await done('readonly-dispatch');assert.equal(count(),before);
  registerExecutor(h.ctx.taskSystem.ledger,'permission-worker',{nodeId:'permission-worker',roles:['executor'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['permission-workspace'],enabled:true,lastSeenAt:new Date().toISOString()});h.model.script.push(dispatch,options=>{assert.doesNotMatch(toolText(options),/read-only/);return 'NORMAL_DISPATCH_ALLOWED';});await service.send({conversationId:'main',commandId:'normal-dispatch',text:'现在请派任务收集天气数据',target:{kind:'project',projectId:h.created.projectId}});await done('normal-dispatch');assert.equal(count(),before+1);
 }finally{await h.close();}
});

test('managed queue preserves each selected permission and snapshots the standing baseline only when its turn applies',{timeout:30000},async()=>{
 const h=await fixture(),entered=Promise.withResolvers(),release=Promise.withResolvers();try{
  const service=h.ctx.taskSystem.steward,seen=[];h.model.script.push(async options=>{seen.push(h.ctx.sandboxPolicy.resolve({session:h.ctx.agents.get(h.runtime.placementProject(h.created.projectId).session).session}).mode);entered.resolve();await release.promise;return 'QUEUED_FIRST';},()=>{const agent=h.ctx.agents.get(h.runtime.placementProject(h.created.projectId).session);seen.push(h.ctx.sandboxPolicy.resolve({session:agent.session}).mode);return 'QUEUED_SECOND';});
  await service.send({conversationId:'main',commandId:'permission-queue-a',text:'第一条仅查看',target:{kind:'project',projectId:h.created.projectId},permissionPreset:'workspace-write'});await entered.promise;
  const second={conversationId:'main',commandId:'permission-queue-b',text:'第二条仅查看',target:{kind:'project',projectId:h.created.projectId},permissionPreset:'read-only'};await service.send(second);second.permissionPreset='danger-full-access';
  const queued=service.store.commandMessage('main','permission-queue-b');assert.equal(queued.permission.preset,'read-only');assert.equal(JSON.parse(h.ctx.taskSystem.ledger.managementDatabase().prepare('SELECT permission FROM pr_turns WHERE command=?').get(service.store.requestId(queued.id)).permission).preset,'read-only');
  const agent=h.ctx.agents.get(h.runtime.placementProject(h.created.projectId).session);h.ctx.permissionPresets.set(agent.session,'danger-full-access');release.resolve();
  for(let n=0;n<400;n++){const value=await service.reconcile({conversationId:'main',commandId:'permission-queue-b'});if(value.commandMessage?.state.kind==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
  await service.permissions.drain();assert.deepEqual(seen,['workspace-write','read-only']);assert.equal(h.ctx.permissionPresets.current(agent.session),'danger-full-access','B restores the later legitimate standing choice, not a submit-time baseline');
 }finally{release.resolve();await h.close();}
});

test('changed native preset definitions fail closed before a previously captured request can execute',{timeout:30000},async()=>{
 const h=await fixture();try{
  h.permissions.arm(h.agent,'changed-catalog',h.permissions.resolve('read-only'));
  await [...h.ctx.loader.entries()].find(entry=>entry.options.name==='@deepseek-ai/dsh-permission-presets').update({config:{presets:{...presets,'read-only':{sandbox:'read-only',approval:'ask'}}}});await h.ctx.loader.await();
  h.agent.followup(createUserMessage({source:{kind:'user',rpcId:'changed-catalog'},content:[{type:'text',text:'This must not execute under changed semantics'}]}));await h.agent.whenIdle();await h.permissions.drain();
  assert.equal(h.model.requests.length,0);assert.equal(h.ctx.sandboxPolicy.resolve({session:h.agent.session}).mode,'workspace-write');
 }finally{await h.close();}
});

test('partial application restores custom effective policy when its raw preset name already equals the requested preset',{timeout:30000},async()=>{
 const h=await fixture(),set=h.ctx.permissionPresets.set.bind(h.ctx.permissionPresets);try{
  setSandboxMode(h.agent.session,'read-only');assert.equal(h.ctx.permissionPresets.current(h.agent.session),'custom');const original=structuredClone(h.ctx.sessionProjections.stateOf(h.agent.session,'permissions'));let fail=true;
  h.ctx.permissionPresets.set=(session,name)=>{set(session,name);if(session===h.agent.session&&name==='workspace-write'&&fail){fail=false;throw Error('Interrupted after native prefix, before active marker');}};
  send(h,'custom-partial',h.permissions.resolve('workspace-write'));await h.agent.whenIdle();await h.permissions.drain();
  assert.equal(fail,false);assert.equal(h.model.requests.length,0);assert.equal(h.ctx.sandboxPolicy.resolve({session:h.agent.session}).mode,'read-only');assert.deepEqual(h.ctx.sessionProjections.stateOf(h.agent.session,'permissions'),original);assert.equal(h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT state FROM steward_turn_permissions WHERE request='custom-partial'").get().state,'restored');
 }finally{h.ctx.permissionPresets.set=set;await h.close();}
});

test('false durability acknowledgments never retire a permission restoration or release a later model',{timeout:30000},async()=>{
 const h=await fixture(),flush=h.ctx.sessions.flush.bind(h.ctx.sessions);let refuse=true;
 try{
  h.ctx.sessions.flush=async session=>{if(refuse&&session.id===h.agent.id&&h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT 1 FROM steward_turn_permissions WHERE request='false-durability' AND state='restoring'").get())return false;return flush(session);};
  h.model.script.push('TEMP_DONE','SAFE_AFTER_DURABILITY');send(h,'false-durability',h.permissions.resolve('read-only'));await h.agent.whenIdle();await h.permissions.drain();assert.equal(h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT state FROM steward_turn_permissions WHERE request='false-durability'").get().state,'restoring');
  send(h,'ordinary-no-ack',undefined);await h.agent.whenIdle();assert.equal(h.model.requests.length,1);refuse=false;send(h,'ordinary-after-ack',undefined);await h.agent.whenIdle();await h.permissions.drain();assert.equal(h.model.requests.length,2);assert.equal(h.ctx.permissionPresets.current(h.agent.session),'workspace-write');
 }finally{refuse=false;h.ctx.sessions.flush=flush;await h.close();}
});

test('linked native sources retain observation list reads but deny every observation mutation in read-only requests',{timeout:30000},async()=>{
 const h=await fixture();try{
  const task=h.ctx.taskSystem,projectId=h.created.projectId,settings=task.ledger.projectExecutionSettings.read(projectId),catalog=await task.sessionPortal.executionSettings(projectId),workspace=catalog.coordinatorOptions.workspaces.find(row=>row.workspaceId===h.workspace.id);
  await task.sessionPortal.saveExecutionSettings({commandId:'native-observation-placement',projectId,expectedRevision:settings.revision,allowedNodeIds:null,executionBindings:{},coordinatorWorkspace:{kind:'registered',nodeId:'local',workspaceId:h.workspace.id,catalogRevision:workspace.catalogRevision}});
  const toolText=options=>JSON.stringify(options.messages.findLast(message=>message.role==='tool')?.content);
  h.model.script.push({name:'task_observations',args:{action:'list'}},options=>{assert.doesNotMatch(toolText(options),/read-only|Error:/);return{name:'task_observations',args:{action:'ignore',commandId:'no-ignore',candidateId:'missing'}};},options=>{assert.match(toolText(options),/read-only/);return{name:'task_observations',args:{action:'create',commandId:'no-create',candidateId:'missing'}};},options=>{assert.match(toolText(options),/read-only/);return{name:'task_observations',args:{action:'attach',commandId:'no-attach',candidateId:'missing',taskId:'missing'}};},options=>{assert.match(toolText(options),/read-only/);return 'OBSERVATION_READ_ONLY';});
  await task.steward.send({conversationId:'main',commandId:'readonly-observation',text:'只查看观察候选，不做变更',target:{kind:'project',projectId},permissionPreset:'read-only'});
  let completed=false;for(let n=0;n<400;n++){const value=await task.steward.reconcile({conversationId:'main',commandId:'readonly-observation'});if(value.commandMessage?.state.kind==='completed'){completed=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(completed,true);assert.equal(task.ledger.managementDatabase().prepare("SELECT COUNT(*) n FROM entities WHERE kind='task'").get().n,0);
 }finally{await h.close();}
});
