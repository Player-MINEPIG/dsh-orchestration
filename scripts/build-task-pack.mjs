import { cpSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=resolve(root,'examples/legacy-task-pack');
const destination=resolve(root,'packages/task-system/dist/task-pack');
// This path contains generated build output only. Original source/readers stay intact.
rmSync(destination,{recursive:true,force:true});mkdirSync(destination,{recursive:true});
cpSync(source,destination,{recursive:true,filter(path){
  const info=lstatSync(path);
  if(info.isSymbolicLink()) throw new Error('Task pack build refuses source symlinks');
  return info.isDirectory() || /\.(mjs|json|jsonl|md|log|txt)$/.test(path);
}});
