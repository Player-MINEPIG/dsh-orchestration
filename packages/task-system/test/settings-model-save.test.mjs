import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ExecutionModels} from '../dist/execution-models.js';
const {TaskPluginSettings}=await import(process.env.DSH_SETTINGS_MODULE ?? '../dist/settings.js');
const choice={provider:'aws-vps-magpie',model:'group/gpt-ds-eco'};
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  let now=Date.now(),generation=0,refreshes=0;
  const models=new ExecutionModels(db,{now:()=>now});
  const publish=(modelsList=[choice],complete=true)=>{
    const id=String(++generation),request=models.request('r'+id,{nodeId:'worker'}).catalog.request;
    return models.complete('c'+id,{nodeId:'worker',requestId:request.requestId,generation:request.generation,result:{state:'success',observedAt:now,complete,models:modelsList}});
  };
  let current;
  const authority={executionModels:models,getNode:()=>({enabled:true}),schedulerIdentity:()=> 'scheduler',refreshNodeModels:async()=>{refreshes++;return publish();}};
  current=authority;
  const settings=Object.create(TaskPluginSettings.prototype);
  Object.defineProperty(settings,'ctx',{value:{get:()=>({config:{role:'planner',nodeId:'scheduler'},ledger:current})}});
  const first=publish();
  const input={nodeId:'worker',expectedRevision:0,expectedCatalogRevision:first.catalog.positiveSnapshot.revision,choice};
  return {models,authority,settings,input,publish,expire:()=>{now=Date.now()-120000;publish();now=Date.now();},refreshes:()=>refreshes,replaceAuthority:()=>{current={...authority};}};
}
const rejects=(promise,code)=>assert.rejects(promise,error=>error.details?.reason===code);
test('expired catalog save refreshes and saves the exact user tuple without reselection',async t=>{
 const f=fixture(t);f.expire();const result=await f.settings.saveNodeModelDefault(f.input);
 assert.equal(f.refreshes(),1);assert.deepEqual(result.policy.choice,choice);assert.equal(result.policy.revision,1);
});
test('background catalog revision changes use current exact positive evidence without a refresh',async t=>{
 const f=fixture(t);f.publish();const result=await f.settings.saveNodeModelDefault(f.input);
 assert.equal(f.refreshes(),0);assert.deepEqual(result.policy.choice,choice);
});
test('refresh failure and partial omission preserve policy and do not claim model disappearance',async t=>{
 for(const mode of ['failure','partial']){
  const f=fixture(t);f.expire();f.authority.refreshNodeModels=async()=>mode==='failure'?f.models.view('worker'):f.publish([],false);
  await rejects(f.settings.saveNodeModelDefault(f.input),mode==='failure'?'EXECUTION_CATALOG_STALE':'EXECUTION_CATALOG_UNCONFIRMED');
  assert.equal(f.models.view('worker').policy.revision,0);
 }
});
test('fresh complete disappearance rejects the original selection without fallback',async t=>{
 const f=fixture(t);f.expire();f.authority.refreshNodeModels=async()=>f.publish([]);
 await rejects(f.settings.saveNodeModelDefault(f.input),'EXECUTION_MODEL_UNAVAILABLE');assert.equal(f.models.view('worker').policy.choice,undefined);
});
test('concurrent policy modification during refresh retains CAS protection',async t=>{
 const f=fixture(t);f.expire();f.authority.refreshNodeModels=async()=>{const view=f.publish();f.models.setDefault('other',{...f.input,expectedCatalogRevision:view.catalog.positiveSnapshot.revision});return f.models.view('worker');};
 await rejects(f.settings.saveNodeModelDefault(f.input),'EXECUTION_MODEL_POLICY_CONFLICT');assert.equal(f.models.view('worker').policy.revision,1);
});
test('authority change during refresh cannot commit to the old scheduler',async t=>{
 const f=fixture(t);f.expire();f.authority.refreshNodeModels=async()=>{const view=f.publish();f.replaceAuthority();return view;};
 await rejects(f.settings.saveNodeModelDefault(f.input),'EXECUTION_MODEL_AUTHORITY_CHANGED');assert.equal(f.models.view('worker').policy.revision,0);
});

test('partial fresh positive evidence confirms the exact tuple after refresh',async t=>{
 const f=fixture(t);f.expire();f.authority.refreshNodeModels=async()=>f.publish([choice],false);
 assert.deepEqual((await f.settings.saveNodeModelDefault(f.input)).policy.choice,choice);
});
test('same ledger with changed scheduler identity rejects a refreshed save',async t=>{
 const f=fixture(t);f.expire();f.authority.refreshNodeModels=async()=>{const view=f.publish();f.authority.schedulerIdentity=()=> 'different-scheduler';return view;};
 await rejects(f.settings.saveNodeModelDefault(f.input),'EXECUTION_MODEL_AUTHORITY_CHANGED');assert.equal(f.models.view('worker').policy.revision,0);
});
