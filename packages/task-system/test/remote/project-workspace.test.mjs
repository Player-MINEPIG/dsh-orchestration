import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync,symlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {RecoveryStore} from '../../dist/remote/store.js';
import {executionWorkspace} from '../../dist/remote/project-workspace.js';
function fixture(t) {
 const parent=realpathSync(mkdtempSync(join(tmpdir(),'dsh-project-worker-'))),store=new RecoveryStore(join(parent,'store.sqlite'));
 t.after(()=>{store.close();rmSync(parent,{recursive:true,force:true})});
 const claim=(projectId='p',taskId='task',schedulerId='scheduler-one')=>({task:{taskId,title:'Task'},attempt:{nodeId:'worker'},run:{projectContext:{version:1,schedulerId,project:projectId===null?null:{projectId,revision:1,title:'Project',goal:'Goal',description:'Context',acceptanceCriteria:[]}}}});
 const workspace=(claim,sessionId='session',resume=false)=>executionWorkspace({parent,store,claim,sessionId,resume});
 return {parent,store,claim,workspace};
}
test('projects and schedulers are isolated; temporary tasks share one workspace with separate session mappings',async t=>{
 const f=fixture(t),a=await f.workspace(f.claim(),'a'),b=await f.workspace(f.claim('p','task-b'),'b');assert.equal(a,b);
 assert.notEqual(await f.workspace(f.claim('q'),'c'),a);assert.notEqual(await f.workspace(f.claim('p','task','scheduler-other'),'d'),a);
 const temp=await f.workspace(f.claim(null,'temp'),'e');assert.notEqual(temp,a);assert.equal(await f.workspace(f.claim(null,'temp-other'),'f'),temp);assert.notEqual(await f.workspace(f.claim(null,'temp','scheduler-other'),'g'),temp);
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
