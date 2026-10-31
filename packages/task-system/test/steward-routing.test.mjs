import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveStewardRoute,createStewardClassifier} from '../dist/steward-routing.js';
const personal={kind:'personal'}, a={kind:'project',projectId:'a'}, b={kind:'project',projectId:'b'};
const projects=[{projectId:'a',title:'Alpha 项目'},{projectId:'b',title:'Beta 项目'}];
const input={text:'继续刚才的话题',projects,previousScope:a};

test('explicit target and reply precede mentions and the classifier; conflicting or unavailable targets stop',async()=>{
  const classify=()=>{throw Error('must not call classifier');};
  assert.deepEqual(await resolveStewardRoute({...input,text:'Beta 项目',explicitTarget:personal,classify}),{kind:'route',target:personal,provenance:'explicit'});
  assert.deepEqual(await resolveStewardRoute({...input,text:'Beta 项目',replyScope:a,classify}),{kind:'route',target:a,provenance:'reply'});
  assert.equal((await resolveStewardRoute({...input,explicitTarget:b,replyScope:a,classify})).kind,'clarification');
  assert.equal((await resolveStewardRoute({...input,explicitTarget:{kind:'project',projectId:'unauthorized'},classify})).kind,'clarification');
});
test('only an explicit leading project address bypasses the classifier',async()=>{
  const classify=()=>{throw Error('must not call classifier');};
  assert.deepEqual(await resolveStewardRoute({...input,text:'Alpha 项目：需要进度。',classify}),{kind:'route',target:a,provenance:'project-mention'});
  assert.deepEqual(await resolveStewardRoute({...input,text:'@Beta 项目 需要进度。',classify}),{kind:'route',target:b,provenance:'project-mention'});
  for(const text of ['不要交给 Alpha 项目，聊点别的','我刚从 Alpha 项目回来，心情不错','他说“Alpha 项目”，只是引用','Alpha 项目和Beta 项目都处理一下']) {
    let called=false;
    const result=await resolveStewardRoute({...input,text,classify:async()=>{called=true;return {kind:'route',target:personal};}});
    assert.equal(called,true);assert.deepEqual(result.target,personal);
  }
  assert.equal((await resolveStewardRoute({...input,text:'Alpha 项目：继续',projects:[...projects,{projectId:'duplicate',title:'Alpha 项目'}],classify})).kind,'clarification');
});
test('oversize metadata or text requires explicit selection without silently truncating intent',async()=>{
  const classify=()=>{throw Error('oversize input must not reach classifier');};
  for(const extra of [{text:'x'.repeat(16001)},{projects:Array.from({length:101},(_,n)=>({projectId:String(n),title:'Project'}))},{projects:[{projectId:'a',title:'x'.repeat(121)}]}])
    assert.equal((await resolveStewardRoute({...input,...extra,classify})).kind,'clarification');
});
test('bounded classifier handles casual return; malformed, ambiguous and unknown IDs cannot dispatch',async()=>{
  let seen;
  const result=await resolveStewardRoute({...input,text:'先不聊项目，今天散散心',classify:async value=>{seen=value;return {kind:'route',target:personal};}});
  assert.deepEqual(result,{kind:'route',target:personal,provenance:'classifier'});
  assert.deepEqual(seen,{text:'先不聊项目，今天散散心',projects,previousScope:a});
  for(const output of [{kind:'route',target:{kind:'project',projectId:'hidden'}},{kind:'route',target:a,extra:'bad'},{kind:'clarification',question:'请明确项目'},'not json',null]) {
    assert.equal((await resolveStewardRoute({...input,classify:async()=>output})).kind,'clarification');
  }
  assert.equal((await resolveStewardRoute({...input,classify:async()=>{throw Error('provider unavailable');}})).kind,'clarification');
});
test('public LLM adapter emits one bounded auxiliary request with provenance and no project transcripts',async()=>{
  let request;
  const ctx={llm:{async *stream(options){request=options;yield {type:'text-delta',index:0,text:JSON.stringify({kind:'route',target:personal})};}}};
  const classify=createStewardClassifier(ctx,{provider:'fixture',model:'script'});
  assert.deepEqual(await classify(input),{kind:'route',target:personal});
  assert.equal(request.messages.length,1);assert.deepEqual(request.tools,[]);assert.equal(request.maxTokens,500);
  assert.equal(request.messages[0].source.kind,'dsh-steward-route-classifier');
  const text=request.messages[0].content[0].text;
  assert.deepEqual(JSON.parse(text),input);assert.doesNotMatch(text,/transcript|history|memory/);
});
