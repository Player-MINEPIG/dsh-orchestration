import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeHarness } from '../../../tests/dsh/native-harness.mjs'

// Completely scripted provider; no external model, network, keys or profile edits.
test('native Task execution resumes the same persisted session on the next run',async()=>{
  const h=await createNativeHarness({script:[{name:'task_settle',args:{outcome:'success',summary:'first fixture'}},{name:'task_settle',args:{outcome:'success',summary:'second fixture'}}]})
  try {
    const l=h.ledger
    l.registerWorkspace('workspace',{workspaceId:'default',nodeId:'local',path:h.dir,label:'fixture',state:'ready',createdAt:new Date().toISOString()})
    l.registerNode('node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()})
    const task=l.createTask('task',{title:'Two run fixture'}).value
    const sessions=[]
    for (const i of [1,2]) {
      const run=l.createRun(`run-${i}`,{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value
      const claim=l.claim(`claim-${i}`,{runId:run.runId,nodeId:'local',ttlMs:10000}).value
      const result=await h.ctx.taskSystem.native.execute(claim)
      assert.equal(result.run.state,'succeeded');sessions.push(result.sessionId)
    }
    assert.equal(sessions[0],sessions[1]);assert.equal(h.adapter.requests.length,2)
    assert.match(JSON.stringify(h.adapter.requests[1].messages),/newly assigned run/)
    assert.equal(l.history(task.taskId).runs.length,2)
  } finally {await h.dispose()}
})

test('resuming an attempt cannot adopt a session whose immutable workspace is different',async()=>{
  const h=await createNativeHarness();let handle
  try {
    const l=h.ledger
    l.registerWorkspace('workspace',{workspaceId:'default',nodeId:'local',path:h.dir,label:'fixture',state:'ready',createdAt:new Date().toISOString()})
    l.registerNode('node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()})
    const task=l.createTask('task',{title:'Invalid historical session'}).value
    const run=l.createRun('run',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value
    const claim=l.claim('claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value
    l.bindSession('legacy-bind',{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'local',fence:claim.attempt.fence,sessionId:'unscoped-session'})
    handle=await h.ctx.agents.create({sessionId:'unscoped-session',agentOptions:{provider:'test-offline',model:'script'}})
    await h.ctx.sessions.flush(handle.agent.session);await handle.dispose();handle=undefined
    await assert.rejects(h.ctx.taskSystem.native.resume({...claim,attempt:l.getAttempt(claim.attempt.attemptId)}),/workspace does not match/)
    assert.equal(h.adapter.requests.length,0)
  } finally {await handle?.dispose();await h.dispose()}
})

test('native decision wait renews the lease before evaluating and still finishes after its initial expiry',async()=>{
  const {DecisionEngine,StructuredModelProvider}=await import('./legacy-model-fixture.mjs')
  const provider=new StructuredModelProvider('ordinary',[{model:'judge',version:'fixture',reasoningEfforts:[]}],{complete:async()=>{await new Promise(resolve=>setTimeout(resolve,1200));return {output:{answers:{session:{type:'choice',choice:'new'},workspace:{type:'choice',choice:'default'}}},modelVersion:'fixture'}}})
  const decisions=new DecisionEngine([provider],{defaultProvider:'ordinary',maxAttempts:1,timeoutMs:3000})
  const h=await createNativeHarness({config:{leaseTtlMs:1000,executionTimeoutMs:4000,sessionDecisionEnabled:true},script:[{name:'task_settle',args:{outcome:'success',summary:'fixture after delayed decision'}}]})
  h.ctx.provide('decisionModels',decisions)
  try {
    const l=h.ledger;l.registerWorkspace('workspace',{workspaceId:'default',nodeId:'local',path:h.dir,label:'fixture',state:'ready',createdAt:new Date().toISOString()})
    l.registerNode('node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()})
    l.registerWorkspace('alternate-workspace',{workspaceId:'other',nodeId:'local',path:h.dir,label:'other fixture',state:'ready',createdAt:new Date().toISOString()});
    l.registerNode('expanded-node',{...l.getNode('local'),workspaceIds:['default','other']});
    const task=l.createTask('task',{title:'Delayed choice'}).value,run=l.createRun('run',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value
    const claim=l.claim('claim',{runId:run.runId,nodeId:'local',ttlMs:1000}).value,originalExpiry=Date.parse(claim.attempt.leaseExpiresAt)
    const result=await h.ctx.taskSystem.native.execute(claim)
    assert.ok(Date.now()>originalExpiry);assert.equal(result.run.state,'succeeded');assert.equal(h.adapter.requests.length,1)
  } finally {await h.dispose();await decisions.close()}
})

for (const recover of [false, true]) test(`report rejection resumes one session with two retry budget; recover=${recover}`,async()=>{
 const rejected={name:'task_settle',args:{outcome:'success',summary:'Original work remains in the session',reportBody:'Unique saved output',reportData:{wrong:true}}};
 const accepted={name:'task_settle',args:{outcome:'success',summary:'Corrected',reportData:{verified:true}}};
 const h=await createNativeHarness({script:[rejected,recover?accepted:rejected,rejected]});
 try {
  const l=h.ledger,runtime=h.ctx.taskSystem.projects;
  l.registerWorkspace('w',{workspaceId:'default',nodeId:'local',path:h.dir,label:'fixture',state:'ready',createdAt:new Date().toISOString()});
  l.registerNode('n',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()});
  l.recordNodeHeartbeat('online',{nodeId:'local',runtimeReady:true,activeExecutions:0});
  const template={"templateId": "checked", "version": 1, "name": "checked", "description": "", "inputSchema": {"type": "object"}, "defaults": {}, "resultContract": {"type": "object", "required": ["report"], "properties": {"report": {"type": "object", "required": ["data"], "properties": {"data": {"type": "object", "required": ["verified"], "properties": {"verified": {"const": true}}}}}}}};
  const task=l.createTask('t',{title:'Daily',description:'Original immutable instruction'}).value;
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
  const h=await createNativeHarness({config:{projectAgentOptions:{provider:'test-offline',model:'script'}},script:[{name:'task_settle',args:{outcome:'success',summary:'first'}},{name:'task_settle',args:{outcome:'success',summary:'second'}}]});
  try {
    const l=h.ledger,runtime=h.ctx.taskSystem.projects,dirs=h.ctx.taskSystem.executionDirectories,wb=new Workbench(l);
    const root=join(h.dir,'executor'),later=join(h.dir,'later');mkdirSync(root);mkdirSync(later);dirs.save({root,expectedRevision:0});
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
      if(i===1) dirs.save({root:later,expectedRevision:1});
    }
    const executorWorkspaces=[...registered].filter(([path])=>path.startsWith(root+'/'));assert.equal(executorWorkspaces.length,1);const [path,workspace]=executorWorkspaces[0];
    assert.ok(path.startsWith(root+'/'));assert.equal(workspace.title,'Project fixture');assert.equal(workspace.sessions.size,2);
  }finally{await h.dispose();}
 });
