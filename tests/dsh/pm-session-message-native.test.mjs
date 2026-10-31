import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
import {ScriptedModel} from './scripted-model.mjs';
import {registerExecutor} from './executor-fixture.mjs';
import {RecoveryStore} from '../../packages/task-system/dist/remote/store.js';
import {SessionMessages} from '../../packages/task-system/dist/remote/session-messages.js';

async function until(read, message) {
  const end=Date.now()+15000;
  while(Date.now()<end){const value=await read();if(value)return value;await new Promise(done=>setTimeout(done,10));}
  throw Error(message);
}
const decode=result=>JSON.parse(result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'));
let serial=0;
const call=(h,agent,input)=>h.ctx.tools.execute({name:'task_session_message',callId:ToolCallId('pm-message-'+serial++),arguments:input,signal:new AbortController().signal,...(agent?{agent}:{})});

test('actual PM tool queues an existing worker conversation and reads its exact reply without a new execution', {timeout:30000}, async()=>{
  const h=await createNativeHarness({executionRoot:true,config:{role:'both',schedulerEnabled:false,autoExecute:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  const recovery=new RecoveryStore(':memory:');let pump,pmHandle;
  try{
    const service=h.ctx.taskSystem,projects=service.projects,ledger=h.ledger;
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const a=await projects.create({commandId:'message-a',title:'Message A',goal:'Only communicate'});
    const b=await projects.create({commandId:'message-b',title:'Message B',goal:'Other scope'});
    const owner=projects.placementProject(a.projectId),other=projects.placementProject(b.projectId);
    ledger.registerWorkspace('message-ws',{workspaceId:'message-ws',nodeId:'local',path:h.dir,state:'ready'});
    registerExecutor(ledger,'message-node',{nodeId:'local',roles:['both'],enabled:true,models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['message-ws'],maxConcurrent:4});
    let stage=0,last,queuedId,ownedDenied=false;
    h.ctx.on('tools/result',(exec,result)=>{if(exec.name==='task_session_message'&&exec.agent?.id===owner.session){assert.equal(result.isError,false,JSON.stringify(result));last=decode(result);}});
    h.adapter.stream=async function*(options){
      this.requests.push(options);
      const user=options.messages.findLast(message=>message.role==='user'),direct=user?.source?.kind==='dsh-direct-message';
      let response;
      if(direct)response='WORKER_REPLY_ONLY: '+user.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
      else if(options.sessionId!==owner.session){
        const agent=h.ctx.agents.get(SessionId(options.sessionId));
        const denied=await call(h,agent,{action:'targets',taskId:'does-not-matter'});
        assert.equal(denied.isError,true);ownedDenied=true;
        response={name:'task_submit_result',args:{outcome:'success',summary:'Existing task completed before ordinary messages',reportTitle:'Existing result',reportBody:'Actual native result retained before asking for feedback'}};
      }else{
        assert.ok(options.tools.some(tool=>tool.name==='task_session_message'));
        stage++;
        if(stage===1)response={name:'task_session_message',args:{action:'targets',taskId:task.taskId}};
        else if(stage===2){const target=last.targets[0];assert.equal(target.sessionId,session.sessionId);response={name:'task_session_message',args:{action:'send',taskId:task.taskId,nodeId:target.nodeId,sessionId:target.sessionId,commandId:'pm-ordinary-feedback',text:'Please confirm the existing result; do not rerun.'}};}
        else if(stage===3){queuedId=last.value.messageId;assert.equal(last.value.state,'queued');await until(async()=>{await pump.poll(4);return ledger.getSessionMessage(queuedId).state==='completed';},'Worker direct reply did not arrive');response={name:'task_session_message',args:{action:'status',taskId:task.taskId,messageId:queuedId}};}
        else {assert.equal(last.state,'completed');assert.match(last.reply,/WORKER_REPLY_ONLY/);response='PM read the exact existing-session reply.';}
      }
      const model=new ScriptedModel([response]);model.requests=Array(this.requests.length);yield*model.stream(options);
    };
    const task=ledger.createTask('message-task',{title:'Existing worker result'}).value;
    projects.linkTask(owner.session,task.taskId);
    const foreign=ledger.createTask('message-foreign',{title:'Other project task'}).value;projects.linkTask(other.session,foreign.taskId);
    const run=ledger.createRun('message-run',{taskId:task.taskId,route:{nodeId:'local',workspaceId:'message-ws',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
    const claim=ledger.claim('message-claim',{runId:run.runId,nodeId:'local',ttlMs:60000}).value;
    await service.native.execute(claim);
    assert.equal(ownedDenied,true);
    const session=ledger.sessionMessageTargets(task.taskId)[0];
    recovery.createDispatch({attemptId:claim.attempt.attemptId,state:'acknowledged',claim,lease:{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'local',fence:claim.attempt.fence},sessionId:session.sessionId,workspacePath:h.dir});
    pump=new SessionMessages({ledger,store:recovery,policy:{role:'executor',nodeId:'local',capabilities:[],workspaces:[{workspaceId:'message-ws',nodeId:'local',path:h.dir,allowedRoot:h.dir}]},provider:{id:'pm-message-native',capabilities:[],supports:()=>true,sendSessionMessage:service.native.sendSessionMessage.bind(service.native)}});
    const before={tasks:ledger.snapshot().tasks.length,runs:ledger.snapshot().runs.length,attempts:ledger.snapshot().attempts.length,reports:ledger.snapshot().reports.length};
    await service.steward.send({conversationId:'main',commandId:'pm-message-instruction',text:'Ask the original worker for feedback only.',target:{kind:'project',projectId:a.projectId}});
    await until(async()=>{const state=await service.steward.reconcile({conversationId:'main'});return state.messages.some(message=>message.text==='PM read the exact existing-session reply.');},'Actual PM tool chain did not finish');
    assert.equal(stage,4);assert.equal(ledger.sessionMessages(task.taskId).filter(message=>!message.completion).length,1);
    assert.deepEqual({tasks:ledger.snapshot().tasks.length,runs:ledger.snapshot().runs.length,attempts:ledger.snapshot().attempts.length,reports:ledger.snapshot().reports.length},before);
    pmHandle=await h.ctx.agents.resume({resumeSessionId:SessionId(owner.session),agentOptions:{provider:'test-offline',model:'script'}});
    const retry={action:'send',taskId:task.taskId,nodeId:'local',sessionId:session.sessionId,commandId:'pm-ordinary-feedback',text:'Please confirm the existing result; do not rerun.'};
    assert.equal(decode(await call(h,pmHandle.agent,retry)).value.messageId,queuedId);
    assert.equal((await call(h,pmHandle.agent,{...retry,text:'Changed retry'})).isError,true);
    assert.equal(ledger.sessionMessages(task.taskId).filter(message=>!message.completion).length,1);
    const gate={gateId:'message-human-gate',projectId:a.projectId,workstreamTaskId:task.taskId,upstreamTaskIds:[task.taskId],instructionRef:'Explicit human pause before further work'};
    ledger.withAcceptanceHumanAction({action:'arm',reference:gate.instructionRef},()=>ledger.armAcceptanceGate('message-arm',gate));
    assert.equal(ledger.acceptanceGateView(gate.gateId).state,'awaiting-acceptance');
    assert.equal((await call(h,pmHandle.agent,{...retry,commandId:'message-after-pause',text:'Do more work in the original worker'})).isError,true);
    assert.equal(ledger.sessionMessages(task.taskId).filter(message=>!message.completion).length,1);
    assert.equal((await call(h,pmHandle.agent,{action:'targets',taskId:task.taskId})).isError,false);
    assert.equal(decode(await call(h,pmHandle.agent,{action:'status',taskId:task.taskId,messageId:queuedId})).state,'completed');
    for(const input of [{action:'targets',taskId:foreign.taskId},{action:'status',taskId:foreign.taskId,messageId:queuedId},{action:'send',taskId:task.taskId,nodeId:'local',sessionId:other.session,commandId:'wrong-original',text:'wrong'},{action:'send',taskId:task.taskId,nodeId:'other',sessionId:session.sessionId,commandId:'wrong-node',text:'wrong'}])assert.equal((await call(h,pmHandle.agent,input)).isError,true);
    assert.equal((await call(h,undefined,{action:'targets',taskId:task.taskId})).isError,true);
    ledger.registerNode('message-outsider',{nodeId:'outsider',roles:['planner'],models:[],capabilities:[],workspaceIds:[],enabled:true});
    await assert.rejects(projects.collaboration.projectCollaborate('outsider','spoof-message',{action:'session',sessionId:owner.session,cwd:owner.cwd,projectId:a.projectId,command:{kind:'sessionMessage',input:{action:'targets',taskId:task.taskId}}}),error=>error.code==='FORBIDDEN');
    await projects.handoff(a.projectId);
    assert.equal((await call(h,pmHandle.agent,{action:'targets',taskId:task.taskId})).isError,true);
    await assert.rejects(projects.collaboration.projectCollaborate('local','old-pm-central',{action:'session',sessionId:owner.session,cwd:owner.cwd,projectId:a.projectId,command:{kind:'sessionMessage',input:{action:'targets',taskId:task.taskId}}}),error=>error.code==='FORBIDDEN');
  }finally{await pmHandle?.dispose();await pump?.dispose();recovery.close();await h.dispose();}
});
