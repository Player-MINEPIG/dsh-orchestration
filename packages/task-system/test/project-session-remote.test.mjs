import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import http from 'node:http';
import {mkdirSync,rmSync} from 'node:fs';
import {Workbench} from '../dist/workbench.js';
import {join} from 'node:path';
import {createNativeHarness} from '../../../tests/dsh/native-harness.mjs';
import {attachProjectSessionHost} from './fixtures/project-session-host.mjs';
import {RemoteClient,RemoteLedgerClient,RemoteGateway,RecoveryStore,IdentityVerifier,httpHandler} from '../dist/remote/api.js';
const official=process.env.DSH_OFFICIAL_ROOT;

test('one authenticated client supports remote UI application while the same owner polls, authorizes and activates', {skip:!official,timeout:20000},async()=>{
 const central=await createNativeHarness({config:{role:'planner',nodeId:'central',executionEnabled:false,projectAgentOptions:{provider:'test-offline',model:'script'}}});let owner=await createNativeHarness({config:{role:'executor',nodeId:'owner',centralMode:'remote',executionEnabled:false}});
 const keys=generateKeyPairSync('ed25519'),serverStore=new RecoveryStore(join(central.dir,'gateway.sqlite')),clientStore=new RecoveryStore(join(owner.dir,'outbound.sqlite'));
 const gateway=new RemoteGateway({role:'planner',nodeId:'central',ledger:central.ledger,store:serverStore,verifier:new IdentityVerifier({audience:'central',peers:[{keyId:'owner-key',nodeId:'owner',audience:'central',publicKey:keys.publicKey,operations:['projectCollaborate'],workspaces:[],capabilities:[]}]})});
 const server=http.createServer(httpHandler(gateway,{allowLoopbackHttp:true}));let client;
 try {
  await attachProjectSessionHost(central);await attachProjectSessionHost(owner);
  central.ledger.registerNode('owner-enabled',{nodeId:'owner',roles:['planner'],models:[],capabilities:[],workspaceIds:[],enabled:true});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  client=new RemoteClient({endpoint:`http://127.0.0.1:${server.address().port}/commands`,nodeId:'owner',audience:'central',keyId:'owner-key',privateKey:keys.privateKey,allowLoopbackHttp:true,store:clientStore,timeoutMs:15000});
  const coordinatorLedger=new RemoteLedgerClient(client,'owner');owner.ctx.provide('remoteExecution',{coordinatorLedger,settingsSnapshot:()=>({paused:false,coordinatorConfigured:true})});
  const firstPath=join(owner.dir,'first-workspace'),secondPath=join(owner.dir,'second-workspace');mkdirSync(firstPath);mkdirSync(secondPath);const first=await owner.ctx.workspaceRegistry.create(firstPath,'First owner workspace'),second=await owner.ctx.workspaceRegistry.create(secondPath,'Second owner workspace');
  await owner.ctx.taskSystem.sessionPortal.ownerCarrier.poll();await owner.ctx.taskSystem.sessionPortal.ownerCarrier.poll();
  const runtime=central.ctx.taskSystem.projects,portal=central.ctx.taskSystem.sessionPortal;runtime.saveSettings({root:join(central.dir,'projects'),expectedRevision:0});const {projectId}=await runtime.create({commandId:'remote-project',title:'Two host ordinary session',goal:'Keep tools on the selected owner'});
  const catalog=owner.ctx.taskSystem.sessionPortal.catalog();const firstSaved=await portal.saveExecutionSettings({commandId:'first-remote-placement',projectId,expectedRevision:0,allowedNodeIds:null,executionBindings:{},coordinatorWorkspace:{kind:'registered',nodeId:'owner',workspaceId:first.id,catalogRevision:catalog.revision}});assert.equal(firstSaved.coordinatorSession.nodeId,'owner');
  const peerPortal=owner.ctx.taskSystem.sessionPortal;
  const capability=await peerPortal.nativeConversation({projectId,commandId:'remote-native-capabilities',operation:{kind:'native-capabilities'}});assert.ok(capability);
  owner.adapter.script.push('😀'.repeat(16000)+' OLD_REMOTE_ASSISTANT_MARKER');await peerPortal.nativeConversation({projectId,commandId:'old-large-turn',operation:{kind:'session-prompt',requestId:'old-large-turn',mode:'queue',content:[{type:'text',text:'OLD_REMOTE_USER_MARKER'}]}});const oldAgent=owner.ctx.agents.get(firstSaved.coordinatorSession.sessionId);await oldAgent.whenIdle();await owner.ctx.sessions.flush(oldAgent.session);const task=central.ledger.createTask('continuation-real-task',{title:'Continue this central task'}).value;new Workbench(central.ledger).manage('continuation-project-task','link_backlog_task',{backlogId:'pr:'+projectId,taskId:task.taskId});
  const secondSaved=await peerPortal.saveExecutionSettings({commandId:'owner-ui-second-placement',projectId,expectedRevision:1,allowedNodeIds:null,executionBindings:{},coordinatorWorkspace:{kind:'registered',nodeId:'owner',workspaceId:second.id,catalogRevision:catalog.revision}});assert.equal(secondSaved.coordinatorSession.cwd,secondPath);assert.equal(secondSaved.coordinatorSession.generation,3);
  owner.adapter.script.push('Actual remote owner response');await peerPortal.nativeConversation({projectId,commandId:'owner-ui-native-prompt',operation:{kind:'session-prompt',requestId:'owner-ui-native-prompt',mode:'queue',content:[{type:'text',text:'Use this device workspace and skills'}]}});const agent=owner.ctx.agents.get(secondSaved.coordinatorSession.sessionId);await agent.whenIdle();await owner.ctx.sessions.flush(agent.session);assert.equal(owner.adapter.requests.length,2);assert.match(JSON.stringify(owner.adapter.requests[1].messages),/OLD_REMOTE_ASSISTANT_MARKER/);assert.match(JSON.stringify(owner.adapter.requests[1].messages),new RegExp(task.taskId));assert.equal(central.adapter.requests.length,0);assert.match(JSON.stringify(owner.adapter.requests[1].messages),new RegExp(secondPath));assert.match(JSON.stringify(owner.adapter.requests[1].messages),/owner-local/);assert.equal(owner.ctx.taskSystem.native,undefined);assert.deepEqual(central.ledger.getNode('owner').workspaceIds,[]);
  const view=await portal.conversation(projectId);assert.equal(view.nativeSession.binding.sessionId,agent.id);
 }finally{await owner.dispose();await client?.dispose();await gateway.dispose();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});serverStore.close();clientStore.close();await central.dispose();}
});
