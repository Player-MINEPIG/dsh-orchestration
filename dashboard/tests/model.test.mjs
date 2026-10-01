import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSnapshot,taskIsStale,sourceIsStale,escapeHtml,safeUri,filteredTasks,taskRecords,taskStats,parseRoute,visibleRecords} from '../public/model.js';
const snapshot=()=>({schemaVersion:'1',generatedAt:'2026-10-01T20:00:00Z',source:{kind:'explicit-import',label:'Test fixture only',observedAt:'2026-10-01T19:00:00Z',staleAfterMs:900000},tasks:[{taskId:'task-a',title:'One objective',description:'',state:'running',kind:'observed',tags:['media'],createdAt:'2026-10-01T18:00:00Z',updatedAt:'2026-10-01T19:00:00Z'},{taskId:'task-b',title:'Done',description:'',state:'completed',tags:[],updatedAt:'2026-10-01T19:00:00Z'}],runs:[{runId:'run-a',taskId:'task-a',state:'running'}],reports:[{reportId:'report-a',taskId:'task-a',runId:'run-a',sessionId:'session-1',createdAt:'2026-10-01T18:00:00Z'},{reportId:'report-b',taskId:'task-a',sessionId:'session-2',createdAt:'2026-10-01T19:00:00Z'}],artifacts:[],templates:[],events:[]});
test('shared contract validation rejects incompatible and duplicate identities',()=>{assert.equal(validateSnapshot(snapshot()).schemaVersion,'1');assert.throws(()=>validateSnapshot({...snapshot(),schemaVersion:'2'}));const bad=snapshot();bad.tasks.push(bad.tasks[0]);assert.throws(()=>validateSnapshot(bad));});
test('a successful polling timestamp never refreshes old task evidence',()=>{const s=snapshot(),now=Date.parse('2026-10-01T20:00:00Z');assert.equal(taskIsStale(s.tasks[0],s,now),true);assert.equal(taskIsStale(s.tasks[1],s,now),false);assert.equal(sourceIsStale(s.source.observedAt,900000,now),true);});
test('same task retains reports across different sessions and known/unknown runs',()=>{const rec=taskRecords(snapshot(),'task-a');assert.equal(rec.reports.length,2);assert.equal(rec.reports[0].sessionId,'session-2');assert.equal(rec.runs.length,1);assert.equal(taskStats(snapshot()).reports,2);});
test('filtering is case insensitive, stable and includes tags',()=>{assert.deepEqual(filteredTasks(snapshot(),'active','MEDIA').map(x=>x.taskId),['task-a']);assert.equal(filteredTasks(snapshot(),'completed').length,1);assert.equal(filteredTasks(snapshot(),'attention').length,0);});
test('external content is escaped and script/file/data URIs are never links',()=>{assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');for(const uri of ['javascript:alert(1)','data:text/html,evil','file:///tmp/private','https://user:pass@example.com'])assert.equal(safeUri(uri),null);assert.equal(safeUri('https://example.com/result'),'https://example.com/result');});
test('deep links preserve task identity and reject malformed escapes',()=>{assert.deepEqual(parseRoute('#task/task%3Aa/reports'),{view:'task',taskId:'task:a',tab:'reports'});assert.deepEqual(parseRoute('#task/%ZZ'),{view:'not-found'});});

test('dismissed tasks default out of lists, search and counts while lifecycle/history remain intact',()=>{
 const s=snapshot();s.tasks[0].admissionState='dismissed';s.tasks[0].admissionRevision=2;
 const original=JSON.stringify(s);
 assert.deepEqual(filteredTasks(s).map(t=>t.taskId),['task-b']);
 assert.equal(filteredTasks(s,'all','One objective').length,0);
 const stats=taskStats(s);assert.equal(stats.total,1);assert.equal(stats.active,0);assert.equal(stats.completed,1);assert.equal(stats.dismissed,1);assert.equal(stats.reports,0);assert.equal(stats.runs,0);
 assert.equal(taskRecords(s,'task-a').reports.length,2);assert.equal(s.tasks[0].state,'running');assert.equal(JSON.stringify(s),original);
});
test('new reports never readmit dismissed tasks and opt-in preserves reports across sessions',()=>{
 const s=snapshot();s.tasks[0].admissionState='dismissed';
 s.reports.push({reportId:'report-late',taskId:'task-a',sessionId:'session-3',createdAt:'2026-10-01T20:00:00Z'});
 s.tasks[0].updatedAt='2026-10-01T20:00:00Z';
 assert.equal(filteredTasks(s,'all','objective').length,0);assert.equal(visibleRecords(s,'reports').length,0);
 assert.equal(filteredTasks(s,'active','media',{includeDismissed:true}).length,1);
 assert.equal(visibleRecords(s,'reports',{includeDismissed:true}).length,3);
 assert.equal(taskRecords(s,'task-a').reports[0].sessionId,'session-3');
 assert.equal(taskStats(s,{includeDismissed:true}).reports,3);assert.equal(taskStats(s,{includeDismissed:true}).total,2);
});
test('missing curation fields remain backward compatible and restoration reveals the same history',()=>{
 const s=snapshot();assert.equal(filteredTasks(s).length,2);
 s.tasks[0].admissionState='dismissed';assert.equal(filteredTasks(s).length,1);
 s.tasks[0].admissionState='admitted';s.tasks[0].admissionRevision=3;
 assert.equal(filteredTasks(s).length,2);assert.equal(taskStats(s).reports,2);assert.equal(s.reports[0].reportId,'report-a');
 s.schedules=[{scheduleId:'schedule-a',taskId:'task-a'}];s.tasks[0].admissionState='dismissed';
 assert.equal(visibleRecords(s,'schedules').length,0);assert.equal(visibleRecords(s,'schedules',{includeDismissed:true}).length,1);
});
