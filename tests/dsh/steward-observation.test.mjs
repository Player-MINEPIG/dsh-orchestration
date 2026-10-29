import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {createNativeHarness} from './native-harness.mjs';
import {canonical} from '../../packages/task-system/dist/ledger.js';

test('steward records exact native request hashes with bounded provenance, without storing a second raw transcript', {timeout:15000}, async()=>{
  const h=await createNativeHarness({config:{role:'both',schedulerEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});
  try {
    const service=h.ctx.taskSystem.steward,projects=h.ctx.taskSystem.projects;
    projects.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});
    const {projectId}=await projects.create({commandId:'audit-project',title:'Audit project',goal:'AUDIT_PROJECT_ONLY'});
    for(const [commandId,text,target] of [
      ['audit-personal','AUDIT_PERSONAL_ONLY',{kind:'personal'}],
      ['audit-project-turn','AUDIT_PROJECT_INPUT',{kind:'project',projectId}],
    ]){
      h.adapter.script.push(`response:${commandId}`);
      await service.send({conversationId:'main',commandId,text,target});
      const deadline=Date.now()+5000;
      while(Date.now()<deadline){
        const snapshot=await service.reconcile({conversationId:'main'});
        if(snapshot.messages.some(message=>message.text===`response:${commandId}`))break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    }
    const snapshot=service.snapshot({conversationId:'main'});
    assert.equal(h.adapter.requests.length,2);
    assert.equal(snapshot.requests.length,2,'Each actual native step has durable evidence');
    assert.equal(snapshot.requestObservation.kind,'active');
    for(let i=0;i<2;i++){
      const evidence=snapshot.requests[i],request=h.adapter.requests[i];
      assert.equal(evidence.messageHash,createHash('sha256').update(canonical(request.messages)).digest('hex'));
      const {signal,...requestFields}=request;
      assert.equal(evidence.requestHash,createHash('sha256').update(canonical(requestFields)).digest('hex'));
      assert.equal(evidence.source.sessionId,request.sessionId);
      assert.equal(evidence.personaObserved,true,'Configured persona must actually appear, not just be selected');
      assert.equal(evidence.assemblerObserved,false);
      assert.equal(evidence.assemblyHash,null);
      assert.ok(evidence.stepSeq>=0);
      assert.equal(evidence.selectedResources[0].id,'dsh-steward');
    }
    assert.doesNotMatch(JSON.stringify(snapshot.requests),/AUDIT_PERSONAL_ONLY|AUDIT_PROJECT_INPUT|AUDIT_PROJECT_ONLY/);
    const before=snapshot.requests.map(request=>request.id);
    await service.send({conversationId:'main',commandId:'audit-personal',text:'AUDIT_PERSONAL_ONLY',target:{kind:'personal'}});
    assert.deepEqual(service.snapshot({conversationId:'main'}).requests.map(request=>request.id),before);
    assert.equal(h.adapter.requests.length,2,'Receipt replay does not manufacture request evidence');
  }finally{await h.dispose();}
});
