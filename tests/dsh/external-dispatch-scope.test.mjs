import {registerExecutor} from './executor-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';

for(const mode of ['inline']) test(`ordinary project coordinator ${mode} dispatch uses the trusted binding without requiring a built-in project turn`,async()=>{
 const h=await createNativeHarness({config:{role:'planner',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
 try{
  const runtime=h.ctx.taskSystem.projects;
  runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const project=await runtime.create({commandId:'project',title:'Existing project',goal:'Read-only review'});
  const cwd=runtime.snapshot().projects.find(row=>row.id===project.projectId).workspace;
  const handle=await h.ctx.agents.create({sessionId:SessionId('external-coordinator'),meta:{cwd},agentOptions:{provider:'test-offline',model:'script'}});
  let seq=0;
  const invoke=(agent,name,args)=>h.ctx.tools.execute({name,arguments:args,agent,callId:ToolCallId('scope-'+ ++seq),signal:new AbortController().signal});
  const call=async(name,args)=>{const result=await invoke(handle.agent,name,args);assert.equal(result.isError,false,JSON.stringify(result));return result.value;};
  const listed=await call('project_list',{});assert.ok(listed.some(row=>row.id===project.projectId));
  await call('project_bind_session',{projectId:project.projectId});
  const parent=(await call('task_create',{commandId:'parent',title:'Parent organizing task'})).value;
  const binding=(await call('task_bind_dispatcher',{commandId:'bind',taskId:parent.taskId})).value;
  assert.equal(runtime.projectForSession(String(handle.agent.id)),undefined,'ordinary session is not a managed project session');
  h.ledger.registerNode('mbp',{nodeId:'MBP',roles:['executor'],enabled:true,capabilities:[],workspaceIds:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}]});
  const requestId='read-pr',intent={title:'Review PR',description:'Read the requested repository without modifying it',route:{nodeId:'MBP',provider:'test-offline',model:'script',requiredCapabilities:[]}};
  const applied=await call('task_dispatch',{commandId:requestId,...(mode==='inline'?intent:{})});
  assert.equal(h.ledger.getDecision(requestId).input.projectId,project.projectId);
  const child=h.ledger.getTask(applied.value.taskId),run=h.ledger.getRun(applied.value.runId);
  assert.equal(child.parentTaskId,parent.taskId);assert.equal(run.parentRunId,binding.runId);
  assert.equal(run.projectContext.project.projectId,project.projectId);assert.equal(run.route.nodeId,'MBP');
  assert.equal(h.ledger.managementDatabase().prepare('SELECT COUNT(*) AS n FROM pr_dispatch').get().n,0,'ordinary dispatch is not deferred to the managed project turn queue');
  const other=await runtime.create({commandId:'other',title:'Another project',goal:'Different owner'});
  const otherCwd=runtime.snapshot().projects.find(row=>row.id===other.projectId).workspace;
  const otherHandle=await h.ctx.agents.create({sessionId:SessionId('other-coordinator'),meta:{cwd:otherCwd},agentOptions:{provider:'test-offline',model:'script'}});
  const bound=await invoke(otherHandle.agent,'project_bind_session',{projectId:other.projectId});assert.equal(bound.isError,false);
  for(const agent of [otherHandle.agent, (await h.ctx.agents.create({sessionId:SessionId('unbound-coordinator'),meta:{cwd},agentOptions:{provider:'test-offline',model:'script'}})).agent]){
   const rejected=await invoke(agent,'task_dispatch',{commandId:requestId});assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected),/Decision belongs to another project/);
  }
  const unrelated=h.ledger.createTask('unrelated',{title:'Unrelated task'}).value;
  runtime.linkTask(runtime.snapshot().projects.find(row=>row.id===other.projectId).sessionId,unrelated.taskId);
  const decision=h.ledger.getDecision(requestId);
  h.ledger.recordDecision('wrong-attach-record',{...decision,decisionId:'wrong-attach',proposal:{...decision.proposal,persistence:'attach',attachTaskId:unrelated.taskId}});
  const attachment=await invoke(handle.agent,'task_dispatch',{commandId:'wrong-attach'});
  assert.equal(attachment.isError,true);assert.match(JSON.stringify(attachment),/Cannot attach a task from another project|Task ancestry and current coordinator must belong to one project/);
  assert.equal(h.ledger.snapshot().runs.length,2,'scope failures create no extra Run');
  assert.equal(h.adapter.requests.length,0,'real tools are exercised without model or production work');
 }finally{await h.dispose();}
});

test('built-in project tools still require the current managed turn request ID',async()=>{
 const requestId='project-message:managed-turn';
 const h=await createNativeHarness({config:{role:'planner',schedulerEnabled:false,planningDecisionEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}},script:[
  {name:'task_dispatch',args:{commandId:'wrong-request',title:'Must fail',description:''}},
  {name:'task_dispatch',args:{commandId:requestId,title:'Managed task',description:'Wait for an explicit route'}},
  'Plan saved'
 ]});
 try{
  registerExecutor(h.ledger,'available',{nodeId:'MBP',roles:['executor'],enabled:true,capabilities:[],workspaceIds:[],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}]});
  const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
  const project=await runtime.create({commandId:'managed',title:'Managed project',goal:'Managed turn boundaries'});
  runtime.send({projectId:project.projectId,commandId:'managed-turn',text:'Plan this work'});
  let turn;
  for(let i=0;i<100;i++){turn=h.ledger.managementDatabase().prepare('SELECT state FROM pr_turns WHERE command=?').get('managed-turn');if(['completed','failed'].includes(turn.state))break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(turn.state,'completed');
  assert.equal(h.ledger.getDecision('wrong-request'),undefined);
  assert.match(JSON.stringify(h.adapter.requests[1].messages),/Use the current message request ID/);
  assert.equal(h.ledger.getDecision(requestId).input.projectId,project.projectId);
  assert.equal(h.ledger.snapshot().tasks.length,1);assert.equal(h.ledger.snapshot().runs.length,0);
  const sessionId=runtime.snapshot().projects.find(row=>row.id===project.projectId).sessionId;
  assert.throws(()=>runtime.assertDecisionScope(sessionId,requestId),/Use the current message request ID/,'completed turns cannot authorize another dispatch');
 }finally{await h.dispose();}
});
