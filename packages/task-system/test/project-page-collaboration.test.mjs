import {webcrypto} from 'node:crypto';
import markdownit from 'markdown-it';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function page({insecureContext=false}={}) {
  const html=readFileSync(new URL('../src/project-page.html',import.meta.url),'utf8');
  const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements=new Map(),requests=[],events={},documentEvents={},root={dataset:{}}; let sequence=0;
  const parent={postMessage:request=>{if(request.id)requests.push(request);}};
  const context=vm.createContext({markdownit,atob,structuredClone,console,Date,Map,Set,URL,innerWidth:1200,MutationObserver:class{observe(){}disconnect(){}},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),crypto:insecureContext?{getRandomValues:value=>webcrypto.getRandomValues(value)}:{randomUUID:()=>String(++sequence)},parent,window:{addEventListener:(name,listener)=>events[name]=listener},document:{documentElement:root,title:'',activeElement:{tagName:'BODY'},querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(name,listener)=>documentEvents[name]=listener,getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',hidden:true,dataset:{},setAttribute(){},removeAttribute(){},focus(){}});return elements.get(id);}},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1});
  vm.runInContext(source,context);
  vm.runInContext('patchHtml=(root,html)=>{root.innerHTML=html}',context);
  return {requests,context,elements,documentEvents,action:(a,id)=>vm.runInContext('actions('+JSON.stringify(a)+','+JSON.stringify(id)+')',context),overlay:()=>elements.get('overlays').innerHTML,theme:(source,input)=>events.message({source:source==='parent'?parent:{},data:{channel:'dsh-project-runtime',method:'theme',input}}),root,content:()=>elements.get('app').innerHTML,async answer(response){const request=requests.shift();assert.ok(request);events.message({source:parent,data:{channel:'dsh-project-runtime',id:request.id,...response}});await new Promise(resolve=>setImmediate(resolve));},async retry(){await vm.runInContext("actions('reload')",context);},startRetry(){return vm.runInContext("actions('reload')",context);},startPoll(){return vm.runInContext('poll()',context);}};
}


const project={id:'local-project',title:'Local project',description:'Work in the existing session',goal:'Deliver PV',workspace:'/test/workspace',stage:'本地会话协作',session:0,messages:[],canChat:false};
const collaboration={projectId:project.id,backlogId:'b1',ownerNodeId:'mbp',sessionId:'source-session',cwd:'/test/workspace',title:'Local session work',goal:'Deliver PV',summary:'Storyboard approved; rendering next',state:'active',updatedAt:'2026-10-12T08:00:00.000Z'};
const snapshot={projects:[project],tasks:[],runs:[],attempts:[],settings:{root:null,revision:0},nodes:[],projectCollaborations:[collaboration],projectRegistrations:[]};
test('planner panel displays owned collaboration before any run and adds no mutation or remote-session links',async()=>{
 const p=page();await p.answer({value:{...structuredClone(snapshot),viewContext:{role:'planner',nodeId:'central',scope:'all'}}});await p.action('projects');assert.match(p.content(),/暂无任务/);assert.match(p.content(),/会话进展 · Storyboard approved; rendering next/);assert.doesNotMatch(p.content(),/已激活|中央跟进|统筹会话 <b>|下一步/);assert.doesNotMatch(p.content(),/来源项目 · 已登记/);
 await p.action('project',project.id);const html=p.content();assert.match(html,/aria-label="会话协作"/);assert.match(html,/source-session/);assert.match(html,/Storyboard approved; rendering next/);assert.match(html,/2026\/10\/12/);assert.match(html,/摘要由负责会话记录/);assert.match(html,/会话协作已登记，尚无任务执行记录/);assert.doesNotMatch(html,/data-action="(?:chat|create|task-approve|task-accept)"/);assert.doesNotMatch(html,/<a[^>]+source-session/);
});
test('a collaboration-only update refreshes the original panel into pending central review',async()=>{
 const p=page();await p.answer({value:structuredClone(snapshot)});await p.action('project',project.id);
 const data=structuredClone(snapshot);data.projectCollaborations[0].state='pending_review';data.projectCollaborations[0].summary='Final preview submitted';data.projectCollaborations[0].updatedAt='2026-10-12T09:00:00.000Z';
 const pending=p.startPoll();await p.answer({value:data});await pending;assert.match(p.content(),/已提交 · 待复核/);assert.match(p.content(),/Final preview submitted/);assert.match(p.content(),/尚无验收记录/);assert.doesNotMatch(p.content(),/Storyboard approved/);
});
test('collaboration text escapes nodes, sessions, workspaces and summaries without granting actions',async()=>{
 const p=page(),data=structuredClone(snapshot),payload='<img src=x onerror="attack()">';Object.assign(data.projectCollaborations[0],{ownerNodeId:payload,sessionId:payload,cwd:payload,title:payload,goal:payload,summary:payload,updatedAt:payload});await p.answer({value:data});await p.action('project',project.id);
 const html=p.content(),section=html.match(/<section class="panel project-collaboration"[\s\S]*?<\/section>/)[0];assert.doesNotMatch(section,/<img|onerror="|data-action=|<a\b/);assert.match(section,/&lt;img src=x onerror=&quot;attack\(\)&quot;&gt;/);assert.match(section,/来源节点/);assert.match(section,/负责会话/);
});
test('old snapshots without collaboration remain compatible and sparse records show unknown facts',async()=>{
 const p=page(),data=structuredClone(snapshot);delete data.projectCollaborations;await p.answer({value:data});await p.action('project',project.id);assert.doesNotMatch(p.content(),/aria-label="会话协作"/);
 data.projectCollaborations=[{projectId:project.id,state:'active'}];let pending=p.startPoll();await p.answer({value:data});await pending;assert.match(p.content(),/尚未记录阶段摘要/);assert.match(p.content(),/<dd>未记录<\/dd>/);assert.doesNotMatch(p.content(),/undefined|null/);
 data.projectCollaborations=[{...collaboration,projectId:'different-project'}];pending=p.startPoll();await p.answer({value:data});await pending;assert.doesNotMatch(p.content(),/aria-label="会话协作"/);
});

test('project cards prioritize actionable tasks over active collaboration and running work',async()=>{
 const p=page(),data=structuredClone(snapshot);data.projects[0].session=7;data.projects[0].next='向统筹端描述下一项工作';data.tasks=[{id:'run',project:project.id,title:'Rendering',status:'running'},{id:'review',project:project.id,title:'Review preview',status:'review'},{id:'fix',project:project.id,title:'Fix render error',status:'error'}];
 await p.answer({value:data});await p.action('projects');let html=p.content();assert.match(html,/需处理 · Fix render error/);assert.match(html,/<b>1<\/b> 待确认/);assert.doesNotMatch(html,/已激活|中央跟进|统筹会话 <b>|向统筹端|<b>0<\/b>/);
 data.tasks=data.tasks.filter(t=>t.status!=='error');let pending=p.startPoll();await p.answer({value:data});await pending;assert.match(p.content(),/待确认 · Review preview/);
 data.tasks=data.tasks.filter(t=>t.status!=='review');pending=p.startPoll();await p.answer({value:data});await pending;assert.match(p.content(),/执行中 · Rendering/);
 data.tasks[0].status='done';pending=p.startPoll();await p.answer({value:data});await pending;assert.match(p.content(),/已完成/);assert.doesNotMatch(p.content(),/>执行中</);
});
test('empty native and historical projects do not imply queued work or use session generations as counts',async()=>{
 for(const canChat of [true,false]){const p=page();await p.answer({value:{...snapshot,projectCollaborations:[],projects:[{...project,canChat,session:12,next:'继续项目工作'}]}});await p.action('projects');assert.match(p.content(),/暂无任务/);assert.doesNotMatch(p.content(),/等待开始|统筹会话 <b>|下一步|<b>0<\/b>/);}
});
test('collaboration review stays distinct from task counts and latest summaries use valid timestamps',async()=>{
 const p=page(),data=structuredClone(snapshot);data.projectCollaborations=[{...collaboration,summary:'Old summary'}, {...collaboration,summary:'<new summary>',updatedAt:'2026-10-13T09:00:00Z',state:'pending_review'},{...collaboration,summary:'Undated summary',updatedAt:'bad'}];
 await p.answer({value:data});await p.action('projects');assert.match(p.content(),/会话成果待复核/);assert.match(p.content(),/会话进展 · &lt;new summary&gt;/);assert.doesNotMatch(p.content(),/Old summary|Undated summary|待确认|<b>0<\/b>/);
 data.projects[0].next='Review the storyboard with Alex';const pending=p.startPoll();await p.answer({value:data});await pending;assert.match(p.content(),/下一步 · Review the storyboard with Alex/);
});
