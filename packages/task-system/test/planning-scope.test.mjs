import test from 'node:test'
import assert from 'node:assert/strict'
import {TaskLedger} from '../dist/ledger.js'
import {TaskPlanner,taskDecisionCatalog} from '../dist/planning.js'
import {chooseExecutionSession} from '../dist/execution-session.js'
import {DecisionEngine,StructuredModelProvider} from './legacy-model-fixture.mjs'
import {Config} from '../dist/dsh-plugin.js'
import {SaveStartupInput} from '../dist/startup-settings.js'

function setup(t) {
  const ledger=TaskLedger.open(':memory:');t.after(()=>ledger.close())
  for(const workspaceId of ['default','other']) ledger.registerWorkspace(`ws-${workspaceId}`,{workspaceId,nodeId:'worker',label:workspaceId,path:`/tmp/fixture-${workspaceId}`,state:'ready',createdAt:new Date().toISOString()})
  ledger.registerNode('node',{nodeId:'worker',roles:['executor'],models:[{provider:'fixture',model:'fixture',reasoningEfforts:['high']}],capabilities:['text'],workspaceIds:['default','other'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()})
  const catalog=()=>taskDecisionCatalog(ledger,{fixture:true}),route={nodeId:'worker',provider:'fixture',model:'fixture',requiredCapabilities:['text']}
  return {ledger,catalog,route}
}
function engine(t,answer) {
  const provider=new StructuredModelProvider('ordinary',[{model:'judge',version:'fixture',reasoningEfforts:[]}],{complete:async call=>({output:{answers:answer(call.input.questions,call.input.context)},modelVersion:'fixture'})})
  const decisions=new DecisionEngine([provider],{defaultProvider:'ordinary',maxAttempts:1});t.after(()=>decisions.close());return decisions
}
const plannerAnswers=(questions,context)=>Object.fromEntries(questions.map(q=>[q.questionId,{type:'choice',choice:({persist:'create',attach:'none',executor:'worker',modelEffort:context.catalog.modelRoutes.find(r=>r.executorId==='worker'&&!r.reasoningEffort).id,reporting:'none'})[q.questionId]}]))
const planner=(f,decisions,enabled=true)=>new TaskPlanner(f.ledger,decisions,f.catalog,()=>{},Date.now,()=>enabled)
const workspaces=['default','other'].map(workspaceId=>({workspaceId,nodeId:'worker',description:workspaceId,eligible:true}))
function claim(f,runId) {const claim=f.ledger.claim(`claim-${runId}`,{runId,nodeId:'worker',ttlMs:60000}).value;const ref={runId,attemptId:claim.attempt.attemptId,nodeId:'worker',fence:claim.attempt.fence,executionId:`exec-${runId}`};claim.attempt=f.ledger.markRunning(`running-${runId}`,ref).value;return {claim,ref}}

test('planning flag is independent, compatible by default and exposed in strict startup writes',()=>{
  assert.equal(Config({}).planningDecisionEnabled.get(),true);assert.equal(Config({}).sessionDecisionEnabled.get(),false)
  const expected={role:'both',defaultWorkspaceId:'default',sessionDecisionEnabled:true,planningDecisionEnabled:true}
  assert.deepEqual(SaveStartupInput.parse({target:'task',expected,changes:{planningDecisionEnabled:false}}).changes,{planningDecisionEnabled:false})
})
for(const mode of ['disabled','missing']) test(`${mode} planning calls no model, preserves an explicit route and otherwise leaves routing pending`,async t=>{
  const f=setup(t);let calls=0
  const p=planner(f,mode==='missing'?undefined:{evaluate:async()=>{calls++;throw Error('must not evaluate')}},mode!=='disabled')
  const pending=await p.plan({requestId:'pending',title:'Await explicit assignment',description:''})
  assert.equal(pending.source,'default');assert.equal(pending.routingStatus,'pending-route');assert.equal(pending.proposal.executor,null)
  const unassigned=p.apply('pending');assert.equal(unassigned.value.runId,undefined);assert.equal(f.ledger.snapshot().runs.length,0)
  const fixed=await p.plan({requestId:'fixed',title:'Fixed route',description:'',route:{...f.route,workspaceId:'other'}})
  assert.equal(fixed.routingStatus,'ready');const applied=p.apply('fixed'),run=f.ledger.getRun(applied.value.runId)
  assert.equal(run.route.nodeId,'worker');assert.deepEqual(run.route.requiredCapabilities,['text']);assert.equal(run.route.workspaceId,'other');assert.equal(f.ledger.getTask(applied.value.taskId).workspaceId,'other');assert.equal(calls,0)
})
test('scheduler request omits workspace and model workspace answers cannot become Task constraints',async t=>{
  const f=setup(t);let seen
  const p=planner(f,engine(t,(questions,context)=>{seen=questions;assert.deepEqual(context.catalog.workspaces,[]);return plannerAnswers(questions,context)}))
  const record=await p.plan({requestId:'model',title:'Executor owns workspace',description:''});assert.equal(record.proposal.kind,'proposal');assert.ok(!seen.some(q=>q.questionId==='workspace'));assert.equal(record.proposal.workspace,null)
  const applied=p.apply('model'),run=f.ledger.getRun(applied.value.runId),task=f.ledger.getTask(applied.value.taskId)
  assert.equal(task.workspaceId,undefined);assert.equal(run.route.workspaceId,'default');assert.equal(run.workspaceConstraint,undefined)
})
test('an injected scheduler workspace answer is rejected instead of copied into a Task',async t=>{
  const f=setup(t),p=planner(f,engine(t,(questions,context)=>({...plannerAnswers(questions,context),workspace:{type:'choice',choice:'other'}})))
  const result=await p.plan({requestId:'injected',title:'No cross-role workspace',description:''})
  assert.equal(result.proposal.kind,'abstain');assert.throws(()=>p.apply('injected'),{code:'ABSTAIN'});assert.equal(f.ledger.snapshot().tasks.length,0)
})
test('explicit caller Task workspace remains a hard constraint while scheduler model never selects it',async t=>{
  const f=setup(t),p=planner(f,engine(t,plannerAnswers))
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
test('explicit schedule workspace cannot be overridden by executor decisions',async t=>{
  const f=setup(t),task=f.ledger.createTask('scheduled-task',{title:'Explicit schedule'}).value,now=new Date().toISOString()
  f.ledger.updateTemplate('template',{templateId:'fixture',version:1,name:'Fixture',description:'',inputSchema:{type:'object'},defaults:{},resultContract:{type:'object'}})
  f.ledger.createSchedule('schedule',{scheduleId:'schedule',taskId:task.taskId,templateId:'fixture',templateVersion:1,enabled:true,intervalMs:60000,nextDueAt:now,overlap:'queue',input:{},route:{...f.route,workspaceId:'other'}})
  const occurrence=f.ledger.fireSchedule('fire',{scheduleId:'schedule',occurrenceAt:now}).value,run=f.ledger.getRun(occurrence.runId);assert.equal(run.workspaceConstraint,'other')
  const x=claim(f,run.runId),decisions=engine(t,questions=>{assert.deepEqual(Object.keys(questions.find(q=>q.questionId==='workspace').candidates),['other']);return {session:{type:'choice',choice:'new'},workspace:{type:'choice',choice:'default'}}})
  const choice=await chooseExecutionSession({claim:x.claim,context:f.ledger.sessionContext(x.ref),workspaces,decisions})
  assert.equal(choice.workspaceId,'other');assert.throws(()=>f.ledger.selectTaskSession('forged-schedule-choice',{...x.ref,workspaceId:'default',session:{mode:'new'}}),/workspace/)
})
test('derived default workspace remains selectable by the executor',async t=>{
  const f=setup(t),task=f.ledger.createTask('task',{title:'Default is not a constraint'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:f.route}).value;assert.equal(run.workspaceConstraint,undefined)
  const x=claim(f,run.runId),decisions=engine(t,()=>({session:{type:'choice',choice:'new'},workspace:{type:'choice',choice:'other'}}))
  const choice=await chooseExecutionSession({claim:x.claim,context:f.ledger.sessionContext(x.ref),workspaces,decisions}),selected=f.ledger.selectTaskSession('executor-choice',{...x.ref,...choice}).value
  assert.equal(selected.workspaceId,'other');assert.equal(f.ledger.getRun(run.runId).workspaceConstraint,undefined)
})

test('deterministic planning imports and works when the optional decision package is unavailable',async()=>{
  const {spawnSync}=await import('node:child_process')
  const script=`import {registerHooks} from 'node:module'; import assert from 'node:assert/strict';
    registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@dsh-task/typed-decisions')) throw Error('optional package unavailable');return next(specifier,context)}});
    const {TaskLedger}=await import(${JSON.stringify(new URL('../dist/ledger.js',import.meta.url).href)});
    const {TaskPlanner,taskDecisionCatalog}=await import(${JSON.stringify(new URL('../dist/planning.js',import.meta.url).href)});
    const ledger=TaskLedger.open(':memory:');const planner=new TaskPlanner(ledger,undefined,()=>taskDecisionCatalog(ledger,{}),()=>{});
    const record=await planner.plan({requestId:'no-package',title:'Wait for route',description:''});assert.equal(record.routingStatus,'pending-route');assert.equal(record.source,'default');ledger.close();`
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'})
  assert.equal(child.status,0,child.stderr)
})

test('continuing a derived-default run does not invent an explicit workspace constraint',t=>{
  const f=setup(t),task=f.ledger.createTask('task',{title:'Continue implicit workspace'}).value,run=f.ledger.createRun('run',{taskId:task.taskId,route:f.route}).value
  const x=claim(f,run.runId);f.ledger.submit('blocked',{...x.ref,outcome:'blocked',summary:'Fixture awaits continuation'})
  const continued=f.ledger.continueRun('continue',{taskId:task.taskId,runId:run.runId}).value
  assert.equal(continued.route.workspaceId,'default');assert.equal(continued.workspaceConstraint,undefined)
})
