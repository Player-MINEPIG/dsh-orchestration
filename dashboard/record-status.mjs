/** Append an operator-authorized status report through the shared core import contract. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskLedger} from '../packages/task-system/dist/index.js';
const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const taskId=arg('--task'),reportId=arg('--report'),title=arg('--title'),bodyPath=arg('--body-file'),at=arg('--observed-at'),state=arg('--state'),kind=arg('--kind','progress');
const STATES=new Set(['inbox','ready','running','waiting','completed','failed','cancelled','archived']);
if(!taskId||!reportId||!title||!bodyPath||!at||!Number.isFinite(Date.parse(at)))throw new Error('Required: --task ID --report UNIQUE-ID --title TITLE --body-file PATH --observed-at ISO-TIMESTAMP [--state STATE] [--kind progress|result|review|observation] [--ledger PATH]');
if(state&&!STATES.has(state))throw new Error('Invalid task state');
if(!['progress','result','review','observation'].includes(kind))throw new Error('Invalid report kind');
const observedAt=new Date(at).toISOString(),body=await readFile(path.resolve(bodyPath),'utf8');
if(!body.trim())throw new Error('Report body must not be empty');
const here=path.dirname(fileURLToPath(import.meta.url)),ledger=TaskLedger.open(path.resolve(arg('--ledger',path.join(here,'../.runtime/tasks.sqlite'))));
try{
 const current=ledger.snapshot(),existing=current.tasks.find(t=>t.taskId===taskId);
 if(!existing)throw new Error('Task must already exist; this command never creates or merges tasks');
 if(existing.kind!=='observed')throw new Error('Managed tasks must use the Task Service execution/report APIs, not the observation bridge');
 const oldReport=current.reports.find(r=>r.reportId===reportId),eventId=`status:${reportId}`;
 if(oldReport){
   const event=current.events.find(e=>e.eventId===eventId);
   if(oldReport.taskId!==taskId||oldReport.title!==title||oldReport.body!==body||Date.parse(oldReport.createdAt)!==Date.parse(observedAt)||oldReport.kind!==kind||event?.detail?.requestedState!==(state??null))throw new Error('Report ID already exists with different content or status; use a new report ID');
   console.log(JSON.stringify({status:'already-recorded',taskId,reportId,observedAt:oldReport.createdAt}));
 }else{
   const now=new Date().toISOString(),latest=Date.parse(observedAt)>=Date.parse(existing.updatedAt);
   const task=latest?{...existing,...(state?{state}:{}),updatedAt:observedAt,source:{...existing.source,observedAt,importedAt:existing.source?.importedAt||existing.createdAt,label:arg('--source-label',existing.source?.label||current.source.label)}}:existing;
   const sourceAt=Date.parse(observedAt)>Date.parse(current.source.observedAt)?observedAt:current.source.observedAt;
   const source={...current.source,kind:'explicit-import',observedAt:sourceAt};
   const report={reportId,taskId,revision:1,title,body,createdAt:observedAt,recordedAt:now,artifactIds:[],kind};
   const event={eventId,taskId,type:title,at:observedAt,detail:{summary:body,requestedState:state??null}};
   const receipt=ledger.importSnapshot(`status:${reportId}`,{schemaVersion:'1',generatedAt:now,source,tasks:[task],runs:[],reports:[report],artifacts:[],templates:[],events:[event]});
   console.log(JSON.stringify({status:'recorded',taskId,reportId,acceptedAt:receipt.acceptedAt,taskProjectionUpdated:latest}));
 }
}finally{ledger.close();}
