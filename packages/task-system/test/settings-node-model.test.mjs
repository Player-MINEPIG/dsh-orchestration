import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function fixture(props, component='NodeModelSettings') {
  const hooks=[];let cursor=0,effects=[],ui,tree;
  const changed=(a,b)=>!a || a.length!==b.length || b.some((value,index)=>value!==a[index]);
  const react={
    createElement:(type,props,...children)=>({type,props:props ?? {},children:children.flat(Infinity)}),
    useState(initial){const slot=cursor++;if(!hooks[slot])hooks[slot]={value:typeof initial==='function'?initial():initial};return [hooks[slot].value,next=>{hooks[slot].value=typeof next==='function'?next(hooks[slot].value):next;}];},
    useRef(initial){const slot=cursor++;return hooks[slot]??=( {current:initial} );},
    useCallback(fn,deps){const slot=cursor++;if(changed(hooks[slot]?.deps,deps))hooks[slot]={value:fn,deps};return hooks[slot].value;},
    useEffect(fn,deps){const slot=cursor++;if(changed(hooks[slot]?.deps,deps)){const prior=hooks[slot];hooks[slot]={deps,cleanup:prior?.cleanup};effects.push(()=>{prior?.cleanup?.();hooks[slot].cleanup=fn();});}},
  };
  vm.runInNewContext(readFileSync(new URL('../src/settings-client.js',import.meta.url),'utf8'),{URL,setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);t.unref();return t;},clearTimeout,window:{__ModuleLoader__:{load(row){ui=row.factory(name=>name==='react'?react:{Button:'Button'});}}}});
  const render=()=>{cursor=0;effects=[];tree=ui[component](props);const pending=effects;effects=[];for(const effect of pending)effect();return tree;};
  const find=(predicate,node=tree)=>{if(!node || typeof node!=='object')return undefined;if(predicate(node))return node;for(const child of node.children ?? []){const found=find(predicate,child);if(found)return found;}};
  const settle=async()=>{for(let i=0;i<8;i++){await Promise.resolve();render();}return tree;};
  render();
  return {ui,props,render,settle,find,text:()=>JSON.stringify(tree),select:label=>find(node=>node.type==='select' && node.props['aria-label']===label),button:label=>find(node=>node.type==='Button' && node.children.includes(label))};
}
const normalize=value=>JSON.parse(JSON.stringify(value));
const tuple=(model='flash',effort='high',backend)=>({provider:'host-provider',model,...(effort===undefined?{}:{reasoningEffort:effort}),...(backend?{backend}:{})});
const view=(nodeId='node-a',choice,revision='catalog-1',state='fresh',complete=true)=>({nodeId,catalog:{state,snapshot:{revision,observedAt:Date.now(),expiresAt:Date.now()+60000,complete,models:[tuple(),tuple('flash','low'),tuple('flash','high','codex'),tuple('other','medium')]}},policy:{revision:7,...(choice?{choice}:{})}});
function modelFixture(initial=view(),overrides={}) {
  const writes=[];let current=initial;
  const props={nodeId:initial.nodeId,writable:true,active:true,read:async()=>current,refresh:async()=>current,save:async input=>{writes.push(normalize(input));current={...current,policy:{revision:8,choice:input.choice}};return current;},...overrides};
  const f=fixture(props);props.saveCoordinator=new f.ui.SettingsSaveCoordinator();f.render();
  return {...f,writes,setView:value=>{current=value;}};
}
const modelOption=(f,model,backend)=>f.select('默认执行模型').children.find(node=>node?.type==='option' && node.props.value && JSON.parse(node.props.value)[1]===model && JSON.parse(node.props.value)[2]===(backend ?? null));

// The repository's browser-half tests drive the exported component with a hook runner.
// These checks exercise user selections and coordinator writes without installing a DOM runtime.
test('node model and effort selection saves one exact node/catalog/policy tuple through the global coordinator',async()=>{
  const f=modelFixture();await f.settle();
  assert.equal(f.writes.length,0);assert.match(f.text(),/尚未设置节点默认值/);
  assert.equal(f.button('保存节点默认模型'),undefined);
  f.select('默认执行模型').props.onChange({target:{value:modelOption(f,'flash','codex').props.value}});f.render();
  assert.equal(f.select('默认推理档位').props.value,'high');
  assert.deepEqual(f.select('默认推理档位').children.filter(Boolean).map(node=>node.props.value),['high']);
  assert.equal(f.props.saveCoordinator.snapshot().count,1);
  assert.equal(await f.props.saveCoordinator.saveAll(),true);await f.settle();
  assert.deepEqual(f.writes,[{nodeId:'node-a',expectedRevision:7,expectedCatalogRevision:'catalog-1',choice:tuple('flash','high','codex')}]);
  assert.equal(f.props.saveCoordinator.snapshot().count,0);
});

test('saved defaults remain visible when catalog is offline, stale, incomplete, or empty',async()=>{
  for(const [state,complete] of [['unavailable',true],['stale',true],['pending',false],['fresh',false]]){
    const current=view('node-a',tuple('retired','max'),'old',state,complete);current.catalog.snapshot.models=[];
    const f=modelFixture(current);await f.settle();
    assert.match(f.text(),/retired/);assert.match(f.text(),/max/);
    assert.equal(f.select('默认执行模型').props.disabled,true);
    assert.equal(f.props.saveCoordinator.snapshot().count,0);
    assert.equal(await f.props.saveCoordinator.saveAll(),false);
    assert.equal(f.writes.length,0);
  }
});

test('fresh partial positive catalog permits confirmed tuples and preserves an omitted saved default',async()=>{
  const current=view('node-a',tuple('saved-not-listed','max'),'last-complete','stale');
  current.catalog.positiveSnapshot={revision:'positive-partial',observedAt:Date.now(),expiresAt:Date.now()+60000,complete:false,models:[tuple(),tuple('flash','low')]};
  let refreshes=0;
  const f=modelFixture(current,{refresh:async()=>{refreshes++;return current;}});await f.settle();
  assert.equal(refreshes,0);assert.equal(f.select('默认执行模型').props.disabled,false);
  assert.match(f.text(),/部分模型目录/);assert.match(f.text(),/saved-not-listed/);assert.equal(f.writes.length,0);assert.equal(f.props.saveCoordinator.snapshot().count,0);
  f.select('默认执行模型').props.onChange({target:{value:modelOption(f,'flash').props.value}});f.render();
  f.select('默认推理档位').props.onChange({target:{value:'low'}});f.render();
  assert.equal(await f.props.saveCoordinator.saveAll(),true);await f.settle();
  assert.equal(f.writes[0].expectedCatalogRevision,'positive-partial');assert.deepEqual(f.writes[0].choice,tuple('flash','low'));
});

test('expired partial evidence retains draft and delegates bounded reconfirmation to the save endpoint',async()=>{
  const f=modelFixture(view('node-a',tuple()));await f.settle();
  f.select('默认执行模型').props.onChange({target:{value:modelOption(f,'other').props.value}});f.render();
  const expired=view('node-a',tuple(),'last-complete','stale');
  expired.catalog.positiveSnapshot={revision:'expired-partial',observedAt:Date.now()-120000,expiresAt:Date.now()-1,complete:false,models:[tuple('other','medium')]};
  f.setView(expired);await f.button('刷新模型目录').props.onClick();await f.settle();
  assert.equal(f.select('默认执行模型').props.disabled,true);assert.equal(f.select('默认推理档位').props.value,'medium');
  assert.equal(await f.props.saveCoordinator.saveAll(),true);assert.equal(f.writes.length,1);
});

test('catalog refresh retains exact draft and original policy revision without requiring reselection',async()=>{
  const f=modelFixture(view('node-a',tuple()));await f.settle();
  f.select('默认执行模型').props.onChange({target:{value:modelOption(f,'other').props.value}});f.render();
  f.setView(view('node-a',tuple(),'catalog-2'));
  await f.button('刷新模型目录').props.onClick();await f.settle();
  assert.equal(f.select('默认推理档位').props.value,'medium');
  assert.equal(f.props.saveCoordinator.snapshot().invalid,false);
  assert.equal(await f.props.saveCoordinator.saveAll(),true);await f.settle();
  assert.equal(f.writes[0].expectedCatalogRevision,'catalog-1');assert.equal(f.writes[0].expectedRevision,7);
});

test('effort changes stay within the selected model catalog and participants do not share another node draft',async()=>{
  const a=modelFixture(view('node-a',tuple())),b=modelFixture(view('node-b',tuple()));
  await a.settle();await b.settle();
  b.props.saveCoordinator=a.props.saveCoordinator;b.render();
  a.select('默认推理档位').props.onChange({target:{value:'low'}});a.render();
  b.select('默认执行模型').props.onChange({target:{value:modelOption(b,'other').props.value}});b.render();
  assert.equal(a.props.saveCoordinator.snapshot().count,2);
  assert.equal(await a.props.saveCoordinator.saveAll(),true);await a.settle();await b.settle();
  assert.deepEqual(a.writes[0].choice,tuple('flash','low'));assert.equal(a.writes[0].nodeId,'node-a');
  assert.deepEqual(b.writes[0].choice,tuple('other','medium'));assert.equal(b.writes[0].nodeId,'node-b');
});

test('failed CAS save and hidden role retain node draft without writing a different node or global default',async()=>{
  const writes=[];const f=modelFixture(view('node-b',tuple()),{save:async input=>{writes.push(normalize(input));throw {code:'CONFLICT'};}});await f.settle();
  f.select('默认执行模型').props.onChange({target:{value:modelOption(f,'other').props.value}});f.render();
  f.props.active=false;f.render();assert.equal(f.props.saveCoordinator.snapshot().count,0);assert.equal(f.props.saveCoordinator.snapshot().retained,1);
  assert.equal(await f.props.saveCoordinator.saveAll(),false);assert.equal(writes.length,0);
  f.props.active=true;f.render();assert.equal(await f.props.saveCoordinator.saveAll(),false);await f.settle();
  assert.equal(writes[0].nodeId,'node-b');assert.equal(f.select('默认推理档位').props.value,'medium');assert.match(f.text(),/CONFLICT/);
  assert.equal(f.props.saveCoordinator.snapshot().count,1);
  f.props.saveCoordinator.discardAll();f.render();assert.equal(f.select('默认推理档位').props.value,'high');assert.equal(f.props.saveCoordinator.snapshot().count,0);
});

test('unexpected node identity is rejected and unavailable refresh retains the existing saved choice',async()=>{
  const f=modelFixture(view('node-a',tuple()),{refresh:async()=>view('node-other',tuple('other','medium'))});await f.settle();
  await f.button('刷新模型目录').props.onClick();await f.settle();
  assert.match(f.text(),/身份不匹配/);assert.equal(f.select('默认执行模型').props.disabled,true);assert.match(f.text(),/flash/);assert.equal(f.writes.length,0);
});

test('connection cards use bound nodeId and leave unpaired nicknames without a model editor',async()=>{
  const row={address:'100.64.0.2',nodeId:'node-real',nickname:'Friendly nickname'};
  const current={writable:true,exists:true,revision:1,paused:true,values:{nodeId:'scheduler',authMode:'trusted-network',listenerEnabled:true,listenAddress:'100.64.0.1',listenPort:18440,routePath:'/dsh-task/v1/commands',serviceAudience:'tasks',peers:[row,{address:'100.64.0.3',nodeId:'',nickname:'Unpaired'}]}};
  const props={role:'planner',read:async()=>current,save:async()=>current,onSaved:async()=>{},nodeModelApi:{read:async()=>view('node-real'),refresh:async()=>view('node-real'),save:async()=>view('node-real')}};
  const f=fixture(props,'ConnectionSettings');await f.settle();
  const editor=f.find(node=>node.type===f.ui.NodeModelSettings);
  assert.equal(editor.props.nodeId,'node-real');assert.equal(editor.props.key,'node-real');assert.match(f.text(),/先连接并绑定执行端身份/);
});


test('TTL expiry changes the visible catalog state and keeps the draft saveable for server reconfirmation',async()=>{
  const current=view('node-a',tuple());current.catalog.snapshot.expiresAt=Date.now()+25;
  const f=modelFixture(current);await f.settle();
  f.select('默认执行模型').props.onChange({target:{value:modelOption(f,'other').props.value}});f.render();
  await new Promise(resolve=>setTimeout(resolve,40));f.render();
  assert.match(f.text(),/模型目录已过期/);assert.doesNotMatch(f.text(),/已读取完整模型目录/);
  assert.equal(f.select('默认推理档位').props.value,'medium');assert.equal(f.props.saveCoordinator.snapshot().invalid,false);
});

test('save refresh errors retain exact draft and display actionable Chinese feedback',async()=>{
  for(const code of ['EXECUTION_CATALOG_STALE','EXECUTION_CATALOG_UNCONFIRMED','EXECUTION_MODEL_UNAVAILABLE','EXECUTION_MODEL_POLICY_CONFLICT','EXECUTION_MODEL_AUTHORITY_CHANGED']){
    const f=modelFixture(view('node-a',tuple()),{save:async()=>{throw {details:{reason:code}};}});await f.settle();
    f.select('默认执行模型').props.onChange({target:{value:modelOption(f,'other').props.value}});f.render();
    assert.equal(await f.props.saveCoordinator.saveAll(),false);await f.settle();
    assert.equal(f.select('默认推理档位').props.value,'medium');assert.equal(f.props.saveCoordinator.snapshot().count,1);
    assert.match(f.text(),/保存失败，草稿已保留/);assert.doesNotMatch(f.text(),new RegExp(code));
  }
});
