import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import TitleService,{foldSessionTitle} from '@deepseek-ai/dsh-session-title';
import ProjectionCache from '@deepseek-ai/dsh-session-projection-cache';
import {createNativeHarness} from './native-harness.mjs';
import {attachWorkspaceRegistry} from '../settings/local-workspace-harness.mjs';
import {backfillTaskSessionTitles} from '../../packages/task-system/dist/session-titles.js';

test('official exclusive backfill preserves prior intent and prefixes, updates cold projections and is idempotent without Agents or turns',async()=>{
 const h=await createNativeHarness();
 try {
  await attachWorkspaceRegistry(h);
  await h.ctx.plugin(TitleService,{fallbackMaxWords:10,fallbackMaxBytes:100,maxTitleBytes:512});
  await h.ctx.plugin(ProjectionCache,{writeEveryEvents:100,writeIntervalMs:10000});
  const req=createRequire(join(process.env.DSH_OFFICIAL_ROOT,'package.json'));
  const query=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-query-sqlite')));
  await h.ctx.plugin(query.default??query,{path:join(h.dir,'query.sqlite'),openAt:'never'});await h.ctx.fiber.ready;
  const before=new Map();
  for(const [id,title] of [['cold',undefined],['manual','我的名字'],['literal','未命名'],['empty',''],['owned',undefined],['live',undefined]]){
   const agent=await h.ctx.agents.create({sessionId:id,meta:{cwd:h.dir,agentPreset:'ptc'}});
   if(title!==undefined)agent.agent.session.append('session/title',{title,messageSeqs:[],source:{kind:'user'}});
   await h.ctx.sessions.flush(agent.agent.session);await agent.dispose();
   const reader=await h.ctx.sessionPersistence.open(id,'read');try{before.set(id,(await reader.read()).events)}finally{await reader.close()}
  }
  const live=await h.ctx.agents.resume({resumeSessionId:'live'});
  const owned=await h.ctx.sessionPersistence.open('owned','write');
  const liveReader=await h.ctx.sessionPersistence.open('live','read');try{before.set('live',(await liveReader.read()).events)}finally{await liveReader.close()}
  let agents=0,turns=0;h.ctx.on('agent/created',()=>agents++);h.ctx.on('session/event',(_s,e)=>{if(e.type==='turn/start')turns++});
  const candidates=[...before.keys(),'missing'].map(sessionId=>({sessionId,taskId:'task',runId:'run',title:'修复 Issue #22：周目残留'}));
  const first=await backfillTaskSessionTitles(h.ctx,candidates);
  assert.deepEqual(first.map(x=>x.status),['named','existing-title','existing-title','existing-title','owned','live','missing']);
  const second=await backfillTaskSessionTitles(h.ctx,candidates);
  assert.equal(second[0].status,'existing-title');
  for(const [id,events] of before){
   const reader=await h.ctx.sessionPersistence.open(id,'read');try{
    const after=(await reader.read()).events;
    assert.deepEqual(after.slice(0,events.length),events,'the original event prefix is immutable');
    assert.equal(after.length,events.length+(id==='cold'?2:0));
    if(id==='cold')assert.deepEqual(after.slice(events.length).map(e=>e.type),['session/end-seed','session/title'],'official detached restore adds only its replay boundary and the title');
    if(id==='cold')assert.equal(foldSessionTitle(after).title,candidates[0].title);
   }finally{await reader.close()}
  }
  const meta=await h.ctx.sessionPersistence.stat('cold');
  assert.equal(h.ctx.sessionProjectionCache.cachedSnapshot(meta.header).values.title,candidates[0].title,'official list cache is updated without a resume');
  const observation=await h.ctx.sessionQuery.readTitleSnapshot('cold');
  assert.equal(observation.title.title,candidates[0].title,'official cold query reads the same title');
  assert.equal(agents,0);assert.equal(turns,0);assert.equal(h.adapter.requests.length,0);
  await owned.close();await live.dispose();
 }finally{await h.dispose()}
});
