import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {openSync} from 'node:fs';
const base='/root/dsh-orchestration-tests/project-registration-20261011',pid=Number(readFileSync(base+'/service.pid','utf8')),database=readFileSync(base+'/service-database.txt','utf8').trim();
if(!Number.isInteger(pid)||!database.startsWith(base+'/runs/'))throw new Error('Invalid isolated service identity');
const args=readFileSync('/proc/'+pid+'/cmdline','utf8');if(!args.includes('scripts/registration/vps-service.mjs')||!args.includes(database))throw new Error('Refusing to stop a different process');
process.kill(pid,'SIGTERM');
for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,50));}
const log=openSync(base+'/service.log','a',0o600),child=spawn(process.execPath,['scripts/registration/vps-service.mjs',database],{cwd:base,detached:true,stdio:['ignore',log,log]});child.unref();console.log(JSON.stringify({restartedTestService:true,pid:child.pid,database,registrationPort:43381,dashboardPort:43382}));
