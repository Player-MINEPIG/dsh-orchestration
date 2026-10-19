import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskLedger, TaskError } from '../dist/ledger.js';
import { SessionCollaboration, collaborationAuthority } from '../dist/project-collaboration/session.js';
const agent = (id='session-one', cwd='/tmp/collaboration') => ({id, session:{header:{cwd},requestHeader:()=>undefined},options:{provider:"fixture",model:"fixture"},ctx:{get:()=>undefined,tools:{schemas:()=>[]}}});
test('binding persists in same SQLite, only acknowledged activation injects bundled skill; leave and cwd/owned guards', async () => {
 const dir=mkdtempSync(join(tmpdir(),'session-binding-')), file=join(dir,'ledger.sqlite');
 let ledger=TaskLedger.open(file), calls=[];
 const port=async (...args)=>{calls.push(args);return {confirmed:true,projectId:'central-project'};};
 try {
  let service=new SessionCollaboration(ledger,'mbp',port);
  assert.equal(service.prompt(agent()),'');
  assert.equal(service.prompt({id:'no-workspace',session:{header:{}}}),'');
  await assert.rejects(service.invoke(agent(),'dispatch',{title:'x'},'call','r1'),/project/);
  await service.activate(agent(),'My project');
  assert.match(service.prompt(agent()),/task_dispatch/);
  assert.equal(calls.length,1);
  await service.activate(agent()); assert.equal(calls.length,1);
  ledger.close(); ledger=TaskLedger.open(file);
  service=new SessionCollaboration(ledger,'mbp',port);
  assert.equal(service.binding(agent()).projectId,'central-project');
  assert.match(service.prompt(agent()),/project_finish/);
  assert.equal(service.prompt(agent('other-session')),'');
  assert.throws(()=>service.binding(agent('session-one','/tmp/other')), /不一致/);
  const owned=new SessionCollaboration(ledger,'mbp',port,()=>true);
  assert.equal(owned.prompt(agent()),'');
  await assert.rejects(owned.activate(agent()),/受管任务/);
  service.leave(agent()); assert.equal(service.prompt(agent()),'');
  await assert.rejects(service.invoke(agent(),'update',{summary:'done'},'call','r1'),/project/);
 } finally {ledger.close();rmSync(dir,{recursive:true,force:true});}
});
test('uncertain activation retries same operation; new tool call with same business requestId never duplicates; central rejection is explicit', async () => {
 const ledger=TaskLedger.open(':memory:'), calls=[]; let connected=false, mode='ok';
 const service=new SessionCollaboration(ledger,'mbp',async (node,id,input)=>{
  calls.push({node,id,input});
  if(!connected) throw new Error('secret transport body must not be persisted');
  if(mode==='blocked') throw new TaskError('PROJECT_NOT_QUIESCENT','Tasks still running');
  return {confirmed:true,projectId:'project'};
 });
 try {
  await assert.rejects(service.activate(agent()),/中央尚未确认/);
  assert.equal(service.binding(agent()).state,'pending');assert.equal(service.prompt(agent()),'');
  const restored=new SessionCollaboration(ledger,'mbp',async (...args)=>{calls.push({node:args[0],id:args[1],input:args[2]});return{confirmed:true,projectId:'project'};});
  await restored.activate(agent()); assert.equal(calls[0].id,calls[1].id);
  connected=true;
  await service.invoke(agent(),'dispatch',{title:'one',description:'work'},'tool-first','work-1');
  await service.invoke(agent(),'dispatch',{description:'work',title:'one'},'tool-retry','work-1');
  assert.equal(calls.length,3);
  await assert.rejects(service.invoke(agent(),'dispatch',{title:'changed'},'tool-new','work-1'),/内容发生变化/);
  mode='blocked'; await assert.rejects(service.invoke(agent(),'submit',{summary:'done'},'finish','finish-1'),e=>e.code==='PROJECT_NOT_QUIESCENT');
  assert.equal(service.localStatus(agent()).pendingOperations.length,0);
  assert.equal(service.localStatus(agent()).rejectedOperations[0].code,'PROJECT_NOT_QUIESCENT');
  const stored=ledger.managementDatabase().prepare('SELECT data FROM project_session_operations').all().map(r=>r.data).join('');
  assert.doesNotMatch(stored,/secret transport/);
 }finally{ledger.close();}
});
test('leave while activation in flight never silently reactivates session', async()=>{
 const ledger=TaskLedger.open(':memory:');let release;
 const service=new SessionCollaboration(ledger,'mbp',()=>new Promise(r=>release=r));
 try{const pending=service.activate(agent());service.leave(agent());release({confirmed:true,projectId:'p'});await pending;assert.equal(service.binding(agent()).state,'paused');assert.equal(service.prompt(agent()),'');}finally{ledger.close();}
});

test('both uses configured remote authority; paused or missing coordinator never falls back to local',async()=>{
 let localCalls=0,remoteCalls=0;
 const local={projectCollaborate:()=>{localCalls++;return 'local';}};
 const remote={settingsSnapshot:()=>({coordinatorConfigured:true,paused:false}),coordinatorLedger:{projectCollaborate:()=>{remoteCalls++;return 'remote';}}};
 assert.equal(await collaborationAuthority('both',local,remote)('mbp','id',{}),'remote');
 assert.equal(localCalls,0);assert.equal(remoteCalls,1);
 assert.throws(()=>collaborationAuthority('both',local,{...remote,settingsSnapshot:()=>({coordinatorConfigured:true,paused:true})}),/第二个中央/);
 assert.throws(()=>collaborationAuthority('both',local,{settingsSnapshot:remote.settingsSnapshot}),/第二个中央/);
 assert.throws(()=>collaborationAuthority('executor',local),/第二个中央/);
 assert.equal(await collaborationAuthority('both',local)('mbp','id',{}),'local');
});
