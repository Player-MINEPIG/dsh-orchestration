import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {StewardTopicRelations} from '../dist/steward-topic-relations.js';
const topic=id=>({conversationId:'main',scope:{kind:'workbench',topicId:id}});
function fixture(){const db=new DatabaseSync(':memory:');const allowed=new Set(['A','B','C']);const service=new StewardTopicRelations({managementDatabase:()=>db},async ref=>{if(ref.conversationId!=='main'||!allowed.has(ref.scope.topicId??ref.scope.projectId))throw Object.assign(Error('not visible'),{code:'FORBIDDEN'});return{}});return{db,allowed,service}}
test('whole discussion placement preserves source data, converges on command replay and prevents stale or cyclic moves',async()=>{
 const f=fixture();try{
  f.db.exec("CREATE TABLE original_records(id TEXT PRIMARY KEY,data TEXT); INSERT INTO original_records VALUES('message','immutable source, cwd, task, run and attempt')");
  const original=f.db.prepare('SELECT * FROM original_records').all();
  const input={commandId:'move-a',topic:topic('A'),expectedRevision:0,parent:topic('B').scope,role:'研究',responsibility:'核对调研材料'};
  const value=await f.service.configure(input);assert.equal(value.revision,1);assert.deepEqual(f.service.group(topic('B')).scopes,[topic('B').scope,topic('A').scope]);
  assert.deepEqual(await f.service.configure(input),value);assert.deepEqual(f.db.prepare('SELECT * FROM original_records').all(),original);
  await assert.rejects(f.service.configure({...input,commandId:'stale'}),{code:'CONFLICT'});
  await assert.rejects(f.service.configure({commandId:'cycle',topic:topic('B'),expectedRevision:0,parent:topic('A').scope}),{code:'INVALID'});
  await assert.rejects(f.service.configure({...input,parent:topic('C').scope}),{code:'CONFLICT'});
  const moved=await f.service.configure({...input,commandId:'move-again',expectedRevision:1,parent:topic('C').scope});assert.equal(moved.revision,2);
  assert.deepEqual(f.service.group(topic('B')).scopes,[topic('B').scope]);assert.deepEqual(f.service.group(topic('C')).scopes,[topic('C').scope,topic('A').scope]);
 }finally{f.db.close()}
});
test('placement authorization is rechecked on replay; bounded groups and source-local artifact names never imply file access',async()=>{
 const f=fixture();try{
  const input={commandId:'move',topic:topic('A'),expectedRevision:0,parent:topic('B').scope};await f.service.configure(input);f.allowed.delete('A');
  await assert.rejects(f.service.configure(input),{code:'FORBIDDEN'});await assert.rejects(f.service.configure({...input,commandId:'foreign',topic:{...topic('A'),conversationId:'foreign'}}),{code:'FORBIDDEN'});
  for(let n=0;n<9;n++){const id='N'+n;f.allowed.add(id);await f.service.configure({commandId:id,topic:topic(id),expectedRevision:0,parent:topic('B').scope})}
  const group=f.service.group(topic('B'));assert.equal(group.complete,false);assert.equal(group.scopes.length,8);
  f.service.recordArtifact({conversationId:'main',scope:topic('A').scope,sessionId:'A',callId:'write1',name:'research.md'});
  assert.deepEqual(f.service.artifacts(topic('A'),'A'),['research.md']);assert.deepEqual(f.service.artifacts(topic('B'),'A'),[]);assert.deepEqual(f.service.artifacts(topic('A'),'B'),[]);
 }finally{f.db.close()}
});

test('concurrent authorization of the same placement command converges to its one durable result',async()=>{
 const f=fixture();try{
  const request={commandId:'same-concurrent',topic:topic('A'),expectedRevision:0,parent:topic('B').scope};
  const [a,b]=await Promise.all([f.service.configure(request),f.service.configure(request)]);
  assert.deepEqual(a,b);assert.equal(f.service.read(topic('A')).revision,1);
 }finally{f.db.close()}
});
