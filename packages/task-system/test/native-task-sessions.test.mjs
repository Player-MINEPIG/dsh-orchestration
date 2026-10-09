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
