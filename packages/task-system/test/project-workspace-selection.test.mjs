import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Workbench} from '../dist/workbench.js';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
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
test('new project selection rejects remote workspaces and never imports executor heartbeat directories',async()=>{
 const h=await createNativeHarness({config});
 try {
  const runtime=h.ctx.taskSystem.projects,existing=join(h.dir,'worker-repo');mkdirSync(existing);
  const workspace=registered(h,existing);
  assert.deepEqual(runtime.workspaceOptions().workspaces,[]);
  await assert.rejects(runtime.create({commandId:'remote',title:'Remote',goal:'Reject a foreign directory',workspace}),error=>error.code==='WORKSPACE_POLICY');
  assert.equal(runtime.snapshot().projects.length,0);
  runtime.saveSettings({root:join(h.dir,'fallback'),expectedRevision:0});const legacy=await runtime.create({commandId:'legacy',title:'Legacy remote',goal:'Retain historical semantics'});
  h.ledger.managementDatabase().prepare('INSERT INTO pr_project_workspaces VALUES(?,?)').run(legacy.projectId,JSON.stringify({workspaceId:workspace.workspaceId,nodeId:'worker',path:existing}));
  assert.equal(runtime.snapshot().projects[0].workspace,existing);assert.equal(h.ledger.projectWorkspaceConstraint(legacy.projectId),'existing');
  const task=h.ledger.createTask('legacy-task',{title:'Historical bound task'}).value;new Workbench(h.ledger).manage('legacy-link','link_backlog_task',{backlogId:'pr:'+legacy.projectId,taskId:task.taskId});
  assert.throws(()=>h.ledger.createRun('wrong-node',{taskId:task.taskId,route:{nodeId:'other',provider:'test-offline',model:'script',requiredCapabilities:[]}}),/selected project device/);
  const run=h.ledger.createRun('right-node',{taskId:task.taskId,route:{nodeId:'worker',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;assert.equal(run.workspaceConstraint,'existing');
  h.ledger.registerNode('revoke-legacy',node('worker',[]));assert.throws(()=>h.ledger.projectWorkspaceConstraint(legacy.projectId),/no longer authorized/);
 }finally{await h.dispose();}
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

test('planner adopts a real official local workspace outside fallback parent without a self executor or heartbeat inventory',async()=>{
 const h=await createNativeHarness({config});
 try {
  const {attachWorkspaceRegistry}=await import('../../../tests/settings/local-workspace-harness.mjs');
  const registry=await attachWorkspaceRegistry(h),runtime=h.ctx.taskSystem.projects;
  const existing=join(h.dir,'official-repo'),root=join(h.dir,'fallback');mkdirSync(existing);writeFileSync(join(existing,'source.txt'),'retain');runtime.saveSettings({root,expectedRevision:0});
  const official=await registry.create(existing,'Official existing repository');
  assert.throws(()=>h.ledger.getNode('local'),error=>error.code==='NOT_FOUND');
  assert.equal(h.ledger.registeredWorkspaces('local').length,0);
  const choices=runtime.workspaceOptions();assert.equal(choices.error,null);assert.deepEqual(choices.workspaces,[{workspaceId:'registry:'+official.id,nodeId:'local',path:existing,label:'Official existing repository'}]);
  const workspace={kind:'registered',nodeId:'local',workspaceId:choices.workspaces[0].workspaceId};
  const result=await runtime.create({commandId:'official',title:'Adopt official',goal:'Use original',workspace});
  assert.equal((await runtime.conversation(result.projectId)).workspace,existing);assert.equal(runtime.projectWorkspace(result.projectId).path,existing);
  assert.equal(readFileSync(join(existing,'source.txt'),'utf8'),'retain');assert.ok(!readdirSync(existing).some(name=>name.startsWith('project-')));
  assert.throws(()=>h.ledger.getNode('local'),error=>error.code==='NOT_FOUND');
  assert.equal(runtime.settings().root,root);
  const fallback=await runtime.create({commandId:'fallback',title:'Default new',goal:'New directory'});assert.ok(runtime.snapshot().projects.find(p=>p.id===fallback.projectId).workspace.startsWith(root+'/project-'));
  assert.equal(h.adapter.requests.length,0);
 }finally{await h.dispose();}
});
test('official registration removal, missing paths and registry read errors remain distinct from an empty catalog',async()=>{
 const h=await createNativeHarness({config});
 try {
  const {attachWorkspaceRegistry}=await import('../../../tests/settings/local-workspace-harness.mjs');
  const registry=await attachWorkspaceRegistry(h),runtime=h.ctx.taskSystem.projects;
  assert.deepEqual(runtime.workspaceOptions().workspaces,[]);assert.equal(runtime.workspaceOptions().error,null);
  const existing=join(h.dir,'removed-repo');mkdirSync(existing);const item=await registry.create(existing,'Removed');
  const selection={kind:'registered',nodeId:'local',workspaceId:runtime.workspaceOptions().workspaces[0].workspaceId};
  h.ledger.registerWorkspace('stale-copy',{workspaceId:selection.workspaceId,nodeId:'local',path:existing,state:'ready',createdAt:new Date().toISOString()});
  await registry.delete(item.id);
  assert.deepEqual(runtime.workspaceOptions().workspaces,[]);
  await assert.rejects(runtime.create({commandId:'revoked',title:'Revoked',goal:'Reject',workspace:selection}),error=>error.code==='WORKSPACE_POLICY');
  const list=registry.list;registry.list=()=>{throw Error('test storage unavailable');};
  assert.match(runtime.workspaceOptions().error,/读取失败/);assert.deepEqual(runtime.workspaceOptions().workspaces,[]);registry.list=list;
  assert.equal(runtime.workspaceOptions().error,null);
 }finally{await h.dispose();}
});
