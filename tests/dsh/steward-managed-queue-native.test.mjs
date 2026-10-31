import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
import {ScriptedModel} from './scripted-model.mjs';

const config={role:'both',schedulerEnabled:false,autoExecute:false,projectAgentOptions:{provider:'test-offline',model:'script'}};
async function until(read,reason){const end=Date.now()+15000;while(Date.now()<end){const value=await read();if(value)return value;await new Promise(done=>setTimeout(done,10));}throw Error(reason);}
const input=(id,text,projectId)=>({conversationId:'main',commandId:id,text,target:{kind:'project',projectId}});
const own=(state,id)=>state.messages.find(message=>message.commandId===id);
const latest=options=>options.messages.findLast(message=>message.role==='user'&&message.source?.kind!=='runtime-context');
const text=user=>user.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
function barrier(){let release;const promise=new Promise(done=>release=done);return{promise,release};}
async function waitBarrier(gate,signal){let stop;const aborted=new Promise((_,reject)=>{stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});try{await Promise.race([gate.promise,aborted]);}finally{signal.removeEventListener('abort',stop);}}
async function projects(h){const runtime=h.ctx.taskSystem.projects;runtime.saveSettings({root:join(h.dir,'projects'),expectedRevision:0});const a=await runtime.create({commandId:'queue-a',title:'Queue A',goal:'A context'}),b=await runtime.create({commandId:'queue-b',title:'Queue B',goal:'B context'});return{runtime,a,b,service:h.ctx.taskSystem.steward};}
async function done(service,id){return until(async()=>{const state=await service.reconcile({conversationId:'main'});return own(state,id)?.state.kind==='completed'&&state;},'Native command did not complete: '+id);}
async function nativeInputs(h,sid){const handle=await h.ctx.sessionPersistence.open(SessionId(sid),'read');try{return(await handle.read()).events.filter(event=>event.type==='user/message').map(event=>event.data.source.rpcId);}finally{await handle.close();}}

test('managed A1 runs while A2/A3 persist queued, B proceeds independently, and every reply stays bound to its own native request', {timeout:30000},async()=>{
  const h=await createNativeHarness({config}),gate=barrier();
  try{
    const {runtime,a,b,service}=await projects(h),db=h.ledger.managementDatabase(),arrived=[];
    const aSession=runtime.placementProject(a.projectId).session;
    const original=h.ctx.agents.resume.bind(h.ctx.agents);
    h.ctx.agents.resume=async options=>{const row=db.prepare("SELECT state FROM pr_turns WHERE session=? AND state='running'").get(options.resumeSessionId);assert.equal(row?.state,'running','queued must become running before the first native resume call');return original(options);};
    h.adapter.stream=async function*(options){this.requests.push(options);const user=latest(options),body=text(user);arrived.push({sessionId:options.sessionId,rpcId:user.source.rpcId,text:body});if(body==='A1')await waitBarrier(gate,options.signal);yield*new ScriptedModel(['ANSWER:'+body]).stream(options);};
    const first=await service.send(input('a1','A1',a.projectId));await until(()=>arrived.some(item=>item.text==='A1'),'A1 reached the actual model');
    const second=await service.send(input('a2','A2',a.projectId)),third=await service.send(input('a3','A3',a.projectId));
    assert.equal(own(second,'a2').state.kind,'queued');assert.equal(own(third,'a3').state.kind,'queued');
    for(const id of ['a2','a3'])assert.deepEqual({...db.prepare('SELECT state,native_admission FROM pr_turns WHERE command=?').get('steward-'+own(third,id).id)},{state:'queued',native_admission:'not-started'});
    const replay=await service.send(input('a2','A2',a.projectId));assert.equal(own(replay,'a2').id,own(second,'a2').id);
    await assert.rejects(async()=>service.send(input('a2','changed',a.projectId)),error=>error.code==='CONFLICT');
    await assert.rejects(runtime.handoff(a.projectId),error=>error.code==='BUSY');
    await service.send(input('b1','B1',b.projectId));await done(service,'b1');
    assert.deepEqual(arrived.filter(item=>item.sessionId===aSession).map(item=>item.text),['A1']);
    assert.deepEqual((await nativeInputs(h,aSession)).filter(Boolean),['steward-'+own(first,'a1').id]);
    gate.release();const final=await done(service,'a3');
    assert.deepEqual(arrived.filter(item=>item.sessionId===aSession).map(item=>item.text),['A1','A2','A3']);
    for(const id of ['a1','a2','a3','b1']){const user=own(final,id),answer=final.messages.find(message=>message.text==='ANSWER:'+user.text);assert.equal(answer.replyTo,user.id);assert.deepEqual(answer.scope,user.scope);}
    assert.deepEqual((await nativeInputs(h,aSession)).filter(Boolean),['a1','a2','a3'].map(id=>'steward-'+own(final,id).id));
  }finally{gate.release();await h.dispose();}
});

test('pre-native failure is not queued, admitted interruption blocks its owner until explicit idle reconciliation, and pending work survives restart', {timeout:40000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-managed-queue-')),gate=barrier();let h=await createNativeHarness({dir,config}),held;
  try{
    let {runtime,a,b,service}=await projects(h);let db=h.ledger.managementDatabase();
    const aOwner=runtime.placementProject(a.projectId),bOwner=runtime.placementProject(b.projectId);
    const resume=h.ctx.agents.resume.bind(h.ctx.agents);
    h.ctx.agents.resume=async options=>{if(options.resumeSessionId===aOwner.session)throw Error('Synthetic native preparation failure');return resume(options);};
    await service.send(input('before-native','FAIL_BEFORE',a.projectId));
    const rejected=await until(async()=>{const state=await service.reconcile({conversationId:'main'});return own(state,'before-native')?.state.kind==='rejected'&&own(state,'before-native');},'A known pre-native failure remained queued');
    assert.equal(h.adapter.requests.length,0);assert.equal(db.prepare('SELECT native_admission FROM pr_turns WHERE command=?').get('steward-'+rejected.id).native_admission,'not-started');
    for(let i=0;i<101;i++)await service.send(input('preparation-failure-'+i,'FAIL_BEFORE_'+i,a.projectId));
    await service.reconcile({conversationId:'main'});
    assert.equal(service.store.commandMessage('main','preparation-failure-100').state.kind,'rejected');
    assert.equal(h.adapter.requests.length,0);
    h.ctx.agents.resume=resume;
    h.adapter.stream=async function*(options){this.requests.push(options);const body=text(latest(options));if(body==='UNKNOWN_A1'||body==='EXTERNAL_HOLD')await waitBarrier(gate,options.signal);yield*new ScriptedModel(['ANSWER:'+body]).stream(options);};
    const started=await service.send(input('unknown-a1','UNKNOWN_A1',a.projectId));
    await until(()=>h.adapter.requests.some(request=>text(latest(request))==='UNKNOWN_A1'),'A1 was not natively admitted');
    assert.equal(db.prepare('SELECT native_admission FROM pr_turns WHERE command=?').get('steward-'+own(started,'unknown-a1').id).native_admission,'started');
    const aQueued=await service.send(input('after-unknown','A2_AFTER_UNKNOWN',a.projectId));assert.equal(own(aQueued,'after-unknown').state.kind,'queued');
    held=await h.ctx.agents.resume({resumeSessionId:SessionId(bOwner.session),agentOptions:{provider:'test-offline',model:'script'}});
    held.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'EXTERNAL_HOLD'}]}));
    await until(()=>h.adapter.requests.some(request=>text(latest(request))==='EXTERNAL_HOLD'),'External B turn did not become busy');
    const bQueued=await service.send(input('restart-queued','B_QUEUED_BEFORE_RESTART',b.projectId));assert.equal(own(bQueued,'restart-queued').state.kind,'queued');
    assert.equal(db.prepare('SELECT state FROM pr_turns WHERE command=?').get('steward-'+own(bQueued,'restart-queued').id).state,'queued');
    await held.dispose();held=null;await h.dispose();
    h=await createNativeHarness({dir,config});runtime=h.ctx.taskSystem.projects;service=h.ctx.taskSystem.steward;db=h.ledger.managementDatabase();
    const seen=[];h.adapter.stream=async function*(options){this.requests.push(options);seen.push(text(latest(options)));yield*new ScriptedModel(['ANSWER:'+seen.at(-1)]).stream(options);};
    await done(service,'restart-queued');
    assert.deepEqual(seen,['B_QUEUED_BEFORE_RESTART']);
    let blocked=await service.reconcile({conversationId:'main'}),unknown=own(blocked,'unknown-a1');
    assert.equal(unknown.state.kind,'needs-reconciliation');assert.equal(own(blocked,'after-unknown').state.kind,'queued');
    assert.equal(db.prepare('SELECT state FROM pr_turns WHERE command=?').get('steward-'+unknown.id).state,'interrupted');
    await service.resolve({conversationId:'main',messageId:unknown.id,commandId:'human-ended-unknown-wait',expectedRevision:unknown.revision,expectedState:'needs-reconciliation',confirm:true});
    const finished=await done(service,'after-unknown');
    assert.deepEqual(seen,['B_QUEUED_BEFORE_RESTART','A2_AFTER_UNKNOWN']);
    assert.equal(own(finished,'unknown-a1').state.kind,'released');
    assert.deepEqual({...db.prepare('SELECT state,error,native_admission FROM pr_turns WHERE command=?').get('steward-'+unknown.id)},{state:'failed',error:'WAIT_ENDED_OUTCOME_UNCONFIRMED',native_admission:'started'});
    const aInputs=(await nativeInputs(h,aOwner.session)).filter(Boolean);
    assert.equal(aInputs.filter(id=>id==='steward-'+unknown.id).length,1);assert.equal(aInputs.filter(id=>id==='steward-'+own(finished,'after-unknown').id).length,1);
    const old=runtime.placementProject(a.projectId);await runtime.handoff(a.projectId);
    db.prepare("INSERT INTO pr_turns(command,digest,owner,session,text,state,error,created,native_admission) VALUES('stale-generation','fixture',?,?,?,'queued',NULL,?,'not-started')").run(a.projectId,old.session,'DO_NOT_MIGRATE',new Date().toISOString());
    await service.send(input('new-generation','NEW_GENERATION',a.projectId));await done(service,'new-generation');
    assert.equal(seen.includes('DO_NOT_MIGRATE'),false);assert.equal(db.prepare("SELECT state,error FROM pr_turns WHERE command='stale-generation'").get().error,'OLD_GENERATION');
  }finally{gate.release();await held?.dispose();await h.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('recovery scans skip 64 blocked owners before admitting an independent queued owner', {timeout:30000},async()=>{
  const h=await createNativeHarness({config}),gate=barrier();let handle;
  try{
    const {runtime,a,service}=await projects(h),owner=runtime.placementProject(a.projectId),db=h.ledger.managementDatabase(),seen=[];
    for(let i=0;i<64;i++){
      const id='000-blocked-'+i,sid='blocked-session-'+i;
      db.prepare("INSERT INTO pr_projects VALUES(?,?,?,?,?,?,?,?,1,'ready')").run(id,'blocked-create-'+i,'fixture',h.dir,h.dir,'Blocked '+i,'Fixture only',sid);
      db.prepare("INSERT INTO pr_turns(command,digest,owner,session,text,state,error,created,native_admission) VALUES(?,?,?,?,?,'interrupted','HOST_RESTART',?,'started')").run('blocked-running-'+i,'fixture',id,sid,'Never rerun',new Date().toISOString());
      db.prepare("INSERT INTO pr_turns(command,digest,owner,session,text,state,error,created,native_admission) VALUES(?,?,?,?,?,'queued',NULL,?,'not-started')").run('blocked-pending-'+i,'fixture',id,sid,'Wait behind unknown',new Date().toISOString());
    }
    h.adapter.stream=async function*(options){this.requests.push(options);const body=text(latest(options));seen.push(body);if(body==='EXTERNAL_HOLD')await waitBarrier(gate,options.signal);yield*new ScriptedModel(['ANSWER:'+body]).stream(options);};
    handle=await h.ctx.agents.resume({resumeSessionId:SessionId(owner.session),agentOptions:{provider:'test-offline',model:'script'}});
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'EXTERNAL_HOLD'}]}));
    await until(()=>seen.includes('EXTERNAL_HOLD'),'Independent native fixture did not start');
    const queued=await service.send(input('free-owner','FREE_OWNER',a.projectId));assert.equal(own(queued,'free-owner').state.kind,'queued');
    const beforeTools=h.ctx.tools.schemas(handle.agent).map(tool=>tool.name).sort();
    gate.release();await handle.agent.whenIdle();runtime.resumeConversationQueue();await done(service,'free-owner');
    await until(()=>h.ctx.tools.schemas(handle.agent).map(tool=>tool.name).sort().join(',')===beforeTools.join(','),'Borrowed native tools were not restored');
    assert.equal(h.ctx.agents.get(SessionId(owner.session)),handle.agent,'The externally owned handle remains live');
    handle.agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'EXTERNAL_AFTER'}]}));await handle.agent.whenIdle();
    assert.deepEqual(seen,['EXTERNAL_HOLD','FREE_OWNER','EXTERNAL_AFTER']);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pr_turns WHERE state='queued'").get().n,64);
  }finally{gate.release();await handle?.dispose();await h.dispose();}
});

test('an accepted queue survives real host restart and waits three seconds for its configured provider registration', {timeout:30000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-provider-startup-'));let h=await createNativeHarness({dir,config,registerScriptedProvider:false});
  try{
    const {a,service}=await projects(h),accepted=await service.send(input('delayed-provider','ONLY_ONCE_AFTER_PROVIDER',a.projectId)),id=own(accepted,'delayed-provider').id;
    assert.equal(own(accepted,'delayed-provider').state.kind,'queued');assert.equal(h.adapter.requests.length,0);
    await h.dispose();h=await createNativeHarness({dir,config,registerScriptedProvider:false});
    const runtime=h.ctx.taskSystem.projects,current=h.ctx.taskSystem.steward;
    const end=Date.now()+3000;
    while(Date.now()<end){runtime.tick();await current.reconcile({conversationId:'main'});await new Promise(done=>setTimeout(done,100));}
    assert.deepEqual({...h.ledger.managementDatabase().prepare('SELECT state,native_admission FROM pr_turns WHERE command=?').get('steward-'+id)},{state:'queued',native_admission:'not-started'});
    assert.equal(h.adapter.requests.length,0);
    h.adapter.script.push('Provider became ready; the original queued message ran once.');h.ctx.llm.registerAdapter(['test-offline'],h.adapter);
    const final=await done(current,'delayed-provider');assert.equal(own(final,'delayed-provider').id,id);assert.equal(h.adapter.requests.length,1);
    assert.equal(final.messages.find(message=>message.text==='Provider became ready; the original queued message ran once.').replyTo,id);
  }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('one-column admission migration preserves legacy unknown rows across repeated native host startup', {timeout:30000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-admission-migration-'));let h=await createNativeHarness({dir,config});
  try{
    const {runtime,a}=await projects(h),owner=runtime.placementProject(a.projectId);
    h.ledger.managementDatabase().prepare("INSERT INTO pr_turns(command,digest,owner,session,text,state,error,created,native_admission) VALUES('legacy-running','fixture',?,?,'Legacy unknown','running',NULL,?,'unknown')").run(a.projectId,owner.session,new Date().toISOString());
    await h.dispose();
    const old=new DatabaseSync(join(dir,'tasks.sqlite'));try{old.exec('ALTER TABLE pr_turns DROP COLUMN native_admission');assert.equal(old.prepare('PRAGMA table_info(pr_turns)').all().length,8);}finally{old.close();}
    for(let restart=0;restart<2;restart++){
      h=await createNativeHarness({dir,config});const db=h.ledger.managementDatabase();
      assert.equal(db.prepare('PRAGMA table_info(pr_turns)').all().filter(column=>column.name==='native_admission').length,1);
      assert.deepEqual({...db.prepare("SELECT state,native_admission FROM pr_turns WHERE command='legacy-running'").get()},{state:'interrupted',native_admission:'unknown'});
      h.ctx.taskSystem.projects.resumeConversationQueue();assert.equal(h.adapter.requests.length,0);
      if(restart===0)await h.dispose();
    }
  }finally{await h.dispose();rmSync(dir,{recursive:true,force:true});}
});
