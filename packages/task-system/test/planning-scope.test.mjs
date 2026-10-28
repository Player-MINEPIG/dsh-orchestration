import {registerExecutor} from '../../../tests/dsh/executor-fixture.mjs';
import test from 'node:test'
import assert from 'node:assert/strict'
import {TaskLedger} from '../dist/ledger.js'
import {TaskPlanner,taskDecisionCatalog} from '../dist/planning.js'
import {chooseExecutionSession} from '../dist/execution-session.js'
import {Config} from '../dist/dsh-plugin.js'
import {SaveStartupInput} from '../dist/startup-settings.js'

function setup(t) {
  const ledger=TaskLedger.open(':memory:');t.after(()=>ledger.close())
  for(const workspaceId of ['default','other']) ledger.registerWorkspace(`ws-${workspaceId}`,{workspaceId,nodeId:'worker',label:workspaceId,path:`/tmp/fixture-${workspaceId}`,state:'ready',createdAt:new Date().toISOString()})
  registerExecutor(ledger, 'node',{nodeId:'worker',roles:['executor'],models:[{provider:'fixture',model:'fixture',reasoningEfforts:['high']}],capabilities:['text'],workspaceIds:['default','other'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()})
  const catalog=()=>taskDecisionCatalog(ledger,{fixture:true}),route={nodeId:'worker',provider:'fixture',model:'fixture',requiredCapabilities:['text']}
  return {ledger,catalog,route}
}
const planner=(f,decisions,enabled=true)=>new TaskPlanner(f.ledger,decisions,f.catalog,()=>{},Date.now,()=>enabled)
const workspaces=['default','other'].map(workspaceId=>({workspaceId,nodeId:'worker',description:workspaceId,eligible:true}))
function claim(f,runId) {const claim=f.ledger.claim(`claim-${runId}`,{runId,nodeId:'worker',ttlMs:60000}).value;const ref={runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:`exec-${runId}`};claim.attempt=f.ledger.markRunning(`running-${runId}`,ref).value;return {claim,ref}}

test('observation planning retains its own startup flag and legacy session flag is read-only',()=>{
  assert.equal(Config({}).planningDecisionEnabled.get(),true);assert.equal(Config({}).sessionDecisionEnabled.get(),false)
  const expected={role:'both',sessionDecisionEnabled:true,planningDecisionEnabled:true}
  assert.deepEqual(SaveStartupInput.parse({target:'task',expected,changes:{planningDecisionEnabled:false}}).changes,{planningDecisionEnabled:false})
  assert.equal(SaveStartupInput.safeParse({target:'task',expected,changes:{sessionDecisionEnabled:true}}).success,false)
})
for(const mode of ['enabled','disabled','missing']) test(`${mode} decision service uses the authorized executor pool and preserves an explicit route`,async t=>{
  const f=setup(t);let calls=0
  const p=planner(f,mode==='missing'?undefined:{ask:async()=>{calls++;throw Error('Formal planning must not ask a model')}},mode!=='disabled')
  const pooled=await p.plan({requestId:'pooled',title:'Use authorized execution',description:''})
  assert.equal(pooled.source,'default');assert.equal(pooled.routingStatus,'ready');assert.equal(pooled.proposal.executor.id,'worker')
  const assigned=p.apply('pooled');assert.equal(f.ledger.getRun(assigned.value.runId).route.nodeId,'worker');assert.equal(f.ledger.snapshot().runs.length,1)
  const fixed=await p.plan({requestId:'fixed',title:'Fixed route',description:'',route:{...f.route,workspaceId:'other'}})
  assert.equal(fixed.routingStatus,'ready');const applied=p.apply('fixed'),run=f.ledger.getRun(applied.value.runId)
  assert.equal(run.route.nodeId,'worker');assert.deepEqual(run.route.requiredCapabilities,['text']);assert.equal(run.route.workspaceId,'other');assert.equal(f.ledger.getTask(applied.value.taskId).workspaceId,'other');assert.equal(calls,0)
})
test('formal planning never sends Task intent to the decision service or copies its possible workspace answer',async t=>{
  const f=setup(t);let calls=0
  const p=planner(f,{ask:async()=>{calls++;return {provider:'injected',model:'injected',answers:{workspace:{type:'choice',choice:'other'}}}}})
  const record=await p.plan({requestId:'model',title:'Executor owns workspace',description:''})
  assert.equal(record.proposal.kind,'proposal');assert.equal(record.proposal.workspace,null);assert.equal(record.source,'default');assert.equal(calls,0)
  const applied=p.apply('model'),run=f.ledger.getRun(applied.value.runId),task=f.ledger.getTask(applied.value.taskId)
  assert.equal(task.workspaceId,undefined);assert.equal(run.route.workspaceId,undefined);assert.equal(run.workspaceConstraint,undefined);assert.equal(run.route.reasoningEffort,'high')
})
test('an empty authorized executor pool rejects before recording a proposal or creating work',async t=>{
  const f=setup(t)
  f.ledger.registerNode('disable-worker',{...f.ledger.getNode('worker'),enabled:false})
  const p=planner(f,{ask:async()=>{throw Error('A model cannot authorize another node')}})
  await assert.rejects(p.plan({requestId:'no-executor',title:'No configured executor',description:''}),{code:'EXECUTOR_REQUIRED'})
  assert.equal(f.ledger.getDecision('no-executor'),undefined);assert.equal(f.ledger.snapshot().tasks.length,0);assert.equal(f.ledger.snapshot().runs.length,0)
})
test('explicit caller Task workspace remains a hard constraint for deterministic dispatch',async t=>{
  const f=setup(t),p=planner(f,undefined)
  await p.plan({requestId:'explicit',title:'User-bound workspace',description:'',workspaceId:'other'})
  const applied=p.apply('explicit'),run=f.ledger.getRun(applied.value.runId)
  assert.equal(f.ledger.getTask(applied.value.taskId).workspaceId,'other');assert.equal(run.workspaceConstraint,'other')
  const x=claim(f,run.runId)
  assert.throws(()=>f.ledger.selectTaskSession('cross-task-constraint',{...x.ref,workspaceId:'default',session:{mode:'new'}}),/workspace/)
})
test('old unapplied model workspace receipts require replan and stored history remains unchanged',async t=>{
  const f=setup(t),snapshot=f.catalog(),proposal={kind:'proposal',persistence:'create',attachTaskId:null,executor:{id:'worker'},modelRoute:{provider:'fixture',model:'fixture'},workspace:{action:'reuse',workspaceRef:'other'},reporting:{narrative:'none'}}
  const original=f.ledger.recordDecision('record-old',{decisionId:'old',inputDigest:'old',receipt:{old:true},proposal,stateHash:snapshot.stateHash,validUntil:snapshot.validUntil,input:{title:'Old',description:''}}).value
  const p=planner(f,undefined)
  assert.throws(()=>p.apply('old'),{code:'WORKSPACE_REPLAN_REQUIRED'})
  assert.throws(()=>f.ledger.applyDecision('bypass-old',{decisionId:'old',currentStateHash:snapshot.stateHash,title:'Old',description:'',persistence:'create',route:{...f.route,workspaceId:'other'},reporting:'none'}),{code:'WORKSPACE_REPLAN_REQUIRED'})
  assert.deepEqual(f.ledger.getDecision('old'),original);assert.equal(f.ledger.snapshot().tasks.length,0)
})
test('explicit schedule workspace cannot be overridden by session selection',async t=>{
  const f=setup(t),task=f.ledger.createTask('scheduled-task',{title:'Explicit schedule'}).value,now=new Date().toISOString()
  f.ledger.updateTemplate('template',{templateId:'fixture',version:1,name:'Fixture',description:'',inputSchema:{type:'object'},defaults:{},resultContract:{type:'object'}})
  f.ledger.createSchedule('schedule',{scheduleId:'schedule',taskId:task.taskId,templateId:'fixture',templateVersion:1,enabled:true,intervalMs:60000,nextDueAt:now,overlap:'queue',input:{},route:{...f.route,workspaceId:'other'}})
  const occurrence=f.ledger.fireSchedule('fire',{scheduleId:'schedule',occurrenceAt:now}).value,run=f.ledger.getRun(occurrence.runId);assert.equal(run.workspaceConstraint,'other')
  const x=claim(f,run.runId)
  const choice=await chooseExecutionSession({claim:x.claim,context:f.ledger.sessionContext(x.ref),workspaces})
  assert.equal(choice.workspaceId,'other');assert.throws(()=>f.ledger.selectTaskSession('forged-schedule-choice',{...x.ref,workspaceId:'default',session:{mode:'new'}}),/workspace/)
})
test('node default workspace does not override the managed execution directory',async t=>{
  const f=setup(t),task=f.ledger.createTask('task',{title:'Default is not a constraint'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:f.route}).value;assert.equal(run.workspaceConstraint,undefined)
  const x=claim(f,run.runId)
  const choice=await chooseExecutionSession({claim:x.claim,context:f.ledger.sessionContext(x.ref),managedWorkspaceAvailable:true,workspaces}),selected=f.ledger.selectTaskSession('executor-choice',{...x.ref,...choice}).value
  assert.equal(selected.workspaceId,undefined);assert.equal(f.ledger.getRun(run.runId).route.workspaceId,undefined);assert.equal(f.ledger.getRun(run.runId).workspaceConstraint,undefined)
})

test('deterministic planning imports and works when the optional decision package is unavailable',async()=>{
  const {spawnSync}=await import('node:child_process')
  const script=`import {registerHooks} from 'node:module'; import assert from 'node:assert/strict';
    registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@dsh-task/typed-decisions')) throw Error('optional package unavailable');return next(specifier,context)}});
    const {TaskLedger}=await import(${JSON.stringify(new URL('../dist/ledger.js',import.meta.url).href)});
    const {TaskPlanner,taskDecisionCatalog}=await import(${JSON.stringify(new URL('../dist/planning.js',import.meta.url).href)});
    const ledger=TaskLedger.open(':memory:');const planner=new TaskPlanner(ledger,undefined,()=>taskDecisionCatalog(ledger,{}),()=>{});
    await assert.rejects(planner.plan({requestId:'no-route',title:'No authorized executor',description:''}),{code:'EXECUTOR_REQUIRED'});assert.equal(ledger.getDecision('no-route'),undefined);
    const {registerExecutor}=await import(${JSON.stringify(new URL('../../../tests/dsh/executor-fixture.mjs',import.meta.url).href)});
    registerExecutor(ledger,'worker',{nodeId:'worker',roles:['executor'],enabled:true,models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],capabilities:[],workspaceIds:[]});
    const record=await planner.plan({requestId:'no-package',title:'Use authorized route',description:''});assert.equal(record.routingStatus,'ready');assert.equal(record.source,'default');const applied=planner.apply(record.decisionId);assert.equal(ledger.getRun(applied.value.runId).route.nodeId,'worker');ledger.close();`
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'})
  assert.equal(child.status,0,child.stderr)
})

test('continuing a managed-directory run does not invent an explicit workspace constraint',t=>{
  const f=setup(t),task=f.ledger.createTask('task',{title:'Continue implicit workspace'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:f.route}).value
  const x=claim(f,run.runId);f.ledger.submit('blocked',{...x.ref,outcome:'blocked',summary:'Fixture awaits continuation'})
  const continued=f.ledger.continueRun('continue',{taskId:task.taskId,runId:run.runId}).value
  assert.equal(continued.route.workspaceId,undefined);assert.equal(continued.workspaceConstraint,undefined)
})
