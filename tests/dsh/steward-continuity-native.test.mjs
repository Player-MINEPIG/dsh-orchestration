import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../ci/browser-native-project.mjs';
import { registerExecutor } from './executor-fixture.mjs';
import { projectContinuity, isProjectContinuation } from '../../packages/task-system/dist/steward-continuity.js';
async function done(h,id){for(let n=0;n<400;n++){const value=await h.ctx.taskSystem.steward.reconcile({conversationId:'main',commandId:id});if(value.commandMessage?.state.kind==='completed')return value;await new Promise(r=>setTimeout(r,10));}throw Error('Continuity native turn did not complete');}
const source=id=>({kind:'managed',nodeId:'local',sessionId:'native-'+id,projectId:id,generation:1,cwd:'/project-'+id});
const user=(id,seq,scope={kind:'project',projectId:id})=>({id,seq,role:'user',text:'进度如何',scope,source:source(scope.projectId??id),state:{kind:'completed'},createdAt:'2020-01-01T00:00:00.000Z',quote:null});
const response=(anchor,id,seq)=>({...anchor,id,seq,role:'assistant',replyTo:anchor.id,text:'目前尚未开始'});

test('recipient continuity follows the actual user turn, not late foreign replies, browsing, age or arbitrary previousScope',()=>{
 const a=user('a',1),b=user('b',3),ar=response(a,'ar',2),br=response(b,'br',4),late=response(a,'late-a',5);
 assert.equal(projectContinuity([a,ar,b,br,late],'b').scope.projectId,'b');assert.equal(projectContinuity([a,ar,b,br,late],'a').scope.projectId,'a','A frozen visible anchor remains stable when newer admissions arrive');
 assert.equal(projectContinuity([a],a.id),undefined);assert.equal(projectContinuity([a,ar,user('casual',3,{kind:'personal'})]),undefined);
 assert.equal(projectContinuity([a,ar,{...user('workspace',3,{kind:'workbench'}),text:'开始'}]),undefined);
 const oldFallback={...user('old-fallback',3,{kind:'workbench'}),text:'开始',route:{reason:'clarification'}};oldFallback.source={kind:'workbench',nodeId:'local',sessionId:'workbench',generation:1,cwd:'/workbench'};
 assert.equal(projectContinuity([a,ar,oldFallback]).scope.projectId,'a');assert.equal(projectContinuity([a,ar]).scope.projectId,'a','A clear unchanged conversation remains usable across time');
 for(const text of ['开始','那就开始','继续','go ahead'])assert.equal(isProjectContinuation(text),true,text);
 for(const text of ['不要开始','开始一个新项目','开始聊别的','开始A和B项目'])assert.equal(isProjectContinuation(text),false,text);
});

test('start returns to the exact native PM, which queries then dispatches its own real task; unrelated sessions remain untouched',{timeout:30000},async()=>{
 const h=await startHost();try{
  const s=h.ctx.taskSystem.steward,scope={kind:'project',projectId:h.created.projectId};
  h.model.script.push({name:'task_query',args:{limit:8,details:true}},'项目已建，目前账本没有任务，尚未开始。');await s.send({conversationId:'main',commandId:'check-start',text:'那它开始工作了吗',target:scope});const prior=await done(h,'check-start');
  assert.equal(h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT COUNT(*) AS n FROM entities WHERE kind='task'").get().n,0);
  registerExecutor(h.ctx.taskSystem.ledger,'continuity-worker',{nodeId:'continuity-worker',roles:['executor'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['continuity-workspace'],enabled:true,lastSeenAt:new Date().toISOString()});
  const before=h.model.requests.length;h.model.script.push(options=>{const input=options.messages.findLast(message=>message.source?.kind==='user');assert.equal(input.content[0].text,'开始');return {name:'task_dispatch',args:{commandId:'project-message:'+input.source.rpcId,title:'研究证据检索',description:'检索并核对研究证据',nodeId:'continuity-worker'}};},'已登记项目研究任务');
  const request={conversationId:'main',commandId:'start-project',text:'开始',routingMode:'auto',contextAnchor:{kind:'canonical',messageId:prior.commandMessage.id,throughSeq:prior.lastSeq}};
  await s.send(request);const next=await done(h,request.commandId);assert.deepEqual(next.commandMessage.scope,scope);assert.equal(next.commandMessage.route.reason,'continuation');assert.equal(next.commandMessage.route.anchorMessageId,prior.commandMessage.id);assert.equal(h.model.requests.length,before+2,'Only actual PM assembly and its tool continuation run; no route model hop');
  const rows=h.ctx.taskSystem.ledger.managementDatabase().prepare("SELECT id FROM entities WHERE kind='task'").all();assert.equal(rows.length,1);assert.equal(h.ctx.taskSystem.ledger.projectForTask(rows[0].id),h.created.projectId);
  const count=h.model.requests.length;await s.send(request);assert.equal(h.model.requests.length,count,'Same command replay does not dispatch again');
 }finally{await h.close();}
});

test('an unconfirmed predecessor cannot send start to older A, and final binding rotation rejects before canonical acceptance',{timeout:30000},async()=>{
 const h=await startHost();try{
  const s=h.ctx.taskSystem.steward;h.model.script.push('A回合已完成');await s.send({conversationId:'main',commandId:'focus-a',text:'项目情况',target:{kind:'project',projectId:h.created.projectId}});const a=await done(h,'focus-a');
  const before=h.model.requests.length;await assert.rejects(s.send({conversationId:'main',commandId:'blocked-start',text:'开始',routingMode:'auto',contextAnchor:{kind:'predecessor',commandId:'unadmitted-b'}}),{code:'CLARIFICATION'});assert.equal(h.model.requests.length,before);assert.equal(s.store.commandMessage('main','blocked-start'),null);
  const b=await h.runtime.create({commandId:'focus-project-b',title:'Continuity B',goal:'An independent project recipient'});h.model.script.push('B准备完成');await s.send({conversationId:'main',commandId:'unadmitted-b',text:'查询B情况',target:{kind:'project',projectId:b.projectId}});await done(h,'unadmitted-b');h.model.script.push('只继续B');await s.send({conversationId:'main',commandId:'blocked-start',text:'开始',routingMode:'auto',contextAnchor:{kind:'predecessor',commandId:'unadmitted-b'}});const resolved=await done(h,'blocked-start');assert.equal(resolved.commandMessage.scope.projectId,b.projectId,'An explicit retry follows the original resolved predecessor, not old A');
  const afterB=h.model.requests.length;
  const read=s.initialSeq.bind(s);let rotated=false;s.initialSeq=async binding=>{const value=await read(binding);if(!rotated&&binding.projectId===h.created.projectId){rotated=true;h.ctx.taskSystem.ledger.managementDatabase().prepare('UPDATE pr_projects SET generation=generation+1 WHERE id=?').run(h.created.projectId);}return value;};
  await assert.rejects(s.send({conversationId:'main',commandId:'rotated-start',text:'开始',routingMode:'auto',contextAnchor:{kind:'canonical',messageId:a.commandMessage.id,throughSeq:a.lastSeq}}),{code:'CLARIFICATION'});assert.equal(s.store.commandMessage('main','rotated-start'),null);assert.equal(h.model.requests.length,afterB);
 }finally{await h.close();}
});
