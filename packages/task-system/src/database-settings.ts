import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const authority = z.object({schedulerId:z.string().regex(/^scheduler-[0-9a-f-]{36}$/)});
/** Preflight only: never creates, migrates, copies, or opens the target writable. */
export async function validateTaskDatabasePath(input: string): Promise<string> {
  if (!isAbsolute(input) || input.includes("\0") || !input.trim()) throw new Error("DATABASE_ABSOLUTE_PATH_REQUIRED");
  const parent=await realpath(dirname(resolve(input))),path=join(parent,basename(input));
  await access(parent,constants.R_OK|constants.W_OK);
  let info;
  try { info=await lstat(path); } catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT")return path;throw error; }
  if(!info.isFile() || info.isSymbolicLink())throw new Error("DATABASE_FILE_REQUIRED");
  await access(path,constants.R_OK|constants.W_OK);
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const schema=db.prepare("SELECT version FROM schema_meta").get();
    if(schema?.version!==1)throw new Error("DATABASE_SCHEMA_UNSUPPORTED");
    const row=db.prepare("SELECT data FROM entities WHERE kind='authority' AND id='scheduler'").get();
    authority.parse(JSON.parse(String(row?.data)));
    if(db.prepare("PRAGMA quick_check").get()?.quick_check!=="ok")throw new Error("DATABASE_CORRUPT");
  } finally { db.close(); }
  return path;
}
