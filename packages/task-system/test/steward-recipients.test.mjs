import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {StewardTopicRelations} from '../dist/steward-topic-relations.js';import {StewardRecipients} from '../dist/steward-recipients.js';
const topic=id=>({conversationId:'main',scope:{kind:'workbench',topicId:id}});
const binding=id=>({kind:'workbench',topicId:id,nodeId:'local',sessionId:'source-'+id,generation:1,cwd:'/own/'+id});
function fixture(){const db=new DatabaseSync(':memory:'),relations=new StewardTopicRelations({managementDatabase:()=>db},async()=>{});let current=true;const host={async source(ref){const id=ref.scope.topicId??ref.scope.projectId;return{binding:binding(id),title:id}},async coordinators(){return[]},async current(){return current}};const recipients=new StewardRecipients(relations,host);return{db,relations,host,recipients,invalidate(){current=false}}}
test('latest child discussion resolves its whole topic group, selects a sibling by roles, and explicit reply remains in its actual source',async()=>{const f=fixture();try{
 for(const [id,role]of[['B','研究'],['C','实现']])await f.relations.configure({commandId:id,topic:topic(id),expectedRevision:0,parent:topic('A').scope,role,responsibility:role==='研究'?'核对来源与研究结论':'修改代码并验证'});
 f.relations.recordArtifact({conversationId:'main',scope:topic('B').scope,sessionId:'source-B',callId:'1',name:'research.md'});f.relations.recordArtifact({conversationId:'main',scope:topic('C').scope,sessionId:'source-C',callId:'2',name:'implementation.ts'});
 let calls=0;const result=await f.recipients.choose({topic:topic('B'),text:'请修改 implementation.ts 的代码',call:async input=>{calls++;assert.equal(input.recipients.length,3);assert.equal(JSON.stringify(input).includes('source-C'),false);assert.equal(JSON.stringify(input).includes('/own/'),false);const selected=input.recipients.find(item=>item.artifacts.includes('implementation.ts'));return{kind:'recipient',id:selected.id}}});
 assert.equal(result.seat.source.sessionId,'source-C');assert.equal(result.reason,'role');assert.equal(calls,1);
 const reply=await f.recipients.choose({topic:topic('B'),text:'请修改代码',replySource:binding('B'),call:()=>assert.fail('Reply is exact source authority')});assert.equal(reply.seat.source.sessionId,'source-B');
 const options=await f.recipients.list(topic('A')),chosen=options.seats.find(seat=>seat.source.sessionId==='source-C');const explicit=await f.recipients.choose({topic:topic('B'),text:'next',explicit:{id:chosen.id,token:chosen.token}});assert.equal(explicit.seat.source.sessionId,'source-C');
 f.invalidate();await assert.rejects(f.recipients.choose({topic:topic('B'),text:'next',explicit:{id:chosen.id,token:chosen.token}}),{code:'CONFLICT'});
 }finally{f.db.close()}});
test('truncated groups cannot infer a unique coordinator from their visible prefix; authority-selected project PM remains a valid fallback',async()=>{const f=fixture();try{
 for(let n=0;n<9;n++)await f.relations.configure({commandId:'n'+n,topic:topic('N'+n),expectedRevision:0,parent:topic('A').scope,role:'职责'+n});
 const result=await f.recipients.choose({topic:topic('A'),text:'不明确',call:()=>assert.fail('Do not semantically select from an incomplete group')});assert.equal(result.kind,'clarification');
 f.host.coordinator=async()=>({topic:topic('A'),source:binding('PM'),title:'负责项目调度',role:'project-coordinator',responsibility:'授权关联的PM',artifacts:[]});
 const fallback=await f.recipients.choose({topic:topic('A'),text:'核实进展'});assert.equal(fallback.kind,'selected');assert.equal(fallback.reason,'project-coordinator');assert.equal(fallback.seat.source.sessionId,'source-PM');
 }finally{f.db.close()}});

test('an exact authorized ninth reply or task owner is not limited by the semantic shortlist',async()=>{const f=fixture();try{
 for(let n=0;n<10;n++)await f.relations.configure({commandId:'seat'+n,topic:topic('N'+n),expectedRevision:0,parent:topic('A').scope});
 f.host.precise=async(ref,identity)=>{
  if(identity.source?.sessionId==='source-N9'||identity.taskId==='owned-task')return{topic:topic('N9'),source:binding('N9'),title:'N9',role:'discussion',responsibility:'exact owner',artifacts:[],...(identity.taskId?{taskId:identity.taskId}:{})};
  return null;
 };
 const reply=await f.recipients.choose({topic:topic('A'),text:'reply',replySource:binding('N9'),call:()=>assert.fail('Exact reply bypasses shortlist inference')});
 assert.equal(reply.seat.source.sessionId,'source-N9');assert.equal(reply.reason,'reply');
 const task=await f.recipients.choose({topic:topic('A'),text:'task',taskId:'owned-task'});assert.equal(task.seat.source.sessionId,'source-N9');assert.equal(task.reason,'task-owner');
 const missing=await f.recipients.choose({topic:topic('A'),text:'task',taskId:'unknown-task'});assert.equal(missing.kind,'clarification');
 }finally{f.db.close()}});
