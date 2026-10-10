#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TaskLedger } from '../../packages/task-system/dist/ledger.js';
import { validateRegistration, mappedId } from '../../packages/task-system/dist/project-registration/protocol.js';
import { enqueueRegistration, flushRegistrations } from '../../packages/task-system/dist/project-registration/client.js';
import { createRegistrationServer, bearerNamespaceAuthorizer } from '../../packages/task-system/dist/project-registration/http.js';
export async function main(args=process.argv.slice(2)) {
 const [op]=args, opt=(key,required=true)=>{const i=args.indexOf('--'+key);if(i<0||!args[i+1]){if(required)throw new Error('Missing --'+key);return;}return args[i+1];};
 const packet=()=>validateRegistration(JSON.parse(readFileSync(opt('packet'),'utf8')));
 if(op==='validate') return {valid:true,protocol:packet().protocol};
 if(op==='enqueue') return enqueueRegistration(opt('outbox'),packet());
 if(op==='flush') return flushRegistrations(opt('outbox'),opt('endpoint'),process.env[opt('token-env',false)??'DSH_REGISTRATION_TOKEN']);
 if(!['import','serve','list'].includes(op)) throw new Error('Use validate/import/enqueue/flush/serve/list. All paths and endpoints must be explicit.');
 const ledger=TaskLedger.open(resolve(opt('database')),{role:'planner',...(op==='list'?{readOnly:true}:{})});
 if(op==='serve') {
  const namespaces=opt('namespaces').split(','),token=process.env[opt('token-env',false)??'DSH_REGISTRATION_TOKEN'];
  if(!token)throw new Error('Registration token environment is missing');
  const port=Number(opt('port'));if(!Number.isInteger(port)||port<43300||port>43499)throw new Error('Test listener must use 433xx/434xx');
  const server=createRegistrationServer({ledger,authorize:bearerNamespaceAuthorizer(token,namespaces)});
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(port,'127.0.0.1',ok);});
  const close=()=>server.close(()=>{ledger.close();process.exit(0);});process.on('SIGTERM',close);process.on('SIGINT',close);
  console.log(JSON.stringify({listening:port,scope:'loopback',protocol:'dsh.project-registration/v1'}));return;
 }
 try {if(op==='list')return ledger.snapshot().projectRegistrations?.map(({packet,...r})=>r);const p=packet();return ledger.registerProject(mappedId(p.namespace,p.projectExternalId,'command',p.idempotencyKey),p,[p.namespace]);} finally {ledger.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(result=>{if(result!==undefined)console.log(JSON.stringify(result,null,2));}).catch(error=>{console.error(JSON.stringify({code:error.code??'ERROR',message:error.message}));process.exitCode=1;});
