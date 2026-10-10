#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fixture} from '../../packages/task-system/test/fixtures/registration.mjs';
import {TaskLedger} from '../../packages/task-system/dist/ledger.js';
import {createRegistrationServer,bearerNamespaceAuthorizer} from '../../packages/task-system/dist/project-registration/http.js';
import {enqueueRegistration,flushRegistrations} from '../../packages/task-system/dist/project-registration/client.js';
import {validateRegistration,mappedId} from '../../packages/task-system/dist/project-registration/protocol.js';
const base=resolve(process.argv[2]??'');
if(base!=='/root/dsh-orchestration-tests/project-registration-20261011'&&!base.includes('/.runtime/registration/'))throw new Error('Explicit isolated run directory required');
const runDir=join(base,'runs',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(runDir,{recursive:true});
const evidence=[],record=(step,data)=>evidence.push({step,at:new Date().toISOString(),...data});
const ledger=TaskLedger.open(join(runDir,'central.sqlite'),{role:'planner',nodeId:'test-central'}),token='local-fixture-smoke-token-1234567890',server=createRegistrationServer({ledger,authorize:bearerNamespaceAuthorizer(token,['fixture/local','pmp-local/pv'])});
await new Promise((ok,bad)=>{server.once('error',bad);server.listen(43383,'127.0.0.1',ok);});
const endpoint='http://127.0.0.1:43383/v1/registrations',outbox=join(runDir,'outbox');
try{
 const p=fixture();p.observedAt=new Date().toISOString();enqueueRegistration(outbox,p);
 const forbidden=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});if(forbidden.status!==403)throw new Error('Auth test failed');record('unauthorized',{httpStatus:forbidden.status});
 await flushRegistrations(outbox,endpoint,token);record('register-live',{revision:ledger.snapshot().projectRegistrations[0].sourceRevision});
 const reg1=ledger.snapshot().projectRegistrations[0];ledger.manageProjectRegistration('central-note',{registrationId:reg1.registrationId,expectedRevision:0,note:'真实中央标注：待用户试听',review:'needs_work',evidenceReportIds:ledger.snapshot().reports.map(r=>r.reportId),revoked:false},'isolated-test-operator');
 ledger.saveOutcome('central-feedback',{...ledger.snapshot().outcomes[0],feedback:'中央反馈应保留',state:'needs_work',expectedRevision:ledger.snapshot().outcomes[0].revision});
 const update={...structuredClone(p),revision:2,previousRevision:1,idempotencyKey:'r2',observedAt:new Date().toISOString()};update.tasks[0].state='completed';update.runs[0].state='succeeded';update.runs[0].outcome='success';enqueueRegistration(outbox,update);await flushRegistrations(outbox,endpoint,token);if(ledger.snapshot().projectRegistrations[0].central.note!=='真实中央标注：待用户试听'||ledger.snapshot().outcomes[0].feedback!=='中央反馈应保留')throw new Error('Central fields overwritten');record('update-live',{centralNotePreserved:true,centralFeedbackPreserved:true,centralReview:ledger.snapshot().projectRegistrations[0].central.review,revision:2,runState:ledger.snapshot().runs[0].state,observationOnly:ledger.snapshot().runs[0].observationOnly});
 const final={...structuredClone(update),revision:3,previousRevision:2,idempotencyKey:'r3',mode:'final',observedAt:new Date().toISOString(),project:{...update.project,state:'completed',nextStep:'Await user acceptance'}};enqueueRegistration(outbox,final);await flushRegistrations(outbox,endpoint,token);record('final',{revision:3,acceptance:ledger.snapshot().outcomes[0].state});
 const replay=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(p)});const receipt=await replay.json();if(replay.status!==200||receipt.value.sourceRevision!==1||ledger.snapshot().projectRegistrations[0].sourceRevision!==3)throw new Error('Replay changed terminal state');record('replay',{httpStatus:200,receiptRevision:1,currentRevision:3});
 const conflict={...final,revision:4,previousRevision:3,idempotencyKey:'r4',mode:'live'};const reject=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(conflict)});if(reject.status!==409)throw new Error('Final seal not enforced');record('sealed',{httpStatus:409});
 const pv=validateRegistration(JSON.parse(readFileSync(join(base,'pv','pv-registration.json'),'utf8')));enqueueRegistration(outbox,pv);await flushRegistrations(outbox,endpoint,token);
 const reg=ledger.snapshot().projectRegistrations.find(r=>r.namespace===pv.namespace);record('pv-history',{registrationId:reg.registrationId,tasks:pv.tasks.length,runs:pv.runs.length,reports:pv.reports.length,artifactReferences:pv.artifacts.length,largeMediaCopied:0,unknownOriginalTime:pv.project.createdAt===null,sourceAcceptance:pv.outcomes.map(o=>({title:o.title,state:o.acceptance}))});
 const pvReplay=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(pv)});if(pvReplay.status!==200)throw new Error('PV replay failed');record('pv-replay',{httpStatus:200,projectCount:ledger.snapshot().projects.length});
 for(const run of ledger.snapshot().runs)if(!run.observationOnly)throw new Error('Dispatchable imported run');
 writeFileSync(join(runDir,'snapshot.json'),JSON.stringify(ledger.snapshot(),null,2));writeFileSync(join(runDir,'http-evidence.json'),JSON.stringify({kind:'actual-http-on-vps-with-fixture-live-and-real-pv-history',modelInvocations:0,evidence},null,2));
 record('assertions',{allImportedRunsObservationOnly:true,projectCount:ledger.snapshot().projects.length,acknowledged:readdirSync(outbox).filter(x=>x.endsWith('.ack')).length});
 console.log(JSON.stringify({ok:true,runDir,evidence},null,2));
}finally{await new Promise(r=>server.close(r));ledger.close();}
