import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskLedger} from '../dist/ledger.js';
import {Workbench} from '../dist/workbench.js';
import {ProjectCollaborationAuthority} from '../dist/project-collaboration/authority.js';
import {TaskReturnInbox} from '../dist/remote/task-return-inbox.js';

function fixture(t) {
  const ledger=TaskLedger.open(':memory:',{role:'planner',nodeId:'central'});t.after(()=>ledger.close());
  ledger.registerNode('device',{nodeId:'device',roles:['planner'],models:[],capabilities:[],workspaceIds:[],enabled:true});
  const authority=new ProjectCollaborationAuthority(ledger),identity={sessionId:'origin',cwd:'/device-only/real-materials'};
  const call=(id,input)=>authority.projectCollaborate('device',id,{...identity,...input});
  const command=(id,value)=>call(id,{action:'session',command:value});
  return {ledger,authority,identity,call,command};
}

test('attaching a central project with no backlog preserves its identity and never creates a central directory',async t=>{
  const f=fixture(t),wb=new Workbench(f.ledger);
  wb.manage('central-project','create_project',{projectId:'existing',title:'Existing central metadata',goal:'No directory required',state:'active'});
  const result=await f.call('attach',{action:'activate',projectId:'existing'});
  assert.equal(result.projectId,'existing');assert.equal(wb.snapshot().projects.length,1);
  assert.equal(wb.snapshot().backlogs[0].projectId,'existing');
  assert.equal((await f.command('create',{kind:'create',title:'Draft'})).result.value.title,'Draft');
});

test('dispatcher settlement replays after inner commit even when outer receipt was not saved',async t=>{
  const f=fixture(t);await f.call('start',{action:'activate'});
  const draft=(await f.command('draft',{kind:'create',title:'Parent',policy:{settlementQuietMs:0}})).result.value;
  const binding=(await f.command('bind',{kind:'bind',taskId:draft.taskId})).result.value;
  const input={kind:'result',outcome:'success',summary:'Done',report:{title:'Evidence',body:'Verified'}};
  const first=await f.command('finish',input);
  f.ledger.managementDatabase().prepare('UPDATE collaboration_commands SET result=NULL').run();
  assert.deepEqual(await f.command('finish',input),first);
  assert.equal(f.ledger.getRun(binding.runId).state,'succeeded');assert.equal(f.ledger.history(draft.taskId).reports.length,1);
});

test('narrow commands reject malformed intent definitively and project history excludes unrelated data and execution configuration',async t=>{
  const f=fixture(t);await f.call('start',{action:'activate'});
  await assert.rejects(f.command('invalid',{kind:'create',title:'Draft',policy:{arbitraryGrant:true}}),{code:'INVALID'});
  const created=(await f.command('draft',{kind:'create',title:'Project task'})).result.value;
  f.ledger.createRun('private-config',{taskId:created.taskId,configuration:{input:{secret:'PRIVATE_EXECUTION_CONFIG'}}});
  f.ledger.createTask('other',{title:'UNRELATED_PRIVATE_TASK'});
  const query=(await f.command('query',{kind:'query'})).result,history=(await f.command('history',{kind:'history',taskId:created.taskId,read:{details:true,section:'events'}})).result;
  assert.equal(query.tasks.length,1);assert.equal(history.task.taskId,created.taskId);assert.ok(history.events.length);
  assert.doesNotMatch(JSON.stringify({query,history}),/PRIVATE_EXECUTION_CONFIG|UNRELATED_PRIVATE_TASK|dispatchOrigin/);
});

test('ordinary return polling filters before the bounded queue, while plain messages retain their own queue',async t=>{
  const f=fixture(t),db=f.ledger.managementDatabase();
  const save=message=>db.prepare("INSERT INTO entities(kind,id,parent,state,data) VALUES('sessionMessage',?,?,?,?)").run(message.messageId,message.taskId,'queued',JSON.stringify(message));
  for(let i=0;i<4;i++)save({messageId:`old-${i}`,taskId:'old-task',nodeId:'device',sessionId:'old-session',state:'queued'});
  save({messageId:'return',taskId:'child',nodeId:'device',sessionId:'origin',workspaceId:'origin-session',state:'queued',completion:{eventId:'return',runId:'child-run',origin:{kind:'session',nodeId:'device',sessionId:'origin',cwd:'/device'}}});
  assert.equal(f.ledger.pendingSessionMessages('device').length,4);
  let deliveries=0;const inbox=new TaskReturnInbox(f.ledger,'device',async()=>{deliveries++;return 'Consumed'});t.after(()=>inbox.dispose());
  await inbox.poll();assert.equal(deliveries,1);
  assert.equal(f.ledger.pendingSessionMessages('device',{kind:'message'}).length,4);
});

test('configuration editing blocks active result delivery and pauses a discovery already in progress',async()=>{
  let delivered,releaseDelivery;const started=new Promise(resolve=>delivered=resolve),gate=new Promise(resolve=>releaseDelivery=resolve);
  const message={messageId:'r',taskId:'child',nodeId:'device',sessionId:'s',completion:{origin:{kind:'session',nodeId:'device'}}};
  const inbox=new TaskReturnInbox({pendingSessionMessages:()=>[message],completeSessionMessage:()=>({})},'device',async()=>{delivered();await gate;return 'Done'});
  const job=inbox.poll();await started;
  await assert.rejects(inbox.beginConfigurationEdit(),/CONFIGURATION_BUSY/);releaseDelivery();await job;
  const release=await inbox.beginConfigurationEdit();await inbox.poll();release();await inbox.dispose();
});

test('project workspace defaults do not restrict ordinary session registration or replace its identity',async t=>{
 const f=fixture(t),wb=new Workbench(f.ledger),db=f.ledger.managementDatabase();
 wb.manage('managed','create_project',{projectId:'managed',title:'Managed',goal:'Preserve selected workspace',state:'active'});
 db.exec('CREATE TABLE pr_projects(id TEXT PRIMARY KEY,cwd TEXT);CREATE TABLE pr_project_workspaces(project TEXT PRIMARY KEY,workspace TEXT)');
 db.prepare('INSERT INTO pr_projects VALUES(?,?)').run('managed','/central/original');
 db.prepare('INSERT INTO pr_project_workspaces VALUES(?,?)').run('managed',JSON.stringify({nodeId:'central',path:'/central/selected'}));
 const selected=await f.authority.projectCollaborate('central','selected',{action:'activate',sessionId:'managed-origin',cwd:'/central/selected',projectId:'managed'});
 assert.equal(selected.projectId,'managed');
 const ordinary={action:'activate',sessionId:'ordinary',cwd:'/central/other-materials',projectId:'managed'};
 const attached=await f.authority.projectCollaborate('central','ordinary',ordinary);
 assert.equal(attached.projectId,'managed');assert.equal(attached.binding.cwd,ordinary.cwd);
 db.prepare('UPDATE pr_projects SET cwd=? WHERE id=?').run('/central/next-pm','managed');
 db.prepare('UPDATE pr_project_workspaces SET workspace=? WHERE project=?').run(JSON.stringify({nodeId:'central',path:'/central/next-pm'}),'managed');
 assert.equal((await f.authority.projectCollaborate('central','after-pm-move',{...ordinary,action:'status'})).binding.cwd,ordinary.cwd);
 const another=await f.authority.projectCollaborate('central','another',{...ordinary,sessionId:'another',cwd:'/central/third-materials'});
 assert.equal(another.projectId,'managed');
 await assert.rejects(f.authority.projectCollaborate('central','changed-cwd',{...ordinary,cwd:'/central/next-pm'}),{code:'CONFLICT'});
 await assert.rejects(f.authority.projectCollaborate('unknown','unregistered',ordinary),{code:'FORBIDDEN'});
 await assert.rejects(f.authority.projectCollaborate('central','missing-project',{...ordinary,sessionId:'missing',projectId:'missing'}),{code:'FORBIDDEN'});
 assert.equal(db.prepare('SELECT cwd FROM pr_projects WHERE id=?').get('managed').cwd,'/central/next-pm');
 assert.equal(JSON.parse(db.prepare('SELECT workspace FROM pr_project_workspaces WHERE project=?').get('managed').workspace).path,'/central/next-pm');
});


test('completion inbox admits a later poll while the first result is still processing',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),seen=[],acks=[];
 const message=n=>({messageId:'r'+n,taskId:'child'+n,nodeId:'device',sessionId:'origin',completion:{origin:{kind:'session',nodeId:'device'}}});
 const messages=[message(1)];
 const inbox=new TaskReturnInbox({pendingSessionMessages:()=>messages,completeSessionMessage:(_id,input)=>acks.push(input)},'device',async message=>{seen.push(message.messageId);await gate;return 'Processed';});
 const first=inbox.poll();
 try{
  for(let i=0;i<100&&seen.length!==1;i++)await new Promise(resolve=>setTimeout(resolve,5));
  messages.push(message(2));const second=inbox.poll();
  try {for(let i=0;i<100&&seen.length!==2;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(seen,['r1','r2']);assert.equal(acks.length,0);}finally{release();await second;}
 }finally{release();await first;await inbox.dispose();}
 assert.equal(acks.length,2);
});
