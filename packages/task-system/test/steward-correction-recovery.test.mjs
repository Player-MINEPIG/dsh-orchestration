import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {StewardConversations} from '../dist/steward-conversations.js';
import {StewardCorrections} from '../dist/steward-corrections.js';
import {TaskError} from '../dist/ledger.js';
const stable=id=>'corrected-'+createHash('sha256').update(id).digest('hex').slice(0,32);
function fixture(){
 const db=new DatabaseSync(':memory:'),ledger={managementDatabase:()=>db},store=new StewardConversations(ledger);
 const scopes={A:{kind:'workbench',topicId:'A'},B:{kind:'workbench',topicId:'B'}};
 const bindings=Object.fromEntries(['A','B'].map(id=>[id,{kind:'workbench',topicId:id,nodeId:'local',sessionId:id,generation:1,cwd:`/fixture/${id}`} ]));
 for(const binding of Object.values(bindings))store.registerSource('main',binding);
 const original=store.accept({conversationId:'main',commandId:'original',text:'FULL_ORIGINAL_PRIVATE_INPUT',target:scopes.A},scopes.A,bindings.A,0,null,{admission:'not-started',selection:{provider:'test-offline',model:'script'}});
 let failures=1,calls=0,accepted=0,denied=false,lostAck=false;
 const host={async authorize(){if(denied)throw new TaskError('FORBIDDEN','revoked');},
  proof(message){return{canRetarget:message.state.kind==='accepted'&&message.admission==='not-started',reason:'Only actual unstarted material'};},
  async target(request){if(request.recipient?.token==='stale')throw new TaskError('CONFLICT','stale recipient');return{target:request.target,recipient:request.recipient??{id:'seat-B',token:'fresh'}};},
  async submit(request,material){calls++;assert.equal(material.text,original.text);assert.deepEqual(material.selection,original.selection);if(failures-->0)throw new TaskError('CONFLICT','generation changed after withdrawal');
   const target=bindings.B;store.accept(request,request.target,target,0,null,{admission:'not-started',selection:material.selection,content:material.content});accepted++;
   if(lostAck)throw new TaskError('UNAVAILABLE','ack lost');return{};}};
 const service=new StewardCorrections(ledger,store,host),command={commandId:'correction-op',conversationId:'main',messageId:original.id,expectedRevision:original.revision,target:scopes.B};
 const resume=(pending,commandId='resume-control')=>({...command,commandId,expectedRevision:store.message(original.id).revision,resumeCorrectionId:pending.correctionId,expectedCorrectionRevision:pending.revision,recipient:{id:'seat-B',token:'fresh'}});
 return{db,store,service,command,original,resume,host,scopes,counts:()=>({calls,accepted}),setDenied:v=>denied=v,setLostAck:v=>lostAck=v,setFailures:v=>failures=v,close:()=>db.close()};
}
test('preaccept receiver failure is explicitly resumable once, preserving frozen material and original stable command',async()=>{
 const f=fixture();try{
  const originalInput=JSON.stringify(f.command),pending=await f.service.correct(f.command);assert.equal(pending.needsRecipient,true);assert.equal(pending.revision,1);assert.equal(f.store.message(f.original.id).state.kind,'released');
  const options=await f.service.options({conversationId:'main',messageId:f.original.id});assert.equal(options.pending,false);assert.equal(options.canRetarget,false);assert.equal(options.correction.correctionId,pending.correctionId);
  assert.deepEqual(await f.service.correct(f.command),pending);assert.equal(f.counts().calls,1,'Original duplicate does not blindly retry stale receiver');
  const request=f.resume(pending);const [a,b]=await Promise.all([f.service.correct(request),f.service.correct(request)]);assert.deepEqual(a,b);assert.equal(a.needsRecipient,false);assert.equal(a.revision,2);
  assert.equal(f.store.commandMessage('main',stable(pending.correctionId)).id,a.messageId);assert.equal(f.store.commandMessage('main',stable(request.commandId)),null);assert.deepEqual(f.counts(),{calls:2,accepted:1});
  assert.deepEqual(await f.service.correct(request),a);assert.deepEqual(f.counts(),{calls:2,accepted:1});
  await assert.rejects(f.service.correct({...request,recipient:{id:'other',token:'fresh'}}),{code:'CONFLICT'});
  await assert.rejects(f.service.correct({...request,commandId:'second-control'}),{code:'CONFLICT'});
  const stored=JSON.parse(f.db.prepare('SELECT input FROM steward_corrections WHERE command=?').get(pending.correctionId).input);assert.deepEqual(stored,JSON.parse(originalInput));
  assert.equal(f.db.prepare('SELECT count(*) n FROM steward_messages').get().n,2);
 }finally{f.close();}});
test('stale correction CAS, stale seat and revoked authority cannot resume or change the withdrawn payload',async()=>{
 const f=fixture();try{const pending=await f.service.correct(f.command),request=f.resume(pending);
  await assert.rejects(f.service.correct({...request,expectedCorrectionRevision:0}),{code:'CONFLICT'});
  await assert.rejects(f.service.correct({...request,recipient:{id:'seat-B',token:'stale'}}),{code:'CONFLICT'});
  f.setDenied(true);await assert.rejects(f.service.correct(request),{code:'FORBIDDEN'});f.setDenied(false);
  const current=f.store.message(f.original.id);f.db.prepare('UPDATE steward_messages SET data=? WHERE id=?').run(JSON.stringify({...current,text:'CHANGED_ORIGINAL'}),current.id);
  await assert.rejects(f.service.correct(request),{code:'CONFLICT'});assert.deepEqual(f.counts(),{calls:1,accepted:0});
 }finally{f.close();}});
test('lost acknowledgement after canonical acceptance is reconciled and never authorizes receiver reselection',async()=>{
 const f=fixture();try{f.setFailures(0);f.setLostAck(true);const result=await f.service.correct(f.command);assert.equal(result.needsRecipient,false);assert.ok(result.messageId);assert.deepEqual(f.counts(),{calls:1,accepted:1});
  await assert.rejects(f.service.correct(f.resume(result)),{code:'CONFLICT'});assert.deepEqual(await f.service.correct(f.command),result);assert.deepEqual(f.counts(),{calls:1,accepted:1});
 }finally{f.close();}});
test('failed reselection requires a fresh explicit control and keeps every control receipt immutable',async()=>{
 const f=fixture();try{const pending=await f.service.correct(f.command);f.setFailures(1);const first=f.resume(pending);const failed=await f.service.correct(first);assert.equal(failed.needsRecipient,true);assert.equal(failed.revision,3);
  assert.deepEqual(await f.service.correct(first),failed);assert.equal(f.counts().calls,2);await assert.rejects(f.service.correct({...first,commandId:'stale-cas'}),{code:'CONFLICT'});
  const done=await f.service.correct(f.resume(failed,'new-control'));assert.ok(done.messageId);assert.equal(f.counts().accepted,1);assert.deepEqual(await f.service.correct(first),failed);
 }finally{f.close();}});
