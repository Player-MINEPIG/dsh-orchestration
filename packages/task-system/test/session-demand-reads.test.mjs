import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const {readSessionDemandPage,arraySessionHeaderSource,compareSessionHeaders}=await import(process.env.DSH_SESSION_DEMAND_MODULE??'../dist/session-demand-reads.js');
const {LocalCodexStore}=await import(process.env.DSH_LOCAL_CODEX_MODULE??'../dist/local-codex.js');
const {SessionDispatchIndex}=await import(process.env.DSH_SESSION_MONITOR_MODULE??'../dist/session-task-monitor.js');
const time=n=>new Date(n*1000).toISOString();
const header=(id,returnedAt,status='done')=>({id,title:id,status,direct:true,owner:'task',time:time(1),returnedAt:time(returnedAt)});
const localTask=(id,n,sessionId='s',extra={})=>({id,sessionId,requestId:id,title:id,description:'Prompt '+id,cwd:'/fixture',model:'model',reasoningEffort:'high',parentMode:'workspace-write',status:'review',createdAt:time(1),updatedAt:time(n),returnedAt:time(n),cliPath:'codex',report:'Body '+id,...extra});
const deps=(ledgerSource,overrides={})=>({sessionId:'s',roots:[],pendingDispatches:2,codexJobs:[],ledgerSource,...overrides});

test('task, local Codex and confirmed shell receipts share one final page, facets and counts',async t=>{
 const store=new LocalCodexStore(':memory:');t.after(()=>store.db.close());store.save(localTask('local-20',20));store.save(localTask('local-40',40));
 const taskSource=arraySessionHeaderSource([header('task-10',10),{...header('task-queued',0,'queued'),returnedAt:null}]);
 const codexJobs=[{id:'shell-30',jobId:'job',title:'Shell',seq:1,startedAt:1000,acknowledgedAt:1100,returnedAt:30000,commandHash:'hash',state:'completed',exitCode:0}];
 const options=deps(taskSource,{localCodex:store,codexJobs});
 const pages=await Promise.all([0,1,2].map(page=>readSessionDemandPage({sessionId:'s',page,pageSize:2},options)));
 assert.deepEqual(pages.flatMap(page=>page.items.map(row=>row.id)),['local-40','shell-30','local-20','task-10','task-queued']);
 assert.equal(pages[0].total,5);assert.deepEqual(pages[0].counts,{all:5,done:1,queued:1,review:2,handled:1});assert.equal(pages[0].directCount,5);assert.equal(pages[0].localCodexCount,2);assert.equal(pages[0].externalDispatchCount,1);assert.equal(pages[0].pendingDispatches,2);
 assert.equal(new Set(pages.flatMap(page=>page.items.map(row=>row.id))).size,5);
 for(const row of pages.flatMap(page=>page.items))for(const field of ['report','description','acceptance','cliPath'])assert.equal(field in row,false,field);
 const filtered=await readSessionDemandPage({sessionId:'s',status:'review',search:'local-20',page:99,pageSize:2},options);assert.equal(filtered.page,0);assert.deepEqual(filtered.items.map(row=>row.id),['local-20']);assert.equal(filtered.counts.all,5);
});

test('rank selection matches a full metadata union across unequal and empty sources without reading the offset prefix',async()=>{
 const left=Array.from({length:10000},(_,i)=>header('a-'+String(i).padStart(5,'0'),30000-i)),right=Array.from({length:5000},(_,i)=>({...header('b-'+String(i).padStart(5,'0'),25000-i*2),owner:'local-codex'}));
 let fetched=0;const wrap=rows=>{const source=arraySessionHeaderSource(rows);return {readHeaders(query){assert.ok(query.limit<=20);const value=source.readHeaders(query);fetched+=value.items.length;return value;}};};
 const page=await readSessionDemandPage({sessionId:'s',page:500,pageSize:20},deps(wrap(left),{localCodex:{headerSource:()=>wrap(right)}}));
 assert.deepEqual(page.items.map(row=>row.id),[...left,...right].sort(compareSessionHeaders).slice(10000,10020).map(row=>row.id));assert.ok(fetched<500,`selected ${fetched} metadata headers for offset 10000`);
 for(let n=0;n<12;n++){const a=left.slice(0,n),b=right.slice(0,11-n),options=deps(arraySessionHeaderSource(a),{localCodex:{headerSource:()=>arraySessionHeaderSource(b)}});for(const pageSize of [1,3,7]){const all=[];for(let page=0;page<Math.ceil((a.length+b.length)/pageSize);page++)all.push(...(await readSessionDemandPage({sessionId:'s',page,pageSize},options)).items);assert.deepEqual(all.map(row=>row.id),[...a,...b].sort(compareSessionHeaders).map(row=>row.id));}}
});

test('a changed source refuses mixed revisions while unrelated session writes keep its revision stable',async t=>{
 const store=new LocalCodexStore(':memory:');t.after(()=>store.db.close());for(let i=0;i<12;i++)store.save(localTask('selected-'+i,20+i));
 const source=store.headerSource('s'),initial=source.readHeaders({offset:0,limit:1});store.save(localTask('unrelated',100,'other'));
 assert.equal(source.readHeaders({offset:0,limit:1}).revision,initial.revision);
 let calls=0;const changing={readHeaders(query){if(++calls===2)store.save(localTask('new-related',200));return source.readHeaders(query);}};
 await assert.rejects(readSessionDemandPage({sessionId:'s',page:2,pageSize:3},deps(changing)),error=>error.code==='READ_MODEL_UPDATING');
 const stable={readHeaders(query){store.save(localTask('unrelated-'+calls++,100,'other'));return source.readHeaders(query);}};
 assert.equal((await readSessionDemandPage({sessionId:'s',page:2,pageSize:3},deps(stable))).items.length,3);
});

test('LocalCodex pages, Unicode search, selected reads and acceptance never decode cold prompt/report rows',async t=>{
 const store=new LocalCodexStore(':memory:');t.after(()=>store.db.close());for(let i=0;i<40;i++)store.save(localTask('local-'+i,i+1,'s',{title:i===30?'ÉCOLE selected':'Cold '+i,description:'p'.repeat(64*1024),report:'r'.repeat(64*1024)}));
 const prepare=store.db.prepare.bind(store.db);let decoded=[];store.db.prepare=sql=>{const statement=prepare(sql);if(/SELECT data FROM session_codex_tasks/.test(sql)){for(const method of ['get','all']){const read=statement[method].bind(statement);statement[method]=(...args)=>{const value=read(...args);for(const row of method==='all'?value:[value])if(row?.data)decoded.push(JSON.parse(String(row.data)).id);return value;};}}return statement;};
 store.list=()=>{throw Error('A bounded read must not list all local tasks');};
 const source=store.headerSource('s'),page=source.readHeaders({offset:20,limit:5,status:'review'});assert.equal(page.items.length,5);assert.equal(page.counts.all,40);assert.deepEqual(decoded,[]);
 const selected=source.readHeaders({offset:0,limit:5,search:'école'});assert.deepEqual(selected.items.map(row=>row.id),['local-30']);const before=selected.items[0].detailVersion;
 assert.equal(store.detail('s','local-30').description.length,64*1024);assert.deepEqual(decoded,['local-30']);assert.equal(store.detail('other','local-30'),undefined);
 store.accept('s','local-30','Verified artifact');const after=source.readHeaders({offset:0,limit:5,search:'école'});assert.equal(after.items[0].status,'done');assert.notEqual(after.items[0].detailVersion,before);assert.equal(after.counts.review,39);assert.equal(after.counts.done,1);
 assert.ok(decoded.every(id=>id==='local-30'));
});

test('reopening local storage recovers only active rows and does not read cold terminal payloads',()=>{
 const dir=mkdtempSync(join(tmpdir(),'session-header-restart-')),path=join(dir,'tasks.sqlite');let store=new LocalCodexStore(path),decoded=[];
 for(let i=0;i<20;i++)store.save(localTask('cold-'+i,i,'s',{report:'x'.repeat(64*1024)}));store.save(localTask('active',30,'s',{status:'running'}));store.db.close();
 const prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);if(/SELECT data FROM session_codex_tasks/.test(sql)){const get=statement.get.bind(statement);statement.get=(...args)=>{const row=get(...args);if(row?.data)decoded.push(JSON.parse(String(row.data)).id);return row;};}return statement;};
 try{store=new LocalCodexStore(path);assert.deepEqual(decoded,['active']);assert.equal(store.headerSource('s').readHeaders({offset:0,limit:1,search:'active'}).items[0].status,'unknown');}finally{DatabaseSync.prototype.prepare=prepare;store.db.close();rmSync(dir,{recursive:true,force:true});}
});

const call=(seq,id,name,args)=>({seq,time:seq,type:'tool/call',data:{name,callId:id,arguments:JSON.stringify(args)}});
const result=(seq,id,value)=>({seq,time:seq,type:'tool/result',data:{message:{toolCallId:id,content:[{type:'text',text:JSON.stringify(value)}]}}});
function historyStore(initial=[],inherited=0){let events=[...initial],revision=1,reads=[],closes=0;const persistence={identity:Symbol(),stat:async()=>({revision:String(revision),eventCount:inherited+events.length,header:{id:'s',createdAt:1}}),open:async()=>({inheritedEventCount:inherited,read:async(offset)=>{reads.push(offset);return {events:events.filter(event=>event.seq>=offset)};},close:async()=>{closes++;}})};return {persistence,reads,closes:()=>closes,append(event){events.push(event);revision++;},replace(next){events=next;revision++;}};}

test('live append consumes only receipt metadata and performs zero persistence reads after the cold seed',async()=>{
 const initial=Array.from({length:100},(_,seq)=>({seq,time:seq,type:'user/message',data:{content:[{type:'text',text:'cold '.repeat(20000)}]}}));
 initial.push(call(100,'dispatch','task_dispatch',{}));const f=historyStore(initial),index=new SessionDispatchIndex(),live={id:'s',seq:101,inheritedEventCount:0};
 await index.readHistory(f.persistence,'s',live);assert.deepEqual(f.reads,[0]);
 const acknowledgement=result(101,'dispatch',{value:{taskId:'task'}});f.append(acknowledgement);live.seq=102;index.observe(live,acknowledgement);
 assert.deepEqual((await index.readHistory(f.persistence,'s',live)).ids,['task']);assert.deepEqual(f.reads,[0]);
 const launch=call(102,'shell','bash',{command:'codex exec -m model '+'private prompt '.repeat(20000),description:'Confirmed shell'});f.append(launch);live.seq=103;index.observe(live,launch);
 const ack={seq:103,time:104,type:'tool/result',data:{message:{toolCallId:'shell',content:[{type:'text',text:'started background job shell-1'}]}}};f.append(ack);live.seq=104;index.observe(live,ack);
 const view=await index.readHistory(f.persistence,'s',live);assert.equal(view.codexJobs.length,1);assert.doesNotMatch(JSON.stringify(view),/private prompt|cold cold/);assert.equal(f.reads.length,1);
});

test('cold tail cursors preserve split calls, reset after truncation and backend identity changes, and close every handle',async()=>{
 const f=historyStore([call(12,'dispatch','task_run',{})],12),index=new SessionDispatchIndex();await index.readHistory(f.persistence,'s');
 f.append(result(13,'dispatch',{taskId:'tail-task'}));assert.deepEqual((await index.readHistory(f.persistence,'s')).ids,['tail-task']);assert.deepEqual(f.reads,[12,13]);
 f.replace([call(12,'new','task_dispatch',{})]);assert.deepEqual((await index.readHistory(f.persistence,'s')).ids,[]);assert.equal(f.reads.at(-1),12);
 f.persistence.identity=Symbol();f.append(result(13,'new',{taskId:'identity-task'}));assert.deepEqual((await index.readHistory(f.persistence,'s')).ids,['identity-task']);assert.equal(f.reads.at(-1),12);assert.equal(f.closes(),4);
});

test('same-session history reads share one flight while independent sessions make progress',async()=>{
 const index=new SessionDispatchIndex();let opens=0,release;const blocked=new Promise(resolve=>release=resolve);
 const persistence={identity:Symbol(),stat:async()=>({revision:'one',header:{createdAt:1}}),open:async id=>{opens++;return {inheritedEventCount:0,read:async()=>{if(id==='slow')await blocked;return {events:[]};},close:async()=>{}};}};
 const one=index.readHistory(persistence,'slow'),two=index.readHistory(persistence,'slow');await index.readHistory(persistence,'fast');assert.equal(opens,2);release();assert.deepEqual(await one,await two);assert.equal(opens,2);
});

test('a delayed read from a replaced persistence backend cannot overwrite the new session cursor',async()=>{
 const index=new SessionDispatchIndex(),old=historyStore([call(0,'old','task_dispatch',{}),result(1,'old',{taskId:'old-task'})]),fresh=historyStore([call(0,'new','task_dispatch',{}),result(1,'new',{taskId:'new-task'})]);
 let release,entered;const blocked=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),open=old.persistence.open;
 old.persistence.open=async(...args)=>{const handle=await open(...args),read=handle.read;handle.read=async(...input)=>{entered();await blocked;return read(...input);};return handle;};
 const stale=index.readHistory(old.persistence,'s');await started;
 assert.deepEqual((await index.readHistory(fresh.persistence,'s')).ids,['new-task']);release();await stale;
 assert.deepEqual((await index.readHistory(fresh.persistence,'s')).ids,['new-task']);assert.equal(fresh.reads.length,1,'late old identity does not replace the new cached cursor');
});

test('real session-scoped authority revision survives unrelated writes during rank probes and rejects related changes',async t=>{
 const {TaskLedger}=await import(process.env.DSH_LEDGER_MODULE??'../dist/ledger.js'),{ProjectRuntime}=await import(process.env.DSH_PROJECT_RUNTIME_MODULE??'../dist/project-runtime.js');
 const ledger=TaskLedger.open(':memory:'),runtime=new ProjectRuntime({get:()=>undefined},ledger,'central','both');t.after(()=>ledger.close());
 const root=ledger.createTask('root',{title:'Root',description:'Selected',policy:{maxChildren:100,maxDescendants:100}}).value;
 for(let i=0;i<30;i++)ledger.createTask('child-'+i,{title:'Child '+i,description:'Selected',parentTaskId:root.taskId});
 const read=input=>{for(let i=0;i<100;i++){try{return runtime.demandRead('sessionTaskPage',input);}catch(error){if(error.code!=='READ_MODEL_UPDATING')throw error;}}throw Error('Index did not settle');};
 let writes=0;
 const stable={readHeaders:query=>{if(writes++)ledger.createTask('unrelated-'+writes,{title:'Unrelated',description:'Cold external scope'});return read({sessionId:'s',rootTaskIds:[root.taskId],...query});}};
 const result=await readSessionDemandPage({sessionId:'s',page:3,pageSize:5},deps(stable));assert.equal(result.total,31);assert.equal(result.items.length,5);
 let probes=0;const changing={readHeaders:query=>{if(++probes===2)ledger.createTask('new-related',{title:'Related',description:'Selected',parentTaskId:root.taskId});return read({sessionId:'s',rootTaskIds:[root.taskId],...query});}};
 await assert.rejects(readSessionDemandPage({sessionId:'s',page:3,pageSize:5},deps(changing)),error=>error.code==='READ_MODEL_UPDATING');
 assert.equal(read({sessionId:'s',rootTaskIds:[root.taskId,...Array.from({length:1500},(_,i)=>'historical-'+i)],offset:0,limit:5}).items.length,5,'1501 receipt roots do not disable every session page');
});

test('host both overlays local task metadata before the one union filter/order/page and overrides browser-supplied roots',async t=>{
 const {TaskLedger}=await import(process.env.DSH_LEDGER_MODULE??'../dist/ledger.js'),{TaskPluginSettings}=await import(process.env.DSH_SETTINGS_MODULE??'../dist/settings.js');
 const ledger=TaskLedger.open(':memory:');t.after(()=>ledger.close());
 const history=historyStore([call(0,'one','task_dispatch',{}),result(1,'one',{taskId:'shared'}),call(2,'two','task_dispatch',{}),result(3,'two',{taskId:'central-only'})]);
 const central=[{...header('shared',10),title:'Old central task'},header('central-only',20),{...header('remote-descendant',40),direct:false,parentTaskId:'local-only'}],local=[{...header('shared',50,'error'),title:'Exact local override'},header('local-only',30)];
 const calls=[];
 const task={config:{role:'both',nodeId:'central',centralMode:'host',executionEnabled:true},ledger,projects:{demandRead(method,input){assert.equal(method,'sessionTaskPage');calls.push(input);const excluded=new Set(input.excludeTaskIds||[]);return arraySessionHeaderSource(central.filter(row=>!excluded.has(row.id))).readHeaders(input);}}};
 const remote={executorSessionOverrideTaskIds:()=>['shared','local-only'],executorDemandRead(method,input){assert.equal(method,'sessionTaskPage');return arraySessionHeaderSource(local).readHeaders(input);}};
 const settings=Object.create(TaskPluginSettings.prototype);Object.defineProperty(settings,'ctx',{value:{get:key=>({taskSystem:task,sessionPersistence:history.persistence,remoteExecution:remote})[key]}});settings.sessionDispatchIndex=new SessionDispatchIndex();
 const first=await settings.sessionTaskPage({sessionId:'s',page:0,pageSize:2,rootTaskIds:['forged-private-root']});
 const second=await settings.sessionTaskPage({sessionId:'s',page:1,pageSize:2});
 assert.deepEqual([...first.items,...second.items].map(row=>row.id),['shared','remote-descendant','local-only','central-only']);assert.equal(first.items[0].title,'Exact local override');assert.equal(first.counts.error,1);assert.equal(first.total,4);
 assert.ok(calls.every(call=>!call.rootTaskIds.includes('forged-private-root')));assert.ok(calls.every(call=>call.rootTaskIds.includes('local-only')));assert.ok(calls.every(call=>call.excludeTaskIds.includes('shared')));
});
