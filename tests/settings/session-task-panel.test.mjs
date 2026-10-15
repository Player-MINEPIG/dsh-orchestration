import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
let ui;
vm.runInNewContext(readFileSync(new URL('../../packages/task-system/dist/settings-client.js',import.meta.url),'utf8'),{
  window:{__ModuleLoader__:{load(row){ui=row.factory(()=>({}));}}},
});
const snapshot=id=>({sessionId:id,tasks:[],runs:[],counts:{all:0}});
test('conversation tab is registered with session identity and is disposed with the plugin',()=>{
  let registration, component, removed=false;
  const invoke=()=>{};
  const off=ui.mountSessionTaskPanel({slots:{inject(name,fn){assert.equal(name,'conversation.view');return fn();},register(row,view){registration=row;component=view;return()=>removed=true;}}},invoke);
  assert.equal(registration.label(),'任务'); assert.equal(registration.order,20);
  assert.equal(registration.inject('session-one').sessionId,'session-one');
  assert.equal(registration.inject('session-two').invoke,invoke);
  assert.equal(component,ui.SessionTaskPanel); off(); assert.equal(removed,true);
});
test('refresh is single-flight, preserves previous data on failure and ignores responses after leaving the session',async()=>{
  let resolve, reject, calls=0;
  const monitor=new ui.SessionTaskMonitor(()=>{calls++;return new Promise((yes,no)=>{resolve=yes;reject=no;});},'one');
  const first=monitor.load(); await monitor.load(); assert.equal(calls,1);
  resolve(snapshot('one'));await first;const previous=monitor.snapshot().value;
  const next=monitor.load();reject(Error('offline'));await next;
  assert.equal(monitor.snapshot().value,previous);assert.ok(monitor.snapshot().error);
  const late=monitor.load();monitor.dispose();resolve({...snapshot('one'),tasks:[{id:'late'}]});await late;
  assert.equal(monitor.snapshot().value,previous);
});
test('a response for another session is never displayed',async()=>{
  const monitor=new ui.SessionTaskMonitor(async()=>snapshot('other'),'one');
  await monitor.load();assert.equal(monitor.snapshot().value,null);assert.ok(monitor.snapshot().error);
});
