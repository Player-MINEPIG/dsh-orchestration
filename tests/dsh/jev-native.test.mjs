import test from 'node:test'
import assert from 'node:assert/strict'
import {resolve,join} from 'node:path'
import {writeFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {createNativeHarness} from './native-harness.mjs'
const request={state:'Caller background',questions:{q:{type:'choice',instructions:'Pick',criteria:{a:'A',b:'B'}}}}
test('real DSH Loader mounts JEV, ordinary DSH requests and a second plugin consuming the shared service',async()=>{
 const h=await createNativeHarness({script:[JSON.stringify({answers:{q:{type:'choice',choice:'a'}}}),JSON.stringify({answers:{q:{type:'choice',choice:'b'}}})]})
 try {
  await h.ctx.loader.create({id:'jev',name:pathToFileURL(resolve('packages/jev/lib/index.js')).href,config:{provider:'native',nativeProvider:'test-offline',model:'script'}})
  await h.ctx.loader.await();assert.ok(h.ctx.get('decisionModels'));assert.ok(h.ctx.tools.get('jev'));assert.equal(h.ctx.get('typedDecisions'),undefined)
  const file=join(h.dir,'decision-consumer.mjs');writeFileSync(file,`export const name='external-decision-consumer';export const inject=['decisionModels'];export function apply(ctx){ctx.provide('decisionConsumer',{ask:(request,options)=>ctx.decisionModels.ask(request,options)})}`)
  await h.ctx.loader.create({id:'decision-consumer',name:pathToFileURL(file).href});await h.ctx.loader.await()
  assert.equal((await h.ctx.get('decisionConsumer').ask(request)).answers.q.choice,'a')
  const tool=await h.ctx.tools.execute({callId:'jev-tool-fixture',name:'jev',arguments:request,signal:new AbortController().signal})
  assert.equal(tool.isError,false);assert.equal(h.adapter.requests.length,2)
  await h.ctx.loader.resolve('jev').fiber.dispose();await h.ctx.loader.await();assert.equal(h.ctx.get('decisionModels'),undefined);assert.equal(h.ctx.tools.get('jev'),undefined)
 } finally {await h.dispose()}
})
