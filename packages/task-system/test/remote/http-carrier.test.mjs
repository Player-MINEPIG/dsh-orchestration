import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskLedger } from '../../dist/index.js';
import { RecoveryStore, IdentityVerifier, RemoteGateway, RemoteClient, RemoteLedgerClient, httpHandler } from '../../dist/remote/api.js';

// Only this test request trusts this disposable CA; certificate verification stays enabled.
function tlsFetch(ca) {
  return (url, options={}) => new Promise((resolve,reject) => {
    const req=https.request(url,{method:options.method,headers:options.headers,signal:options.signal,ca},res=>{
      const chunks=[];res.on('data',b=>chunks.push(b));res.on('error',reject);
      res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });
    req.on('error',reject); req.end(options.body);
  });
}
const listen = server => new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const close = server => new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});

test('actual loopback TLS carrier validates its certificate and signed ledger flow; no external network', async()=>{
  const root=mkdtempSync(join(tmpdir(),'dsh-tls-'));
  const cert=join(root,'fixture-cert.pem'), key=join(root,'fixture-key.pem');
  const result=spawnSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{encoding:'utf8'});
  assert.equal(result.status,0,'OpenSSL must generate the disposable TLS test certificate');
  const ledger=TaskLedger.open(join(root,'tasks.sqlite'),{role:'planner',nodeId:'planner'});
  const serverStore=new RecoveryStore(join(root,'server.sqlite')), clientStore=new RecoveryStore(join(root,'client.sqlite'));
  const keys=generateKeyPairSync('ed25519');
  const peer={keyId:'test-peer',nodeId:'worker',publicKey:keys.publicKey,audience:'planner',operations:['listWork','claim','markRunning','bindSession','renew','submit','getRun'],workspaces:['workspace'],capabilities:['read']};
  const gateway=new RemoteGateway({role:'planner',nodeId:'planner',ledger,store:serverStore,verifier:new IdentityVerifier({audience:'planner',peers:[peer]})});
  const tls=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},httpHandler(gateway));
  const plain=http.createServer(httpHandler(gateway));
  let client;
  try {
    ledger.registerWorkspace('workspace',{workspaceId:'workspace',nodeId:'worker',path:root,label:'Disposable fixture',state:'ready',createdAt:new Date().toISOString()});
    ledger.registerNode('node',{nodeId:'worker',roles:['executor'],capabilities:['read'],models:[{provider:'fixture',model:'fixture',reasoningEfforts:[]}],workspaceIds:['workspace'],enabled:true,lastSeenAt:new Date().toISOString()});
    const task=ledger.createTask('task',{title:'Actual TLS fixture',workspaceId:'workspace'}).value;
    const run=ledger.createRun('run',{taskId:task.taskId,route:{nodeId:'worker',provider:'fixture',model:'fixture',requiredCapabilities:['read'],workspaceId:'workspace'}}).value;
    const endpoint=`https://127.0.0.1:${await listen(tls)}/commands`;
    await assert.rejects(tlsFetch(undefined)(endpoint,{method:'POST',body:'{}'}),/self-signed|certificate/i);
    const response=await fetch(`http://127.0.0.1:${await listen(plain)}/commands`,{method:'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https'},body:'{}'});
    assert.equal(response.status,403);assert.equal((await response.json()).error,'TLS_REQUIRED');
    client=new RemoteClient({endpoint,nodeId:'worker',keyId:peer.keyId,audience:'planner',privateKey:keys.privateKey,store:clientStore,fetch:tlsFetch(readFileSync(cert))});
    const remote=new RemoteLedgerClient(client,'worker');
    assert.equal((await remote.pendingRuns('worker')).length,1);
    const claimed=await remote.claim('claim',{runId:run.runId,nodeId:'worker',ttlMs:60000});
    const lease={runId:run.runId,attemptId:claimed.value.attempt.attemptId,nodeId:'worker',fence:claimed.value.attempt.fence,executionId:'tls-fixture-execution'};
    await remote.markRunning('start',lease);await remote.bindSession('session',{...lease,sessionId:'tls-fixture-session'});
    await remote.renew('renew',{...lease,ttlMs:60000});
    await remote.submit('result',{...lease,outcome:'success',summary:'Actual authenticated TLS result',report:{title:'Fixture',body:'No live model or user task involved'}});
    assert.equal((await remote.getRun(run.runId)).state,'succeeded');
    assert.equal(ledger.history(task.taskId).reports.length,1);
  } finally {
    await client?.dispose();await gateway.dispose();await close(tls);await close(plain);
    clientStore.close();serverStore.close();ledger.close();rmSync(root,{recursive:true,force:true});
  }
});
