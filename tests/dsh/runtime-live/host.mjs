/** Isolated real DSH Web host, exposed only on the named Tailscale address.
 * The official browser shell, auth cookies, plugin loading and RPC are unchanged.
 * No mock parent, no SSH forwarding, no default DSH profile.
 */
import {mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute,relative} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {isIP} from 'node:net';

const input=process.argv[2];if(!input)throw Error('Pass an isolated host config JSON path');
const config=JSON.parse(readFileSync(resolve(input),'utf8'));
const {runtimeRoot,stateDir,bindAddress,port,innerPort,allowedAddresses,taskConfig,remoteConfig}=config;
const tail=ip=>isIP(ip)===4&&ip.split('.')[0]==='100'&&Number(ip.split('.')[1])>=64&&Number(ip.split('.')[1])<=127;
if(!tail(bindAddress)||!Array.isArray(allowedAddresses)||!allowedAddresses.length||allowedAddresses.some(a=>!tail(a)))throw Error('Explicit Tailscale bind and peer addresses required');
if(!Number.isInteger(port)||!Number.isInteger(innerPort)||port===innerPort||Math.min(port,innerPort)<1024||Math.max(port,innerPort)>65535)throw Error('Distinct unprivileged UI and internal ports required');
if(!isAbsolute(stateDir)||stateDir===join(homedir(),'.dsh')||stateDir.startsWith(join(homedir(),'.dsh')+'/'))throw Error('Use an isolated absolute test state directory');
if(!taskConfig?.databasePath||!isAbsolute(taskConfig.databasePath))throw Error('Explicit isolated task database required');
const testParent=resolve(config.testRoot||stateDir),inside=p=>{const r=relative(testParent,resolve(p));return r!== '..'&&!r.startsWith('../')&&!isAbsolute(r);};
if(!inside(stateDir)||!inside(taskConfig.databasePath)||(remoteConfig?.statePath&&!inside(remoteConfig.statePath)))throw Error('Host state and databases must remain below the declared isolated testRoot');
if(!['planner','executor'].includes(taskConfig.role))throw Error('Declare test host role');
const scheduleAcceptance=config.allowScheduledPlanTest===true&&taskConfig.role==='planner'&&taskConfig.keepAlive===true;
if((taskConfig.schedulerEnabled!==false&&!scheduleAcceptance)||taskConfig.autoExecute!==false)throw Error('Only an explicitly enabled isolated planner may run the scheduler; automatic local execution stays disabled');
const req=createRequire(join(resolve(runtimeRoot),'package.json'));
const {initProfile}=await import(req.resolve('@deepseek-ai/dsh-app-boot'));
const home=join(stateDir,'home'),profileName='runtime-ui-'+taskConfig.role,profileDir=join(home,'profiles',profileName);
mkdirSync(profileDir,{recursive:true});
if(!existsSync(join(profileDir,'package.json')))initProfile(profileDir,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);
const packageDir=resolve(config.taskPackage||join(dirname(fileURLToPath(import.meta.url)),'../../../packages/task-system'));
const modules=join(profileDir,'node_modules','@dsh-task');mkdirSync(modules,{recursive:true});
if(!existsSync(join(modules,'task-system')))symlinkSync(packageDir,join(modules,'task-system'),'dir');
const patches=[{insert:[{id:'task-system',name:'@dsh-task/task-system/plugin',config:taskConfig},{id:'task-system-settings',name:'@dsh-task/task-system'},...(remoteConfig?[{id:'task-remote-execution',name:'@dsh-task/task-system/remote',config:remoteConfig}]:[])]},...(config.extraPatches||[])];
writeFileSync(join(profileDir,'cordis.patch.yml'),JSON.stringify(patches,null,2),{mode:0o600});
const dshPackage=req.resolve('@deepseek-ai/dsh/package.json'),bin=join(dirname(dshPackage),'lib/bin.js');
const logPath=join(stateDir,'host.log'),authPath=join(stateDir,'browser-login.json'),readyPath=join(stateDir,'ready.json');
writeFileSync(logPath,'',{mode:0o600});
const {appendFileSync}=await import('node:fs');
const authority=`${bindAddress}:${port}`,allowed=new Set([...allowedAddresses,bindAddress]);
let stopped=false,authenticated=false;
const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'};
const child=spawn(process.execPath,[bin,'--profile',profileName,'--host','127.0.0.1','--port',String(innerPort),'--trusted-host',authority,'--no-open'],{cwd:stateDir,env,stdio:['ignore','pipe','pipe']});
let pending='';
function record(chunk){pending+=chunk.toString('utf8');let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);for(const match of line.matchAll(/https?:\/\/[^\s\u001b<>]+/g)){try{const url=new URL(match[0]);if(url.searchParams.has('token')){url.hostname=bindAddress;url.port=String(port);writeFileSync(authPath,JSON.stringify({url:url.href}),{mode:0o600});authenticated=true;}}catch{}}
 appendFileSync(logPath,line.replace(/([?&]token=)[^\s\u001b<>]+/g,'$1[redacted]')+'\n');}}
child.stdout.on('data',record);child.stderr.on('data',record);
function admitted(request){const address=request.socket.remoteAddress?.replace(/^::ffff:/,'');return allowed.has(address)&&request.socket.localAddress===bindAddress&&request.headers.host===authority&&!Object.keys(request.headers).some(k=>/^(forwarded|x-forwarded-)/i.test(k));}
const carrier=http.createServer((request,response)=>{
 if(!admitted(request)){response.writeHead(403);response.end('Tailscale host access denied');return;}
 const upstream=http.request({hostname:'127.0.0.1',port:innerPort,path:request.url,method:request.method,headers:request.headers},incoming=>{response.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(response);});
 upstream.on('error',()=>{if(!response.headersSent)response.writeHead(503);response.end('Isolated DSH host unavailable');});request.on('aborted',()=>upstream.destroy());response.on('close',()=>upstream.destroy());request.pipe(upstream);
});
carrier.on('upgrade',(request,socket,head)=>{
 if(!admitted(request)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
 const upstream=http.request({hostname:'127.0.0.1',port:innerPort,path:request.url,method:request.method,headers:request.headers});
 upstream.on('upgrade',(response,peer,upstreamHead)=>{socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');if(upstreamHead.length)socket.write(upstreamHead);if(head.length)peer.write(head);socket.pipe(peer).pipe(socket);peer.on('error',()=>socket.destroy());socket.on('error',()=>peer.destroy());});
 upstream.on('response',response=>{socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);response.resume();});upstream.on('error',()=>socket.destroy());upstream.end();
});
await new Promise((resolve,reject)=>{carrier.once('error',reject);carrier.listen(port,bindAddress,resolve);});
const timer=setInterval(()=>{if(authenticated){writeFileSync(readyPath,JSON.stringify({url:`http://${authority}/#tasks`,role:taskConfig.role,nodeId:taskConfig.nodeId,officialHost:true,transport:'Tailscale direct HTTP to local official WebServer carrier',browserLoginFile:authPath,pid:process.pid,childPid:child.pid}),{mode:0o600});clearInterval(timer);console.log(`Official isolated ${taskConfig.role} panel ready: http://${authority}/#tasks (login URL saved privately)`);}},250);
async function close(code=0){if(stopped)return;stopped=true;clearInterval(timer);carrier.close();carrier.closeAllConnections();child.kill('SIGTERM');setTimeout(()=>{child.kill('SIGKILL');process.exit(code)},5000).unref();}
process.on('SIGINT',()=>close());process.on('SIGTERM',()=>close());child.on('exit',code=>{if(!stopped){console.error(`Official host exited (${code}); inspect isolated host.log`);close(code||1);}});
