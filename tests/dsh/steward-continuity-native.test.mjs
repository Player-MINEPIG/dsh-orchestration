import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../ci/browser-native-project.mjs';
import { registerExecutor } from './executor-fixture.mjs';
async function done(h,id){for(let n=0;n<400;n++){const value=await h.ctx.taskSystem.steward.reconcile({conversationId:'main',commandId:id});if(value.commandMessage?.state.kind==='completed')return value;await new Promise(r=>setTimeout(r,10));}throw Error('Continuity native turn did not complete');}
test('start returns to the exact native PM, which queries then dispatches its own real task; unrelated sessions remain untouched',{timeout:30000},async()=>{
 const h=await startHost();try{
  const s=h.ctx.taskSystem.steward,scope={kind:'project',projectId:h.created.projectId};
  h.model.script.push({name:'task_query',args:{limit:8,details:true}},'项目已建，目前账本没有任务，尚未开始。');await s.send({conversationId:'main',commandId:'check-start',text:'那它开始工作了吗',target:scope});const prior=await done(h,'check-start');
  assert.equal(h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE kind='task'").get().n,0);
  registerExecutor(h.ctx.taskSystem.ledger,'continuity-worker',{nodeId:'continuity-worker',roles:['executor'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['continuity-workspace'],enabled:true,lastSeenAt:new Date().toISOString()});
  const before=h.model.requests.length;h.model.script.push(JSON.stringify({kind:'route',target:scope}),options=>{const input=options.messages.findLast(message=>message.source?.kind==='user');assert.equal(input.content[0].text,'开始');return {name:'task_dispatch',args:{commandId:'project-message:'+input.source.rpcId,title:'研究证据检索',description:'检索并核对研究证据',nodeId:'continuity-worker'}};},'已登记项目研究任务');
  const request={conversationId:'main',commandId:'start-project',text:'开始',routingMode:'auto',latestTopic:{scope,latestMessageId:prior.topicActivity.latestMessage.id,throughSeq:prior.lastSeq}};
  await s.send(request);const next=await done(h,request.commandId);assert.deepEqual(next.commandMessage.scope,scope);assert.equal(h.model.requests.length,before+3,'One independent semantic hop precedes actual PM assembly and its tool continuation');
  const rows=h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT id FROM entities WHERE kind='task'").all();assert.equal(rows.length,1);assert.equal(h.ctx.taskSystem.ledger.projectForTask(rows[0].id),h.created.projectId);
  const count=h.model.requests.length;await s.send(request);assert.equal(h.model.requests.length,count,'Same command replay does not dispatch again');
 }finally{await h.close();}
});
