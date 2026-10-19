import { writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export const name = 'live-orchestration-scenario';
export const inject = ['taskSystem', 'decisionModels', 'loader'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function apply(ctx, config) {
  const controller = new AbortController();
  let job;
  const timer = setTimeout(() => { job = run(ctx, config, controller.signal); }, 0);
  ctx.effect(() => async () => { clearTimeout(timer); controller.abort(); await job; });
}
async function run(ctx, config, signal) {
  const result = { sampledAt:new Date().toISOString(), status:'running', checks:[], runs:[] };
  const save = () => writeFileSync(config.output, JSON.stringify(result, null, 2)+'\n', {mode:0o600});
  const require = (value, message) => { if (!value) throw Object.assign(new Error(message), {code:message}); };
  try {
    if (existsSync(config.guard)) return;
    closeSync(openSync(config.guard, 'wx', 0o600));
    await ctx.loader.await();
    const ledger = ctx.taskSystem.ledger;
    require(ctx.taskSystem.config.nodeId === 'vps-planner', 'WRONG_NODE');
    require(!ctx.taskSystem.config.autoExecute && !ctx.taskSystem.config.schedulerEnabled, 'UNBOUNDED_ADMISSION');
    const {TaskPlanner, taskDecisionCatalog} = await import(pathToFileURL(join(config.packageRoot,'dist/planning.js')));
    const planner = new TaskPlanner(ledger, ctx.decisionModels, () => taskDecisionCatalog(ledger, {scope:'authorized two-device acceptance'}, 60000), () => {});
    const decision = await planner.plan({requestId:'live-20261006-plan', title:'独立的双端真实验收报告任务', description:'Create a new Task to produce a short report comparing task result, report validity, and delivery acknowledgement. Execute on the only eligible mbp-executor using deepseek-flash off. This is a new authorized request, not an observation or an old negative test. Workspace is acceptance.', provider:'live-native', model:'live-judge', reasoningEffort:'off', workspaceId:'acceptance'}, {signal});
    result.planning = decision;
    save();
    require(decision.receipt.status === 'answered', 'PLANNING_NOT_ANSWERED');
    require(decision.proposal.kind === 'proposal' && decision.proposal.persistence === 'create', 'PLANNING_NOT_NEW_TASK');
    require(decision.proposal.executor?.id === 'mbp-executor' && decision.proposal.modelRoute?.provider === 'deepseek-official' && decision.proposal.modelRoute?.model === 'deepseek-flash', 'PLANNING_BAD_ROUTE');
    result.checks.push('real VPS TaskPlanner decision answered and accepted under operator policy');
    result.stage='createTask';save();
    const task = ledger.createTask('live-20261006-create', {taskId:'live-20261006-report', title:'双端真实报告与会话连续性验收', description:'Follow this run configuration. Produce a concise report. Use only task_submit_result with outcome success, summary, reportTitle, reportBody. No filesystem, shell, delegation or messaging. For a follow-up run reuse previous Task conversation facts.', workspaceId:'acceptance', policy:{allowedNodeIds:['mbp-executor'],allowedWorkspaceIds:['acceptance'],allowedTools:[],maxRuntimeMs:45000,maxSafeRetries:0,settlementQuietMs:0,maxChildren:0,maxDescendants:0}}).value;
    result.taskId = task.taskId;
    const route = {nodeId:'mbp-executor',provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',requiredCapabilities:['acceptance'],workspaceId:'acceptance'};
    const wait = async runId => {
      const deadline = Date.now()+100000;
      while (Date.now()<deadline) {
        signal.throwIfAborted();
        const current = ledger.getRun(runId);
        if (['succeeded','failed','blocked','cancelled','uncertain'].includes(current.state)) return current;
        await delay(500);
      }
      throw Object.assign(new Error('RUN_DEADLINE'),{code:'RUN_DEADLINE'});
    };
    for (const phase of [1,2]) {
      const configuration = phase === 1
        ? {phase, instructions:'Write a report under 180 Chinese characters. Explain that task completion, report validity, and receipt ACK are distinct. Compute 19+23. Store the exact private conversation marker ORCH-20261006-CEDAR-42 in reportBody for a later follow-up. Call task_submit_result with outcome success and the report. Do not call other tools.'}
        : {phase, instructions:'From the prior run in this same Task conversation, recall the exact marker and arithmetic result. Do not use task history tools. Include both in a report under 100 Chinese characters, then call task_submit_result with outcome success. The marker is intentionally not repeated in this run configuration.'};
      result.stage=`createRun-${phase}`;save();
      const queued = ledger.createRun(`live-20261006-run-${phase}`,{runId:`live-20261006-run-${phase}`,taskId:task.taskId,route,configuration:{input:configuration,reporting:'summary'}}).value;
      result.runs.push({phase,runId:queued.runId,state:queued.state});save();
      const settled = await wait(queued.runId);
      const snapshot = ledger.snapshot();
      const attempts = snapshot.attempts.filter(row => row.runId === settled.runId);
      const reports = snapshot.reports.filter(row => row.runId === settled.runId);
      const sessionEvents = snapshot.events.filter(row => row.runId === settled.runId && row.type === 'session.selected');
      Object.assign(result.runs.at(-1),{state:settled.state,settled,attempts,reports,sessionEvents});save();
      require(settled.state === 'succeeded','WORKLOAD_NOT_SUCCEEDED');
      require(reports.some(row => row.body?.includes('ORCH-20261006-CEDAR-42')),'REPORT_MARKER_MISSING');
      require(attempts.length === 1 && attempts[0].sessionId, 'INVALID_ATTEMPT_COUNT');
    }
    require(result.runs[0].attempts[0].sessionId === result.runs[1].attempts[0].sessionId, 'SESSION_NOT_REUSED');
    result.checks.push('two real native workloads succeeded with report marker', 'same Task session reused across runs');
    result.status='passed';
  } catch (error) {
    result.status='failed';result.errorCode=error.code??error.name;
    if (error.name === 'TaskError') result.coreDiagnostic=error.message.slice(0,200);
  }
  result.finishedAt=new Date().toISOString();save();
}
