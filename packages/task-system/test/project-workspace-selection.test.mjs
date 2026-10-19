import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
import {Workbench} from '../dist/workbench.js';
import {executionWorkspace} from '../dist/remote/project-workspace.js';
import {RecoveryStore} from '../dist/remote/store.js';
const config={role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'}};
const node=(nodeId,workspaceIds)=>({nodeId,roles:['executor'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds,enabled:true,lastSeenAt:new Date().toISOString()});
function registered(h,path,nodeId='worker',workspaceId='existing') {
 h.ledger.registerNode('node:'+nodeId,node(nodeId,[workspaceId]));
 h.ledger.registerWorkspace('workspace:'+workspaceId,{workspaceId,nodeId,path,label:'Existing repo',state:'ready',createdAt:new Date().toISOString()});
 return {kind:'registered',nodeId,workspaceId};
}
test('existing controlled local directory is adopted exactly, existing files retained, parent default affects only later new projects',async()=>{
 const h=await createNativeHarness({config});
 try {
  const runtime=h.ctx.taskSystem.projects,root=join(h.dir,'projects'),existing=join(root,'already-here');mkdirSync(existing,{recursive:true});writeFileSync(join(existing,'PROJECT.md'),'user project');writeFileSync(join(existing,'code.txt'),'keep');
  runtime.saveSettings({root,expectedRevision:0});
  const input={commandId:'adopt',title:'Adopt',goal:'Use existing directory',workspace:{kind:'directory',nodeId:'local',path:existing}};
  const result=await runtime.create(input);assert.deepEqual(await runtime.create(input),result);
  assert.equal(runtime.snapshot().projects[0].workspace,existing);assert.equal((await runtime.conversation(result.projectId)).workspace,existing);
  assert.equal(readFileSync(join(existing,'PROJECT.md'),'utf8'),'user project');assert.equal(readFileSync(join(existing,'code.txt'),'utf8'),'keep');
  assert.ok(!readdirSync(existing).some(name=>name.startsWith('project-')));
  assert.equal(runtime.settings().root,root);
  const next=join(h.dir,'later');runtime.saveSettings({root:next,expectedRevision:1});const created=await runtime.create({commandId:'new',title:'New',goal:'Use default'});
  assert.ok(runtime.snapshot().projects.find(p=>p.id===created.projectId).workspace.startsWith(next+'/project-'));assert.equal(runtime.snapshot().projects.find(p=>p.id===result.projectId).workspace,existing);
  await assert.rejects(runtime.create({...input,workspace:{...input.workspace,path:root}}),error=>error.code==='CONFLICT');
 }finally{await h.dispose();}
});
test('remote workspace selection keeps device authority and real execution cwd without making a nested project',async()=>{
 const h=await createNativeHarness({config});let store;
 try {
  const runtime=h.ctx.taskSystem.projects,root=join(h.dir,'coordinator'),existing=join(h.dir,'worker-repo');mkdirSync(existing);writeFileSync(join(existing,'code.txt'),'base');runtime.saveSettings({root,expectedRevision:0});
  execFileSync('git',['init',existing],{stdio:'pipe'});execFileSync('git',['-C',existing,'add','code.txt']);execFileSync('git',['-C',existing,'-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','initial'],{stdio:'pipe'});
  const workspace=registered(h,existing);const result=await runtime.create({commandId:'remote',title:'Remote',goal:'Use worker repo',workspace});
  assert.equal(runtime.snapshot().projects[0].workspace,existing);assert.equal(runtime.snapshot().projects[0].workspaceNodeId,'worker');assert.ok(runtime.snapshot().projects[0].coordinatorWorkspace.startsWith(root+'/project-'));
  assert.equal(h.ledger.projectWorkspaceConstraint(result.projectId),'existing');assert.deepEqual(runtime.snapshotForNode('worker').workspaceOptions,{nodeId:'worker',roots:[],workspaces:[]});
  const task=h.ledger.createTask('task',{title:'Read existing code'}).value;new Workbench(h.ledger).manage('link','link_backlog_task',{backlogId:'pr:'+result.projectId,taskId:task.taskId});
  assert.throws(()=>h.ledger.createRun('wrong-device',{taskId:task.taskId,route:{nodeId:'other',provider:'test-offline',model:'script',requiredCapabilities:[]}}),/selected project device/);
  const run=h.ledger.createRun('correct-device',{taskId:task.taskId,route:{nodeId:'worker',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
  assert.equal(run.workspaceConstraint,'existing');assert.equal(run.route.workspaceId,'existing');
  store=new RecoveryStore(join(h.dir,'recovery.sqlite'));const claim={task,run,attempt:{nodeId:'worker'}};
  const cwd=await executionWorkspace({parent:existing,store,claim,sessionId:'existing-session',resume:false});assert.equal(cwd,existing);assert.equal(readFileSync(join(cwd,'code.txt'),'utf8'),'base');writeFileSync(join(cwd,'result.txt'),'written at original root');assert.equal(readFileSync(join(existing,'result.txt'),'utf8'),'written at original root');assert.ok(!readdirSync(existing).some(name=>name.startsWith('scheduler-')||name.startsWith('project-')));
  h.ledger.registerNode('revoke',node('worker',[]));assert.throws(()=>h.ledger.projectWorkspaceConstraint(result.projectId),/no longer authorized/);assert.throws(()=>h.ledger.createRun('revoked',{taskId:task.taskId,route:run.route}),/no longer authorized/);
 }finally{store?.close();await h.dispose();}
});
test('selection rejects foreign ownership, missing grants, unavailable workspace, traversal, symlinks and directories outside controlled roots',async()=>{
 const h=await createNativeHarness({config});
 try {
  const runtime=h.ctx.taskSystem.projects,root=join(h.dir,'projects'),existing=join(root,'existing');mkdirSync(existing,{recursive:true});runtime.saveSettings({root,expectedRevision:0});const selected=registered(h,existing);
  const create=(workspace,id)=>runtime.create({commandId:id,title:'Invalid',goal:'Reject',workspace});
  await assert.rejects(create({...selected,nodeId:'local'},'foreign'));
  h.ledger.registerNode('revoke',node('worker',[]));await assert.rejects(create(selected,'ungranted'),error=>error.code==='WORKSPACE_POLICY');
  const directory={kind:'directory',nodeId:'local',path:existing};
  await assert.rejects(create({...directory,nodeId:'worker'},'foreign-directory'),error=>error.code==='WORKSPACE_POLICY');
  for(const [id,path] of [['outside',h.dir],['missing',join(root,'missing')],['escape',root+'/existing/../existing']])await assert.rejects(create({...directory,path},id),error=>error.code==='WORKSPACE_POLICY');
  symlinkSync(existing,join(root,'linked'));await assert.rejects(create({...directory,path:join(root,'linked')},'linked'),error=>error.code==='WORKSPACE_POLICY');assert.equal(runtime.snapshot().projects.length,0);
 }finally{await h.dispose();}
});
