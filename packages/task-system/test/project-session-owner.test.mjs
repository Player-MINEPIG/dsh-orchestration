import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {TaskReturnDelivery} from '../dist/task-returns.js';
import {ownerHarness,prepare,commit,waitFor} from './fixtures/project-session-owner.mjs';
const prompt=(agent,rpcId,target='next-turn')=>agent.send(createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:rpcId}]}),target,true);
const fixture=()=>mkdtempSync(join(tmpdir(),'project-owner-'));

test('ordinary preparation holds both native input and actual task return until committed activation',async()=>{
 const dir=fixture(),h=await ownerHarness(dir);try {
 const prepared=await h.owner.handle(prepare());assert.equal(prepared.kind,'prepared');const agent=h.ctx.agents.get(prepared.binding.sessionId);assert.equal(agent.status,'idle');
 prompt(agent,'native-A');prompt(agent,'native-B');prompt(agent,'steering','next-step');
 const delivery=new TaskReturnDelivery(h.ctx);const returning=delivery.deliver({nodeId:'owner',sessionId:agent.id,taskId:'fixture-task',text:'Frozen result',completion:{eventId:'return-1',origin:{kind:'session',nodeId:'owner',sessionId:agent.id,cwd:dir}}});
 await waitFor(()=>agent.inbox.nextTurn.length===3);await h.ctx.sessions.flush(agent.session);assert.equal(h.model.requests.length,0);await assert.rejects(h.owner.admit(prepared.binding,'write'),/not been activated/);
 const decision=commit(dir,prepared.binding);h.setDecision(decision);const active=await h.owner.handle({kind:'activate',operationId:'move-1',binding:prepared.binding,decision});assert.equal(active.kind,'active');await returning;await agent.whenIdle();await h.ctx.sessions.flush(agent.session);
 assert.equal(h.activations,1);assert.equal(h.model.requests.length,3);assert.deepEqual(agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&['user','dsh-task-result'].includes(e.data.source.kind)).map(e=>e.data.source.rpcId??e.data.source.eventId),['steering','native-A','native-B','return-1']);
 assert.equal((await h.owner.handle(prepare())).evidenceId,prepared.evidenceId);await assert.rejects(h.owner.handle({...prepare(),workspaceRevision:'changed'}),/changed/);await delivery.dispose();
 }finally{await h.close();rmSync(dir,{recursive:true,force:true});}
});

test('graceful shutdown preserves exact accepted input identity and cold activation wakes without new input',async()=>{
 const dir=fixture();let h=await ownerHarness(dir);try {
 const prepared=await h.owner.handle(prepare());const agent=h.ctx.agents.get(prepared.binding.sessionId);prompt(agent,'native-pending');prompt(agent,'native-second');const ids=agent.inbox.nextTurn.map(m=>m.id);await h.ctx.sessions.flush(agent.session);assert.equal(h.model.requests.length,0);await h.close();
 h=await ownerHarness(dir);const retry=await h.owner.handle(prepare());const restored=h.ctx.agents.get(retry.binding.sessionId);assert.deepEqual(restored.inbox.nextTurn.map(m=>m.id),ids);assert.equal(h.model.requests.length,0);const decision=commit(dir,retry.binding);h.setDecision(decision);await h.owner.handle({kind:'activate',operationId:'move-1',binding:retry.binding,decision});await restored.whenIdle();await h.ctx.sessions.flush(restored.session);assert.equal(h.model.requests.length,2);assert.deepEqual(restored.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.source.kind==='user').map(e=>e.data.id),ids);
 }finally{await h.close();rmSync(dir,{recursive:true,force:true});}
});

test('live busy native driver is not cancelled and idle freeze rejects an existing pending inbox',async()=>{
 const dir=fixture(),h=await ownerHarness(dir,['hang']);try {
 const prepared=await h.owner.handle(prepare());const decision=commit(dir,prepared.binding);h.setDecision(decision);await h.owner.handle({kind:'activate',operationId:'move-1',binding:prepared.binding,decision});const agent=h.ctx.agents.get(prepared.binding.sessionId);prompt(agent,'running');await waitFor(()=>h.model.requests.length===1);
 await assert.rejects(h.owner.handle({kind:'freeze',operationId:'move-2',binding:prepared.binding}),e=>e.code==='BUSY');assert.equal(h.model.requests[0].signal.aborted,false);agent.cancel({kind:'user'});await agent.whenIdle();
 agent.inject(createUserMessage({source:{kind:'fixture'},content:[{type:'text',text:'Parked context'}]}));await assert.rejects(h.owner.handle({kind:'freeze',operationId:'move-3',binding:prepared.binding}),e=>e.code==='BUSY');assert.equal(agent.inbox.nextStep.length,1);
 }finally{await h.close();rmSync(dir,{recursive:true,force:true});}
});

test('actual owner survives SIGKILL before wake send and after active persistence without new ingress',async()=>{
 const {spawn}=await import('node:child_process');const worker=new URL('./fixtures/project-session-owner-crash.mjs',import.meta.url);const dir=fixture();
 async function crash(mode){const child=spawn(process.execPath,[worker.pathname,mode,dir],{stdio:['ignore','pipe','pipe','ipc']});let error='';child.stderr.on('data',v=>error+=v);const ready=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('exit',code=>reject(new Error(mode+' exited '+code+' '+error)));});child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));return ready;}
 try {const seed=await crash('seed');await crash('remove-crash');await crash('active-crash');const child=spawn(process.execPath,[worker.pathname,'restore',dir],{stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>error+=v);assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0,error);assert.deepEqual(JSON.parse(output.trim()).ids,seed.ids);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('cold freeze keeps previously queued native inputs inert and releases them in their original session',async()=>{
 const {spawn}=await import('node:child_process');const worker=new URL('./fixtures/project-session-owner-crash.mjs',import.meta.url),dir=fixture();try{const seed=spawn(process.execPath,[worker.pathname,'seed-cold',dir],{stdio:['ignore','pipe','pipe','ipc']});let error='';seed.stderr.on('data',v=>error+=v);const ready=await new Promise((resolve,reject)=>{seed.once('message',resolve);seed.once('exit',code=>reject(new Error('seed '+code+' '+error)));});seed.kill('SIGKILL');await new Promise(resolve=>seed.once('exit',resolve));const restored=spawn(process.execPath,[worker.pathname,'freeze-cold',dir],{stdio:['ignore','pipe','pipe']});let output='';restored.stdout.on('data',v=>output+=v);restored.stderr.on('data',v=>error+=v);assert.equal(await new Promise(resolve=>restored.once('exit',resolve)),0,error);assert.deepEqual(JSON.parse(output.trim()).ids,ready.ids);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
