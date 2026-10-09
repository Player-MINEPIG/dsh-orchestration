import test from 'node:test';import assert from 'node:assert/strict';import {migrateDecisionConfig} from '../../../scripts/migrate-decision-config.mjs';
test('native model presets and consumer bindings migrate without reading credentials or copying business state',()=>{
 const d={defaultProvider:'ordinary',presets:[{id:'native-work',name:'Judge',provider:'ordinary',model:'selector',reasoningEffort:'high'}],defaultPreset:'native-work',bindings:{'task-session':'native-work'},providers:[{id:'ordinary',kind:'structured',models:[{model:'selector',version:'host-model'}]}]};
 const migrated=migrateDecisionConfig(d,{routes:[{model:'selector',modelVersion:'host-model',provider:'host'}]},{sessionDecisionEnabled:true});
 assert.equal(migrated.jev.provider,'native');assert.equal(migrated.jev.model,'host-model');assert.equal(migrated.jev.nativeProvider,'host');assert.equal(migrated.jev.reasoningEffort,'high');assert.equal(migrated.taskChanges.decisionBindings['task-session'],'native-work');assert.equal(migrated.taskChanges.sessionDecisionEnabled,undefined);
 assert.equal(JSON.stringify(migrated).includes('requestId'),false);
});
test('empty rules preserve deterministic caller defaults; active rules block an automatic switch',()=>{
 const empty=migrateDecisionConfig({defaultProvider:'rules',providers:[{id:'rules',kind:'rules',rules:[]}]});assert.equal(empty.taskChanges.sessionDecisionEnabled,false);assert.equal(empty.taskChanges.planningDecisionEnabled,false);
 assert.throws(()=>migrateDecisionConfig({defaultProvider:'rules',providers:[{id:'rules',kind:'rules',rules:[{questionId:'session'}]}]}),/business-side/);
});
test('Jev-compatible configuration migrates endpoint and credential references, never key values',()=>{
 const r=migrateDecisionConfig({defaultProvider:'custom',providers:[{id:'custom',kind:'compatible',endpoint:'https://fixture/systemone',model:'judge',apiKeyEnv:'EXISTING_REFERENCE',apiKey:'must-not-copy'}]});
 assert.equal(r.jev.baseUrl,'https://fixture/systemone');assert.equal(r.jev.credential,'EXISTING_REFERENCE');assert.equal(JSON.stringify(r).includes('must-not-copy'),false);
});
