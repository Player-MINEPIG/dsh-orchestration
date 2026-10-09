import test from 'node:test';
import assert from 'node:assert/strict';
import {readDecisionSettings,saveDecisionSettings} from '../dist/decision-settings.js';
import {readDecisionPreferences,saveDecisionPreference} from '../dist/decision-preferences.js';
function fixture() {
 const raw={decisionBindings:{'task-planning':'local'},other:'preserved'};
 const task={config:raw};let writes=0;
 const entry={options:{id:'task-system',name:'@dsh-task/task-system/plugin',config:raw}};
 const services={taskSystem:task,decisionModels:{config:()=>({provider:'native',nativeProvider:'host',model:'judge',profiles:[{id:'local',name:'Local decision model',provider:'native',nativeProvider:'host',model:'judge'}]})},configEditor:{entries:()=>[entry],async edit(e,change){Object.assign(raw,change(structuredClone(raw)));writes++;}},profileContext:{overlays:[]}};
 return {ctx:{get:key=>services[key]},services,raw,writes:()=>writes};
}
test('task preferences select model profiles; provider configuration remains owned by JEV',async()=>{
 const f=fixture();const view=await readDecisionSettings(f.ctx);assert.equal(view.available,true);assert.equal(view.writable,false);assert.equal(view.snapshot.defaultProvider,'native');
 await assert.rejects(saveDecisionSettings(f.ctx,{expected:view.snapshot,selection:{kind:'rules',providerId:'unused'}}),/Plugins → Jev/);
 const preferences=readDecisionPreferences(f.ctx);assert.equal(preferences.bindings['task-planning'],'local');assert.equal(preferences.presets[0].id,'local');
 await saveDecisionPreference(f.ctx,{expected:preferences.revision,consumer:'task-planning',id:''});assert.equal(f.raw.decisionBindings['task-planning'],'');assert.equal(f.raw.other,'preserved');assert.equal(f.writes(),1);
});
test('stale or unknown profile selections and overlay-owned config never overwrite preferences',async()=>{
 const f=fixture(),view=readDecisionPreferences(f.ctx);
 await assert.rejects(saveDecisionPreference(f.ctx,{expected:'stale',consumer:'task-session',id:'local'}),/DECISION_CONFLICT/);
 await assert.rejects(saveDecisionPreference(f.ctx,{expected:view.revision,consumer:'task-session',id:'missing'}),/DECISION_PROFILE_MISSING/);
 f.services.profileContext.overlays=[{id:'task-system',config:{}}];
 await assert.rejects(saveDecisionPreference(f.ctx,{expected:view.revision,consumer:'task-session',id:'local'}),/DECISION_OVERRIDE/);assert.equal(f.writes(),0);
});
test('absence of the optional JEV service is explicit and leaves caller deterministic defaults usable',async()=>{
 const f=fixture();delete f.services.decisionModels;assert.equal((await readDecisionSettings(f.ctx)).available,false);assert.equal(readDecisionPreferences(f.ctx).writable,false);
});
