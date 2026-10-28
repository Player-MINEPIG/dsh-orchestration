import {registerExecutor,respondToCatalogRequests} from '../../../tests/dsh/executor-fixture.mjs';
import test from 'node:test'
import assert from 'node:assert/strict'
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs'
import {DecisionEngine,StructuredModelProvider} from './legacy-model-fixture.mjs'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'

test('a native user message exposes orchestration tools and applies an executor/model choice without a caller route',async()=>{
  let calls=0
  const decisions=new DecisionEngine([new StructuredModelProvider('judge',[{model:'router',version:'fixture',reasoningEfforts:[]}],{complete:async({input})=>{
    calls++
    const demanding=input.context.state.request.description.includes('复杂')
    const node=demanding?'quality-worker':'fast-worker',effort=demanding?'high':'off'
    const route=input.context.catalog.modelRoutes.find(row=>row.executorId===node&&row.reasoningEffort===effort)
    assert.ok(route,'the full model/effort choice must come from this executor catalog')
    assert.equal(input.context.catalog.workspaces.length,0)
    const choices={persist:'create',attach:'none',executor:node,modelEffort:route.id,reporting:'summary'}
    return {output:{answers:Object.fromEntries(input.questions.map(q=>[q.questionId,{type:'choice',choice:choices[q.questionId]??'none'}]))},modelVersion:'fixture'}
  }})],{defaultProvider:'judge',maxAttempts:1})
  const h=await createNativeHarness({executionRoot:true,config:{planningDecisionEnabled:true,sessionDecisionEnabled:false,autoExecute:false}})
  h.ctx.provide('decisionModels',decisions)
  let stopCatalogs=()=>{}
  try {
    for(const [nodeId,model,reasoningEfforts] of [['fast-worker','small',['off']],['quality-worker','large',['high']]]) registerExecutor(h.ledger, `register-${nodeId}`,{nodeId,roles:['executor'],models:[{provider:'worker-provider',model,reasoningEfforts}],capabilities:['text'],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()})
    stopCatalogs=respondToCatalogRequests(h.ledger,['fast-worker','quality-worker'])
    const discovery=await h.ctx.tools.execute({name:'task_nodes',callId:'discover',arguments:{details:true},signal:new AbortController().signal})
    assert.ok(discovery.value.routes.some(row=>row.nodeId==='fast-worker'&&row.model==='small'&&row.reasoningEffort==='off'))
    assert.deepEqual(discovery.value.nodes.find(row=>row.nodeId==='quality-worker').capabilities,['text'])
    for(const [nodeId,model,effort] of [['fast-worker','small','off'],['quality-worker','large','high']]) {
      const view=discovery.value.nodes.find(row=>row.nodeId===nodeId)
      assert.equal(view.catalog.state,'fresh','execution choices come from a completed discovery catalog')
      assert.deepEqual(view.policy.choice,{provider:'worker-provider',model,reasoningEffort:effort},'each executor owns its workload model default')
      assert.ok(discovery.value.routes.some(row=>row.nodeId===nodeId&&row.model===model&&row.reasoningEffort===effort))
    }
    for(const [index,text,nodeId,model,effort] of [[1,'帮我计算并提交一份简短报告','fast-worker','small','off'],[2,'帮我完成复杂的推理并提交分析报告','quality-worker','large','high']]) {
      const requestId=`message-${index}`
      h.adapter.script.push({name:'task_nodes',args:{}},{name:'task_dispatch',args:{commandId:requestId,title:text,description:text,nodeId}},'已派发，等待执行端报告')
      const handle=await h.ctx.agents.create({sessionId:SessionId(`planner-${index}`),agentOptions:{provider:'test-offline',model:'script'}})
      try {
        handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}))
        await handle.agent.whenIdle()
        const record=h.ledger.getDecision(requestId)
        assert.equal(record.receipt.kind,'deterministic-planning-v1')
        assert.equal(record.input.route,undefined)
        assert.equal(record.input.provider,undefined)
        assert.equal(record.input.model,undefined)
        const applied=h.ledger.commandReceipt(`apply-decision:${requestId}`)
        assert.ok(applied,JSON.stringify(h.adapter.requests.at(-1).messages))
        const run=h.ledger.getRun(applied.value.runId)
        assert.ok(run,'task_dispatch itself creates the assigned Run')
        assert.equal(run.route.nodeId,nodeId)
        assert.equal(run.route.provider,'worker-provider')
        assert.equal(run.route.model,model)
        assert.equal(run.route.reasoningEffort,effort)
        assert.equal(run.state,'queued')
        assert.equal(h.ledger.snapshot().attempts.length,0,'the conversation did not execute the workload locally')
        const request=h.adapter.requests[(index-1)*3]
        assert.doesNotMatch(JSON.stringify(request.messages.filter(row=>row.role==='system')),/prefer dispatching to a suitable executor/)
        assert.ok(request.tools.some(row=>row.name==='task_nodes'))
        assert.ok(!request.tools.some(row=>row.name==='task_plan'))
        const replay=await h.ctx.tools.execute({name:'task_dispatch',callId:`replay-${index}`,arguments:{commandId:requestId},signal:new AbortController().signal})
        assert.equal(replay.isError,false)
        assert.equal(h.ledger.snapshot().runs.length,index,'apply replay cannot duplicate dispatch')
      } finally {await handle.dispose()}
    }
    assert.equal(calls,0)
    registerExecutor(h.ledger, 'local-node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()})
    const task=h.ledger.createTask('owned-task',{title:'Owned workload',policy:{settlementQuietMs:0}}).value
    const run=h.ledger.createRun('owned-run',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value
    const claim=h.ledger.claim('owned-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value
    h.adapter.script.push({name:'task_nodes',args:{}},{name:'task_submit_result',args:{outcome:'success',summary:'Done'}})
    assert.equal((await h.ctx.taskSystem.native.execute(claim)).run.state,'succeeded')
    assert.doesNotMatch(JSON.stringify(h.adapter.requests.at(-1).messages.filter(row=>row.role==='system')),/You coordinate work across registered execution nodes/,'owned execution must not inherit the conversation dispatch preference')
    assert.doesNotMatch(JSON.stringify(h.adapter.requests.at(-1).messages),/fast-worker|quality-worker|worker-provider/,'owned task_nodes keeps catalog disclosure scoped to the assigned node')
  } finally {stopCatalogs();await h.dispose();await decisions.close()}
})

test('planner role exposes dispatch tools to its conversation model and hides workload tools',async()=>{
  const h=await createNativeHarness({executionRoot:true,config:{role:'planner'},script:['等待任务描述']})
  let handle
  try {
    handle=await h.ctx.agents.create({sessionId:SessionId('planner-only'),agentOptions:{provider:'test-offline',model:'script'}})
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'你可以调度哪些执行端？'}]}))
    await handle.agent.whenIdle()
    const names=h.adapter.requests[0].tools.map(tool=>tool.name)
    for(const name of ['task_nodes','task_dispatch','task_query','task_history','task_wait']) assert.ok(names.includes(name),name)
    for(const name of ['task_delegate','task_run','task_children','codex_delegate']) assert.ok(!names.includes(name),name)
    assert.doesNotMatch(JSON.stringify(h.adapter.requests[0].messages.filter(row=>row.role==='system')),/prefer dispatching to a suitable executor/)
  } finally {await handle?.dispose();await h.dispose()}
})


test('orchestration prompt follows active session duties and clears after leaving or settlement',async()=>{
  const h=await createNativeHarness({config:{centralMode:'host',executionEnabled:false}})
  let handle
  const sessionId=SessionId('switching-session-duty')
  const create=()=>h.ctx.agents.create({sessionId,meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}})
  const prompt=async expected=>{
    h.adapter.script.push('Session state checked')
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Explain your current session responsibility.'}]}))
    await handle.agent.whenIdle()
    const system=JSON.stringify(h.adapter.requests.at(-1).messages.filter(row=>row.role==='system'))
    assert.equal(system.includes('prefer dispatching to a suitable executor'),expected)
  }
  try {
    handle=await create()
    await prompt(false)
    const active=await h.ctx.taskSystem.sessionCollaboration.activate(handle.agent,'Session duty fixture')
    await prompt(true)
    h.ctx.taskSystem.sessionCollaboration.leave(handle.agent)
    await prompt(false)
    await h.ctx.taskSystem.sessionCollaboration.activate(handle.agent,undefined,active.binding.projectId)
    await prompt(true)
    await h.ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    handle=await h.ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'test-offline',model:'script'}})
    await prompt(true)
    const parent=(await h.ctx.taskSystem.sessionCollaboration.command(handle.agent,{kind:'create',title:'Parent',policy:{settlementQuietMs:0}},'duty-parent')).value
    await h.ctx.taskSystem.sessionCollaboration.command(handle.agent,{kind:'bind',taskId:parent.taskId},'duty-bind')
    h.ctx.taskSystem.sessionCollaboration.leave(handle.agent)
    await prompt(true)
    h.ledger.submitDispatcherResult('duty-settle',{nodeId:'local',sessionId,outcome:'success',summary:'Verified',report:{title:'Result',body:'Completed the coordinator responsibility'}})
    await prompt(false)
  } finally {await handle?.dispose();await h.dispose()}
})
