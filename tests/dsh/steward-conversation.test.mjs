import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import TitleService,{foldSessionTitle} from '@deepseek-ai/dsh-session-title';
import ProjectionCache from '@deepseek-ai/dsh-session-projection-cache';
import {createNativeHarness} from './native-harness.mjs';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

async function waitFor(service, predicate) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {
    const snapshot=await service.reconcile({conversationId:'main'});
    if(predicate(snapshot))return snapshot;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('Steward native turn did not reach its expected durable projection');
}
function requestText(request) {return JSON.stringify(request.messages);}
async function attachSidebar(h) {
  process.env.DSH_HOME=join(h.dir,'isolated-home');process.env.DSH_AGENTS_HOME=join(h.dir,'isolated-agents');
  const rows=[['query','dsh-session-query-sqlite',{path:join(h.dir,'query.sqlite'),openAt:'never'}],['typert','dsh-typert-registry'],['access','dsh-api-remote-access'],
    ['default-model','dsh-agent-default-model',{provider:'test-offline',model:'script'}],['fs','dsh-fs-local'],['attachment','dsh-attachment-local',{dshHome:join(h.dir,'isolated-home')}],
    ['commands','dsh-commands'],['credentials','dsh-credentials-local'],['connection','dsh-client-connection'],['uploads','dsh-client-file-upload'],
    ['storage','dsh-storage'],['storage-json','dsh-storage-json',{root:join(h.dir,'workspace-storage')}],['domain','dsh-storage-domain',{backend:'json'}],
    ['workspaces','dsh-workspace'],['working-directory','dsh-working-directory'],['controller','dsh-api-session-controller',{nativeOpen:false}]];
  for(const[id,name,config]of rows)await h.ctx.loader.create({id:'sidebar-'+id,name:'@deepseek-ai/'+name,config});
  await h.ctx.loader.await();assert.ok(h.ctx.sessionController);
  await h.ctx.plugin(TitleService,{fallbackMaxWords:10,fallbackMaxBytes:100,maxTitleBytes:512});
  await h.ctx.plugin(ProjectionCache,{writeEveryEvents:100,writeIntervalMs:10000});
  await h.ctx.fiber.ready;
}
async function sidebarRows(h) {return (await h.ctx.sessionController.list({},AbortSignal.timeout(5000))).items;}

test('opening an empty personal source creates one durable native session without a model and its first send resumes normally', {timeout:15000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-empty-source-'));
  let h=await createNativeHarness({dir,config:{role:'both',schedulerEnabled:false}});
  try {
    const input={conversationId:'main',scope:{kind:'personal'}};
    const sources=await Promise.all(Array.from({length:3},()=>h.ctx.taskSystem.steward.sourceSession(input)));
    assert.deepEqual(sources[0],sources[1]);assert.deepEqual(sources[1],sources[2]);
    const source=sources[0],id=source.binding.sessionId;
    assert.deepEqual(source.scope,input.scope);assert.equal(source.binding.nodeId,'local');
    const stored=await h.ctx.sessionPersistence.stat(id);
    assert.equal(stored.header.cwd,source.binding.cwd);
    const empty=await h.ctx.sessionPersistence.open(id,'read');
    try{const events=(await empty.read()).events;assert.equal(foldSessionTitle(events).title,'管家 · 闲聊');assert.ok(events.every(event=>event.type!=='turn/start'));}finally{await empty.close();}
    assert.equal(h.ctx.agents.get(id),undefined);assert.equal(h.adapter.requests.length,0);
    assert.equal(h.ctx.taskSystem.steward.snapshot({conversationId:'main'}).messages.length,0);
    await h.dispose();
    h=await createNativeHarness({dir,config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}},script:['First personal native reply']});
    assert.deepEqual(await h.ctx.taskSystem.steward.sourceSession(input),source);
    assert.equal((await h.ctx.sessionPersistence.stat(id)).header.createdAt,stored.header.createdAt);
    await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'first-after-source-view',text:'FIRST_SOURCE_VIEW_INPUT',target:input.scope});
    const snapshot=await waitFor(h.ctx.taskSystem.steward,s=>s.messages.some(message=>message.text==='First personal native reply'));
    assert.equal(snapshot.messages.find(message=>message.role==='user').source.sessionId,id);
    assert.equal(h.adapter.requests.length,1);assert.match(requestText(h.adapter.requests[0]),/FIRST_SOURCE_VIEW_INPUT/);
  }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('personal source has durable native sidebar membership and title through restart, preserving a human rename and archive choice', {timeout:15000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-sidebar-'));
  const config={role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}};
  let h=await createNativeHarness({dir,config});
  try {
    await attachSidebar(h);
    const input={conversationId:'main',scope:{kind:'personal'}},source=await h.ctx.taskSystem.steward.sourceSession(input),id=source.binding.sessionId;
    const member=()=>h.ctx.workspaceRegistry.list().some(workspace=>workspace.sessionIds.includes(id));
    assert.equal(member(),true);
    const first=(await sidebarRows(h)).find(row=>row.sessionId===id);
    assert.ok(first,'Actual session/list includes the cold empty source');
    assert.equal(first.projections.values.title,'管家 · 闲聊');assert.equal(h.adapter.requests.length,0);
    await h.ctx.sessionController.rename({sessionId:id,title:'我的管家名字'},AbortSignal.timeout(5000));
    const renamed=h.ctx.sessions.get(id);await h.ctx.sessions.flush(renamed);await h.ctx.sessionProjectionCache.write(renamed);
    await h.ctx.workspaceRegistry.archiveSession(id);
    await h.ctx.taskSystem.steward.sourceSession(input);
    assert.ok(h.ctx.workspaceRegistry.archivedSessionIds.includes(id),'Opening the source never reverses a human archive');
    await h.ctx.workspaceRegistry.unarchiveSession(id);
    await h.dispose();h=await createNativeHarness({dir,config});await attachSidebar(h);
    assert.equal(member(),true,'The official workspace registry restores membership without reopening the source');
    const restored=(await sidebarRows(h)).find(row=>row.sessionId===id);
    assert.ok(restored);assert.equal(restored.projections.values.title,'我的管家名字');
    await h.ctx.taskSystem.steward.sourceSession(input);
    assert.equal((await h.ctx.sessionQuery.readTitleSnapshot(id)).title.title,'我的管家名字');
    assert.equal(h.adapter.requests.length,0);
  }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('native browse, controller open and first steward send share one borrowed Agent without model/default changes or disposal', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'separate-configured-route',model:'unused'}}});
  try {
    await attachSidebar(h);const service=h.ctx.taskSystem.steward,input={conversationId:'main',scope:{kind:'personal'}};
    let created=0;h.ctx.on('agent/created',()=>created++);
    const [source,duplicate]=await Promise.all([service.sourceSession(input),service.sourceSession(input)]);
    assert.deepEqual(source,duplicate);assert.equal(created,1);assert.equal(h.adapter.requests.length,0);
    const id=source.binding.sessionId,agent=h.ctx.agents.get(id),before=h.ctx.agentDefaultModel.currentSelection();
    assert.ok(agent,'Source browsing activates the exact native Agent required by Memory and Skills');
    let defaultSaves=0;const save=h.ctx.agentDefaultModel.saveSelection.bind(h.ctx.agentDefaultModel);
    h.ctx.agentDefaultModel.saveSelection=async(...args)=>{defaultSaves++;return save(...args);};
    h.adapter.script.push('Only one native steward reply');
    await Promise.all([service.sourceSession(input),h.ctx.sessionController.resolveAgent(id),
      service.send({conversationId:'main',commandId:'shared-first-send',text:'SHARED_NATIVE_FIRST_SEND',target:input.scope})]);
    await waitFor(service,s=>s.messages.some(message=>message.text==='Only one native steward reply'));
    assert.equal(created,1);assert.equal(h.adapter.requests.length,1);
    assert.equal(h.adapter.requests[0].provider,'test-offline','A borrowed native Agent retains its native model selection');
    assert.equal(defaultSaves,0);assert.deepEqual(h.ctx.agentDefaultModel.currentSelection(),before);
    await service.close();
    assert.equal(h.ctx.agents.get(id),agent,'Closing the steward does not dispose the native-controller-owned Agent');
    assert.equal(agent.status,'idle');
    h.adapter.script.push('Native session remains usable');
    const {createUserMessage}=await import('@deepseek-ai/dsh-llm');
    agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'AFTER_STEWARD_CLOSE'}]}));
    await agent.whenIdle();assert.equal(h.adapter.requests.length,2);
  }finally{await h.dispose();}
});

test('a concurrent source view borrows the matching Agent activated after its retained cold revision', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  const firstEntered=Promise.withResolvers(),secondEntered=Promise.withResolvers(),firstRelease=Promise.withResolvers(),secondRelease=Promise.withResolvers();
  try {
    const service=h.ctx.taskSystem.steward,input={conversationId:'main',scope:{kind:'personal'}},source=await service.sourceSession(input);
    await attachSidebar(h);const observe=h.ctx.sessionQuery.observeSession.bind(h.ctx.sessionQuery);let calls=0,created=0;
    h.ctx.on('agent/created',()=>created++);
    h.ctx.sessionQuery.observeSession=async(...args)=>{
      const observation=await observe(...args),call=++calls;
      if(call===1){firstEntered.resolve();await firstRelease.promise;}
      if(call===2){secondEntered.resolve();await secondRelease.promise;}
      return observation;
    };
    const first=service.sourceSession(input);await firstEntered.promise;
    const second=service.sourceSession(input);await secondEntered.promise;
    firstRelease.resolve();assert.deepEqual(await first,source);
    const agent=h.ctx.agents.get(source.binding.sessionId);await h.ctx.sessions.flush(agent.session);
    secondRelease.resolve();assert.deepEqual(await second,source);
    assert.equal(h.ctx.agents.get(source.binding.sessionId),agent);assert.equal(created,1);assert.equal(h.adapter.requests.length,0);
    assert.deepEqual(service.store.current('main'),{kind:'workbench'});
  }finally{firstRelease.resolve();secondRelease.resolve();await h.dispose();}
});

test('an initial flush failure retains borrowed steward tool restrictions until the admitted native turn becomes idle', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  try {
    await attachSidebar(h);const service=h.ctx.taskSystem.steward,source=await service.sourceSession({conversationId:'main',scope:{kind:'personal'}});
    const agent=h.ctx.agents.get(source.binding.sessionId);assert.ok(h.ctx.tools.get('task_query',agent));
    const flush=h.ctx.sessions.flush.bind(h.ctx.sessions);let fail=true;
    h.ctx.sessions.flush=async session=>{if(fail&&session.id===agent.id){fail=false;throw new Error('Injected initial admission flush failure');}return flush(session);};
    h.adapter.script.push(async()=>{entered.resolve();await release.promise;return 'Held borrowed turn finished';});
    const sending=service.send({conversationId:'main',commandId:'borrowed-flush-failure',text:'KEEP_SCOPE_THROUGH_FLUSH_FAILURE',target:{kind:'personal'}});
    await entered.promise;await sending;
    assert.equal(h.ctx.tools.get('task_query',agent),undefined,'The live admitted turn retains its steward restriction after flush failure');
    assert.ok(h.ctx.tools.get('steward_recall',agent));assert.equal(h.ctx.agents.get(agent.id),agent);
    release.resolve();
    await waitFor(service,s=>s.messages.some(message=>message.text==='Held borrowed turn finished')&&!!h.ctx.tools.get('task_query',agent));
    assert.equal(agent.status,'idle');assert.equal(h.ctx.agents.get(agent.id),agent);assert.equal(h.adapter.requests.length,1);
  }finally{release.resolve();await h.dispose();}
});

test('opening cold pending, incomplete and canonically uncertain sources never resumes or replays native work', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false}});
  try {
    const service=h.ctx.taskSystem.steward,inputs=[];
    const {Session}=await import('@deepseek-ai/dsh-session'),{createUserMessage}=await import('@deepseek-ai/dsh-llm');
    for(const kind of ['pending','incomplete','uncertain']) {
      const input={conversationId:kind,scope:{kind:'personal'}},source=await service.sourceSession(input),id=source.binding.sessionId;
      if(kind==='uncertain')service.store.accept({conversationId:kind,commandId:'unknown-native-wait',text:'UNKNOWN_WAIT',target:input.scope},input.scope,source.binding,-1);
      else {
        const handle=await h.ctx.sessionPersistence.open(id,'write');
        try {
          const read=await handle.read(),session=Session.fromRestore(id,read.events,handle.header,handle.inheritedEventCount,read.eventState,h.ctx.sessions.messageProjections);
          if(kind==='incomplete')session.append('turn/start',{turn:1});
          else session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'DO_NOT_REPLAY_PENDING_INPUT'}]})]});
          await handle.append(session.snapshotEvents().slice(read.events.length));await handle.flush();
        }finally{await handle.close();}
      }
      const reader=await h.ctx.sessionPersistence.open(id,'read');
      try{inputs.push({input,id,before:(await reader.read()).events});}finally{await reader.close();}
    }
    await attachSidebar(h);let created=0;h.ctx.on('agent/created',()=>created++);
    for(const {input,id,before} of inputs) {
      await assert.rejects(service.sourceSession(input),{code:'UNAVAILABLE'},input.conversationId);
      assert.equal(h.ctx.agents.get(id),undefined);
      const reader=await h.ctx.sessionPersistence.open(id,'read');
      try{assert.deepEqual((await reader.read()).events,before,'A rejected view leaves native history and inbox untouched');}finally{await reader.close();}
    }
    assert.equal(created,0);assert.equal(h.adapter.requests.length,0);
  }finally{await h.dispose();}
});

test('project source activation is tracked through steward shutdown and never disposes the borrowed native Agent', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  try {
    await attachSidebar(h);const service=h.ctx.taskSystem.steward,projects=h.ctx.taskSystem.projects;
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const project=await projects.create({commandId:'view-close-project',title:'View close project',goal:'Source lifecycle'}),id=projects.placementProject(project.projectId).session;
    const resolveAgent=h.ctx.sessionController.resolveAgent.bind(h.ctx.sessionController);
    h.ctx.sessionController.resolveAgent=async(...args)=>{entered.resolve();await release.promise;return resolveAgent(...args);};
    const opening=service.sourceSession({conversationId:'main',scope:{kind:'project',projectId:project.projectId}});
    await entered.promise;assert.equal(service.active,true);
    let closed=false;const closing=service.close().then(()=>{closed=true;});
    await new Promise(done=>setImmediate(done));assert.equal(closed,false,'Shutdown waits for project source activation too');
    const rejected=assert.rejects(opening,{code:'UNAVAILABLE'});release.resolve();await rejected;await closing;
    assert.ok(h.ctx.agents.get(id),'The native controller owns the activation handle');assert.equal(h.adapter.requests.length,0);
  }finally{release.resolve();await h.dispose();}
});

test('native source selection enforces personal metadata and the current authorized project generation', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try {
    const task=h.ctx.taskSystem,service=task.steward,projects=task.projects;
    const key=createHash('sha256').update(task.ledger.schedulerIdentity()+':tampered').digest('hex').slice(0,32);
    const {SESSION_FORMAT_VERSION}=await import('@deepseek-ai/dsh-session');
    const handle=await h.ctx.sessionPersistence.create({version:SESSION_FORMAT_VERSION,id:`steward-personal-${key}`,createdAt:Date.now(),cwd:join(h.dir,'wrong-source'),isSeeded:false,delegationDepth:0});
    try{await handle.flush();}finally{await handle.close();}
    await assert.rejects(service.sourceSession({conversationId:'tampered',scope:{kind:'personal'}}),{code:'FORBIDDEN'});
    await assert.rejects(service.sourceSession({conversationId:'main',scope:{kind:'project',projectId:'not-authorized'}}),{code:'FORBIDDEN'});
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const project=await projects.create({commandId:'source-view-project',title:'Source view project',goal:'Native source generation'});
    const topics=service.snapshot({conversationId:'main'}).topicActivity;
    assert.equal(topics.activeDays,30);assert.equal(topics.latestMessage,null);
    assert.ok(topics.items.some(item=>item.scope.kind==='project'&&item.scope.projectId===project.projectId),'A new topic is selectable before its first canonical message');
    const input={conversationId:'main',scope:{kind:'project',projectId:project.projectId}};
    const first=await service.sourceSession(input);
    const token=service.snapshot({conversationId:'main'}).projects.find(item=>item.projectId===project.projectId).bindingToken;
    assert.match(token,/^[a-f0-9]{64}$/);
    assert.equal(service.snapshot({conversationId:'main'}).projects.find(item=>item.projectId===project.projectId).bindingToken,token);
    assert.equal(first.binding.sessionId,projects.placementProject(project.projectId).session);
    assert.equal(first.binding.generation,1);
    await projects.handoff(project.projectId);
    const second=await service.sourceSession(input);
    const currentToken=service.snapshot({conversationId:'main'}).projects.find(item=>item.projectId===project.projectId).bindingToken;
    assert.notEqual(currentToken,token,'The same topic publishes a new current-binding token after handoff');
    assert.equal(second.binding.generation,2);assert.notEqual(second.binding.sessionId,first.binding.sessionId);
    const bindingForRead=task.sessionPortal.bindingForRead.bind(task.sessionPortal);
    let rotate=true;
    task.sessionPortal.bindingForRead=async(...args)=>{
      const binding=await bindingForRead(...args);
      if(rotate){rotate=false;await projects.handoff(project.projectId);}
      return binding;
    };
    await assert.rejects(service.sourceSession(input),{code:'CONFLICT'});
    assert.equal(projects.placementProject(project.projectId).generation,3);
    assert.equal(h.adapter.requests.length,0,'Opening sources and rotating empty sessions never invokes the model');
    assert.equal(service.snapshot({conversationId:'main'}).messages.length,0);
  }finally{await h.dispose();}
});

test('active topic days use the live plugin setting with a default and validated integral bounds', async()=>{
  const {Config,LIVE_SETTING_KEYS}=await import('../../packages/task-system/dist/dsh-plugin.js');
  assert.equal(Config({}).stewardActiveDays.get(),30);assert.ok(LIVE_SETTING_KEYS.includes('stewardActiveDays'));
  assert.equal(Config({stewardActiveDays:1}).stewardActiveDays.get(),1);
  assert.equal(Config({stewardActiveDays:365}).stewardActiveDays.get(),365);
  for(const stewardActiveDays of [0,366,1.5])assert.throws(()=>Config({stewardActiveDays}));
});

test('official Loader Settings changes active topic days live and persists the value across an isolated Host restart', {timeout:15000}, async()=>{
  const {boot,initProfile,readProfilePatches}=await import('@deepseek-ai/dsh-app-boot');
  const require=createRequire(resolve('package.json'));
  const dir=mkdtempSync(join(tmpdir(),'steward-topic-settings-')),home=join(dir,'home'),profileDir=join(home,'profiles','steward');
  mkdirSync(home,{recursive:true});initProfile(profileDir,[]);symlinkSync(resolve('node_modules'),join(profileDir,'node_modules'),'dir');
  const profile={name:'steward',dir:profileDir,patchPath:join(profileDir,'cordis.patch.yml'),installAnchor:resolve('package.json'),cwd:dir,home,startedBundles:[],overlays:[],telemetryDisabledEnv:'1'};
  const rows=[['config-editor','@deepseek-ai/dsh-config-editor'],['settings','@deepseek-ai/dsh-settings'],
    ['llm','@deepseek-ai/dsh-llm'],['sessions','@deepseek-ai/dsh-session'],['sessionProjections','@deepseek-ai/dsh-session-projection'],
    ['systemPrompt','@deepseek-ai/dsh-system-prompt'],['tools','@deepseek-ai/dsh-tools'],['agents','@deepseek-ai/dsh-agent'],
    ['persistence','@deepseek-ai/dsh-session-persistence-jsonl',{root:join(dir,'sessions'),compression:'none'}],['agentLoop','@deepseek-ai/dsh-agent-loop',{agents:[]}],
    ['task-system',pathToFileURL(resolve('packages/task-system/dist/dsh-plugin.js')).href,{role:'both',nodeId:'local',schedulerEnabled:false,keepAlive:false,databasePath:join(dir,'tasks.sqlite')}]]
    .map(([id,name,config])=>({id,name:name.startsWith('@')?pathToFileURL(require.resolve(name)).href:name,config}));
  writeFileSync(profile.patchPath,JSON.stringify([{insert:rows}]));const root=join(profileDir,'cordis.yml');writeFileSync(root,'[]\n');
  const start=()=>boot('steward-settings-test',root,readProfilePatches('steward-settings-test',profile),ctx=>ctx.provide('profileContext',profile));
  let ctx,stage='boot';
  try {
    ctx=await start();stage='describe';const task=ctx.taskSystem,original=task.steward.snapshot({conversationId:'main'}).topicActivity;
    assert.equal(original.activeDays,30);assert.equal(Date.parse(original.observedAt)-Date.parse(original.cutoffAt),30*86400000);
    const settings=ctx.settings.describe().find(item=>item.ns==='task-system');assert.ok(settings);
    assert.equal(settings.value.stewardActiveDays,30);
    stage='mutate';await ctx.settings.mutate('task-system',[{op:'set',path:['stewardActiveDays'],value:1}],settings.revision);
    assert.equal(ctx.taskSystem.steward,task.steward,'Editing the live setting does not replace the running steward');
    const changed=task.steward.snapshot({conversationId:'main'}).topicActivity;
    assert.equal(changed.activeDays,1);assert.equal(Date.parse(changed.observedAt)-Date.parse(changed.cutoffAt),86400000);
    assert.match(readFileSync(profile.patchPath,'utf8'),/stewardActiveDays[\s\S]*1/);
    stage='restart';await ctx.fiber.dispose();ctx=await start();
    assert.equal(ctx.settings.describe().find(item=>item.ns==='task-system').value.stewardActiveDays,1);
    const restored=ctx.taskSystem.steward.snapshot({conversationId:'main'}).topicActivity;
    assert.equal(restored.activeDays,1);assert.equal(Date.parse(restored.observedAt)-Date.parse(restored.cutoffAt),86400000);
  }catch(error){throw new Error(`Isolated settings ${stage} failed`,{cause:error});}finally{if(ctx)await ctx.fiber.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('concurrent source reads and first send await empty-session durability, and a failed creation can retry', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}},script:['Durable first reply']});
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  try {
    const service=h.ctx.taskSystem.steward,persistence=h.ctx.sessionPersistence;
    const create=persistence.create.bind(persistence);
    let pause=true,fail=false;
    persistence.create=async(...args)=>{
      const handle=await create(...args),flush=handle.flush.bind(handle);
      handle.flush=async()=>{
        if(pause){pause=false;entered.resolve();await release.promise;}
        if(fail){fail=false;throw new Error('Injected source durability failure');}
        await flush();
      };
      return handle;
    };
    const input={conversationId:'main',scope:{kind:'personal'}};
    const first=service.sourceSession(input);await entered.promise;
    let secondResolved=false;
    const second=service.sourceSession(input).then(source=>{secondResolved=true;return source;});
    const send=service.send({conversationId:'main',commandId:'send-during-source-create',text:'DURABILITY_BARRIER_INPUT',target:input.scope});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(secondResolved,false,'A second source request waits for the creator durability barrier');
    assert.equal(h.adapter.requests.length,0,'The first send also waits instead of opening the pending log');
    release.resolve();
    const [source,other]=await Promise.all([first,second,send]);assert.deepEqual(source,other);
    await waitFor(service,s=>s.messages.some(message=>message.text==='Durable first reply'));
    assert.equal(h.adapter.requests.length,1);
    fail=true;
    const retry={conversationId:'retry-after-failed-source',scope:{kind:'personal'}};
    await assert.rejects(service.sourceSession(retry),/Injected source durability failure/);
    const recovered=await service.sourceSession(retry);
    const readable=await persistence.open(recovered.binding.sessionId,'read');
    try{assert.equal(foldSessionTitle((await readable.read()).events).title,'管家 · 闲聊');}finally{await readable.close();}
  }finally{release.resolve();await h.dispose();}
});

test('one canonical steward conversation routes personal/A/B/personal and an old reply to independent real native histories', {timeout:30000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try {
    const task=h.ctx.taskSystem,projects=task.projects;
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const a=await projects.create({commandId:'steward-create-a',title:'Project A',goal:'A_ONLY_GOAL'});
    const b=await projects.create({commandId:'steward-create-b',title:'Project B',goal:'B_ONLY_GOAL'});
    const service=task.steward;
    assert.ok(service,'Actual task service must mount steward');
    const send=async(commandId,text,target,expected,replyTo)=>{
      h.adapter.script.push(expected);
      await service.send({conversationId:'main',commandId,text,...(target?{target}:{}),...(replyTo?{replyTo}:{})});
      return waitFor(service,s=>s.messages.some(message=>message.role==='assistant'&&message.text===expected));
    };
    await send('personal-1','PERSONAL_ONLY_ONE',{kind:'personal'},'Personal response one');
    let snapshot=await send('project-a-1','A_ONLY_REQUEST',{kind:'project',projectId:a.projectId},'A response one');
    const aReply=snapshot.messages.find(message=>message.role==='assistant'&&message.text==='A response one');
    await send('project-b-1','B_ONLY_REQUEST',{kind:'project',projectId:b.projectId},'B response one');
    await send('personal-2','PERSONAL_ONLY_TWO',{kind:'personal'},'Personal response two');
    snapshot=await send('reply-a','A_REPLY_REQUEST',undefined,'A response two',aReply.id);
    assert.equal(snapshot.conversationId,'main');
    assert.equal(snapshot.messages.filter(message=>message.role==='user').length,5);
    const reply=snapshot.messages.find(message=>message.role==='user'&&message.text==='A_REPLY_REQUEST');
    assert.equal(reply.replyTo,aReply.id);assert.deepEqual(reply.scope,{kind:'project',projectId:a.projectId});
    const requests=h.adapter.requests;
    assert.equal(requests.length,5,'There is no mandatory extra steward LLM hop');
    assert.match(requestText(requests[0]),/PERSONAL_ONLY_ONE/);assert.doesNotMatch(requestText(requests[0]),/A_ONLY|B_ONLY/);
    assert.match(requestText(requests[1]),/A_ONLY_REQUEST/);assert.doesNotMatch(requestText(requests[1]),/PERSONAL_ONLY|B_ONLY/);
    assert.match(requestText(requests[2]),/B_ONLY_REQUEST/);assert.doesNotMatch(requestText(requests[2]),/PERSONAL_ONLY|A_ONLY/);
    assert.match(requestText(requests[3]),/PERSONAL_ONLY_ONE.*PERSONAL_ONLY_TWO/);assert.doesNotMatch(requestText(requests[3]),/A_ONLY|B_ONLY/);
    assert.match(requestText(requests[4]),/A_ONLY_REQUEST.*A_REPLY_REQUEST/);assert.doesNotMatch(requestText(requests[4]),/PERSONAL_ONLY|B_ONLY/);
    const userMessages=snapshot.messages.filter(message=>message.role==='user');
    assert.equal(new Set(userMessages.map(message=>message.source.sessionId)).size,3);
    assert.equal(userMessages[0].source.sessionId,userMessages[3].source.sessionId);
    assert.equal(userMessages[1].source.sessionId,userMessages[4].source.sessionId);
    const before=requests.length;
    await service.send({conversationId:'main',commandId:'reply-a',text:'A_REPLY_REQUEST',replyTo:aReply.id});
    assert.equal(h.adapter.requests.length,before,'Exact accepted retry must not create another model request');
    await assert.rejects(async()=>service.send({conversationId:'main',commandId:'reply-a',text:'changed',replyTo:aReply.id}),/changed|reused|conflict/i);
    const restored=await service.snapshot({conversationId:'main'});
    assert.deepEqual(restored.messages.map(message=>message.id),snapshot.messages.map(message=>message.id));
  } finally {await h.dispose();}
});

test('project PM dispatches to the same machine native executor; late task notifications keep their project and do not switch the visible scope', {timeout:30000}, async()=>{
  const {registerExecutor}=await import('./executor-fixture.mjs');
  const dir=mkdtempSync(join(tmpdir(),'steward-worker-sidebar-'));
  const config={role:'both',schedulerEnabled:false,autoExecute:false,projectAgentOptions:{provider:'test-offline',model:'script'},localNode:{models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true}};
  let h=await createNativeHarness({dir,executionRoot:true,config});
  try {
    await attachSidebar(h);
    registerExecutor(h.ledger,'steward-local-node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
    h.ledger.recordNodeHeartbeat('steward-local-ready',{nodeId:'local',runtimeReady:true,activeExecutions:0});
    const projects=h.ctx.taskSystem.projects,service=h.ctx.taskSystem.steward;
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const {projectId}=await projects.create({commandId:'local-project',title:'Local project',goal:'One local coordinator and executor'});
    h.adapter.script.push(options=>{
      const match=requestText(options).match(/commandId=\\"(project-message:[^\\"]+)\\"/);
      assert.ok(match,'Managed PM prompt supplies its authoritative stable dispatch command');
      return {name:'task_dispatch',args:{commandId:match[1],title:'Steward same-machine task',description:'Produce the explicit offline native fixture report',nodeId:'local'}};
    },'Local task registered');
    await service.send({conversationId:'main',commandId:'local-dispatch',text:'LOCAL_DISPATCH_MARKER',target:{kind:'project',projectId}});
    await waitFor(service,s=>s.messages.some(message=>message.text==='Local task registered'));
    projects.tick();
    const task=h.ledger.snapshot().tasks.find(task=>task.title==='Steward same-machine task');
    assert.ok(task,'PM used the real task_dispatch tool');
    const run=h.ledger.history(task.taskId).runs.at(-1);assert.ok(run,'Host admitted an actual Run');
    assert.equal(run.route.nodeId,'local');
    h.adapter.script.push('Personal while worker pending');
    await service.send({conversationId:'main',commandId:'personal-while-task',text:'PERSONAL_PENDING_TASK_MARKER',target:{kind:'personal'}});
    await waitFor(service,s=>s.messages.some(message=>message.text==='Personal while worker pending'));
    const claim=h.ledger.claim('steward-native-local-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
    h.adapter.script.push({name:'task_submit_result',args:{outcome:'success',summary:'Actual local native fixture chain completed',reportTitle:'Local execution evidence',reportBody:'Task dispatch, claim, native AgentLoop and scoped result tool executed on the same isolated host.'}});
    const result=await h.ctx.taskSystem.native.execute(claim);
    assert.equal(result.run.state,'succeeded');assert.ok(result.sessionId);
    assert.equal(h.ledger.history(task.taskId).reports.filter(report=>report.kind==='result').length,1);
    const snapshot=await waitFor(service,s=>s.messages.some(message=>message.role==='notification'&&message.provenance?.eventType==='run.settled'));
    assert.deepEqual(snapshot.currentScope,{kind:'personal'});
    const notifications=snapshot.messages.filter(message=>message.role==='notification');
    assert.ok(notifications.length);assert.ok(notifications.every(message=>message.scope.kind==='project'&&message.scope.projectId===projectId));
    assert.equal(notifications.filter(message=>message.provenance?.eventType==='report.appended').length,0,'Initial task request and terminal result report do not duplicate the settled notification');
    const again=await service.reconcile({conversationId:'main'});
    assert.deepEqual(again.messages.filter(message=>message.role==='notification').map(message=>message.id),notifications.map(message=>message.id));
    assert.equal(service.store.isStewardTask(task.taskId),true);
    const pm=projects.placementProject(projectId).session,worker=result.sessionId;
    for(const id of [pm,worker]) {
      assert.ok(h.ctx.workspaceRegistry.list().some(workspace=>workspace.sessionIds.includes(id)),'Actual PM and executor have native workspace membership');
      const row=(await sidebarRows(h)).find(row=>row.sessionId===id);assert.ok(row);
      assert.match(row.projections?.values.title??'',/^管家/,'The native sidebar row carries the prefixed display title');
      assert.match((await h.ctx.sessionQuery.readTitleSnapshot(id)).title.title,/^管家/);
    }
    await h.dispose();h=await createNativeHarness({dir,executionRoot:true,config});await attachSidebar(h);
    const restored=await sidebarRows(h);
    for(const id of [pm,worker]) {
      assert.ok(restored.some(row=>row.sessionId===id),'Actual native catalog restores PM and executor without reopening the steward');
      assert.match(restored.find(row=>row.sessionId===id).projections?.values.title??'',/^管家/);
      assert.ok(h.ctx.workspaceRegistry.list().some(workspace=>workspace.sessionIds.includes(id)),'Native sidebar membership survives a Host restart');
      assert.match((await h.ctx.sessionQuery.readTitleSnapshot(id)).title.title,/^管家/);
    }
    assert.equal(h.adapter.requests.length,0,'Restoring sidebar metadata does not rerun work');
  }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});


test('a recreated host restores the canonical log without replay and old project replies follow the authority current generation', {timeout:30000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-restart-'));
  const config={role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}};
  let h=await createNativeHarness({dir,config});
  try {
    h.ctx.taskSystem.projects.saveSettings({root:join(dir,'projects'),expectedRevision:0});
    const {projectId}=await h.ctx.taskSystem.projects.create({commandId:'restart-project',title:'Persistent project',goal:'PERSISTENT_PROJECT_GOAL'});
    const input={conversationId:'main',commandId:'before-restart',text:'BEFORE_RESTART_MARKER',target:{kind:'project',projectId}};
    h.adapter.script.push('Before restart response');
    await h.ctx.taskSystem.steward.send(input);
    const original=await waitFor(h.ctx.taskSystem.steward,s=>s.messages.some(message=>message.text==='Before restart response'));
    const reply=original.messages.find(message=>message.text==='Before restart response');
    await h.dispose();h=await createNativeHarness({dir,config});
    const restored=await h.ctx.taskSystem.steward.reconcile({conversationId:'main'});
    assert.deepEqual(restored.messages.map(message=>message.id),original.messages.map(message=>message.id));
    await h.ctx.taskSystem.steward.send(input);assert.equal(h.adapter.requests.length,0,'Restart does not replay an admitted message');
    const taskIds=[];
    for(let i=0;i<120;i++) {
      const task=h.ledger.createTask(`large-continuation-task-${i}`,{title:`Existing original task ${i}`,description:'PRIVATE_TASK_DESCRIPTION_'.repeat(300)}).value;
      taskIds.push(task.taskId);h.ctx.taskSystem.projects.linkTask(reply.source.sessionId,task.taskId);
      h.ledger.appendReport(`large-continuation-report-${i}`,{taskId:task.taskId,title:`Prior result ${i}`,body:'PRIVATE_FULL_REPORT_BODY_'.repeat(500)});
    }
    let handedOff=false;
    for(let attempt=0;attempt<10&&!handedOff;attempt++) {
      try { await h.ctx.taskSystem.projects.handoff(projectId);handedOff=true; }
      catch(error) {
        assert.equal(error.code,'READ_MODEL_UPDATING');
        assert.equal(h.ctx.taskSystem.projects.placementProject(projectId).generation,1,'A bounded read retry does not advance coordinator authority');
      }
    }
    assert.equal(handedOff,true,'Bounded read materialization converges before the handoff');
    const binding=h.ctx.taskSystem.projects.placementProject(projectId);
    const summary=String(h.ledger.managementDatabase().prepare('SELECT summary FROM pr_sessions WHERE session=?').get(binding.session).summary);
    assert.ok(summary.length<=24000,'A large project continuation has a hard serialized-character budget');
    assert.match(summary,/"taskCount":120/);assert.match(summary,/"tasksTruncated":true/);
    assert.doesNotMatch(summary,/PRIVATE_FULL_REPORT_BODY_/,'Continuation carries bounded authority references instead of full reports');
    h.adapter.script.push('After rotation response');
    const admission=await h.ctx.taskSystem.steward.send({conversationId:'main',commandId:'after-rotation',text:'AFTER_ROTATION_MARKER',replyTo:reply.id});
    assert.equal(admission.commandMessage?.text,'AFTER_ROTATION_MARKER','Send response includes its direct receipt independently of the paginated notification tail');
    const rotated=await waitFor(h.ctx.taskSystem.steward,s=>s.messages.some(message=>message.text==='After rotation response'));
    const user=(await h.ctx.taskSystem.steward.snapshot({conversationId:'main',commandId:'after-rotation'})).commandMessage;
    assert.ok(user,'Direct command receipt remains available even when a report burst moved it outside the tail page');
    assert.equal(user.source.generation,2);assert.notEqual(user.source.sessionId,reply.source.sessionId);
    assert.deepEqual(user.scope,{kind:'project',projectId});assert.equal(rotated.persona.id,original.persona.id);
    assert.equal(h.adapter.requests.length,1);assert.match(requestText(h.adapter.requests[0]),/BEFORE_RESTART_MARKER/);
    assert.match(requestText(h.adapter.requests[0]),/AFTER_ROTATION_MARKER/);
    assert.doesNotMatch(requestText(h.adapter.requests[0]),/PRIVATE_FULL_REPORT_BODY_/);
    assert.equal((requestText(h.adapter.requests[0]).match(/\[persona dsh-steward@1\]/g)??[]).length,1);
    assert.deepEqual(taskIds.map(id=>h.ledger.getTask(id).taskId),taskIds,'Rotation reuses every original task identity');
  }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('ordinary host runtime-context snapshots do not detach an accepted user message from its assistant reply', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}},script:['Reply after runtime context']});
  const stop=h.ctx.systemPrompt.context({name:'steward-native-context-regression',order:110,interpolate:false,text:'RUNTIME_CONTEXT_REGRESSION_MARKER'});
  try {
    const service=h.ctx.taskSystem.steward;
    await service.send({conversationId:'main',commandId:'context-order',text:'USER_BEFORE_RUNTIME_CONTEXT',target:{kind:'personal'}});
    const snapshot=await waitFor(service,s=>s.messages.some(message=>message.role==='assistant'&&message.text==='Reply after runtime context'));
    const user=snapshot.messages.find(message=>message.role==='user');
    assert.equal(snapshot.messages.find(message=>message.role==='assistant').replyTo,user.id);
    assert.equal(user.state.kind,'completed');
    assert.match(requestText(h.adapter.requests[0]),/RUNTIME_CONTEXT_REGRESSION_MARKER/);
  }finally{stop();await h.dispose();}
});

test('auto routing uses bounded classifier requests for casual turns, direct addresses for A/B and old replies before text intent', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try {
    const service=h.ctx.taskSystem.steward,projects=h.ctx.taskSystem.projects;
    await attachSidebar(h);
    await service.configureRouting({commandId:'auto-routing-fixture-model',expectedRevision:0,fallback:{provider:'test-offline',model:'script'}});
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const a=await projects.create({commandId:'auto-a',title:'Alpha 项目',goal:'SECRET_A_GOAL'});
    const b=await projects.create({commandId:'auto-b',title:'Beta 项目',goal:'SECRET_B_GOAL'});
    for(const [project,commandId,response] of [[a,'auto-recent-a','Alpha discussion ready'],[b,'auto-recent-b','Beta discussion ready']]){
      h.adapter.script.push(response);await service.send({conversationId:'main',commandId,text:'建立近期讨论记录',target:{kind:'project',projectId:project.projectId}});
      await waitFor(service,s=>s.messages.some(message=>message.text===response));
    }
    h.adapter.script.push('ordinary topic ready');
    await service.send({conversationId:'main',commandId:'auto-casual-topic',text:'普通闲聊 PERSONAL_BACK_AUTO',routeCreateTopic:true});
    await waitFor(service,s=>s.messages.some(message=>message.text==='ordinary topic ready'));
    const casual=service.store.commandMessage('main','auto-casual-topic').scope;
    assert.equal(casual.kind,'workbench');assert.ok(casual.topicId);
    async function send(commandId,text,response,{target,program=false,replyTo}={}) {
      const classifierCount=()=>h.adapter.requests.filter(request=>request.messages[0]?.source?.kind==='dsh-steward-route-classifier').length;
      const before=classifierCount(),requestsBefore=h.adapter.requests.length;
      if(!replyTo&&!program){const latest=service.snapshot({conversationId:'main'}).topicActivity.latestMessage?.scope ?? service.store.current('main');if(JSON.stringify(latest)!==JSON.stringify(target))h.adapter.script.push(JSON.stringify({kind:'search',queries:[target.kind==='workbench'?'普通闲聊':target.projectId===a.projectId?'Alpha':'Beta']}));h.adapter.script.push(options=>{const input=JSON.parse(options.messages[0].content[0].text);if(input.stage==='candidates'){assert.equal(input.candidates.length,1);assert.equal(input.candidates[0].complete,false);return JSON.stringify({kind:'inspect',candidateIds:[input.candidates[0].id]})}return JSON.stringify({kind:'route',target})});if(JSON.stringify(latest)!==JSON.stringify(target))h.adapter.script.push(options=>{const input=JSON.parse(options.messages[0].content[0].text);assert.equal(input.stage,'candidates');assert.equal(input.candidates[0].complete,true);return JSON.stringify({kind:'candidate',id:input.candidates[0].id});});}h.adapter.script.push(response);
      await service.send({conversationId:'main',commandId,text,routingMode:'auto',...(replyTo?{replyTo}:{})});
      const snapshot=await waitFor(service,s=>s.messages.some(message=>message.text===response));
      if(program||replyTo){assert.equal(classifierCount(),before,'An exact recent title or canonical reply uses no routing model');assert.equal(h.adapter.requests.length,requestsBefore+1,'Only the destination native model runs for a direct title or reply');}
      return snapshot;
    }
    await send('auto-personal','先闲聊 PERSONAL_AUTO_MARKER','personal one',{target:casual});
    assert.deepEqual(service.store.commandMessage('main','auto-personal').scope,casual);
    let snapshot=await send('auto-project-a','继续「Alpha 项目」: A_AUTO_MARKER','alpha one',{program:true});
    const oldA=snapshot.messages.find(message=>message.text==='alpha one');
    await send('auto-project-b','继续「Beta 项目」: B_AUTO_MARKER','beta one',{program:true});
    await send('auto-personal-back','不要交给 Alpha 项目，聊点别的 PERSONAL_BACK_AUTO','personal back',{target:casual});
    assert.deepEqual(service.store.commandMessage('main','auto-personal-back').scope,casual);
    snapshot=await send('auto-old-reply','Beta 项目只是引用，继续旧问题','alpha reply',{replyTo:oldA.id});
    assert.deepEqual(snapshot.messages.find(message=>message.commandId==='auto-old-reply').scope,{kind:'project',projectId:a.projectId});
    const classifiers=h.adapter.requests.filter(request=>request.messages[0]?.source?.kind==='dsh-steward-route-classifier');
    assert.equal(classifiers.length,4);assert.ok(classifiers.every(request=>request.messages.length===1));
    for(const request of classifiers){assert.deepEqual(request.tools,[]);assert.ok(Buffer.byteLength(JSON.stringify(request))<=32768);}
    const before=snapshot.messages.length,requestsBefore=h.adapter.requests.length;
    h.adapter.script.push(JSON.stringify({kind:'route',target:{kind:'project',projectId:'UNKNOWN_PROJECT'}}));
    const uncertain=await service.send({conversationId:'main',commandId:'auto-unknown',text:'不明确的话题',routingMode:'auto'});assert.equal(uncertain.router.find(item=>item.commandId==='auto-unknown').phase,'clarifying');
    assert.equal(service.snapshot({conversationId:'main'}).messages.length,before,'Unknown target has no canonical admission or PM dispatch');
    assert.equal(h.adapter.requests.length,requestsBefore+1,'Only classification ran, no destination model');
  }finally{await h.dispose();}
});

test('human recovery closes only an uncertain wait after restart, without replaying its original effect', {timeout:15000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-uncertain-'));
  const config={role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}};
  let h=await createNativeHarness({dir,config,script:['Initial personal response']});
  try {
    let service=h.ctx.taskSystem.steward;
    await service.send({conversationId:'main',commandId:'before-fault',text:'INITIAL_NATIVE_MARKER',target:{kind:'personal'}});
    const initial=await waitFor(service,s=>s.messages.some(message=>message.text==='Initial personal response'));
    const binding=initial.messages.find(message=>message.role==='user').source;
    // Deliberately stop at the durable acceptance boundary, before any native admission.
    const original={conversationId:'main',commandId:'fault-before-native',text:'NEVER_ADMITTED_MARKER',target:{kind:'personal'}};
    const accepted=service.store.accept(original,{kind:'personal'},binding,service.store.cursors('main')[0].afterSeq);
    service.store.setState(accepted.id,{kind:'needs-reconciliation',reason:'Injected interruption after attempt marker, before native admission'});
    await h.dispose();h=await createNativeHarness({dir,config});service=h.ctx.taskSystem.steward;
    const restored=await service.reconcile({conversationId:'main'}),message=restored.messages.find(row=>row.id===accepted.id);
    assert.equal(message.state.kind,'needs-reconciliation');assert.equal(h.adapter.requests.length,0);
    const resolution={conversationId:'main',messageId:message.id,commandId:'resolve-fault',expectedRevision:message.revision,expectedState:message.state.kind,confirm:true};
    await assert.rejects(service.resolve({...resolution,commandId:'stale-resolve',expectedRevision:message.revision+1}),{code:'CONFLICT'});
    const released=await service.resolve(resolution),row=released.messages.find(row=>row.id===message.id);
    assert.equal(row.state.kind,'released');assert.equal(row.resolution.priorState,'needs-reconciliation');
    await service.resolve(resolution);assert.equal(h.adapter.requests.length,0,'Recovery never resends or wakes the original native owner');
    h.adapter.script.push('New independent response');
    await service.send({conversationId:'main',commandId:'after-release',text:'AFTER_RELEASE_MARKER',target:{kind:'personal'}});
    await waitFor(service,s=>s.messages.some(message=>message.text==='New independent response'));
    assert.equal(h.adapter.requests.length,1);assert.doesNotMatch(requestText(h.adapter.requests[0]),/NEVER_ADMITTED_MARKER/);
  }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('explicit quotation shares only the selected historical A excerpt to the current B generation, with immutable provenance', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try {
    const projects=h.ctx.taskSystem.projects,service=h.ctx.taskSystem.steward;
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const a=await projects.create({commandId:'quote-a',title:'Quote A',goal:'A_UNSHARED_PROJECT_GOAL'}),b=await projects.create({commandId:'quote-b',title:'Quote B',goal:'B_PROJECT_GOAL'});
    h.adapter.script.push('原句 QUOTE_ALLOWED_EXCERPT 后面是 A_UNSHARED_REMAINDER');
    await service.send({conversationId:'main',commandId:'quote-source',text:'A_UNSHARED_INPUT',target:{kind:'project',projectId:a.projectId}});
    const initial=await waitFor(service,s=>s.messages.some(message=>message.text.includes('QUOTE_ALLOWED_EXCERPT')&&message.role==='assistant'));
    const source=initial.messages.find(message=>message.role==='assistant');
    await projects.handoff(a.projectId);await projects.handoff(b.projectId);
    const input={conversationId:'main',commandId:'quote-to-b',text:'请把引用作为资料核对。',target:{kind:'project',projectId:b.projectId},quote:{messageId:source.id,expectedRevision:source.revision,excerpt:'QUOTE_ALLOWED_EXCERPT'}};
    h.adapter.script.push('B received explicit excerpt');await service.send(input);
    const snapshot=await waitFor(service,s=>s.messages.some(message=>message.text==='B received explicit excerpt'));
    const shared=snapshot.messages.find(message=>message.commandId===input.commandId);
    assert.equal(shared.source.generation,2);assert.equal(shared.quote.source.generation,1);
    assert.equal(shared.quote.messageId,source.id);assert.equal(shared.quote.revision,source.revision);
    assert.match(shared.quote.sourceContentHash,/^[a-f0-9]{64}$/);assert.match(shared.quote.excerptHash,/^[a-f0-9]{64}$/);
    assert.match(requestText(h.adapter.requests.at(-1)),/QUOTE_ALLOWED_EXCERPT/);
    assert.doesNotMatch(requestText(h.adapter.requests.at(-1)),/A_UNSHARED_INPUT|A_UNSHARED_REMAINDER|A_UNSHARED_PROJECT_GOAL/);
    const requests=h.adapter.requests.length;await service.send(input);assert.equal(h.adapter.requests.length,requests);
    await assert.rejects(async()=>service.send({...input,quote:{...input.quote,excerpt:'changed'}}),{code:'CONFLICT'});
    for(const [commandId,quote] of [['quote-stale',{...input.quote,expectedRevision:99}],['quote-forged',{...input.quote,excerpt:'not original text'}]])
      await assert.rejects(service.send({...input,commandId,quote}),/changed|exact contiguous/);
    await assert.rejects(service.send({...input,commandId:'quote-other-conversation',conversationId:'other'}),{code:'FORBIDDEN'});
    h.ledger.managementDatabase().prepare("UPDATE pr_projects SET state='handoff' WHERE id=?").run(a.projectId);
    await assert.rejects(service.send({...input,commandId:'quote-revoked'}),{code:'FORBIDDEN'});
    assert.equal(h.adapter.requests.length,requests,'Rejected or replayed quotations do not dispatch a destination native turn');
  }finally{await h.dispose();}
});

test('automatic quotation routes the next text to B without sharing the source history with the classifier or B', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try {
    const projects=h.ctx.taskSystem.projects,service=h.ctx.taskSystem.steward;
    await attachSidebar(h);
    await service.configureRouting({commandId:'auto-quote-fixture-model',expectedRevision:0,fallback:{provider:'test-offline',model:'script'}});
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const a=await projects.create({commandId:'auto-quote-a',title:'Auto quote A',goal:'AUTO_A_PRIVATE_GOAL'});
    const b=await projects.create({commandId:'auto-quote-b',title:'Auto quote B',goal:'AUTO_B_GOAL'});
    h.adapter.script.push('Auto B discussion ready');await service.send({conversationId:'main',commandId:'auto-quote-recent-b',text:'建立B的近期讨论记录，后续核对资料。',target:{kind:'project',projectId:b.projectId}});
    await waitFor(service,s=>s.messages.some(message=>message.text==='Auto B discussion ready'));
    h.adapter.script.push('AUTO_QUOTE_SHARED_EXCERPT AUTO_A_PRIVATE_REMAINDER');
    await service.send({conversationId:'main',commandId:'auto-quote-source',text:'AUTO_A_PRIVATE_INPUT',target:{kind:'project',projectId:a.projectId}});
    const initial=await waitFor(service,s=>s.messages.some(message=>message.role==='assistant'&&message.text.includes('AUTO_QUOTE_SHARED_EXCERPT')));
    const source=initial.messages.find(message=>message.role==='assistant'&&message.text.includes('AUTO_QUOTE_SHARED_EXCERPT'));
    const input={conversationId:'main',commandId:'auto-quote-send',text:'请交给另一个项目核对这份资料。',routingMode:'auto',
      quote:{messageId:source.id,expectedRevision:source.revision,excerpt:'AUTO_QUOTE_SHARED_EXCERPT'}};
    h.adapter.script.push(JSON.stringify({kind:'search',queries:['Auto quote B']}),JSON.stringify({kind:'inspect',candidateIds:['topic_0']}),JSON.stringify({kind:'candidate',id:'topic_0'}),'Auto B received excerpt');
    await service.send(input);
    const snapshot=await waitFor(service,s=>s.messages.some(message=>message.text==='Auto B received excerpt'));
    const shared=snapshot.messages.find(message=>message.commandId===input.commandId);
    assert.deepEqual(shared.scope,{kind:'project',projectId:b.projectId});assert.equal(shared.replyTo,null);
    assert.equal(shared.quote.messageId,source.id);assert.deepEqual(shared.quote.scope,{kind:'project',projectId:a.projectId});
    const classifier=h.adapter.requests.findLast(request=>request.messages[0]?.source?.kind==='dsh-steward-route-classifier');
    assert.ok(classifier);assert.equal(classifier.messages.length,1);
    const classificationInput=JSON.parse(classifier.messages[0].content[0].text);
    assert.equal(classificationInput.text,input.text);assert.deepEqual(Object.keys(classificationInput).sort(),['candidates','stage','text']);
    assert.doesNotMatch(requestText(classifier),/AUTO_QUOTE_SHARED_EXCERPT|AUTO_A_PRIVATE_/);
    assert.match(requestText(h.adapter.requests.at(-1)),/AUTO_QUOTE_SHARED_EXCERPT/);
    assert.doesNotMatch(requestText(h.adapter.requests.at(-1)),/AUTO_A_PRIVATE_/);
    const requests=h.adapter.requests.length;await service.send(input);
    assert.equal(h.adapter.requests.length,requests,'Exact quotation retry does not reroute or resend');
    await assert.rejects(async()=>service.send({...input,quote:{...input.quote,excerpt:'AUTO_A_PRIVATE_REMAINDER'}}),{code:'CONFLICT'});
    assert.equal(h.adapter.requests.length,requests);
  }finally{await h.dispose();}
});

test('ambiguous quotation stays router-only with its exact excerpt frozen; invalid sources never reach routing', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try {
    const projects=h.ctx.taskSystem.projects,service=h.ctx.taskSystem.steward;
    await attachSidebar(h);
    await service.configureRouting({commandId:'ambiguous-quote-fixture-model',expectedRevision:0,fallback:{provider:'test-offline',model:'script'}});
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const a=await projects.create({commandId:'ambiguous-quote-a',title:'Ambiguous quote A',goal:'PRIVATE_AMBIGUOUS_A_GOAL'});
    const b=await projects.create({commandId:'ambiguous-quote-b',title:'Ambiguous quote B',goal:'AMBIGUOUS_B_GOAL'});
    h.adapter.script.push('Ambiguous B discussion ready');await service.send({conversationId:'main',commandId:'ambiguous-quote-recent-b',text:'建立B的近期讨论记录',target:{kind:'project',projectId:b.projectId}});
    await waitFor(service,s=>s.messages.some(message=>message.text==='Ambiguous B discussion ready'));
    h.adapter.script.push('WAITING_QUOTE_EXCERPT PRIVATE_AMBIGUOUS_REMAINDER');
    await service.send({conversationId:'main',commandId:'ambiguous-quote-source',text:'PRIVATE_AMBIGUOUS_INPUT',target:{kind:'project',projectId:a.projectId}});
    const initial=await waitFor(service,s=>s.messages.some(message=>message.role==='assistant'&&message.text.includes('WAITING_QUOTE_EXCERPT')));
    const source=initial.messages.find(message=>message.role==='assistant'&&message.text.includes('WAITING_QUOTE_EXCERPT'));
    const input={conversationId:'main',commandId:'ambiguous-quote-send',text:'请核对这份资料。',routingMode:'auto',
      quote:{messageId:source.id,expectedRevision:source.revision,excerpt:'WAITING_QUOTE_EXCERPT'}};
    const before=h.adapter.requests.length;
    h.adapter.script.push(JSON.stringify({kind:'search',queries:['Ambiguous quote B']}),JSON.stringify({kind:'clarification',question:'交给哪个项目？',candidateIds:['topic_0']}));
    await service.send(input);
    const pending=service.snapshot({conversationId:'main'}).router.find(item=>item.commandId===input.commandId);assert.equal(pending.phase,'clarifying');assert.match(pending.question,/请选择下列去向/);assert.equal(service.store.commandMessage('main',input.commandId),null);assert.equal(h.adapter.requests.length,before+2,'Both semantic stages stay in the router, without workbench or PM execution');
    const option=pending.options.find(option=>option.target?.kind==='project'&&option.target.projectId===b.projectId);assert.ok(option,'Clarification offers the retrieved and authorized B destination');
    h.adapter.script.push('Clarified B received excerpt');
    const clarified={conversationId:'main',commandId:'ambiguous-quote-selected-b',text:'选择B',routeQuestionId:pending.questionId,target:{kind:'project',projectId:b.projectId}};
    await service.send(clarified);
    const snapshot=await waitFor(service,s=>s.messages.some(message=>message.text==='Clarified B received excerpt'));
    const shared=snapshot.messages.find(message=>message.commandId===input.commandId);
    assert.deepEqual(shared.scope,clarified.target);assert.equal(shared.quote.excerpt,input.quote.excerpt);
    assert.equal(shared.quote.messageId,source.id);assert.equal(shared.quote.revision,source.revision);
    assert.match(requestText(h.adapter.requests.at(-1)),/WAITING_QUOTE_EXCERPT/);assert.doesNotMatch(requestText(h.adapter.requests.at(-1)),/PRIVATE_AMBIGUOUS_/);
    const after=h.adapter.requests.length;
    for(const [suffix,quote] of [['stale',{...input.quote,expectedRevision:99}],['forged',{...input.quote,excerpt:'FORGED_TEXT'}],['too-long',{...input.quote,excerpt:'x'.repeat(2001)}]])
      await assert.rejects(async()=>service.send({...input,commandId:`invalid-auto-quote-${suffix}`,quote}));
    await assert.rejects(service.send({...input,commandId:'foreign-auto-quote',conversationId:'other'}),{code:'FORBIDDEN'});
    h.ledger.managementDatabase().prepare("UPDATE pr_projects SET state='handoff' WHERE id=?").run(a.projectId);
    await assert.rejects(service.send({...input,commandId:'inaccessible-auto-quote'}),{code:'FORBIDDEN'});
    assert.equal(h.adapter.requests.length,after,'Source validation precedes both the classifier and destination admission');
  }finally{await h.dispose();}
});
