import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../dist/ledger.js';
import {validateRegistration,mappedId} from '../dist/project-registration/protocol.js';
import {enqueueRegistration,flushRegistrations} from '../dist/project-registration/client.js';
import {createRegistrationServer,bearerNamespaceAuthorizer} from '../dist/project-registration/http.js';
import {fixture} from './fixtures/registration.mjs';

const command=p=>mappedId(p.namespace,p.projectExternalId,'command',p.idempotencyKey);
const next=(p,mode='live')=>({...structuredClone(p),revision:p.revision+1,previousRevision:p.revision,idempotencyKey:'r'+(p.revision+1),mode,observedAt:'2026-10-11T00:01:00Z',project:{...p.project,state:mode==='live'?'active':'completed'}});
const fail=code=>e=>e.code===code;
test('atomic source revisions, replay, central authority, final sealing and observation-only imports',()=>{
 const l=TaskLedger.open(':memory:');try{
 const p=fixture(),a=l.registerProject(command(p),p,[p.namespace]),s=l.snapshot();assert.equal(s.projects.length,1);assert.equal(s.runs[0].observationOnly,true);assert.equal(s.outcomes[0].state,'draft');assert.equal(s.projectRegistrations[0].packet.project.createdAt,null);assert.equal(s.artifacts[0].finalized,false);
 assert.throws(()=>l.createRun('dispatch',{taskId:s.tasks[0].taskId}),fail('OBSERVE_ONLY'));
 assert.deepEqual(l.registerProject('other-command',p,[p.namespace]).value,a.value);
 assert.throws(()=>l.registerProject('bad-auth',p,['other']),fail('FORBIDDEN'));
 assert.throws(()=>l.registerProject('bad-revision',{...p,project:{...p.project,title:'changed'}},[p.namespace]),fail('CONFLICT'));
 assert.throws(()=>l.saveProject('edit-facts',{...s.projects[0],expectedRevision:s.projects[0].revision}),fail('FORBIDDEN'));
 l.manageProjectRegistration('note',{registrationId:a.value.registrationId,expectedRevision:0,note:'Await listening',review:'unreviewed',evidenceReportIds:[],revoked:false},'operator');
 l.saveOutcome('outcome-central',{...s.outcomes[0],feedback:'Central feedback',state:'needs_work',expectedRevision:s.outcomes[0].revision});
 assert.throws(()=>l.saveOutcome('outcome-source-edit',{...s.outcomes[0],title:'Central rename',expectedRevision:s.outcomes[0].revision+1}),fail('FORBIDDEN'));
 const p2=next(p),b=l.registerProject(command(p2),p2,[p.namespace]);assert.equal(l.snapshot().projectRegistrations[0].central.note,'Await listening');assert.equal(l.snapshot().outcomes[0].feedback,'Central feedback');assert.equal(l.snapshot().outcomes[0].state,'needs_work');
 const bad=next(p2);bad.reports[0].body='rewrite';assert.throws(()=>l.registerProject(command(bad),bad,[p.namespace]),fail('CONFLICT'));assert.equal(l.snapshot().projectRegistrations[0].sourceRevision,2);
 const p3=next(p2,'final');l.registerProject(command(p3),p3,[p.namespace]);assert.throws(()=>l.registerProject('after-final',next(p3),[p.namespace]),fail('CONFLICT'));assert.deepEqual(l.registerProject('old-replay',p,[p.namespace]).value,a.value);assert.equal(l.snapshot().projectRegistrations[0].sourceRevision,3);assert.equal(l.snapshot().tasks.length,1);
 }finally{l.close();}
});
test('history namespace isolation, unknown times, explicit withdrawal and validation reference checks',()=>{
 const l=TaskLedger.open(':memory:');try{const p=fixture();p.mode='history';p.project.state='completed';const a=l.registerProject(command(p),p,[p.namespace]);const other={...p,namespace:'different/harness'};l.registerProject(command(other),other,[other.namespace]);assert.equal(l.snapshot().projects.length,2);
 assert.throws(()=>validateRegistration({...p,tasks:[{...p.tasks[0],parentTaskId:'missing'}]}),fail('INVALID'));
 assert.throws(()=>validateRegistration({...p,execute:true}),fail('INVALID'));
 assert.throws(()=>l.withdrawProjectRegistration('wrong',{registrationId:a.value.registrationId,namespace:'different/harness',expectedRevision:1},['different/harness']),fail('FORBIDDEN'));
 l.withdrawProjectRegistration('withdraw',{registrationId:a.value.registrationId,namespace:p.namespace,expectedRevision:1},[p.namespace]);assert.equal(l.snapshot().projectRegistrations[0].central.withdrawn,true);assert.equal(l.snapshot().runs.length,2);
 }finally{l.close();}
});
test('durable offline outbox resumes over actual HTTP; conflicts retain packets; receipts survive restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'registration-')),db=join(dir,'ledger.sqlite'),out=join(dir,'outbox'),token='fixture-only-token-1234567890';let l=TaskLedger.open(db),server;
 try{const p=fixture();enqueueRegistration(out,p);await assert.rejects(flushRegistrations(out,'http://127.0.0.1:43499/v1/registrations',token));assert.equal(readdirSync(out).filter(x=>x.endsWith('.json')).length,1);
 server=createRegistrationServer({ledger:l,authorize:bearerNamespaceAuthorizer(token,[p.namespace])});await new Promise(r=>server.listen(43493,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${server.address().port}/v1/registrations`;
 const forbidden=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});assert.equal(forbidden.status,403);
 assert.equal((await flushRegistrations(out,endpoint,token)).sent.length,1);assert.equal(l.snapshot().projects.length,1);assert.equal((await flushRegistrations(out,endpoint,token)).sent.length,0);
 const p2=next(p);enqueueRegistration(out,p2);await flushRegistrations(out,endpoint,token);const p3=next(p2,'final');enqueueRegistration(out,p3);await flushRegistrations(out,endpoint,token);
 await new Promise(r=>server.close(r));server=undefined;l.close();l=TaskLedger.open(db);assert.equal(l.snapshot().projectRegistrations[0].sourceRevision,3);assert.deepEqual(l.registerProject('replay-after-restart',p,[p.namespace]).value.sourceRevision,1);
 }finally{if(server)await new Promise(r=>server.close(r));l.close();rmSync(dir,{recursive:true,force:true});}
});
test('all observed execution admission routes reject or ignore imports; source acceptance remains only a claim',()=>{
 const l=TaskLedger.open(':memory:');try{
 const p=fixture();p.runs[0].state='blocked';p.outcomes[0].acceptance='accepted';p.outcomes[0].acceptanceEvidenceUri='file:///fixture/user-approval.md';l.registerProject(command(p),p,[p.namespace]);const s=l.snapshot(),taskId=s.tasks[0].taskId,runId=s.runs[0].runId;
 assert.equal(s.outcomes[0].state,'draft');assert.equal(s.projectRegistrations[0].central.review,'unreviewed');assert.equal(s.projectRegistrations[0].packet.outcomes[0].acceptance,'accepted');
 assert.throws(()=>l.continueRun('continue',{taskId,runId}),fail('OBSERVE_ONLY'));
 assert.throws(()=>l.cancel('cancel',{taskId,runId}),fail('OBSERVE_ONLY'));
 assert.throws(()=>l.resolveUncertain('reconcile',{runId,outcome:'failed',reason:'historical'}),fail('OBSERVE_ONLY'));
 assert.throws(()=>l.createSchedule('schedule',{scheduleId:'schedule',taskId,enabled:true}),fail('OBSERVE_ONLY'));
 l.registerNode('node',{nodeId:'fixture-mac',roles:['executor'],capabilities:[],models:[],workspaceIds:[],enabled:true,lastSeenAt:new Date().toISOString()});
 assert.deepEqual(l.pendingRuns('fixture-mac'),[]);
 assert.throws(()=>l.claim('claim',{runId,nodeId:'fixture-mac',ttlMs:10000}),e=>['OBSERVE_ONLY','FORBIDDEN','CONFLICT'].includes(e.code));
 assert.throws(()=>l.updateTask('update-facts',{taskId,goal:'rewrite'}),fail('FORBIDDEN'));
 }finally{l.close();}
});
test('source run-parent ownership must agree with the task-parent relation; missing historical links stay absent',()=>{
 const p=fixture();p.tasks.push({...p.tasks[0],externalId:'child',parentTaskId:'t'});p.runs.push({...p.runs[0],externalId:'child-run',taskId:'child',parentRunId:'run'});assert.equal(validateRegistration(p).runs[1].parentRunId,'run');
 const bad=structuredClone(p);bad.tasks[1].parentTaskId=undefined;assert.throws(()=>validateRegistration(bad),fail('INVALID'));
 const unknown=structuredClone(p);delete unknown.runs[1].parentRunId;assert.equal(validateRegistration(unknown).runs[1].parentRunId,undefined);
});
