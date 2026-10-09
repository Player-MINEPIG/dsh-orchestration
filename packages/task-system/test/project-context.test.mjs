import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskLedger} from '../dist/ledger.js';
import {Workbench} from '../dist/workbench.js';
import {projectContext} from '../dist/project-context.js';

function fixture(t) {
 const l=TaskLedger.open(':memory:',{role:'planner',nodeId:'planner'});t.after(()=>l.close());const w=new Workbench(l);let seq=0;
 const m=(op,data)=>w.manage('m'+(++seq),op,data).value;
 l.registerNode('node',{nodeId:'worker',roles:['executor'],models:[{provider:'test',model:'small',reasoningEfforts:[]}],capabilities:[],workspaceIds:[],enabled:true});
 m('create_project',{projectId:'p',title:'Project',goal:'Original goal',description:'Context',state:'active'});
 m('create_backlog',{backlogId:'b',projectId:'p',title:'Backlog'});
 const task=l.createTask('task',{title:'Task'}).value;m('link_backlog_task',{backlogId:'b',taskId:task.taskId});
 const create=(key)=>l.createRun(key,{taskId:task.taskId,route:{nodeId:'worker',provider:'test',model:'small',requiredCapabilities:[]}}).value;
 return {l,m,task,create};
}
test('project identity, revision and context are pinned by the authority at run creation; subsequent edits do not change a dispatched run',t=>{
 const {l,m,create}=fixture(t);const first=create('first');
 assert.equal(first.projectContext.schedulerId,l.schedulerIdentity());assert.equal(first.projectContext.project.projectId,'p');
 m('update_project',{projectId:'p',expectedRevision:1,goal:'Changed goal'});
 assert.equal(l.getRun(first.runId).projectContext.project.goal,'Original goal');
 const next=create('next');assert.equal(next.projectContext.project.goal,'Changed goal');assert.equal(next.projectContext.project.revision,2);
 assert.equal('path' in next.projectContext.project,false);
});
test('a task belonging to multiple projects cannot silently adopt one project for dispatch',t=>{
 const {m,task,create}=fixture(t);
 m('create_project',{projectId:'q',title:'Other',goal:'Other',state:'active'});m('create_backlog',{backlogId:'c',projectId:'q',title:'Other'});m('link_backlog_task',{backlogId:'c',taskId:task.taskId});
 assert.throws(()=>create('ambiguous'),/one project/);
});
test('unsupported versions, unknown path grants and excessive context are rejected before deriving a workspace',()=>{
 const c={version:1,schedulerId:'scheduler-one',project:{projectId:'p',revision:1,title:'P',goal:'G',description:'D',acceptanceCriteria:[]}};
 assert.deepEqual(projectContext(c),c);assert.throws(()=>projectContext({...c,version:2}),/VERSION_UNSUPPORTED/);
 assert.throws(()=>projectContext({...c,project:{...c.project,path:'/foreign'}}),/INVALID_PROJECT_CONTEXT/);
 assert.throws(()=>projectContext({...c,project:{...c.project,description:'x'.repeat(20001)}}),/CONTEXT_LIMIT/);
});
