import {registerExecutor,publishModels} from '../../../tests/dsh/executor-fixture.mjs';
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
  try {
    for(const [nodeId,model,reasoningEfforts] of [['fast-worker','small',['off']],['quality-worker','large',['high']]]) registerExecutor(h.ledger, `register-${nodeId}`,{nodeId,roles:['executor'],models:[{provider:'worker-provider',model,reasoningEfforts}],capabilities:['text'],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()})
    const discovery=await h.ctx.tools.execute({name:'task_nodes',callId:'discover',arguments:{},signal:new AbortController().signal})
    assert.deepEqual(discovery.value.find(row=>row.nodeId==='fast-worker').models,[{provider:'worker-provider',model:'small',reasoningEfforts:['off']}])
    assert.deepEqual(discovery.value.find(row=>row.nodeId==='quality-worker').capabilities,['text'])
    for(const [index,text,nodeId,model,effort] of [[1,'帮我计算并提交一份简短报告','fast-worker','small','off'],[2,'帮我完成复杂的推理并提交分析报告','quality-worker','large','high']]) {
      const requestId=`message-${index}`
      h.adapter.script.push({name:'task_nodes',args:{}},{name:'task_plan',args:{requestId,title:text,description:text}},{name:'task_dispatch',args:{commandId:requestId}},'已派发，等待执行端报告')
      const handle=await h.ctx.agents.create({sessionId:SessionId(`planner-${index}`),agentOptions:{provider:'test-offline',model:'script'}})
      try {
        handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}))
        await handle.agent.whenIdle()
        const record=h.ledger.getDecision(requestId)
        assert.equal(record.receipt.status,'answered')
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
        const request=h.adapter.requests[(index-1)*4]
        assert.match(JSON.stringify(request.messages.filter(row=>row.role==='system')),/prefer dispatching to a suitable executor/)
        assert.ok(request.tools.some(row=>row.name==='task_nodes'))
        const plan=request.tools.find(row=>row.name==='task_plan')
        assert.ok(plan)
        assert.match(plan.description,/No caller-specified execution model/)
        assert.match(plan.parameters.properties.model.description,/decision-model override/)
        const replay=await h.ctx.tools.execute({name:'task_dispatch',callId:`replay-${index}`,arguments:{commandId:requestId},signal:new AbortController().signal})
        assert.equal(replay.isError,false)
        assert.equal(h.ledger.snapshot().runs.length,index,'apply replay cannot duplicate dispatch')
      } finally {await handle.dispose()}
    }
    assert.equal(calls,2)
    registerExecutor(h.ledger, 'local-node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()})
    const task=h.ledger.createTask('owned-task',{title:'Owned workload',policy:{settlementQuietMs:0}}).value
    const run=h.ledger.createRun('owned-run',{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value
    const claim=h.ledger.claim('owned-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value
    h.adapter.script.push({name:'task_nodes',args:{}},{name:'task_submit_result',args:{outcome:'success',summary:'Done'}})
    assert.equal((await h.ctx.taskSystem.native.execute(claim)).run.state,'succeeded')
    assert.doesNotMatch(JSON.stringify(h.adapter.requests.at(-1).messages.filter(row=>row.role==='system')),/You coordinate work across registered execution nodes/,'owned execution must not inherit the conversation dispatch preference')
    assert.doesNotMatch(JSON.stringify(h.adapter.requests.at(-1).messages),/fast-worker|quality-worker|worker-provider/,'owned task_nodes keeps catalog disclosure scoped to the assigned node')
  } finally {await h.dispose();await decisions.close()}
})

test('planner role exposes dispatch tools to its conversation model and hides workload tools',async()=>{
  const h=await createNativeHarness({executionRoot:true,config:{role:'planner'},script:['等待任务描述']})
  let handle
  try {
    handle=await h.ctx.agents.create({sessionId:SessionId('planner-only'),agentOptions:{provider:'test-offline',model:'script'}})
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'你可以调度哪些执行端？'}]}))
    await handle.agent.whenIdle()
    const names=h.adapter.requests[0].tools.map(tool=>tool.name)
    for(const name of ['task_nodes','task_plan','task_dispatch','task_query','task_history','task_wait']) assert.ok(names.includes(name),name)
    for(const name of ['task_delegate','task_run','task_children','codex_delegate']) assert.ok(!names.includes(name),name)
    assert.match(JSON.stringify(h.adapter.requests[0].messages.filter(row=>row.role==='system')),/prefer dispatching to a suitable executor/)
  } finally {await handle?.dispose();await h.dispose()}
})
