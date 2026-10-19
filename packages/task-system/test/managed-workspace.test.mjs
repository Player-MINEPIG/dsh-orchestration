import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
import {chooseExecutionSession} from '../dist/execution-session.js';
import {acquireWorkspaceExecution} from '../dist/workspace-execution-lock.js';
const settle={name:'task_settle',args:{outcome:'success',summary:'fixture completed'}};
test('saved planning/execution roots support real native execution and JEV session choices with no default workspace',async()=>{
 const h=await createNativeHarness({config:{defaultWorkspaceId:undefined,sessionDecisionEnabled:true,projectAgentOptions:{provider:'test-offline',model:'script'}},script:[settle,settle,settle]});let asked=0;
 h.ctx.provide('decisionModels',{ask:async()=>{asked++;return{provider:'fixture',model:'fixture',answers:{session:{type:'choice',choice:'reuse-0'}}}}});
 try {
  const service=h.ctx.taskSystem,l=h.ledger;service.projects.saveSettings({root:h.dir,expectedRevision:0});service.executionDirectories.save({root:h.dir,expectedRevision:0});
  l.registerNode('node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
  const task=l.createTask('temporary',{title:'Temporary'}).value;await service.projects.prepareTaskConversation(task.taskId);
  const paths=[],sessions=[];
  for(const i of [1,2]){const run=l.createRun('run'+i,{taskId:task.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;assert.equal(run.route.workspaceId,undefined);const claim=l.claim('claim'+i,{runId:run.runId,nodeId:'local',ttlMs:10000}).value;const result=await service.native.execute(claim);assert.equal(result.run.state,'succeeded');sessions.push(result.sessionId);const handle=await h.ctx.sessionPersistence.open(result.sessionId,'read');paths.push(handle.header.cwd);await handle.close();}
  assert.deepEqual(paths,[join(h.dir,'temporary-tasks'),join(h.dir,'temporary-tasks')]);assert.equal(sessions[0],sessions[1]);assert.equal(asked,1,'JEV chooses reuse/new once a legal session exists');
  const other=l.createTask('other',{title:'Other temporary'}).value;await service.projects.prepareTaskConversation(other.taskId);const run=l.createRun('other-run',{taskId:other.taskId,route:{nodeId:'local',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;const result=await service.native.execute(l.claim('other-claim',{runId:run.runId,nodeId:'local',ttlMs:10000}).value);assert.equal(result.run.state,'succeeded');const handle=await h.ctx.sessionPersistence.open(result.sessionId,'read');assert.equal(handle.header.cwd,paths[0]);await handle.close();
 } finally {await h.dispose();}
});
test('managed decisions refresh stale candidates, fall back on provider failure, and propagate cancellation',async()=>{
 const context={schedulerId:'scheduler',taskSessionId:'existing',sessions:[{taskId:'task',nodeId:'node',schedulerId:'scheduler',sessionId:'existing'}]};
 const input={claim:{task:{taskId:'task',title:'Task'},run:{runId:'run',projectContext:{schedulerId:'scheduler',project:null}},attempt:{attemptId:'attempt',nodeId:'node'}},context,managedWorkspaceAvailable:true,workspaces:[]};
 assert.deepEqual((await chooseExecutionSession({...input,decisions:{ask:async()=>{throw Error('offline')}}})).session,{mode:'reuse',sessionId:'existing'});
 const changed=await chooseExecutionSession({...input,decisions:{ask:async()=>({provider:'fixture',model:'fixture',answers:{session:{type:'choice',choice:'reuse-0'}}})},refresh:()=>({...context,taskSessionId:undefined,sessions:[]})});assert.deepEqual(changed.session,{mode:'new'});
 const abort=new AbortController();await assert.rejects(chooseExecutionSession({...input,signal:abort.signal,decisions:{ask:async()=>{abort.abort(Error('cancelled'));throw abort.signal.reason}}}),/cancelled/);
 await assert.rejects(chooseExecutionSession({...input,claim:{...input.claim,task:{...input.claim.task,policy:{allowedWorkspaceIds:['explicit']}}}}),/DENIED/);
});
test('workspace execution locks share canonical cwd and remove cancelled waiters without blocking isolated children',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'cwd-lock-')));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'child'));symlinkSync(root,join(root,'alias'));
 const first=await acquireWorkspaceExecution(root,new AbortController().signal),abort=new AbortController();let entered=false;
 const waiting=acquireWorkspaceExecution(join(root,'alias'),abort.signal).then(release=>{entered=true;return release});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,false);const child=await acquireWorkspaceExecution(join(root,'child'),new AbortController().signal);child();abort.abort(Error('cancelled'));await assert.rejects(waiting,/cancelled/);first();const release=await acquireWorkspaceExecution(root,new AbortController().signal);release();
});
