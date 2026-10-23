import {registerExecutor} from '../../../tests/dsh/executor-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createNativeHarness } from '../../../tests/dsh/native-harness.mjs';
import { ExecutorWorker, RecoveryStore, nativeExecutionAdapter } from '../dist/remote/api.js';

for (const transport of ['local', 'remote']) test(`${transport} delegated sessions retain isolated cwd and history without creating sidebar workspaces`, async () => {
  const h = await createNativeHarness({executionRoot:true,config:{projectAgentOptions:{provider:'test-offline',model:'script'}},script:[1,2].map(i=>({name:'task_submit_result',args:{outcome:'success',summary:`Child ${i}`,reportTitle:`Child ${i}`,reportBody:`Retained child evidence ${i}`}}))});
  let worker, store;
  try {
    const l=h.ledger, runtime=h.ctx.taskSystem.projects, registered=new Map();
    h.ctx.provide('workspaceRegistry',{async create(path,title){
      if(!registered.has(path))registered.set(path,{title,sessions:new Set(),async attachSession(id){
        const session=await h.ctx.sessionPersistence.open(id,'read');
        try{assert.equal(session.header.cwd,path,'official membership requires exact immutable cwd');}finally{await session.close();}
        this.sessions.add(id);
      }});
      return registered.get(path);
    }});
    runtime.saveSettings({root:join(h.dir,'planner'),expectedRevision:0});
    const {projectId}=await runtime.create({commandId:'project',title:'Daily project',goal:'Keep task evidence'});
    const project=runtime.snapshot().projects.find(p=>p.id===projectId);
    const route={nodeId:'local',workspaceId:'default',provider:'test-offline',model:'script',requiredCapabilities:[]};
    l.registerWorkspace('workspace',{workspaceId:'default',nodeId:'local',path:h.dir,label:'Authorized root',state:'ready',createdAt:new Date().toISOString()});
    registerExecutor(l, 'node',{nodeId:'local',roles:['both'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['default'],defaultWorkspaceId:'default',enabled:true,maxConcurrent:4});
    const task=l.createTask('parent',{title:'Daily root',policy:{maxChildren:3,maxDepth:3}}).value;
    runtime.linkTask(project.sessionId,task.taskId);
    const parent=l.createRun('parent-run',{taskId:task.taskId,route}).value;
    const claim=l.claim('parent-claim',{runId:parent.runId,nodeId:'local',ttlMs:60000}).value;
    const ref={runId:parent.runId,attemptId:claim.attempt.attemptId,nodeId:'local',fence:claim.attempt.fence,executionId:'parent-owner'};
    l.markRunning('parent-running',ref);
    if(transport==='remote'){
      store=new RecoveryStore(join(h.dir,'worker.sqlite'));
      worker=new ExecutorWorker({ledger:l,store,provider:nativeExecutionAdapter(h.ctx.taskSystem.native,{provider:'test-offline',models:[{model:'script',reasoningEfforts:[]}],capabilities:[]}),policy:{role:'executor',nodeId:'local',capabilities:[],workspaces:[{workspaceId:'default',nodeId:'local',path:h.dir,allowedRoot:h.dir}]}});
    }
    const paths=[];
    for(const i of [1,2]){
      const child=l.delegateTask(`delegate-${i}`,{...ref,title:`Internal step ${i}`,route}).value;
      if(worker){assert.equal((await worker.execute(child.run.runId,`execute-${i}`)).state,'acknowledged');}
      else{
        const owned=l.claim(`child-claim-${i}`,{runId:child.run.runId,nodeId:'local',ttlMs:10000}).value;
        assert.equal((await h.ctx.taskSystem.native.execute(owned)).run.state,'succeeded');
      }
      const run=l.getRun(child.run.runId), attempt=l.getAttempt(run.currentAttemptId);
      assert.equal(run.state,'succeeded');assert.equal(run.parentRunId,parent.runId);
      assert.equal(run.projectContext.project.projectId,projectId);
      const session=await h.ctx.sessionPersistence.open(attempt.sessionId,'read');
      try{assert.ok(session.header.cwd.startsWith(join(h.dir,'.dsh','delegated')+'/'),'recursive task cwd remains beneath the authorized repository delegation directory');assert.ok(existsSync(session.header.cwd));paths.push(session.header.cwd);}finally{await session.close();}
      assert.equal(l.history(child.task.taskId).reports.length,1);
      assert.deepEqual([...registered.keys()],[project.workspace],'internal execution must not register or attach its cwd as another project');
    }
    assert.notEqual(paths[0],paths[1]);
    assert.deepEqual([...registered.get(project.workspace).sessions],[project.sessionId]);
    await runtime.syncWorkspaces();
    assert.equal(registered.size,1);
  } finally {await worker?.dispose();store?.close();await h.dispose();}
});
