import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const workspace=process.argv[2]??'/private/tmp/dsh-origin-return-tools-workspace';
const {createNativeHarness}=await import(pathToFileURL(join(workspace,'tests/dsh/native-harness.mjs')));
const {taskReturnCompleted}=await import(pathToFileURL(join(workspace,'packages/task-system/dist/task-returns.js')));
const cases=[];
for(const mode of ['pending','consumed-interrupted']) {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'dsh-return-restart-review-')));let h;
 try {
  const stage1=`import {createNativeHarness} from './tests/dsh/native-harness.mjs';import {createUserMessage} from '@deepseek-ai/dsh-llm';import {SessionId} from '@deepseek-ai/dsh-session';const h=await createNativeHarness({dir:${JSON.stringify(dir)},script:['hang']});const handle=await h.ctx.agents.create({sessionId:SessionId('original'),meta:{cwd:h.dir},agentOptions:{provider:'test-offline',model:'script'}});const m=createUserMessage({source:{kind:'dsh-task-result',eventId:'crash-event',taskId:'child'},content:[{type:'text',text:'EXACT_ORIGINAL_CHILD_PAYLOAD'}]});${mode==='pending'?`handle.agent.send(m,'next-turn',false);`:`handle.agent.followup(m);for(let i=0;i<100&&!h.adapter.requests.length;i++)await new Promise(r=>setTimeout(r,5));`}await h.ctx.sessions.flush(handle.agent.session);process.stdout.write('flushed');process.exit(0);`;
  const crash=spawnSync(process.execPath,['--input-type=module','-e',stage1],{cwd:workspace,encoding:'utf8'});
  assert.equal(crash.status,0,crash.stderr);assert.match(crash.stdout,/flushed/);
  h=await createNativeHarness({dir,script:['Recovered the original child result exactly once.']});
  const message={messageId:'crash-event',taskId:'child',sessionId:'original',nodeId:'local',text:'EXACT_ORIGINAL_CHILD_PAYLOAD',completion:{eventId:'crash-event',origin:{kind:'session',nodeId:'local',sessionId:'original',cwd:dir,composition:{provider:'test-offline',model:'script',tools:[]}}}};
  await h.ctx.taskSystem.taskReturns.deliver(message);
  const stored=await h.ctx.sessionPersistence.open('original','read');const events=(await stored.read()).events;await stored.close();
  const resultMessages=events.filter(event=>event.type==='user/message'&&event.data.source.kind==='dsh-task-result');
  const originals=resultMessages.filter(event=>JSON.stringify(event.data.content).includes('EXACT_ORIGINAL_CHILD_PAYLOAD'));
  assert.equal(originals.length,1);assert.equal(taskReturnCompleted(events,'crash-event'),true);assert.equal(h.ledger.snapshot().runs.length,0);assert.equal(h.ctx.agents.get('original'),undefined);assert.equal(h.adapter.requests.length,1);
  cases.push({mode,originalPayloads:originals.length,resultMessages:resultMessages.length,modelRequests:h.adapter.requests.length,completed:true,returnedHandleDisposed:true,newRuns:0});
 } finally {await h?.dispose();rmSync(dir,{recursive:true,force:true});}
}
const result={verifiedAt:new Date().toISOString(),workspace,status:'passed',cases};
if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify(result,null,2)+'\n');
