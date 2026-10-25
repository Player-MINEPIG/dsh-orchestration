import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const markdownit=createRequire(import.meta.url)('markdown-it');

function page(){
 const html=readFileSync(new URL('../src/project-page.html',import.meta.url),'utf8'),source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 const elements=new Map(),requests=[],events={},parent={postMessage:request=>{if(request.id)requests.push(request);}};let sequence=0;
 const context=vm.createContext({markdownit,atob,structuredClone,console,Date,Map,Set,URL,innerWidth:1200,MutationObserver:class{observe(){}disconnect(){}},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),crypto:{randomUUID:()=>String(++sequence)},parent,window:{addEventListener:(name,listener)=>events[name]=listener},document:{documentElement:{dataset:{}},title:'',activeElement:{tagName:'BODY'},querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',hidden:true,dataset:{},setAttribute(){},removeAttribute(){},focus(){}});return elements.get(id);}},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1});
 vm.runInContext(source,context);vm.runInContext('patchHtml=(root,html)=>{root.innerHTML=html;};',context);
 return {requests,context,action:(action,id)=>vm.runInContext(`actions(${JSON.stringify(action)},${JSON.stringify(id)})`,context),overlay:()=>elements.get('overlays').innerHTML,content:()=>elements.get('app').innerHTML,async answer(response){const request=requests.shift();assert.ok(request,'a page RPC is pending');events.message({source:parent,data:{channel:'dsh-project-runtime',id:request.id,...response}});await new Promise(resolve=>setImmediate(resolve));}};
}
const checkin={phase:'scheduled',category:'ready',reason:'等待负责会话核对',canRequest:true,revision:1,nextCheckAt:'2026-10-26T04:00:00Z',observation:null,checksWithoutUpdate:0,deliveryFailures:0,pendingMessageId:null};
const task={id:'draft-task',project:'unassigned',title:'未派发调查',description:'读取资料',status:'draft',nativeState:'ready',actionVersion:'v1',runId:null,confirmationRevision:1,checkin};
const snapshot=tasks=>({projects:[],tasks,settings:{root:null,revision:0},nodes:[]});

test('unstarted drafts have their own board column and filter',async()=>{
 const p=page();await p.answer({value:snapshot([task,{...task,id:'queued-task',title:'已入队调查',status:'queued'}])});
 assert.match(p.content(),/aria-label="未派发"/);assert.match(p.content(),/data-id="draft"/);
 await p.action('filter','draft');assert.match(p.content(),/未派发调查/);assert.doesNotMatch(p.content(),/已入队调查/);
 await p.action('task',task.id);assert.match(p.overlay(),/>未派发<\/span>/);assert.match(p.overlay(),/负责会话进度/);assert.match(p.overlay(),/下次检查/);
});

test('progress observations and request errors are escaped in the task detail',async()=>{
 const p=page(),unsafe='<img src=x onerror=alert(1)>';
 await p.answer({value:snapshot([{...task,checkin:{...checkin,reason:unsafe,observation:{kind:'waiting_external',summary:unsafe,at:'2026-10-26T03:00:00Z'}}}])});await p.action('task',task.id);
 assert.match(p.overlay(),/等待外部条件/);assert.match(p.overlay(),/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(p.overlay(),/<img src=x/);
 const pending=p.action('task-check',task.id);await p.answer({error:unsafe,errorCode:'gateway/internal'});await pending;
 assert.match(p.overlay(),/role="alert"/);assert.doesNotMatch(p.overlay(),/<img src=x/);assert.match(p.overlay(),/重试检查请求/);
});

test('check requests cannot duplicate while pending and use the normal task action authority',async()=>{
 const p=page();await p.answer({value:snapshot([task])});await p.action('task',task.id);
 const pending=p.action('task-check',task.id),input={...p.requests[0].input};
 assert.equal(p.requests[0].method,'actOnProjectTask');assert.deepEqual(input,{commandId:input.commandId,taskId:task.id,expectedVersion:'v1',runId:null,confirmationRevision:1,action:'check'});
 assert.match(p.overlay(),/正在请求检查/);await p.action('task-check',task.id);assert.equal(p.requests.length,1);
 await p.answer({value:{}});await p.answer({value:snapshot([{...task,checkin:{...checkin,phase:'queued',pendingMessageId:'check-event'}}])});await pending;
 assert.match(p.overlay(),/已排队，等待会话处理/);await p.action('task-check',task.id);assert.equal(p.requests.length,0);
});

test('uncertain check retries preserve the command and original version after closing the detail',async()=>{
 const p=page();await p.answer({value:snapshot([task])});await p.action('task',task.id);
 let pending=p.action('task-check',task.id);const input={...p.requests[0].input};await p.answer({error:'连接中断',errorCode:'gateway/internal'});await pending;
 await p.action('close');vm.runInContext("state.tasks[0].actionVersion='v2'",p.context);await p.action('task',task.id);
 pending=p.action('task-check',task.id);assert.deepEqual({...p.requests[0].input},input);
 await p.answer({value:{}});await p.answer({value:snapshot([{...task,checkin:{...checkin,phase:'queued',pendingMessageId:'same-check-event'}}])});await pending;
});

test('closed, ownerless and already queued checks cannot send requests even through direct actions',async()=>{
 for(const phase of ['closed','needs_owner','queued']){
  const p=page();await p.answer({value:snapshot([{...task,checkin:{...checkin,phase}}])});await p.action('task',task.id);
  assert.match(p.overlay(),/data-action="task-check"[^>]*disabled aria-disabled="true"/);
  await p.action('task-check',task.id);assert.equal(p.requests.length,0);
 }
 const p=page();await p.answer({value:snapshot([{...task,checkin:{...checkin,canRequest:false}}])});await p.action('task',task.id);await p.action('task-check',task.id);assert.equal(p.requests.length,0);
});

test('a paused plan offers a single manual check without promising automatic resumption',async()=>{
 const p=page();await p.answer({value:snapshot([{...task,checkin:{...checkin,phase:'paused',nextCheckAt:null}}])});await p.action('task',task.id);
 assert.match(p.overlay(),/本次为单次检查，自动检查继续暂停/);
 const pending=p.action('task-check',task.id);assert.equal(p.requests[0].input.action,'check');assert.equal(p.requests[0].input.plan,undefined);
 await p.answer({value:{}});await p.answer({value:snapshot([{...task,checkin:{...checkin,phase:'paused',nextCheckAt:null}}])});await pending;
 assert.match(p.overlay(),/自动检查已暂停/);
});
