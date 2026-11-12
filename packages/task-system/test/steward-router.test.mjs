import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {StewardRouter} from '../dist/steward-router.js';
import {canonical} from '../dist/ledger.js';
const scope={kind:'project',projectId:'A'},other={kind:'project',projectId:'B'};
const binding={kind:'managed',projectId:'A',nodeId:'host',sessionId:'A',generation:1,cwd:'/A'};
const card=s=>({topic:{conversationId:'main',scope:s},version:'v1',binding:s.kind==='project'?{...binding,projectId:s.projectId,sessionId:s.projectId}:null,title:s.projectId??s.kind,summary:'goal',facts:[],coverageSeq:4,observedThroughSeq:4,freshness:'current',sources:[]});
function fixture(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE steward_commands(id TEXT)');const inputs=[],cards={async context(input){inputs.push(input);return{card:card(input.topic.scope),originals:[],complete:true,byteLimit:10240}},async candidates(){return{items:[{card:{...card(other),facts:[{state:'active',section:'goal',text:'goal'}]},originals:[],complete:true,byteLimit:10240}],complete:true}}};return {db,inputs,router:new StewardRouter({managementDatabase:()=>db},cards)};}
const request=(id,text='开始')=>({conversationId:'main',commandId:id,text,routingMode:'auto',selection:{provider:'p',model:'m'},permissionPreset:'read-only',uploads:['server-minted']});
const latest={scope,latestMessageId:'last',throughSeq:4};
test('latest candidate is frozen and semantically checked even for start; unrelated index shortlist is bounded',async()=>{const f=fixture();try{const calls=[];const result=await f.router.prepare(request('x'),latest,async input=>{calls.push(input);return input.stage==='latest'?{kind:'search',queries:['B']}:{kind:'candidate',id:'topic_0'}});assert.deepEqual(f.inputs[0].topic.scope,scope);assert.equal(calls.length,2);assert.deepEqual(result.delivery.target,other);assert.deepEqual(result.delivery.selection,request('x').selection);assert.deepEqual(result.delivery.uploads,['server-minted']);assert.equal(result.delivery.permissionPreset,'read-only');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM steward_commands').get().n,0);assert.deepEqual(await f.router.prepare(request('x'),{...latest,scope:other},()=>{throw Error('no replay')}),result);}finally{f.db.close()}});
test('provider failure and ambiguity retain complete durable original without executor delivery or workbench fallback',async()=>{const f=fixture();try{const input=request('original','complete original '.repeat(700));const value=await f.router.prepare(input,latest,async()=>{throw Error('secret provider failure')});assert.equal(value.phase,'clarifying');assert.equal(value.delivery,null);assert.equal(value.request.text,input.text);assert.equal(value.reason,'unavailable');assert.equal(JSON.stringify(f.router.list('main')).includes('secret'),false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM steward_commands').get().n,0);}finally{f.db.close()}});
test('new work requires confirmation, then original immutable payload plus answer is delivered; retry has no model calls',async()=>{const f=fixture();try{const root=await f.router.prepare(request('orig','research something'),latest,async()=>({kind:'new-work',question:'交给管家工作区吗？'}));assert.equal(root.delivery,null);const answer={conversationId:'main',commandId:'ans',text:'是的',routeQuestionId:root.questionId,routeCreateTopic:true};const result=await f.router.prepare(answer,latest,undefined,undefined,undefined,{createTopic:()=>({kind:'workbench',topicId:'confirmed-new'})});assert.equal(result.delivery.commandId,'orig');assert.match(result.delivery.text,/research something/);assert.equal(f.router.get('orig').answers[0].text,'是的');assert.deepEqual(result.delivery.selection,root.request.selection);assert.deepEqual((await f.router.prepare(answer,latest,()=>{throw Error('no replay')})).delivery,result.delivery);}finally{f.db.close()}});
test('unique unanswered question is only association candidate; new-topic answer is not forced into original',async()=>{const f=fixture();try{await f.router.prepare(request('old','old work'),latest,async()=>({kind:'new-work',question:'工作区？'}));const stages=[];const fresh=await f.router.prepare({conversationId:'main',commandId:'fresh',text:'聊点别的',routingMode:'auto'},latest,async input=>{stages.push(input.stage);return input.stage==='association'?{kind:'new-request'}:{kind:'route',target:scope}});assert.deepEqual(stages,['association','latest']);assert.equal(fresh.delivery.commandId,'fresh');assert.equal(f.router.get('old').delivery,null);}finally{f.db.close()}});
test('multiple questions require explicit association, and an answer cannot silently overwrite frozen media/model/permission',async()=>{const f=fixture();try{const a=await f.router.prepare(request('a','first'),latest,async()=>({kind:'new-work',question:'工作区？'}));await f.router.prepare(request('b','second'),latest,async input=>input.stage==='association'?{kind:'new-request'}:{kind:'new-work',question:'工作区？'});const response=await f.router.prepare({conversationId:'main',commandId:'c',text:'yes',routeQuestionId:a.questionId,uploads:['other']},latest,async()=>{throw Error('should not classify')});assert.equal(response.delivery,null);assert.equal(f.router.get('a').answers.length,0);}finally{f.db.close()}});
test('question lookup and uniqueness use all unresolved roots, not the forty visible receipts',async()=>{const f=fixture();try{const q=await f.router.prepare(request('old-q'),latest,async()=>({kind:'new-work',question:'工作区吗'}));for(let n=0;n<45;n++){const value={...q,commandId:'resolved-'+n,questionId:'q-'+n,phase:'resolved'};f.db.prepare('INSERT INTO steward_router VALUES(?,?,?)').run(value.commandId,'main',JSON.stringify(value));}const r=await f.router.prepare({conversationId:'main',commandId:'exact-old',text:'选择',routeQuestionId:q.questionId,routeCreateTopic:true,target:{kind:'workbench'}},latest,undefined,undefined,undefined,{createTopic:()=>({kind:'workbench',topicId:'old-visible-question'})});assert.equal(r.delivery.commandId,'old-q');assert.equal(r.delivery.target.kind,'workbench');assert.equal(r.request.selection,undefined);assert.equal(r.delivery.selection.model,'m');}finally{f.db.close()}});
test('one parent resolves once under simultaneous different candidate choices, including metadata changes on the answering composer',async()=>{const f=fixture();try{const q=await f.router.prepare(request('root'),latest,async()=>({kind:'new-work',question:'工作区吗'}));const one={conversationId:'main',commandId:'answer-1',text:'确认',routeQuestionId:q.questionId,routeCreateTopic:true,target:{kind:'workbench'},selection:{provider:'other',model:'later-model'},permissionPreset:'full'};const [a,b]=await Promise.all([f.router.prepare(one,latest,undefined,undefined,undefined,{createTopic:()=>({kind:'workbench',topicId:'race-topic'})}),f.router.prepare({...one,commandId:'answer-2'},latest,undefined,undefined,undefined,{createTopic:()=>({kind:'workbench',topicId:'race-topic'})})]);assert.equal([a,b].filter(item=>item.delivery).length,1);const saved=f.router.get('root');assert.equal(saved.answers.length,1);assert.equal(saved.delivery.selection.model,'m');assert.equal(saved.delivery.permissionPreset,'read-only');assert.equal(saved.delivery.commandId,'root');}finally{f.db.close()}});
test('routing never performs synchronous card maintenance before either semantic tier',async()=>{const f=fixture();try{await f.router.prepare(request('old'),latest,async()=>({kind:'new-work',question:'工作区吗'}));const router=f.router;const previous=router.cards.context;router.cards.context=async input=>{if(input.maintain){input.requestBudget.claimCall();input.requestBudget.claimCall();}return previous(input)};let calls=0;const result=await router.prepare({conversationId:'main',commandId:'new',text:'another request',routingMode:'auto'},latest,async input=>{calls++;return input.stage==='association'?{kind:'new-request'}:{kind:'search',queries:['B']}});assert.equal(calls,3);assert.equal(f.inputs.every(input=>input.maintain===false),true);assert.equal(result.delivery,null);assert.equal(result.reason,'uncertain');}finally{f.db.close()}});
test('the unresolved-root capacity cannot block answering an existing question',async()=>{const f=fixture();try{const q=await f.router.prepare(request('first'),latest,async()=>({kind:'new-work',question:'工作区吗'}));for(let n=0;n<19;n++){const value={...q,commandId:'other-'+n,questionId:'other-q-'+n};f.db.prepare('INSERT INTO steward_router VALUES(?,?,?)').run(value.commandId,'main',JSON.stringify(value));}await assert.rejects(f.router.prepare(request('overflow'),latest),{code:'LIMIT'});const resolved=await f.router.prepare({conversationId:'main',commandId:'capacity-answer',text:'确认',routeQuestionId:q.questionId,routeCreateTopic:true,target:{kind:'workbench'}},latest,undefined,undefined,undefined,{createTopic:()=>({kind:'workbench',topicId:'capacity-confirmed'})});assert.equal(resolved.delivery.commandId,'first');}finally{f.db.close()}});

test('empty retrieval offers a new ordinary topic without a second model call and freezes original payload',async()=>{
 const f=fixture();try{
  f.router.cards.candidates=async()=>({items:[],complete:true});let calls=0;
  const root=await f.router.prepare(request('empty'),{...latest,scope:{kind:'personal'}},async()=>{calls++;return {kind:'search',queries:['no matching topic']}});
  assert.equal(calls,1);assert.equal(root.delivery,null);
  const options=f.router.list('main')[0].options;
  assert.deepEqual(options.map(x=>x.target),[{kind:'workbench'}]);
  assert.deepEqual(options.map(x=>x.label),['新开普通话题']);assert.equal(options[0].action,'create-topic');
  const resolved=await f.router.prepare({conversationId:'main',commandId:'pick-empty',text:'明确选择',routeQuestionId:root.questionId,routeCreateTopic:true,target:{kind:'workbench'}},latest,undefined,undefined,undefined,{createTopic:()=>({kind:'workbench',topicId:'empty-confirmed'})});
  assert.equal(resolved.delivery.commandId,'empty');assert.deepEqual(resolved.delivery.uploads,['server-minted']);assert.equal(resolved.delivery.selection.model,'m');
 }finally{f.db.close()}
});
test('structured questions whitelist offered targets; free-text questions never infer choices from prose',async()=>{
 const f=fixture();try{
  const q=await f.router.prepare(request('choices'),{...latest,scope:{kind:'personal'}},async()=>({kind:'clarification',question:'model question',targets:[{kind:'personal'}]}));
  assert.deepEqual(f.router.list('main')[0].options.map(x=>x.target),[{kind:'personal'}]);
  const rejected=await f.router.prepare({conversationId:'main',commandId:'foreign-target',text:'pick',routeQuestionId:q.questionId,target:other},latest);
  assert.equal(rejected.delivery,null);assert.equal(f.router.get('choices').answers.length,0);
  const free=await f.router.prepare(request('free'),latest,async input=>input.stage==='association'?{kind:'new-request'}:{kind:'clarification',question:'个人话题「闲聊」中继续，还是作为一项新的独立工作处理？'});
  assert.deepEqual(free.options,[]);
  const invalid=await f.router.prepare(request('invalid'),latest,async()=>({kind:'clarification',question:'foreign',targets:[other]}));
  assert.equal(invalid.delivery,null);assert.equal(invalid.reason,'unavailable');
 }finally{f.db.close()}
});
test('known legacy two-way receipt projects both choices without changing audit or accepting arbitrary legacy questions',async()=>{
 const f=fixture();try{
  const original=await f.router.prepare(request('legacy'),latest,async()=>({kind:'clarification',question:'ignored'}));
  const old={...original,question:'请确认：是放入个人话题「闲聊」中继续，还是作为一项新的独立工作处理？',candidates:[{kind:'personal'}]};delete old.options;
  const raw=canonical(old);f.db.prepare('UPDATE steward_router SET data=? WHERE command=?').run(raw,'legacy');
  assert.deepEqual(f.router.list('main')[0].options.map(x=>x.target),[{kind:'personal'},{kind:'workbench'}]);
  assert.equal(f.db.prepare('SELECT data FROM steward_router WHERE command=?').get('legacy').data,raw);
  const answer={conversationId:'main',commandId:'legacy-pick',text:'选择独立工作',routeQuestionId:old.questionId,routeCreateTopic:true,target:{kind:'workbench'}};
  const result=await f.router.prepare(answer,latest,undefined,undefined,undefined,{createTopic:()=>({kind:'workbench',topicId:'legacy-independent'})});assert.equal(result.delivery.commandId,'legacy');assert.equal(result.delivery.target.topicId,'legacy-independent');
  assert.deepEqual((await f.router.prepare(answer,latest)).delivery,result.delivery);
  const ordinary={...old,commandId:'ordinary-legacy',questionId:'ordinary-q',question:'你要分析哪个年份？'};
  f.db.prepare('INSERT INTO steward_router VALUES(?,?,?)').run(ordinary.commandId,'main',JSON.stringify(ordinary));
  assert.deepEqual(f.router.list('main').find(x=>x.commandId==='ordinary-legacy').options,[]);
 }finally{f.db.close()}
});

test('an explicit exact recent topic short-circuits models; repeated wording alone remains semantic',async()=>{
 const f=fixture();try{
  f.router.cards.deterministic=async input=>({matches:[{card:card(other),lastActiveAt:new Date(Date.now()-1000).toISOString()}],complete:true,directed:input.text==='继续「B」'});
  const direct=await f.router.prepare(request('direct','继续「B」'),latest,()=>{throw Error('No model may be called')});
  assert.deepEqual(direct.delivery.target,other);assert.equal(direct.trace[0].tier,'program');
  let calls=0;const repeated=await f.router.prepare(request('repeated','A complete repeated instruction'),latest,async()=>{calls++;return {kind:'route',target:other}});
  assert.equal(calls,1);assert.deepEqual(repeated.delivery.target,other);
 }finally{f.db.close()}
});
test('old exact matches and same-title collisions ask before any model, and explicit confirmation preserves the original',async()=>{
 for(const collision of [false,true]) {
  const f=fixture();try{
   const oldAt=new Date(Date.now()-31*86400000).toISOString();
   f.router.cards.deterministic=async()=>({matches:[{card:card(scope),lastActiveAt:oldAt},...(collision?[{card:card(other),lastActiveAt:new Date(Date.now()-1000).toISOString()}]:[])],complete:true,directed:true});
   const root=await f.router.prepare(request('old-match','继续「Alpha」'),latest,()=>{throw Error('Old matches must not reach a model')},undefined,undefined,{activeDays:30});
   assert.equal(root.delivery,null);assert.equal(root.phase,'clarifying');assert.ok(root.clarifiedAt);assert.match(root.options[0].label,/上次活动/);
   assert.equal(root.options.at(-1).action,'create-topic');
   const result=await f.router.prepare({conversationId:'main',commandId:'confirm-old',routeQuestionId:root.questionId,text:'明确选择旧话题',target:scope},latest);
   assert.equal(result.delivery.commandId,'old-match');assert.equal(result.delivery.selection.model,'m');assert.deepEqual(result.delivery.uploads,['server-minted']);
  }finally{f.db.close()}
 }
});
test('rejecting an old association retains its original and selecting new-topic mints one identity without executing it',async()=>{
 const f=fixture();try{
  f.router.cards.deterministic=async()=>({matches:[{card:card(scope),lastActiveAt:'2000-01-01T00:00:00.000Z'}],complete:true,directed:true});
  const root=await f.router.prepare({...request('old-source'),uploads:undefined},latest);
  const rejected=await f.router.prepare({conversationId:'main',commandId:'reject-old',routeQuestionId:root.questionId,text:'不要关联旧记录'},latest,async()=>({kind:'new-work',question:'新开话题吗？'}));
  assert.equal(rejected.delivery,null);assert.equal(f.router.get('old-source').delivery,null);
  let creates=0;const createTopic=parent=>{creates++;assert.equal(parent.commandId,'old-source');return {kind:'workbench',topicId:'independent-one'}};
  const confirmed=await f.router.prepare({conversationId:'main',commandId:'new-choice',routeQuestionId:root.questionId,routeCreateTopic:true,target:{kind:'workbench'},text:'新开普通话题'},latest,undefined,undefined,undefined,{createTopic});
  assert.equal(creates,1);assert.deepEqual(confirmed.delivery.target,{kind:'workbench',topicId:'independent-one'});assert.equal(confirmed.delivery.routeCreateTopic,undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM steward_commands').get().n,0);
 }finally{f.db.close()}
});
test('manual new-topic selection is explicit and bypasses pending questions and both model tiers',async()=>{
 const f=fixture();try{
  await f.router.prepare(request('pending-old'),latest,async()=>({kind:'new-work',question:'New topic?'}));
  const input={conversationId:'main',commandId:'manual-new',text:'A synthetic independent discussion',routeCreateTopic:true,selection:{provider:'p',model:'m'}};
  let creates=0;const options={createTopic:parent=>{creates++;assert.equal(parent.commandId,'manual-new');return {kind:'workbench',topicId:'manual-topic'}}};
  const result=await f.router.prepare(input,latest,()=>{throw Error('Explicit new topic must not classify')},undefined,undefined,options);
  assert.equal(result.parent,null);assert.equal(creates,1);assert.deepEqual(result.delivery.target,{kind:'workbench',topicId:'manual-topic'});
  assert.equal(f.router.get('pending-old').answers.length,0);assert.deepEqual((await f.router.prepare(input,latest,undefined,undefined,undefined,options)).delivery,result.delivery);assert.equal(creates,1);
 }finally{f.db.close()}
});
test('a new-topic choice and an old-topic choice settle one parent and mint no losing orphan',async()=>{
 for(const oldFirst of [false,true]) {
  const f=fixture();try{
   f.db.exec('CREATE TABLE minted_topics(id TEXT PRIMARY KEY)');
   f.router.cards.deterministic=async()=>({matches:[{card:card(scope),lastActiveAt:'2000-01-01T00:00:00.000Z'}],complete:true});
   const root=await f.router.prepare({...request('race-root'),uploads:undefined},latest);
   const old=()=>f.router.prepare({conversationId:'main',commandId:'old-choice',routeQuestionId:root.questionId,text:'选择旧话题',target:scope},latest);
   const fresh=()=>f.router.prepare({conversationId:'main',commandId:'fresh-choice',routeQuestionId:root.questionId,routeCreateTopic:true,text:'新开普通话题'},latest,undefined,undefined,undefined,{createTopic:()=>{
    f.db.prepare('INSERT INTO minted_topics VALUES(?)').run('fresh-topic');return {kind:'workbench',topicId:'fresh-topic'};
   }});
   const results=oldFirst?[await old(),await fresh()]:await Promise.all([old(),fresh()]);
   assert.equal(results.filter(result=>result.delivery).length,1);assert.equal(f.router.get('race-root').answers.length,1);
   const minted=f.db.prepare('SELECT COUNT(*) n FROM minted_topics').get().n;
   assert.equal(minted,oldFirst?0:1);assert.equal(f.router.get('race-root').delivery.target.kind,oldFirst?'project':'workbench');
  }finally{f.db.close()}
 }
});

test('a natural explicit answer creates the offered independent topic once, never the legacy workbench candidate',async()=>{
 const f=fixture();try{
  const root=await f.router.prepare(request('spoken-new','The complete original request'),latest,async()=>({kind:'new-work',question:'新开普通话题吗？'}));
  const legacy={...f.router.get(root.commandId),candidates:[{kind:'workbench'}]};f.db.prepare('UPDATE steward_router SET data=? WHERE command=?').run(canonical(legacy),root.commandId);
  let creates=0;const options={createTopic:parent=>{creates++;assert.equal(parent.commandId,'spoken-new');return {kind:'workbench',topicId:'spoken-independent'}}};
  const invalid=await f.router.prepare({conversationId:'main',commandId:'wrong-bucket',text:'是，另开话题',routeQuestionId:root.questionId},latest,async input=>{assert.deepEqual(input.actions,['create-topic']);assert.deepEqual(input.candidates,[]);return {kind:'route',target:{kind:'workbench'}}},undefined,undefined,options);
  assert.equal(invalid.delivery,null);assert.equal(creates,0);assert.equal(f.router.get(root.commandId).delivery,null);
  const answer={conversationId:'main',commandId:'spoken-yes',text:'是，另开话题',routeQuestionId:root.questionId};
  const resolved=await f.router.prepare(answer,latest,async input=>{assert.equal(input.stage,'answer');assert.deepEqual(input.actions,['create-topic']);return {kind:'create-topic'}},undefined,undefined,options);
  assert.equal(creates,1);assert.equal(resolved.delivery.commandId,'spoken-new');assert.equal(resolved.delivery.target.topicId,'spoken-independent');assert.deepEqual(resolved.delivery.uploads,root.request.uploads);assert.deepEqual(resolved.delivery.selection,root.request.selection);assert.equal(resolved.delivery.permissionPreset,root.request.permissionPreset);
  await f.router.prepare(answer,latest,()=>{throw Error('must not replay the semantic decision')},undefined,undefined,options);assert.equal(creates,1);
 }finally{f.db.close()}
});
test('ambiguous answers stay in clarification and a model cannot invent the create-topic action',async()=>{
 const f=fixture();try{
  const root=await f.router.prepare(request('ambiguous-new'),latest,async()=>({kind:'new-work',question:'新开话题吗？'}));let creates=0;const options={createTopic:()=>{creates++;return {kind:'workbench',topicId:'no'}}};
  const result=await f.router.prepare({conversationId:'main',commandId:'maybe',text:'再看看',routeQuestionId:root.questionId},latest,async()=>({kind:'clarification',question:'要明确新开话题吗？'}),undefined,undefined,options);
  assert.equal(result.delivery,null);assert.equal(creates,0);assert.equal(f.router.list('main').find(item=>item.commandId===root.commandId).options[0].action,'create-topic');
  const plain=await f.router.prepare(request('plain-existing'),latest,async input=>input.stage==='association'?{kind:'new-request'}:{kind:'clarification',question:'哪个时间范围？'});
  const forbidden=await f.router.prepare({conversationId:'main',commandId:'invented-action',text:'2026年',routeQuestionId:plain.questionId},latest,async()=>({kind:'create-topic'}),undefined,undefined,options);
  assert.equal(forbidden.delivery,null);assert.equal(creates,0);assert.equal(f.router.get('plain-existing').delivery,null);
 }finally{f.db.close()}
});

test('pending clarification cannot intercept an explicit indexed topic continuation or stale-topic confirmation',async()=>{
 for(const stale of [false,true]){
  const f=fixture();try{
   const pending=await f.router.prepare(request('unanswered'),latest,async()=>({kind:'new-work',question:'新开话题吗？'}));
   let lookups=0;f.router.cards.deterministic=async()=>{lookups++;return {matches:[{card:card(other),lastActiveAt:stale?'2000-01-01T00:00:00.000Z':new Date(Date.now()-1000).toISOString()}],complete:true,directed:true}};
   const directed=await f.router.prepare(request('direct-with-pending','继续「B」'),latest,()=>{throw Error('Directed/stale matches must precede association')});
   assert.equal(lookups,1);assert.equal(f.router.get(pending.commandId).answers.length,0);
   if(stale){assert.equal(directed.delivery,null);assert.match(directed.question,/较早|同名/)}else assert.deepEqual(directed.delivery.target,other);
   const answer=await f.router.prepare({conversationId:'main',commandId:'answer-explicit-question',routeQuestionId:pending.questionId,routeCreateTopic:true,text:'新开'},latest,undefined,undefined,undefined,{createTopic:()=>({kind:'workbench',topicId:'explicit-question-topic'})});
   assert.equal(lookups,1,'explicit question answer must bypass deterministic reclassification');assert.equal(answer.delivery.commandId,pending.commandId);
  }finally{f.db.close()}
 }
});
test('persisted legacy independent-work option projects a typed new-topic action without editing its audit',async()=>{
 const f=fixture();try{
  const root=await f.router.prepare(request('old-options'),latest,async()=>({kind:'new-work',question:'作为独立工作处理吗？'}));
  const old={...root,candidates:[{kind:'workbench'}],options:[{id:'old-work',label:'作为独立工作处理',target:{kind:'workbench'}}]};
  const raw=canonical(old);f.db.prepare('UPDATE steward_router SET data=? WHERE command=?').run(raw,root.commandId);
  assert.equal(f.router.list('main')[0].options[0].action,'create-topic');assert.equal(f.db.prepare('SELECT data FROM steward_router WHERE command=?').get(root.commandId).data,raw);
  let creates=0;const result=await f.router.prepare({conversationId:'main',commandId:'old-options-yes',routeQuestionId:root.questionId,text:'是，另开话题'},latest,async input=>{assert.deepEqual(input.actions,['create-topic']);assert.deepEqual(input.candidates,[]);return {kind:'create-topic'}},undefined,undefined,{createTopic:()=>{creates++;return {kind:'workbench',topicId:'legacy-option-topic'}}});
  assert.equal(creates,1);assert.equal(result.delivery.target.topicId,'legacy-option-topic');
 }finally{f.db.close()}
});


test('candidate IDs map all 32 authorized recipients; scopes, stale evidence and overflow never bypass confirmation',async()=>{
 for(const mode of ['last','scope','incomplete','overflow']) {
  const f=fixture();try {
   const items=Array.from({length:32},(_,n)=>({card:{...card({kind:'project',projectId:`P${n}`}),facts:[{state:'active',section:'goal',text:`specific goal ${n}`}]},originals:[],complete:mode!=='incomplete',byteLimit:10240}));
   f.router.cards.candidates=async input=>{assert.equal(input.limit,32);assert.equal(input.throughSeq,latest.throughSeq);return {items,complete:mode!=='overflow'}};
   let calls=0;const original=request(`mapping-${mode}`);
   const result=await f.router.prepare(original,latest,async input=>{calls++;if(input.stage==='latest')return {kind:'search',queries:['specific']};assert.equal(input.candidates.length,32);assert.equal(JSON.stringify(input.candidates).includes('projectId'),false);return mode==='scope'?{kind:'route',target:items[31].card.topic.scope}:{kind:'candidate',id:'topic_31'}});
   if(mode==='last'){assert.deepEqual(result.delivery.target,items[31].card.topic.scope);assert.equal(result.binding.projectId,'P31');assert.deepEqual(result.delivery.uploads,original.uploads);assert.deepEqual(result.delivery.selection,original.selection);assert.equal(result.delivery.permissionPreset,original.permissionPreset)}
   else{assert.equal(result.delivery,null);assert.equal(result.phase,'clarifying');assert.ok(result.options.length<=4)}
   assert.equal(calls,mode==='overflow'?1:2);
  }finally{f.db.close()}
 }
});


test('candidate clarification maps at most four exact IDs, rejects duplicates and foreign IDs, and preserves free-text questions',async()=>{
 for(const ids of [['topic_0'],['topic_0','topic_0'],['topic_31'],['topic_32'],undefined]) {
  const f=fixture();try {
   const result=await f.router.prepare(request(`choices-${ids}`),latest,async input=>input.stage==='latest'?{kind:'search',queries:['specific']}:{kind:'clarification',question:'Which intended recipient?',...(ids?{candidateIds:ids}:{})});
   assert.equal(result.delivery,null);
   if(ids?.length===1&&ids[0]==='topic_0')assert.deepEqual(result.options.map(option=>option.target),[other]);
   else if(!ids)assert.deepEqual(result.options,[],'A genuine free-text question is not forced into recipient buttons');
   else assert.ok(['invalid-output','unavailable'].includes(result.reason));
  }finally{f.db.close()}
 }
 const f=fixture();try {
  const value=await f.router.prepare(request('wrong-stage-ids'),latest,async()=>({kind:'clarification',question:'No IDs in latest stage',candidateIds:['topic_0']}));
  assert.equal(value.delivery,null);assert.equal(value.reason,'unavailable');
 }finally{f.db.close()}
});
