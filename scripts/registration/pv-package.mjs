#!/usr/bin/env node
import {readFileSync,readdirSync,writeFileSync,mkdirSync,copyFileSync,existsSync,statSync} from 'node:fs';
import {resolve,join,dirname,basename,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateRegistration} from '../../packages/task-system/dist/project-registration/protocol.js';
const args=process.argv.slice(2),arg=(name)=>args[args.indexOf('--'+name)+1];
if(!args.includes('--source')||!args.includes('--output'))throw new Error('Explicit --source (read-only PV root) and --output (isolated root) required');
const source=resolve(arg('source')),out=resolve(arg('output'));if(out===source||out.startsWith(source+'/'))throw new Error('Output must be outside PV source');
mkdirSync(join(out,'evidence'),{recursive:true,mode:0o700});
const uri=path=>pathToFileURL(path).href,now=new Date().toISOString();
const packet={protocol:'dsh.project-registration/v1',namespace:'pmp-local/pv',projectExternalId:'dsh-tavern-v3-pv-first-round',revision:1,previousRevision:0,idempotencyKey:'pv-history-r1',mode:'history',observedAt:now,staleAfterMs:60000,origin:{nodeId:'pmp-mac',harness:'DSH + Codex CLI (historical evidence)',workspaceUri:uri(source)},project:{title:'dsh-tavern v3 PV · 有限历史报告包',goal:'三位一体 PV 制作；技术交付、导演复核、用户效果验收分别记录',state:'completed',nextStep:'仅登记报告生成时的交付状态；后续封面选择、试听与 PV 整体验收未纳入此包',createdAt:null,updatedAt:null,milestones:[]},tasks:[],runs:[],reports:[],artifacts:[],outcomes:[]};
const addTask=(id,title,parent,state='completed',description='来源文档中的交付；中央未重跑验收')=>packet.tasks.push({externalId:id,title,parentTaskId:parent,description,goal:title,state,stage:'supporting',rank:packet.tasks.length,createdAt:null,updatedAt:null});
addTask('pv','PV 制作',undefined,'completed','结构依据文件命名和报告重建，非原生父 task 身份；完成仅指历史报告交付');
const files=readdirSync(join(source,'.codex-runs')).filter(x=>x.endsWith('.final.md')).sort();
const groups=new Set();
for(const name of files){const id=name.replace('.final.md',''),phase=id.split('-')[0];if(!groups.has(phase)){groups.add(phase);addTask(phase,phase+' 阶段','pv');packet.project.milestones.push({externalId:phase,title:phase+' 制作阶段（验收未确认）',weight:1,state:'active',reportIds:[]});}
 addTask(id,id,phase);packet.tasks.at(-1).milestoneId=phase;
 const file=join(source,'.codex-runs',name),body=readFileSync(file,'utf8');copyFileSync(file,join(out,'evidence',name));
 const eventPath=join(source,'.codex-runs',id+'.events.jsonl'),facts={threadId:null,turnCompleted:false,turnFailed:false};
 if(existsSync(eventPath))for(const line of readFileSync(eventPath,'utf8').split('\n')){if(!line.trim())continue;let event;try{event=JSON.parse(line);}catch{continue;}if(event.type==='thread.started')facts.threadId=event.thread_id??null;if(event.type==='turn.completed')facts.turnCompleted=true;if(event.type==='turn.failed'||event.type==='error')facts.turnFailed=true;}
 // Never copy items/messages/reasoning from event streams. Only identity + terminal markers.
 writeFileSync(join(out,'evidence',id+'.execution-facts.json'),JSON.stringify({sourceUri:uri(eventPath),...facts,originalTimestamp:null,model:null,reasoningEffort:null},null,2));
 packet.runs.push({externalId:id+'-run',taskId:id,state:facts.turnCompleted&&!facts.turnFailed?'succeeded':'uncertain',outcome:'unknown',sessionIds:facts.threadId?[facts.threadId]:[],evidenceUri:uri(eventPath),provider:'codex-cli-historical',createdAt:null,updatedAt:null});
 packet.reports.push({externalId:id+'-final',taskId:id,runId:id+'-run',title:id+' Codex final report',body,kind:'result',createdAt:null,evidenceUri:uri(file),artifactIds:[]});packet.project.milestones.find(x=>x.externalId===phase).reportIds.push(id+'-final');
}
for(const relative of ['docs/collaboration-first-round-review.md',...readdirSync(join(source,'docs/c6')).filter(x=>x.endsWith('.md')).map(x=>'docs/c6/'+x)]){
 const file=join(source,relative),body=readFileSync(file,'utf8'),id='doc/'+Buffer.from(relative).toString('base64url');
 const taskId=relative.includes('/c6/')?'c6-docs':'pv';if(taskId==='c6-docs'&&!packet.tasks.some(x=>x.externalId===taskId))addTask(taskId,'C6 任务书、候选及配音交付','pv');
 const target=join(out,'evidence',relative);mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target);
 packet.reports.push({externalId:id,taskId,title:basename(file),body,kind:relative.includes('REPORT')?'result':'note',createdAt:null,evidenceUri:uri(file),artifactIds:[]});
 for(const match of body.matchAll(/\]\(([^)]+)\)/g)) {const link=match[1];if(!link||/^(https?:|#)/.test(link))continue;const path=resolve(dirname(file),link),extension=extname(path).toLowerCase();if(!['.mp4','.wav','.png','.drp','.drt','.srt'].includes(extension)||!path.startsWith(source+'/'))continue;const aid='media/'+Buffer.from(path.slice(source.length+1)).toString('base64url');if(!packet.artifacts.some(a=>a.externalId===aid)){const exists=existsSync(path);packet.artifacts.push({externalId:aid,taskId,name:basename(path),uri:uri(path),mediaType:{'.mp4':'video/mp4','.wav':'audio/wav','.png':'image/png'}[extension]??'application/octet-stream',...(exists?{bytes:statSync(path).size}:{}),createdAt:null,availability:exists?'origin-local':'unknown',evidenceUri:uri(file)});}if(packet.artifacts.find(a=>a.externalId===aid).taskId===taskId)packet.reports.at(-1).artifactIds.push(aid); }
}
for(const [id,title,summary] of [['first-round','首轮技术交付','首轮审阅未证明用户观看后的效果反馈；执行摘要不是验收'],['c6-cover','C6 封面候选','历史 REPORT_C6_COVER 生成时有五个候选且未选定；本包未包含后续 cover01/titleA 选择证据，不能代表当前选择状态'],['c6-vo','C6 配音技术交付','历史 REPORT_C6_VO 陈述数值/工程验证与当时待试听；本包不涵盖后续反馈，中央未复验']])packet.outcomes.push({externalId:id,title,summary,taskIds:['pv'],reportIds:packet.reports.filter(r=>id==='first-round'?r.title.includes('collaboration-first'):id==='c6-cover'?r.title.includes('REPORT_C6_COVER'):r.title.includes('REPORT_C6_VO')).map(r=>r.externalId),acceptance:'unknown',createdAt:null,updatedAt:null});
const valid=validateRegistration(packet),target=join(out,'pv-registration.json');writeFileSync(target,JSON.stringify(valid,null,2));
console.log(JSON.stringify({packet:target,tasks:packet.tasks.length,runs:packet.runs.length,reports:packet.reports.length,artifacts:packet.artifacts.length,mediaCopied:0,modelInvocations:0,originalTimes:'unknown (not inferred from filesystem mtime)'}));
