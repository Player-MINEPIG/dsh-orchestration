import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createNativeHarness} from '../dsh/native-harness.mjs';
import {attachWorkspaceRegistry} from './local-workspace-harness.mjs';
import {Workbench} from '../../packages/task-system/dist/workbench.js';

async function fixture(t) {
 const h=await createNativeHarness({config:{role:'planner',projectAgentOptions:{provider:'test-offline',model:'script'},schedulerEnabled:false}});t.after(()=>h.dispose());
 const runtime=h.ctx.taskSystem.projects,registry=await attachWorkspaceRegistry(h),dirs=['first','next'].map(n=>join(h.dir,n));
 dirs.forEach(d=>mkdirSync(d));writeFileSync(join(dirs[0],'existing.txt'),'Original files remain in place');
 const entries=await Promise.all(dirs.map((d,i)=>registry.create(d,'Workspace '+i)));
 const selection=i=>({kind:'registered',nodeId:'local',workspaceId:'registry:'+entries[i].id});
 const {projectId}=await runtime.create({commandId:'fixture-project',title:'Settings fixture',goal:'Preserve real task and session relationships',workspace:selection(0)});
 const save=(extra={})=>runtime.saveExecutionSettings({projectId,expectedRevision:runtime.executionSettings(projectId).revision,allowedNodeIds:null,executionBindings:{},...extra});
 return {h,runtime,registry,dirs,entries,selection,projectId,save};
}

test('changing coordinator cwd creates a real next generation, preserves history across resync and updates default tool projection',async t=>{
 const f=await fixture(t),before=f.runtime.executionSettings(f.projectId),oldSession=before.coordinatorSession.sessionId;
 assert.throws(()=>f.h.ledger.getNode('local'),{code:'NOT_FOUND'});
 const saved=await f.save({coordinatorWorkspace:f.selection(1),allowedNodeIds:[]});
 assert.equal(saved.revision,1);assert.equal(saved.coordinatorSessionChanged,true);assert.notEqual(saved.coordinatorSession.sessionId,oldSession);assert.equal(saved.coordinatorSession.generation,2);
 assert.equal((await f.h.ctx.sessionPersistence.stat(SessionId(oldSession))).header.cwd,f.dirs[0]);
 assert.equal((await f.h.ctx.sessionPersistence.stat(SessionId(saved.coordinatorSession.sessionId))).header.cwd,f.dirs[1]);
 await f.runtime.syncWorkspaces();
 assert.ok(f.entries[0].sessionIds.includes(oldSession));assert.ok(!f.entries[1].sessionIds.includes(oldSession));assert.ok(f.entries[1].sessionIds.includes(saved.coordinatorSession.sessionId));
 const links=new Workbench(f.h.ledger).snapshot().projectWorkspaces.filter(link=>link.projectId===f.projectId&&link.isDefault);
 assert.equal(links.length,1);assert.equal(f.h.ledger.getWorkspace(links[0].workspaceId).path,f.dirs[1]);
 assert.equal(f.runtime.snapshot().projects.find(p=>p.id===f.projectId).workspace,f.dirs[1]);
 assert.equal(readFileSync(join(f.dirs[0],'existing.txt'),'utf8'),'Original files remain in place');
 assert.throws(()=>readFileSync(join(f.dirs[1],'existing.txt')));
 await assert.rejects(f.save({expectedRevision:0,coordinatorWorkspace:f.selection(0)}),{code:'CONFLICT'});
 assert.equal(f.runtime.executionSettings(f.projectId).coordinatorSession.generation,2);
 assert.equal(f.h.ledger.snapshot().runs.length,0);assert.equal(f.h.adapter.requests.length,0);
});

test('an active managed dispatcher blocks coordinator relocation, while policy-only edits and unrelated external sessions remain independent',async t=>{
 const f=await fixture(t),s=f.runtime.executionSettings(f.projectId).coordinatorSession.sessionId;
 const origin={kind:'session',nodeId:'local',sessionId:s,cwd:f.dirs[0],composition:{provider:'test-offline',model:'script',tools:[]}};
 const parent=f.h.ledger.withDispatchOrigin(origin,()=>f.h.ledger.createTask('draft',{title:'Active parent',policy:{settlementQuietMs:0}}).value);
 f.h.ledger.bindDispatcher('bind',{taskId:parent.taskId,nodeId:'local',sessionId:s,projectId:f.projectId});
 await assert.rejects(f.save({coordinatorWorkspace:f.selection(1)}),{code:'BUSY'});
 const policy=await f.save({allowedNodeIds:[]});assert.equal(policy.coordinatorSessionChanged,false);assert.equal(policy.coordinatorSession.sessionId,s);
 f.h.ledger.submitDispatcherResult('done',{nodeId:'local',sessionId:s,outcome:'success',summary:'No child work',report:{title:'Done',body:'No work was dispatched'}});
 const external=await f.h.ctx.agents.create({sessionId:SessionId('external-plugin-owned-session'),meta:{cwd:f.dirs[0]},agentOptions:{provider:'test-offline',model:'script'}});
 try {assert.equal((await f.save({coordinatorWorkspace:f.selection(1)})).coordinatorSessionChanged,true);assert.equal(external.agent.session.header.cwd,f.dirs[0]);}finally{await external.dispose();}
});

test('legacy remote execution binding is not displayed as scheduler cwd and first save makes new per-node policy authoritative',async t=>{
 const f=await fixture(t),l=f.h.ledger,db=l.managementDatabase();
 l.registerNode('legacy-node',{nodeId:'remote',roles:['executor'],models:[],capabilities:[],workspaceIds:[],enabled:true,maxConcurrent:1});
 l.recordExecutorWorkspaces('legacy-grant',{nodeId:'remote',sampledAt:Date.now(),workspaces:[{workspaceId:'legacy-remote',nodeId:'remote',label:'Remote repository',path:'/remote/repository',state:'ready'}]});
 db.prepare('UPDATE pr_project_workspaces SET workspace=? WHERE project=?').run(JSON.stringify({workspaceId:'legacy-remote',nodeId:'remote',path:'/remote/repository'}),f.projectId);
 const before=f.runtime.executionSettings(f.projectId);assert.equal(before.coordinatorWorkspace.path,f.dirs[0]);assert.deepEqual(before.executionBindings,{remote:'legacy-remote'});
 const saved=await f.save({executionBindings:before.executionBindings});assert.equal(saved.coordinatorWorkspace.scope,'coordinator');assert.equal(saved.coordinatorWorkspace.nodeId,'local');assert.equal(saved.coordinatorSessionChanged,false);
 assert.equal(l.projectWorkspaceConstraint(f.projectId),undefined);assert.equal(l.projectExecutionPolicy(f.projectId,'remote').workspaceId,'legacy-remote');
 await assert.rejects(f.save({executionBindings:{remote:'not-authorized'}}),{code:'WORKSPACE_POLICY'});
 assert.equal(f.runtime.executionSettings(f.projectId).revision,1);
});
