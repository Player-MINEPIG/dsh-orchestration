import {writeFileSync,existsSync,openSync,closeSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const name='live-ad-hoc-orchestration';
export const inject=['taskSystem','agents','sessions','sessionPersistence','loader'];
export function apply(ctx,config) {
  const controller=new AbortController();let job;
  const timer=setTimeout(()=>{job=run(ctx,config,controller.signal)},0);
  ctx.effect(()=>async()=>{clearTimeout(timer);controller.abort();await job});
}
async function run(ctx,config,signal) {
  const result={status:'running',sampledAt:new Date().toISOString(),checks:[]};
  const save=()=>writeFileSync(config.output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  const require=(value,message)=>{if(!value)throw Object.assign(new Error(message),{code:message})};
  const marker=config.marker??'ORCH-ADHOC-20261006-95';
  let handle,completion,originalComplete;const cancel=new AbortController();
  const timeout=setTimeout(()=>cancel.abort(new Error('AD_HOC_DEADLINE')),150000);
  try {
    if(existsSync(config.guard))return;
    closeSync(openSync(config.guard,'wx',0o600));await ctx.loader.await();
    const ledger=ctx.taskSystem.ledger;
    require(ctx.taskSystem.config.role==='planner'&&!ctx.taskSystem.config.autoExecute&&!ctx.taskSystem.config.schedulerEnabled,'WRONG_OR_UNBOUNDED_HOST');
    require(!ledger.snapshot().runs.some(run=>['queued','running','uncertain'].includes(run.state)&&!run.historyOnly&&!run.observationOnly),'EXISTING_ACTIVE_RUN');
    completion=ctx.get('decisionModels');originalComplete=completion?.ask;
    if(completion) completion.ask=async function(input,options){
      try {
        const value=await originalComplete.call(this,input,options);
        const parseable=!!value.answers&&typeof value.answers==='object';
        result.decisionCompletion={usage:value.usage,outputBytes:Buffer.byteLength(JSON.stringify(value.answers)),parseable};save();return value;
      }catch(error){result.decisionCompletionError={name:error.name,code:typeof error.code==='string'?error.code:'unknown'};save();throw error}
    };
    const {createUserMessage}=await import(pathToFileURL(config.llmEntry));
    const combined=AbortSignal.any([signal,cancel.signal]);let steps=0;
    const requestId=config.requestId??'live-ad-hoc-20261006-plan';
    handle=await ctx.agents.create({sessionId:config.sessionId??'live-ad-hoc-20261006-conversation',agentOptions:{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',maxTokens:1024},signal:combined,setup:(agentCtx,agent)=>{
      agentCtx.tools.restrict({allow:['task_nodes','task_plan','task_dispatch','task_query']});
      agentCtx.systemPrompt.section({name:'live-acceptance-identity',order:95,interpolate:false,text:`This is one bounded authorized acceptance request. Use requestId ${requestId} for task_plan and commandId ${requestId} for task_dispatch. Do not specify route, workspaceId or decision provider/model/effort overrides. Create one new Task for this incoming request. Do not create or modify other tasks. After applying the proposal, return a short acknowledgement; do not wait for execution in this conversation.`});
      agentCtx.on('agent/pre-step',async(_payload,next)=>++steps<=6?next():{kind:'reject'});
      agentCtx.tools.guard(exec=>{
        if(exec.agent!==agent)return 'Foreign agent';
        if(exec.name==='task_plan'||exec.name==='task_dispatch') {
          const args=exec.arguments;
          if(args.workspaceId)return 'Omit workspaceId: the user supplied no workspace constraint; the executor selects its workspace';
          if((exec.name==='task_plan'?args.requestId:args.commandId)!==requestId||args.route||args.provider||args.model||args.reasoningEffort)return 'Acceptance requires an unassigned natural-language task';
          if(exec.name==='task_plan'&&!String(args.description).includes(marker))return 'Complete task instructions required';
          if(exec.name==='task_dispatch') {
            const record=ledger.getDecision(args.requestId??args.commandId),proposal=record?.proposal;
            if(record?.receipt?.status!=='answered'||proposal?.kind!=='proposal'||proposal.persistence!=='create'||proposal.executor?.id!=='mbp-executor'||proposal.modelRoute?.provider!=='deepseek-official'||proposal.modelRoute?.model!=='deepseek-flash')return 'Outside bounded acceptance catalog';
          }
        }
        return undefined;
      });
    }});
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:`这是一个新的独立任务，请优先安排合适的执行端完成：计算${config.expression??'37+58'}，用不到100字的中文提交结果报告，报告包含验收标记 ${marker}。只调用 task_submit_result 提交 outcome=success、summary、reportTitle 和 reportBody，不使用文件、shell、消息或子任务工具。请你自行选择执行端和执行模型；我没有指定它们。`}]}));
    await handle.agent.whenIdle();await ctx.sessions.flush(handle.agent.session);combined.throwIfAborted();
    const record=ledger.getDecision(requestId),applied=ledger.commandReceipt(`apply-decision:${requestId}`);
    result.planning=record;result.conversationSteps=steps;save();
    require(record&&record.receipt.status==='answered'&&applied?.value?.runId,'CONVERSATION_DID_NOT_DISPATCH');
    require(!record.input.route&&!record.input.provider&&!record.input.model&&!record.input.reasoningEffort,'CALLER_PINNED_ROUTE');
    result.planning=record;result.applied=applied;result.taskId=applied.value.taskId;result.runId=applied.value.runId;result.conversationSteps=steps;save();
    result.checks.push('real conversation model received dispatch tools and preferred a remote executor','real decision model selected execution route without caller model/node/effort','task_dispatch created exactly one assigned Run');
    await handle.dispose();handle=undefined;
    const deadline=Date.now()+100000;
    while(Date.now()<deadline) {
      combined.throwIfAborted();const current=ledger.getRun(result.runId);
      if(['succeeded','failed','blocked','cancelled','uncertain'].includes(current.state)){result.run=current;break}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    require(result.run?.state==='succeeded','WORKLOAD_NOT_SUCCEEDED');
    const snapshot=ledger.snapshot();result.attempts=snapshot.attempts.filter(row=>row.runId===result.runId);result.reports=snapshot.reports.filter(row=>row.runId===result.runId);result.sessionEvents=snapshot.events.filter(row=>row.runId===result.runId&&row.type==='session.selected');
    require(result.attempts.length===1&&result.reports.some(row=>row.kind==='result'&&row.body.includes(marker)&&row.body.includes(String(config.expected??95))),'INVALID_REAL_REPORT');
    result.checks.push('MBP native workload succeeded with the expected report');result.status='passed';
  } catch(error) {result.status='failed';result.errorCode=error.code??error.name}
  finally {clearTimeout(timeout);await handle?.dispose();if(completion&&originalComplete)completion.ask=originalComplete}
  result.finishedAt=new Date().toISOString();save();
}
