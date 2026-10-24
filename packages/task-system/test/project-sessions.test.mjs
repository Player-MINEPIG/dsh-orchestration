import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {ProjectSessions} from '../dist/project-sessions.js';
import {TaskError,canonical} from '../dist/ledger.js';
import {ownerHarness,oldBinding} from './fixtures/project-session-owner.mjs';
async function fixture(){const dir=mkdtempSync(join(tmpdir(),'project-placement-')),h=await ownerHarness(dir);await h.native.create({sessionId:'legacy-1',cwd:dir});h.db.exec('CREATE TABLE current_reference(revision INTEGER NOT NULL,binding TEXT NOT NULL)');h.db.prepare('INSERT INTO current_reference VALUES(0,?)').run(canonical(oldBinding(dir)));const request={operationId:'move-1',projectId:'project-1',expectedRevision:0,old:oldBinding(dir),sessionId:'ordinary-new',selection:{nodeId:'owner',workspaceId:'registered-1',workspaceRevision:'catalog-1'},allowedNodeIds:null,executionBindings:{}};return {h,request,close:async()=>{await h.close();rmSync(dir,{recursive:true,force:true});}};}
function ports(h,override){return {owner:override??((_node,command)=>h.owner.handle(command)),checkCurrent(request){const row=h.db.prepare('SELECT * FROM current_reference').get();if(row.revision!==request.expectedRevision||canonical(JSON.parse(row.binding))!==canonical(request.old))throw new TaskError('CONFLICT','Settings changed');},commit(request,next){h.db.prepare('UPDATE current_reference SET revision=revision+1,binding=?').run(canonical(next));h.setDecision({outcome:'commit',operationId:request.operationId,projectId:request.projectId,old:request.old,next});}};}

test('receipt loss retries the original prepared session, commits one reference, and drains old-generation input in its origin',async()=>{
 const f=await fixture(),{h,request}=f;try{let lose=true;const service=new ProjectSessions({managementDatabase:()=>h.db},ports(h,async(_node,command)=>{const result=await h.owner.handle(command);if(command.kind==='prepare'&&lose){lose=false;throw new Error('Receipt lost');}if(command.kind==='freeze')h.ctx.agents.get('legacy-1').followup(createUserMessage({source:{kind:'fixture-origin'},content:[{type:'text',text:'Late original input'}]}));return result;}));
 await assert.rejects(service.move(request),/Receipt lost/);assert.equal(service.status('move-1').state,'preparing');assert.equal(h.db.prepare('SELECT revision FROM current_reference').get().revision,0);const completed=await service.move(request);assert.equal(completed.state,'complete');assert.equal(completed.decision.next.sessionId,'ordinary-new');assert.equal(h.db.prepare('SELECT revision FROM current_reference').get().revision,1);await h.ctx.agents.get('legacy-1').whenIdle();assert.equal(h.model.requests.length,1);assert.equal(h.ctx.agents.get('ordinary-new').session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.source.kind==='fixture-origin'),false);assert.equal(h.activations,1);assert.equal((await service.move(request)).state,'complete');await assert.rejects(service.move({...request,selection:{...request.selection,workspaceRevision:'changed'}}),e=>e.code==='CONFLICT');
 }finally{await f.close();}
});

test('lost activation receipt preserves the committed reference and reconciles without activating twice',async()=>{
 const f=await fixture(),{h,request}=f;try{let lose=true;const service=new ProjectSessions({managementDatabase:()=>h.db},ports(h,async(_node,command)=>{const result=await h.owner.handle(command);if(command.kind==='activate'&&lose){lose=false;throw new Error('Activation receipt lost');}return result;}));await assert.rejects(service.move(request),/Activation receipt lost/);assert.equal(service.status('move-1').state,'committed');assert.equal(h.db.prepare('SELECT revision FROM current_reference').get().revision,1);assert.equal((await service.move(request)).state,'complete');assert.equal(h.activations,1);
 }finally{await f.close();}
});

test('competing settings CAS aborts and releases both owners while retaining the old primary',async()=>{
 const f=await fixture(),{h,request}=f;try{let service;const options=ports(h,async(_node,command)=>{if(command.kind==='release')h.setDecision(service.decision('move-1'));const result=await h.owner.handle(command);if(command.kind==='freeze')h.db.exec('UPDATE current_reference SET revision=revision+1');return result;});service=new ProjectSessions({managementDatabase:()=>h.db},options);await assert.rejects(service.move(request),e=>e.code==='CONFLICT');assert.equal(service.status('move-1').state,'aborted');assert.equal(JSON.parse(h.db.prepare('SELECT binding FROM current_reference').get().binding).sessionId,'legacy-1');assert.equal(h.activations,0);assert.equal(h.owner.status('move-1','ordinary-new').kind,'released');assert.equal(h.owner.status('move-1','legacy-1').kind,'released');
 }finally{await f.close();}
});

test('BUSY aborts preparation, retains pending cleanup after receipt loss, and permits retrying cleanup',async()=>{
 const f=await fixture(),{h,request}=f;try{let service,lose=true;const options=ports(h,async(_node,command)=>{if(command.kind==='freeze')throw new TaskError('BUSY','Native driver active');if(command.kind==='release')h.setDecision(service.decision('move-1'));const result=await h.owner.handle(command);if(command.kind==='release'&&lose){lose=false;throw new Error('Cleanup receipt lost');}return result;});service=new ProjectSessions({managementDatabase:()=>h.db},options);await assert.rejects(service.move(request),/Cleanup receipt lost/);assert.equal(service.status('move-1').state,'aborting');assert.equal(service.outstanding().length,1);assert.equal(h.owner.status('move-1','ordinary-new').kind,'released');assert.equal((await service.move(request)).state,'aborted');assert.equal(service.outstanding().length,0);assert.equal(JSON.parse(h.db.prepare('SELECT binding FROM current_reference').get().binding).sessionId,'legacy-1');
 }finally{await f.close();}
});

test('continuation receipt cannot replace the prepared binding or contaminate abort cleanup',async()=>{
 const f=await fixture(),{h,request}=f;
 try{
  let service,firstPrepared,corruptBinding=true;const releases=[];
  const options=ports(h,async(_node,command)=>{
   if(command.kind==='release'){releases.push(command.binding);h.setDecision(service.decision(request.operationId));}
   const result=await h.owner.handle(command);
   if(command.kind!=='prepare')return result;
   if(!command.continuation){firstPrepared=result;return result;}
   return corruptBinding?{...result,binding:{...result.binding,projectId:'another-project',sessionId:'another-owner-session'}}:{...result,continuationDigest:'0'.repeat(64)};
  });
  options.continuation=async()=>({source:request.old,summary:'Frozen old conversation',sourceSeq:0,truncated:false,tasks:[]});
  service=new ProjectSessions({managementDatabase:()=>h.db},options);
  await assert.rejects(service.move(request),e=>e.code==='UNAVAILABLE');
  assert.equal(service.status(request.operationId).state,'preparing');
  assert.deepEqual(service.status(request.operationId).prepared,firstPrepared);
  assert.equal(h.db.prepare('SELECT revision FROM current_reference').get().revision,0);
  assert.equal(h.activations,0);assert.deepEqual(releases,[]);
  corruptBinding=false;
  await assert.rejects(service.move(request),e=>e.code==='FORBIDDEN');
  assert.equal(service.status(request.operationId).state,'aborted');
  assert.deepEqual(releases,[request.old,firstPrepared.binding]);
  assert.equal(h.owner.status(request.operationId,request.sessionId).kind,'released');
  assert.equal(h.owner.status(request.operationId,request.old.sessionId).kind,'released');
  assert.equal(JSON.parse(h.db.prepare('SELECT binding FROM current_reference').get().binding).sessionId,request.old.sessionId);
  assert.equal(h.activations,0);
 }finally{await f.close();}
});
