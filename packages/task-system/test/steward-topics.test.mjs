import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {StewardTopics} from '../dist/steward-topics.js';
import {StewardTopicPromotion} from '../dist/steward-topic-promotion.js';

function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE entities(kind TEXT,parent TEXT,data TEXT)');const topics=new StewardTopics({managementDatabase:()=>db});
 const a=topics.create({conversationId:'main',commandId:'original',text:'A distinct discussion'}),ref={conversationId:'main',scope:{kind:'workbench',topicId:a.id}};
 const owners=new Map(),tasks=new Map([['task-one',{taskId:'task-one',title:'Task one',state:'inbox'}],['task-two',{taskId:'task-two',title:'Task two',state:'succeeded'}]]),projects=new Map(),created=new Map();let calls=0,failLink=0;
 const workspace={id:'workspace',path:'/topic',title:'管家 · A',async setTitle(title){this.title=title}};
 const projectService={chatProjects:()=>[...projects.values()].map(p=>({projectId:p.id,title:p.title})),placementProject:id=>projects.get(id),workspaceOptions:()=>({workspaces:[{workspaceId:'registry:workspace',nodeId:'local',path:'/topic'}]}),
  async create(input){calls++;if(!created.has(input.commandId)){const id='project-'+created.size;created.set(input.commandId,id);projects.set(id,{id,session:'pm-'+id,cwd:'/topic',title:input.title});}return{projectId:created.get(input.commandId)}},
  linkTask(_session,taskId){if(failLink && --failLink===0){throw Error('injected transient link failure')}owners.set(taskId,'project-0')},
  async createTemporary(){return{taskId:'task-one',dispatchState:'needs-planning'}}};
 const task={assertConversationAdmission(){},ledger:{managementDatabase:()=>db,getTask:id=>tasks.get(id),projectForTask:id=>owners.get(id)},projects:projectService};
 let ensure=async()=>{};const make=()=>new StewardTopicPromotion(task,{get:name=>name==='workspaceRegistry'?{list:()=>[workspace]}:undefined},topics,()=>({kind:'workbench',topicId:a.id,nodeId:'local',sessionId:'source-A',generation:1,cwd:'/topic'}),()=>ensure());
 return{db,topics,a,ref,owners,tasks,projects,workspace,make,calls:()=>calls,setEnsure:value=>ensure=value,failLink:()=>failLink=1,failAfterOne:()=>failLink=2};
}
test('topic identities are command-idempotent, conversation-scoped, and multiple discussions remain distinct',()=>{const f=fixture();try{
 assert.deepEqual(f.topics.create({conversationId:'main',commandId:'original',text:'not a rename'}),f.a);
 const b=f.topics.create({conversationId:'main',commandId:'other',text:'Other'});assert.notEqual(b.id,f.a.id);
 assert.throws(()=>f.topics.get('foreign',f.a.id),{code:'FORBIDDEN'});
}finally{f.db.close()}});
test('promotion serializes different commands before project creation and replays the same durable result',async()=>{const f=fixture();try{
 let release;f.setEnsure(()=>new Promise(r=>release=r));const p=f.make();
 const request={commandId:'promote',topic:f.ref,expectedRevision:0,mode:'create',title:'A project',goal:'A goal',taskIds:[]};
 const first=p.configure(request);await new Promise(r=>setImmediate(r));assert.equal(p.active,true);
 await assert.rejects(p.configure({...request,commandId:'another'}),{code:'BUSY'});assert.equal(f.calls(),0);
 release();const result=await first;await p.drain();assert.equal(p.active,false);assert.equal(f.calls(),1);assert.equal(result.sameWorkspace,true);assert.equal(result.sourceSessionId,'source-A');assert.equal(f.workspace.title,'A project');
 assert.deepEqual(await p.configure(request),result);assert.equal(f.calls(),1);
}finally{f.db.close()}});
test('stale or foreign association cannot retain a claim; partial promotion resumes its original project and task instances',async()=>{const f=fixture();try{
 const p=f.make();await assert.rejects(p.bindTask({commandId:'stale',topic:f.ref,expectedRevision:99,taskId:'task-one'}),{code:'CONFLICT'});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM steward_topic_operations').get().n,0);
 f.owners.set('task-two','foreign-project');await assert.rejects(p.bindTask({commandId:'foreign',topic:f.ref,expectedRevision:0,taskId:'task-two'}),{code:'FORBIDDEN'});
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM steward_topic_operations').get().n,0);
 const attached=await p.bindTask({commandId:'attach',topic:f.ref,expectedRevision:0,taskId:'task-one'});f.owners.delete('task-two');const linked=await p.bindTask({commandId:'attach-two',topic:f.ref,expectedRevision:attached.topic.revision,taskId:'task-two'});f.failAfterOne();
 const request={commandId:'resume-project',topic:f.ref,expectedRevision:linked.topic.revision,mode:'create',title:'A project',goal:'A goal',taskIds:['task-one','task-two']};
 await assert.rejects(p.configure(request),/injected/);assert.equal(f.projects.size,1);assert.equal((await p.options({topic:f.ref})).pendingOperation.method,'topicProjectConfigure');
 const restarted=f.make();const resumed=await restarted.configure(request);assert.equal(f.projects.size,1);assert.equal(resumed.topic.taskIds[0],'task-one');assert.equal(f.owners.get('task-one'),resumed.projectId);assert.equal((await restarted.options({topic:f.ref})).pendingOperation,null);
 assert.equal(f.tasks.get('task-two').state,'succeeded');
}finally{f.db.close()}});
