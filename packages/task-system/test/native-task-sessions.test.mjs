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
