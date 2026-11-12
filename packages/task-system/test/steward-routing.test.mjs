import test from 'node:test';
import assert from 'node:assert/strict';
import {compactRoutingCandidates,assertRoutingBudget} from '../dist/steward-routing-budget.js';
import {createStewardSemanticCall,createStewardTopicCompactor,createStewardTriageCall} from '../dist/steward-routing.js';
test('auxiliary router uses only explicit bounded input with no tools and preserves provenance',async()=>{let seen;const ctx={llm:{async *stream(request){seen=request;yield{type:'text-delta',text:JSON.stringify({kind:'route',target:{kind:'personal'}})}}}};const input={stage:'latest',text:'开始',context:{card:{topic:{scope:{kind:'personal'}}},originals:[{text:'合法的同话题前文'}]}};assert.deepEqual(await createStewardSemanticCall(ctx,{provider:'fixture',model:'script'})(input),{kind:'route',target:{kind:'personal'}});assert.deepEqual(seen.tools,[]);assert.deepEqual(JSON.parse(seen.messages[0].content[0].text),input);assert.equal(seen.messages[0].source.kind,'dsh-steward-route-classifier');assert.match(seen.system,/NOT sufficient alone/);assert.ok(Buffer.byteLength(JSON.stringify(seen))<32768);});
test('full system/message envelope limits reject without model calls and incomplete provider output never becomes a route',async()=>{let calls=0;const ctx={llm:{async *stream(){calls++;yield{type:'finish',reason:{kind:'error'}}}}};const route=createStewardSemanticCall(ctx,{provider:'fixture',model:'script'});await assert.rejects(route({stage:'latest',text:'中'.repeat(16000)}),/budget|bound/);assert.equal(calls,0);await assert.rejects(route({stage:'latest',text:'hello'}),/provider failed/);assert.equal(calls,1);const compact=createStewardTopicCompactor(ctx,{provider:'fixture',model:'script'});await assert.rejects(compact({previous:{facts:[]},delta:[{text:'中'.repeat(16000)}]}),/budget/);assert.equal(calls,1);});

const triageInput = () => ({stage:'latest',text:'Continue the explicitly cited requirement',context:{card:{topic:{conversationId:'main',scope:{kind:'project',projectId:'A'}},version:'one',binding:null,title:'Alpha',summary:'one unique marker',facts:[],sources:[],coverageSeq:1,observedThroughSeq:1,freshness:'current'},originals:[],complete:true,byteLimit:10240}});
function triageFixture(answer) {
 const requests=[],fallbacks=[],traces=[];
 const ctx={decisionModels:{async ask(request){requests.push(request);if(answer instanceof Error)throw answer;return {provider:'jev-own-provider',model:'jev-own-model',answers:{recipient:answer}}}},
  llm:{async *stream(request){fallbacks.push(request);yield {type:'text-delta',text:JSON.stringify({kind:'route',target:{kind:'project',projectId:'A'}})}}}};
 ctx.get=name=>ctx[name];
 return {requests,fallbacks,traces,call:input=>createStewardTriageCall(ctx,{provider:'small-provider',model:'small-model'})(input,undefined,item=>traces.push(item))};
}
test('JEV uses its own configuration and one evidence copy; decisive results skip the independent fallback',async()=>{
 const f=triageFixture({type:'choice',choice:'topic_0',confidence:0.9,probabilities:{topic_0:0.9,uncertain:0.1}});
 assert.deepEqual(await f.call(triageInput()),{kind:'route',target:{kind:'project',projectId:'A'}});
 assert.equal(f.fallbacks.length,0);assert.equal(f.requests[0].provider,undefined);assert.equal(f.requests[0].model,undefined);
 assert.equal(JSON.stringify(f.requests[0]).split('one unique marker').length-1,1);
 assert.equal(f.traces[0].tier,'jev');assert.equal(f.traces[0].outcome,'accepted');
});
test('ambiguous, low-confidence, invalid and unavailable JEV results use only the configured fallback model',async()=>{
 for(const answer of [{type:'choice',choice:'uncertain'},{type:'choice',choice:'topic_0',probabilities:{topic_0:0.5,uncertain:0.5}},
  {type:'choice',choice:'topic_0',confidence:0.2},{type:'choice',choice:'foreign'},new Error('provider unavailable')]) {
  const f=triageFixture(answer);await f.call(triageInput());
  assert.equal(f.fallbacks.length,1);assert.equal(f.fallbacks[0].provider,'small-provider');assert.equal(f.fallbacks[0].model,'small-model');
  assert.deepEqual(f.fallbacks[0].tools,[]);assert.equal(f.traces.at(-1).tier,'fallback');
 }
});
test('no eligible recipient never sends a singleton JEV question, and absent fallback fails closed',async()=>{
 const f=triageFixture({type:'choice',choice:'topic_0'}),input={stage:'candidates',text:'A request with no eligible candidate',candidates:[]};
 await f.call(input);assert.equal(f.requests.length,0);assert.equal(f.fallbacks.length,1);
 const ctx={get(){return undefined}};
 await assert.rejects(createStewardTriageCall(ctx,null)(input),/No independent routing fallback/);
});
test('one incoming triage instance shares a three-model-call budget across JEV and fallback stages',async()=>{
 let jev=0,fallback=0,reads=0;const traces=[];
 const ctx={decisionModels:{async ask(){jev++;return {provider:'jev',model:'judge',answers:{recipient:{type:'choice',choice:'uncertain'}}}}},
  llm:{async *stream(){fallback++;yield {type:'text-delta',text:'{"kind":"search","queries":["synthetic"]}'}}}};ctx.get=name=>ctx[name];
 const call=createStewardTriageCall(ctx,async()=>{reads++;return {provider:'small',model:'fallback'}});
 await call(triageInput(),undefined,value=>traces.push(value));
 await assert.rejects(call(triageInput(),undefined,value=>traces.push(value)),{code:'LIMIT'});
 assert.equal(jev,2);assert.equal(fallback,1);assert.equal(reads,1);assert.equal(traces.filter(item=>item.modelCall).length,3);
 await assert.rejects(call(triageInput()),{code:'LIMIT'});assert.equal(jev+fallback,3);
});

test('JEV can classify an explicit offered new-topic answer without fabricating a workbench destination',async()=>{
 const f=triageFixture({type:'choice',choice:'create_topic',confidence:0.95});
 const result=await f.call({stage:'answer',text:'是，另开话题',original:'A complete original request',question:'要新开普通话题吗？',candidates:[],actions:['create-topic']});
 assert.deepEqual(result,{kind:'create-topic'});assert.equal(f.fallbacks.length,0);assert.ok(f.requests[0].questions.recipient.criteria.create_topic);
 const unoffered=triageFixture({type:'choice',choice:'create_topic'});await unoffered.call({stage:'answer',text:'unclear',candidates:[]});assert.equal(unoffered.requests.length,0);assert.equal(unoffered.fallbacks.length,1);
});
test('independent fallback receives typed new-topic actions, not an instruction to reuse a generic workbench',async()=>{
 let seen;const ctx={get(){return undefined},llm:{async *stream(request){seen=request;yield{type:'text-delta',text:'{"kind":"create-topic"}'}}}};ctx.get=name=>ctx[name];
 const input={stage:'answer',text:'是，另开话题',original:'A preserved request',question:'新开普通话题吗？',candidates:[],actions:['create-topic']};
 const result=await createStewardTriageCall(ctx,{provider:'small',model:'fallback'})(input);
 assert.deepEqual(result,{kind:'create-topic'});assert.deepEqual(JSON.parse(seen.messages[0].content[0].text).actions,['create-topic']);
 assert.match(seen.system,/Generic workbench is never a substitute/);assert.doesNotMatch(seen.system,/confirmation to use steward workbench|exact supplied scopes or/);
});

test('without a configured fallback JEV can decide, while abstention and failure never borrow another model',async()=>{
 for(const answer of [{type:'choice',choice:'topic_0',confidence:0.9},{type:'choice',choice:'uncertain'},new Error('unavailable')]) {
  const ctx={decisionModels:{async ask(){if(answer instanceof Error)throw answer;return {provider:'jev-own-provider',model:'jev-own-model',answers:{recipient:answer}};}},llm:{async *stream(){assert.fail('No fallback model was configured');}}};ctx.get=name=>ctx[name];
  const invoke=()=>createStewardTriageCall(ctx,null)(triageInput());
  if(!(answer instanceof Error)&&answer.choice==='topic_0')assert.deepEqual(await invoke(),{kind:'route',target:{kind:'project',projectId:'A'}});
  else await assert.rejects(invoke(),/No independent routing fallback/);
 }
});


test('32 compact candidates plus uncertain reach Jev and explicit fallback without exposing executable authority',async()=>{
 const candidates=Array.from({length:32},(_,i)=>({id:`topic_${i}`,title:`话题${i}`,summary:'讨论近期研究目标与已有材料，保持当前范围和约束，区分证据、预测与尚待回答的问题。'.repeat(3).slice(0,100),evidence:`goal: specific bounded goal ${i}`,freshness:'current',complete:true,previewTruncated:false}));
 const input={stage:'candidates',text:'An exact original request with its unique evidence',candidates};
 const f=triageFixture({type:'choice',choice:'topic_31',confidence:0.99});
 assert.deepEqual(await f.call(input),{kind:'candidate',id:'topic_31'});
 assert.equal(Object.keys(f.requests[0].questions.recipient.criteria).length,33);
 assert.deepEqual(JSON.parse(f.requests[0].state),input);assert.equal(f.fallbacks.length,0);
 let seen;const ctx={get(name){return this[name]},llm:{async *stream(request){seen=request;yield {type:'text-delta',text:'{"kind":"candidate","id":"topic_31"}'}}}};
 assert.deepEqual(await createStewardTriageCall(ctx,{provider:'explicit',model:'small'})(input),{kind:'candidate',id:'topic_31'});
 assert.equal(JSON.parse(seen.messages[0].content[0].text).candidates.length,32);
 assert.match(seen.system,/opaque IDs/);assert.deepEqual(seen.tools,[]);
});


test('compact evidence retains literal restrictions alongside goals, and omitted evidence cannot look complete',()=>{
 const value=triageInput().context;
 value.card.facts=[{state:'active',section:'goal',text:'Continue the research'}];
 value.originals=[{role:'user',text:'Do not continue; the topic now concerns a different design.'}];
 const [preview]=compactRoutingCandidates([value]);
 assert.match(preview.evidence,/Continue the research/);assert.match(preview.evidence,/Do not continue/);assert.equal(preview.complete,true);
 value.originals[0].text='关键约束'.repeat(300);
 const [partial]=compactRoutingCandidates([value]);assert.equal(partial.complete,false);assert.equal(partial.previewTruncated,true);
 assert.throws(()=>compactRoutingCandidates(Array(33).fill(value)),{code:'LIMIT'});
 const original='中'.repeat(16000);assert.throws(()=>assertRoutingBudget({text:original}),{code:'LIMIT'});assert.equal(original.length,16000);
});

test('Jev candidate protocol remains 32 choices plus uncertain and incomplete selections request inspection only',async()=>{
 const candidates=Array.from({length:32},(_,i)=>({id:`topic_${i}`,title:`Topic ${i}`,summary:'summary',evidence:'specific evidence',freshness:'current',complete:i!==31,previewTruncated:i===31}));let observed;
 const ctx={decisionModels:{async ask(input){observed=input;return {provider:'jev',model:'own',answers:{recipient:{type:'choice',choice:'topic_31',confidence:0.95}}}}}};ctx.get=name=>ctx[name];
 assert.deepEqual(await createStewardTriageCall(ctx,null)({stage:'candidates',text:'Find the exact supplied requirement',candidates}),{kind:'inspect',candidateIds:['topic_31']});assert.equal(Object.keys(observed.questions.recipient.criteria).length,33);assert.equal(observed.questions.recipient.criteria.independent,undefined);
});
test('recipient classification exposes only opaque authorized roles and shares the existing model-call budget',async()=>{
 let observed,calls=0;const ctx={decisionModels:{async ask(input){observed=input;calls++;return {provider:'jev',model:'own',answers:{recipient:{type:'choice',choice:'seat_1',confidence:0.99}}}}}};ctx.get=name=>ctx[name];const classify=createStewardTriageCall(ctx,null);const input={stage:'recipient',text:'Read the existing execution report',recipients:[{id:'seat_0',role:'PM',responsibility:'Coordinate',artifacts:[],scopeLabel:'Current topic'},{id:'seat_1',role:'Executor',responsibility:'Own the existing result',artifacts:['report.md'],scopeLabel:'Current topic'}]};assert.deepEqual(await classify(input),{kind:'recipient',id:'seat_1'});assert.deepEqual(Object.keys(observed.questions.recipient.criteria),['uncertain','seat_0','seat_1']);assert.equal(observed.provider,undefined);assert.equal(observed.model,undefined);await classify(input);await classify(input);await assert.rejects(classify(input),{code:'LIMIT'});assert.equal(calls,3);
});
test('a dependent continuation choice is available only when the trusted original offers that action',async()=>{
 for(const allowed of [false,true]){const ctx={decisionModels:{async ask(){return {provider:'jev',model:'own',answers:{recipient:{type:'choice',choice:'continue_dependent',confidence:1}}}}}};ctx.get=name=>ctx[name];const input={stage:'answer',text:'The effective budget is 5000',original:'Compare both specs, then recommend using the budget.',question:'What is the budget?',candidates:[],actions:allowed?['continue-dependent']:[]};if(allowed)assert.deepEqual(await createStewardTriageCall(ctx,null)(input),{kind:'continue-dependent'});else await assert.rejects(createStewardTriageCall(ctx,null)(input),/No independent routing fallback/);}
});

test('latest Jev may search only with complete bounded local keywords, without changing candidate choice cardinality',async()=>{
 const ctx={decisionModels:{async ask(input){assert.ok(input.questions.recipient.criteria.search);return {provider:'jev',model:'own',answers:{recipient:{type:'choice',choice:'search',confidence:1}}}}}};ctx.get=name=>ctx[name];const input={...triageInput(),text:'scopeboundedsharedneedle'};assert.deepEqual(await createStewardTriageCall(ctx,null)(input),{kind:'search',queries:['scopeboundedsharedneedle']});
});
