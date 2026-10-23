import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskLedger} from '../dist/index.js';
import {taskSessionTitleCandidates, taskSessionTitle} from '../dist/session-titles.js';
import {resolvedClaimContext} from '../dist/remote/context.js';

test('actual schedule slots supply local date, same-day ordinal, restart stability and no lifetime suffix',()=>{
 let now=Date.parse('2026-10-23T16:30:00Z');const ledger=TaskLedger.open(':memory:',{role:'planner',now:()=>now});
 try {
  const task=ledger.createTask('task',{title:'Agent 日报',kind:'scheduled'}).value;
  ledger.updateTemplate('template',{templateId:'daily',version:1,name:'Daily',description:'',defaults:{},inputSchema:{},resultContract:{}});
  ledger.createSchedule('schedule',{scheduleId:'daily',taskId:task.taskId,templateId:'daily',templateVersion:1,enabled:true,cron:'30 0 * * *',timeZone:'Asia/Shanghai',nextDueAt:new Date(now).toISOString(),overlap:'queue',input:{}});
  const first=ledger.fireSchedule('first',{scheduleId:'daily',occurrenceAt:new Date(now).toISOString()}).value;
  assert.equal(ledger.executionContext(first.runId).sessionTitle,'Agent 日报 · 10-24');
  const again=ledger.createRun('same-day',{taskId:task.taskId,configuration:ledger.getRun(first.runId).configuration}).value;
  assert.equal(ledger.executionContext(again.runId).sessionTitle,'Agent 日报 · 10-24 · 第2次');
  now+=86400000;
  const next=ledger.fireSchedule('next',{scheduleId:'daily',occurrenceAt:new Date(now).toISOString()}).value;
  assert.equal(ledger.executionContext(next.runId).sessionTitle,'Agent 日报 · 10-25');
  const schedule=ledger.getSchedule('daily');
  ledger.updateSchedule('new-timezone',{scheduleId:'daily',expectedRevision:schedule.revision,changes:{timeZone:'America/Los_Angeles'}});
  assert.equal(ledger.executionContext(first.runId).sessionTitle,'Agent 日报 · 10-24','recovery time and later runs do not rename the first occurrence');
  assert.equal(resolvedClaimContext({run:ledger.getRun(again.runId),executionContext:ledger.executionContext(again.runId)}).sessionTitle,'Agent 日报 · 10-24 · 第2次');
 }finally{ledger.close()}
});

test('titles retain short intent, truncate Unicode safely, and old claims omit unknown numbering',()=>{
 assert.equal(taskSessionTitle({title:'审查 PR #23：归档与清理',configuration:{}}),'审查 PR #23：归档与清理');
 assert.equal(taskSessionTitle({title:'Legacy 日报',configuration:{trigger:{scheduledFor:'2026-10-23T16:30:00Z'}}}),'Legacy 日报','unknown legacy timezone omits the date');
 const long=taskSessionTitle({title:'修复'.repeat(30),configuration:{}});
 assert.ok(Array.from(long).length<=30);assert.ok(Buffer.byteLength(long)<=80);assert.ok(!long.includes('\ufffd'));
 assert.deepEqual(resolvedClaimContext({run:{configuration:{},contextNotes:[]}}),{reports:[]});
 assert.throws(()=>resolvedClaimContext({run:{configuration:{}},executionContext:{reports:[],sessionTitle:''}}),/INVALID_SESSION_TITLE_CONTEXT/);
});

test('historical candidates require local execution ownership, excluding ordinary and dispatcher chat links',()=>{
 const snapshot={tasks:[{taskId:'task',title:'Original task'}],runs:[{runId:'run',taskId:'task',configuration:{},route:{nodeId:'worker'},sessionIds:['user-chat','coordinator-chat']}],attempts:[],schedules:[]};
 assert.deepEqual(taskSessionTitleCandidates({nodeId:'worker',snapshot}),[]);
 snapshot.attempts=[{attemptId:'a',taskId:'task',runId:'run',nodeId:'other',executionId:'e',sessionId:'foreign'},{attemptId:'b',taskId:'task',runId:'run',nodeId:'worker',sessionId:'unowned'},{attemptId:'c',taskId:'task',runId:'run',nodeId:'worker',executionId:'e',sessionId:'native'}];
 assert.deepEqual(taskSessionTitleCandidates({nodeId:'worker',snapshot}),[{taskId:'task',runId:'run',sessionId:'native',title:'Original task'}]);
});

test('two schedules on one Task use their own occurrence timezone and legacy changed zones omit uncertain dates',()=>{
 const now=Date.parse('2026-10-23T14:30:00Z');const ledger=TaskLedger.open(':memory:',{role:'planner',now:()=>now});
 try {
  const task=ledger.createTask('task',{title:'Shared daily task',kind:'scheduled'}).value;
  ledger.updateTemplate('template',{templateId:'daily',version:1,name:'Daily',description:'',defaults:{},inputSchema:{},resultContract:{}});
  for(const [scheduleId,timeZone] of [['utc','UTC'],['melbourne','Australia/Melbourne']])ledger.createSchedule('schedule-'+scheduleId,{scheduleId,taskId:task.taskId,templateId:'daily',templateVersion:1,enabled:true,cron:'30 * * * *',timeZone,nextDueAt:new Date(now).toISOString(),overlap:'queue',input:{}});
  const first=ledger.fireSchedule('utc',{scheduleId:'utc',occurrenceAt:new Date(now).toISOString()}).value;
  const second=ledger.fireSchedule('melbourne',{scheduleId:'melbourne',occurrenceAt:new Date(now).toISOString()}).value;
  assert.equal(ledger.executionContext(first.runId).sessionTitle,'Shared daily task · 10-23');
  assert.equal(ledger.executionContext(second.runId).sessionTitle,'Shared daily task · 10-24');
  ledger.managementDatabase().prepare("UPDATE entities SET data=json_remove(data,'$.configuration.trigger.timeZone') WHERE kind='run' AND id=?").run(second.runId);
  assert.equal(ledger.executionContext(second.runId).sessionTitle,'Shared daily task · 10-24','a legacy Run resolves its exact occurrence schedule');
  const schedule=ledger.getSchedule('melbourne');ledger.updateSchedule('changed-zone',{scheduleId:'melbourne',expectedRevision:schedule.revision,changes:{timeZone:'UTC'}});
  assert.equal(ledger.executionContext(second.runId).sessionTitle,'Shared daily task','a changed legacy zone has no reliable historical date');
  assert.equal(ledger.executionContext(first.runId).sessionTitle,'Shared daily task · 10-23','another schedule does not affect the pinned run');
 }finally{ledger.close()}
});
