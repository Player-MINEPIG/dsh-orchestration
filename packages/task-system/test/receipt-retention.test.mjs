import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskLedger } from '../dist/index.js';
import { RecoveryStore } from '../dist/remote/api.js';
import { TRANSIENT_RECEIPT_TTL_MS as TTL } from '../dist/receipt-retention.js';

function directory(t){const p=mkdtempSync(join(tmpdir(),'receipt-retention-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p}
function envelope(sequence,operation,commandId){return {nodeId:'worker',nonce:`nonce-${sequence}`,sequence,commandId,operation,payload:{},expiresAt:1000+sequence+60000}}

test('expiry only affects explicitly classified observations; uncertain and completed effects survive',t=>{
  const file=join(directory(t),'remote.sqlite');let s=new RecoveryStore(file);
  s.admit(envelope(1,'submit','read-effect'),1000);s.uncertain('worker','read-effect');
  s.admit(envelope(2,'claim','heartbeat-effect'),1000);s.complete('worker','heartbeat-effect',{saved:true});
  s.admit(envelope(3,'listWork','poll'),1000);s.complete('worker','poll',[]);
  s.saveOutbound('uncertain-business',{operation:'submit',state:'uncertain'},1000);
  s.saveOutbound('failed-poll',{operation:'listWork',state:'uncertain'},1000);
  assert.throws(()=>s.admit(envelope(4,'claim','poll'),1001),/COMMAND_CONFLICT/);
  s.close();s=new RecoveryStore(file);t.after(()=>s.close());
  s.admit(envelope(5,'listWork','later'),1001+TTL);
  s.saveOutbound('later',{operation:'listWork',state:'done'},1001+TTL);
  assert.equal(s.receipt('worker','poll'),undefined);
  assert.equal(s.outbound('failed-poll'),undefined);
  assert.equal(s.receipt('worker','read-effect').state,'uncertain');
  assert.deepEqual(s.receipt('worker','heartbeat-effect').result,{saved:true});
  assert.equal(s.outbound('uncertain-business').state,'uncertain');
  // Removing old read receipts never resets the durable sequence fence.
  assert.throws(()=>s.admit(envelope(4,'listWork','reordered'),1002+TTL),/OUT_OF_ORDER/);
});

test('legacy recovery store receipts are migrated without inferring their operation from IDs',t=>{
  const file=join(directory(t),'old.sqlite');const db=new DatabaseSync(file);
  db.exec("CREATE TABLE commands(node TEXT,id TEXT,digest TEXT,state TEXT,result TEXT,PRIMARY KEY(node,id)); CREATE TABLE outbound(id TEXT PRIMARY KEY,data TEXT); PRAGMA user_version=1;");
  db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run('worker','read-old','digest','done','{}');
  db.prepare('INSERT INTO outbound VALUES(?,?)').run('heartbeat-old','{"state":"uncertain"}');db.close();
  const s=new RecoveryStore(file);t.after(()=>s.close());
  s.admit(envelope(1,'listWork','new'),Date.now());s.saveOutbound('new',{operation:'listWork',state:'done'});
  assert.equal(s.receipt('worker','read-old').state,'done');
  assert.equal(s.outbound('heartbeat-old').state,'uncertain');
});

test('local heartbeat retention preserves latest health and durable task replay across reopen',t=>{
  let now=Date.now();const file=join(directory(t),'ledger.sqlite');const opts={now:()=>now,role:'planner'};
  let ledger=TaskLedger.open(file,opts);
  ledger.registerNode('node',{nodeId:'worker',roles:['executor'],capabilities:[],models:[],workspaceIds:[],enabled:true,lastSeenAt:new Date(now).toISOString()});
  const task=ledger.createTask('heartbeat-business',{title:'Keep this'});
  for(let i=0;i<40;i++){
    ledger.recordNodeHeartbeat(`h-${i}`,{nodeId:'worker',sampledAt:now,runtimeReady:true,activeExecutions:0});now+=60000;
  }
  assert.ok(Number(ledger.managementDatabase().prepare('SELECT count(*) AS n FROM commands').get().n)<=12);
  assert.equal(ledger.commandReceipt('h-0'),undefined);
  ledger.close();ledger=TaskLedger.open(file,opts);t.after(()=>ledger.close());
  assert.deepEqual(ledger.createTask('heartbeat-business',{title:'Keep this'}),task);
  assert.equal(ledger.nodeStatuses().find(n=>n.nodeId==='worker').runtimeReady,true);
});

test('read-only access to a pre-expiry ledger does not require a schema write',t=>{
  const file=join(directory(t),'legacy.sqlite');let ledger=TaskLedger.open(file);
  const first=ledger.createTask('original',{title:'Old receipt'});ledger.close();
  const db=new DatabaseSync(file);db.exec('DROP TABLE transient_command_expiry');db.close();
  ledger=TaskLedger.open(file,{readOnly:true});assert.deepEqual(ledger.commandReceipt('original'),first);ledger.close();
  ledger=TaskLedger.open(file);t.after(()=>ledger.close());assert.deepEqual(ledger.createTask('original',{title:'Old receipt'}),first);
});

test('project session poll receipts expire while admissions and placement writes remain replayable', t=>{
  const store=new RecoveryStore(join(directory(t),'project-session.sqlite'));t.after(()=>store.close());
  const requests=[
    ['poll',{kind:'exchange',input:{}}],
    ['read',{kind:'application',input:{kind:'conversation',projectId:'p'}}],
    ['write',{kind:'application',input:{kind:'native-conversation',input:{operation:{kind:'session-prompt'}}}}],
    ['placement',{kind:'application',input:{kind:'save-execution-settings',input:{}}}],
  ];
  for(const [index,[key,request]] of requests.entries()){
    const payload={input:{action:'project-session',request}};
    store.admit({...envelope(index+1,'projectCollaborate',key),payload},1000);
    store.complete('worker',key,{accepted:true});
    store.saveOutbound(key,{operation:'projectCollaborate',payload,state:'done'},1000);
  }
  store.admit(envelope(5,'listWork','next'),1001+TTL);
  store.saveOutbound('next',{operation:'listWork',state:'done'},1001+TTL);
  for(const key of ['poll','read']){assert.equal(store.receipt('worker',key),undefined);assert.equal(store.outbound(key),undefined);}
  for(const key of ['write','placement']){assert.equal(store.receipt('worker',key).state,'done');assert.equal(store.outbound(key).state,'done');}
});
