import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
let ui;
vm.runInNewContext(readFileSync(new URL('../../packages/task-system/dist/settings-client.js',import.meta.url),'utf8'),{
  window:{__ModuleLoader__:{load(row){ui=row.factory(()=>({}));}}},
});
const snapshot=id=>({sessionId:id,tasks:[],runs:[],counts:{all:0}});
test('conversation tab is registered with session identity and is disposed with the plugin',()=>{
  let registration, component, removed=false;
  const invoke=()=>{};
  const off=ui.mountSessionTaskPanel({slots:{inject(name,fn){assert.equal(name,'conversation.view');return fn();},register(row,view){registration=row;component=view;return()=>removed=true;}}},invoke);
  assert.equal(registration.label(),'任务'); assert.equal(registration.order,20);
  assert.equal(registration.inject('session-one').sessionId,'session-one');
  assert.equal(registration.inject('session-two').invoke,invoke);
  assert.equal(component,ui.SessionTaskPanel); off(); assert.equal(removed,true);
});
test('refresh is single-flight, preserves previous data on failure and ignores responses after leaving the session',async()=>{
  let resolve, reject, calls=0;
  const monitor=new ui.SessionTaskMonitor(()=>{calls++;return new Promise((yes,no)=>{resolve=yes;reject=no;});},'one');
  const first=monitor.load(); await monitor.load(); assert.equal(calls,1);
  resolve(snapshot('one'));await first;const previous=monitor.snapshot().value;
  const next=monitor.load();reject(Error('offline'));await next;
  assert.equal(monitor.snapshot().value,previous);assert.ok(monitor.snapshot().error);
  const late=monitor.load();monitor.dispose();resolve({...snapshot('one'),tasks:[{id:'late'}]});await late;
  assert.equal(monitor.snapshot().value,previous);
});
test('a response for another session is never displayed',async()=>{
  const monitor=new ui.SessionTaskMonitor(async()=>snapshot('other'),'one');
  await monitor.load();assert.equal(monitor.snapshot().value,null);assert.ok(monitor.snapshot().error);
});

test('local refresh failure retains local evidence and never requests a project snapshot',async()=>{
  const calls=[];let fail=false;
  const value={...snapshot('local'),viewContext:{role:'executor',scope:'local',nodeId:'mbp'}};
  const monitor=new ui.SessionTaskMonitor(async(method,args)=>{calls.push([method,args.sessionId]);if(fail)throw Error('offline');return value;},'local');
  await monitor.load();fail=true;await monitor.load();
  assert.equal(monitor.snapshot().value,value);
  assert.match(monitor.snapshot().error,/本机任务记录/);
  assert.doesNotMatch(monitor.snapshot().error,/调度端/);
  assert.deepEqual(calls,[['sessionTasks','local'],['sessionTasks','local']]);
});

function renderPanel(value,{filter='all',search='',error=null}={}) {
  let component,stateIndex=0;
  const state=[filter,search];
  const react={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),Fragment:'fragment',
    useMemo:fn=>fn(),useSyncExternalStore:()=>({value,loading:false,error}),useState:()=>[state[stateIndex++],()=>{}],useEffect:()=>{}};
  vm.runInNewContext(readFileSync(new URL('../../packages/task-system/dist/settings-client.js',import.meta.url),'utf8'),{
    window:{__ModuleLoader__:{load(row){component=row.factory(name=>name==='react'?react:{});}}},
  });
  return component.SessionTaskPanel({invoke:()=>{throw Error('Render must not request data');},sessionId:'source-session'});
}
function nodes(tree) {return !tree||typeof tree!=='object'?[]:[tree,...tree.children.flatMap(nodes)];}
function text(tree) {return typeof tree==='string'||typeof tree==='number'?String(tree):!tree||typeof tree!=='object'||tree.type==='style'?'':tree.children.map(text).join(' ');}
const localView=()=>({sessionId:'source-session',directCount:1,counts:{all:2,running:1,done:1},unavailableTasks:1,
  viewContext:{scope:'local',role:'executor',nodeId:'mbp',pollState:'failed',observedAt:'2026-10-22T06:00:00Z'},
  tasks:[{id:'child-task',parentTaskId:'parent-task',runId:'child-run',sessionIds:['executor-session'],title:'Inspect fixture',direct:true,status:'running',stateLabel:'结果待回传'},
    {id:'returned-task',parentTaskId:'child-task',title:'Return fixture',direct:false,status:'done',stateLabel:'结果已回传'}],
  runs:[{id:'child-run',taskId:'child-task',parentTaskId:'parent-task',parentRunId:'parent-run',sessionIds:['executor-session'],state:'running',stateLabel:'结果待回传'}]});

test('local cards preserve concrete result-return labels and actual task/run/session parent evidence',()=>{
  const tree=renderPanel(localView()),content=text(tree);
  for(const value of ['本机执行 · mbp','结果待回传','结果已回传','child-task','parent-task','child-run','parent-run','executor-session','source-session'])assert.ok(content.includes(value),value);
  assert.match(content,/不能据此判定远端无任务/);
  assert.match(content,/最近一次观测失败，保留已有执行记录/);
  const cards=nodes(tree).filter(node=>node.type==='details');
  assert.equal(cards.length,2);assert.equal(cards[0].props['data-task-status'],'running');
  assert.equal(nodes(cards[0]).find(node=>node.props.className==='stm-status').children.at(-1),'结果待回传');
  assert.equal(nodes(cards[1]).find(node=>node.props.className==='stm-status').children.at(-1),'结果已回传');
  assert.doesNotMatch(content,/undefined|Invalid Date|检查调度端/);
});

test('status filtering and identifier search keep parent associations without exposing unrelated cards',()=>{
  const filtered=renderPanel(localView(),{filter:'done'});
  assert.equal(nodes(filtered).filter(node=>node.type==='details').length,1);
  assert.doesNotMatch(text(filtered),/Inspect fixture/);
  const searched=renderPanel(localView(),{search:'executor-session'});
  assert.equal(nodes(searched).filter(node=>node.type==='details').length,1);
  assert.match(text(searched),/parent-task/);assert.doesNotMatch(text(searched),/Return fixture/);
  assert.match(text(renderPanel(localView(),{search:'missing'})),/当前筛选没有任务/);
});

test('snapshots without optional view context retain the scheduler labels and omit absent session evidence',()=>{
  const tree=renderPanel({sessionId:'source-session',directCount:1,counts:{all:1,done:1},tasks:[{id:'legacy-task',title:'Legacy result',status:'done',direct:true}],runs:[]});
  assert.match(text(tree),/当前会话/);assert.match(text(tree),/已完成/);
  assert.doesNotMatch(text(tree),/本机执行|队列轮询|会话 ID|Invalid Date|undefined/);
});
