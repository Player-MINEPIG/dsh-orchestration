import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StewardConversations} from '../dist/steward-conversations.js';
import {stewardRead,stewardSend} from '../dist/steward-contracts.js';

const binding={kind:'personal',nodeId:'local',sessionId:'pagination-personal',generation:1,cwd:'/isolated'};
const personal={kind:'personal'};
for(const count of [2000,10000])test(`${count} durable messages return SQL-bounded pages, stable cursors and bounded state refresh after restart`,()=>{
  const dir=mkdtempSync(join(tmpdir(),'steward-pages-')),path=join(dir,'state.sqlite');let db=new DatabaseSync(path);
  db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY,data TEXT)');let store=new StewardConversations({managementDatabase:()=>db});
  try {
    store.ensure('main');
    const first=store.project({conversationId:'main',role:'notification',text:'notice-1',commandId:null,scope:personal,replyTo:null,createdAt:new Date().toISOString(),source:binding,nativeSeq:null,provenance:null,state:{kind:'completed'},manifest:{persona:{id:'dsh-steward',version:'1'},scope:personal,history:'scope-native-session',evidence:'selection-only',resources:[]}},'seed-first');
    const insert=db.prepare('INSERT INTO steward_messages(seq,id,conversation,data) VALUES(?,?,?,?)');
    db.exec('BEGIN');for(let seq=2;seq<=count;seq++){const value={...first,id:`bulk-${seq}`,seq,text:`notice-${seq}`};insert.run(seq,value.id,'main',JSON.stringify(value));}db.exec('COMMIT');
    store.messages=()=>{throw Error('Unbounded message materialization must not be used by pagination or admission');};
    const read=extra=>store.page(stewardRead.parse({conversationId:'main',...extra}));
    const tail=read({});assert.equal(tail.messages.length,50);assert.equal(tail.messages[0].seq,count-49);assert.equal(tail.page.lastStoredSeq,count);
    const ids=new Set();let page=read({limit:100});
    while(true){assert.ok(page.messages.length<=100);for(const row of page.messages){assert.ok(!ids.has(row.id),'Older pages never overlap their exclusive sequence cursor');ids.add(row.id);}if(!page.page.hasOlder)break;page=read({beforeSeq:page.page.firstSeq,limit:100});}
    assert.equal(ids.size,count);
    const request=stewardSend.parse({conversationId:'main',commandId:'after-many-notices',text:'New user turn',target:personal});
    const accepted=store.accept(request,personal,binding,-1);assert.equal(accepted.seq,count+1);
    store.setState(first.id,{kind:'stopped',reason:'Updated old evidence'});
    const delta=read({afterSeq:count,limit:50,knownIds:[first.id,...tail.messages.map(row=>row.id)]});
    assert.equal(delta.messages.length,1);assert.equal(delta.updates.length,51);assert.equal(delta.updates.find(row=>row.id===first.id).state.kind,'stopped');
    assert.equal(store.commandMessage('main',request.commandId).id,accepted.id);assert.equal(store.commandMessage('other',request.commandId),null);
    const original=read({beforeSeq:101,limit:100}).messages.map(row=>row.id);
    db.close();db=new DatabaseSync(path);store=new StewardConversations({managementDatabase:()=>db});
    assert.deepEqual(read({beforeSeq:101,limit:100}).messages.map(row=>row.id),original);
    assert.equal(store.activeMessage('main',binding).id,accepted.id);assert.equal(store.nativeRequest('main',store.requestId(accepted.id),binding).id,accepted.id);
    const plan=db.prepare("EXPLAIN QUERY PLAN SELECT data FROM steward_messages WHERE conversation=? AND seq<? ORDER BY seq DESC LIMIT ?").all('main',101,100);
    assert.ok(plan.some(row=>String(row.detail).includes('steward_message_conversation')),'The bounded history query uses the conversation/sequence index');
    assert.throws(()=>stewardRead.parse({conversationId:'main',limit:101}));
    assert.throws(()=>stewardRead.parse({conversationId:'main',knownIds:Array(301).fill(first.id)}));
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
