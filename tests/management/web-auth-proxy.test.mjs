import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuthProxy,latestLaunchToken,enableHostSettings} from '../../scripts/web-auth/tailscale-dsh-proxy.mjs';

const owner={UserProfile:{ID:123,LoginName:'owner@example.test'},Node:{User:123}};
const authorized={host:'example.test:10000','tailscale-user-login':'owner@example.test','x-forwarded-for':'100.64.0.1'};
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
function request(port,path='/',headers=authorized,method='GET',body){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method,headers},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.on('error',reject);req.end(body);});}
function handshake(port,headers=authorized){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/api',headers:{...headers,connection:'Upgrade',upgrade:'websocket','sec-websocket-key':'fixture','sec-websocket-version':'13'}});req.on('upgrade',(_res,socket)=>resolve({status:101,socket}));req.on('response',res=>{res.resume();resolve({status:res.statusCode});});req.on('error',reject);req.end();});}
async function fixture(options={}){
 let generation=1,logins=0,posts=0,whoisCalls=0,lastHeaders;
 const upstreamSockets=new Set();
 const app=http.createServer((req,res)=>{
  lastHeaders=req.headers;
  if(req.url===`/?token=launch-${generation}`){logins++;res.writeHead(303,{'set-cookie':`dsh-auth-fixture=g${generation}; Max-Age=2592000; HttpOnly; Path=/`,location:'./'});res.end();return;}
  if(req.headers.cookie!==`dsh-auth-fixture=g${generation}`){res.writeHead(401);res.end('dsh web authentication required');return;}
  if(req.url.startsWith('/plugins/??')) {res.writeHead(200,{'content-type':'application/javascript','etag':'fixture','content-length':Buffer.byteLength(options.asset ?? 'connected')});res.end(options.asset ?? 'connected');return;}
  if(req.method==='POST')posts++;
  let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.writeHead(200,{'set-cookie':`dsh-auth-fixture=g${generation}; HttpOnly`});res.end(body||'connected');});
 });
 app.on('connection',s=>{upstreamSockets.add(s);s.on('close',()=>upstreamSockets.delete(s));});
 app.on('upgrade',(req,socket,head)=>{
  if(req.headers.cookie!==`dsh-auth-fixture=g${generation}`){socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');return;}
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fixture\r\n\r\n');
  if(head.length)socket.write(head);socket.on('data',chunk=>socket.write(chunk));socket.on('error',()=>{});
 });
 const upstreamPort=await listen(app);
 const proxy=createAuthProxy({publicOrigin:'https://example.test:10000',upstream:`http://127.0.0.1:${upstreamPort}`,allowedLogin:'owner@example.test',allowedUserId:123,hostSettings:options.hostSettings},{launchToken:async()=>`launch-${generation}`,whois:async ip=>{whoisCalls++;return ip==='100.64.0.1'?owner:{UserProfile:{ID:999,LoginName:'other@example.test'},Node:{User:999,MachineAuthorized:true}};}});
 const port=await listen(proxy.server);
 return {port,proxy,rotate:()=>generation++,stats:()=>({logins,posts,whoisCalls,lastHeaders}),async close(){await proxy.close();for(const s of upstreamSockets)s.destroy();await new Promise(r=>app.close(r));}};
}

test('owner uses a clean URL without browser cookies; DSH credentials stay inside proxy',async()=>{
 const f=await fixture();try{
  const response=await request(f.port,'/',{...authorized,cookie:'dsh-auth-stale=bad; unrelated=private'});
  assert.equal(response.status,200);assert.equal(response.body,'connected');assert.equal(response.headers['set-cookie'],undefined);
  assert.equal((await request(f.port,'/',{...authorized,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'})).status,200,'opening a clean bookmark/link works');
  assert.equal((await request(f.port,'/api',{...authorized,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'})).status,403);
  assert.equal(f.stats().lastHeaders.cookie,'dsh-auth-fixture=g1');assert.equal(f.stats().lastHeaders['tailscale-user-login'],undefined);
  assert.equal((await request(f.port,'/?token=obsolete')).status,303);assert.equal((await request(f.port,'/?token=obsolete')).headers.location,'/');
  await Promise.all(Array.from({length:6},()=>request(f.port,'/asset')));assert.equal(f.stats().logins,1);assert.equal(f.stats().whoisCalls,1);
 }finally{await f.close();}
});
test('missing identity, foreign users, spoofed login/IP, hostile Host/Origin and cross-site requests fail closed',async()=>{
 const f=await fixture();try{
  for(const headers of [{host:authorized.host},{...authorized,'tailscale-user-login':'other@example.test'},{...authorized,'x-forwarded-for':'100.64.0.2'},{...authorized,'x-forwarded-for':'100.64.0.1, 100.64.0.2'},{...authorized,host:'attacker.test'},{...authorized,origin:'https://attacker.test'},{...authorized,'sec-fetch-site':'cross-site'}]){
   assert.equal((await request(f.port,'/',headers)).status,403);assert.equal((await handshake(f.port,headers)).status,403);
  }
  assert.equal((await request(f.port,'//attacker.test/')).status,403);assert.equal(f.stats().logins,0);assert.equal(f.stats().posts,0);
 }finally{await f.close();}
});
test('new DSH credentials recover GET and WebSocket, but a POST is never replayed',async()=>{
 const f=await fixture();try{
  await request(f.port);f.rotate();assert.equal((await request(f.port)).status,200);assert.equal(f.stats().logins,2);
  f.rotate();const ws=await handshake(f.port);assert.equal(ws.status,101);const echoed=new Promise(r=>ws.socket.once('data',c=>r(c.toString())));ws.socket.write('bidirectional');assert.equal(await echoed,'bidirectional');ws.socket.destroy();
  f.rotate();assert.equal((await request(f.port,'/mutation',authorized,'POST','action')).status,503);assert.equal(f.stats().posts,0);
  assert.equal((await request(f.port,'/mutation',authorized,'POST','action')).status,200);assert.equal(f.stats().posts,1);
 }finally{await f.close();}
});
test('identity verification unavailable fails closed without invoking DSH',async()=>{
 let called=false;const p=createAuthProxy({publicOrigin:'https://example.test:10000',upstream:'http://127.0.0.1:1',allowedLogin:'owner@example.test',allowedUserId:123},{whois:async()=>{throw Error('unavailable');},launchToken:async()=>{called=true;return 'secret';}});
 try{const port=await listen(p.server);assert.equal((await request(port)).status,503);assert.equal(called,false);}finally{await p.close();}
});
test('private startup token lookup handles large logs and chunk boundaries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-auth-log-'));try{const path=join(dir,'service.log'),old='a'.repeat(64),current='b'.repeat(64);
 await writeFile(path,`http://127.0.0.1:3082/?token=${old}\n`+'x'.repeat(100000)+`\nhttp://127.0.0.1:3082/?token=${current}\n`+'x'.repeat(65510));assert.equal(await latestLaunchToken(path),current);
 }finally{await rm(dir,{recursive:true,force:true});}
});

const mirrorGate = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";';
const settingsPath = '/plugins/??@deepseek-ai/dsh-client-ui-settings/client.js&rev=fixture';
test('Host settings opt-in changes only the settings mirror behind owner authentication', async () => {
 const source = '/* 设置 */\n' + mirrorGate + '\n// connection.isLoopback stays unchanged';
 for (const enabled of [false,true]) {
  const f = await fixture({hostSettings:enabled,asset:source});
  try {
   const response = await request(f.port,settingsPath,{...authorized,'accept-encoding':'gzip','if-none-match':'fixture'});
   assert.equal(response.status,200);
   assert.equal(response.body,enabled ? enableHostSettings(source) : source);
   assert.equal(Number(response.headers['content-length']),Buffer.byteLength(response.body));
   if(enabled) {
    assert.equal(response.headers['cache-control'],'no-store');
    assert.equal(response.headers.etag,undefined);
    assert.equal(f.stats().lastHeaders['accept-encoding'],'identity');
    assert.equal(f.stats().lastHeaders['if-none-match'],undefined);
   }
   assert.equal((await request(f.port,settingsPath,{...authorized,'x-forwarded-for':'100.64.0.2'})).status,403);
   assert.equal((await request(f.port,'/plugins/??other/client.js')).body,source);
  } finally {await f.close()}
 }
});
test('an unsupported DSH client fails clearly instead of silently enabling a different contract', async () => {
 for(const source of ['changed client',mirrorGate + mirrorGate]) {
  const f=await fixture({hostSettings:true,asset:source});
  try {assert.equal((await request(f.port,settingsPath)).status,502)} finally {await f.close()}
 }
});
