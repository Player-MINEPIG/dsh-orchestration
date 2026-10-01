/** Explicit operator bridge into the shared TaskLedger. Never exposed by the WebUI. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskLedger} from '../packages/task-system/dist/index.js';
import {validateSnapshot} from './public/model.js';
const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const sourceFile=value('--source'),commandId=value('--command');
if(!sourceFile||!commandId){console.error('Usage: node dashboard/import.mjs --source path/to/explicit-import.json --command stable-import-id [--ledger path]');process.exitCode=1;}
else{
 const source=validateSnapshot(JSON.parse(await readFile(path.resolve(sourceFile),'utf8')));
 if(source.source.kind!=='explicit-import')throw new Error('Only explicit-import snapshots are accepted');
 const here=path.dirname(fileURLToPath(import.meta.url)),ledger=TaskLedger.open(path.resolve(value('--ledger')||path.join(here,'../.runtime/tasks.sqlite')));
 try{
   for(const workspace of source.workspaces||[])ledger.registerWorkspace(`${commandId}:workspace:${workspace.workspaceId}`,workspace);
   const receipt=ledger.importSnapshot(commandId,source);
   console.log(JSON.stringify({commandId:receipt.commandId,acceptedAt:receipt.acceptedAt,...receipt.value}));
 }finally{ledger.close();}
}
