import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {StewardConversations} from '../dist/steward-conversations.js';
import {StewardRecall} from '../dist/steward-recall.js';
import {StewardEvidence,refineTopicEvidence,workerRead,ordinaryTaskRead} from '../dist/steward-evidence.js';
import {StewardContinuity} from '../dist/steward-continuity.js';
import {TaskError} from '../dist/ledger.js';

const hash=text=>createHash('sha256').update(text).digest('hex');
const source=message=>({kind:'message',id:message.id,revision:message.revision,seq:message.seq,scope:message.scope,binding:message.source});
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT)');
 const ledger={managementDatabase:()=>db},store=new StewardConversations(ledger);
 const bindings=new Map(['A','B'].map(id=>[id,{kind:'workbench',topicId:id,nodeId:'local',sessionId:id,generation:1,cwd:`/work/${id}`} ]));
 const scope=id=>{const binding=bindings.get(id);return binding?.projectId?{kind:'project',projectId:binding.projectId}:{kind:'workbench',topicId:binding?.topicId??id};};
 for(const binding of bindings.values())store.registerSource('main',binding);
 let serial=0,decisions=[],complete=true,freshness='current',facts=null,ownedTask=null,denied=false;
 function add(text,id='A',extra={}){return store.project({conversationId:'main',role:'user',text,scope:scope(id),source:bindings.get(id),commandId:null,
  replyTo:null,createdAt:new Date(2000000000000+serial).toISOString(),nativeSeq:null,state:{kind:'completed'},
  manifest:{persona:{id:'dsh-steward',version:'1'},scope:scope(id),history:'scope-native-session',evidence:'selection-only',resources:[]},...extra},`entry-${++serial}`);}
 const host={bindingForSession(sessionId){const binding=bindings.get(sessionId);return binding?{conversationId:'main',scope:scope(sessionId),binding}:null;},
  async context({topic,binding}){const actual=binding??[...bindings.values()].find(b=>JSON.stringify(scope(b.sessionId))===JSON.stringify(topic.scope));const originals=store.messages('main').filter(m=>m.source.sessionId===actual.sessionId).map(m=>({source:source(m),role:m.role,text:m.text}));
   return {card:{topic,binding:actual,version:'card-v1',title:topic.scope.topicId,summary:'Current sourced notes',facts:decisions,coverageSeq:originals.at(-1)?.source.seq??0,
    observedThroughSeq:originals.at(-1)?.source.seq??0,freshness,sources:decisions.flatMap(f=>f.sources)},originals,complete,byteLimit:10240};},
  async source({ref}){if(denied)throw new TaskError('FORBIDDEN','revoked');const m=store.message(ref.id);if(m.revision!==ref.revision||JSON.stringify(m.source)!==JSON.stringify(ref.binding))throw new TaskError('CONFLICT','changed');return{ref,content:m.text.slice(0,2000),offset:0,totalBytes:Buffer.byteLength(m.text),nextOffset:null,byteLimit:2000,coordinate:'utf-8-bytes'};},
  taskFacts(){return facts;},taskStatus(){return ownedTask;}};
 const recall=new StewardRecall(ledger,store,id=>{const binding=bindings.get(id);if(!binding)throw new TaskError('FORBIDDEN','unknown');return binding;});
 const evidence=new StewardEvidence(store,recall),continuity=new StewardContinuity(ledger,store,host);
 function decide(message,text=message.text,id='effective'){decisions=[{id,section:'decision',text,origin:'extractive',state:'active',sources:[source(message)]}];}
 return{db,store,host,bindings,add,evidence,continuity,decide,scope,setComplete:v=>complete=v,setFreshness:v=>freshness=v,setDenied:v=>denied=v,
  setFacts:v=>facts=v,setTaskStatus:v=>ownedTask=v,close:()=>db.close()};
}
function quote(message,excerpt){return{messageId:message.id,revision:message.revision,scope:message.scope,source:message.source,sourceContentHash:hash(message.text),excerpt,excerptHash:hash(excerpt),authorizedAt:new Date().toISOString()};}
function capture(f,message,tokens){return f.continuity.capture({messageId:message.id,trigger:'turn-complete',...(tokens?{tokens}:{})});}

test('question-only discovery finds the later compatibility decision in its actual source, with versioned pointers',()=>{
 const f=fixture();try{f.add('兼容决定：采用旧方案A。');const last=f.add('兼容决定变更：放弃A，最后采纳B。');f.add('FOREIGN_COMPATIBILITY_SECRET','B');
  const result=f.evidence.read('A',{question:'昨天最后采纳哪条兼容决定？'});assert.equal(result.kind,'evidence');assert.equal(result.coverage,'bounded-discovery');
  assert.match(JSON.stringify(result),/最后采纳B/);assert.doesNotMatch(JSON.stringify(result),/FOREIGN_COMPATIBILITY_SECRET/);
  const pointer=result.items[0].record.items.find(item=>item.messageId===last.id).lookup;
  const exact=f.evidence.read('A',{question:'精读最后的更改原文',references:[{kind:'message',messageId:pointer.messageId,expectedRevision:pointer.expectedRevision}]});
  assert.equal(exact.items[0].record.content,last.text);assert.equal(exact.dataOnly,true);
 }finally{f.close();}});

test('bounded no-ID discovery exposes remaining history and never treats an empty prefix search as no evidence anywhere',()=>{
 const f=fixture();try{for(let n=0;n<6;n++)f.add(`Decision ${n}`);const page=f.evidence.read('A',{question:'Which decision?'});assert.equal(page.complete,false);assert.equal(page.items[0].record.hasMore,true);const filtered=f.evidence.read('A',{question:'Which decision?',query:'Decision'});assert.equal(filtered.complete,false,'Lexical selection is not complete decision coverage');
  const missing=f.evidence.read('A',{question:'Find unavailable evidence',query:'absent-keyword'});assert.equal(missing.kind,'needs_context');assert.match(missing.reason,/不能据此声称/);
 }finally{f.close();}});

test('exact foreign IDs are denied, stale own pointers signal stale, and multiple known references remain bounded data',()=>{
 const f=fixture();try{const a=f.add('Own decision'),b=f.add('Foreign decision','B');
  assert.equal(f.evidence.read('A',{question:'Read',references:[{kind:'message',messageId:b.id,expectedRevision:String(b.revision)}]}).kind,'forbidden');
  assert.equal(f.evidence.read('A',{question:'Read',references:[{kind:'message',messageId:a.id,expectedRevision:'999'}]}).kind,'stale');
  const result=f.evidence.read('A',{question:'Compare these sources',references:[{kind:'message',messageId:a.id,expectedRevision:String(a.revision)},{kind:'message',messageId:a.id,expectedRevision:String(a.revision)}]});
  assert.equal(result.items.length,2);assert.equal(result.coverage,'referenced-material-only');
 }finally{f.close();}});

test('a received explicit quote grants only its exact excerpt, not donor history or later versions',()=>{
 const f=fixture();try{const original=f.add('SHARED_FRAGMENT PRIVATE_DONOR_REMAINDER','B');const received=f.add('Please check the shared material','A',{quote:quote(original,'SHARED_FRAGMENT')});
  const ref={kind:'shared',messageId:received.id,expectedRevision:String(received.revision)};const result=f.evidence.read('A',{question:'What was shared?',references:[ref]});
  assert.equal(result.items[0].record.content,'SHARED_FRAGMENT');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_DONOR_REMAINDER/);
  const raw=JSON.parse(f.db.prepare('SELECT data FROM steward_messages WHERE id=?').get(original.id).data);raw.revision++;
  f.db.prepare('UPDATE steward_messages SET data=? WHERE id=?').run(JSON.stringify(raw),original.id);
  assert.equal(f.evidence.read('A',{question:'Check freshness',references:[ref]}).kind,'stale');
 }finally{f.close();}});

test('question-only discovers only bounded evidence actually handed to its receiver, and cannot follow donor full history',()=>{
 const f=fixture();try{const granted=f.add('Granted compatibility decision B','B');f.add('UNSHARED_DONOR_HISTORY','B');
  const received=f.add('Please inspect the admitted material','A',{contextEvidence:[{topic:{conversationId:'main',scope:f.scope('B')},originals:[{source:source(granted),role:'user',text:granted.text}]}]});
  const result=f.evidence.read('A',{question:'Which compatibility decision was handed over?'});assert.equal(result.kind,'evidence');assert.match(JSON.stringify(result),/Granted compatibility decision B/);assert.doesNotMatch(JSON.stringify(result),/UNSHARED_DONOR_HISTORY/);
  const exact=f.evidence.read('A',{question:'Inspect handoff',references:[{kind:'handoff',messageId:received.id,expectedRevision:String(received.revision)}]});assert.equal(exact.items[0].record.content,granted.text);
  assert.equal(f.evidence.read('A',{question:'Follow donor',references:[{kind:'message',messageId:granted.id,expectedRevision:String(granted.revision)}]}).kind,'forbidden');
 }finally{f.close();}});

test('refinement retains later negation even without repeated query words, and refuses incomplete, stale or oversized context',async()=>{
 const f=fixture();try{for(let n=0;n<5;n++)f.add(`Compatibility plan A detail ${n}`);const last=f.add('No. Wait for my acceptance; do not deploy.');
  const input={topic:{conversationId:'main',scope:f.scope('A')},throughSeq:9999,query:'Compatibility'};const result=await refineTopicEvidence(input,f.host);
  assert.equal(result.kind,'evidence');assert.equal(result.context.originals.length,6);assert.equal(result.context.originals.at(-1).text,last.text);assert.equal(result.coverage.selection,'full-scoped-context');
  f.setComplete(false);assert.equal((await refineTopicEvidence(input,f.host)).kind,'needs_context');f.setComplete(true);f.setFreshness('stale');assert.equal((await refineTopicEvidence(input,f.host)).kind,'stale');f.setFreshness('current');
  f.add('Compatibility '+ 'x'.repeat(9000));assert.equal((await refineTopicEvidence(input,f.host)).kind,'needs_context');
 }finally{f.close();}});

const claim=()=>({task:{taskId:'T',title:'Read assigned material',description:'Research compatibility',policy:{}},run:{taskId:'T',runId:'R',configuration:{}},attempt:{taskId:'T',runId:'R',attemptId:'A',nodeId:'local',fence:1,leaseExpiresAt:new Date().toISOString()},executionContext:{reports:[{reportId:'authorized-report',body:'The authorized handoff says compatibility B.',actor:'responsible-PM'}]}});
test('worker question-only discovers its task and directed handoff without receiving steward recall access',()=>{
 const value=claim(),result=workerRead(value,{question:'What compatibility decision was supplied?'});assert.equal(result.kind,'evidence');assert.equal(result.coverage,'assigned-material-only');assert.equal(result.complete,false);assert.match(JSON.stringify(result),/compatibility B/);
 const page=workerRead(value,{question:'Read exact handed report',references:[{kind:'record',recordKind:'report',recordId:'authorized-report'}]});assert.equal(page.items[0].record.source.actor,'responsible-PM');
 const oldVersion=page.items[0].record.source.revision;value.executionContext.reports[0].actor='changed-actor';assert.equal(workerRead(value,{question:'Verify provenance',references:[{kind:'record',recordKind:'report',recordId:'authorized-report',expectedRevision:oldVersion}]}).kind,'stale');value.executionContext.reports[0].actor='responsible-PM';
 assert.equal(workerRead(value,{question:'Read foreign task',references:[{kind:'record',recordKind:'task',recordId:'FOREIGN'}]}).kind,'forbidden');
 assert.equal(workerRead(value,{question:'Read steward',references:[{kind:'message',messageId:'steward-id',expectedRevision:'1'}]}).kind,'forbidden');
 assert.equal(workerRead(value,{question:'Read stale report',references:[{kind:'record',recordKind:'report',recordId:'authorized-report',expectedRevision:'old'}]}).kind,'stale');
});

test('worker material paging keeps the same authorized hash and UTF-8 coordinates',()=>{
 const value=claim();value.executionContext.reports[0].body='😀'.repeat(900)+'exact-tail';let ref={kind:'record',recordKind:'report',recordId:'authorized-report'},text='';
 do{const result=workerRead(value,{question:'Read assigned long material',references:[ref]});assert.equal(result.kind,'evidence');const page=result.items[0].record;assert.equal(page.offset,Buffer.byteLength(text));assert.ok(Buffer.byteLength(page.content)<=2000);text+=page.content;ref=page.next;}while(ref);
 assert.equal(text,value.executionContext.reports[0].body);
});

test('actual completed-turn capture is bounded and real token pressure, not absent measurements, triggers a new checkpoint',async()=>{
 const f=fixture();try{const message=f.add('Current work');let result=await capture(f,message);assert.equal(result.checkpoint.reason,'initial');
  assert.equal((await capture(f,message)).changed,false);assert.equal((await capture(f,message,{totalTokens:600,contextWindow:1000})).changed,false);
  result=await capture(f,message,{totalTokens:710,contextWindow:1000});assert.equal(result.checkpoint.reason,'budget');assert.equal(result.verification.automaticRetry,false);
  for(let n=0;n<6;n++)await capture(f,message,{totalTokens:720+n,contextWindow:1000});assert.equal(f.db.prepare('SELECT COUNT(*) n FROM steward_continuity_checkpoints').get().n,4);
  assert.equal(f.store.messages('main').length,1,'Checkpointing never replays or adds conversation actions');
  const pending=f.add('Not finished','A',{state:{kind:'accepted'}});assert.equal((await capture(f,pending)).kind,'needs_context');
 }finally{f.close();}});

test('restoration provides the current replacement decision, not the old deployment conclusion',async()=>{
 const f=fixture();try{const old=f.add('Deploy now');f.decide(old);const first=await capture(f,old);assert.match(JSON.stringify(first.checkpoint.decisions),/Deploy now/);
  const replacement=f.add('Do not deploy; wait for my acceptance');f.decide(replacement);const inspected=await f.continuity.inspect('A',{});
  assert.equal(inspected.kind,'checkpoint');assert.match(JSON.stringify(inspected.checkpoint.decisions),/wait for my acceptance/);assert.doesNotMatch(JSON.stringify(inspected.checkpoint.decisions),/Deploy now/);
  assert.equal(inspected.verification.status,'review-required');assert.equal(inspected.verification.automaticRetry,false);
  const saved=await capture(f,replacement);assert.equal(saved.checkpoint.reason,'decisions');assert.equal(saved.checkpoint.decisions[0].sources[0].id,replacement.id);
 }finally{f.close();}});

test('stale or incomplete restoration withholds old conclusions, and cross-source checkpoint IDs are denied',async()=>{
 const f=fixture();try{const message=f.add('Old action');f.decide(message);const first=await capture(f,message);
  f.setFreshness('stale');let result=await f.continuity.inspect('A',{});assert.equal(result.kind,'needs_context');assert.doesNotMatch(JSON.stringify(result),/Old action/);f.setFreshness('current');
  assert.equal((await f.continuity.inspect('B',{checkpointId:first.checkpoint.id})).kind,'forbidden');
  f.setDenied(true);assert.equal((await f.continuity.inspect('A',{})).kind,'forbidden');
 }finally{f.close();}});

test('checkpoint source revisions are rechecked and restoration never masks a changed original',async()=>{
 const f=fixture();try{const message=f.add('Sourced decision');f.decide(message);await capture(f,message);
  const raw=JSON.parse(f.db.prepare('SELECT data FROM steward_messages WHERE id=?').get(message.id).data);raw.revision++;
  f.db.prepare('UPDATE steward_messages SET data=? WHERE id=?').run(JSON.stringify(raw),message.id);
  assert.equal((await f.continuity.inspect('A',{})).kind,'stale');
 }finally{f.close();}});

test('same logical topic never makes another native seat visible through question-only recall',()=>{
 const f=fixture();try{f.bindings.set('B',{...f.bindings.get('B'),topicId:'A'});f.store.registerSource('main',f.bindings.get('B'));f.add('Own seat decision');f.add('OTHER_SEAT_PRIVATE','B');
  const result=f.evidence.read('A',{question:'Which decision?'});assert.equal(result.kind,'evidence');assert.doesNotMatch(JSON.stringify(result),/OTHER_SEAT_PRIVATE/);
 }finally{f.close();}});

test('phase, uncertain execution and human acceptance are read as authority, never released or replayed',async()=>{
 const f=fixture();try{f.bindings.set('A',{kind:'managed',projectId:'P',nodeId:'local',sessionId:'A',generation:1,cwd:'/project/P'});f.store.registerSource('main',f.bindings.get('A'));
  const facts={projectId:'P',tasksTruncated:false,tasks:[{source:{kind:'task',id:'T',revision:1},state:'ready',run:null,reports:[],decision:null,checkin:{phase:'idle',revision:0,reason:''}}],gates:{gates:[],total:0,truncated:false}};f.setFacts(facts);
  const message=f.add('Discuss deployment');const first=await capture(f,message);assert.equal(first.checkpoint.phase,'planning');
  facts.tasks[0].run={source:{kind:'run',id:'R',revision:'v2'},state:'uncertain'};facts.gates.gates=[{gateId:'G',state:'awaiting-acceptance',revision:1}];
  const second=await capture(f,message);assert.equal(second.checkpoint.reason,'phase');assert.equal(second.checkpoint.phase,'acceptance');assert.equal(second.verification.status,'review-required');
  assert.match(second.verification.reasons.join(' '),/不能自动重跑/);assert.match(second.verification.reasons.join(' '),/人员验收/);assert.equal(facts.gates.gates[0].state,'awaiting-acceptance');assert.equal(facts.tasks[0].run.state,'uncertain');
 }finally{f.close();}});

test('duplicate completed-turn observations converge to one checkpoint under concurrent capture',async()=>{
 const f=fixture();try{const message=f.add('A complete turn');const results=await Promise.all([capture(f,message),capture(f,message)]);assert.equal(results[0].checkpoint.id,results[1].checkpoint.id);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM steward_continuity_checkpoints').get().n,1);
 }finally{f.close();}});


test('an ordinary responsible task PM reads only its verified material without a fabricated project or execution lease',()=>{
 const value=claim(),assigned={task:value.task,executionContext:value.executionContext};
 const result=ordinaryTaskRead(assigned,{question:'Which handoff decision applies?'});assert.equal(result.kind,'evidence');assert.match(JSON.stringify(result),/compatibility B/);
 const withoutRun=ordinaryTaskRead({task:value.task,reports:value.executionContext.reports},{question:'Read current task PM material before any run'});assert.equal(withoutRun.kind,'evidence');assert.match(JSON.stringify(withoutRun),/compatibility B/);
 const dedup=ordinaryTaskRead({...assigned,reports:value.executionContext.reports},{question:'Read handed material'});assert.equal(dedup.items.filter(item=>item.record.source?.id==='authorized-report').length,1);
 assert.equal(ordinaryTaskRead(assigned,{question:'Another task',references:[{kind:'record',recordKind:'task',recordId:'foreign-task'}]}).kind,'forbidden');
 assert.equal(ordinaryTaskRead(assigned,{question:'PM history',references:[{kind:'message',messageId:'foreign-steward',expectedRevision:'1'}]}).kind,'forbidden');
});

test('verified taskPM status produces a narrow task checkpoint with unresolved execution and review risks',async()=>{
 const f=fixture();try{const message=f.add('Task planning');f.setTaskStatus({taskId:'T',state:'waiting',version:'one',run:{runId:'R',state:'uncertain'},reports:[],reviewRequired:true});
  const first=await capture(f,message);assert.equal(first.kind,'checkpoint');assert.equal(first.checkpoint.task.taskId,'T');assert.equal(first.checkpoint.phase,'acceptance');assert.equal(first.verification.automaticRetry,false);assert.match(first.verification.reasons.join(' '),/缺少门禁记录不表示已通过/);
  f.setTaskStatus({taskId:'T',state:'completed',version:'two',run:{runId:'R',state:'succeeded'},reports:[{reportId:'P',revision:2}],reviewRequired:true});
  const next=await f.continuity.inspect('A',{});assert.equal(next.checkpoint.task.run.runId,'R');assert.equal(next.checkpoint.task.version,'two');assert.equal(next.verification.status,'review-required');assert.equal(f.store.messages('main').length,1);
 }finally{f.close();}
});
