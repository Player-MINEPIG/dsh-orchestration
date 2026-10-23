import {registerExecutor} from '../../../tests/dsh/executor-fixture.mjs';
import test from 'node:test'
import assert from 'node:assert/strict'
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs'
import {DecisionEngine,StructuredModelProvider} from './legacy-model-fixture.mjs'

for (const planningDecisionEnabled of [false,true]) for(const sessionDecisionEnabled of [false,true]) test(`native scheduler=${planningDecisionEnabled} and executor=${sessionDecisionEnabled} decision switches are independent`,async()=>{
  let plannerCalls=0,executorCalls=0
  const decisionProvider=new StructuredModelProvider('ordinary',[{model:'judge',version:'fixture',reasoningEfforts:[]}],{complete:async({input})=>{
    const questions=input.questions;let answers
    if(questions.some(q=>q.questionId==='persist')) {
      plannerCalls++;assert.ok(!questions.some(q=>q.questionId==='workspace'));assert.deepEqual(input.context.catalog.workspaces,[])
      const choices={persist:'create',attach:'none',executor:'local',modelEffort:input.context.catalog.modelRoutes[0].id,reporting:'none'}
      answers=Object.fromEntries(questions.map(q=>[q.questionId,{type:'choice',choice:choices[q.questionId]??'none'}]))
    } else {executorCalls++;assert.deepEqual(questions.map(q=>q.questionId),['session']);answers={session:{type:'choice',choice:'new'}}}
    return {output:{answers},modelVersion:'fixture'}
  }})
  const decisions=new DecisionEngine([decisionProvider],{defaultProvider:'ordinary',maxAttempts:1})
  const h=await createNativeHarness({executionRoot:true,config:{planningDecisionEnabled,sessionDecisionEnabled},script:[{name:'task_submit_result',args:{outcome:'success',summary:'Fixture-only independent decisions'}}]})
  h.ctx.provide('decisionModels',decisions)
  try {
    const l=h.ledger
    l.registerWorkspace('workspace',{workspaceId:'default',nodeId:'local',path:h.dir,label:'Fixture',state:'ready',createdAt:new Date().toISOString()})
    registerExecutor(l, 'node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,lastSeenAt:new Date().toISOString()})
    l.registerWorkspace('alternate-workspace',{workspaceId:'other',nodeId:'local',path:h.dir,label:'other fixture',state:'ready',createdAt:new Date().toISOString()});
    registerExecutor(l, 'expanded-node',{...l.getNode('local'),workspaceIds:['default','other']});
    const invoke=async(action)=>h.ctx.tools.execute({callId:`plan-${action}`,name:action==='propose'?'task_plan':'task_dispatch',arguments:action==='propose'?{requestId:'plan',title:'Independent switches',description:''}:{commandId:'plan'},signal:new AbortController().signal})
    assert.equal((await invoke('propose')).isError,false)
    assert.equal(plannerCalls,planningDecisionEnabled?1:0)
    assert.equal((await invoke('apply')).isError,false)
    const task=l.snapshot().tasks[0]
    assert.equal(task.workspaceId,undefined)
    const run=l.snapshot().runs[0]??l.createRun('manual-assignment',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value
    assert.equal(run.workspaceConstraint,undefined)
    const claim=l.claim('claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value
    const result=await h.ctx.taskSystem.native.execute(claim)
    assert.equal(result.run.state,'succeeded');assert.equal(plannerCalls,planningDecisionEnabled?1:0);assert.equal(executorCalls,0,'a first run has no reusable session and needs no model call')
    const next=l.createRun('next-run',{taskId:task.taskId,route:run.route}).value
    const nextClaim=l.claim('next-claim',{runId:next.runId,nodeId:'local',ttlMs:10000}).value
    h.adapter.script.push({name:'task_submit_result',args:{outcome:'success',summary:'Second run may choose a new session'}})
    const nextResult=await h.ctx.taskSystem.native.execute(nextClaim)
    assert.equal(nextResult.run.state,'succeeded');assert.equal(plannerCalls,planningDecisionEnabled?1:0);assert.equal(executorCalls,sessionDecisionEnabled?1:0)
    assert.equal(nextResult.sessionId===result.sessionId,!sessionDecisionEnabled,'disabled executor decisions reuse the authoritative task session')
  } finally {await h.dispose();await decisions.close()}
})
