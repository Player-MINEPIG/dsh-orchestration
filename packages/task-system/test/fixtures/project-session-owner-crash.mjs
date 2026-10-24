import assert from 'node:assert/strict';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {ownerHarness,prepare,commit} from './project-session-owner.mjs';
const [mode,dir]=process.argv.slice(2),h=await ownerHarness(dir),prepared=await h.owner.handle(prepare()),agent=h.ctx.agents.get(prepared.binding.sessionId);
if(mode==='seed') {
 for(const rpcId of ['first','second'])agent.followup(createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:rpcId}]}));
 agent.steer(createUserMessage({source:{kind:'user',rpcId:'steering'},content:[{type:'text',text:'steering'}]}));await h.ctx.sessions.flush(agent.session);process.send({ready:true,ids:[...agent.inbox.nextStep,...agent.inbox.nextTurn].map(m=>m.id)});await new Promise(()=>{});
}else {
 const decision=commit(dir,prepared.binding);h.setDecision(decision);
 if(mode==='remove-crash'){const remove=agent.inbox.remove.bind(agent.inbox);agent.inbox.remove=id=>{const result=remove(id);process.send({ready:true,barrier:'removed-before-send'});process.kill(process.pid,'SIGSTOP');return result;};}
 if(mode==='active-crash'){const original=h.db.prepare.bind(h.db);h.db.prepare=sql=>{const statement=original(sql);if(!sql.startsWith('INSERT INTO project_session_owner_operations'))return statement;const run=statement.run.bind(statement);statement.run=(...args)=>{const result=run(...args);if(args[2]==='active'){process.send({ready:true,barrier:'active-before-release'});process.kill(process.pid,'SIGSTOP');}return result;};return statement;};}
 await h.owner.handle({kind:'activate',operationId:'move-1',binding:prepared.binding,decision});const restored=h.ctx.agents.get(prepared.binding.sessionId);await restored.whenIdle();await h.ctx.sessions.flush(restored.session);const messages=restored.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.source.kind==='user');assert.deepEqual(messages.map(e=>e.data.source.rpcId),['steering','first','second']);assert.equal(h.model.requests.length,2);console.log(JSON.stringify({kind:'owner-crash-restored',mode,ids:messages.map(e=>e.data.id),requests:h.model.requests.length}));await h.close();
}
