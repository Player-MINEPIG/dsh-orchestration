import { Readable } from 'node:stream'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { DecisionModels, createDecisionCaller, callJev, makeTool, apply, makeBridgeRoutes } from '../lib/index.js'
const questions = {q:{type:'choice',instructions:'Choose one',criteria:{a:'A',b:'B'}}}
const request = {state:'Background supplied by consumer',questions}
const reply = {model:'response-model',answers:{q:{type:'choice',choice:'a'}},usage:{input_tokens:3,output_tokens:1}}
function service(config, extras={}) {
  const ctx=new Context()
  const call=createDecisionCaller(()=>({resolve:async()=>({value:'fixture-key'})}),()=>config,undefined,()=>extras.llm)
  return {ctx,value:new DecisionModels(ctx,call,()=>config)}
}

test('shared service is independent of tools and an injected consumer captures parsed results',async t=>{
  const f=service({provider:'custom',baseUrl:'http://fixture/systemone'})
  t.after(()=>f.ctx.fiber.dispose())
  let body, captured
  t.mock.method(globalThis,'fetch',async(_,init)=>{body=JSON.parse(init.body);return new Response(JSON.stringify(reply))})
  f.ctx.inject(['decisionModels'],ctx=>{captured=ctx.decisionModels})
  await new Promise(resolve=>setImmediate(resolve))
  const result=await captured.ask(request)
  assert.deepEqual(result,{provider:'custom',...reply})
  assert.deepEqual(body,{model:'jev-latest',...request})
  assert.equal(f.ctx.get('tools'),undefined)
})

test('default and explicit providers use their own models and credentials; configured profiles resolve',async t=>{
  const f=service({provider:'native',nativeProvider:'dsh-native',model:'chat',profiles:[{id:'local-judge',provider:'custom',model:'judge',baseUrl:'http://fixture',credential:'LOCAL_REF'}]})
  t.after(()=>f.ctx.fiber.dispose())
  const sent=[]
  t.mock.method(globalThis,'fetch',async(url,init)=>{sent.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify(reply))})
  assert.equal((await f.value.ask({...request,provider:'typesafe'})).provider,'typesafe')
  assert.equal(sent[0].body.model,'jev-latest')
  assert.equal((await f.value.ask({...request,provider:'local-judge',model:'override'})).provider,'local-judge')
  assert.equal(sent[1].url,'http://fixture'); assert.equal(sent[1].body.model,'override')
})

test('Jev tool and shared ask use the same caller',async t=>{
  const f=service({provider:'custom',baseUrl:'http://fixture'})
  t.after(()=>f.ctx.fiber.dispose())
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(reply)))
  const tool=makeTool(null,()=>({}),null,(r,o)=>f.value.ask(r,o))
  const result=await tool.execute(request,{signal:new AbortController().signal})
  assert.deepEqual(result.answers,(await f.value.ask(request)).answers)
  assert.equal(result.provider,'custom'); assert.match(result.text,/q: a/)
})

test('protocol failures reject while business candidate validity is left to consumers',async t=>{
  const f=service({provider:'custom',baseUrl:'http://fixture'})
  t.after(()=>f.ctx.fiber.dispose())
  let body
  t.mock.method(globalThis,'fetch',async()=>new Response(body))
  for(const invalid of ['plain text','{"answers":{},"answers":{}}','{}','{"answers":{"q":{"type":"choice","choice":4}}}']){
    body=invalid; await assert.rejects(f.value.ask(request),/JSON|protocol/)
  }
  body=JSON.stringify({answers:{q:{type:'choice',choice:'unlisted'}}})
  assert.equal((await f.value.ask(request)).answers.q.choice,'unlisted')
})

test('pre-aborted calls never reach transport and cancellation is prompt during retry backoff',async t=>{
  const stopped=new AbortController(); stopped.abort()
  let calls=0
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'20'}})})
  await assert.rejects(callJev({url:'http://fixture',apiKey:'x',...request,signal:stopped.signal}),{name:'AbortError'})
  assert.equal(calls,0)
  const controller=new AbortController()
  const pending=callJev({url:'http://fixture',apiKey:'x',...request,signal:controller.signal})
  await new Promise(resolve=>setTimeout(resolve,5));const started=Date.now();controller.abort()
  await assert.rejects(pending,{name:'AbortError'});assert.ok(Date.now()-started<100);assert.equal(calls,1)
})

test('one deadline covers response body reads and cancellation wins against ignored signals',async t=>{
  const f=service({provider:'custom',baseUrl:'http://fixture',timeoutMs:15})
  t.after(()=>f.ctx.fiber.dispose())
  const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive))
  t.mock.method(globalThis,'fetch',async()=>({ok:true,text:()=>new Promise(()=>{})}))
  await assert.rejects(f.value.ask(request),{name:'TimeoutError'})
  assert.equal(f.value.activeCount,0)
})

test('unload cancels pending calls and removes the service',async t=>{
  const f=service({provider:'custom',baseUrl:'http://fixture'})
  t.mock.method(globalThis,'fetch',()=>new Promise(()=>{}))
  const pending=f.value.ask(request)
  const rejected=assert.rejects(pending,/unloaded/)
  await f.ctx.fiber.dispose();await rejected
  assert.equal(f.ctx.get('decisionModels'),undefined);assert.equal(f.value.activeCount,0)
})

test('ordinary DSH models use the identical questions contract and host credentials',async t=>{
  let options,prepare
  const text=JSON.stringify({answers:reply.answers})
  const llm={async prepareCall(config,signal){prepare=config;return {config,async *stream(input){options=input;yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'usage',usage:{inputTokens:3,outputTokens:1}};yield {type:'finish',reason:{kind:'stop'}}}}}}
  const f=service({provider:'native',nativeProvider:'host-provider',model:'host-model',reasoningEffort:'low'},{llm})
  t.after(()=>f.ctx.fiber.dispose())
  t.mock.method(globalThis,'fetch',()=>{throw Error('native must use DSH llm')})
  const result=await f.value.ask(request)
  assert.deepEqual(result,{provider:'native',model:'host-model',answers:reply.answers,usage:reply.usage})
  assert.equal(prepare.provider,'host-provider');assert.equal(prepare.reasoningEffort,'low')
  assert.deepEqual(options.tools,[])
  assert.deepEqual(JSON.parse(options.messages[0].content[0].text),request)
  assert.ok(options.signal instanceof AbortSignal)
})

test('connection test uses shared ask and the plugin mounts before optional tools',async t=>{
  const ctx=new Context();t.after(()=>ctx.fiber.dispose())
  let requests=0; const routes=[]
  ctx.provide('settings',{installSection(_owner,_ns,_schema,config,handlers){handlers.setSource(()=>config)}})
  ctx.provide('webServer',{register(route){routes.push(route);return ()=>{}}})
  t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(JSON.stringify({answers:{passed:{type:'noul',noul:0},severity:{type:'choice',choice:'fatal'}}}))})
  ctx.provide('credentials',{resolve:async()=>({value:'fixture-key'})})
  await ctx.plugin({name:'jev-service-test',apply},{provider:'custom',baseUrl:'http://fixture',dataDir:'/private/tmp/jev-service-test-ledger'})
  assert.ok(ctx.get('decisionModels'))
  await ctx.get('decisionModels').ask(request)
  assert.equal(requests,1)
  assert.equal(ctx.get('tools'),undefined)
  await new Promise(resolve=>setImmediate(resolve))
  const route=routes.find(r=>r.path.endsWith('/test'));assert.ok(route)
  let output;await route.handler({method:'POST',socket:{remoteAddress:'127.0.0.1'}},{writeHead(){},end(body){output=JSON.parse(body)}})
  assert.equal(output.ok,true);assert.equal(output.value.provider,'custom');assert.equal(requests,2)
})


test('provider overrides resolve the selected provider credential instead of forwarding the default key', async () => {
  const references = []
  const previous = globalThis.fetch
  let authorization
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.authorization
    return {ok:true,status:200,text:async()=>JSON.stringify({answers:{q:{type:'noul',noul:1}}})}
  }
  try {
    const ask = createDecisionCaller(() => ({resolve:async reference => {references.push(reference);return {value:reference === 'JEV_API_KEY' ? 'selected-fixture-key' : 'wrong-default-key'}}}),
      () => ({provider:'typesafe',credential:'DEFAULT_REFERENCE',apiKey:'legacy-default-key',baseUrl:'https://selected.invalid/v1/systemone'}))
    await ask({provider:'custom',state:'Fixture',questions:{q:{type:'noul',instructions:'Question'}}})
    assert.deepEqual(references, ['JEV_API_KEY'])
    assert.equal(authorization, 'Bearer selected-fixture-key')
  } finally {globalThis.fetch = previous}
})

async function catalogBridge(llm, body={}, address='127.0.0.1') {
  const route=makeBridgeRoutes({getLlm:()=>llm}).find(r=>r.path.endsWith('/catalog'));
  const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.socket={remoteAddress:address};
  let status,result;const res={writeHead:code=>{status=code},end:value=>{result=JSON.parse(value)}};
  await route.handler(req,res);return {status,...result};
}
test('settings choices use the registered DSH models and per-model reasoning metadata without generating',async()=>{
  const calls=[];const llm={
    listProviders:()=>[{id:'host',name:'Host',privateField:'do not expose'}],
    listModels:async provider=>{calls.push(provider);return [{id:'fast',name:'Fast'},{id:'plain',name:'Plain'}]},
    resolveModelInfo:async(provider,model)=>model==='fast' ? {reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}} : {},
    prepareCall:()=>{throw Error('Catalog must never generate')},
  };
  const result=await catalogBridge(llm,{provider:'host'});assert.equal(result.status,200);assert.equal(result.ok,true);
  assert.deepEqual(result.value,{providers:[{id:'host',name:'Host'}],provider:'host',models:[{id:'fast',name:'Fast',reasoningEfforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]},{id:'plain',name:'Plain',reasoningEfforts:[]}]});
  assert.deepEqual(calls,['host']);
  assert.deepEqual((await catalogBridge(llm,{provider:'removed'})).value.models,[]);assert.deepEqual(calls,['host']);
});
test('catalog retains bridge access restrictions and rejects malformed provider selection',async()=>{
  let read=false;const llm={listProviders:()=>{read=true;return []}};
  assert.equal((await catalogBridge(llm,{},'100.64.0.1')).status,403);assert.equal(read,false);
  assert.equal((await catalogBridge(llm,{provider:42})).status,400);assert.equal(read,false);
});
test('missing or failed catalog reports availability without exposing provider errors',async()=>{
  const missing=await catalogBridge(undefined);assert.equal(missing.ok,false);assert.match(missing.message,/service unavailable/);
  const result=await catalogBridge({listProviders:()=>{throw Error('private transport detail')}});
  assert.equal(result.ok,false);assert.doesNotMatch(result.message,/private transport/);
});

async function keyBridge(action,body,deps) {
  const route=makeBridgeRoutes(deps).find(r=>r.path.endsWith('/key-'+action));
  const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.socket={remoteAddress:'127.0.0.1'};
  let status,result;await route.handler(req,{writeHead:code=>{status=code},end:value=>{result=JSON.parse(value)}});return {status,...result};
}
test('key operations target the selected provider while saved configuration remains native',async()=>{
  const writes=[],removed=[];const values=new Map();
  const cfg={provider:'native',nativeProvider:'host',model:'chat',credential:'NATIVE_ONLY',profiles:[{id:'judge',provider:'custom',credential:'JUDGE_REF'}]};
  const deps={getConfig:()=>cfg,getSettings:()=>({describe:()=>[{ns:'jev',revision:7}]}),getCredentials:()=>({
    describe:async ref=>({configured:values.has(ref)}),set:async(ref,value)=>{writes.push(ref);values.set(ref,value)},unset:async ref=>{removed.push(ref);values.delete(ref)},
  })};
  const target={provider:'typesafe',expectedRevision:7};
  assert.equal((await keyBridge('set',{...target,value:'fixture-key'},deps)).ok,true);
  assert.deepEqual(writes,['TYPESAFE_API_KEY']);assert.equal(cfg.provider,'native');
  assert.deepEqual((await keyBridge('describe',target,deps)).value,{provider:'typesafe',credential:'TYPESAFE_API_KEY',configured:true,envFallback:!!process.env.TYPESAFE_API_KEY});
  assert.equal((await keyBridge('unset',target,deps)).ok,true);assert.deepEqual(removed,['TYPESAFE_API_KEY']);
  assert.equal((await keyBridge('set',{provider:'judge',expectedRevision:7,value:'fixture-key'},deps)).ok,true);assert.equal(writes.at(-1),'JUDGE_REF');
});
test('key operations reject native ownership, unknown providers and stale configuration before writing',async()=>{
  let wrote=false;const deps={getConfig:()=>({provider:'native',nativeProvider:'host',model:'chat'}),getSettings:()=>({describe:()=>[{ns:'jev',revision:4}]}),getCredentials:()=>({set:async()=>{wrote=true}})};
  for(const [provider,expectedRevision,code] of [['native',4,'provider-owned'],['not-registered',4,'provider-invalid'],['typesafe',3,'settings-conflict']]) {
    const result=await keyBridge('set',{provider,expectedRevision,value:'fixture-key'},deps);assert.equal(result.ok,false);assert.equal(result.code,code);
  }
  assert.equal(wrote,false);
});
