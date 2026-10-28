import test from 'node:test';
import assert from 'node:assert/strict';
import {askTaskDecision} from '../dist/decision-call.js';
import {TaskLedger} from '../dist/ledger.js';
import {TaskPlanner,taskDecisionCatalog} from '../dist/planning.js';
const request={requestId:'fixture',stateHash:'fixture-state',context:{background:'Caller-owned evidence'},questions:[{questionId:'fixed',questionVersion:'1',type:'choice',instructions:'Only one eligible option',candidates:{only:'Only'}},{questionId:'pick',questionVersion:'2',type:'choice',instructions:'Choose',candidates:{a:'A',b:'B'}}]};
test('caller supplies background and wire criteria, resolves singleton options and owns request binding',async()=>{
 let sent;const result=await askTaskDecision({ask:async input=>{sent=input;return {provider:'test',model:'judge',answers:{pick:{type:'choice',choice:'a'}}};}},request);
 assert.deepEqual(JSON.parse(sent.state),request.context);assert.deepEqual(Object.keys(sent.questions),['pick']);assert.deepEqual(sent.questions.pick.criteria,{a:'A',b:'B'});
 assert.deepEqual(result.answers.fixed,{type:'choice',choice:'only'});assert.equal(result.requestId,'fixture');assert.equal(result.questionVersions.pick,'2');
 assert.equal(Object.hasOwn(sent,'requestId'),false);assert.equal(Object.hasOwn(sent,'stateHash'),false);
});
test('observation consumer catches model failures without executing and replay never repeats the request',async t=>{
 const ledger=TaskLedger.open(':memory:');t.after(()=>ledger.close());let calls=0;
 const planner=new TaskPlanner(ledger,{ask:async()=>{calls++;throw Error('private model error');}},()=>taskDecisionCatalog(ledger,{}),()=>{});
 const input={requestId:'intent',title:'Work',description:'Request',observationCandidateId:'fixture-observation'};
 const first=await planner.plan(input);assert.equal(first.proposal.kind,'abstain');assert.equal(first.receipt.status,'abstained');
 await planner.plan(input);assert.equal(calls,1);assert.equal(ledger.snapshot().runs.length,0);assert.equal(ledger.snapshot().attempts.length,0);
 assert.throws(()=>planner.apply('intent'),/clarification/);assert.equal(JSON.stringify(first).includes('private model error'),false);
});
test('observation consumer rejects business-invalid choices even when model protocol parsing succeeded',async t=>{
 const ledger=TaskLedger.open(':memory:');t.after(()=>ledger.close());
 const planner=new TaskPlanner(ledger,{ask:async input=>({provider:'test',model:'judge',answers:Object.fromEntries(Object.keys(input.questions).map(id=>[id,{type:'choice',choice:'invented'}]))})},()=>taskDecisionCatalog(ledger,{}),()=>{});
 const result=await planner.plan({requestId:'invalid-candidate',title:'No unauthorized execution',description:'',observationCandidateId:'fixture-observation'});
 assert.equal(result.proposal.kind,'abstain');assert.equal(result.receipt.status,'answered');assert.equal(ledger.snapshot().runs.length,0);
});
test('cancellation propagates instead of being persisted as a fallback answer',async()=>{
 const controller=new AbortController();const service={ask:async()=>{controller.abort();throw controller.signal.reason;}};
 await assert.rejects(askTaskDecision(service,request,{signal:controller.signal}),{name:'AbortError'});
});
