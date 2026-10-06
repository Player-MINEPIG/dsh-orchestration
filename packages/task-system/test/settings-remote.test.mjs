import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

let ui;
vm.runInNewContext(readFileSync(new URL('../src/settings-client.js',import.meta.url),'utf8'), {
  structuredClone, window:{__ModuleLoader__:{load(row){ui=row.factory(()=>({}));}}},
});
const view=(revision=1)=>({ns:'task-system',revision,value:{maxConcurrent:1,autoExecute:false,nodeId:'private-node'},base:{maxConcurrent:1},user:{}});
test('remote task settings read Host values, narrow fields and send exact revision-fenced writes',async()=>{
  const calls=[];let current=view();
  const scope=new ui.RemoteTaskSettingsScope({describe:async()=>({ok:true,value:{writable:true,namespaces:[current]}}),mutate:async(...args)=>{calls.push(args);current={...current,revision:2,value:{...current.value,maxConcurrent:2},user:{maxConcurrent:2}};return {ok:true,value:current};}});
  let mounted=0,unmounted=0;
  const off=scope.whileServed(()=>{mounted++;return ()=>unmounted++;});
  await scope.load();
  assert.equal(mounted,1);assert.equal(scope.getSnapshot().value.nodeId,undefined);
  assert.equal(await scope.mutate([{op:'set',path:['maxConcurrent'],value:2}],1),true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['task-system',[{op:'set',path:['maxConcurrent'],value:2}],1]]);
  assert.equal(scope.getSnapshot().revision,2);
  off();assert.equal(unmounted,1);await scope.dispose();
});
test('remote adapter cannot write identity, nested fields, invalid types or ranges',async()=>{
  let writes=0;
  const scope=new ui.RemoteTaskSettingsScope({describe:async()=>({ok:true,value:{writable:true,namespaces:[view()]}}),mutate:async()=>{writes++;}});
  await scope.load();
  for(const op of [
    {op:'set',path:['nodeId'],value:'other'},
    {op:'set',path:['maxConcurrent','nested'],value:2},
    {op:'set',path:['maxConcurrent'],value:'2'},
    {op:'set',path:['maxConcurrent'],value:33},
    {op:'set',path:['autoExecute'],value:'true'},
  ]) assert.equal(await scope.mutate([op],1),false);
  assert.equal(writes,0);await scope.dispose();
});
test('rejected writes refresh authoritative state; failed reads retain it without permitting saves',async()=>{
  let current=view(),failRead=false;
  const scope=new ui.RemoteTaskSettingsScope({describe:async()=>failRead?{ok:false}:{ok:true,value:{writable:true,namespaces:[current]}},mutate:async()=>{current=view(3);return {ok:false,error:{code:'conflict'}};}});
  await scope.load();
  assert.equal(await scope.mutate([{op:'set',path:['maxConcurrent'],value:2}],1),false);
  assert.equal(scope.getSnapshot().revision,3);
  failRead=true;await scope.load();
  assert.equal(scope.getSnapshot().value.maxConcurrent,1);assert.equal(scope.getSnapshot().writable,false);
  failRead=false;await scope.load();assert.equal(scope.getSnapshot().writable,true);
  await scope.dispose();assert.equal(await scope.mutate([{op:'unset',path:['maxConcurrent']}],3),false);
});
test('missing Host namespace and read-only responses do not enable writes',async()=>{
  let namespace=false,writes=0;
  const scope=new ui.RemoteTaskSettingsScope({describe:async()=>({ok:true,value:{writable:false,namespaces:namespace?[view()]:[]}}),mutate:async()=>{writes++;}});
  await scope.load();assert.equal(scope.getSnapshot().status,'unavailable');
  namespace=true;await scope.load();assert.equal(scope.getSnapshot().status,'ready');
  assert.equal(await scope.mutate([{op:'unset',path:['maxConcurrent']}],1),false);
  assert.equal(writes,0);await scope.dispose();
});
