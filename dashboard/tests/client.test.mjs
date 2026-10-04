import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSnapshot} from '../public/client.js';
const url='https://tasks.example.test/api/snapshot',origin='https://tasks.example.test';
const snapshot={schemaVersion:'1',source:{staleAfterMs:900000},tasks:[],runs:[],reports:[],artifacts:[],events:[],templates:[]};
const response=(body=snapshot,options={})=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'},...options});
test('same-origin no-store session reads preserve source data and verified expiry',async()=>{
 const expires=new Date(Date.now()+60000).toISOString();let options;
 const result=await loadSnapshot(url,{origin,requireSessionExpiry:true,fetcher:async(_,value)=>{options=value;return response(snapshot,{headers:{'content-type':'application/json','x-dsh-session-expires-at':expires}});}});
 assert.deepEqual(result.snapshot,snapshot);assert.equal(result.expiresAt,Date.parse(expires));assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
});
test('cross-origin source never sends a request',async()=>{let called=false;await assert.rejects(loadSnapshot('https://other.test/snapshot',{origin,fetcher:async()=>{called=true;}}),{kind:'configuration'});assert.equal(called,false);});
test('unauthorized, opaque login redirect and HTML response require authentication',async()=>{
 for(const value of [response({}, {status:401}),response({}, {status:403}),response({}, {status:302}),{type:'opaqueredirect'},new Response('<html>login</html>',{headers:{'content-type':'text/html'}})]) await assert.rejects(loadSnapshot(url,{origin,fetcher:async()=>value}),{kind:'authentication'});
});
test('Access reads require valid future signed-session expiry',async()=>{
 for(const expiry of [undefined,'invalid',new Date(Date.now()-1000).toISOString()]) await assert.rejects(loadSnapshot(url,{origin,requireSessionExpiry:true,fetcher:async()=>response(snapshot,{headers:{'content-type':'application/json',...(expiry?{'x-dsh-session-expires-at':expiry}:{})}})}),{kind:'authentication'});
 const actualNow=Date.now,deadline=actualNow()+1000;
 try{await assert.rejects(loadSnapshot(url,{origin,requireSessionExpiry:true,fetcher:async()=>({ok:true,status:200,headers:new Headers({'content-type':'application/json','x-dsh-session-expires-at':new Date(deadline).toISOString()}),json:async()=>{Date.now=()=>deadline+1000;return snapshot;}})}),{kind:'authentication'});}finally{Date.now=actualNow;}
});
test('network and source errors remain distinct from authentication loss',async()=>{
 await assert.rejects(loadSnapshot(url,{origin,fetcher:async()=>{throw new TypeError('sensitive internal error');}}),{kind:'connection',message:'暂时无法连接任务数据源'});
 await assert.rejects(loadSnapshot(url,{origin,fetcher:async()=>response({}, {status:503})}),{kind:'connection'});
 await assert.rejects(loadSnapshot(url,{origin,fetcher:async()=>response({})}),{kind:'data'});
});
