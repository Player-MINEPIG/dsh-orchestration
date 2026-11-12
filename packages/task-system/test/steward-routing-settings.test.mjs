import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {StewardRoutingSettings} from '../dist/steward-routing-settings.js';
import {topicActiveAt,topicCutoff} from '../dist/steward-topic-activity.js';

function fixture() {
 const db=new DatabaseSync(':memory:');
 const groups=[{id:'native',name:'Native',models:[{id:'deepseek-flash',name:'Flash',reasoning:{efforts:[{id:'none',name:'None'},{id:'high',name:'High'}]}}]},
  {id:'gateway',name:'Gateway',models:[{id:'group/gpt-ds-eco',name:'Eco',reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}}]}];
 let days=30;
 const service=new StewardRoutingSettings({managementDatabase:()=>db},async()=>({groups,default:{provider:'pm',model:'large'},routableProviders:['native','gateway'],failures:[]}),()=>true,()=>days);
 return {db,service,groups,setDays:value=>{days=value}};
}
test('unset and previously automatic null preferences never choose or persist a catalog model and share the active window',async()=>{
 const f=fixture();try {
  const assertUnset=async()=>{const value=await f.service.read();assert.equal(value.configuredFallback,null);assert.equal(value.fallback,null);assert.equal(value.source,'unset');return value;};
  assert.equal((await assertUnset()).activeDays,30);f.setDays(7);assert.equal((await assertUnset()).activeDays,7);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM steward_routing_settings').get().n,0);
  f.db.prepare('INSERT INTO steward_routing_settings VALUES(?,?)').run('global',JSON.stringify({revision:4,fallback:null}));
  assert.equal((await assertUnset()).revision,4);f.groups.reverse();await assertUnset();f.groups.length=0;await assertUnset();
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT data FROM steward_routing_settings').get().data),{revision:4,fallback:null});
 }finally{f.db.close()}
});
test('routing preferences are validated, revisioned and idempotent independently of PM or JEV configuration',async()=>{
 const f=fixture();try {
  const request={commandId:'pick',expectedRevision:0,fallback:{provider:'native',model:'deepseek-flash',reasoningEffort:'high'}};
  const picked=await f.service.configure(request);assert.equal(picked.revision,1);assert.deepEqual(picked.fallback,request.fallback);
  assert.equal((await f.service.configure(request)).revision,1);
  await assert.rejects(f.service.configure({...request,fallback:null}),{code:'CONFLICT'});
  await assert.rejects(f.service.configure({commandId:'stale',expectedRevision:0,fallback:null}),{code:'CONFLICT'});
  await assert.rejects(f.service.configure({commandId:'unknown',expectedRevision:1,fallback:{provider:'pm',model:'large'}}),{code:'CONFIGURATION'});
  await assert.rejects(f.service.configure({commandId:'effort',expectedRevision:1,fallback:{provider:'native',model:'deepseek-flash',reasoningEffort:'invalid'}}),{code:'CONFIGURATION'});
  f.groups[0].models.length=0;const missing=await f.service.read();assert.equal(missing.fallback,null);assert.equal(missing.source,'unavailable');assert.deepEqual(missing.configuredFallback,request.fallback);
  const reset=await f.service.configure({commandId:'reset',expectedRevision:1,fallback:null});assert.equal(reset.configuredFallback,null);assert.equal(reset.fallback,null);assert.equal(reset.source,'unset');assert.equal(reset.revision,2);assert.equal((await f.service.configure({commandId:'reset',expectedRevision:1,fallback:null})).revision,2);
 }finally{f.db.close()}
});
test('the shared activity boundary includes exactly the cutoff and excludes earlier, future and unknown activity',()=>{
 const now='2030-02-01T00:00:00.000Z',cutoff=topicCutoff(now,30);
 assert.equal(topicActiveAt(cutoff,now,30),true);assert.equal(topicActiveAt('2030-01-01T23:59:59.999Z',now,30),false);
 assert.equal(topicActiveAt(now,now,30),true);assert.equal(topicActiveAt('2030-02-01T00:00:00.001Z',now,30),false);assert.equal(topicActiveAt(null,now,30),false);
});
