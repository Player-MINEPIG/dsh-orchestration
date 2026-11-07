import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {registerExecutor} from './executor-fixture.mjs';
export async function seedStewardProgress(host){
 const service=host.ctx.taskSystem.steward,ledger=host.ctx.taskSystem.ledger,scope={kind:'project',projectId:host.created.projectId};
  host.model.script.push('我会在这里汇报实际进展。');await service.send({conversationId:'main',commandId:'progress-origin',text:'请留意这项工作',target:scope});
  for(let i=0;i<300;i++){await service.reconcile({conversationId:'main'});if(service.store.messages('main').some(message=>message.role==='assistant'))break;await new Promise(r=>setTimeout(r,10));}
  const executor=join(host.directory,'executor');mkdirSync(executor);writeFileSync(join(executor,'研究报告.md'),'# 研究稿预览\n\n这是既有工作文件，不是正式结果提交。\n');
  ledger.registerWorkspace('progress-workspace',{workspaceId:'progress-workspace',nodeId:'local',path:executor,label:'progress executor',state:'ready',createdAt:new Date().toISOString()});
  registerExecutor(ledger,'progress-node',{nodeId:'local',roles:['executor'],models:[{provider:'test-offline',model:'script',reasoningEfforts:[]}],capabilities:[],workspaceIds:['progress-workspace'],enabled:true,lastSeenAt:new Date().toISOString()});
  const task=ledger.createTask('progress-task',{title:'研究进展示例',workspaceId:'progress-workspace'}).value;
  host.runtime.linkTask(host.runtime.placementProject(host.created.projectId).session,task.taskId);
  const run=ledger.createRun('progress-run',{taskId:task.taskId,route:{nodeId:'local',workspaceId:'progress-workspace',provider:'test-offline',model:'script',requiredCapabilities:[]}}).value;
  const claim=ledger.claim('progress-claim',{runId:run.runId,nodeId:'local',ttlMs:60000}).value;
  const ref={runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'local',fence:claim.attempt.fence,executionId:'progress-execution'};ledger.markRunning('progress-start',ref);
  const selected=ledger.selectTaskSession('progress-session',{...ref,workspaceId:'progress-workspace',session:{mode:'new'}}).value;
  const handle=await host.ctx.agents.create({sessionId:selected.sessionId,meta:{cwd:executor},agentOptions:{provider:'test-offline',model:'script'}});await host.ctx.sessions.flush(handle.agent.session);
  ledger.submit('progress-stopped',{...ref,outcome:'unknown',summary:'RAW_RUNTIME_ERROR secret-details-not-default'});
  const report=ledger.appendReport('progress-report',{taskId:task.taskId,sessionId:selected.sessionId,title:'研究稿已形成',kind:'progress',body:`报告绝对路径：${join(executor,'研究报告.md')} 。这是进度记录，不是正式结果。`,data:{reportRelativePath:'研究报告.md'}}).value;
  await service.reconcile({conversationId:'main'});
  const original=service.store.messages('main').filter(message=>message.provenance?.taskId===task.taskId);assert.ok(original.length>=2);
  const presentations=await service.progress.read({conversationId:'main',messageIds:original.map(message=>message.id)});assert.equal(presentations.find(row=>row.messageId===original.at(-1).id).presentation.targets.some(target=>target.kind==='file'),true);
 return {service,ledger,scope,task,run,ref,selected,executor,report,original,handle};
}
