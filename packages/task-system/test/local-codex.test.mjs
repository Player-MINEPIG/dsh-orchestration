import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalCodexStore, LocalCodexService, localCodexPermission, localCodexProfile, localCodexReasoningEffort, CodexOutput } from '../dist/local-codex.js';

test('DSH writable permission modes use auto review with workspace sandbox; readonly stays readonly', () => {
  for (const parentMode of ['workspace-write', 'danger-full-access']) {
    assert.deepEqual(localCodexPermission(parentMode), {sandbox:'workspace-write', approval:'on-request', reviewer:'auto_review', label:'Codex 自动审批 · 工作区写入沙箱'});
    const config = localCodexProfile({parentMode, model:'gpt-6.1-sol', reasoningEffort:'high'});
    assert.match(config, /approvals_reviewer = "auto_review"/);
    assert.match(config, /sandbox_mode = "workspace-write"/);
  }
  assert.equal(localCodexPermission('read-only').approval, 'never');
  assert.equal(localCodexPermission('read-only').sandbox, 'read-only');
  assert.throws(() => localCodexPermission('invalid'), /Unknown/);
});

test('per-task reasoning effort reaches the CLI profile and persistent receipt without changing approval', async () => {
  const service = Object.create(LocalCodexService.prototype);
  const store = service.store = new LocalCodexStore(':memory:');
  service.active = new Map();
  service.config = {maxConcurrent:2,model:'gpt-6.1-sol',reasoningEffort:'high',cliPath:process.execPath};
  const pending = [], profiles = [];
  service.execute = async task => {profiles.push(localCodexProfile(task)); return {status:'completed'};};
  service.ctx = {get:()=>undefined,jobs:{start:spec=>{pending.push(spec.run().done);return `job-${pending.length}`;}}};
  const agent = {id:'parent',session:{header:{cwd:resolve('.')}},ctx:{get:()=>({resolve:()=>({mode:'danger-full-access'})})}};
  const args = {requestId:'override',title:'title',prompt:'prompt',reasoningEffort:'xhigh'};
  try {
    const receipt = service.delegate(agent,args,new AbortController().signal);
    assert.equal(receipt.reasoningEffort,'xhigh');
    assert.equal(receipt.parentMode,'danger-full-access');
    assert.equal(receipt.permission.reviewer,'auto_review');
    assert.equal(receipt.permission.sandbox,'workspace-write');
    assert.equal(store.rows('parent')[0].reasoningEffort,'xhigh');
    assert.throws(()=>service.delegate(agent,{...args,reasoningEffort:'high'},new AbortController().signal), /reasoningEffort/);
    service.config.reasoningEffort = 'medium';
    assert.equal(service.delegate(agent,{...args,reasoningEffort:undefined},new AbortController().signal).taskId,receipt.taskId);
    await Promise.all(pending);
    assert.match(profiles[0],/model_reasoning_effort = "xhigh"/);
    assert.match(profiles[0],/approvals_reviewer = "auto_review"/);
    assert.equal(localCodexReasoningEffort(undefined,'high'),'high');
    assert.equal(localCodexReasoningEffort('ultra','high'),'ultra');
    assert.throws(()=>localCodexReasoningEffort('','high'),/Invalid/);
    assert.throws(()=>localCodexReasoningEffort('high\napproval_policy=never','high'),/Invalid/);
  } finally {await Promise.all(pending);store.db.close();}
});

test('local task rows are isolated by session and restart never reruns unfinished work', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-codex-test-'));
  const path = join(root, 'tasks.sqlite');
  let store = new LocalCodexStore(path);
  try {
    const task = {id:'one', sessionId:'parent', requestId:'request', title:'test', description:'modify', cwd:root, model:'model', reasoningEffort:'high', parentMode:'workspace-write', status:'running', createdAt:new Date().toISOString(), updatedAt:'', cliPath:'codex'};
    store.save(task);
    store.save({...task,id:'two',sessionId:'other',status:'review',report:'finished'});
    assert.deepEqual(store.rows('parent').map(t=>t.id), ['one']);
    store.db.close();
    store = new LocalCodexStore(path);
    assert.equal(store.list('parent')[0].status, 'unknown');
    assert.equal(store.list('other')[0].report, 'finished');
    assert.equal(store.list('other')[0].status, 'review');
  } finally { store.db.close(); rmSync(root,{recursive:true,force:true}); }
});

test('Codex output folds split UTF-8 and requires an actual completed turn', () => {
  const output = new CodexOutput();
  const bytes = Buffer.from([
    {type:'thread.started',thread_id:'thread'},
    {type:'item.completed',item:{type:'agent_message',text:'修改成功'}},
    {type:'turn.completed',usage:{}}
  ].map(x=>JSON.stringify(x)).join('\n'));
  for (let i=0;i<bytes.length;i++) output.push(bytes.subarray(i,i+1));
  output.finish();
  assert.equal(output.threadId,'thread'); assert.equal(output.report,'修改成功'); assert.equal(output.completed,true);
  const failed = new CodexOutput();
  failed.push(Buffer.from('{"type":"turn.failed","error":{"message":"denied"}}\n'));
  assert.equal(failed.completed,false); assert.equal(failed.error,'denied');
  assert.throws(()=>new CodexOutput().push(Buffer.from('x'.repeat(4*1024*1024+1))), /limit/);
});

test('idempotent retry returns the same task without launching; mismatched retry and owned execution fail', () => {
  const service = Object.create(LocalCodexService.prototype);
  const store = service.store = new LocalCodexStore(':memory:');
  const cwd = resolve('.');
  service.ctx = { get:()=>undefined };
  const agent = {id:'parent',session:{header:{cwd}},ctx:{get:()=>({resolve:()=>({mode:'workspace-write'})})}};
  store.save({id:'one',sessionId:'parent',requestId:'same',title:'title',description:'prompt',cwd,parentMode:'workspace-write',status:'review',createdAt:'now',updatedAt:'now',cliPath:'codex',model:'model',reasoningEffort:'high'});
  const args = {requestId:'same',title:'title',prompt:'prompt'};
  try {
    assert.equal(service.delegate(agent,args,new AbortController().signal).taskId,'one');
    assert.throws(()=>service.delegate(agent,{...args,prompt:'changed'},new AbortController().signal), /different/);
    service.ctx = {get:()=>({native:{scopeFor:()=>({})}})};
    assert.throws(()=>service.delegate(agent,args,new AbortController().signal), /scheduler-owned/);
  } finally { store.db.close(); }
});

test('only the original parent can accept a returned result with evidence; acceptance survives restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-accept-test-'));
  const path = join(root, 'tasks.sqlite');
  let store = new LocalCodexStore(path);
  const task = {id:'one',sessionId:'parent',requestId:'same',title:'title',description:'prompt',cwd:root,parentMode:'workspace-write',status:'running',createdAt:'now',updatedAt:'now',cliPath:'codex',model:'model',reasoningEffort:'high'};
  try {
    store.save(task);
    assert.throws(()=>store.accept('other','one','checked'), /not found/);
    assert.throws(()=>store.accept('parent','one','checked'), /awaiting review/);
    store.save({...task,status:'error'});
    assert.throws(()=>store.accept('parent','one','checked'), /awaiting review/);
    store.save({...task,status:'review',report:'child says done'});
    const returnedAt = store.rows('parent')[0].returnedAt;
    assert.ok(Number.isFinite(Date.parse(returnedAt)));
    assert.throws(()=>store.accept('parent','one','  '), /evidence/);
    const accepted = store.accept('parent','one','Read file and verified expected bytes');
    assert.equal(accepted.status,'done');
    assert.equal(accepted.returnedAt,returnedAt);
    assert.deepEqual(store.accept('parent','one',accepted.acceptance.evidence), accepted);
    store.db.close(); store = new LocalCodexStore(path);
    assert.equal(store.rows('parent')[0].status,'done');
    assert.equal(store.rows('parent')[0].returnedAt,returnedAt);
    assert.deepEqual(store.rows('parent')[0].acceptance,accepted.acceptance);
    assert.equal(store.rows('other').length,0);
  } finally {store.db.close();rmSync(root,{recursive:true,force:true});}
});
