import test from 'node:test';
import assert from 'node:assert/strict';
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
 const f=triageFixture({type:'choice',choice:'topic_0'}),input=triageInput();input.context.card.topic.scope={kind:'personal'};
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
