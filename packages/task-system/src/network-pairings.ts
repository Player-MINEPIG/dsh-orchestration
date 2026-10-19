import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
/** Read diagnostics without creating a recovery database or starting a connection. */
export function readNetworkPairings(path:string):Map<string,string> {
  if(!existsSync(path))return new Map();
  const db=new DatabaseSync(path,{readOnly:true});
  try {return new Map(db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'network-peer:%'").all().map(row=>[String(row.key).slice(13),String(row.value)]));} finally {db.close();}
}
/** Called only after a successful explicit configuration save, including paused services. */
export function removeNetworkPairings(path:string,addresses:readonly string[]):void {
  if(!addresses.length || !existsSync(path))return;
  const db=new DatabaseSync(path);
  try {db.exec("BEGIN IMMEDIATE");for(const address of addresses)db.prepare("DELETE FROM metadata WHERE key=?").run(`network-peer:${address}`);db.exec("COMMIT");}catch(error){db.exec("ROLLBACK");throw error;}finally{db.close();}
}
