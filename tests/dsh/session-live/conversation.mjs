/** Real DSH conversation: slash activation, independent process resume, skill-directed collaboration. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import {Loader} from '@deepseek-ai/cordis-plugin-loader';
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {assembleContextFor} from '@deepseek-ai/dsh-agent';
const root=resolve(process.env.DSH_RECURSIVE_RUNTIME),stage=process.argv[2];
assert(['start','resume','inspect'].includes(stage));
const workspace=join(root,'conversation-workspace');mkdirSync(workspace,{recursive:true});mkdirSync(join(root,'evidence'),{recursive:true});
const endpoint=process.env.DSH_RECURSIVE_ENDPOINT;assert(endpoint?.startsWith('http://100.123.230.75:43971/'));
const ctx=new Context();await ctx.plugin(Loader,{baseUrl:pathToFileURL(resolve('package.json')).href});
const yaml=await import('/Users/pmp/.local/lib/deepseek-harness/0.2.0-rc.2/node_modules/yaml/dist/index.js');
const refs=yaml.parse(readFileSync('/Users/pmp/.dsh/.credentials.yaml','utf8')).refs;
ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{DEEPSEEK_API_KEY:refs.DEEPSEEK_API_KEY}}]));
const remoteConfig={role:'executor',nodeId:'mbp',authMode:'trusted-network',statePath:join(root,'conversation-remote.sqlite'),pollIntervalMs:0,coordinator:{endpoint,audience:'vps',authMode:'trusted-network',trustedNetwork:{address:'100.123.230.75',port:43971,localAddress:'100.111.163.32',allowHttp:true},nativeRoutes:[]}};
await ctx.loader.root.update([
 ['llm','@deepseek-ai/dsh-llm'],['deepseek','@deepseek-ai/dsh-llm-deepseek-api-key',{maxTokens:6000}],
 ['sessions','@deepseek-ai/dsh-session'],['projection','@deepseek-ai/dsh-session-projection'],['prompt','@deepseek-ai/dsh-system-prompt'],
 ['tools','@deepseek-ai/dsh-tools'],['agents','@deepseek-ai/dsh-agent'],['loop','@deepseek-ai/dsh-agent-loop',{agents:[]}],['commands','@deepseek-ai/dsh-commands'],
 ['persistence','@deepseek-ai/dsh-session-persistence-jsonl',{root:join(root,'conversation-sessions'),compression:'none'}],
 ['task',pathToFileURL(resolve('packages/task-system/dist/dsh-plugin.js')).href,{databasePath:join(root,'conversation-local.sqlite'),role:'executor',nodeId:'mbp',keepAlive:false,schedulerEnabled:false,autoExecute:false}],
 ['remote',pathToFileURL(resolve('packages/task-system/dist/remote/index.js')).href,remoteConfig],
 ['registration',pathToFileURL(resolve('packages/task-system/dist/project-registration/plugin.js')).href,{namespaces:['local']}],
].map(([id,name,config])=>({id,name,config})));await ctx.loader.await();
const sessionId=SessionId(process.env.DSH_TEST_SESSION_ID || 'session-collaboration-real-v2'),agentOptions={provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'low'};
const options={agentOptions,setup:(agentCtx,agent)=>{let steps=0;agentCtx.on('agent/pre-step',async(_p,next)=>{if(++steps>18)throw Error('Acceptance turn step limit');return await next();});agentCtx.tools.restrict({allow:['task_nodes','project_status','task_dispatch','project_progress','project_finish']});}};
let handle;
try{
 handle=stage==='start'?await ctx.agents.create({...options,sessionId,meta:{cwd:workspace}}):await ctx.agents.resume({...options,resumeSessionId:sessionId});
 const agent=handle.agent;
 const before=await ctx.systemPrompt.assemble(assembleContextFor(agent));
 const beforeEvents=agent.session.snapshotEvents().length;
 if(stage==='start'){
  const result=await ctx.commands.execute(agent,'/project start 会话自动协作真实验收',[],new AbortController().signal);
  assert.equal(result?.result.kind,'success',result?.result.text);
  writeFileSync(join(root,'evidence','activation.json'),JSON.stringify(result.result,null,2));
  assert.equal(agent.session.snapshotEvents().slice(beforeEvents).filter(e=>e.type==='turn/start').length,0);
 }
 const prompt=await ctx.systemPrompt.assemble(assembleContextFor(agent));
 writeFileSync(join(root,'evidence',`prompt-${stage}.json`),JSON.stringify(prompt,null,2));
 if(stage==='inspect') {
  assert(JSON.stringify(prompt).includes('当前项目协作'),'Restored official session must load the bundled skill without contacting the coordinator');
  console.log(JSON.stringify({stage,sessionId,skillRestored:true,modelCalled:false}));
 } else {
 const input=stage==='start'
 ? '这是一个隔离的会话协作验收项目。请让本机 Codex（GPT-6 Luna，low）完成两个独立任务：一是用三条中文列出会话恢复时避免重复派发的检查项；二是用三条中文解释执行完成与人工验收的区别。只需要文字，不读取或修改文件。记录当前项目阶段进度，派发后先向我汇报，下一轮再检查和提交。'
 : '继续刚才的项目。请检查前面派发的两项工作；如果执行已结束，汇总真实结果并提交项目待复核。沿用原有任务，不要重复派发。';
 agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:input}]}));
 await agent.whenIdle();await ctx.sessions.flush(agent.session);
 const events=agent.session.snapshotEvents();
 writeFileSync(join(root,'evidence',`conversation-${stage}.json`),JSON.stringify({stage,sessionId,input,beforeEvents,eventCount:events.length,events},null,2));
 console.log(JSON.stringify({stage,sessionId,eventCount:events.length,sessionPersisted:true}));
 }
}finally{if(handle)await handle.dispose();await ctx.fiber.dispose();}
