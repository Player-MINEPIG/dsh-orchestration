#!/usr/bin/env node
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {TaskLedger} from '../../packages/task-system/dist/ledger.js';
import {createRegistrationServer,bearerNamespaceAuthorizer} from '../../packages/task-system/dist/project-registration/http.js';
import {createDashboardServer} from '../../dashboard/server.mjs';
import {createWorkbenchMutation} from '../../dashboard/management.mjs';
const base='/root/dsh-orchestration-tests/project-registration-20261011',database=process.argv[2];
if(!database?.startsWith(base+'/runs/')||!database.endsWith('/central.sqlite'))throw new Error('Only the designated test database can be served');
const tokenPath=join(base,'registration-token');if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
const ledger=TaskLedger.open(database,{role:'planner',nodeId:'test-central'});
const intake=createRegistrationServer({ledger,authorize:bearerNamespaceAuthorizer(readFileSync(tokenPath,'utf8').trim(),['fixture/local','pmp-local/pv','pmp-local/live-smoke'])});
// Loopback dashboard access is authenticated by the user's SSH tunnel; no public listener.
const dashboard=createDashboardServer({snapshot:()=>ledger.querySnapshot(),mutate:createWorkbenchMutation(ledger),accessLabel:'隔离 VPS 测试账本',accessDescription:'SSH 隧道 · 中央登记元数据管理'});
await new Promise((ok,bad)=>{intake.once('error',bad);intake.listen(43381,'127.0.0.1',ok);});
await new Promise((ok,bad)=>{dashboard.once('error',bad);dashboard.listen(43382,'127.0.0.1',ok);});
writeFileSync(join(base,'service.pid'),String(process.pid));writeFileSync(join(base,'service-database.txt'),database);
console.log(JSON.stringify({registrationPort:43381,dashboardPort:43382,database,tokenPath,scope:'loopback-only; SSH tunnel required'}));
const close=()=>{intake.close(()=>dashboard.close(()=>{ledger.close();process.exit(0);}));};process.on('SIGTERM',close);process.on('SIGINT',close);
