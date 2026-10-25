import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
import * as registration from '../dist/project-registration/plugin.js';
import {SessionCollaboration} from '../dist/project-collaboration/session.js';
import {TaskLedger} from '../dist/ledger.js';
import {ScheduledPlans} from '../dist/scheduled-plans.js';
import {Workbench} from '../dist/workbench.js';

const preferred={provider:'workload',model:'preferred',reasoningEffort:'high'};
const explicit={provider:'workload',model:'explicit',reasoningEffort:'low'};
const fallback={provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'};
function publish(ledger,models,tag,now=Date.now()){
  const request=ledger.executionModels.request(`request-${tag}`,{nodeId:'worker'}).catalog.request;
  return ledger.completeExecutionModels(`complete-${tag}`,{nodeId:'worker',requestId:request.requestId,generation:request.generation,result:{state:'success',observedAt:now,complete:true,temporaryWorkspaceReady:true,models}}).value;
}
function defaults(ledger,choice,tag){const view=ledger.executionModels.view('worker');return ledger.executionModels.setDefault(tag,{nodeId:'worker',expectedRevision:view.policy.revision,expectedCatalogRevision:view.catalog.snapshot.revision,choice});}
function worker(ledger){ledger.registerNode('worker',{nodeId:'worker',roles:['executor'],enabled:true,models:[],capabilities:[],workspaceIds:[],maxConcurrent:2});}

test('real task_dispatch tools use bound context and node default or explicit workload without mandatory workspaces',async()=>{
  const h=await createNativeHarness({config:{nodeId:'owner',localNode:null,planningDecisionEnabled:false,autoExecute:false,schedulerEnabled:false}});
  let handle;
  try{
    await h.ctx.plugin(registration,{namespaces:['fixture/project']});
    h.ledger.registerNode('owner-node',{nodeId:'owner',roles:['planner'],enabled:true,models:[],capabilities:[],workspaceIds:[]});
    worker(h.ledger);publish(h.ledger,[preferred,explicit,fallback],'initial');defaults(h.ledger,preferred,'default');
    handle=await h.ctx.agents.create({sessionId:SessionId('project-policy-source'),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});
    const session=new SessionCollaboration(h.ledger,'owner',h.ledger.projectCollaborate.bind(h.ledger));
    await session.activate(handle.agent,'Model policy project');
    let call=0;
    const invoke=(name,args)=>h.ctx.tools.execute({name,arguments:args,callId:ToolCallId(`project-policy-${++call}`),agent:handle.agent,signal:new AbortController().signal});
    const nodes=await invoke('task_nodes',{details:true});assert.equal(nodes.isError,false,JSON.stringify(nodes));
    assert.equal(nodes.value.nodes[0].nodeId,'worker');assert.equal(nodes.value.nodes[0].catalog.state,'fresh');assert.equal(nodes.value.nodes[0].policy.choice.model,'preferred');
    assert.ok(nodes.value.routes.some(route=>route.model==='preferred' && route.workspaceId===undefined));
    const args={commandId:'node-default-work',title:'Use the configured node model',description:'Authorized project work',nodeId:'worker'};
    const normal=await invoke('task_dispatch',args);assert.equal(normal.isError,false,JSON.stringify(normal));
    const first=h.ledger.history(normal.value.taskId).runs[0];assert.equal(first.route.model,'preferred');assert.equal(first.executionModel.origin,'node_default');assert.equal(first.route.workspaceId,undefined);assert.ok(first.projectContext.project.projectId);
    const replay=await invoke('task_dispatch',args);assert.equal(replay.isError,false,JSON.stringify(replay));assert.equal(replay.value.taskId,normal.value.taskId);
    const selected=await invoke('task_dispatch',{commandId:'explicit-work',title:'Use the user model',description:'Execute with the explicit user selection',nodeId:'worker',executionModel:explicit});assert.equal(selected.isError,false,JSON.stringify(selected));
    const second=h.ledger.history(selected.value.taskId).runs[0];assert.equal(second.route.model,'explicit');assert.equal(second.executionModel.origin,'explicit');
    const missing={provider:'workload',model:'removed',reasoningEffort:'low'};
    const unavailable=await invoke('task_dispatch',{commandId:'missing-explicit',title:'Preserve explicit choice',description:'Retain the user model when unavailable',nodeId:'worker',executionModel:missing});assert.equal(unavailable.isError,false,JSON.stringify(unavailable));
    const third=h.ledger.history(unavailable.value.taskId).runs[0];assert.equal(third.route.model,'removed');assert.equal(third.dispatchIssue.code,'EXPLICIT_EXECUTION_MODEL_UNAVAILABLE');
    const status=await invoke('project_status',{});assert.equal(status.isError,false,JSON.stringify(status));assert.equal(status.value.runs.find(run=>run.runId===third.runId).dispatchIssue.kind,'needs_action');
    const invalid=await invoke('task_dispatch',{commandId:'two-model-sources',title:'Reject ambiguous route',description:'Reject conflicting model sources',route:nodes.value.routes[0],executionModel:explicit});assert.equal(invalid.isError,true);
    const unowned=await h.ctx.tools.execute({name:'task_dispatch',arguments:{commandId:'no-agent',title:'No bound caller',description:'Reject missing source identity',nodeId:'worker'},callId:ToolCallId('project-policy-no-agent'),signal:new AbortController().signal});assert.equal(unowned.isError,false,JSON.stringify(unowned));
    assert.equal(h.ledger.snapshot().runs.length,4);assert.equal(h.ledger.snapshot().attempts.length,0);assert.equal(h.adapter.requests.length,0);
  }finally{await handle?.dispose();await h.dispose();}
});

test('scheduled node defaults follow policy for new occurrences while explicit route selections stay pinned',()=>{
  let now=Date.now();const ledger=TaskLedger.open(':memory:',{nodeId:'scheduler',now:()=>now});
  try{
    worker(ledger);publish(ledger,[preferred,explicit,fallback],'schedule-initial',now);defaults(ledger,preferred,'schedule-default');
    new Workbench(ledger).manage('project','create_project',{projectId:'model-policy-project',title:'Recurring project',goal:'Verify occurrence policy'});
    const plans=new ScheduledPlans(ledger),base={title:'Scheduled work',description:'Return actual evidence',projectId:'model-policy-project',cadence:{mode:'interval',minutes:1}};
    const normal=plans.create({commandId:'default-plan',...base,nodeId:'worker'});
    const route=plans.options().routes.find(row=>row.route.model==='preferred' && row.executionModel.origin==='explicit' && !row.route.workspaceId);
    assert.ok(route,'fresh executor catalog supplies explicit routes without a forced workspace');
    const pinned=plans.create({commandId:'pinned-plan',...base,routeId:route.id});
    assert.equal(ledger.getSchedule(normal.scheduleId).executionModel.origin,'node_default');assert.equal(ledger.getSchedule(pinned.scheduleId).executionModel.origin,'explicit');
    now+=60000;publish(ledger,[preferred,explicit,fallback],'schedule-new-default',now);defaults(ledger,explicit,'changed-default');
    for(const [tag,plan,model] of [['normal',normal,'explicit'],['pinned',pinned,'preferred']]){
      const schedule=ledger.getSchedule(plan.scheduleId),fire=ledger.fireSchedule(`fire-${tag}`,{scheduleId:plan.scheduleId,occurrenceAt:schedule.nextDueAt}).value;
      const run=ledger.getRun(fire.runId);assert.equal(run.route.model,model);assert.equal(run.projectContext.project.projectId,'model-policy-project');
    }
    const count=ledger.snapshot().tasks.length;
    assert.throws(()=>plans.create({commandId:'unbound',title:'No project',description:'Not eligible',nodeId:'worker',cadence:{mode:'interval',minutes:1}}));
    assert.equal(ledger.snapshot().tasks.length,count);
  }finally{ledger.close();}
});

test('scheduled backend default replaced by a native default removes old backend and effort',()=>{
  let now=Date.now();const ledger=TaskLedger.open(':memory:',{nodeId:'scheduler',now:()=>now});
  try{
    const backend={provider:'official',model:'codex-model',reasoningEffort:'high',backend:'host-codex-profile'},native={provider:'native',model:'native-without-effort'};
    worker(ledger);publish(ledger,[backend,native,fallback],'backend-initial',now);defaults(ledger,backend,'backend-default');
    new Workbench(ledger).manage('backend-project','create_project',{projectId:'backend-switch-project',title:'Backend transition',goal:'Keep default model dimensions exact'});
    const plans=new ScheduledPlans(ledger),plan=plans.create({commandId:'backend-plan',title:'Use node default',description:'Run the exact next default',projectId:'backend-switch-project',nodeId:'worker',cadence:{mode:'interval',minutes:1}});
    now+=60000;publish(ledger,[backend,native,fallback],'native-replacement',now);defaults(ledger,native,'native-default');
    const schedule=ledger.getSchedule(plan.scheduleId),fired=ledger.fireSchedule('fire-native',{scheduleId:plan.scheduleId,occurrenceAt:schedule.nextDueAt}).value;
    const run=ledger.getRun(fired.runId);assert.equal(run.route.model,native.model);assert.equal(run.route.provider,native.provider);assert.equal(run.route.backend,undefined);assert.equal(run.route.reasoningEffort,undefined);assert.equal(run.executionModel.origin,'node_default');assert.equal(run.dispatchIssue,undefined);
    assert.equal(ledger.getSchedule(plan.scheduleId).route.backend,backend.backend);
  }finally{ledger.close();}
});
