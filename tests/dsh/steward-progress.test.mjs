import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync,symlinkSync} from 'node:fs';
import {startHost} from '../ci/browser-native-project.mjs';
import {seedStewardProgress} from './steward-progress-fixture.mjs';

test('authorized progress keeps exact ledger records and opens only task-bound files inside the executor workspace', {timeout:20000}, async()=>{
 const host=await startHost({executionEnabled:true});
 try{
  const {service,ledger,task,selected,executor,original,report}=await seedStewardProgress(host);
  const ids=original.map(message=>message.id),input={conversationId:'main',messageIds:ids};
  const read=await service.progress.read(input),latest=read.at(-1),file=latest.presentation.targets.find(target=>target.kind==='file');
  assert.match(read[0].presentation.summary,/打断|结束|停止/);assert.ok(read.every(row=>!row.presentation.summary.includes('RAW_RUNTIME_ERROR')));assert.ok(original.every(message=>!message.text.includes('RAW_RUNTIME_ERROR')));assert.ok(!original[0].text.includes('请查看报告'));
  assert.equal(file.label,'查看研究报告');
  const target=await service.progress.open({conversationId:'main',messageId:latest.messageId,targetId:file.id});
  assert.equal(target.reportId,report.reportId);assert.equal(target.sessionId,selected.sessionId);assert.equal(target.path,join(executor,'研究报告.md'));
  await assert.rejects(service.progress.open({conversationId:'main',messageId:latest.messageId,targetId:'/etc/passwd'}),{code:'NOT_FOUND'});
  await assert.rejects(service.progress.open({conversationId:'foreign',messageId:latest.messageId,targetId:file.id}),{code:'FORBIDDEN'});
  const record=latest.presentation.targets.find(target=>target.kind==='record'),body=await service.progress.open({conversationId:'main',messageId:latest.messageId,targetId:record.id});assert.equal(body.body,report.body);assert.equal(body.reportKind,'progress');
  const outside=join(host.directory,'outside.md');writeFileSync(outside,'OUTSIDE FILE MUST NOT BE A PREVIEW TARGET');symlinkSync(outside,join(executor,'escape.md'));
  for(const [key,path]of [['symlink','escape.md'],['absolute',outside],['missing','missing.md']])ledger.appendReport('progress-negative-'+key,{taskId:task.taskId,sessionId:selected.sessionId,title:'普通文件',kind:'progress',body:'not a formal result',data:{reportRelativePath:path}});
  ledger.appendReport('progress-unbound',{taskId:task.taskId,sessionId:'foreign-executor',title:'研究报告',body:'do not borrow a different session',data:{reportRelativePath:'研究报告.md'}});
  ledger.appendReport('progress-unstructured',{taskId:task.taskId,sessionId:selected.sessionId,title:'other evidence',body:outside+'\n[来源]('+outside+')'});
  writeFileSync(join(executor,'notes.mmd'),'working notes');const notes=ledger.appendReport('progress-notes',{taskId:task.taskId,sessionId:selected.sessionId,title:'插件配置记录',kind:'progress',body:'ordinary file',data:{reportRelativePath:'notes.mmd'}}).value;
  await service.reconcile({conversationId:'main'});
  const messages=service.store.messages('main').filter(message=>message.provenance?.taskId===task.taskId),projected=await service.progress.read({conversationId:'main',messageIds:messages.map(message=>message.id)});
  for(const row of projected.filter(row=>!ids.includes(row.messageId))){const targets=row.presentation.targets;assert.equal(targets.filter(target=>target.kind==='file').length,row===projected.at(-1)?1:0);}
  const last=projected.at(-1),noteFile=last.presentation.targets.find(target=>target.kind==='file');assert.equal(noteFile.label,'查看文件');assert.equal((await service.progress.open({conversationId:'main',messageId:last.messageId,targetId:noteFile.id})).reportId,notes.reportId);
  assert.equal(host.model.requests.length,1,'Projection/source resolution performs no model call or executor turn');
 }finally{await host.close();}
});
