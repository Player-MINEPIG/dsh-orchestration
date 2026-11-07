import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const progressSource=readFileSync(new URL('../src/steward-progress-client.js',import.meta.url),'utf8');
const createJournal = runInNewContext(`${progressSource}\n${readFileSync(new URL('../src/steward-native-client.js', import.meta.url), 'utf8')}\ncreateStewardDisplayJournal`);
const message = (seq, role = 'user') => ({ id: `canonical-${seq}`, seq, role, commandId: role === 'user' ? `command-${seq}` : null, text: `Canonical message ${seq}`, createdAt: '2026-11-03T00:00:00Z' });

test('display journal keeps immutable canonical identity and native optimistic correlation without copying inference history', () => {
  const journal = createJournal(), appended = [];
  journal.subscribe(rows => appended.push(...rows));
  journal.sync([message(40), message(50, 'assistant')]);
  assert.equal(journal.records.length, 10);
  assert.equal(journal.cursor, 9);
  assert.deepEqual(Array.from(journal.records, row => row.event.seq), Array.from({ length: 10 }, (_, index) => index));
  const user = journal.records.find(row => row.event.type === 'user/message').event.data;
  assert.equal(user.id, 'canonical-40');
  assert.equal(user.source.rpcId, 'command-40');
  journal.sync([{ ...message(40), revision: 8, state: { kind: 'completed' } }, message(50, 'assistant')]);
  assert.equal(appended.length, 10, 'State revisions belong to receipt slots and do not duplicate canonical text');
  journal.sync([message(40), message(50, 'assistant'), message(80)]);
  assert.equal(appended.length, 15);
  assert.equal(journal.records.filter(row => row.event.type === 'user/message' && row.event.data.source.rpcId === 'command-40').length, 1);
});

test('fresh display windows cap canonical history independently of project-native sequence spaces', () => {
  const journal = createJournal();
  journal.sync(Array.from({ length: 320 }, (_, index) => message(320 - index)));
  assert.equal(journal.ids.length, 300);
  assert.equal(journal.records.length, 1500);
  assert.equal(journal.records[0].event.seq, 0);
  assert.equal(journal.records.at(-1).event.seq, journal.cursor);
  const users = journal.records.filter(row => row.event.type === 'user/message');
  assert.equal(users[0].event.data.id, 'canonical-21');
  assert.equal(users.at(-1).event.data.id, 'canonical-320');
  assert.deepEqual(Array.from(journal.records, row => row.event.seq), Array.from({ length: 1500 }, (_, index) => index));
});


test('notification projection grows one adjacent task group without changing original identities or user turns',()=>{
 const journal=createJournal();
 const notice=(seq,runId)=>({...message(seq,'notification'),scope:{kind:'project',projectId:'project-a'},provenance:{taskId:'task-a',runId}});
 const first=notice(10,'run-old'),next=notice(11,'run-new');journal.sync([first]);journal.sync([first,next]);
 let nodes=journal.records.filter(row=>row.event.type==='plugin:steward/progress');assert.equal(nodes.length,2);assert.equal(nodes[0].event.data.id,first.id);assert.equal(nodes[1].event.data.id,first.id);assert.deepEqual(Array.from(nodes[1].event.data.messageIds),[first.id,next.id]);
 assert.equal(journal.records.filter(row=>row.event.type==='assistant/message').length,0,'Notifications remain display-only business nodes');
 const boundary=message(12),third=notice(13,null),gate={...notice(14,null),gate:{gateId:'gate'}};
 journal.sync([first,next,boundary,third,gate]);nodes=journal.records.filter(row=>row.event.type==='plugin:steward/progress');assert.equal(nodes.at(-2).event.data.id,third.id);assert.equal(nodes.at(-1).event.data.id,gate.id);assert.equal(journal.records.filter(row=>row.event.type==='user/message').length,1);
 assert.deepEqual(Array.from(journal.ids),[first.id,next.id,boundary.id,third.id,gate.id]);
});
