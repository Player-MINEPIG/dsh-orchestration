import {createRequire} from 'node:module';
import {join} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const official=process.env.DSH_OFFICIAL_ROOT;
export async function attachProjectSessionHost(h){
 const req=createRequire(join(official,'package.json'));
 process.env.DSH_HOME=join(h.dir,'isolated-home');process.env.DSH_AGENTS_HOME=join(h.dir,'isolated-agents');
 const skills=join(h.dir,'skills');mkdirSync(join(skills,'owner-local'),{recursive:true});writeFileSync(join(skills,'owner-local','SKILL.md'),'---\nname: owner-local\ndescription: Native owner skill proof\n---\nOWNER_LOCAL_APPLICATION_SKILL\n');
 const rows=[['query','dsh-session-query-sqlite',{path:join(h.dir,'query.sqlite'),openAt:'never'}],['typert','dsh-typert-registry'],['access','dsh-api-remote-access'],['default-model','dsh-agent-default-model',{provider:'test-offline',model:'script'}],['fs','dsh-fs-local'],['attachment','dsh-attachment-local',{dshHome:join(h.dir,'isolated-home')}],['commands','dsh-commands'],['credentials','dsh-credentials-local'],['connection','dsh-client-connection'],['uploads','dsh-client-file-upload'],['storage','dsh-storage'],['storage-json','dsh-storage-json',{root:join(h.dir,'workspace-storage')}],['domain','dsh-storage-domain',{backend:'json'}],['workspaces','dsh-workspace'],['working-directory','dsh-working-directory'],['skills','dsh-skill'],['skill-files','dsh-skill-filesystem',{includeDefaultRoots:false,customSkillDirs:[skills],watch:false}],['tool-directory','dsh-tool-working-directory'],['tool-skill','dsh-tool-skill'],['controller','dsh-api-session-controller',{nativeOpen:false}]];
 for(const[id,name,config]of rows)await h.ctx.loader.create({id:'portal-'+id,name:pathToFileURL(req.resolve('@deepseek-ai/'+name)).href,config});await h.ctx.loader.await();assert.ok(h.ctx.sessionController,JSON.stringify(rows.map(([id])=>({id,state:h.ctx.loader.resolve("portal-"+id).fiber.state})))) ;
}
