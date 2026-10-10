#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {hostname} from 'node:os';
import {fixture} from '../../packages/task-system/test/fixtures/registration.mjs';
import {enqueueRegistration,flushRegistrations} from '../../packages/task-system/dist/project-registration/client.js';
const base=resolve('.runtime/registration'),endpoint=process.env.DSH_REGISTRATION_ENDPOINT??'http://127.0.0.1:43481/v1/registrations',token=process.env.DSH_REGISTRATION_TOKEN??readFileSync(0,'utf8').trim();
if(!token)throw new Error('Use isolated registration token via environment; no token is printed');
const runDir=join(base,'cross-host',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(runDir,{recursive:true});
const outbox=join(runDir,'outbox'),steps=[];
const receiptStep=(step,sent)=>{const receipts=sent.sent.map(x=>JSON.parse(readFileSync(x.receiptFile,'utf8')));steps.push({step,at:new Date().toISOString(),receipts});return receipts;};
const p=fixture();p.namespace='pmp-local/live-smoke';p.projectExternalId='mac-created-'+Date.now();p.origin={nodeId:'pmp-mac',harness:'harness-neutral CLI fixture (no model execution)',workspaceUri:'file://'+runDir};p.observedAt=new Date().toISOString();
const p2={...structuredClone(p),revision:2,previousRevision:1,idempotencyKey:'r2',observedAt:new Date().toISOString()};p2.tasks[0].state='completed';p2.runs[0].state='succeeded';p2.runs[0].outcome='success';
enqueueRegistration(outbox,p);
// A deliberately closed local port simulates loss of the SSH transport without mutating the tunnel.
try{await flushRegistrations(outbox,'http://127.0.0.1:43499/v1/registrations',token);throw new Error('Offline probe unexpectedly connected');}catch(error){if(error.message==='Offline probe unexpectedly connected')throw error;steps.push({step:'offline-enqueued',transportFailure:true,queuedFiles:readdirSync(outbox).filter(x=>x.endsWith('.json')).length});}
receiptStep('local-origin-register-to-vps',await flushRegistrations(outbox,endpoint,token));
enqueueRegistration(outbox,p2);receiptStep('local-origin-update-to-vps',await flushRegistrations(outbox,endpoint,token));
const p3={...structuredClone(p2),revision:3,previousRevision:2,idempotencyKey:'r3',mode:'final',observedAt:new Date().toISOString(),project:{...p.project,state:'completed',nextStep:'Await user acceptance'}};enqueueRegistration(outbox,p3);receiptStep('local-origin-final-to-vps',await flushRegistrations(outbox,endpoint,token));
enqueueRegistration(outbox,p);receiptStep('old-source-replay-to-vps',await flushRegistrations(outbox,endpoint,token));
const pv=JSON.parse(readFileSync(join(base,'pv/pv-registration.json'),'utf8'));enqueueRegistration(outbox,pv);receiptStep('real-pv-local-package-replay-to-vps',await flushRegistrations(outbox,endpoint,token));
const final=await fetch(endpoint,{headers:{authorization:'Bearer '+token}});if(!final.ok)throw new Error('Cannot query source-scoped registrations');const registrations=await final.json(),live=registrations.find(r=>r.projectExternalId===p.projectExternalId);if(live?.sourceRevision!==3||live.mode!=='final')throw new Error('Central state not sealed at revision 3');
const evidence={kind:'actual-MBP-to-VPS-HTTP-over-SSH-tunnel',source:{hostname:hostname(),nodeId:'pmp-mac',workspace:runDir,outbox},destination:{sshAlias:'aliyun-vps',nodeId:'test-central',isolatedRoot:'/root/dsh-orchestration-tests/project-registration-20261011',endpoint},projectExternalId:p.projectExternalId,modelInvocations:0,steps,registrations};writeFileSync(join(runDir,'evidence.json'),JSON.stringify(evidence,null,2));writeFileSync(join(base,'cross-host-latest.txt'),runDir);console.log(JSON.stringify({ok:true,evidence:join(runDir,'evidence.json'),sourceNode:'pmp-mac',destinationNode:'test-central',projectExternalId:p.projectExternalId,registrationId:live.registrationId,sourceRevision:live.sourceRevision,steps:steps.map(s=>s.step)},null,2));
