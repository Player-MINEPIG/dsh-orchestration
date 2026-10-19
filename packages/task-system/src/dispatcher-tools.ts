import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { realpathSync } from "node:fs";
import { Workbench } from "./workbench.js";
import { TaskError } from "./ledger.js";
import type { TaskSystemService } from "./dsh-plugin.js";
import type { Json } from "./contracts.js";

const json=(value:unknown):Json=>JSON.parse(JSON.stringify(value));
const output={schema:{type:"json" as const},render:(_args:unknown,value:unknown)=>[{type:"text" as const,text:JSON.stringify(value)}]};
/** Ordinary coordinator identity is distinct from an executor's fenced lease. */
export function mountDispatcherTools(ctx:Context,service:TaskSystemService) {
 const ledger=service.ledger,db=ledger.managementDatabase();
 db.exec("CREATE TABLE IF NOT EXISTS dispatcher_projects(node TEXT NOT NULL,session TEXT NOT NULL,project TEXT NOT NULL,cwd TEXT NOT NULL,PRIMARY KEY(node,session))");
 const identity=(agent:Agent|undefined)=>{
   if(!agent || service.native?.scopeFor(agent))throw new TaskError("FORBIDDEN","Only an ordinary current session can bind a project or dispatcher task");
   const cwd=agent.session.header.cwd;if(!cwd)throw new TaskError("FORBIDDEN","Current session has no workspace");
   return {nodeId:service.config.nodeId,sessionId:String(agent.id),cwd:realpathSync(cwd)};
 };
 const projects=()=>db.prepare("SELECT id,title,goal,cwd,state FROM pr_projects WHERE state='ready'").all();
 ctx.tools.register(defineTool({name:"project_list",description:"List existing managed projects that a coordinator can select. Creating a project remains a separate action in the project page.",parameters:{},output,execute:async(_args,exec)=>{
   identity(exec.agent);return json(projects());
 }}));
 ctx.tools.register(defineTool({name:"project_bind_session",description:"Bind this current ordinary session to an existing managed project at its authorized workspace. Session identity and device are supplied by the host.",parameters:{projectId:{type:"string",required:true}},output,execute:async(args,exec)=>{
   const who=identity(exec.agent),project=projects().find(row=>row.id===args.projectId);
   if(!project)throw new TaskError("NOT_FOUND","Managed project not found; create it in the project page first");
   let permitted=String(project.cwd)===who.cwd;
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='pr_project_workspaces'").get()) {
     const row=db.prepare("SELECT workspace FROM pr_project_workspaces WHERE project=?").get(args.projectId);
     if(row) {const workspace=JSON.parse(String(row.workspace));if(workspace.nodeId===who.nodeId && realpathSync(workspace.path)===who.cwd)permitted=true;}
   }
   if(!permitted)throw new TaskError("FORBIDDEN","Open the current session in this project's workspace before binding it");
   const active=ledger.dispatcherForSession(who.nodeId,who.sessionId);
   if(active && active.projectId!==args.projectId)throw new TaskError("CONFLICT","Finish the current coordinated task before changing projects");
   db.prepare("INSERT INTO dispatcher_projects VALUES(?,?,?,?) ON CONFLICT(node,session) DO UPDATE SET project=excluded.project,cwd=excluded.cwd").run(who.nodeId,who.sessionId,args.projectId,who.cwd);
   return json({...who,projectId:args.projectId});
 }}));
 ctx.tools.register(defineTool({name:"task_bind_dispatcher",description:"Register this current project session as coordinator of a draft Task it created. Creates the parent coordination Run; no executor lease is granted.",parameters:{commandId:{type:"string",required:true},taskId:{type:"string",required:true}},output,execute:async(args,exec)=>{
   const who=identity(exec.agent),project=db.prepare("SELECT project,cwd FROM dispatcher_projects WHERE node=? AND session=?").get(who.nodeId,who.sessionId);
   if(!project || project.cwd!==who.cwd)throw new TaskError("FORBIDDEN","Select this session's project using project_bind_session first");
   const task=ledger.getTask(args.taskId),origin=task.dispatchOrigin;
   if(origin?.kind!=="session" || origin.sessionId!==who.sessionId || origin.nodeId!==who.nodeId)throw new TaskError("FORBIDDEN","Only the creator can coordinate this draft");
   new Workbench(ledger).manage(`dispatcher-link:${args.commandId}`,"link_backlog_task",{backlogId:`pr:${String(project.project)}`,taskId:task.taskId});
   return json(ledger.bindDispatcher(args.commandId,{...who,taskId:task.taskId,projectId:String(project.project)}));
 }}));
 ctx.tools.register(defineTool({name:"task_retry_return",description:"Retry delivery of an existing task result to its original session. This never starts or repeats task execution.",parameters:{commandId:{type:"string",required:true},messageId:{type:"string",required:true}},output,execute:async(args,exec)=>{
   const message=ledger.getSessionMessage(args.messageId),origin=message.completion?.origin;
   if(exec.agent && (origin?.kind!=="session" || origin.sessionId!==String(exec.agent.id) || origin.nodeId!==service.config.nodeId))throw new TaskError("FORBIDDEN","Only the origin session can retry this result return");
   return json(ledger.retryTaskReturn(args.commandId,args.messageId));
 }}));
}
