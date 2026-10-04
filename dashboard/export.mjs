/** Build a portable immutable snapshot from the SAME read-only ledger. No new persistence. */
import {cp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskLedger} from '../packages/task-system/dist/index.js';
import {dashboardSnapshot} from './server.mjs';
import {validateSnapshot} from './public/model.js';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const destination=path.resolve(arg('--out',path.join(HERE,'../.runtime/dashboard-site/dist')));
const ledgerPath=path.resolve(arg('--ledger',path.join(HERE,'../.runtime/tasks.sqlite')));
const ledger=TaskLedger.open(ledgerPath,{readOnly:true});
try{
 const snapshot=validateSnapshot(dashboardSnapshot(ledger.snapshot()));
 await mkdir(destination,{recursive:true});
 for(const name of ['index.html','app.js','model.js','client.js','styles.css','favicon.svg'])await cp(path.join(HERE,'public',name),path.join(destination,name));
 await writeFile(path.join(destination,'snapshot.json'),JSON.stringify(snapshot,null,2)+'\n');
 await writeFile(path.join(destination,'config.js'),`window.DSH_DASHBOARD_CONFIG=Object.freeze(${JSON.stringify({mode:'snapshot',snapshotUrl:'./snapshot.json',apiBase:'./api',title:'DSH · 任务看板',accessLabel:'私有任务看板',accessDescription:'只读快照 · 不自动同步'})});\n`);
 await writeFile(path.join(destination,'_headers'),`/*\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'\n`);
 console.log(JSON.stringify({output:destination,observedAt:snapshot.source.observedAt,generatedAt:snapshot.generatedAt,tasks:snapshot.tasks.length,reports:snapshot.reports.length,mode:'snapshot',requiresPrivateHosting:true}));
}finally{ledger.close();}
