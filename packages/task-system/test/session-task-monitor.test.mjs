import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskLedger } from '../dist/ledger.js';
import { SessionCollaboration } from '../dist/project-collaboration/session.js';
import { dispatchedTaskIds, SessionDispatchIndex, sessionDispatchOperations, sessionTaskSnapshot, sortSessionTasks } from '../dist/session-task-monitor.js';

test('results sort by return time across sources, ahead of unfinished tasks; ties are stable', () => {
  const tasks = [
    {id:'running-old',time:'2026-10-15T01:00:00Z'},
    {id:'local',time:'2026-10-15T02:00:00Z',returnedAt:'2026-10-15T03:00:00Z'},
    {id:'shell',time:'2026-10-15T01:00:00Z',returnedAt:'2026-10-15T04:00:00Z'},
    {id:'ledger',time:'2026-10-15T05:00:00Z',returnedAt:'2026-10-15T02:00:00Z'},
    {id:'running-new',time:'2026-10-15T06:00:00Z'},
    {id:'missing'}, {id:'invalid',returnedAt:'invalid'},
  ];
  assert.deepEqual(sortSessionTasks(tasks).map(t=>t.id),['shell','local','ledger','running-new','running-old','missing','invalid']);
  assert.equal(tasks[0].id,'running-old');
});

function receipt(name, value, args = {}, isError = false, id = name) {
  return [
    { type: 'tool/call', data: { name, callId: id, arguments: JSON.stringify(args) } },
    { type: 'tool/result', data: { message: { toolCallId: id, isError, content: [{ type: 'text', text: JSON.stringify(value) }] } } },
  ];
}
test('dispatch receipts include plan apply, project, direct runs and delegation; queries, proposals, errors and retries do not inflate count', () => {
  assert.deepEqual(dispatchedTaskIds([
    ...receipt('task_plan', {value:{task:{taskId:'proposed'}}}, {action:'propose'}),
    ...receipt('task_plan', {value:{task:{taskId:'planned'}}}, {action:'apply'}),
    ...receipt('task_dispatch',{value:{taskId:'new-dispatch'}}),
    ...receipt('task_query', {taskId:'unrelated'}),
    ...receipt('project_dispatch', {taskId:'project'}),
    ...receipt('project_dispatch', {taskId:'project'}, {}, false, 'replay'),
    ...receipt('task_run', {value:{taskId:'run'}}),
    ...receipt('task_delegate', {value:{task:{taskId:'child'},run:{taskId:'child'}}}),
    ...receipt('task_delegate', {taskId:'failed'}, {}, true),
    ...receipt('task_delegate', {taskId:'local-codex-example',localOnly:true}),
    {type:'tool/result',data:{message:{toolCallId:'unknown',content:[{type:'text',text:'{"taskId":"injected"}'}]}}},
  ]), ['planned','new-dispatch','project','run','child']);
});

test('index skips fork-inherited history, invalidates on changes, caches only IDs and always closes read handles', async () => {
  const index = new SessionDispatchIndex();
  let opens=0, closes=0, revision='one', fail=false;
  const persistence={identity:Symbol(),stat:async()=>({revision}),open:async(id,mode)=>{
    opens++; assert.equal(mode,'read'); return {inheritedEventCount:12, read:async offset=>{
      assert.equal(offset,12); if(fail)throw Error('read failed'); return {events:receipt('project_dispatch',{taskId:revision})};
    }, close:async()=>{closes++;}};
  }};
  assert.deepEqual(await index.read(persistence,'fork'),['one']);
  await index.read(persistence,'fork'); assert.equal(opens,1);
  revision='two'; assert.deepEqual(await index.read(persistence,'fork'),['two']);
  fail=true; revision='three'; await assert.rejects(index.read(persistence,'fork'),/read failed/);
  assert.equal(closes,3);
});

test('durable operations isolate sessions even when they share a project, retain pending ACKs and survive paused mode', async () => {
  const ledger=TaskLedger.open(':memory:');
  const agent=id=>({id,session:{header:{cwd:process.cwd()},requestHeader:()=>undefined},options:{provider:"fixture",model:"fixture"},ctx:{get:()=>undefined,tools:{schemas:()=>[]}}});
  const service=new SessionCollaboration(ledger,'local',async (_node,_id,input)=>{
    if(input.action==='activate')return {confirmed:true,projectId:'shared'};
    if(input.title==='pending')throw Error('offline');
    return {confirmed:true,taskId:input.title};
  });
  try {
    await service.activate(agent('one')); await service.activate(agent('two'));
    await service.invoke(agent('one'),'dispatch',{title:'mine'},'call','request');
    await service.invoke(agent('two'),'dispatch',{title:'other'},'call','request');
    await assert.rejects(service.invoke(agent('one'),'dispatch',{title:'pending'},'call','pending'));
    service.leave(agent('one'));
    assert.deepEqual(sessionDispatchOperations(ledger,'one'),{taskIds:['mine'],pending:1});
    assert.deepEqual(sessionDispatchOperations(ledger,'new'),{taskIds:[],pending:0});
  } finally {ledger.close();}
});

test('task-center categories are reused; descendants included once, siblings and private data excluded', () => {
  const view=sessionTaskSnapshot({
    tasks:[
      {id:'root',title:'Root',status:'review',project:'shared',secret:'never'},
      {id:'child',title:'Child',parentTaskId:'root',status:'running'},
      {id:'grandchild',parentTaskId:'child',status:'done'},
      {id:'sibling',project:'shared',status:'error'},
    ],
    runs:[{id:'r1',taskId:'root',state:'succeeded',reviewStatus:'pending_user',configuration:{apiKey:'secret'}},{id:'r2',taskId:'sibling'}],
    reports:[{taskId:'sibling',body:'unrelated private report'}],
  },['root','missing'],'session',1);
  assert.deepEqual(view.counts,{all:3,review:1,running:1,done:1});
  assert.equal(view.directCount,1); assert.equal(view.unavailableTasks,1); assert.equal(view.pendingDispatches,1);
  assert.deepEqual(view.runs.map(r=>r.id),['r1']);
  assert.doesNotMatch(JSON.stringify(view),/secret|sibling|configuration|unrelated/);
  assert.equal(view.tasks[1].direct,false);
});

test('empty and cyclic task graphs terminate without including unrelated tasks',()=>{
  assert.equal(sessionTaskSnapshot({tasks:[],runs:[]},[],'s').counts.all,0);
  const view=sessionTaskSnapshot({tasks:[{id:'a',parentTaskId:'b',status:'queued'},{id:'b',parentTaskId:'a',status:'queued'}],runs:[]},['a'],'s');
  assert.equal(view.counts.all,2);
});
