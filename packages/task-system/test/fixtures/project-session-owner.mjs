import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ScriptedModel } from '../../../../tests/dsh/scripted-model.mjs';
import {canonical} from '../../dist/ledger.js';
import { ProjectSessionOwner } from '../../dist/project-session-owner.js';
const project = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
export async function ownerHarness(dir, script=[]) {
  mkdirSync(dir,{recursive:true});
  const db=new DatabaseSync(join(dir,'owner.sqlite')),ctx=new Context();
  await (await ctx.plugin(Loader,{baseUrl:pathToFileURL(join(project,'package.json')).href})).await();
  await ctx.loader.root.update([
    ['llm','@deepseek-ai/dsh-llm'],['sessions','@deepseek-ai/dsh-session'],['projections','@deepseek-ai/dsh-session-projection'],
    ['prompt','@deepseek-ai/dsh-system-prompt'],['tools','@deepseek-ai/dsh-tools'],['agents','@deepseek-ai/dsh-agent'],
    ['persistence','@deepseek-ai/dsh-session-persistence-jsonl',{root:join(dir,'sessions'),compression:'none'}],
    ['loop','@deepseek-ai/dsh-agent-loop',{agents:[]}],
  ].map(([id,name,config])=>({id,name,config})));
  await ctx.loader.await();const model=new ScriptedModel(script);ctx.llm.registerAdapter(['owner-script'],model);
  const handles=new Map();
  const native={
    async create({sessionId,cwd}) { const handle=await ctx.agents.create({sessionId,meta:{cwd},agentOptions:{provider:'owner-script',model:'script'}});handles.set(sessionId,handle);return {sessionId:handle.agent.id}; },
    async resolveAgent(sessionId) { try {const live=ctx.agents.get(sessionId);if(live)return {agent:live};const handle=await ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'owner-script',model:'script'}});handles.set(sessionId,handle);return {agent:handle.agent};}catch(error){return {error};} },
  };
  let decision;let activations=0;
  const owner=new ProjectSessionOwner({managementDatabase:()=>db},ctx,'owner',{
    native,workspace:async({workspaceId,workspaceRevision})=>({cwd:dir,workspaceId,workspaceRevision}),
    authorize:async()=>{},verifyDecision:async value=>{if(canonical(value)!==canonical(decision))throw new Error('Decision unavailable');},
    activate:async()=>{activations++;},
  });
  return {ctx,db,owner,model,native,dir,get activations(){return activations;},setDecision(value){decision=value;},async close(){owner.dispose();await ctx.fiber.dispose();db.close();}};
}
export const prepare=(operationId='move-1',sessionId='ordinary-1')=>({kind:'prepare',operationId,projectId:'project-1',generation:2,sessionId,workspaceId:'registered-1',workspaceRevision:'catalog-1'});
export const oldBinding=dir=>({kind:'managed',projectId:'project-1',generation:1,nodeId:'owner',sessionId:'legacy-1',cwd:dir});
export const commit=(dir,next,operationId='move-1')=>({outcome:'commit',operationId,projectId:'project-1',old:oldBinding(dir),next});
export async function waitFor(test){for(let i=0;i<200;i++){if(test())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Timed out owner fixture');}
