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
  const parent={postMessage:request=>{if(request.method!=="detailFullscreen")requests.push(request);}};
  const context=vm.createContext({markdownit,atob,structuredClone,console,Date,Map,Set,URL,innerWidth:1200,crypto:insecureContext?{getRandomValues:value=>webcrypto.getRandomValues(value)}:{randomUUID:()=>String(++sequence)},parent,window:{addEventListener:(name,listener)=>events[name]=listener},document:{documentElement:root,title:'',activeElement:{tagName:'BODY'},querySelector:()=>null,addEventListener:(name,listener)=>documentEvents[name]=listener,getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',hidden:true,dataset:{}});return elements.get(id);}},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1});
  vm.runInContext(source,context);
  return {requests,context,elements,documentEvents,action:(a,id)=>vm.runInContext('actions('+JSON.stringify(a)+','+JSON.stringify(id)+')',context),overlay:()=>elements.get('overlays').innerHTML,theme:(source,input)=>events.message({source:source==='parent'?parent:{},data:{channel:'dsh-project-runtime',method:'theme',input}}),root,content:()=>elements.get('app').innerHTML,async answer(response){const request=requests.shift();assert.ok(request);events.message({source:parent,data:{channel:'dsh-project-runtime',id:request.id,...response}});await new Promise(resolve=>setImmediate(resolve));},async retry(){await vm.runInContext("actions('reload')",context);},startRetry(){return vm.runInContext("actions('reload')",context);},startPoll(){return vm.runInContext('poll()',context);}};
}


const project={id:'local-project',title:'Local project',description:'Work in the existing session',goal:'Deliver PV',workspace:'/test/workspace',stage:'本地会话协作',session:0,messages:[],canChat:false};
const collaboration={projectId:project.id,backlogId:'b1',ownerNodeId:'mbp',sessionId:'source-session',cwd:'/test/workspace',title:'Local session work',goal:'Deliver PV',summary:'Storyboard approved; rendering next',state:'active',updatedAt:'2026-10-12T08:00:00.000Z'};
const snapshot={projects:[project],tasks:[],runs:[],attempts:[],settings:{root:null,revision:0},nodes:[],projectCollaborations:[collaboration],projectRegistrations:[]};
test('existing executor panel displays owned collaboration before any run and adds no mutation or remote-session links',async()=>{
 const p=page();await p.answer({value:{...structuredClone(snapshot),viewContext:{role:'executor',nodeId:'mbp',scope:'node'}}});await p.action('projects');assert.match(p.content(),/会话协作 · 已激活/);assert.match(p.content(),/当前会话协作 · 中央跟进/);assert.doesNotMatch(p.content(),/来源项目 · 已登记/);
 await p.action('project',project.id);const html=p.content();assert.match(html,/aria-label="会话协作"/);assert.match(html,/source-session/);assert.match(html,/Storyboard approved; rendering next/);assert.match(html,/2026\/10\/12/);assert.match(html,/中央尚未验收/);assert.match(html,/会话协作已登记，尚无任务执行记录/);assert.doesNotMatch(html,/data-action="(?:chat|create|task-approve|task-accept)"/);assert.doesNotMatch(html,/<a[^>]+source-session/);
});
test('a collaboration-only update refreshes the original panel into pending central review',async()=>{
 const p=page();await p.answer({value:structuredClone(snapshot)});await p.action('project',project.id);
 const data=structuredClone(snapshot);data.projectCollaborations[0].state='pending_review';data.projectCollaborations[0].summary='Final preview submitted';data.projectCollaborations[0].updatedAt='2026-10-12T09:00:00.000Z';
 const pending=p.startPoll();await p.answer({value:data});await pending;assert.match(p.content(),/已提交 · 待复核/);assert.match(p.content(),/Final preview submitted/);assert.match(p.content(),/中央尚未验收/);assert.doesNotMatch(p.content(),/Storyboard approved/);
});
test('collaboration text escapes nodes, sessions, workspaces and summaries without granting actions',async()=>{
 const p=page(),data=structuredClone(snapshot),payload='<img src=x onerror="attack()">';Object.assign(data.projectCollaborations[0],{ownerNodeId:payload,sessionId:payload,cwd:payload,title:payload,goal:payload,summary:payload,updatedAt:payload});await p.answer({value:data});await p.action('project',project.id);
 const html=p.content(),section=html.match(/<section class="panel project-collaboration"[\s\S]*?<\/section>/)[0];assert.doesNotMatch(section,/<img|onerror="|data-action=|<a\b/);assert.match(section,/&lt;img src=x onerror=&quot;attack\(\)&quot;&gt;/);assert.match(section,/来源节点/);assert.match(section,/来源会话/);
});
test('old snapshots without collaboration remain compatible and sparse records show unknown facts',async()=>{
 const p=page(),data=structuredClone(snapshot);delete data.projectCollaborations;await p.answer({value:data});await p.action('project',project.id);assert.doesNotMatch(p.content(),/aria-label="会话协作"/);
 data.projectCollaborations=[{projectId:project.id,state:'active'}];let pending=p.startPoll();await p.answer({value:data});await pending;assert.match(p.content(),/尚未记录阶段摘要/);assert.match(p.content(),/<dd>未记录<\/dd>/);assert.doesNotMatch(p.content(),/undefined|null/);
 data.projectCollaborations=[{...collaboration,projectId:'different-project'}];pending=p.startPoll();await p.answer({value:data});await pending;assert.doesNotMatch(p.content(),/aria-label="会话协作"/);
});
