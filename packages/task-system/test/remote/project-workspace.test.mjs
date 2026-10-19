import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,readFileSync,writeFileSync,symlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {RecoveryStore} from '../../dist/remote/store.js';
import {executionWorkspace,temporaryTaskMetadata} from '../../dist/remote/project-workspace.js';
function fixture(t) {
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'dsh-project-worker-'))),store=new RecoveryStore(join(parent,'store.sqlite'));
 t.after(()=>{store.close();rmSync(parent,{recursive:true,force:true})});
 const claim=(projectId='p',taskId='task',schedulerId='scheduler-one')=>({task:{taskId,title:'Task'},attempt:{nodeId:'worker'},run:{projectContext:{version:1,schedulerId,project:projectId===null?null:{projectId,revision:1,title:'Project',goal:'Goal',description:'Context',acceptanceCriteria:[]}}}});
 const workspace=(claim,sessionId='session',resume=false)=>executionWorkspace({parent,store,claim,sessionId,resume});
 return {parent,store,claim,workspace};
}
test('projects and schedulers are isolated; temporary tasks share one selected directory',async t=>{
 const f=fixture(t),a=await f.workspace(f.claim(),'a'),b=await f.workspace(f.claim('p','task-b'),'b');assert.equal(a,b);
 assert.notEqual(await f.workspace(f.claim('q'),'c'),a);assert.notEqual(await f.workspace(f.claim('p','task','scheduler-other'),'d'),a);
 const temp=await f.workspace(f.claim(null,'temp'),'e');assert.notEqual(temp,a);assert.equal(temp,join(f.parent,'temporary-tasks'));assert.equal(await f.workspace(f.claim(null,'temp-other'),'f'),temp);assert.equal(await f.workspace(f.claim(null,'temp','scheduler-other'),'g'),temp);
 assert.equal(await f.workspace(f.claim(),'a',true),a);
 assert.equal(JSON.parse(readFileSync(join(a,'.dsh-project-context/revision-1.json'),'utf8')).project.projectId,'p');
 await assert.rejects(f.workspace(f.claim('q'),'a',true),/TASK_PROJECT_CHANGED/);
 await assert.rejects(f.workspace(f.claim(),'lost',true),/MAPPING_REQUIRED/);
});
test('managed parents and leaf directories cannot be replaced by links, including links inside the authorized root',async t=>{
 const f=fixture(t),cwd=await f.workspace(f.claim(),'a'),scheduler=dirname(cwd);renameSync(scheduler,scheduler+'-moved');symlinkSync(scheduler+'-moved',scheduler);
 await assert.rejects(f.workspace(f.claim(),'a',true),/SYMLINK/);
});
test('existing legacy sessions keep their original authorized cwd and cannot be adopted without a durable task/session witness',async t=>{
 const f=fixture(t);f.store.rememberScheduler('legacy',{schedulerId:'scheduler-one',nodeId:'worker',executorId:'executor-one'});f.store.createDispatch({attemptId:'legacy',state:'acknowledged',sessionId:'old',claim:{task:{taskId:'task'},attempt:{nodeId:'worker'},run:{}},lease:{}});
 assert.equal(await f.workspace(f.claim(),'old',true),f.parent);
 await assert.rejects(f.workspace(f.claim('p','different'),'old',true),/MAPPING_REQUIRED/);
 await assert.rejects(f.workspace(f.claim('p','task','scheduler-other'),'old',true),/MAPPING_REQUIRED/);
});
test('a Git project gives subsequent task sessions independent detached worktrees instead of modifying the shared checkout',async t=>{
 const f=fixture(t),root=await f.workspace(f.claim(),'a');
 execFileSync('git',['init',root]);writeFileSync(join(root,'code.txt'),'base');execFileSync('git',['-C',root,'add','code.txt']);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);
 const other=await f.workspace(f.claim('p','code-task'),'code-session');assert.notEqual(other,root);assert.equal(readFileSync(join(other,'code.txt'),'utf8'),'base');writeFileSync(join(other,'code.txt'),'task change');assert.equal(readFileSync(join(root,'code.txt'),'utf8'),'base');assert.equal(await f.workspace(f.claim('p','code-task'),'code-session',true),other);
});

test('plain recursive task sessions get independent directories and cannot resume an old shared project mapping',async t=>{
 const f=fixture(t),parent=await f.workspace(f.claim(),'parent');
 const child=f.claim('p','child');child.run.parentRunId='parent-run';
 const sibling=f.claim('p','sibling');sibling.run.parentRunId='parent-run';
 const [a,b]=await Promise.all([f.workspace(child,'child-session'),f.workspace(sibling,'sibling-session')]);
 assert.notEqual(a,parent);assert.notEqual(a,b);assert.equal(await f.workspace(child,'child-session',true),a);
 writeFileSync(join(a,'result.txt'),'child');assert.throws(()=>readFileSync(join(parent,'result.txt')));
 const old=f.claim('p','old-child');await f.workspace(old,'old-session');old.run.parentRunId='parent-run';
 await assert.rejects(f.workspace(old,'old-session',true),/RECURSIVE_WORKSPACE_REQUIRES_NEW_SESSION/);
});

 test('operator-selected parent persists for projects and sessions; new projects follow later selections', async t=>{
  const f=fixture(t), root=realpathSync(mkdtempSync(join(tmpdir(),'dsh-picked-root-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const selected=(claim,sessionId,resume=false,projectRoot=root)=>executionWorkspace({parent:f.parent,store:f.store,claim,sessionId,resume,projectRoot});
  const first=await selected(f.claim(),'first'); assert.ok(first.startsWith(root+'/'));
  assert.equal(await selected(f.claim(),'first',true,f.parent),first);
  assert.equal(await selected(f.claim('p','second'),'second',false,f.parent),first);
  const next=await selected(f.claim('new','third'),'third',false,f.parent); assert.ok(next.startsWith(f.parent+'/'));
  const restricted=f.claim('restricted','explicit');restricted.run.workspaceConstraint='allowed-workspace';
  assert.ok((await selected(restricted,'explicit')).startsWith(f.parent+'/'));
 });
 test('existing project directories survive selecting a different parent before their next task',async t=>{
  const f=fixture(t), first=await f.workspace(f.claim(),'first');
  const selected=realpathSync(mkdtempSync(join(tmpdir(),'dsh-new-parent-')));t.after(()=>rmSync(selected,{recursive:true,force:true}));
  assert.equal(await executionWorkspace({parent:f.parent,projectRoot:selected,store:f.store,claim:f.claim('p','new-task'),sessionId:'new-session',resume:false}),first);
 });

test('an explicit workspace constraint cannot resume outside a replaced route binding',async t=>{
 const f=fixture(t),claim=f.claim();claim.run.workspaceConstraint='explicit';await f.workspace(claim,'existing');
 const replacement=realpathSync(mkdtempSync(join(tmpdir(),'dsh-restricted-root-')));t.after(()=>rmSync(replacement,{recursive:true,force:true}));
 await assert.rejects(executionWorkspace({parent:replacement,projectRoot:f.parent,store:f.store,claim,sessionId:'existing',resume:true}),/WORKSPACE_ESCAPE/);
 await assert.rejects(executionWorkspace({parent:replacement,store:f.store,claim,sessionId:'new-session',resume:false}),/WORKSPACE_ESCAPE/);
});

test('upgrade adopts selected existing temporary folder without touching old task files; context namespaces never collide',async t=>{
 const f=fixture(t),old=join(f.parent,'temporary-tasks');mkdirSync(old);mkdirSync(join(old,'task-old'));writeFileSync(join(old,'task-old','TOOLS.md'),'original');
 const cwd=await f.workspace(f.claim(null,'new'),'new');assert.equal(cwd,old);assert.equal(readFileSync(join(old,'task-old','TOOLS.md'),'utf8'),'original');
 const a=await temporaryTaskMetadata(cwd,'scheduler-one','new','planner'),b=await temporaryTaskMetadata(cwd,'scheduler-one','new','executor'),c=await temporaryTaskMetadata(cwd,'scheduler-two','new','executor');
 assert.notEqual(a,b);assert.notEqual(b,c);assert.equal(await f.workspace(f.claim(null,'new'),'new',true),old);
});
