import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {startHost} from '../ci/browser-native-project.mjs';
const input=(commandId,text,target,extra={})=>({conversationId:'main',commandId,text,target,...extra});
const scope=project=>({kind:'project',projectId:project.projectId});
const diagnostics=new WeakMap();
function watch(h){const record={host:h,errors:[],ends:[],failed:false};diagnostics.set(h.ctx.taskSystem.steward,record);const push=h.model.script.push.bind(h.model.script);h.model.script.push=(...entries)=>push(...entries.map(entry=>typeof entry==='function'?async options=>{try{return await entry(options)}catch(error){record.errors.push(String(error.stack??error));throw error}}:entry));h.ctx.on('session/event',(session,event)=>{if(event.type==='turn/end')record.ends.push({sessionId:String(session.id),reason:event.data.reason})});}
async function close(h){const record=diagnostics.get(h.ctx.taskSystem.steward);if(record?.failed&&process.env.DSH_KEEP_CORRECTION_FIXTURE==='1')await h.ctx.fiber.dispose();else await h.close();}

async function until(service,commandId,predicate){for(let n=0;n<500;n++){const snapshot=await service.reconcile({conversationId:'main',commandId});if(snapshot.commandMessage&&predicate(snapshot.commandMessage))return snapshot.commandMessage;await new Promise(r=>setTimeout(r,10));}const record=diagnostics.get(service);if(record){record.failed=true;const h=record.host;writeFileSync('.runtime/correction-diagnostic.json',JSON.stringify({fixtureDirectory:h.directory,commandId,message:service.store.commandMessage('main',commandId),turns:h.ctx.taskSystem.ledger.managementDatabase().prepare('SELECT command,owner,session,state,native_admission,error FROM pr_turns').all(),scriptErrors:record.errors,turnEnds:record.ends,lastRequests:h.model.requests.slice(-2).map(options=>({model:options.model,system:options.system,messages:options.messages,tools:options.tools?.map(tool=>tool.name)}))},null,2));}throw Error(`Correction fixture did not settle: ${commandId}`);}
const completed=(service,id)=>until(service,id,message=>message.state.kind==='completed');
async function upload(service,data){const first=await service.upload({kind:'start',conversationId:'main',commandId:'correction-upload',bytes:data.length,name:'correction-proof.txt'});await service.upload({kind:'part',conversationId:'main',uploadId:first.uploadId,index:0,data:data.toString('base64')});await service.upload({kind:'finish',conversationId:'main',uploadId:first.uploadId});return first.uploadId;}
const stable=(prefix,id)=>prefix+createHash('sha256').update(id).digest('hex').slice(0,32);

test('a queued not-started correction withdraws the old input and submits complete text, attachment and frozen choices once to the actual new PM',{timeout:40000},async()=>{
 const h=await startHost();watch(h);let release;try{
  const s=h.ctx.taskSystem.steward,a=h.created,b=await h.runtime.create({commandId:'correction-target',title:'Correction destination',goal:'Authorized target only'});
  let begun;const entered=new Promise(resolve=>begun=resolve);h.model.script.push(async()=>{begun();await new Promise(resolve=>release=resolve);return 'Held source finished';});
  await s.send(input('correction-hold','SOURCE_BUSY_ONLY',scope(a)));await entered;
  const bytes=Buffer.from('CORRECTION_ATTACHMENT_EXACT'),uploadId=await upload(s,bytes);
  const originalRequest=input('correction-queued','UNSTARTED_FULL_ORIGINAL: please inspect this attached evidence.',scope(a),{uploads:[uploadId],selection:{provider:'test-offline',model:'script'},permissionPreset:'read-only'});
  // Seed only trusted delivery metadata, as a prior router clarification/refinement would.
  // Human answers narrow execution; automatic old-source evidence grants no new receiver access.
  const held=s.store.commandMessage('main','correction-hold');
  const seed=text=>s.store.project({conversationId:'main',role:'assistant',text,commandId:null,scope:scope(a),source:held.source,replyTo:null,createdAt:new Date().toISOString(),nativeSeq:null,state:{kind:'completed'},manifest:held.manifest},'correction-frozen-evidence-'+text);
  const donor=seed('DONOR_PRIVATE_AUTO_REFINE');seed('PRIVATE_UNSHARED_SOURCE_HISTORY');
  const routingClarification={questionId:'synthetic-scope-question',question:'QUESTION_PRIVATE_FROM_OLD_SOURCE：做 X 是指调研还是实施？',answers:[{commandId:'synthetic-narrow-answer',text:'只调研，不要实现；尚未授权执行或部署。'}]};
  const contextEvidence=[{topic:{conversationId:'main',scope:scope(a)},originals:[{source:{kind:'message',id:donor.id,revision:donor.revision,seq:donor.seq,scope:donor.scope,binding:donor.source},role:donor.role,text:donor.text}]}];
  const accept=s.store.accept.bind(s.store);let accepted;
  s.store.accept=(request,actualScope,binding,afterSeq,quote,delivery,bindUploads)=>accept(request,actualScope,binding,afterSeq,quote,request.commandId===originalRequest.commandId?{...delivery,routingClarification,contextEvidence}:delivery,bindUploads);
  try{accepted=await s.send(originalRequest);}finally{s.store.accept=accept;}
  const queued=accepted.commandMessage??s.store.commandMessage('main',originalRequest.commandId);
  assert.deepEqual(queued.routingClarification,routingClarification);assert.deepEqual(queued.contextEvidence,contextEvidence);
  const options=await s.correctionOptions({conversationId:'main',messageId:queued.id});assert.equal(options.canRetarget,true);
  const correction={commandId:'correct-unstarted-once',conversationId:'main',messageId:queued.id,expectedRevision:options.message.revision,target:scope(b)};
  await assert.rejects(s.correct({...correction,commandId:'correct-stale',expectedRevision:999}),{code:'CONFLICT'});
  h.model.script.push(options=>{assert.match(JSON.stringify(options.messages),/UNSTARTED_FULL_ORIGINAL/);assert.doesNotMatch(JSON.stringify(options.messages),/SOURCE_BUSY_ONLY/);assert.equal(options.model,'script');assert.match(JSON.stringify(options.messages),/只调研，不要实现/);assert.match(JSON.stringify(options.messages),/尚未授权执行或部署/);assert.doesNotMatch(JSON.stringify(options.messages),/DONOR_PRIVATE_AUTO_REFINE|QUESTION_PRIVATE_FROM_OLD_SOURCE|PRIVATE_UNSHARED_SOURCE_HISTORY/);assert.match(JSON.stringify(options.messages),/未随改派授权/);assert.match(JSON.stringify(options.messages),/核对或询问/);return 'Correct destination received the original once';});
  const concurrent=await Promise.all([s.correct(correction),s.correct(correction)]);assert.deepEqual(concurrent[0],concurrent[1]);const result=concurrent[0];assert.equal(result.kind,'retargeted');assert.equal(result.originalMessageId,queued.id);
  const registered=s.store.commandMessage('main',stable('corrected-',correction.commandId));assert.deepEqual(registered.routingClarification.answers,queued.routingClarification.answers,'Retargeting preserves the human narrowing answer');assert.equal(registered.routingClarification.questionId,queued.routingClarification.questionId);assert.doesNotMatch(registered.routingClarification.question,/QUESTION_PRIVATE_FROM_OLD_SOURCE/);assert.deepEqual(registered.contextEvidence??[],[],'Automatic evidence for the old receiver is not a grant to the new receiver');assert.equal(registered.sourceContextWithheld,true);assert.doesNotMatch(JSON.stringify(registered),/DONOR_PRIVATE_AUTO_REFINE|QUESTION_PRIVATE_FROM_OLD_SOURCE/);
  const corrected=await completed(s,stable('corrected-',correction.commandId));assert.equal(result.messageId,corrected.id);assert.deepEqual(corrected.scope,scope(b));assert.equal(corrected.text,queued.text);
  assert.deepEqual(corrected.selection,queued.selection);assert.equal(corrected.permission.preset,queued.permission.preset);assert.deepEqual(corrected.content.filter(part=>part.type!=='text'),queued.content.filter(part=>part.type!=='text'));
  const file=corrected.content.find(part=>part.type==='file');const filePath=h.ctx.fs.processPathFromHostPath(h.ctx.attachments.fileHostPath(file.attachment));assert.equal(s.canReadAttachmentFile(corrected.source.sessionId,{file_path:filePath}),true,'Corrected destination can use the actual admitted attachment read guard');const read=await s.attachmentRead({conversationId:'main',messageId:corrected.id,attachmentId:file.attachment.attachmentId});assert.equal(Buffer.from(read.data,'base64').toString(),bytes.toString());
  const requests=h.model.requests.length;const replay=await s.correct(correction);assert.equal(replay.messageId,result.messageId);assert.equal(h.model.requests.length,requests);
  release();release=undefined;await completed(s,'correction-hold');
  assert.equal(h.model.requests.length,2,'Only the held turn and corrected destination ran, never the withdrawn source input');
  assert.equal(h.model.requests.filter(request=>JSON.stringify(request.messages).includes('UNSTARTED_FULL_ORIGINAL')).length,1);
  assert.equal(s.store.message(queued.id).text,queued.text);assert.deepEqual(s.store.message(queued.id).source,queued.source);assert.notEqual(s.store.message(queued.id).state.kind,'completed');
  assert.equal(h.ctx.taskSystem.ledger.snapshot().tasks.length,0);assert.equal(h.ctx.taskSystem.ledger.snapshot().runs.length,0);
 }finally{release?.();await close(h);}
});

test('completed correction preserves history and effects; only a separate explicit excerpt handoff opens a read-only review without replay',{timeout:40000},async()=>{
 const h=await startHost();watch(h);try{
  const s=h.ctx.taskSystem.steward,a=h.created,b=await h.runtime.create({commandId:'completed-target',title:'Review destination',goal:'Review only explicitly shared evidence'}),bytes=Buffer.from('DO_NOT_IMPLICITLY_SHARE_FILE');
  const uploadId=await upload(s,bytes);h.model.script.push(options=>{assert.ok(options.tools.some(tool=>tool.name==='task_dispatch'),'Ordinary PM normally has the dispatcher tool');return 'Completed result remains historical';});
  await s.send(input('completed-original','ORIGINAL_DO_NOT_REEXECUTE_FULL_TASK SHARE_EXACT PRIVATE_UNSHARED_REMAINDER',scope(a),{uploads:[uploadId]}));const original=await completed(s,'completed-original');
  const before=JSON.stringify(s.store.message(original.id)),calls=h.model.requests.length;
  const options=await s.correctionOptions({conversationId:'main',messageId:original.id});assert.equal(options.canRetarget,false);
  const command={commandId:'correct-completed',conversationId:'main',messageId:original.id,expectedRevision:options.message.revision,target:scope(b)};
  const result=await s.correct(command);assert.equal(result.kind,'review-required');assert.equal(h.model.requests.length,calls);assert.equal(JSON.stringify(s.store.message(original.id)),before);
  assert.equal((await s.correct(command)).correctionId,result.correctionId);assert.equal(h.model.requests.length,calls);
  let dispatchResult;
  h.ctx.on('tools/result',(exec,value)=>{if(exec.name==='task_dispatch')dispatchResult=value;});
  h.model.script.push(options=>{const text=JSON.stringify(options.messages);assert.match(text,/SHARE_EXACT/);assert.match(text,/Please review only this fragment/);assert.doesNotMatch(text,/ORIGINAL_DO_NOT_REEXECUTE_FULL_TASK|PRIVATE_UNSHARED_REMAINDER|correction-proof.txt/);return{name:'task_dispatch',args:{commandId:'must-not-dispatch-review',title:'UNAUTHORIZED_REVIEW_TASK',description:'This review must not dispatch work'}};},()=>{assert.equal(dispatchResult?.isError,true,'A normally available dispatcher is denied in this review turn');assert.match(JSON.stringify(dispatchResult),/read.only|只读/i);return 'Only the selected fragment was reviewed; no original task was rerun.';});
  const handoff={commandId:'review-explicit-fragment',conversationId:'main',correctionId:result.correctionId,sourceMessageId:original.id,expectedSourceRevision:original.revision,excerpt:'SHARE_EXACT',text:'Please review only this fragment and report what can be verified.'};
  const sent=await s.correctionHandoff(handoff);const review=await completed(s,stable('handoff-',handoff.commandId));assert.equal(sent.commandMessage.id,review.id);assert.deepEqual(review.scope,scope(b));assert.equal(review.quote.excerpt,'SHARE_EXACT');assert.equal(review.workPlan.mode,'handoff-review');assert.equal(review.content?.some(part=>part.type==='file')??false,false);
  const afterCalls=h.model.requests.length;await s.correctionHandoff(handoff);assert.equal(h.model.requests.length,afterCalls);assert.equal(JSON.stringify(s.store.message(original.id)),before);
  assert.equal(h.ctx.taskSystem.ledger.snapshot().tasks.length,0);assert.equal(h.ctx.taskSystem.ledger.snapshot().runs.length,0);
 }finally{await close(h);}
});

test('an actual uncertain native turn is never retargeted or replayed by correction, including duplicate requests',{timeout:30000},async()=>{
 const h=await startHost();watch(h);try{
  const s=h.ctx.taskSystem.steward,b=await h.runtime.create({commandId:'uncertain-target',title:'Unknown result review',goal:'Preserve uncertain work'});
  h.model.script.push(()=>{throw Error('SYNTHETIC_NATIVE_INTERRUPTION');});await s.send(input('uncertain-original','UNKNOWN_ORIGINAL_MUST_NOT_REPEAT',scope(h.created)));
  const original=await until(s,'uncertain-original',message=>message.state.kind==='needs-reconciliation');const before=JSON.stringify(original),calls=h.model.requests.length;
  const options=await s.correctionOptions({conversationId:'main',messageId:original.id});assert.equal(options.canRetarget,false);
  const command={commandId:'correct-unknown',conversationId:'main',messageId:original.id,expectedRevision:options.message.revision,target:scope(b)};
  const result=await s.correct(command);assert.equal(result.kind,'review-required');assert.equal((await s.correct(command)).correctionId,result.correctionId);assert.equal(h.model.requests.length,calls);assert.equal(JSON.stringify(s.store.message(original.id)),before);
  assert.equal(h.ctx.taskSystem.ledger.snapshot().runs.length,0);
 }finally{await close(h);}
});
