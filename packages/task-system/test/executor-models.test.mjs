import test from 'node:test';
import assert from 'node:assert/strict';
import {executorModelRoutes} from '../dist/executor-models.js';
const grant=(model,reasoningEffort)=>({nodeId:'test',provider:'installed',model,...(reasoningEffort?{reasoningEffort}:{}),requiredCapabilities:[]});
test('executor advertises installed models and efforts within grants; provider unloading withdraws candidates',async()=>{
 let models=['one','two'],providers=[{id:'installed'}];
 const llm={listProviders:()=>providers,listModels:async()=>models.map(id=>({id})),resolveModelInfo:async()=>({reasoning:{efforts:[{id:'high'}]}})};
 const grants=[grant('one','high'),grant('one','low'),grant('missing','high')];
 assert.deepEqual(await executorModelRoutes(llm,grants),[grant('one','high')]);
 models=['two'];assert.deepEqual(await executorModelRoutes(llm,grants),[]);
 models=['one'];providers=[];assert.deepEqual(await executorModelRoutes(llm,grants),[]);
});
test('unavailable catalogs never fall back to static names; explicit CLI backends remain separate',async()=>{
 const backend={...grant('cli','high'),backend:'official-cli'};
 assert.deepEqual(await executorModelRoutes(undefined,[grant('one'),backend]),[backend]);
 const llm={listProviders:()=>[{id:'installed'}],listModels:async()=>{throw Error('offline')}};
 assert.deepEqual(await executorModelRoutes(llm,[grant('one')]),[]);
});
test('stalled model discovery is bounded and cannot block the next heartbeat',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const llm={listProviders:()=>[{id:'installed'}],listModels:()=>new Promise(()=>{})};
 const reading=executorModelRoutes(llm,[grant('one')]);t.mock.timers.tick(3000);
 assert.deepEqual(await reading,[]);
});
