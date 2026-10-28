import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeHarness } from '../../../tests/dsh/native-harness.mjs'
import TitleService, {foldSessionTitle} from '@deepseek-ai/dsh-session-title'

// Completely scripted provider; no external model, network, keys or profile edits.
for (const kind of ['ad_hoc', 'scheduled']) test(`native ${kind} session lifetime follows task versus scheduled occurrence`,async()=>{
  const h=await createNativeHarness({executionRoot:true,script:[{name:'task_submit_result',args:{outcome:'success',summary:'first fixture'}},{name:'task_submit_result',args:{outcome:'success',summary:'second fixture'}}]})
  try {
    await h.ctx.plugin(TitleService,{fallbackMaxWords:10,fallbackMaxBytes:100,maxTitleBytes:512})
    const createdTitles=[]
    h.ctx.on('session/created',session=>createdTitles.push(h.ctx.sessionProjections.snapshot(session).values.title))
    const l=h.ledger
    l.registerWorkspace('workspace',{workspaceId:'default',nodeId:'local',path:h.dir,label:'fixture',state:'ready',createdAt:new Date().toISOString()})
    l.registerNode('node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()})
    const task=l.createTask('task',{title:'Two run fixture',kind}).value
    const sessions=[]
    for (const i of [1,2]) {
      const run=l.createRun(`run-${i}`,{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value
      const claim=l.claim(`claim-${i}`,{runId:run.runId,nodeId:'local',ttlMs:10000}).value
      const result=await h.ctx.taskSystem.native.execute(claim)
      assert.equal(result.run.state,'succeeded');sessions.push(result.sessionId)
      const reader=await h.ctx.sessionPersistence.open(result.sessionId,'read')
      try {assert.equal(foldSessionTitle((await reader.read()).events).title,i===2&&kind==='ad_hoc'?'用户保留的名字':i===2?'Two run fixture · 第2次':'Two run fixture')} finally {await reader.close()}
      if(i===1&&kind==='ad_hoc'){
        const handle=await h.ctx.agents.resume({resumeSessionId:result.sessionId})
        h.ctx.sessionTitle.rename(handle.agent.session,'用户保留的名字')
        await h.ctx.sessions.flush(handle.agent.session);await handle.dispose()
      }
    }
    if(kind==='scheduled')assert.notEqual(sessions[0],sessions[1]);else assert.equal(sessions[0],sessions[1]);assert.equal(h.adapter.requests.length,2)
    if(kind==='ad_hoc')assert.match(JSON.stringify(h.adapter.requests[1].messages),/newly assigned run/);else assert.doesNotMatch(JSON.stringify(h.adapter.requests[1].messages),/first fixture/)
    assert.equal(l.history(task.taskId).runs.length,2)
    assert.equal(createdTitles[0],'Two run fixture','title is projected before the first session publication')
  } finally {await h.dispose()}
})

test('resuming an attempt cannot adopt a session whose immutable workspace is different',async()=>{
  const h=await createNativeHarness({executionRoot:true});let handle
  try {
    const l=h.ledger
    l.registerWorkspace('workspace',{workspaceId:'default',nodeId:'local',path:h.dir,label:'fixture',state:'ready',createdAt:new Date().toISOString()})
    l.registerNode('node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()})
    const task=l.createTask('task',{title:'Invalid historical session'}).value
    const run=l.createRun('run',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',workspaceId:'default',requiredCapabilities:[]}}).value
    const claim=l.claim('claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value
    l.bindSession('legacy-bind',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'local',fence:claim.attempt.fence,sessionId:'unscoped-session'})
    handle=await h.ctx.agents.create({sessionId:'unscoped-session',meta:{agentPreset:'ptc'},agentOptions:{provider:'test-offline',model:'script'}})
    await h.ctx.sessions.flush(handle.agent.session);await handle.dispose();handle=undefined
    await assert.rejects(h.ctx.taskSystem.native.resume({...claim,attempt:l.getAttempt(claim.attempt.attemptId)}),/workspace does not match/)
    assert.equal(h.adapter.requests.length,0)
  } finally {await handle?.dispose();await h.dispose()}
})

test('native workload renews its lease beyond initial expiry without a session decision',async()=>{
  let choices=0;
  const decisions={ask:async input=>{
    choices++;
    assert.deepEqual(Object.keys(input.questions),['session']);
    assert.ok(Object.keys(input.questions.session.criteria).some(id=>id.startsWith('reuse-')),'the persisted first Run supplies a real reuse candidate');
    await new Promise(resolve=>setTimeout(resolve,1200));
    return {provider:'fixture',model:'judge',answers:{session:{type:'choice',choice:'new'}}};
  }};
  const settle={name:'task_submit_result',args:{outcome:'success',summary:'fixture after session selection'}};
  const h=await createNativeHarness({executionRoot:true,config:{leaseTtlMs:1000,executionTimeoutMs:4000,sessionDecisionEnabled:true},script:[settle,async()=>{await new Promise(resolve=>setTimeout(resolve,1200));return settle;}]});
  h.ctx.provide('decisionModels',decisions);
  try {
    const l=h.ledger;
    l.registerNode('node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
    const task=l.createTask('task',{title:'Delayed choice'}).value;
    const route={nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]};
    const first=l.createRun('first',{taskId:task.taskId,route}).value;
    const initial=await h.ctx.taskSystem.native.execute(l.claim('first-claim',{runId:first.runId,nodeId:'local',ttlMs:1000}).value);
    assert.equal(initial.run.state,'succeeded');assert.equal(choices,0,'the first session is a deterministic singleton');
    const run=l.createRun('second',{taskId:task.taskId,route}).value;
    const claim=l.claim('claim',{runId:run.runId,nodeId:'local',ttlMs:1000}).value,originalExpiry=Date.parse(claim.attempt.leaseExpiresAt);
    const result=await h.ctx.taskSystem.native.execute(claim);
    assert.ok(Date.now()>originalExpiry);assert.equal(result.run.state,'succeeded');assert.equal(choices,0);assert.equal(h.adapter.requests.length,2);assert.equal(result.sessionId,initial.sessionId);
  } finally {await h.dispose();}
});

for (const recover of [false, true]) test(`report rejection resumes one session with two retry budget; recover=${recover}`,async()=>{
 const rejected={name:'task_submit_result',args:{outcome:'success',summary:'Original work remains in the session',reportBody:'Unique saved output',reportData:{wrong:true}}};
 const accepted={name:'task_submit_result',args:{outcome:'success',summary:'Corrected',reportData:{verified:true}}};
 const h=await createNativeHarness({executionRoot:true,script:[rejected,recover?accepted:rejected,rejected]});
 try {
  const l=h.ledger,runtime=h.ctx.taskSystem.projects;
  l.registerWorkspace('w',{workspaceId:'default',nodeId:'local',path:h.dir,label:'fixture',state:'ready',createdAt:new Date().toISOString()});
  l.registerNode('n',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()});
  l.recordNodeHeartbeat('online',{nodeId:'local',runtimeReady:true,activeExecutions:0});
  const template={"templateId": "checked", "version": 1, "name": "checked", "description": "", "inputSchema": {"type": "object"}, "defaults": {}, "resultContract": {"type": "object", "required": ["report"], "properties": {"report": {"type": "object", "required": ["data"], "properties": {"data": {"type": "object", "required": ["verified"], "properties": {"verified": {"const": true}}}}}}}};
  const task=l.createTask('t',{title:'Daily',kind:'scheduled',description:'Original immutable instruction'}).value;
  const input={windowStart:'2026-10-11T00:00:00Z',windowEnd:'2026-10-12T00:00:00Z'};
  let run=l.createRun('r',{taskId:task.taskId,configuration:{template,input},route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
  const sessions=[];
  for(let i=0;i<(recover?2:3);i++){
   const claim=l.claim('c'+i,{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
   const result=await h.ctx.taskSystem.native.execute(claim);sessions.push(result.sessionId);
   assert.equal(result.run.state,recover&&i===1?'succeeded':'failed');
   const count=l.snapshot().runs.length;
   for(let j=0;j<30;j++){runtime.tick();await new Promise(r=>setTimeout(r,5));if(l.snapshot().runs.length>count)break;}
   if(recover&&i===1||i===2){assert.equal(l.snapshot().runs.length,count);break;}
   run=l.snapshot().runs.at(-1);
   assert.equal(l.snapshot().runs.length,count+1);
   assert.deepEqual(run.configuration.input,input);assert.deepEqual(run.configuration.templateRef,{templateId:'checked',version:1});
   assert.equal(run.configuration.taskRetry.count,i+1);
   const notes=l.executionContext(run.runId).reports;
   assert.match(JSON.stringify(notes),/SCHEMA_VALIDATION/);assert.doesNotMatch(JSON.stringify(notes),/Unique saved output|Original immutable instruction/);
  }
  assert.equal(new Set(sessions).size,1,'automatic redispatch must resume the original native session');
  assert.equal(l.getTask(task.taskId).description,'Original immutable instruction');
  assert.equal(l.history(task.taskId).reports.filter(r=>r.kind==='result').length,recover?1:0);
  assert.equal(l.resultRetryInfo(l.snapshot().runs.at(-1).runId).eligible,false);
  if(!recover){
   const current=runtime.snapshot().tasks.find(t=>t.id===task.taskId);assert.equal(current.resultRetry.count,2);assert.equal(current.canRetry,true);
   const {TaskLedger}=await import('../dist/ledger.js');const {join}=await import('node:path');const reopened=TaskLedger.open(join(h.dir,'tasks.sqlite'),{readOnly:true});try{assert.equal(reopened.resultRetryInfo(l.snapshot().runs.at(-1).runId).count,2);assert.equal(reopened.resultRetryInfo(l.snapshot().runs.at(-1).runId).eligible,false);}finally{reopened.close();}
   await runtime.actOnTask({commandId:'manual-after-budget',taskId:task.taskId,action:'retry',expectedVersion:current.actionVersion,retryPrompt:'Operator reviewed failure'});
   assert.equal(l.snapshot().runs.length,4);assert.equal(l.snapshot().runs.at(-1).configuration.taskRetry.count,0);
  }
 } finally {await h.dispose();}
});

 test('local executor creates registered project workspaces under the selected parent and retains them after changes',async()=>{
  const {mkdirSync}=await import('node:fs'),{join}=await import('node:path');
  const {Workbench}=await import('../dist/workbench.js');
  const h=await createNativeHarness({executionRoot:true,config:{projectAgentOptions:{provider:'test-offline',model:'script'}},script:[{name:'task_submit_result',args:{outcome:'success',summary:'first'}},{name:'task_submit_result',args:{outcome:'success',summary:'second'}}]});
  try {
    const l=h.ledger,runtime=h.ctx.taskSystem.projects,dirs=h.ctx.taskSystem.executionDirectories,wb=new Workbench(l);
    const root=join(h.dir,'executor'),later=join(h.dir,'later');mkdirSync(root);mkdirSync(later);dirs.save({root,expectedRevision:dirs.settings().revision});
    runtime.saveSettings({root:join(h.dir,'planner'),expectedRevision:0});
    const {projectId}=await runtime.create({commandId:'project',title:'Project fixture',goal:'Two tasks'});
    const registered=new Map();h.ctx.provide('workspaceRegistry',{async create(path,title){if(!registered.has(path))registered.set(path,{title,sessions:new Set(),async attachSession(id){assert.ok(await h.ctx.sessionPersistence.stat(id));this.sessions.add(id);}});return registered.get(path);}});
    l.registerWorkspace('w',{workspaceId:'default',nodeId:'local',path:h.dir,label:'fixture',state:'ready',createdAt:new Date().toISOString()});
    l.registerNode('n',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()});
    for(const i of [1,2]){
      const task=l.createTask('task'+i,{title:'Task '+i}).value;
      wb.manage('link'+i,'link_backlog_task',{backlogId:'pr:'+projectId,taskId:task.taskId});
      const run=l.createRun('run'+i,{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
      const claim=l.claim('claim'+i,{runId:run.runId,nodeId:'local',ttlMs:10000}).value;
      assert.equal((await h.ctx.taskSystem.native.execute(claim)).run.state,'succeeded');
      if(i===1) dirs.save({root:later,expectedRevision:dirs.settings().revision});
    }
    const executorWorkspaces=[...registered].filter(([path])=>path.startsWith(root+'/'));assert.equal(executorWorkspaces.length,1);const [path,workspace]=executorWorkspaces[0];
    assert.ok(path.startsWith(root+'/'));assert.equal(workspace.title,'Project fixture');assert.equal(workspace.sessions.size,2);
  }finally{await h.dispose();}
 });

test('automatic conversational title generation cannot replace an initialized task name',async()=>{
 const {createUserMessage}=await import('@deepseek-ai/dsh-llm');
 const {SessionTitleProviderId}=await import('@deepseek-ai/dsh-session-title');
 const h=await createNativeHarness({executionRoot:true,script:[{name:'task_submit_result',args:{outcome:'success',summary:'Task complete'}},'Ordinary reply']});
 try {
  await h.ctx.plugin(TitleService,{fallbackMaxWords:10,fallbackMaxBytes:80,maxTitleBytes:80});
  let generated=0;
  h.ctx.sessionTitle.register({id:SessionTitleProviderId('fixture-title'),automatic:'all-prompts',async generate(request){generated++;return {title:'Should not replace task name',messageSeqs:request.messages.map(m=>m.seq)}}});
  const l=h.ledger;l.registerNode('node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
  const task=l.createTask('task',{title:'审查 PR #23：归档与清理'}).value;
  const run=l.createRun('run',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
  const result=await h.ctx.taskSystem.native.execute(l.claim('claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value);
  const resumed=await h.ctx.agents.resume({resumeSessionId:result.sessionId});
  resumed.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'An ordinary follow-up with different content'}]}));await resumed.agent.whenIdle();
  assert.equal(h.ctx.sessionTitle.get(resumed.agent.session).title,task.title);assert.equal(generated,0);
  await h.ctx.sessions.flush(resumed.agent.session);await resumed.dispose();
  const reader=await h.ctx.sessionPersistence.open(result.sessionId,'read');try{assert.equal(foldSessionTitle((await reader.read()).events).title,task.title)}finally{await reader.close()}
 }finally{await h.dispose()}
});
