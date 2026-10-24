import assert from 'node:assert/strict';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {ownerHarness,prepare,commit} from './project-session-owner.mjs';
const [mode,dir]=process.argv.slice(2),h=await ownerHarness(dir);
if(mode==='seed-cold'){
 await h.native.create({sessionId:'cold-old',cwd:dir});const original=h.ctx.agents.get('cold-old');original.runMaintenance(()=>new Promise(()=>{}));for(const rpcId of ['cold-first','cold-second'])original.followup(createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:rpcId}]}));await h.ctx.sessions.flush(original.session);process.send({ready:true,ids:original.inbox.nextTurn.map(m=>m.id)});await new Promise(()=>{});
}
if(mode==='freeze-cold'){
 const binding={kind:'native',projectId:'project-1',generation:1,nodeId:'owner',sessionId:'cold-old',cwd:dir,workspaceId:'registered-1',workspaceRevision:'catalog-1'};const held=await h.owner.handle({kind:'freeze',operationId:'cold-move',binding});assert.equal(held.kind,'frozen');const restored=h.ctx.agents.get('cold-old');assert.equal(restored.inbox.nextTurn.length,2);assert.equal(h.model.requests.length,0);const decision={outcome:'abort',operationId:'cold-move',projectId:'project-1',old:binding,next:null};h.setDecision(decision);await h.owner.handle({kind:'release',operationId:'cold-move',binding,decision});await restored.whenIdle();await h.ctx.sessions.flush(restored.session);const users=restored.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.source.kind==='user');assert.deepEqual(users.map(e=>e.data.source.rpcId),['cold-first','cold-second']);assert.equal(h.model.requests.length,2);console.log(JSON.stringify({kind:'cold-existing-pending-preserved',ids:users.map(e=>e.data.id),requests:h.model.requests.length}));await h.close();process.exit(0);
}
const prepared=await h.owner.handle(prepare()),agent=h.ctx.agents.get(prepared.binding.sessionId);
if(mode==='seed') {
 for(const rpcId of ['first','second'])agent.followup(createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:rpcId}]}));
 agent.steer(createUserMessage({source:{kind:'user',rpcId:'steering'},content:[{type:'text',text:'steering'}]}));await h.ctx.sessions.flush(agent.session);process.send({ready:true,ids:[...agent.inbox.nextStep,...agent.inbox.nextTurn].map(m=>m.id)});await new Promise(()=>{});
}else {
 const decision=commit(dir,prepared.binding);h.setDecision(decision);
 if(mode==='remove-crash'){const remove=agent.inbox.remove.bind(agent.inbox);agent.inbox.remove=id=>{const result=remove(id);process.send({ready:true,barrier:'removed-before-send'});process.kill(process.pid,'SIGSTOP');return result;};}
 if(mode==='active-crash'){const original=h.db.prepare.bind(h.db);h.db.prepare=sql=>{const statement=original(sql);if(!sql.startsWith('INSERT INTO project_session_owner_operations'))return statement;const run=statement.run.bind(statement);statement.run=(...args)=>{const result=run(...args);if(args[2]==='active'){process.send({ready:true,barrier:'active-before-release'});process.kill(process.pid,'SIGSTOP');}return result;};return statement;};}
 await h.owner.handle({kind:'activate',operationId:'move-1',binding:prepared.binding,decision});const restored=h.ctx.agents.get(prepared.binding.sessionId);await restored.whenIdle();await h.ctx.sessions.flush(restored.session);const messages=restored.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.source.kind==='user');assert.deepEqual(messages.map(e=>e.data.source.rpcId),['steering','first','second']);assert.equal(h.model.requests.length,2);console.log(JSON.stringify({kind:'owner-crash-restored',mode,ids:messages.map(e=>e.data.id),requests:h.model.requests.length}));await h.close();
}
