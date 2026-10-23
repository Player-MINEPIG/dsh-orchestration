import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RecoveryStore} from '../dist/remote/store.js';
import {RemoteExecutionService} from '../dist/remote/index.js';
import {TaskPluginSettings} from '../dist/settings.js';
import {TaskLedger} from '../dist/ledger.js';
import {SessionDispatchIndex} from '../dist/session-task-monitor.js';
import {executorPanelSnapshot} from '../dist/executor-panel.js';

function fixture(t,role='executor') {
 const store=new RecoveryStore(':memory:'),ledger=TaskLedger.open(':memory:');t.after(()=>{store.close();ledger.close();});
 const nodeId='mbp',run={runId:'run-child',taskId:'child',state:'queued',updatedAt:'2026-10-22T01:00:00Z',parentRunId:'parent-run',route:{nodeId,model:'fixture',workspaceId:'mbp-workspace'},configuration:{secret:'must never reach browser'},intentSnapshot:{title:'Queued child',description:'Original workload'}};
 const task={taskId:'child',parentTaskId:'parent',title:'Child analysis',description:'Read only analysis'};
 const worker={queueObservedAt:'2026-10-22T02:00:00Z',lastPollFailed:true,isExecuting:()=>false,queueSnapshot:()=>[run]};
 const remote=Object.assign(Object.create(RemoteExecutionService.prototype),{store,workers:new Set([worker]),config:{role:'executor',nodeId,paused:false,pollIntervalMs:5000,concurrency:1},active:true,heartbeatTimer:1,lastHeartbeatAcknowledgedAt:'2026-10-22T03:00:00Z',lastHeartbeatFailed:false});
 let calls=0;remote.coordinatorLedger={projectSnapshot(){calls++;throw Error('remote forbidden');}};
 const taskSystem={config:{role,nodeId},ledger,results:{pending:()=>[]},projects:{snapshot:()=>({projects:[],tasks:[],runs:[],viewContext:{role:'planner'}})}};
 const persistence={identity:Symbol(),stat:async()=>null};
 const settings=Object.assign(Object.create(TaskPluginSettings.prototype),{sessionDispatchIndex:new SessionDispatchIndex(),ctx:{get:key=>({taskSystem,remoteExecution:remote,sessionPersistence:persistence})[key]}});
 return {store,ledger,remote,settings,task,run,get calls(){return calls;},save(state='dispatching',sessionId='actual-session'){store.createDispatch({attemptId:'attempt-'+state,state,claim:{task,run,attempt:{attemptId:'attempt-'+state}},lease:{},sessionId,...(state==='acknowledged'?{result:{outcome:'success',summary:'actual report'}}:{})});}};
}
test('local queue, durable claim uncertainty, acknowledged history and parents survive coordinator outage',async t=>{
 const f=fixture(t);f.store.saveOutbound('claim',{operation:'claim',payload:{runId:f.run.runId,secret:'not displayed'},state:'uncertain'});
 let view=await f.settings.projectSnapshot();assert.equal(view.viewContext.scope,'local');assert.equal(view.viewContext.pollState,'failed');assert.equal(view.tasks[0].stateLabel,'领取未确认');assert.equal(view.viewCapabilities.planner,true);
 f.save('acknowledged');view=await f.settings.projectSnapshot();assert.equal(view.tasks.length,1);assert.equal(view.tasks[0].stateLabel,'结果已回传');assert.equal(view.tasks[0].parentTaskId,'parent');assert.equal(view.runs[0].parentRunId,'parent-run');assert.deepEqual(view.runs[0].sessionIds,['actual-session']);assert.equal(view.tasks[0].report,'actual report');assert.doesNotMatch(JSON.stringify(view),/secret|must never/);assert.equal(f.calls,0);
 await assert.rejects(f.settings.projectSnapshot({view:'planner'}),e=>e.details.reason==='CENTRAL_UNAVAILABLE');
});
for(const role of ['executor','both'])test(`${role} session view uses exact local assignment with no remote snapshot or sibling leak`,async t=>{
 const f=fixture(t,role);f.save();
 const mine=await f.settings.sessionTasks({sessionId:'actual-session'});assert.equal(mine.tasks[0].id,'child');assert.equal(mine.tasks[0].parentTaskId,'parent');assert.deepEqual(mine.runs[0].sessionIds,['actual-session']);assert.equal(mine.viewContext.scope,'local');
 const other=await f.settings.sessionTasks({sessionId:'unrelated-session'});assert.equal(other.tasks.length,0);assert.equal(f.calls,0);
});
test('recovery panel bounds history and returns claim metadata without payloads',t=>{
 const f=fixture(t);for(let i=0;i<205;i++)f.store.createDispatch({attemptId:'history-'+i,state:'acknowledged',claim:{task:f.task,run:{...f.run,runId:'history-'+i}},lease:{},sessionId:'s'});
 f.save('uncertain');assert.equal(f.store.panelDispatches().length,201);assert.equal(f.store.panelDispatches()[0].state,'uncertain');assert.equal(f.remote.executorPanel().truncated,true);
 f.store.saveOutbound('claim',{operation:'claim',payload:{runId:'orphan-run',credential:'never return'},state:'uncertain'});assert.deepEqual(f.store.panelClaims(),[{commandId:'claim',runId:'orphan-run',state:'uncertain',endpoint:'',audience:''}]);
});
test('projection de-duplicates queue and attempts by Run while retaining other Runs of the Task',()=>{
 const row={taskId:'t',runId:'r',nodeId:'mbp',title:'T',description:'D',state:'queued',source:'local-queue',time:'2026-10-22T01:00:00Z',sessionIds:[]};
 const view=executorPanelSnapshot('mbp',[row,{...row,state:'acknowledged',source:'local-recovery',sessionIds:['s']},{...row,runId:'old',time:'2026-10-21T01:00:00Z',state:'failed'},{...row,runId:'foreign',nodeId:'other'}]);
 assert.equal(view.tasks.length,1);assert.equal(view.runs.length,2);assert.equal(view.tasks[0].stateLabel,'结果已回传');assert.deepEqual(view.tasks[0].sessionIds,['s']);
});
